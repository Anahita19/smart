/**
 * Phase 3 hardening regression tests.
 *
 *  1. Data-layer date rule: no code path can ADD or UPDATE a transaction to a future (or invalid)
 *     date, even when the form is bypassed; existing future-dated records are kept and can still be
 *     corrected or deleted.
 *  2. Consistent "today": every screen derives today from the clock at render time (nothing caches
 *     it), so the whole app follows the calendar across midnight.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { availableMonths, calculateMonthlyTotals } from '../src/lib/analytics.ts';
import { calculateSummary } from '../src/lib/calculations.ts';
import {
  FUTURE_DATE_MESSAGE,
  INVALID_DATE_MESSAGE,
  actualTransactions,
  checkTransactionDate,
  futureTransactions,
  todayISO,
} from '../src/lib/datePolicy.ts';
import { ALL_TIME, resolvePreset } from '../src/lib/dateRange.ts';
import { buildPeriodAnalysis } from '../src/lib/insights.ts';
import { openSession } from '../src/lib/storage.ts';
import { transactionsReducer } from '../src/state/transactionsReducer.ts';
import type { TransactionAction } from '../src/state/transactionsReducer.ts';
import type { Transaction } from '../src/types/transaction.ts';

const TODAY = '2026-11-11';
const mk = (id: string, date: string, over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_000, categoryId: 'groceries', description: `tx ${id}`, date, ...over,
});
const add = (t: Transaction, today: string = TODAY): TransactionAction => ({ type: 'add', transaction: t, today });
const update = (t: Transaction, today: string = TODAY): TransactionAction => ({ type: 'update', transaction: t, today });

// ───────────────────────────── 1. data-layer validation ─────────────────────────────

describe('checkTransactionDate (the central write rule)', () => {
  it('accepts today, yesterday and very old dates', () => {
    for (const d of [TODAY, '2026-11-10', '1900-01-01']) assert.deepEqual(checkTransactionDate(d, TODAY), { ok: true });
  });
  it('rejects tomorrow, far-future and year-boundary dates as "future"', () => {
    for (const [d, today] of [['2026-11-12', TODAY], ['2099-01-01', TODAY], ['2027-01-01', '2026-12-31']]) {
      assert.deepEqual(checkTransactionDate(d, today), { ok: false, reason: 'future', message: FUTURE_DATE_MESSAGE });
    }
  });
  it('rejects empty, malformed and impossible dates as "invalid" (they would otherwise slip past a string compare)', () => {
    for (const d of ['', 'abc', '2026-2-3', '2026-02-31', '2026-13-01', '11/11/2026']) {
      assert.deepEqual(checkTransactionDate(d, TODAY), { ok: false, reason: 'invalid', message: INVALID_DATE_MESSAGE }, d);
    }
  });
});

describe('reducer: add', () => {
  const existing = [mk('a', '2026-11-01'), mk('f', '2027-03-01')];

  it('rejects a future-dated add, keeping the very same state object', () => {
    for (const date of ['2026-11-12', '2027-03-01', '2099-01-01', '9999-12-31']) {
      assert.equal(transactionsReducer(existing, add(mk('n', date))), existing, date);
    }
  });
  it('rejects it for income too, and rejects invalid dates', () => {
    assert.equal(transactionsReducer(existing, add(mk('n', '2026-11-12', { type: 'income', categoryId: 'salary' }))), existing);
    for (const date of ['', 'nope', '2026-02-31']) assert.equal(transactionsReducer(existing, add(mk('n', date))), existing, date);
  });
  it('still accepts today and past dates (new record first, as before)', () => {
    for (const date of [TODAY, '2026-11-10', '1900-01-01']) {
      const next = transactionsReducer(existing, add(mk('n', date)));
      assert.equal(next.length, 3);
      assert.equal(next[0].id, 'n');
    }
  });
  it('judges against the stamped today: a date that is "today" only after midnight is refused before it', () => {
    assert.equal(transactionsReducer(existing, add(mk('n', '2026-11-12'), '2026-11-11')), existing);
    assert.equal(transactionsReducer(existing, add(mk('n', '2026-11-12'), '2026-11-12')).length, 3);
  });
  it('falls back to the real clock when no today is stamped on the action', () => {
    const real = todayISO();
    const tomorrow = todayISO(new Date(Date.now() + 36 * 3_600_000));
    assert.equal(transactionsReducer(existing, { type: 'add', transaction: mk('n', tomorrow) }), existing);
    assert.equal(transactionsReducer(existing, { type: 'add', transaction: mk('n', real) }).length, 3);
  });
});

describe('reducer: update', () => {
  const futureRec = mk('f', '2027-03-01');
  const state = [mk('a', '2026-11-01'), futureRec, mk('b', '2026-10-01')];

  it('lets an existing future-dated record be corrected to today or any past date', () => {
    for (const date of [TODAY, '2026-11-10', '2026-03-01']) {
      const next = transactionsReducer(state, update({ ...futureRec, date }));
      assert.equal(next.find((t) => t.id === 'f')?.date, date);
      assert.deepEqual(next.filter((t) => t.id !== 'f'), state.filter((t) => t.id !== 'f')); // others untouched
      assert.equal(next.length, state.length);
    }
  });
  it('lets it change to a valid date together with other edits', () => {
    const next = transactionsReducer(state, update({ ...futureRec, date: TODAY, description: 'fixed', amount: 2_000 }));
    assert.deepEqual(next.find((t) => t.id === 'f'), { ...futureRec, date: TODAY, description: 'fixed', amount: 2_000 });
  });
  it('refuses to save a future-dated record that still has a future date (even if only the description changed)', () => {
    assert.equal(transactionsReducer(state, update({ ...futureRec, description: 'renamed' })), state);
    assert.equal(transactionsReducer(state, update({ ...futureRec, date: '2027-04-01' })), state);
    assert.equal(state[1], futureRec); // record untouched
  });
  it('refuses to move a normal record into the future or to an invalid date', () => {
    for (const date of ['2026-11-12', '2099-01-01', '', '2026-02-31']) {
      assert.equal(transactionsReducer(state, update({ ...state[0], date })), state, date);
    }
  });
  it('an update for an unknown id is still a harmless no-op', () => {
    assert.deepEqual(transactionsReducer(state, update(mk('zzz', TODAY))), state);
  });
});

describe('existing records are neither deleted nor migrated', () => {
  const futureRec = mk('f', '2027-03-01');
  const state = [mk('a', '2026-11-01'), futureRec];

  it('valid writes leave an existing future-dated record exactly as it was', () => {
    const afterAdd = transactionsReducer(state, add(mk('n', TODAY)));
    assert.equal(afterAdd.find((t) => t.id === 'f'), futureRec);
    const afterUpdate = transactionsReducer(state, update({ ...state[0], description: 'edit' }));
    assert.equal(afterUpdate.find((t) => t.id === 'f'), futureRec);
  });
  it('rejected writes leave everything alone', () => {
    const snapshot = JSON.stringify(state);
    transactionsReducer(state, add(mk('n', '2099-01-01')));
    transactionsReducer(state, update({ ...state[0], date: '2099-01-01' }));
    assert.equal(JSON.stringify(state), snapshot);
  });
  it('delete is never blocked, including for a future-dated record', () => {
    assert.deepEqual(transactionsReducer(state, { type: 'delete', id: 'f' }).map((t) => t.id), ['a']);
  });
  it('stored future-dated records load back unchanged (loading does not go through the write rule)', () => {
    const data = new Map<string, string>();
    const store = {
      get length() { return data.size; },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    assert.equal(openSession(store).save(state).status, 'saved');
    const reopened = openSession(store);
    assert.equal(reopened.boot.status, 'ok');
    assert.deepEqual(reopened.boot.transactions, state);
  });
});

describe('wiring guard (source text): the rule lives in the central write path, not just the form', () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  const ctx = read('state/TransactionsContext.tsx');
  const body = (name: 'addTransaction' | 'updateTransaction') => {
    const start = ctx.indexOf(`const ${name} = useCallback`);
    assert.ok(start >= 0, `${name} not found`);
    return ctx.slice(start, ctx.indexOf('}, []);', start));
  };

  for (const name of ['addTransaction', 'updateTransaction'] as const) {
    it(`${name} checks the date before dispatching and stamps today on the action`, () => {
      const fn = body(name);
      assert.match(fn, /checkTransactionDate\(input\.date, today\)/);
      assert.ok(fn.indexOf('checkTransactionDate') < fn.indexOf('dispatch('), 'check must come first');
      assert.match(fn, /\{ ok: false, message: check\.message \}/);
      assert.match(fn, /dispatch\(\{[^}]*\}, today \}\)|today \}\);/);
    });
  }
  it('the reducer itself enforces the rule for both add and update', () => {
    const reducer = read('state/transactionsReducer.ts');
    assert.equal((reducer.match(/checkTransactionDate\(action\.transaction\.date, action\.today\)/g) ?? []).length, 2);
  });
  it('the Transactions page only closes the dialog when the write succeeded', () => {
    const page = read('components/transactions/TransactionsPage.tsx');
    assert.equal((page.match(/if \(result\.ok\) closeDialog\(\);/g) ?? []).length, 2);
    assert.doesNotMatch(page, /addTransaction\(input\);\s*closeDialog\(\)/);
  });
  it('the form surfaces a refused write on the date field', () => {
    const form = read('components/transactions/TransactionForm.tsx');
    assert.match(form, /setWriteError\(result && !result\.ok \? result\.message : null\)/);
    assert.match(form, /errors\.date \?\? writeError/);
  });
});

// ───────────────────────────── 2. consistent today ─────────────────────────────

describe('app open across midnight: the same data, analysed with the new "today"', () => {
  const data = [
    mk('1', '2026-11-05', { type: 'income', categoryId: 'salary', amount: 100_000 }),
    mk('2', '2026-11-10', { amount: 3_000 }),
    mk('3', '2026-11-12', { amount: 7_000 }), // tomorrow, as seen on the 11th
  ];

  it('a record dated "tomorrow" is excluded before midnight and counted right after', () => {
    const before = actualTransactions(data, '2026-11-11');
    const after = actualTransactions(data, '2026-11-12');
    assert.equal(calculateSummary(before).totalExpenses, 3_000);
    assert.equal(calculateSummary(after).totalExpenses, 10_000);
    assert.equal(futureTransactions(data, '2026-11-11').length, 1);
    assert.equal(futureTransactions(data, '2026-11-12').length, 0);
  });
  it('Insights, Analytics and Dashboard stay in agreement on both sides of midnight', () => {
    for (const today of ['2026-11-11', '2026-11-12']) {
      const actual = actualTransactions(data, today);
      const insights = buildPeriodAnalysis(data, ALL_TIME, 'all', today);
      const dash = calculateSummary(actual);
      assert.equal(insights.stats.totalIncome, dash.totalIncome, today);
      assert.equal(insights.stats.totalExpenses, dash.totalExpenses, today);
      assert.equal(insights.stats.transactionCount, actual.length, today);
      assert.deepEqual(insights.monthly, calculateMonthlyTotals(actual, 12), today);
    }
  });
  it('Insights with a fixed (stale) today would disagree with the others — the bug this guards against', () => {
    const stale = buildPeriodAnalysis(data, ALL_TIME, 'all', '2026-11-11');
    const fresh = actualTransactions(data, '2026-11-12');
    assert.notEqual(stale.stats.totalExpenses, calculateSummary(fresh).totalExpenses);
  });
  it('date presets roll forward with today (month, 30 days, year to date)', () => {
    assert.deepEqual(resolvePreset('month', '2026-11-30'), { from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(resolvePreset('month', '2026-12-01'), { from: '2026-12-01', to: '2026-12-01' });
    assert.deepEqual(resolvePreset('30d', '2026-11-11'), { from: '2026-10-13', to: '2026-11-11' });
    assert.deepEqual(resolvePreset('30d', '2026-11-12'), { from: '2026-10-14', to: '2026-11-12' });
    assert.deepEqual(resolvePreset('ytd', '2027-01-01'), { from: '2027-01-01', to: '2027-01-01' });
  });
  it('crossing a month boundary: a record dated the 1st appears, the new month becomes the latest', () => {
    const rows = [mk('x', '2026-11-20'), mk('y', '2026-12-01', { amount: 4_000 })];
    assert.equal(availableMonths(actualTransactions(rows, '2026-11-30'))[0], '2026-11');
    assert.equal(availableMonths(actualTransactions(rows, '2026-12-01'))[0], '2026-12');
    const a = buildPeriodAnalysis(rows, ALL_TIME, 'all', '2026-12-01');
    assert.equal(a.monthly.at(-1)?.month, '2026-12');
    assert.ok(a.partialMonths.has('2026-12'));
  });
});

describe('wiring guard (source text): nothing caches "today"', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  })(srcDir);
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

  it('InsightsPage reads todayISO() on every render and does not freeze it in state', () => {
    const page = read('components/insights/InsightsPage.tsx');
    assert.match(page, /^\s*const today = todayISO\(\);/m);
    assert.doesNotMatch(page, /useState\([^)]*today/i);
    assert.doesNotMatch(page, /useRef\([^)]*today/i);
    assert.match(page, /import \{ todayISO \} from '@\/lib\/datePolicy'/);
  });
  it('no file keeps today in state/ref or in a module-level constant', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /use(State|Ref)\([^)]*todayISO/, file);
      assert.doesNotMatch(text, /^(export )?const \w*(today|TODAY)\w* = todayISO\(/m, file);
    }
  });
  it('the Dashboard/Analytics source, the Transactions page and Insights all take today from the shared policy', () => {
    assert.match(read('state/TransactionsContext.tsx'), /const today = todayISO\(\);\s*\n\s*return useMemo\(\(\) => actualTransactions\(transactions, today\), \[transactions, today\]\)/);
    assert.match(read('components/transactions/TransactionsPage.tsx'), /const today = todayISO\(\);/);
    assert.match(read('components/transactions/TransactionsPage.tsx'), /import \{ isFutureDate, todayISO \} from '@\/lib\/datePolicy'/);
    assert.match(read('components/ui/FutureDateNotice.tsx'), /futureTransactions\(transactions, todayISO\(\)\)/);
  });
  it('todayISO is defined in exactly one place and no timers were added', () => {
    const defs = files.filter((f) => /function todayISO\b/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(defs.map((f) => f.split('/src/')[1]), ['lib/datePolicy.ts']);
    for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /setInterval|setTimeout/, file);
  });
});
