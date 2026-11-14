/**
 * Phase 4B, Stage 2 tests: Merge / Replace restore in the STORAGE layer (src/lib/storage.ts) and its
 * wiring in the provider. No UI, no browser, no packages: an in-memory Web Storage fake with failure
 * injection and an operation log.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { planMerge } from '../src/lib/backup.ts';
import {
  MAX_SNAPSHOTS,
  RECOVERY_KEY_PREFIX,
  SCHEMA_VERSION,
  SNAPSHOT_KEY_PREFIX,
  STORAGE_KEY,
  listSnapshotKeys,
  openSession,
  planRestoreMerge,
  validateIncoming,
} from '../src/lib/storage.ts';
import type { RestoreOutcome, StorageLike } from '../src/lib/storage.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

type Op = { op: 'set' | 'remove'; key: string };

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  log: Op[] = [];
  /** Throw (e.g. quota) for a write to this key. */
  failSet: (key: string, value: string) => boolean = () => false;
  /** Change what is actually stored for a write (simulates damage or another tab). */
  mangleSet: (key: string, value: string) => string | null = () => null;
  /** Change what a read returns. */
  mangleGet: (key: string, value: string | null) => string | null | undefined = () => undefined;
  failRemove: (key: string) => boolean = () => false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) {
    const real = this.data.get(k) ?? null;
    const altered = this.mangleGet(k, real);
    return altered === undefined ? real : altered;
  }
  setItem(k: string, v: string) {
    if (this.failSet(k, v)) throw new Error('QuotaExceededError');
    this.log.push({ op: 'set', key: k });
    this.data.set(k, this.mangleSet(k, v) ?? v);
  }
  removeItem(k: string) {
    if (this.failRemove(k)) throw new Error('SecurityError');
    this.log.push({ op: 'remove', key: k });
    this.data.delete(k);
  }
  keysWith(prefix: string) { return [...this.data.keys()].filter((k) => k.startsWith(prefix)); }
  snapshots() { return this.keysWith(SNAPSHOT_KEY_PREFIX); }
  recoveries() { return this.keysWith(RECOVERY_KEY_PREFIX); }
  removals() { return this.log.filter((o) => o.op === 'remove'); }
  storageWrites() { return this.log.filter((o) => o.op === 'set' && o.key === STORAGE_KEY); }
}

const tx = (id: string, date = '2026-11-01', over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date, ...over,
});
const envelope = (transactions: unknown[], version: number = SCHEMA_VERSION) =>
  JSON.stringify({ schemaVersion: version, savedAt: '2026-11-10T08:00:00.000Z', transactions });
const seeded = (raw: string) => { const s = new FakeStorage(); s.data.set(STORAGE_KEY, raw); return s; };
const clock = (start = 2_000_000_000_000) => { let t = start; return () => t++; };
const stored = (s: FakeStorage): Transaction[] => (JSON.parse(s.data.get(STORAGE_KEY)!) as { transactions: Transaction[] }).transactions;
const asRestored = (o: RestoreOutcome) => { assert.equal(o.status, 'restored', JSON.stringify(o)); return o as Extract<RestoreOutcome, { status: 'restored' }>; };
const asRefused = (o: RestoreOutcome) => { assert.equal(o.status, 'refused', JSON.stringify(o)); return o as Extract<RestoreOutcome, { status: 'refused' }>; };
const asFailed = (o: RestoreOutcome) => { assert.equal(o.status, 'failed', JSON.stringify(o)); return o as Extract<RestoreOutcome, { status: 'failed' }>; };

const A = [tx('a'), tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 400_000 })];
const RAW_A = envelope(A);
const INCOMING = [tx('n1', '2026-09-01'), tx('n2', '2026-09-02')];

/** Pre-seed `count` snapshots of distinct times (oldest first) and two recovery copies. */
function seedSnapshots(s: FakeStorage, count: number) {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${SNAPSHOT_KEY_PREFIX}${(1_000_000 + i).toString(36)}-seed${i}`;
    s.data.set(key, `old snapshot ${i}`);
    keys.push(key);
  }
  s.data.set(`${RECOVERY_KEY_PREFIX}aaa-one`, 'recovery one raw');
  s.data.set(`${RECOVERY_KEY_PREFIX}bbb-two`, 'recovery two raw');
  return keys;
}

// ───────────── A. keys never overlap ─────────────

describe('key spaces are disjoint, so pruning snapshots cannot reach recovery copies or live data', () => {
  it('no prefix starts with another, and none matches the live key', () => {
    assert.equal(SNAPSHOT_KEY_PREFIX.startsWith(RECOVERY_KEY_PREFIX), false);
    assert.equal(RECOVERY_KEY_PREFIX.startsWith(SNAPSHOT_KEY_PREFIX), false);
    assert.equal(STORAGE_KEY.startsWith(SNAPSHOT_KEY_PREFIX), false);
    assert.equal(STORAGE_KEY.startsWith(RECOVERY_KEY_PREFIX), false);
    assert.equal(MAX_SNAPSHOTS, 5);
  });
});

// ───────────── B. replace: success path and ordering ─────────────

describe('Replace: snapshot first, then persist, then verify', () => {
  it('writes the snapshot (byte-for-byte) BEFORE touching the live key, and returns the verified list', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));

    const firstLiveWrite = store.log.findIndex((o) => o.op === 'set' && o.key === STORAGE_KEY);
    const snapshotWrite = store.log.findIndex((o) => o.op === 'set' && o.key.startsWith(SNAPSHOT_KEY_PREFIX));
    assert.ok(snapshotWrite >= 0 && snapshotWrite < firstLiveWrite, 'snapshot must be written first');
    assert.equal(store.data.get(out.snapshotKey!), RAW_A, 'snapshot is the previous raw string, byte-for-byte');
    assert.deepEqual(stored(store), INCOMING);
    assert.deepEqual(out.transactions, INCOMING);
    assert.equal(out.changed, true);
    assert.equal(out.merge, null);
    assert.equal(out.pruneIncomplete, false);
  });

  it('the session stays in step: a later save has no conflict and a sync is a no-op', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.deepEqual(session.syncFromStorage('event'), { action: 'none' });
    assert.equal(session.save([...INCOMING, tx('z')]).status, 'saved');
  });

  it('future-dated records are preserved (not filtered, not altered)', () => {
    const future = [tx('f1', '2099-01-01'), tx('f2', '2026-01-01')];
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    asRestored(session.restore({ mode: 'replace', incoming: future }));
    assert.deepEqual(stored(store), future);
  });

  it('records are written exactly as given: unknown categories kept, extra properties dropped', () => {
    const odd = [{ ...tx('o1', '2026-02-02', { categoryId: 'no-such-category' }), extra: 'x' } as unknown as Transaction];
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    asRestored(session.restore({ mode: 'replace', incoming: odd }));
    assert.deepEqual(stored(store), [tx('o1', '2026-02-02', { categoryId: 'no-such-category' })]);
  });

  it('successive restores make distinct snapshots; none is reused or overwritten', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const one = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    const raw1 = store.data.get(STORAGE_KEY)!;
    const two = asRestored(session.restore({ mode: 'replace', incoming: A }));
    assert.notEqual(one.snapshotKey, two.snapshotKey);
    assert.equal(store.data.get(one.snapshotKey!), RAW_A);
    assert.equal(store.data.get(two.snapshotKey!), raw1);
  });

  it('a snapshot key that is already taken is never overwritten', () => {
    const store = seeded(RAW_A);
    const realRandom = Math.random;
    const times = clock(5);
    const first = `${SNAPSHOT_KEY_PREFIX}${(5).toString(36)}-${(0.5).toString(36).slice(2, 8)}`;
    store.data.set(first, 'precious');
    let calls = 0;
    Math.random = () => (calls++ === 0 ? 0.5 : 0.25); // first candidate collides, second does not
    try {
      const out = asRestored(openSession(store, times).restore({ mode: 'replace', incoming: INCOMING }));
      assert.notEqual(out.snapshotKey, first);
      assert.equal(store.data.get(first), 'precious');
    } finally {
      Math.random = realRandom;
    }
  });
});

// ───────────── C. empty storage ─────────────

describe('empty storage: nothing to protect, so no snapshot', () => {
  it('Replace into an empty store writes the list and makes no snapshot', () => {
    const store = new FakeStorage();
    const out = asRestored(openSession(store, clock()).restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.snapshotKey, null);
    assert.equal(store.snapshots().length, 0);
    assert.deepEqual(stored(store), INCOMING);
  });
  it('Merge into an empty store adds everything', () => {
    const store = new FakeStorage();
    const out = asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming: INCOMING }));
    assert.equal(out.snapshotKey, null);
    assert.deepEqual(stored(store), INCOMING);
    assert.equal(out.merge?.added, 2);
  });
  it('Replace with an EMPTY list is refused by default and writes nothing', () => {
    const store = seeded(RAW_A);
    const out = asRefused(openSession(store, clock()).restore({ mode: 'replace', incoming: [] }));
    assert.equal(out.reason, 'empty-replace');
    assert.equal(store.log.length, 0);
    assert.equal(store.data.get(STORAGE_KEY), RAW_A);
  });
  it('only an explicit allowEmptyReplace permits it — and then a snapshot protects the old data', () => {
    const store = seeded(RAW_A);
    const out = asRestored(openSession(store, clock()).restore({ mode: 'replace', incoming: [], allowEmptyReplace: true }));
    assert.deepEqual(stored(store), []);
    assert.equal(store.data.get(out.snapshotKey!), RAW_A);
  });
  it('allowEmptyReplace has no effect on Merge or on a non-empty replace', () => {
    const store = seeded(RAW_A);
    const out = asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming: [], allowEmptyReplace: true }));
    assert.equal(out.changed, false);
    assert.equal(store.log.length, 0);
  });
});

// ───────────── D. merge ─────────────

describe('Merge', () => {
  it('default policy keeps the existing record on a conflict; new ids are appended', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const incoming = [tx('a', '2026-11-01', { amount: 9_999 }), tx('c', '2026-08-08')];
    const out = asRestored(session.restore({ mode: 'merge', incoming }));
    assert.deepEqual(stored(store), [...A, tx('c', '2026-08-08')]);
    assert.equal(out.merge?.conflicts, 1);
    assert.equal(out.merge?.conflictsReplaced, 0);
    assert.equal(store.data.get(out.snapshotKey!), RAW_A);
  });

  it('use-incoming replaces conflicting records in place', () => {
    const store = seeded(RAW_A);
    const incoming = [tx('a', '2026-11-01', { amount: 9_999 })];
    const out = asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming, conflictPolicy: 'use-incoming' }));
    assert.deepEqual(stored(store), [tx('a', '2026-11-01', { amount: 9_999 }), A[1]]);
    assert.equal(out.merge?.conflictsReplaced, 1);
  });

  it('restoring the same data twice is a no-op: nothing written, no snapshot, no prune', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const out = asRestored(session.restore({ mode: 'merge', incoming: A }));
    assert.equal(out.changed, false);
    assert.equal(out.snapshotKey, null);
    assert.deepEqual(out.transactions, A);
    assert.equal(store.log.length, 0);
    assert.equal(store.data.get(STORAGE_KEY), RAW_A);
  });

  it('a merge whose only difference is a kept (not replaced) conflict is also a no-op', () => {
    const store = seeded(RAW_A);
    const out = asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming: [tx('a', '2026-11-01', { amount: 7 })] }));
    assert.equal(out.changed, false);
    assert.equal(store.log.length, 0);
  });

  it('merges into what is STORED (fresh read), and future-dated records survive on both sides', () => {
    const existing = [tx('e1', '2099-05-05'), tx('e2')];
    const store = seeded(envelope(existing));
    const out = asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming: [tx('i1', '2099-06-06')] }));
    assert.deepEqual(stored(store), [...existing, tx('i1', '2099-06-06')]);
    assert.equal(out.transactions.length, 3);
  });

  it('stored legacy bare-array data can be merged into (and is upgraded to the envelope)', () => {
    const store = seeded(JSON.stringify(A));
    asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming: INCOMING }));
    assert.deepEqual(stored(store), [...A, ...INCOMING]);
  });

  it('stored data with some invalid records: merge uses the valid ones; the original is kept in the snapshot', () => {
    const raw = envelope([...A, { id: 'bad', nope: true }]);
    const store = seeded(raw);
    const out = asRestored(openSession(store, clock()).restore({ mode: 'merge', incoming: INCOMING }));
    assert.deepEqual(stored(store), [...A, ...INCOMING]);
    assert.equal(store.data.get(out.snapshotKey!), raw);
  });

  it('unparseable stored data cannot be merged into: refused, nothing written or removed', () => {
    for (const raw of ['{not json', JSON.stringify({ schemaVersion: 1, savedAt: 5, transactions: 'x' })]) {
      const store = seeded(raw);
      const session = openSession(store, clock());
      const before = [...store.data.entries()];
      const out = asRefused(session.restore({ mode: 'merge', incoming: INCOMING }));
      assert.equal(out.reason, 'stored-unreadable');
      assert.equal(store.data.get(STORAGE_KEY), raw);
      assert.deepEqual(store.log.filter((o) => o.key === STORAGE_KEY), []);
      assert.equal(store.snapshots().length, 0);
      assert.equal(store.removals().length, 0);
      assert.ok(before.every(([k, v]) => store.data.get(k) === v), 'every pre-existing key is untouched (recovery copy from boot included)');
    }
  });
});

// ───────────── E. replace over unreadable data ─────────────

describe('Replace over corrupt stored data', () => {
  it('is allowed only because a byte-for-byte snapshot of the unreadable original is made and verified first', () => {
    const raw = '{this is not json';
    const store = seeded(raw);
    const session = openSession(store, clock());
    const recoveriesAtBoot = store.recoveries();
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(store.data.get(out.snapshotKey!), raw);
    assert.deepEqual(stored(store), INCOMING);
    assert.deepEqual(store.recoveries(), recoveriesAtBoot, 'the boot-time recovery copy is untouched');
  });

  it('if the snapshot cannot be made, a corrupt original is NOT replaced', () => {
    const raw = '{this is not json';
    const store = seeded(raw);
    const session = openSession(store, clock());
    store.failSet = (key) => key.startsWith(SNAPSHOT_KEY_PREFIX);
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'snapshot-write');
    assert.equal(store.data.get(STORAGE_KEY), raw);
  });
});

// ───────────── F. newer-version data and blocked sessions ─────────────

describe('data from a newer app version, and other blocked states', () => {
  it('newer-version data is never touched (Phase 4A rule): refused, zero writes, zero removals', () => {
    const raw = envelope(A, SCHEMA_VERSION + 1);
    const store = seeded(raw);
    const session = openSession(store, clock());
    for (const mode of ['merge', 'replace'] as const) {
      const out = asRefused(session.restore({ mode, incoming: INCOMING }));
      assert.equal(out.reason, 'blocked');
      assert.equal(out.blockedReason, 'unsupported-version');
    }
    assert.equal(store.data.get(STORAGE_KEY), raw);
    assert.equal(store.log.length, 0);
    assert.equal(store.data.size, 1, 'no snapshot, no recovery copy, nothing else was created');
  });

  it('unavailable storage: refused, nothing thrown', () => {
    const out = asRefused(openSession(null, clock()).restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.reason, 'unavailable');
  });

  it('removed-elsewhere keeps the session blocked: restore refused', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    store.data.delete(STORAGE_KEY);
    session.syncFromStorage('event');
    const out = asRefused(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.reason, 'blocked');
    assert.equal(out.blockedReason, 'removed-elsewhere');
    assert.equal(store.log.length, 0);
  });

  it('a read that throws is a refusal, not a crash, and writes nothing', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    store.mangleGet = (key) => { if (key === STORAGE_KEY) throw new Error('SecurityError'); return undefined; };
    const out = asRefused(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.reason, 'unavailable');
    assert.equal(store.log.length, 0);
  });
});

// ───────────── G. input validation ─────────────

describe('input validation is all-or-nothing and writes nothing', () => {
  const cases: [string, unknown, Partial<{ invalidRecords: number; descriptionTooLong: number; duplicateIds: number }>][] = [
    ['an invalid record', [tx('ok'), { id: 'x', type: 'expense', amount: 0, categoryId: 'c', description: 'd', date: '2026-01-01' }], { invalidRecords: 1 }],
    ['an impossible date', [tx('ok'), tx('bad', '2026-02-31')], { invalidRecords: 1 }],
    ['a repeated id', [tx('dup'), tx('dup', '2026-05-05')], { duplicateIds: 1 }],
    ['a description over the limit', [tx('long', '2026-01-01', { description: 'x'.repeat(81) })], { descriptionTooLong: 1 }],
    ['not a list at all', { transactions: [] }, { invalidRecords: 1 }],
  ];
  for (const [name, incoming, expected] of cases) {
    for (const mode of ['merge', 'replace'] as const) {
      it(`${mode}: ${name} → refused`, () => {
        const store = seeded(RAW_A);
        const out = asRefused(openSession(store, clock()).restore({ mode, incoming: incoming as Transaction[] }));
        assert.equal(out.reason, 'invalid-input');
        for (const [k, v] of Object.entries(expected)) assert.equal(out.problems?.[k as 'invalidRecords'], v);
        assert.equal(store.log.length, 0);
        assert.equal(store.data.get(STORAGE_KEY), RAW_A);
        assert.doesNotMatch(JSON.stringify(out), /item ok|item bad|item dup/, 'no transaction contents in the outcome');
      });
    }
  }
  it('an unknown mode is refused', () => {
    const store = seeded(RAW_A);
    const out = asRefused(openSession(store, clock()).restore({ mode: 'append' as 'merge', incoming: INCOMING }));
    assert.equal(out.reason, 'invalid-input');
    assert.equal(store.log.length, 0);
  });
  it('validateIncoming: exactly 80 characters is allowed; duplicates are counted, not thrown', () => {
    assert.equal(validateIncoming([tx('k', '2026-01-01', { description: 'x'.repeat(80) })]).ok, true);
    const bad = validateIncoming([tx('d'), tx('d'), tx('d')]);
    assert.deepEqual(bad.ok === false && bad.duplicateIds, 2);
  });
});

// ───────────── H. other tabs ─────────────

describe('another tab changed storage', () => {
  it('before the restore: refused, nothing written, and the newer data is reported for adoption', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const theirs = envelope([tx('t1', '2026-07-07')]);
    store.data.set(STORAGE_KEY, theirs);
    const out = asRefused(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.reason, 'conflict');
    assert.equal(out.sync?.action, 'adopt');
    assert.equal(store.data.get(STORAGE_KEY), theirs);
    assert.equal(store.snapshots().length, 0);
    assert.equal(store.log.length, 0);
  });

  it('while the snapshot is being written: the live key is NOT overwritten; the snapshot stays', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const theirs = envelope([tx('t1', '2026-07-07')]);
    store.mangleSet = (key) => { if (key.startsWith(SNAPSHOT_KEY_PREFIX)) store.data.set(STORAGE_KEY, theirs); return null; };
    const out = asRefused(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.reason, 'conflict');
    assert.equal(store.data.get(STORAGE_KEY), theirs);
    assert.equal(store.storageWrites().length, 0, 'the restore never wrote the live key');
    assert.equal(store.snapshots().length, 1);
    assert.equal(store.removals().length, 0);
  });
});

// ───────────── I. snapshot failure → stop, delete nothing, change nothing ─────────────

describe('a snapshot that cannot be created or verified stops the restore with nothing deleted', () => {
  function setup() {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const oldSnapshots = seedSnapshots(store, MAX_SNAPSHOTS); // already at the cap
    const before = new Map(store.data);
    return { store, session, oldSnapshots, before };
  }

  it('quota error while writing the snapshot', () => {
    const { store, session, before } = setup();
    store.failSet = (key) => key.startsWith(SNAPSHOT_KEY_PREFIX);
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'snapshot-write');
    assert.equal(out.dataState, 'unchanged');
    assert.equal(out.snapshotKey, null);
    assert.deepEqual(store.data, before, 'every key and value is exactly as before');
    assert.equal(store.removals().length, 0);
    assert.equal(store.storageWrites().length, 0);
  });

  it('snapshot written but the read-back differs: previous snapshots and recovery copies untouched', () => {
    const { store, session, before } = setup();
    store.mangleSet = (key, value) => (key.startsWith(SNAPSHOT_KEY_PREFIX) ? value.slice(0, 5) : null);
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'snapshot-verify');
    assert.equal(out.dataState, 'unchanged');
    for (const [k, v] of before) assert.equal(store.data.get(k), v, `${k} must be unchanged`);
    assert.ok(store.removals().every((o) => !before.has(o.key)), 'only this attempt’s own unverified key may be removed');
    assert.equal(store.snapshots().length, MAX_SNAPSHOTS, 'back to exactly the old five');
    assert.equal(store.storageWrites().length, 0);
  });

  it('a read-back that throws is a verification failure, not a success', () => {
    const { store, session, before } = setup();
    const reads = new Map<string, number>();
    store.mangleGet = (key) => {
      if (!key.startsWith(SNAPSHOT_KEY_PREFIX) || before.has(key)) return undefined;
      const n = (reads.get(key) ?? 0) + 1;
      reads.set(key, n);
      if (n >= 2) throw new Error('boom'); // 1st read = "is the key free?", 2nd = the verification read-back
      return undefined;
    };
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'snapshot-verify');
    assert.equal(store.data.get(STORAGE_KEY), RAW_A);
    assert.equal(store.storageWrites().length, 0);
  });

  it('removeItem is not even attempted on previous snapshots when the snapshot step fails', () => {
    const { store, session, oldSnapshots } = setup();
    store.failSet = (key) => key.startsWith(SNAPSHOT_KEY_PREFIX);
    session.restore({ mode: 'merge', incoming: INCOMING });
    for (const key of oldSnapshots) assert.ok(store.data.has(key));
    assert.equal(store.removals().length, 0);
  });

  it('the session is not blocked afterwards: the same restore works once storage allows it', () => {
    const { store, session } = setup();
    store.failSet = (key) => key.startsWith(SNAPSHOT_KEY_PREFIX);
    asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    store.failSet = () => false;
    asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.deepEqual(stored(store), INCOMING);
  });
});

// ───────────── J. persist / verify failure ─────────────

describe('persist or verify failure: reported as failure, previous data kept, snapshot kept, nothing pruned', () => {
  function setup() {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const oldSnapshots = seedSnapshots(store, MAX_SNAPSHOTS);
    return { store, session, oldSnapshots };
  }

  it('the live write is refused (quota): data unchanged, snapshot kept, no pruning, saving still allowed', () => {
    const { store, session, oldSnapshots } = setup();
    store.failSet = (key) => key === STORAGE_KEY;
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'persist');
    assert.equal(out.dataState, 'unchanged');
    assert.equal(store.data.get(out.snapshotKey!), RAW_A);
    assert.equal(store.data.get(STORAGE_KEY), RAW_A);
    assert.equal(store.snapshots().length, MAX_SNAPSHOTS + 1, 'over the cap, but nothing was deleted');
    for (const key of oldSnapshots) assert.ok(store.data.has(key));
    assert.equal(store.removals().length, 0);
    store.failSet = () => false;
    assert.equal(session.save([...A, tx('z')]).status, 'saved', 'the session is consistent and usable');
  });

  it('read-back unusable but our write is in place: the previous value is put back and verified', () => {
    const { store, session, oldSnapshots } = setup();
    const readsOfLive = { n: 0 };
    store.mangleGet = (key) => {
      if (key === STORAGE_KEY && ++readsOfLive.n === 3) throw new Error('boom'); // 1: guard, 2: re-check, 3: verification
      return undefined;
    };
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'verify');
    assert.equal(out.dataState, 'rolled-back');
    assert.equal(store.data.get(STORAGE_KEY), RAW_A);
    assert.equal(store.data.get(out.snapshotKey!), RAW_A);
    for (const key of oldSnapshots) assert.ok(store.data.has(key));
    assert.equal(store.removals().length, 0, 'nothing pruned after a failure');
    assert.equal(store.recoveries().length, 2);
    assert.equal(store.storageWrites().length, 2, 'the restore’s write, then the rollback write');
    assert.equal(session.save([...A, tx('z')]).status, 'saved', 'a clean rollback leaves the session usable');
  });

  it('a write that storage silently altered cannot be told apart from another tab: left alone, saving paused', () => {
    const { store, session, oldSnapshots } = setup();
    store.mangleSet = (key, value) => (key === STORAGE_KEY && value !== RAW_A ? value.slice(0, -3) : null);
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'verify');
    assert.equal(out.dataState, 'changed-elsewhere');
    assert.equal(store.storageWrites().length, 1, 'no rollback write on a value this restore does not recognise');
    assert.equal(store.data.get(out.snapshotKey!), RAW_A, 'the snapshot holds the previous data');
    for (const key of oldSnapshots) assert.ok(store.data.has(key));
    assert.equal(store.removals().length, 0);
    assert.equal(session.save([tx('z')]).status, 'blocked');
  });

  it('well-formed but wrong content read back (e.g. stale value) is also a verify failure', () => {
    const { store, session } = setup();
    const wrong = envelope([tx('wrong')]);
    store.mangleSet = (key, value) => (key === STORAGE_KEY && value !== RAW_A ? wrong : null);
    const out = asFailed(session.restore({ mode: 'merge', incoming: INCOMING }));
    assert.equal(out.stage, 'verify');
    // storage holds neither the previous value nor what was written: another writer is assumed
    assert.equal(out.dataState, 'changed-elsewhere');
    assert.equal(store.data.get(STORAGE_KEY), wrong, 'a value this restore did not write is never overwritten');
  });

  it('rollback failure: reported as such, snapshot and recovery copies kept, session paused', () => {
    const { store, session, oldSnapshots } = setup();
    let liveReads = 0;
    store.mangleGet = (key) => { if (key === STORAGE_KEY && ++liveReads === 3) throw new Error('boom'); return undefined; };
    let liveWrites = 0;
    store.failSet = (key) => key === STORAGE_KEY && ++liveWrites > 1; // the rollback write fails
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'verify');
    assert.equal(out.dataState, 'rollback-failed');
    assert.equal(store.data.get(out.snapshotKey!), RAW_A, 'the recovery snapshot holds the previous data');
    for (const key of oldSnapshots) assert.ok(store.data.has(key));
    assert.equal(store.removals().length, 0);
    assert.equal(store.recoveries().length, 2);
    store.failSet = () => false;
    const blocked = session.save([tx('z')]);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.status === 'blocked' && blocked.reason, 'restore-incomplete');
    assert.equal(asRefused(session.restore({ mode: 'replace', incoming: INCOMING })).reason, 'blocked');
  });

  it('rollback guard: when another tab\'s value is in place, the rollback writes NOTHING', () => {
    const { store, session } = setup();
    const theirs = envelope([tx('theirs', '2026-03-03')]);
    store.mangleSet = (key, value) => (key === STORAGE_KEY && value !== RAW_A ? theirs : null);
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.dataState, 'changed-elsewhere');
    assert.equal(store.data.get(STORAGE_KEY), theirs);
    assert.equal(store.storageWrites().length, 1, 'exactly one live write (the restore’s own); the rollback wrote none');
    assert.equal(session.save([tx('z')]).status, 'blocked');
    // a later storage event adopts the other tab's data and lifts the pause
    assert.equal(session.syncFromStorage('event').action, 'adopt');
    assert.equal(session.save([tx('z')]).status, 'saved');
  });

  it('empty storage + damaged write: the live key is removed again (previous state was "nothing")', () => {
    const store = new FakeStorage();
    const session = openSession(store, clock());
    let liveReads = 0;
    store.mangleGet = (key) => { if (key === STORAGE_KEY && ++liveReads === 3) throw new Error('boom'); return undefined; };
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.dataState, 'rolled-back');
    assert.equal(store.data.has(STORAGE_KEY), false);
    assert.equal(out.snapshotKey, null);
  });

  it('empty storage + damaged write + no removeItem: rollback-failed, never "restored"', () => {
    const store = new FakeStorage();
    (store as { removeItem?: unknown }).removeItem = undefined;
    const session = openSession(store, clock());
    let liveReads = 0;
    store.mangleGet = (key) => { if (key === STORAGE_KEY && ++liveReads === 3) throw new Error('boom'); return undefined; };
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.dataState, 'rollback-failed');
    assert.equal(store.data.has(STORAGE_KEY), true, 'it could not be removed; the snapshot-less state is reported, not hidden');
  });

  it('a read-back that throws after a successful write is a failure (and is rolled back)', () => {
    const { store, session } = setup();
    let liveReads = 0;
    store.mangleGet = (key) => { if (key === STORAGE_KEY && ++liveReads === 3) throw new Error('boom'); return undefined; };
    const out = asFailed(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.stage, 'verify');
    assert.equal(out.dataState, 'rolled-back');
    assert.equal(store.data.get(STORAGE_KEY), RAW_A);
  });
});

// ───────────── K. retention ─────────────

describe('retention: at most 5 snapshots, trimmed only after full success', () => {
  it('keeps the 5 newest INCLUDING the new one; removes only the oldest snapshots', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const old = seedSnapshots(store, 7);
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    const remaining = store.snapshots();
    assert.equal(remaining.length, MAX_SNAPSHOTS);
    assert.ok(remaining.includes(out.snapshotKey!));
    assert.deepEqual(remaining.filter((k) => k !== out.snapshotKey).sort(), old.slice(3).sort(), 'the 4 newest old ones remain');
    assert.equal(out.snapshotsPruned, 3);
    assert.equal(out.pruneIncomplete, false);
    assert.equal(store.recoveries().length, 2, 'recovery copies are never removed');
    assert.deepEqual(stored(store), INCOMING);
  });

  it('every removal happens AFTER the final live write, and only snapshot keys are removed', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    seedSnapshots(store, 8);
    asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    const lastLiveWrite = store.log.map((o, i) => (o.op === 'set' && o.key === STORAGE_KEY ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const removalIndexes = store.log.map((o, i) => (o.op === 'remove' ? i : -1)).filter((i) => i >= 0);
    assert.ok(removalIndexes.length > 0);
    assert.ok(removalIndexes.every((i) => i > lastLiveWrite));
    assert.ok(store.removals().every((o) => o.key.startsWith(SNAPSHOT_KEY_PREFIX)));
  });

  it('the new snapshot survives even when the clock went BACKWARDS (it looks oldest)', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, () => 1); // far older than the seeded snapshots
    seedSnapshots(store, 6);
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.ok(store.data.has(out.snapshotKey!));
    assert.equal(store.snapshots().length, MAX_SNAPSHOTS);
    assert.equal(store.data.get(out.snapshotKey!), RAW_A);
  });

  it('below the cap nothing is removed', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    seedSnapshots(store, 3);
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(store.snapshots().length, 4);
    assert.equal(out.snapshotsPruned, 0);
    assert.equal(store.removals().length, 0);
  });

  it('a removal that fails leaves the extra snapshot, still reports success, and flags the incomplete trim', () => {
    const store = seeded(RAW_A);
    const session = openSession(store, clock());
    const old = seedSnapshots(store, 7);
    store.failRemove = (key) => key === old[0];
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.pruneIncomplete, true);
    assert.ok(store.data.has(old[0]!));
    assert.deepEqual(stored(store), INCOMING);
  });

  it('a store without removeItem: the restore succeeds, trimming is reported incomplete (never an error)', () => {
    const store = seeded(RAW_A);
    (store as { removeItem?: unknown }).removeItem = undefined;
    const session = openSession(store, clock());
    seedSnapshots(store, 6);
    const out = asRestored(session.restore({ mode: 'replace', incoming: INCOMING }));
    assert.equal(out.pruneIncomplete, true);
    assert.equal(store.snapshots().length, 7);
  });

  it('listSnapshotKeys orders by embedded time (numerically) and ignores other keys', () => {
    const store = new FakeStorage();
    store.data.set(`${SNAPSHOT_KEY_PREFIX}${(300).toString(36)}-b`, 'x');
    store.data.set(`${SNAPSHOT_KEY_PREFIX}${(20).toString(36)}-a`, 'x');
    store.data.set(`${SNAPSHOT_KEY_PREFIX}!bad`, 'x');
    store.data.set(`${RECOVERY_KEY_PREFIX}zzz`, 'x');
    store.data.set(STORAGE_KEY, 'x');
    const keys = listSnapshotKeys(store)!;
    assert.equal(keys.length, 3);
    assert.equal(keys[0], `${SNAPSHOT_KEY_PREFIX}!bad`); // unparseable time sorts oldest
    assert.ok(keys[1]!.endsWith('-a') && keys[2]!.endsWith('-b'));
  });
});

// ───────────── L. merge logic parity with the backup module ─────────────

describe('planRestoreMerge behaves exactly like planMerge from the backup module', () => {
  const T = tx;
  const hand: [string, Transaction[], Transaction[]][] = [
    ['empty + empty', [], []],
    ['all new', [T('a')], [T('b'), T('c')]],
    ['identical content', [T('a'), T('b')], [T('b'), T('a')]],
    ['conflict on one field', [T('a')], [T('a', '2026-11-01', { amount: 5 })]],
    ['conflict on every field', [T('a')], [T('a', '2020-01-01', { type: 'income', categoryId: 'salary', amount: 77, description: 'other' })]],
    ['look-alike under another id', [T('a', '2026-11-01', { description: 'Coffee  Beans' })], [T('z', '2026-11-01', { description: ' coffee beans ' })]],
    ['future-dated on both sides', [T('a', '2099-01-01')], [T('b', '2099-01-01'), T('a', '2099-01-01')]],
  ];
  for (const [name, existing, incoming] of hand) {
    for (const conflictPolicy of ['keep-existing', 'use-incoming'] as const) {
      it(`${name} (${conflictPolicy})`, () => {
        assert.deepEqual(planRestoreMerge(existing, incoming, { conflictPolicy }), planMerge(existing, incoming, { conflictPolicy }));
      });
    }
  }
  it('default policy is the same (keep-existing) when none is given', () => {
    const e = [T('a')], i = [T('a', '2026-11-01', { amount: 3 })];
    assert.deepEqual(planRestoreMerge(e, i), planMerge(e, i));
    assert.equal(planRestoreMerge(e, i).conflictPolicy, 'keep-existing');
  });
  it('300 seeded random cases agree on every field of the plan', () => {
    let seed = 20261111;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const dates = ['2026-01-01', '2026-01-02', '2099-12-31'];
    const descs = ['tea', 'Tea', ' tea ', 'bread', 'rent'];
    const make = (id: string): Transaction => ({
      id, type: rnd(2) ? 'income' : 'expense', amount: 100 * (1 + rnd(3)), categoryId: ['groceries', 'salary', 'zzz'][rnd(3)]!,
      description: descs[rnd(descs.length)]!, date: dates[rnd(dates.length)]!,
    });
    const pick = () => ids.filter(() => rnd(2) === 1).sort(() => rnd(3) - 1).map(make);
    for (let n = 0; n < 300; n++) {
      const existing = pick();
      // the app's stored lists have unique ids; so do validated incoming lists
      const uniq = (list: Transaction[]) => list.filter((t, i) => list.findIndex((o) => o.id === t.id) === i);
      const e = uniq(existing), i = uniq(pick());
      for (const conflictPolicy of ['keep-existing', 'use-incoming'] as const) {
        assert.deepEqual(planRestoreMerge(e, i, { conflictPolicy }), planMerge(e, i, { conflictPolicy }), `case ${n}`);
      }
    }
  });
  it('both refuse a repeated incoming id, and neither mutates its inputs', () => {
    assert.throws(() => planRestoreMerge([], [tx('d'), tx('d')]));
    assert.throws(() => planMerge([], [tx('d'), tx('d')]));
    const e = [tx('a')], i = [tx('a', '2026-11-01', { amount: 9 }), tx('b')];
    const before = JSON.stringify([e, i]);
    planRestoreMerge(e, i, { conflictPolicy: 'use-incoming' });
    assert.equal(JSON.stringify([e, i]), before);
  });
});

// ───────────── M. wiring and architecture guards (source text) ─────────────

describe('wiring and architecture guards', () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  const storage = read('lib/storage.ts');
  const provider = read('state/TransactionsContext.tsx');
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('storage.ts does not import the backup module (no circular dependency), and backup.ts is unchanged in its imports', () => {
    assert.doesNotMatch(code(storage), /from\s+['"][^'"]*backup[^'"]*['"]/);
    assert.doesNotMatch(provider, /from\s+['"][^'"]*backup[^'"]*['"]/);
    const backupImports = [...read('lib/backup.ts').matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    assert.ok(backupImports.includes('@/lib/storage'), 'backup.ts still depends on storage.ts, never the other way round');
  });

  it('storage.ts imports only validation, format and types', () => {
    const imports = [...storage.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['@/lib/format', '@/lib/validation', '@/types/transaction'].sort());
  });

  it('the provider refuses on unsaved changes BEFORE calling the session', () => {
    const body = provider.slice(provider.indexOf('const restoreTransactions'));
    assert.ok(body.indexOf('transactions !== syncedRef.current') >= 0);
    assert.ok(body.indexOf('transactions !== syncedRef.current') < body.indexOf('session.restore('));
    assert.match(body, /reason: 'unsaved-changes'/);
  });

  it('React state changes only after a verified "restored" result, through the existing adopt path (marks synced first)', () => {
    const body = provider.slice(provider.indexOf('const restoreTransactions'), provider.indexOf('const addTransaction'));
    assert.match(body, /result\.status === 'restored'/);
    assert.match(body, /if \(result\.changed\)/);
    assert.ok(body.indexOf("result.status === 'restored'") < body.indexOf("action: 'adopt'"));
    assert.equal((body.match(/dispatch\(/g) ?? []).length, 0, 'no direct dispatch in the restore path');
    assert.equal((provider.match(/type: 'replace'/g) ?? []).length, 1, 'still exactly one replace dispatch in the provider');
    assert.doesNotMatch(body, /session\.save|syncedRef\.current =/);
  });

  it('failures and refusals never touch the on-screen list', () => {
    const body = provider.slice(provider.indexOf('const restoreTransactions'), provider.indexOf('const addTransaction'));
    const failureBranch = body.slice(body.indexOf("result.status === 'refused'"));
    assert.doesNotMatch(failureBranch, /action: 'adopt'\s*,\s*transactions: (?!result\.sync)/);
    assert.doesNotMatch(failureBranch, /dispatch/);
  });

  it('the storage layer never calls React, the DOM or the network', () => {
    assert.doesNotMatch(code(storage), /from 'react'|document\.|fetch\(|XMLHttpRequest|indexedDB|sessionStorage/);
  });

  it('no timers were added', () => {
    assert.doesNotMatch(code(storage) + code(provider), /setInterval|setTimeout/);
  });
});
