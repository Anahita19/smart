import { LineChart } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatCompactCurrency, niceAxis } from '@/lib/analytics';
import { formatCurrency, formatDate, formatPercent, parseISODate } from '@/lib/format';
import type { Granularity, SpendingTrend, TrendPoint } from '@/lib/insights';

interface TrendChartProps {
  trend: SpendingTrend;
}

const LINE_COLOR = '#2A3A56';
const AVERAGE_COLOR = '#C39A3E';

const HEIGHT = 260;
const PAD = { top: 16, right: 12, bottom: 32, left: 52 };
const SPACING: Record<Granularity, number> = { day: 26, week: 48, month: 64 };

const GRANULARITY_LABEL: Record<Granularity, string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};

const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short' });
const shortMonthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function pointLabel(point: TrendPoint, granularity: Granularity): string {
  const date = parseISODate(point.start);
  if (!date) return point.start;
  return granularity === 'month' ? shortMonth.format(date) : shortMonthDay.format(date);
}

function pointTitle(point: TrendPoint, granularity: Granularity): string {
  const period =
    granularity === 'day'
      ? formatDate(point.start)
      : granularity === 'week'
        ? `Week of ${formatDate(point.start)}`
        : `${pointLabel(point, 'month')} ${point.start.slice(0, 4)}`;
  return `${period}: expenses ${formatCurrency(point.expenses)}${point.partial ? ' (period in progress)' : ''}`;
}

/**
 * Spending over time as a hand-built SVG line/area chart (no chart dependency). The plot is
 * always left-to-right because time axes read left to right.
 */
export function TrendChart({ trend }: TrendChartProps) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="text-base font-semibold text-navy-900">Spending trend</h2>
          {trend.points.length > 0 && (
            <p className="mt-0.5 text-xs text-navy-500">
              Expenses per {trend.granularity} · {GRANULARITY_LABEL[trend.granularity]} view
            </p>
          )}
        </div>
        {trend.points.length > 0 && <DirectionBadge trend={trend} />}
      </div>

      {trend.points.length === 0 ? (
        <EmptyState
          icon={LineChart}
          title="No spending to chart"
          description="Pick a period that contains expenses to see how your spending changes over time."
        />
      ) : (
        <ChartBody trend={trend} />
      )}
    </Card>
  );
}

function DirectionBadge({ trend }: TrendChartProps) {
  const { direction, directionChange } = trend;
  if (direction === 'insufficient') {
    return (
      <span className="rounded-full bg-navy-50 px-3 py-1 text-xs font-medium text-navy-500">
        Not enough complete periods for a trend
      </span>
    );
  }
  const pct = directionChange === null ? '' : ` ${formatPercent(Math.abs(directionChange))}`;
  const styles = {
    up: 'bg-rose-50 text-rose-700',
    down: 'bg-emerald-50 text-emerald-700',
    flat: 'bg-navy-50 text-navy-600',
  }[direction];
  const text = {
    up: `Trending up${pct}`,
    down: `Trending down${pct}`,
    flat: 'Holding steady',
  }[direction];
  return <span className={`rounded-full px-3 py-1 text-xs font-medium ${styles}`}>{text}</span>;
}

function ChartBody({ trend }: TrendChartProps) {
  const { points, granularity } = trend;
  const spacing = SPACING[granularity];
  const maxValue = Math.max(...points.map((p) => Math.max(p.expenses, p.movingAverage ?? 0)));
  const { max, ticks } = niceAxis(maxValue);

  const plotWidth = points.length * spacing;
  const width = PAD.left + plotWidth + PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + index * spacing + spacing / 2;
  const y = (value: number) => PAD.top + plotHeight - (value / max) * plotHeight;
  const baseline = y(0);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(p.expenses)}`).join(' ');
  const areaPath = `${linePath} L${x(points.length - 1)} ${baseline} L${x(0)} ${baseline} Z`;

  let averagePath = '';
  let previousHadAverage = false;
  points.forEach((p, i) => {
    if (p.movingAverage === null) {
      previousHadAverage = false;
      return;
    }
    averagePath += `${previousHadAverage ? 'L' : 'M'}${x(i)} ${y(p.movingAverage)} `;
    previousHadAverage = true;
  });

  // Skip labels when buckets are narrow so the axis never overlaps itself.
  const labelEvery = Math.max(1, Math.ceil(44 / spacing));
  const showDots = points.length <= 40;
  const hasAverage = averagePath !== '';

  return (
    <div className="px-2 pb-4 pt-2 sm:px-3" dir="ltr">
      <ul className="mb-1 flex flex-wrap items-center gap-4 ps-3 text-xs text-navy-500" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ backgroundColor: LINE_COLOR }} aria-hidden="true" />
          Expenses
        </li>
        {hasAverage && (
          <li className="flex items-center gap-1.5">
            <span
              className="h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: AVERAGE_COLOR }}
              aria-hidden="true"
            />
            3-period average
          </li>
        )}
        {points.some((p) => p.partial) && (
          <li className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-full border-2 bg-white"
              style={{ borderColor: LINE_COLOR }}
              aria-hidden="true"
            />
            Period in progress
          </li>
        )}
      </ul>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`Line chart of ${GRANULARITY_LABEL[granularity]} expenses over time`}
          className="h-auto w-full"
          style={{ minWidth: Math.min(width, 520) }}
        >
          <defs>
            <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={LINE_COLOR} stopOpacity={0.18} />
              <stop offset="100%" stopColor={LINE_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>

          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke="#E1E7F0" strokeWidth={1} />
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

          <path d={areaPath} fill="url(#trend-fill)" />
          <path d={linePath} fill="none" stroke={LINE_COLOR} strokeWidth={2} strokeLinejoin="round" />
          {hasAverage && (
            <path
              d={averagePath}
              fill="none"
              stroke={AVERAGE_COLOR}
              strokeWidth={2}
              strokeDasharray="5 4"
              strokeLinejoin="round"
            />
          )}

          {points.map((p, i) => (
            <g key={p.start}>
              {(showDots || p.partial) && (
                <circle
                  cx={x(i)}
                  cy={y(p.expenses)}
                  r={4}
                  fill={p.partial ? '#FFFFFF' : LINE_COLOR}
                  stroke={LINE_COLOR}
                  strokeWidth={2}
                />
              )}
              {/* Full-height transparent hit area so the tooltip works anywhere in the column. */}
              <rect x={x(i) - spacing / 2} y={PAD.top} width={spacing} height={plotHeight} fill="transparent">
                <title>{pointTitle(p, granularity)}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={x(i)} y={HEIGHT - 10} textAnchor="middle" fontSize={11} fill="#4A6188">
                  {pointLabel(p, granularity)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>

      <table className="sr-only">
        <caption>Expenses over time</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Expenses</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.start}>
              <th scope="row">{pointTitle(p, granularity).split(':')[0]}</th>
              <td>{formatCurrency(p.expenses)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
