/**
 * Phase 4A (data safety) tests for src/lib/storage.ts and its wiring into the provider.
 * Uses an in-memory fake of the Web Storage API with failure injection; no browser, no packages.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  RECOVERY_KEY_PREFIX,
  SCHEMA_VERSION,
  STORAGE_KEY,
  getBrowserStorage,
  openSession,
  parseStoredPayload,
  preserveRawCopy,
  requestPersistentStorage,
} from '../src/lib/storage.ts';
import type { StorageLike } from '../src/lib/storage.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  writes: string[] = [];
  failReads = false;
  failWrite: (key: string) => boolean = () => false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) {
    if (this.failReads) throw new Error('SecurityError');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrite(k)) throw new Error('QuotaExceededError');
    this.writes.push(k);
    this.data.set(k, v);
  }
  recoveryKeys() { return [...this.data.keys()].filter((k) => k.startsWith(RECOVERY_KEY_PREFIX)); }
}

const tx = (id: string, date = '2026-11-01', over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date, ...over,
});
const envelope = (transactions: unknown[], version: number = SCHEMA_VERSION) =>
  JSON.stringify({ schemaVersion: version, savedAt: '2026-11-10T08:00:00.000Z', transactions });
const seeded = (raw: string) => { const s = new FakeStorage(); s.data.set(STORAGE_KEY, raw); return s; };

const GOOD = [tx('a'), tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 400_000 })];
const BAD = [{ id: 'x1', type: 'expense', amount: 0, categoryId: 'c', description: 'd', date: '2026-11-01' }, { nope: true }];

// ───────────── A/B. outcomes and first run ─────────────

describe('storage outcomes', () => {
  it('genuine first run → "empty": empty list, nothing written, not blocked, no notice', () => {
    const store = new FakeStorage();
    const { boot } = openSession(store);
    assert.equal(boot.status, 'empty');
    assert.deepEqual(boot.transactions, []);
    assert.equal(boot.saveBlocked, null);
    assert.equal(boot.notice, null);
    assert.equal(store.writes.length, 0, 'startup must not write anything');
    assert.equal(store.data.size, 0);
  });

  it('valid legacy bare array still loads, unchanged, with nothing rewritten', () => {
    const raw = JSON.stringify(GOOD);
    const store = seeded(raw);
    const { boot } = openSession(store);
    assert.equal(boot.status, 'ok');
    assert.equal(boot.format, 'legacy');
    assert.deepEqual(boot.transactions, GOOD);
    assert.equal(boot.invalid, 0);
    assert.equal(boot.notice, null);
    assert.equal(store.data.get(STORAGE_KEY), raw);
    assert.equal(store.writes.length, 0);
    assert.equal(store.recoveryKeys().length, 0);
  });

  it('valid versioned envelope loads', () => {
    const store = seeded(envelope(GOOD));
    const { boot } = openSession(store);
    assert.equal(boot.status, 'ok');
    assert.equal(boot.format, 'envelope');
    assert.deepEqual(boot.transactions, GOOD);
    assert.equal(boot.accepted, 2);
    assert.equal(boot.invalid, 0);
    assert.equal(store.writes.length, 0);
  });

  it('an intentionally empty saved list ([] / empty envelope) is "ok", not a first run', () => {
    for (const raw of ['[]', envelope([])]) {
      const { boot } = openSession(seeded(raw));
      assert.equal(boot.status, 'ok');
      assert.deepEqual(boot.transactions, []);
    }
  });

  it('corrupt JSON is "corrupt", not "empty"; original preserved verbatim; main key untouched', () => {
    const raw = '{"schemaVersion":1,"transactions":[{"id":"a"';
    const store = seeded(raw);
    const { boot } = openSession(store);
    assert.equal(boot.status, 'corrupt');
    assert.notEqual(boot.status, 'empty');
    assert.deepEqual(boot.transactions, []);
    assert.equal(boot.recovery?.ok, true);
    assert.equal(boot.saveBlocked, null);
    assert.equal(store.data.get(STORAGE_KEY), raw, 'original stays in place until the user saves');
    const [key] = store.recoveryKeys();
    assert.equal(store.data.get(key), raw, 'byte-for-byte copy');
    assert.equal(boot.notice?.kind, 'corrupt');
  });

  it('other unusable payloads (null, number, string, object without a version) are corrupt too', () => {
    for (const raw of ['null', '5', '"text"', '{}', '{"transactions":[]}', '', 'not json']) {
      const store = seeded(raw);
      const { boot } = openSession(store);
      assert.equal(boot.status, 'corrupt', JSON.stringify(raw));
      assert.equal(store.data.get(STORAGE_KEY), raw);
      assert.equal(store.data.get(store.recoveryKeys()[0]), raw);
    }
  });

  it('storage read failure → "unavailable": not a first run, saving blocked, nothing written', () => {
    const store = seeded(envelope(GOOD));
    store.failReads = true;
    const session = openSession(store);
    assert.equal(session.boot.status, 'unavailable');
    assert.notEqual(session.boot.status, 'empty');
    assert.deepEqual(session.boot.transactions, []);
    assert.equal(session.boot.saveBlocked, 'unavailable');
    assert.equal(session.boot.notice?.kind, 'unavailable');
    store.failReads = false;
    assert.deepEqual(session.save([tx('n')]), { status: 'blocked', reason: 'unavailable' });
    assert.equal(store.writes.length, 0);
    assert.equal(store.data.get(STORAGE_KEY), envelope(GOOD), 'existing data untouched');
  });

  it('no storage object at all (access blocked) → "unavailable"', () => {
    const session = openSession(null);
    assert.equal(session.boot.status, 'unavailable');
    assert.equal(session.boot.saveBlocked, 'unavailable');
    assert.equal(getBrowserStorage(), null); // no `window` under Node
  });
});

// ───────────── demo data ─────────────

describe('demo data is never seeded automatically', () => {
  it('no startup outcome other than stored valid data yields transactions', () => {
    const failing = new FakeStorage(); failing.failReads = true;
    for (const store of [new FakeStorage(), failing, seeded('garbage'), seeded(envelope(GOOD, 99))]) {
      const { boot } = openSession(store);
      assert.deepEqual(boot.transactions, [], boot.status);
    }
  });
  it('the provider no longer imports or calls createDemoTransactions', () => {
    const provider = readFileSync(new URL('../src/state/TransactionsContext.tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(provider, /createDemoTransactions|demoData/);
    for (const f of ['lib/storage.ts', 'App.tsx', 'main.tsx']) {
      assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /createDemoTransactions|demoData/, f);
    }
  });
});

// ───────────── C/E. invalid records and recovery ─────────────

describe('invalid records are counted and the original is preserved first', () => {
  const mixed = JSON.stringify([...GOOD, ...BAD, tx('a', '2026-11-02')]); // 2 good, 2 bad, 1 duplicate id

  it('reports accepted vs invalid, keeps valid values untouched, preserves the exact original', () => {
    const store = seeded(mixed);
    const { boot } = openSession(store);
    assert.equal(boot.status, 'ok');
    assert.equal(boot.accepted, 2);
    assert.equal(boot.invalid, 3);
    assert.deepEqual(boot.transactions, GOOD);
    assert.equal(boot.recovery?.ok, true);
    assert.equal(store.data.get(store.recoveryKeys()[0]), mixed);
    assert.equal(store.data.get(STORAGE_KEY), mixed, 'nothing cleaned yet');
    assert.equal(boot.notice?.kind, 'invalid-records');
    assert.match(boot.notice!.message, /3 of 5/);
  });

  it('the backup exists BEFORE the cleaned version can be written, and the cleaned save then works', () => {
    const store = seeded(mixed);
    const session = openSession(store);
    assert.equal(store.recoveryKeys().length, 1);
    assert.equal(session.save([...session.boot.transactions, tx('n')]).status, 'saved');
    const stored = parseStoredPayload(store.data.get(STORAGE_KEY)!);
    assert.equal(stored.status === 'ok' && stored.invalid, 0);
    assert.equal(store.data.get(store.recoveryKeys()[0]), mixed, 'recovery copy still the original');
  });

  it('failed recovery backup → saving blocked, original never replaced, failure is visible', () => {
    const store = seeded(mixed);
    store.failWrite = (k) => k.startsWith(RECOVERY_KEY_PREFIX);
    const session = openSession(store);
    assert.equal(session.boot.recovery?.ok, false);
    assert.equal(session.boot.saveBlocked, 'backup-failed');
    assert.deepEqual(session.boot.transactions, GOOD); // valid records still usable in memory
    assert.match(session.boot.notice!.message, /recovery copy couldn’t be made/);
    assert.match(session.boot.notice!.message, /paused/);
    assert.deepEqual(session.save([tx('n')]), { status: 'blocked', reason: 'backup-failed' });
    assert.equal(store.data.get(STORAGE_KEY), mixed);
    assert.equal(store.writes.length, 0);
  });

  it('failed backup for corrupt JSON also blocks replacement', () => {
    const store = seeded('{broken');
    store.failWrite = (k) => k.startsWith(RECOVERY_KEY_PREFIX);
    const session = openSession(store);
    assert.equal(session.boot.status, 'corrupt');
    assert.equal(session.boot.saveBlocked, 'backup-failed');
    assert.equal(session.save([tx('n')]).status, 'blocked');
    assert.equal(store.data.get(STORAGE_KEY), '{broken');
  });

  it('a backup that does not read back identically counts as failed', () => {
    const store = seeded('{broken');
    const realGet = store.getItem.bind(store);
    store.getItem = (k: string) => (k.startsWith(RECOVERY_KEY_PREFIX) ? 'truncated' : realGet(k));
    assert.deepEqual(preserveRawCopy(store, '{broken'), { ok: false });
  });

  it('notices never contain transaction contents', () => {
    const secret = JSON.stringify([tx('s', '2026-11-01', { description: 'TOP-SECRET-DESCRIPTION' }), ...BAD]);
    const { boot } = openSession(seeded(secret));
    assert.doesNotMatch(boot.notice!.message, /TOP-SECRET|item|groceries/);
    const { boot: corrupt } = openSession(seeded('{"description":"TOP-SECRET'));
    assert.doesNotMatch(corrupt.notice!.message, /TOP-SECRET/);
  });
});

describe('recovery keys are collision-safe', () => {
  it('different damaged payloads get different keys; earlier copies are never overwritten', () => {
    const store = new FakeStorage();
    const fixedNow = () => 1_700_000_000_000; // same millisecond on purpose
    const first = preserveRawCopy(store, 'damaged-1', fixedNow);
    const second = preserveRawCopy(store, 'damaged-2', fixedNow);
    assert.ok(first.ok && second.ok);
    assert.notEqual(first.ok && first.key, second.ok && second.key);
    assert.equal(store.data.get(first.ok ? first.key : ''), 'damaged-1');
    assert.equal(store.data.get(second.ok ? second.key : ''), 'damaged-2');
    assert.ok([...store.data.keys()].every((k) => k.startsWith(RECOVERY_KEY_PREFIX)));
  });
  it('never writes to a key that is already taken', () => {
    const store = new FakeStorage();
    const orig = Math.random;
    Math.random = () => 0.123456; // every candidate key identical
    try {
      const a = preserveRawCopy(store, 'one', () => 1);
      const b = preserveRawCopy(store, 'two', () => 1);
      assert.ok(a.ok);
      assert.deepEqual(b, { ok: false }); // gives up rather than overwriting
      assert.equal(store.data.get(a.ok ? a.key : ''), 'one');
    } finally { Math.random = orig; }
  });
  it('the recovery prefix differs from the main key, so copies are never read as live data', () => {
    assert.notEqual(RECOVERY_KEY_PREFIX, STORAGE_KEY);
    assert.ok(!RECOVERY_KEY_PREFIX.startsWith(STORAGE_KEY));
  });
});

// ───────────── D. versioned envelope ─────────────

describe('versioned storage envelope', () => {
  it('new writes use { schemaVersion, savedAt, transactions } under the unchanged key', () => {
    const store = new FakeStorage();
    assert.equal(STORAGE_KEY, 'smart-expense-tracker:v1:transactions');
    const session = openSession(store);
    assert.equal(session.save([tx('a')]).status, 'saved');
    const stored = JSON.parse(store.data.get(STORAGE_KEY)!);
    assert.deepEqual(Object.keys(stored).sort(), ['savedAt', 'schemaVersion', 'transactions']);
    assert.equal(stored.schemaVersion, SCHEMA_VERSION);
    assert.ok(!Number.isNaN(Date.parse(stored.savedAt)));
    assert.deepEqual(stored.transactions, [tx('a')]);
  });

  it('a legacy array is upgraded only when the user next saves, and round-trips', () => {
    const store = seeded(JSON.stringify(GOOD));
    const session = openSession(store);
    assert.equal(store.writes.length, 0);
    session.save([...session.boot.transactions, tx('c')]);
    const again = openSession(store);
    assert.equal(again.boot.format, 'envelope');
    assert.equal(again.boot.transactions.length, 3);
  });

  it('unsupported versions are untouched: blocked, no copy needed, main key identical', () => {
    for (const v of [0, 2, 99, -1]) {
      const raw = envelope(GOOD, v);
      const store = seeded(raw);
      const session = openSession(store);
      assert.equal(session.boot.status, 'corrupt');
      assert.equal(session.boot.reason, 'unsupported-version');
      assert.equal(session.boot.saveBlocked, 'unsupported-version');
      assert.equal(session.boot.notice?.kind, 'unsupported-version');
      assert.equal(session.save([tx('n')]).status, 'blocked');
      assert.equal(store.data.get(STORAGE_KEY), raw, `version ${v} must not be erased`);
      assert.equal(store.writes.length, 0);
    }
  });

  it('malformed envelopes are never silently erased: copy preserved, notice shown', () => {
    const cases = [
      JSON.stringify({ schemaVersion: 1, savedAt: 'x' }),                    // no transactions
      JSON.stringify({ schemaVersion: 1, transactions: [] }),                // no savedAt
      JSON.stringify({ schemaVersion: 1, savedAt: 'x', transactions: {} }),  // not an array
      JSON.stringify({ schemaVersion: '1', savedAt: 'x', transactions: [] }),// version not a number
      JSON.stringify({ schemaVersion: 1.5, savedAt: 'x', transactions: [] }),
    ];
    for (const raw of cases) {
      const store = seeded(raw);
      const { boot } = openSession(store);
      assert.equal(boot.status, 'corrupt', raw);
      assert.equal(store.data.get(store.recoveryKeys()[0]), raw);
      assert.equal(store.data.get(STORAGE_KEY), raw);
      assert.ok(boot.notice);
    }
  });

  it('invalid records inside an envelope are counted and preserved the same way', () => {
    const raw = envelope([...GOOD, ...BAD]);
    const store = seeded(raw);
    const { boot } = openSession(store);
    assert.equal(boot.accepted, 2);
    assert.equal(boot.invalid, 2);
    assert.equal(store.data.get(store.recoveryKeys()[0]), raw);
  });
});

// ───────────── Phase 3 policy: stored future-dated records ─────────────

describe('future-dated records already in storage are preserved (Phase 3 behaviour)', () => {
  const future = tx('f', '2099-01-01');
  it('load as-is, raise no notice and no recovery copy, and survive later saves', () => {
    for (const raw of [JSON.stringify([future, ...GOOD]), envelope([future, ...GOOD])]) {
      const store = seeded(raw);
      const session = openSession(store);
      assert.equal(session.boot.invalid, 0);
      assert.equal(session.boot.notice, null);
      assert.equal(store.recoveryKeys().length, 0);
      assert.ok(session.boot.transactions.some((t) => t.id === 'f' && t.date === '2099-01-01'));
      session.save([...session.boot.transactions, tx('n')]);
      const saved = openSession(store).boot.transactions;
      assert.ok(saved.some((t) => t.id === 'f' && t.date === '2099-01-01'));
    }
  });
});

// ───────────── F. multi-tab ─────────────

describe('multi-tab safety', () => {
  it('a stale tab cannot overwrite newer data: its save is refused and the newer data adopted', () => {
    const store = new FakeStorage();
    const tabA = openSession(store);
    const tabB = openSession(store); // both started on an empty store
    assert.equal(tabA.save([tx('a')]).status, 'saved');
    const stored = store.data.get(STORAGE_KEY);

    const result = tabB.save([tx('b')]); // B is stale
    assert.equal(result.status, 'conflict');
    assert.equal(store.data.get(STORAGE_KEY), stored, 'A\'s data must not be overwritten');
    if (result.status !== 'conflict' || result.sync.action !== 'adopt') return assert.fail('expected adopt');
    assert.deepEqual(result.sync.transactions, [tx('a')]);
    assert.equal(result.sync.notice.kind, 'conflict');
  });

  it('after adopting, the tab can save again (no refusal loop) and the other tab then sees it', () => {
    const store = new FakeStorage();
    const tabA = openSession(store);
    const tabB = openSession(store);
    tabA.save([tx('a')]);
    const r = tabB.save([tx('b')]);
    assert.equal(r.status, 'conflict');
    assert.equal(tabB.syncFromStorage('event').action, 'none'); // already in sync, nothing to reload
    assert.equal(tabB.save([tx('a'), tx('b')]).status, 'saved');
    const ev = tabA.syncFromStorage('event');
    assert.equal(ev.action, 'adopt');
    assert.equal(ev.action === 'adopt' && ev.transactions.length, 2);
    assert.equal(ev.action === 'adopt' && ev.notice.kind, 'external-update');
    assert.equal(tabA.syncFromStorage('event').action, 'none'); // idempotent: no loop
  });

  it('a storage event for our own last write changes nothing', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    assert.equal(tab.syncFromStorage('event').action, 'none');
    assert.equal(store.writes.length, 1);
  });

  it('syncing never writes to the main key', () => {
    const store = new FakeStorage();
    const tabA = openSession(store);
    const tabB = openSession(store);
    tabA.save([tx('a')]);
    const before = store.writes.length;
    tabB.syncFromStorage('event');
    assert.equal(store.writes.length, before);
  });

  it('another tab removing the main key is a deletion conflict: kept in memory, notice shown, key NOT recreated', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    const writesBefore = store.writes.length;
    store.data.delete(STORAGE_KEY);

    const out = tab.syncFromStorage('event');
    assert.equal(out.action, 'keep'); // never 'adopt': the tab's list is not replaced by "nothing"
    assert.equal(out.action === 'keep' && out.notice?.kind, 'removed-elsewhere');
    assert.match(out.action === 'keep' ? out.notice!.message : '', /removed in another tab/);
    assert.match(out.action === 'keep' ? out.notice!.message : '', /can’t be saved/);
    assert.equal(store.data.has(STORAGE_KEY), false, 'must not be recreated automatically');
    assert.equal(store.writes.length, writesBefore, 'syncing must not write anything');
  });

  it('a later save after the removal is blocked and the key stays deleted', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    store.data.delete(STORAGE_KEY);
    tab.syncFromStorage('event');
    for (const list of [[tx('a')], [tx('a'), tx('b')], []]) {
      assert.deepEqual(tab.save(list), { status: 'blocked', reason: 'removed-elsewhere' });
    }
    assert.equal(store.data.has(STORAGE_KEY), false);
    assert.equal(openSession(store).boot.status, 'empty');
  });

  it('a save attempted BEFORE the event arrives is also refused (no recreation), and reports the removal', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    store.data.delete(STORAGE_KEY); // no event delivered to this tab
    const result = tab.save([tx('a'), tx('b')]);
    assert.equal(result.status, 'conflict');
    assert.equal(result.status === 'conflict' && result.sync.action, 'keep');
    assert.equal(result.status === 'conflict' && result.sync.action === 'keep' && result.sync.notice?.kind, 'removed-elsewhere');
    assert.equal(store.data.has(STORAGE_KEY), false);
    assert.equal(tab.save([tx('a'), tx('b')]).status, 'blocked');
  });

  it('existing in-memory data is not discarded: no session path replaces or clears it', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a'), tx('b')]);
    store.data.delete(STORAGE_KEY);
    const out = tab.syncFromStorage('event');
    assert.notEqual(out.action, 'adopt');
    assert.equal('transactions' in out, false, 'the outcome carries no replacement list');
    // and at the provider level, only an "adopt" outcome ever dispatches a replace
    const provider = readFileSync(new URL('../src/state/TransactionsContext.tsx', import.meta.url), 'utf8');
    assert.match(provider, /if \(outcome\.action === 'adopt'\) \{[^}]*dispatch\(\{ type: 'replace'/s);
    assert.equal((provider.match(/type: 'replace'/g) ?? []).length, 1);
  });

  it('no event loop: repeated removal events are no-ops and never write', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    store.data.delete(STORAGE_KEY);
    assert.equal(tab.syncFromStorage('event').action, 'keep');
    const writes = store.writes.length;
    for (let i = 0; i < 5; i++) assert.deepEqual(tab.syncFromStorage('event'), { action: 'none' });
    assert.equal(store.writes.length, writes);
    assert.equal(store.data.size, 0);
  });

  it('removal also blocks a tab that was blocked for another reason (stays conservative)', () => {
    const store = seeded(envelope(GOOD, 2));
    const tab = openSession(store);
    store.data.delete(STORAGE_KEY);
    tab.syncFromStorage('event');
    assert.deepEqual(tab.save([tx('a')]), { status: 'blocked', reason: 'removed-elsewhere' });
    assert.equal(store.data.has(STORAGE_KEY), false);
  });

  it('after a removal, a valid update from another tab is adopted and saving works again', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    const other = openSession(store);
    tab.save([tx('a')]);
    other.syncFromStorage('event');
    store.data.delete(STORAGE_KEY);
    tab.syncFromStorage('event');
    assert.equal(tab.save([tx('a')]).status, 'blocked');

    // another tab starts fresh and stores new data
    const fresh = openSession(store);
    assert.equal(fresh.save([tx('n1'), tx('n2')]).status, 'saved');

    const ev = tab.syncFromStorage('event');
    assert.equal(ev.action, 'adopt');
    assert.deepEqual(ev.action === 'adopt' && ev.transactions.map((t) => t.id), ['n1', 'n2']);
    assert.equal(ev.action === 'adopt' && ev.notice.kind, 'external-update');
    assert.equal(tab.save([tx('n1'), tx('n2'), tx('n3')]).status, 'saved');
  });

  it('ordinary external updates and stale-write conflicts behave exactly as before', () => {
    const store = new FakeStorage();
    const a = openSession(store);
    const b = openSession(store);
    a.save([tx('a')]);
    const conflict = b.save([tx('b')]);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.status === 'conflict' && conflict.sync.action, 'adopt');
    assert.equal(conflict.status === 'conflict' && conflict.sync.action === 'adopt' && conflict.sync.notice.kind, 'conflict');
    assert.equal(b.save([tx('a'), tx('b')]).status, 'saved');
    assert.equal(a.syncFromStorage('event').action, 'adopt');
  });

  it('a stored list that someone else set to "[]" is a valid update, not a removal', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    store.data.set(STORAGE_KEY, envelope([]));
    const ev = tab.syncFromStorage('event');
    assert.equal(ev.action, 'adopt');
    assert.deepEqual(ev.action === 'adopt' && ev.transactions, []);
  });

  it('unreadable data written elsewhere is preserved, this tab keeps its own data', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    store.data.set(STORAGE_KEY, '{garbage');
    const out = tab.syncFromStorage('event');
    assert.equal(out.action, 'keep');
    assert.equal(out.action === 'keep' && out.notice?.kind, 'external-unreadable');
    assert.equal(store.data.get(store.recoveryKeys()[0]), '{garbage');
  });

  it('a newer-version payload written elsewhere is left alone and blocks saving', () => {
    const store = new FakeStorage();
    const tab = openSession(store);
    tab.save([tx('a')]);
    const raw = envelope(GOOD, 2);
    store.data.set(STORAGE_KEY, raw);
    tab.syncFromStorage('event');
    assert.equal(tab.save([tx('a'), tx('z')]).status, 'blocked');
    assert.equal(store.data.get(STORAGE_KEY), raw);
  });

  it('a failed write (quota) leaves stored data intact and is reported, not swallowed', () => {
    const store = seeded(envelope(GOOD));
    const session = openSession(store);
    store.failWrite = (k) => k === STORAGE_KEY;
    assert.equal(session.save([...GOOD, tx('n')]).status, 'failed');
    assert.equal(store.data.get(STORAGE_KEY), envelope(GOOD));
    store.failWrite = () => false;
    assert.equal(session.save([...GOOD, tx('n')]).status, 'saved'); // retry works
  });
});

// ───────────── StrictMode / repeated initialisation ─────────────

describe('repeated initialisation (StrictMode) is never destructive', () => {
  it('opening an empty store repeatedly writes nothing', () => {
    const store = new FakeStorage();
    for (let i = 0; i < 4; i++) openSession(store);
    assert.equal(store.writes.length, 0);
    assert.equal(store.data.size, 0);
  });
  it('opening damaged data repeatedly keeps one recovery copy and never touches the main key', () => {
    const store = seeded('{damaged');
    for (let i = 0; i < 4; i++) openSession(store);
    assert.equal(store.recoveryKeys().length, 1);
    assert.equal(store.data.get(STORAGE_KEY), '{damaged');
    assert.equal(store.writes.length, 1); // just the one recovery copy
  });
  it('opening partly invalid data repeatedly keeps one copy and never cleans the main key', () => {
    const raw = JSON.stringify([...GOOD, ...BAD]);
    const store = seeded(raw);
    for (let i = 0; i < 3; i++) openSession(store);
    assert.equal(store.recoveryKeys().length, 1);
    assert.equal(store.data.get(STORAGE_KEY), raw);
  });
  it('opening valid data repeatedly writes nothing', () => {
    const store = seeded(envelope(GOOD));
    for (let i = 0; i < 3; i++) openSession(store);
    assert.equal(store.writes.length, 0);
  });
});

describe('wiring guard (source text): the provider cannot save prematurely or loop', () => {
  const provider = readFileSync(new URL('../src/state/TransactionsContext.tsx', import.meta.url), 'utf8');
  it('state starts from the session and the save effect skips while state equals the synced list', () => {
    assert.match(provider, /useReducer\(transactionsReducer, session\.boot\.transactions\)/);
    assert.match(provider, /useRef\(session\.boot\.transactions\)/);
    assert.match(provider, /if \(transactions === syncedRef\.current\) return;/);
    assert.doesNotMatch(provider, /isFirstRender/);
  });
  it('adopting another tab\'s data marks it as synced BEFORE dispatching, so it is never re-saved', () => {
    const adopt = provider.slice(provider.indexOf("outcome.action === 'adopt'"));
    assert.ok(adopt.indexOf('syncedRef.current = outcome.transactions') < adopt.indexOf("dispatch({ type: 'replace'"));
  });
  it('listens to the storage event for our key only and cleans up', () => {
    assert.match(provider, /addEventListener\('storage', onStorage\)/);
    assert.match(provider, /removeEventListener\('storage', onStorage\)/);
    assert.match(provider, /event\.key !== null && event\.key !== STORAGE_KEY/);
  });
  it('the sync path never saves: applySync does not call session.save', () => {
    const fn = provider.slice(provider.indexOf('const applySync'), provider.indexOf('// Save after real changes'));
    assert.doesNotMatch(fn, /session\.save/);
  });
  it('the persistent-storage request is fire-and-forget and runs after a successful save only', () => {
    assert.match(provider, /void requestPersistentStorage\(\)/);
    const saved = provider.slice(provider.indexOf("outcome.status === 'saved'"), provider.indexOf("outcome.status === 'failed'"));
    assert.match(saved, /requestPersistentStorage/);
  });
  it('the UI shows the notice message only (role=alert) with a dismiss button', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    assert.match(app, /storageNotice &&/);
    assert.match(app, /\{storageNotice\.message\}/);
  });
});

// ───────────── G. persistent storage request ─────────────

describe('requestPersistentStorage (best effort, never throws)', () => {
  it('unsupported: no manager, or no persist()', async () => {
    assert.equal(await requestPersistentStorage(undefined), 'unsupported');
    assert.equal(await requestPersistentStorage({}), 'unsupported');
  });
  it('granted / denied', async () => {
    assert.equal(await requestPersistentStorage({ persist: async () => true }), 'granted');
    assert.equal(await requestPersistentStorage({ persist: async () => false }), 'denied');
  });
  it('already persisted: does not ask again', async () => {
    let asked = 0;
    const r = await requestPersistentStorage({ persisted: async () => true, persist: async () => { asked++; return true; } });
    assert.equal(r, 'granted');
    assert.equal(asked, 0);
  });
  it('a rejected promise or a throwing API resolves to "error"', async () => {
    assert.equal(await requestPersistentStorage({ persist: () => Promise.reject(new Error('no')) }), 'error');
    assert.equal(await requestPersistentStorage({ persisted: () => { throw new Error('boom'); }, persist: async () => true }), 'error');
  });
});
