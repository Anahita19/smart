/**
 * Phase 4B, Stage 4 tests: Import & Restore — the decision layer (src/lib/importRestore.ts), its
 * English copy, and source guards for the UI card. No browser, no React, no packages: an in-memory
 * Web Storage fake with failure injection drives the REAL Stage 1 parser and the REAL Stage 2
 * storage session.
 *
 * The Context's `restoreTransactions` (unsaved-changes refusal + adopt) is React and cannot run here;
 * `makeApp` below mirrors exactly its gate (refuse while unsaved, else `session.restore`), and the
 * Stage 2 suite plus the source guards at the end keep the real provider honest.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BACKUP_APP_NAME, BACKUP_FORMAT, MAX_BACKUP_CHARS, computeChecksum, createBackupJson } from '../src/lib/backup.ts';
import {
  MAX_IMPORT_BYTES,
  REPLACE_CONFIRM_PHRASE,
  buildPreview,
  isReplacePhrase,
  normalizePhrase,
  prepareImport,
  readImportFile,
  runImport,
} from '../src/lib/importRestore.ts';
import type { ImportPreview, ImportRunResult, ParsedImport, RestoreGate, RestoreGateOutcome } from '../src/lib/importRestore.ts';
import { SCHEMA_VERSION, SNAPSHOT_KEY_PREFIX, STORAGE_KEY, openSession } from '../src/lib/storage.ts';
import type { RestoreRequest, StorageLike } from '../src/lib/storage.ts';
import { describeImportFailure, describeRunResult } from '../src/components/data/importCopy.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  log: { op: 'set' | 'remove'; key: string }[] = [];
  failSet: (key: string, value: string) => boolean = () => false;
  mangleSet: (key: string, value: string) => string | null = () => null;
  /** Change what a read returns (or throw). */
  mangleGet: (key: string, value: string | null) => string | null | undefined = () => undefined;
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
  removeItem(k: string) { this.log.push({ op: 'remove', key: k }); this.data.delete(k); }
  snapshots() { return [...this.data.keys()].filter((k) => k.startsWith(SNAPSHOT_KEY_PREFIX)); }
  liveWrites() { return this.log.filter((o) => o.op === 'set' && o.key === STORAGE_KEY); }
}

const tx = (id: string, date = '2026-11-01', over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date, ...over,
});
const envelope = (transactions: unknown[]) => JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: '2026-11-10T08:00:00.000Z', transactions });
const seeded = (raw: string) => { const s = new FakeStorage(); s.data.set(STORAGE_KEY, raw); return s; };
const clock = (start = 2_000_000_000_000) => { let t = start; return () => t++; };
const stored = (s: FakeStorage): Transaction[] => (JSON.parse(s.data.get(STORAGE_KEY)!) as { transactions: Transaction[] }).transactions;
const NOW = new Date('2026-11-11T09:30:00.000Z');
const TODAY = '2026-11-12';

const EXISTING = [tx('a'), tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 400_000, description: 'secret salary' })];
const RAW_EXISTING = envelope(EXISTING);

/** A real backup file's text. */
const backupText = (txs: Transaction[]) => createBackupJson(txs, { now: NOW });

/** A backup document with a CORRECT checksum over arbitrary (possibly invalid) records. */
async function crafted(records: unknown[], over: Record<string, unknown> = {}): Promise<string> {
  const data = { transactions: records };
  const value = await computeChecksum(data);
  return JSON.stringify({
    format: BACKUP_FORMAT, backupVersion: 1, appSchemaVersion: SCHEMA_VERSION, exportedAt: '2026-11-10T08:00:00.000Z',
    app: { name: BACKUP_APP_NAME }, counts: { transactions: records.length }, checksum: { algorithm: 'SHA-256', value }, data, ...over,
  });
}

/** Mirrors TransactionsContext.restoreTransactions: refuse while unsaved, otherwise the Stage 2 session. */
function makeApp(store: FakeStorage, opts: { unsaved?: () => boolean } = {}) {
  const session = openSession(store, clock());
  const app = {
    session,
    current: session.boot.transactions as readonly Transaction[],
    calls: [] as RestoreRequest[],
    gate: ((request) => {
      app.calls.push(request);
      if (opts.unsaved?.()) {
        return { status: 'refused', reason: 'unsaved-changes', message: 'This tab has changes that are not saved yet, so nothing was restored. Your data was not changed.' };
      }
      const result = session.restore(request);
      if (result.status === 'restored' && result.changed) app.current = result.transactions;
      return result;
    }) as RestoreGate,
  };
  return app;
}

async function prepared(raw: string, existing: readonly Transaction[] = EXISTING) {
  const result = await prepareImport(raw, existing, { today: TODAY });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<Awaited<ReturnType<typeof prepareImport>>, { ok: true }>;
}

function run(app: ReturnType<typeof makeApp>, parsed: ParsedImport, over: Partial<Parameters<typeof runImport>[0]> = {}): ImportRunResult {
  return runImport({
    parsed, baseTransactions: app.current, currentTransactions: app.current, mode: 'merge', confirmed: true, restore: app.gate, ...over,
  });
}
const asRestored = (r: ImportRunResult) => { assert.equal(r.status, 'restored', JSON.stringify(r)); return r as Extract<ImportRunResult, { status: 'restored' }>; };

// ───────────── A. rejected files: the WHOLE file, with no preview ─────────────

describe('invalid files are rejected entirely', () => {
  it('invalid JSON', async () => {
    const r = await prepareImport('{ not json', EXISTING);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, 'invalid-json');
    assert.match(describeImportFailure((r as { error: never }).error), /not valid JSON/);
  });

  it('empty file and an unrelated JSON document', async () => {
    assert.equal((await prepareImport('   ', EXISTING) as { error: { code: string } }).error.code, 'empty');
    assert.equal((await prepareImport('{"hello":1}', EXISTING) as { error: { code: string } }).error.code, 'unrecognized-format');
  });

  it('invalid checksum: a backup edited after export', async () => {
    const json = await backupText([tx('n1'), tx('n2')]);
    const edited = json.replace('"amount": 1250', '"amount": 1251');
    assert.notEqual(edited, json);
    const r = await prepareImport(edited, EXISTING);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, 'checksum-mismatch');
    assert.match(describeImportFailure((r as { error: never }).error), /checksum/i);
  });

  it('missing checksum in a backup-format file is refused (never skipped)', async () => {
    const doc = JSON.parse(await backupText([tx('n1')])) as Record<string, unknown>;
    delete doc.checksum;
    const r = await prepareImport(JSON.stringify(doc), EXISTING);
    assert.equal(r.ok === false && r.error.code, 'checksum-missing');
  });

  it('unsupported version: a newer backup format and a newer storage schema', async () => {
    const newerFormat = await prepareImport(await crafted([tx('n1')], { backupVersion: 99 }), EXISTING);
    assert.equal(newerFormat.ok === false && newerFormat.error.code, 'unsupported-version');
    const newerSchema = await prepareImport(await crafted([tx('n1')], { appSchemaVersion: 99 }), EXISTING);
    assert.equal(newerSchema.ok === false && newerSchema.error.code, 'unsupported-version');
    assert.match(describeImportFailure((newerFormat as { error: never }).error), /version/i);
  });

  it('invalid transaction: one bad record rejects the whole file, even with a valid checksum', async () => {
    const raw = await crafted([tx('ok1'), tx('ok2'), { ...tx('bad'), amount: -5 }, tx('ok3')]);
    const r = await prepareImport(raw, EXISTING);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, 'invalid-transactions');
    assert.equal('parsed' in r, false, 'nothing is returned to import');
    assert.equal(r.ok === false && r.error.details?.invalidRecords, 1);
    assert.match(describeImportFailure((r as { error: never }).error), /whole file was rejected/);
  });

  it('duplicate ids inside the file reject the whole file', async () => {
    const r = await prepareImport(await crafted([tx('dup'), tx('dup', '2026-10-01'), tx('x')]), EXISTING);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, 'duplicate-ids');
    assert.match(describeImportFailure((r as { error: never }).error), /duplicate id/);
  });

  it('count mismatch and an over-long description are rejected', async () => {
    const mismatch = await prepareImport(await crafted([tx('n1')], { counts: { transactions: 5 } }), EXISTING);
    assert.equal(mismatch.ok === false && mismatch.error.code, 'count-mismatch');
    const long = await prepareImport(await crafted([tx('n1', '2026-10-01', { description: 'x'.repeat(500) })]), EXISTING);
    assert.equal(long.ok === false && long.error.code, 'invalid-transactions');
  });

  it('web crypto missing: the file is refused, not accepted unverified', async () => {
    const r = await prepareImport(await backupText([tx('n1')]), EXISTING, { subtle: null });
    assert.equal(r.ok === false && r.error.code, 'crypto-unavailable');
  });

  it('every failure message is English, says nothing was imported and carries no transaction content', async () => {
    const codes = ['too-large', 'read-failed', 'empty', 'invalid-json', 'unrecognized-format', 'malformed', 'missing-field', 'unsupported-version', 'migration-failed', 'checksum-missing', 'unsupported-checksum', 'crypto-unavailable', 'checksum-mismatch', 'count-mismatch', 'invalid-transactions', 'duplicate-ids', 'unexpected'] as const;
    for (const code of codes) {
      const text = describeImportFailure({ code, message: 'secret salary 400000' });
      assert.match(text, /[A-Za-z]{3,}/, code);
      assert.doesNotMatch(text, /[\u0600-\u06FF]/, code);
      assert.match(text, /not changed/, code);
      assert.doesNotMatch(text, /secret|400000/, code);
    }
  });
});

// ───────────── B. reading a file ─────────────

describe('reading the chosen file', () => {
  it('reads text without a restore function or storage in sight', async () => {
    const r = await readImportFile({ size: 10, text: async () => 'hello' });
    assert.deepEqual(r, { ok: true, text: 'hello' });
  });

  it('a file beyond the size ceiling is refused WITHOUT being read', async () => {
    let read = false;
    const r = await readImportFile({ size: MAX_IMPORT_BYTES + 1, text: async () => { read = true; return ''; } });
    assert.equal(r.ok === false && r.error.code, 'too-large');
    assert.equal(read, false);
    assert.ok(MAX_IMPORT_BYTES >= MAX_BACKUP_CHARS);
  });

  it('a read failure is reported, not thrown', async () => {
    const r = await readImportFile({ size: 5, text: async () => { throw new Error('NotReadableError'); } });
    assert.equal(r.ok === false && r.error.code, 'read-failed');
  });
});

// ───────────── C. preview: counts only, and never a storage write ─────────────

describe('preview', () => {
  it('shows backup date, incoming, new, duplicate and conflicting counts', async () => {
    const incoming = [tx('a'), tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 999_999, description: 'secret salary' }), tx('n1'), tx('n2')];
    const { preview } = await prepared(await backupText(incoming));
    assert.equal(preview.backupDate, NOW.toISOString());
    assert.equal(preview.checksum, 'verified');
    assert.equal(preview.incomingCount, 4);
    assert.equal(preview.newCount, 2);
    assert.equal(preview.duplicateCount, 1, 'same id + same content');
    assert.equal(preview.conflictCount, 1, 'same id + different content');
    assert.equal(preview.existingCount, 2);
    assert.equal(preview.canReplace, true);
    // Replace would remove the existing records that are not in the file.
    assert.equal(preview.replaceRemovedCount, 0);
  });

  it('the preview carries no amounts, descriptions or categories', async () => {
    const incoming = [tx('n1', '2026-09-01', { amount: 7_654_321, description: 'private rent payment' })];
    const { preview } = await prepared(await backupText(incoming));
    const text = JSON.stringify(preview);
    assert.doesNotMatch(text, /7654321|private rent|groceries|salary/);
    for (const [key, value] of Object.entries(preview)) {
      assert.ok(['string', 'number', 'boolean'].includes(typeof value) || value === null, `${key} is a plain value`);
    }
  });

  it('PREVIEW WITHOUT STORAGE WRITES: reading + validating + previewing writes nothing and creates no snapshot', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    store.log.length = 0;
    const text = await readImportFile({ size: 100, text: async () => backupText([tx('n1'), tx('n2')]) });
    assert.ok(text.ok);
    const result = await prepareImport(text.ok ? text.text : '', app.current);
    assert.ok(result.ok);
    buildPreview((result as { parsed: ParsedImport }).parsed, app.current);
    assert.deepEqual(store.log, [], 'no setItem/removeItem at all');
    assert.equal(store.data.get(STORAGE_KEY), RAW_EXISTING);
    assert.equal(store.snapshots().length, 0);
    assert.equal(app.calls.length, 0, 'the restore function was never called');
  });

  it('a rejected file also writes nothing', async () => {
    const store = seeded(RAW_EXISTING);
    makeApp(store);
    store.log.length = 0;
    await prepareImport('garbage', EXISTING);
    await prepareImport((await backupText([tx('n1')])).replace('"amount": 1250', '"amount": 9'), EXISTING);
    assert.deepEqual(store.log, []);
  });

  it('flags a legacy file with no checksum, future-dated records, and look-alike records under new ids', async () => {
    const legacy = JSON.stringify([tx('n1', '2099-12-31'), tx('copy-of-a', '2026-11-01', { description: 'item a' })]);
    const { preview } = await prepared(legacy);
    assert.equal(preview.checksum, 'not-present');
    assert.equal(preview.backupDate, null);
    assert.equal(preview.futureDatedCount, 1);
    assert.equal(preview.possibleDuplicateCount, 1, 'copy-of-a has the same content as "a" under another id');
  });

  it('a file with no transactions cannot be used for Replace', async () => {
    const { preview } = await prepared(await backupText([]));
    assert.equal(preview.incomingCount, 0);
    assert.equal(preview.canReplace, false);
  });
});

// ───────────── D. confirmation ─────────────

describe('explicit confirmation is required', () => {
  it('without confirmed === true the restore function is never called (merge and replace)', async () => {
    const { parsed } = await prepared(await backupText([tx('n1')]));
    for (const mode of ['merge', 'replace'] as const) {
      for (const confirmed of [false, undefined, 'yes', 1] as unknown[]) {
        const app = makeApp(seeded(RAW_EXISTING));
        const r = run(app, parsed, { mode, confirmed: confirmed as boolean, replacePhrase: REPLACE_CONFIRM_PHRASE });
        assert.deepEqual(r, { status: 'not-confirmed', reason: 'not-confirmed' });
        assert.equal(app.calls.length, 0);
      }
    }
  });

  it('REPLACE CONFIRMATION: a missing or wrong phrase is refused; the right phrase (ignoring case and extra spacing) is accepted', async () => {
    const { parsed } = await prepared(await backupText([tx('n1')]));
    for (const phrase of [undefined, '', 'replac', 'replace all', 'yes', 'merge']) {
      const store = seeded(RAW_EXISTING);
      const app = makeApp(store);
      store.log.length = 0;
      const r = run(app, parsed, { mode: 'replace', ...(phrase === undefined ? {} : { replacePhrase: phrase }) });
      assert.deepEqual(r, { status: 'not-confirmed', reason: 'replace-phrase-mismatch' }, String(phrase));
      assert.equal(app.calls.length, 0);
      assert.deepEqual(store.log, []);
    }
    assert.ok(isReplacePhrase(REPLACE_CONFIRM_PHRASE));
    assert.ok(isReplacePhrase('  replace  '), 'surrounding spaces and case are ignored');
    assert.ok(isReplacePhrase('Replace'), 'case is ignored');
    assert.equal(normalizePhrase('  Re  Place '), 're place');
    assert.ok(!isReplacePhrase('re place'), 'inner spacing still has to match');
    const app = makeApp(seeded(RAW_EXISTING));
    asRestored(run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE }));
    assert.equal(app.calls.length, 1);
  });

  it('merge does not need the phrase', async () => {
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const app = makeApp(seeded(RAW_EXISTING));
    asRestored(run(app, parsed, { mode: 'merge' }));
  });
});

// ───────────── E. merge ─────────────

describe('Merge (default) preserves existing transactions', () => {
  it('the request is a merge with keep-existing spelled out, and never allows an empty replace', async () => {
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const app = makeApp(seeded(RAW_EXISTING));
    run(app, parsed);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0]!.mode, 'merge');
    assert.equal(app.calls[0]!.conflictPolicy, 'keep-existing');
    assert.equal('allowEmptyReplace' in app.calls[0]!, false);
  });

  it('adds new ids, skips same-id-same-content, keeps the existing record on a same-id conflict', async () => {
    const changedB = tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 1, description: 'changed elsewhere' });
    const incoming = [tx('a'), changedB, tx('n1', '2026-09-01'), tx('n2', '2026-09-02')];
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText(incoming));
    const r = asRestored(run(app, parsed));

    assert.equal(r.changed, true);
    assert.equal(r.addedCount, 2);
    assert.equal(r.duplicateCount, 1);
    assert.equal(r.conflictsKeptCount, 1);
    assert.equal(r.totalAfter, 4);
    const after = stored(store);
    assert.deepEqual(after.slice(0, 2), EXISTING, 'existing records, unchanged and in the same order');
    assert.deepEqual(after.map((t) => t.id), ['a', 'b', 'n1', 'n2']);
    assert.equal(after.find((t) => t.id === 'b')!.amount, 400_000, 'the existing version of the conflict is kept');
  });

  it('restoring the same data again is a no-op: nothing written, no snapshot, reported as such', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText(EXISTING));
    store.log.length = 0;
    const r = asRestored(run(app, parsed));
    assert.equal(r.changed, false);
    assert.equal(r.addedCount, 0);
    assert.deepEqual(store.log, []);
    assert.equal(store.snapshots().length, 0);
    const message = describeRunResult(r);
    assert.equal(message.tone, 'info');
    assert.doesNotMatch(message.text, /storage verified/, 'does not claim anything was saved');
  });

  it('works on an empty app (first run): no snapshot is needed and the list is the file', async () => {
    const store = new FakeStorage();
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1'), tx('n2')]), []);
    const r = asRestored(run(app, parsed));
    assert.equal(r.snapshotKept, false);
    assert.deepEqual(stored(store).map((t) => t.id), ['n1', 'n2']);
  });
});

// ───────────── F. replace ─────────────

describe('Replace', () => {
  it('replaces everything, takes the snapshot FIRST (byte-for-byte) and reports it', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1'), tx('n2'), tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 400_000, description: 'secret salary' })]));
    store.log.length = 0;
    const r = asRestored(run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE }));

    assert.deepEqual(stored(store).map((t) => t.id), ['n1', 'n2', 'b']);
    assert.equal(r.removedCount, 1, 'only "a" was in the app and not in the file');
    assert.equal(r.totalAfter, 3);
    assert.equal(r.snapshotKept, true);
    const snapshots = store.snapshots();
    assert.equal(snapshots.length, 1);
    assert.equal(store.data.get(snapshots[0]!), RAW_EXISTING);
    const firstSnapshot = store.log.findIndex((o) => o.key.startsWith(SNAPSHOT_KEY_PREFIX));
    const firstLive = store.log.findIndex((o) => o.key === STORAGE_KEY);
    assert.ok(firstSnapshot >= 0 && firstSnapshot < firstLive, 'snapshot before the live write');
  });

  it('a file with no transactions never wipes the data, even with the right phrase', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([]));
    store.log.length = 0;
    const r = run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE });
    assert.equal(r.status, 'refused');
    assert.equal(r.status === 'refused' && r.reason, 'empty-replace');
    assert.equal(app.calls.length, 0);
    assert.deepEqual(store.log, []);
    assert.match(describeRunResult(r as never).text, /not changed/);
  });

  it('SNAPSHOT FAILURE: Replace is not attempted — the live key is never written and nothing is deleted', async () => {
    const store = seeded(RAW_EXISTING);
    store.failSet = (key) => key.startsWith(SNAPSHOT_KEY_PREFIX);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    store.log.length = 0;
    const r = run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE });
    assert.equal(r.status, 'failed');
    assert.ok(r.status === 'failed' && (r.stage === 'snapshot-write' || r.stage === 'snapshot-verify'));
    assert.equal(r.status === 'failed' && r.dataState, 'unchanged');
    assert.equal(store.liveWrites().length, 0, 'the live key was never written');
    assert.equal(store.data.get(STORAGE_KEY), RAW_EXISTING);
    assert.deepEqual(store.log.filter((o) => o.op === 'remove'), []);
    assert.deepEqual(app.current, EXISTING, 'the list on screen is unchanged');
    const message = describeRunResult(r as never);
    assert.equal(message.tone, 'error');
    assert.match(message.text, /snapshot/i);
    assert.doesNotMatch(message.text, /completed and storage verified/);
  });

  it('SNAPSHOT FAILURE (verify): a snapshot that does not read back identically also stops the restore', async () => {
    const store = seeded(RAW_EXISTING);
    store.mangleSet = (key, value) => (key.startsWith(SNAPSHOT_KEY_PREFIX) ? value.slice(0, 10) : null);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const r = run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE });
    assert.equal(r.status, 'failed');
    assert.equal(store.data.get(STORAGE_KEY), RAW_EXISTING);
    assert.equal(store.liveWrites().length, 0);
  });
});

// ───────────── G. unsaved changes ─────────────

describe('unsaved changes reject the restore', () => {
  it('UNSAVED CHANGES: refused for merge and replace, storage untouched, a clear message', async () => {
    for (const mode of ['merge', 'replace'] as const) {
      const store = seeded(RAW_EXISTING);
      const app = makeApp(store, { unsaved: () => true });
      const { parsed } = await prepared(await backupText([tx('n1')]));
      store.log.length = 0;
      const r = run(app, parsed, { mode, replacePhrase: REPLACE_CONFIRM_PHRASE });
      assert.equal(r.status, 'refused', mode);
      assert.equal(r.status === 'refused' && r.reason, 'unsaved-changes');
      assert.deepEqual(store.log, [], 'no snapshot, no write');
      assert.deepEqual(app.current, EXISTING);
      const message = describeRunResult(r as never);
      assert.equal(message.tone, 'error');
      assert.match(message.text, /not been saved/);
    }
  });

  it('the real provider performs that refusal before it touches the session (source guard)', () => {
    const provider = readFileSync(new URL('../src/state/TransactionsContext.tsx', import.meta.url), 'utf8');
    const body = provider.slice(provider.indexOf('const restoreTransactions'));
    assert.ok(body.indexOf('transactions !== syncedRef.current') < body.indexOf('session.restore('));
  });
});

// ───────────── H. persistence failure, success, future dates ─────────────

describe('persistence failure', () => {
  it('PERSISTENCE FAILURE: the write is refused by storage — reported as a failure, the previous data and the snapshot stay', async () => {
    const store = seeded(RAW_EXISTING);
    store.failSet = (key) => key === STORAGE_KEY;
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const r = run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE });
    assert.equal(r.status, 'failed');
    assert.equal(r.status === 'failed' && r.stage, 'persist');
    assert.equal(r.status === 'failed' && r.snapshotKept, true);
    assert.equal(store.data.get(STORAGE_KEY), RAW_EXISTING);
    assert.equal(store.snapshots().length, 1, 'the recovery snapshot is preserved');
    assert.equal(store.data.get(store.snapshots()[0]!), RAW_EXISTING);
    assert.deepEqual(app.current, EXISTING);
    const message = describeRunResult(r as never);
    assert.equal(message.tone, 'error');
    assert.match(message.text, /snapshot/i);
    assert.doesNotMatch(message.text, /completed and storage verified/);
  });

  it('verification failure (read-back unusable): the previous value is put back and verified, the snapshot is kept, never a success', async () => {
    const store = seeded(RAW_EXISTING);
    let liveReads = 0;
    store.mangleGet = (key) => {
      if (key === STORAGE_KEY && ++liveReads === 3) throw new Error('boom'); // 1: guard, 2: re-check, 3: verification
      return undefined;
    };
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    liveReads = 0;
    const r = run(app, parsed, { mode: 'merge' });
    assert.equal(r.status, 'failed');
    assert.equal(r.status === 'failed' && r.stage, 'verify');
    assert.equal(r.status === 'failed' && r.dataState, 'rolled-back');
    assert.equal(store.data.get(STORAGE_KEY), RAW_EXISTING);
    assert.equal(store.snapshots().length, 1);
    assert.deepEqual(app.current, EXISTING);
    const message = describeRunResult(r as never);
    assert.equal(message.tone, 'error');
    assert.match(message.text, /restored and verified/);
  });

  it('verification failure (storage altered the write): left alone, snapshot kept, the screen list unchanged, told to reload', async () => {
    const store = seeded(RAW_EXISTING);
    store.mangleSet = (key, value) => (key === STORAGE_KEY && value !== RAW_EXISTING ? value.slice(0, -3) : null);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const r = run(app, parsed, { mode: 'merge' });
    assert.equal(r.status, 'failed');
    assert.equal(r.status === 'failed' && r.stage, 'verify');
    assert.equal(r.status === 'failed' && r.dataState, 'changed-elsewhere');
    assert.equal(store.snapshots().length, 1);
    assert.equal(store.data.get(store.snapshots()[0]!), RAW_EXISTING, 'the snapshot holds the previous data');
    assert.deepEqual(app.current, EXISTING, 'the list on screen is never replaced after a failure');
    const message = describeRunResult(r as never);
    assert.equal(message.tone, 'error');
    assert.match(message.text, /Reload the page/);
    assert.doesNotMatch(message.text, /completed and storage verified/);
  });

  it('a failed restore leaves the preview source untouched: the failure message names the snapshot but no transaction content', async () => {
    const store = seeded(RAW_EXISTING);
    store.failSet = (key) => key === STORAGE_KEY;
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const r = run(app, parsed);
    const text = describeRunResult(r as never).text;
    assert.doesNotMatch(text, /secret|400000|item |groceries/);
  });
});

describe('successful restore', () => {
  it('SUCCESS is reported only for a verified restore, with counts and no transaction content', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1', '2026-09-01', { description: 'secret rent', amount: 8_888_888 }), tx('n2')]));
    const r = asRestored(run(app, parsed));
    const message = describeRunResult(r);
    assert.equal(message.tone, 'success');
    assert.match(message.text, /Merge completed and storage verified/);
    assert.doesNotMatch(message.text, /secret|8888888|item /);
    assert.deepEqual(app.current.map((t) => t.id), ['a', 'b', 'n1', 'n2'], 'the screen list adopts the verified result');
    // What is stored is exactly what is reported.
    assert.deepEqual(stored(store), [...app.current]);
  });

  it('a second restore of the same file after success is a no-op', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const raw = await backupText([tx('n1'), tx('n2')]);
    asRestored(run(app, (await prepared(raw)).parsed));
    const again = asRestored(run(app, (await prepared(raw, app.current)).parsed));
    assert.equal(again.changed, false);
  });

  it('UNVERIFIED: if the restore claims success but returns a different list, it is NOT reported as success', async () => {
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const lying: RestoreGate = () => ({
      status: 'restored', mode: 'merge', changed: true, transactions: [tx('zzz')], snapshotKey: 'k', snapshotsPruned: 0, pruneIncomplete: false, merge: null,
    });
    const r = runImport({ parsed, baseTransactions: EXISTING, currentTransactions: EXISTING, mode: 'merge', confirmed: true, restore: lying });
    assert.deepEqual(r, { status: 'unverified' });
    assert.equal(describeRunResult(r).tone, 'error');

    const wrongMode: RestoreGate = () => ({
      status: 'restored', mode: 'replace', changed: true, transactions: [...EXISTING, tx('n1')], snapshotKey: 'k', snapshotsPruned: 0, pruneIncomplete: false, merge: null,
    });
    assert.deepEqual(runImport({ parsed, baseTransactions: EXISTING, currentTransactions: EXISTING, mode: 'merge', confirmed: true, restore: wrongMode }), { status: 'unverified' });

    const replaceNoChange: RestoreGate = () => ({
      status: 'restored', mode: 'replace', changed: false, transactions: [tx('n1')], snapshotKey: null, snapshotsPruned: 0, pruneIncomplete: false, merge: null,
    });
    assert.deepEqual(
      runImport({ parsed, baseTransactions: EXISTING, currentTransactions: EXISTING, mode: 'replace', confirmed: true, replacePhrase: REPLACE_CONFIRM_PHRASE, restore: replaceNoChange }),
      { status: 'unverified' },
    );
  });

  it('a restore function that throws is reported as an unexpected, unverified state — never a success', async () => {
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const r = runImport({ parsed, baseTransactions: EXISTING, currentTransactions: EXISTING, mode: 'merge', confirmed: true, restore: () => { throw new Error('boom'); } });
    assert.deepEqual(r, { status: 'unexpected' });
    assert.equal(describeRunResult(r).tone, 'error');
  });

  it('failure results never produce a success message', () => {
    const results: ImportRunResult[] = [
      { status: 'refused', reason: 'conflict', message: 'x' },
      { status: 'refused', reason: 'blocked', message: 'x' },
      { status: 'refused', reason: 'unsaved-changes', message: 'x' },
      { status: 'failed', stage: 'persist', dataState: 'rollback-failed', snapshotKept: true, message: 'x' },
      { status: 'failed', stage: 'verify', dataState: 'changed-elsewhere', snapshotKept: true, message: 'x' },
      { status: 'unverified' },
      { status: 'unexpected' },
    ];
    for (const r of results) {
      const m = describeRunResult(r as never);
      assert.equal(m.tone, 'error');
      assert.doesNotMatch(m.text, /completed and storage verified/);
    }
  });
});

describe('future-dated transactions are preserved', () => {
  const FUTURE = '2099-12-31';

  it('merge keeps future-dated records from the file and the existing ones', async () => {
    const existing = [tx('a'), tx('f-old', FUTURE)];
    const store = seeded(envelope(existing));
    const app = makeApp(store);
    const { parsed, preview } = await prepared(await backupText([tx('f-new', FUTURE), tx('n1')]), existing);
    assert.equal(preview.futureDatedCount, 1);
    asRestored(run(app, parsed));
    const after = stored(store);
    assert.deepEqual(after.map((t) => [t.id, t.date]), [['a', '2026-11-01'], ['f-old', FUTURE], ['f-new', FUTURE], ['n1', '2026-11-01']]);
  });

  it('replace keeps future-dated records exactly as in the file (the reducer date rule is not applied to a restore)', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('f1', FUTURE), tx('f2', '2100-01-01'), tx('p', '2026-01-01')]));
    asRestored(run(app, parsed, { mode: 'replace', replacePhrase: REPLACE_CONFIRM_PHRASE }));
    assert.deepEqual(stored(store).map((t) => t.date), [FUTURE, '2100-01-01', '2026-01-01']);
    assert.deepEqual(app.current.map((t) => t.date), [FUTURE, '2100-01-01', '2026-01-01']);
  });
});

// ───────────── I. stale preview ─────────────

describe('a preview that is out of date is never restored', () => {
  it('if the list changed after the preview, nothing is restored and a fresh preview is returned', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed, preview } = await prepared(await backupText([tx('n1'), tx('x')]));
    const changedList = [...EXISTING, tx('x')];
    store.log.length = 0;
    const r = runImport({ parsed, baseTransactions: EXISTING, currentTransactions: changedList, mode: 'merge', confirmed: true, restore: app.gate });
    assert.equal(r.status, 'stale');
    const fresh = (r as { preview: ImportPreview }).preview;
    assert.equal(preview.newCount, 2);
    assert.equal(fresh.newCount, 1);
    assert.equal(fresh.duplicateCount, 1);
    assert.equal(app.calls.length, 0);
    assert.deepEqual(store.log, []);
  });

  it('an unchanged list with a new array identity is not stale', async () => {
    const app = makeApp(seeded(RAW_EXISTING));
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const r = runImport({ parsed, baseTransactions: EXISTING, currentTransactions: EXISTING.map((t) => ({ ...t })), mode: 'merge', confirmed: true, restore: app.gate });
    assert.equal(r.status, 'restored');
  });

  it('another tab changed storage after the preview: the Stage 2 conflict refusal surfaces, nothing is overwritten', async () => {
    const store = seeded(RAW_EXISTING);
    const app = makeApp(store);
    const { parsed } = await prepared(await backupText([tx('n1')]));
    const theirs = envelope([...EXISTING, tx('from-other-tab')]);
    store.data.set(STORAGE_KEY, theirs);
    const r = run(app, parsed);
    assert.equal(r.status, 'refused');
    assert.equal(r.status === 'refused' && r.reason, 'conflict');
    assert.equal(store.data.get(STORAGE_KEY), theirs);
    assert.equal(store.snapshots().length, 0);
  });
});

// ───────────── J. source guards ─────────────

describe('architecture and UI guards (source text)', () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const card = read('components/data/ImportRestoreCard.tsx');
  const logic = read('lib/importRestore.ts');
  const page = read('components/data/DataPage.tsx');

  it('the logic layer only imports the backup engine, the storage TYPES/planner and the transaction type; it has no storage access', () => {
    const imports = [...code(logic).matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ['@/lib/backup', '@/lib/backup', '@/lib/storage', '@/lib/storage', '@/types/transaction']);
    assert.doesNotMatch(code(logic), /localStorage|sessionStorage|STORAGE_KEY|\.setItem\(|\.removeItem\(|openSession|from 'react'|document\.|fetch\(|setTimeout|setInterval/);
    assert.doesNotMatch(code(logic), /allowEmptyReplace:\s*true/);
    assert.match(code(logic), /parseBackup\(/);
  });

  it('choosing a file is read-only: handleFile never calls runImport or the restore function', () => {
    const handler = card.slice(card.indexOf('async function handleFile'), card.indexOf('function handleConfirm'));
    assert.ok(handler.length > 100);
    assert.doesNotMatch(handler, /runImport|restoreTransactions|restore\b/);
    assert.match(handler, /readImportFile\(file\)/);
    assert.match(handler, /prepareImport\(/);
  });

  it('the only restore path is handleConfirm, via the Context function, with confirmed: true set once, there', () => {
    assert.equal((card.match(/runImport\(/g) ?? []).length, 1);
    assert.equal((card.match(/confirmed: true/g) ?? []).length, 1);
    const confirm = card.slice(card.indexOf('function handleConfirm'), card.indexOf('const preview ='));
    assert.match(confirm, /confirmed: true/);
    assert.match(confirm, /restore: restoreTransactions/);
    assert.match(card, /const \{ transactions, persistenceOk, restoreTransactions \} = useTransactions\(\)/);
    assert.match(confirm, /busy\.current/);
  });

  it('the card never touches storage, snapshots, recovery copies or the engine directly', () => {
    assert.doesNotMatch(code(card), /localStorage|sessionStorage|STORAGE_KEY|openSession|snapshot\b|recovery|from '@\/lib\/backup'|from '@\/lib\/storage'|FileReader|parseBackup\(|planMerge\(|JSON\.(parse|stringify)/i);
  });

  it('Merge is the default; Replace sits behind the typed phrase and its button is disabled until it matches', () => {
    assert.match(card, /useState<ImportMode>\('merge'\)/);
    assert.match(card, /disabled=\{!isReplacePhrase\(phrase\)\}/);
    assert.match(card, /type="file" accept="\.json,application\/json"/);
  });

  it('success appears only through describeRunResult; the card never writes a success message itself', () => {
    assert.match(card, /describeRunResult\(result\)/);
    assert.doesNotMatch(code(card), /tone: 'success'/);
    const confirm = card.slice(card.indexOf('function handleConfirm'), card.indexOf('const preview ='));
    assert.ok(confirm.indexOf("result.status === 'stale'") < confirm.indexOf("result.status !== 'not-confirmed'"));
  });

  it('states: loading (aria-busy), preview, confirmation, success/info (role=status), error (role=alert)', () => {
    assert.match(card, /aria-busy=\{reading\}/);
    assert.match(card, /disabled=\{reading\}/);
    assert.match(card, /role=\{stage\.message\.tone === 'error' \? 'alert' : 'status'\}/);
    assert.match(card, /role="alert"/);
    assert.match(card, /IMPORT_PRIVACY_TEXT/);
    assert.match(card, /UNSAVED_IMPORT_NOTE/);
  });

  it('the preview shows counts and dates only: no amounts, descriptions, categories or record lists', () => {
    assert.doesNotMatch(code(card), /formatCurrency|\.amount|\.description|\.categoryId|\.transactions\b|\.map\(\(t\)/);
    for (const label of ['Backup date', 'Transactions in file', 'New transactions', 'Duplicates', 'Conflicting ids', 'Validation errors']) {
      assert.ok(card.includes(label), label);
    }
  });

  it('direction: neither the card nor the Data page sets a direction of its own (the whole app is left-to-right)', () => {
    assert.doesNotMatch(code(card), /\bdir=["']?rtl|rtl:|writing-mode/);
    assert.doesNotMatch(code(page), /\bdir=["']?rtl|lang="fa"/);
    assert.match(page, /<ImportRestoreCard \/>/);
    assert.doesNotMatch(code(page).replace(/^import .*$/gm, ''), /\b(restore|merge|replace|snapshot)\b/i);
  });

  it('mobile layout: stacked full-width buttons on small screens, row on sm+', () => {
    assert.match(card, /w-full sm:w-auto/);
    assert.match(card, /flex-col-reverse gap-2 sm:flex-row/);
  });

  it('scope: no new dependencies, no timers, no Undo/Snapshot-management UI', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['lucide-react', 'react', 'react-dom']);
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', '@types/react', '@types/react-dom', '@vitejs/plugin-react', 'autoprefixer', 'postcss', 'tailwindcss', 'typescript', 'vite']);
    for (const text of [card, logic, read('components/data/importCopy.ts')]) {
      assert.doesNotMatch(text, /setTimeout|setInterval/);
      assert.doesNotMatch(code(text), /undo|listSnapshotKeys|SNAPSHOT_KEY_PREFIX/i);
    }
  });
});
