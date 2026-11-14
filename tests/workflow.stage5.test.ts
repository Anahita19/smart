/**
 * Stage 5 – critical user workflows, tested on the pure layers (Option A: no DOM, no React).
 *
 * These drive the exact functions the screens call, in the order the screens call them:
 *   form values → validateTransactionForm / toTransactionInput → transactionsReducer
 *   → openSession().save → a reload from storage → the derived views (summary, query, pagination),
 * plus the Data page's export → preview → restore path.
 *
 * `App` below mirrors the save/sync wiring of TransactionsProvider (src/state/TransactionsContext.tsx),
 * which cannot be rendered here. It is a test double of that wiring, NOT the real component: the
 * provider itself, the pages and their click handling remain unverified (see the Stage 5 report).
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportBackup } from '../src/lib/exportBackup.ts';
import { calculateExpensesByCategory, calculateSummary } from '../src/lib/calculations.ts';
import { FUTURE_DATE_MESSAGE, actualTransactions, checkTransactionDate, todayISO } from '../src/lib/datePolicy.ts';
import { REPLACE_CONFIRM_PHRASE, prepareImport, runImport } from '../src/lib/importRestore.ts';
import type { ImportRunResult } from '../src/lib/importRestore.ts';
import {
  SNAPSHOT_KEY_PREFIX,
  RECOVERY_KEY_PREFIX,
  STORAGE_KEY,
  SCHEMA_VERSION,
  openSession,
  parseStoredPayload,
} from '../src/lib/storage.ts';
import type { RestoreOutcome, RestoreRequest, StorageLike, SyncOutcome } from '../src/lib/storage.ts';
import { DEFAULT_FILTERS, filterTransactions, paginate, sortTransactions } from '../src/lib/transactionQuery.ts';
import { hasErrors, toTransactionInput, validateTransactionForm } from '../src/lib/validation.ts';
import type { TransactionFormErrors, TransactionFormValues } from '../src/lib/validation.ts';
import { createId, transactionsReducer } from '../src/state/transactionsReducer.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── test doubles ─────────────

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  writes: string[] = [];
  failWrites = false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.writes.push(k);
    this.data.set(k, v);
  }
  removeItem(k: string) { this.data.delete(k); }
  keysWithPrefix(prefix: string) { return [...this.data.keys()].filter((k) => k.startsWith(prefix)); }
}

type SubmitResult = { ok: true } | { ok: false; errors: TransactionFormErrors };

/** Mirrors TransactionsProvider's wiring (reducer + save effect + restore gate) over a real storage session. */
class App {
  readonly store: FakeStorage;
  readonly session;
  state: Transaction[];
  persistenceOk = true;
  private synced: Transaction[];

  constructor(store: FakeStorage) {
    this.store = store;
    this.session = openSession(store);
    this.state = this.session.boot.transactions;
    this.synced = this.state;
  }

  /** The Add/Edit form's submit: validate, convert to cents, apply the write guard, reduce, then persist. */
  submit(values: TransactionFormValues, editId?: string): SubmitResult {
    const errors = validateTransactionForm(values);
    if (hasErrors(errors)) return { ok: false, errors };
    const input = toTransactionInput(values);
    if (input === null) return { ok: false, errors: { amount: 'Invalid.' } };
    const today = todayISO();
    const check = checkTransactionDate(input.date, today);
    if (!check.ok) return { ok: false, errors: { date: check.message } };
    this.state = transactionsReducer(
      this.state,
      editId === undefined
        ? { type: 'add', transaction: { id: createId(), ...input }, today }
        : { type: 'update', transaction: { id: editId, ...input }, today },
    );
    this.flush();
    return { ok: true };
  }

  remove(id: string) {
    this.state = transactionsReducer(this.state, { type: 'delete', id });
    this.flush();
  }

  /** The provider's "save after real changes only" effect. */
  flush() {
    if (this.state === this.synced) return;
    const outcome = this.session.save(this.state);
    if (outcome.status === 'saved') {
      this.synced = this.state;
      this.persistenceOk = true;
    } else if (outcome.status === 'failed') {
      this.persistenceOk = false;
    } else if (outcome.status === 'conflict') {
      if (outcome.sync.action === 'none') this.persistenceOk = false;
      else this.apply(outcome.sync);
    }
  }

  private apply(sync: SyncOutcome) {
    if (sync.action !== 'adopt') return;
    this.synced = sync.transactions;
    this.state = transactionsReducer(this.state, { type: 'replace', transactions: sync.transactions });
  }

  /** The context's restoreTransactions: refused while unsaved changes exist; adopts a verified result. */
  restore = (request: RestoreRequest) => {
    if (this.state !== this.synced) {
      return { status: 'refused' as const, reason: 'unsaved-changes' as const, message: 'unsaved' };
    }
    const result: RestoreOutcome = this.session.restore(request);
    if (result.status === 'restored' && result.changed) {
      this.apply({ action: 'adopt', transactions: result.transactions, notice: { kind: 'restored', message: 'ok' } });
    } else if (result.status === 'refused' && result.sync) {
      this.apply(result.sync);
    }
    return result;
  };
}

// ───────────── fixtures ─────────────

const TODAY = '2026-11-11'; // for derived views; all fixture dates are far from it
const form = (over: Partial<TransactionFormValues> = {}): TransactionFormValues => ({
  type: 'expense', amount: '10.00', categoryId: 'groceries', description: 'Item', date: '2025-03-05', ...over,
});
const stored = (list: Transaction[]) =>
  JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: '2026-11-10T08:00:00.000Z', transactions: list });
const seeded = (list: Transaction[]) => {
  const s = new FakeStorage();
  s.data.set(STORAGE_KEY, stored(list));
  return s;
};
const reload = (store: FakeStorage) => openSession(store).boot;
const saved = (store: FakeStorage) => {
  const parsed = parseStoredPayload(store.data.get(STORAGE_KEY) ?? '[]');
  assert.equal(parsed.status, 'ok');
  return parsed.status === 'ok' ? parsed.transactions : [];
};
const ids = (list: readonly Transaction[]) => list.map((t) => t.id);
const rec = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_000, categoryId: 'groceries', description: `item ${id}`, date: '2025-02-01', ...over,
});

// ───────────── add ─────────────

describe('workflow: first run → add transactions → reload', () => {
  it('three entries are validated, saved as cents and come back identical after a reload', () => {
    const store = new FakeStorage();
    const app = new App(store);
    assert.equal(app.session.boot.status, 'empty');
    assert.equal(store.writes.length, 0, 'opening the app writes nothing');

    assert.deepEqual(app.submit(form({ type: 'income', amount: '2,500.00', categoryId: 'salary', description: 'Salary', date: '2025-03-01' })), { ok: true });
    assert.deepEqual(app.submit(form({ amount: '123.45', categoryId: 'groceries', description: '  Weekly shop ', date: '2025-03-02' })), { ok: true });
    assert.deepEqual(app.submit(form({ amount: '$19.99', categoryId: 'dining', description: 'Dinner', date: '2025-03-03' })), { ok: true });

    assert.equal(app.persistenceOk, true);
    assert.equal(app.state.length, 3);
    assert.deepEqual(app.state.map((t) => [t.amount, t.description]), [[1_999, 'Dinner'], [12_345, 'Weekly shop'], [250_000, 'Salary']]);
    assert.ok(app.state.every((t) => Number.isSafeInteger(t.amount) && t.id.startsWith('tx-')));

    const boot = reload(store);
    assert.equal(boot.status, 'ok');
    assert.equal(boot.format, 'envelope');
    assert.deepEqual(boot.transactions, app.state);
    assert.deepEqual([...store.data.keys()], [STORAGE_KEY], 'no stray keys were written');
    assert.equal(store.keysWithPrefix(RECOVERY_KEY_PREFIX).length, 0);

    const summary = calculateSummary(actualTransactions(boot.transactions, TODAY));
    assert.deepEqual(summary, { totalIncome: 250_000, totalExpenses: 14_344, balance: 235_656, savingsRate: 235_656 / 250_000 });
    assert.deepEqual(calculateExpensesByCategory(boot.transactions).map((c) => [c.categoryId, c.total]), [['groceries', 12_345], ['dining', 1_999]]);
  });

  it('invalid submissions change nothing and write nothing; fixing the form then writes exactly once', () => {
    const store = new FakeStorage();
    const app = new App(store);
    const attempts: Array<[string, TransactionFormValues, string[]]> = [
      ['everything empty', form({ amount: '', description: '', categoryId: '', date: '' }), ['amount', 'categoryId', 'date', 'description']],
      ['future date', form({ date: '2999-01-01' }), ['date']],
      ['three decimals', form({ amount: '1.234' }), ['amount']],
      ['category of the wrong type', form({ categoryId: 'salary' }), ['categoryId']],
      ['impossible date', form({ date: '2025-02-31' }), ['date']],
    ];
    for (const [name, values, fields] of attempts) {
      const result = app.submit(values);
      assert.equal(result.ok, false, name);
      if (!result.ok) assert.deepEqual(Object.keys(result.errors).sort(), fields, name);
    }
    assert.deepEqual(app.state, []);
    assert.equal(store.writes.length, 0);
    assert.equal(store.data.size, 0);

    assert.deepEqual(app.submit(form({ amount: '1.23' })), { ok: true });
    assert.equal(store.writes.length, 1);
    assert.equal(saved(store).length, 1);
  });
});

// ───────────── edit ─────────────

describe('workflow: edit', () => {
  it('editing amount and category updates every derived figure and survives a reload', () => {
    const store = seeded([
      rec('inc', { type: 'income', amount: 200_000, categoryId: 'salary' }),
      rec('a', { amount: 5_000, categoryId: 'groceries' }),
      rec('b', { amount: 3_000, categoryId: 'dining' }),
    ]);
    const app = new App(store);
    assert.equal(calculateSummary(app.state).totalExpenses, 8_000);

    assert.deepEqual(app.submit(form({ amount: '75.50', categoryId: 'transport', description: 'Fuel', date: '2025-02-10' }), 'a'), { ok: true });

    assert.deepEqual(ids(app.state), ['inc', 'a', 'b'], 'position is kept');
    assert.deepEqual(app.state.find((t) => t.id === 'a'), { id: 'a', type: 'expense', amount: 7_550, categoryId: 'transport', description: 'Fuel', date: '2025-02-10' });
    assert.equal(calculateSummary(app.state).totalExpenses, 7_550 + 3_000);
    assert.deepEqual(calculateExpensesByCategory(app.state).map((c) => c.categoryId), ['transport', 'dining']);
    assert.deepEqual(reload(store).transactions, app.state);
    assert.equal(saved(store).length, 3, 'an edit never adds or drops a record');
  });

  it('a stored future-dated record stays visible but uncounted; it can only be saved with a valid date', () => {
    const store = seeded([rec('now', { amount: 4_000 }), rec('future', { amount: 90_000, date: '2999-01-01', categoryId: 'shopping' })]);
    const app = new App(store);
    assert.equal(app.session.boot.status, 'ok');
    assert.equal(app.state.length, 2, 'loading keeps the future-dated record');
    assert.equal(filterTransactions(app.state, DEFAULT_FILTERS).length, 2, 'the Transactions page still lists it');
    assert.equal(calculateSummary(actualTransactions(app.state, TODAY)).totalExpenses, 4_000, 'but no total counts it');

    const refused = app.submit(form({ amount: '900.00', categoryId: 'shopping', date: '2999-06-01' }), 'future');
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.errors.date, FUTURE_DATE_MESSAGE);
    assert.equal(store.writes.length, 0, 'a refused edit writes nothing');
    assert.equal(saved(store).find((t) => t.id === 'future')?.date, '2999-01-01', 'the stored record is untouched');

    assert.deepEqual(app.submit(form({ amount: '900.00', categoryId: 'shopping', description: 'Corrected', date: '2025-05-05' }), 'future'), { ok: true });
    assert.equal(calculateSummary(actualTransactions(app.state, TODAY)).totalExpenses, 4_000 + 90_000, 'now it counts');
    assert.deepEqual(reload(store).transactions.find((t) => t.id === 'future'), { id: 'future', type: 'expense', amount: 90_000, categoryId: 'shopping', description: 'Corrected', date: '2025-05-05' });
  });
});

// ───────────── delete ─────────────

describe('workflow: delete', () => {
  it('deleting the only row on the last page moves the list back one page and persists the deletion', () => {
    const list = Array.from({ length: 21 }, (_, i) => rec(`r${String(i).padStart(2, '0')}`, { amount: 100 + i, date: `2025-01-${String(i + 1).padStart(2, '0')}` }));
    const store = seeded(list);
    const app = new App(store);
    const view = (page: number) => paginate(sortTransactions(filterTransactions(app.state, DEFAULT_FILTERS), 'date-desc'), page);

    const last = view(3);
    assert.equal(last.items.length, 1);
    const onlyRow = last.items[0];
    const expenseBefore = calculateSummary(app.state).totalExpenses;

    app.remove(onlyRow.id);

    const after = view(3); // the page the person was looking at
    assert.deepEqual([after.page, after.pageCount, after.items.length], [2, 2, 10]);
    assert.equal(app.state.length, 20);
    assert.equal(calculateSummary(app.state).totalExpenses, expenseBefore - onlyRow.amount);
    assert.equal(saved(store).length, 20);
    assert.ok(!ids(reload(store).transactions).includes(onlyRow.id));
  });

  it('deleting every record leaves a valid empty envelope, which is not mistaken for a first run or corruption', () => {
    const store = seeded([rec('a'), rec('b')]);
    const app = new App(store);
    app.remove('a');
    app.remove('b');
    const boot = reload(store);
    assert.equal(boot.status, 'ok');
    assert.deepEqual(boot.transactions, []);
    assert.equal(boot.notice, null);
    assert.equal(store.keysWithPrefix(RECOVERY_KEY_PREFIX).length, 0);
  });
});

// ───────────── storage failure and two tabs ─────────────

describe('workflow: the browser refuses to save', () => {
  it('the entry stays on screen, a warning is raised, and nothing is lost once saving works again', () => {
    const store = new FakeStorage();
    const app = new App(store);
    store.failWrites = true;

    assert.deepEqual(app.submit(form({ amount: '20.00', description: 'first' })), { ok: true });
    assert.equal(app.persistenceOk, false, 'the warning flag is raised');
    assert.equal(app.state.length, 1, 'the entry is still shown');
    assert.equal(store.data.has(STORAGE_KEY), false, 'and nothing half-written is stored');

    store.failWrites = false;
    assert.deepEqual(app.submit(form({ amount: '30.00', description: 'second' })), { ok: true });
    assert.equal(app.persistenceOk, true);
    assert.deepEqual(saved(store).map((t) => t.description).sort(), ['first', 'second'], 'the earlier entry is saved too');
  });
});

describe('workflow: the same data open in two tabs', () => {
  it('a stale tab never overwrites newer data; it adopts it, then its repeated change is saved on top', () => {
    const store = new FakeStorage();
    const tabA = new App(store);
    const tabB = new App(store);

    tabA.submit(form({ amount: '11.00', description: 'from A' }));
    const afterA = store.data.get(STORAGE_KEY);
    assert.ok(afterA);

    tabB.submit(form({ amount: '22.00', description: 'from B' })); // B never saw A's save
    assert.equal(store.data.get(STORAGE_KEY), afterA, "B's stale write was refused: storage is exactly what A saved");
    assert.deepEqual(tabB.state.map((t) => t.description), ['from A'], 'B now shows the newer data');
    assert.equal(tabB.persistenceOk, true);

    tabB.submit(form({ amount: '22.00', description: 'from B' })); // the repeat the notice asks for
    assert.deepEqual(saved(store).map((t) => t.description).sort(), ['from A', 'from B']);
    assert.deepEqual(reload(store).transactions, tabB.state);
  });
});

// ───────────── export → preview → restore ─────────────

async function exportText(list: Transaction[]): Promise<string> {
  let text = '';
  const outcome = await exportBackup(list, { now: () => new Date('2026-11-12T08:00:00.000Z'), save: (t) => { text = t; return () => {}; } });
  assert.equal(outcome.ok, true);
  return text;
}

describe('workflow: export, preview and restore', () => {
  const original = Array.from({ length: 40 }, (_, i) =>
    rec(`o${i}`, { type: i % 5 === 0 ? 'income' : 'expense', categoryId: i % 5 === 0 ? 'salary' : 'dining', amount: 150 + i * 37, date: `2025-0${1 + (i % 9)}-1${i % 9}` }),
  );

  const merge = (app: App, parsed: Parameters<typeof runImport>[0]['parsed']): ImportRunResult =>
    runImport({ parsed, baseTransactions: app.state, currentTransactions: app.state, mode: 'merge', confirmed: true, restore: app.restore });

  it('a backup restored into an empty app reproduces the data exactly, in storage as well as on screen', async () => {
    const text = await exportText(original);
    const app = new App(new FakeStorage());
    const prepared = await prepareImport(text, app.state, { today: TODAY });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual([prepared.preview.incomingCount, prepared.preview.newCount, prepared.preview.duplicateCount, prepared.preview.conflictCount], [40, 40, 0, 0]);
    assert.equal(app.store.writes.length, 0, 'previewing writes nothing');

    const result = merge(app, prepared.parsed);
    assert.equal(result.status, 'restored');
    assert.deepEqual([...ids(app.state)].sort(), [...ids(original)].sort());
    assert.deepEqual(calculateSummary(app.state), calculateSummary(original));
    assert.deepEqual([...ids(saved(app.store))].sort(), [...ids(original)].sort());
    assert.deepEqual(reload(app.store).transactions, app.state);
  });

  it('restoring the same file again is a no-op: duplicates are skipped and nothing is written', async () => {
    const text = await exportText(original);
    const app = new App(new FakeStorage());
    const first = await prepareImport(text, app.state, { today: TODAY });
    assert.ok(first.ok);
    if (!first.ok) return;
    merge(app, first.parsed);

    const writesBefore = app.store.writes.length;
    const second = await prepareImport(text, app.state, { today: TODAY });
    assert.ok(second.ok);
    if (!second.ok) return;
    assert.deepEqual([second.preview.newCount, second.preview.duplicateCount], [0, 40]);
    const result = merge(app, second.parsed);
    assert.equal(result.status === 'restored' && result.changed, false);
    assert.equal(app.state.length, 40);
    assert.equal(app.store.writes.length, writesBefore);
  });

  it('merge keeps existing records and adds only what is new; the existing version wins a same-id conflict', async () => {
    const text = await exportText(original);
    const mine = [rec('mine-1'), { ...original[0], amount: 999_999, description: 'my newer edit' }];
    const app = new App(seeded(mine));
    const prepared = await prepareImport(text, app.state, { today: TODAY });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    assert.deepEqual([prepared.preview.newCount, prepared.preview.conflictCount], [39, 1]);

    const result = merge(app, prepared.parsed);
    assert.equal(result.status, 'restored');
    assert.equal(app.state.length, 41);
    assert.ok(app.state.some((t) => t.id === 'mine-1'));
    assert.deepEqual(app.state.find((t) => t.id === original[0].id)?.description, 'my newer edit');
    assert.equal(saved(app.store).length, 41);
  });

  it('replace needs the typed phrase, keeps a snapshot of the old data, then matches the file exactly', async () => {
    const text = await exportText(original);
    const app = new App(seeded([rec('old-1'), rec('old-2')]));
    const prepared = await prepareImport(text, app.state, { today: TODAY });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    assert.equal(prepared.preview.replaceRemovedCount, 2);

    const base = { parsed: prepared.parsed, baseTransactions: app.state, currentTransactions: app.state, mode: 'replace' as const, restore: app.restore };
    assert.deepEqual(runImport({ ...base, confirmed: true }), { status: 'not-confirmed', reason: 'replace-phrase-mismatch' });
    assert.deepEqual(runImport({ ...base, confirmed: true, replacePhrase: 'replac' }), { status: 'not-confirmed', reason: 'replace-phrase-mismatch' });
    assert.deepEqual(runImport({ ...base, confirmed: false, replacePhrase: REPLACE_CONFIRM_PHRASE }), { status: 'not-confirmed', reason: 'not-confirmed' });
    assert.deepEqual(ids(saved(app.store)), ['old-1', 'old-2'], 'unconfirmed attempts change nothing');

    const result = runImport({ ...base, confirmed: true, replacePhrase: REPLACE_CONFIRM_PHRASE });
    assert.equal(result.status, 'restored');
    if (result.status !== 'restored') return;
    assert.deepEqual([result.mode, result.removedCount, result.totalAfter, result.snapshotKept], ['replace', 2, 40, true]);
    assert.deepEqual([...ids(app.state)].sort(), [...ids(original)].sort());

    const snapshots = app.store.keysWithPrefix(SNAPSHOT_KEY_PREFIX);
    assert.equal(snapshots.length, 1);
    const snapshotText = app.store.data.get(snapshots[0]) ?? '';
    assert.ok(snapshotText.includes('old-1') && snapshotText.includes('old-2'), 'the replaced data is recoverable from the snapshot');
  });

  it('a file altered after export is rejected as a whole and the restore is never attempted', async () => {
    const text = await exportText(original);
    const doc = JSON.parse(text);
    doc.data.transactions[0].amount += 1;
    const app = new App(seeded([rec('keep-me')]));
    const prepared = await prepareImport(JSON.stringify(doc), app.state, { today: TODAY });
    assert.equal(prepared.ok, false);
    assert.equal(!prepared.ok && prepared.error.code, 'checksum-mismatch');
    assert.deepEqual(ids(app.state), ['keep-me']);
    assert.equal(app.store.writes.length, 0);
  });

  it('a restore is refused while this tab has unsaved changes, and nothing is lost', async () => {
    const text = await exportText(original);
    const app = new App(new FakeStorage());
    app.store.failWrites = true;
    app.submit(form({ description: 'unsaved entry' })); // cannot be saved → state is ahead of storage
    app.store.failWrites = false;
    const prepared = await prepareImport(text, app.state, { today: TODAY });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;

    const result = merge(app, prepared.parsed);
    assert.deepEqual([result.status, result.status === 'refused' && result.reason], ['refused', 'unsaved-changes']);
    assert.deepEqual(app.state.map((t) => t.description), ['unsaved entry'], 'the unsaved entry is still there');
  });
});
