/**
 * Regression tests for the monthly analysis window (src/lib/analytics.ts).
 *
 * Bug: monthRange() walked forward from the earliest month and stopped after 600 months, so a
 * single very old transaction (e.g. 1900) made the *recent* months disappear. The window must
 * always end at the latest month.
 *
 * Run (no dependencies needed, Node >= 22.18):
 *   node --import ./tests/register-alias.mjs --test tests/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MONTH_RANGE,
  calculateMonthlyTotals,
  monthRange,
  shiftMonth,
} from '../src/lib/analytics.ts';
import type { Transaction } from '../src/types/transaction.ts';

let seq = 0;
const tx = (date: string, type: 'income' | 'expense', amount: number): Transaction =>
  ({ id: `t${++seq}`, type, amount, categoryId: 'other', description: 'x', date }) as Transaction;

const isConsecutive = (keys: string[]) => keys.every((k, i) => i === 0 || k === shiftMonth(keys[i - 1], 1));

describe('shiftMonth', () => {
  it('crosses year boundaries in both directions', () => {
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
    assert.equal(shiftMonth('2026-11', -599), '1976-12');
  });
  it('keeps keys sortable by zero-padding years below 1000', () => {
    assert.equal(shiftMonth('0999-12', 1), '1000-01');
    assert.equal(shiftMonth('1000-01', -1), '0999-12');
  });
});

describe('monthRange', () => {
  it('returns every month inclusive, oldest first, for normal ranges', () => {
    assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
    assert.deepEqual(monthRange('2026-05', '2026-05'), ['2026-05']);
  });
  it('returns [] for a reversed range or malformed keys', () => {
    assert.deepEqual(monthRange('2026-05', '2026-04'), []);
    assert.deepEqual(monthRange('abcd-ef', '2026-04'), []);
  });
  it('600-month boundary: exactly 600 months are all kept', () => {
    const r = monthRange('1977-01', '2026-12'); // 50 years = 600 months
    assert.equal(r.length, 600);
    assert.equal(r[0], '1977-01');
    assert.equal(r[599], '2026-12');
  });
  it('600-month boundary: 601 months drops the OLDEST month, never the newest', () => {
    const r = monthRange('1976-12', '2026-12');
    assert.equal(r.length, 600);
    assert.equal(r[0], '1977-01');
    assert.equal(r.at(-1), '2026-12');
  });
  it('a span of 1900..2026 keeps the latest 600 months, consecutive and ending at `to`', () => {
    const r = monthRange('1900-01', '2026-11');
    assert.equal(r.length, MAX_MONTH_RANGE);
    assert.equal(r.at(-1), '2026-11');
    assert.equal(r[0], '1976-12'); // 599 months before 2026-11
    assert.ok(isConsecutive(r));
  });
  it('honours a custom maximum', () => {
    assert.deepEqual(monthRange('2020-01', '2026-11', 3), ['2026-09', '2026-10', '2026-11']);
    assert.deepEqual(monthRange('2026-10', '2026-11', 3), ['2026-10', '2026-11']);
    assert.deepEqual(monthRange('2020-01', '2026-11', 0), []);
  });
});

describe('calculateMonthlyTotals with very old transactions', () => {
  const recent = [
    tx('2026-11-03', 'income', 500_000),
    tx('2026-11-09', 'expense', 120_000),
    tx('2026-10-15', 'expense', 80_000),
    tx('2026-08-01', 'income', 30_000),
  ];

  it('a 1900 transaction never makes recent months disappear (unlimited window)', () => {
    const totals = calculateMonthlyTotals([tx('1900-01-01', 'expense', 100), ...recent]);
    assert.equal(totals.length, MAX_MONTH_RANGE);
    assert.equal(totals.at(-1)?.month, '2026-11');
    assert.deepEqual(totals.at(-1), { month: '2026-11', income: 500_000, expenses: 120_000, net: 380_000 });
    assert.deepEqual(totals.find((m) => m.month === '2026-10'), {
      month: '2026-10', income: 0, expenses: 80_000, net: -80_000,
    });
    assert.deepEqual(totals.find((m) => m.month === '2026-09'), { month: '2026-09', income: 0, expenses: 0, net: 0 });
    assert.ok(isConsecutive(totals.map((m) => m.month)));
  });

  it('the latest 12 months are identical with or without the 1900 transaction', () => {
    const without = calculateMonthlyTotals(recent); // Aug..Nov 2026 (4 months)
    const withOld = calculateMonthlyTotals([tx('1900-06-15', 'income', 999), ...recent], 12);
    assert.equal(withOld.length, 12);
    assert.equal(withOld.at(-1)?.month, '2026-11');
    // Same figures for every month the two series share...
    assert.deepEqual(withOld.slice(-without.length), without);
    // ...and the extra months to the left are plain zero months (Dec 2025 - Jul 2026).
    assert.ok(withOld.slice(0, 8).every((m) => m.income === 0 && m.expenses === 0 && m.net === 0));
  });

  it('the order of the input does not matter', () => {
    const old = tx('1900-01-01', 'expense', 100);
    assert.deepEqual(calculateMonthlyTotals([...recent, old], 12), calculateMonthlyTotals([old, ...recent], 12));
  });

  it('600-month boundary: oldest month exactly 599 months before the newest is kept with its totals', () => {
    const t = calculateMonthlyTotals([tx('1977-01-10', 'income', 777), tx('2026-12-01', 'expense', 5)]);
    assert.equal(t.length, 600);
    assert.deepEqual(t[0], { month: '1977-01', income: 777, expenses: 0, net: 777 });
    assert.equal(t.at(-1)?.month, '2026-12');
  });

  it('600-month boundary: a month 600 months before the newest falls out of the window', () => {
    const t = calculateMonthlyTotals([tx('1976-12-10', 'income', 777), tx('2026-12-01', 'expense', 5)]);
    assert.equal(t.length, 600);
    assert.equal(t[0].month, '1977-01');
    assert.deepEqual(t.at(-1), { month: '2026-12', income: 0, expenses: 5, net: -5 });
  });

  it('only old transactions: the window ends at the newest of them', () => {
    const t = calculateMonthlyTotals([tx('1900-01-01', 'expense', 1), tx('1999-05-01', 'income', 2)], 2);
    assert.deepEqual(t.map((m) => m.month), ['1999-04', '1999-05']);
  });
});

describe('normal date ranges are unchanged (compared with an uncapped reference)', () => {
  // Reference: the original algorithm minus the cap, written independently of the implementation.
  function reference(list: Transaction[], months?: number) {
    const byMonth = new Map<string, { income: number; expenses: number }>();
    for (const t of list) {
      const key = t.date.slice(0, 7);
      const b = byMonth.get(key) ?? { income: 0, expenses: 0 };
      if (t.type === 'income') b.income += t.amount; else b.expenses += t.amount;
      byMonth.set(key, b);
    }
    const keys = [...byMonth.keys()].sort();
    const out = [];
    for (let k = keys[0]; k <= keys.at(-1)!; k = shiftMonth(k, 1)) {
      const { income, expenses } = byMonth.get(k) ?? { income: 0, expenses: 0 };
      out.push({ month: k, income, expenses, net: income - expenses });
    }
    return months === undefined ? out : out.slice(-months);
  }

  it('matches for 200 pseudo-random data sets spanning up to 40 years', () => {
    let state = 12345;
    const rand = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rand() * 40);
      const list: Transaction[] = [];
      for (let i = 0; i < n; i++) {
        const y = 1990 + Math.floor(rand() * 37);
        const m = 1 + Math.floor(rand() * 12);
        const d = 1 + Math.floor(rand() * 28);
        const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        list.push(tx(date, rand() < 0.4 ? 'income' : 'expense', 1 + Math.floor(rand() * 100_000)));
      }
      assert.deepEqual(calculateMonthlyTotals(list), reference(list));
      assert.deepEqual(calculateMonthlyTotals(list, 12), reference(list, 12));
    }
  });

  it('empty input and a single transaction', () => {
    assert.deepEqual(calculateMonthlyTotals([]), []);
    assert.deepEqual(calculateMonthlyTotals([tx('2026-11-11', 'expense', 9)]), [
      { month: '2026-11', income: 0, expenses: 9, net: -9 },
    ]);
  });
});
