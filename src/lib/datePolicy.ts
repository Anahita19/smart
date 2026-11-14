import { parseISODate } from '@/lib/format';
import type { Transaction } from '@/types/transaction';

/**
 * The application's single date policy.
 *
 * This version has no scheduled transactions, so a transaction dated AFTER today is not an actual
 * financial event. Everything that needs to know "is this date in the future?" goes through this
 * module — the form validation, the Dashboard, Analytics, Insights and the Transactions page flag —
 * so they can never disagree. There are no other date cut-offs for transactions.
 *
 *  - Today is the local calendar date (not UTC).
 *  - A transaction dated today is actual; a transaction dated tomorrow or later is "future".
 *  - The rule is enforced twice: the form shows a friendly message, and the central write path
 *    (`checkTransactionDate`, used by the context's add/update and by the reducer) refuses any new
 *    or updated transaction whose date is invalid or after today, so no caller can bypass the form.
 *    Delete is never blocked, and loading stored data does not go through this check.
 *  - Future-dated records are never deleted or rewritten: they stay in storage and on the
 *    Transactions page (flagged), but are left out of every balance, total, chart and analysis.
 *
 * Pure functions only; `today` is injectable so behaviour is deterministic in tests.
 */

/** Today as a local YYYY-MM-DD string (not UTC). */
export function todayISO(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Shown by the transaction form when the chosen date is after today. */
export const FUTURE_DATE_MESSAGE =
  'Date can’t be in the future. Scheduled transactions aren’t supported — choose today or an earlier date.';

/** Shown when a date is not a real calendar date (YYYY-MM-DD). */
export const INVALID_DATE_MESSAGE = 'Enter a valid date.';

/** True when `date` (YYYY-MM-DD) is after `today`. ISO dates compare correctly as plain strings. */
export function isFutureDate(date: string, today: string = todayISO()): boolean {
  return date > today;
}

/** Transactions that count as real: dated today or earlier. Returns a new array. */
export function actualTransactions<T extends { date: string }>(
  transactions: readonly T[],
  today: string = todayISO(),
): T[] {
  return transactions.filter((t) => !isFutureDate(t.date, today));
}

/** Transactions dated after today (the ones the policy leaves out). Returns a new array. */
export function futureTransactions<T extends { date: string }>(
  transactions: readonly T[],
  today: string = todayISO(),
): T[] {
  return transactions.filter((t) => isFutureDate(t.date, today));
}

/** Convenience for callers that only need to know whether a transaction is excluded. */
export const isFutureTransaction = (t: Pick<Transaction, 'date'>, today: string = todayISO()): boolean =>
  isFutureDate(t.date, today);

export type DateCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'future'; message: string };

/**
 * The write-side rule for a transaction's date: it must be a real calendar date and not after
 * `today`. Used by every code path that creates or changes a transaction. It looks only at the NEW
 * date, so an existing future-dated record can always be edited to today or an earlier date, while
 * saving it with a future date is refused just like adding one.
 */
export function checkTransactionDate(date: string, today: string = todayISO()): DateCheck {
  if (parseISODate(date) === null) return { ok: false, reason: 'invalid', message: INVALID_DATE_MESSAGE };
  if (isFutureDate(date, today)) return { ok: false, reason: 'future', message: FUTURE_DATE_MESSAGE };
  return { ok: true };
}
