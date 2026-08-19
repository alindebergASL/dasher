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

/**
 * Space characters real documents use as a THOUSANDS SEPARATOR.
 *
 * They are not "whitespace to ignore". An earlier version of this module
 * stripped every one of them before validating grouping, which merged separate
 * tokens into a single valid number: `2 7,633` became 27633, `1 2 3` became
 * 123, and `4. 7%` became 4.7. Each of those is a span that swallowed more than
 * one number, accepted as though it were one — a deterministic lexical false
 * acceptance, and the same boundary failure as a span that cuts a number in
 * half. Found in review, not by this module's own tests.
 *
 * So a space is now a separator subject to exactly the grouping rule a comma
 * is, and is legal nowhere else in the token.
 */
const GROUPING_SPACE = /[    ]/gu;

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
 * Thousands separators must actually separate thousands, whichever character
 * spells them.
 *
 * `27,633` and `27 633` are numbers. `2,7633`, `27,63`, `1 2 3` and `2 7,633`
 * are not, and accepting any of them means accepting a typo, a mis-sliced span,
 * or two adjacent numbers glued together. One separator kind per token: a value
 * mixing commas and spaces is not a number a source wrote, it is two.
 */
function stripGroupedThousands(digits: string): string | undefined {
  const hasComma = digits.includes(",");
  const hasSpace = GROUPING_SPACE.test(digits);
  GROUPING_SPACE.lastIndex = 0; // the regex is /g/, so `test` is stateful

  if (hasComma && hasSpace) {
    return undefined;
  }
  if (!hasComma && !hasSpace) {
    return /^\d+$/u.test(digits) ? digits : undefined;
  }
  // Space-separated groups are checked by the same rule as comma-separated
  // ones rather than by a second regex that could drift away from it.
  const canonical = hasSpace ? digits.replaceAll(GROUPING_SPACE, ",") : digits;
  if (!/^\d{1,3}(,\d{3})+$/u.test(canonical)) {
    return undefined;
  }
  return canonical.replaceAll(",", "");
}

export function normalize(text: string): NormalizationResult {
  // Only the OUTER edges are trimmed. Interior space is meaningful — either a
  // thousands separator in the right place or a token boundary that must be
  // refused — so it is never removed before the number is validated.
  let signed = text.trim();
  const firstCharacter = signed.slice(0, 1);
  const mappedSign = SIGN_SPELLINGS.get(firstCharacter);
  if (mappedSign !== undefined) {
    signed = mappedSign + signed.slice(1);
  }

  const { number: rawNumber, unit: unitSpelling } = splitUnit(signed);
  // `16.0 µg/m³` puts a space before the unit; that one is separation between
  // the number and its unit, not part of either.
  const numberPart = rawNumber.trim();
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
  // rather than an integer, and neither grouping separators nor spaces mean
  // anything after the decimal point — `4. 7%` is two tokens, not 4.7.
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
