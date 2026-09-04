/**
 * Tolerant readers for the text a spreadsheet cell or header actually holds.
 *
 * Each returns `null` rather than guessing when the text is not unambiguously
 * the thing asked for, so a column's type can be decided by counting successes.
 *
 * Two questions no single cell can answer — whether `1.250` is a fraction or a
 * group of thousands, and whether `01/02/2026` is January or February — are
 * decided over a whole column and then applied to every cell in it.
 */

import { type Exact, fromText } from "./exact";
import type { DateConvention, DecimalConvention, Grain } from "./table";

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
/** A symbol at one end, whatever signs, spaces or parentheses wrap it. */
const LEADING_SYMBOL = new RegExp(`^([-+(\\s]*)(${SYMBOL_CLASS})\\s*`, "u");
const TRAILING_SYMBOL = new RegExp(`\\s*(${SYMBOL_CLASS})([\\s)]*)$`, "u");

const EMPTY_MARKERS: ReadonlySet<string> = new Set(["", "-", "–", "—"]);
const PARENTHESISED = /^\((.*)\)$/u;

/** The currency a cell names by symbol or ISO code, if any. */
export function detectCurrency(text: string): string | undefined {
  const value = normaliseSpaces(text);
  const code = LEADING_CODE.exec(value)?.[1] ?? TRAILING_CODE.exec(value)?.[1];
  if (code !== undefined && CURRENCY_CODES.has(code)) return code;
  const symbol =
    LEADING_SYMBOL.exec(value)?.[2] ?? TRAILING_SYMBOL.exec(value)?.[1];
  return symbol === undefined ? undefined : CURRENCY_SYMBOLS[symbol];
}

export interface AmountOptions {
  /**
   * The decimal mark of the column the cell comes from. Only a separator
   * followed by exactly three digits needs it. Defaults to `"dot"`.
   */
  readonly decimal?: DecimalConvention;
}

/**
 * Reads an amount as written by a person or an exporter: thousands separators,
 * a currency symbol or code, accounting parentheses, a trailing percent sign.
 * `12%` reads as `12`. Dashes and blanks read as `null`, as does anything that
 * could be read two ways.
 */
export function parseAmount(
  text: string,
  options: AmountOptions = {},
): Exact | null {
  const unsigned = unsign(text);
  if (unsigned === null) return null;
  const digits = readDigits(unsigned.digits, options.decimal ?? "dot");
  if (digits === null) return null;
  const canonical = fromText(digits);
  return unsigned.negative ? negate(canonical) : canonical;
}

/** Reads a whole column under the one convention its own cells agree on. */
export function parseAmountsInColumn(
  cells: readonly string[],
): readonly (Exact | null)[] {
  const decimal = decimalConvention(cells);
  return cells.map((cell) => parseAmount(cell, { decimal }));
}

interface Unsigned {
  /** Digits and separators only. */
  readonly digits: string;
  readonly negative: boolean;
}

/**
 * Strips the currency, the percent sign and the sign from a cell.
 *
 * A symbol and an accounting parenthesis nest either way round: Excel's
 * Accounting format writes `$(1,234.56)` and a person writes `($1,234.56)`. So
 * the sign is read once the currency is gone, and a doubled sign — `(-500)`,
 * `--5` — is refused rather than resolved.
 */
function unsign(text: string): Unsigned | null {
  let value = normaliseSpaces(text);
  if (EMPTY_MARKERS.has(value)) return null;
  value = stripCurrency(value);

  let negative = false;
  const parenthesised = PARENTHESISED.exec(value);
  if (parenthesised !== null) {
    negative = true;
    value = (parenthesised[1] as string).trim();
  }
  if (value.startsWith("-")) {
    if (negative) return null;
    negative = true;
    value = value.slice(1).trim();
  } else if (value.startsWith("+")) {
    value = value.slice(1).trim();
  }
  if (value.endsWith("%")) value = value.slice(0, -1).trim();
  return { digits: value, negative };
}

/**
 * Removes the currency a cell names.
 *
 * A three-letter code is only a currency when it is one this ledger knows:
 * `QTY 3` and `100 PCS` are a count and a unit, and reading them as amounts
 * types a column of quantities as money.
 */
function stripCurrency(text: string): string {
  let value = text;
  const leading = LEADING_CODE.exec(value)?.[1];
  if (leading !== undefined && CURRENCY_CODES.has(leading)) {
    value = value.slice(leading.length).trim();
  }
  const trailing = TRAILING_CODE.exec(value)?.[1];
  if (trailing !== undefined && CURRENCY_CODES.has(trailing)) {
    value = value.slice(0, -trailing.length).trim();
  }
  return value
    .replace(LEADING_SYMBOL, "$1")
    .replace(TRAILING_SYMBOL, "$2")
    .trim();
}

type Separator = "." | ",";

const PLAIN_INTEGER = /^\d+$/u;
/** Spaces group; whichever separator is left is the decimal mark. */
const SPACE_GROUPED = /^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/u;
const GROUPED: Readonly<Record<Separator, RegExp>> = {
  ".": /^\d{1,3}(?:\.\d{3})+$/u,
  ",": /^\d{1,3}(?:,\d{3})+$/u,
};
const FRACTION: Readonly<Record<Separator, RegExp>> = {
  ".": /^\d+\.\d+$/u,
  ",": /^\d+,\d+$/u,
};
/** Both separators, keyed by the one acting as the decimal mark. */
const GROUPED_FRACTION: Readonly<Record<Separator, RegExp>> = {
  ".": /^\d{1,3}(?:,\d{3})+\.\d+$/u,
  ",": /^\d{1,3}(?:\.\d{3})+,\d+$/u,
};

/**
 * The unsigned digits of an amount as a plain decimal, or `null`.
 *
 * Only one shape needs the column's convention: a separator followed by exactly
 * three digits, which is a group of thousands under one convention and a
 * fraction under the other. Every other shape settles itself — two different
 * separators means the later one is the decimal mark, and a repeated separator
 * can only be grouping.
 */
function readDigits(value: string, decimal: DecimalConvention): string | null {
  if (value.includes(" ")) {
    return SPACE_GROUPED.test(value)
      ? value.replaceAll(" ", "").replace(",", ".")
      : null;
  }
  const dots = occurrences(value, ".");
  const commas = occurrences(value, ",");
  if (dots === 0 && commas === 0) {
    return PLAIN_INTEGER.test(value) ? value : null;
  }
  if (dots > 0 && commas > 0) {
    const mark: Separator =
      value.lastIndexOf(".") > value.lastIndexOf(",") ? "." : ",";
    const group: Separator = mark === "." ? "," : ".";
    return GROUPED_FRACTION[mark].test(value)
      ? value.replaceAll(group, "").replace(mark, ".")
      : null;
  }

  const separator: Separator = dots > 0 ? "." : ",";
  const grouped = GROUPED[separator].test(value)
    ? value.replaceAll(separator, "")
    : null;
  if (dots + commas > 1) return grouped;
  const isMark = separator === markOf(decimal);
  if (!isMark && fractionLength(value, separator) === 3) return grouped;
  return FRACTION[separator].test(value)
    ? value.replace(separator, ".")
    : null;
}

function markOf(decimal: DecimalConvention): Separator {
  return decimal === "dot" ? "." : ",";
}

function fractionLength(value: string, separator: Separator): number {
  return value.length - value.lastIndexOf(separator) - 1;
}

function occurrences(value: string, character: string): number {
  return value.split(character).length - 1;
}

/**
 * What one cell proves about its column's decimal mark, or `null` when it can
 * be read either way.
 */
function decimalEvidence(value: string): DecimalConvention | null {
  const dots = occurrences(value, ".");
  const commas = occurrences(value, ",");
  if (dots > 0 && commas > 0) {
    return value.lastIndexOf(".") > value.lastIndexOf(",") ? "dot" : "comma";
  }
  if (dots === 0 && commas === 0) return null;
  const separator: Separator = dots > 0 ? "." : ",";
  // A separator that repeats is the group separator, so the mark is the other.
  if (dots + commas > 1) return separator === "." ? "comma" : "dot";
  if (fractionLength(value, separator) === 3) return null;
  return separator === "." ? "dot" : "comma";
}

/**
 * The decimal mark a column's cells agree on.
 *
 * `1.250` and `1,250` are the same shape, so a column may not read one as
 * thousands and the other as a fraction; the cells that can only be read one
 * way decide for the rest. A column with no such cell is read as US, which is
 * what a string on its own is.
 */
export function decimalConvention(
  cells: readonly string[],
): DecimalConvention {
  let dot = 0;
  let comma = 0;
  for (const cell of cells) {
    const unsigned = unsign(cell);
    if (unsigned === null) continue;
    const readable =
      readDigits(unsigned.digits, "dot") !== null ||
      readDigits(unsigned.digits, "comma") !== null;
    if (!readable) continue;
    const evidence = decimalEvidence(unsigned.digits);
    if (evidence === "dot") dot += 1;
    else if (evidence === "comma") comma += 1;
  }
  return comma > dot ? "comma" : "dot";
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
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/u;
const DAY_MONTH_YEAR = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4}|\d{2})$/u;
const MONTH_DAY_YEAR = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/u;
const MONTH_YEAR = /^([A-Za-z]{3,9})\.? (\d{4})$/u;
/** `Mar-26`, a header form; as a cell it would be ambiguous with a day. */
const MONTH_SHORT_YEAR = /^([A-Za-z]{3,9})\.?[- '](\d{2}|\d{4})$/u;
const YEAR_MONTH = /^(\d{4})[-/.](\d{1,2})$/u;

export interface DateOptions {
  /**
   * The component order of the column the cell comes from. Only a slashed date
   * whose components are both twelve or under needs it. Defaults to
   * `"month-first"`.
   */
  readonly dates?: DateConvention;
}

/**
 * Reads a calendar date and returns its midnight, UTC, as an ISO timestamp.
 * A time of day on the input is dropped; a month without a day is its first.
 */
export function parseDate(
  text: string,
  options: DateOptions = {},
): { readonly iso: string } | null {
  const value = normaliseSpaces(text);
  let iso: string | null = null;
  let match: RegExpExecArray | null;

  if ((match = ISO_DATE.exec(value)) !== null) {
    iso = midnightUtc(Number(match[1]), Number(match[2]), Number(match[3]));
  } else if ((match = SLASHED_DATE.exec(value)) !== null) {
    const dayFirst = (options.dates ?? "month-first") === "day-first";
    iso = midnightUtc(
      fullYear(match[3] as string),
      Number(match[dayFirst ? 2 : 1]),
      Number(match[dayFirst ? 1 : 2]),
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

/**
 * Which order a column writes `01/02/2026` in, or `"mixed"` when it writes
 * both and can therefore not be read as dates at all.
 *
 * A first component over twelve can only be a day; a second over twelve can
 * only be a day too, which makes the first the month. Where no cell says,
 * `fallback` decides: the file's other locale signals are all the evidence
 * there is, and reading a day-first ledger as month-first collapses a year of
 * months into January without skipping a row.
 */
export function dateConvention(
  cells: readonly string[],
  fallback: DateConvention = "month-first",
): DateConvention | "mixed" {
  let dayFirst = false;
  let monthFirst = false;
  for (const cell of cells) {
    const match = SLASHED_DATE.exec(normaliseSpaces(cell));
    if (match === null) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12 && second <= 12) dayFirst = true;
    else if (second > 12 && first <= 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return "mixed";
  if (dayFirst) return "day-first";
  if (monthFirst) return "month-first";
  return fallback;
}

/** Reads a whole column under the one order its cells agree on. */
export function parseDatesInColumn(
  cells: readonly string[],
  fallback: DateConvention = "month-first",
): readonly ({ readonly iso: string } | null)[] {
  const dates = dateConvention(cells, fallback);
  if (dates === "mixed") return cells.map(() => null);
  return cells.map((cell) => parseDate(cell, { dates }));
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
