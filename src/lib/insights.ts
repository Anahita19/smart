import { getCategory } from '@/data/categories';
import { calculateMonthlyTotals, formatMonthLong, monthKey, shiftMonth } from '@/lib/analytics';
import type { MonthlyTotal } from '@/lib/analytics';
import { calculateExpensesByCategory, calculateSummary } from '@/lib/calculations';
import type { CategoryTotal } from '@/lib/calculations';
import { actualTransactions, isFutureDate } from '@/lib/datePolicy';
import { ALL_TIME, addDays, daysBetween, inRange, limitRangeToDate, previousPeriod, weekStart } from '@/lib/dateRange';
import type { DateRange, RangePreset } from '@/lib/dateRange';
import { formatCurrency, formatDate, formatPercent, parseISODate } from '@/lib/format';
import { todayISO } from '@/lib/validation';
import type { Transaction } from '@/types/transaction';

/**
 * Phase 3 financial analysis. Pure functions only (no React, no clock unless `asOf` is
 * omitted), working on the existing `Transaction` shape. Amounts are integer cents.
 * Every function returns a sensible empty result for empty input and never produces NaN.
 */

/* -------------------------------------------------------------------------- */
/* Input safety                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Drops anything that could poison a total: unknown type, non-finite or non-positive amount,
 * or a date that is not a real calendar date. Storage already validates records, but the
 * analysis must not depend on that.
 */
export function sanitizeTransactions(transactions: readonly Transaction[]): Transaction[] {
  return transactions.filter(
    (t) =>
      t != null &&
      typeof t.id === 'string' &&
      typeof t.categoryId === 'string' &&
      (t.type === 'income' || t.type === 'expense') &&
      typeof t.amount === 'number' &&
      Number.isFinite(t.amount) &&
      t.amount > 0 &&
      typeof t.date === 'string' &&
      parseISODate(t.date) !== null,
  );
}

export function filterByRange(
  transactions: readonly Transaction[],
  range: DateRange,
): Transaction[] {
  return transactions.filter((t) => inRange(t.date, range));
}

/** a / b, or null when the division is meaningless (zero/negative/non-finite denominator). */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/* -------------------------------------------------------------------------- */
/* Period summary and monthly savings                                         */
/* -------------------------------------------------------------------------- */

export interface MonthlySavings extends MonthlyTotal {
  /** Income minus expenses for the month (same value as `net`). */
  savings: number;
  /** Share of income kept (can be negative). null when the month has no income. */
  savingsRate: number | null;
}

/** Per-month income, expenses, savings and savings rate, oldest first, gaps filled with zeros. */
export function calculateMonthlySavings(transactions: readonly Transaction[]): MonthlySavings[] {
  return calculateMonthlyTotals(transactions).map((m) => ({
    ...m,
    savings: m.net,
    savingsRate: safeRatio(m.net, m.income),
  }));
}

export interface PeriodStats {
  totalIncome: number;
  totalExpenses: number;
  /** Income minus expenses. */
  savings: number;
  /** null when there is no income in the period. */
  savingsRate: number | null;
  transactionCount: number;
  /** Mean of the monthly savings figures; null when there are no months. */
  /** Mean savings of the complete months; null when there is no complete month. */
  averageMonthlySavings: number | null;
  /** Best/worst among complete months only (a month in progress would distort the ranking). */
  bestMonth: MonthlySavings | null;
  worstMonth: MonthlySavings | null;
  /** How many partial months were left out of the average and best/worst. */
  excludedPartialMonths: number;
}

/**
 * Totals are always for every transaction given. The per-month figures (average, best, worst)
 * skip the months listed in `partialMonths` ("YYYY-MM"), because a month that is still running or
 * cut off by the selected range understates (or overstates) a typical month.
 */
export function summarizePeriod(
  transactions: readonly Transaction[],
  partialMonths: ReadonlySet<string> = new Set(),
): PeriodStats {
  const { totalIncome, totalExpenses, balance } = calculateSummary(transactions);
  const months = calculateMonthlySavings(transactions);
  const completeMonths = months.filter((m) => !partialMonths.has(m.month));

  let best: MonthlySavings | null = null;
  let worst: MonthlySavings | null = null;
  for (const m of completeMonths) {
    if (best === null || m.savings > best.savings) best = m;
    if (worst === null || m.savings < worst.savings) worst = m;
  }

  return {
    totalIncome,
    totalExpenses,
    savings: balance,
    savingsRate: safeRatio(balance, totalIncome),
    transactionCount: transactions.length,
    averageMonthlySavings:
      completeMonths.length > 0
        ? Math.round(completeMonths.reduce((sum, m) => sum + m.savings, 0) / completeMonths.length)
        : null,
    bestMonth: best,
    worstMonth: worst,
    excludedPartialMonths: months.length - completeMonths.length,
  };
}

/** Relative change from `previous` to `current`; null when there is no usable baseline. */
export function changeRatio(current: number, previous: number): number | null {
  const ratio = safeRatio(current - previous, previous);
  return ratio;
}

/* -------------------------------------------------------------------------- */
/* Spending trend                                                             */
/* -------------------------------------------------------------------------- */

export type Granularity = 'day' | 'week' | 'month';
export type TrendDirection = 'up' | 'down' | 'flat' | 'insufficient';

export interface TrendPoint {
  /** First day of the bucket (ISO). Also the unique key. */
  start: string;
  /** Last day of the bucket (ISO). */
  end: string;
  income: number;
  expenses: number;
  /** True when the bucket is cut off by the range or by "today", so it understates the total. */
  partial: boolean;
  /** Trailing 3-bucket average of expenses; null until 3 complete buckets exist. */
  movingAverage: number | null;
}

export interface SpendingTrend {
  granularity: Granularity;
  points: TrendPoint[];
  direction: TrendDirection;
  /** Second half vs first half of the complete buckets; null when not computable. */
  directionChange: number | null;
}

const DAY_BUCKET_MAX_SPAN = 45;
const WEEK_BUCKET_MAX_SPAN = 200;
const MAX_TREND_POINTS = 1000;
const FLAT_BAND = 0.1;

function lastDayOfMonth(key: string): string {
  return addDays(`${shiftMonth(key, 1)}-01`, -1) ?? `${key}-28`;
}

/**
 * Months ("YYYY-MM") that the range or "today" cuts off, so their totals are incomplete:
 * the range starts after the 1st, or ends/today falls before the last day of the month.
 */
export function partialMonthKeys(
  monthKeys: readonly string[],
  range: DateRange,
  asOf: string = todayISO(),
): Set<string> {
  const effectiveEnd = range.to !== '' && range.to < asOf ? range.to : asOf;
  const partial = new Set<string>();
  for (const key of monthKeys) {
    const startsLate = range.from !== '' && range.from > `${key}-01`;
    const endsEarly = lastDayOfMonth(key) > effectiveEnd;
    if (startsLate || endsEarly) partial.add(key);
  }
  return partial;
}

/**
 * Expenses (and income) over time. The bucket size adapts to the data span: days up to ~6 weeks,
 * weeks up to ~6 months, months beyond that. Empty buckets are included so the line has no gaps.
 */
export function calculateSpendingTrend(
  transactions: readonly Transaction[],
  range: DateRange,
  asOf: string = todayISO(),
): SpendingTrend {
  if (transactions.length === 0) {
    return { granularity: 'month', points: [], direction: 'insufficient', directionChange: null };
  }

  let first = transactions[0].date;
  let last = first;
  for (const t of transactions) {
    if (t.date < first) first = t.date;
    if (t.date > last) last = t.date;
  }

  const span = daysBetween(first, last) ?? 1;
  const granularity: Granularity =
    span <= DAY_BUCKET_MAX_SPAN ? 'day' : span <= WEEK_BUCKET_MAX_SPAN ? 'week' : 'month';

  const startOf = (iso: string): string =>
    granularity === 'day' ? iso : granularity === 'week' ? (weekStart(iso) ?? iso) : `${monthKey(iso)}-01`;
  const endOf = (start: string): string =>
    granularity === 'day'
      ? start
      : granularity === 'week'
        ? (addDays(start, 6) ?? start)
        : lastDayOfMonth(monthKey(start));
  const nextStart = (start: string): string | null =>
    granularity === 'day'
      ? addDays(start, 1)
      : granularity === 'week'
        ? addDays(start, 7)
        : `${shiftMonth(monthKey(start), 1)}-01`;

  const buckets = new Map<string, { income: number; expenses: number }>();
  for (const t of transactions) {
    const key = startOf(t.date);
    const bucket = buckets.get(key) ?? { income: 0, expenses: 0 };
    if (t.type === 'income') bucket.income += t.amount;
    else bucket.expenses += t.amount;
    buckets.set(key, bucket);
  }

  // A bucket is "partial" if the range or today cuts it off at either end.
  const effectiveEnd = range.to !== '' && range.to < asOf ? range.to : asOf;
  const lastStart = startOf(last);
  const points: TrendPoint[] = [];
  let start: string | null = startOf(first);
  while (start !== null && start <= lastStart && points.length < MAX_TREND_POINTS) {
    const { income, expenses } = buckets.get(start) ?? { income: 0, expenses: 0 };
    const end = endOf(start);
    const partial = end > effectiveEnd || (range.from !== '' && start < range.from);
    points.push({ start, end, income, expenses, partial, movingAverage: null });
    start = nextStart(start);
  }

  for (let i = 2; i < points.length; i++) {
    const window = points.slice(i - 2, i + 1);
    if (window.every((p) => !p.partial)) {
      points[i].movingAverage = Math.round(window.reduce((sum, p) => sum + p.expenses, 0) / 3);
    }
  }

  const complete = points.filter((p) => !p.partial);
  let direction: TrendDirection = 'insufficient';
  let directionChange: number | null = null;
  if (complete.length >= 4) {
    const half = Math.floor(complete.length / 2);
    const mean = (items: TrendPoint[]) => items.reduce((s, p) => s + p.expenses, 0) / items.length;
    const earlier = mean(complete.slice(0, half));
    const later = mean(complete.slice(complete.length - half));
    if (earlier === 0 && later === 0) {
      direction = 'flat';
    } else if (earlier === 0) {
      direction = 'up';
    } else {
      directionChange = (later - earlier) / earlier;
      direction = directionChange > FLAT_BAND ? 'up' : directionChange < -FLAT_BAND ? 'down' : 'flat';
    }
  }

  return { granularity, points, direction, directionChange };
}

/* -------------------------------------------------------------------------- */
/* Top categories                                                             */
/* -------------------------------------------------------------------------- */

export interface TopCategory extends CategoryTotal {
  /** Spending in the previous period; null when there is no comparison period. */
  previousTotal: number | null;
  /** Relative change vs the previous period; null when the previous total is zero or unknown. */
  change: number | null;
}

export function calculateTopCategories(
  current: readonly Transaction[],
  previous: readonly Transaction[] | null,
  limit = 5,
): TopCategory[] {
  const previousTotals = new Map<string, number>();
  if (previous !== null) {
    for (const entry of calculateExpensesByCategory(previous)) {
      previousTotals.set(entry.categoryId, entry.total);
    }
  }

  return calculateExpensesByCategory(current)
    .slice(0, Math.max(0, limit))
    .map((entry) => {
      const previousTotal = previous === null ? null : (previousTotals.get(entry.categoryId) ?? 0);
      return {
        ...entry,
        previousTotal,
        change: previousTotal === null ? null : changeRatio(entry.total, previousTotal),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Budget insights and warnings                                               */
/* -------------------------------------------------------------------------- */

export type InsightSeverity = 'critical' | 'warning' | 'info' | 'positive';

export interface InsightAlert {
  id: string;
  severity: InsightSeverity;
  title: string;
  message: string;
}

export type ComparisonStatus = 'over' | 'normal' | 'under';

export interface CategoryComparison {
  categoryId: string;
  /** Spending in the focus month. */
  current: number;
  /** Average monthly spending over the baseline months. */
  average: number;
  /** current / average; null when there is no baseline for the category. */
  ratio: number | null;
  status: ComparisonStatus;
}

export interface InsightsResult {
  /** "YYYY-MM" of the latest month in the range, or null when the range is empty. */
  focusMonth: string | null;
  /** True when the focus month is still in progress (or cut off by the range). */
  focusPartial: boolean;
  /** How many earlier months with data were used as the baseline (0–3). */
  baselineMonths: number;
  alerts: InsightAlert[];
  comparisons: CategoryComparison[];
}

// Thresholds are deliberately conservative so the warnings stay rare and meaningful.
const BASELINE_MONTHS = 3;
const MIN_BASELINE_MONTHS = 2;
const SPIKE_RATIO = 1.25;
const SPIKE_CRITICAL_RATIO = 2;
const MIN_EXCESS_CENTS = 2_500; // ignore differences under $25
const TOTAL_GROWTH_RATIO = 1.2;
const TOTAL_MIN_EXCESS_CENTS = 10_000; // $100
const LOW_SAVINGS_RATE = 0.1;
const STRONG_SAVINGS_RATE = 0.2;
// Unusually large single expense: an expense is judged against the *other* expenses in its
// category, and only when that history is substantial enough to define "typical".
const LARGE_TX_MULTIPLE = 2.5; // at least 2.5x the category median
const LARGE_TX_MIN_CENTS = 10_000; // and at least $100
const LARGE_TX_MIN_EXCESS_CENTS = 7_500; // and at least $75 above the median
const LARGE_TX_MIN_PEERS = 6; // other expenses in the category
const LARGE_TX_MIN_PEER_MONTHS = 3; // spread over at least this many calendar months
const LARGE_TX_MIN_ROBUST_Z = 3.5; // modified z-score (median/MAD), the usual outlier cut-off
const LARGE_TX_SIMILAR_SHARE = 0.8; // peers this close to the amount count as "similar"
const LARGE_TX_MAX_SIMILAR_PEERS = 1; // two or more similar peers = a recurring size, not an outlier
const FIXED_BILL_MIN_OCCURRENCES = 3; // same description in 3+ different months,
const FIXED_BILL_MAX_PER_MONTH = 1.5; // about once a month (not a generic label used daily),
const FIXED_BILL_MAX_SPREAD = 0.05; // at (almost) the same price = a fixed bill
const MAX_LARGE_TX_ALERTS = 3;
const MAX_COMPARISONS = 8;

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

/** Wraps user-entered text in Unicode bidi isolates so RTL (e.g. Persian) text cannot scramble the sentence. */
export function isolate(text: string): string {
  return `\u2068${text}\u2069`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const normaliseDescription = (description: string): string => description.trim().toLowerCase();

/**
 * Descriptions that behave like fixed bills (rent, gym, subscriptions): about one per month, in
 * several months, at nearly the same amount. They say nothing about what a "typical" discretionary
 * purchase in the category costs, so they are kept out of the baseline.
 */
function fixedBillDescriptions(categoryExpenses: readonly Transaction[]): Set<string> {
  const groups = new Map<string, Transaction[]>();
  for (const t of categoryExpenses) {
    const key = normaliseDescription(t.description);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const fixed = new Set<string>();
  for (const [key, list] of groups) {
    if (list.length < FIXED_BILL_MIN_OCCURRENCES) continue;
    const monthCount = new Set(list.map((t) => monthKey(t.date))).size;
    if (monthCount < FIXED_BILL_MIN_OCCURRENCES) continue;
    // A generic label such as "Lunch" used many times a month is not a bill; keep it in the baseline.
    if (list.length > monthCount * FIXED_BILL_MAX_PER_MONTH) continue;
    const amounts = list.map((t) => t.amount);
    const typical = median(amounts);
    if (typical > 0 && (Math.max(...amounts) - Math.min(...amounts)) / typical <= FIXED_BILL_MAX_SPREAD) {
      fixed.add(key);
    }
  }
  return fixed;
}

export interface UnusualExpense {
  transaction: Transaction;
  /** Median of the other expenses in the same category, in cents. */
  typical: number;
  /** How many other expenses in the category the median is based on. */
  peerCount: number;
}

/**
 * Expenses in `candidates` that stand out from the user's other expenses in the same category.
 *
 * To keep false positives rare, an expense is only flagged when ALL of these hold:
 * - the category has at least {@link LARGE_TX_MIN_PEERS} *other* expenses (the expense itself is
 *   never part of its own baseline) spread over at least {@link LARGE_TX_MIN_PEER_MONTHS} months,
 *   so a category with only a handful of entries is never judged;
 * - it is at least $100, at least 2.5x the category median and $75 above it;
 * - it is not itself a fixed bill, and fixed bills (same description, about once a month at
 *   nearly the same amount, e.g. a gym membership) are left out of the baseline, so a one-off dental
 *   visit is not compared with a monthly gym fee;
 * - it is a statistical outlier (modified z-score >= 3.5, scaled by the median absolute deviation
 *   with a floor of 10% of the median so identical history cannot make the threshold razor-thin);
 * - fewer than two peers are of similar size (>= 80% of it), because a size that keeps coming
 *   back (rent, a yearly bill paid twice) is a pattern, not a surprise.
 *
 * Expenses dated after `asOf` are ignored as history.
 */
export function findUnusualExpenses(
  allTransactions: readonly Transaction[],
  candidates: readonly Transaction[],
  asOf: string = todayISO(),
): UnusualExpense[] {
  const byCategory = new Map<string, Transaction[]>();
  for (const t of allTransactions) {
    if (t.type !== 'expense' || isFutureDate(t.date, asOf)) continue;
    const list = byCategory.get(t.categoryId);
    if (list) list.push(t);
    else byCategory.set(t.categoryId, [t]);
  }

  const fixedByCategory = new Map<string, Set<string>>();
  for (const [categoryId, list] of byCategory) fixedByCategory.set(categoryId, fixedBillDescriptions(list));

  // The peer list of a candidate is its category minus fixed bills minus the candidate itself. It is
  // prepared once per category (sorted) so each candidate only needs a few binary searches instead
  // of rebuilding and re-sorting the whole list, which made the cost grow with the square of the history.
  const baselines = new Map<string, CategoryBaseline>();
  const baselineFor = (categoryId: string, fixed: ReadonlySet<string>): CategoryBaseline => {
    let baseline = baselines.get(categoryId);
    if (!baseline) {
      baseline = buildCategoryBaseline((byCategory.get(categoryId) ?? []).filter((t) => !fixed.has(normaliseDescription(t.description))));
      baselines.set(categoryId, baseline);
    }
    return baseline;
  };

  const found: UnusualExpense[] = [];
  for (const candidate of candidates) {
    if (candidate.type !== 'expense' || candidate.amount < LARGE_TX_MIN_CENTS) continue;

    const fixed = fixedByCategory.get(candidate.categoryId) ?? new Set<string>();
    if (fixed.has(normaliseDescription(candidate.description))) continue;

    const peers = peersWithout(baselineFor(candidate.categoryId, fixed), candidate.id);
    if (peers.count < LARGE_TX_MIN_PEERS) continue;
    if (peers.monthCount < LARGE_TX_MIN_PEER_MONTHS) continue;

    const typical = sortedMedian(peers.sorted, peers.skip, peers.count);
    if (typical <= 0) continue;
    if (candidate.amount < typical * LARGE_TX_MULTIPLE) continue;
    if (candidate.amount - typical < LARGE_TX_MIN_EXCESS_CENTS) continue;

    const scale = Math.max(1.4826 * sortedMedianAbsoluteDeviation(peers.sorted, peers.skip, peers.count, typical), typical * 0.1);
    if ((candidate.amount - typical) / scale < LARGE_TX_MIN_ROBUST_Z) continue;

    const similarFrom = lowerBound(peers.sorted, peers.skip, peers.count, candidate.amount * LARGE_TX_SIMILAR_SHARE);
    const similar = peers.count - similarFrom;
    if (similar > LARGE_TX_MAX_SIMILAR_PEERS) continue;

    found.push({ transaction: candidate, typical, peerCount: peers.count });
  }

  return found.sort(
    (a, b) => b.transaction.amount - a.transaction.amount || a.transaction.id.localeCompare(b.transaction.id),
  );
}

/* --- Order statistics on a sorted amount list with (at most) one element left out ------------ */
/* `skip` is the index of the one element to ignore, or -1 for none; `n` is the resulting length. */

function sortedAt(sorted: readonly number[], skip: number, i: number): number {
  return skip >= 0 && i >= skip ? sorted[i + 1] : sorted[i];
}

/** Number of elements < x (the index of the first element >= x). */
function lowerBound(sorted: readonly number[], skip: number, n: number, x: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAt(sorted, skip, mid) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Same result as {@link median} on the same values, without copying or sorting. */
function sortedMedian(sorted: readonly number[], skip: number, n: number): number {
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? sortedAt(sorted, skip, mid)
    : (sortedAt(sorted, skip, mid - 1) + sortedAt(sorted, skip, mid)) / 2;
}

/**
 * Median absolute deviation (a spread measure that one outlier cannot distort): the median of the
 * distances from `center`, computed without building that list. The distances to `center` form two already-sorted
 * runs (walking left and walking right from `center`), so the middle distance(s) of their union are
 * found by a binary search instead of building and sorting the full list of distances.
 */
function sortedMedianAbsoluteDeviation(sorted: readonly number[], skip: number, n: number, center: number): number {
  const split = lowerBound(sorted, skip, n, center); // elements [0, split) lie left of center
  const left = (i: number) => Math.abs(sortedAt(sorted, skip, split - 1 - i) - center);
  const right = (j: number) => Math.abs(sortedAt(sorted, skip, split + j) - center);
  const kth = (k: number): number => {
    const leftLength = split;
    const rightLength = n - split;
    let lo = Math.max(0, k + 1 - rightLength);
    let hi = Math.min(leftLength, k + 1);
    while (lo < hi) {
      const i = (lo + hi) >>> 1; // take i from the left run and k + 1 - i from the right run
      if (left(i) < right(k - i)) lo = i + 1;
      else hi = i;
    }
    const fromLeft = lo > 0 ? left(lo - 1) : -Infinity;
    const fromRight = k + 1 - lo > 0 ? right(k - lo) : -Infinity;
    return Math.max(fromLeft, fromRight);
  };
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? kth(mid) : (kth(mid - 1) + kth(mid)) / 2;
}

interface CategoryBaseline {
  /** Amounts of every eligible expense in the category, ascending. */
  sorted: number[];
  /** Eligible expenses per calendar month (its size is the number of distinct months). */
  monthCounts: Map<string, number>;
  /** Eligible expenses grouped by id, so one candidate's own entries can be left out. */
  byId: Map<string, Transaction[]>;
  /** The eligible expenses themselves (only used for the duplicate-id fallback). */
  entries: Transaction[];
}

function buildCategoryBaseline(entries: Transaction[]): CategoryBaseline {
  const monthCounts = new Map<string, number>();
  const byId = new Map<string, Transaction[]>();
  for (const t of entries) {
    const month = monthKey(t.date);
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
    const same = byId.get(t.id);
    if (same) same.push(t);
    else byId.set(t.id, [t]);
  }
  return { sorted: entries.map((t) => t.amount).sort((a, b) => a - b), monthCounts, byId, entries };
}

interface PeerView {
  sorted: number[];
  skip: number;
  count: number;
  monthCount: number;
}

/** The baseline without the entries whose id is `id` (a candidate is never its own peer). */
function peersWithout(baseline: CategoryBaseline, id: string): PeerView {
  const own = baseline.byId.get(id);
  if (!own) {
    return { sorted: baseline.sorted, skip: -1, count: baseline.sorted.length, monthCount: baseline.monthCounts.size };
  }
  if (own.length === 1) {
    // The usual case (ids are unique): leave out exactly one element.
    const t = own[0];
    const skip = lowerBound(baseline.sorted, -1, baseline.sorted.length, t.amount);
    const alone = baseline.monthCounts.get(monthKey(t.date)) === 1;
    return {
      sorted: baseline.sorted,
      skip,
      count: baseline.sorted.length - 1,
      monthCount: baseline.monthCounts.size - (alone ? 1 : 0),
    };
  }
  // Duplicate ids (not expected in valid data): rebuild this one list, exactly as before.
  const rest = baseline.entries.filter((t) => t.id !== id);
  return {
    sorted: rest.map((t) => t.amount).sort((a, b) => a - b),
    skip: -1,
    count: rest.length,
    monthCount: new Set(rest.map((t) => monthKey(t.date))).size,
  };
}

function groupByMonth(transactions: readonly Transaction[]): Map<string, Transaction[]> {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = monthKey(t.date);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  return groups;
}

function expenseTotalsByCategory(transactions: readonly Transaction[]): Map<string, number> {
  return new Map(calculateExpensesByCategory(transactions).map((c) => [c.categoryId, c.total]));
}

/**
 * Compares the latest month in the range with the user's own recent history (no budgets are
 * stored, so the "budget" is the average of up to the 3 previous months that have data), and
 * flags overspending, low savings, spending spikes and unusually large single expenses.
 *
 * `allTransactions` supplies the history; `rangeTransactions` is what the user is looking at.
 */
export function generateInsights(
  allTransactions: readonly Transaction[],
  rangeTransactions: readonly Transaction[],
  range: DateRange,
  asOf: string = todayISO(),
): InsightsResult {
  const empty: InsightsResult = {
    focusMonth: null,
    focusPartial: false,
    baselineMonths: 0,
    alerts: [],
    comparisons: [],
  };
  if (rangeTransactions.length === 0) return empty;

  const rangeByMonth = groupByMonth(rangeTransactions);
  const monthsInRange = [...rangeByMonth.keys()].sort();
  const focusMonth = monthsInRange[monthsInRange.length - 1];
  const focusTransactions = rangeByMonth.get(focusMonth) ?? [];
  const focusSummary = calculateSummary(focusTransactions);
  const rangeSummary = calculateSummary(rangeTransactions);

  // Partial when the range/today cuts the month off at the end, or the range starts after the 1st.
  const focusPartial = partialMonthKeys([focusMonth], range, asOf).has(focusMonth);
  const singlePartialMonth = focusPartial && monthsInRange.length === 1;
  const focusLabel = formatMonthLong(focusMonth);

  const alerts: InsightAlert[] = [];

  /* --- Income vs spending -------------------------------------------------- */
  // A month still in progress (or cut off by the range) is judged more gently: income such as a
  // salary may simply not have arrived yet, so "so far" overspending is a warning, not critical.
  if (rangeSummary.totalIncome > 0 && rangeSummary.balance < 0) {
    alerts.push({
      id: 'range-overspend',
      severity: singlePartialMonth ? 'warning' : 'critical',
      title: singlePartialMonth ? 'Spending is ahead of income so far' : 'Spending exceeded income',
      message: `Expenses were ${formatCurrency(-rangeSummary.balance)} higher than income in the selected period${
        singlePartialMonth ? ', and the month is not over yet' : ''
      }.`,
    });
  } else if (
    monthsInRange.length > 1 &&
    focusSummary.totalIncome > 0 &&
    focusSummary.balance < 0
  ) {
    alerts.push({
      id: 'focus-overspend',
      severity: focusPartial ? 'warning' : 'critical',
      title: focusPartial ? `Spending is ahead of income in ${focusLabel} so far` : `Overspent in ${focusLabel}`,
      message: `Expenses were ${formatCurrency(-focusSummary.balance)} higher than income ${
        focusPartial ? 'so far this month' : 'that month'
      }.`,
    });
  } else if (rangeSummary.totalIncome === 0 && rangeSummary.totalExpenses > 0) {
    alerts.push({
      id: 'no-income',
      severity: 'info',
      title: 'No income recorded',
      message: 'This period has expenses but no income, so savings cannot be measured.',
    });
  } else if (rangeSummary.totalIncome > 0 && !singlePartialMonth) {
    // The savings rate of a single unfinished month says little (income often arrives first,
    // spending accrues later), so it is only judged for finished months or longer ranges.
    const rate = rangeSummary.balance / rangeSummary.totalIncome;
    if (rate < LOW_SAVINGS_RATE) {
      alerts.push({
        id: 'low-savings',
        severity: 'warning',
        title: 'Low savings rate',
        message: `You kept ${formatPercent(rate)} of your income. Aim for at least ${formatPercent(LOW_SAVINGS_RATE)}.`,
      });
    } else if (rate >= STRONG_SAVINGS_RATE) {
      alerts.push({
        id: 'strong-savings',
        severity: 'positive',
        title: 'Healthy savings rate',
        message: `You kept ${formatPercent(rate)} of your income in the selected period.`,
      });
    }
  }

  /* --- Focus month vs the user's own recent average ------------------------ */
  const history = groupByMonth(allTransactions);
  const baselineTotals: Map<string, number>[] = [];
  let baselineExpenseSum = 0;
  for (let i = 1; i <= BASELINE_MONTHS; i++) {
    const monthTransactions = history.get(shiftMonth(focusMonth, -i));
    if (!monthTransactions) continue;
    // A month with income only has no spending to learn from; counting it would drag the
    // average towards zero and make an ordinary month look like a spike.
    const totals = expenseTotalsByCategory(monthTransactions);
    if (totals.size === 0) continue;
    baselineTotals.push(totals);
    baselineExpenseSum += calculateSummary(monthTransactions).totalExpenses;
  }
  const baselineMonths = baselineTotals.length;

  const comparisons: CategoryComparison[] = [];
  if (baselineMonths >= MIN_BASELINE_MONTHS) {
    const current = expenseTotalsByCategory(focusTransactions);
    const categoryIds = new Set<string>(current.keys());
    for (const month of baselineTotals) for (const id of month.keys()) categoryIds.add(id);

    for (const categoryId of categoryIds) {
      const currentTotal = current.get(categoryId) ?? 0;
      const average = baselineTotals.reduce((sum, m) => sum + (m.get(categoryId) ?? 0), 0) / baselineMonths;
      const ratio = safeRatio(currentTotal, average);

      // Sporadic categories (bought in fewer than 2 baseline months) have no meaningful monthly
      // average, so they are shown as typical instead of being flagged.
      const monthsSeen = baselineTotals.filter((m) => (m.get(categoryId) ?? 0) > 0).length;
      const recurring = monthsSeen >= MIN_BASELINE_MONTHS;

      let status: ComparisonStatus = 'normal';
      if (ratio !== null && recurring) {
        if (ratio >= SPIKE_RATIO && currentTotal - average >= MIN_EXCESS_CENTS) status = 'over';
        // A month in progress always looks "low", so only flag under-spending for finished months.
        else if (!focusPartial && ratio <= 1 / SPIKE_RATIO && average - currentTotal >= MIN_EXCESS_CENTS) {
          status = 'under';
        }
      }
      comparisons.push({ categoryId, current: currentTotal, average: Math.round(average), ratio, status });

      if (status === 'over' && ratio !== null) {
        alerts.push({
          id: `spike-${categoryId}`,
          severity: ratio >= SPIKE_CRITICAL_RATIO ? 'critical' : 'warning',
          title: `${getCategory(categoryId).name} spending is ${formatPercent(ratio - 1)} above average`,
          message: `${formatCurrency(currentTotal)} in ${focusLabel}${
            focusPartial ? ' so far' : ''
          } vs a typical ${formatCurrency(Math.round(average))} per month over the previous ${baselineMonths} months.`,
        });
      }
    }

    comparisons.sort((a, b) => b.current - a.current || b.average - a.average || a.categoryId.localeCompare(b.categoryId));

    const baselineExpenseAverage = baselineExpenseSum / baselineMonths;
    const totalRatio = safeRatio(focusSummary.totalExpenses, baselineExpenseAverage);
    if (
      totalRatio !== null &&
      totalRatio >= TOTAL_GROWTH_RATIO &&
      focusSummary.totalExpenses - baselineExpenseAverage >= TOTAL_MIN_EXCESS_CENTS
    ) {
      alerts.push({
        id: 'total-growth',
        severity: 'warning',
        title: `Total spending is ${formatPercent(totalRatio - 1)} above average`,
        message: `${formatCurrency(focusSummary.totalExpenses)} in ${focusLabel}${
          focusPartial ? ' so far' : ''
        } vs ${formatCurrency(Math.round(baselineExpenseAverage))} per month recently.`,
      });
    }
  }

  /* --- Unusually large single expenses ------------------------------------- */
  const large = findUnusualExpenses(
    allTransactions,
    rangeTransactions.filter((t) => t.type === 'expense'),
    asOf,
  ).slice(0, MAX_LARGE_TX_ALERTS);

  for (const { transaction, typical, peerCount } of large) {
    alerts.push({
      id: `large-${transaction.id}`,
      severity: 'warning',
      title: 'Unusually large expense',
      message: `${isolate(transaction.description)} on ${formatDate(transaction.date)}: ${formatCurrency(
        transaction.amount,
      )}, about ${(transaction.amount / typical).toFixed(1)}× your typical ${getCategory(transaction.categoryId).name} expense (${formatCurrency(
        Math.round(typical),
      )}, the median of ${peerCount} other purchases).`,
    });
  }

  alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    focusMonth,
    focusPartial,
    baselineMonths,
    alerts,
    comparisons: comparisons.slice(0, MAX_COMPARISONS),
  };
}

/* -------------------------------------------------------------------------- */
/* Whole-page analysis                                                        */
/* -------------------------------------------------------------------------- */

/** Number of most recent months shown in the income-vs-expenses bar chart. */
export const MONTHLY_CHART_MONTHS = 12;

export interface PeriodAnalysis {
  /** Transactions analysed: inside the range and not after `today`. */
  current: Transaction[];
  /** The range actually analysed (end limited to today); null when nothing can be analysed. */
  effectiveRange: DateRange | null;
  stats: PeriodStats;
  previousStats: PeriodStats | null;
  /** A comparison was expected but the previous period is empty or not covered by the history. */
  comparisonMissing: boolean;
  monthly: MonthlyTotal[];
  savings: MonthlySavings[];
  partialMonths: Set<string>;
  byCategory: CategoryTotal[];
  topCategories: TopCategory[];
  trend: SpendingTrend;
  insights: InsightsResult;
}

/**
 * Everything the Insights page shows, from one consistent set of transactions.
 *
 * Future-dated transactions (after `today`) are excluded from every figure: totals, charts,
 * savings, comparisons, alerts and the history used as a baseline. The selected range is limited
 * to today for the current period AND for the previous-period comparison, so both always cover
 * the same window. `transactions` must already be sanitised; `range` is null for an unusable
 * custom range, which analyses nothing.
 */
export function buildPeriodAnalysis(
  transactions: readonly Transaction[],
  range: DateRange | null,
  preset: RangePreset,
  today: string,
): PeriodAnalysis {
  const known = actualTransactions(transactions, today);
  const effectiveRange = range === null ? null : limitRangeToDate(range, today);
  const analysisRange = effectiveRange ?? range ?? ALL_TIME;
  const current = effectiveRange === null ? [] : filterByRange(known, effectiveRange);

  // Open-ended ranges (no start or no end chosen) have no comparable past.
  const comparable = range !== null && range.from !== '' && range.to !== '';
  const previousBounds = effectiveRange === null || !comparable ? null : previousPeriod(preset, effectiveRange);
  const previousCandidate = previousBounds === null ? null : filterByRange(known, previousBounds);

  // The earliest transaction tells us whether the previous period is actually covered by data;
  // otherwise an "increase" would simply mean the earlier period is missing.
  let dataStart = '';
  for (const t of known) if (dataStart === '' || t.date < dataStart) dataStart = t.date;

  const previous =
    previousBounds !== null &&
    previousCandidate !== null &&
    previousCandidate.length > 0 &&
    dataStart !== '' &&
    dataStart <= previousBounds.from
      ? previousCandidate
      : null;

  const savings = calculateMonthlySavings(current);
  const partialMonths = partialMonthKeys(
    savings.map((m) => m.month),
    analysisRange,
    today,
  );

  return {
    current,
    effectiveRange,
    stats: summarizePeriod(current, partialMonths),
    previousStats: previous === null ? null : summarizePeriod(previous),
    comparisonMissing: previousBounds !== null && previous === null,
    monthly: calculateMonthlyTotals(current, MONTHLY_CHART_MONTHS),
    savings,
    partialMonths,
    byCategory: calculateExpensesByCategory(current),
    topCategories: calculateTopCategories(current, previous, 5),
    trend: calculateSpendingTrend(current, analysisRange, today),
    insights: generateInsights(known, current, analysisRange, today),
  };
}
