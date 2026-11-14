import { BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatCompactCurrency, formatMonthLong, formatMonthShort, niceAxis } from '@/lib/analytics';
import type { MonthlyTotal } from '@/lib/analytics';
import { formatCurrency } from '@/lib/format';

interface MonthlyChartProps {
  months: readonly MonthlyTotal[];
}

const INCOME_COLOR = '#2F8F6B';
const EXPENSE_COLOR = '#2A3A56';

const HEIGHT = 280;
const PAD = { top: 16, right: 12, bottom: 32, left: 52 };
const GROUP_WIDTH = 64;

/**
 * Hand-built SVG grouped bar chart (income vs expenses per month). No chart dependency needed
 * for this single chart type; the data table below it keeps the numbers available to screen readers.
 */
export function MonthlyChart({ months }: MonthlyChartProps) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <h2 className="text-base font-semibold text-navy-900">Income vs expenses</h2>
        <ul className="flex items-center gap-4 text-xs text-navy-500" aria-label="Legend">
          <LegendItem color={INCOME_COLOR} label="Income" />
          <LegendItem color={EXPENSE_COLOR} label="Expenses" />
        </ul>
      </div>

      {months.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No data to chart yet"
          description="Add a few transactions and your monthly trends will appear here."
        />
      ) : (
        <ChartBody months={months} />
      )}
    </Card>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
    </li>
  );
}

function ChartBody({ months }: MonthlyChartProps) {
  const maxValue = Math.max(...months.flatMap((m) => [m.income, m.expenses]));
  const { max, ticks } = niceAxis(maxValue);

  const plotWidth = months.length * GROUP_WIDTH;
  const width = PAD.left + plotWidth + PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const y = (value: number) => PAD.top + plotHeight - (value / max) * plotHeight;
  const barWidth = 18;
  const barGap = 4;

  return (
    <div className="px-2 pb-4 pt-2 sm:px-3">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label="Grouped bar chart of income and expenses for each month"
          className="h-auto w-full"
          style={{ minWidth: Math.min(width, 520) }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="#E1E7F0"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fill="#6B82A8"
              >
                {formatCompactCurrency(tick)}
              </text>
            </g>
          ))}

          {months.map((m, index) => {
            const center = PAD.left + index * GROUP_WIDTH + GROUP_WIDTH / 2;
            const incomeX = center - barGap / 2 - barWidth;
            const expenseX = center + barGap / 2;
            const baseline = y(0);
            return (
              <g key={m.month}>
                <title>
                  {`${formatMonthLong(m.month)}: income ${formatCurrency(m.income)}, expenses ${formatCurrency(
                    m.expenses,
                  )}`}
                </title>
                <rect
                  x={incomeX}
                  y={y(m.income)}
                  width={barWidth}
                  height={baseline - y(m.income)}
                  rx={3}
                  fill={INCOME_COLOR}
                />
                <rect
                  x={expenseX}
                  y={y(m.expenses)}
                  width={barWidth}
                  height={baseline - y(m.expenses)}
                  rx={3}
                  fill={EXPENSE_COLOR}
                />
                <text
                  x={center}
                  y={HEIGHT - 10}
                  textAnchor="middle"
                  fontSize={12}
                  fill="#4A6188"
                >
                  {formatMonthShort(m.month)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <table className="sr-only">
        <caption>Monthly income and expenses</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Income</th>
            <th scope="col">Expenses</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{formatMonthLong(m.month)}</th>
              <td>{formatCurrency(m.income)}</td>
              <td>{formatCurrency(m.expenses)}</td>
              <td>{formatCurrency(m.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
