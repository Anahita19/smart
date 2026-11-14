/**
 * Effect of the monthRange fix on the Insights figures: savings table, Best month,
 * Average per month and the monthly chart (src/lib/insights.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_MONTH_RANGE } from '../src/lib/analytics.ts';
import { ALL_TIME } from '../src/lib/dateRange.ts';
import { buildPeriodAnalysis, calculateMonthlySavings, summarizePeriod } from '../src/lib/insights.ts';
import type { Transaction } from '../src/types/transaction.ts';

let seq = 0;
const tx = (date: string, type: 'income' | 'expense', amount: number): Transaction =>
  ({ id: `i${++seq}`, type, amount, categoryId: 'other', description: 'x', date }) as Transaction;

const TODAY = '2026-11-11';
const recent = [
  tx('2026-09-02', 'income', 400_000), tx('2026-09-10', 'expense', 100_000), // Sep: +300k  (best)
  tx('2026-10-02', 'income', 400_000), tx('2026-10-10', 'expense', 350_000), // Oct: +50k
  tx('2026-11-02', 'income', 100_000), tx('2026-11-05', 'expense', 90_000),  // Nov: +10k (in progress)
];
const old = tx('1900-01-01', 'expense', 1_000);

describe('Insights with a 1900 transaction in the data', () => {
  it('savings table keeps the recent months (previously showed 1900-1949 only)', () => {
    const months = calculateMonthlySavings([old, ...recent]);
    assert.equal(months.length, MAX_MONTH_RANGE);
    assert.equal(months.at(-1)?.month, '2026-11');
    assert.deepEqual(months.slice(-3).map((m) => m.savings), [300_000, 50_000, 10_000]);
  });

  it('Best month and Average per month are computed from recent data', () => {
    const partial = new Set(['2026-11']);
    const stats = summarizePeriod([old, ...recent], partial);
    assert.equal(stats.bestMonth?.month, '2026-09');
    assert.equal(stats.bestMonth?.savings, 300_000);
    assert.equal(stats.worstMonth?.savings, 0); // an empty gap month in the window, as before
    // Window = latest 600 months, 1 partial excluded => 599 months; Sep+Oct = 350k of savings.
    assert.equal(stats.averageMonthlySavings, Math.round(350_000 / 599));
    assert.equal(stats.excludedPartialMonths, 1);
  });

  it('without an old transaction nothing changes (span well under 600 months)', () => {
    const stats = summarizePeriod(recent, new Set(['2026-11']));
    assert.equal(stats.bestMonth?.month, '2026-09');
    assert.equal(stats.averageMonthlySavings, Math.round(350_000 / 2));
  });

  it('buildPeriodAnalysis (All time): chart, savings, partial month and totals', () => {
    const a = buildPeriodAnalysis([old, ...recent], ALL_TIME, 'all', TODAY);
    assert.deepEqual(a.monthly.map((m) => m.month).slice(-3), ['2026-09', '2026-10', '2026-11']);
    assert.equal(a.monthly.length, 12);
    assert.equal(a.savings.at(-1)?.month, '2026-11');
    assert.ok(a.partialMonths.has('2026-11'));
    assert.equal(a.stats.bestMonth?.month, '2026-09');
    // Headline totals are over ALL analysed transactions, including the 1900 one.
    assert.equal(a.stats.totalExpenses, 1_000 + 100_000 + 350_000 + 90_000);
    assert.equal(a.stats.transactionCount, 7);
  });

  it('future-dated transactions stay excluded from Insights', () => {
    const future = tx('2027-03-01', 'income', 9_999_999);
    const a = buildPeriodAnalysis([old, ...recent, future], ALL_TIME, 'all', TODAY);
    assert.equal(a.stats.transactionCount, 7);
    assert.equal(a.monthly.at(-1)?.month, '2026-11');
    assert.ok(!a.savings.some((m) => m.month === '2027-03'));
  });
});
