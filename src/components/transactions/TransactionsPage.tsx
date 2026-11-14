import { useMemo, useState } from 'react';
import { Inbox, SearchX } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FutureDateNotice } from '@/components/ui/FutureDateNotice';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/formStyles';
import { addDays } from '@/lib/dateRange';
import { isFutureDate, todayISO } from '@/lib/datePolicy';
import {
  DEFAULT_FILTERS,
  filterTransactions,
  paginate,
  sortTransactions,
} from '@/lib/transactionQuery';
import type { SortKey, TransactionFilters as Filters } from '@/lib/transactionQuery';
import { useTransactions } from '@/state/TransactionsContext';
import type { Transaction } from '@/types/transaction';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { Pagination } from './Pagination';
import { TransactionFilters } from './TransactionFilters';
import { TransactionForm } from './TransactionForm';
import { TransactionRow } from './TransactionRow';

/** What the modal layer is currently showing. */
type Dialog =
  | { kind: 'none' }
  | { kind: 'add' }
  | { kind: 'edit'; transaction: Transaction }
  | { kind: 'delete'; transaction: Transaction };

export function TransactionsPage() {
  const { transactions, addTransaction, updateTransaction, deleteTransaction } = useTransactions();

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('date-desc');
  const [requestedPage, setRequestedPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });

  const visible = useMemo(
    () => sortTransactions(filterTransactions(transactions, filters), sort),
    [transactions, filters, sort],
  );
  // paginate() clamps the page, so deleting the last row of the last page can't strand the user
  // on an empty page.
  const page = paginate(visible, requestedPage);

  function changeFilters(next: Filters) {
    setFilters(next);
    setRequestedPage(1);
  }

  function changeSort(next: SortKey) {
    setSort(next);
    setRequestedPage(1);
  }

  function clearFilters() {
    setFilters(DEFAULT_FILTERS);
    setRequestedPage(1);
  }

  const closeDialog = () => setDialog({ kind: 'none' });

  // Future-dated records stay listed (flagged) so they can be corrected; "Show them" filters to
  // everything dated after today.
  const today = todayISO();
  function showFutureDated() {
    const tomorrow = addDays(today, 1);
    if (tomorrow === null) return;
    setFilters({ ...DEFAULT_FILTERS, dateFrom: tomorrow });
    setRequestedPage(1);
  }

  return (
    <div className="space-y-6">
      <TransactionFilters
        filters={filters}
        sort={sort}
        onFiltersChange={changeFilters}
        onSortChange={changeSort}
        onClear={clearFilters}
        onAdd={() => setDialog({ kind: 'add' })}
      />

      <FutureDateNotice onShow={showFutureDated} />

      <Card>
        {transactions.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No transactions yet"
            description="Add your first income or expense to start tracking your finances."
          />
        ) : page.total === 0 ? (
          <div>
            <EmptyState
              icon={SearchX}
              title="No matching transactions"
              description="Try a different search term or adjust your filters."
            />
            <div className="flex justify-center pb-8">
              <button type="button" onClick={clearFilters} className={secondaryButtonClass}>
                Clear filters
              </button>
            </div>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-navy-100 px-5 py-2">
              {page.items.map((transaction) => (
                <TransactionRow
                  key={transaction.id}
                  transaction={transaction}
                  isFuture={isFutureDate(transaction.date, today)}
                  onEdit={(t) => setDialog({ kind: 'edit', transaction: t })}
                  onDelete={(t) => setDialog({ kind: 'delete', transaction: t })}
                />
              ))}
            </ul>
            <Pagination
              page={page.page}
              pageCount={page.pageCount}
              from={page.from}
              to={page.to}
              total={page.total}
              onPageChange={setRequestedPage}
            />
          </>
        )}
        {transactions.length === 0 && (
          <div className="flex justify-center pb-8">
            <button type="button" onClick={() => setDialog({ kind: 'add' })} className={primaryButtonClass}>
              Add transaction
            </button>
          </div>
        )}
      </Card>

      {dialog.kind === 'add' && (
        <TransactionForm
          onCancel={closeDialog}
          onSubmit={(input) => {
            const result = addTransaction(input);
            if (result.ok) closeDialog();
            return result;
          }}
        />
      )}
      {dialog.kind === 'edit' && (
        <TransactionForm
          initial={dialog.transaction}
          onCancel={closeDialog}
          onSubmit={(input) => {
            const result = updateTransaction(dialog.transaction.id, input);
            if (result.ok) closeDialog();
            return result;
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <ConfirmDeleteDialog
          transaction={dialog.transaction}
          onCancel={closeDialog}
          onConfirm={() => {
            deleteTransaction(dialog.transaction.id);
            closeDialog();
          }}
        />
      )}
    </div>
  );
}
