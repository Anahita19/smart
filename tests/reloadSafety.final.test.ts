/**
 * Stage 6 final reload-safety hardening (audit findings H-A, M-A, M-B, L-A).
 *
 * H-A: the reload guard now asks the STORAGE SESSION whether this page's data can be recovered from
 *      storage (`getDiscardHazard`). No notice, dismissal or `persistenceOk` value takes part.
 * M-A: an incomplete restore is such a hazard too, so dismissing or replacing its notice changes nothing.
 *
 * Everything below drives the real `openSession` (two sessions on one fake storage stand for two tabs),
 * the real `evaluateReloadSafety`, `createGuardedReload` and `requestUpdateActivation`. The only
 * stand-in is `Tab`, which repeats the handful of lines in TransactionsProvider that turn session
 * outcomes into React state (list, synced list, persistenceOk, notice); the wiring tests at the end
 * pin those lines in the real source. Typecheck/Build and a rendered browser run are NOT covered here.
 *
 * Run: node --experimental-strip-types --import ./tests/register-alias.mjs --test "tests/reloadSafety.final.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { createGuardedReload, evaluateReloadSafety, getReloadActivities } from '../src/pwa/reloadGuard.ts';
import type { ReloadBlock } from '../src/pwa/reloadGuard.ts';
import { requestUpdateActivation } from '../src/pwa/updateLifecycle.ts';
import { RECOVERY_KEY_PREFIX, SCHEMA_VERSION, STORAGE_KEY, openSession } from '../src/lib/storage.ts';
import type { RestoreOutcome, RestoreRequest, StorageLike, StorageNotice, SyncOutcome } from '../src/lib/storage.ts';
import { hasDraftChanges } from '../src/lib/validation.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── fakes ─────────────

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  failWrite: (key: string, value: string) => boolean = () => false;
  /** Runs right after a successful write; lets a test act as "another tab" or garble the read-back. */
  afterWrite: (key: string, value: string) => void = () => {};
  garbleNextRead = false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) {
    if (k === STORAGE_KEY && this.garbleNextRead) { this.garbleNextRead = false; return '<<garbled>>'; }
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrite(k, v)) throw new Error('QuotaExceededError');
    this.data.set(k, v);
    this.afterWrite(k, v);
  }
  removeItem(k: string) { this.data.delete(k); }
  recoveryKeys() { return [...this.data.keys()].filter((k) => k.startsWith(RECOVERY_KEY_PREFIX)); }
}

const tx = (id: string): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date: '2026-11-01',
});
const envelope = (transactions: unknown[], version: number = SCHEMA_VERSION) =>
  JSON.stringify({ schemaVersion: version, savedAt: '2026-11-10T08:00:00.000Z', transactions });

class FakeWorker { posted: unknown[] = []; state = 'installed'; addEventListener() {} postMessage(m: unknown) { this.posted.push(m); } }
class FakeRegistration { waiting: FakeWorker | null = new FakeWorker(); installing = null; addEventListener() {} update() { return Promise.resolve(); } }
class FakeContainer {
  controller: unknown = {};
  listeners = new Set<() => void>();
  addEventListener(_t: 'controllerchange', l: () => void) { this.listeners.add(l); }
  removeEventListener(_t: 'controllerchange', l: () => void) { this.listeners.delete(l); }
  fireControllerChange() { [...this.listeners].forEach((l) => l()); }
}

/** One browser tab: a real storage session plus the provider's state transitions (see the header). */
class Tab {
  session;
  transactions: Transaction[];
  synced: Transaction[];
  persistenceOk = true;
  notice: StorageNotice | null;
  store: FakeStorage;
  constructor(store: FakeStorage) {
    this.store = store;
    this.session = openSession(store, () => 1);
    this.transactions = this.session.boot.transactions;
    this.synced = this.transactions;
    this.notice = this.session.boot.notice;
  }
  private applySync(o: SyncOutcome) {
    if (o.action === 'adopt') { this.synced = o.transactions; this.transactions = o.transactions; this.persistenceOk = true; }
    if (o.action !== 'none' && o.notice) this.notice = o.notice;
  }
  /** The `storage` event another tab's write would raise. */
  storageEvent() { this.applySync(this.session.syncFromStorage('event')); }
  commit(next: Transaction[]) {
    this.transactions = next;
    if (next === this.synced) return 'none' as const;
    const out = this.session.save(next);
    if (out.status === 'saved') { this.synced = next; this.persistenceOk = true; }
    else if (out.status === 'failed') this.persistenceOk = false;
    else if (out.status === 'conflict') { if (out.sync.action === 'none') this.persistenceOk = false; else this.applySync(out.sync); }
    return out.status;
  }
  restore(request: RestoreRequest): RestoreOutcome {
    const result = this.session.restore(request);
    if (result.status === 'restored') {
      if (result.changed) this.applySync({ action: 'adopt', transactions: result.transactions, notice: { kind: 'restored', message: 'done' } });
    } else if (result.status === 'refused') {
      if (result.sync) this.applySync(result.sync);
    } else if (result.dataState === 'rollback-failed' || result.dataState === 'changed-elsewhere') {
      this.notice = { kind: 'restore-incomplete', message: result.message };
    }
    return result;
  }
  dismissNotice() { this.notice = null; }
  /** The banner's verdict: exactly the inputs UpdateBanner passes (no notice among them). */
  block(): ReloadBlock | null {
    return evaluateReloadSafety({
      persistenceOk: this.persistenceOk,
      hasUnsavedChanges: this.transactions !== this.synced,
      storageHazard: this.session.getDiscardHazard(),
      activities: getReloadActivities(),
    });
  }
  /** What a Reload click does, with the real lifecycle and guarded reload. */
  clickReload() {
    const registration = new FakeRegistration(); const container = new FakeContainer(); const counters = { reloads: 0, deferred: 0 };
    if (this.block() !== null) return { result: 'disabled' as const, registration, container, counters };
    const result = requestUpdateActivation(registration, container, { type: 'SKIP_WAITING' },
      createGuardedReload({ getBlock: () => this.block(), reload: () => { counters.reloads += 1; }, onDeferred: () => { counters.deferred += 1; } }));
    return { result, registration, container, counters };
  }
}

function assertRefused(tab: Tab, reason: string) {
  assert.equal(tab.block()?.reason, reason);
  const click = tab.clickReload();
  assert.equal(click.result, 'disabled');
  assert.deepEqual(click.registration.waiting!.posted, [], 'no activation was requested');
  assert.equal(click.container.listeners.size, 0);
  click.container.fireControllerChange();
  assert.equal(click.counters.reloads, 0);
}

function openWithData() {
  const store = new FakeStorage();
  store.data.set(STORAGE_KEY, envelope([tx('a')]));
  return { store, tab: new Tab(store) };
}

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// ───────────── H-A: another tab changes storage ─────────────

describe('H-A: another tab removes stored data', () => {
  it('blocks Reload even though nothing is "unsaved" and persistenceOk is true', () => {
    const { store, tab } = openWithData();
    assert.equal(tab.block(), null);
    store.data.delete(STORAGE_KEY);
    tab.storageEvent();
    assert.equal(tab.session.getDiscardHazard(), 'removed-elsewhere');
    assert.equal(tab.persistenceOk, true, 'persistenceOk is not the signal');
    assert.equal(tab.transactions, tab.synced, 'the old hasUnsavedChanges flag is false here: that was the hole');
    assert.equal(tab.notice?.kind, 'removed-elsewhere');
    assertRefused(tab, 'removed-elsewhere');
    assert.equal(store.data.has(STORAGE_KEY), false, 'the deletion was not undone');
  });

  it('a later edit stays unsaved, so the protection keeps holding', () => {
    const { store, tab } = openWithData();
    store.data.delete(STORAGE_KEY);
    tab.storageEvent();
    assert.equal(tab.commit([tx('b'), ...tab.transactions]), 'blocked');
    assert.equal(tab.session.getDiscardHazard(), 'removed-elsewhere');
    assertRefused(tab, 'unsaved-changes'); // the more specific data-loss reason is reported first; the hazard is still set
  });
});

describe('H-A: another tab writes unreadable data', () => {
  it('blocks Reload; this tab keeps its list and a recovery copy of the other data exists', () => {
    const { store, tab } = openWithData();
    store.data.set(STORAGE_KEY, '{definitely not json');
    tab.storageEvent();
    assert.equal(tab.notice?.kind, 'external-unreadable');
    assert.equal(tab.session.getDiscardHazard(), 'external-unreadable');
    assert.equal(tab.persistenceOk, true);
    assert.equal(tab.transactions, tab.synced);
    assert.equal(store.recoveryKeys().length, 1);
    assert.equal(tab.transactions[0]?.id, 'a');
    assertRefused(tab, 'external-unreadable');
  });

  it('also blocks when no recovery copy could be made (saving is paused as well)', () => {
    const { store, tab } = openWithData();
    store.failWrite = (key) => key.startsWith(RECOVERY_KEY_PREFIX);
    store.data.set(STORAGE_KEY, '{definitely not json');
    tab.storageEvent();
    assert.equal(tab.session.getDiscardHazard(), 'external-unreadable');
    assertRefused(tab, 'external-unreadable');
  });
});

describe('H-A: another tab writes a newer unsupported version', () => {
  it('blocks Reload and leaves the newer data untouched', () => {
    const { store, tab } = openWithData();
    const newer = envelope([tx('z')], SCHEMA_VERSION + 1);
    store.data.set(STORAGE_KEY, newer);
    tab.storageEvent();
    assert.equal(tab.notice?.kind, 'unsupported-version');
    assert.equal(tab.session.getDiscardHazard(), 'unsupported-version');
    assert.equal(tab.persistenceOk, true);
    assert.equal(tab.transactions, tab.synced);
    assertRefused(tab, 'unsupported-version');
    assert.equal(store.data.get(STORAGE_KEY), newer);
  });

  it('a conflicting save refused for a newer version raises the same protection', () => {
    const { store, tab } = openWithData();
    store.data.set(STORAGE_KEY, envelope([tx('z')], SCHEMA_VERSION + 1)); // no storage event delivered yet
    tab.commit([tx('b'), ...tab.transactions]);
    assert.equal(tab.session.getDiscardHazard(), 'unsupported-version');
    assertRefused(tab, 'unsaved-changes'); // the refused edit is unsaved too; the hazard is set independently
  });
});

// ───────────── H-A: notices are irrelevant to the protection ─────────────

describe('H-A: dismissing the removed-elsewhere notice', () => {
  it('does not release the protection', () => {
    const { store, tab } = openWithData();
    store.data.delete(STORAGE_KEY);
    tab.storageEvent();
    tab.dismissNotice();
    assert.equal(tab.notice, null);
    assertRefused(tab, 'removed-elsewhere');
    tab.storageEvent(); // the same condition reported again changes nothing either
    assertRefused(tab, 'removed-elsewhere');
  });

  it('every other session-level notice behaves the same way when dismissed', () => {
    for (const [write, reason] of [
      ['{not json', 'external-unreadable'],
      [envelope([tx('z')], SCHEMA_VERSION + 1), 'unsupported-version'],
    ] as const) {
      const { store, tab } = openWithData();
      store.data.set(STORAGE_KEY, write);
      tab.storageEvent();
      tab.dismissNotice();
      assertRefused(tab, reason);
    }
  });
});

// ───────────── M-A: incomplete restore ─────────────

/** A restore whose write cannot be undone: the verify read fails and the previous value cannot be written back. */
function incompleteRestoreByFailedRollback() {
  const { store, tab } = openWithData();
  const previous = store.data.get(STORAGE_KEY)!;
  store.afterWrite = (key) => { if (key === STORAGE_KEY) { store.garbleNextRead = true; store.afterWrite = () => {}; } };
  store.failWrite = (key, value) => key === STORAGE_KEY && value === previous; // rollback is refused
  const result = tab.restore({ mode: 'replace', incoming: [tx('r1'), tx('r2')] });
  store.failWrite = () => false;
  return { store, tab, result, previous };
}

/** Another tab overwrites storage in the middle of the restore, so it is neither the old nor the new value. */
function incompleteRestoreChangedElsewhere() {
  const { store, tab } = openWithData();
  const other = envelope([tx('other')]);
  store.afterWrite = (key) => { if (key === STORAGE_KEY) { store.data.set(STORAGE_KEY, other); store.afterWrite = () => {}; } };
  const result = tab.restore({ mode: 'replace', incoming: [tx('r1')] });
  return { store, tab, result, other };
}

describe('M-A: incomplete restore protection', () => {
  it('rollback-failed: Reload is blocked from the session state, not from the notice', () => {
    const { tab, result } = incompleteRestoreByFailedRollback();
    assert.equal(result.status, 'failed');
    assert.equal((result as { dataState: string }).dataState, 'rollback-failed');
    assert.equal(tab.notice?.kind, 'restore-incomplete');
    assert.equal(tab.session.getDiscardHazard(), 'restore-incomplete');
    assert.equal(tab.transactions, tab.synced, 'no unsaved-changes flag either');
    assertRefused(tab, 'restore-incomplete');
  });

  it('changed-elsewhere: also blocked', () => {
    const { tab, result } = incompleteRestoreChangedElsewhere();
    assert.equal((result as { dataState: string }).dataState, 'changed-elsewhere');
    assertRefused(tab, 'restore-incomplete');
  });

  it('dismissing the restore-incomplete notice does not enable Reload', () => {
    const { tab } = incompleteRestoreByFailedRollback();
    tab.dismissNotice();
    assert.equal(tab.notice, null);
    assertRefused(tab, 'restore-incomplete');
    const other = incompleteRestoreChangedElsewhere();
    other.tab.dismissNotice();
    assertRefused(other.tab, 'restore-incomplete');
  });

  it('another notification replacing the restore notice does not enable Reload', () => {
    const { tab } = incompleteRestoreByFailedRollback();
    tab.notice = { kind: 'restored', message: 'Restore complete: 1 transactions are now saved.' }; // an arbitrary replacement
    assertRefused(tab, 'restore-incomplete');
    // …and a real one: a failed second restore attempt is refused while saving is paused, and leaves the protection in place.
    const second = tab.restore({ mode: 'merge', incoming: [tx('q')] });
    assert.equal(second.status, 'refused');
    assertRefused(tab, 'restore-incomplete');
  });

  it('a real replacement notice (another tab writes unreadable data) keeps Reload blocked, now for that reason', () => {
    const { store, tab } = incompleteRestoreByFailedRollback();
    store.data.set(STORAGE_KEY, '{garbage from another tab');
    tab.storageEvent();
    assert.equal(tab.notice?.kind, 'external-unreadable');
    assert.equal(tab.block()?.reason, 'external-unreadable');
    assert.notEqual(tab.block(), null);
  });

  it('keeps the existing rollback and snapshot behaviour: the snapshot is kept and saving stays paused', () => {
    const { store, tab, result, previous } = incompleteRestoreByFailedRollback();
    const snapshotKey = (result as { snapshotKey: string | null }).snapshotKey;
    assert.ok(snapshotKey);
    assert.equal(store.data.get(snapshotKey!), previous, 'byte-for-byte safety snapshot of the previous value');
    assert.equal(tab.commit([tx('x')]), 'blocked');
  });

  it('a restore that rolls back cleanly is NOT a hazard and is not reported as success', () => {
    const { store, tab } = openWithData();
    store.afterWrite = (key) => { if (key === STORAGE_KEY) { store.garbleNextRead = true; store.afterWrite = () => {}; } };
    const result = tab.restore({ mode: 'replace', incoming: [tx('r1')] });
    assert.equal(result.status, 'failed');
    assert.equal((result as { dataState: string }).dataState, 'rolled-back');
    assert.equal(tab.session.getDiscardHazard(), null);
    assert.equal(tab.block(), null);
  });

  it('a successful restore leaves no hazard', () => {
    const { tab } = openWithData();
    assert.equal(tab.restore({ mode: 'merge', incoming: [tx('b')] }).status, 'restored');
    assert.equal(tab.block(), null);
  });
});

// ───────────── released only when genuinely resolved ─────────────

describe('Reload becomes available only after the underlying condition is resolved', () => {
  it('removed-elsewhere: only another tab storing valid data (which this tab adopts) releases it', () => {
    const { store, tab } = openWithData();
    store.data.delete(STORAGE_KEY);
    tab.storageEvent();
    tab.dismissNotice();
    assert.equal(tab.commit([tx('b'), ...tab.transactions]), 'blocked', 'saving cannot release it');
    assert.equal(tab.session.getDiscardHazard(), 'removed-elsewhere');
    assertRefused(tab, 'unsaved-changes');
    // the other tab stores valid data
    const other = new Tab(store);
    assert.equal(other.commit([tx('o')]), 'saved');
    assert.notEqual(tab.block(), null, 'not released until this tab has actually re-read storage');
    assert.equal(tab.session.getDiscardHazard(), 'removed-elsewhere');
    tab.storageEvent();
    assert.equal(tab.session.getDiscardHazard(), null);
    assert.deepEqual(tab.transactions.map((t) => t.id), ['o']);
    assert.equal(tab.block(), null);
    const click = tab.clickReload();
    assert.equal(click.result, 'requested');
    click.container.fireControllerChange();
    assert.deepEqual(click.counters, { reloads: 1, deferred: 0 });
  });

  it('external-unreadable: released by adopting valid data, or once this tab\'s own list is saved', () => {
    const a = openWithData();
    a.store.data.set(STORAGE_KEY, '{nope');
    a.tab.storageEvent();
    a.tab.dismissNotice();
    assertRefused(a.tab, 'external-unreadable');
    a.store.data.set(STORAGE_KEY, envelope([tx('o')]));
    a.tab.storageEvent();
    assert.equal(a.tab.block(), null);

    const b = openWithData();
    b.store.data.set(STORAGE_KEY, '{nope');
    b.tab.storageEvent();
    assertRefused(b.tab, 'external-unreadable');
    assert.equal(b.tab.commit([tx('mine'), ...b.tab.transactions]), 'saved', 'saving is allowed here and puts this tab\'s list into storage');
    assert.equal(b.tab.session.getDiscardHazard(), null);
    assert.equal(b.tab.block(), null);
  });

  it('unsupported-version: released when storage holds readable data again and this tab adopts it', () => {
    const { store, tab } = openWithData();
    store.data.set(STORAGE_KEY, envelope([tx('z')], SCHEMA_VERSION + 1));
    tab.storageEvent();
    assertRefused(tab, 'unsupported-version');
    store.data.set(STORAGE_KEY, envelope([tx('ok')]));
    tab.storageEvent();
    assert.equal(tab.block(), null);
    assert.deepEqual(tab.transactions.map((t) => t.id), ['ok']);
  });

  it('restore-incomplete: released when this tab re-reads storage and adopts what it holds', () => {
    const { store, tab } = incompleteRestoreByFailedRollback();
    tab.dismissNotice();
    assertRefused(tab, 'restore-incomplete');
    tab.storageEvent(); // storage holds the data the restore wrote; adopting it makes screen and storage agree
    assert.equal(tab.session.getDiscardHazard(), null);
    assert.deepEqual(tab.transactions.map((t) => t.id), ['r1', 'r2']);
    assert.equal(tab.block(), null);
    assert.equal(tab.commit([tx('n'), ...tab.transactions]), 'saved');
    assert.ok(store.data.get(STORAGE_KEY)!.includes('item n'));
  });

  it('a hazard raised between the click and the controller change defers the reload instead of discarding data', () => {
    const { store, tab } = openWithData();
    const click = tab.clickReload();
    assert.equal(click.result, 'requested');
    store.data.delete(STORAGE_KEY);
    tab.storageEvent();
    click.container.fireControllerChange();
    assert.deepEqual(click.counters, { reloads: 0, deferred: 1 });
  });

  it('persistenceOk === true proves nothing: it is true in every hazard above', () => {
    const { store, tab } = openWithData();
    store.data.delete(STORAGE_KEY);
    tab.storageEvent();
    assert.equal(tab.persistenceOk, true);
    assert.notEqual(tab.block(), null);
  });
});

// ───────────── existing safe behaviour ─────────────

describe('existing safe reload behaviour still works', () => {
  it('no hazard, saved data: Reload is offered, activates once and reloads once', () => {
    const { tab } = openWithData();
    assert.equal(tab.commit([tx('b'), ...tab.transactions]), 'saved');
    assert.equal(tab.session.getDiscardHazard(), null);
    const click = tab.clickReload();
    assert.equal(click.result, 'requested');
    assert.deepEqual(click.registration.waiting!.posted, [{ type: 'SKIP_WAITING' }]);
    click.container.fireControllerChange(); click.container.fireControllerChange();
    assert.deepEqual(click.counters, { reloads: 1, deferred: 0 });
  });

  it('a first run with an empty store, and an update from another tab that is simply adopted, are safe', () => {
    const store = new FakeStorage();
    const tab = new Tab(store);
    assert.equal(tab.block(), null);
    const other = new Tab(store);
    other.commit([tx('o')]);
    tab.storageEvent();
    assert.equal(tab.notice?.kind, 'external-update');
    assert.equal(tab.block(), null);
  });

  it('startup states are not hazards (the screen is exactly what a reload would show); edits there still count as unsaved', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')], SCHEMA_VERSION + 1));
    const tab = new Tab(store);
    assert.equal(tab.session.getDiscardHazard(), null);
    assert.equal(tab.block(), null);
    tab.commit([tx('new')]);
    assert.equal(tab.block()?.reason, 'unsaved-changes');
  });

  it('failed saves still block (existing protection)', () => {
    const { store, tab } = openWithData();
    store.failWrite = () => true;
    tab.commit([tx('n'), ...tab.transactions]);
    assert.equal(tab.block()?.reason, 'save-failed');
  });
});

// ───────────── M-B ─────────────

describe('M-B: adopting another tab\'s data and a stale persistenceOk', () => {
  it('after adopting, everything on screen equals what storage holds, so a failed save from before leaves nothing only in memory', () => {
    const { store, tab } = openWithData();
    store.failWrite = (key) => key === STORAGE_KEY;
    tab.commit([tx('lost-edit'), ...tab.transactions]);
    assert.equal(tab.persistenceOk, false);
    assert.equal(tab.block()?.reason, 'save-failed');
    store.failWrite = () => false;
    const other = new Tab(store);
    other.commit([tx('o')]);
    tab.storageEvent();
    assert.equal(tab.notice?.kind, 'external-update');
    assert.equal(tab.transactions, tab.synced);
    assert.deepEqual(tab.transactions.map((t) => t.id), ['o']);
    assert.equal(tab.session.getDiscardHazard(), null);
    assert.equal(tab.persistenceOk, true, 'reset on adopt: no false "could not be saved" and no stuck Reload');
    assert.equal(tab.block(), null);
  });

  it('a later failing save sets it to false again, so the reset removes no protection', () => {
    const { store, tab } = openWithData();
    store.failWrite = (key) => key === STORAGE_KEY;
    tab.commit([tx('x'), ...tab.transactions]);
    store.data.set(STORAGE_KEY, envelope([tx('o')]));
    tab.storageEvent();
    assert.equal(tab.persistenceOk, true);
    tab.commit([tx('y'), ...tab.transactions]);
    assert.equal(tab.persistenceOk, false);
    assert.equal(tab.block()?.reason, 'save-failed');
  });
});

// ───────────── L-A ─────────────

describe('L-A: a new form opened before midnight', () => {
  const values = { type: 'expense' as const, amount: '', categoryId: '', description: '', date: '2026-11-13' };
  it('an untouched form is not a draft when compared with the values it STARTED with, even after the calendar rolls over', () => {
    const startAtOpen = { ...values };
    assert.equal(hasDraftChanges(values, startAtOpen), false);
    const recomputedAfterMidnight = { ...values, date: '2026-11-14' }; // what the old per-render `initialValues()` produced
    assert.equal(hasDraftChanges(values, recomputedAfterMidnight), true, 'this is the false positive the fix removes');
  });
  it('real edits still count as a draft', () => {
    for (const patch of [{ amount: '5' }, { description: 'x' }, { categoryId: 'groceries' }, { type: 'income' as const }, { date: '2026-11-12' }]) {
      assert.equal(hasDraftChanges({ ...values, ...patch }, values), true);
    }
  });
});

// ───────────── wiring in the real source ─────────────

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('wiring in the real source', () => {
  it('the banner takes its verdict from the session hazard and never from a notice; it re-reads the session live at reload time', () => {
    const src = read('src/components/layout/UpdateBanner.tsx');
    assert.doesNotMatch(src, /storageNotice|restore-incomplete/);
    assert.match(src, /storageHazard/);
    assert.match(src, /readStorageHazard\(\)/);
    assert.match(src, /getBlock: getLiveBlock/);
  });

  it('the provider derives the hazard from the session after every save, sync and restore, and keeps dismissStorageNotice a pure notice reset', () => {
    const src = read('src/state/TransactionsContext.tsx');
    assert.match(src, /session\.getDiscardHazard\(\)/);
    assert.match(src, /const dismissStorageNotice = useCallback\(\(\) => setStorageNotice\(null\), \[\]\);/);
    assert.equal((src.match(/refreshStorageHazard\(\);/g) ?? []).length, 3, 'save effect, applySync, restore');
    assert.match(src, /dispatch\(\{ type: 'replace', transactions: outcome\.transactions \}\);\s*[^}]*setPersistenceOk\(true\);/, 'M-B: reset only inside the adopt branch');
  });

  it('the form captures its starting values once', () => {
    assert.match(read('src/components/transactions/TransactionForm.tsx'), /const \[start\] = useState<TransactionFormValues>\(\(\) => initialValues\(initial\)\);/);
  });

  it('the service worker and the update lifecycle are untouched', () => {
    assert.doesNotMatch(read('src/pwa/updateLifecycle.ts'), /reloadGuard|useReloadActivity|Hazard/);
    assert.doesNotMatch(read('public/sw.js'), /reloadGuard|Hazard/);
  });
});
