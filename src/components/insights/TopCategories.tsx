import { ArrowDownRight, ArrowUpRight, PiggyBank } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getCategory } from '@/data/categories';
import { formatCurrency, formatPercent } from '@/lib/format';
import type { TopCategory } from '@/lib/insights';

interface TopCategoriesProps {
  categories: readonly TopCategory[];
}

/** Ranked top spending categories, with the change against the previous period when one exists. */
export function TopCategories({ categories }: TopCategoriesProps) {
  return (
    <Card>
      <div className="px-5 pt-5">
        <h2 className="text-base font-semibold text-navy-900">Top spending categories</h2>
        <p className="mt-0.5 text-xs text-navy-500">Change is compared with the previous period</p>
      </div>

      {categories.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="No expenses in this period"
          description="Your biggest spending categories will appear here."
        />
      ) : (
        <ol className="divide-y divide-navy-50 px-5 pb-3 pt-2">
          {categories.map((entry, index) => {
            const category = getCategory(entry.categoryId);
            const Icon = category.icon;
            return (
              <li key={entry.categoryId} className="flex items-center gap-3 py-3">
                <span className="w-4 shrink-0 text-xs font-semibold tabular-nums text-navy-400">
                  {index + 1}
                </span>
                <span
                  className="grid size-9 shrink-0 place-items-center rounded-xl"
                  style={{ backgroundColor: `${category.color}1A`, color: category.color }}
                >
                  <Icon className="size-[18px]" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-navy-900">{category.name}</p>
                  <p className="text-xs text-navy-500">{formatPercent(entry.share)} of spending</p>
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-sm font-semibold tabular-nums text-navy-900">
                    {formatCurrency(entry.total)}
                  </p>
                  <ChangeChip entry={entry} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function ChangeChip({ entry }: { entry: TopCategory }) {
  if (entry.previousTotal === null) return null;

  if (entry.change === null) {
    // No spending in the previous period: show "New" instead of an undefined percentage.
    return <p className="text-xs text-navy-500">New this period</p>;
  }

  const rounded = Math.round(entry.change * 1000) / 1000;
  if (rounded === 0) return <p className="text-xs text-navy-500">No change</p>;

  // For spending, an increase is the unfavourable direction.
  const up = rounded > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <p className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-rose-600' : 'text-emerald-600'}`}>
      <Arrow className="size-3.5" aria-hidden="true" />
      {formatPercent(Math.abs(rounded))}
      <span className="sr-only">{up ? ' higher' : ' lower'} than the previous period</span>
    </p>
  );
}
