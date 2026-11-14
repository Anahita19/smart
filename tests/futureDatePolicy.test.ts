/**
 * Regression tests for the shared date policy (src/lib/datePolicy.ts): transactions dated after
 * today are not actual transactions. Covers the form rule, the data-source filter used by Dashboard
 * and Analytics, Insights, the Transactions page listing and extreme old/future dates.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { availableMonths, calculateMonthlyTotals, filterByMonth, MAX_MONTH_RANGE } from '../src/lib/analytics.ts';
import { calculateExpensesByCategory, calculateSummary, getRecentTransactions } from '../src/lib/calculations.ts';
import {
  FUTURE_DATE_MESSAGE,
  actualTransactions,
  futureTransactions,
  isFutureDate,
  todayISO,
} from '../src/lib/datePolicy.ts';
import { ALL_TIME } from '../src/lib/dateRange.ts';
import { buildPeriodAnalysis } from '../src/lib/insights.ts';
import { DEFAULT_FILTERS, filterTransactions } from '../src/lib/transactionQuery.ts';
import { toTransactionInput, validateTransactionForm } from '../src/lib/validation.ts';
import type { TransactionFormValues } from '../src/lib/validation.ts';
import type { Transaction } from '../src/types/transaction.ts';

const TODAY = '2026-11-11';
let seq = 0;
const tx = (date: string, type: 'income' | 'expense', amount: number, categoryId = 'groceries'): Transaction =>
  ({ id: `f${++seq}`, type, amount, categoryId, description: `${type} ${date}`, date }) as Transaction;

describe('todayISO / isFutureDate', () => {
  it('uses the local calendar date, zero-padded', () => {
    assert.equal(todayISO(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.equal(todayISO(new Date(2026, 10, 11, 0, 0)), '2026-11-11');
  });
  it('today and the past are not future; tomorrow and later are', () => {
    assert.equal(isFutureDate('2026-11-11', TODAY), false); // today
    assert.equal(isFutureDate('2026-11-10', TODAY), false); // yesterday
    assert.equal(isFutureDate('1900-01-01', TODAY), false); // very old
    assert.equal(isFutureDate('2026-11-12', TODAY), true); // tomorrow
    assert.equal(isFutureDate('2027-01-01', '2026-12-31'), true); // year boundary
    assert.equal(isFutureDate('2099-01-01', TODAY), true); // extreme future
  });
});

describe('actualTransactions / futureTransactions', () => {
  const futureIncome = tx('2027-03-01', 'income', 900_000);
  const futureExpense = tx('2026-11-12', 'expense', 5_000);
  const todayTx = tx(TODAY, 'expense', 1_200);
  const historical = tx('2026-05-20', 'income', 700_000);
  const ancient = tx('1900-01-01', 'expense', 100);
  const all = [futureIncome, historical, futureExpense, todayTx, ancient];

  it('keeps today, historical and very old; drops future income and future expenses', () => {
    assert.deepEqual(actualTransactions(all, TODAY).map((t) => t.id), [historical, todayTx, ancient].map((t) => t.id));
    assert.deepEqual(futureTransactions(all, TODAY).map((t) => t.id), [futureIncome, futureExpense].map((t) => t.id));
  });
  it('is a partition: nothing lost, nothing counted twice, input untouched', () => {
    const copy = [...all];
    assert.equal(actualTransactions(all, TODAY).length + futureTransactions(all, TODAY).length, all.length);
    assert.deepEqual(all, copy);
  });
  it('future income no longer inflates balance; future expense no longer reduces it', () => {
    const s = calculateSummary(actualTransactions(all, TODAY));
    assert.equal(s.totalIncome, 700_000);
    assert.equal(s.totalExpenses, 1_300);
    assert.equal(s.balance, 698_700);
  });
});

describe('transaction form validation', () => {
  const valid: TransactionFormValues = {
    type: 'expense', amount: '12.50', categoryId: 'groceries', description: 'Milk', date: TODAY,
  };
  it('accepts today and earlier dates', () => {
    assert.equal(validateTransactionForm(valid, TODAY).date, undefined);
    assert.equal(validateTransactionForm({ ...valid, date: '2026-11-10' }, TODAY).date, undefined);
    assert.equal(validateTransactionForm({ ...valid, date: '1900-01-01' }, TODAY).date, undefined);
  });
  it('rejects tomorrow, far-future dates and the year boundary with a clear message', () => {
    for (const date of ['2026-11-12', '2099-01-01']) {
      assert.equal(validateTransactionForm({ ...valid, date }, TODAY).date, FUTURE_DATE_MESSAGE);
    }
    assert.equal(validateTransactionForm({ ...valid, date: '2027-01-01' }, '2026-12-31').date, FUTURE_DATE_MESSAGE);
    assert.match(FUTURE_DATE_MESSAGE, /future/i);
  });
  it('applies to income too, and when updating an existing future-dated record', () => {
    assert.equal(validateTransactionForm({ ...valid, type: 'income', categoryId: 'salary', date: '2027-03-01' }, TODAY).date, FUTURE_DATE_MESSAGE);
    // editing only the description of a record that still has a future date is still blocked...
    assert.equal(validateTransactionForm({ ...valid, description: 'renamed', date: '2027-03-01' }, TODAY).date, FUTURE_DATE_MESSAGE);
    // ...until the date is corrected.
    assert.equal(validateTransactionForm({ ...valid, description: 'renamed', date: TODAY }, TODAY).date, undefined);
  });
  it('keeps the other date messages', () => {
    assert.equal(validateTransactionForm({ ...valid, date: '' }, TODAY).date, 'Choose a date.');
    assert.equal(validateTransactionForm({ ...valid, date: '2026-02-31' }, TODAY).date, 'Enter a valid date.');
  });
  it('toTransactionInput refuses a future date and accepts today', () => {
    // The real clock is used here (no injection point): build dates relative to it.
    const real = todayISO();
    const tomorrow = todayISO(new Date(Date.now() + 36 * 3_600_000));
    assert.notEqual(tomorrow, real);
    assert.equal(toTransactionInput({ ...valid, date: tomorrow }), null);
    assert.deepEqual(toTransactionInput({ ...valid, date: real })?.date, real);
  });
});

describe('Dashboard, Analytics, Insights and Transactions agree', () => {
  const data = [
    tx('1900-02-01', 'expense', 1_000),
    tx('2026-09-02', 'income', 400_000, 'salary'), tx('2026-09-10', 'expense', 100_000, 'rent'),
    tx('2026-10-02', 'income', 400_000, 'salary'), tx('2026-10-10', 'expense', 350_000, 'rent'),
    tx('2026-11-02', 'income', 100_000, 'salary'), tx('2026-11-05', 'expense', 90_000, 'groceries'),
    tx(TODAY, 'expense', 2_500, 'groceries'), // today counts
    tx('2026-11-20', 'income', 777_000, 'salary'), // future income, same month as today
    tx('2027-03-01', 'expense', 66_000, 'groceries'), // future expense
    tx('2099-01-01', 'expense', 5_000, 'groceries'), // extreme future ("typo")
  ];
  const actual = actualTransactions(data, TODAY);
  const insights = buildPeriodAnalysis(data, ALL_TIME, 'all', TODAY);

  it('Dashboard totals == Analytics (all time) totals == Insights totals', () => {
    const dashboard = calculateSummary(actual);
    const analytics = calculateSummary(filterByMonth(actual, 'all'));
    assert.deepEqual(analytics, dashboard);
    assert.equal(insights.stats.totalIncome, dashboard.totalIncome);
    assert.equal(insights.stats.totalExpenses, dashboard.totalExpenses);
    assert.equal(insights.stats.savings, dashboard.balance);
    assert.equal(insights.stats.transactionCount, actual.length);
    assert.equal(dashboard.totalIncome, 900_000); // future 777,000 income is NOT in it
    assert.equal(dashboard.totalExpenses, 1_000 + 100_000 + 350_000 + 90_000 + 2_500);
  });

  it('category breakdowns match', () => {
    assert.deepEqual(insights.byCategory, calculateExpensesByCategory(actual));
  });

  it('Analytics chart == Insights chart, and ends at the current month with real data', () => {
    const analyticsChart = calculateMonthlyTotals(actual, 12);
    assert.deepEqual(analyticsChart, insights.monthly);
    assert.equal(analyticsChart.at(-1)?.month, '2026-11');
    assert.deepEqual(analyticsChart.at(-1), { month: '2026-11', income: 100_000, expenses: 92_500, net: 7_500 });
    assert.equal(analyticsChart.length, 12);
  });

  it('no future month is offered by Analytics or appears in Insights', () => {
    assert.equal(availableMonths(actual)[0], '2026-11');
    assert.ok(!availableMonths(actual).some((m) => m > '2026-11'));
    assert.ok(!insights.savings.some((m) => m.month > '2026-11'));
  });

  it('Dashboard "recent" never leads with a future-dated entry', () => {
    assert.equal(getRecentTransactions(actual, 1)[0].date, TODAY);
  });

  it('Transactions page still lists every record, including future-dated ones', () => {
    const listed = filterTransactions(data, DEFAULT_FILTERS);
    assert.equal(listed.length, data.length);
    assert.equal(futureTransactions(listed, TODAY).length, 3);
    // "Show them" filter = dateFrom tomorrow -> exactly the flagged records
    const onlyFuture = filterTransactions(data, { ...DEFAULT_FILTERS, dateFrom: '2026-11-12' });
    assert.deepEqual(onlyFuture.map((t) => t.id).sort(), futureTransactions(data, TODAY).map((t) => t.id).sort());
  });

  it('records are never modified or removed by the policy', () => {
    const snapshot = JSON.stringify(data);
    actualTransactions(data, TODAY);
    futureTransactions(data, TODAY);
    buildPeriodAnalysis(data, ALL_TIME, 'all', TODAY);
    assert.equal(JSON.stringify(data), snapshot);
  });

  it('a today-dated record is included and its month is flagged in progress', () => {
    assert.ok(insights.current.some((t) => t.date === TODAY));
    assert.ok(insights.partialMonths.has('2026-11'));
  });
});

describe('month range with extreme old AND extreme future dates', () => {
  const recent = [tx('2026-10-15', 'expense', 80_000), tx('2026-11-03', 'income', 500_000)];
  const extremes = [tx('1900-01-01', 'expense', 1), tx('2099-01-01', 'expense', 2), tx('9999-12-31', 'income', 3)];
  const data = [...extremes, ...recent];

  it('through the policy, the 12-month and full charts always end at the latest ACTUAL month', () => {
    const actual = actualTransactions(data, TODAY);
    const twelve = calculateMonthlyTotals(actual, 12);
    assert.equal(twelve.at(-1)?.month, '2026-11');
    assert.deepEqual(twelve.at(-1), { month: '2026-11', income: 500_000, expenses: 0, net: 500_000 });
    assert.deepEqual(twelve.at(-2), { month: '2026-10', income: 0, expenses: 80_000, net: -80_000 });
    const full = calculateMonthlyTotals(actual);
    assert.equal(full.length, MAX_MONTH_RANGE);
    assert.equal(full.at(-1)?.month, '2026-11');
  });
  it('through Insights, extreme dates never move the chart or savings table', () => {
    const a = buildPeriodAnalysis(data, ALL_TIME, 'all', TODAY);
    assert.equal(a.monthly.at(-1)?.month, '2026-11');
    assert.equal(a.savings.at(-1)?.month, '2026-11');
    assert.equal(a.stats.transactionCount, 3); // 1900 + two recent; 2099 and 9999 excluded
  });
  it('documents WHY the filter sits at the data source: raw data would hide recent months', () => {
    const raw = calculateMonthlyTotals(data, 12);
    assert.equal(raw.at(-1)?.month, '9999-12');
    assert.ok(!raw.some((m) => m.month === '2026-11'));
  });
  it('only-future data yields empty actual data, not a chart of future months', () => {
    assert.deepEqual(calculateMonthlyTotals(actualTransactions([tx('2099-01-01', 'expense', 5)], TODAY), 12), []);
  });
});

describe('wiring guard (source text): screens must read actual transactions via the shared policy', () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  it('Dashboard is fed actual transactions by App', () => {
    const app = read('App.tsx');
    assert.match(app, /useActualTransactions\(\)/);
    assert.match(app, /<Dashboard[^>]*transactions=\{actualTransactions\}/s);
  });
  it('AnalyticsPage reads actual transactions and never the raw list', () => {
    const page = read('components/analytics/AnalyticsPage.tsx');
    assert.match(page, /useActualTransactions\(\)/);
    assert.doesNotMatch(page, /useTransactions\(\)/);
  });
  it('Insights builds from the shared policy; TransactionsPage keeps the raw list', () => {
    assert.match(read('lib/insights.ts'), /actualTransactions\(transactions, today\)/);
    assert.match(read('components/transactions/TransactionsPage.tsx'), /useTransactions\(\)/);
  });
  it('no screen re-implements a date cut-off of its own', () => {
    for (const file of ['App.tsx', 'components/dashboard/Dashboard.tsx', 'components/analytics/AnalyticsPage.tsx']) {
      assert.doesNotMatch(read(file), /\.date\s*[<>]=?\s*(today|asOf)|date\s*>\s*today/);
    }
  });
});
