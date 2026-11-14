/**
 * Stage 6 H1: the update banner's Reload must never discard data that lives only in memory.
 * Uses the real storage session with a failure-injecting fake of the Web Storage API, the real
 * update lifecycle helpers and the real reload guard; no browser, no packages.
 *
 * Run: node --experimental-strip-types --import ./tests/register-alias.mjs --test "tests/reloadGuard.stage6.test.ts"
 *
 * The React provider and banner cannot be rendered here (no React in the dependency-free setup), so
 * `providerModel` and `bannerClick` below mirror their few lines of state tracking; the wiring tests at
 * the end pin those lines in the real source so the mirror cannot silently drift.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import {
  createGuardedReload,
  evaluateReloadSafety,
  getReloadActivities,
  registerReloadActivity,
  subscribeReloadActivities,
} from '../src/pwa/reloadGuard.ts';
import type { ReloadBlock } from '../src/pwa/reloadGuard.ts';
import { requestUpdateActivation } from '../src/pwa/updateLifecycle.ts';
import { STORAGE_KEY, SCHEMA_VERSION, openSession } from '../src/lib/storage.ts';
import type { StorageLike } from '../src/lib/storage.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── fakes ─────────────

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  failWrite: (key: string) => boolean = () => false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (this.failWrite(k)) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
}

const tx = (id: string): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date: '2026-11-01',
});
const envelope = (transactions: unknown[], version: number = SCHEMA_VERSION) =>
  JSON.stringify({ schemaVersion: version, savedAt: '2026-11-10T08:00:00.000Z', transactions });

class FakeWorker {
  posted: unknown[] = [];
  state = 'installed';
  addEventListener() {}
  postMessage(message: unknown) { this.posted.push(message); }
}
class FakeRegistration {
  waiting: FakeWorker | null = new FakeWorker();
  installing = null;
  addEventListener() {}
  update() { return Promise.resolve(); }
}
class FakeContainer {
  controller: unknown = {};
  listeners = new Set<() => void>();
  addEventListener(_type: 'controllerchange', listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'controllerchange', listener: () => void) { this.listeners.delete(listener); }
  fireControllerChange() { [...this.listeners].forEach((l) => l()); }
}

/** Mirrors TransactionsProvider's save effect: `persistenceOk` and `hasUnsavedChanges` after each change. */
function providerModel(store: StorageLike) {
  const session = openSession(store, () => 1);
  let transactions: Transaction[] = session.boot.transactions;
  let synced = transactions;
  const state = { persistenceOk: true, hasUnsavedChanges: false, lastStatus: 'none' as string };
  return {
    session,
    state,
    commit(next: Transaction[]) {
      transactions = next;
      if (transactions === synced) { state.hasUnsavedChanges = false; return; }
      const outcome = session.save(transactions);
      state.lastStatus = outcome.status;
      if (outcome.status === 'saved') { synced = transactions; state.persistenceOk = true; }
      else if (outcome.status === 'failed') state.persistenceOk = false;
      state.hasUnsavedChanges = transactions !== synced;
    },
    get transactions() { return transactions; },
  };
}

/** Mirrors UpdateBanner: the button is disabled while blocked; otherwise the real lifecycle runs with a guarded reload. */
function bannerClick(opts: {
  getBlock: () => ReloadBlock | null;
  registration: FakeRegistration;
  container: FakeContainer;
  counters: { reloads: number; deferred: number };
}) {
  if (opts.getBlock() !== null) return 'disabled' as const;
  return requestUpdateActivation(
    opts.registration, opts.container, { type: 'SKIP_WAITING' },
    createGuardedReload({
      getBlock: opts.getBlock,
      reload: () => { opts.counters.reloads += 1; },
      onDeferred: () => { opts.counters.deferred += 1; },
    }),
  );
}

const safeInput = { persistenceOk: true, hasUnsavedChanges: false, storageHazard: null, activities: [] as const };
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// ───────────── the decision ─────────────

describe('evaluateReloadSafety', () => {
  it('is safe only when nothing lives only in memory', () => {
    assert.equal(evaluateReloadSafety(safeInput), null);
  });

  it('blocks for every data-loss condition with a plain-language message', () => {
    const cases: Array<[Partial<Parameters<typeof evaluateReloadSafety>[0]>, string]> = [
      [{ persistenceOk: false }, 'save-failed'],
      [{ hasUnsavedChanges: true }, 'unsaved-changes'],
      [{ storageHazard: 'removed-elsewhere' }, 'removed-elsewhere'],
      [{ storageHazard: 'external-unreadable' }, 'external-unreadable'],
      [{ storageHazard: 'unsupported-version' }, 'unsupported-version'],
      [{ storageHazard: 'restore-incomplete' }, 'restore-incomplete'],
      [{ activities: ['restore-in-progress'] }, 'restore-in-progress'],
      [{ activities: ['draft-open'] }, 'draft-open'],
    ];
    for (const [patch, reason] of cases) {
      const block = evaluateReloadSafety({ ...safeInput, ...patch });
      assert.equal(block?.reason, reason);
      assert.match(block!.message, /^Update paused: /);
    }
  });

  it('reports a data-loss reason before a screen-activity reason', () => {
    const block = evaluateReloadSafety({ ...safeInput, persistenceOk: false, activities: ['draft-open', 'restore-in-progress'] });
    assert.equal(block?.reason, 'save-failed');
  });
});

// ───────────── required regression scenarios ─────────────

describe('H1 regression: failed save followed by a Reload click', () => {
  it('refuses the click: no activation request, no listener, no reload, even if the controller changes later', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')]));
    const model = providerModel(store);
    store.failWrite = (key) => key === STORAGE_KEY; // storage full / refused
    model.commit([tx('new'), ...model.transactions]);
    assert.equal(model.state.lastStatus, 'failed');
    assert.equal(model.state.persistenceOk, false);
    assert.equal(model.state.hasUnsavedChanges, true);

    const registration = new FakeRegistration(); const container = new FakeContainer(); const counters = { reloads: 0, deferred: 0 };
    const getBlock = () => evaluateReloadSafety({ ...safeInput, ...model.state });
    assert.equal(getBlock()?.reason, 'save-failed');
    assert.equal(bannerClick({ getBlock, registration, container, counters }), 'disabled');
    assert.deepEqual(registration.waiting!.posted, []);
    assert.equal(container.listeners.size, 0);
    container.fireControllerChange();
    assert.equal(counters.reloads, 0);
  });

  it('allows Reload again once a later save succeeds', () => {
    const store = new FakeStorage();
    const model = providerModel(store);
    store.failWrite = () => true;
    model.commit([tx('a')]);
    assert.equal(evaluateReloadSafety({ ...safeInput, ...model.state })?.reason, 'save-failed');
    store.failWrite = () => false;
    model.commit([tx('b'), ...model.transactions]);
    assert.equal(model.state.lastStatus, 'saved');
    assert.equal(evaluateReloadSafety({ ...safeInput, ...model.state }), null);
  });
});

describe('H1 regression: blocked persistence followed by a Reload click', () => {
  it('a change made while saving is blocked is unsaved even though persistenceOk stays true, so Reload is refused', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')], SCHEMA_VERSION + 1)); // newer app version: saving is blocked
    const model = providerModel(store);
    assert.equal(model.session.boot.saveBlocked, 'unsupported-version');
    model.commit([tx('new')]);
    assert.equal(model.state.lastStatus, 'blocked');
    assert.equal(model.state.persistenceOk, true, 'the blocked path does not flip persistenceOk, so it alone is not enough');
    assert.equal(model.state.hasUnsavedChanges, true);

    const registration = new FakeRegistration(); const container = new FakeContainer(); const counters = { reloads: 0, deferred: 0 };
    const getBlock = () => evaluateReloadSafety({ ...safeInput, ...model.state });
    assert.equal(getBlock()?.reason, 'unsaved-changes');
    assert.equal(bannerClick({ getBlock, registration, container, counters }), 'disabled');
    assert.deepEqual(registration.waiting!.posted, []);
    container.fireControllerChange();
    assert.equal(counters.reloads, 0);
    assert.equal(store.data.get(STORAGE_KEY), envelope([tx('a')], SCHEMA_VERSION + 1), 'the newer data was left untouched');
  });

  it('blocked saving with no edits made holds nothing only in memory, so it does not block an update', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')], SCHEMA_VERSION + 1));
    const model = providerModel(store);
    assert.equal(evaluateReloadSafety({ ...safeInput, ...model.state }), null);
  });
});

describe('H1 regression: normal safe update and reload', () => {
  it('after a successful save the click activates the waiting worker and reloads exactly once when control changes', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')]));
    const model = providerModel(store);
    model.commit([tx('new'), ...model.transactions]);
    assert.equal(model.state.lastStatus, 'saved');

    const registration = new FakeRegistration(); const container = new FakeContainer(); const counters = { reloads: 0, deferred: 0 };
    const getBlock = () => evaluateReloadSafety({ ...safeInput, ...model.state });
    assert.equal(getBlock(), null);
    assert.equal(bannerClick({ getBlock, registration, container, counters }), 'requested');
    assert.deepEqual(registration.waiting!.posted, [{ type: 'SKIP_WAITING' }]);
    assert.equal(counters.reloads, 0, 'no reload before the new worker takes control');
    container.fireControllerChange(); container.fireControllerChange();
    assert.deepEqual(counters, { reloads: 1, deferred: 0 });
    assert.ok(store.data.get(STORAGE_KEY)!.includes('"new"') || store.data.get(STORAGE_KEY)!.includes('item new'));
  });
});

describe('H1 regression: active restore operation', () => {
  it('a restore in progress blocks Reload until it ends or is cancelled', () => {
    const end = registerReloadActivity('restore-in-progress');
    cleanup.push(end);
    const getBlock = () => evaluateReloadSafety({ ...safeInput, activities: getReloadActivities() });
    assert.equal(getBlock()?.reason, 'restore-in-progress');
    const registration = new FakeRegistration(); const container = new FakeContainer(); const counters = { reloads: 0, deferred: 0 };
    assert.equal(bannerClick({ getBlock, registration, container, counters }), 'disabled');
    assert.deepEqual(registration.waiting!.posted, []);
    end();
    assert.equal(getBlock(), null);
    assert.equal(bannerClick({ getBlock, registration, container, counters }), 'requested');
  });

  it('a restore that starts after the click but before the controller changes defers the reload instead of discarding it', () => {
    const getBlock = () => evaluateReloadSafety({ ...safeInput, activities: getReloadActivities() });
    const registration = new FakeRegistration(); const container = new FakeContainer(); const counters = { reloads: 0, deferred: 0 };
    assert.equal(bannerClick({ getBlock, registration, container, counters }), 'requested');
    cleanup.push(registerReloadActivity('restore-in-progress'));
    container.fireControllerChange();
    assert.deepEqual(counters, { reloads: 0, deferred: 1 });
  });

  it('an incomplete restore keeps Reload blocked while the session reports it (a notice is not an input; see reloadSafety.final.test.ts)', () => {
    assert.equal(evaluateReloadSafety({ ...safeInput, storageHazard: 'restore-incomplete' })?.reason, 'restore-incomplete');
    assert.equal(evaluateReloadSafety({ ...safeInput, storageHazard: null }), null);
  });

  it('the storage restore itself is synchronous, so it can never be interrupted by a click', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')]));
    const { session } = providerModel(store);
    const outcome = session.restore({ mode: 'merge', incoming: [tx('b')] }) as unknown as { then?: unknown; status: string };
    assert.equal(typeof outcome.then, 'undefined');
    assert.equal(outcome.status, 'restored');
  });
});

describe('H1: draft protection and registry', () => {
  it('an open draft blocks Reload and releases when the form closes; counts nested registrations', () => {
    const a = registerReloadActivity('draft-open'); const b = registerReloadActivity('draft-open');
    cleanup.push(a, b);
    a();
    assert.deepEqual([...getReloadActivities()], ['draft-open']);
    a(); // releasing twice must not release the other registration
    assert.deepEqual([...getReloadActivities()], ['draft-open']);
    b();
    assert.deepEqual([...getReloadActivities()], []);
  });

  it('notifies subscribers and gives a stable snapshot until something changes', () => {
    let calls = 0;
    const unsubscribe = subscribeReloadActivities(() => { calls += 1; });
    cleanup.push(unsubscribe);
    const before = getReloadActivities();
    assert.equal(getReloadActivities(), before);
    const end = registerReloadActivity('draft-open'); cleanup.push(end);
    assert.equal(calls, 1);
    assert.notEqual(getReloadActivities(), before);
  });
});

// ───────────── wiring: pin the real source the mirrors above stand for ─────────────

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('wiring in the real source', () => {
  it('the provider exposes hasUnsavedChanges and recomputes it after the save effect, so blocked and failed saves count as unsaved', () => {
    const src = read('src/state/TransactionsContext.tsx');
    assert.match(src, /hasUnsavedChanges: boolean;/);
    assert.match(src, /if \(transactions === syncedRef\.current\) return;/, 'the accepted save-effect guard is unchanged');
    assert.match(src, /setHasUnsavedChanges\(transactions !== syncedRef\.current\);\s*\}, \[transactions\]\);/);
    assert.ok(src.indexOf('session.save(transactions)') < src.indexOf('setHasUnsavedChanges(transactions !== syncedRef.current)'), 'the tracking effect is declared after the save effect');
    assert.match(src, /setPersistenceOk\(false\)/, 'existing failed-save handling is unchanged');
    assert.match(src, /reason: 'unsaved-changes'/, 'the existing restore refusal is unchanged');
  });

  it('the banner checks the guard before requesting activation, disables the button while blocked and reloads through the guarded callback', () => {
    const src = read('src/components/layout/UpdateBanner.tsx');
    assert.match(src, /useTransactions\(\)/);
    assert.match(src, /storageHazard/);
    assert.doesNotMatch(src, /storageNotice/, 'the verdict never reads a notice');
    assert.match(src, /if \(!registration \|\| reloading \|\| block !== null \|\| getLiveBlock\(\) !== null\) return;/);
    assert.ok(src.indexOf('getLiveBlock() !== null') < src.indexOf('requestUpdateActivation('), 'the guard runs before the request');
    assert.match(src, /createGuardedReload\(\{/);
    assert.match(src, /disabled=\{reloading \|\| block !== null\}/);
    assert.match(src, /block \? block\.message/);
    assert.equal((src.match(/location\.reload\(\)/g) ?? []).length, 1, 'still a single reload call site');
  });

  it('the import card and the transaction form register the activities that block a reload', () => {
    assert.match(read('src/components/data/ImportRestoreCard.tsx'), /useReloadActivity\('restore-in-progress', stage\.name === 'reading' \|\| stage\.name === 'preview'\)/);
    const form = read('src/components/transactions/TransactionForm.tsx');
    assert.match(form, /useReloadActivity\(\s*'draft-open'/);
    assert.match(form, /hasDraftChanges\(values, start\)/);
    assert.match(read('src/lib/validation.ts'), /values\.description !== start\.description/);
  });

  it('the service worker, the update lifecycle and the storage layer are untouched by this fix', () => {
    const lifecycle = read('src/pwa/updateLifecycle.ts');
    assert.doesNotMatch(lifecycle, /reloadGuard|useReloadActivity/);
    assert.doesNotMatch(read('public/sw.js'), /reloadGuard|hasUnsavedChanges/);
    assert.doesNotMatch(read('src/lib/storage.ts'), /reloadGuard|hasUnsavedChanges/);
  });
});
