import { AlertTriangle, CheckCircle2, Info, Lightbulb, ShieldAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getCategory } from '@/data/categories';
import { formatMonthLong } from '@/lib/analytics';
import { formatCurrency } from '@/lib/format';
import type { ComparisonStatus, InsightSeverity, InsightsResult } from '@/lib/insights';

interface BudgetInsightsProps {
  insights: InsightsResult;
}

const SEVERITY_STYLES: Record<InsightSeverity, { icon: LucideIcon; box: string; iconColor: string; label: string }> = {
  critical: { icon: ShieldAlert, box: 'bg-rose-50 ring-rose-200', iconColor: 'text-rose-600', label: 'Critical' },
  warning: { icon: AlertTriangle, box: 'bg-amber-50 ring-amber-200', iconColor: 'text-amber-600', label: 'Warning' },
  info: { icon: Info, box: 'bg-navy-50 ring-navy-100', iconColor: 'text-navy-500', label: 'Note' },
  positive: { icon: CheckCircle2, box: 'bg-emerald-50 ring-emerald-200', iconColor: 'text-emerald-600', label: 'Good news' },
};

const STATUS_STYLES: Record<ComparisonStatus, { text: string; badge: string; bar: string }> = {
  over: { text: 'Above average', badge: 'bg-rose-50 text-rose-700', bar: '#E11D48' },
  normal: { text: 'Typical', badge: 'bg-navy-50 text-navy-600', bar: '#4A6188' },
  under: { text: 'Below average', badge: 'bg-emerald-50 text-emerald-700', bar: '#2F8F6B' },
};

/** Bars are scaled so the category's own average sits at the midpoint of the track. */
const BAR_SCALE = 2;

export function BudgetInsights({ insights }: BudgetInsightsProps) {
  const { alerts, comparisons, focusMonth, focusPartial, baselineMonths } = insights;
  const hasBaseline = comparisons.length > 0;

  return (
    <Card>
      <div className="px-5 pt-5">
        <h2 className="text-base font-semibold text-navy-900">Budget insights</h2>
        <p className="mt-0.5 text-xs text-navy-500">
          {focusMonth !== null && hasBaseline
            ? `${formatMonthLong(focusMonth)}${focusPartial ? ' (in progress)' : ''} compared with your average of the previous ${baselineMonths} months`
            : 'Warnings are based on your own spending history — no budgets to set up'}
        </p>
      </div>

      {alerts.length === 0 && !hasBaseline ? (
        <EmptyState
          icon={Lightbulb}
          title="Nothing unusual to report"
          description="Spending warnings appear here once there is enough history to compare against."
        />
      ) : (
        <div className="space-y-6 px-5 pb-6 pt-4">
          {alerts.length === 0 ? (
            <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
              No unusual spending detected in this period.
            </p>
          ) : (
            <ul className="space-y-3">
              {alerts.map((alert) => {
                const style = SEVERITY_STYLES[alert.severity];
                const Icon = style.icon;
                return (
                  <li key={alert.id} className={`flex gap-3 rounded-xl p-4 ring-1 ${style.box}`}>
                    <Icon className={`mt-0.5 size-5 shrink-0 ${style.iconColor}`} aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-navy-900">
                        <span className="sr-only">{style.label}: </span>
                        {alert.title}
                      </p>
                      {/* dir="auto" lets user-entered Persian/Arabic text pick its own direction. */}
                      <p dir="auto" className="mt-0.5 text-sm text-navy-600">
                        {alert.message}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hasBaseline && (
            <div>
              <h3 className="text-sm font-semibold text-navy-900">Category spending vs. your average</h3>
              <ul className="mt-3 space-y-4">
                {comparisons.map((row) => {
                  const category = getCategory(row.categoryId);
                  const Icon = category.icon;
                  const status = STATUS_STYLES[row.status];
                  const fill = row.ratio === null ? 100 : Math.min(row.ratio / BAR_SCALE, 1) * 100;
                  return (
                    <li key={row.categoryId}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2 font-medium text-navy-900">
                          <Icon className="size-4 shrink-0" style={{ color: category.color }} aria-hidden="true" />
                          <span className="truncate">{category.name}</span>
                        </span>
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${status.badge}`}>
                          {row.ratio === null ? 'No history' : status.text}
                        </span>
                      </div>
                      <div className="relative mt-2 h-1.5 rounded-full bg-navy-50" aria-hidden="true">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${fill}%`, backgroundColor: status.bar }}
                        />
                        <span className="absolute inset-y-[-3px] start-1/2 w-px bg-navy-300" />
                      </div>
                      <p className="mt-1 text-xs tabular-nums text-navy-500">
                        {formatCurrency(row.current)} this month · average {formatCurrency(row.average)}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-navy-400">The tick marks each category's average.</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
