/**
 * Exact helpers the planner needs on top of the workbook's arithmetic: a
 * scaled division, a percent allocation that always sums to one hundred, and
 * the two number formats a reader sees.
 */
import { abs, add, compare, sign, toFixed, ZERO, type Exact } from "./workbook";

function parts(value: Exact): { units: bigint; scale: number } {
  const dot = value.indexOf(".");
  if (dot === -1) return { units: BigInt(value), scale: 0 };
  return {
    units: BigInt(value.slice(0, dot) + value.slice(dot + 1)),
    scale: value.length - dot - 1,
  };
}

function fromScaled(units: bigint, scale: number): Exact {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString(10)
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, "");
  const body = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative && /[1-9]/u.test(body) ? `-${body}` : body;
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** `part / whole * 100` to one decimal, half away from zero. Undefined when `whole` is zero. */
export function percentOf(part: Exact, whole: Exact): Exact | undefined {
  if (sign(whole) === 0) return undefined;
  const top = parts(part);
  const bottom = parts(whole);
  // Tenths of a percent: shift by two for percent and one more for the decimal.
  const shift = bottom.scale - top.scale + 3;
  let numerator = top.units;
  let denominator = bottom.units;
  if (shift >= 0) numerator *= 10n ** BigInt(shift);
  else denominator *= 10n ** BigInt(-shift);
  const negative = numerator < 0n !== denominator < 0n;
  const n = absBig(numerator);
  const d = absBig(denominator);
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return fromScaled(negative ? -quotient : quotient, 1);
}

/**
 * Shares of a whole in tenths of a percent that add up to exactly `100`.
 * Uses largest remainder, so no share moves by more than one tenth from its
 * true value. Falls back to plain rounding when any part is negative.
 */
export function allocatePercents(parts_: readonly Exact[]): Exact[] {
  const total = parts_.reduce((sum, value) => add(sum, value), ZERO);
  if (sign(total) <= 0 || parts_.some((value) => sign(value) < 0)) {
    return parts_.map((value) => percentOf(value, total) ?? ZERO);
  }
  const whole = parts(total);
  const scaled = parts_.map((value) => {
    const one = parts(value);
    const shift = BigInt(whole.scale - one.scale);
    const units = shift >= 0n ? one.units * 10n ** shift : one.units;
    const denominator = shift >= 0n ? whole.units : whole.units * 10n ** -shift;
    // Tenths of a percent, floored, with the remainder kept for allocation.
    const numerator = units * 1000n;
    return {
      floor: numerator / denominator,
      remainder: numerator % denominator,
    };
  });
  let leftover = 1000n - scaled.reduce((sum, one) => sum + one.floor, 0n);
  const order = scaled
    .map((one, index) => ({ index, remainder: one.remainder }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const tenths = scaled.map((one) => one.floor);
  for (const { index } of order) {
    if (leftover <= 0n) break;
    tenths[index] = (tenths[index] as bigint) + 1n;
    leftover -= 1n;
  }
  return tenths.map((value) => fromScaled(value, 1));
}

/** How a reader sees money: a currency symbol from Intl, exact digits. */
export interface MoneyFormat {
  readonly currency?: string;
  readonly decimals: 0 | 2;
}

function currencyAffix(currency: string): { prefix: string; suffix: string } {
  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(1);
    const index = formatted.findIndex((part) => part.type === "currency");
    const symbol = formatted[index]?.value ?? currency;
    const integerIndex = formatted.findIndex((part) => part.type === "integer");
    return index < integerIndex
      ? { prefix: symbol, suffix: "" }
      : { prefix: "", suffix: ` ${symbol}` };
  } catch {
    return { prefix: "", suffix: ` ${currency}` };
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

export function formatMoney(value: Exact, format: MoneyFormat): string {
  const fixed = toFixed(value, format.decimals);
  const negative = fixed.startsWith("-");
  const body = negative ? fixed.slice(1) : fixed;
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot);
  const digits = `${groupThousands(whole)}${fraction}`;
  const affix =
    format.currency === undefined
      ? { prefix: "", suffix: "" }
      : currencyAffix(format.currency);
  return `${negative ? "-" : ""}${affix.prefix}${digits}${affix.suffix}`;
}

/** `+12.3%`, `-0.4%`, `0.0%`. */
export function formatSignedPercent(value: Exact): string {
  const fixed = toFixed(value, 1);
  return sign(value) > 0 ? `+${fixed}%` : `${fixed}%`;
}

export function formatPercent(value: Exact): string {
  return `${toFixed(value, 1)}%`;
}

/** `+$1,200`, `-$40`, `$0`. */
export function formatSignedMoney(value: Exact, format: MoneyFormat): string {
  const text = formatMoney(value, format);
  return sign(value) > 0 ? `+${text}` : text;
}

export function isWhole(value: Exact): boolean {
  return !value.includes(".");
}

export function compareAbsDesc(left: Exact, right: Exact): number {
  return compare(abs(right), abs(left));
}
