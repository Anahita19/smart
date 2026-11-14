import { useMemo, useState } from 'react';
import { PiggyBank, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { StatCard } from '@/components/dashboard/StatCard';
import { FutureDateNotice } from '@/components/ui/FutureDateNotice';
import { inputClass } from '@/components/ui/formStyles';
import {
  availableMonths,
  calculateMonthlyTotals,
  filterByMonth,
  formatMonthLong,
} from '@/lib/analytics';
import { calculateExpensesByCategory, calculateSummary } from '@/lib/calculations';
import { formatCurrency, formatPercent } from '@/lib/format';
import { useActualTransactions } from '@/state/TransactionsContext';
import { CategoryBreakdown } from './CategoryBreakdown';
import { MonthlyChart } from './MonthlyChart';

/** Number of most recent months shown in the trend chart. */
const CHART_MONTHS = 12;

export function AnalyticsPage() {
  // Actual transactions only (dated today or earlier): future-dated ones never reach any figure or
  // chart here, so an extreme date such as 2099 cannot push recent months out of the chart.
  const transactions = useActualTransactions();
  const [selectedMonth, setSelectedMonth] = useState('all');

  const months = useMemo(() => availableMonths(transactions), [transactions]);
  // If the selected month's data was deleted, quietly fall back to "all".
  const period = months.includes(selectedMonth) ? selectedMonth : 'all';

  const monthly = useMemo(() => calculateMonthlyTotals(transactions, CHART_MONTHS), [transactions]);
  const periodTransactions = useMemo(() => filterByMonth(transactions, period), [transactions, period]);
  const summary = useMemo(() => calculateSummary(periodTransactions), [periodTransactions]);
  const byCategory = useMemo(() => calculateExpensesByCategory(periodTransactions), [periodTransactions]);

  const periodLabel = period === 'all' ? 'All time' : formatMonthLong(period);

  return (
    <div className="space-y-6">
      <FutureDateNotice />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-navy-500">
          Showing figures for <span className="font-medium text-navy-900">{periodLabel}</span>
        </p>
        <div className="w-full sm:w-56">
          <label htmlFor="analytics-period" className="mb-1 block text-xs font-medium text-navy-500">
            Period
          </label>
          <select
            id="analytics-period"
            value={period}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className={inputClass}
          >
            <option value="all">All time</option>
            {months.map((month) => (
              <option key={month} value={month}>
                {formatMonthLong(month)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section aria-label="Period summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          tone="hero"
          label="Net balance"
          value={formatCurrency(summary.balance)}
          icon={Wallet}
          hint="Income minus expenses"
        />
        <StatCard
          tone="income"
          label="Income"
          value={formatCurrency(summary.totalIncome)}
          icon={TrendingUp}
          hint={periodLabel}
        />
        <StatCard
          tone="expense"
          label="Expenses"
          value={formatCurrency(summary.totalExpenses)}
          icon={TrendingDown}
          hint={periodLabel}
        />
        <StatCard
          tone="neutral"
          label="Savings rate"
          value={formatPercent(summary.savingsRate)}
          icon={PiggyBank}
          hint="Share of income kept"
        />
      </section>

      <MonthlyChart months={monthly} />
      <CategoryBreakdown
        totals={byCategory}
        totalExpenses={summary.totalExpenses}
        periodLabel={periodLabel}
      />
    </div>
  );
}
