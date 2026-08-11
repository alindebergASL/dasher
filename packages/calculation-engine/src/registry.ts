/**
 * The closed `calculation-registry-v1` lookup tables: `ucum-subset-v1`,
 * `iso4217-task9-v1`, `calculation-limits-v1`, the `W(t)` canonical value widths,
 * the exhaustive operation key registry, and the exhaustive primitive-step map.
 *
 * These are lookup tables, not parsers. No unit string is prefixed, pluralized,
 * trimmed, aliased, or composed, and no currency code is derived from another.
 */

import {
  type CanonicalDecimal,
  type Rational,
  type Rounding,
  quantize,
  ratAdd,
  ratDivide,
  ratMultiply,
  ratSubtract,
  rational,
} from "./decimal";

export const UNIT_REGISTRY_VERSION = "ucum-subset-v1";
export const CURRENCY_REGISTRY_VERSION = "iso4217-task9-v1";
export const REGISTRY_NAME = "calculation-registry-v1";
export const LIMITS_NAME = "calculation-limits-v1";
export const GRAPH_SCHEMA_NAME = "calculation-graph-v1";
export const TZDB_VERSION = "2025b";

export type Dimension =
  | "dimensionless"
  | "length"
  | "duration"
  | "volume"
  | "volumetric_flow"
  | "temperature";

export interface UnitEntry {
  readonly unit: string;
  readonly dimension: Dimension;
  readonly baseUnit: string;
  readonly multiplier: Rational;
  readonly offset: Rational;
  readonly affine: boolean;
}

function unit(
  unitText: string,
  dimension: Dimension,
  baseUnit: string,
  multiplierNumerator: bigint,
  multiplierDenominator: bigint,
  offsetNumerator: bigint,
  offsetDenominator: bigint,
): UnitEntry {
  return {
    unit: unitText,
    dimension,
    baseUnit,
    multiplier: { n: multiplierNumerator, d: multiplierDenominator },
    offset: { n: offsetNumerator, d: offsetDenominator },
    affine: offsetNumerator !== 0n,
  };
}

/** The 26 accepted unit literals in the frozen table order. */
export const UNIT_REGISTRY: readonly UnitEntry[] = Object.freeze([
  unit("1", "dimensionless", "1", 1n, 1n, 0n, 1n),
  unit("%", "dimensionless", "1", 1n, 100n, 0n, 1n),
  unit("m", "length", "m", 1n, 1n, 0n, 1n),
  unit("cm", "length", "m", 1n, 100n, 0n, 1n),
  unit("mm", "length", "m", 1n, 1000n, 0n, 1n),
  unit("km", "length", "m", 1000n, 1n, 0n, 1n),
  unit("[in_i]", "length", "m", 127n, 5000n, 0n, 1n),
  unit("[ft_i]", "length", "m", 381n, 1250n, 0n, 1n),
  unit("s", "duration", "s", 1n, 1n, 0n, 1n),
  unit("min", "duration", "s", 60n, 1n, 0n, 1n),
  unit("h", "duration", "s", 3600n, 1n, 0n, 1n),
  unit("d", "duration", "s", 86400n, 1n, 0n, 1n),
  unit("m3", "volume", "m3", 1n, 1n, 0n, 1n),
  unit("L", "volume", "m3", 1n, 1000n, 0n, 1n),
  unit("[ft_i]3", "volume", "m3", 55306341n, 1953125000n, 0n, 1n),
  unit("[gal_us]", "volume", "m3", 473176473n, 125000000000n, 0n, 1n),
  unit("m3/s", "volumetric_flow", "m3/s", 1n, 1n, 0n, 1n),
  unit("m3/h", "volumetric_flow", "m3/s", 1n, 3600n, 0n, 1n),
  unit("L/s", "volumetric_flow", "m3/s", 1n, 1000n, 0n, 1n),
  unit("L/min", "volumetric_flow", "m3/s", 1n, 60000n, 0n, 1n),
  unit("[ft_i]3/s", "volumetric_flow", "m3/s", 55306341n, 1953125000n, 0n, 1n),
  unit(
    "[gal_us]/min",
    "volumetric_flow",
    "m3/s",
    157725491n,
    2500000000000n,
    0n,
    1n,
  ),
  unit("K", "temperature", "K", 1n, 1n, 0n, 1n),
  unit("Cel", "temperature", "K", 1n, 1n, 5463n, 20n),
  unit("[degF]", "temperature", "K", 5n, 9n, 45967n, 180n),
  unit("[degR]", "temperature", "K", 5n, 9n, 0n, 1n),
]);

const UNIT_BY_LITERAL = new Map(
  UNIT_REGISTRY.map((entry) => [entry.unit, entry] as const),
);

/** Exact case-sensitive ASCII lookup; every other string is unknown. */
export function lookupUnit(value: unknown): UnitEntry | null {
  if (typeof value !== "string") return null;
  return UNIT_BY_LITERAL.get(value) ?? null;
}

export type UnitConversionResult =
  | { readonly ok: true; readonly value: CanonicalDecimal }
  | {
      readonly ok: false;
      readonly code: "invalid_unit_conversion" | "unit_mismatch" | "overflow";
    };

/**
 * The exact two-stage conversion: `base = x * Ms + Os`, then
 * `target = (base - Ot) / Mt`, with no quantization between the stages and
 * exactly one final quantization at the node scale.
 */
export function convertUnitValue(
  value: Rational,
  fromUnit: string,
  toUnit: string,
  scale: bigint,
  rounding: Rounding,
): UnitConversionResult {
  const source = lookupUnit(fromUnit);
  const target = lookupUnit(toUnit);
  if (source === null || target === null) {
    return { ok: false, code: "invalid_unit_conversion" };
  }
  if (source.dimension !== target.dimension) {
    return { ok: false, code: "unit_mismatch" };
  }
  const base = ratAdd(
    ratMultiply(value, rational(source.multiplier.n, source.multiplier.d)),
    rational(source.offset.n, source.offset.d),
  );
  const shifted = ratSubtract(base, rational(target.offset.n, target.offset.d));
  const converted = ratDivide(
    shifted,
    rational(target.multiplier.n, target.multiplier.d),
  );
  if (converted === null) return { ok: false, code: "invalid_unit_conversion" };
  const quantized = quantize(converted, scale, rounding);
  if (!quantized.ok) {
    return {
      ok: false,
      code:
        quantized.reason === "overflow"
          ? "overflow"
          : "invalid_unit_conversion",
    };
  }
  return { ok: true, value: quantized.value };
}

/** The closed four-code minor-unit exponent table. */
export const CURRENCY_REGISTRY: ReadonlyMap<string, bigint> = new Map([
  ["USD", 2n],
  ["EUR", 2n],
  ["GBP", 2n],
  ["JPY", 0n],
]);

export function lookupCurrency(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  return CURRENCY_REGISTRY.get(value) ?? null;
}

/** Inclusive fixed FX age from the graph's pinned evaluation time. */
export const FX_MAX_AGE_MILLIS = 86400000n;

export type CurrencyConversionResult =
  | { readonly ok: true; readonly value: CanonicalDecimal }
  | { readonly ok: false; readonly code: "overflow" };

/**
 * The sole FX formula `target = input * rate`: one exact rational multiply and
 * one final symmetric half-even quantization at the target minor-unit exponent.
 */
export function convertCurrencyValue(
  value: Rational,
  rate: Rational,
  targetExponent: bigint,
): CurrencyConversionResult {
  const quantized = quantize(
    ratMultiply(value, rate),
    targetExponent,
    "half_even",
  );
  if (!quantized.ok) return { ok: false, code: "overflow" };
  return { ok: true, value: quantized.value };
}

export { LIMITS, MAX_DECLARED_VALUE_BYTES, type Limits } from "./limits";

/** `W(t)` for every fixed-width scalar; text uses its declared width. */
export const SCALAR_WIDTHS = Object.freeze({
  boolean: 5n,
  integer: 26n,
  decimal: 74n,
  date: 12n,
  timestamp: 29n,
  duration: 26n,
});

/** The derived fixed text enum width of `classify_state`, `"current"`/`"stale"`. */
export const CLASSIFY_STATE_WIDTH = 9n;

export const SCALAR_TYPES = [
  "boolean",
  "integer",
  "decimal",
  "text",
  "date",
  "timestamp",
  "duration",
] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];

/** The scalar types admitted by `canonical-input-table-v1` and the field catalog. */
export const INPUT_SCALAR_TYPES = [
  "boolean",
  "integer",
  "decimal",
  "text",
  "date",
  "timestamp",
] as const;

/** Common node fields; op-specific keys are the only other accepted keys. */
export const COMMON_NODE_FIELDS = [
  "node_id",
  "op",
  "output_type",
  "evaluation_rows_from",
] as const;

/** The exhaustive op-specific key registry. */
export const OP_FIELDS = {
  source: ["field_ids"],
  field: ["input", "field_id"],
  literal: ["value"],
  select: ["input", "projections"],
  filter: ["input", "predicate"],
  group: ["input", "key_node_ids"],
  sort: ["input", "keys"],
  top_k: ["input", "k"],
  rank: ["input", "partition_node_ids", "keys"],
  count_rows: ["group_node_id"],
  count_present: ["input", "group_node_id"],
  sum: ["input", "group_node_id"],
  min: ["input", "group_node_id"],
  max: ["input", "group_node_id"],
  mean: ["input", "group_node_id", "scale", "rounding"],
  add: ["left", "right", "scale", "rounding"],
  subtract: ["left", "right", "scale", "rounding"],
  multiply: ["left", "right", "scale", "rounding"],
  divide: ["left", "right", "scale", "rounding"],
  absolute: ["input"],
  clamp: ["input", "minimum", "maximum"],
  round: ["input", "scale", "rounding"],
  equal: ["left", "right"],
  not_equal: ["left", "right"],
  less: ["left", "right"],
  less_equal: ["left", "right"],
  greater: ["left", "right"],
  greater_equal: ["left", "right"],
  and: ["left", "right"],
  or: ["left", "right"],
  not: ["input"],
  if_then_else: ["condition", "when_true", "when_false"],
  coalesce: ["inputs"],
  lag: ["input", "partition_node_ids", "keys", "offset"],
  delta: ["input", "partition_node_ids", "keys", "offset", "scale", "rounding"],
  percentage_change: [
    "input",
    "partition_node_ids",
    "keys",
    "offset",
    "scale",
    "rounding",
  ],
  window_sum: ["input", "partition_node_ids", "keys", "preceding", "following"],
  window_mean: [
    "input",
    "partition_node_ids",
    "keys",
    "preceding",
    "following",
    "scale",
    "rounding",
  ],
  unit_convert: [
    "input",
    "from_unit",
    "to_unit",
    "registry_version",
    "scale",
    "rounding",
  ],
  currency_convert: [
    "input",
    "from_currency",
    "to_currency",
    "fx_evidence_id",
    "rate",
    "scale",
    "rounding",
  ],
  classify_state: ["input", "stale_after_millis", "evaluation_time"],
} as const satisfies Record<string, readonly string[]>;

export type Op = keyof typeof OP_FIELDS;

/** The six rowset operations; every other operation is scalar. */
export const ROWSET_OPS: ReadonlySet<Op> = new Set<Op>([
  "source",
  "select",
  "filter",
  "group",
  "sort",
  "top_k",
]);

/**
 * Exact membership in the closed operation registry.
 *
 * `Object.hasOwn`, never `in`: `OP_FIELDS` is an object literal, so `in` would
 * also admit the eight inherited `Object.prototype` members — `toString`,
 * `valueOf`, `constructor`, `__proto__`, `hasOwnProperty`, `isPrototypeOf`,
 * `propertyIsEnumerable`, and `toLocaleString` — and each would pass this guard
 * and then reach the key registry with a non-array value.
 */
export function isOp(value: unknown): value is Op {
  return typeof value === "string" && Object.hasOwn(OP_FIELDS, value);
}

/** Aggregates whose evaluation domain is a group node. */
export const GROUPED_AGGREGATE_OPS: ReadonlySet<Op> = new Set<Op>([
  "count_rows",
  "count_present",
  "sum",
  "min",
  "max",
  "mean",
]);

function ceilLog2(value: bigint): bigint {
  let bound = 1n;
  let exponent = 0n;
  while (bound < value) {
    bound *= 2n;
    exponent += 1n;
  }
  return exponent;
}

/** `L(n) = n * ceil(log2(max(1, n)))`. */
export function stepsL(rows: bigint): bigint {
  const bounded = rows < 1n ? 1n : rows;
  return rows * ceilLog2(bounded);
}

export interface StepCounts {
  /** Evaluation-domain rows; an aggregate uses its group's total membership. */
  readonly n: bigint;
  /** Actual emitted groups. */
  readonly g: bigint;
  /** `key_node_ids.length` of a group node. */
  readonly gk: bigint;
  /** `keys.length` of a sort or rank node. */
  readonly sk: bigint;
  /** `partition_node_ids.length` of a rank node. */
  readonly pk: bigint;
  /** Top-count literal; never used by the top-k step formula. */
  readonly q: bigint;
  /** AST-derived inherited total-sort certificate key count. */
  readonly s: bigint;
  /** Coalesce argument count. */
  readonly a: bigint;
  /** Projection count. */
  readonly p: bigint;
  /** Declared inclusive window width `1 + preceding + following`. */
  readonly w: bigint;
}

/** The exhaustive per-node primitive-step mapping; each op appears exactly once. */
export function primitiveStepCharge(op: Op, counts: StepCounts): bigint {
  const { n } = counts;
  switch (op) {
    case "source":
    case "field":
    case "literal":
    case "filter":
    case "count_rows":
    case "count_present":
    case "sum":
    case "min":
    case "max":
    case "mean":
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "absolute":
    case "clamp":
    case "round":
    case "equal":
    case "not_equal":
    case "less":
    case "less_equal":
    case "greater":
    case "greater_equal":
    case "and":
    case "or":
    case "not":
    case "classify_state":
    case "lag":
    case "delta":
    case "percentage_change":
      return n;
    case "select":
      return n * counts.p;
    case "group":
      return n * counts.gk + counts.g;
    case "sort":
      return stepsL(n) + n * counts.sk;
    case "top_k":
      return stepsL(n) + n * counts.s;
    case "rank":
      return stepsL(n) + n * (counts.pk + counts.sk) + n;
    case "unit_convert":
    case "currency_convert":
    case "if_then_else":
      return 2n * n;
    case "coalesce":
      return n * counts.a;
    case "window_sum":
    case "window_mean":
      return n * counts.w;
  }
}
