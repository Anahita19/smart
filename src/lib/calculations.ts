import type { Transaction } from '@/types/transaction';

/**
 * Pure functions: no React, no side effects. This keeps the financial logic
 * trivial to unit-test (Phase 5) and reusable across components.
 * All amounts are integer cents.
 */

export interface FinancialSummary {
  totalIncome: number;
  totalExpenses: number;
  /** Income minus expenses. Negative when spending exceeds income. */
  balance: number;
  /** Share of income that was kept (0–1). 0 when there is no income. */
  savingsRate: number;
}

export function calculateSummary(transactions: readonly Transaction[]): FinancialSummary {
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const transaction of transactions) {
    if (transaction.type === 'income') {
      totalIncome += transaction.amount;
    } else {
      totalExpenses += transaction.amount;
    }
  }

  const balance = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? balance / totalIncome : 0;

  return { totalIncome, totalExpenses, balance, savingsRate };
}

export interface CategoryTotal {
  categoryId: string;
  /** Sum of expenses in this category, in cents. */
  total: number;
  /** Share of all expenses (0–1). */
  share: number;
}

/** Groups expenses by category, largest first. Income is ignored. */
export function calculateExpensesByCategory(
  transactions: readonly Transaction[],
): CategoryTotal[] {
  const totals = new Map<string, number>();
  let allExpenses = 0;

  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue;
    totals.set(transaction.categoryId, (totals.get(transaction.categoryId) ?? 0) + transaction.amount);
    allExpenses += transaction.amount;
  }

  return [...totals.entries()]
    .map(([categoryId, total]) => ({
      categoryId,
      total,
      share: allExpenses > 0 ? total / allExpenses : 0,
    }))
    .sort((a, b) => b.total - a.total || a.categoryId.localeCompare(b.categoryId));
}

/** Newest first. Array.sort is stable, so same-day entries keep their input order. */
export function sortByDateDesc<T extends { date: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.date.localeCompare(a.date));
}

export function getRecentTransactions(
  transactions: readonly Transaction[],
  limit = 6,
): Transaction[] {
  return sortByDateDesc(transactions).slice(0, limit);
}
