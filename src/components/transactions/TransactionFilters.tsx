import { Plus, Search, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/formStyles';
import { categories } from '@/data/categories';
import { hasActiveFilters } from '@/lib/transactionQuery';
import type { SortKey, TransactionFilters as Filters } from '@/lib/transactionQuery';

interface TransactionFiltersProps {
  filters: Filters;
  sort: SortKey;
  onFiltersChange: (filters: Filters) => void;
  onSortChange: (sort: SortKey) => void;
  onClear: () => void;
  onAdd: () => void;
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'amount-desc', label: 'Amount: high to low' },
  { value: 'amount-asc', label: 'Amount: low to high' },
];

const labelClass = 'mb-1 block text-xs font-medium text-navy-500';

export function TransactionFilters({
  filters,
  sort,
  onFiltersChange,
  onSortChange,
  onClear,
  onAdd,
}: TransactionFiltersProps) {
  const patch = (changes: Partial<Filters>) => onFiltersChange({ ...filters, ...changes });
  const active = hasActiveFilters(filters);
  const incomeCategories = categories.filter((c) => c.type === 'income');
  const expenseCategories = categories.filter((c) => c.type === 'expense');

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-navy-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Search description or category"
            aria-label="Search transactions"
            className={`${inputClass} pl-9`}
          />
        </div>
        <button type="button" onClick={onAdd} className={primaryButtonClass}>
          <Plus className="size-4" aria-hidden="true" />
          Add transaction
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor="filter-type" className={labelClass}>
            Type
          </label>
          <select
            id="filter-type"
            value={filters.type}
            onChange={(e) => {
              const type = e.target.value as Filters['type'];
              // Drop a category filter that can no longer match the chosen type.
              const category = categories.find((c) => c.id === filters.categoryId);
              const clearCategory = type !== 'all' && category !== undefined && category.type !== type;
              patch({ type, ...(clearCategory ? { categoryId: 'all' } : {}) });
            }}
            className={inputClass}
          >
            <option value="all">All types</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>

        <div>
          <label htmlFor="filter-category" className={labelClass}>
            Category
          </label>
          <select
            id="filter-category"
            value={filters.categoryId}
            onChange={(e) => patch({ categoryId: e.target.value })}
            className={inputClass}
          >
            <option value="all">All categories</option>
            {filters.type !== 'expense' && (
              <optgroup label="Income">
                {incomeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            {filters.type !== 'income' && (
              <optgroup label="Expenses">
                {expenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div>
          <label htmlFor="filter-from" className={labelClass}>
            From
          </label>
          <input
            id="filter-from"
            type="date"
            value={filters.dateFrom}
            max={filters.dateTo || undefined}
            onChange={(e) => patch({ dateFrom: e.target.value })}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="filter-to" className={labelClass}>
            To
          </label>
          <input
            id="filter-to"
            type="date"
            value={filters.dateTo}
            min={filters.dateFrom || undefined}
            onChange={(e) => patch({ dateTo: e.target.value })}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="sort" className={labelClass}>
            Sort by
          </label>
          <select
            id="sort"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortKey)}
            className={inputClass}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {active && (
        <div className="mt-4">
          <button type="button" onClick={onClear} className={`${secondaryButtonClass} !py-1.5`}>
            <X className="size-4" aria-hidden="true" />
            Clear filters
          </button>
        </div>
      )}
    </Card>
  );
}
