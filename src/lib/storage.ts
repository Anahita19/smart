import { MAX_AMOUNT_CENTS, MAX_DESCRIPTION_LENGTH } from '@/lib/validation';
import { parseISODate } from '@/lib/format';
import type { Transaction } from '@/types/transaction';

/**
 * Local persistence with data-safety rules (Phase 4A). No React in here, so every rule is testable.
 *
 * Storage outcomes — a read is never a guess:
 *  - `empty`       nothing is stored: a genuine first run. The app starts with an empty list.
 *  - `ok`          valid data was loaded (legacy bare array or versioned envelope).
 *  - `corrupt`     something is stored but cannot be trusted (unparseable, malformed, unsupported version).
 *  - `unavailable` storage could not be read at all (blocked, throws).
 * `corrupt` and `unavailable` are never treated as a first run, and demo data is never seeded.
 *
 * Protection rules:
 *  - Before anything unreadable or invalid is replaced or pruned, the ORIGINAL raw string is copied
 *    to a separate recovery entry (see `preserveRawCopy`) and the copy is read back to verify it.
 *    If that fails, saving is blocked for the session so the original is never overwritten.
 *  - A payload written by a newer app version (unsupported `schemaVersion`) is left completely
 *    untouched and saving is blocked.
 *  - Every save compares the stored value with what this tab last read or wrote. If another tab
 *    changed it, the save is refused and the newer data is adopted instead (see `StorageSession`).
 *
 * Restore (Phase 4B, Stage 2 — storage layer only, no UI): `StorageSession.restore` merges or
 * replaces the stored list with already-parsed records. Order of operations, each step guarded:
 *  1. refuse when saving is blocked, the input is invalid, or storage changed since this tab last looked;
 *  2. a SNAPSHOT (byte-for-byte copy of the current stored value, own key prefix, never overwritten)
 *     is written and read back; if that fails nothing else happens and nothing is deleted;
 *  3. the new list is persisted, read back and compared with what was intended;
 *  4. only after full success are snapshots beyond MAX_SNAPSHOTS removed (oldest first, never the new
 *     one) — recovery copies are never touched (different prefix, different code path);
 *  5. on a persist/verify failure the previous value is put back, but only while storage still holds
 *     exactly what this restore wrote (another tab's data is never overwritten).
 * localStorage offers no compare-and-swap, so steps 1–3 narrow a cross-tab race window but cannot
 * close it; see `StorageSession.restore`.
 */

/** Versioned key so a future data-shape change can migrate instead of crash. Unchanged since Phase 2. */
export const STORAGE_KEY = 'smart-expense-tracker:v1:transactions';
/** Recovery copies are stored as `<prefix><time>-<random>`; the key is never reused. */
export const RECOVERY_KEY_PREFIX = 'smart-expense-tracker:v1:recovery:';
/** Version of the envelope written by this app. */
export const SCHEMA_VERSION = 1;

/** The new write format: `{ schemaVersion, savedAt, transactions }`. The legacy format is a bare array. */
export interface StorageEnvelope {
  schemaVersion: number;
  savedAt: string;
  transactions: Transaction[];
}

/** The subset of the Web Storage API this module needs (so tests can supply a fake). */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional so minimal stand-ins keep working; without it, snapshot pruning is skipped (never an error). */
  removeItem?(key: string): void;
}

/** `window.localStorage`, or null when the browser blocks access to it. */
export function getBrowserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

// ───────────────────────────── parsing and validation ─────────────────────────────

export function isTransaction(value: unknown): value is Transaction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id !== '' &&
    (v.type === 'income' || v.type === 'expense') &&
    typeof v.amount === 'number' &&
    Number.isSafeInteger(v.amount) &&
    v.amount > 0 &&
    v.amount <= MAX_AMOUNT_CENTS &&
    typeof v.categoryId === 'string' &&
    typeof v.description === 'string' &&
    typeof v.date === 'string' &&
    parseISODate(v.date) !== null
  );
}

export type CorruptReason = 'unparseable' | 'malformed' | 'unsupported-version';

export type ParsedPayload =
  | { status: 'ok'; format: 'legacy' | 'envelope'; transactions: Transaction[]; accepted: number; invalid: number }
  | { status: 'corrupt'; reason: CorruptReason };

/** Keeps valid, unique-id records exactly as stored (values are never altered); counts the rest. */
function validateRecords(items: readonly unknown[]): { transactions: Transaction[]; invalid: number } {
  const seen = new Set<string>();
  const transactions: Transaction[] = [];
  for (const item of items) {
    // Unknown category ids are kept (the UI shows "Uncategorized"); future-dated records are kept too.
    if (isTransaction(item) && !seen.has(item.id)) {
      seen.add(item.id);
      transactions.push({
        id: item.id,
        type: item.type,
        amount: item.amount,
        categoryId: item.categoryId,
        description: item.description,
        date: item.date,
      });
    }
  }
  return { transactions, invalid: items.length - transactions.length };
}

/** Interprets a raw stored string. Pure: reads nothing, writes nothing. */
export function parseStoredPayload(raw: string): ParsedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', reason: 'unparseable' };
  }

  if (Array.isArray(parsed)) {
    const { transactions, invalid } = validateRecords(parsed);
    return { status: 'ok', format: 'legacy', transactions, accepted: transactions.length, invalid };
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.schemaVersion !== 'number' || !Number.isInteger(envelope.schemaVersion)) {
      return { status: 'corrupt', reason: 'malformed' };
    }
    // Another version's data is never interpreted or rewritten by this one.
    if (envelope.schemaVersion !== SCHEMA_VERSION) return { status: 'corrupt', reason: 'unsupported-version' };
    if (typeof envelope.savedAt !== 'string' || !Array.isArray(envelope.transactions)) {
      return { status: 'corrupt', reason: 'malformed' };
    }
    const { transactions, invalid } = validateRecords(envelope.transactions);
    return { status: 'ok', format: 'envelope', transactions, accepted: transactions.length, invalid };
  }

  return { status: 'corrupt', reason: 'malformed' };
}

export function serializeEnvelope(transactions: readonly Transaction[], now: Date = new Date()): string {
  const envelope: StorageEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: now.toISOString(),
    transactions: [...transactions],
  };
  return JSON.stringify(envelope);
}

// ───────────────────────────── recovery copies ─────────────────────────────

export type RecoveryResult = { ok: true; key: string; reused: boolean } | { ok: false };

/**
 * Copies `raw` byte-for-byte to a NEW key `RECOVERY_KEY_PREFIX + <time>-<random>` and reads it back
 * to confirm. Existing entries are never overwritten: a candidate key is only used if nothing is
 * stored under it. If an identical copy already exists (e.g. the app started twice on the same
 * damaged data, as React StrictMode does in development) that copy is reused, so repeated starts
 * don't pile up duplicates. Returns `{ ok: false }` on any failure; the caller must then not
 * replace or prune the original.
 */
export function preserveRawCopy(store: StorageLike, raw: string, now: () => number = Date.now): RecoveryResult {
  try {
    for (let i = 0; i < store.length; i++) {
      const existingKey = store.key(i);
      if (existingKey !== null && existingKey.startsWith(RECOVERY_KEY_PREFIX) && store.getItem(existingKey) === raw) {
        return { ok: true, key: existingKey, reused: true };
      }
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const key = `${RECOVERY_KEY_PREFIX}${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      if (store.getItem(key) !== null) continue; // taken: pick another, never overwrite
      store.setItem(key, raw);
      return store.getItem(key) === raw ? { ok: true, key, reused: false } : { ok: false };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ───────────────────────────── notices (no raw data, no stack traces) ─────────────────────────────

export type NoticeKind =
  | 'unavailable'
  | 'corrupt'
  | 'unsupported-version'
  | 'invalid-records'
  | 'external-update'
  | 'conflict'
  | 'external-unreadable'
  | 'removed-elsewhere'
  | 'restored'
  | 'restore-incomplete';

export interface StorageNotice {
  kind: NoticeKind;
  /** Plain-language text for the UI. Contains counts at most — never transaction contents. */
  message: string;
}

const SAVING_PAUSED = 'Saving is paused so the original content isn’t overwritten.';

function bootNotice(prepared: Pick<OpenResult, 'status' | 'reason' | 'accepted' | 'invalid' | 'recovery'>): StorageNotice | null {
  const preserved = prepared.recovery?.ok === true;
  switch (prepared.status) {
    case 'unavailable':
      return {
        kind: 'unavailable',
        message:
          'Your saved data couldn’t be read from this browser, so nothing is shown. Changes made now won’t be saved, to avoid overwriting data that may still exist.',
      };
    case 'corrupt':
      if (prepared.reason === 'unsupported-version') {
        return {
          kind: 'unsupported-version',
          message: `Your saved data was written by a newer version of this app. It has been left untouched. ${SAVING_PAUSED}`,
        };
      }
      return {
        kind: 'corrupt',
        message: preserved
          ? 'Your saved data couldn’t be read. The original content was preserved in a recovery copy in this browser, and the app has started with an empty list.'
          : `Your saved data couldn’t be read, and a recovery copy couldn’t be made. ${SAVING_PAUSED}`,
      };
    case 'ok':
      if (prepared.invalid === 0) return null;
      return {
        kind: 'invalid-records',
        message: preserved
          ? `${prepared.invalid} of ${prepared.accepted + prepared.invalid} saved records were invalid and are not shown. The original data was preserved in a recovery copy in this browser.`
          : `${prepared.invalid} of ${prepared.accepted + prepared.invalid} saved records were invalid and are not shown, and a recovery copy couldn’t be made. ${SAVING_PAUSED}`,
      };
    default:
      return null;
  }
}

// ───────────────────────────── reading ─────────────────────────────

export interface Prepared {
  status: 'ok' | 'corrupt';
  reason?: CorruptReason;
  format?: 'legacy' | 'envelope';
  /** Valid records only; empty for corrupt payloads. */
  transactions: Transaction[];
  accepted: number;
  invalid: number;
  /** Set when saving must not happen (see StorageSession). */
  saveBlocked: SaveBlockReason | null;
  recovery: RecoveryResult | null;
}

export type SaveBlockReason =
  | 'unavailable'
  | 'unsupported-version'
  | 'backup-failed'
  | 'removed-elsewhere'
  /** A restore could not be completed or undone cleanly; saving stays paused until storage is re-read. */
  | 'restore-incomplete';

/** Parses `raw` and, if anything in it would be dropped or replaced, preserves the original first. */
function prepare(store: StorageLike, raw: string, now: () => number): Prepared {
  const parsed = parseStoredPayload(raw);

  if (parsed.status === 'corrupt') {
    if (parsed.reason === 'unsupported-version') {
      // Nothing will be replaced, so no copy is needed; saving is blocked instead.
      return { status: 'corrupt', reason: parsed.reason, transactions: [], accepted: 0, invalid: 0, saveBlocked: 'unsupported-version', recovery: null };
    }
    const recovery = preserveRawCopy(store, raw, now);
    return { status: 'corrupt', reason: parsed.reason, transactions: [], accepted: 0, invalid: 0, saveBlocked: recovery.ok ? null : 'backup-failed', recovery };
  }

  if (parsed.invalid > 0) {
    const recovery = preserveRawCopy(store, raw, now);
    return { status: 'ok', format: parsed.format, transactions: parsed.transactions, accepted: parsed.accepted, invalid: parsed.invalid, saveBlocked: recovery.ok ? null : 'backup-failed', recovery };
  }

  return { status: 'ok', format: parsed.format, transactions: parsed.transactions, accepted: parsed.accepted, invalid: 0, saveBlocked: null, recovery: null };
}

export interface OpenResult {
  /** ok | empty | corrupt | unavailable */
  status: 'ok' | 'empty' | 'corrupt' | 'unavailable';
  reason?: CorruptReason;
  format?: 'legacy' | 'envelope';
  /** What the app starts with: stored valid records, or an empty list. Never demo data. */
  transactions: Transaction[];
  accepted: number;
  invalid: number;
  saveBlocked: SaveBlockReason | null;
  recovery: RecoveryResult | null;
  notice: StorageNotice | null;
}

// ───────────────────────────── snapshots ─────────────────────────────

/** Snapshots are stored as `<prefix><time>-<random>`. Distinct from RECOVERY_KEY_PREFIX and STORAGE_KEY. */
export const SNAPSHOT_KEY_PREFIX = 'smart-expense-tracker:v1:snapshot:';
/** How many snapshots are kept after a fully successful restore. */
export const MAX_SNAPSHOTS = 5;

function snapshotTime(key: string): number {
  const stamp = key.slice(SNAPSHOT_KEY_PREFIX.length).split('-')[0] ?? '';
  const value = Number.parseInt(stamp, 36);
  return Number.isFinite(value) ? value : 0;
}

/** Snapshot keys, oldest first (by embedded time, then by key). Returns null if storage can't be listed. */
export function listSnapshotKeys(store: StorageLike): string[] | null {
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(SNAPSHOT_KEY_PREFIX)) keys.push(key);
    }
    return keys.sort((a, b) => snapshotTime(a) - snapshotTime(b) || (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return null;
  }
}

type SnapshotResult = { ok: true; key: string } | { ok: false; stage: 'snapshot-write' | 'snapshot-verify' };

/** Removes a key THIS call created and could not verify. Never used on any other key. */
function discardOwnAttempt(store: StorageLike, key: string): void {
  try {
    if (typeof store.removeItem === 'function' && store.getItem(key) !== null) store.removeItem(key);
  } catch {
    /* best effort: a leftover unverified attempt is harmless and is pruned like any snapshot */
  }
}

/**
 * Copies `raw` byte-for-byte to a NEW snapshot key and reads it back. A key is only used if nothing is
 * stored under it; an existing snapshot is never overwritten or reused, and none is deleted here.
 */
function createSnapshot(store: StorageLike, raw: string, now: () => number): SnapshotResult {
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = `${SNAPSHOT_KEY_PREFIX}${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (store.getItem(key) !== null) continue; // taken: pick another, never overwrite
    } catch {
      return { ok: false, stage: 'snapshot-write' };
    }
    try {
      store.setItem(key, raw);
    } catch {
      discardOwnAttempt(store, key);
      return { ok: false, stage: 'snapshot-write' };
    }
    let back: string | null;
    try {
      back = store.getItem(key);
    } catch {
      return { ok: false, stage: 'snapshot-verify' };
    }
    if (back === raw) return { ok: true, key };
    discardOwnAttempt(store, key);
    return { ok: false, stage: 'snapshot-verify' };
  }
  return { ok: false, stage: 'snapshot-write' };
}

/**
 * Keeps the newest MAX_SNAPSHOTS snapshots INCLUDING `keepKey`, which is never removed whatever its
 * timestamp says (the clock may have gone backwards). Only snapshot keys are considered. Called only
 * after a restore has fully succeeded. Failures leave extra snapshots in place and are reported.
 */
function pruneSnapshots(store: StorageLike, keepKey: string): { pruned: number; incomplete: boolean } {
  const keys = listSnapshotKeys(store);
  if (keys === null) return { pruned: 0, incomplete: true };
  const others = keys.filter((key) => key !== keepKey);
  const surplus = others.length - (MAX_SNAPSHOTS - 1);
  if (surplus <= 0) return { pruned: 0, incomplete: false };
  if (typeof store.removeItem !== 'function') return { pruned: 0, incomplete: true };
  let pruned = 0;
  let incomplete = false;
  for (const key of others.slice(0, surplus)) {
    try {
      store.removeItem(key);
      if (store.getItem(key) === null) pruned += 1;
      else incomplete = true;
    } catch {
      incomplete = true;
    }
  }
  return { pruned, incomplete };
}

// ───────────────────────────── restore: validation and merge planning ─────────────────────────────

export type RestoreConflictPolicy = 'keep-existing' | 'use-incoming';

export interface RestoreMergeConflict {
  id: string;
  existing: Transaction;
  incoming: Transaction;
  changedFields: (keyof Transaction)[];
}

export interface RestorePossibleDuplicate {
  incomingId: string;
  existingId: string;
}

/** Same shape and meaning as the backup module's merge plan; a test keeps the two in lockstep. */
export interface RestoreMergePlan {
  conflictPolicy: RestoreConflictPolicy;
  merged: Transaction[];
  toAdd: Transaction[];
  conflicts: RestoreMergeConflict[];
  possibleDuplicates: RestorePossibleDuplicate[];
  summary: {
    existing: number;
    incoming: number;
    added: number;
    skippedIdentical: number;
    conflicts: number;
    conflictsReplaced: number;
    possibleDuplicates: number;
    resultTotal: number;
  };
}

const MERGE_FIELDS: readonly (keyof Transaction)[] = ['type', 'amount', 'categoryId', 'description', 'date'];

function changedFields(a: Transaction, b: Transaction): (keyof Transaction)[] {
  return MERGE_FIELDS.filter((field) => a[field] !== b[field]);
}

/** Heuristic key for "looks like the same purchase": ignores id, case and spacing of the description. */
function fingerprint(t: Transaction): string {
  const description = t.description.trim().replace(/\s+/g, ' ').toLowerCase();
  return JSON.stringify([t.type, t.amount, t.categoryId, t.date, description]);
}

/**
 * Plans a merge of validated `incoming` records into `existing` without changing either list.
 *  - new id → added (existing order kept, new records appended in input order);
 *  - same id, identical content → skipped (restoring the same data twice is a no-op);
 *  - same id, different content → a conflict; by default the existing record wins;
 *  - different id but same type/amount/category/date/description → reported, still added.
 * Future-dated records are ordinary records here: nothing is filtered by date.
 * `incoming` must have unique ids (the restore validates that first); a repeated id throws.
 * Deliberately self-contained: this module does not depend on the backup module.
 */
export function planRestoreMerge(
  existing: readonly Transaction[],
  incoming: readonly Transaction[],
  options: { conflictPolicy?: RestoreConflictPolicy } = {},
): RestoreMergePlan {
  const conflictPolicy = options.conflictPolicy ?? 'keep-existing';

  const incomingIds = new Set<string>();
  for (const t of incoming) {
    if (incomingIds.has(t.id)) throw new Error('The records to merge repeat an id.');
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
  const conflicts: RestoreMergeConflict[] = [];
  const possibleDuplicates: RestorePossibleDuplicate[] = [];
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

export interface IncomingProblems {
  invalidRecords: number;
  descriptionTooLong: number;
  duplicateIds: number;
}

/**
 * All-or-nothing check of the records a restore is asked to write: every record valid, description
 * within the form limit, ids unique. Returns clean copies (known fields only, values unaltered).
 * Counts only — never transaction contents.
 */
export function validateIncoming(
  items: unknown,
): { ok: true; transactions: Transaction[] } | ({ ok: false } & IncomingProblems) {
  if (!Array.isArray(items)) return { ok: false, invalidRecords: 1, descriptionTooLong: 0, duplicateIds: 0 };
  const seen = new Set<string>();
  const transactions: Transaction[] = [];
  const problems: IncomingProblems = { invalidRecords: 0, descriptionTooLong: 0, duplicateIds: 0 };
  for (const item of items as unknown[]) {
    if (!isTransaction(item)) problems.invalidRecords += 1;
    else if (item.description.length > MAX_DESCRIPTION_LENGTH) problems.descriptionTooLong += 1;
    else if (seen.has(item.id)) problems.duplicateIds += 1;
    else {
      seen.add(item.id);
      transactions.push({
        id: item.id,
        type: item.type,
        amount: item.amount,
        categoryId: item.categoryId,
        description: item.description,
        date: item.date,
      });
    }
  }
  if (problems.invalidRecords + problems.descriptionTooLong + problems.duplicateIds > 0) return { ok: false, ...problems };
  return { ok: true, transactions };
}

function sameTransactions(a: readonly Transaction[], b: readonly Transaction[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const o = b[i]!;
    return t.id === o.id && t.type === o.type && t.amount === o.amount && t.categoryId === o.categoryId && t.description === o.description && t.date === o.date;
  });
}

// ───────────────────────────── restore: request and outcome ─────────────────────────────

export type RestoreMode = 'merge' | 'replace';

export interface RestoreRequest {
  mode: RestoreMode;
  /** Records that already passed the backup parser (or any equivalent validation; it is re-checked here). */
  incoming: readonly Transaction[];
  /** Merge only; default 'keep-existing'. */
  conflictPolicy?: RestoreConflictPolicy;
  /** Replace only: a replace with no records wipes the list, so it needs this explicit opt-in. */
  allowEmptyReplace?: boolean;
}

export type RestoreRefusalReason =
  | 'invalid-input'
  | 'empty-replace'
  | 'unavailable'
  | 'blocked'
  | 'stored-unreadable'
  | 'conflict';

export type RestoreFailureStage = 'snapshot-write' | 'snapshot-verify' | 'persist' | 'verify';

/**
 * What is in STORAGE_KEY after a failed restore:
 *  - unchanged: exactly what was there before;
 *  - rolled-back: this restore's write was undone and the previous value verified;
 *  - rollback-failed: this restore's write could not be undone (the snapshot is kept — see snapshotKey);
 *  - changed-elsewhere: neither value; another tab wrote meanwhile and was NOT touched.
 */
export type RestoreDataState = 'unchanged' | 'rolled-back' | 'rollback-failed' | 'changed-elsewhere';

export type RestoreOutcome =
  | {
      status: 'restored';
      mode: RestoreMode;
      /** False when a merge had nothing to add or replace: nothing was written and no snapshot was made. */
      changed: boolean;
      /** The list now stored (verified by reading it back). */
      transactions: Transaction[];
      /** The snapshot taken first; null when storage was empty (nothing to protect) or nothing changed. */
      snapshotKey: string | null;
      snapshotsPruned: number;
      /** True when old snapshots beyond the cap could not all be removed. The restore itself succeeded. */
      pruneIncomplete: boolean;
      merge: RestoreMergePlan['summary'] | null;
    }
  | {
      status: 'refused';
      reason: RestoreRefusalReason;
      message: string;
      blockedReason?: SaveBlockReason;
      problems?: IncomingProblems;
      /** Set for 'conflict': what re-reading storage found (the caller should apply it). */
      sync?: SyncOutcome;
    }
  | {
      status: 'failed';
      stage: RestoreFailureStage;
      dataState: RestoreDataState;
      /** The snapshot holding the previous data (null if none was created). Never deleted on failure. */
      snapshotKey: string | null;
      message: string;
    };

// ───────────────────────────── the session ─────────────────────────────

export type SyncReason = 'event' | 'conflict';

export type SyncOutcome =
  | { action: 'none' }
  /** Another tab's data was valid: show it. */
  | { action: 'adopt'; transactions: Transaction[]; notice: StorageNotice }
  /** Keep what this tab has (the stored value was removed, or could not be used). */
  | { action: 'keep'; notice: StorageNotice | null };

/**
 * Session-level reasons why what this tab shows can NOT be recovered by re-reading storage, i.e. a
 * page reload would lose it. Unlike a notice, this is state of the session itself: nothing in the UI
 * can dismiss or replace it. See `StorageSession.getDiscardHazard`.
 *  - removed-elsewhere:   stored data was removed by another tab (or cleared); this tab's list is not stored.
 *  - external-unreadable: another tab wrote content this tab cannot read; this tab's list is not stored.
 *  - unsupported-version: another tab wrote a newer format; this tab's list is not stored.
 *  - restore-incomplete:  a restore could not be completed or undone cleanly; storage and screen disagree.
 */
export type DiscardHazard = 'removed-elsewhere' | 'external-unreadable' | 'unsupported-version' | 'restore-incomplete';

export type RecheckOutcome = 'cleared' | 'kept' | 'not-applicable';

export type SaveOutcome =
  | { status: 'saved' }
  | { status: 'failed' }
  | { status: 'blocked'; reason: SaveBlockReason }
  | { status: 'conflict'; sync: SyncOutcome };

export interface StorageSession {
  readonly boot: OpenResult;
  /** Writes the full list as a versioned envelope — unless blocked, stale or failing. */
  save(transactions: readonly Transaction[]): SaveOutcome;
  /** Re-reads storage after another tab changed it (the `storage` event, or a refused save). */
  syncFromStorage(reason: SyncReason): SyncOutcome;
  /**
   * Merges or replaces the stored list (see the header for the order of operations). Synchronous.
   * A storage failure is never reported as `restored`. The caller must make sure its own in-memory
   * list has no unsaved changes before calling (the session cannot see React state).
   */
  restore(request: RestoreRequest): RestoreOutcome;
  /**
   * Why the list this tab shows cannot safely be discarded, or null when storage can reproduce it.
   * Set when the session learns that storage and this tab disagree in a way a re-read would resolve
   * in storage's favour (see `DiscardHazard`). It is cleared only by facts about storage: another
   * tab's valid data being adopted, this tab's list being written and kept by a save, or a restore
   * that wrote and verified its list. A successful save elsewhere in the UI, a dismissed notice or
   * `persistenceOk` have no effect on it. Boot-time blocks (storage unavailable, newer version found
   * at startup) are not hazards: the list on screen is exactly what a reload would show.
   */
  getDiscardHazard(): DiscardHazard | null;
  /**
   * Gives an incomplete restore a way to end without another tab's help. Only acts while the
   * `restore-incomplete` hazard is set; otherwise it returns 'not-applicable' and changes nothing.
   * It re-reads STORAGE_KEY and clears the hazard (and the matching save pause) ONLY when that read
   * succeeds and returns exactly what this tab last read or wrote, i.e. storage verifiably holds the
   * list on screen. A read that throws, or any other value (the restore's own write, another tab's
   * data, nothing at all), leaves everything as it was: 'kept'. It never adopts, writes or deletes.
   * `save` and `restore` call it first, so the next edit or restore attempt is the opportunity.
   */
  recheckAfterIncompleteRestore(): RecheckOutcome;
}

/**
 * Reads storage once and returns a session that guards every later write.
 * `openSession` performs the only side effect of starting up: preserving a recovery copy when the
 * stored content needs it. It never writes to STORAGE_KEY and never invents data, so starting the
 * app (once, twice, or under StrictMode) can't change what is stored.
 */
export function openSession(
  store: StorageLike | null = getBrowserStorage(),
  now: () => number = Date.now,
): StorageSession {
  let expectedRaw: string | null = null; // what STORAGE_KEY held when this tab last read or wrote it
  let blocked: SaveBlockReason | null = null;
  let hazard: DiscardHazard | null = null; // see StorageSession.getDiscardHazard

  const boot = ((): OpenResult => {
    const unavailable: OpenResult = {
      status: 'unavailable', transactions: [], accepted: 0, invalid: 0, saveBlocked: 'unavailable', recovery: null, notice: null,
    };
    if (store === null) return { ...unavailable, notice: bootNotice(unavailable) };

    let raw: string | null;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch {
      return { ...unavailable, notice: bootNotice(unavailable) };
    }

    if (raw === null) {
      return { status: 'empty', transactions: [], accepted: 0, invalid: 0, saveBlocked: null, recovery: null, notice: null };
    }

    expectedRaw = raw;
    const prepared = prepare(store, raw, now);
    return {
      status: prepared.status,
      reason: prepared.reason,
      format: prepared.format,
      transactions: prepared.transactions,
      accepted: prepared.accepted,
      invalid: prepared.invalid,
      saveBlocked: prepared.saveBlocked,
      recovery: prepared.recovery,
      notice: bootNotice(prepared),
    };
  })();
  blocked = boot.saveBlocked;

  function syncFromStorage(reason: SyncReason): SyncOutcome {
    if (store === null) return { action: 'none' };
    let raw: string | null;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch {
      return { action: 'none' };
    }
    if (raw === expectedRaw) return { action: 'none' };

    if (raw === null) {
      // Removed elsewhere (another tab, or site data cleared). That is a deletion this tab must not
      // undo: its in-memory list may be stale, so it is NOT written back and saving stays blocked.
      // The list on screen is kept (never silently cleared). `expectedRaw` becomes null so a repeat
      // of the same event is a no-op (no notice spam, no loop). Saving is allowed again only when
      // another tab stores valid data, which is then adopted by the branch below.
      expectedRaw = null;
      blocked = 'removed-elsewhere';
      hazard = 'removed-elsewhere';
      return {
        action: 'keep',
        notice: {
          kind: 'removed-elsewhere',
          message:
            'Your saved data was removed in another tab. What you see here has not been saved back, and changes in this tab can’t be saved right now. Reloading shows what is currently stored.',
        },
      };
    }

    const prepared = prepare(store, raw, now);
    expectedRaw = raw;
    blocked = prepared.saveBlocked;

    if (prepared.status === 'ok') {
      // The caller replaces its list with what storage holds, so nothing is left that storage lacks.
      hazard = null;
      const invalidNotice = bootNotice(prepared);
      return {
        action: 'adopt',
        transactions: prepared.transactions,
        notice: invalidNotice ?? {
          kind: reason === 'conflict' ? 'conflict' : 'external-update',
          message:
            reason === 'conflict'
              ? 'Another tab saved newer data, so it was loaded here. Your latest change in this tab was not saved — please repeat it if needed.'
              : 'Your data was updated in another tab, so this tab now shows the latest version.',
        },
      };
    }

    // Unusable content written elsewhere: keep this tab's data, never adopt or erase it.
    hazard = prepared.reason === 'unsupported-version' ? 'unsupported-version' : 'external-unreadable';
    const preserved = prepared.recovery?.ok === true;
    const notice: StorageNotice =
      prepared.reason === 'unsupported-version'
        ? bootNotice(prepared)!
        : {
            kind: 'external-unreadable',
            message: preserved
              ? 'Data saved in another tab couldn’t be read. A recovery copy of it was preserved, and this tab keeps its own data.'
              : `Data saved in another tab couldn’t be read, and a recovery copy couldn’t be made. ${SAVING_PAUSED}`,
          };
    return { action: 'keep', notice };
  }

  function recheckAfterIncompleteRestore(): RecheckOutcome {
    if (hazard !== 'restore-incomplete' || blocked !== 'restore-incomplete' || store === null) return 'not-applicable';
    let raw: string | null;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch {
      return 'kept'; // unreadable: nothing is verified
    }
    if (raw !== expectedRaw) return 'kept'; // storage does not hold what this tab shows
    blocked = null;
    hazard = null;
    return 'cleared';
  }

  function save(transactions: readonly Transaction[]): SaveOutcome {
    recheckAfterIncompleteRestore();
    if (blocked !== null) return { status: 'blocked', reason: blocked };
    if (store === null) return { status: 'failed' };
    try {
      if (store.getItem(STORAGE_KEY) !== expectedRaw) {
        // Stale: another tab saved since this one last looked. Refuse; adopt what is stored.
        return { status: 'conflict', sync: syncFromStorage('conflict') };
      }
      const raw = serializeEnvelope(transactions);
      store.setItem(STORAGE_KEY, raw);
      expectedRaw = raw;
      hazard = null; // storage now holds exactly this tab's list
      return { status: 'saved' };
    } catch {
      return { status: 'failed' };
    }
  }

  function restore(request: RestoreRequest): RestoreOutcome {
    const refuse = (reason: RestoreRefusalReason, message: string, extra: Partial<Extract<RestoreOutcome, { status: 'refused' }>> = {}): RestoreOutcome => ({
      status: 'refused',
      reason,
      message,
      ...extra,
    });

    if (store === null) return refuse('unavailable', 'Browser storage isn’t available, so nothing was restored.');
    recheckAfterIncompleteRestore();
    if (blocked !== null) {
      return refuse('blocked', 'Saving is paused for this session, so nothing was restored. Your data was not changed.', { blockedReason: blocked });
    }
    if (request.mode !== 'merge' && request.mode !== 'replace') {
      return refuse('invalid-input', 'Unknown restore mode. Your data was not changed.');
    }
    const checked = validateIncoming(request.incoming);
    if (!checked.ok) {
      const { invalidRecords, descriptionTooLong, duplicateIds } = checked;
      return refuse('invalid-input', 'The records to restore are not all valid. Nothing was restored.', {
        problems: { invalidRecords, descriptionTooLong, duplicateIds },
      });
    }
    const incoming = checked.transactions;
    if (request.mode === 'replace' && incoming.length === 0 && request.allowEmptyReplace !== true) {
      return refuse('empty-replace', 'Replacing with an empty list would remove all current data. Nothing was restored.');
    }

    // 1. Is storage still what this tab last saw?
    let previousRaw: string | null;
    try {
      previousRaw = store.getItem(STORAGE_KEY);
    } catch {
      return refuse('unavailable', 'Stored data couldn’t be read, so nothing was restored. Your data was not changed.');
    }
    if (previousRaw !== expectedRaw) {
      return refuse('conflict', 'Another tab changed your data, so nothing was restored. The newer data was loaded instead.', {
        sync: syncFromStorage('conflict'),
      });
    }

    // 2. What is stored decides what is allowed. Newer-version data is never touched.
    let existing: Transaction[] = [];
    if (previousRaw !== null) {
      const parsed = parseStoredPayload(previousRaw);
      if (parsed.status === 'corrupt') {
        if (parsed.reason === 'unsupported-version') {
          blocked = 'unsupported-version';
          return refuse('blocked', 'Your saved data was written by a newer version of this app and was left untouched.', {
            blockedReason: 'unsupported-version',
          });
        }
        // Replace may proceed (the snapshot below keeps the unreadable original byte-for-byte);
        // a merge has nothing trustworthy to merge into.
        if (request.mode === 'merge') {
          return refuse('stored-unreadable', 'Your saved data couldn’t be read, so it can’t be merged into. Nothing was restored.');
        }
      } else {
        existing = parsed.transactions;
      }
    }

    // 3. The list to write.
    let intended: Transaction[];
    let mergeSummary: RestoreMergePlan['summary'] | null = null;
    if (request.mode === 'merge') {
      const plan = planRestoreMerge(existing, incoming, { conflictPolicy: request.conflictPolicy });
      mergeSummary = plan.summary;
      if (plan.toAdd.length === 0 && plan.summary.conflictsReplaced === 0) {
        return {
          status: 'restored', mode: 'merge', changed: false, transactions: existing,
          snapshotKey: null, snapshotsPruned: 0, pruneIncomplete: false, merge: mergeSummary,
        };
      }
      intended = plan.merged;
    } else {
      intended = incoming;
    }

    // 4. Snapshot FIRST (only when something is stored). Nothing is deleted before or if this fails.
    let snapshotKey: string | null = null;
    if (previousRaw !== null) {
      const snapshot = createSnapshot(store, previousRaw, now);
      if (!snapshot.ok) {
        return {
          status: 'failed', stage: snapshot.stage, dataState: 'unchanged', snapshotKey: null,
          message: 'A safety snapshot of your current data couldn’t be saved (storage may be full), so nothing was restored. Your data was not changed.',
        };
      }
      snapshotKey = snapshot.key;
    }

    // 5. Re-check right before writing (narrows, but cannot close, the cross-tab window).
    try {
      if (store.getItem(STORAGE_KEY) !== previousRaw) {
        return refuse('conflict', 'Another tab changed your data, so nothing was restored. The newer data was loaded instead.', {
          sync: syncFromStorage('conflict'),
        });
      }
    } catch {
      return refuse('unavailable', 'Stored data couldn’t be read, so nothing was restored. Your data was not changed.');
    }

    // 6. Persist, read back, compare.
    const raw = serializeEnvelope(intended, new Date(now()));
    let failedStage: 'persist' | 'verify' | null = null;
    try {
      store.setItem(STORAGE_KEY, raw);
    } catch {
      failedStage = 'persist';
    }
    if (failedStage === null) {
      let verified = false;
      try {
        const back = store.getItem(STORAGE_KEY);
        if (back === raw) {
          const parsedBack = parseStoredPayload(back);
          verified = parsedBack.status === 'ok' && parsedBack.invalid === 0 && sameTransactions(parsedBack.transactions, intended);
        }
      } catch {
        verified = false;
      }
      if (!verified) failedStage = 'verify';
    }

    if (failedStage !== null) {
      const dataState = recoverAfterFailure(store, previousRaw, raw);
      if (dataState === 'rollback-failed' || dataState === 'changed-elsewhere') {
        blocked = 'restore-incomplete';
        hazard = 'restore-incomplete';
      }
      const where = failedStage === 'persist' ? 'The new data couldn’t be saved' : 'The saved data didn’t match what was expected';
      const state =
        dataState === 'unchanged' ? 'Your data was not changed.'
        : dataState === 'rolled-back' ? 'Your previous data was put back and verified.'
        : dataState === 'changed-elsewhere' ? 'Storage was changed by another tab in the meantime and was left alone.'
        : 'Your previous data could not be put back automatically; a safety snapshot of it was kept.';
      return { status: 'failed', stage: failedStage, dataState, snapshotKey, message: `${where}, so the restore was not completed. ${state}` };
    }

    // 7. Full success: only now trim old snapshots (never the new one, never recovery copies).
    expectedRaw = raw;
    hazard = null; // written and verified by reading it back
    const pruned = snapshotKey === null ? { pruned: 0, incomplete: false } : pruneSnapshots(store, snapshotKey);
    return {
      status: 'restored', mode: request.mode, changed: true, transactions: intended, snapshotKey,
      snapshotsPruned: pruned.pruned, pruneIncomplete: pruned.incomplete, merge: mergeSummary,
    };
  }

  return { boot, save, syncFromStorage, restore, getDiscardHazard: () => hazard, recheckAfterIncompleteRestore };
}

/**
 * After a failed persist/verify: put the previous value back, but only while storage still holds
 * exactly what the restore wrote. Anything else (the previous value, or another tab's data) is
 * left alone. The snapshot is never touched here.
 */
function recoverAfterFailure(store: StorageLike, previousRaw: string | null, written: string): RestoreDataState {
  let current: string | null;
  try {
    current = store.getItem(STORAGE_KEY);
  } catch {
    return 'rollback-failed';
  }
  if (current === previousRaw) return 'unchanged';
  if (current !== written) return 'changed-elsewhere';
  try {
    if (previousRaw === null) {
      if (typeof store.removeItem !== 'function') return 'rollback-failed';
      store.removeItem(STORAGE_KEY);
    } else {
      store.setItem(STORAGE_KEY, previousRaw);
    }
    return store.getItem(STORAGE_KEY) === previousRaw ? 'rolled-back' : 'rollback-failed';
  } catch {
    return 'rollback-failed';
  }
}

// ───────────────────────────── persistent storage (best effort) ─────────────────────────────

export type PersistResult = 'granted' | 'denied' | 'unsupported' | 'error';

interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

/**
 * Asks the browser (native Storage API) to treat this site's storage as persistent. Best effort and
 * non-blocking: unsupported APIs and rejections resolve to a result instead of throwing, and a
 * `granted` answer is not a guarantee — users and browsers can still clear site data.
 */
export async function requestPersistentStorage(
  manager: StorageManagerLike | undefined = typeof navigator === 'undefined' ? undefined : navigator.storage,
): Promise<PersistResult> {
  try {
    if (!manager || typeof manager.persist !== 'function') return 'unsupported';
    if (typeof manager.persisted === 'function' && (await manager.persisted())) return 'granted';
    return (await manager.persist()) ? 'granted' : 'denied';
  } catch {
    return 'error';
  }
}
