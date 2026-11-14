const DEFAULT_CURRENCY = 'USD';
const DEFAULT_LOCALE = 'en-US';

const currencyFormatters = new Map<string, Intl.NumberFormat>();

function getCurrencyFormatter(currency: string, locale: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let formatter = currencyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
    currencyFormatters.set(key, formatter);
  }
  return formatter;
}

/** Formats an amount stored in minor units (cents), e.g. 123456 -> "$1,234.56". */
export function formatCurrency(
  amountInCents: number,
  currency: string = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE,
): string {
  return getCurrencyFormatter(currency, locale).format(amountInCents / 100);
}

const percentFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** Formats a ratio as a percentage, e.g. 0.425 -> "42.5%". */
export function formatPercent(ratio: number): string {
  return percentFormatter.format(ratio);
}

/**
 * Parses a YYYY-MM-DD string as a *local* calendar date.
 * (`new Date('2026-11-08')` would be parsed as UTC and can shift by a day.)
 * Returns null for malformed or impossible dates such as 2026-02-31.
 */
export function parseISODate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  const isRealDate =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return isRealDate ? date : null;
}

const dateFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Formats an ISO date for display, e.g. "2026-11-08" -> "Nov 8, 2026". Falls back to the raw input. */
export function formatDate(iso: string): string {
  const date = parseISODate(iso);
  return date ? dateFormatter.format(date) : iso;
}
