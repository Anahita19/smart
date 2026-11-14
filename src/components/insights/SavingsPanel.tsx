import { PiggyBank } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatMonthLong, monthKey } from '@/lib/analytics';
import { formatCurrency, formatPercent } from '@/lib/format';
import type { MonthlySavings, PeriodStats } from '@/lib/insights';

interface SavingsPanelProps {
  months: readonly MonthlySavings[];
  stats: PeriodStats;
  /** Today (ISO); the current month is labelled "in progress". */
  asOf: string;
  /** Months ("YYYY-MM") cut off by the range or by today; they are excluded from average/best. */
  partialMonths: ReadonlySet<string>;
}

const signed = (cents: number) => `${cents < 0 ? '−' : ''}${formatCurrency(Math.abs(cents))}`;

/** Monthly income, expenses, savings and savings rate, newest month first. */
export function SavingsPanel({ months, stats, asOf, partialMonths }: SavingsPanelProps) {
  const rows = [...months].reverse();
  const currentMonth = monthKey(asOf);

  return (
    <Card>
      <div className="px-5 pt-5">
        <h2 className="text-base font-semibold text-navy-900">Monthly savings</h2>
        <p className="mt-0.5 text-xs text-navy-500">Savings = income − expenses; rate = savings ÷ income</p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="No months to show"
          description="Monthly savings appear once the period contains transactions."
        />
      ) : (
        <>
          <dl className="grid gap-4 px-5 pt-4 sm:grid-cols-3">
            <Metric label="Total savings" value={signed(stats.savings)} />
            <Metric
              label="Average per month"
              value={stats.averageMonthlySavings === null ? '—' : signed(stats.averageMonthlySavings)}
              hint={stats.excludedPartialMonths > 0 ? 'Complete months only' : undefined}
            />
            <Metric
              label="Best month"
              value={stats.bestMonth ? formatMonthLong(stats.bestMonth.month) : '—'}
              hint={
                stats.bestMonth
                  ? `${signed(stats.bestMonth.savings)}${stats.excludedPartialMonths > 0 ? ' · complete months only' : ''}`
                  : undefined
              }
            />
          </dl>

          <div className="mt-4 overflow-x-auto px-2 pb-4 sm:px-3">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">Income, expenses, savings and savings rate by month</caption>
              <thead>
                <tr className="text-xs text-navy-500">
                  <th scope="col" className="px-3 py-2 text-start font-medium">Month</th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">Income</th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">Expenses</th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">Savings</th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">Savings rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-50">
                {rows.map((m) => {
                  const rate = m.savingsRate;
                  const width = rate === null ? 0 : Math.min(Math.abs(rate), 1) * 100;
                  const negative = m.savings < 0;
                  return (
                    <tr key={m.month}>
                      <th scope="row" className="whitespace-nowrap px-3 py-3 text-start font-medium text-navy-900">
                        {formatMonthLong(m.month)}
                        {partialMonths.has(m.month) && (
                          <span className="ms-2 text-xs font-normal text-navy-400">
                            {m.month === currentMonth ? 'in progress' : 'partial'}
                          </span>
                        )}
                      </th>
                      <td className="px-3 py-3 text-end tabular-nums text-navy-700">{formatCurrency(m.income)}</td>
                      <td className="px-3 py-3 text-end tabular-nums text-navy-700">{formatCurrency(m.expenses)}</td>
                      <td
                        className={`px-3 py-3 text-end font-semibold tabular-nums ${
                          negative ? 'text-rose-600' : 'text-emerald-700'
                        }`}
                      >
                        {signed(m.savings)}
                      </td>
                      <td className="px-3 py-3">
                        {rate === null ? (
                          <span className="text-navy-400">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-navy-50" aria-hidden="true">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${width}%`, backgroundColor: negative ? '#E11D48' : '#2F8F6B' }}
                              />
                            </div>
                            <span className="tabular-nums text-navy-700">
                              {negative ? '−' : ''}
                              {formatPercent(Math.abs(rate))}
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-sand-50 px-4 py-3">
      <dt className="text-xs font-medium text-navy-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-navy-900">{value}</dd>
      {hint && <dd className="text-xs tabular-nums text-navy-500">{hint}</dd>}
    </div>
  );
}
