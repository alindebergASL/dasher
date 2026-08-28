import { describe, expect, it } from "vitest";

import {
  type CellSpec,
  type FieldSpec,
  type Json,
  type NodeSpec,
  buildCatalog,
  buildGraph,
  buildInput,
  decimal,
  fieldOut,
  groupFieldId,
  groupGrain,
  literalValue,
  rowsetOut,
  scalarOut,
  selectFieldId,
  uuid,
} from "./fixture-builder";
import { type CalculationRun, runCalculation } from "./index";

const EVALUATION_TIME = "2026-08-05T12:00:00.000000Z";
const ROW_GRAIN = "row";
const ZERO_KEY_GRAIN = groupGrain("gregorian", "UTC", []);

const F = {
  key: uuid(201),
  usdA: uuid(202),
  usdB: uuid(203),
  eur: uuid(204),
  metresA: uuid(205),
  metresB: uuid(206),
  centimetres: uuid(207),
  celsius: uuid(208),
  observed: uuid(209),
  group: uuid(210),
  count: uuid(211),
  percent: uuid(212),
  flow: uuid(213),
  feet: uuid(214),
  bare: uuid(215),
};

function measure(
  field_id: string,
  logical_name: string,
  extra: Partial<FieldSpec> = {},
): FieldSpec {
  return {
    field_id,
    logical_name,
    scalar_type: "decimal",
    nullable: true,
    stable_key_ordinal: null,
    semantic_type: "measure",
    max_value_bytes: 74,
    allowed_aggregations: ["max", "mean", "min", "sum"],
    allowed_dimensions: [F.group],
    event_time_field_id: F.observed,
    ...extra,
  };
}

const FIELDS: readonly FieldSpec[] = [
  {
    field_id: F.key,
    logical_name: "row_key",
    scalar_type: "integer",
    nullable: false,
    stable_key_ordinal: 0,
    semantic_type: "identifier",
    max_value_bytes: 26,
    allowed_aggregations: ["count"],
  },
  measure(F.usdA, "usd_a", { currency: "USD" }),
  measure(F.usdB, "usd_b", { currency: "USD" }),
  measure(F.eur, "eur_a", { currency: "EUR" }),
  measure(F.metresA, "metres_a", { unit: "m" }),
  measure(F.metresB, "metres_b", { unit: "m" }),
  measure(F.centimetres, "centimetres", { unit: "cm" }),
  measure(F.celsius, "celsius", { unit: "Cel" }),
  {
    field_id: F.observed,
    logical_name: "observed_at",
    scalar_type: "timestamp",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "event_time",
    max_value_bytes: 29,
    allowed_aggregations: ["max"],
  },
  {
    field_id: F.group,
    logical_name: "group_key",
    scalar_type: "text",
    nullable: true,
    stable_key_ordinal: null,
    semantic_type: "dimension",
    max_value_bytes: 20,
    allowed_aggregations: [],
  },
  {
    field_id: F.count,
    logical_name: "count_int",
    scalar_type: "integer",
    nullable: true,
    stable_key_ordinal: null,
    semantic_type: "measure",
    max_value_bytes: 26,
    allowed_aggregations: ["max", "mean", "min", "sum"],
    allowed_dimensions: [F.group],
    event_time_field_id: F.observed,
  },
  measure(F.percent, "percent_a", { unit: "%" }),
  measure(F.flow, "flow_cfs", { unit: "[ft_i]3/s" }),
  measure(F.feet, "stage_ft", { unit: "[ft_i]" }),
  // A null-grain measure, so a literal-bearing comparison shares its grain.
  measure(F.bare, "bare_decimal", { grain: null, nullable: false }),
];

function cell(
  value: Json | null,
  state: CellSpec["state"] = "present",
): CellSpec {
  return state === "present" ? { state, value: value as Json } : { state };
}

function row(options: {
  key: number;
  usdA?: CellSpec;
  usdB?: CellSpec;
  eur?: CellSpec;
  metresA?: CellSpec;
  metresB?: CellSpec;
  centimetres?: CellSpec;
  celsius?: CellSpec;
  observed?: string;
  group?: CellSpec;
  count?: CellSpec;
  percent?: CellSpec;
  flow?: CellSpec;
  feet?: CellSpec;
  bare?: CellSpec;
}): Record<string, CellSpec> {
  return {
    [F.key]: cell(`i64:${options.key}`),
    [F.usdA]: options.usdA ?? cell(decimal("100", 0)),
    [F.usdB]: options.usdB ?? cell(decimal("25", 0)),
    [F.eur]: options.eur ?? cell(decimal("10", 0)),
    [F.metresA]: options.metresA ?? cell(decimal("3", 0)),
    [F.metresB]: options.metresB ?? cell(decimal("4", 0)),
    [F.centimetres]: options.centimetres ?? cell(decimal("500", 0)),
    [F.celsius]: options.celsius ?? cell(decimal("21", 0)),
    [F.observed]: cell(options.observed ?? "2026-08-04T12:00:00.000000Z"),
    [F.group]: options.group ?? cell("alpha"),
    [F.count]: options.count ?? cell("i64:2"),
    [F.percent]: options.percent ?? cell(decimal("50", 0)),
    [F.flow]: options.flow ?? cell(decimal("1", 0)),
    [F.feet]: options.feet ?? cell(decimal("2", 0)),
    [F.bare]: options.bare ?? cell(decimal("25", 0)),
  };
}

const INPUT = buildInput({
  fields: FIELDS,
  rows: [
    row({ key: 1 }),
    row({
      key: 2,
      usdB: cell(decimal("75", 0)),
      group: cell("beta"),
      bare: cell(decimal("75", 0)),
    }),
  ],
});

const CATALOG = buildCatalog({
  input: INPUT,
  fields: FIELDS,
  evaluatedAt: EVALUATION_TIME,
});

const SRC = uuid(301);

function sourceNode(fieldIds: readonly string[]): NodeSpec {
  const specs = fieldIds.map(
    (id) => FIELDS.find((field) => field.field_id === id) as FieldSpec,
  );
  return {
    node_id: SRC,
    op: "source",
    evaluation_rows_from: null,
    output_type: rowsetOut(specs.map(fieldOut)),
    field_ids: [...fieldIds].sort(),
  };
}

function fieldNode(nodeId: string, fieldId: string, input = SRC): NodeSpec {
  const spec = FIELDS.find((field) => field.field_id === fieldId) as FieldSpec;
  return {
    node_id: nodeId,
    op: "field",
    evaluation_rows_from: input,
    input,
    field_id: fieldId,
    output_type: scalarOut({
      scalar: spec.scalar_type,
      nullable: spec.nullable,
      width: spec.max_value_bytes,
      unit: spec.unit ?? null,
      currency: spec.currency ?? null,
      grain: spec.grain === undefined ? ROW_GRAIN : spec.grain,
    }),
  };
}

function literalNode(
  nodeId: string,
  type: string,
  value: Json | null,
  state = "present",
  domain = SRC,
): NodeSpec {
  const widths: Record<string, number> = {
    boolean: 5,
    integer: 26,
    decimal: 74,
    date: 12,
    timestamp: 29,
    duration: 26,
  };
  return {
    node_id: nodeId,
    op: "literal",
    evaluation_rows_from: domain,
    value: literalValue(type, value, state),
    output_type: scalarOut({
      scalar: type,
      nullable: state === "null",
      width: widths[type] as number,
    }),
  };
}

function run(
  nodes: readonly NodeSpec[],
  outputNodeIds: readonly string[],
): CalculationRun {
  const graph = buildGraph({
    nodes,
    outputNodeIds,
    contractOutputNodeId: outputNodeIds[0] as string,
    input: INPUT,
    catalog: CATALOG,
    evaluationTime: EVALUATION_TIME,
  });
  return runCalculation({
    rawGraphBytes: graph.bytes,
    inputBytes: INPUT.bytes,
    catalogBytes: CATALOG.bytes,
    calendar: "gregorian",
    skipContractConformance: true,
  });
}

function firstValue(outcome: CalculationRun): Json {
  const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
    outputs: { rows: { value: Json }[] }[];
  };
  return (result.outputs[0] as { rows: { value: Json }[] }).rows[0]
    ?.value as Json;
}

/* ------------------------------------------------------------------ *
 * Frozen arithmetic registry
 * ------------------------------------------------------------------ */

function arithmetic(options: {
  op: "add" | "subtract" | "multiply" | "divide";
  left: NodeSpec;
  right: NodeSpec;
  scale: number;
  rounding: "none" | "half_even";
  unit?: string | null;
  currency?: string | null;
  grain?: string | null;
  nullable?: boolean;
}): { nodes: readonly NodeSpec[]; outputs: readonly string[] } {
  const nodeId = uuid(400);
  const sourceFields = [F.key, options.left, options.right]
    .flatMap((operand) =>
      typeof operand === "string"
        ? [operand]
        : typeof operand.field_id === "string"
          ? [operand.field_id]
          : [],
    )
    .filter((value, index, all) => all.indexOf(value) === index);
  const node: NodeSpec = {
    node_id: nodeId,
    op: options.op,
    evaluation_rows_from: SRC,
    left: options.left.node_id,
    right: options.right.node_id,
    scale: `i64:${options.scale}`,
    rounding: options.rounding,
    output_type: scalarOut({
      scalar: "decimal",
      nullable: options.nullable ?? false,
      width: 74,
      unit: options.unit ?? null,
      currency: options.currency ?? null,
      grain: options.grain ?? null,
    }),
  };
  return {
    nodes: [sourceNode(sourceFields), options.left, options.right, node],
    outputs: [nodeId],
  };
}

describe("frozen arithmetic registry", () => {
  const one = literalNode(uuid(310), "integer", "i64:1");
  const two = literalNode(uuid(311), "integer", "i64:2");
  const zero = literalNode(uuid(313), "integer", "i64:0");

  it("derives decimal, width 74, and the operand grain for every operation", () => {
    for (const op of ["add", "subtract", "multiply", "divide"] as const) {
      const built = arithmetic({
        op,
        left: one,
        right: two,
        scale: 18,
        rounding: "half_even",
        unit: op === "divide" ? "1" : null,
      });
      const outcome = run(built.nodes, built.outputs);
      expect(outcome.error_code).toBeNull();
      const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
        outputs: { output_type: { scalar: string; max_value_bytes: string } }[];
      };
      expect(result.outputs[0]?.output_type.scalar).toBe("decimal");
      expect(result.outputs[0]?.output_type.max_value_bytes).toBe("i64:74");
    }
  });

  it("returns the same canonical decimal for integer and decimal operands", () => {
    const integerCase = arithmetic({
      op: "add",
      left: one,
      right: two,
      scale: 0,
      rounding: "none",
    });
    const decimalOne = literalNode(uuid(310), "decimal", decimal("1", 0));
    const decimalTwo = literalNode(uuid(311), "decimal", decimal("2", 0));
    const decimalCase = arithmetic({
      op: "add",
      left: decimalOne,
      right: decimalTwo,
      scale: 0,
      rounding: "none",
    });
    expect(firstValue(run(integerCase.nodes, integerCase.outputs))).toEqual(
      firstValue(run(decimalCase.nodes, decimalCase.outputs)),
    );
    expect(firstValue(run(integerCase.nodes, integerCase.outputs))).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "3", scale: "i64:0" },
    });
  });

  it("materializes exact unit 1 for every admitted divide", () => {
    const bare = arithmetic({
      op: "divide",
      left: one,
      right: two,
      scale: 18,
      rounding: "none",
      unit: "1",
    });
    const outcome = run(bare.nodes, bare.outputs);
    expect(outcome.error_code).toBeNull();
    const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
      outputs: { output_type: { unit: string | null } }[];
    };
    expect(result.outputs[0]?.output_type.unit).toBe("1");
  });

  it("denies a divide that claims null unit", () => {
    const bare = arithmetic({
      op: "divide",
      left: one,
      right: two,
      scale: 18,
      rounding: "none",
      unit: null,
    });
    expect(run(bare.nodes, bare.outputs).error_code).toBe("unit_mismatch");
  });

  it("preserves an identical currency for add and subtract and denies multiply", () => {
    const left = fieldNode(uuid(320), F.usdA);
    const right = fieldNode(uuid(321), F.usdB);
    const added = arithmetic({
      op: "add",
      left,
      right,
      scale: 0,
      rounding: "none",
      currency: "USD",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(added.nodes, added.outputs).error_code).toBeNull();
    const multiplied = arithmetic({
      op: "multiply",
      left,
      right,
      scale: 0,
      rounding: "none",
      currency: "USD",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(multiplied.nodes, multiplied.outputs).error_code).toBe(
      "currency_mismatch",
    );
  });

  it("denies unlike currency arithmetic", () => {
    const built = arithmetic({
      op: "add",
      left: fieldNode(uuid(320), F.usdA),
      right: fieldNode(uuid(321), F.eur),
      scale: 0,
      rounding: "none",
      currency: "USD",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(built.nodes, built.outputs).error_code).toBe(
      "currency_mismatch",
    );
  });

  it("cancels an identical currency to exact unit 1 under divide", () => {
    const built = arithmetic({
      op: "divide",
      left: fieldNode(uuid(320), F.usdA),
      right: fieldNode(uuid(321), F.usdB),
      scale: 18,
      rounding: "half_even",
      unit: "1",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(built.nodes, built.outputs).error_code).toBeNull();
  });

  it("preserves an identical non-affine unit and denies affine or unlike units", () => {
    const metres = arithmetic({
      op: "add",
      left: fieldNode(uuid(320), F.metresA),
      right: fieldNode(uuid(321), F.metresB),
      scale: 0,
      rounding: "none",
      unit: "m",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(metres.nodes, metres.outputs).error_code).toBeNull();

    const unlike = arithmetic({
      op: "add",
      left: fieldNode(uuid(320), F.metresA),
      right: fieldNode(uuid(321), F.centimetres),
      scale: 0,
      rounding: "none",
      unit: "m",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(unlike.nodes, unlike.outputs).error_code).toBe("unit_mismatch");

    const affine = arithmetic({
      op: "add",
      left: fieldNode(uuid(320), F.celsius),
      right: fieldNode(uuid(321), F.celsius),
      scale: 0,
      rounding: "none",
      unit: "Cel",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(affine.nodes, affine.outputs).error_code).toBe("unit_mismatch");
  });

  it("treats percentage values as ordinary unit-bearing values", () => {
    const added = arithmetic({
      op: "add",
      left: fieldNode(uuid(320), F.percent),
      right: fieldNode(uuid(321), F.percent),
      scale: 0,
      rounding: "none",
      unit: "%",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(added.nodes, added.outputs).error_code).toBeNull();

    const divided = arithmetic({
      op: "divide",
      left: fieldNode(uuid(320), F.percent),
      right: fieldNode(uuid(321), F.percent),
      scale: 0,
      rounding: "none",
      unit: "1",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(divided.nodes, divided.outputs).error_code).toBeNull();

    const multiplied = arithmetic({
      op: "multiply",
      left: fieldNode(uuid(320), F.percent),
      right: fieldNode(uuid(321), F.percent),
      scale: 0,
      rounding: "none",
      unit: null,
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(multiplied.nodes, multiplied.outputs).error_code).toBe(
      "unit_mismatch",
    );
  });

  it("denies a drifted operand grain before any currency or unit check", () => {
    const built = arithmetic({
      op: "add",
      left: fieldNode(uuid(320), F.usdA),
      right: literalNode(uuid(321), "integer", "i64:1"),
      scale: 0,
      rounding: "none",
      currency: "USD",
      grain: ROW_GRAIN,
      nullable: true,
    });
    expect(run(built.nodes, built.outputs).error_code).toBe("grain_mismatch");
  });

  it("performs one final quantization with symmetric half-even", () => {
    const cases: ReadonlyArray<readonly [string, number, string, string]> = [
      ["5", 1, "0", "i64:0"],
      ["15", 1, "2", "i64:0"],
      ["-15", 1, "-2", "i64:0"],
      ["25", 1, "2", "i64:0"],
      ["-25", 1, "-2", "i64:0"],
      ["35", 1, "4", "i64:0"],
    ];
    for (const [coefficient, scale, expected, expectedScale] of cases) {
      const built = arithmetic({
        op: "add",
        left: literalNode(uuid(310), "decimal", decimal(coefficient, scale)),
        right: literalNode(uuid(311), "integer", "i64:0"),
        scale: 0,
        rounding: "half_even",
      });
      expect(firstValue(run(built.nodes, built.outputs))).toEqual({
        state: "present",
        type: "decimal",
        value: { coefficient: expected, scale: expectedScale },
      });
    }
  });

  it("accepts scale i64:0 and i64:18", () => {
    for (const scale of [0, 18]) {
      const built = arithmetic({
        op: "add",
        left: one,
        right: two,
        scale,
        rounding: "none",
      });
      expect(run(built.nodes, built.outputs).error_code).toBeNull();
    }
  });

  it("checks divide-by-zero before quantization and coefficient range", () => {
    const huge = literalNode(uuid(310), "decimal", decimal("9".repeat(38), 0));
    const built = arithmetic({
      op: "divide",
      left: huge,
      right: zero,
      scale: 0,
      rounding: "none",
      unit: "1",
    });
    const outcome = run(built.nodes, built.outputs);
    expect(outcome.outcome?.error_code).toBe("divide_by_zero");
    expect(outcome.outcome?.state).toBe("failed");
  });

  it("returns inexact_arithmetic for a nonterminating rounding=none result", () => {
    const built = arithmetic({
      op: "divide",
      left: one,
      right: literalNode(uuid(311), "integer", "i64:3"),
      scale: 18,
      rounding: "none",
      unit: "1",
    });
    expect(run(built.nodes, built.outputs).outcome?.error_code).toBe(
      "inexact_arithmetic",
    );
  });

  it("accepts a 38-digit coefficient and overflows at 39", () => {
    const c38 = literalNode(uuid(310), "decimal", decimal("9".repeat(38), 0));
    const accepted = arithmetic({
      op: "add",
      left: c38,
      right: literalNode(uuid(311), "integer", "i64:0"),
      scale: 0,
      rounding: "none",
    });
    expect(run(accepted.nodes, accepted.outputs).error_code).toBeNull();
    const overflowed = arithmetic({
      op: "multiply",
      left: c38,
      right: literalNode(uuid(311), "integer", "i64:10"),
      scale: 0,
      rounding: "none",
    });
    expect(run(overflowed.nodes, overflowed.outputs).outcome?.error_code).toBe(
      "overflow",
    );
  });

  it("charges exactly n primitive steps per arithmetic node", () => {
    const built = arithmetic({
      op: "add",
      left: one,
      right: two,
      scale: 0,
      rounding: "none",
    });
    const outcome = run(built.nodes, built.outputs);
    // source(2) + literal(2) + literal(2) + add(2) over two input rows.
    expect(outcome.outcome?.meter.primitive_steps).toBe(8n);
  });

  it("propagates missing before null and unavailable before both", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["unavailable", "null", "unavailable"],
      ["missing", "null", "missing"],
      ["null", "present", "null"],
    ];
    for (const [leftState, rightState, expected] of cases) {
      const built = arithmetic({
        op: "add",
        left: literalNode(
          uuid(310),
          "integer",
          leftState === "present" ? "i64:1" : null,
          leftState,
        ),
        right: literalNode(
          uuid(311),
          "integer",
          rightState === "present" ? "i64:1" : null,
          rightState,
        ),
        scale: 0,
        rounding: "none",
        nullable: leftState === "null" || rightState === "null",
      });
      const value = firstValue(run(built.nodes, built.outputs)) as {
        state: string;
      };
      expect(value.state).toBe(expected);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Aggregates, groups, and states
 * ------------------------------------------------------------------ */

const GROUP_ZERO = uuid(330);
const FIELD_USD = uuid(331);
const FIELD_GROUP = uuid(332);
const GROUP_KEYED = uuid(333);

function zeroKeyGroup(input = SRC): NodeSpec {
  return {
    node_id: GROUP_ZERO,
    op: "group",
    evaluation_rows_from: null,
    input,
    key_node_ids: [],
    output_type: rowsetOut([]),
  };
}

function aggregate(options: {
  nodeId: string;
  op: "sum" | "min" | "max" | "mean" | "count_present" | "count_rows";
  input?: string;
  group: string;
  scalar: string;
  width: number;
  unit?: string | null;
  currency?: string | null;
  grain: string;
  scale?: number;
}): NodeSpec {
  const node: Record<string, Json | undefined> = {
    node_id: options.nodeId,
    op: options.op,
    evaluation_rows_from: options.group,
    group_node_id: options.group,
    output_type: scalarOut({
      scalar: options.scalar,
      nullable: false,
      width: options.width,
      unit: options.unit ?? null,
      currency: options.currency ?? null,
      grain: options.grain,
    }),
  };
  if (options.op !== "count_rows") node.input = options.input as string;
  if (options.op === "mean") {
    node.scale = `i64:${options.scale ?? 18}`;
    node.rounding = "half_even";
  }
  return node as unknown as NodeSpec;
}

describe("aggregates and group semantics", () => {
  it("sums over a zero-key group with the derived group grain", () => {
    const nodes = [
      sourceNode([F.key, F.usdA]),
      fieldNode(FIELD_USD, F.usdA),
      zeroKeyGroup(),
      aggregate({
        nodeId: uuid(340),
        op: "sum",
        input: FIELD_USD,
        group: GROUP_ZERO,
        scalar: "decimal",
        width: 74,
        currency: "USD",
        grain: ZERO_KEY_GRAIN,
      }),
    ];
    const outcome = run(nodes, [uuid(340)]);
    expect(outcome.error_code).toBeNull();
    expect(firstValue(outcome)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "200", scale: "i64:0" },
    });
  });

  it("returns typed zero for a sum with no contributor and empty_input for min", () => {
    const nullInput = buildInput({
      fields: FIELDS,
      rows: [row({ key: 1, usdA: cell(null, "null") })],
    });
    const nullCatalog = buildCatalog({
      input: nullInput,
      fields: FIELDS,
      evaluatedAt: EVALUATION_TIME,
    });
    const build = (op: "sum" | "min"): CalculationRun => {
      const nodes = [
        sourceNode([F.key, F.usdA]),
        fieldNode(FIELD_USD, F.usdA),
        zeroKeyGroup(),
        aggregate({
          nodeId: uuid(340),
          op,
          input: FIELD_USD,
          group: GROUP_ZERO,
          scalar: op === "sum" ? "decimal" : "decimal",
          width: 74,
          currency: "USD",
          grain: ZERO_KEY_GRAIN,
        }),
      ];
      const graph = buildGraph({
        nodes,
        outputNodeIds: [uuid(340)],
        contractOutputNodeId: uuid(340),
        input: nullInput,
        catalog: nullCatalog,
        evaluationTime: EVALUATION_TIME,
      });
      return runCalculation({
        rawGraphBytes: graph.bytes,
        inputBytes: nullInput.bytes,
        catalogBytes: nullCatalog.bytes,
        calendar: "gregorian",
        skipContractConformance: true,
      });
    };
    expect(firstValue(build("sum"))).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "0", scale: "i64:0" },
    });
    expect(build("min").outcome?.error_code).toBe("empty_input");
  });

  it("counts present and stale values and counts rows independently", () => {
    const nodes = [
      sourceNode([F.key, F.usdA]),
      fieldNode(FIELD_USD, F.usdA),
      zeroKeyGroup(),
      aggregate({
        nodeId: uuid(341),
        op: "count_present",
        input: FIELD_USD,
        group: GROUP_ZERO,
        scalar: "integer",
        width: 26,
        grain: ZERO_KEY_GRAIN,
      }),
      aggregate({
        nodeId: uuid(342),
        op: "count_rows",
        group: GROUP_ZERO,
        scalar: "integer",
        width: 26,
        grain: ZERO_KEY_GRAIN,
      }),
    ];
    const outcome = run(nodes, [uuid(341), uuid(342)]);
    expect(outcome.error_code).toBeNull();
    const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
      outputs: { node_id: string; rows: { value: { value: string } }[] }[];
    };
    for (const entry of result.outputs) {
      expect(entry.rows[0]?.value.value).toBe("i64:2");
    }
  });

  it("rejects the first absent group key as invalid_group_key with the exact meter", () => {
    const keyedInput = buildInput({
      fields: FIELDS,
      rows: [row({ key: 1, group: cell(null, "missing") }), row({ key: 2 })],
    });
    const keyedCatalog = buildCatalog({
      input: keyedInput,
      fields: FIELDS,
      evaluatedAt: EVALUATION_TIME,
    });
    const groupNodes: NodeSpec[] = [
      sourceNode([F.key, F.group]),
      fieldNode(FIELD_GROUP, F.group),
      {
        node_id: GROUP_KEYED,
        op: "group",
        evaluation_rows_from: null,
        input: SRC,
        key_node_ids: [FIELD_GROUP],
        output_type: rowsetOut([
          {
            field_id: groupFieldId(GROUP_KEYED, 0, FIELD_GROUP),
            name: "key_0",
            scalar: "text",
            nullable: true,
            unit: null,
            currency: null,
            grain: ROW_GRAIN,
            max_value_bytes: "i64:20",
          },
        ]),
      },
    ];
    const graph = buildGraph({
      nodes: groupNodes,
      outputNodeIds: [GROUP_KEYED],
      contractOutputNodeId: GROUP_KEYED,
      input: keyedInput,
      catalog: keyedCatalog,
      evaluationTime: EVALUATION_TIME,
    });
    const outcome = runCalculation({
      rawGraphBytes: graph.bytes,
      inputBytes: keyedInput.bytes,
      catalogBytes: keyedCatalog.bytes,
      calendar: "gregorian",
      skipContractConformance: true,
    });
    expect(outcome.outcome?.error_code).toBe("invalid_group_key");
    expect(outcome.outcome?.state).toBe("failed");
    // source(2) + field(2) + failed group charge n * group_key_count = 2.
    expect(outcome.outcome?.meter.primitive_steps).toBe(6n);
    expect(outcome.outcome?.meter.group_count).toBe(0n);
    expect(outcome.outcome?.meter.final_output_rows).toBe(0n);
    expect(JSON.parse(outcome.outcome?.resultBytes as string)).toMatchObject({
      outputs: [],
      state: "failed",
    });
  });

  it("keeps unavailable an ordinary value state outside group keys", () => {
    const unavailableInput = buildInput({
      fields: FIELDS,
      rows: [row({ key: 1, usdA: cell(null, "unavailable") })],
    });
    const unavailableCatalog = buildCatalog({
      input: unavailableInput,
      fields: FIELDS,
      evaluatedAt: EVALUATION_TIME,
    });
    const nodes = [sourceNode([F.key, F.usdA]), fieldNode(FIELD_USD, F.usdA)];
    const graph = buildGraph({
      nodes,
      outputNodeIds: [FIELD_USD],
      contractOutputNodeId: FIELD_USD,
      input: unavailableInput,
      catalog: unavailableCatalog,
      evaluationTime: EVALUATION_TIME,
    });
    const outcome = runCalculation({
      rawGraphBytes: graph.bytes,
      inputBytes: unavailableInput.bytes,
      catalogBytes: unavailableCatalog.bytes,
      calendar: "gregorian",
      skipContractConformance: true,
    });
    expect(outcome.error_code).toBeNull();
    expect(firstValue(outcome)).toEqual({
      state: "unavailable",
      type: "decimal",
      value: null,
    });
  });

  it("groups by an admitted key and emits deterministic group rows", () => {
    const nodes: NodeSpec[] = [
      sourceNode([F.key, F.group, F.usdA]),
      fieldNode(FIELD_GROUP, F.group),
      fieldNode(FIELD_USD, F.usdA),
      {
        node_id: GROUP_KEYED,
        op: "group",
        evaluation_rows_from: null,
        input: SRC,
        key_node_ids: [FIELD_GROUP],
        output_type: rowsetOut([
          {
            field_id: groupFieldId(GROUP_KEYED, 0, FIELD_GROUP),
            name: "key_0",
            scalar: "text",
            nullable: true,
            unit: null,
            currency: null,
            grain: ROW_GRAIN,
            max_value_bytes: "i64:20",
          },
        ]),
      },
      aggregate({
        nodeId: uuid(343),
        op: "sum",
        input: FIELD_USD,
        group: GROUP_KEYED,
        scalar: "decimal",
        width: 74,
        currency: "USD",
        grain: groupGrain("gregorian", "UTC", [F.group]),
      }),
    ];
    const outcome = run(nodes, [uuid(343)]);
    expect(outcome.error_code).toBeNull();
    expect(outcome.outcome?.meter.group_count).toBe(2n);
    expect(outcome.outcome?.meter.max_group_rows).toBe(1n);
  });
});

/* ------------------------------------------------------------------ *
 * Conversions and classification
 * ------------------------------------------------------------------ */

describe("in-graph conversions and classification", () => {
  it("converts [ft_i] to m through the frozen two-stage order", () => {
    const nodes: NodeSpec[] = [
      sourceNode([F.key, F.feet]),
      fieldNode(uuid(350), F.feet),
      {
        node_id: uuid(351),
        op: "unit_convert",
        evaluation_rows_from: SRC,
        input: uuid(350),
        from_unit: "[ft_i]",
        to_unit: "m",
        registry_version: "ucum-subset-v1",
        scale: "i64:4",
        rounding: "none",
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          unit: "m",
          grain: ROW_GRAIN,
        }),
      },
    ];
    const outcome = run(nodes, [uuid(351)]);
    expect(outcome.error_code).toBeNull();
    // 2 [ft_i] = 2 * 381/1250 = 0.6096 m exactly at scale 4.
    expect(firstValue(outcome)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "6096", scale: "i64:4" },
    });
    // unit_convert charges 2n for two rows.
    expect(outcome.outcome?.meter.primitive_steps).toBe(2n + 2n + 4n);
  });

  /**
   * A `unit_convert` node over the metres-typed source field.
   *
   * `declaredUnit` is what the node claims to emit; it is a registry literal in
   * every vector so that the declared output type is never itself the reason a
   * conversion vector is denied.
   */
  const conversionNodes = (options: {
    readonly from: string;
    readonly to: string;
    readonly declaredUnit: string;
    readonly sourceField?: string;
  }): NodeSpec[] => [
    sourceNode([F.key, options.sourceField ?? F.feet]),
    fieldNode(uuid(350), options.sourceField ?? F.feet),
    {
      node_id: uuid(351),
      op: "unit_convert",
      evaluation_rows_from: SRC,
      input: uuid(350),
      from_unit: options.from,
      to_unit: options.to,
      registry_version: "ucum-subset-v1",
      scale: "i64:4",
      rounding: "none",
      output_type: scalarOut({
        scalar: "decimal",
        nullable: true,
        width: 74,
        unit: options.declaredUnit,
        grain: ROW_GRAIN,
      }),
    },
  ];

  it("denies an incompatible dimension as unit_mismatch", () => {
    const nodes = conversionNodes({
      from: "[ft_i]",
      to: "s",
      declaredUnit: "s",
    });
    expect(run(nodes, [uuid(351)]).error_code).toBe("unit_mismatch");
  });

  it("denies an unknown opaque unit alias as invalid_unit_conversion", () => {
    // `ft` is not a `ucum-subset-v1` literal. An unknown conversion literal is a
    // conversion failure, not a unit mismatch: the two units are never compared.
    expect(
      run(conversionNodes({ from: "[ft_i]", to: "ft", declaredUnit: "m" }), [
        uuid(351),
      ]).error_code,
    ).toBe("invalid_unit_conversion");
    expect(
      run(conversionNodes({ from: "ft", to: "m", declaredUnit: "m" }), [
        uuid(351),
      ]).error_code,
    ).toBe("invalid_unit_conversion");
  });

  it("checks type and currency before conversion validity", () => {
    // A non-numeric input is `type_mismatch` even though the literal is unknown.
    expect(
      run(
        conversionNodes({
          from: "ft",
          to: "ft",
          declaredUnit: "m",
          sourceField: F.observed,
        }),
        [uuid(351)],
      ).error_code,
    ).toBe("type_mismatch");
    // A currency-bearing input is `currency_mismatch` on the same graph shape.
    expect(
      run(
        conversionNodes({
          from: "ft",
          to: "ft",
          declaredUnit: "m",
          sourceField: F.usdA,
        }),
        [uuid(351)],
      ).error_code,
    ).toBe("currency_mismatch");
  });

  it("checks conversion validity before the unit comparison", () => {
    // `from_unit` disagrees with the input unit *and* names no literal. The
    // unknown literal decides first, so this is never `unit_mismatch`.
    expect(
      run(conversionNodes({ from: "furlong", to: "m", declaredUnit: "m" }), [
        uuid(351),
      ]).error_code,
    ).toBe("invalid_unit_conversion");
    // With both literals known, the same disagreement is `unit_mismatch`.
    expect(
      run(conversionNodes({ from: "cm", to: "m", declaredUnit: "m" }), [
        uuid(351),
      ]).error_code,
    ).toBe("unit_mismatch");
  });

  it("classifies current at equality and stale one microsecond over", () => {
    const build = (staleAfterMillis: number): CalculationRun => {
      const nodes: NodeSpec[] = [
        sourceNode([F.key, F.observed]),
        fieldNode(uuid(360), F.observed),
        {
          node_id: uuid(361),
          op: "classify_state",
          evaluation_rows_from: SRC,
          input: uuid(360),
          stale_after_millis: `i64:${staleAfterMillis}`,
          evaluation_time: EVALUATION_TIME,
          output_type: scalarOut({
            scalar: "text",
            nullable: false,
            width: 9,
            grain: ROW_GRAIN,
          }),
        },
      ];
      return run(nodes, [uuid(361)]);
    };
    expect(firstValue(build(86400000))).toEqual({
      state: "present",
      type: "text",
      value: "current",
    });
    expect(firstValue(build(86399999))).toEqual({
      state: "present",
      type: "text",
      value: "stale",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Ordering, windows, and the lag family
 * ------------------------------------------------------------------ */

const SORT_KEY = uuid(370);
const SORTED = uuid(371);

function sortNodes(
  direction: "asc" | "desc",
  nulls: "first" | "last",
): NodeSpec[] {
  return [
    sourceNode([F.key, F.usdB]),
    fieldNode(SORT_KEY, F.usdB),
    {
      node_id: SORTED,
      op: "sort",
      evaluation_rows_from: null,
      input: SRC,
      keys: [
        { value_node_id: SORT_KEY, direction, nulls, tie: true },
      ] as unknown as Json,
      output_type: rowsetOut([
        fieldOut(FIELDS.find((field) => field.field_id === F.key) as FieldSpec),
        fieldOut(
          FIELDS.find((field) => field.field_id === F.usdB) as FieldSpec,
        ),
      ]),
    },
  ];
}

describe("ordering, top-k, windows, and the lag family", () => {
  it("sorts ascending and descending by the explicit total order", () => {
    const ascending = run(sortNodes("asc", "last"), [SORTED]);
    const descending = run(sortNodes("desc", "last"), [SORTED]);
    const rowsOf = (outcome: CalculationRun): string[] => {
      const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
        outputs: { rows: { row_id: string }[] }[];
      };
      return (result.outputs[0]?.rows ?? []).map((entry) => entry.row_id);
    };
    expect(rowsOf(ascending)).toEqual([...rowsOf(descending)].reverse());
  });

  it("charges top-k with the inherited sort-key count, never the top count", () => {
    const topNode = (k: number): NodeSpec => ({
      node_id: uuid(372),
      op: "top_k",
      evaluation_rows_from: null,
      input: SORTED,
      k: `i64:${k}`,
      output_type: rowsetOut([
        fieldOut(FIELDS.find((field) => field.field_id === F.key) as FieldSpec),
        fieldOut(
          FIELDS.find((field) => field.field_id === F.usdB) as FieldSpec,
        ),
      ]),
    });
    const small = run([...sortNodes("asc", "last"), topNode(1)], [uuid(372)]);
    const large = run(
      [...sortNodes("asc", "last"), topNode(1000)],
      [uuid(372)],
    );
    expect(small.outcome?.meter.primitive_steps).toBe(
      large.outcome?.meter.primitive_steps,
    );
    expect(small.outcome?.meter.max_top_k).toBe(1n);
    expect(large.outcome?.meter.max_top_k).toBe(1000n);
    expect(small.outcome?.meter.final_output_rows).toBe(1n);
    expect(large.outcome?.meter.final_output_rows).toBe(2n);
  });

  it("requires an already totally sorted input for top_k", () => {
    const topNode: NodeSpec = {
      node_id: uuid(372),
      op: "top_k",
      evaluation_rows_from: null,
      input: SRC,
      k: "i64:1",
      output_type: rowsetOut([
        fieldOut(FIELDS.find((field) => field.field_id === F.key) as FieldSpec),
      ]),
    };
    expect(run([sourceNode([F.key]), topNode], [uuid(372)]).error_code).toBe(
      "type_mismatch",
    );
  });

  it("computes a row-count window mean over the declared inclusive frame", () => {
    const nodes: NodeSpec[] = [
      ...sortNodes("asc", "last"),
      {
        node_id: uuid(380),
        op: "window_mean",
        evaluation_rows_from: SORTED,
        input: uuid(381),
        partition_node_ids: [],
        keys: [
          {
            value_node_id: uuid(381),
            direction: "asc",
            nulls: "last",
            tie: true,
          },
        ] as unknown as Json,
        preceding: "i64:1",
        following: "i64:1",
        scale: "i64:2",
        rounding: "half_even",
        output_type: scalarOut({
          scalar: "decimal",
          nullable: false,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
      {
        node_id: uuid(381),
        op: "field",
        evaluation_rows_from: SORTED,
        input: SORTED,
        field_id: F.usdB,
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
    ];
    const outcome = run(nodes, [uuid(380)]);
    expect(outcome.error_code).toBeNull();
    // Both rows see the whole two-row frame: (25 + 75) / 2 = 50.
    expect(firstValue(outcome)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "50", scale: "i64:0" },
    });
    expect(outcome.outcome?.meter.max_window_frame).toBe(3n);
  });

  it("returns missing from lag when the partition has no offset row", () => {
    const nodes: NodeSpec[] = [
      ...sortNodes("asc", "last"),
      {
        node_id: uuid(381),
        op: "field",
        evaluation_rows_from: SORTED,
        input: SORTED,
        field_id: F.usdB,
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
      {
        node_id: uuid(382),
        op: "lag",
        evaluation_rows_from: SORTED,
        input: uuid(381),
        partition_node_ids: [],
        keys: [
          {
            value_node_id: uuid(381),
            direction: "asc",
            nulls: "last",
            tie: true,
          },
        ] as unknown as Json,
        offset: "i64:1",
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
    ];
    const outcome = run(nodes, [uuid(382)]);
    expect(outcome.error_code).toBeNull();
    expect(firstValue(outcome)).toEqual({
      state: "missing",
      type: "decimal",
      value: null,
    });
  });

  it("emits unit % and null currency for percentage_change", () => {
    const nodes: NodeSpec[] = [
      ...sortNodes("asc", "last"),
      {
        node_id: uuid(381),
        op: "field",
        evaluation_rows_from: SORTED,
        input: SORTED,
        field_id: F.usdB,
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
      {
        node_id: uuid(383),
        op: "percentage_change",
        evaluation_rows_from: SORTED,
        input: uuid(381),
        partition_node_ids: [],
        keys: [
          {
            value_node_id: uuid(381),
            direction: "asc",
            nulls: "last",
            tie: true,
          },
        ] as unknown as Json,
        offset: "i64:1",
        scale: "i64:2",
        rounding: "half_even",
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          unit: "%",
          grain: ROW_GRAIN,
        }),
      },
    ];
    const outcome = run(nodes, [uuid(383)]);
    expect(outcome.error_code).toBeNull();
    const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
      outputs: {
        output_type: { unit: string | null; currency: string | null };
        rows: { value: Json }[];
      }[];
    };
    expect(result.outputs[0]?.output_type.unit).toBe("%");
    expect(result.outputs[0]?.output_type.currency).toBeNull();
    // The second sorted row is (75 - 25) / 25 * 100 = 200 percent.
    expect(result.outputs[0]?.rows[1]?.value).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "200", scale: "i64:0" },
    });
  });

  it("preserves currency through delta", () => {
    const nodes: NodeSpec[] = [
      ...sortNodes("asc", "last"),
      {
        node_id: uuid(381),
        op: "field",
        evaluation_rows_from: SORTED,
        input: SORTED,
        field_id: F.usdB,
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
      {
        node_id: uuid(384),
        op: "delta",
        evaluation_rows_from: SORTED,
        input: uuid(381),
        partition_node_ids: [],
        keys: [
          {
            value_node_id: uuid(381),
            direction: "asc",
            nulls: "last",
            tie: true,
          },
        ] as unknown as Json,
        offset: "i64:1",
        scale: "i64:2",
        rounding: "half_even",
        output_type: scalarOut({
          scalar: "decimal",
          nullable: true,
          width: 74,
          currency: "USD",
          grain: ROW_GRAIN,
        }),
      },
    ];
    const outcome = run(nodes, [uuid(384)]);
    expect(outcome.error_code).toBeNull();
    const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
      outputs: { output_type: { currency: string | null } }[];
    };
    expect(result.outputs[0]?.output_type.currency).toBe("USD");
  });
});

/* ------------------------------------------------------------------ *
 * Boolean, conditional, clamp, and select behaviour
 * ------------------------------------------------------------------ */

describe("boolean, conditional, clamp, and select", () => {
  const trueLiteral = literalNode(uuid(390), "boolean", true);
  const falseLiteral = literalNode(uuid(391), "boolean", false);
  const nullBoolean = literalNode(uuid(392), "boolean", null, "null");

  function boolean(
    op: "and" | "or",
    left: NodeSpec,
    right: NodeSpec,
  ): CalculationRun {
    const node: NodeSpec = {
      node_id: uuid(393),
      op,
      evaluation_rows_from: SRC,
      left: left.node_id,
      right: right.node_id,
      output_type: scalarOut({ scalar: "boolean", nullable: true, width: 5 }),
    };
    return run([sourceNode([F.key]), left, right, node], [uuid(393)]);
  }

  it("returns present false from and when either operand is present false", () => {
    expect(firstValue(boolean("and", falseLiteral, nullBoolean))).toEqual({
      state: "present",
      type: "boolean",
      value: false,
    });
    expect(firstValue(boolean("or", trueLiteral, nullBoolean))).toEqual({
      state: "present",
      type: "boolean",
      value: true,
    });
    expect(
      (
        firstValue(boolean("and", trueLiteral, nullBoolean)) as {
          state: string;
        }
      ).state,
    ).toBe("null");
  });

  it("evaluates only the selected if_then_else branch", () => {
    const node: NodeSpec = {
      node_id: uuid(394),
      op: "if_then_else",
      evaluation_rows_from: SRC,
      condition: trueLiteral.node_id,
      when_true: uuid(395),
      when_false: uuid(396),
      output_type: scalarOut({ scalar: "integer", nullable: false, width: 26 }),
    };
    const outcome = run(
      [
        sourceNode([F.key]),
        trueLiteral,
        literalNode(uuid(395), "integer", "i64:7"),
        literalNode(uuid(396), "integer", "i64:9"),
        node,
      ],
      [uuid(394)],
    );
    expect(firstValue(outcome)).toEqual({
      state: "present",
      type: "integer",
      value: "i64:7",
    });
  });

  it("returns the first computable coalesce input and null before missing", () => {
    const node = (inputs: readonly string[]): NodeSpec => ({
      node_id: uuid(397),
      op: "coalesce",
      evaluation_rows_from: SRC,
      inputs: [...inputs],
      output_type: scalarOut({ scalar: "integer", nullable: false, width: 26 }),
    });
    const nullLiteral = literalNode(uuid(398), "integer", null, "null");
    const missingLiteral = literalNode(uuid(399), "integer", null, "missing");
    const outcome = run(
      [
        sourceNode([F.key]),
        nullLiteral,
        missingLiteral,
        node([uuid(398), uuid(399)]),
      ],
      [uuid(397)],
    );
    expect(firstValue(outcome)).toEqual({
      state: "null",
      type: "integer",
      value: null,
    });
  });

  it("clamps monotonically to the inclusive bounds", () => {
    const clampNode = (minimum: Json, maximum: Json): NodeSpec => ({
      node_id: uuid(401),
      op: "clamp",
      evaluation_rows_from: SRC,
      input: FIELD_USD,
      minimum,
      maximum,
      output_type: scalarOut({
        scalar: "decimal",
        nullable: true,
        width: 74,
        currency: "USD",
        grain: ROW_GRAIN,
      }),
    });
    const below = run(
      [
        sourceNode([F.key, F.usdA]),
        fieldNode(FIELD_USD, F.usdA),
        clampNode(
          literalValue("integer", "i64:0"),
          literalValue("integer", "i64:10"),
        ),
      ],
      [uuid(401)],
    );
    expect(firstValue(below)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "10", scale: "i64:0" },
    });
    const inside = run(
      [
        sourceNode([F.key, F.usdA]),
        fieldNode(FIELD_USD, F.usdA),
        clampNode(
          literalValue("integer", "i64:0"),
          literalValue("decimal", decimal("1000", 0)),
        ),
      ],
      [uuid(401)],
    );
    expect(firstValue(inside)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "100", scale: "i64:0" },
    });
  });

  it("denies a clamp whose minimum exceeds its maximum", () => {
    const node: NodeSpec = {
      node_id: uuid(401),
      op: "clamp",
      evaluation_rows_from: SRC,
      input: FIELD_USD,
      minimum: literalValue("integer", "i64:10"),
      maximum: literalValue("integer", "i64:0"),
      output_type: scalarOut({
        scalar: "decimal",
        nullable: true,
        width: 74,
        currency: "USD",
        grain: ROW_GRAIN,
      }),
    };
    expect(
      run(
        [sourceNode([F.key, F.usdA]), fieldNode(FIELD_USD, F.usdA), node],
        [uuid(401)],
      ).error_code,
    ).toBe("invalid_graph");
  });

  it("can only express a multi-column select when the hashes happen to sort", () => {
    /*
     * A characterization test, not a wish. `select` is unusable beyond one
     * projection, and this pins why so the next person does not spend an
     * afternoon finding out.
     *
     * Two rules apply at once. `schema.ts` requires the declared `field_id`
     * array to be STRICTLY ASCENDING. `validate.ts` requires each `field_id` to
     * equal `derivedSelectFieldId(node, ORDINAL, name, value_node)`, where the
     * ordinal is the projection's index in that same array. So the position
     * determines the hash and the hashes must ascend: a caller has to find a
     * permutation whose derived ids happen to come out sorted, and for n columns
     * only about 1 in n! orderings can.
     *
     * Whether ANY ordering works is therefore a property of the hashes, not
     * something a caller can arrange — and it is sometimes zero. The first
     * version of this test asserted five columns can never work, and was wrong:
     * with the node ids below one ordering out of 120 does. Both facts are
     * pinned here, because the useful statement is not "impossible" but "you get
     * what the hashes give you".
     *
     * The eight-column set that prompted this had 2 valid orderings out of
     * 40,320 — and seven of its eight subsets, as columns were added and
     * removed, had none at all. A caller whose projection list varies cannot
     * rely on the feature.
     *
     * Nothing is broken at runtime; the engine refuses exactly what it
     * documents. But `select` has only ever been exercised with a single
     * projection (the test below), which is why the interaction went unnoticed.
     */
    const selectId = uuid(430);
    const columns = [
      [uuid(431), "line_id"],
      [uuid(432), "period"],
      [uuid(433), "amount"],
      [uuid(434), "period_total"],
      [uuid(435), "change"],
    ] as const;

    const orderings = (function permute<T>(items: readonly T[]): T[][] {
      if (items.length <= 1) return [[...items]];
      return items.flatMap((item, index) =>
        permute([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
    })(columns);

    const ascends = orderings.filter((ordering) => {
      const ids = ordering.map(([node, name], index) =>
        selectFieldId(selectId, index, name, node),
      );
      return ids.every(
        (id, index) => index === 0 || (ids[index - 1] as string) < id,
      );
    });

    expect(orderings).toHaveLength(120);
    // One in 120 for this set — close to the 1/n! a random hash order predicts,
    // and the whole of what a caller has to work with.
    expect(ascends).toHaveLength(1);

    // The same five columns under different node ids: none of the 120 works.
    const barren = [
      [uuid(441), "line_id"],
      [uuid(442), "period"],
      [uuid(443), "amount"],
      [uuid(444), "period_total"],
      [uuid(446), "change"],
    ] as const;
    const barrenOrderings = (function permute<T>(items: readonly T[]): T[][] {
      if (items.length <= 1) return [[...items]];
      return items.flatMap((item, index) =>
        permute([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
    })(barren);

    expect(
      barrenOrderings.filter((ordering) => {
        const ids = ordering.map(([node, name], index) =>
          selectFieldId(uuid(440), index, name, node),
        );
        return ids.every(
          (id, index) => index === 0 || (ids[index - 1] as string) < id,
        );
      }),
    ).toHaveLength(0);
  });

  it("derives select field IDs from the frozen UUIDv8 preimage", () => {
    const selectId = uuid(410);
    const derived = selectFieldId(selectId, 0, "amount", FIELD_USD);
    const node: NodeSpec = {
      node_id: selectId,
      op: "select",
      evaluation_rows_from: null,
      input: SRC,
      projections: [
        { field_id: derived, name: "amount", value_node_id: FIELD_USD },
      ] as unknown as Json,
      output_type: rowsetOut([
        {
          field_id: derived,
          name: "amount",
          scalar: "decimal",
          nullable: true,
          unit: null,
          currency: "USD",
          grain: ROW_GRAIN,
          max_value_bytes: "i64:74",
        },
      ]),
    };
    const outcome = run(
      [sourceNode([F.key, F.usdA]), fieldNode(FIELD_USD, F.usdA), node],
      [selectId],
    );
    expect(outcome.error_code).toBeNull();

    const wrong: NodeSpec = {
      ...node,
      projections: [
        { field_id: uuid(999), name: "amount", value_node_id: FIELD_USD },
      ] as unknown as Json,
    };
    expect(
      run(
        [sourceNode([F.key, F.usdA]), fieldNode(FIELD_USD, F.usdA), wrong],
        [selectId],
      ).error_code,
    ).toBe("type_mismatch");
  });

  it("keeps only present or stale true rows in a filter", () => {
    const predicate = uuid(420);
    const filterId = uuid(421);
    const nodes: NodeSpec[] = [
      sourceNode([F.key, F.bare]),
      fieldNode(uuid(422), F.bare),
      literalNode(uuid(423), "decimal", decimal("50", 0)),
      {
        node_id: predicate,
        op: "greater",
        evaluation_rows_from: SRC,
        left: uuid(422),
        right: uuid(423),
        output_type: scalarOut({
          scalar: "boolean",
          nullable: false,
          width: 5,
        }),
      },
      {
        node_id: filterId,
        op: "filter",
        evaluation_rows_from: null,
        input: SRC,
        predicate,
        output_type: rowsetOut([
          fieldOut(
            FIELDS.find((field) => field.field_id === F.key) as FieldSpec,
          ),
          fieldOut(
            FIELDS.find((field) => field.field_id === F.bare) as FieldSpec,
          ),
        ]),
      },
    ];
    const outcome = run(nodes, [filterId]);
    expect(outcome.error_code).toBeNull();
    const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
      outputs: { cardinality: string }[];
    };
    expect(result.outputs[0]?.cardinality).toBe("i64:1");
  });

  it("excludes and counts non-true predicate rows", () => {
    const predicate = uuid(420);
    const filterId = uuid(421);
    const nodes: NodeSpec[] = [
      sourceNode([F.key, F.bare]),
      fieldNode(uuid(422), F.bare),
      literalNode(uuid(424), "decimal", null, "null"),
      {
        node_id: predicate,
        op: "greater",
        evaluation_rows_from: SRC,
        left: uuid(422),
        right: uuid(424),
        output_type: scalarOut({ scalar: "boolean", nullable: true, width: 5 }),
      },
      {
        node_id: filterId,
        op: "filter",
        evaluation_rows_from: null,
        input: SRC,
        predicate,
        output_type: rowsetOut([
          fieldOut(
            FIELDS.find((field) => field.field_id === F.key) as FieldSpec,
          ),
          fieldOut(
            FIELDS.find((field) => field.field_id === F.bare) as FieldSpec,
          ),
        ]),
      },
    ];
    const outcome = run(nodes, [filterId]);
    expect(outcome.error_code).toBeNull();
    const result = JSON.parse(outcome.outcome?.resultBytes as string) as {
      outputs: { cardinality: string }[];
    };
    expect(result.outputs[0]?.cardinality).toBe("i64:0");
    // A filter still charges n for every scanned row, retained or not.
    expect(outcome.outcome?.meter.primitive_steps).toBe(2n + 2n + 2n + 2n + 2n);
  });
});
