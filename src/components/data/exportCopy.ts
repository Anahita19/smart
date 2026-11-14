import { todayISO } from '@/lib/datePolicy';
import type { ExportFailureCode } from '@/lib/exportBackup';

/** English wording and small formatters for the Data page. Pure, so they can be tested without React. */

export const PRIVACY_WARNING_TITLE = 'Privacy warning';

export const PRIVACY_WARNING_TEXT =
  'The backup file contains your financial information and is saved as readable, unencrypted JSON. Keep it somewhere safe, do not send it through messaging apps or post it publicly, and delete extra copies after use.';

export const SCOPE_NOTE =
  "All transactions, including future-dated ones, are included in the file. Recovery copies and the app's internal snapshots are not included.";

export const EMPTY_NOTE = 'No transactions have been recorded yet, so there is nothing to back up.';

export const UNSAVED_NOTE =
  'Recent changes in this browser have not been saved. The backup is built from the data currently on screen.';

export const FAILURE_FILE_NOTE = 'No file was downloaded and your data was not changed.';

/** Message for a failed export. Counts and reasons only — never transaction contents. */
export function describeExportFailure(code: ExportFailureCode): string {
  switch (code) {
    case 'crypto-unavailable':
      return 'This browser cannot compute the SHA-256 checksum (Web Crypto is unavailable and requires a secure context such as https or localhost). The backup was not created. ' + FAILURE_FILE_NOTE;
    case 'invalid-transactions':
    case 'duplicate-ids':
    case 'malformed':
      return 'Some transactions are invalid, so a complete, restorable backup cannot be created, and no partial backup was produced. ' + FAILURE_FILE_NOTE;
    case 'verification-failed':
      return 'The generated file failed its own integrity check, so it was not saved. Try again. ' + FAILURE_FILE_NOTE;
    case 'download-failed':
      return 'The browser could not start the download. Check your download settings or any blocker in the browser and try again. ' + FAILURE_FILE_NOTE;
    default:
      return 'Creating the backup failed. Try again. ' + FAILURE_FILE_NOTE;
  }
}

export function describeExportSuccess(fileName: string, count: number): string {
  return `Backup created with ${formatTransactionCount(count)} and the download of "${fileName}" has started. If the download did not start, check your browser's download settings.`;
}

/** Number with thousands separators (e.g. 1234 → 1,234). Fixed to en-US so output does not depend on the browser's locale. */
export function formatCount(count: number): string {
  return new Intl.NumberFormat('en-US').format(count);
}

/** "1 transaction" / "3 transactions", with an optional adjective ("3 new transactions"). */
export function formatTransactionCount(count: number, adjective?: string): string {
  return `${formatCount(count)} ${adjective ? adjective + ' ' : ''}${count === 1 ? 'transaction' : 'transactions'}`;
}

/** The export date: a readable date (e.g. "Nov 11, 2026") plus the ISO date the file name uses. */
export function formatExportDate(date: Date): { display: string; iso: string } {
  const display = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  return { display, iso: todayISO(date) };
}
