/**
 * The versioned lexical normalisation ADR-008 requires, and nothing more.
 *
 * ADR-008 splits verification in two. Coordinate verification proves that some
 * characters really are at a stated place in a sealed document. This module
 * answers the *second*, deliberately narrow question: do those characters
 * denote this typed value and this unit?
 *
 * "Denote" here is lexical, never semantic. It decides that the characters
 * `27,633` are the integer 27633 and that `4.7%` is a percentage rather than a
 * count. It decides nothing about what the number is *of* — not the subject,
 * not the field, not the reporting period. That limit is the whole point: the
 * ADR removed the word "denotes" precisely because it smuggled in a semantic
 * verifier that does not exist, and this module must not quietly rebuild one.
 *
 * VERSIONED, because widening it changes what verifies. Admitting a new
 * separator or a new unit spelling silently accepts candidates that were
 * refused yesterday, which is a contract change wearing the clothes of a bug
 * fix. A candidate names the version it was produced under and a mismatch is
 * refused rather than reinterpreted.
 */

/** Bump when the accepted character set or unit table changes. Never edit in place. */
export const NORMALIZATION_VERSION = "1";

/**
 * Canonical unit identities. The *keys* are the spellings a source may use;
 * the values are what a candidate must claim. This table is the entire
 * definition of "supported unit syntax" — anything absent is refused, which is
 * what keeps a guess about an unfamiliar unit from becoming an accepted value.
 */
const UNIT_SPELLINGS = new Map<string, string>([
  ["", "count"],
  ["%", "percent"],
  // U+00B5 MICRO SIGN — what the OpenAQ capture actually emits.
  ["µg/m³", "ug_per_m3"],
  // U+03BC GREEK SMALL LETTER MU — visually identical, a different code point,
  // and common in text copied through editors. Mapping both to one identity is
  // exactly the kind of normalisation this module exists to make explicit and
  // versioned rather than incidental.
  ["μg/m³", "ug_per_m3"],
]);

/** Whitespace that may appear *inside* a numeric token and carries no meaning. */
const INNER_WHITESPACE = /[    ]/gu;

/** Leading signs that mean "negative" in real documents but are not ASCII `-`. */
const SIGN_SPELLINGS = new Map<string, string>([
  ["−", "-"], // MINUS SIGN
  ["–", "-"], // EN DASH, used as a minus in financial tables
]);

export type NormalizationFailure =
  | { readonly kind: "unsupported-unit-syntax"; readonly detail: string }
  | { readonly kind: "unparseable-number"; readonly detail: string };

export interface NormalizedValue {
  readonly value: number;
  readonly unit: string;
}

export type NormalizationResult = NormalizedValue | NormalizationFailure;

export function isNormalizationFailure(
  result: NormalizationResult,
): result is NormalizationFailure {
  return "kind" in result;
}

/**
 * Splits a token into its numeric part and its unit spelling.
 *
 * Only a trailing unit is recognised. A leading currency symbol is deliberately
 * NOT supported in v1: `$27,633` refuses rather than silently dropping the
 * symbol, because dropping it is how a dollar amount becomes a headcount.
 */
function splitUnit(token: string): { number: string; unit: string } {
  const match = /^([^A-Za-z%µμ]*)(.*)$/u.exec(token);
  const numberPart = match?.[1] ?? token;
  const unitPart = match?.[2] ?? "";
  return { number: numberPart, unit: unitPart };
}

/**
 * Thousands separators must actually separate thousands.
 *
 * `27,633` is a number; `2,7633` and `27,63` are not, and accepting them would
 * mean accepting a typo or a mis-sliced span as a value. Strictness here is
 * cheap to test and is the difference between a check and a formality.
 */
function stripGroupedThousands(digits: string): string | undefined {
  if (!digits.includes(",")) {
    return digits;
  }
  if (!/^\d{1,3}(,\d{3})+$/u.test(digits)) {
    return undefined;
  }
  return digits.replaceAll(",", "");
}

export function normalize(text: string): NormalizationResult {
  const trimmed = text.trim().replaceAll(INNER_WHITESPACE, "");

  let signed = trimmed;
  const firstCharacter = signed.slice(0, 1);
  const mappedSign = SIGN_SPELLINGS.get(firstCharacter);
  if (mappedSign !== undefined) {
    signed = mappedSign + signed.slice(1);
  }

  const { number: numberPart, unit: unitSpelling } = splitUnit(signed);
  const unit = UNIT_SPELLINGS.get(unitSpelling);
  if (unit === undefined) {
    return {
      kind: "unsupported-unit-syntax",
      detail: `unit spelling ${JSON.stringify(unitSpelling)} is not in the version ${NORMALIZATION_VERSION} table`,
    };
  }

  const negative = numberPart.startsWith("-");
  const magnitude = negative ? numberPart.slice(1) : numberPart;
  const [wholePart, fractionPart, ...extra] = magnitude.split(".");
  if (wholePart === undefined || extra.length > 0) {
    return {
      kind: "unparseable-number",
      detail: `${JSON.stringify(numberPart)} is not a single decimal number`,
    };
  }

  const whole = stripGroupedThousands(wholePart);
  if (whole === undefined || !/^\d+$/u.test(whole)) {
    return {
      kind: "unparseable-number",
      detail: `${JSON.stringify(wholePart)} is not a digit sequence with correctly grouped thousands`,
    };
  }
  // A fraction is optional, but an empty one (`27.`) is a malformed number
  // rather than an integer, and grouping separators are meaningless after the
  // decimal point.
  if (fractionPart !== undefined && !/^\d+$/u.test(fractionPart)) {
    return {
      kind: "unparseable-number",
      detail: `${JSON.stringify(fractionPart)} is not a valid fractional part`,
    };
  }

  const literal = `${negative ? "-" : ""}${whole}${fractionPart === undefined ? "" : `.${fractionPart}`}`;
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    return {
      kind: "unparseable-number",
      detail: `${JSON.stringify(literal)} is not a finite number`,
    };
  }
  return { value, unit };
}
