/**
 * M1 (final audit): a `restore-incomplete` hazard must be able to end without another tab's help, but
 * only on verified storage facts. Real `openSession` on a failure-injecting fake storage, the real
 * reload guard. No React, no packages.
 *
 * Run: node --experimental-strip-types --import ./tests/register-alias.mjs --test "tests/restoreIncomplete.reverify.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateReloadSafety } from '../src/pwa/reloadGuard.ts';
import { STORAGE_KEY, SCHEMA_VERSION, openSession } from '../src/lib/storage.ts';
import type { StorageLike } from '../src/lib/storage.ts';
import type { Transaction } from '../src/types/transaction.ts';

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  failWrite: (key: string, value: string) => boolean = () => false;
  afterWrite: (key: string, value: string) => void = () => {};
  garbleNextRead = false;
  throwReads = false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) {
    if (k === STORAGE_KEY && this.throwReads) throw new Error('SecurityError');
    if (k === STORAGE_KEY && this.garbleNextRead) { this.garbleNextRead = false; return '<<garbled>>'; }
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrite(k, v)) throw new Error('QuotaExceededError');
    this.data.set(k, v);
    this.afterWrite(k, v);
  }
  removeItem(k: string) { this.data.delete(k); }
}

const tx = (id: string): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date: '2026-11-01',
});
const envelope = (transactions: unknown[]) =>
  JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: '2026-11-10T08:00:00.000Z', transactions });
const guard = (session: ReturnType<typeof openSession>) =>
  evaluateReloadSafety({ persistenceOk: true, hasUnsavedChanges: false, storageHazard: session.getDiscardHazard(), activities: [] })?.reason ?? null;

/** Restore whose rollback is refused: storage keeps the restore's own write. */
function rollbackRefused() {
  const store = new FakeStorage();
  const previous = envelope([tx('a')]);
  store.data.set(STORAGE_KEY, previous);
  const session = openSession(store, () => 1);
  store.afterWrite = (key) => { if (key === STORAGE_KEY) { store.garbleNextRead = true; store.afterWrite = () => {}; } };
  store.failWrite = (key, value) => key === STORAGE_KEY && value === previous;
  const result = session.restore({ mode: 'replace', incoming: [tx('r1'), tx('r2')] });
  store.failWrite = () => false;
  return { store, session, previous, result };
}

/** Restore whose rollback SUCCEEDS but whose confirming read throws, so it is reported as rollback-failed. */
function rollbackSucceededButReadThrew() {
  const store = new FakeStorage();
  const previous = envelope([tx('a')]);
  store.data.set(STORAGE_KEY, previous);
  const session = openSession(store, () => 1);
  let writes = 0;
  store.afterWrite = (key) => {
    if (key !== STORAGE_KEY) return;
    writes += 1;
    if (writes === 1) store.garbleNextRead = true; // the restore's own write fails verification
    if (writes === 2) store.throwReads = true;     // the rollback write lands; reading it back throws
  };
  const result = session.restore({ mode: 'replace', incoming: [tx('r1')] });
  return { store, session, previous, result };
}

describe('M1: restore-incomplete re-verification', () => {
  it('setup sanity: the rollback-succeeded-but-read-threw case really is reported as rollback-failed while storage holds the previous value', () => {
    const { store, session, previous, result } = rollbackSucceededButReadThrew();
    assert.equal(result.status, 'failed');
    assert.equal((result as { dataState: string }).dataState, 'rollback-failed');
    assert.equal(session.getDiscardHazard(), 'restore-incomplete');
    store.throwReads = false;
    assert.equal(store.getItem(STORAGE_KEY), previous);
  });

  it('is not applicable (and changes nothing) when no restore-incomplete hazard is set', () => {
    const store = new FakeStorage();
    store.data.set(STORAGE_KEY, envelope([tx('a')]));
    const session = openSession(store, () => 1);
    assert.equal(session.recheckAfterIncompleteRestore(), 'not-applicable');
    store.data.delete(STORAGE_KEY);
    session.syncFromStorage('event'); // removed-elsewhere; storage (null) equals expectedRaw (null) now
    assert.equal(session.getDiscardHazard(), 'removed-elsewhere');
    assert.equal(session.recheckAfterIncompleteRestore(), 'not-applicable');
    assert.equal(session.getDiscardHazard(), 'removed-elsewhere', 'other hazards are never cleared by this path');
    assert.equal(session.save([tx('x')]).status, 'blocked');
  });

  it('clears after a verified safe re-read (rollback succeeded, read threw earlier)', () => {
    const { store, session } = rollbackSucceededButReadThrew();
    store.throwReads = false;
    assert.equal(guard(session), 'restore-incomplete');
    assert.equal(session.recheckAfterIncompleteRestore(), 'cleared');
    assert.equal(session.getDiscardHazard(), null);
    assert.equal(guard(session), null);
  });

  it('keeps the hazard while storage is unreadable, then clears once a read verifies', () => {
    const { store, session } = rollbackSucceededButReadThrew();
    assert.equal(store.throwReads, true);
    assert.equal(session.recheckAfterIncompleteRestore(), 'kept');
    assert.equal(session.getDiscardHazard(), 'restore-incomplete');
    assert.equal(guard(session), 'restore-incomplete');
    assert.equal(session.save([tx('n')]).status, 'blocked', 'saving stays paused while unreadable');
    assert.equal(session.restore({ mode: 'merge', incoming: [tx('q')] }).status, 'refused');
    assert.equal(session.getDiscardHazard(), 'restore-incomplete');
    store.throwReads = false;
    assert.equal(session.recheckAfterIncompleteRestore(), 'cleared');
  });

  it('keeps the hazard when storage holds the restore\'s own write (rollback refused), however often it is re-read', () => {
    const { store, session, previous } = rollbackRefused();
    assert.notEqual(store.getItem(STORAGE_KEY), previous);
    for (let i = 0; i < 3; i++) assert.equal(session.recheckAfterIncompleteRestore(), 'kept');
    assert.equal(session.getDiscardHazard(), 'restore-incomplete');
    assert.equal(guard(session), 'restore-incomplete');
  });

  it('keeps the hazard when another tab\'s data, unreadable data, a newer version or nothing is stored', () => {
    for (const stored of [envelope([tx('other')]), '{nope', JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, transactions: [] }), null]) {
      const { store, session } = rollbackSucceededButReadThrew();
      store.throwReads = false;
      if (stored === null) store.data.delete(STORAGE_KEY); else store.data.set(STORAGE_KEY, stored);
      assert.equal(session.recheckAfterIncompleteRestore(), 'kept');
      assert.equal(session.getDiscardHazard(), 'restore-incomplete');
      assert.equal(session.save([tx('n')]).status, 'blocked');
      assert.equal(store.data.get(STORAGE_KEY) ?? null, stored, 'storage is never written by the re-check');
    }
  });

  it('the existing way out still works: adopting storage\'s valid data after a storage event ends the hazard', () => {
    const { store, session } = rollbackRefused();
    session.syncFromStorage('event');
    assert.equal(session.getDiscardHazard(), null);
    assert.equal(guard(session), null);
    assert.ok(store.getItem(STORAGE_KEY));
  });
});

describe('M1: the next relevant interaction is the opportunity', () => {
  it('save() re-verifies first: after a safe re-read the edit is saved and the hazard is gone', () => {
    const { store, session } = rollbackSucceededButReadThrew();
    store.throwReads = false;
    assert.equal(session.save([tx('n'), tx('a')]).status, 'saved');
    assert.equal(session.getDiscardHazard(), null);
    assert.ok(store.getItem(STORAGE_KEY)!.includes('item n'));
  });

  it('save() while storage is unreadable or different stays blocked and the hazard stays', () => {
    const a = rollbackSucceededButReadThrew();
    assert.deepEqual(a.session.save([tx('n')]), { status: 'blocked', reason: 'restore-incomplete' });
    assert.equal(a.session.getDiscardHazard(), 'restore-incomplete');
    const b = rollbackRefused();
    assert.deepEqual(b.session.save([tx('n')]), { status: 'blocked', reason: 'restore-incomplete' });
    assert.equal(b.session.getDiscardHazard(), 'restore-incomplete');
  });

  it('restore() re-verifies first: after a safe re-read a new restore may proceed, and it is itself fully verified', () => {
    const { store, session } = rollbackSucceededButReadThrew();
    store.throwReads = false;
    const result = session.restore({ mode: 'merge', incoming: [tx('b')] });
    assert.equal(result.status, 'restored');
    assert.equal(session.getDiscardHazard(), null);
  });

  it('restore() with a mismatch is still refused as blocked (existing Stage 5 behaviour)', () => {
    const { session } = rollbackRefused();
    const result = session.restore({ mode: 'merge', incoming: [tx('b')] });
    assert.equal(result.status, 'refused');
    assert.equal((result as { reason: string }).reason, 'blocked');
  });
});
