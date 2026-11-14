import { useMemo } from 'react';
import { PiggyBank, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import {
  calculateExpensesByCategory,
  calculateSummary,
  getRecentTransactions,
} from '@/lib/calculations';
import { FutureDateNotice } from '@/components/ui/FutureDateNotice';
import { formatCurrency, formatPercent } from '@/lib/format';
import type { Transaction } from '@/types/transaction';
import { RecentTransactions } from './RecentTransactions';
import { SpendingByCategory } from './SpendingByCategory';
import { StatCard } from './StatCard';

interface DashboardProps {
  transactions: readonly Transaction[];
  onViewAllTransactions: () => void;
}

export function Dashboard({ transactions, onViewAllTransactions }: DashboardProps) {
  const summary = useMemo(() => calculateSummary(transactions), [transactions]);
  const recent = useMemo(() => getRecentTransactions(transactions, 6), [transactions]);
  const topCategories = useMemo(
    () => calculateExpensesByCategory(transactions).slice(0, 5),
    [transactions],
  );

  return (
    <div className="space-y-6">
      <FutureDateNotice />
      <section aria-label="Financial summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          tone="hero"
          label="Total balance"
          value={formatCurrency(summary.balance)}
          icon={Wallet}
          hint="Income minus expenses"
        />
        <StatCard
          tone="income"
          label="Total income"
          value={formatCurrency(summary.totalIncome)}
          icon={TrendingUp}
          hint="All recorded income"
        />
        <StatCard
          tone="expense"
          label="Total expenses"
          value={formatCurrency(summary.totalExpenses)}
          icon={TrendingDown}
          hint="All recorded expenses"
        />
        <StatCard
          tone="neutral"
          label="Savings rate"
          value={formatPercent(summary.savingsRate)}
          icon={PiggyBank}
          hint="Share of income kept"
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        <RecentTransactions
          className="xl:col-span-2"
          transactions={recent}
          onViewAll={onViewAllTransactions}
        />
        <SpendingByCategory totals={topCategories} />
      </div>
    </div>
  );
}
