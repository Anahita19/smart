import { PiggyBank } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getCategory } from '@/data/categories';
import type { CategoryTotal } from '@/lib/calculations';
import { formatCurrency, formatPercent } from '@/lib/format';

interface SpendingByCategoryProps {
  /** Expected to be sorted largest-first and limited by the caller. */
  totals: readonly CategoryTotal[];
  className?: string;
}

/** Compact "top categories" list with proportional bars. Full charts arrive in the analytics phase. */
export function SpendingByCategory({ totals, className = '' }: SpendingByCategoryProps) {
  return (
    <Card className={className}>
      <h2 className="px-5 pt-5 text-base font-semibold text-navy-900">Top spending categories</h2>

      {totals.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="No expenses yet"
          description="Your biggest spending categories will appear here."
        />
      ) : (
        <ul className="space-y-4 px-5 pb-6 pt-4">
          {totals.map(({ categoryId, total, share }) => {
            const category = getCategory(categoryId);
            const Icon = category.icon;

            return (
              <li key={categoryId}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-navy-900">
                    <Icon
                      className="size-4 shrink-0"
                      style={{ color: category.color }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{category.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-navy-600">
                    {formatCurrency(total)}
                    <span className="ml-2 text-xs text-navy-400">{formatPercent(share)}</span>
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-navy-50" aria-hidden="true">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${share * 100}%`, backgroundColor: category.color }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
