import type { Transaction, TransactionType } from '@/types/transaction';

/**
 * Deterministic demo data: six months of realistic personal finances.
 * Dates are fixed (not relative to "today") so the data — and any tests
 * built on top of it — never change between runs.
 */

/** Last day covered by the demo data; entries after it are skipped. */
const DEMO_END_DATE = '2026-11-10';
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'] as const;

type Draft = Omit<Transaction, 'id'>;
type UndatedDraft = Omit<Draft, 'date'>;

/** Converts a human-readable amount (e.g. 15.99) to integer cents. */
const toCents = (value: number): number => Math.round(value * 100);

const entry = (
  type: TransactionType,
  amount: number,
  categoryId: string,
  description: string,
): UndatedDraft => ({ type, amount: toCents(amount), categoryId, description });

const income = (amount: number, categoryId: string, description: string) =>
  entry('income', amount, categoryId, description);

const expense = (amount: number, categoryId: string, description: string) =>
  entry('expense', amount, categoryId, description);

const oneOff = (date: string, undated: UndatedDraft): Draft => ({ ...undated, date });

/**
 * Repeats an entry on the same day of every demo month.
 * `make` receives the month index and may return null to skip a month.
 */
function recurring(day: number, make: (monthIndex: number) => UndatedDraft | null): Draft[] {
  return MONTHS.flatMap((month, monthIndex) => {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const undated = make(monthIndex);
    return undated && date <= DEMO_END_DATE ? [{ ...undated, date }] : [];
  });
}

const FREELANCE = [850, 0, 1200, 640, 980, 0];
const UTILITIES = [118.4, 96.75, 104.2, 121.9, 135.6, 128.3];
const TRANSIT = [64, 64, 64, 68, 68, 68];
const GROCERIES_EARLY = [86.4, 92.15, 78.9, 101.3, 88.75, 94.2];
const GROCERIES_LATE = [73.2, 81.6, 69.45, 77.9, 92.1, 84.35];
const GROCERIES_MONTH_END = [95.8, 67.3, 88.4, 84.15, 79.6, 90.0];
const DINING_EARLY = [54.8, 62.4, 48.9, 71.2, 58.6, 66.1];
const DINING_LATE = [89.5, 44.2, 57.8, 63.9, 76.4, 52.0];

const drafts: Draft[] = [
  // Recurring income and bills
  ...recurring(1, () => income(4200, 'salary', 'Monthly salary')),
  ...recurring(3, () => expense(1450, 'housing', 'Apartment rent')),
  ...recurring(5, () => expense(49, 'health', 'Gym membership')),
  ...recurring(8, () => expense(15.99, 'entertainment', 'Streaming subscription')),
  ...recurring(12, (i) => expense(UTILITIES[i], 'utilities', 'Electricity & internet')),
  ...recurring(15, (i) => expense(TRANSIT[i], 'transport', 'Monthly transit pass')),

  // Everyday spending
  ...recurring(6, (i) => expense(GROCERIES_EARLY[i], 'groceries', 'Supermarket')),
  ...recurring(14, (i) => expense(GROCERIES_LATE[i], 'groceries', 'Farmers market')),
  ...recurring(23, (i) => expense(GROCERIES_MONTH_END[i], 'groceries', 'Weekly groceries')),
  ...recurring(9, (i) => expense(DINING_EARLY[i], 'dining', 'Restaurant dinner')),
  ...recurring(19, (i) => expense(DINING_LATE[i], 'dining', 'Lunch with colleagues')),

  // Irregular income
  ...recurring(20, (i) =>
    FREELANCE[i] > 0 ? income(FREELANCE[i], 'freelance', 'Freelance design project') : null,
  ),
  oneOff('2026-06-28', income(142.5, 'investments', 'Dividend payout')),
  oneOff('2026-09-28', income(142.5, 'investments', 'Dividend payout')),
  oneOff('2026-10-14', income(120, 'other-income', 'Sold used bike')),

  // One-off expenses
  oneOff('2026-06-25', expense(119, 'shopping', 'Running shoes')),
  oneOff('2026-07-11', expense(38.2, 'health', 'Pharmacy')),
  oneOff('2026-07-18', expense(412, 'travel', 'Flight tickets')),
  oneOff('2026-07-20', expense(560, 'travel', 'Hotel for summer trip')),
  oneOff('2026-08-22', expense(86, 'entertainment', 'Concert tickets')),
  oneOff('2026-08-30', expense(74.9, 'shopping', 'Backpack')),
  oneOff('2026-09-02', expense(199, 'education', 'Online data science course')),
  oneOff('2026-09-17', expense(185, 'health', 'Dental check-up')),
  oneOff('2026-10-11', expense(159, 'shopping', 'Wireless headphones')),
  oneOff('2026-10-26', expense(45, 'other-expense', 'Birthday gift')),
  oneOff('2026-11-02', expense(38.5, 'transport', 'Taxi')),
  oneOff('2026-11-07', expense(142, 'shopping', 'Winter jacket')),
];

/**
 * Returns a fresh copy of the demo transactions, newest first.
 * A function (not a constant) so "reset demo data" always starts from pristine objects.
 */
export function createDemoTransactions(): Transaction[] {
  return [...drafts]
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.amount - a.amount ||
        a.description.localeCompare(b.description),
    )
    .map((draft, index) => ({
      id: `demo-${String(index + 1).padStart(3, '0')}`,
      ...draft,
    }));
}
