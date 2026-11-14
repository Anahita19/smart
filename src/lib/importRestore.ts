import { MAX_BACKUP_CHARS, parseBackup } from '@/lib/backup';
import type { BackupErrorCode, BackupErrorDetails, BackupMeta, BackupReport, BackupSource, DigestLike } from '@/lib/backup';
import { planRestoreMerge } from '@/lib/storage';
import type { RestoreDataState, RestoreFailureStage, RestoreMode, RestoreOutcome, RestoreRefusalReason, RestoreRequest } from '@/lib/storage';
import type { Transaction } from '@/types/transaction';

/**
 * Import & Restore — Phase 4B, Stage 4: the decision layer between the Data page and the Stage 2
 * restore integration. No React, no DOM, no storage access: it reads a file's text, validates it
 * with the Stage 1 `parseBackup`, builds a COUNTS-ONLY preview, and — only after explicit
 * confirmation — hands the validated records to the restore function it is given (in the app that
 * is the Context's `restoreTransactions`, which already refuses unsaved changes, takes the snapshot
 * first and verifies the write by reading it back).
 *
 * Nothing here changes the backup format or checksum logic, and nothing here writes anywhere:
 * `prepareImport` and `buildPreview` are read-only; `runImport` calls the injected restore function
 * at most once and never touches storage keys, snapshots or recovery copies itself.
 *
 * Rules enforced here (each one is tested):
 *  - choosing a file never restores it: preview and restore are separate calls, and `runImport`
 *    refuses to call the restore function unless `confirmed === true`;
 *  - Replace additionally needs the typed phrase (`REPLACE_CONFIRM_PHRASE`);
 *  - merge always uses `conflictPolicy: 'keep-existing'`, spelled out explicitly;
 *  - Replace never sets `allowEmptyReplace`: a file with no transactions can never wipe the list;
 *  - if the stored list changed after the preview was made, nothing is restored and a fresh preview
 *    is returned for a new confirmation;
 *  - success is reported only when the restore function says `restored` AND the list it returns
 *    equals the list this layer expected; otherwise the result is `unverified`, never a success;
 *  - previews and results carry counts and dates only — never amounts, descriptions or categories.
 */

/** What the person must type to confirm a Replace. */
export const REPLACE_CONFIRM_PHRASE = 'REPLACE';

/**
 * A file's size in bytes can't tell its length in characters exactly, but one character takes at most
 * three UTF-8 bytes in the BMP (and four bytes cover two UTF-16 units), so a file above this many
 * bytes is certainly over MAX_BACKUP_CHARS and is refused WITHOUT reading it into memory.
 */
export const MAX_IMPORT_BYTES = MAX_BACKUP_CHARS * 3;

export type ImportMode = RestoreMode;

// ───────────────────────────── types ─────────────────────────────

export type ImportFailureCode = BackupErrorCode | 'read-failed' | 'unexpected';

export interface ImportFailure {
  code: ImportFailureCode;
  /** Plain-language English text for logs and tests; the screen shows its own wording (see components/data/importCopy.ts). */
  message: string;
  /** Counts and positions only. */
  details?: BackupErrorDetails;
}

/** The validated content of a file: what `parseBackup` returned, nothing else. */
export interface ParsedImport {
  source: BackupSource;
  transactions: Transaction[];
  report: BackupReport;
  meta: BackupMeta;
}

/** Everything the preview may show: counts, dates and flags — no amounts, descriptions or categories. */
export interface ImportPreview {
  source: BackupSource;
  /** 'verified' for a backup file; legacy formats carry no checksum. */
  checksum: BackupMeta['checksum'];
  backupVersion: number | null;
  /** ISO 8601 timestamp from the file (`exportedAt`/`savedAt`); null for a bare list. */
  backupDate: string | null;
  incomingCount: number;
  /** Ids the app does not have yet. */
  newCount: number;
  /** Same id, same content: skipped by a merge. */
  duplicateCount: number;
  /** Same id, different content: the existing record is kept by a merge. */
  conflictCount: number;
  /** New ids whose content looks like an existing record. A warning only. */
  possibleDuplicateCount: number;
  futureDatedCount: number;
  unknownCategoryCount: number;
  existingCount: number;
  /** Replace: records in the app whose id is not in the file (they would be removed). */
  replaceRemovedCount: number;
  /** Replace is offered only for a file that holds at least one transaction. */
  canReplace: boolean;
}

export type PrepareResult = { ok: true; parsed: ParsedImport; preview: ImportPreview } | { ok: false; error: ImportFailure };

/** The part of a browser `File` that reading needs (so tests can supply a fake). */
export interface FileLike {
  size: number;
  text(): Promise<string>;
}

export type ReadFileResult = { ok: true; text: string } | { ok: false; error: ImportFailure };

/** What the Context's `restoreTransactions` returns: the storage outcome, or a refusal for unsaved changes. */
export type RestoreGateOutcome = RestoreOutcome | { status: 'refused'; reason: 'unsaved-changes'; message: string };
export type RestoreGate = (request: RestoreRequest) => RestoreGateOutcome;

export interface RunImportInput {
  parsed: ParsedImport;
  /** The list the preview was computed against. */
  baseTransactions: readonly Transaction[];
  /** The list the app holds right now. */
  currentTransactions: readonly Transaction[];
  mode: ImportMode;
  /** Must be exactly `true`: set only by the person's explicit confirm action. */
  confirmed: boolean;
  /** Replace only: what the person typed. */
  replacePhrase?: string;
  restore: RestoreGate;
}

export type ImportRefusalReason = RestoreRefusalReason | 'unsaved-changes';

export type ImportRunResult =
  | {
      status: 'restored';
      mode: ImportMode;
      /** False when a merge had nothing to add: nothing was written. */
      changed: boolean;
      addedCount: number;
      duplicateCount: number;
      conflictsKeptCount: number;
      /** Replace: records that were in the app and are not in the file any more. */
      removedCount: number;
      totalAfter: number;
      snapshotKept: boolean;
      pruneIncomplete: boolean;
    }
  /** The preview is out of date: nothing was restored. Show `preview` and ask again. */
  | { status: 'stale'; preview: ImportPreview }
  | { status: 'not-confirmed'; reason: 'not-confirmed' | 'replace-phrase-mismatch' }
  | { status: 'refused'; reason: ImportRefusalReason; message: string }
  | { status: 'failed'; stage: RestoreFailureStage; dataState: RestoreDataState; snapshotKept: boolean; message: string }
  /** The restore said it succeeded but the list it returned is not the expected one: NOT reported as success. */
  | { status: 'unverified' }
  /** The restore function threw: what was stored is unknown. */
  | { status: 'unexpected' };

// ───────────────────────────── confirmation phrase ─────────────────────────────

/** Makes typing forgiving without making it loose: ignores letter case and extra spacing. */
export function normalizePhrase(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isReplacePhrase(input: string): boolean {
  return normalizePhrase(input) === normalizePhrase(REPLACE_CONFIRM_PHRASE);
}

// ───────────────────────────── list helpers ─────────────────────────────

function sameList(a: readonly Transaction[], b: readonly Transaction[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const o = b[i]!;
    return t.id === o.id && t.type === o.type && t.amount === o.amount && t.categoryId === o.categoryId && t.description === o.description && t.date === o.date;
  });
}

// ───────────────────────────── reading and preview (read-only) ─────────────────────────────

/** Reads the text of the chosen file. Never writes anything; never throws. */
export async function readImportFile(file: FileLike): Promise<ReadFileResult> {
  if (file.size > MAX_IMPORT_BYTES) {
    return { ok: false, error: { code: 'too-large', message: 'The file is too large to be a backup of this app.' } };
  }
  try {
    return { ok: true, text: await file.text() };
  } catch {
    return { ok: false, error: { code: 'read-failed', message: 'The file could not be read.' } };
  }
}

/** Counts-only preview of what restoring `parsed` into `existing` would do. Pure. */
export function buildPreview(parsed: ParsedImport, existing: readonly Transaction[]): ImportPreview {
  const plan = planRestoreMerge(existing, parsed.transactions, { conflictPolicy: 'keep-existing' });
  const incomingIds = new Set(parsed.transactions.map((t) => t.id));
  const replaceRemovedCount = existing.reduce((count, t) => (incomingIds.has(t.id) ? count : count + 1), 0);
  return {
    source: parsed.source,
    checksum: parsed.meta.checksum,
    backupVersion: parsed.meta.backupVersion ?? null,
    backupDate: parsed.meta.exportedAt ?? null,
    incomingCount: parsed.transactions.length,
    newCount: plan.summary.added,
    duplicateCount: plan.summary.skippedIdentical,
    conflictCount: plan.summary.conflicts,
    possibleDuplicateCount: plan.summary.possibleDuplicates,
    futureDatedCount: parsed.report.futureDated,
    unknownCategoryCount: parsed.report.unknownCategories,
    existingCount: existing.length,
    replaceRemovedCount,
    canReplace: parsed.transactions.length > 0,
  };
}

/**
 * Validates the file text with the Stage 1 `parseBackup` (JSON, format, version, SHA-256 checksum,
 * count, every transaction, duplicate ids) and builds the preview. All-or-nothing: any problem
 * rejects the whole file. Reads and writes nothing else; never throws.
 */
export async function prepareImport(
  raw: string,
  existing: readonly Transaction[],
  options: { today?: string; subtle?: DigestLike | null } = {},
): Promise<PrepareResult> {
  let result;
  try {
    result = await parseBackup(raw, options);
  } catch {
    return { ok: false, error: { code: 'unexpected', message: 'The file could not be checked.' } };
  }
  if (!result.ok) {
    const { code, message, details } = result.error;
    return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
  }
  const parsed: ParsedImport = { source: result.source, transactions: result.transactions, report: result.report, meta: result.meta };
  return { ok: true, parsed, preview: buildPreview(parsed, existing) };
}

// ───────────────────────────── restore ─────────────────────────────

/**
 * Restores a previewed file — only with explicit confirmation. Calls `restore` at most once, and
 * never before every check here has passed. See the header for the rules.
 */
export function runImport(input: RunImportInput): ImportRunResult {
  const { parsed, baseTransactions, currentTransactions, mode, restore } = input;
  const incoming = parsed.transactions;

  if (mode !== 'merge' && mode !== 'replace') {
    return { status: 'refused', reason: 'invalid-input', message: 'Unknown restore mode. Your data was not changed.' };
  }
  if (input.confirmed !== true) return { status: 'not-confirmed', reason: 'not-confirmed' };
  if (mode === 'replace' && !isReplacePhrase(input.replacePhrase ?? '')) {
    return { status: 'not-confirmed', reason: 'replace-phrase-mismatch' };
  }

  // The preview was computed against `baseTransactions`; if the list moved on, the person has not
  // confirmed THIS outcome. Nothing is restored; they get a fresh preview.
  if (!sameList(baseTransactions, currentTransactions)) {
    return { status: 'stale', preview: buildPreview(parsed, currentTransactions) };
  }

  if (mode === 'replace' && incoming.length === 0) {
    return { status: 'refused', reason: 'empty-replace', message: 'Replacing with an empty list would remove all current data. Nothing was restored.' };
  }

  const preview = buildPreview(parsed, currentTransactions);
  const request: RestoreRequest =
    mode === 'merge'
      ? { mode: 'merge', incoming, conflictPolicy: 'keep-existing' }
      : { mode: 'replace', incoming };

  let outcome: RestoreGateOutcome;
  try {
    outcome = restore(request);
  } catch {
    return { status: 'unexpected' };
  }

  if (outcome.status === 'refused') {
    return { status: 'refused', reason: outcome.reason, message: outcome.message };
  }
  if (outcome.status === 'failed') {
    return { status: 'failed', stage: outcome.stage, dataState: outcome.dataState, snapshotKept: outcome.snapshotKey !== null, message: outcome.message };
  }

  // 'restored': the storage layer has written AND read the data back. Check the list it reports is
  // exactly the list this layer expected before calling it a success.
  const expected =
    mode === 'merge'
      ? planRestoreMerge(currentTransactions, incoming, { conflictPolicy: 'keep-existing' }).merged
      : incoming;
  if (outcome.mode !== mode || !sameList(outcome.transactions, expected)) return { status: 'unverified' };
  if (mode === 'replace' && !outcome.changed) return { status: 'unverified' };

  return {
    status: 'restored',
    mode,
    changed: outcome.changed,
    addedCount: mode === 'merge' ? preview.newCount : incoming.length,
    duplicateCount: mode === 'merge' ? preview.duplicateCount : 0,
    conflictsKeptCount: mode === 'merge' ? preview.conflictCount : 0,
    removedCount: mode === 'replace' ? preview.replaceRemovedCount : 0,
    totalAfter: outcome.transactions.length,
    snapshotKept: outcome.snapshotKey !== null,
    pruneIncomplete: outcome.pruneIncomplete,
  };
}
