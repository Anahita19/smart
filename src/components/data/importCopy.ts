import type { ImportFailure, ImportRunResult } from '@/lib/importRestore';
import { REPLACE_CONFIRM_PHRASE } from '@/lib/importRestore';
import { formatTransactionCount } from '@/components/data/exportCopy';

/**
 * English wording for the Import & Restore card. Pure, so it can be tested without React.
 * Every message contains counts at most — never transaction amounts, descriptions or categories.
 */

export const IMPORT_TITLE = 'Restore from a backup file';

export const IMPORT_INTRO =
  'Choose a JSON backup file. The file is only checked first and a summary is shown; nothing is changed until you confirm.';

export const IMPORT_PRIVACY_TEXT =
  'A backup file contains your financial data in readable, unencrypted form. Only choose a file from a source you trust, and keep it somewhere safe.';

export const NO_CHECKSUM_WARNING =
  'This file has no checksum (legacy format), so its integrity cannot be verified. Continue only if you are sure it is intact.';

export const UNSAVED_IMPORT_NOTE =
  'Recent changes in this browser have not been saved yet. Restore is unavailable until they are saved, and your data stays untouched.';

export const MERGE_TITLE = 'Merge (recommended)';
export const MERGE_TEXT =
  'New transactions from the file are added to your current data. No existing transaction is removed, and if an id matches but the content differs, the existing version is kept.';

export const REPLACE_TITLE = 'Replace everything';
export const REPLACE_TEXT = 'All current data is replaced with the contents of the file.';

export const REPLACE_SAFETY_TEXT =
  'Before replacing, a safety snapshot of your current data is created. If that fails, nothing is changed.';

export const REPLACE_PHRASE_LABEL = `To confirm, type "${REPLACE_CONFIRM_PHRASE}"`;

export const STALE_NOTE = 'The app data changed after the preview was created. The preview has been refreshed; please review and confirm it again.';

export const SELECT_LABEL = 'Choose a backup file';
export const READING_LABEL = 'Reading and checking the file…';

const NOTHING_CHANGED = 'Your data was not changed.';
const NOTHING_IMPORTED = 'Nothing was imported. ' + NOTHING_CHANGED;

/** Why a file was rejected. Counts only. The whole file is rejected whenever any problem exists. */
export function describeImportFailure(failure: ImportFailure): string {
  const d = failure.details;
  switch (failure.code) {
    case 'too-large':
      return 'The file is larger than allowed and cannot be a backup of this app. ' + NOTHING_IMPORTED;
    case 'read-failed':
      return 'The file could not be read. Try again or choose a different file. ' + NOTHING_IMPORTED;
    case 'empty':
      return 'The file is empty. ' + NOTHING_IMPORTED;
    case 'invalid-json':
      return 'This file is not valid JSON and cannot be a backup of this app. ' + NOTHING_IMPORTED;
    case 'unrecognized-format':
      return 'This file is not a Smart Expense Tracker backup or a recognized export of one. ' + NOTHING_IMPORTED;
    case 'malformed':
    case 'missing-field':
      return 'The file structure is incomplete or invalid. ' + NOTHING_IMPORTED;
    case 'unsupported-version':
      return 'This app cannot read the version of this file (it is from a newer or unknown version). Update the app or choose a different file. ' + NOTHING_IMPORTED;
    case 'migration-failed':
      return 'Upgrading this backup to the current version failed. ' + NOTHING_IMPORTED;
    case 'checksum-missing':
      return 'This backup has no checksum, so its integrity cannot be verified. ' + NOTHING_IMPORTED;
    case 'unsupported-checksum':
      return "The file's checksum algorithm is not supported. " + NOTHING_IMPORTED;
    case 'crypto-unavailable':
      return 'This browser cannot compute the SHA-256 checksum (Web Crypto is unavailable and requires a secure context such as https or localhost), so the file cannot be verified. ' + NOTHING_IMPORTED;
    case 'checksum-mismatch':
      return "The file's checksum does not match its content; the file is damaged or was edited after it was created. " + NOTHING_IMPORTED;
    case 'count-mismatch':
      return 'The transaction count declared in the file does not match the actual count. ' + NOTHING_IMPORTED;
    case 'invalid-transactions': {
      const bad = (d?.invalidRecords ?? 0) + (d?.descriptionTooLong ?? 0);
      const dupCount = d?.duplicateIds ?? 0;
      const head = bad > 0 ? `${formatTransactionCount(bad)} in the file ${bad === 1 ? 'is' : 'are'} invalid` : 'Some transactions in the file are invalid';
      const dup = dupCount > 0 ? ` and ${formatTransactionCount(dupCount)} more ${dupCount === 1 ? 'has a duplicate id' : 'have duplicate ids'}` : '';
      return `${head}${dup}. The whole file was rejected, even if the other transactions are valid. ` + NOTHING_IMPORTED;
    }
    case 'duplicate-ids': {
      const dup = d?.duplicateIds ?? 0;
      const head = dup > 0 ? `${formatTransactionCount(dup)} in the file ${dup === 1 ? 'has a duplicate id' : 'have duplicate ids'}` : 'Some transactions in the file have duplicate ids';
      return `${head}. The whole file was rejected. ` + NOTHING_IMPORTED;
    }
    default:
      return 'Checking the file ran into an unexpected error. ' + NOTHING_IMPORTED;
  }
}

export type ResultTone = 'success' | 'info' | 'error' | 'warning';
export interface ResultMessage {
  tone: ResultTone;
  text: string;
}

const SNAPSHOT_KEPT = 'A safety snapshot of your previous data has been kept.';

/**
 * The message for the outcome of a restore. "success" is produced ONLY for a `restored` result,
 * which `runImport` returns only after the storage layer's read-back verification and its own
 * consistency check. Counts only.
 */
export function describeRunResult(result: Exclude<ImportRunResult, { status: 'stale' } | { status: 'not-confirmed' }>): ResultMessage {
  switch (result.status) {
    case 'restored': {
      if (!result.changed) {
        return { tone: 'info', text: 'All transactions in this file were already in the app. Nothing was added and your data was not changed.' };
      }
      const snapshot = result.snapshotKept ? ' ' + SNAPSHOT_KEPT : '';
      const prune = result.pruneIncomplete ? ' Cleaning up old snapshots did not finish; this does not affect the restore.' : '';
      if (result.mode === 'merge') {
        const extras: string[] = [];
        if (result.duplicateCount > 0) {
          extras.push(`${formatTransactionCount(result.duplicateCount, 'duplicate')} ${result.duplicateCount === 1 ? 'was' : 'were'} ignored`);
        }
        if (result.conflictsKeptCount > 0) {
          extras.push(
            `${formatTransactionCount(result.conflictsKeptCount)} with the same id but different content ${result.conflictsKeptCount === 1 ? 'was' : 'were'} kept as the existing version`,
          );
        }
        const tail = extras.length > 0 ? ` ${extras.join('; ')}.` : '';
        return {
          tone: 'success',
          text: `Merge completed and storage verified: ${formatTransactionCount(result.addedCount, 'new')} added; you now have ${formatTransactionCount(result.totalAfter)}.${tail}${snapshot}${prune}`,
        };
      }
      return {
        tone: 'success',
        text: `Replace completed and storage verified: you now have ${formatTransactionCount(result.totalAfter)} (${formatTransactionCount(result.removedCount, 'previous')} not in the file removed).${snapshot}${prune}`,
      };
    }
    case 'refused':
      return { tone: 'error', text: describeRefusal(result.reason) };
    case 'failed': {
      const state =
        result.dataState === 'unchanged' ? NOTHING_CHANGED
        : result.dataState === 'rolled-back' ? 'Your previous data was restored and verified.'
        : result.dataState === 'changed-elsewhere' ? 'Meanwhile, another tab changed the data, and it was left untouched.'
        : 'Automatic restoration of your previous data was not possible.';
      const where =
        result.stage === 'snapshot-write' || result.stage === 'snapshot-verify'
          ? 'Creating the safety snapshot failed (storage may be full), so the restore was not performed.'
          : result.stage === 'persist'
            ? 'Saving the new data failed, so the restore was not completed.'
            : 'The stored data did not match the expected data, so the restore was not completed.';
      const snapshot = result.snapshotKept ? ` ${SNAPSHOT_KEPT}` : '';
      const reload = result.dataState === 'rollback-failed' || result.dataState === 'changed-elsewhere' ? ' Reload the page and check your data.' : '';
      return { tone: 'error', text: `${where} ${state}${snapshot}${reload}` };
    }
    case 'unverified':
      return {
        tone: 'error',
        text: 'The restore result did not match what was expected, and its success could not be confirmed. Reload the page and check your data.',
      };
    case 'unexpected':
      return {
        tone: 'error',
        text: 'The restore ran into an unexpected error, and the state of storage cannot be verified. Reload the page and check your data.',
      };
  }
}

function describeRefusal(reason: string): string {
  switch (reason) {
    case 'unsaved-changes':
      return 'This tab has changes that have not been saved yet, so nothing was restored. ' + NOTHING_CHANGED;
    case 'conflict':
      return 'Another tab had changed your data, so nothing was restored. The newer data has been loaded; select the file again if you want to.';
    case 'blocked':
      return 'Saving is paused for this session (for example, the stored data is from a newer version), so nothing was restored. ' + NOTHING_CHANGED;
    case 'unavailable':
      return 'Browser storage is unavailable or could not be read, so nothing was restored. ' + NOTHING_CHANGED;
    case 'stored-unreadable':
      return 'The currently stored data cannot be read, so the file cannot be merged into it. Nothing was restored.';
    case 'empty-replace':
      return 'This file has no transactions, and replacing with it would erase all data, so it was not done. ' + NOTHING_CHANGED;
    default:
      return 'The restore was not performed. ' + NOTHING_CHANGED;
  }
}
