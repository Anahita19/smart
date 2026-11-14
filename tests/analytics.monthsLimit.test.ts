/**
 * Regression tests for the `months` limit of calculateMonthlyTotals (src/lib/analytics.ts).
 *
 * Bug: months = 0 returned the WHOLE series because slice(-0) === slice(0), and negative values
 * returned a truncated series from the wrong end. Anything below 1 must now give [].
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateMonthlyTotals } from '../src/lib/analytics.ts';
import type { Transaction } from '../src/types/transaction.ts';

let seq = 0;
const tx = (date: string, type: 'income' | 'expense', amount: number): Transaction =>
  ({ id: `m${++seq}`, type, amount, categoryId: 'other', description: 'x', date }) as Transaction;

// 5 months, with a gap month (2026-09) that must appear as zeros.
const data = [
  tx('2026-07-10', 'expense', 100), tx('2026-08-03', 'income', 500),
  tx('2026-10-01', 'expense', 40), tx('2026-11-05', 'income', 900), tx('2026-11-06', 'expense', 60),
];
const all = calculateMonthlyTotals(data);
const months = (r: { month: string }[]) => r.map((m) => m.month);

describe('calculateMonthlyTotals: months limit', () => {
  it('baseline: without a limit the full gap-filled series is returned', () => {
    assert.deepEqual(months(all), ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    assert.deepEqual(all[2], { month: '2026-09', income: 0, expenses: 0, net: 0 });
  });

  it('0 returns an empty array (previously the whole series)', () => {
    assert.deepEqual(calculateMonthlyTotals(data, 0), []);
    assert.deepEqual(calculateMonthlyTotals(data, -0), []);
  });

  it('negative values return an empty array (previously a series cut from the wrong end)', () => {
    for (const n of [-1, -3, -100, -Infinity]) assert.deepEqual(calculateMonthlyTotals(data, n), [], String(n));
  });

  it('invalid values (NaN, values that round down to 0) return an empty array', () => {
    for (const n of [NaN, 0.5, 0.999]) assert.deepEqual(calculateMonthlyTotals(data, n), [], String(n));
  });

  it('positive values keep the LATEST n months with identical totals', () => {
    assert.deepEqual(months(calculateMonthlyTotals(data, 1)), ['2026-11']);
    assert.deepEqual(calculateMonthlyTotals(data, 1)[0], { month: '2026-11', income: 900, expenses: 60, net: 840 });
    assert.deepEqual(months(calculateMonthlyTotals(data, 3)), ['2026-09', '2026-10', '2026-11']);
    for (const n of [1, 2, 3, 4, 5]) assert.deepEqual(calculateMonthlyTotals(data, n), all.slice(-n), String(n));
  });

  it('a limit equal to or larger than the series returns all of it; Infinity means no limit', () => {
    assert.deepEqual(calculateMonthlyTotals(data, 5), all);
    assert.deepEqual(calculateMonthlyTotals(data, 12), all); // what the charts pass
    assert.deepEqual(calculateMonthlyTotals(data, 1_000_000), all);
    assert.deepEqual(calculateMonthlyTotals(data, Infinity), all);
  });

  it('fractions round down, consistent with monthRange', () => {
    assert.deepEqual(months(calculateMonthlyTotals(data, 2.9)), ['2026-10', '2026-11']);
  });

  it('empty input stays empty for every limit, and the input is not modified', () => {
    for (const n of [undefined, 0, -1, 12]) assert.deepEqual(calculateMonthlyTotals([], n), []);
    const snapshot = JSON.stringify(data);
    calculateMonthlyTotals(data, 0); calculateMonthlyTotals(data, 2);
    assert.equal(JSON.stringify(data), snapshot);
  });

  it('works with the old-date window: limits apply to the latest months, 0 stays empty', () => {
    const withOld = [tx('1900-01-01', 'expense', 1), ...data];
    assert.deepEqual(months(calculateMonthlyTotals(withOld, 2)), ['2026-10', '2026-11']);
    assert.deepEqual(calculateMonthlyTotals(withOld, 0), []);
  });
});
