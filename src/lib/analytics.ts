import { parseISODate } from '@/lib/format';
import type { Transaction } from '@/types/transaction';

export interface MonthlyTotal {
  /** "YYYY-MM" */
  month: string;
  income: number;
  expenses: number;
  net: number;
}

/** Returns the "YYYY-MM" prefix of an ISO date. */
export const monthKey = (isoDate: string): string => isoDate.slice(0, 7);

/** Adds `delta` months to a "YYYY-MM" key. The year is zero-padded so keys always sort as text. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  const year = String(Math.floor(index / 12)).padStart(4, '0');
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Longest run of months monthRange() will return (50 years); keeps charts and tables bounded. */
export const MAX_MONTH_RANGE = 600;

/** "YYYY-MM" -> months since year 0, or null when the key is not a valid month key. */
function monthIndex(key: string): number | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

/**
 * All month keys from `from` to `to` inclusive, oldest first.
 *
 * The result is capped at `maxMonths`. When the span is longer, it is the *latest* `maxMonths`
 * months (ending at `to`) that are kept and the oldest ones are dropped, so one very old
 * transaction (say, dated 1900) can never push the recent months out of the series.
 * Returns [] for a reversed range or a key that is not "YYYY-MM".
 */
export function monthRange(from: string, to: string, maxMonths: number = MAX_MONTH_RANGE): string[] {
  const start = monthIndex(from);
  const end = monthIndex(to);
  if (start === null || end === null || start > end || !(maxMonths >= 1)) return [];

  const first = Math.max(start, end - Math.floor(maxMonths) + 1);
  const result: string[] = [];
  for (let index = first; index <= end; index++) {
    result.push(`${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return result;
}

/**
 * Income and expense totals per calendar month, oldest first.
 * Months without activity *between* the first and last month are included with zeros so the
 * chart has no gaps. When `months` is given, only the latest `months` months are returned.
 * Whatever the data span, the series never exceeds MAX_MONTH_RANGE months and always ends at the
 * latest month that has a transaction (older months beyond that window are left out).
 *
 * `months` follows the same rule as monthRange's cap: fractions round down, and anything below 1
 * (zero, negatives, NaN) yields an empty series — never the whole one. Infinity means "no limit".
 */
export function calculateMonthlyTotals(
  transactions: readonly Transaction[],
  months?: number,
): MonthlyTotal[] {
  if (transactions.length === 0) return [];
  const limit = months === undefined ? undefined : Math.floor(months);
  if (limit !== undefined && !(limit >= 1)) return [];

  const buckets = new Map<string, { income: number; expenses: number }>();
  let first = monthKey(transactions[0].date);
  let last = first;

  for (const t of transactions) {
    const key = monthKey(t.date);
    if (key < first) first = key;
    if (key > last) last = key;
    const bucket = buckets.get(key) ?? { income: 0, expenses: 0 };
    if (t.type === 'income') bucket.income += t.amount;
    else bucket.expenses += t.amount;
    buckets.set(key, bucket);
  }

  const all = monthRange(first, last).map((month) => {
    const { income, expenses } = buckets.get(month) ?? { income: 0, expenses: 0 };
    return { month, income, expenses, net: income - expenses };
  });

  // Not slice(-limit): that would return everything for 0. Infinity keeps the whole series.
  return limit !== undefined ? all.slice(Math.max(0, all.length - limit)) : all;
}

const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short' });
const monthYearFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

export function formatMonthShort(key: string): string {
  const date = parseISODate(`${key}-01`);
  return date ? monthFormatter.format(date) : key;
}

export function formatMonthLong(key: string): string {
  const date = parseISODate(`${key}-01`);
  return date ? monthYearFormatter.format(date) : key;
}

/** Keeps only transactions that fall in `month` ("YYYY-MM"), or all when month is "all". */
export function filterByMonth(
  transactions: readonly Transaction[],
  month: string,
): Transaction[] {
  return month === 'all' ? [...transactions] : transactions.filter((t) => monthKey(t.date) === month);
}

/** Distinct months that have data, newest first. */
export function availableMonths(transactions: readonly Transaction[]): string[] {
  return [...new Set(transactions.map((t) => monthKey(t.date)))].sort((a, b) => b.localeCompare(a));
}

/** Rounds a maximum up to a "nice" axis ceiling and returns evenly spaced tick values (in cents). */
export function niceAxis(maxValue: number, tickCount = 4): { max: number; ticks: number[] } {
  if (maxValue <= 0) return { max: 100, ticks: [0, 100] };
  const rawStep = maxValue / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { max, ticks };
}

/** Compact axis label for a cents value, e.g. 450000 -> "$4.5K". */
export function formatCompactCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100);
}
