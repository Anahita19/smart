/**
 * Stage 5 – findUnusualExpenses: behaviour pinned while its implementation was made non-quadratic.
 *
 * The first block states the rules with small hand-checked examples. The second block compares the
 * implementation with a straightforward reference written the way the function worked before it was
 * optimised (rebuild and sort the peer list for every candidate), over thousands of randomised
 * histories — including ties, duplicate ids, fixed bills, future-dated rows and candidates that are
 * not in the history — so any change in what gets flagged, or in the typical/peerCount reported, fails.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/unusualExpenses.stage5.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findUnusualExpenses } from '../src/lib/insights.ts';
import type { UnusualExpense } from '../src/lib/insights.ts';
import type { Transaction } from '../src/types/transaction.ts';

const ASOF = '2026-11-11';

// ───────────── helpers ─────────────

const exp = (id: string, amount: number, date: string, description = id, categoryId = 'shopping'): Transaction => ({
  id, type: 'expense', amount, categoryId, description, date,
});

/** Eight ordinary purchases in eight different months: median 2,900 cents. */
const PEERS: Transaction[] = [2000, 2200, 2500, 2800, 3000, 3200, 3500, 4000].map((amount, i) =>
  exp(`p${i}`, amount, `2026-${String(i + 1).padStart(2, '0')}-10`, `item ${i}`),
);

const summary = (found: UnusualExpense[]) => found.map((f) => ({ id: f.transaction.id, typical: f.typical, peerCount: f.peerCount }));

// ───────────── reference: the original algorithm, unoptimised ─────────────

const norm = (d: string) => d.trim().toLowerCase();
const month = (d: string) => d.slice(0, 7);
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function referenceFixed(list: Transaction[]): Set<string> {
  const groups = new Map<string, Transaction[]>();
  for (const t of list) groups.set(norm(t.description), [...(groups.get(norm(t.description)) ?? []), t]);
  const fixed = new Set<string>();
  for (const [key, g] of groups) {
    if (g.length < 3) continue;
    const months = new Set(g.map((t) => month(t.date))).size;
    if (months < 3 || g.length > months * 1.5) continue;
    const amounts = g.map((t) => t.amount);
    const typical = median(amounts);
    if (typical > 0 && (Math.max(...amounts) - Math.min(...amounts)) / typical <= 0.05) fixed.add(key);
  }
  return fixed;
}
function reference(all: readonly Transaction[], candidates: readonly Transaction[], asOf: string): UnusualExpense[] {
  const byCategory = new Map<string, Transaction[]>();
  for (const t of all) {
    if (t.type !== 'expense' || t.date > asOf) continue;
    byCategory.set(t.categoryId, [...(byCategory.get(t.categoryId) ?? []), t]);
  }
  const fixedBy = new Map<string, Set<string>>();
  for (const [c, list] of byCategory) fixedBy.set(c, referenceFixed(list));
  const found: UnusualExpense[] = [];
  for (const c of candidates) {
    if (c.type !== 'expense' || c.amount < 10_000) continue;
    const fixed = fixedBy.get(c.categoryId) ?? new Set<string>();
    if (fixed.has(norm(c.description))) continue;
    const peers = (byCategory.get(c.categoryId) ?? []).filter((t) => t.id !== c.id && !fixed.has(norm(t.description)));
    if (peers.length < 6) continue;
    if (new Set(peers.map((t) => month(t.date))).size < 3) continue;
    const amounts = peers.map((t) => t.amount);
    const typical = median(amounts);
    if (typical <= 0) continue;
    if (c.amount < typical * 2.5) continue;
    if (c.amount - typical < 7_500) continue;
    const mad = median(amounts.map((v) => Math.abs(v - typical)));
    const scale = Math.max(1.4826 * mad, typical * 0.1);
    if ((c.amount - typical) / scale < 3.5) continue;
    if (amounts.filter((a) => a >= c.amount * 0.8).length > 1) continue;
    found.push({ transaction: c, typical, peerCount: peers.length });
  }
  return found.sort((a, b) => b.transaction.amount - a.transaction.amount || a.transaction.id.localeCompare(b.transaction.id));
}

// ───────────── the rules, by example ─────────────

describe('findUnusualExpenses: rules', () => {
  it('flags a clear outlier and reports its typical size; the expense is never its own peer', () => {
    const big = exp('big', 60_000, '2026-09-05', 'Surgery');
    const found = findUnusualExpenses([...PEERS, big], [big], ASOF);
    assert.deepEqual(summary(found), [{ id: 'big', typical: 2_900, peerCount: 8 }]);
    assert.equal(found[0].transaction, big);
  });

  it('judges a candidate that is not in the history against the whole category', () => {
    const ghost = exp('ghost', 60_000, '2026-09-05', 'Surgery');
    assert.deepEqual(summary(findUnusualExpenses(PEERS, [ghost], ASOF)), [{ id: 'ghost', typical: 2_900, peerCount: 8 }]);
  });

  it('flags nothing without enough peers, or when the peers span fewer than 3 months', () => {
    const big = exp('big', 60_000, '2026-09-05');
    assert.deepEqual(findUnusualExpenses([...PEERS.slice(0, 5), big], [big], ASOF), [], '5 peers');
    const oneMonth = PEERS.map((p, i) => exp(p.id, p.amount, `2026-03-${String(i + 1).padStart(2, '0')}`));
    assert.deepEqual(findUnusualExpenses([...oneMonth, big], [big], ASOF), [], 'one month');
    const twoMonths = PEERS.map((p, i) => exp(p.id, p.amount, i % 2 ? '2026-03-04' : '2026-04-04'));
    assert.deepEqual(findUnusualExpenses([...twoMonths, big], [big], ASOF), [], 'two months');
  });

  it('a peer that is the only one in its month still lets the other months count (leave-one-out month count)', () => {
    // Three months in total; the candidate is the only expense in its own month, so without it there are 2 → not judged.
    const peers = PEERS.map((p, i) => exp(p.id, p.amount, i < 4 ? '2026-01-10' : '2026-02-10'));
    const lonely = exp('lonely', 60_000, '2026-03-10');
    assert.deepEqual(findUnusualExpenses([...peers, lonely], [lonely], ASOF), []);
    const withThird = [...peers, exp('third', 2_500, '2026-03-12'), lonely];
    assert.deepEqual(summary(findUnusualExpenses(withThird, [lonely], ASOF)), [{ id: 'lonely', typical: 2_800, peerCount: 9 }]);
  });

  it('ignores expenses dated after asOf as history', () => {
    const big = exp('big', 60_000, '2026-09-05');
    const future = [3_000, 3_100, 3_200].map((a, i) => exp(`f${i}`, a, '2026-12-01'));
    assert.deepEqual(findUnusualExpenses([...PEERS.slice(0, 5), ...future, big], [big], ASOF), []);
  });

  it('only compares within the same category, and ignores income', () => {
    const big = exp('big', 60_000, '2026-09-05', 'Surgery', 'health');
    const income: Transaction = { id: 'inc', type: 'income', amount: 60_000, categoryId: 'shopping', description: 'Pay', date: '2026-09-05' };
    assert.deepEqual(findUnusualExpenses([...PEERS, big], [big], ASOF), [], 'no health peers');
    assert.deepEqual(findUnusualExpenses([...PEERS, income], [income], ASOF), [], 'income is never a candidate');
  });

  it('keeps fixed bills out of the baseline and never flags them', () => {
    const rent = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map((d, i) => exp(`r${i}`, 20_000, d, 'Rent'));
    const small = [2000, 2200, 2500, 2800, 3000, 3200].map((a, i) => exp(`s${i}`, a, `2026-0${i + 1}-15`, `thing ${i}`));
    const surgery = exp('surgery', 90_000, '2026-05-20', 'Surgery');
    const history = [...rent, ...small, surgery];
    assert.deepEqual(summary(findUnusualExpenses(history, [surgery], ASOF)), [{ id: 'surgery', typical: 2_650, peerCount: 6 }]);
    assert.deepEqual(findUnusualExpenses(history, [rent[3]], ASOF), []);
  });

  it('does not flag a size that keeps coming back (two or more similar peers)', () => {
    const twin = [exp('a', 60_000, '2026-09-01', 'a'), exp('b', 58_000, '2026-10-01', 'b'), exp('c', 61_000, '2026-10-05', 'c')];
    assert.deepEqual(findUnusualExpenses([...PEERS, ...twin], twin, ASOF), []);
  });

  it('orders results by amount, then by id', () => {
    // Two equal amounts count as one similar peer for each other, which the rule still allows.
    const b = exp('b', 60_000, '2026-09-05', 'b');
    const a = exp('a', 60_000, '2026-09-06', 'a');
    assert.deepEqual(findUnusualExpenses([...PEERS, b, a], [b, a], ASOF).map((f) => f.transaction.id), ['a', 'b'], 'ties by id');
    const mid = exp('mid', 30_000, '2026-09-05', 'mid');
    const top = exp('top', 90_000, '2026-09-07', 'top');
    assert.deepEqual(findUnusualExpenses([...PEERS, mid, top], [mid, top], ASOF).map((f) => f.transaction.id), ['top', 'mid'], 'larger first');
  });

  it('ids that appear more than once are all left out of that candidate’s baseline', () => {
    const big = exp('dup', 60_000, '2026-09-05', 'Surgery');
    const twin = exp('dup', 2_400, '2026-10-05', 'Other');
    assert.deepEqual(summary(findUnusualExpenses([...PEERS, big, twin], [big], ASOF)), [{ id: 'dup', typical: 2_900, peerCount: 8 }]);
  });
});

// ───────────── optimised implementation ≡ reference ─────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function randomHistory(seed: number): { all: Transaction[]; candidates: Transaction[] } {
  const r = rng(seed * 7919);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const categories = ['groceries', 'dining', 'shopping'].slice(0, 1 + Math.floor(r() * 3));
  const mode = pick(['uniform', 'ties', 'tight', 'bimodal', 'small']);
  const duplicateIds = r() < 0.15;
  const months = 1 + Math.floor(r() * 6);
  const all: Transaction[] = [];
  const count = Math.floor(r() * 45);
  for (let i = 0; i < count; i++) {
    let amount: number;
    if (mode === 'uniform') amount = 100 + Math.floor(r() * 30_000);
    else if (mode === 'ties') amount = pick([2000, 2000, 2500, 3000, 12_000, 30_000, 31_000]);
    else if (mode === 'tight') amount = 2000 + Math.floor(r() * 5);
    else if (mode === 'bimodal') amount = r() < 0.5 ? 1000 + Math.floor(r() * 50) : 20_000 + Math.floor(r() * 50);
    else amount = pick([1, 2, 3, 4, 5, 6, 100, 200, 15_000, 40_000]);
    if (r() < 0.08) amount += 50_000 + Math.floor(r() * 400_000);
    const day = String(1 + Math.floor(r() * 27)).padStart(2, '0');
    const mm = String(Math.max(1, 11 - Math.floor(r() * months))).padStart(2, '0');
    all.push({
      id: duplicateIds && r() < 0.3 ? `dup${Math.floor(r() * 4)}` : `t${i}`,
      type: r() < 0.1 ? 'income' : 'expense',
      amount: r() < 0.06 ? 2000 : amount,
      categoryId: pick(categories),
      description: r() < 0.25 ? pick(['Gym', 'rent', ' RENT ', 'gym']) : `thing ${Math.floor(r() * 1000)}`,
      date: r() < 0.05 ? '2026-12-15' : `2026-${mm}-${day}`,
    });
  }
  if (r() < 0.3) for (const t of all) if (/gym|rent/i.test(t.description)) t.amount = 5000 + Math.floor(r() * 100);
  const candidates = all.filter(() => r() < 0.7);
  if (r() < 0.5) {
    candidates.push({ id: 'ghost', type: 'expense', amount: 90_000 + Math.floor(r() * 90_000), categoryId: pick(categories), description: 'ghost', date: pick(['2026-11-05', '2026-12-30']) });
  }
  return { all, candidates };
}

describe('findUnusualExpenses: same answers as the unoptimised reference', () => {
  it('matches on 4,000 randomised histories (and those histories do flag things)', () => {
    let flaggedCases = 0;
    for (let seed = 1; seed <= 4_000; seed++) {
      const { all, candidates } = randomHistory(seed);
      const expected = reference(all, candidates, ASOF);
      const actual = findUnusualExpenses(all, candidates, ASOF);
      assert.deepEqual(summary(actual), summary(expected), `seed ${seed}`);
      for (let i = 0; i < actual.length; i++) assert.equal(actual[i].transaction, expected[i].transaction, `seed ${seed}, result ${i}`);
      if (expected.length > 0) flaggedCases++;
    }
    assert.ok(flaggedCases > 500, `only ${flaggedCases} histories flagged anything — the comparison would be too weak`);
  });

  it('matches on a 3,000-row history with injected outliers', () => {
    const r = rng(42);
    const cats = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']; // at most two expenses per category can pass the "similar peers" rule
    const all: Transaction[] = Array.from({ length: 3_000 }, (_, i) => {
      const spike = r() < 0.01;
      const d = new Date(Date.parse('2026-11-01T00:00:00Z') - Math.floor(r() * 700) * 86_400_000).toISOString().slice(0, 10);
      return exp(`x${i}`, spike ? 80_000 + Math.floor(r() * 200_000) : 500 + Math.floor(r() * 9_000), d, `purchase ${i}`, cats[Math.floor(r() * cats.length)]);
    });
    const expected = reference(all, all, ASOF);
    assert.ok(expected.length > 5, 'the data must contain flaggable expenses');
    assert.deepEqual(summary(findUnusualExpenses(all, all, ASOF)), summary(expected));
  });
});
