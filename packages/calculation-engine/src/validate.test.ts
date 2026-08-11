import { describe, expect, it } from "vitest";

import { jcsEncode, parseStrictJson, utf8ByteLength } from "./canonical";
import {
  type FieldSpec,
  type Json,
  type NodeSpec,
  buildCatalog,
  buildGraph,
  buildInput,
  canonical,
  decimal,
  fieldOut,
  groupGrain,
  literalValue,
  rowsetOut,
  scalarOut,
  uuid,
} from "./fixture-builder";
import { type CalculationRun, LIMITS, runCalculation } from "./index";
import { CalculationFailure } from "./schema";
import { type StaticMeter, requireLimits } from "./validate";

const EVALUATION_TIME = "2026-08-05T12:00:00.000000Z";
const KEY = uuid(201);
const BARE = uuid(202);
const OBSERVED = uuid(203);
const SRC = uuid(301);
const ZERO_KEY_GRAIN = groupGrain("gregorian", "UTC", []);

const FIELDS: readonly FieldSpec[] = [
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
    field_id: BARE,
    logical_name: "bare_decimal",
    scalar_type: "decimal",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "measure",
    grain: null,
    max_value_bytes: 74,
    allowed_aggregations: ["sum"],
    event_time_field_id: OBSERVED,
  },
  {
    field_id: OBSERVED,
    logical_name: "observed_at",
    scalar_type: "timestamp",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "event_time",
    max_value_bytes: 29,
    allowed_aggregations: ["max"],
  },
];

const INPUT = buildInput({
  fields: FIELDS,
  rows: [
    {
      [KEY]: { state: "present", value: "i64:1" },
      [BARE]: { state: "present", value: decimal("10", 0) },
      [OBSERVED]: { state: "present", value: "2026-08-04T12:00:00.000000Z" },
    },
  ],
});

const CATALOG = buildCatalog({
  input: INPUT,
  fields: FIELDS,
  evaluatedAt: EVALUATION_TIME,
});

function sourceNode(fieldIds: readonly string[] = [KEY]): NodeSpec {
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

function booleanLiteral(nodeId: string): NodeSpec {
  return {
    node_id: nodeId,
    op: "literal",
    evaluation_rows_from: SRC,
    value: literalValue("boolean", true),
    output_type: scalarOut({ scalar: "boolean", nullable: false, width: 5 }),
  };
}

function notNode(nodeId: string, input: string): NodeSpec {
  return {
    node_id: nodeId,
    op: "not",
    evaluation_rows_from: SRC,
    input,
    output_type: scalarOut({ scalar: "boolean", nullable: false, width: 5 }),
  };
}

function run(
  nodes: readonly NodeSpec[],
  outputNodeIds: readonly string[],
  contractIds: {
    contractOutputNodeId?: string;
    thresholdNodeId?: string;
    targetNodeId?: string;
  } = {},
): CalculationRun {
  const graph = buildGraph({
    nodes,
    outputNodeIds,
    contractOutputNodeId:
      contractIds.contractOutputNodeId ?? (outputNodeIds[0] as string),
    thresholdNodeId: contractIds.thresholdNodeId ?? null,
    targetNodeId: contractIds.targetNodeId ?? null,
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

/** Runs a graph whose canonical bytes were edited after construction. */
function runEditedGraph(
  nodes: readonly NodeSpec[],
  outputNodeIds: readonly string[],
  mutate: (document: Record<string, unknown>) => void,
): CalculationRun {
  const graph = buildGraph({
    nodes,
    outputNodeIds,
    contractOutputNodeId: outputNodeIds[0] as string,
    input: INPUT,
    catalog: CATALOG,
    evaluationTime: EVALUATION_TIME,
  });
  const document = JSON.parse(graph.bytes) as Record<string, unknown>;
  mutate(document);
  return runCalculation({
    rawGraphBytes: canonical(document as Json),
    inputBytes: INPUT.bytes,
    catalogBytes: CATALOG.bytes,
    calendar: "gregorian",
    skipContractConformance: true,
  });
}

/* ------------------------------------------------------------------ *
 * calculation-limits-v1
 *
 * Every ceiling is exercised at and over its boundary by real graphs in
 * `limits-boundary.test.ts`, which runs actual static derivation and runtime
 * metering rather than supplying meter values to an internal function.
 * ------------------------------------------------------------------ */

describe("meter guard", () => {
  it("denies a negative meter value", () => {
    // Not a ceiling vector: the guard that no counted dimension can go
    // negative, which no admissible graph can produce.
    expect(() =>
      requireLimits({
        ...(runCalculation({
          rawGraphBytes: buildGraph({
            nodes: [sourceNode()],
            outputNodeIds: [SRC],
            contractOutputNodeId: SRC,
            input: INPUT,
            catalog: CATALOG,
            evaluationTime: EVALUATION_TIME,
          }).bytes,
          inputBytes: INPUT.bytes,
          catalogBytes: CATALOG.bytes,
          calendar: "gregorian",
          skipContractConformance: true,
        }).validated?.staticMeter as StaticMeter),
        node_count: -1n,
      }),
    ).toThrow(CalculationFailure);
  });
});

/* ------------------------------------------------------------------ *
 * AST depth, node count, order, and references
 * ------------------------------------------------------------------ */

function depthChain(depth: number): NodeSpec[] {
  // source = 1, literal = 2, and each `not` adds exactly one level.
  const nodes: NodeSpec[] = [sourceNode(), booleanLiteral(uuid(2))];
  let previous = uuid(2);
  for (let level = 3; level <= depth; level += 1) {
    const nodeId = uuid(level);
    nodes.push(notNode(nodeId, previous));
    previous = nodeId;
  }
  return nodes;
}

describe("AST depth and node count", () => {
  it("admits root depth 1 through 32 and denies 33", () => {
    const shallow = run([sourceNode()], [SRC]);
    expect(shallow.error_code).toBeNull();
    expect(shallow.outcome?.meter.max_depth).toBe(1n);

    const deep = depthChain(32);
    const admitted = run(deep, [deep[deep.length - 1]?.node_id as string]);
    expect(admitted.error_code).toBeNull();
    expect(admitted.outcome?.meter.max_depth).toBe(32n);

    const tooDeep = depthChain(33);
    expect(
      run(tooDeep, [tooDeep[tooDeep.length - 1]?.node_id as string]).error_code,
    ).toBe("limit_exceeded");
  });

  it("admits 128 nodes and denies 129", () => {
    const build = (count: number): NodeSpec[] => {
      const nodes: NodeSpec[] = [sourceNode()];
      for (let index = 2; index <= count; index += 1) {
        nodes.push(booleanLiteral(uuid(index)));
      }
      return nodes;
    };
    expect(run(build(128), [SRC]).error_code).toBeNull();
    expect(run(build(129), [SRC]).error_code).toBe("limit_exceeded");
  });

  it("denies a reference to an undefined node as missing_field", () => {
    const outcome = runEditedGraph(
      [sourceNode(), booleanLiteral(uuid(2)), notNode(uuid(3), uuid(2))],
      [uuid(3)],
      (document) => {
        const nodes = document.nodes as Record<string, unknown>[];
        const target = nodes.find((node) => node.op === "not") as Record<
          string,
          unknown
        >;
        target.input = uuid(999);
      },
    );
    expect(outcome.error_code).toBe("missing_field");
  });

  it("denies a self-referencing node as a cycle", () => {
    const outcome = runEditedGraph(
      [sourceNode(), booleanLiteral(uuid(2)), notNode(uuid(3), uuid(2))],
      [uuid(3)],
      (document) => {
        const nodes = document.nodes as Record<string, unknown>[];
        const target = nodes.find((node) => node.op === "not") as Record<
          string,
          unknown
        >;
        target.input = uuid(3);
      },
    );
    expect(outcome.error_code).toBe("cycle");
  });

  it("denies nodes that are not in deterministic topological order", () => {
    const outcome = runEditedGraph(
      [sourceNode(), booleanLiteral(uuid(2)), booleanLiteral(uuid(3))],
      [uuid(2)],
      (document) => {
        const nodes = document.nodes as Record<string, unknown>[];
        const swapped = [nodes[0], nodes[2], nodes[1]];
        document.nodes = swapped;
      },
    );
    expect(outcome.error_code).toBe("invalid_graph");
  });
});

/* ------------------------------------------------------------------ *
 * Literal byte meters
 * ------------------------------------------------------------------ */

describe("literal byte meters", () => {
  function textLiteralGraph(text: string): CalculationRun {
    const literal: NodeSpec = {
      node_id: uuid(2),
      op: "literal",
      evaluation_rows_from: SRC,
      value: literalValue("text", text),
      output_type: scalarOut({
        scalar: "text",
        nullable: false,
        width: Number(utf8ByteLength(jcsEncode(text))),
      }),
    };
    return run([sourceNode(), literal], [uuid(2)]);
  }

  it("counts the complete canonical tagged-literal byte length", () => {
    const outcome = textLiteralGraph("ab");
    const expected = utf8ByteLength(
      jcsEncode(
        parseStrictJson('{"state":"present","type":"text","value":"ab"}'),
      ),
    );
    expect(outcome.outcome?.meter.max_literal_bytes).toBe(expected);
    expect(outcome.outcome?.meter.total_literal_bytes).toBe(expected);
  });

  it("counts multibyte literals by UTF-8 bytes, not code points", () => {
    const ascii = textLiteralGraph("aaaa");
    const multibyte = textLiteralGraph("éééé");
    expect(multibyte.outcome?.meter.max_literal_bytes).toBe(
      (ascii.outcome?.meter.max_literal_bytes as bigint) + 4n,
    );
  });

  it("reports zero literal metrics when a graph has no literal", () => {
    const outcome = run([sourceNode()], [SRC]);
    expect(outcome.outcome?.meter.max_literal_bytes).toBe(0n);
    expect(outcome.outcome?.meter.total_literal_bytes).toBe(0n);
    expect(outcome.outcome?.meter.max_literal_list_length).toBe(0n);
  });

  it("keeps max_literal_list_length at exactly zero for registry v1", () => {
    const outcome = textLiteralGraph("ab");
    expect(outcome.outcome?.meter.max_literal_list_length).toBe(0n);
    expect(LIMITS.literalListLength).toBe(256n);
  });

  it("denies a text literal beyond 4,096 UTF-8 bytes", () => {
    expect(textLiteralGraph("x".repeat(4097)).error_code).toBe("invalid_graph");
  });
});

/* ------------------------------------------------------------------ *
 * Final and intermediate partition
 * ------------------------------------------------------------------ */

describe("final and intermediate accounting partition", () => {
  const FIELD = uuid(302);
  const GROUP = uuid(303);
  const SUM = uuid(304);
  const THRESHOLD_LITERAL = uuid(305);
  const TARGET_LITERAL = uuid(306);
  const THRESHOLD = uuid(307);
  const TARGET = uuid(308);

  const CONTRACT_IDS = {
    contractOutputNodeId: SUM,
    thresholdNodeId: THRESHOLD,
    targetNodeId: TARGET,
  };

  const nodes: NodeSpec[] = [
    sourceNode([KEY, BARE]),
    {
      node_id: FIELD,
      op: "field",
      evaluation_rows_from: SRC,
      input: SRC,
      field_id: BARE,
      output_type: scalarOut({ scalar: "decimal", nullable: false, width: 74 }),
    },
    {
      node_id: GROUP,
      op: "group",
      evaluation_rows_from: null,
      input: SRC,
      key_node_ids: [],
      output_type: rowsetOut([]),
    },
    {
      node_id: SUM,
      op: "sum",
      evaluation_rows_from: GROUP,
      input: FIELD,
      group_node_id: GROUP,
      output_type: scalarOut({
        scalar: "decimal",
        nullable: false,
        width: 74,
        grain: ZERO_KEY_GRAIN,
      }),
    },
    {
      node_id: THRESHOLD_LITERAL,
      op: "literal",
      evaluation_rows_from: GROUP,
      value: literalValue("decimal", decimal("5", 0)),
      output_type: scalarOut({
        scalar: "decimal",
        nullable: false,
        width: 74,
        grain: ZERO_KEY_GRAIN,
      }),
    },
    {
      node_id: TARGET_LITERAL,
      op: "literal",
      evaluation_rows_from: GROUP,
      value: literalValue("decimal", decimal("20", 0)),
      output_type: scalarOut({
        scalar: "decimal",
        nullable: false,
        width: 74,
        grain: ZERO_KEY_GRAIN,
      }),
    },
    {
      node_id: THRESHOLD,
      op: "greater_equal",
      evaluation_rows_from: GROUP,
      left: SUM,
      right: THRESHOLD_LITERAL,
      output_type: scalarOut({
        scalar: "boolean",
        nullable: false,
        width: 5,
        grain: ZERO_KEY_GRAIN,
      }),
    },
    {
      node_id: TARGET,
      op: "less_equal",
      evaluation_rows_from: GROUP,
      left: SUM,
      right: TARGET_LITERAL,
      output_type: scalarOut({
        scalar: "boolean",
        nullable: false,
        width: 5,
        grain: ZERO_KEY_GRAIN,
      }),
    },
  ];

  it("never counts a consumed final output in the intermediate totals", () => {
    const outcome = run(nodes, [SUM, THRESHOLD, TARGET], CONTRACT_IDS);
    expect(outcome.error_code).toBeNull();
    // source, field, group, and the two literals are the only intermediates.
    expect(outcome.outcome?.meter.cumulative_intermediate_rows).toBe(5n);
    expect(outcome.outcome?.meter.final_output_rows).toBe(3n);
    expect(outcome.outcome?.intermediateByteVector).toHaveLength(5);
  });

  it("keeps a consumerless node intermediate when it is not an output", () => {
    const consumerless = [
      ...nodes,
      {
        node_id: uuid(309),
        op: "not",
        evaluation_rows_from: GROUP,
        input: THRESHOLD,
        output_type: scalarOut({
          scalar: "boolean",
          nullable: false,
          width: 5,
          grain: ZERO_KEY_GRAIN,
        }),
      } satisfies NodeSpec,
    ];
    const outcome = run(consumerless, [SUM, THRESHOLD, TARGET], CONTRACT_IDS);
    expect(outcome.error_code).toBeNull();
    expect(outcome.outcome?.meter.cumulative_intermediate_rows).toBe(6n);
    expect(outcome.outcome?.meter.final_output_rows).toBe(3n);
  });

  it("uses the closed logical-allocation equation and no host measurement", () => {
    const outcome = run(nodes, [SUM, THRESHOLD, TARGET], CONTRACT_IDS);
    const meter = outcome.outcome?.meter;
    expect(meter?.logical_allocation_bytes).toBe(
      (meter?.input_bytes as bigint) +
        (meter?.ast_bytes as bigint) +
        (meter?.cumulative_intermediate_bytes as bigint) +
        (meter?.output_bytes as bigint) +
        64n * (meter?.node_count as bigint),
    );
  });

  it("keeps every static bound at or above the runtime meter", () => {
    const graph = buildGraph({
      nodes,
      outputNodeIds: [SUM, THRESHOLD, TARGET],
      contractOutputNodeId: SUM,
      thresholdNodeId: THRESHOLD,
      targetNodeId: TARGET,
      input: INPUT,
      catalog: CATALOG,
      evaluationTime: EVALUATION_TIME,
    });
    const outcome = runCalculation({
      rawGraphBytes: graph.bytes,
      inputBytes: INPUT.bytes,
      catalogBytes: CATALOG.bytes,
      calendar: "gregorian",
      skipContractConformance: true,
    });
    const staticMeter = outcome.validated?.staticMeter as StaticMeter;
    const runtime = outcome.outcome?.meter as StaticMeter;
    for (const name of [
      "scanned_rows",
      "group_count",
      "max_group_rows",
      "cumulative_intermediate_rows",
      "final_output_rows",
      "cumulative_intermediate_bytes",
      "output_bytes",
      "primitive_steps",
      "logical_allocation_bytes",
    ] as const) {
      expect(staticMeter[name]).toBeGreaterThanOrEqual(runtime[name]);
    }
    // The one-row source makes the static row bounds exact.
    expect(staticMeter.scanned_rows).toBe(runtime.scanned_rows);
    expect(staticMeter.primitive_steps).toBe(runtime.primitive_steps);
  });
});

/* ------------------------------------------------------------------ *
 * Static width requirements
 * ------------------------------------------------------------------ */

describe("static width requirements", () => {
  it("denies a catalog field without a positive maximum width", () => {
    const zeroWidthFields = FIELDS.map((field) =>
      field.field_id === BARE ? { ...field, max_value_bytes: 0 } : field,
    );
    const badCatalog = buildCatalog({
      input: INPUT,
      fields: zeroWidthFields,
      evaluatedAt: EVALUATION_TIME,
    });
    const graph = buildGraph({
      nodes: [sourceNode([KEY, BARE])],
      outputNodeIds: [SRC],
      contractOutputNodeId: SRC,
      input: INPUT,
      catalog: badCatalog,
      evaluationTime: EVALUATION_TIME,
    });
    const outcome = runCalculation({
      rawGraphBytes: graph.bytes,
      inputBytes: INPUT.bytes,
      catalogBytes: badCatalog.bytes,
      calendar: "gregorian",
      skipContractConformance: true,
    });
    expect(outcome.error_code).toBe("type_mismatch");
  });

  it("denies a graph whose input snapshot or hash differs from the parsed input", () => {
    const graph = buildGraph({
      nodes: [sourceNode()],
      outputNodeIds: [SRC],
      contractOutputNodeId: SRC,
      input: INPUT,
      catalog: CATALOG,
      evaluationTime: EVALUATION_TIME,
    });
    const document = JSON.parse(graph.bytes) as Record<string, unknown>;
    // A deliberately arbitrary digest, not a value the plan states anywhere.
    const WRONG_DIGEST = "0".repeat(64);
    expect(WRONG_DIGEST).not.toBe(INPUT.sha256);
    document.input_sha256 = WRONG_DIGEST;
    const outcome = runCalculation({
      rawGraphBytes: canonical(document as Json),
      inputBytes: INPUT.bytes,
      catalogBytes: CATALOG.bytes,
      calendar: "gregorian",
      skipContractConformance: true,
    });
    expect(outcome.error_code).toBe("invalid_graph");
  });
});

/* ------------------------------------------------------------------ *
 * The external defence is separate and never hashed
 * ------------------------------------------------------------------ */

describe("external wall and memory defence", () => {
  it("stays outside the engine and never enters any hashed byte", () => {
    const started = process.hrtime.bigint();
    const outcome = run([sourceNode()], [SRC]);
    const elapsedNanos = process.hrtime.bigint() - started;
    // The external 45-second budget is enforced by the caller, not the engine.
    expect(elapsedNanos).toBeLessThan(45_000_000_000n);
    expect(outcome.outcome?.meterBytes).not.toContain(elapsedNanos.toString());
    expect(outcome.outcome?.resultBytes).not.toContain(elapsedNanos.toString());
  });

  it("produces identical bytes regardless of how long the caller took", () => {
    const first = run([sourceNode()], [SRC]);
    const second = run([sourceNode()], [SRC]);
    expect(first.outcome?.meter_sha256).toBe(second.outcome?.meter_sha256);
    expect(first.outcome?.result_sha256).toBe(second.outcome?.result_sha256);
  });
});
