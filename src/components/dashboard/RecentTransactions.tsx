import { Inbox } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getCategory } from '@/data/categories';
import { formatCurrency, formatDate } from '@/lib/format';
import type { Transaction } from '@/types/transaction';

interface RecentTransactionsProps {
  /** Expected to be already sorted and limited by the caller. */
  transactions: readonly Transaction[];
  onViewAll: () => void;
  className?: string;
}

export function RecentTransactions({
  transactions,
  onViewAll,
  className = '',
}: RecentTransactionsProps) {
  return (
    <Card className={className}>
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 className="text-base font-semibold text-navy-900">Recent transactions</h2>
        {transactions.length > 0 && (
          <button
            type="button"
            onClick={onViewAll}
            className="rounded-lg px-2 py-1 text-sm font-medium text-navy-600 transition-colors hover:bg-navy-50 hover:text-navy-900"
          >
            View all
          </button>
        )}
      </div>

      {transactions.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No transactions yet"
          description="Once you add income or expenses, your latest activity will show up here."
        />
      ) : (
        <ul className="divide-y divide-navy-100 px-5 pb-2 pt-1">
          {transactions.map((transaction) => {
            const category = getCategory(transaction.categoryId);
            const Icon = category.icon;
            const isIncome = transaction.type === 'income';

            return (
              <li key={transaction.id} className="flex items-center gap-3 py-3">
                <span
                  className="grid size-10 shrink-0 place-items-center rounded-xl"
                  style={{ backgroundColor: `${category.color}1A`, color: category.color }}
                >
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-navy-900">
                    {transaction.description}
                  </p>
                  <p className="truncate text-xs text-navy-500">
                    {category.name} · {formatDate(transaction.date)}
                  </p>
                </div>
                <p
                  className={`shrink-0 text-sm font-semibold tabular-nums ${
                    isIncome ? 'text-emerald-600' : 'text-navy-900'
                  }`}
                >
                  {isIncome ? '+' : '−'}
                  {formatCurrency(transaction.amount)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
