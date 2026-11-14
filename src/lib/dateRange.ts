import { parseISODate } from '@/lib/format';
import { todayISO } from '@/lib/validation';

/**
 * Pure date-range helpers for the Insights view. All dates are local calendar dates in
 * ISO format (YYYY-MM-DD); an empty string means "unbounded" (same convention as the
 * transaction filters). Nothing here reads the clock unless `today` is omitted.
 */

export interface DateRange {
  /** Inclusive lower bound, or '' for no lower bound. */
  from: string;
  /** Inclusive upper bound, or '' for no upper bound. */
  to: string;
}

export type RangePreset = 'month' | '30d' | '3m' | '6m' | 'ytd' | 'all' | 'custom';

export const ALL_TIME: DateRange = { from: '', to: '' };

const MS_PER_DAY = 86_400_000;

/** Days since the epoch for an ISO date, using UTC so daylight-saving shifts cannot skew counts. */
function toDayNumber(iso: string): number | null {
  const date = parseISODate(iso);
  if (!date) return null;
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);
}

function fromDayNumber(days: number): string {
  const d = new Date(days * MS_PER_DAY);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/** Adds `days` (may be negative) to an ISO date. Returns null for an invalid input date. */
export function addDays(iso: string, days: number): string | null {
  const n = toDayNumber(iso);
  return n === null ? null : fromDayNumber(n + days);
}

/** Inclusive number of days between two ISO dates, or null if either is invalid or reversed. */
export function daysBetween(from: string, to: string): number | null {
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  if (a === null || b === null || b < a) return null;
  return b - a + 1;
}

/** Monday of the week containing `iso` (weeks start on Monday). */
export function weekStart(iso: string): string | null {
  const n = toDayNumber(iso);
  if (n === null) return null;
  // 1970-01-01 was a Thursday; (n + 3) % 7 === 0 means Monday.
  const offset = (((n + 3) % 7) + 7) % 7;
  return fromDayNumber(n - offset);
}

/** Resolves a preset to concrete bounds relative to `today`. 'custom' is handled by the caller. */
export function resolvePreset(preset: Exclude<RangePreset, 'custom'>, today: string = todayISO()): DateRange {
  const todayDate = parseISODate(today);
  if (!todayDate) return ALL_TIME;

  const y = todayDate.getFullYear();
  const m = todayDate.getMonth(); // 0-based
  const firstOfMonth = (year: number, month: number) => {
    const d = new Date(year, month, 1); // Date normalises month overflow/underflow
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  };

  switch (preset) {
    case 'month':
      return { from: firstOfMonth(y, m), to: today };
    case '30d':
      return { from: addDays(today, -29) ?? '', to: today };
    case '3m':
      return { from: firstOfMonth(y, m - 2), to: today };
    case '6m':
      return { from: firstOfMonth(y, m - 5), to: today };
    case 'ytd':
      return { from: `${y}-01-01`, to: today };
    case 'all':
      return ALL_TIME;
  }
}

export type RangeProblem = 'invalid-date' | 'reversed';

/** Returns an error code when a custom range cannot be applied, otherwise null. */
export function validateRange(range: DateRange): RangeProblem | null {
  if (range.from !== '' && parseISODate(range.from) === null) return 'invalid-date';
  if (range.to !== '' && parseISODate(range.to) === null) return 'invalid-date';
  if (range.from !== '' && range.to !== '' && range.from > range.to) return 'reversed';
  return null;
}

/**
 * The equally long period immediately before `range`, used for "vs previous period".
 * Only defined when both bounds exist and are valid; open-ended ranges have no comparable past.
 */
export function previousRange(range: DateRange): DateRange | null {
  if (range.from === '' || range.to === '') return null;
  const length = daysBetween(range.from, range.to);
  if (length === null) return null;
  const prevTo = addDays(range.from, -1);
  const prevFrom = addDays(range.from, -length);
  if (prevTo === null || prevFrom === null) return null;
  return { from: prevFrom, to: prevTo };
}

/** Number of days in a calendar month (`month` is 1–12). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Moves an ISO date by whole calendar months (negative = earlier). The day of month is kept and
 * clamped to the target month's length (31 Mar − 1 month = 28/29 Feb); a month-end date stays a
 * month-end date (30 Apr − 1 month = 31 Mar). Pure calendar arithmetic, so DST cannot affect it.
 */
export function shiftDateByMonths(iso: string, months: number): string | null {
  const date = parseISODate(iso);
  if (!date) return null;
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-based
  const day = date.getDate();

  const index = year * 12 + month + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index - targetYear * 12; // 0-based
  if (targetYear < 1000 || targetYear > 9999) return null;

  const targetLength = daysInMonth(targetYear, targetMonth + 1);
  const wasMonthEnd = day === daysInMonth(year, month + 1);
  const targetDay = wasMonthEnd ? targetLength : Math.min(day, targetLength);
  return `${targetYear}-${pad2(targetMonth + 1)}-${pad2(targetDay)}`;
}

/** Calendar presets compare with the same calendar window one period earlier. */
const PRESET_MONTH_SPAN: Partial<Record<RangePreset, number>> = { month: 1, '3m': 3, '6m': 6, ytd: 12 };

/**
 * The period "vs previous period" comparisons should use.
 *
 * - Calendar presets (this month, last 3/6 months, year to date) compare with the same calendar
 *   window one span earlier, e.g. 1–11 Nov vs 1–11 Oct. An equally long window straight before
 *   (21–31 Oct) would miss the 1st-of-month rent/salary and show a false jump.
 * - "Last 30 days" and custom ranges compare with the equally long window immediately before.
 * - All time and open-ended ranges have no comparable past (null).
 */
export function previousPeriod(preset: RangePreset, range: DateRange): DateRange | null {
  if (preset === 'all') return null;
  if (range.from === '' || range.to === '') return null;

  const span = PRESET_MONTH_SPAN[preset];
  if (span === undefined) return previousRange(range);

  const from = shiftDateByMonths(range.from, -span);
  const to = shiftDateByMonths(range.to, -span);
  if (from === null || to === null || from > to) return null;
  return { from, to };
}

/**
 * Restricts a range so it never reaches past `date` (normally today): an open or later end
 * becomes `date`. Returns null when the whole range lies after `date`. Used so that future-dated
 * transactions can never influence an analysis, whatever range the person picks.
 */
export function limitRangeToDate(range: DateRange, date: string): DateRange | null {
  if (range.from !== '' && range.from > date) return null;
  const to = range.to === '' || range.to > date ? date : range.to;
  return { from: range.from, to };
}

/** Inclusive filter by ISO date. ISO strings compare correctly as plain strings. */
export function inRange(date: string, range: DateRange): boolean {
  if (range.from !== '' && date < range.from) return false;
  if (range.to !== '' && date > range.to) return false;
  return true;
}
