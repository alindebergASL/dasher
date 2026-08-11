/**
 * Exact tagged signed-64 and canonical decimal primitives for
 * `calculation-registry-v1`.
 *
 * Every semantic signed-64 value is the tagged string form `i64:<decimal>` and is
 * parsed straight to `bigint`; no value is routed through a JavaScript number.
 * Decimals are the canonical `{coefficient, scale}` pair, and every arithmetic
 * stage runs on exact reduced rationals with exactly one final quantization.
 */

import { LIMITS } from "./limits";

export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;

/** Maximum coefficient digits, excluding sign, of any canonical decimal. */
export const MAX_COEFFICIENT_DIGITS = LIMITS.coefficientDigits;
/** Maximum canonical decimal scale. */
export const MAX_SCALE = LIMITS.scale;

export type Rounding = "none" | "half_even";

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export interface CanonicalDecimal {
  readonly coefficient: bigint;
  readonly scale: bigint;
}

export type QuantizeResult =
  | { readonly ok: true; readonly value: CanonicalDecimal }
  | { readonly ok: false; readonly reason: "inexact" | "overflow" };

const TAG = "i64:";

/**
 * Reads the exact grammar `0|-?[1-9][0-9]*` without a regular expression so that
 * untrusted text can never drive a backtracking evaluator.
 */
function parseCanonicalIntegerText(text: string): bigint | null {
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  if (digits.length === 0) return null;
  for (let index = 0; index < digits.length; index += 1) {
    const code = digits.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return null;
  }
  if (digits.length > 1 && digits.charCodeAt(0) === 0x30) return null;
  if (negative && digits === "0") return null;
  return negative ? -BigInt(digits) : BigInt(digits);
}

/** Parses the exact tagged form, returning null for every noncanonical spelling. */
export function parseTaggedI64(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith(TAG)) return null;
  const parsed = parseCanonicalIntegerText(value.slice(TAG.length));
  if (parsed === null) return null;
  if (parsed < I64_MIN || parsed > I64_MAX) return null;
  return parsed;
}

export function formatTaggedI64(value: bigint): string {
  return `${TAG}${value.toString(10)}`;
}

/** Checked signed-64 addition; null on overflow. */
export function checkedAdd(left: bigint, right: bigint): bigint | null {
  const sum = left + right;
  return sum < I64_MIN || sum > I64_MAX ? null : sum;
}

/** Checked signed-64 multiplication; null on overflow. */
export function checkedMultiply(left: bigint, right: bigint): bigint | null {
  const product = left * right;
  return product < I64_MIN || product > I64_MAX ? null : product;
}

export function coefficientDigits(coefficient: bigint): bigint {
  const absolute = coefficient < 0n ? -coefficient : coefficient;
  return BigInt(absolute.toString(10).length);
}

/** Strips coefficient trailing zeroes while scale is positive; zero is `0`/`i64:0`. */
export function canonicalizeDecimal(
  coefficient: bigint,
  scale: bigint,
): CanonicalDecimal {
  if (coefficient === 0n) return { coefficient: 0n, scale: 0n };
  let value = coefficient;
  let remaining = scale;
  while (remaining > 0n && value % 10n === 0n) {
    value /= 10n;
    remaining -= 1n;
  }
  return { coefficient: value, scale: remaining };
}

/**
 * A prototype-free or ordinary plain object; every other exotic object is not a
 * document value. Parsed canonical objects are prototype-free so that no
 * untrusted key can reach `Object.prototype`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Parses the canonical decimal object, rejecting unknown keys, unreduced
 * trailing zeroes, negative zero, 39 digits, and out-of-range scales.
 */
export function parseDecimalObject(value: unknown): CanonicalDecimal | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2) return null;
  if (!keys.includes("coefficient") || !keys.includes("scale")) return null;
  const coefficientText = value.coefficient;
  if (typeof coefficientText !== "string") return null;
  const coefficient = parseCanonicalIntegerText(coefficientText);
  if (coefficient === null) return null;
  if (coefficientDigits(coefficient) > MAX_COEFFICIENT_DIGITS) return null;
  const scale = parseTaggedI64(value.scale);
  if (scale === null || scale < 0n || scale > MAX_SCALE) return null;
  if (coefficient === 0n && scale !== 0n) return null;
  if (scale > 0n && coefficient % 10n === 0n) return null;
  return { coefficient, scale };
}

export function formatDecimalObject(value: CanonicalDecimal): {
  coefficient: string;
  scale: string;
} {
  return {
    coefficient: value.coefficient.toString(10),
    scale: formatTaggedI64(value.scale),
  };
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

/** Builds a sign-normalized, GCD-reduced rational with a positive denominator. */
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RangeError("zero denominator");
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { n: 0n, d: 1n };
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

export function integerToRational(value: bigint): Rational {
  return { n: value, d: 1n };
}

export function decimalToRational(value: CanonicalDecimal): Rational {
  return rational(value.coefficient, 10n ** value.scale);
}

export function ratAdd(left: Rational, right: Rational): Rational {
  return rational(left.n * right.d + right.n * left.d, left.d * right.d);
}

export function ratSubtract(left: Rational, right: Rational): Rational {
  return rational(left.n * right.d - right.n * left.d, left.d * right.d);
}

export function ratMultiply(left: Rational, right: Rational): Rational {
  return rational(left.n * right.n, left.d * right.d);
}

/** Exact division; null denotes an exact zero denominator. */
export function ratDivide(left: Rational, right: Rational): Rational | null {
  if (right.n === 0n) return null;
  return rational(left.n * right.d, left.d * right.n);
}

export function ratNegate(value: Rational): Rational {
  return { n: -value.n, d: value.d };
}

export function ratAbs(value: Rational): Rational {
  return value.n < 0n ? { n: -value.n, d: value.d } : value;
}

export function ratIsZero(value: Rational): boolean {
  return value.n === 0n;
}

export function ratCompare(left: Rational, right: Rational): -1 | 0 | 1 {
  const difference = left.n * right.d - right.n * left.d;
  if (difference < 0n) return -1;
  if (difference > 0n) return 1;
  return 0;
}

/**
 * The single final node quantization: multiply by `10^scale`, require an integer
 * coefficient for `none` or take the symmetric ties-to-even nearest integer for
 * `half_even`, check the 38-digit ceiling, then canonicalize.
 */
export function quantize(
  value: Rational,
  scale: bigint,
  rounding: Rounding,
): QuantizeResult {
  const scaledNumerator = value.n * 10n ** scale;
  const denominator = value.d;
  let coefficient = scaledNumerator / denominator;
  const remainder = scaledNumerator - coefficient * denominator;
  if (remainder !== 0n) {
    if (rounding === "none") return { ok: false, reason: "inexact" };
    const step = remainder < 0n ? -1n : 1n;
    const twiceRemainder = remainder < 0n ? -2n * remainder : 2n * remainder;
    if (twiceRemainder > denominator) {
      coefficient += step;
    } else if (twiceRemainder === denominator && coefficient % 2n !== 0n) {
      coefficient += step;
    }
  }
  if (coefficientDigits(coefficient) > MAX_COEFFICIENT_DIGITS) {
    return { ok: false, reason: "overflow" };
  }
  return { ok: true, value: canonicalizeDecimal(coefficient, scale) };
}
