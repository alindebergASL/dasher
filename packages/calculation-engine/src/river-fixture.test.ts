import { describe, expect, it } from "vitest";

import {
  type FieldSpec,
  type Json,
  type NodeSpec,
  buildBundle,
  buildCatalog,
  buildContractSet,
  buildGraph,
  buildInput,
  decimal,
  fieldOut,
  groupGrain,
  rowsetOut,
  scalarOut,
  uuid,
} from "./fixture-builder";
import { runCalculation } from "./index";
import { rowHash } from "./canonical";
import { R7_EVIDENCE_BYTES } from "./r7-fixtures";

/**
 * A bounded river dashboard fixture. It uses only the exact `ucum-subset-v1`
 * literals `[ft_i]`, `[ft_i]3/s`, and `[degF]` and asserts the frozen metric
 * conversions to `m`, `m3/s`, and `Cel`. It introduces no `ft`, `cfs`, `degC`,
 * or any other parser alias.
 */

const EVALUATION_TIME = "2026-08-05T12:00:00.000000Z";
const OBSERVED_AT = "2026-08-04T12:00:00.000000Z";
const EVIDENCE_ID = uuid(106);

const GAUGE = uuid(201);
const STAGE_FT = uuid(202);
const FLOW_CFS = uuid(203);
const TEMP_F = uuid(204);
const OBSERVED = uuid(205);

const SRC = uuid(301);
const FIELD_STAGE = uuid(302);
const FIELD_FLOW = uuid(303);
const FIELD_TEMP = uuid(304);
const GROUP = uuid(305);
const SUM_FLOW = uuid(306);
const FLOW_IN_SI = uuid(307);
const MAX_STAGE = uuid(308);
const STAGE_IN_METRES = uuid(309);
const MAX_TEMP = uuid(310);
const TEMP_IN_CELSIUS = uuid(311);

const FIELDS: readonly FieldSpec[] = [
  {
    field_id: GAUGE,
    logical_name: "gauge_id",
    scalar_type: "integer",
    nullable: false,
    stable_key_ordinal: 0,
    semantic_type: "identifier",
    max_value_bytes: 26,
    allowed_aggregations: ["count"],
  },
  {
    field_id: STAGE_FT,
    logical_name: "stage",
    scalar_type: "decimal",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "measure",
    unit: "[ft_i]",
    max_value_bytes: 74,
    allowed_aggregations: ["max", "mean", "min", "sum"],
    event_time_field_id: OBSERVED,
  },
  {
    field_id: FLOW_CFS,
    logical_name: "streamflow",
    scalar_type: "decimal",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "measure",
    unit: "[ft_i]3/s",
    max_value_bytes: 74,
    allowed_aggregations: ["max", "mean", "min", "sum"],
    event_time_field_id: OBSERVED,
  },
  {
    field_id: TEMP_F,
    logical_name: "water_temperature",
    scalar_type: "decimal",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "measure",
    unit: "[degF]",
    max_value_bytes: 74,
    allowed_aggregations: ["max", "mean", "min", "sum"],
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
      [GAUGE]: { state: "present", value: "i64:11446500" },
      [STAGE_FT]: { state: "present", value: decimal("2", 0) },
      [FLOW_CFS]: { state: "present", value: decimal("1", 0) },
      [TEMP_F]: { state: "present", value: decimal("212", 0) },
      [OBSERVED]: { state: "present", value: OBSERVED_AT },
    },
  ],
});

const CATALOG = buildCatalog({
  input: INPUT,
  fields: FIELDS,
  evaluatedAt: EVALUATION_TIME,
});

const GROUP_GRAIN = groupGrain("gregorian", "UTC", []);

const CONTRACT_SET = buildContractSet({
  catalog: CATALOG,
  contracts: [
    {
      measure_field_id: FLOW_CFS,
      aggregation: "sum",
      value_type: "decimal",
      unit: "m3/s",
      name: "Metric streamflow",
      definition: "Sum the frozen [ft_i]3/s measure and convert once to m3/s.",
    },
  ],
});

const BUNDLE = buildBundle({
  input: INPUT,
  entries: [
    {
      evidence_id: EVIDENCE_ID,
      evidence_sha256: rowHash("dasher.fx-rate-evidence.v1", R7_EVIDENCE_BYTES),
      observed_at: OBSERVED_AT,
    },
  ],
});

function measureField(nodeId: string, fieldId: string, unit: string): NodeSpec {
  return {
    node_id: nodeId,
    op: "field",
    evaluation_rows_from: SRC,
    input: SRC,
    field_id: fieldId,
    output_type: scalarOut({
      scalar: "decimal",
      nullable: false,
      width: 74,
      unit,
      grain: "row",
    }),
  };
}

function aggregateNode(
  nodeId: string,
  op: "sum" | "max",
  input: string,
  unit: string,
): NodeSpec {
  return {
    node_id: nodeId,
    op,
    evaluation_rows_from: GROUP,
    input,
    group_node_id: GROUP,
    output_type: scalarOut({
      scalar: "decimal",
      nullable: false,
      width: 74,
      unit,
      grain: GROUP_GRAIN,
    }),
  };
}

function convertNode(
  nodeId: string,
  input: string,
  fromUnit: string,
  toUnit: string,
  scale: number,
): NodeSpec {
  return {
    node_id: nodeId,
    op: "unit_convert",
    evaluation_rows_from: GROUP,
    input,
    from_unit: fromUnit,
    to_unit: toUnit,
    registry_version: "ucum-subset-v1",
    scale: `i64:${scale}`,
    rounding: "half_even",
    output_type: scalarOut({
      scalar: "decimal",
      nullable: false,
      width: 74,
      unit: toUnit,
      grain: GROUP_GRAIN,
    }),
  };
}

const NODES: readonly NodeSpec[] = [
  {
    node_id: SRC,
    op: "source",
    evaluation_rows_from: null,
    output_type: rowsetOut(FIELDS.map(fieldOut)),
    field_ids: FIELDS.map((field) => field.field_id).sort(),
  },
  measureField(FIELD_STAGE, STAGE_FT, "[ft_i]"),
  measureField(FIELD_FLOW, FLOW_CFS, "[ft_i]3/s"),
  measureField(FIELD_TEMP, TEMP_F, "[degF]"),
  {
    node_id: GROUP,
    op: "group",
    evaluation_rows_from: null,
    input: SRC,
    key_node_ids: [],
    output_type: rowsetOut([]),
  },
  aggregateNode(SUM_FLOW, "sum", FIELD_FLOW, "[ft_i]3/s"),
  convertNode(FLOW_IN_SI, SUM_FLOW, "[ft_i]3/s", "m3/s", 18),
  aggregateNode(MAX_STAGE, "max", FIELD_STAGE, "[ft_i]"),
  convertNode(STAGE_IN_METRES, MAX_STAGE, "[ft_i]", "m", 18),
  aggregateNode(MAX_TEMP, "max", FIELD_TEMP, "[degF]"),
  convertNode(TEMP_IN_CELSIUS, MAX_TEMP, "[degF]", "Cel", 18),
];

const GRAPH = buildGraph({
  nodes: NODES,
  outputNodeIds: [FLOW_IN_SI, STAGE_IN_METRES, TEMP_IN_CELSIUS],
  contractOutputNodeId: FLOW_IN_SI,
  input: INPUT,
  catalog: CATALOG,
  contractSetId: CONTRACT_SET.contractSetId,
  bundleId: BUNDLE.bundleId,
  bundleSha256: BUNDLE.sha256,
  evaluationTime: EVALUATION_TIME,
});

const RUN = runCalculation({
  rawGraphBytes: GRAPH.bytes,
  inputBytes: INPUT.bytes,
  catalogBytes: CATALOG.bytes,
  contractSetBytes: CONTRACT_SET.bytes,
  bundleBytes: BUNDLE.bytes,
});

function outputValue(nodeId: string): Json {
  const result = JSON.parse(RUN.outcome?.resultBytes as string) as {
    outputs: { node_id: string; rows: { value: Json }[] }[];
  };
  const entry = result.outputs.find(
    (candidate) => candidate.node_id === nodeId,
  );
  return entry?.rows[0]?.value as Json;
}

describe("bounded river dashboard fixture", () => {
  it("passes contract conformance and succeeds", () => {
    expect(RUN.error_code).toBeNull();
    expect(RUN.outcome?.state).toBe("succeeded");
  });

  it("uses only the exact registry literals and no alias", () => {
    for (const literal of [
      "[ft_i]",
      "[ft_i]3/s",
      "[degF]",
      "m",
      "m3/s",
      "Cel",
    ]) {
      expect(GRAPH.bytes).toContain(`"${literal}"`);
    }
    for (const alias of ["ft", "cfs", "degC", "°C", "m^3/s", "[ft_i]^3/s"]) {
      expect(GRAPH.bytes).not.toContain(`"${alias}"`);
      expect(CATALOG.bytes).not.toContain(`"${alias}"`);
    }
  });

  it("converts the streamflow sum from [ft_i]3/s to m3/s exactly", () => {
    // 1 [ft_i]3/s = 55306341/1953125000 m3/s = 0.028316846592 exactly.
    expect(outputValue(FLOW_IN_SI)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "28316846592", scale: "i64:12" },
    });
  });

  it("converts the maximum stage from [ft_i] to m exactly", () => {
    // 2 [ft_i] = 2 * 381/1250 m = 0.6096 exactly.
    expect(outputValue(STAGE_IN_METRES)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "6096", scale: "i64:4" },
    });
  });

  it("converts the maximum temperature from [degF] to Cel through both affine offsets", () => {
    // 212 [degF] -> 373.15 K -> 100 Cel exactly.
    expect(outputValue(TEMP_IN_CELSIUS)).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "100", scale: "i64:0" },
    });
  });

  it("charges 2n primitive steps for every unit conversion", () => {
    // source 1 + three fields 3 + group 1 + three aggregates 3 + three 2n conversions 6.
    expect(RUN.outcome?.meter.primitive_steps).toBe(14n);
  });

  it("reports the two conversion diagnostics as final output rows", () => {
    expect(RUN.outcome?.meter.final_output_rows).toBe(3n);
    expect(RUN.outcome?.meter.group_count).toBe(1n);
    expect(RUN.outcome?.meter.scanned_rows).toBe(1n);
  });

  it("keeps the derived contract output unit exactly m3/s", () => {
    const result = JSON.parse(RUN.outcome?.resultBytes as string) as {
      outputs: { node_id: string; output_type: { unit: string | null } }[];
    };
    const entry = result.outputs.find(
      (candidate) => candidate.node_id === FLOW_IN_SI,
    );
    expect(entry?.output_type.unit).toBe("m3/s");
    expect(RUN.validated?.contract?.unit).toBe("m3/s");
  });
});
