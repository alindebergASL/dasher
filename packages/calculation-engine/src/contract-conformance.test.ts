import { describe, expect, it } from "vitest";

import {
  type FieldSpec,
  type NodeSpec,
  buildBundle,
  buildCatalog,
  buildContractSet,
  buildGraph,
  buildInput,
  decimal,
  fieldOut,
  groupFieldId,
  groupGrain,
  literalValue,
  rowsetOut,
  scalarOut,
  uuid,
} from "./fixture-builder";
import { type CalculationRun, runCalculation } from "./index";
import { rowHash } from "./canonical";
import { R7_EVIDENCE_BYTES } from "./r7-fixtures";

const EVALUATION_TIME = "2026-08-05T12:00:00.000000Z";
const OBSERVED_AT = "2026-08-04T12:00:00.000000Z";
const EVIDENCE_ID = uuid(106);
/* The plan's own digest for evidence `...0106`, recomputed from its bytes. */
const EVIDENCE_SHA = rowHash("dasher.fx-rate-evidence.v1", R7_EVIDENCE_BYTES);

const KEY = uuid(201);
const AMOUNT = uuid(202);
const OBSERVED = uuid(203);
const REGION = uuid(204);

const SRC = uuid(301);
const FIELD_AMOUNT = uuid(302);
const GROUP = uuid(303);
const SUM = uuid(304);
const FIELD_EVENT_TIME = uuid(305);
const FRESHNESS_GROUP = uuid(306);
const MAX_EVENT_TIME = uuid(307);
const CLASSIFIER = uuid(308);
const THRESHOLD_LITERAL = uuid(309);
const TARGET_LITERAL = uuid(310);
const THRESHOLD = uuid(311);
const TARGET = uuid(312);

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
    field_id: AMOUNT,
    logical_name: "amount",
    scalar_type: "decimal",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "measure",
    max_value_bytes: 74,
    allowed_aggregations: ["max", "mean", "min", "sum"],
    allowed_dimensions: [REGION],
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
  {
    field_id: REGION,
    logical_name: "region",
    scalar_type: "text",
    nullable: false,
    stable_key_ordinal: null,
    semantic_type: "dimension",
    max_value_bytes: 20,
    allowed_aggregations: [],
  },
];

function buildFixtureInput(
  observedAt = OBSERVED_AT,
): ReturnType<typeof buildInput> {
  return buildInput({
    fields: FIELDS,
    rows: [
      {
        [KEY]: { state: "present", value: "i64:1" },
        [AMOUNT]: { state: "present", value: decimal("10", 0) },
        [OBSERVED]: { state: "present", value: observedAt },
        [REGION]: { state: "present", value: "north" },
      },
    ],
  });
}

const ZERO_KEY_GRAIN = groupGrain("gregorian", "UTC", []);

/** A stable per-field key-node offset so fixtures keep deterministic UUIDs. */
function dimensionIndex(fieldId: string): number {
  return FIELDS.findIndex((field) => field.field_id === fieldId);
}

interface Scenario {
  readonly calendar?: string;
  readonly timezone?: string;
  readonly graphTimezone?: string;
  readonly direction?: string;
  readonly threshold?: string | null;
  readonly target?: string | null;
  readonly aggregation?: string;
  readonly valueType?: string;
  readonly unit?: string | null;
  readonly currency?: string | null;
  readonly grain?: string;
  readonly lagMillis?: number;
  readonly sloMillis?: number;
  readonly businessOwner?: string;
  readonly dataOwner?: string;
  readonly dimensions?: readonly string[];
  readonly lineageEvidenceIds?: readonly string[];
  readonly catalogEvaluatedAt?: string;
  readonly rowObservedAt?: string;
  readonly bundleFreshness?: "current" | "stale";
  readonly bundleObservedAt?: string;
  readonly includeFreshnessTrio?: boolean;
  readonly classifierStaleAfterMillis?: number;
  readonly thresholdComparisonOp?: string;
  readonly targetComparisonOp?: string;
  /** Group key field IDs the graph actually groups on. */
  readonly groupKeys?: readonly string[];
  /** The unit the graph's contract output declares, when it must differ. */
  readonly graphUnit?: string | null;
}

function scenario(options: Scenario = {}): CalculationRun {
  const calendar = options.calendar ?? "gregorian";
  const timezone = options.timezone ?? "UTC";
  const dimensions = options.dimensions ?? [];
  const direction = options.direction ?? "neutral";
  const directional = direction !== "neutral";
  const lagMillis = options.lagMillis ?? 0;
  const sloMillis = options.sloMillis ?? 86400000;

  const input = buildFixtureInput(options.rowObservedAt ?? OBSERVED_AT);
  const catalog = buildCatalog({
    input,
    fields: FIELDS,
    evaluatedAt: options.catalogEvaluatedAt ?? EVALUATION_TIME,
  });
  const contractSet = buildContractSet({
    catalog,
    contracts: [
      {
        measure_field_id: AMOUNT,
        aggregation: options.aggregation ?? "sum",
        value_type: options.valueType ?? "decimal",
        unit: options.unit ?? null,
        currency: options.currency ?? null,
        direction,
        threshold: options.threshold ?? null,
        target: options.target ?? null,
        ...(options.grain === undefined ? {} : { grain: options.grain }),
        lag_millis: lagMillis,
        freshness_slo_millis: sloMillis,
        allowed_dimension_field_ids: dimensions,
        calendar,
        timezone,
        ...(options.businessOwner === undefined
          ? {}
          : { business_owner_membership_id: options.businessOwner }),
        ...(options.dataOwner === undefined
          ? {}
          : { data_owner_membership_id: options.dataOwner }),
        ...(options.lineageEvidenceIds === undefined
          ? {}
          : { lineage_evidence_ids: options.lineageEvidenceIds }),
      },
    ],
  });
  const bundle = buildBundle({
    input,
    entries: [
      {
        evidence_id: EVIDENCE_ID,
        evidence_sha256: EVIDENCE_SHA,
        freshness: options.bundleFreshness ?? "current",
        observed_at: options.bundleObservedAt ?? OBSERVED_AT,
      },
    ],
  });

  const groupKeys = options.groupKeys ?? [];
  const groupGrainText = groupGrain(calendar, timezone, dimensions);
  const sourceFields = [
    KEY,
    AMOUNT,
    OBSERVED,
    ...dimensions,
    ...groupKeys,
  ].filter((value, index, all) => all.indexOf(value) === index);
  const keyNodeIdOf = (fieldId: string): string =>
    uuid(320 + dimensionIndex(fieldId));
  const nodes: NodeSpec[] = [
    {
      node_id: SRC,
      op: "source",
      evaluation_rows_from: null,
      output_type: rowsetOut(
        sourceFields
          .map(
            (id) => FIELDS.find((field) => field.field_id === id) as FieldSpec,
          )
          .map(fieldOut),
      ),
      field_ids: [...sourceFields].sort(),
    },
    {
      node_id: FIELD_AMOUNT,
      op: "field",
      evaluation_rows_from: SRC,
      input: SRC,
      field_id: AMOUNT,
      output_type: scalarOut({
        scalar: "decimal",
        nullable: false,
        width: 74,
        grain: "row",
      }),
    },
    ...groupKeys.map((fieldId) => {
      const spec = FIELDS.find(
        (field) => field.field_id === fieldId,
      ) as FieldSpec;
      return {
        node_id: keyNodeIdOf(fieldId),
        op: "field",
        evaluation_rows_from: SRC,
        input: SRC,
        field_id: fieldId,
        output_type: scalarOut({
          scalar: spec.scalar_type,
          nullable: spec.nullable,
          width: spec.max_value_bytes,
          grain: "row",
        }),
      } satisfies NodeSpec;
    }),
    {
      node_id: GROUP,
      op: "group",
      evaluation_rows_from: null,
      input: SRC,
      key_node_ids: groupKeys.map(keyNodeIdOf),
      output_type: rowsetOut(
        groupKeys.map((fieldId, ordinal) => {
          const spec = FIELDS.find(
            (field) => field.field_id === fieldId,
          ) as FieldSpec;
          return {
            field_id: groupFieldId(GROUP, ordinal, keyNodeIdOf(fieldId)),
            name: `key_${ordinal}`,
            scalar: spec.scalar_type,
            nullable: spec.nullable,
            unit: null,
            currency: null,
            grain: "row",
            max_value_bytes: `i64:${spec.max_value_bytes}`,
          };
        }),
      ),
    },
    {
      node_id: SUM,
      op: "sum",
      evaluation_rows_from: GROUP,
      input: FIELD_AMOUNT,
      group_node_id: GROUP,
      output_type: scalarOut({
        scalar: "decimal",
        nullable: false,
        width: 74,
        unit:
          options.graphUnit === undefined
            ? (options.unit ?? null)
            : options.graphUnit,
        currency: options.currency ?? null,
        grain: groupGrainText,
      }),
    },
  ];

  const outputs = [SUM];

  if (options.includeFreshnessTrio === true) {
    nodes.push(
      {
        node_id: FIELD_EVENT_TIME,
        op: "field",
        evaluation_rows_from: SRC,
        input: SRC,
        field_id: OBSERVED,
        output_type: scalarOut({
          scalar: "timestamp",
          nullable: false,
          width: 29,
          grain: "row",
        }),
      },
      {
        node_id: FRESHNESS_GROUP,
        op: "group",
        evaluation_rows_from: null,
        input: SRC,
        key_node_ids: [],
        output_type: rowsetOut([]),
      },
      {
        node_id: MAX_EVENT_TIME,
        op: "max",
        evaluation_rows_from: FRESHNESS_GROUP,
        input: FIELD_EVENT_TIME,
        group_node_id: FRESHNESS_GROUP,
        output_type: scalarOut({
          scalar: "timestamp",
          nullable: false,
          width: 29,
          grain: ZERO_KEY_GRAIN,
        }),
      },
      {
        node_id: CLASSIFIER,
        op: "classify_state",
        evaluation_rows_from: FRESHNESS_GROUP,
        input: MAX_EVENT_TIME,
        stale_after_millis: `i64:${
          options.classifierStaleAfterMillis ?? lagMillis + sloMillis
        }`,
        evaluation_time: EVALUATION_TIME,
        output_type: scalarOut({
          scalar: "text",
          nullable: false,
          width: 9,
          grain: ZERO_KEY_GRAIN,
        }),
      },
    );
    outputs.push(CLASSIFIER);
  }

  if (directional) {
    nodes.push(
      {
        node_id: THRESHOLD_LITERAL,
        op: "literal",
        evaluation_rows_from: GROUP,
        value: literalValue(
          "decimal",
          decimal((options.threshold ?? "5").replace(".", ""), 0),
        ),
        output_type: scalarOut({
          scalar: "decimal",
          nullable: false,
          width: 74,
          unit: options.unit ?? null,
          currency: options.currency ?? null,
          grain: groupGrainText,
        }),
      },
      {
        node_id: TARGET_LITERAL,
        op: "literal",
        evaluation_rows_from: GROUP,
        value: literalValue(
          "decimal",
          decimal((options.target ?? "20").replace(".", ""), 0),
        ),
        output_type: scalarOut({
          scalar: "decimal",
          nullable: false,
          width: 74,
          unit: options.unit ?? null,
          currency: options.currency ?? null,
          grain: groupGrainText,
        }),
      },
      {
        node_id: THRESHOLD,
        op: options.thresholdComparisonOp ?? "greater_equal",
        evaluation_rows_from: GROUP,
        left: SUM,
        right: THRESHOLD_LITERAL,
        output_type: scalarOut({
          scalar: "boolean",
          nullable: false,
          width: 5,
          grain: groupGrainText,
        }),
      },
      {
        node_id: TARGET,
        op: options.targetComparisonOp ?? "greater_equal",
        evaluation_rows_from: GROUP,
        left: SUM,
        right: TARGET_LITERAL,
        output_type: scalarOut({
          scalar: "boolean",
          nullable: false,
          width: 5,
          grain: groupGrainText,
        }),
      },
    );
    outputs.push(THRESHOLD, TARGET);
  }

  const graph = buildGraph({
    nodes,
    outputNodeIds: outputs,
    contractOutputNodeId: SUM,
    thresholdNodeId: directional ? THRESHOLD : null,
    targetNodeId: directional ? TARGET : null,
    input,
    catalog,
    contractSetId: contractSet.contractSetId,
    bundleId: bundle.bundleId,
    bundleSha256: bundle.sha256,
    evaluationTime: EVALUATION_TIME,
    timezone: options.graphTimezone ?? timezone,
  });

  return runCalculation({
    rawGraphBytes: graph.bytes,
    inputBytes: input.bytes,
    catalogBytes: catalog.bytes,
    contractSetBytes: contractSet.bytes,
    bundleBytes: bundle.bytes,
  });
}

describe("MetricContractVersion conformance", () => {
  it("admits the exact source, field, group, aggregation structure", () => {
    const run = scenario();
    expect(run.error_code).toBeNull();
    expect(run.outcome?.state).toBe("succeeded");
    expect(run.validated?.contract?.aggregation).toBe("sum");
  });

  it("requires the contract grain to be the derived hashed group grain", () => {
    expect(scenario({ grain: "daily" }).error_code).toBe("grain_mismatch");
  });

  it("binds the calendar into the derived grain", () => {
    // The grain text below is the gregorian digest, so an iso_week contract denies.
    expect(
      scenario({
        calendar: "iso_week",
        grain: groupGrain("gregorian", "UTC", []),
      }).error_code,
    ).toBe("grain_mismatch");
  });

  it("requires the contract timezone to equal the graph timezone", () => {
    expect(
      scenario({ timezone: "Europe/Berlin", graphTimezone: "UTC" }).error_code,
    ).toBe("invalid_timezone");
  });

  it("requires distinct current business and data owner memberships", () => {
    expect(
      scenario({ businessOwner: uuid(109), dataOwner: uuid(109) }).error_code,
    ).toBe("invalid_graph");
  });

  it("requires every contract lineage entry to be a current bundle member", () => {
    expect(scenario({ lineageEvidenceIds: [uuid(199)] }).error_code).toBe(
      "missing_field",
    );
    expect(scenario({ bundleFreshness: "stale" }).error_code).toBe(
      "invalid_graph",
    );
  });

  it("requires the group keys to equal the sorted allowed dimensions", () => {
    // A contract dimension the graph does not group on changes the derived grain.
    expect(scenario({ dimensions: [REGION] }).error_code).toBe(
      "grain_mismatch",
    );
    // Grouping on exactly that dimension is admitted.
    expect(
      scenario({ dimensions: [REGION], groupKeys: [REGION] }).error_code,
    ).toBeNull();
  });

  it("requires neutral to carry null threshold and target", () => {
    expect(scenario({ threshold: "5" }).error_code).toBe("invalid_graph");
  });

  it("admits higher_is_better with two greater_equal comparisons", () => {
    const run = scenario({
      direction: "higher_is_better",
      threshold: "5",
      target: "20",
    });
    expect(run.error_code).toBeNull();
  });

  it("requires higher_is_better to have target at or above threshold", () => {
    expect(
      scenario({ direction: "higher_is_better", threshold: "20", target: "5" })
        .error_code,
    ).toBe("invalid_graph");
  });

  it("requires lower_is_better to use two less_equal comparisons", () => {
    expect(
      scenario({
        direction: "lower_is_better",
        threshold: "20",
        target: "5",
        thresholdComparisonOp: "greater_equal",
        targetComparisonOp: "greater_equal",
      }).error_code,
    ).toBe("invalid_graph");
    expect(
      scenario({
        direction: "lower_is_better",
        threshold: "20",
        target: "5",
        thresholdComparisonOp: "less_equal",
        targetComparisonOp: "less_equal",
      }).error_code,
    ).toBeNull();
  });

  it("requires target_band to use greater_equal then less_equal", () => {
    expect(
      scenario({
        direction: "target_band",
        threshold: "5",
        target: "20",
        thresholdComparisonOp: "greater_equal",
        targetComparisonOp: "less_equal",
      }).error_code,
    ).toBeNull();
    expect(
      scenario({
        direction: "target_band",
        threshold: "5",
        target: "20",
        thresholdComparisonOp: "less_equal",
        targetComparisonOp: "greater_equal",
      }).error_code,
    ).toBe("invalid_graph");
  });

  it("denies a value type that does not match its aggregation", () => {
    expect(scenario({ valueType: "integer" }).error_code).toBe("type_mismatch");
  });

  it("denies a contract unit the graph output does not carry", () => {
    expect(
      scenario({ valueType: "percentage", unit: "%", graphUnit: null })
        .error_code,
    ).toBe("unit_mismatch");
  });

  it("denies an unsupported aggregation that cannot reach the registry", () => {
    expect(scenario({ aggregation: "count_distinct" }).error_code).toBe(
      "invalid_graph",
    );
    expect(scenario({ aggregation: "median" }).error_code).toBe(
      "invalid_graph",
    );
  });
});

describe("contract freshness conformance", () => {
  it("admits the catalog instant exactly at the checked lag plus SLO", () => {
    // Evaluation is 86,400,000 ms after the catalog instant, exactly the allowance.
    expect(
      scenario({
        catalogEvaluatedAt: OBSERVED_AT,
        lagMillis: 0,
        sloMillis: 86400000,
      }).error_code,
    ).toBeNull();
  });

  it("denies a catalog instant one microsecond beyond the allowance", () => {
    expect(
      scenario({
        catalogEvaluatedAt: "2026-08-04T11:59:59.999999Z",
        lagMillis: 0,
        sloMillis: 86400000,
      }).error_code,
    ).toBe("invalid_graph");
  });

  it("denies a lineage evidence instant one microsecond beyond the allowance", () => {
    expect(
      scenario({
        bundleObservedAt: "2026-08-04T11:59:59.999999Z",
        lagMillis: 0,
        sloMillis: 86400000,
      }).error_code,
    ).toBe("invalid_graph");
  });

  it("admits a stale maximum event time and reports it through the classifier", () => {
    const run = scenario({
      includeFreshnessTrio: true,
      rowObservedAt: "2026-08-04T11:59:59.999999Z",
      lagMillis: 0,
      sloMillis: 86400000,
    });
    expect(run.error_code).toBeNull();
    const result = JSON.parse(run.outcome?.resultBytes as string) as {
      outputs: { node_id: string; rows: { value: { value: string } }[] }[];
    };
    const classifier = result.outputs.find(
      (entry) => entry.node_id === CLASSIFIER,
    );
    expect(classifier?.rows[0]?.value.value).toBe("stale");
  });

  it("classifies the maximum event time as current at exact equality", () => {
    const run = scenario({
      includeFreshnessTrio: true,
      lagMillis: 0,
      sloMillis: 86400000,
    });
    expect(run.error_code).toBeNull();
    const result = JSON.parse(run.outcome?.resultBytes as string) as {
      outputs: { node_id: string; rows: { value: { value: string } }[] }[];
    };
    const classifier = result.outputs.find(
      (entry) => entry.node_id === CLASSIFIER,
    );
    expect(classifier?.rows[0]?.value.value).toBe("current");
  });

  it("derives the freshness trio only from the exact structure", () => {
    const run = scenario({ includeFreshnessTrio: true });
    expect(run.validated?.freshness).toEqual({
      classifier_node_id: CLASSIFIER,
      input_node_id: MAX_EVENT_TIME,
    });
    expect(scenario().validated?.freshness).toBeNull();
  });

  it("requires the classifier threshold to equal the checked lag plus SLO", () => {
    expect(
      scenario({
        includeFreshnessTrio: true,
        classifierStaleAfterMillis: 1,
      }).error_code,
    ).toBe("invalid_graph");
  });

  it("admits the maximum lag and SLO and denies one millisecond over", () => {
    expect(
      scenario({ lagMillis: 31536000000, sloMillis: 31536000000 }).error_code,
    ).toBeNull();
    expect(scenario({ lagMillis: 31536000001 }).error_code).toBe(
      "invalid_graph",
    );
    expect(scenario({ sloMillis: 31536000001 }).error_code).toBe(
      "invalid_graph",
    );
    expect(scenario({ sloMillis: 0 }).error_code).toBe("invalid_graph");
  });
});
