import { CalendarClock } from 'lucide-react';
import { futureTransactions, todayISO } from '@/lib/datePolicy';
import { useTransactions } from '@/state/TransactionsContext';

interface FutureDateNoticeProps {
  /** When given, shows a button that lets the person jump to the affected transactions. */
  onShow?: () => void;
}

/**
 * Tells the person that some transactions are dated after today and therefore left out of every
 * balance, total and chart. Renders nothing when there are none. The wording is shared so all
 * screens explain the same rule (see lib/datePolicy).
 */
export function FutureDateNotice({ onShow }: FutureDateNoticeProps) {
  const { transactions } = useTransactions();
  const count = futureTransactions(transactions, todayISO()).length;
  if (count === 0) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
    >
      <CalendarClock className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          {count} {count === 1 ? 'transaction has' : 'transactions have'} a future date.
        </span>{' '}
        Scheduled transactions aren’t supported, so {count === 1 ? 'it is' : 'they are'} not counted in
        balances, the Dashboard, Analytics or Insights. Edit the date on the Transactions page to include{' '}
        {count === 1 ? 'it' : 'them'}.
      </p>
      {onShow && (
        <button
          type="button"
          onClick={onShow}
          className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-amber-900 ring-1 ring-amber-300 transition-colors hover:bg-amber-100"
        >
          Show them
        </button>
      )}
    </div>
  );
}
