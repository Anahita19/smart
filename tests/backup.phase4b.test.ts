/**
 * Phase 4B / Stage 1 tests for src/lib/backup.ts (pure logic: build, parse, validate, checksum,
 * versioning, migration architecture, merge planning). No browser, no storage, no packages.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  BACKUP_FORMAT,
  BACKUP_MIGRATIONS,
  BACKUP_VERSION,
  BackupError,
  MAX_BACKUP_CHARS,
  backupFileName,
  buildBackup,
  buildReport,
  canonicalJson,
  computeChecksum,
  createBackupJson,
  migrateBackupDocument,
  parseBackup,
  planMerge,
  serializeBackup,
  sha256Hex,
} from '../src/lib/backup.ts';
import type { BackupFile, DigestLike, ParseBackupResult } from '../src/lib/backup.ts';
import { MAX_DESCRIPTION_LENGTH, MAX_AMOUNT_CENTS } from '../src/lib/validation.ts';
import { SCHEMA_VERSION, parseStoredPayload, serializeEnvelope } from '../src/lib/storage.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

const TODAY = '2026-11-10';
const NOW = new Date('2026-11-10T08:00:00.000Z');

const tx = (id: string, date = '2026-11-01', over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date, ...over,
});

const GOOD: Transaction[] = [
  tx('a'),
  tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 400_000, description: 'Salary' }),
  tx('c', '2026-09-15', { categoryId: 'dining', amount: 4_599, description: 'Dinner' }),
];

const parse = (raw: string, extra: Parameters<typeof parseBackup>[1] = {}) => parseBackup(raw, { today: TODAY, ...extra });

function must<T extends ParseBackupResult>(result: T): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? '' : `${result.error.code}: ${result.error.message}`);
  return result as Extract<T, { ok: true }>;
}
function mustFail(result: ParseBackupResult, code: string) {
  assert.equal(result.ok, false, 'expected a failure');
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.error.code, code, result.error.message);
  return result.error;
}

async function validFile(list: readonly Transaction[] = GOOD): Promise<BackupFile> {
  return buildBackup(list, { now: NOW, appVersion: '0.2.0' });
}
/** A backup document as a plain object that tests can tamper with, with a correct checksum for its data. */
async function doc(list: readonly Transaction[] = GOOD): Promise<Record<string, any>> {
  return JSON.parse(serializeBackup(await validFile(list)));
}
async function withData(transactions: unknown[]): Promise<string> {
  const d = await doc();
  d.data = { transactions };
  d.counts = { transactions: transactions.length };
  d.checksum.value = await computeChecksum(d.data);
  return JSON.stringify(d);
}

// ───────────── valid backups ─────────────

describe('valid backups', () => {
  it('round-trips: build → serialize → parse returns exactly the same transactions', async () => {
    const result = must(await parse(serializeBackup(await validFile())));
    assert.equal(result.source, 'backup');
    assert.deepEqual(result.transactions, GOOD);
    assert.equal(result.meta.checksum, 'verified');
    assert.equal(result.meta.backupVersion, BACKUP_VERSION);
    assert.equal(result.meta.exportedAt, NOW.toISOString());
  });

  it('writes the documented structure', async () => {
    const file = await validFile();
    assert.equal(file.format, BACKUP_FORMAT);
    assert.equal(file.backupVersion, 1);
    assert.equal(file.appSchemaVersion, SCHEMA_VERSION);
    assert.equal(file.exportedAt, '2026-11-10T08:00:00.000Z');
    assert.deepEqual(file.app, { name: 'smart-expense-tracker', version: '0.2.0' });
    assert.deepEqual(file.counts, { transactions: 3 });
    assert.equal(file.checksum.algorithm, 'SHA-256');
    assert.match(file.checksum.value, /^[0-9a-f]{64}$/);
    assert.deepEqual(file.data.transactions, GOOD);
  });

  it('omits app.version when not supplied', async () => {
    const file = await buildBackup(GOOD, { now: NOW });
    assert.deepEqual(file.app, { name: 'smart-expense-tracker' });
  });

  it('serialization is deterministic and createBackupJson equals serialize(build)', async () => {
    const one = serializeBackup(await validFile());
    const two = serializeBackup(await validFile());
    assert.equal(one, two);
    assert.equal(await createBackupJson(GOOD, { now: NOW, appVersion: '0.2.0' }), one);
    assert.ok(one.endsWith('\n'));
  });

  it('an empty list is a valid backup', async () => {
    const result = must(await parse(await createBackupJson([], { now: NOW })));
    assert.deepEqual(result.transactions, []);
    assert.equal(result.report.dateRange, null);
    assert.equal(result.report.total, 0);
  });

  it('the checksum does not depend on key order or whitespace in the file', async () => {
    const d = await doc();
    const reordered = {
      data: { transactions: d.data.transactions.map((t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).reverse())) },
      checksum: d.checksum, counts: d.counts, exportedAt: d.exportedAt, appSchemaVersion: d.appSchemaVersion,
      backupVersion: d.backupVersion, format: d.format,
    };
    must(await parse(JSON.stringify(reordered)));
    must(await parse(JSON.stringify(reordered, null, 4)));
  });

  it('a leading byte-order mark is tolerated', async () => {
    must(await parse('﻿' + serializeBackup(await validFile())));
  });

  it('unknown extra properties on records are covered by the checksum but never returned', async () => {
    const d = await doc();
    d.data.transactions[0].injected = '<script>';
    d.checksum.value = await computeChecksum(d.data);
    const result = must(await parse(JSON.stringify(d)));
    assert.deepEqual(result.transactions, GOOD);
    assert.ok(result.transactions.every((t) => Object.keys(t).sort().join() === 'amount,categoryId,date,description,id,type'));
  });

  it('report: counts, income/expense split, date range, unknown categories', async () => {
    const list = [...GOOD, tx('z', '2026-08-01', { categoryId: 'no-such-category' })];
    const { report } = must(await parse(await createBackupJson(list, { now: NOW })));
    assert.deepEqual(report, {
      total: 4, incomeCount: 1, expenseCount: 3, futureDated: 0, unknownCategories: 1,
      dateRange: { from: '2026-08-01', to: '2026-11-01' },
    });
  });

  it('building does not mutate its input', async () => {
    const input = structuredClone(GOOD);
    await buildBackup(input, { now: NOW });
    assert.deepEqual(input, GOOD);
  });
});

// ───────────── invalid JSON and unrecognised content ─────────────

describe('invalid JSON and unrecognised content', () => {
  it('broken JSON → invalid-json', async () => {
    for (const raw of ['{"format":', '{broken', 'not json', '[1,2', '{"a":1,}']) {
      mustFail(await parse(raw), 'invalid-json');
    }
  });
  it('empty or whitespace-only → empty', async () => {
    for (const raw of ['', '   ', '\n\t', '﻿']) mustFail(await parse(raw), 'empty');
  });
  it('valid JSON that is not a backup → unrecognized-format', async () => {
    for (const raw of ['5', '"text"', 'null', 'true', '{}', '{"transactions":[]}', '{"format":"something-else"}', '{"foo":1}']) {
      mustFail(await parse(raw), 'unrecognized-format');
    }
  });
  it('an oversized file is refused before parsing', async () => {
    mustFail(await parse('x'.repeat(MAX_BACKUP_CHARS + 1)), 'too-large');
  });
  it('parseBackup never throws, whatever it is given', async () => {
    for (const raw of ['\u0000', '[[[[', '{"format":"smart-expense-tracker-backup"}', '[null]', '[[]]', '{"schemaVersion":null}']) {
      const result = await parse(raw);
      assert.equal(typeof result.ok, 'boolean');
    }
  });
});

// ───────────── versions ─────────────

describe('version checking', () => {
  it('a newer backupVersion is refused — before the checksum is even looked at', async () => {
    const d = await doc();
    d.backupVersion = 2;
    d.checksum.value = '0'.repeat(64); // would mismatch, but the version check comes first
    const error = mustFail(await parse(JSON.stringify(d)), 'unsupported-version');
    assert.match(error.message, /newer/);
  });
  it('a newer appSchemaVersion is refused', async () => {
    const d = await doc();
    d.appSchemaVersion = SCHEMA_VERSION + 1;
    mustFail(await parse(JSON.stringify(d)), 'unsupported-version');
  });
  it('invalid version numbers are malformed', async () => {
    for (const bad of [0, -1, 1.5, '1', null, true]) {
      const d = await doc();
      d.backupVersion = bad;
      mustFail(await parse(JSON.stringify(d)), 'malformed');
    }
    for (const bad of [0, 1.5, '1']) {
      const d = await doc();
      d.appSchemaVersion = bad;
      mustFail(await parse(JSON.stringify(d)), 'malformed');
    }
  });
  it('a storage envelope with another schemaVersion is refused; a non-integer one is malformed', async () => {
    mustFail(await parse(JSON.stringify({ schemaVersion: 2, savedAt: 'x', transactions: [] })), 'unsupported-version');
    mustFail(await parse(JSON.stringify({ schemaVersion: 0, savedAt: 'x', transactions: [] })), 'malformed');
    mustFail(await parse(JSON.stringify({ schemaVersion: 1.5, savedAt: 'x', transactions: [] })), 'malformed');
    mustFail(await parse(JSON.stringify({ schemaVersion: '1', savedAt: 'x', transactions: [] })), 'malformed');
  });
});

// ───────────── checksum ─────────────

describe('SHA-256 checksum', () => {
  it('sha256Hex matches the standard test vectors', async () => {
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('canonicalJson sorts keys recursively and is whitespace-free', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it('changing an amount, a description, a date or the list size is a mismatch', async () => {
    const edits: Array<(d: Record<string, any>) => void> = [
      (d) => { d.data.transactions[0].amount += 1; },
      (d) => { d.data.transactions[1].description = 'Salary!'; },
      (d) => { d.data.transactions[2].date = '2026-09-16'; },
      (d) => { d.data.transactions[0].id = 'a2'; },
      (d) => { d.data.transactions.pop(); d.counts.transactions = 2; },
      (d) => { d.data.transactions.push(structuredClone(d.data.transactions[0])); d.data.transactions[3].id = 'extra'; d.counts.transactions = 4; },
    ];
    for (const edit of edits) {
      const d = await doc();
      edit(d);
      mustFail(await parse(JSON.stringify(d)), 'checksum-mismatch');
    }
  });
  it('an uppercase checksum is accepted; a wrong one is not', async () => {
    const d = await doc();
    d.checksum.value = d.checksum.value.toUpperCase();
    must(await parse(JSON.stringify(d)));
    d.checksum.value = (d.checksum.value[0] === 'A' ? 'B' : 'A') + d.checksum.value.slice(1);
    mustFail(await parse(JSON.stringify(d)), 'checksum-mismatch');
  });
  it('a missing checksum is refused, never skipped', async () => {
    const d = await doc();
    delete d.checksum;
    const error = mustFail(await parse(JSON.stringify(d)), 'checksum-missing');
    assert.match(error.message, /integrity/);
  });
  it('an unsupported algorithm or a malformed value is refused', async () => {
    const a = await doc(); a.checksum.algorithm = 'MD5';
    mustFail(await parse(JSON.stringify(a)), 'unsupported-checksum');
    for (const value of ['', 'abc', 'g'.repeat(64), '0'.repeat(63), 5, null]) {
      const d = await doc(); d.checksum.value = value;
      assert.equal((await parse(JSON.stringify(d))).ok, false, String(value));
    }
    const e = await doc(); e.checksum = 'abc';
    mustFail(await parse(JSON.stringify(e)), 'malformed');
  });
  it('Web Crypto unavailable → fails safely with a clear error (parse, build and sha256Hex)', async () => {
    const raw = serializeBackup(await validFile());
    const error = mustFail(await parse(raw, { subtle: null }), 'crypto-unavailable');
    assert.match(error.message, /Web Crypto|SHA-256/);
    assert.match(error.message, /not read/);
    await assert.rejects(buildBackup(GOOD, { subtle: null }), (e: unknown) => e instanceof BackupError && e.code === 'crypto-unavailable');
    await assert.rejects(sha256Hex('x', null), (e: unknown) => e instanceof BackupError && e.code === 'crypto-unavailable');
  });
  it('a subtle object without digest, or whose digest rejects, also fails safely (checksum never skipped)', async () => {
    const raw = serializeBackup(await validFile());
    mustFail(await parse(raw, { subtle: {} as unknown as DigestLike }), 'crypto-unavailable');
    const rejecting: DigestLike = { digest: () => Promise.reject(new Error('boom')) };
    mustFail(await parse(raw, { subtle: rejecting }), 'crypto-unavailable');
  });
  it('a stub whose digest returns the wrong hash is detected as a mismatch (the hash really is compared)', async () => {
    const raw = serializeBackup(await validFile());
    const zeros: DigestLike = { digest: async () => new ArrayBuffer(32) };
    mustFail(await parse(raw, { subtle: zeros }), 'checksum-mismatch');
  });
  it('legacy formats need no checksum, so they still import when Web Crypto is unavailable', async () => {
    must(await parse(JSON.stringify(GOOD), { subtle: null }));
    must(await parse(serializeEnvelope(GOOD, NOW), { subtle: null }));
  });
  it('the count in the file must match the data (checksum alone does not cover counts)', async () => {
    const d = await doc();
    d.counts.transactions = 99;
    mustFail(await parse(JSON.stringify(d)), 'count-mismatch');
  });
});

// ───────────── missing fields ─────────────

describe('missing and malformed fields', () => {
  it('each required backup field is reported when absent', async () => {
    for (const field of ['backupVersion', 'appSchemaVersion', 'exportedAt', 'counts', 'data']) {
      const d = await doc();
      delete d[field];
      const error = mustFail(await parse(JSON.stringify(d)), 'missing-field');
      assert.ok(error.message.includes(field), field);
    }
  });
  it('wrong types are malformed', async () => {
    const cases: Array<(d: Record<string, any>) => void> = [
      (d) => { d.exportedAt = 'not a date'; },
      (d) => { d.exportedAt = 5; },
      (d) => { d.counts = 3; },
      (d) => { d.counts = { transactions: -1 }; },
      (d) => { d.counts = { transactions: '3' }; },
      (d) => { d.data = []; },
      (d) => { d.data = { transactions: {} }; },
      (d) => { d.data = {}; },
    ];
    for (const edit of cases) {
      const d = await doc();
      edit(d);
      mustFail(await parse(JSON.stringify(d)), 'malformed');
    }
  });
  it('a storage envelope missing savedAt or transactions is refused', async () => {
    mustFail(await parse(JSON.stringify({ schemaVersion: 1, transactions: [] })), 'missing-field');
    mustFail(await parse(JSON.stringify({ schemaVersion: 1, savedAt: 'x' })), 'missing-field');
    mustFail(await parse(JSON.stringify({ schemaVersion: 1, savedAt: 5, transactions: [] })), 'malformed');
    mustFail(await parse(JSON.stringify({ schemaVersion: 1, savedAt: 'x', transactions: {} })), 'malformed');
  });
  it('a record missing a required field rejects the whole file', async () => {
    for (const field of ['id', 'type', 'amount', 'categoryId', 'description', 'date']) {
      const bad: Record<string, unknown> = { ...tx('m') };
      delete bad[field];
      const error = mustFail(await parse(await withData([...GOOD, bad])), 'invalid-transactions');
      assert.equal(error.details?.invalidRecords, 1, field);
      assert.deepEqual(error.details?.indexes, [3], field);
    }
  });
});

// ───────────── invalid transactions (all-or-nothing) ─────────────

describe('invalid transactions reject the entire file', () => {
  const longOk = 'x'.repeat(MAX_DESCRIPTION_LENGTH);
  const bads: Array<[string, unknown]> = [
    ['zero amount', tx('z', '2026-11-01', { amount: 0 })],
    ['negative amount', tx('n', '2026-11-01', { amount: -5 })],
    ['fractional amount', tx('f', '2026-11-01', { amount: 12.5 })],
    ['string amount', tx('s', '2026-11-01', { amount: '1250' as unknown as number })],
    ['NaN-like amount', { ...tx('q'), amount: null }],
    ['over the maximum amount', tx('big', '2026-11-01', { amount: MAX_AMOUNT_CENTS + 1 })],
    ['unknown type', tx('t', '2026-11-01', { type: 'transfer' as unknown as 'income' })],
    ['impossible date', tx('d1', '2026-02-30')],
    ['wrongly formatted date', tx('d2', '11/01/2026')],
    ['empty id', tx('', '2026-11-01')],
    ['numeric id', { ...tx('i'), id: 7 }],
    ['non-string category', { ...tx('c'), categoryId: 3 }],
    ['non-string description', { ...tx('e'), description: null }],
    ['null record', null],
    ['string record', 'a transaction'],
    ['nested array record', [tx('arr')]],
  ];

  for (const [name, record] of bads) {
    it(`${name} → whole file rejected, nothing returned (legacy array and backup file)`, async () => {
      const legacy = mustFail(await parse(JSON.stringify([...GOOD, record])), 'invalid-transactions');
      assert.equal(legacy.details?.invalidRecords, 1);
      assert.deepEqual(legacy.details?.indexes, [GOOD.length]);
      const inBackup = mustFail(await parse(await withData([record, ...GOOD])), 'invalid-transactions');
      assert.deepEqual(inBackup.details?.indexes, [0]);
    });
  }

  it('description: exactly the limit is accepted, one over rejects the file', async () => {
    must(await parse(JSON.stringify([tx('ok', '2026-11-01', { description: longOk })])));
    const error = mustFail(await parse(JSON.stringify([...GOOD, tx('long', '2026-11-01', { description: longOk + 'x' })])), 'invalid-transactions');
    assert.equal(error.details?.descriptionTooLong, 1);
    assert.match(error.message, new RegExp(`over ${MAX_DESCRIPTION_LENGTH} characters`));
  });
  it('the largest allowed amount and the smallest (1 cent) are accepted', async () => {
    must(await parse(JSON.stringify([tx('max', '2026-11-01', { amount: MAX_AMOUNT_CENTS }), tx('min', '2026-11-01', { amount: 1 })])));
  });
  it('several bad records are all counted; positions are capped', async () => {
    const many = Array.from({ length: 30 }, (_, i) => tx(`bad${i}`, '2026-11-01', { amount: 0 }));
    const error = mustFail(await parse(JSON.stringify([...GOOD, ...many])), 'invalid-transactions');
    assert.equal(error.details?.invalidRecords, 30);
    assert.equal(error.details?.indexes?.length, 20);
  });
  it('errors never contain transaction contents', async () => {
    const secret = 'TOP-SECRET-PAYEE';
    const records = [tx('s', '2026-11-01', { description: secret, amount: 0 }), tx('t', '2026-11-01', { description: secret + 'x'.repeat(100) })];
    for (const raw of [JSON.stringify(records), await withData(records)]) {
      const error = mustFail(await parse(raw), 'invalid-transactions');
      assert.doesNotMatch(JSON.stringify(error), /TOP-SECRET/);
    }
  });
  it('building a backup from invalid data throws instead of writing a file that could not be restored', async () => {
    for (const list of [[tx('z', '2026-11-01', { amount: 0 })], [tx('l', '2026-11-01', { description: 'x'.repeat(81) })], [tx('d'), tx('d')]]) {
      await assert.rejects(buildBackup(list), (e: unknown) => e instanceof BackupError && /can’t be created/.test(e.message));
    }
  });
});

// ───────────── duplicate ids ─────────────

describe('duplicate ids inside a file', () => {
  it('a repeated id rejects the whole file — even when the copies are identical', async () => {
    const error = mustFail(await parse(JSON.stringify([tx('a'), tx('b'), tx('a')])), 'duplicate-ids');
    assert.equal(error.details?.duplicateIds, 1);
    assert.deepEqual(error.details?.indexes, [2]);
    mustFail(await parse(JSON.stringify([tx('a'), tx('a')])), 'duplicate-ids');
  });
  it('same id with different content is rejected too (the second would otherwise be silently lost)', async () => {
    mustFail(await parse(JSON.stringify([tx('a'), tx('a', '2026-10-01', { amount: 99 })])), 'duplicate-ids');
  });
  it('in the backup format (valid checksum) and in the storage envelope', async () => {
    mustFail(await parse(await withData([tx('a'), tx('a')])), 'duplicate-ids');
    mustFail(await parse(JSON.stringify({ schemaVersion: 1, savedAt: 'x', transactions: [tx('a'), tx('a')] })), 'duplicate-ids');
  });
  it('a file with both invalid records and duplicates reports invalid-transactions with both counts', async () => {
    const error = mustFail(await parse(JSON.stringify([tx('a'), tx('a'), tx('z', '2026-11-01', { amount: 0 })])), 'invalid-transactions');
    assert.equal(error.details?.invalidRecords, 1);
    assert.equal(error.details?.duplicateIds, 1);
  });
  it('building rejects duplicate ids', async () => {
    await assert.rejects(buildBackup([tx('a'), tx('a')]), (e: unknown) => e instanceof BackupError && e.code === 'duplicate-ids');
  });
});

// ───────────── future dates ─────────────

describe('future-dated transactions are preserved', () => {
  const future = [tx('f1', '2026-11-11'), tx('f2', '2027-01-01', { type: 'income', categoryId: 'salary' })];
  const mixed = [...GOOD, ...future];

  it('kept untouched through build → parse', async () => {
    const result = must(await parse(await createBackupJson(mixed, { now: NOW })));
    assert.deepEqual(result.transactions, mixed);
    assert.equal(result.report.futureDated, 2);
    assert.deepEqual(result.report.dateRange, { from: '2026-09-15', to: '2027-01-01' });
  });
  it('kept in both legacy formats', async () => {
    assert.equal(must(await parse(JSON.stringify(mixed))).report.futureDated, 2);
    assert.equal(must(await parse(serializeEnvelope(mixed, NOW))).transactions.length, 5);
  });
  it('"future" follows the injected today; today itself is not future', async () => {
    assert.equal(buildReport(mixed, '2026-11-11').futureDated, 1);
    assert.equal(buildReport(mixed, '2027-01-01').futureDated, 0);
    assert.equal(buildReport(mixed, '2026-11-10').futureDated, 2);
  });
  it('merge planning keeps future-dated records', () => {
    const plan = planMerge(GOOD, future);
    assert.deepEqual(plan.toAdd, future);
    assert.equal(plan.merged.length, 5);
  });
});

// ───────────── legacy formats ─────────────

describe('legacy import formats', () => {
  it('bare transaction array', async () => {
    const result = must(await parse(JSON.stringify(GOOD)));
    assert.equal(result.source, 'legacy-array');
    assert.deepEqual(result.transactions, GOOD);
    assert.equal(result.meta.checksum, 'not-present');
    assert.equal(result.meta.exportedAt, undefined);
  });
  it('existing localStorage envelope — the exact string the app writes', async () => {
    const raw = serializeEnvelope(GOOD, NOW);
    const result = must(await parse(raw));
    assert.equal(result.source, 'storage-envelope');
    assert.deepEqual(result.transactions, GOOD);
    assert.equal(result.meta.checksum, 'not-present');
    assert.equal(result.meta.exportedAt, NOW.toISOString());
  });
  it('whatever the storage loader accepts from a clean payload, the importer accepts too', async () => {
    for (const raw of [JSON.stringify(GOOD), serializeEnvelope(GOOD, NOW)]) {
      const stored = parseStoredPayload(raw);
      assert.equal(stored.status, 'ok');
      assert.deepEqual(must(await parse(raw)).transactions, stored.status === 'ok' ? stored.transactions : null);
    }
  });
  it('empty array and empty envelope are valid', async () => {
    assert.deepEqual(must(await parse('[]')).transactions, []);
    assert.deepEqual(must(await parse(serializeEnvelope([], NOW))).transactions, []);
  });
  it('strict where the loader is lenient: one bad record rejects the whole legacy file', async () => {
    const raw = JSON.stringify([...GOOD, { nope: true }]);
    assert.equal(parseStoredPayload(raw).status, 'ok'); // the startup loader would keep the 3 good ones…
    mustFail(await parse(raw), 'invalid-transactions'); // …an import refuses the file
  });
  it('unknown category ids are accepted and counted, in every format', async () => {
    const list = [tx('u', '2026-11-01', { categoryId: 'removed-category' })];
    for (const raw of [JSON.stringify(list), serializeEnvelope(list, NOW), await createBackupJson(list, { now: NOW })]) {
      assert.equal(must(await parse(raw)).report.unknownCategories, 1);
    }
  });
});

// ───────────── migration architecture ─────────────

describe('migration architecture', () => {
  it('there are no migrations yet, and a current-version file is not migrated', async () => {
    assert.deepEqual(Object.keys(BACKUP_MIGRATIONS), []);
    assert.equal(BACKUP_VERSION, 1);
    const out = migrateBackupDocument({ a: 1 }, 1);
    assert.deepEqual(out, { ok: true, doc: { a: 1 } });
  });

  // A hypothetical version 2 that renamed `description` to `note`; the migration upgrades v1 → v2.
  const v1toV2 = (d: Record<string, unknown>): Record<string, unknown> => {
    const data = d.data as { transactions: Array<Record<string, unknown>> };
    return {
      ...d,
      backupVersion: 2,
      data: { transactions: data.transactions.map(({ description, ...rest }) => ({ ...rest, description: String(description).toUpperCase() })) },
    };
  };

  it('an older file is checksum-verified as written, then migrated step by step', async () => {
    const calls: number[] = [];
    const table = { 1: (d: Record<string, unknown>) => { calls.push(1); return v1toV2(d); } };
    const result = must(await parse(serializeBackup(await validFile()), { targetVersion: 2, migrations: table }));
    assert.deepEqual(calls, [1]);
    assert.deepEqual(result.transactions.map((t) => t.description), GOOD.map((t) => t.description.toUpperCase()));
    assert.equal(result.meta.checksum, 'verified');
  });
  it('a tampered older file fails its checksum before any migration runs', async () => {
    let ran = false;
    const table = { 1: (d: Record<string, unknown>) => { ran = true; return d; } };
    const d = await doc();
    d.data.transactions[0].amount += 1;
    mustFail(await parse(JSON.stringify(d), { targetVersion: 2, migrations: table }), 'checksum-mismatch');
    assert.equal(ran, false);
  });
  it('chains several steps in order', () => {
    const order: number[] = [];
    const table = {
      1: (d: Record<string, unknown>) => { order.push(1); return { ...d, s1: true }; },
      2: (d: Record<string, unknown>) => { order.push(2); return { ...d, s2: true }; },
    };
    const out = migrateBackupDocument({}, 1, 3, table);
    assert.deepEqual(order, [1, 2]);
    assert.deepEqual(out, { ok: true, doc: { s1: true, s2: true } });
  });
  it('a missing step → unsupported-version; a throwing step → migration-failed; a non-object result is a failure', async () => {
    const raw = serializeBackup(await validFile());
    mustFail(await parse(raw, { targetVersion: 3, migrations: { 1: v1toV2 } }), 'unsupported-version');
    mustFail(await parse(raw, { targetVersion: 2, migrations: { 1: () => { throw new Error('x'); } } }), 'migration-failed');
    mustFail(await parse(raw, { targetVersion: 2, migrations: { 1: () => null as unknown as Record<string, unknown> } }), 'migration-failed');
    mustFail(await parse(raw, { targetVersion: 2, migrations: { 1: (d) => ({ ...d, data: 5 }) } }), 'migration-failed');
  });
  it('migrated records are validated like any others', async () => {
    const bad = (d: Record<string, unknown>) => ({ ...d, data: { transactions: [{ id: 'x' }] } });
    mustFail(await parse(serializeBackup(await validFile()), { targetVersion: 2, migrations: { 1: bad } }), 'invalid-transactions');
  });
  it('migration does not mutate the original document', () => {
    const original = { data: { transactions: [] as unknown[] } };
    const snapshot = structuredClone(original);
    migrateBackupDocument(original, 1, 2, { 1: (d) => ({ ...d, extra: 1 }) });
    assert.deepEqual(original, snapshot);
  });
});

// ───────────── merge planning ─────────────

describe('merge planning and duplicate detection', () => {
  it('into an empty list: everything is added', () => {
    const plan = planMerge([], GOOD);
    assert.deepEqual(plan.merged, GOOD);
    assert.deepEqual(plan.summary, {
      existing: 0, incoming: 3, added: 3, skippedIdentical: 0, conflicts: 0, conflictsReplaced: 0, possibleDuplicates: 0, resultTotal: 3,
    });
  });
  it('an empty backup changes nothing', () => {
    const plan = planMerge(GOOD, []);
    assert.deepEqual(plan.merged, GOOD);
    assert.equal(plan.summary.added, 0);
  });
  it('new ids are added after the existing records, in file order', () => {
    const incoming = [tx('n1', '2026-07-01'), tx('n2', '2026-07-02')];
    const plan = planMerge(GOOD, incoming);
    assert.deepEqual(plan.merged.map((t) => t.id), ['a', 'b', 'c', 'n1', 'n2']);
    assert.deepEqual(plan.toAdd, incoming);
  });
  it('same id and identical content is skipped', () => {
    const plan = planMerge(GOOD, [tx('a'), tx('x', '2026-07-07')]);
    assert.equal(plan.summary.skippedIdentical, 1);
    assert.equal(plan.summary.added, 1);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.merged.length, 4);
  });
  it('restoring the same backup twice is a no-op (idempotent)', () => {
    const once = planMerge(GOOD, GOOD);
    assert.deepEqual(once.merged, GOOD);
    assert.equal(once.summary.skippedIdentical, 3);
    const first = planMerge([], GOOD).merged;
    assert.deepEqual(planMerge(first, GOOD).merged, first);
  });
  it('same id, different content → a conflict; the existing record is kept by default', () => {
    const changed = tx('a', '2026-11-02', { amount: 9_999, description: 'changed' });
    const plan = planMerge(GOOD, [changed]);
    assert.equal(plan.conflictPolicy, 'keep-existing');
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].id, 'a');
    assert.deepEqual(plan.conflicts[0].existing, GOOD[0]);
    assert.deepEqual(plan.conflicts[0].incoming, changed);
    assert.deepEqual(plan.conflicts[0].changedFields, ['amount', 'description', 'date']);
    assert.deepEqual(plan.merged, GOOD);
    assert.equal(plan.summary.conflicts, 1);
    assert.equal(plan.summary.conflictsReplaced, 0);
    assert.equal(plan.summary.added, 0);
  });
  it('conflictPolicy "use-incoming" replaces in place, keeping position and count', () => {
    const changed = tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 1, description: 'Salary' });
    const plan = planMerge(GOOD, [changed], { conflictPolicy: 'use-incoming' });
    assert.deepEqual(plan.merged.map((t) => t.id), ['a', 'b', 'c']);
    assert.deepEqual(plan.merged[1], changed);
    assert.equal(plan.summary.conflictsReplaced, 1);
    assert.equal(plan.summary.resultTotal, 3);
    assert.deepEqual(plan.conflicts[0].changedFields, ['amount']);
  });
  it('each differing field is detected individually', () => {
    const base = tx('k');
    const variants: Array<[Partial<Transaction>, string]> = [
      [{ type: 'income' }, 'type'], [{ amount: 1 }, 'amount'], [{ categoryId: 'dining' }, 'categoryId'],
      [{ description: 'other' }, 'description'], [{ date: '2026-01-01' }, 'date'],
    ];
    for (const [over, field] of variants) {
      const plan = planMerge([base], [{ ...base, ...over }]);
      assert.deepEqual(plan.conflicts[0].changedFields, [field]);
    }
  });
  it('a lookalike with a different id is flagged as a possible duplicate but still added', () => {
    const lookalike = tx('new-id', '2026-11-01', { description: '  ITEM   a ' }); // same as "item a", different spacing/case
    const plan = planMerge(GOOD, [lookalike]);
    assert.deepEqual(plan.possibleDuplicates, [{ incomingId: 'new-id', existingId: 'a' }]);
    assert.equal(plan.summary.possibleDuplicates, 1);
    assert.equal(plan.summary.added, 1);
    assert.equal(plan.merged.length, 4);
  });
  it('any differing field means it is not a lookalike', () => {
    for (const over of [{ amount: 1_251 }, { date: '2026-11-02' }, { categoryId: 'dining' }, { type: 'income' as const }, { description: 'item b' }]) {
      assert.equal(planMerge(GOOD, [tx('new-id', '2026-11-01', over)]).possibleDuplicates.length, 0, JSON.stringify(over));
    }
  });
  it('same-id records are conflicts/skips, never "possible duplicates"', () => {
    const plan = planMerge(GOOD, [tx('a')]);
    assert.equal(plan.possibleDuplicates.length, 0);
  });
  it('mixed scenario: summary numbers add up', () => {
    const incoming = [
      tx('a'),                                  // identical → skip
      tx('b', '2026-10-05', { amount: 5 }),     // conflict
      tx('n1', '2026-06-01'),                   // new
      tx('n2', '2026-11-01', { description: 'Item A' }), // new id, lookalike of "a"
    ];
    const { summary } = planMerge(GOOD, incoming);
    assert.deepEqual(summary, {
      existing: 3, incoming: 4, added: 2, skippedIdentical: 1, conflicts: 1, conflictsReplaced: 0, possibleDuplicates: 1, resultTotal: 5,
    });
    assert.equal(summary.incoming, summary.added + summary.skippedIdentical + summary.conflicts);
  });
  it('never mutates its inputs', () => {
    const existing = structuredClone(GOOD);
    const incoming = [tx('a', '2026-11-02', { amount: 5 }), tx('n1')];
    const incomingCopy = structuredClone(incoming);
    Object.freeze(existing); existing.forEach(Object.freeze);
    Object.freeze(incoming); incoming.forEach(Object.freeze);
    planMerge(existing, incoming, { conflictPolicy: 'use-incoming' });
    assert.deepEqual(existing, GOOD);
    assert.deepEqual(incoming, incomingCopy);
  });
  it('repeated ids in the incoming list throw (the parser already guarantees this cannot happen)', () => {
    assert.throws(() => planMerge(GOOD, [tx('n'), tx('n')]), (e: unknown) => e instanceof BackupError && e.code === 'duplicate-ids');
  });
  it('end to end: parse a backup, then plan the merge against current data', async () => {
    const backup = must(await parse(await createBackupJson([...GOOD, tx('only-in-backup', '2026-05-05')], { now: NOW })));
    const current = [GOOD[0], tx('only-here', '2026-04-04')];
    const plan = planMerge(current, backup.transactions);
    assert.deepEqual(plan.merged.map((t) => t.id), ['a', 'only-here', 'b', 'c', 'only-in-backup']);
    assert.equal(plan.summary.skippedIdentical, 1);
  });
});

// ───────────── misc and scope guards ─────────────

describe('misc and scope', () => {
  it('backup file name uses the local calendar date', () => {
    assert.equal(backupFileName(new Date(2026, 10, 9, 23, 59)), 'smart-expense-tracker-backup-2026-11-09.json');
    assert.equal(backupFileName(new Date(2026, 0, 5, 0, 1)), 'smart-expense-tracker-backup-2026-01-05.json');
  });
  it('backup.ts is pure: no storage, DOM, network or React', () => {
    // Comments are stripped first: the header comment legitimately names what the module avoids.
    const source = readFileSync(new URL('../src/lib/backup.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.|window\.|fetch\(|XMLHttpRequest|from 'react'|\.setItem\(|\.removeItem\(/);
  });
  it('Stage 1 touches no app wiring: provider and reducer do not reference the backup module', () => {
    for (const f of ['state/TransactionsContext.tsx', 'state/transactionsReducer.ts', 'App.tsx', 'lib/storage.ts']) {
      assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /lib\/backup|from '\.\/backup'/, f);
    }
  });
});
