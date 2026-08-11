import { describe, expect, it } from "vitest";

import {
  decimalToRational,
  integerToRational,
  quantize,
  ratMultiply,
  rational,
} from "./decimal";
import {
  CURRENCY_REGISTRY,
  FX_MAX_AGE_MILLIS,
  LIMITS,
  OP_FIELDS,
  ROWSET_OPS,
  SCALAR_WIDTHS,
  UNIT_REGISTRY,
  UNIT_REGISTRY_VERSION,
  convertCurrencyValue,
  convertUnitValue,
  lookupCurrency,
  lookupUnit,
  primitiveStepCharge,
  stepsL,
} from "./registry";

const UNIT_LITERALS = [
  "1",
  "%",
  "m",
  "cm",
  "mm",
  "km",
  "[in_i]",
  "[ft_i]",
  "s",
  "min",
  "h",
  "d",
  "m3",
  "L",
  "[ft_i]3",
  "[gal_us]",
  "m3/s",
  "m3/h",
  "L/s",
  "L/min",
  "[ft_i]3/s",
  "[gal_us]/min",
  "K",
  "Cel",
  "[degF]",
  "[degR]",
];

describe("frozen ucum-subset-v1", () => {
  it("is the pinned registry version", () => {
    expect(UNIT_REGISTRY_VERSION).toBe("ucum-subset-v1");
  });

  it("accepts exactly the 26 table literals once in the displayed order", () => {
    expect(UNIT_REGISTRY.map((entry) => entry.unit)).toEqual(UNIT_LITERALS);
    expect(UNIT_REGISTRY).toHaveLength(26);
    expect(new Set(UNIT_LITERALS).size).toBe(26);
    for (const unit of UNIT_LITERALS) {
      expect(lookupUnit(unit)?.unit).toBe(unit);
    }
  });

  it("stores exact reduced rational multipliers and offsets", () => {
    expect(lookupUnit("%")).toMatchObject({
      dimension: "dimensionless",
      baseUnit: "1",
      multiplier: { n: 1n, d: 100n },
      offset: { n: 0n, d: 1n },
      affine: false,
    });
    expect(lookupUnit("[ft_i]")?.multiplier).toEqual({ n: 381n, d: 1250n });
    expect(lookupUnit("[in_i]")?.multiplier).toEqual({ n: 127n, d: 5000n });
    expect(lookupUnit("[ft_i]3")?.multiplier).toEqual({
      n: 55306341n,
      d: 1953125000n,
    });
    expect(lookupUnit("[gal_us]")?.multiplier).toEqual({
      n: 473176473n,
      d: 125000000000n,
    });
    expect(lookupUnit("[ft_i]3/s")?.multiplier).toEqual({
      n: 55306341n,
      d: 1953125000n,
    });
    expect(lookupUnit("[gal_us]/min")?.multiplier).toEqual({
      n: 157725491n,
      d: 2500000000000n,
    });
    expect(lookupUnit("Cel")?.offset).toEqual({ n: 5463n, d: 20n });
    expect(lookupUnit("[degF]")).toMatchObject({
      multiplier: { n: 5n, d: 9n },
      offset: { n: 45967n, d: 180n },
      affine: true,
    });
    expect(lookupUnit("[degR]")).toMatchObject({
      multiplier: { n: 5n, d: 9n },
      offset: { n: 0n, d: 1n },
      affine: false,
    });
  });

  it("marks Cel and [degF] as the only affine entries", () => {
    expect(
      UNIT_REGISTRY.filter((entry) => entry.affine).map((entry) => entry.unit),
    ).toEqual(["Cel", "[degF]"]);
    expect(
      UNIT_REGISTRY.filter((entry) => entry.offset.n !== 0n).map(
        (entry) => entry.unit,
      ),
    ).toEqual(["Cel", "[degF]"]);
  });

  it("rejects every alias, prefix, symbol, exponent, and whitespace variant", () => {
    for (const unknown of [
      "ft",
      "in",
      "liter",
      "l",
      "sec",
      "hr",
      "day",
      "degC",
      "°C",
      "F",
      "cfs",
      "cms",
      "m^3",
      "m^3/s",
      "[ft_i]^3/s",
      "kg",
      "dm",
      "km3",
      "M",
      "CEL",
      "[FT_I]",
      " m",
      "m ",
      "m/s",
      "",
      "1/1",
      "percent",
      "％",
    ]) {
      expect(lookupUnit(unknown)).toBeNull();
    }
  });

  it("groups the closed dimensions exactly", () => {
    const byDimension = new Map<string, string[]>();
    for (const entry of UNIT_REGISTRY) {
      const list = byDimension.get(entry.dimension) ?? [];
      list.push(entry.unit);
      byDimension.set(entry.dimension, list);
    }
    expect(byDimension.get("dimensionless")).toEqual(["1", "%"]);
    expect(byDimension.get("length")).toEqual([
      "m",
      "cm",
      "mm",
      "km",
      "[in_i]",
      "[ft_i]",
    ]);
    expect(byDimension.get("duration")).toEqual(["s", "min", "h", "d"]);
    expect(byDimension.get("volume")).toEqual([
      "m3",
      "L",
      "[ft_i]3",
      "[gal_us]",
    ]);
    expect(byDimension.get("volumetric_flow")).toEqual([
      "m3/s",
      "m3/h",
      "L/s",
      "L/min",
      "[ft_i]3/s",
      "[gal_us]/min",
    ]);
    expect(byDimension.get("temperature")).toEqual([
      "K",
      "Cel",
      "[degF]",
      "[degR]",
    ]);
  });
});

describe("normative unit-conversion fixtures", () => {
  const cases: ReadonlyArray<
    readonly [
      string,
      ReturnType<typeof integerToRational>,
      string,
      string,
      bigint,
      "none" | "half_even",
      (
        | { ok: true; coefficient: bigint; scale: bigint }
        | { ok: false; code: string }
      ),
    ]
  > = [
    [
      "unit-at-scale-0",
      integerToRational(1n),
      "m",
      "cm",
      0n,
      "none",
      { ok: true, coefficient: 100n, scale: 0n },
    ],
    [
      "unit-at-scale-18",
      integerToRational(1n),
      "%",
      "1",
      18n,
      "none",
      { ok: true, coefficient: 1n, scale: 2n },
    ],
    [
      "unit-at-width-74",
      decimalToRational({
        coefficient: -BigInt("9".repeat(38)),
        scale: 18n,
      }),
      "m",
      "m",
      18n,
      "none",
      { ok: true, coefficient: -BigInt("9".repeat(38)), scale: 18n },
    ],
    [
      "unit-over-coefficient",
      decimalToRational({ coefficient: BigInt("9".repeat(38)), scale: 0n }),
      "km",
      "mm",
      0n,
      "none",
      { ok: false, code: "overflow" },
    ],
    [
      "unit-rational-cfs",
      integerToRational(1n),
      "[ft_i]3/s",
      "m3/s",
      12n,
      "none",
      { ok: true, coefficient: 28316846592n, scale: 12n },
    ],
    [
      "unit-rational-gpm",
      integerToRational(1n),
      "[gal_us]/min",
      "L/s",
      10n,
      "none",
      { ok: true, coefficient: 630901964n, scale: 10n },
    ],
    [
      "unit-affine-celsius",
      integerToRational(0n),
      "Cel",
      "K",
      2n,
      "none",
      { ok: true, coefficient: 27315n, scale: 2n },
    ],
    [
      "unit-affine-freezing",
      integerToRational(32n),
      "[degF]",
      "Cel",
      0n,
      "none",
      { ok: true, coefficient: 0n, scale: 0n },
    ],
    [
      "unit-affine-boiling",
      integerToRational(212n),
      "[degF]",
      "Cel",
      0n,
      "none",
      { ok: true, coefficient: 100n, scale: 0n },
    ],
    [
      "unit-affine-negative",
      integerToRational(-40n),
      "[degF]",
      "Cel",
      0n,
      "none",
      { ok: true, coefficient: -40n, scale: 0n },
    ],
    [
      "unit-affine-rankine",
      decimalToRational({ coefficient: 49167n, scale: 2n }),
      "[degR]",
      "K",
      2n,
      "none",
      { ok: true, coefficient: 27315n, scale: 2n },
    ],
    [
      "unit-half-even-low",
      integerToRational(5n),
      "cm",
      "m",
      1n,
      "half_even",
      { ok: true, coefficient: 0n, scale: 0n },
    ],
    [
      "unit-half-even-high",
      integerToRational(15n),
      "cm",
      "m",
      1n,
      "half_even",
      { ok: true, coefficient: 2n, scale: 1n },
    ],
    [
      "unit-half-even-negative",
      integerToRational(-15n),
      "cm",
      "m",
      1n,
      "half_even",
      { ok: true, coefficient: -2n, scale: 1n },
    ],
    [
      "unit-none-inexact",
      integerToRational(5n),
      "cm",
      "m",
      1n,
      "none",
      { ok: false, code: "invalid_unit_conversion" },
    ],
    [
      "unit-none-nonterminating",
      integerToRational(1n),
      "m",
      "[ft_i]",
      18n,
      "none",
      { ok: false, code: "invalid_unit_conversion" },
    ],
    [
      "unit-incompatible",
      integerToRational(1n),
      "m",
      "s",
      0n,
      "none",
      { ok: false, code: "unit_mismatch" },
    ],
    [
      "unit-unknown-opaque",
      integerToRational(1n),
      "cfs",
      "m3/s",
      12n,
      "none",
      { ok: false, code: "invalid_unit_conversion" },
    ],
  ];

  for (const [name, value, from, to, scale, rounding, expected] of cases) {
    it(`freezes ${name}`, () => {
      const actual = convertUnitValue(value, from, to, scale, rounding);
      if (expected.ok) {
        expect(actual).toEqual({
          ok: true,
          value: { coefficient: expected.coefficient, scale: expected.scale },
        });
      } else {
        expect(actual).toEqual({ ok: false, code: expected.code });
      }
    });
  }

  it("still runs the one final quantization when source equals target", () => {
    expect(
      convertUnitValue(
        decimalToRational({ coefficient: 15n, scale: 1n }),
        "m",
        "m",
        0n,
        "half_even",
      ),
    ).toEqual({ ok: true, value: { coefficient: 2n, scale: 0n } });
  });

  it("rejects an unknown target as well as an unknown source", () => {
    expect(
      convertUnitValue(integerToRational(1n), "m", "ft", 0n, "none"),
    ).toEqual({ ok: false, code: "invalid_unit_conversion" });
  });
});

describe("frozen iso4217-task9-v1", () => {
  it("is exactly four codes with their minor-unit exponents", () => {
    expect([...CURRENCY_REGISTRY.entries()]).toEqual([
      ["USD", 2n],
      ["EUR", 2n],
      ["GBP", 2n],
      ["JPY", 0n],
    ]);
  });

  it("rejects every other code, alias, numeric code, and case variant", () => {
    for (const unknown of [
      "usd",
      "Usd",
      "CHF",
      "840",
      "$",
      "€",
      "BTC",
      "USD ",
      " USD",
      "USDEUR",
      "USD/EUR",
      "",
    ]) {
      expect(lookupCurrency(unknown)).toBeNull();
    }
  });

  it("multiplies once and quantizes at the target exponent with half-even", () => {
    expect(
      convertCurrencyValue(
        integerToRational(100n),
        decimalToRational({ coefficient: 925n, scale: 3n }),
        2n,
      ),
    ).toEqual({ ok: true, value: { coefficient: 925n, scale: 1n } });
    expect(
      convertCurrencyValue(
        integerToRational(1n),
        decimalToRational({ coefficient: 15n, scale: 1n }),
        0n,
      ),
    ).toEqual({ ok: true, value: { coefficient: 2n, scale: 0n } });
    expect(
      convertCurrencyValue(
        integerToRational(-1n),
        decimalToRational({ coefficient: 15n, scale: 1n }),
        0n,
      ),
    ).toEqual({ ok: true, value: { coefficient: -2n, scale: 0n } });
  });

  it("reports overflow past 38 final coefficient digits", () => {
    const c38 = BigInt("9".repeat(38));
    expect(
      convertCurrencyValue(
        decimalToRational({ coefficient: c38, scale: 0n }),
        integerToRational(1n),
        0n,
      ),
    ).toEqual({ ok: true, value: { coefficient: c38, scale: 0n } });
    expect(
      convertCurrencyValue(
        decimalToRational({ coefficient: c38, scale: 0n }),
        integerToRational(10n),
        0n,
      ),
    ).toEqual({ ok: false, code: "overflow" });
  });

  it("uses the fixed inclusive FX age", () => {
    expect(FX_MAX_AGE_MILLIS).toBe(86400000n);
  });

  it("matches an independent rational multiply-then-quantize", () => {
    const expected = quantize(
      ratMultiply(integerToRational(100n), rational(925n, 1000n)),
      2n,
      "half_even",
    );
    expect(
      convertCurrencyValue(integerToRational(100n), rational(925n, 1000n), 2n),
    ).toEqual(expected);
  });
});

describe("calculation-limits-v1", () => {
  it("freezes every inclusive ceiling in one object", () => {
    expect(LIMITS).toEqual({
      canonicalInputBytes: 1048576n,
      rawGraphBytes: 131072n,
      astBytes: 65536n,
      nodeCount: 128n,
      maxDepth: 32n,
      literalBytes: 4096n,
      totalLiteralBytes: 32768n,
      literalListLength: 256n,
      topK: 1000n,
      windowFrame: 10000n,
      coefficientDigits: 38n,
      scale: 18n,
      scannedRows: 10000n,
      groups: 1000n,
      rowsInGroup: 10000n,
      cumulativeIntermediateRows: 50000n,
      finalOutputRows: 2000n,
      cumulativeIntermediateBytes: 8388608n,
      outputBytes: 1048576n,
      primitiveSteps: 1000000n,
      logicalAllocationBytes: 33554432n,
    });
  });
});

describe("W(t) canonical widths", () => {
  it("freezes each fixed scalar width", () => {
    expect(SCALAR_WIDTHS).toEqual({
      boolean: 5n,
      integer: 26n,
      decimal: 74n,
      date: 12n,
      timestamp: 29n,
      duration: 26n,
    });
  });
});

describe("primitive step charges", () => {
  it("computes the exact L(n) merge-sort term", () => {
    expect(stepsL(0n)).toBe(0n);
    expect(stepsL(1n)).toBe(0n);
    expect(stepsL(2n)).toBe(2n);
    expect(stepsL(3n)).toBe(6n);
    expect(stepsL(4n)).toBe(8n);
    expect(stepsL(10000n)).toBe(140000n);
  });

  it("charges every operation exactly once from the exhaustive mapping", () => {
    const counts = {
      n: 10n,
      g: 3n,
      gk: 2n,
      sk: 4n,
      pk: 1n,
      q: 5n,
      s: 4n,
      a: 3n,
      p: 6n,
      w: 7n,
    };
    expect(primitiveStepCharge("source", counts)).toBe(10n);
    expect(primitiveStepCharge("field", counts)).toBe(10n);
    expect(primitiveStepCharge("literal", counts)).toBe(10n);
    expect(primitiveStepCharge("select", counts)).toBe(60n);
    expect(primitiveStepCharge("filter", counts)).toBe(10n);
    expect(primitiveStepCharge("group", counts)).toBe(23n);
    expect(primitiveStepCharge("sort", counts)).toBe(stepsL(10n) + 40n);
    expect(primitiveStepCharge("top_k", counts)).toBe(stepsL(10n) + 40n);
    expect(primitiveStepCharge("rank", counts)).toBe(stepsL(10n) + 50n + 10n);
    for (const op of [
      "count_rows",
      "count_present",
      "sum",
      "min",
      "max",
      "mean",
      "add",
      "subtract",
      "multiply",
      "divide",
      "absolute",
      "clamp",
      "round",
      "equal",
      "not_equal",
      "less",
      "less_equal",
      "greater",
      "greater_equal",
      "and",
      "or",
      "not",
      "classify_state",
      "lag",
      "delta",
      "percentage_change",
    ] as const) {
      expect(primitiveStepCharge(op, counts)).toBe(10n);
    }
    expect(primitiveStepCharge("unit_convert", counts)).toBe(20n);
    expect(primitiveStepCharge("currency_convert", counts)).toBe(20n);
    expect(primitiveStepCharge("coalesce", counts)).toBe(30n);
    expect(primitiveStepCharge("if_then_else", counts)).toBe(20n);
    expect(primitiveStepCharge("window_sum", counts)).toBe(70n);
    expect(primitiveStepCharge("window_mean", counts)).toBe(70n);
  });

  it("never uses the top count q in the top-k step formula", () => {
    const base = {
      n: 10n,
      g: 1n,
      gk: 0n,
      sk: 0n,
      pk: 0n,
      s: 3n,
      a: 1n,
      p: 1n,
      w: 1n,
    };
    expect(primitiveStepCharge("top_k", { ...base, q: 1n })).toBe(
      primitiveStepCharge("top_k", { ...base, q: 1000n }),
    );
  });
});

describe("closed operation key registry", () => {
  it("names every registry operation exactly once", () => {
    expect(Object.keys(OP_FIELDS)).toHaveLength(41);
    expect(new Set(Object.keys(OP_FIELDS)).size).toBe(41);
  });

  it("has no unknown alias operation name", () => {
    for (const alias of [
      "project",
      "projection",
      "map",
      "percent_change",
      "aggregate",
      "window",
      "classify",
      "formula",
      "join",
      "count_distinct",
      "median",
      "ratio",
    ]) {
      expect(Object.keys(OP_FIELDS)).not.toContain(alias);
    }
  });

  it("lists exactly the six rowset operations", () => {
    expect([...ROWSET_OPS]).toEqual([
      "source",
      "select",
      "filter",
      "group",
      "sort",
      "top_k",
    ]);
  });

  it("freezes the op-specific field lists", () => {
    expect(OP_FIELDS.source).toEqual(["field_ids"]);
    expect(OP_FIELDS.select).toEqual(["input", "projections"]);
    expect(OP_FIELDS.top_k).toEqual(["input", "k"]);
    expect(OP_FIELDS.mean).toEqual([
      "input",
      "group_node_id",
      "scale",
      "rounding",
    ]);
    expect(OP_FIELDS.window_mean).toEqual([
      "input",
      "partition_node_ids",
      "keys",
      "preceding",
      "following",
      "scale",
      "rounding",
    ]);
    expect(OP_FIELDS.unit_convert).toEqual([
      "input",
      "from_unit",
      "to_unit",
      "registry_version",
      "scale",
      "rounding",
    ]);
    expect(OP_FIELDS.currency_convert).toEqual([
      "input",
      "from_currency",
      "to_currency",
      "fx_evidence_id",
      "rate",
      "scale",
      "rounding",
    ]);
    expect(OP_FIELDS.classify_state).toEqual([
      "input",
      "stale_after_millis",
      "evaluation_time",
    ]);
  });
});
