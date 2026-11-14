import { checkTransactionDate } from '@/lib/datePolicy';
import type { Transaction } from '@/types/transaction';

/**
 * `today` is stamped on add/update actions by the provider at dispatch time (the reducer itself
 * stays pure); when omitted the local calendar date is used. See lib/datePolicy.
 */
export type TransactionAction =
  | { type: 'add'; transaction: Transaction; today?: string }
  | { type: 'update'; transaction: Transaction; today?: string }
  | { type: 'delete'; id: string }
  /**
   * Swaps in the list read back from storage after another tab changed it. This is the load path,
   * not a user write: like loading at startup it keeps stored records as they are (including
   * future-dated ones). Only the provider dispatches it; it is not part of the context API.
   */
  | { type: 'replace'; transactions: Transaction[] };

/**
 * The last line of defence for the date rule: an add or update whose date is invalid or after
 * today is ignored (the SAME state reference is returned, so nothing re-renders or persists).
 * Existing records are never touched here, so future-dated ones survive until the user edits or
 * deletes them; an update that moves one to a valid date is accepted.
 */
export function transactionsReducer(
  state: readonly Transaction[],
  action: TransactionAction,
): Transaction[] {
  switch (action.type) {
    case 'add':
      if (!checkTransactionDate(action.transaction.date, action.today).ok) return state as Transaction[];
      return [action.transaction, ...state];
    case 'update':
      if (!checkTransactionDate(action.transaction.date, action.today).ok) return state as Transaction[];
      return state.map((t) => (t.id === action.transaction.id ? action.transaction : t));
    case 'delete':
      return state.filter((t) => t.id !== action.id);
    case 'replace':
      return action.transactions;
  }
}

/** Collision-resistant id; falls back when crypto.randomUUID is unavailable (e.g. insecure http). */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `tx-${crypto.randomUUID()}`;
  }
  return `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
