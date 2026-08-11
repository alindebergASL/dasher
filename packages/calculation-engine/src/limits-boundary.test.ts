/**
 * `calculation-limits-v1` boundaries exercised through real graphs.
 *
 * Section 5.3 requires the inclusive ceiling and the first unit above it to be
 * exercised by actual static derivation and runtime metering, so every vector
 * here builds a complete request and runs it. No meter value is injected into an
 * internal function, and no ceiling is asserted by restating its constant.
 *
 * Where a ceiling is not representable by any admissible graph, the test proves
 * why from the limits themselves — the plan requires the vectors "where
 * representable" — and pins the meter behaviour that is reachable.
 */

import { describe, expect, it } from "vitest";

import {
  type FieldSpec,
  type Json,
  type NodeSpec,
  buildCatalog,
  buildGraph,
  buildInput,
  decimal,
  fieldOut,
  literalValue,
  rowsetOut,
  scalarOut,
  uuid,
} from "./fixture-builder";
import {
  type CalculationRun,
  LIMITS,
  type StaticMeter,
  runCalculation,
} from "./index";

const EVALUATION_TIME = "2026-08-05T12:00:00.000000Z";
const KEY = uuid(201);
const TEXT = uuid(202);
const SRC = uuid(301);

function fieldSpecs(textWidth: number): readonly FieldSpec[] {
  return [
    {
      field_id: KEY,
      logical_name: "row_key",
      scalar_type: "integer",
      nullable: false,
      stable_key_ordinal: 0,
      semantic_type: "identifier",
      max_value_bytes: 26,
      allowed_aggregations: ["count"],
    },
    {
      field_id: TEXT,
      logical_name: "label",
      scalar_type: "text",
      nullable: false,
      stable_key_ordinal: null,
      semantic_type: "attribute",
      max_value_bytes: textWidth,
      allowed_aggregations: [],
    },
  ];
}

interface Fixture {
  readonly inputBytes: string;
  readonly catalogBytes: string;
  readonly fields: readonly FieldSpec[];
  readonly rowCount: number;
}

/**
 * One input/catalog pair.
 *
 * `textWidth` is the declared catalog width of the text field, and `label` its
 * actual value in every row; the two are independent knobs, exactly as a real
 * catalog bound and a real value are.
 */
function fixture(options: {
  readonly rows: number;
  readonly textWidth?: number;
  readonly label?: string;
  readonly distinctKeys?: boolean;
}): Fixture {
  const label = options.label ?? "x";
  const fields = fieldSpecs(options.textWidth ?? label.length + 2);
  const rows = Array.from({ length: options.rows }, (_unused, index) => ({
    [KEY]: {
      state: "present" as const,
      value: `i64:${options.distinctKeys === false ? 1 : index + 1}`,
    },
    [TEXT]: { state: "present" as const, value: label },
  }));
  const input = buildInput({ fields, rows });
  const catalog = buildCatalog({
    input,
    fields,
    evaluatedAt: EVALUATION_TIME,
  });
  return {
    inputBytes: input.bytes,
    catalogBytes: catalog.bytes,
    fields,
    rowCount: options.rows,
  };
}

/** A fixture whose rows carry maximal labels, with a variable-length tail row. */
function labelledFixture(fullRows: number, tail: number): Fixture {
  const maximal = "x".repeat(4094);
  const labels = [
    ...Array.from({ length: fullRows }, () => maximal),
    "x".repeat(tail),
  ];
  const fields = fieldSpecs(4096);
  const rows = labels.map((label, index) => ({
    [KEY]: { state: "present" as const, value: `i64:${index + 1}` },
    [TEXT]: { state: "present" as const, value: label },
  }));
  const input = buildInput({ fields, rows });
  const catalog = buildCatalog({ input, fields, evaluatedAt: EVALUATION_TIME });
  return {
    inputBytes: input.bytes,
    catalogBytes: catalog.bytes,
    fields,
    rowCount: rows.length,
  };
}

function run(
  base: Fixture,
  nodes: readonly NodeSpec[],
  outputNodeIds: readonly string[],
): CalculationRun {
  const graph = buildGraph({
    nodes,
    outputNodeIds,
    contractOutputNodeId: outputNodeIds[0] as string,
    thresholdNodeId: null,
    targetNodeId: null,
    input: {
      bytes: base.inputBytes,
      sha256: inputSha(base),
      rowIds: [],
      snapshotId: uuid(101),
      rowCount: base.rowCount,
    },
    catalog: {
      bytes: base.catalogBytes,
      sha256: catalogSha(base),
      snapshotId: uuid(102),
    },
    evaluationTime: EVALUATION_TIME,
  });
  return runCalculation({
    rawGraphBytes: graph.bytes,
    inputBytes: base.inputBytes,
    catalogBytes: base.catalogBytes,
    calendar: "gregorian",
    skipContractConformance: true,
  });
}

/* The fixture builder already returns these; recomputed here to keep `run`
 * independent of which builder produced the fixture. */
import { rowHash } from "./canonical";

function inputSha(base: Fixture): string {
  return rowHash("dasher.canonical-input-table.v1", base.inputBytes);
}

function catalogSha(base: Fixture): string {
  return rowHash("dasher.field-catalog-snapshot.v1", base.catalogBytes);
}

function sourceNode(
  base: Fixture,
  nodeId: string = SRC,
  fieldIds: readonly string[] = [KEY],
): NodeSpec {
  const specs = fieldIds.map(
    (id) => base.fields.find((field) => field.field_id === id) as FieldSpec,
  );
  return {
    node_id: nodeId,
    op: "source",
    evaluation_rows_from: null,
    output_type: rowsetOut(specs.map(fieldOut)),
    field_ids: [...fieldIds].sort(),
  };
}

function booleanLiteral(nodeId: string, domain: string = SRC): NodeSpec {
  return {
    node_id: nodeId,
    op: "literal",
    evaluation_rows_from: domain,
    value: literalValue("boolean", true),
    output_type: scalarOut({ scalar: "boolean", nullable: false, width: 5 }),
  };
}

function textLiteral(nodeId: string, value: string): NodeSpec {
  return {
    node_id: nodeId,
    op: "literal",
    evaluation_rows_from: SRC,
    value: literalValue("text", value),
    output_type: scalarOut({
      scalar: "text",
      nullable: false,
      width: value.length + 2,
    }),
  };
}

function meterOf(outcome: CalculationRun): StaticMeter {
  expect(denialOf(outcome)).toBeNull();
  return outcome.validated?.staticMeter as StaticMeter;
}

/**
 * The closed code of a denial, whether it came from static admission or from
 * the runtime meter's failed envelope.
 */
function denialOf(outcome: CalculationRun): string | null {
  if (outcome.error_code !== null) return outcome.error_code;
  if (outcome.outcome?.state === "failed") {
    return outcome.outcome.error_code as string;
  }
  return null;
}

/**
 * Solves for the knob value that puts one meter dimension exactly on its
 * ceiling by measuring the real meter, never by predicting it.
 *
 * Each padding byte moves one metered byte, plus the occasional extra byte when
 * a declared width gains a decimal digit, so the search jumps by the measured
 * shortfall while it is far away and then steps by one. Every measurement is a
 * complete request through the public entry point; a denied vector measures as
 * `null` and the search steps back.
 */
function solveForCeiling(options: {
  readonly probe: (knob: number) => CalculationRun;
  readonly read: (meter: StaticMeter) => bigint;
  readonly ceiling: bigint;
  readonly start: number;
}): number {
  const measure = (knob: number): bigint | null => {
    const outcome = options.probe(knob);
    if (denialOf(outcome) !== null) return null;
    return options.read(outcome.validated?.staticMeter as StaticMeter);
  };
  let knob = options.start;
  for (let step = 0; step < 64; step += 1) {
    const value = measure(knob);
    if (value === null || value > options.ceiling) {
      knob -= 1;
      continue;
    }
    if (value === options.ceiling) return knob;
    const shortfall = options.ceiling - value;
    knob += shortfall > 8n ? Number(shortfall) - 4 : 1;
  }
  throw new Error("no knob value reaches the ceiling exactly");
}

/* ------------------------------------------------------------------ *
 * Counted dimensions
 * ------------------------------------------------------------------ */

describe("node and depth ceilings", () => {
  const base = fixture({ rows: 1 });

  it("admits 128 nodes and denies 129", () => {
    const build = (count: number): NodeSpec[] => {
      const nodes: NodeSpec[] = [sourceNode(base)];
      for (let index = 2; index <= count; index += 1) {
        nodes.push(booleanLiteral(uuid(index)));
      }
      return nodes;
    };
    expect(meterOf(run(base, build(128), [SRC])).node_count).toBe(
      LIMITS.nodeCount,
    );
    expect(denialOf(run(base, build(129), [SRC]))).toBe("limit_exceeded");
  });

  it("admits depth 32 and denies 33", () => {
    const chain = (depth: number): NodeSpec[] => {
      const nodes: NodeSpec[] = [sourceNode(base), booleanLiteral(uuid(2))];
      let previous = uuid(2);
      for (let level = 3; level <= depth; level += 1) {
        const nodeId = uuid(level);
        nodes.push({
          node_id: nodeId,
          op: "not",
          evaluation_rows_from: SRC,
          input: previous,
          output_type: scalarOut({
            scalar: "boolean",
            nullable: false,
            width: 5,
          }),
        });
        previous = nodeId;
      }
      return nodes;
    };
    const deep = chain(32);
    expect(
      meterOf(run(base, deep, [deep[deep.length - 1]?.node_id as string]))
        .max_depth,
    ).toBe(LIMITS.maxDepth);
    const tooDeep = chain(33);
    expect(
      denialOf(
        run(base, tooDeep, [tooDeep[tooDeep.length - 1]?.node_id as string]),
      ),
    ).toBe("limit_exceeded");
  });
});

describe("row ceilings", () => {
  it("admits scanned rows at the ceiling and denies the next source", () => {
    // Every source node scans the whole input, so the metered total is the
    // source count times the bounded row count.
    const rows = 1000;
    const base = fixture({ rows });
    const sources = (count: number): NodeSpec[] =>
      Array.from({ length: count }, (_unused, index) =>
        sourceNode(base, uuid(301 + index)),
      );
    const atLimit = sources(Number(LIMITS.scannedRows) / rows);
    expect(meterOf(run(base, atLimit, [SRC])).scanned_rows).toBe(
      LIMITS.scannedRows,
    );
    expect(
      run(base, sources(Number(LIMITS.scannedRows) / rows + 1), [SRC])
        .error_code,
    ).toBe("limit_exceeded");
  });

  it("admits final output rows at the ceiling and denies one over", () => {
    const atLimit = fixture({ rows: Number(LIMITS.finalOutputRows) });
    expect(
      meterOf(run(atLimit, [sourceNode(atLimit)], [SRC])).final_output_rows,
    ).toBe(LIMITS.finalOutputRows);
    const over = fixture({ rows: Number(LIMITS.finalOutputRows) + 1 });
    expect(denialOf(run(over, [sourceNode(over)], [SRC]))).toBe(
      "limit_exceeded",
    );
  });

  it("admits cumulative intermediate rows at the ceiling and denies one node over", () => {
    const rows = 500;
    const base = fixture({ rows });
    const build = (intermediates: number): NodeSpec[] => {
      const nodes: NodeSpec[] = [sourceNode(base)];
      for (let index = 1; index < intermediates; index += 1) {
        nodes.push(booleanLiteral(uuid(400 + index)));
      }
      nodes.push(booleanLiteral(uuid(399)));
      return nodes;
    };
    const perNode = BigInt(rows);
    const count = Number(LIMITS.cumulativeIntermediateRows / perNode);
    const meter = meterOf(run(base, build(count), [uuid(399)]));
    expect(meter.cumulative_intermediate_rows).toBe(
      LIMITS.cumulativeIntermediateRows,
    );
    expect(denialOf(run(base, build(count + 1), [uuid(399)]))).toBe(
      "limit_exceeded",
    );
  });

  it("admits groups at the ceiling and denies one group over", () => {
    const keyed = (base: Fixture): NodeSpec[] => [
      sourceNode(base, SRC, [KEY]),
      {
        node_id: uuid(310),
        op: "field",
        evaluation_rows_from: SRC,
        input: SRC,
        field_id: KEY,
        output_type: scalarOut({
          scalar: "integer",
          nullable: false,
          width: 26,
          grain: "row",
        }),
      },
      {
        node_id: uuid(311),
        op: "group",
        evaluation_rows_from: null,
        input: SRC,
        key_node_ids: [uuid(310)],
        output_type: rowsetOut([
          {
            field_id: groupKeyFieldId(),
            name: "key_0",
            scalar: "integer",
            nullable: false,
            unit: null,
            currency: null,
            grain: "row",
            max_value_bytes: "i64:26",
          },
        ]),
      },
    ];
    const atLimit = fixture({ rows: Number(LIMITS.groups) });
    expect(meterOf(run(atLimit, keyed(atLimit), [uuid(311)])).group_count).toBe(
      LIMITS.groups,
    );
    const over = fixture({ rows: Number(LIMITS.groups) + 1 });
    expect(denialOf(run(over, keyed(over), [uuid(311)]))).toBe(
      "limit_exceeded",
    );
  });
});

/* The derived group-key field UUID of the single-key group node above. */
import { groupFieldId } from "./fixture-builder";

function groupKeyFieldId(): string {
  return groupFieldId(uuid(311), 0, uuid(310));
}

/* ------------------------------------------------------------------ *
 * Byte ceilings
 * ------------------------------------------------------------------ */

describe("byte ceilings", () => {
  it("admits canonical input bytes at the ceiling and denies one over", () => {
    // One text value is itself bounded, so the ceiling is approached with whole
    // rows and then met exactly by the last row's label.
    const build = (fullRows: number, tail: number): CalculationRun => {
      const base = labelledFixture(fullRows, tail);
      return run(base, [sourceNode(base)], [SRC]);
    };
    const perRow =
      (meterOf(build(200, 1)).input_bytes -
        meterOf(build(100, 1)).input_bytes) /
      100n;
    const at100 = meterOf(build(100, 1)).input_bytes;
    const fullRows =
      100 + Number((LIMITS.canonicalInputBytes - at100 - 2048n) / perRow);
    const tail = solveForCeiling({
      probe: (knob) => build(fullRows, knob),
      read: (meter) => meter.input_bytes,
      ceiling: LIMITS.canonicalInputBytes,
      start: 1,
    });
    expect(meterOf(build(fullRows, tail)).input_bytes).toBe(
      LIMITS.canonicalInputBytes,
    );
    expect(denialOf(build(fullRows, tail + 1))).toBe("limit_exceeded");
  });

  it("admits intermediate bytes at the ceiling and denies one over", () => {
    // One intermediate source row of the declared text width, and a small
    // separate output node, so the ceiling is reached by the declared width.
    const build = (textWidth: number): CalculationRun => {
      const base = fixture({ rows: 1, textWidth });
      return run(
        base,
        [sourceNode(base, SRC, [KEY, TEXT]), booleanLiteral(uuid(302))],
        [uuid(302)],
      );
    };
    const width = solveForCeiling({
      probe: build,
      read: (meter) => meter.cumulative_intermediate_bytes,
      ceiling: LIMITS.cumulativeIntermediateBytes,
      start: 16,
    });
    expect(meterOf(build(width)).cumulative_intermediate_bytes).toBe(
      LIMITS.cumulativeIntermediateBytes,
    );
    expect(denialOf(build(width + 1))).toBe("limit_exceeded");
  });

  it("admits output bytes at the ceiling and denies one over", () => {
    const build = (textWidth: number): CalculationRun => {
      const base = fixture({ rows: 1, textWidth });
      return run(base, [sourceNode(base, SRC, [KEY, TEXT])], [SRC]);
    };
    const width = solveForCeiling({
      probe: build,
      read: (meter) => meter.output_bytes,
      ceiling: LIMITS.outputBytes,
      start: 16,
    });
    expect(meterOf(build(width)).output_bytes).toBe(LIMITS.outputBytes);
    expect(denialOf(build(width + 1))).toBe("limit_exceeded");
  });
});

/* ------------------------------------------------------------------ *
 * Literal ceilings
 * ------------------------------------------------------------------ */

describe("literal ceilings", () => {
  const base = fixture({ rows: 1 });

  it("admits one literal at the byte ceiling and denies one over", () => {
    const build = (length: number): CalculationRun =>
      run(
        base,
        [sourceNode(base), textLiteral(uuid(302), "x".repeat(length))],
        [uuid(302)],
      );
    const length = solveForCeiling({
      probe: build,
      read: (meter) => meter.max_literal_bytes,
      ceiling: LIMITS.literalBytes,
      start: 16,
    });
    expect(meterOf(build(length)).max_literal_bytes).toBe(LIMITS.literalBytes);
    expect(denialOf(build(length + 1))).toBe("limit_exceeded");
  });

  it("admits total literal bytes at the ceiling and denies one over", () => {
    // Eight literals, each solved to its own inclusive ceiling, sum to exactly
    // the total ceiling; a ninth literal of any size is over.
    const single = (length: number): CalculationRun =>
      run(
        base,
        [sourceNode(base), textLiteral(uuid(302), "x".repeat(length))],
        [uuid(302)],
      );
    const maximal = solveForCeiling({
      probe: single,
      read: (meter) => meter.max_literal_bytes,
      ceiling: LIMITS.literalBytes,
      start: 8,
    });
    const build = (count: number): CalculationRun => {
      const nodes: NodeSpec[] = [sourceNode(base)];
      for (let index = 0; index < count; index += 1) {
        nodes.push(textLiteral(uuid(310 + index), "x".repeat(maximal)));
      }
      return run(base, nodes, [uuid(310)]);
    };
    const count = Number(LIMITS.totalLiteralBytes / LIMITS.literalBytes);
    expect(meterOf(build(count)).total_literal_bytes).toBe(
      LIMITS.totalLiteralBytes,
    );
    expect(denialOf(build(count + 1))).toBe("limit_exceeded");
  });
});

/* ------------------------------------------------------------------ *
 * Ordering, window, and decimal ceilings
 * ------------------------------------------------------------------ */

/** A source, its sort key, and a total order over the key field. */
function sortedNodes(base: Fixture): NodeSpec[] {
  return [
    sourceNode(base, SRC, [KEY]),
    {
      node_id: uuid(370),
      op: "field",
      evaluation_rows_from: SRC,
      input: SRC,
      field_id: KEY,
      output_type: scalarOut({
        scalar: "integer",
        nullable: false,
        width: 26,
        grain: "row",
      }),
    },
    {
      node_id: uuid(371),
      op: "sort",
      evaluation_rows_from: null,
      input: SRC,
      keys: [
        {
          value_node_id: uuid(370),
          direction: "asc",
          nulls: "last",
          tie: true,
        },
      ] as unknown as Json,
      output_type: rowsetOut(
        [base.fields.find((field) => field.field_id === KEY) as FieldSpec].map(
          fieldOut,
        ),
      ),
    },
  ];
}

describe("ordering and window ceilings", () => {
  const base = fixture({ rows: 2 });

  it("admits the top count at its ceiling and denies one over", () => {
    const build = (k: number): CalculationRun =>
      run(
        base,
        [
          ...sortedNodes(base),
          {
            node_id: uuid(372),
            op: "top_k",
            evaluation_rows_from: null,
            input: uuid(371),
            k: `i64:${k}`,
            output_type: rowsetOut(
              [
                base.fields.find(
                  (field) => field.field_id === KEY,
                ) as FieldSpec,
              ].map(fieldOut),
            ),
          },
        ],
        [uuid(372)],
      );
    expect(meterOf(build(Number(LIMITS.topK))).max_top_k).toBe(LIMITS.topK);
    // One over is rejected by the AST bound on `k`, before any meter runs.
    expect(denialOf(build(Number(LIMITS.topK) + 1))).toBe("invalid_graph");
  });

  it("admits the window frame at its ceiling and denies one over", () => {
    const build = (preceding: number): CalculationRun =>
      run(
        base,
        [
          ...sortedNodes(base),
          {
            node_id: uuid(380),
            op: "window_sum",
            evaluation_rows_from: uuid(371),
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
            preceding: `i64:${preceding}`,
            following: "i64:0",
            output_type: scalarOut({
              scalar: "decimal",
              nullable: false,
              width: 74,
              grain: "row",
            }),
          },
          {
            node_id: uuid(381),
            op: "field",
            evaluation_rows_from: uuid(371),
            input: uuid(371),
            field_id: KEY,
            output_type: scalarOut({
              scalar: "integer",
              nullable: false,
              width: 26,
              grain: "row",
            }),
          },
        ],
        [uuid(380)],
      );
    // The declared inclusive frame is `1 + preceding + following`.
    const atLimit = Number(LIMITS.windowFrame) - 1;
    expect(meterOf(build(atLimit)).max_window_frame).toBe(LIMITS.windowFrame);
    // One over is rejected by the AST frame bound, before any meter runs.
    expect(denialOf(build(atLimit + 1))).toBe("invalid_graph");
  });
});

describe("decimal ceilings", () => {
  const base = fixture({ rows: 1 });

  const decimalLiteral = (coefficient: string, scale: number): NodeSpec => ({
    node_id: uuid(302),
    op: "literal",
    evaluation_rows_from: SRC,
    value: literalValue("decimal", decimal(coefficient, scale)),
    output_type: scalarOut({ scalar: "decimal", nullable: false, width: 74 }),
  });

  const build = (coefficient: string, scale: number): CalculationRun =>
    run(
      base,
      [sourceNode(base), decimalLiteral(coefficient, scale)],
      [uuid(302)],
    );

  it("admits 38 coefficient digits and denies 39", () => {
    const digits = Number(LIMITS.coefficientDigits);
    expect(meterOf(build("9".repeat(digits), 0)).max_coefficient_digits).toBe(
      LIMITS.coefficientDigits,
    );
    // A 39-digit coefficient is not a canonical decimal at all.
    expect(denialOf(build("9".repeat(digits + 1), 0))).toBe("invalid_graph");
  });

  it("admits scale 18 and denies 19", () => {
    const scale = Number(LIMITS.scale);
    expect(meterOf(build(`1${"0".repeat(scale)}1`, scale)).max_scale).toBe(
      LIMITS.scale,
    );
    expect(denialOf(build(`1${"0".repeat(scale + 1)}1`, scale + 1))).toBe(
      "invalid_graph",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Primitive steps
 * ------------------------------------------------------------------ */

describe("primitive step ceiling", () => {
  const rows = 100;
  const base = fixture({ rows });

  /**
   * A window over `rows` rows charges `rows * frame`, and each scalar node on
   * the zero-key group charges exactly one, so the two together reach any exact
   * step total.
   */
  function build(frame: number, fillers: number): CalculationRun {
    const nodes: NodeSpec[] = [
      ...sortedNodes(base),
      {
        node_id: uuid(381),
        op: "field",
        evaluation_rows_from: uuid(371),
        input: uuid(371),
        field_id: KEY,
        output_type: scalarOut({
          scalar: "integer",
          nullable: false,
          width: 26,
          grain: "row",
        }),
      },
      {
        node_id: uuid(380),
        op: "window_sum",
        evaluation_rows_from: uuid(371),
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
        preceding: `i64:${frame - 1}`,
        following: "i64:0",
        output_type: scalarOut({
          scalar: "decimal",
          nullable: false,
          width: 74,
          grain: "row",
        }),
      },
      {
        node_id: uuid(390),
        op: "group",
        evaluation_rows_from: null,
        input: SRC,
        key_node_ids: [],
        output_type: rowsetOut([]),
      },
    ];
    for (let index = 0; index < fillers; index += 1) {
      nodes.push(booleanLiteral(uuid(400 + index), uuid(390)));
    }
    return run(base, nodes, [uuid(380)]);
  }

  it("admits the step ceiling exactly and denies one step over", () => {
    // Measure the graph without a wide frame, then widen it to within a
    // hundred steps of the ceiling and close the gap with single-step nodes.
    const atFrameTwo = meterOf(build(2, 0)).primitive_steps;
    const frame =
      2 + Number((LIMITS.primitiveSteps - atFrameTwo - 60n) / BigInt(rows));
    const withoutFillers = meterOf(build(frame, 0)).primitive_steps;
    const fillers = Number(LIMITS.primitiveSteps - withoutFillers);
    expect(fillers).toBeGreaterThanOrEqual(0);
    expect(fillers).toBeLessThan(120);
    expect(meterOf(build(frame, fillers)).primitive_steps).toBe(
      LIMITS.primitiveSteps,
    );
    expect(denialOf(build(frame, fillers + 1))).toBe("limit_exceeded");
  });
});

/* ------------------------------------------------------------------ *
 * Canonical AST bytes
 * ------------------------------------------------------------------ */

describe("canonical AST byte ceiling", () => {
  const base = fixture({ rows: 1 });

  /** `sources` copies of the source node, plus one literal as the fine knob. */
  function build(sources: number, literalLength: number): CalculationRun {
    const nodes: NodeSpec[] = Array.from(
      { length: sources },
      (_unused, index) => sourceNode(base, uuid(301 + index), [KEY, TEXT]),
    );
    nodes.push(textLiteral(uuid(299), "x".repeat(literalLength)));
    return run(base, nodes, [uuid(299)]);
  }

  it("admits AST bytes at the ceiling and denies one over", () => {
    const perSource =
      meterOf(build(3, 8)).ast_bytes - meterOf(build(2, 8)).ast_bytes;
    const atTwo = meterOf(build(2, 8)).ast_bytes;
    const sources = 2 + Number((LIMITS.astBytes - atTwo - 2048n) / perSource);
    expect(sources).toBeLessThan(Number(LIMITS.nodeCount));
    const literalLength = solveForCeiling({
      probe: (knob) => build(sources, knob),
      read: (meter) => meter.ast_bytes,
      ceiling: LIMITS.astBytes,
      start: 8,
    });
    expect(meterOf(build(sources, literalLength)).ast_bytes).toBe(
      LIMITS.astBytes,
    );
    expect(denialOf(build(sources, literalLength + 1))).toBe("limit_exceeded");
  });
});

/* ------------------------------------------------------------------ *
 * Ceilings no admissible graph can reach
 * ------------------------------------------------------------------ */

describe("ceilings that are not representable", () => {
  it("meters no literal list, because registry v1 has no list literal", () => {
    // Every literal is one tagged scalar value, so the list-length meter is
    // structurally zero and its ceiling has no at-limit vector.
    const base = fixture({ rows: 1 });
    const meter = meterOf(
      run(
        base,
        [sourceNode(base), textLiteral(uuid(302), "x".repeat(1000))],
        [uuid(302)],
      ),
    );
    expect(meter.max_literal_list_length).toBe(0n);
    expect(meter.max_literal_bytes).toBeGreaterThan(0n);
  });

  it("cannot fill one group to its row ceiling within the input ceiling", () => {
    // The rows of one group are input rows, and the smallest admissible row
    // costs more canonical bytes than the input ceiling allows at that count.
    const measured = (rows: number): bigint => {
      const base = fixture({ rows });
      return meterOf(run(base, [sourceNode(base)], [SRC])).input_bytes;
    };
    const perRow = (measured(200) - measured(100)) / 100n;
    const needed = perRow * (LIMITS.rowsInGroup + 1n);
    expect(needed).toBeGreaterThan(LIMITS.canonicalInputBytes);
  });

  it("cannot reach the allocation ceiling, whose parts are separately capped", () => {
    // Logical allocation is input + AST + intermediate + output + 64 per node,
    // and every term already has its own inclusive ceiling.
    const maximum =
      LIMITS.canonicalInputBytes +
      LIMITS.astBytes +
      LIMITS.cumulativeIntermediateBytes +
      LIMITS.outputBytes +
      64n * LIMITS.nodeCount;
    expect(maximum).toBeLessThan(LIMITS.logicalAllocationBytes);
  });
});

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

describe("limit coverage", () => {
  const BOUNDED_BY_REAL_GRAPHS = [
    "input_bytes",
    "ast_bytes",
    "node_count",
    "max_depth",
    "max_literal_bytes",
    "total_literal_bytes",
    "scanned_rows",
    "group_count",
    "cumulative_intermediate_rows",
    "final_output_rows",
    "cumulative_intermediate_bytes",
    "output_bytes",
    "primitive_steps",
    "max_top_k",
    "max_window_frame",
    "max_coefficient_digits",
    "max_scale",
  ] as const;

  const NOT_REPRESENTABLE = [
    "max_literal_list_length",
    "max_group_rows",
    "logical_allocation_bytes",
  ] as const;

  it("accounts for every metered dimension", () => {
    const base = fixture({ rows: 1 });
    const meter = meterOf(run(base, [sourceNode(base)], [SRC]));
    const metered = Object.keys(meter).sort();
    expect(metered).toHaveLength(20);
    expect([...BOUNDED_BY_REAL_GRAPHS, ...NOT_REPRESENTABLE].sort()).toEqual(
      metered,
    );
  });
});
