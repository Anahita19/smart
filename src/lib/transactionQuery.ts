import { getCategory } from '@/data/categories';
import type { Transaction, TransactionType } from '@/types/transaction';

export type SortKey = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc';

export interface TransactionFilters {
  search: string;
  type: TransactionType | 'all';
  /** Category id or 'all'. */
  categoryId: string;
  /** Inclusive ISO bounds; empty string = unbounded. */
  dateFrom: string;
  dateTo: string;
}

export const DEFAULT_FILTERS: TransactionFilters = {
  search: '',
  type: 'all',
  categoryId: 'all',
  dateFrom: '',
  dateTo: '',
};

export const PAGE_SIZE = 10;

export function hasActiveFilters(filters: TransactionFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.type !== 'all' ||
    filters.categoryId !== 'all' ||
    filters.dateFrom !== '' ||
    filters.dateTo !== ''
  );
}

export function filterTransactions(
  transactions: readonly Transaction[],
  filters: TransactionFilters,
): Transaction[] {
  const query = filters.search.trim().toLowerCase();

  return transactions.filter((t) => {
    if (filters.type !== 'all' && t.type !== filters.type) return false;
    if (filters.categoryId !== 'all' && t.categoryId !== filters.categoryId) return false;
    if (filters.dateFrom !== '' && t.date < filters.dateFrom) return false;
    if (filters.dateTo !== '' && t.date > filters.dateTo) return false;
    if (query !== '') {
      const haystack = `${t.description} ${getCategory(t.categoryId).name}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** Sorts a copy. Ties are broken deterministically so pagination never reshuffles rows. */
export function sortTransactions(
  transactions: readonly Transaction[],
  sort: SortKey,
): Transaction[] {
  const byId = (a: Transaction, b: Transaction) => a.id.localeCompare(b.id);
  const comparators: Record<SortKey, (a: Transaction, b: Transaction) => number> = {
    'date-desc': (a, b) => b.date.localeCompare(a.date) || b.amount - a.amount || byId(a, b),
    'date-asc': (a, b) => a.date.localeCompare(b.date) || a.amount - b.amount || byId(a, b),
    'amount-desc': (a, b) => b.amount - a.amount || b.date.localeCompare(a.date) || byId(a, b),
    'amount-asc': (a, b) => a.amount - b.amount || b.date.localeCompare(a.date) || byId(a, b),
  };
  return [...transactions].sort(comparators[sort]);
}

export interface Page<T> {
  items: T[];
  /** Current page, clamped to the valid range (1-based). */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based index of first/last item shown (0 when empty). */
  from: number;
  to: number;
}

export function paginate<T>(items: readonly T[], requestedPage: number, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
