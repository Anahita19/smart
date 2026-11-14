import { getCategory } from '@/data/categories';
import { FUTURE_DATE_MESSAGE, INVALID_DATE_MESSAGE, isFutureDate, todayISO } from '@/lib/datePolicy';
import { parseISODate } from '@/lib/format';
import type { Transaction, TransactionType } from '@/types/transaction';

/** Raw values as typed into the form (everything is a string). */
export interface TransactionFormValues {
  type: TransactionType;
  amount: string;
  categoryId: string;
  description: string;
  date: string;
}

export type TransactionFormErrors = Partial<Record<keyof TransactionFormValues, string>>;

export const MAX_DESCRIPTION_LENGTH = 80;
/** Largest accepted amount in cents ($1,000,000,000.00) – keeps totals far from Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT_CENTS = 100_000_000_000;

/**
 * Digits with an optional ".dd" part. If commas are present they must be thousands separators:
 * a first group of 1-3 digits (not starting with 0) followed by groups of exactly 3 ("1,234",
 * "12,345,678.90"); "0,001" is a decimal comma, not a thousands separator.
 */
const AMOUNT_PATTERN = /^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/;

/**
 * Converts user input such as "12", "12.5", "1,234.56" or "$12.99" to integer cents.
 * Returns null when the text is not a valid positive amount with at most 2 decimals.
 * Commas are accepted only as proper thousands separators, so an input like "1,2" (a decimal
 * comma? a typo?) is rejected instead of being silently read as 12.
 */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '');
  if (!AMOUNT_PATTERN.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Formats cents for an editable input, e.g. 1250 -> "12.50". */
export function centsToInputValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Re-exported so existing imports keep working; the implementation lives in the shared date policy. */
export { todayISO };

/**
 * `today` is injectable for tests. Dates after today are rejected (see lib/datePolicy), both when
 * adding and when editing — an existing future-dated record must get a valid date before it can be saved.
 */
export function validateTransactionForm(
  values: TransactionFormValues,
  today: string = todayISO(),
): TransactionFormErrors {
  const errors: TransactionFormErrors = {};

  const cents = parseAmountToCents(values.amount);
  if (values.amount.trim() === '') {
    errors.amount = 'Enter an amount.';
  } else if (cents === null) {
    errors.amount = 'Use a positive number with up to 2 decimals, e.g. 12.50.';
  } else if (cents <= 0) {
    errors.amount = 'Amount must be greater than zero.';
  } else if (cents > MAX_AMOUNT_CENTS) {
    errors.amount = 'Amount is too large.';
  }

  const description = values.description.trim();
  if (description === '') {
    errors.description = 'Enter a description.';
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters.`;
  }

  if (values.categoryId === '') {
    errors.categoryId = 'Choose a category.';
  } else {
    const category = getCategory(values.categoryId);
    if (category.id === 'unknown' || category.type !== values.type) {
      errors.categoryId = `Choose a valid ${values.type} category.`;
    }
  }

  if (values.date === '') {
    errors.date = 'Choose a date.';
  } else if (parseISODate(values.date) === null) {
    errors.date = INVALID_DATE_MESSAGE;
  } else if (isFutureDate(values.date, today)) {
    errors.date = FUTURE_DATE_MESSAGE;
  }

  return errors;
}

export function hasErrors(errors: TransactionFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Builds a transaction payload from *validated* values. Returns null if the values are invalid. */
export function toTransactionInput(
  values: TransactionFormValues,
): Omit<Transaction, 'id'> | null {
  if (hasErrors(validateTransactionForm(values))) return null;
  const amount = parseAmountToCents(values.amount);
  if (amount === null) return null;
  return {
    type: values.type,
    amount,
    categoryId: values.categoryId,
    description: values.description.trim(),
    date: values.date,
  };
}

/** True when any field differs from the values the form started with (an unsubmitted draft). */
export function hasDraftChanges(values: TransactionFormValues, start: TransactionFormValues): boolean {
  return (
    values.type !== start.type ||
    values.amount !== start.amount ||
    values.categoryId !== start.categoryId ||
    values.description !== start.description ||
    values.date !== start.date
  );
}
