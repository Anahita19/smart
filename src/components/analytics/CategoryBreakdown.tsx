import { PieChart } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getCategory } from '@/data/categories';
import type { CategoryTotal } from '@/lib/calculations';
import { formatCurrency, formatPercent } from '@/lib/format';

interface CategoryBreakdownProps {
  totals: readonly CategoryTotal[];
  totalExpenses: number;
  /** Human-readable period, e.g. "October 2026" or "All time". */
  periodLabel: string;
}

const SIZE = 160;
const STROKE = 26;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function CategoryBreakdown({ totals, totalExpenses, periodLabel }: CategoryBreakdownProps) {
  return (
    <Card>
      <div className="px-5 pt-5">
        <h2 className="text-base font-semibold text-navy-900">Spending by category</h2>
        <p className="mt-0.5 text-xs text-navy-500">{periodLabel}</p>
      </div>

      {totals.length === 0 ? (
        <EmptyState
          icon={PieChart}
          title="No expenses in this period"
          description="Pick another period, or add an expense to see the breakdown."
        />
      ) : (
        <div className="grid gap-6 px-5 pb-6 pt-5 md:grid-cols-[auto_1fr] md:items-center">
          <Donut totals={totals} totalExpenses={totalExpenses} />
          <ul className="space-y-4">
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
        </div>
      )}
    </Card>
  );
}

function Donut({ totals, totalExpenses }: { totals: readonly CategoryTotal[]; totalExpenses: number }) {
  let offset = 0;
  return (
    <div className="relative mx-auto size-40 shrink-0">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-full -rotate-90" aria-hidden="true">
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="#F1F4F9"
          strokeWidth={STROKE}
        />
        {totals.map(({ categoryId, share }) => {
          const length = share * CIRCUMFERENCE;
          const circle = (
            <circle
              key={categoryId}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={getCategory(categoryId).color}
              strokeWidth={STROKE}
              strokeDasharray={`${Math.max(length - 1, 0)} ${CIRCUMFERENCE}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return circle;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-xs text-navy-500">Total spent</span>
        <span className="text-base font-semibold tabular-nums text-navy-900">
          {formatCurrency(totalExpenses)}
        </span>
      </div>
    </div>
  );
}
