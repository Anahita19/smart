/**
 * Stage 5 – data integrity. Property-style tests (seeded, deterministic) for the Transactions
 * page's query pipeline (filter → sort → paginate), the reducer and id generation, the
 * reconciliation between the different views of the same data, and the persisted record format.
 * The audit found no direct tests for sortTransactions, paginate, hasActiveFilters, createId or
 * isTransaction, and only two indirect calls to filterTransactions.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableMonths, calculateMonthlyTotals, filterByMonth } from '../src/lib/analytics.ts';
import { calculateExpensesByCategory, calculateSummary } from '../src/lib/calculations.ts';
import { ALL_TIME } from '../src/lib/dateRange.ts';
import { buildPeriodAnalysis } from '../src/lib/insights.ts';
import { SCHEMA_VERSION, isTransaction, parseStoredPayload, serializeEnvelope } from '../src/lib/storage.ts';
import {
  DEFAULT_FILTERS,
  PAGE_SIZE,
  filterTransactions,
  hasActiveFilters,
  paginate,
  sortTransactions,
} from '../src/lib/transactionQuery.ts';
import type { SortKey, TransactionFilters } from '../src/lib/transactionQuery.ts';
import { MAX_AMOUNT_CENTS } from '../src/lib/validation.ts';
import { createId, transactionsReducer } from '../src/state/transactionsReducer.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const EXPENSE_CATEGORIES = ['housing', 'groceries', 'dining', 'transport', 'utilities', 'health', 'travel'];
const INCOME_CATEGORIES = ['salary', 'freelance', 'investments'];
const DESCRIPTIONS = ['Coffee beans', 'coffee', 'Rent', 'قهوه', 'A.*B', '100% juice', 'Lunch', 'Bus pass', 'Salary Nov'];

/**
 * Deliberately collision-heavy (30 distinct days, 20 distinct amounts) so many rows tie on the
 * primary sort key and the tie-breakers are genuinely exercised.
 */
function dataset(count: number, seed = 42): Transaction[] {
  const next = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const income = next() < 0.2;
    const categories = income ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    const day = 1 + Math.floor(next() * 30);
    return {
      id: `d-${String(i).padStart(4, '0')}`,
      type: income ? 'income' : 'expense',
      amount: (1 + Math.floor(next() * 20)) * 500,
      categoryId: categories[Math.floor(next() * categories.length)],
      description: DESCRIPTIONS[Math.floor(next() * DESCRIPTIONS.length)],
      date: `2026-${next() < 0.5 ? '09' : '10'}-${String(day).padStart(2, '0')}`,
    };
  });
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = rng(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ids = (list: readonly Transaction[]) => list.map((t) => t.id);
const filters = (over: Partial<TransactionFilters>): TransactionFilters => ({ ...DEFAULT_FILTERS, ...over });
const DATA = dataset(600);

// ───────────── filterTransactions / hasActiveFilters ─────────────

describe('filterTransactions', () => {
  it('default filters keep every row, in order, as a new array', () => {
    const out = filterTransactions(DATA, DEFAULT_FILTERS);
    assert.deepEqual(ids(out), ids(DATA));
    assert.notEqual(out, DATA);
  });

  it('never mutates its input', () => {
    const frozen = deepFreeze(structuredClone(DATA));
    assert.doesNotThrow(() => filterTransactions(frozen, filters({ type: 'expense', search: 'coffee' })));
  });

  it('type filters partition the data: income + expense = everything, with no overlap', () => {
    const income = filterTransactions(DATA, filters({ type: 'income' }));
    const expense = filterTransactions(DATA, filters({ type: 'expense' }));
    assert.equal(income.length + expense.length, DATA.length);
    assert.ok(income.every((t) => t.type === 'income') && expense.every((t) => t.type === 'expense'));
    assert.equal(new Set([...ids(income), ...ids(expense)]).size, DATA.length);
  });

  it('date bounds are inclusive on both ends, and a single day can be selected', () => {
    const day = DATA[0].date;
    const oneDay = filterTransactions(DATA, filters({ dateFrom: day, dateTo: day }));
    assert.ok(oneDay.length > 0 && oneDay.every((t) => t.date === day));
    assert.equal(oneDay.length, DATA.filter((t) => t.date === day).length);
    const from = filterTransactions(DATA, filters({ dateFrom: '2026-10-15' }));
    assert.ok(from.every((t) => t.date >= '2026-10-15') && from.some((t) => t.date === '2026-10-15'));
    const to = filterTransactions(DATA, filters({ dateTo: '2026-09-10' }));
    assert.ok(to.every((t) => t.date <= '2026-09-10') && to.some((t) => t.date === '2026-09-10'));
    assert.deepEqual(filterTransactions(DATA, filters({ dateFrom: '2026-10-20', dateTo: '2026-10-10' })), [], 'reversed range matches nothing');
  });

  it('search is case-insensitive, trimmed, and looks at description AND category name', () => {
    const upper = filterTransactions(DATA, filters({ search: 'COFFEE' }));
    const padded = filterTransactions(DATA, filters({ search: '   coffee  ' }));
    assert.deepEqual(ids(upper), ids(padded));
    assert.ok(upper.length > 0 && upper.every((t) => t.description.toLowerCase().includes('coffee')));
    const byCategoryName = filterTransactions(DATA, filters({ search: 'groc' }));
    assert.ok(byCategoryName.length > 0 && byCategoryName.every((t) => t.categoryId === 'groceries' || t.description.toLowerCase().includes('groc')));
    assert.ok(filterTransactions(DATA, filters({ search: 'قهوه' })).length > 0, 'non-Latin text is searchable');
  });

  it('search text is literal: regex characters match only themselves', () => {
    const star = filterTransactions(DATA, filters({ search: '.*' }));
    assert.ok(star.length > 0 && star.every((t) => t.description.includes('.*')));
    assert.equal(filterTransactions(DATA, filters({ search: '100%' })).every((t) => t.description.includes('100%')), true);
    assert.deepEqual(filterTransactions(DATA, filters({ search: '[' })), []);
  });

  it('a record with an unknown category is found under "Uncategorized", not lost', () => {
    const orphan: Transaction = { id: 'orphan', type: 'expense', amount: 100, categoryId: 'deleted-category', description: 'old entry', date: '2026-10-01' };
    const result = filterTransactions([...DATA, orphan], filters({ search: 'uncategorized' }));
    assert.deepEqual(ids(result), ['orphan']);
  });

  it('combined filters equal applying each filter on its own (intersection)', () => {
    const combined = filterTransactions(DATA, filters({ type: 'expense', categoryId: 'dining', dateFrom: '2026-09-15', dateTo: '2026-10-15', search: 'lunch' }));
    const chained = [
      filters({ type: 'expense' }), filters({ categoryId: 'dining' }), filters({ dateFrom: '2026-09-15' }),
      filters({ dateTo: '2026-10-15' }), filters({ search: 'lunch' }),
    ].reduce<Transaction[]>((rows, f) => filterTransactions(rows, f), [...DATA]);
    assert.deepEqual(ids(combined), ids(chained));
  });
});

describe('hasActiveFilters', () => {
  it('false for the defaults and for a whitespace-only search', () => {
    assert.equal(hasActiveFilters(DEFAULT_FILTERS), false);
    assert.equal(hasActiveFilters(filters({ search: '   ' })), false);
  });

  it('true as soon as any single filter is set', () => {
    for (const over of [{ search: 'x' }, { type: 'income' as const }, { categoryId: 'dining' }, { dateFrom: '2026-01-01' }, { dateTo: '2026-01-01' }]) {
      assert.equal(hasActiveFilters(filters(over)), true, JSON.stringify(over));
    }
  });
});

// ───────────── sortTransactions ─────────────

describe('sortTransactions', () => {
  const orderings: Record<SortKey, (a: Transaction, b: Transaction) => boolean> = {
    'date-desc': (a, b) => a.date >= b.date,
    'date-asc': (a, b) => a.date <= b.date,
    'amount-desc': (a, b) => a.amount >= b.amount,
    'amount-asc': (a, b) => a.amount <= b.amount,
  };

  for (const key of Object.keys(orderings) as SortKey[]) {
    it(`${key}: a permutation of the input, correctly ordered, idempotent`, () => {
      const sorted = sortTransactions(DATA, key);
      assert.deepEqual([...ids(sorted)].sort(), [...ids(DATA)].sort(), 'no row lost or duplicated');
      for (let i = 1; i < sorted.length; i++) assert.ok(orderings[key](sorted[i - 1], sorted[i]), `${key} out of order at ${i}`);
      assert.deepEqual(ids(sortTransactions(sorted, key)), ids(sorted));
    });

    it(`${key}: identical order whatever order the input arrives in (so pagination never reshuffles)`, () => {
      const reference = ids(sortTransactions(DATA, key));
      for (const seed of [1, 2, 3, 4, 5]) assert.deepEqual(ids(sortTransactions(shuffled(DATA, seed), key)), reference, `seed ${seed}`);
    });
  }

  it('never mutates its input', () => {
    const frozen = deepFreeze(structuredClone(DATA));
    assert.doesNotThrow(() => sortTransactions(frozen, 'amount-desc'));
  });

  it('handles empty and single-row lists', () => {
    assert.deepEqual(sortTransactions([], 'date-desc'), []);
    assert.deepEqual(ids(sortTransactions([DATA[0]], 'amount-asc')), [DATA[0].id]);
  });
});

// ───────────── paginate ─────────────

describe('paginate', () => {
  const items = Array.from({ length: 95 }, (_, i) => i + 1);

  it(`pages of ${PAGE_SIZE}: correct counts and from/to for first, middle and last page`, () => {
    const first = paginate(items, 1);
    assert.deepEqual([first.page, first.pageCount, first.total, first.from, first.to, first.items.length], [1, 10, 95, 1, 10, 10]);
    const second = paginate(items, 2);
    assert.deepEqual([second.from, second.to], [11, 20]);
    const last = paginate(items, 10);
    assert.deepEqual([last.page, last.from, last.to, last.items.length], [10, 91, 95, 5]);
  });

  it('every item appears on exactly one page, in order', () => {
    const { pageCount } = paginate(items, 1);
    const all = Array.from({ length: pageCount }, (_, i) => paginate(items, i + 1).items).flat();
    assert.deepEqual(all, items);
  });

  it('out-of-range or odd page numbers are clamped, never an error or an empty page', () => {
    assert.equal(paginate(items, 0).page, 1);
    assert.equal(paginate(items, -5).page, 1);
    assert.equal(paginate(items, NaN).page, 1);
    assert.equal(paginate(items, -Infinity).page, 1);
    assert.equal(paginate(items, 999).page, 10);
    assert.equal(paginate(items, Infinity).page, 10);
    assert.equal(paginate(items, 2.7).page, 2);
    assert.ok(paginate(items, 999).items.length > 0);
  });

  it('exact multiples of the page size do not create an extra empty page', () => {
    assert.equal(paginate(Array.from({ length: 20 }, (_, i) => i), 1).pageCount, 2);
    assert.equal(paginate(Array.from({ length: 21 }, (_, i) => i), 1).pageCount, 3);
    assert.equal(paginate(Array.from({ length: 1 }, (_, i) => i), 1).pageCount, 1);
  });

  it('an empty list is page 1 of 1 with from = to = 0', () => {
    assert.deepEqual(paginate([], 1), { items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
    assert.deepEqual(paginate([], 7), { items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
  });

  it('honours a custom page size', () => {
    const page = paginate(items, 4, 25);
    assert.deepEqual([page.pageCount, page.items.length, page.from, page.to], [4, 20, 76, 95]);
  });

  it('deleting the only row on the last page moves the view back instead of showing an empty page', () => {
    const before = Array.from({ length: 21 }, (_, i) => i);
    assert.equal(paginate(before, 3).items.length, 1);
    const after = before.slice(0, 20); // the single row on page 3 was deleted
    const view = paginate(after, 3); // the page the user was on
    assert.deepEqual([view.page, view.pageCount, view.items.length], [2, 2, 10]);
  });

  it('does not mutate its input', () => {
    const frozen = deepFreeze([...items]);
    assert.doesNotThrow(() => paginate(frozen, 3));
  });
});

describe('filter → sort → paginate pipeline', () => {
  const scenarios: Array<[string, TransactionFilters, SortKey]> = [
    ['no filters, newest first', DEFAULT_FILTERS, 'date-desc'],
    ['expenses by amount', filters({ type: 'expense' }), 'amount-desc'],
    ['category + date window', filters({ categoryId: 'groceries', dateFrom: '2026-09-10', dateTo: '2026-10-20' }), 'date-asc'],
    ['text search', filters({ search: 'coffee' }), 'amount-asc'],
    ['nothing matches', filters({ search: 'zzz-no-match' }), 'date-desc'],
  ];

  for (const [name, f, sort] of scenarios) {
    it(`${name}: walking every page returns exactly the filtered rows, once each`, () => {
      const rows = sortTransactions(filterTransactions(DATA, f), sort);
      const { pageCount } = paginate(rows, 1);
      const walked = Array.from({ length: pageCount }, (_, i) => paginate(rows, i + 1).items).flat();
      assert.deepEqual(ids(walked), ids(rows));
      assert.equal(new Set(ids(walked)).size, walked.length);
      assert.equal(walked.length, filterTransactions(DATA, f).length);
    });
  }
});

// ───────────── reducer and ids ─────────────

describe('transactionsReducer integrity', () => {
  const base = dataset(8, 7);
  const TODAY = '2026-11-11';
  const fresh: Transaction = { id: 'new-1', type: 'expense', amount: 1_234, categoryId: 'dining', description: 'Dinner', date: '2026-11-10' };

  it('add puts the new record first and keeps every existing record untouched', () => {
    const next = transactionsReducer(deepFreeze(structuredClone(base)), { type: 'add', transaction: fresh, today: TODAY });
    assert.equal(next.length, base.length + 1);
    assert.deepEqual(next[0], fresh);
    assert.deepEqual(next.slice(1), base);
  });

  it('update replaces only the matching record, keeping position and every other record', () => {
    const target = base[3];
    const edited = { ...target, amount: 777, description: 'edited' };
    const next = transactionsReducer(deepFreeze(structuredClone(base)), { type: 'update', transaction: edited, today: TODAY });
    assert.equal(next.length, base.length);
    assert.deepEqual(next[3], edited);
    assert.deepEqual(next.filter((_, i) => i !== 3), base.filter((_, i) => i !== 3));
  });

  it('updating an unknown id changes nothing (no record is created or lost)', () => {
    const next = transactionsReducer(base, { type: 'update', transaction: { ...fresh, id: 'does-not-exist' }, today: TODAY });
    assert.deepEqual(next, base);
  });

  it('delete removes exactly one record; deleting an unknown id changes nothing', () => {
    const next = transactionsReducer(deepFreeze(structuredClone(base)), { type: 'delete', id: base[2].id });
    assert.deepEqual(ids(next), ids(base).filter((id) => id !== base[2].id));
    assert.deepEqual(transactionsReducer(base, { type: 'delete', id: 'missing' }), base);
  });

  it('delete never touches other records, including future-dated ones', () => {
    const future: Transaction = { ...fresh, id: 'future', date: '2999-01-01' };
    const next = transactionsReducer([future, ...base], { type: 'delete', id: base[0].id });
    assert.ok(next.some((t) => t.id === 'future'));
    assert.equal(next.length, base.length);
  });

  it('refused writes return the SAME array reference, so nothing re-renders or persists', () => {
    assert.equal(transactionsReducer(base, { type: 'add', transaction: { ...fresh, date: '2999-01-01' }, today: TODAY }), base);
    assert.equal(transactionsReducer(base, { type: 'add', transaction: { ...fresh, date: '2026-02-31' }, today: TODAY }), base);
    assert.equal(transactionsReducer(base, { type: 'update', transaction: { ...base[0], date: '2999-01-01' }, today: TODAY }), base);
  });

  it('replace swaps in exactly the list it is given', () => {
    const incoming = dataset(3, 99);
    assert.deepEqual(transactionsReducer(base, { type: 'replace', transactions: incoming }), incoming);
  });

  it('a long random sequence of valid actions keeps ids unique and totals consistent with an independent model', () => {
    const next = rng(1234);
    let state: Transaction[] = [];
    const model = new Map<string, Transaction>();
    for (let step = 0; step < 3_000; step++) {
      const roll = next();
      if (roll < 0.55 || model.size === 0) {
        const t: Transaction = { id: createId(), type: next() < 0.3 ? 'income' : 'expense', amount: 1 + Math.floor(next() * 90_000), categoryId: 'groceries', description: 'x', date: '2026-10-01' };
        state = transactionsReducer(state, { type: 'add', transaction: t, today: TODAY });
        model.set(t.id, t);
      } else {
        const id = [...model.keys()][Math.floor(next() * model.size)];
        if (roll < 0.8) {
          const edited = { ...model.get(id)!, amount: 1 + Math.floor(next() * 90_000) };
          state = transactionsReducer(state, { type: 'update', transaction: edited, today: TODAY });
          model.set(id, edited);
        } else {
          state = transactionsReducer(state, { type: 'delete', id });
          model.delete(id);
        }
      }
    }
    assert.equal(state.length, model.size);
    assert.equal(new Set(ids(state)).size, state.length, 'ids are unique');
    assert.deepEqual(calculateSummary(state), calculateSummary([...model.values()]));
    for (const t of state) assert.deepEqual(t, model.get(t.id));
  });
});

describe('createId', () => {
  it('produces prefixed ids that never collide (5,000 ids)', () => {
    const generated = Array.from({ length: 5_000 }, () => createId());
    assert.ok(generated.every((id) => id.startsWith('tx-') && id.length > 5));
    assert.equal(new Set(generated).size, generated.length);
  });

  it('still works when crypto.randomUUID is unavailable (insecure http fallback)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    assert.ok(descriptor?.configurable, 'cannot simulate a missing crypto in this runtime');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    try {
      const generated = Array.from({ length: 2_000 }, () => createId());
      assert.ok(generated.every((id) => /^tx-[a-z0-9]+-[a-z0-9]+$/.test(id)), 'fallback format');
      assert.equal(new Set(generated).size, generated.length);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
    assert.equal(typeof crypto.randomUUID, 'function', 'crypto was restored');
  });
});

// ───────────── reconciliation between views ─────────────

describe('every view of the same data adds up to the same totals', () => {
  const data = dataset(800, 2026);
  const today = '2026-11-11';
  const summary = calculateSummary(data);

  it('monthly totals add up to the overall summary', () => {
    const months = calculateMonthlyTotals(data);
    assert.equal(months.reduce((s, m) => s + m.income, 0), summary.totalIncome);
    assert.equal(months.reduce((s, m) => s + m.expenses, 0), summary.totalExpenses);
    assert.equal(months.reduce((s, m) => s + m.net, 0), summary.balance);
  });

  it('category totals add up to total expenses', () => {
    assert.equal(calculateExpensesByCategory(data).reduce((s, c) => s + c.total, 0), summary.totalExpenses);
  });

  it('splitting by month loses and duplicates nothing', () => {
    const months = availableMonths(data);
    const parts = months.flatMap((m) => filterByMonth(data, m));
    assert.equal(parts.length, data.length);
    assert.equal(new Set(ids(parts)).size, data.length);
    assert.equal(filterByMonth(data, 'all').length, data.length);
  });

  it('the Insights analysis for all time reports the same totals as the plain summary', () => {
    const analysis = buildPeriodAnalysis(data, ALL_TIME, 'all', today);
    assert.equal(analysis.stats.totalIncome, summary.totalIncome);
    assert.equal(analysis.stats.totalExpenses, summary.totalExpenses);
    assert.equal(analysis.stats.savings, summary.balance);
    assert.equal(analysis.stats.transactionCount, data.length);
    assert.equal(analysis.byCategory.reduce((s, c) => s + c.total, 0), summary.totalExpenses);
    assert.equal(analysis.monthly.reduce((s, m) => s + m.income, 0), summary.totalIncome);
    assert.equal(analysis.savings.reduce((s, m) => s + m.savings, 0), summary.balance);
  });
});

// ───────────── persisted record format ─────────────

describe('isTransaction', () => {
  const ok: Transaction = { id: 'a', type: 'expense', amount: 100, categoryId: 'groceries', description: 'd', date: '2026-11-01' };

  it('accepts a valid record, the maximum amount, an unknown category and a future date', () => {
    assert.equal(isTransaction(ok), true);
    assert.equal(isTransaction({ ...ok, amount: MAX_AMOUNT_CENTS }), true);
    assert.equal(isTransaction({ ...ok, categoryId: 'deleted-category' }), true);
    assert.equal(isTransaction({ ...ok, date: '2999-01-01' }), true, 'stored future-dated records are kept, not pruned');
  });

  it('rejects every kind of damaged record', () => {
    const bad: unknown[] = [
      null, undefined, 'x', 5, [], {},
      { ...ok, id: '' }, { ...ok, id: 5 }, { ...ok, type: 'transfer' }, { ...ok, type: undefined },
      { ...ok, amount: 0 }, { ...ok, amount: -1 }, { ...ok, amount: 12.5 }, { ...ok, amount: NaN }, { ...ok, amount: Infinity },
      { ...ok, amount: '100' }, { ...ok, amount: MAX_AMOUNT_CENTS + 1 }, { ...ok, amount: 2 ** 53 },
      { ...ok, categoryId: 5 }, { ...ok, description: undefined }, { ...ok, date: '2026-02-31' }, { ...ok, date: '01/11/2026' },
    ];
    for (const record of bad) assert.equal(isTransaction(record), false, JSON.stringify(record));
  });
});

describe('serializeEnvelope ⇄ parseStoredPayload', () => {
  it('round-trips 5,000 records exactly, including non-Latin text, emoji and quotes', () => {
    const next = rng(8);
    const unusual = ['قهوه و شیرینی', '日本語のメモ', 'café ☕', 'He said "hi"', "it's", 'back\\slash', 'line\nbreak', '<script>alert(1)</script>', ' padded '];
    const list: Transaction[] = Array.from({ length: 5_000 }, (_, i) => ({
      id: `tx-${i}`, type: i % 4 === 0 ? 'income' : 'expense', amount: 1 + Math.floor(next() * 5_000_000),
      categoryId: i % 4 === 0 ? 'salary' : 'groceries', description: unusual[i % unusual.length], date: '2026-10-01',
    }));
    const parsed = parseStoredPayload(serializeEnvelope(list));
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    assert.equal(parsed.format, 'envelope');
    assert.deepEqual(parsed.transactions, list);
    assert.deepEqual([parsed.accepted, parsed.invalid], [5_000, 0]);
  });

  it('the envelope carries the schema version and an ISO timestamp', () => {
    const envelope = JSON.parse(serializeEnvelope([], new Date('2026-11-12T08:30:00.000Z')));
    assert.deepEqual(envelope, { schemaVersion: SCHEMA_VERSION, savedAt: '2026-11-12T08:30:00.000Z', transactions: [] });
  });

  it('counts damaged records instead of silently accepting them, and the first of two equal ids wins', () => {
    const good: Transaction = { id: 'a', type: 'expense', amount: 100, categoryId: 'groceries', description: 'kept', date: '2026-11-01' };
    const records = [good, { ...good, description: 'duplicate id' }, { ...good, id: 'b', amount: 1.5 }, { nope: true }, { ...good, id: 'c', amount: 0 }, { ...good, id: 'd' }];
    const parsed = parseStoredPayload(JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: 'x', transactions: records }));
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    assert.deepEqual(ids(parsed.transactions), ['a', 'd']);
    assert.equal(parsed.transactions[0].description, 'kept');
    assert.deepEqual([parsed.accepted, parsed.invalid], [2, 4]);
  });

  it('keeps exactly the six record fields (nothing extra is carried into the app)', () => {
    const record = { id: 'a', type: 'expense', amount: 100, categoryId: 'groceries', description: 'd', date: '2026-11-01', note: 'extra', __proto__x: 1 };
    const parsed = parseStoredPayload(JSON.stringify([record]));
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    assert.deepEqual(Object.keys(parsed.transactions[0]).sort(), ['amount', 'categoryId', 'date', 'description', 'id', 'type']);
  });

  it('still reads the older bare-array format', () => {
    const list: Transaction[] = [{ id: 'a', type: 'income', amount: 100, categoryId: 'salary', description: 'd', date: '2026-11-01' }];
    const parsed = parseStoredPayload(JSON.stringify(list));
    assert.deepEqual(parsed.status === 'ok' && [parsed.format, parsed.transactions], ['legacy', list]);
  });

  it('classifies unreadable content instead of throwing', () => {
    const reason = (raw: string) => {
      const p = parseStoredPayload(raw);
      return p.status === 'corrupt' ? p.reason : p.status;
    };
    assert.equal(reason(''), 'unparseable');
    assert.equal(reason('not json'), 'unparseable');
    assert.equal(reason('{"schemaVersion":'), 'unparseable');
    for (const raw of ['null', '"text"', '123', 'true', '{}', '{"schemaVersion":1.5,"savedAt":"x","transactions":[]}', '{"schemaVersion":1,"transactions":[]}', '{"schemaVersion":1,"savedAt":"x"}']) {
      assert.equal(reason(raw), 'malformed', raw);
    }
    assert.equal(reason(`{"schemaVersion":${SCHEMA_VERSION + 1},"savedAt":"x","transactions":[]}`), 'unsupported-version');
    assert.equal(reason('{"schemaVersion":0,"savedAt":"x","transactions":[]}'), 'unsupported-version');
  });
});
