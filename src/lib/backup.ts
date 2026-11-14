import { getCategory } from '@/data/categories';
import { isFutureDate, todayISO } from '@/lib/datePolicy';
import { SCHEMA_VERSION, isTransaction } from '@/lib/storage';
import { MAX_DESCRIPTION_LENGTH } from '@/lib/validation';
import type { Transaction } from '@/types/transaction';

/**
 * Backup & Restore — Phase 4B, Stage 1: the pure logic layer.
 *
 * This module only builds, parses, validates and plans. It never reads or writes localStorage,
 * never touches React, the DOM, the network or the clock (except `todayISO()`/`new Date()` as
 * injectable defaults), and it performs no restore: Stage 2+ decides what to do with its results.
 *
 * Backup file (`backupVersion` 1):
 * ```
 * { format: "smart-expense-tracker-backup", backupVersion, appSchemaVersion, exportedAt,
 *   app: { name, version? }, counts: { transactions }, checksum: { algorithm: "SHA-256", value },
 *   data: { transactions: [...] } }
 * ```
 *  - `backupVersion` versions THIS FILE FORMAT; `appSchemaVersion` is the storage schema
 *    (`SCHEMA_VERSION`) of the records inside. They evolve independently.
 *  - The checksum is SHA-256 (Web Crypto) over the canonical JSON (recursively sorted keys, no
 *    whitespace) of `data`, as written in the file. It detects truncation and accidental edits; it is
 *    NOT protection against deliberate tampering (anyone can recompute it).
 *  - A file that needs a checksum is never accepted without verifying it. If Web Crypto is missing
 *    (`crypto.subtle` is undefined, e.g. on plain http), parsing fails with `crypto-unavailable`.
 *
 * Recognised import formats: the backup file above, the legacy bare array of transactions, and the
 * localStorage envelope `{ schemaVersion, savedAt, transactions }`. The two legacy formats carry no
 * checksum; the result says so (`checksum: 'not-present'`).
 *
 * Strictness: unlike the startup loader (which drops bad records and counts them), an import is
 * all-or-nothing. If ANY record is invalid, has a description longer than the form limit, or repeats
 * an id, the whole file is rejected and nothing is returned. Future-dated records are valid and are
 * preserved exactly like the loader preserves them. Unknown category ids are kept (the UI shows
 * "Uncategorized") and only counted in the report. Records are copied field by field, so unknown
 * extra properties never reach the app.
 *
 * Errors and reports contain counts and positions only — never transaction contents.
 */

export const BACKUP_FORMAT = 'smart-expense-tracker-backup';
/** Version of the backup FILE format written by this app. */
export const BACKUP_VERSION = 1;
export const BACKUP_APP_NAME = 'smart-expense-tracker';
export const CHECKSUM_ALGORITHM = 'SHA-256';
/** Generous upper bound (characters) for a file to be parsed; localStorage itself caps near 5 MB. */
export const MAX_BACKUP_CHARS = 10 * 1024 * 1024;
/** How many offending record positions an error reports. */
export const MAX_REPORTED_INDEXES = 20;

// ───────────────────────────── types ─────────────────────────────

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  backupVersion: number;
  appSchemaVersion: number;
  /** ISO 8601 UTC timestamp. */
  exportedAt: string;
  app: { name: string; version?: string };
  counts: { transactions: number };
  checksum: { algorithm: typeof CHECKSUM_ALGORITHM; value: string };
  data: { transactions: Transaction[] };
}

export type BackupErrorCode =
  | 'too-large'
  | 'empty'
  | 'invalid-json'
  | 'unrecognized-format'
  | 'malformed'
  | 'missing-field'
  | 'unsupported-version'
  | 'migration-failed'
  | 'checksum-missing'
  | 'unsupported-checksum'
  | 'crypto-unavailable'
  | 'checksum-mismatch'
  | 'count-mismatch'
  | 'invalid-transactions'
  | 'duplicate-ids';

export interface BackupErrorDetails {
  /** Records that are not valid transactions (wrong shape, amount, type, date…). */
  invalidRecords?: number;
  /** Records whose description is longer than the allowed limit. */
  descriptionTooLong?: number;
  /** Records repeating an id that appeared earlier in the same file. */
  duplicateIds?: number;
  /** Zero-based positions of the first offending records (at most MAX_REPORTED_INDEXES). */
  indexes?: number[];
}

export interface BackupFailure {
  code: BackupErrorCode;
  /** Plain-language text for the UI. Never contains transaction contents. */
  message: string;
  details?: BackupErrorDetails;
}

/** Thrown by the async helpers that cannot return a result object (checksum and build). */
export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly details?: BackupErrorDetails;
  constructor(code: BackupErrorCode, message: string, details?: BackupErrorDetails) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
  }
}

export type BackupSource = 'backup' | 'legacy-array' | 'storage-envelope';

export interface BackupReport {
  total: number;
  incomeCount: number;
  expenseCount: number;
  /** Dated after `today`; kept, but left out of totals by the date policy. */
  futureDated: number;
  /** Category ids the app doesn't know (shown as "Uncategorized"); kept. */
  unknownCategories: number;
  /** Earliest and latest date among the records, or null for an empty list. */
  dateRange: { from: string; to: string } | null;
}

export interface BackupMeta {
  /** Only for the backup format. */
  backupVersion?: number;
  /** Backup format: `exportedAt`; storage envelope: `savedAt`; bare array: absent. */
  exportedAt?: string;
  /** 'verified' only for the backup format; the legacy formats have none to verify. */
  checksum: 'verified' | 'not-present';
}

export type ParseBackupResult =
  | { ok: true; source: BackupSource; transactions: Transaction[]; report: BackupReport; meta: BackupMeta }
  | { ok: false; error: BackupFailure };

/** The part of SubtleCrypto this module needs (so tests can supply a fake). */
export interface DigestLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** A pure step that upgrades a backup document from version N to N+1. */
export type BackupMigration = (doc: Record<string, unknown>) => Record<string, unknown>;
/** `table[n]` upgrades version n to n + 1. */
export type MigrationTable = Readonly<Record<number, BackupMigration>>;

/**
 * Migrations from older backup versions to the current one. Empty: version 1 is the first format.
 * To introduce version 2: bump BACKUP_VERSION and add `1: (doc) => ({ ...upgraded doc })`. A file is
 * checksum-verified exactly as written (its own version) BEFORE it is migrated.
 */
export const BACKUP_MIGRATIONS: MigrationTable = {};

export interface ParseOptions {
  /** Defaults to the local calendar date; only used to count future-dated records. */
  today?: string;
  /** `undefined` → the global Web Crypto; `null` → treat Web Crypto as unavailable. */
  subtle?: DigestLike | null;
  /** Defaults to BACKUP_MIGRATIONS. */
  migrations?: MigrationTable;
  /** Version to migrate to; defaults to BACKUP_VERSION. */
  targetVersion?: number;
}

export interface BuildOptions {
  now?: Date;
  /** Stored as `app.version` (informational, not covered by the checksum). Omitted when not given. */
  appVersion?: string;
  subtle?: DigestLike | null;
}

// ───────────────────────────── helpers ─────────────────────────────

function fail(code: BackupErrorCode, message: string, details?: BackupErrorDetails): ParseBackupResult {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. Input must be JSON-compatible. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

function resolveSubtle(subtle: DigestLike | null | undefined): DigestLike | null {
  if (subtle !== undefined) return subtle;
  if (typeof globalThis.crypto === 'undefined') return null;
  const candidate = globalThis.crypto.subtle as DigestLike | undefined;
  return candidate ?? null;
}

const CRYPTO_UNAVAILABLE_MESSAGE =
  'This browser can’t compute the SHA-256 checksum (Web Crypto is unavailable — it needs a secure context such as https or localhost). The file was not read, because its integrity can’t be verified.';

/** SHA-256 of the UTF-8 text as lowercase hex. Throws BackupError('crypto-unavailable') — never skips. */
export async function sha256Hex(text: string, subtle?: DigestLike | null): Promise<string> {
  const digestApi = resolveSubtle(subtle);
  if (digestApi === null || typeof digestApi.digest !== 'function') {
    throw new BackupError('crypto-unavailable', CRYPTO_UNAVAILABLE_MESSAGE);
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await digestApi.digest(CHECKSUM_ALGORITHM, new TextEncoder().encode(text));
  } catch {
    throw new BackupError('crypto-unavailable', CRYPTO_UNAVAILABLE_MESSAGE);
  }
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Checksum of a backup's `data` section: SHA-256 over its canonical JSON. */
export async function computeChecksum(data: unknown, subtle?: DigestLike | null): Promise<string> {
  return sha256Hex(canonicalJson(data), subtle);
}

// ───────────────────────────── record validation ─────────────────────────────

interface RecordCheck {
  transactions: Transaction[];
  invalidRecords: number;
  descriptionTooLong: number;
  duplicateIds: number;
  indexes: number[];
}

/** Strict, non-dropping check: counts every problem, returns clean copies of the good records. */
function checkRecords(items: readonly unknown[]): RecordCheck {
  const seen = new Set<string>();
  const result: RecordCheck = { transactions: [], invalidRecords: 0, descriptionTooLong: 0, duplicateIds: 0, indexes: [] };
  const flag = (index: number): void => {
    if (result.indexes.length < MAX_REPORTED_INDEXES) result.indexes.push(index);
  };
  items.forEach((item, index) => {
    if (!isTransaction(item)) {
      result.invalidRecords += 1;
      flag(index);
    } else if (item.description.length > MAX_DESCRIPTION_LENGTH) {
      result.descriptionTooLong += 1;
      flag(index);
    } else if (seen.has(item.id)) {
      result.duplicateIds += 1;
      flag(index);
    } else {
      seen.add(item.id);
      // Copied field by field: unknown properties never pass through, valid values are never altered.
      result.transactions.push({
        id: item.id,
        type: item.type,
        amount: item.amount,
        categoryId: item.categoryId,
        description: item.description,
        date: item.date,
      });
    }
  });
  return result;
}

function recordFailure(check: RecordCheck): BackupFailure {
  const details: BackupErrorDetails = { indexes: check.indexes };
  if (check.invalidRecords > 0) details.invalidRecords = check.invalidRecords;
  if (check.descriptionTooLong > 0) details.descriptionTooLong = check.descriptionTooLong;
  if (check.duplicateIds > 0) details.duplicateIds = check.duplicateIds;

  if (check.invalidRecords > 0 || check.descriptionTooLong > 0) {
    const bad = check.invalidRecords + check.descriptionTooLong;
    const parts = [`${bad} transaction${bad === 1 ? ' is' : 's are'} invalid`];
    if (check.descriptionTooLong > 0) {
      parts.push(`${check.descriptionTooLong} of them with a description over ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    if (check.duplicateIds > 0) parts.push(`${check.duplicateIds} more repeat${check.duplicateIds === 1 ? 's' : ''} an id`);
    return {
      code: 'invalid-transactions',
      message: `The file was rejected: ${parts.join(', ')}. Nothing was imported.`,
      details,
    };
  }
  return {
    code: 'duplicate-ids',
    message: `The file was rejected: ${check.duplicateIds} transaction${check.duplicateIds === 1 ? '' : 's'} repeat${check.duplicateIds === 1 ? 's' : ''} an id used earlier in the file. Nothing was imported.`,
    details,
  };
}

/** Summary of already-validated records. `today` is injectable. */
export function buildReport(transactions: readonly Transaction[], today: string = todayISO()): BackupReport {
  let from: string | null = null;
  let to: string | null = null;
  let futureDated = 0;
  let unknownCategories = 0;
  let incomeCount = 0;
  for (const t of transactions) {
    if (from === null || t.date < from) from = t.date;
    if (to === null || t.date > to) to = t.date;
    if (isFutureDate(t.date, today)) futureDated += 1;
    if (getCategory(t.categoryId).id === 'unknown') unknownCategories += 1;
    if (t.type === 'income') incomeCount += 1;
  }
  return {
    total: transactions.length,
    incomeCount,
    expenseCount: transactions.length - incomeCount,
    futureDated,
    unknownCategories,
    dateRange: from !== null && to !== null ? { from, to } : null,
  };
}

// ───────────────────────────── building ─────────────────────────────

/** `smart-expense-tracker-backup-YYYY-MM-DD.json`, using the local calendar date. */
export function backupFileName(now: Date = new Date()): string {
  return `${BACKUP_APP_NAME}-backup-${todayISO(now)}.json`;
}

/**
 * Builds a backup document from the app's transactions. Refuses (throws BackupError) when the list
 * could not be restored later — an invalid record, a description over the limit or a repeated id —
 * so a file that would be rejected on import is never produced. Throws 'crypto-unavailable' when
 * Web Crypto is missing. Does not mutate its input.
 */
export async function buildBackup(transactions: readonly Transaction[], options: BuildOptions = {}): Promise<BackupFile> {
  const check = checkRecords(transactions);
  if (check.invalidRecords > 0 || check.descriptionTooLong > 0 || check.duplicateIds > 0) {
    const failure = recordFailure(check);
    throw new BackupError(failure.code, failure.message.replace('The file was rejected', 'The backup can’t be created'), failure.details);
  }
  const data = { transactions: check.transactions };
  const value = await computeChecksum(data, options.subtle);
  const app: BackupFile['app'] =
    options.appVersion === undefined ? { name: BACKUP_APP_NAME } : { name: BACKUP_APP_NAME, version: options.appVersion };
  return {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    appSchemaVersion: SCHEMA_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    app,
    counts: { transactions: check.transactions.length },
    checksum: { algorithm: CHECKSUM_ALGORITHM, value },
    data,
  };
}

/** Pretty-printed JSON text of a backup, ready to be saved as a file. */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Convenience: build + serialize. */
export async function createBackupJson(transactions: readonly Transaction[], options: BuildOptions = {}): Promise<string> {
  return serializeBackup(await buildBackup(transactions, options));
}

// ───────────────────────────── migration ─────────────────────────────

type MigrationResult = { ok: true; doc: Record<string, unknown> } | { ok: false; error: BackupFailure };

/** Applies `table[from]`, `table[from + 1]`, … until `target` is reached. Pure; never mutates `doc`. */
export function migrateBackupDocument(
  doc: Record<string, unknown>,
  from: number,
  target: number = BACKUP_VERSION,
  table: MigrationTable = BACKUP_MIGRATIONS,
): MigrationResult {
  let current = doc;
  for (let version = from; version < target; version++) {
    const step = table[version];
    if (typeof step !== 'function') {
      return {
        ok: false,
        error: { code: 'unsupported-version', message: `This backup (version ${from}) can’t be upgraded to the version this app reads (${target}).` },
      };
    }
    try {
      const next = step(current);
      if (!isRecord(next)) throw new Error('migration returned a non-object');
      current = next;
    } catch {
      return {
        ok: false,
        error: { code: 'migration-failed', message: `Upgrading this backup from version ${version} to ${version + 1} failed. Nothing was imported.` },
      };
    }
  }
  return { ok: true, doc: current };
}

// ───────────────────────────── parsing ─────────────────────────────

const REQUIRED_BACKUP_FIELDS = ['backupVersion', 'appSchemaVersion', 'exportedAt', 'counts', 'data'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

function finish(
  source: BackupSource,
  items: readonly unknown[],
  meta: BackupMeta,
  today: string,
): ParseBackupResult {
  const check = checkRecords(items);
  if (check.invalidRecords > 0 || check.descriptionTooLong > 0 || check.duplicateIds > 0) {
    return { ok: false, error: recordFailure(check) };
  }
  return { ok: true, source, transactions: check.transactions, report: buildReport(check.transactions, today), meta };
}

function parseStorageEnvelope(doc: Record<string, unknown>, today: string): ParseBackupResult {
  if (typeof doc.schemaVersion !== 'number' || !Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) {
    return fail('malformed', 'The file’s schemaVersion is not a valid version number.');
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return fail(
      'unsupported-version',
      `This data uses storage schema version ${doc.schemaVersion}, but this app reads version ${SCHEMA_VERSION}.`,
    );
  }
  if (doc.savedAt === undefined) return fail('missing-field', 'The file is missing “savedAt”.');
  if (doc.transactions === undefined) return fail('missing-field', 'The file is missing “transactions”.');
  if (typeof doc.savedAt !== 'string') return fail('malformed', '“savedAt” must be text.');
  if (!Array.isArray(doc.transactions)) return fail('malformed', '“transactions” must be a list.');
  return finish('storage-envelope', doc.transactions, { exportedAt: doc.savedAt, checksum: 'not-present' }, today);
}

async function parseBackupDocument(doc: Record<string, unknown>, options: ParseOptions, today: string): Promise<ParseBackupResult> {
  for (const field of REQUIRED_BACKUP_FIELDS) {
    if (doc[field] === undefined) return fail('missing-field', `The backup is missing “${field}”.`);
  }
  if (doc.checksum === undefined) {
    return fail('checksum-missing', 'The backup has no checksum, so its integrity can’t be verified. It was not read.');
  }

  const { backupVersion, appSchemaVersion, exportedAt, counts, checksum, data } = doc;
  if (!isPositiveInteger(backupVersion)) return fail('malformed', '“backupVersion” is not a valid version number.');
  if (!isPositiveInteger(appSchemaVersion)) return fail('malformed', '“appSchemaVersion” is not a valid version number.');
  if (typeof exportedAt !== 'string' || Number.isNaN(Date.parse(exportedAt))) {
    return fail('malformed', '“exportedAt” is not a valid date and time.');
  }
  if (!isRecord(counts) || typeof counts.transactions !== 'number' || !Number.isInteger(counts.transactions) || counts.transactions < 0) {
    return fail('malformed', '“counts” is not valid.');
  }
  if (!isRecord(checksum) || typeof checksum.algorithm !== 'string' || typeof checksum.value !== 'string') {
    return fail('malformed', '“checksum” is not valid.');
  }
  if (!isRecord(data) || !Array.isArray(data.transactions)) {
    return fail('malformed', '“data.transactions” must be a list.');
  }

  const target = options.targetVersion ?? BACKUP_VERSION;
  if (backupVersion > target) {
    return fail(
      'unsupported-version',
      `This backup uses file format version ${backupVersion}, newer than the version ${target} this app reads. Update the app to import it.`,
    );
  }
  if (appSchemaVersion > SCHEMA_VERSION) {
    return fail(
      'unsupported-version',
      `This backup holds data from a newer storage schema (${appSchemaVersion}); this app reads version ${SCHEMA_VERSION}.`,
    );
  }

  if (checksum.algorithm !== CHECKSUM_ALGORITHM) {
    return fail('unsupported-checksum', `The backup uses an unsupported checksum algorithm (“${checksum.algorithm.slice(0, 20)}”).`);
  }
  if (!SHA256_HEX.test(checksum.value)) return fail('malformed', 'The checksum value is not a valid SHA-256 hash.');

  // Integrity is verified on the file exactly as written, before any migration. Never skipped.
  let actual: string;
  try {
    actual = await computeChecksum(data, options.subtle);
  } catch (error) {
    if (error instanceof BackupError) return fail(error.code, error.message);
    throw error;
  }
  if (actual !== checksum.value.toLowerCase()) {
    return fail('checksum-mismatch', 'The checksum doesn’t match: the file is damaged or was edited after it was exported. Nothing was imported.');
  }
  if (counts.transactions !== data.transactions.length) {
    return fail(
      'count-mismatch',
      `The file says it holds ${counts.transactions} transactions but contains ${data.transactions.length}. Nothing was imported.`,
    );
  }

  const migrated = migrateBackupDocument(doc, backupVersion, target, options.migrations ?? BACKUP_MIGRATIONS);
  if (!migrated.ok) return { ok: false, error: migrated.error };
  const migratedData = migrated.doc.data;
  if (!isRecord(migratedData) || !Array.isArray(migratedData.transactions)) {
    return fail('migration-failed', 'Upgrading this backup produced unusable data. Nothing was imported.');
  }

  return finish('backup', migratedData.transactions, { backupVersion, exportedAt, checksum: 'verified' }, today);
}

/**
 * Reads the text of a file the user chose and decides what it is. Pure: no storage, no side effects.
 * Returns the validated transactions plus a report, or a failure with a plain-language message.
 * Never throws for bad input.
 */
export async function parseBackup(raw: string, options: ParseOptions = {}): Promise<ParseBackupResult> {
  const today = options.today ?? todayISO();
  if (raw.length > MAX_BACKUP_CHARS) {
    return fail('too-large', 'The file is too large to be a backup of this app.');
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.trim() === '') return fail('empty', 'The file is empty.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('invalid-json', 'The file isn’t valid JSON, so it can’t be a backup of this app.');
  }

  if (Array.isArray(parsed)) return finish('legacy-array', parsed, { checksum: 'not-present' }, today);

  if (isRecord(parsed)) {
    if ('format' in parsed) {
      if (parsed.format === BACKUP_FORMAT) return parseBackupDocument(parsed, options, today);
      return fail('unrecognized-format', 'This file isn’t a Smart Expense Tracker backup.');
    }
    if (parsed.schemaVersion !== undefined) return parseStorageEnvelope(parsed, today);
  }
  return fail('unrecognized-format', 'This file isn’t a Smart Expense Tracker backup or a recognised data export.');
}

// ───────────────────────────── merge planning ─────────────────────────────

export type ConflictPolicy = 'keep-existing' | 'use-incoming';

export interface MergeConflict {
  id: string;
  existing: Transaction;
  incoming: Transaction;
  /** Which fields differ. */
  changedFields: (keyof Transaction)[];
}

export interface PossibleDuplicate {
  incomingId: string;
  existingId: string;
}

export interface MergePlan {
  conflictPolicy: ConflictPolicy;
  /** The list after the merge: existing order kept, new records appended in file order. */
  merged: Transaction[];
  /** Records from the file whose id is new. */
  toAdd: Transaction[];
  /** Same id, different content. Resolved per `conflictPolicy` (default: the existing record is kept). */
  conflicts: MergeConflict[];
  /** New records that look like an existing one under a different id. A WARNING only: they are still added. */
  possibleDuplicates: PossibleDuplicate[];
  summary: {
    existing: number;
    incoming: number;
    added: number;
    /** Same id and identical content: nothing to do. */
    skippedIdentical: number;
    conflicts: number;
    /** Conflicts where the incoming version replaced the existing one. */
    conflictsReplaced: number;
    possibleDuplicates: number;
    resultTotal: number;
  };
}

const FIELDS: readonly (keyof Transaction)[] = ['type', 'amount', 'categoryId', 'description', 'date'];

function changedFields(a: Transaction, b: Transaction): (keyof Transaction)[] {
  return FIELDS.filter((field) => a[field] !== b[field]);
}

/** Heuristic key for "looks like the same purchase": ignores id, case and spacing of the description. */
function fingerprint(t: Transaction): string {
  const description = t.description.trim().replace(/\s+/g, ' ').toLowerCase();
  return JSON.stringify([t.type, t.amount, t.categoryId, t.date, description]);
}

/**
 * Plans a merge of validated `incoming` records into `existing`, without changing either list.
 *  - new id → added;
 *  - same id, identical content → skipped (this is what makes restoring the same backup twice a no-op);
 *  - same id, different content → a conflict; by default the existing record wins;
 *  - different id but same type/amount/category/date/description → reported in `possibleDuplicates`
 *    and still added, because two identical purchases on one day are legitimate.
 * `incoming` must already have passed `parseBackup` (unique ids); a repeated id throws.
 */
export function planMerge(
  existing: readonly Transaction[],
  incoming: readonly Transaction[],
  options: { conflictPolicy?: ConflictPolicy } = {},
): MergePlan {
  const conflictPolicy = options.conflictPolicy ?? 'keep-existing';

  const incomingIds = new Set<string>();
  for (const t of incoming) {
    if (incomingIds.has(t.id)) throw new BackupError('duplicate-ids', 'The records to merge repeat an id.');
    incomingIds.add(t.id);
  }

  const existingById = new Map<string, Transaction>();
  const existingByFingerprint = new Map<string, string>();
  for (const t of existing) {
    if (!existingById.has(t.id)) existingById.set(t.id, t);
    const key = fingerprint(t);
    if (!existingByFingerprint.has(key)) existingByFingerprint.set(key, t.id);
  }

  const toAdd: Transaction[] = [];
  const conflicts: MergeConflict[] = [];
  const possibleDuplicates: PossibleDuplicate[] = [];
  const replacements = new Map<string, Transaction>();
  let skippedIdentical = 0;

  for (const record of incoming) {
    const match = existingById.get(record.id);
    if (match === undefined) {
      toAdd.push(record);
      const lookalike = existingByFingerprint.get(fingerprint(record));
      if (lookalike !== undefined) possibleDuplicates.push({ incomingId: record.id, existingId: lookalike });
      continue;
    }
    const fields = changedFields(match, record);
    if (fields.length === 0) {
      skippedIdentical += 1;
    } else {
      conflicts.push({ id: record.id, existing: match, incoming: record, changedFields: fields });
      if (conflictPolicy === 'use-incoming') replacements.set(record.id, record);
    }
  }

  const merged = [...existing.map((t) => replacements.get(t.id) ?? t), ...toAdd];
  return {
    conflictPolicy,
    merged,
    toAdd,
    conflicts,
    possibleDuplicates,
    summary: {
      existing: existing.length,
      incoming: incoming.length,
      added: toAdd.length,
      skippedIdentical,
      conflicts: conflicts.length,
      conflictsReplaced: replacements.size,
      possibleDuplicates: possibleDuplicates.length,
      resultTotal: merged.length,
    },
  };
}
