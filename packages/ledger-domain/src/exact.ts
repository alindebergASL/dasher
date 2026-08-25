/**
 * Exact decimal values, as text, for money and the ratios derived from it.
 *
 * WHY THIS EXISTS. Every figure on a ledger dashboard was a JavaScript `number`.
 * The defect that made the cost concrete was small and completely silent: the
 * committed fixture's shares summed to 99.99999999999999 rather than 100, and
 * the test written for that property asserted `toBeCloseTo(100, 6)` — a
 * tolerance chosen to fit what the code did rather than what a finance dashboard
 * needs. A tolerance is the right tool for a sensor reading. It is the wrong
 * tool for an amount of money, where the arithmetic has an exact answer and
 * anything else is an error the reader cannot see.
 *
 * WHY TEXT rather than the engine's `{coefficient, scale}` pair. These values
 * cross three boundaries — into evidence a reader is shown, into a compiled
 * `DashboardSpec` that is hashed and persisted, and into test expectations. A
 * decimal string is the same thing in all three, and `"0.6662881571"` says what
 * it is where `{coefficient: "6662881571", scale: "i64:10"}` needs decoding.
 * The pair remains the engine's wire form; this is the shape it is read into.
 *
 * Every value here is canonical: no leading zeros, no trailing fractional
 * zeros, a single optional leading `-`, and never `-0`.
 */

/**
 * A canonical decimal, as text. Not branded: the values flow into strings a
 * reader sees, and a brand would have to be stripped at every one of those
 * boundaries, which is where a wrong value would slip in unnoticed anyway.
 */
export type Exact = string;

export const ZERO: Exact = "0";

const DIGITS = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/** Splits a canonical decimal into a scaled integer and its scale. */
function parts(value: Exact): {
  readonly units: bigint;
  readonly scale: number;
} {
  const dot = value.indexOf(".");
  if (dot === -1) return { units: BigInt(value), scale: 0 };
  const scale = value.length - dot - 1;
  return {
    units: BigInt(value.slice(0, dot) + value.slice(dot + 1)),
    scale,
  };
}

/** Renders a scaled integer as a canonical decimal, trimming what is not there. */
export function fromParts(units: bigint, scale: number): Exact {
  if (scale === 0) return units.toString(10);
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString(10)
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, "");
  const body = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  // `-0` is a value JavaScript has and arithmetic does not; it must not reach a
  // reader, and it must not make two equal results compare as different text.
  return negative && /[1-9]/u.test(body) ? `-${body}` : body;
}

/** Reads the engine's wire form. */
export function fromEngineDecimal(value: {
  readonly coefficient: string;
  readonly scale: string;
}): Exact {
  return fromParts(BigInt(value.coefficient), Number(value.scale.slice(4)));
}

/**
 * Reads a JSON number as the decimal that was written.
 *
 * `toString` returns the shortest text that round-trips to the same double,
 * which for any amount a person actually typed is the text they typed: `49875`
 * and `1234.56` come back unchanged. That makes this exact with respect to the
 * authored value, which is the only sense in which reading a `number` can be
 * exact at all.
 *
 * It refuses rather than approximates on the two forms where that guarantee
 * fails — a magnitude large or small enough that `toString` switches to
 * exponent notation, and any non-finite value. THIS IS A BOUNDARY, NOT A FIX:
 * the snapshot still carries `number`, and a workbook carrying real cents
 * should carry decimal text instead. That change belongs with the slice that
 * parses workbooks, where there is a wire format to change.
 */
export function fromNumber(value: number): Exact {
  const text = value.toString(10);
  if (!DIGITS.test(text)) {
    throw new RangeError(
      `${text} is not a decimal this ledger can carry exactly`,
    );
  }
  return text;
}

/** Aligns two values to a common scale so their integers can be compared. */
function align(
  left: Exact,
  right: Exact,
): { readonly left: bigint; readonly right: bigint; readonly scale: number } {
  const one = parts(left);
  const two = parts(right);
  const scale = Math.max(one.scale, two.scale);
  return {
    left: one.units * 10n ** BigInt(scale - one.scale),
    right: two.units * 10n ** BigInt(scale - two.scale),
    scale,
  };
}

export function add(left: Exact, right: Exact): Exact {
  const pair = align(left, right);
  return fromParts(pair.left + pair.right, pair.scale);
}

export function subtract(left: Exact, right: Exact): Exact {
  const pair = align(left, right);
  return fromParts(pair.left - pair.right, pair.scale);
}

/** Negative, zero, or positive, for sorting and for comparisons. */
export function compare(left: Exact, right: Exact): number {
  const pair = align(left, right);
  return pair.left < pair.right ? -1 : pair.left > pair.right ? 1 : 0;
}

export function sign(value: Exact): -1 | 0 | 1 {
  return value.startsWith("-") ? -1 : value === "0" ? 0 : 1;
}

export function abs(value: Exact): Exact {
  return value.startsWith("-") ? value.slice(1) : value;
}

/** A ratio as a percentage, by moving the point rather than by multiplying. */
export function ratioToPercent(ratio: Exact): Exact {
  const one = parts(ratio);
  return one.scale >= 2
    ? fromParts(one.units, one.scale - 2)
    : fromParts(one.units * 10n ** BigInt(2 - one.scale), 0);
}

/**
 * Rounds half away from zero to `places`, for display only.
 *
 * Half-away rather than half-even because this is the last step before a reader
 * sees the number, and `+7.5%` reading as `+8%` is what a person expects. The
 * engine's own arithmetic uses half-even, where the bias matters because
 * results are summed again.
 */
export function round(value: Exact, places: number): Exact {
  const one = parts(value);
  if (one.scale <= places) return value;
  const divisor = 10n ** BigInt(one.scale - places);
  const negative = one.units < 0n;
  const magnitude = negative ? -one.units : one.units;
  const quotient = magnitude / divisor;
  const carry =
    magnitude % divisor >= divisor - (magnitude % divisor) ? 1n : 0n;
  const rounded = quotient + carry;
  return fromParts(negative ? -rounded : rounded, places);
}

/** Pads to exactly `places` decimals, so a column of figures lines up. */
export function toFixed(value: Exact, places: number): string {
  const rounded = round(value, places);
  if (places === 0) return rounded;
  const dot = rounded.indexOf(".");
  if (dot === -1) return `${rounded}.${"0".repeat(places)}`;
  const fraction = rounded.length - dot - 1;
  return `${rounded}${"0".repeat(places - fraction)}`;
}
