import { CalendarClock, Pencil, Trash2 } from 'lucide-react';
import { getCategory } from '@/data/categories';
import { formatCurrency, formatDate } from '@/lib/format';
import type { Transaction } from '@/types/transaction';

interface TransactionRowProps {
  transaction: Transaction;
  /** Dated after today: shown here, but not counted anywhere else (see lib/datePolicy). */
  isFuture?: boolean;
  onEdit: (transaction: Transaction) => void;
  onDelete: (transaction: Transaction) => void;
}

const actionClass =
  'grid size-9 place-items-center rounded-lg text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-900';

/** Same visual language as the dashboard's recent-transactions rows, plus edit/delete actions. */
export function TransactionRow({ transaction, isFuture = false, onEdit, onDelete }: TransactionRowProps) {
  const category = getCategory(transaction.categoryId);
  const Icon = category.icon;
  const isIncome = transaction.type === 'income';

  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className="grid size-10 shrink-0 place-items-center rounded-xl"
        style={{ backgroundColor: `${category.color}1A`, color: category.color }}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-navy-900">{transaction.description}</p>
        <p className="truncate text-xs text-navy-500">
          {category.name} · {formatDate(transaction.date)}
        </p>
        {isFuture && (
          <p className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
            <CalendarClock className="size-3" aria-hidden="true" />
            Future date — not counted. Edit the date to include it.
          </p>
        )}
      </div>
      <p
        className={`shrink-0 text-sm font-semibold tabular-nums ${
          isIncome ? 'text-emerald-600' : 'text-navy-900'
        }`}
      >
        {isIncome ? '+' : '−'}
        {formatCurrency(transaction.amount)}
      </p>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => onEdit(transaction)}
          aria-label={`Edit ${transaction.description}`}
          className={actionClass}
        >
          <Pencil className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(transaction)}
          aria-label={`Delete ${transaction.description}`}
          className={`${actionClass} hover:!bg-rose-50 hover:!text-rose-600`}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
