export type TransactionType = 'income' | 'expense';

/** Outcome of an add/update. `message` is user-presentable. Delete never fails, so it has no result. */
export type TransactionWriteResult = { ok: true } | { ok: false; message: string };

/**
 * A single income or expense entry.
 *
 * - `amount` is always positive; the sign is implied by `type`.
 * - `amount` is stored as an integer number of minor units (cents) so that
 *   sums never suffer from floating-point rounding errors.
 */
export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  categoryId: string;
  description: string;
  /** Calendar date in ISO format (YYYY-MM-DD). */
  date: string;
}
