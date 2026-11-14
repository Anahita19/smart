import { BackupError, MAX_BACKUP_CHARS, backupFileName, createBackupJson, parseBackup } from '@/lib/backup';
import type { BackupErrorCode, DigestLike } from '@/lib/backup';
import type { Transaction } from '@/types/transaction';

/**
 * Backup export — Phase 4B, Stage 3: build the file and hand it to the browser.
 *
 * This module adds NO format and NO checksum of its own. The file is made by the Stage 1 engine
 * (`createBackupJson`: validation, canonical JSON, SHA-256) and, before anything is downloaded, read
 * back with the same engine (`parseBackup`) to prove that the text about to be saved verifies and
 * holds exactly as many transactions as were given. Nothing here reads or writes localStorage, so
 * transaction data, recovery copies and snapshots are never touched or exported.
 */

export type ExportFailureCode = BackupErrorCode | 'verification-failed' | 'download-failed' | 'unexpected';

export type ExportOutcome =
  | {
      ok: true;
      fileName: string;
      transactionCount: number;
      /** ISO 8601 UTC timestamp written into the file. */
      exportedAt: string;
      /** Size of the file text in characters. */
      size: number;
      /** Frees the temporary download URL. Safe to call more than once. */
      release: () => void;
    }
  | {
      ok: false;
      code: ExportFailureCode;
      /** Technical English text for logs and tests; the screen shows its own wording. Never contains transaction contents. */
      message: string;
      details?: { invalidRecords?: number; descriptionTooLong?: number; duplicateIds?: number };
    };

/** Hands finished file text to the user's device. Returns a function that frees what it allocated. */
export type SaveFile = (text: string, fileName: string) => () => void;

export interface ExportDeps {
  now?: () => Date;
  appVersion?: string;
  /** Test seam; the browser's `crypto.subtle` by default. `null` simulates it being unavailable. */
  subtle?: DigestLike | null;
  save?: SaveFile;
}

export const BACKUP_MIME_TYPE = 'application/json;charset=utf-8';

/**
 * Browser download: a temporary object URL on a hidden <a download>. The URL is NOT revoked here
 * (revoking immediately can cancel the download in some browsers and this app uses no timers);
 * the caller frees it through the returned function.
 */
export const saveInBrowser: SaveFile = (text, fileName) => {
  const url = URL.createObjectURL(new Blob([text], { type: BACKUP_MIME_TYPE }));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(url);
  };
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      document.body.removeChild(link);
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
};

/**
 * Builds a backup of ALL the given transactions (future-dated ones included, nothing filtered),
 * verifies it, and downloads it. Never throws; never changes its input.
 */
export async function exportBackup(transactions: readonly Transaction[], deps: ExportDeps = {}): Promise<ExportOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const save = deps.save ?? saveInBrowser;
  const subtleOption = deps.subtle === undefined ? {} : { subtle: deps.subtle };
  const versionOption = deps.appVersion === undefined ? {} : { appVersion: deps.appVersion };

  let json: string;
  try {
    json = await createBackupJson(transactions, { now, ...versionOption, ...subtleOption });
  } catch (error) {
    if (error instanceof BackupError) {
      return { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
    }
    return { ok: false, code: 'unexpected', message: 'The backup could not be created.' };
  }

  // Never save a file this app could not read back: re-parse it with the Stage 1 engine (this also
  // re-verifies the SHA-256 checksum and enforces the size limit an import would apply).
  let verified = false;
  try {
    const parsed = await parseBackup(json, deps.subtle === undefined ? {} : { subtle: deps.subtle });
    verified =
      parsed.ok &&
      parsed.source === 'backup' &&
      parsed.meta.checksum === 'verified' &&
      parsed.report.total === transactions.length &&
      json.length <= MAX_BACKUP_CHARS;
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, code: 'verification-failed', message: 'The backup file did not pass its own verification, so it was not saved.' };
  }

  const fileName = backupFileName(now);
  try {
    const release = save(json, fileName);
    return { ok: true, fileName, transactionCount: transactions.length, exportedAt: now.toISOString(), size: json.length, release };
  } catch {
    return { ok: false, code: 'download-failed', message: 'The browser could not start the download.' };
  }
}
