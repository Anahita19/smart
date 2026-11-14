/**
 * Decides whether the page may be reloaded to apply a service-worker update. Kept free of React and
 * of the DOM so it can be tested without a browser. A reload throws away everything that lives only
 * in memory, so it is refused whenever that could cost the person data:
 *  - a save failed or is blocked, so recent changes exist only on this page;
 *  - changes have not reached storage yet;
 *  - the storage session reports that this page's data cannot be recovered from storage (removed or
 *    overwritten by another tab, a restore that did not complete). That verdict is session state:
 *    notices, dismissals and `persistenceOk` cannot clear it;
 *  - an import/restore is in progress;
 *  - a transaction form holds edits that have not been submitted.
 * It never changes how data is saved or restored; it only reads state the app already tracks.
 */
import type { DiscardHazard } from '@/lib/storage';

export type ReloadActivityKind = 'restore-in-progress' | 'draft-open';

export type ReloadBlockReason =
  | 'save-failed'
  | 'unsaved-changes'
  | 'removed-elsewhere'
  | 'external-unreadable'
  | 'unsupported-version'
  | 'restore-incomplete'
  | 'restore-in-progress'
  | 'draft-open';

export interface ReloadBlock {
  reason: ReloadBlockReason;
  /** Plain-language explanation for the person; contains no transaction data. */
  message: string;
}

export interface ReloadSafetyInput {
  /** False after the browser refused a save (the provider's `persistenceOk`). */
  persistenceOk: boolean;
  /** State that storage does not hold yet: a pending, failed or blocked save (the provider's `hasUnsavedChanges`). */
  hasUnsavedChanges: boolean;
  /**
   * The storage session's own verdict (`StorageSession.getDiscardHazard`): why this page's data
   * cannot be recovered by re-reading storage, or null. Deliberately NOT derived from any notice.
   */
  storageHazard: DiscardHazard | null;
  /** Screens currently holding work that a reload would discard. */
  activities: readonly ReloadActivityKind[];
}

const MESSAGES: Record<ReloadBlockReason, string> = {
  'save-failed':
    'Update paused: your latest changes could not be saved to this browser and exist only on this page. Reloading now would lose them.',
  'unsaved-changes':
    'Update paused: recent changes are not saved to this browser yet (saving may be paused). Reloading now could lose them.',
  'removed-elsewhere':
    'Update paused: your saved data was removed in another tab, so what is on this page is not saved anywhere. Reloading now would lose it.',
  'external-unreadable':
    'Update paused: another tab saved data this page cannot read, so what is on this page is not saved. Reloading now could lose it.',
  'unsupported-version':
    'Update paused: another tab saved data in a newer format, so what is on this page is not saved. Reloading now could lose it.',
  'restore-incomplete':
    'Update paused: the last restore did not finish, so this page and your saved data may not match. Dismissing the notice does not change that.',
  'restore-in-progress':
    'Update paused: an import or restore is in progress. Finish or cancel it first.',
  'draft-open':
    'Update paused: a transaction form has changes you have not saved. Save or cancel it first.',
};

/** Returns why a reload is unsafe right now, or null when it is safe. Data-loss reasons come first. */
export function evaluateReloadSafety(input: ReloadSafetyInput): ReloadBlock | null {
  const block = (reason: ReloadBlockReason): ReloadBlock => ({ reason, message: MESSAGES[reason] });
  if (!input.persistenceOk) return block('save-failed');
  if (input.hasUnsavedChanges) return block('unsaved-changes');
  if (input.storageHazard !== null) return block(input.storageHazard);
  if (input.activities.includes('restore-in-progress')) return block('restore-in-progress');
  if (input.activities.includes('draft-open')) return block('draft-open');
  return null;
}

/**
 * The callback handed to the update lifecycle as its `reload`. It runs when the new worker has taken
 * control, which can be some time after the click, so safety is checked again at that moment: if the
 * page became unsafe in between, it does not reload and reports the deferral instead.
 */
export function createGuardedReload(options: {
  getBlock: () => ReloadBlock | null;
  reload: () => void;
  onDeferred: () => void;
}): () => void {
  return () => {
    if (options.getBlock() !== null) {
      options.onDeferred();
      return;
    }
    options.reload();
  };
}

// ───────────── registry of screens holding unsaved work ─────────────

let activities: readonly ReloadActivityKind[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly ReloadActivityKind[]): void {
  activities = next;
  listeners.forEach((listener) => listener());
}

/** Marks work that a reload would discard; call the returned function when it ends. */
export function registerReloadActivity(kind: ReloadActivityKind): () => void {
  publish([...activities, kind]);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = activities.indexOf(kind);
    if (index === -1) return;
    publish([...activities.slice(0, index), ...activities.slice(index + 1)]);
  };
}

/** A stable snapshot (the same array until something changes), as `useSyncExternalStore` needs. */
export function getReloadActivities(): readonly ReloadActivityKind[] {
  return activities;
}

export function subscribeReloadActivities(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
