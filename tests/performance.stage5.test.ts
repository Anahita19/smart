/**
 * Stage 5 – performance at 10,000 / 25,000 / 50,000 transactions.
 *
 * What is meaningful to test here: the pure logic that runs on every render or every save. (Browser
 * rendering, layout, localStorage speed and quota are not measurable in this environment and are
 * not claimed.) Budgets are deliberately generous — roughly 10–50× the times measured on the
 * development machine — so the tests catch accidental quadratic behaviour or a regression to
 * seconds, not normal machine-to-machine variation. Each timing is the median of several runs and
 * is printed as a diagnostic line. On a much slower machine, relax every budget at once:
 *
 *   PERF_BUDGET_SCALE=4 node --import ./tests/register-alias.mjs --test "tests/performance.stage5.test.ts"
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { calculateMonthlyTotals } from '../src/lib/analytics.ts';
import { MAX_BACKUP_CHARS, parseBackup } from '../src/lib/backup.ts';
import { calculateExpensesByCategory, calculateSummary, getRecentTransactions } from '../src/lib/calculations.ts';
import { actualTransactions } from '../src/lib/datePolicy.ts';
import { ALL_TIME, resolvePreset } from '../src/lib/dateRange.ts';
import { exportBackup } from '../src/lib/exportBackup.ts';
import { buildPeriodAnalysis, findUnusualExpenses } from '../src/lib/insights.ts';
import { STORAGE_KEY, openSession, parseStoredPayload, serializeEnvelope } from '../src/lib/storage.ts';
import type { StorageLike } from '../src/lib/storage.ts';
import { DEFAULT_FILTERS, filterTransactions, paginate, sortTransactions } from '../src/lib/transactionQuery.ts';
import type { SortKey } from '../src/lib/transactionQuery.ts';
import { formatCurrency } from '../src/lib/format.ts';
import { transactionsReducer } from '../src/state/transactionsReducer.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

const SCALE = Number(process.env.PERF_BUDGET_SCALE) > 0 ? Number(process.env.PERF_BUDGET_SCALE) : 1;
const TODAY = '2026-11-11';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const EXPENSE_CATEGORIES = ['housing', 'groceries', 'dining', 'transport', 'utilities', 'health', 'entertainment', 'shopping', 'travel', 'education', 'other-expense'];
const INCOME_CATEGORIES = ['salary', 'freelance', 'investments', 'other-income'];

const cache = new Map<number, Transaction[]>();
/** Deterministic, realistic data: UUID-shaped ids, 8 years of dates ending today, ~15% income. */
function dataset(count: number): Transaction[] {
  const hit = cache.get(count);
  if (hit) return hit;
  const next = rng(count);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('');
  const end = Date.parse(`${TODAY}T00:00:00Z`);
  const list: Transaction[] = Array.from({ length: count }, (_, i) => {
    const income = next() < 0.15;
    const categories = income ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    return {
      id: `tx-${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`,
      type: income ? 'income' : 'expense',
      amount: 100 + Math.floor(next() * 500_000),
      categoryId: categories[Math.floor(next() * categories.length)],
      description: `purchase ${i} ${hex(4)}`,
      date: new Date(end - Math.floor(next() * 365 * 8) * 86_400_000).toISOString().slice(0, 10),
    };
  });
  cache.set(count, list);
  return list;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Runs `fn` several times, reports the median as a diagnostic and asserts it is within budget. */
function within<T>(t: TestContext, label: string, budgetMs: number, fn: () => T, runs = 3): T {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  const ms = median(times);
  const budget = budgetMs * SCALE;
  t.diagnostic(`${label}: ${ms.toFixed(1)} ms (budget ${budget} ms)`);
  assert.ok(ms <= budget, `${label} took ${ms.toFixed(1)} ms, budget ${budget} ms`);
  return result;
}

async function withinAsync<T>(t: TestContext, label: string, budgetMs: number, fn: () => Promise<T>, runs = 2): Promise<T> {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = await fn();
    times.push(performance.now() - start);
  }
  const ms = median(times);
  const budget = budgetMs * SCALE;
  t.diagnostic(`${label}: ${ms.toFixed(1)} ms (budget ${budget} ms)`);
  assert.ok(ms <= budget, `${label} took ${ms.toFixed(1)} ms, budget ${budget} ms`);
  return result;
}

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

const SIZES = [10_000, 25_000, 50_000] as const;

// ───────────── per-render calculations ─────────────

describe('performance: calculations that run on every render', () => {
  for (const n of SIZES) {
    it(`Dashboard + Analytics figures for ${n.toLocaleString()} transactions`, (t) => {
      const data = dataset(n);
      within(t, `${n} summary`, 200, () => calculateSummary(data));
      within(t, `${n} by category`, 500, () => calculateExpensesByCategory(data));
      within(t, `${n} monthly totals`, 500, () => calculateMonthlyTotals(data));
      within(t, `${n} actual + recent`, 500, () => getRecentTransactions(actualTransactions(data, TODAY)));
    });
  }

  it('formatting 100,000 amounts stays fast (formatter is cached)', (t) => {
    within(t, 'format 100k amounts', 1_500, () => {
      for (let i = 0; i < 100_000; i++) formatCurrency(100 + i);
    });
  });
});

// ───────────── transactions page pipeline ─────────────

describe('performance: the Transactions page pipeline (filter → sort → paginate)', () => {
  for (const n of SIZES) {
    it(`${n.toLocaleString()} rows, every sort order, with and without a text search`, (t) => {
      const data = dataset(n);
      for (const sort of ['date-desc', 'date-asc', 'amount-desc', 'amount-asc'] as SortKey[]) {
        within(t, `${n} ${sort}`, 1_000, () => paginate(sortTransactions(filterTransactions(data, DEFAULT_FILTERS), sort), 1));
      }
      const searched = within(t, `${n} search+sort`, 1_000, () =>
        paginate(sortTransactions(filterTransactions(data, { ...DEFAULT_FILTERS, search: 'purchase 1', type: 'expense' }), 'date-desc'), 1),
      );
      assert.ok(searched.total > 0 && searched.items.length <= 10);
    });
  }

  it('walking all 5,000 pages of 50,000 rows finishes quickly and yields every row once', (t) => {
    const rows = sortTransactions(dataset(50_000), 'date-desc');
    const seen = new Set<string>();
    within(t, 'walk 5,000 pages', 2_000, () => {
      seen.clear();
      const { pageCount } = paginate(rows, 1);
      for (let p = 1; p <= pageCount; p++) for (const row of paginate(rows, p).items) seen.add(row.id);
    }, 2);
    assert.equal(seen.size, 50_000);
  });
});

// ───────────── add / edit / delete on a large list ─────────────

describe('performance: single writes on a 50,000-row list', () => {
  const base = dataset(50_000);
  const fresh: Transaction = { id: 'perf-new', type: 'expense', amount: 1_234, categoryId: 'dining', description: 'new', date: '2025-01-01' };

  it('add, update and delete each take a few milliseconds and are correct', (t) => {
    const added = within(t, 'add', 100, () => transactionsReducer(base, { type: 'add', transaction: fresh, today: TODAY }), 5);
    assert.equal(added.length, 50_001);
    const updated = within(t, 'update', 100, () => transactionsReducer(base, { type: 'update', transaction: { ...base[25_000], amount: 7 }, today: TODAY }), 5);
    assert.equal(updated[25_000].amount, 7);
    const deleted = within(t, 'delete', 100, () => transactionsReducer(base, { type: 'delete', id: base[10].id }), 5);
    assert.equal(deleted.length, 49_999);
  });

  it('200 consecutive edits (the worst a person could do in a sitting) stay well under a second', (t) => {
    within(t, '200 sequential updates', 2_500, () => {
      let state = base;
      for (let i = 0; i < 200; i++) state = transactionsReducer(state, { type: 'update', transaction: { ...state[i * 100], amount: 1 + i }, today: TODAY });
      return state;
    }, 2);
  });
});

// ───────────── persistence ─────────────

describe('performance: saving and loading', () => {
  for (const n of SIZES) {
    it(`serialize, parse, open a session and save ${n.toLocaleString()} transactions`, (t) => {
      const data = dataset(n);
      const raw = within(t, `${n} serializeEnvelope`, 1_000, () => serializeEnvelope(data));
      const parsed = within(t, `${n} parseStoredPayload`, 3_000, () => parseStoredPayload(raw));
      assert.ok(parsed.status === 'ok' && parsed.accepted === n && parsed.invalid === 0);

      const store = new MemoryStorage();
      store.data.set(STORAGE_KEY, raw);
      const session = within(t, `${n} openSession`, 3_000, () => openSession(store));
      assert.equal(session.boot.status, 'ok');
      assert.equal(session.boot.transactions.length, n);
      within(t, `${n} session.save`, 3_000, () => session.save([...session.boot.transactions].reverse()), 2);
      assert.equal(session.save([...session.boot.transactions].reverse()).status, 'saved');
    });
  }
});

describe('performance: backup export, verification and restore', () => {
  it('25,000 transactions: export (with its own verification), preview and restore', async (t) => {
    const data = dataset(25_000);
    let text = '';
    const outcome = await withinAsync(t, '25k exportBackup', 5_000, () =>
      exportBackup(data, { save: (file) => { text = file; return () => {}; } }),
    );
    assert.equal(outcome.ok, true);
    assert.ok(text.length > 0 && text.length <= MAX_BACKUP_CHARS);
    t.diagnostic(`25k backup size: ${text.length.toLocaleString()} characters (limit ${MAX_BACKUP_CHARS.toLocaleString()})`);

    const parsed = await withinAsync(t, '25k parseBackup', 5_000, () => parseBackup(text));
    assert.ok(parsed.ok && parsed.transactions.length === 25_000 && parsed.meta.checksum === 'verified');

    const restored = within(t, '25k merge restore into an empty app', 5_000, () => {
      const fresh = new MemoryStorage();
      return openSession(fresh).restore({ mode: 'merge', incoming: parsed.ok ? parsed.transactions : [], conflictPolicy: 'keep-existing' });
    }, 2);
    assert.ok(restored.status === 'restored' && restored.transactions.length === 25_000);
  });

  it('50,000 transactions exceed the backup size limit: the export is refused cleanly — no file, no exception', async (t) => {
    const data = dataset(50_000);
    let saved = false;
    const outcome = await withinAsync(t, '50k exportBackup (refused)', 8_000, () =>
      exportBackup(data, { save: () => { saved = true; return () => {}; } }),
    1);
    assert.equal(outcome.ok, false);
    assert.equal(saved, false, 'a file that could not be read back must never be handed to the browser');
    assert.equal(data.length, 50_000, 'the list itself is untouched');
  });
});

// ───────────── Insights analysis ─────────────

describe('performance: the Insights analysis (buildPeriodAnalysis)', () => {
  it('a month or three of a large history is fast: 10,000 rows of history', (t) => {
    const data = dataset(10_000);
    for (const preset of ['month', '30d', '3m'] as const) {
      within(t, `10k history, ${preset}`, 1_500, () => buildPeriodAnalysis(data, resolvePreset(preset, TODAY), preset, TODAY), 2);
    }
  });

  it('a month of a 50,000-row history is within a few seconds', (t) => {
    const data = dataset(50_000);
    const analysis = within(t, '50k history, month', 5_000, () => buildPeriodAnalysis(data, resolvePreset('month', TODAY), 'month', TODAY), 1);
    assert.ok(analysis.current.length > 0);
  });

  it('all time over 2,000 rows is fast, and its totals match the plain summary', (t) => {
    const data = dataset(2_000);
    const analysis = within(t, '2k history, all time', 2_000, () => buildPeriodAnalysis(data, ALL_TIME, 'all', TODAY), 2);
    assert.equal(analysis.stats.totalExpenses, calculateSummary(data).totalExpenses);
  });

  /**
   * Regression test for a defect found in the Stage 5 audit and since fixed: findUnusualExpenses
   * (called by generateInsights with every expense in the selected range) rebuilt and sorted the
   * category's peer list once per candidate, so "All time" cost grew with the square of the range
   * (measured before the fix: 10,000 rows ≈ 3 s · 25,000 ≈ 21 s · 50,000 ≈ 99 s). It now sorts each
   * category once and answers each candidate with binary searches.
   */
  it('all time over 10,000 rows takes under one second', (t) => {
    const data = dataset(10_000);
    within(t, '10k history, all time', 1_000, () => buildPeriodAnalysis(data, ALL_TIME, 'all', TODAY), 1);
  });

  it('all time over 50,000 rows is no longer quadratic (it froze the page for ~100 s before)', (t) => {
    const data = dataset(50_000);
    const analysis = within(t, '50k history, all time', 3_000, () => buildPeriodAnalysis(data, ALL_TIME, 'all', TODAY), 1);
    assert.equal(analysis.stats.totalExpenses, calculateSummary(data).totalExpenses);
  });

  it('findUnusualExpenses alone: 50,000 rows, every expense a candidate', (t) => {
    const data = dataset(50_000);
    const expenses = data.filter((x) => x.type === 'expense');
    within(t, 'findUnusualExpenses 50k', 2_000, () => findUnusualExpenses(data, expenses, TODAY), 3);
  });

  it('findUnusualExpenses cost scales roughly linearly, not with the square', (t) => {
    const time = (n: number) => {
      const data = dataset(n);
      const expenses = data.filter((x) => x.type === 'expense');
      findUnusualExpenses(data, expenses, TODAY); // warm-up
      const runs = Array.from({ length: 3 }, () => {
        const start = performance.now();
        findUnusualExpenses(data, expenses, TODAY);
        return performance.now() - start;
      });
      return median(runs);
    };
    const small = Math.max(time(10_000), 5); // floor: avoids dividing by timer noise
    const large = time(50_000);
    t.diagnostic(`findUnusualExpenses: 10k ${small.toFixed(1)} ms, 50k ${large.toFixed(1)} ms (5x the rows)`);
    // 5x the rows: ~5-9x when (near) linear, ~30x when quadratic (3.2 s -> 99 s was measured before the fix).
    assert.ok(large <= small * 20, `50k took ${large.toFixed(1)} ms vs ${small.toFixed(1)} ms for 10k`);
  });

  it('findUnusualExpenses never flags anything in a history too small to judge', (t) => {
    // 4 expenses in one category: below the minimum number of peers, so nothing may be flagged.
    const tiny: Transaction[] = ['2026-05-02', '2026-06-02', '2026-07-02', '2026-08-02'].map((date, i) => ({
      id: `t${i}`, type: 'expense', amount: i === 3 ? 900_000 : 2_000, categoryId: 'shopping', description: `thing ${i}`, date,
    }));
    const found = within(t, 'tiny history', 50, () => findUnusualExpenses(tiny, tiny, TODAY));
    assert.deepEqual(found, []);
  });
});
