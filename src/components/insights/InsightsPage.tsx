import { useMemo, useState } from 'react';
import { LineChart, PiggyBank, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { CategoryBreakdown } from '@/components/analytics/CategoryBreakdown';
import { MonthlyChart } from '@/components/analytics/MonthlyChart';
import { StatCard } from '@/components/dashboard/StatCard';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FutureDateNotice } from '@/components/ui/FutureDateNotice';
import { ALL_TIME, resolvePreset, validateRange } from '@/lib/dateRange';
import type { DateRange, RangePreset } from '@/lib/dateRange';
import { formatCurrency, formatDate, formatPercent } from '@/lib/format';
import { buildPeriodAnalysis, changeRatio, sanitizeTransactions } from '@/lib/insights';
import { todayISO } from '@/lib/datePolicy';
import { useTransactions } from '@/state/TransactionsContext';
import { BudgetInsights } from './BudgetInsights';
import { DateRangeFilter } from './DateRangeFilter';
import { SavingsPanel } from './SavingsPanel';
import { TopCategories } from './TopCategories';
import { TrendChart } from './TrendChart';

function describeRange(range: DateRange): string {
  if (range.from === '' && range.to === '') return 'All time';
  if (range.from !== '' && range.to !== '') return `${formatDate(range.from)} – ${formatDate(range.to)}`;
  return range.from !== '' ? `From ${formatDate(range.from)}` : `Until ${formatDate(range.to)}`;
}

/** "▲ 12.4% vs previous period", or the fallback when there is nothing to compare with. */
function deltaHint(current: number, previous: number | null, fallback: string): string {
  if (previous === null) return fallback;
  const change = changeRatio(current, previous);
  if (change === null) {
    // No usable percentage: nothing before ("new"), or a negative baseline (a deficit) where a
    // percentage would be meaningless, so say whether things got better or worse instead.
    if (previous === 0 && current > 0) return 'New vs previous period';
    if (previous < 0 && current !== previous) {
      return `${current > previous ? '▲ Improved' : '▼ Worse'} vs previous period`;
    }
    return fallback;
  }
  const rounded = Math.round(change * 1000) / 1000;
  if (rounded === 0) return 'No change vs previous period';
  return `${rounded > 0 ? '▲' : '▼'} ${formatPercent(Math.abs(rounded))} vs previous period`;
}

function rateHint(current: number | null, previous: number | null | undefined, fallback: string): string {
  if (current === null || previous === null || previous === undefined) return fallback;
  const points = Math.round((current - previous) * 1000) / 10;
  if (points === 0) return 'No change vs previous period';
  return `${points > 0 ? '▲' : '▼'} ${Math.abs(points).toFixed(1)} pts vs previous period`;
}

export function InsightsPage() {
  const { transactions } = useTransactions();
  const [preset, setPreset] = useState<RangePreset>('all');
  const [custom, setCustom] = useState<DateRange>(ALL_TIME);
  // "Today" is read once per render and passed to everything below, so all figures in one render
  // agree with each other AND follow the calendar if the page stays open past midnight (it was
  // previously frozen at mount). It is deliberately not state: the memos depend on the string, so
  // they recompute exactly when the date changes, with no timer needed.
  const today = todayISO();

  const clean = useMemo(() => sanitizeTransactions(transactions), [transactions]);

  const problem = preset === 'custom' ? validateRange(custom) : null;
  // An unusable custom range (reversed or invalid dates) analyses nothing rather than guessing.
  const range: DateRange | null = useMemo(() => {
    if (preset === 'custom') return problem === null ? custom : null;
    return resolvePreset(preset, today);
  }, [preset, custom, problem, today]);

  // One pure pipeline (lib/insights) so every figure uses the same transactions, with anything
  // dated after today left out and the range limited to today.
  const analysis = useMemo(
    () => buildPeriodAnalysis(clean, range, preset, today),
    [clean, range, preset, today],
  );

  const {
    current,
    effectiveRange,
    stats,
    previousStats,
    comparisonMissing,
    monthly,
    savings,
    partialMonths,
    byCategory,
    topCategories,
    trend,
    insights,
  } = analysis;
  // An explicit end date later than today is analysed only up to today, and the label says so.
  const periodLabel =
    range === null
      ? 'Invalid period'
      : describeRange(range.to !== '' && effectiveRange !== null ? effectiveRange : range);

  return (
    <div className="space-y-6">
      <FutureDateNotice />
      <DateRangeFilter
        preset={preset}
        custom={custom}
        problem={problem}
        onPresetChange={setPreset}
        onCustomChange={setCustom}
      />

      {clean.length === 0 ? (
        <Card>
          <EmptyState
            icon={LineChart}
            title="No transactions yet"
            description="Add income and expenses on the Transactions page to unlock trends, savings and spending insights."
          />
        </Card>
      ) : current.length === 0 ? (
        <Card>
          <EmptyState
            icon={LineChart}
            title={range === null ? 'Choose a valid period' : 'No transactions in this period'}
            description={
              range === null
                ? 'Fix the dates above to see your analysis.'
                : 'Try a longer period or a different date range.'
            }
          />
        </Card>
      ) : (
        <>
          <p className="text-sm text-navy-500">
            <span className="font-medium text-navy-900">{periodLabel}</span> ·{' '}
            {stats.transactionCount} {stats.transactionCount === 1 ? 'transaction' : 'transactions'}
          </p>
          {comparisonMissing && (
            <p className="-mt-3 text-xs text-navy-400">
              Comparison with the previous period is hidden because your history does not fully cover it.
            </p>
          )}

          <section aria-label="Period summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              tone="hero"
              label="Net savings"
              value={formatCurrency(stats.savings)}
              icon={Wallet}
              hint={deltaHint(stats.savings, previousStats?.savings ?? null, 'Income minus expenses')}
            />
            <StatCard
              tone="income"
              label="Income"
              value={formatCurrency(stats.totalIncome)}
              icon={TrendingUp}
              hint={deltaHint(stats.totalIncome, previousStats?.totalIncome ?? null, periodLabel)}
            />
            <StatCard
              tone="expense"
              label="Expenses"
              value={formatCurrency(stats.totalExpenses)}
              icon={TrendingDown}
              hint={deltaHint(stats.totalExpenses, previousStats?.totalExpenses ?? null, periodLabel)}
            />
            <StatCard
              tone="neutral"
              label="Savings rate"
              value={stats.savingsRate === null ? '—' : formatPercent(stats.savingsRate)}
              icon={PiggyBank}
              hint={rateHint(stats.savingsRate, previousStats?.savingsRate, 'Share of income kept')}
            />
          </section>

          <BudgetInsights insights={insights} />

          <div className="grid gap-6 xl:grid-cols-2">
            <MonthlyChart months={monthly} />
            <TrendChart trend={trend} />
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <CategoryBreakdown
                totals={byCategory}
                totalExpenses={stats.totalExpenses}
                periodLabel={periodLabel}
              />
            </div>
            <TopCategories categories={topCategories} />
          </div>

          <SavingsPanel months={savings} stats={stats} asOf={today} partialMonths={partialMonths} />
        </>
      )}
    </div>
  );
}
