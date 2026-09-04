/**
 * Tolerant readers for the text a spreadsheet cell or header actually holds.
 *
 * Each returns `null` rather than guessing when the text is not unambiguously
 * the thing asked for, so a column's type can be decided by counting successes.
 */

import { type Exact, fromText } from "./exact";
import type { Grain } from "./table";

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
};

const CURRENCY_CODES: ReadonlySet<string> = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "INR",
  "CNY",
  "HKD",
  "SGD",
  "MXN",
  "BRL",
  "ZAR",
  "PLN",
  "CZK",
  "HUF",
  "KRW",
]);

const SYMBOL_CLASS = `[${Object.keys(CURRENCY_SYMBOLS).join("")}]`;
const LEADING_CODE = /^([A-Z]{3})(?=[\s\d(+-])/u;
const TRAILING_CODE = /(?<=[\s\d)%])([A-Z]{3})$/u;
const LEADING_SYMBOL = new RegExp(`^([-+(]?\\s*)(${SYMBOL_CLASS})\\s*`, "u");
const TRAILING_SYMBOL = new RegExp(`\\s*(${SYMBOL_CLASS})(\\s*\\)?)$`, "u");

const EMPTY_MARKERS: ReadonlySet<string> = new Set(["", "-", "–", "—"]);

/** The currency a cell names by symbol or ISO code, if any. */
export function detectCurrency(text: string): string | undefined {
  const value = normaliseSpaces(text);
  const code = LEADING_CODE.exec(value)?.[1] ?? TRAILING_CODE.exec(value)?.[1];
  if (code !== undefined && CURRENCY_CODES.has(code)) return code;
  const symbol =
    LEADING_SYMBOL.exec(value)?.[2] ?? TRAILING_SYMBOL.exec(value)?.[1];
  return symbol === undefined ? undefined : CURRENCY_SYMBOLS[symbol];
}

/**
 * Reads an amount as written by a person or an exporter: thousands separators,
 * a currency symbol or code, accounting parentheses, a trailing percent sign.
 * `12%` reads as `12`. Dashes and blanks read as `null`, as does anything that
 * could be read two ways.
 */
export function parseAmount(text: string): Exact | null {
  let value = normaliseSpaces(text);
  if (EMPTY_MARKERS.has(value)) return null;

  value = value.replace(LEADING_CODE, "").replace(TRAILING_CODE, "").trim();

  let negative = false;
  const parenthesised = /^\((.*)\)$/u.exec(value);
  if (parenthesised !== null) {
    negative = true;
    value = (parenthesised[1] as string).trim();
  }

  value = value.replace(LEADING_SYMBOL, "$1").replace(TRAILING_SYMBOL, "$2");
  value = value.trim();

  if (value.startsWith("-")) {
    if (negative) return null;
    negative = true;
    value = value.slice(1).trim();
  } else if (value.startsWith("+")) {
    value = value.slice(1).trim();
  }

  if (value.endsWith("%")) value = value.slice(0, -1).trim();

  const digits = readDigits(value);
  if (digits === null) return null;
  const canonical = fromText(digits);
  return negative ? negate(canonical) : canonical;
}

const PLAIN = /^\d+(?:\.\d+)?$/u;
const COMMA_THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;
const SPACE_THOUSANDS = /^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/u;
const DOT_THOUSANDS_COMMA_DECIMAL = /^\d{1,3}(?:\.\d{3})+,\d+$/u;
const COMMA_DECIMAL = /^\d+,\d+$/u;

/** The unsigned digits of an amount as a plain decimal, or `null`. */
function readDigits(value: string): string | null {
  if (PLAIN.test(value)) return value;
  if (COMMA_THOUSANDS.test(value)) return value.replaceAll(",", "");
  if (SPACE_THOUSANDS.test(value)) {
    return value.replaceAll(" ", "").replace(",", ".");
  }
  if (DOT_THOUSANDS_COMMA_DECIMAL.test(value)) {
    return value.replaceAll(".", "").replace(",", ".");
  }
  if (COMMA_DECIMAL.test(value)) {
    // `12,50` is a decimal; `12,500` is three-digit grouping and already read
    // above, so a comma followed by exactly three digits is left ambiguous.
    const fraction = value.slice(value.indexOf(",") + 1);
    return fraction.length === 3 ? null : value.replace(",", ".");
  }
  return null;
}

function negate(value: Exact): Exact {
  return value === "0" ? value : `-${value}`;
}

function normaliseSpaces(text: string): string {
  return text.replaceAll(/[\u00A0\u202F\u2009]/gu, " ").trim();
}

const MONTHS: readonly string[] = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const MONTH_LABELS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const FULL_MONTHS: readonly string[] = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Month number 1-12 from `Mar`, `March`, `Sept`, or `null`. */
function monthFromName(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((month) => lower.startsWith(month));
  if (index === -1) return null;
  const accepted =
    lower === MONTHS[index] || lower === FULL_MONTHS[index] || lower === "sept";
  return accepted ? index + 1 : null;
}

function midnightUtc(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return valid ? date.toISOString() : null;
}

function fullYear(text: string): number {
  const year = Number(text);
  if (text.length === 4) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

const ISO_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/u;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/u;
const DAY_MONTH_YEAR = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4}|\d{2})$/u;
const MONTH_DAY_YEAR = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/u;
const MONTH_YEAR = /^([A-Za-z]{3,9})\.? (\d{4})$/u;
/** `Mar-26`, a header form; as a cell it would be ambiguous with a day. */
const MONTH_SHORT_YEAR = /^([A-Za-z]{3,9})\.?[- '](\d{2}|\d{4})$/u;
const YEAR_MONTH = /^(\d{4})[-/.](\d{1,2})$/u;

/**
 * Reads a calendar date and returns its midnight, UTC, as an ISO timestamp.
 * A time of day on the input is dropped; a month without a day is its first.
 */
export function parseDate(text: string): { readonly iso: string } | null {
  const value = normaliseSpaces(text);
  let iso: string | null = null;
  let match: RegExpExecArray | null;

  if ((match = ISO_DATE.exec(value)) !== null) {
    iso = midnightUtc(Number(match[1]), Number(match[2]), Number(match[3]));
  } else if ((match = US_DATE.exec(value)) !== null) {
    iso = midnightUtc(
      fullYear(match[3] as string),
      Number(match[1]),
      Number(match[2]),
    );
  } else if ((match = DAY_MONTH_YEAR.exec(value)) !== null) {
    const month = monthFromName(match[2] as string);
    if (month !== null) {
      iso = midnightUtc(fullYear(match[3] as string), month, Number(match[1]));
    }
  } else if ((match = MONTH_DAY_YEAR.exec(value)) !== null) {
    const month = monthFromName(match[1] as string);
    if (month !== null) {
      iso = midnightUtc(Number(match[3]), month, Number(match[2]));
    }
  } else if ((match = MONTH_YEAR.exec(value)) !== null) {
    const month = monthFromName(match[1] as string);
    if (month !== null) iso = midnightUtc(Number(match[2]), month, 1);
  } else if ((match = YEAR_MONTH.exec(value)) !== null) {
    iso = midnightUtc(Number(match[1]), Number(match[2]), 1);
  }

  return iso === null ? null : { iso };
}

const QUARTER_YEAR = /^Q([1-4])[- ']?(\d{4}|\d{2})$/iu;
const YEAR_QUARTER = /^(\d{4})[- ]?Q([1-4])$/iu;
const FISCAL_YEAR = /^FY[- ']?(\d{4}|\d{2})$/iu;
const BARE_YEAR = /^(19|20)\d{2}$/u;

/**
 * Reads a column header that names a period and returns the canonical bucket
 * key (`2026-03`, `2026-Q1`, `2026`) with its grain.
 */
export function parsePeriodHeader(
  text: string,
): { readonly key: string; readonly grain: Grain } | null {
  const value = normaliseSpaces(text);
  let match: RegExpExecArray | null;

  if ((match = YEAR_QUARTER.exec(value)) !== null) {
    return {
      key: `${match[1] as string}-Q${match[2] as string}`,
      grain: "quarter",
    };
  }
  if ((match = QUARTER_YEAR.exec(value)) !== null) {
    const year = fullYear(match[2] as string);
    return { key: `${String(year)}-Q${match[1] as string}`, grain: "quarter" };
  }
  if ((match = FISCAL_YEAR.exec(value)) !== null) {
    return { key: String(fullYear(match[1] as string)), grain: "year" };
  }
  if (BARE_YEAR.test(value)) return { key: value, grain: "year" };

  if ((match = MONTH_SHORT_YEAR.exec(value)) !== null) {
    const month = monthFromName(match[1] as string);
    if (month === null) return null;
    const year = fullYear(match[2] as string);
    return {
      key: `${String(year)}-${String(month).padStart(2, "0")}`,
      grain: "month",
    };
  }
  if (YEAR_MONTH.test(value) || ISO_DATE.test(value)) {
    const date = parseDate(value);
    if (date === null || !date.iso.endsWith("-01T00:00:00.000Z")) return null;
    return { key: bucketPeriod(date.iso, "month"), grain: "month" };
  }
  return null;
}

/** The bucket an ISO date falls in at a grain: `2026-03`, `2026-Q1`, `2026`. */
export function bucketPeriod(isoDate: string, grain: Grain): string {
  const year = isoDate.slice(0, 4);
  const month = Number(isoDate.slice(5, 7));
  if (!/^\d{4}$/u.test(year) || month < 1 || month > 12) {
    throw new RangeError(`${isoDate} is not an ISO date`);
  }
  switch (grain) {
    case "month":
      return `${year}-${isoDate.slice(5, 7)}`;
    case "quarter":
      return `${year}-Q${String(Math.ceil(month / 3))}`;
    case "year":
      return year;
  }
}

const MONTH_BUCKET = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const QUARTER_BUCKET = /^(\d{4})-Q([1-4])$/u;
const YEAR_BUCKET = /^\d{4}$/u;

/** The grain a bucket key was written at. */
export function periodGrain(bucket: string): Grain {
  if (MONTH_BUCKET.test(bucket)) return "month";
  if (QUARTER_BUCKET.test(bucket)) return "quarter";
  if (YEAR_BUCKET.test(bucket)) return "year";
  throw new RangeError(`${bucket} is not a period bucket`);
}

/** Midnight UTC on the first day of the bucket. */
export function periodStartIso(bucket: string): string {
  let match: RegExpExecArray | null;
  if ((match = MONTH_BUCKET.exec(bucket)) !== null) {
    return midnightUtc(Number(match[1]), Number(match[2]), 1) as string;
  }
  if ((match = QUARTER_BUCKET.exec(bucket)) !== null) {
    const month = (Number(match[2]) - 1) * 3 + 1;
    return midnightUtc(Number(match[1]), month, 1) as string;
  }
  if (YEAR_BUCKET.test(bucket))
    return midnightUtc(Number(bucket), 1, 1) as string;
  throw new RangeError(`${bucket} is not a period bucket`);
}

/** `Mar 2026`, `Q1 2026`, `2026`. */
export function periodLabel(bucket: string): string {
  let match: RegExpExecArray | null;
  if ((match = MONTH_BUCKET.exec(bucket)) !== null) {
    const month = MONTH_LABELS[Number(match[2]) - 1] as string;
    return `${month} ${match[1] as string}`;
  }
  if ((match = QUARTER_BUCKET.exec(bucket)) !== null) {
    return `Q${match[2] as string} ${match[1] as string}`;
  }
  if (YEAR_BUCKET.test(bucket)) return bucket;
  throw new RangeError(`${bucket} is not a period bucket`);
}

const GRAIN_ORDER: Readonly<Record<Grain, number>> = {
  year: 0,
  quarter: 1,
  month: 2,
};

/** Chronological order by start; a coarser bucket sorts before a finer one. */
export function comparePeriods(a: string, b: string): number {
  const starts = periodStartIso(a).localeCompare(periodStartIso(b));
  if (starts !== 0) return starts;
  return GRAIN_ORDER[periodGrain(a)] - GRAIN_ORDER[periodGrain(b)];
}
