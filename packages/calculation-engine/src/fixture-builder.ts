/**
 * Deterministic fixture construction for the engine's own vectors.
 *
 * The builder independently recomputes canonical input row IDs, the canonical
 * topological node order, and every envelope hash rather than importing the
 * engine's internal derivations, so a fixture and the engine agree only when
 * both follow the plan. It is test support and is not exported from the package.
 */

import { createHash } from "node:crypto";

import { jcsEncode, parseStrictJson, rowHash } from "./canonical";

export type Json = string | boolean | null | Json[] | { [key: string]: Json };

const UUID_PREFIX = "00000000-0000-8000-8000-";

/** A stable fixture UUID from a 12-digit suffix. */
export function uuid(suffix: number): string {
  return `${UUID_PREFIX}${suffix.toString(10).padStart(12, "0")}`;
}

export function canonical(value: Json): string {
  return jcsEncode(parseStrictJson(JSON.stringify(value)));
}

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function i64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let remaining = BigInt.asUintN(64, value);
  for (let index = 7; index >= 0; index -= 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.split("-").join("");
  const out = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function text(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat([u32(bytes.length), bytes]);
}

function uuidV8(domain: string, parts: readonly Uint8Array[]): string {
  const digest = createHash("sha256")
    .update(concat([encoder.encode(`${domain}\0`), ...parts]))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

export type InputScalar =
  "boolean" | "integer" | "decimal" | "text" | "date" | "timestamp";

const TYPE_BYTE: Record<InputScalar, number> = {
  boolean: 0x00,
  integer: 0x01,
  decimal: 0x02,
  text: 0x03,
  date: 0x04,
  timestamp: 0x05,
};

const STATE_BYTE: Record<string, number> = {
  present: 0x00,
  null: 0x01,
  missing: 0x02,
  unavailable: 0x03,
};

const DAYS_PER_400_YEARS = 146097n;

function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
  const shifted = month <= 2n ? year - 1n : year;
  const era = (shifted >= 0n ? shifted : shifted - 399n) / 400n;
  const yearOfEra = shifted - era * 400n;
  const dayOfYear =
    (153n * (month + (month > 2n ? -3n : 9n)) + 2n) / 5n + day - 1n;
  const dayOfEra =
    yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * DAYS_PER_400_YEARS + dayOfEra - 719468n;
}

function timestampMicros(value: string): bigint {
  const year = BigInt(value.slice(0, 4));
  const month = BigInt(value.slice(5, 7));
  const day = BigInt(value.slice(8, 10));
  const hour = BigInt(value.slice(11, 13));
  const minute = BigInt(value.slice(14, 16));
  const second = BigInt(value.slice(17, 19));
  const micros = BigInt(value.slice(20, 26));
  const days = daysFromCivil(year, month, day);
  return (
    ((days * 24n + hour) * 60n + minute) * 60n * 1000000n +
    second * 1000000n +
    micros
  );
}

export interface CellSpec {
  readonly state: "present" | "null" | "missing" | "unavailable";
  readonly value?: Json;
}

/** The exact canonical-binary typed value used by input row-ID preimages. */
function typedValueBinary(type: InputScalar, cell: CellSpec): Uint8Array {
  const header = new Uint8Array([
    TYPE_BYTE[type],
    STATE_BYTE[cell.state] as number,
  ]);
  if (cell.state !== "present") return header;
  const value = cell.value as Json;
  switch (type) {
    case "boolean":
      return concat([header, new Uint8Array([value === true ? 1 : 0])]);
    case "integer":
      return concat([header, i64(BigInt((value as string).slice(4)))]);
    case "timestamp":
      return concat([header, i64(timestampMicros(value as string))]);
    case "date": {
      const days = daysFromCivil(
        BigInt((value as string).slice(0, 4)),
        BigInt((value as string).slice(5, 7)),
        BigInt((value as string).slice(8, 10)),
      );
      const out = new Uint8Array(4);
      const unsigned = BigInt.asUintN(32, days);
      out[0] = Number((unsigned >> 24n) & 0xffn);
      out[1] = Number((unsigned >> 16n) & 0xffn);
      out[2] = Number((unsigned >> 8n) & 0xffn);
      out[3] = Number(unsigned & 0xffn);
      return concat([header, out]);
    }
    case "decimal": {
      const decimal = value as { coefficient: string; scale: string };
      const out = new Uint8Array(17);
      let remaining = BigInt.asUintN(128, BigInt(decimal.coefficient));
      for (let index = 15; index >= 0; index -= 1) {
        out[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
      }
      out[16] = Number(BigInt(decimal.scale.slice(4)));
      return concat([header, out]);
    }
    case "text":
      return concat([header, text(value as string)]);
  }
}

export interface FieldSpec {
  readonly field_id: string;
  readonly scalar_type: InputScalar;
  readonly nullable: boolean;
  readonly stable_key_ordinal: number | null;
  readonly logical_name: string;
  readonly semantic_type:
    "identifier" | "measure" | "dimension" | "event_time" | "attribute";
  readonly unit?: string | null;
  readonly currency?: string | null;
  readonly grain?: string | null;
  readonly event_time_field_id?: string | null;
  readonly max_value_bytes: number;
  readonly allowed_aggregations?: readonly string[];
  readonly allowed_dimensions?: readonly string[];
  readonly lineage_evidence_ids?: readonly string[];
  readonly source_path?: string;
}

export interface BuiltInput {
  readonly bytes: string;
  readonly sha256: string;
  readonly rowIds: readonly string[];
  readonly snapshotId: string;
  readonly rowCount: number;
}

export interface BuildInputOptions {
  readonly snapshotId?: string;
  readonly fields: readonly FieldSpec[];
  readonly rows: ReadonlyArray<Readonly<Record<string, CellSpec>>>;
}

export function buildInput(options: BuildInputOptions): BuiltInput {
  const snapshotId = options.snapshotId ?? uuid(101);
  const fields = [...options.fields].sort((left, right) =>
    left.field_id < right.field_id ? -1 : 1,
  );
  const keyFields = fields
    .filter((field) => field.stable_key_ordinal !== null)
    .sort(
      (left, right) =>
        (left.stable_key_ordinal as number) -
        (right.stable_key_ordinal as number),
    );
  const rows = options.rows.map((row) => {
    const keyPreimage = concat([
      uuidBytes(snapshotId),
      i64(BigInt(keyFields.length)),
      ...keyFields.flatMap((field) => [
        uuidBytes(field.field_id),
        typedValueBinary(field.scalar_type, row[field.field_id] as CellSpec),
      ]),
    ]);
    const rowId = uuidV8("dasher.input-row-id.v1", [
      uuidBytes(snapshotId),
      i64(BigInt(keyFields.length)),
      ...keyFields.flatMap((field) => [
        uuidBytes(field.field_id),
        typedValueBinary(field.scalar_type, row[field.field_id] as CellSpec),
      ]),
    ]);
    const sortKey = Array.from(
      keyPreimage.slice(uuidBytes(snapshotId).length),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return { row, rowId, sortKey };
  });
  rows.sort((left, right) =>
    left.sortKey === right.sortKey
      ? left.rowId < right.rowId
        ? -1
        : 1
      : left.sortKey < right.sortKey
        ? -1
        : 1,
  );
  const document: Json = {
    schema: "canonical-input-table-v1",
    input_snapshot_id: snapshotId,
    row_count: `i64:${rows.length}`,
    fields: fields.map((field) => ({
      field_id: field.field_id,
      scalar_type: field.scalar_type,
      nullable: field.nullable,
      stable_key_ordinal:
        field.stable_key_ordinal === null
          ? null
          : `i64:${field.stable_key_ordinal}`,
    })),
    rows: rows.map((entry) => ({
      row_id: entry.rowId,
      values: fields.map((field) => {
        const cell = entry.row[field.field_id] as CellSpec;
        return {
          field_id: field.field_id,
          state: cell.state,
          type: field.scalar_type,
          value: cell.state === "present" ? (cell.value as Json) : null,
        };
      }),
    })),
  };
  const bytes = canonical(document);
  return {
    bytes,
    sha256: rowHash("dasher.canonical-input-table.v1", bytes),
    rowIds: rows.map((entry) => entry.rowId),
    snapshotId,
    rowCount: rows.length,
  };
}

export interface BuiltCatalog {
  readonly bytes: string;
  readonly sha256: string;
  readonly snapshotId: string;
}

export function buildCatalog(options: {
  readonly catalogId?: string;
  readonly input: BuiltInput;
  readonly fields: readonly FieldSpec[];
  readonly evaluatedAt: string;
  readonly lineageEvidenceIds?: readonly string[];
}): BuiltCatalog {
  const catalogId = options.catalogId ?? uuid(102);
  const lineage = options.lineageEvidenceIds ?? [uuid(106)];
  const fields = [...options.fields].sort((left, right) =>
    left.field_id < right.field_id ? -1 : 1,
  );
  const document: Json = {
    schema: "field-catalog-snapshot-v1",
    catalog_snapshot_id: catalogId,
    input_snapshot_id: options.input.snapshotId,
    input_sha256: options.input.sha256,
    input_row_count: `i64:${options.input.rowCount}`,
    evaluated_at: options.evaluatedAt,
    fields: fields.map((field) => ({
      field_id: field.field_id,
      source_path: field.source_path ?? `/rows/*/${field.logical_name}`,
      logical_name: field.logical_name,
      scalar_type: field.scalar_type,
      nullable: field.nullable,
      semantic_type: field.semantic_type,
      unit: field.unit ?? null,
      currency: field.currency ?? null,
      grain: field.grain === undefined ? "row" : field.grain,
      event_time_field_id: field.event_time_field_id ?? null,
      stable_key_ordinal:
        field.stable_key_ordinal === null
          ? null
          : `i64:${field.stable_key_ordinal}`,
      max_value_bytes: `i64:${field.max_value_bytes}`,
      allowed_aggregations: [...(field.allowed_aggregations ?? [])].sort(),
      allowed_dimensions: [...(field.allowed_dimensions ?? [])].sort(),
      lineage_evidence_ids: [...(field.lineage_evidence_ids ?? lineage)].sort(),
    })),
  };
  const bytes = canonical(document);
  return {
    bytes,
    sha256: rowHash("dasher.field-catalog-snapshot.v1", bytes),
    snapshotId: catalogId,
  };
}

export interface NodeSpec {
  readonly node_id: string;
  readonly op: string;
  readonly output_type: Json;
  readonly evaluation_rows_from: string | null;
  readonly [key: string]: Json | undefined;
}

/** Node reference fields, used to compute the canonical topological order. */
const REFERENCE_FIELDS = [
  "input",
  "predicate",
  "left",
  "right",
  "condition",
  "when_true",
  "when_false",
  "group_node_id",
];

function referencesOf(node: NodeSpec): readonly string[] {
  const refs: string[] = [];
  for (const field of REFERENCE_FIELDS) {
    const value = node[field];
    if (typeof value === "string") refs.push(value);
  }
  for (const field of ["key_node_ids", "partition_node_ids", "inputs"]) {
    const value = node[field];
    if (Array.isArray(value)) {
      for (const entry of value)
        if (typeof entry === "string") refs.push(entry);
    }
  }
  const keys = node.keys;
  if (Array.isArray(keys)) {
    for (const key of keys) {
      const valueNode = (key as { value_node_id?: string }).value_node_id;
      if (typeof valueNode === "string") refs.push(valueNode);
    }
  }
  const projections = node.projections;
  if (Array.isArray(projections)) {
    for (const projection of projections) {
      const valueNode = (projection as { value_node_id?: string })
        .value_node_id;
      if (typeof valueNode === "string") refs.push(valueNode);
    }
  }
  if (node.evaluation_rows_from !== null) refs.push(node.evaluation_rows_from);
  return refs;
}

/** Orders nodes by choosing the lexicographically smallest ready UUID. */
export function canonicalNodeOrder(
  nodes: readonly NodeSpec[],
): readonly NodeSpec[] {
  const pending = new Map(
    nodes.map((node) => [node.node_id, new Set(referencesOf(node))]),
  );
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const emitted = new Set<string>();
  const order: NodeSpec[] = [];
  while (order.length < nodes.length) {
    const ready = [...pending.keys()]
      .filter(
        (id) =>
          !emitted.has(id) &&
          [...(pending.get(id) as Set<string>)].every((ref) =>
            emitted.has(ref),
          ),
      )
      .sort();
    const next = ready[0];
    if (next === undefined) throw new Error("fixture nodes do not form a DAG");
    emitted.add(next);
    order.push(byId.get(next) as NodeSpec);
  }
  return order;
}

/**
 * The placeholder a fixture carries when it binds no evidence bundle.
 *
 * It is deliberately arbitrary rather than a digest of anything: a graph that
 * actually binds a bundle passes that bundle's recomputed hash instead.
 */
export const UNBOUND_BUNDLE_SHA256 = "0".repeat(64);

export interface BuildGraphOptions {
  readonly graphId?: string;
  readonly nodes: readonly NodeSpec[];
  readonly outputNodeIds: readonly string[];
  readonly contractOutputNodeId: string;
  readonly thresholdNodeId?: string | null;
  readonly targetNodeId?: string | null;
  readonly input: BuiltInput;
  readonly catalog: BuiltCatalog;
  readonly contractSetId?: string;
  readonly contractId?: string;
  readonly contractVersion?: number;
  readonly bundleId?: string;
  readonly bundleSha256?: string;
  readonly evaluationTime: string;
  readonly timezone?: string;
  readonly fxEvidenceId?: string | null;
  readonly fxEvidenceSha256?: string | null;
}

export interface BuiltGraph {
  readonly bytes: string;
  readonly sha256: string;
}

export function buildGraph(options: BuildGraphOptions): BuiltGraph {
  const document: Json = {
    schema: "calculation-graph-v1",
    registry: "calculation-registry-v1",
    limits: "calculation-limits-v1",
    graph_id: options.graphId ?? uuid(107),
    contract_set_id: options.contractSetId ?? uuid(103),
    contract_id: options.contractId ?? uuid(104),
    contract_version: `i64:${options.contractVersion ?? 1}`,
    contract_output_node_id: options.contractOutputNodeId,
    threshold_node_id: options.thresholdNodeId ?? null,
    target_node_id: options.targetNodeId ?? null,
    input_snapshot_id: options.input.snapshotId,
    input_sha256: options.input.sha256,
    field_catalog_snapshot_id: options.catalog.snapshotId,
    field_catalog_sha256: options.catalog.sha256,
    common_bundle_id: options.bundleId ?? uuid(105),
    common_bundle_sha256: options.bundleSha256 ?? UNBOUND_BUNDLE_SHA256,
    evaluation_time: options.evaluationTime,
    timezone: options.timezone ?? "UTC",
    tzdb_version: "2025b",
    unit_registry_version: "ucum-subset-v1",
    fx_evidence_id: options.fxEvidenceId ?? null,
    fx_evidence_sha256: options.fxEvidenceSha256 ?? null,
    nodes: canonicalNodeOrder(options.nodes) as unknown as Json,
    output_node_ids: [...options.outputNodeIds].sort(),
  };
  const bytes = canonical(document);
  return { bytes, sha256: rowHash("dasher.calculation-graph.v1", bytes) };
}

export interface ContractSpec {
  readonly contract_id?: string;
  readonly version?: number;
  readonly business_owner_membership_id?: string;
  readonly data_owner_membership_id?: string;
  readonly name?: string;
  readonly definition?: string;
  readonly measure_field_id: string;
  readonly aggregation: string;
  readonly denominator_contract_id?: string | null;
  readonly denominator_contract_version?: number | null;
  readonly value_type: string;
  readonly unit?: string | null;
  readonly currency?: string | null;
  readonly direction?: string;
  readonly threshold?: string | null;
  readonly target?: string | null;
  readonly grain?: string;
  readonly lag_millis?: number;
  readonly freshness_slo_millis?: number;
  readonly allowed_dimension_field_ids?: readonly string[];
  readonly calendar?: string;
  readonly timezone?: string;
  readonly lineage_evidence_ids?: readonly string[];
}

export interface BuiltContractSet {
  readonly bytes: string;
  readonly sha256: string;
  readonly contractSetId: string;
}

export function buildContractSet(options: {
  readonly contractSetId?: string;
  readonly catalog: BuiltCatalog;
  readonly contracts: readonly ContractSpec[];
}): BuiltContractSet {
  const contractSetId = options.contractSetId ?? uuid(103);
  const document: Json = {
    schema: "metric-contract-set-v1",
    contract_set_id: contractSetId,
    catalog_snapshot_id: options.catalog.snapshotId,
    contracts: options.contracts.map((contract) => {
      const calendar = contract.calendar ?? "gregorian";
      const timezone = contract.timezone ?? "UTC";
      const dimensions = [
        ...(contract.allowed_dimension_field_ids ?? []),
      ].sort();
      return {
        contract_id: contract.contract_id ?? uuid(104),
        version: `i64:${contract.version ?? 1}`,
        business_owner_membership_id:
          contract.business_owner_membership_id ?? uuid(109),
        data_owner_membership_id:
          contract.data_owner_membership_id ?? uuid(110),
        name: contract.name ?? "Fixture metric",
        definition: contract.definition ?? "A deterministic fixture metric.",
        measure_field_id: contract.measure_field_id,
        aggregation: contract.aggregation,
        denominator_contract_id: contract.denominator_contract_id ?? null,
        denominator_contract_version:
          contract.denominator_contract_version === undefined ||
          contract.denominator_contract_version === null
            ? null
            : `i64:${contract.denominator_contract_version}`,
        value_type: contract.value_type,
        unit: contract.unit ?? null,
        currency: contract.currency ?? null,
        direction: contract.direction ?? "neutral",
        threshold: contract.threshold ?? null,
        target: contract.target ?? null,
        grain: contract.grain ?? groupGrain(calendar, timezone, dimensions),
        lag_millis: `i64:${contract.lag_millis ?? 0}`,
        freshness_slo_millis: `i64:${contract.freshness_slo_millis ?? 86400000}`,
        allowed_dimension_field_ids: dimensions,
        calendar,
        timezone,
        lineage_evidence_ids: [
          ...(contract.lineage_evidence_ids ?? [uuid(106)]),
        ].sort(),
        review_state: "reviewed",
      };
    }),
  };
  const bytes = canonical(document);
  return {
    bytes,
    sha256: rowHash("dasher.metric-contract-set.v1", bytes),
    contractSetId,
  };
}

export interface BuiltBundle {
  readonly bytes: string;
  readonly sha256: string;
  readonly bundleId: string;
}

export function buildBundle(options: {
  readonly bundleId?: string;
  readonly input: BuiltInput;
  readonly entries: ReadonlyArray<{
    readonly evidence_id: string;
    readonly evidence_sha256: string;
    readonly freshness?: "current" | "stale";
    readonly observed_at: string;
  }>;
}): BuiltBundle {
  const bundleId = options.bundleId ?? uuid(105);
  const document: Json = {
    schema: "common-evidence-bundle-v1",
    bundle_id: bundleId,
    source_snapshot_id: options.input.snapshotId,
    entries: [...options.entries]
      .sort((left, right) => (left.evidence_id < right.evidence_id ? -1 : 1))
      .map((entry) => ({
        evidence_id: entry.evidence_id,
        evidence_sha256: entry.evidence_sha256,
        source_snapshot_id: options.input.snapshotId,
        source_sha256: options.input.sha256,
        freshness: entry.freshness ?? "current",
        observed_at: entry.observed_at,
      })),
  };
  const bytes = canonical(document);
  return {
    bytes,
    sha256: rowHash("dasher.common-evidence-bundle.v1", bytes),
    bundleId,
  };
}

/* ------------------------------------------------------------------ *
 * Output-type helpers
 * ------------------------------------------------------------------ */

export function scalarOut(options: {
  readonly scalar: string;
  readonly nullable: boolean;
  readonly width: number;
  readonly unit?: string | null;
  readonly currency?: string | null;
  readonly grain?: string | null;
}): Json {
  return {
    shape: "scalar",
    scalar: options.scalar,
    nullable: options.nullable,
    unit: options.unit ?? null,
    currency: options.currency ?? null,
    grain: options.grain ?? null,
    max_value_bytes: `i64:${options.width}`,
    fields: null,
  };
}

export function rowsetOut(fields: readonly Json[]): Json {
  return {
    shape: "rowset",
    scalar: null,
    nullable: null,
    unit: null,
    currency: null,
    grain: null,
    max_value_bytes: null,
    fields: [...fields].sort((left, right) =>
      (left as { field_id: string }).field_id <
      (right as { field_id: string }).field_id
        ? -1
        : 1,
    ),
  };
}

export function fieldOut(field: FieldSpec): Json {
  return {
    field_id: field.field_id,
    name: field.logical_name,
    scalar: field.scalar_type,
    nullable: field.nullable,
    unit: field.unit ?? null,
    currency: field.currency ?? null,
    grain: field.grain === undefined ? "row" : field.grain,
    max_value_bytes: `i64:${field.max_value_bytes}`,
  };
}

/** The `group:` grain digest, recomputed independently of the engine. */
export function groupGrain(
  calendar: string,
  timezone: string,
  fieldIds: readonly string[],
): string {
  const sorted = [...fieldIds].sort();
  const digest = createHash("sha256")
    .update(
      concat([
        encoder.encode("dasher.metric-group-grain.v1\0"),
        text(calendar),
        text(timezone),
        i64(BigInt(sorted.length)),
        ...sorted.map((id) => uuidBytes(id)),
      ]),
    )
    .digest("hex");
  return `group:${digest}`;
}

/** The derived `select` projection field UUID. */
export function selectFieldId(
  selectNodeId: string,
  ordinal: number,
  name: string,
  valueNodeId: string,
): string {
  return uuidV8("dasher.derived-field.v1", [
    uuidBytes(selectNodeId),
    i64(BigInt(ordinal)),
    text(name),
    uuidBytes(valueNodeId),
  ]);
}

/** The derived `group` key field UUID. */
export function groupFieldId(
  groupNodeId: string,
  ordinal: number,
  keyNodeId: string,
): string {
  return uuidV8("dasher.derived-field.v1", [
    uuidBytes(groupNodeId),
    text("key"),
    i64(BigInt(ordinal)),
    uuidBytes(keyNodeId),
  ]);
}

export function decimal(coefficient: string, scale: number): Json {
  return { coefficient, scale: `i64:${scale}` };
}

export function literalValue(
  type: string,
  value: Json | null,
  state = "present",
): Json {
  return { state, type, value };
}
