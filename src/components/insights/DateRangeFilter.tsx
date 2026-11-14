import { CalendarRange } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { inputClass } from '@/components/ui/formStyles';
import type { DateRange, RangePreset, RangeProblem } from '@/lib/dateRange';

interface DateRangeFilterProps {
  preset: RangePreset;
  custom: DateRange;
  problem: RangeProblem | null;
  onPresetChange: (preset: RangePreset) => void;
  onCustomChange: (range: DateRange) => void;
}

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
  { id: '3m', label: 'Last 3 months' },
  { id: '6m', label: 'Last 6 months' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'custom', label: 'Custom' },
];

const labelClass = 'mb-1 block text-xs font-medium text-navy-500';

const PROBLEM_TEXT: Record<RangeProblem, string> = {
  reversed: 'The start date must be on or before the end date.',
  'invalid-date': 'Enter valid dates.',
};

/** Preset chips plus optional custom From/To dates. Logical (RTL-safe) spacing throughout. */
export function DateRangeFilter({
  preset,
  custom,
  problem,
  onPresetChange,
  onCustomChange,
}: DateRangeFilterProps) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-navy-900">
        <CalendarRange className="size-4 text-navy-500" aria-hidden="true" />
        <h2>Analysis period</h2>
      </div>

      <div role="group" aria-label="Analysis period presets" className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map(({ id, label }) => {
          const active = id === preset;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => onPresetChange(id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-navy-900 text-white'
                  : 'bg-white text-navy-700 ring-1 ring-navy-200 hover:bg-navy-50'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {preset === 'custom' && (
        <div className="mt-4 grid gap-3 sm:max-w-md sm:grid-cols-2">
          <div>
            <label htmlFor="insights-from" className={labelClass}>
              From
            </label>
            <input
              id="insights-from"
              type="date"
              value={custom.from}
              max={custom.to || undefined}
              onChange={(e) => onCustomChange({ ...custom, from: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="insights-to" className={labelClass}>
              To
            </label>
            <input
              id="insights-to"
              type="date"
              value={custom.to}
              min={custom.from || undefined}
              onChange={(e) => onCustomChange({ ...custom, to: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>
      )}

      {problem !== null && (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {PROBLEM_TEXT[problem]}
        </p>
      )}
    </Card>
  );
}
