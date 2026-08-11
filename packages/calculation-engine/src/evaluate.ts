/**
 * Deterministic runtime evaluation of a validated `calculation-graph-v1` graph.
 *
 * Evaluation walks the canonical topological order, applies the frozen state and
 * quantization rules, and meters every dimension with checked signed-64
 * arithmetic. The engine has no clock, process, or host-memory dependency: the
 * external wall-clock and process ceilings are non-semantic defences enforced
 * outside it and never enter any hash.
 */

import {
  type CanonicalObject,
  type CanonicalValue,
  canonicalBinaryI64,
  canonicalBinaryShaBytes,
  canonicalBinaryText,
  canonicalBinaryUuid,
  compareBytes,
  compareUtf8,
  jcsEncode,
  rowHash,
  utf8ByteLength,
  uuidV8,
} from "./canonical";
import {
  type CanonicalDecimal,
  type Rational,
  type Rounding,
  canonicalizeDecimal,
  coefficientDigits,
  decimalToRational,
  integerToRational,
  quantize,
  ratAdd,
  ratCompare,
  ratDivide,
  ratMultiply,
  ratSubtract,
  rational,
} from "./decimal";
import {
  GROUPED_AGGREGATE_OPS,
  LIMITS,
  LIMITS_NAME,
  type Op,
  REGISTRY_NAME,
  ROWSET_OPS,
  type ScalarType,
  type StepCounts,
  convertCurrencyValue,
  convertUnitValue,
  lookupCurrency,
  primitiveStepCharge,
} from "./registry";
import {
  type ErrorCode,
  type GraphNode,
  type OutputFieldType,
  type OutputType,
  type RuntimeValue,
  type ScalarPayload,
  CalculationFailure,
  encodeOutputType,
  encodeTypedValue,
  fail,
} from "./schema";
import {
  type ValidatedGraph,
  deriveGroupRowId,
  requireLimits,
} from "./validate";

const RESULT_ID_DOMAIN = "dasher.calculation-result-id.v1";
const RESULT_DOMAIN = "dasher.calculation-result.v1";
const METER_DOMAIN = "dasher.calculation-meter.v1";
const OUTPUT_DOMAIN = "dasher.calculation-output.v1";
const OUTPUT_VALUE_DOMAIN = "dasher.calculation-output-value.v1";

export interface RuntimeMeter {
  readonly input_bytes: bigint;
  readonly ast_bytes: bigint;
  readonly node_count: bigint;
  readonly max_depth: bigint;
  readonly max_literal_bytes: bigint;
  readonly total_literal_bytes: bigint;
  readonly max_literal_list_length: bigint;
  readonly scanned_rows: bigint;
  readonly group_count: bigint;
  readonly max_group_rows: bigint;
  readonly cumulative_intermediate_rows: bigint;
  readonly final_output_rows: bigint;
  readonly cumulative_intermediate_bytes: bigint;
  readonly output_bytes: bigint;
  readonly primitive_steps: bigint;
  readonly logical_allocation_bytes: bigint;
  readonly max_top_k: bigint;
  readonly max_window_frame: bigint;
  readonly max_coefficient_digits: bigint;
  readonly max_scale: bigint;
}

export interface CalculationOutcome {
  readonly state: "succeeded" | "failed";
  readonly error_code: ErrorCode | null;
  readonly result_id: string;
  readonly resultBytes: string;
  readonly result_sha256: string;
  readonly meterBytes: string;
  readonly meter_sha256: string;
  readonly meter: RuntimeMeter;
  readonly outputBytes: string;
  /** Per-node intermediate JCS byte lengths in canonical node order. */
  readonly intermediateByteVector: readonly bigint[];
  readonly outputEntrySha256: ReadonlyMap<string, string>;
}

interface RowsetRow {
  readonly row_id: string;
  readonly cells: ReadonlyMap<string, RuntimeValue>;
}

interface ScalarRow {
  readonly row_id: string;
  readonly value: RuntimeValue;
}

interface RowsetOutput {
  readonly kind: "rowset";
  readonly rows: readonly RowsetRow[];
}

interface ScalarOutput {
  readonly kind: "scalar";
  readonly rows: readonly ScalarRow[];
}

type NodeOutput = RowsetOutput | ScalarOutput;

const STATE_RANK: Record<RuntimeValue["state"], number> = {
  unavailable: 0,
  missing: 1,
  null: 2,
  present: 3,
  stale: 4,
};

const TYPE_BYTE: Record<ScalarType, number> = {
  boolean: 0x00,
  integer: 0x01,
  decimal: 0x02,
  text: 0x03,
  date: 0x04,
  timestamp: 0x05,
  duration: 0x06,
};

const STATE_BYTE: Record<RuntimeValue["state"], number> = {
  present: 0x00,
  null: 0x01,
  missing: 0x02,
  unavailable: 0x03,
  stale: 0x04,
};

function checkedAddOrFail(left: bigint, right: bigint): bigint {
  const sum = left + right;
  if (sum > 9223372036854775807n || sum < -9223372036854775808n) {
    fail("limit_exceeded", "checked signed-64 addition overflowed");
  }
  return sum;
}

function checkedMultiplyOrFail(left: bigint, right: bigint): bigint {
  const product = left * right;
  if (product > 9223372036854775807n || product < -9223372036854775808n) {
    fail("limit_exceeded", "checked signed-64 multiplication overflowed");
  }
  return product;
}

/* ------------------------------------------------------------------ *
 * Canonical-binary typed value for row IDs and sort keys
 * ------------------------------------------------------------------ */

function encodeTypedValueBinary(value: RuntimeValue): Uint8Array {
  const header = new Uint8Array([
    TYPE_BYTE[value.type],
    STATE_BYTE[value.state],
  ]);
  if (value.value === null) return header;
  const payload = encodePayloadBinary(value.type, value.value);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

function encodePayloadBinary(
  type: ScalarType,
  payload: ScalarPayload,
): Uint8Array {
  switch (type) {
    case "boolean":
      return new Uint8Array([payload === true ? 0x01 : 0x00]);
    case "integer":
    case "timestamp":
    case "duration":
      return canonicalBinaryI64(payload as bigint);
    case "date": {
      const out = new Uint8Array(4);
      const value = BigInt.asUintN(32, payload as bigint);
      out[0] = Number((value >> 24n) & 0xffn);
      out[1] = Number((value >> 16n) & 0xffn);
      out[2] = Number((value >> 8n) & 0xffn);
      out[3] = Number(value & 0xffn);
      return out;
    }
    case "decimal": {
      const decimal = payload as CanonicalDecimal;
      const out = new Uint8Array(17);
      let remaining = BigInt.asUintN(128, decimal.coefficient);
      for (let index = 15; index >= 0; index -= 1) {
        out[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
      }
      out[16] = Number(decimal.scale);
      return out;
    }
    case "text":
      return canonicalBinaryText(payload as string);
  }
}

/* ------------------------------------------------------------------ *
 * Value comparison
 * ------------------------------------------------------------------ */

function payloadRational(value: RuntimeValue): Rational {
  if (value.type === "decimal") {
    return decimalToRational(value.value as CanonicalDecimal);
  }
  return integerToRational(value.value as bigint);
}

/** Signed numeric, temporal, boolean, and unsigned UTF-8 text order. */
function comparePayloads(
  type: ScalarType,
  left: ScalarPayload,
  right: ScalarPayload,
): -1 | 0 | 1 {
  switch (type) {
    case "boolean": {
      const a = left === true ? 1 : 0;
      const b = right === true ? 1 : 0;
      return a === b ? 0 : a < b ? -1 : 1;
    }
    case "integer":
    case "date":
    case "timestamp":
    case "duration": {
      const a = left as bigint;
      const b = right as bigint;
      return a === b ? 0 : a < b ? -1 : 1;
    }
    case "decimal":
      return ratCompare(
        decimalToRational(left as CanonicalDecimal),
        decimalToRational(right as CanonicalDecimal),
      );
    case "text":
      return compareUtf8(left as string, right as string);
  }
}

/* ------------------------------------------------------------------ *
 * Exact decimal materialization
 * ------------------------------------------------------------------ */

/** Exact base-10 rendering of a terminating rational, or null when it does not terminate. */
function rationalToExactDecimal(value: Rational): CanonicalDecimal | null {
  let denominator = value.d;
  let scale = 0n;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    scale += 1n;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    scale += 1n;
  }
  if (denominator !== 1n) return null;
  if (scale > LIMITS.scale) return null;
  const coefficient = (value.n * 10n ** scale) / value.d;
  return canonicalizeDecimal(coefficient, scale);
}

function decimalValue(value: CanonicalDecimal, stale: boolean): RuntimeValue {
  return { state: stale ? "stale" : "present", type: "decimal", value };
}

/* ------------------------------------------------------------------ *
 * Evaluator
 * ------------------------------------------------------------------ */

class Evaluator {
  private readonly outputs = new Map<string, NodeOutput>();
  private readonly groupMembership = new Map<
    string,
    ReadonlyMap<string, string>
  >();
  private readonly intermediateBytes: bigint[] = [];

  scannedRows = 0n;
  groupCount = 0n;
  maxGroupRows = 0n;
  intermediateRows = 0n;
  cumulativeIntermediateBytes = 0n;
  primitiveSteps = 0n;
  maxScale = 0n;
  maxDigits = 0n;

  constructor(private readonly validated: ValidatedGraph) {}

  private typeOf(nodeId: string): OutputType {
    return this.validated.derivedTypes.get(nodeId) as OutputType;
  }

  private nodeOf(nodeId: string): GraphNode {
    return this.validated.nodesById.get(nodeId) as GraphNode;
  }

  private rowsetOf(nodeId: string): RowsetOutput {
    const output = this.outputs.get(nodeId);
    if (output === undefined || output.kind !== "rowset") {
      fail("type_mismatch", `node ${nodeId} is not a rowset`);
    }
    return output;
  }

  private scalarOf(nodeId: string): ScalarOutput {
    const output = this.outputs.get(nodeId);
    if (output === undefined || output.kind !== "scalar") {
      fail("type_mismatch", `node ${nodeId} is not a scalar`);
    }
    return output;
  }

  private observeDecimal(value: CanonicalDecimal): void {
    if (value.scale > this.maxScale) this.maxScale = value.scale;
    const digits = coefficientDigits(value.coefficient);
    if (digits > this.maxDigits) this.maxDigits = digits;
  }

  private observe(value: RuntimeValue): RuntimeValue {
    if (value.type === "decimal" && value.value !== null) {
      this.observeDecimal(value.value as CanonicalDecimal);
    }
    return value;
  }

  run(): {
    outputs: ReadonlyMap<string, NodeOutput>;
    intermediateByteVector: readonly bigint[];
  } {
    for (const node of this.validated.order) {
      const output = this.evaluateNode(node);
      this.outputs.set(node.node_id, output);
      this.chargeSteps(node, output);
      const rows = BigInt(output.rows.length);
      if (node.op === "source") {
        this.scannedRows = checkedAddOrFail(this.scannedRows, rows);
      }
      if (!this.validated.graph.output_node_ids.includes(node.node_id)) {
        this.intermediateRows = checkedAddOrFail(this.intermediateRows, rows);
        const bytes = utf8ByteLength(this.encodeIntermediate(node, output));
        this.intermediateBytes.push(bytes);
        this.cumulativeIntermediateBytes = checkedAddOrFail(
          this.cumulativeIntermediateBytes,
          bytes,
        );
      }
    }
    return {
      outputs: this.outputs,
      intermediateByteVector: this.intermediateBytes,
    };
  }

  private chargeSteps(node: GraphNode, output: NodeOutput): void {
    const counts = this.stepCounts(node, output);
    this.primitiveSteps = checkedAddOrFail(
      this.primitiveSteps,
      primitiveStepCharge(node.op as Op, counts),
    );
    if (this.primitiveSteps > LIMITS.primitiveSteps) {
      fail("limit_exceeded", "primitive steps exceeded the inclusive ceiling");
    }
  }

  private stepCounts(node: GraphNode, output: NodeOutput): StepCounts {
    let n: bigint;
    if (node.op === "source") {
      n = BigInt(output.rows.length);
    } else if (GROUPED_AGGREGATE_OPS.has(node.op)) {
      const group = this.nodeOf(node.group_node_id as string);
      n = BigInt(this.rowsetOf(group.input as string).rows.length);
    } else if (ROWSET_OPS.has(node.op)) {
      n = BigInt(this.rowsetOf(node.input as string).rows.length);
    } else {
      n = BigInt(
        this.rowsetOf(node.evaluation_rows_from as string).rows.length,
      );
    }
    return {
      n,
      g: node.op === "group" ? BigInt(output.rows.length) : 0n,
      gk: BigInt((node.key_node_ids ?? []).length),
      sk: BigInt((node.keys ?? []).length),
      pk: BigInt((node.partition_node_ids ?? []).length),
      q: node.k ?? 0n,
      s: this.validated.sortCertificates.get(node.input ?? "") ?? 0n,
      a: BigInt((node.inputs ?? []).length),
      p: BigInt((node.projections ?? []).length),
      w:
        node.preceding !== undefined && node.following !== undefined
          ? 1n + node.preceding + node.following
          : 0n,
    };
  }

  private encodeIntermediate(node: GraphNode, output: NodeOutput): string {
    const type = this.typeOf(node.node_id);
    if (output.kind === "rowset") {
      return jcsEncode({
        schema: "calculation-node-rowset-v1",
        node_id: node.node_id,
        output_type: encodeOutputType(type),
        rows: this.encodeRowsetRows(type, output.rows),
      });
    }
    return jcsEncode({
      schema: "calculation-node-scalar-v1",
      node_id: node.node_id,
      output_type: encodeOutputType(type),
      evaluation_rows_from: node.evaluation_rows_from,
      rows: this.encodeScalarRows(output.rows),
    });
  }

  encodeRowsetRows(
    type: OutputType,
    rows: readonly RowsetRow[],
  ): readonly CanonicalValue[] {
    const fields = type.fields ?? [];
    return rows.map((row, index) => ({
      ordinal: `i64:${index}`,
      row_id: row.row_id,
      cells: fields.map((field: OutputFieldType) => ({
        field_id: field.field_id,
        value: encodeTypedValue(row.cells.get(field.field_id) as RuntimeValue),
      })),
    }));
  }

  encodeScalarRows(rows: readonly ScalarRow[]): readonly CanonicalValue[] {
    return rows.map((row, index) => ({
      ordinal: `i64:${index}`,
      row_id: row.row_id,
      value: encodeTypedValue(row.value),
    }));
  }

  /* ---------------------------------------------------------------- *
   * Per-operation evaluation
   * ---------------------------------------------------------------- */

  private evaluateNode(node: GraphNode): NodeOutput {
    switch (node.op) {
      case "source": {
        const fields = node.field_ids ?? [];
        const rows = this.validated.input.rows.map((row) => {
          const cells = new Map<string, RuntimeValue>();
          for (const fieldId of fields) {
            cells.set(
              fieldId,
              this.observe(row.values.get(fieldId) as RuntimeValue),
            );
          }
          return { row_id: row.row_id, cells };
        });
        return { kind: "rowset", rows };
      }
      case "field": {
        const input = this.rowsetOf(node.input as string);
        return {
          kind: "scalar",
          rows: input.rows.map((row) => ({
            row_id: row.row_id,
            value: row.cells.get(node.field_id as string) as RuntimeValue,
          })),
        };
      }
      case "literal": {
        const domain = this.rowsetOf(node.evaluation_rows_from as string);
        const literal = this.observe(node.literal as RuntimeValue);
        return {
          kind: "scalar",
          rows: domain.rows.map((row) => ({
            row_id: row.row_id,
            value: literal,
          })),
        };
      }
      case "select": {
        const input = this.rowsetOf(node.input as string);
        const type = this.typeOf(node.node_id);
        const projections = node.projections ?? [];
        const columns = projections.map((projection) => ({
          field_id: projection.field_id,
          values: this.scalarOf(projection.value_node_id).rows,
        }));
        const rows = input.rows.map((row, index) => {
          const cells = new Map<string, RuntimeValue>();
          for (const column of columns) {
            cells.set(
              column.field_id,
              (column.values[index] as ScalarRow).value,
            );
          }
          return { row_id: row.row_id, cells };
        });
        void type;
        return { kind: "rowset", rows };
      }
      case "filter": {
        const input = this.rowsetOf(node.input as string);
        const predicate = this.scalarOf(node.predicate as string).rows;
        const rows = input.rows.filter((_, index) => {
          const value = (predicate[index] as ScalarRow).value;
          return (
            (value.state === "present" || value.state === "stale") &&
            value.value === true
          );
        });
        return { kind: "rowset", rows };
      }
      case "sort": {
        const input = this.rowsetOf(node.input as string);
        const keys = (node.keys ?? []).map((key) => ({
          spec: key,
          values: this.scalarOf(key.value_node_id).rows,
        }));
        const indexed = input.rows.map((row, index) => ({ row, index }));
        indexed.sort((left, right) => {
          for (const key of keys) {
            const a = (key.values[left.index] as ScalarRow).value;
            const b = (key.values[right.index] as ScalarRow).value;
            const comparison = compareSortKey(
              a,
              b,
              key.spec.direction,
              key.spec.nulls,
            );
            if (comparison !== 0) return comparison;
          }
          return compareUtf8(left.row.row_id, right.row.row_id);
        });
        return { kind: "rowset", rows: indexed.map((entry) => entry.row) };
      }
      case "top_k": {
        const input = this.rowsetOf(node.input as string);
        const q = Number(node.k as bigint);
        return { kind: "rowset", rows: input.rows.slice(0, q) };
      }
      case "group":
        return this.evaluateGroup(node);
      case "rank":
        return this.evaluateRank(node);
      case "count_rows":
      case "count_present":
      case "sum":
      case "min":
      case "max":
      case "mean":
        return this.evaluateAggregate(node);
      case "lag":
      case "delta":
      case "percentage_change":
        return this.evaluateLagFamily(node);
      case "window_sum":
      case "window_mean":
        return this.evaluateWindow(node);
      default:
        return this.evaluateScalarwise(node);
    }
  }

  private evaluateGroup(node: GraphNode): NodeOutput {
    const inputId = node.input as string;
    const input = this.rowsetOf(inputId);
    const keyNodeIds = node.key_node_ids ?? [];
    const keyColumns = keyNodeIds.map((id) => this.scalarOf(id).rows);
    const type = this.typeOf(node.node_id);
    const fields = type.fields ?? [];

    // The first unavailable, missing, or null key denies before any construction.
    for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
      for (const column of keyColumns) {
        const value = (column[rowIndex] as ScalarRow).value;
        if (value.state !== "present" && value.state !== "stale") {
          this.primitiveSteps = checkedAddOrFail(
            this.primitiveSteps,
            checkedMultiplyOrFail(
              BigInt(input.rows.length),
              BigInt(keyNodeIds.length),
            ),
          );
          fail(
            "invalid_group_key",
            "an absent group key was rejected before grouping",
          );
        }
      }
    }

    if (keyNodeIds.length === 0) {
      const rowId = deriveGroupRowId(node.node_id, [], encodeTypedValueBinary);
      const membership = new Map<string, string>();
      for (const row of input.rows) membership.set(row.row_id, rowId);
      this.groupMembership.set(node.node_id, membership);
      this.groupCount = this.groupCount < 1n ? 1n : this.groupCount;
      const size = BigInt(input.rows.length);
      if (size > this.maxGroupRows) this.maxGroupRows = size;
      return { kind: "rowset", rows: [{ row_id: rowId, cells: new Map() }] };
    }

    const groups = new Map<
      string,
      {
        readonly rowId: string;
        readonly keys: readonly RuntimeValue[];
        readonly tuple: Uint8Array;
        members: string[];
      }
    >();
    const membership = new Map<string, string>();
    for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
      const keys = keyColumns.map(
        (column) => (column[rowIndex] as ScalarRow).value,
      );
      const encoded = keys.map(encodeTypedValueBinary);
      let total = 0;
      for (const part of encoded) total += part.length;
      const tuple = new Uint8Array(total);
      let offset = 0;
      for (const part of encoded) {
        tuple.set(part, offset);
        offset += part.length;
      }
      const digest = Array.from(tuple, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      let group = groups.get(digest);
      if (group === undefined) {
        group = {
          rowId: deriveGroupRowId(node.node_id, keys, encodeTypedValueBinary),
          keys,
          tuple,
          members: [],
        };
        groups.set(digest, group);
      }
      group.members.push((input.rows[rowIndex] as RowsetRow).row_id);
      membership.set((input.rows[rowIndex] as RowsetRow).row_id, group.rowId);
    }
    const ordered = [...groups.values()].sort((left, right) => {
      const comparison = compareBytes(left.tuple, right.tuple);
      return comparison !== 0
        ? comparison
        : compareUtf8(left.rowId, right.rowId);
    });
    this.groupMembership.set(node.node_id, membership);
    const count = BigInt(ordered.length);
    if (count > this.groupCount) this.groupCount = count;
    if (count > LIMITS.groups)
      fail("limit_exceeded", "group count exceeded its ceiling");
    for (const group of ordered) {
      const size = BigInt(group.members.length);
      if (size > this.maxGroupRows) this.maxGroupRows = size;
      if (size > LIMITS.rowsInGroup) {
        fail("limit_exceeded", "one group exceeded its row ceiling");
      }
    }
    const rows = ordered.map((group) => {
      const cells = new Map<string, RuntimeValue>();
      group.keys.forEach((key, index) => {
        cells.set((fields[index] as OutputFieldType).field_id, key);
      });
      return { row_id: group.rowId, cells };
    });
    return { kind: "rowset", rows };
  }

  private partitionKeyOf(node: GraphNode, rowIndex: number): string {
    const partitions = (node.partition_node_ids ?? []).map(
      (id) => this.scalarOf(id).rows,
    );
    return partitions
      .map((column) => {
        const value = (column[rowIndex] as ScalarRow).value;
        return Array.from(encodeTypedValueBinary(value), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      })
      .join("|");
  }

  /** Orders the rows of a partition by the node's total key schema. */
  private orderedPartitions(
    node: GraphNode,
  ): ReadonlyMap<string, readonly number[]> {
    const domain = this.rowsetOf(node.evaluation_rows_from as string);
    const keys = (node.keys ?? []).map((key) => ({
      spec: key,
      values: this.scalarOf(key.value_node_id).rows,
    }));
    const partitions = new Map<string, number[]>();
    for (let index = 0; index < domain.rows.length; index += 1) {
      const key = this.partitionKeyOf(node, index);
      const bucket = partitions.get(key) ?? [];
      bucket.push(index);
      partitions.set(key, bucket);
    }
    for (const [key, indexes] of partitions) {
      const sorted = [...indexes].sort((left, right) => {
        for (const entry of keys) {
          const a = (entry.values[left] as ScalarRow).value;
          const b = (entry.values[right] as ScalarRow).value;
          const comparison = compareSortKey(
            a,
            b,
            entry.spec.direction,
            entry.spec.nulls,
          );
          if (comparison !== 0) return comparison;
        }
        return compareUtf8(
          (domain.rows[left] as RowsetRow).row_id,
          (domain.rows[right] as RowsetRow).row_id,
        );
      });
      partitions.set(key, sorted);
    }
    return partitions;
  }

  private evaluateRank(node: GraphNode): NodeOutput {
    const domain = this.rowsetOf(node.evaluation_rows_from as string);
    const partitions = this.orderedPartitions(node);
    const ranks = new Array<bigint>(domain.rows.length).fill(0n);
    for (const indexes of partitions.values()) {
      indexes.forEach((rowIndex, position) => {
        ranks[rowIndex] = BigInt(position + 1);
      });
    }
    return {
      kind: "scalar",
      rows: domain.rows.map((row, index) => ({
        row_id: row.row_id,
        value: {
          state: "present" as const,
          type: "integer" as const,
          value: ranks[index] as bigint,
        },
      })),
    };
  }

  private evaluateAggregate(node: GraphNode): NodeOutput {
    const groupId = node.group_node_id as string;
    const groupNode = this.nodeOf(groupId);
    const groupOutput = this.rowsetOf(groupId);
    const inputRows = this.rowsetOf(groupNode.input as string).rows;
    const membership = this.groupMembership.get(groupId) as ReadonlyMap<
      string,
      string
    >;
    const values =
      node.op === "count_rows"
        ? null
        : this.scalarOf(node.input as string).rows;
    const outputType = this.typeOf(node.node_id);

    const byGroup = new Map<string, RuntimeValue[]>();
    const memberCount = new Map<string, number>();
    for (let index = 0; index < inputRows.length; index += 1) {
      const rowId = (inputRows[index] as RowsetRow).row_id;
      const groupRowId = membership.get(rowId) as string;
      memberCount.set(groupRowId, (memberCount.get(groupRowId) ?? 0) + 1);
      if (values !== null) {
        const bucket = byGroup.get(groupRowId) ?? [];
        bucket.push((values[index] as ScalarRow).value);
        byGroup.set(groupRowId, bucket);
      }
    }

    const rows = groupOutput.rows.map((groupRow) => {
      const contributors = byGroup.get(groupRow.row_id) ?? [];
      const value = this.aggregateOne(node, outputType, contributors, {
        memberCount: BigInt(memberCount.get(groupRow.row_id) ?? 0),
      });
      return { row_id: groupRow.row_id, value: this.observe(value) };
    });
    return { kind: "scalar", rows };
  }

  private aggregateOne(
    node: GraphNode,
    outputType: OutputType,
    contributors: readonly RuntimeValue[],
    context: { readonly memberCount: bigint },
  ): RuntimeValue {
    if (node.op === "count_rows") {
      return { state: "present", type: "integer", value: context.memberCount };
    }
    if (contributors.some((value) => value.state === "unavailable")) {
      return {
        state: "unavailable",
        type: outputType.scalar as ScalarType,
        value: null,
      };
    }
    const computable = contributors.filter(
      (value) => value.state === "present" || value.state === "stale",
    );
    const stale = computable.some((value) => value.state === "stale");
    if (node.op === "count_present") {
      return {
        state: computable.length > 0 && stale ? "stale" : "present",
        type: "integer",
        value: BigInt(computable.length),
      };
    }
    if (node.op === "sum") {
      if (computable.length === 0) {
        return decimalValue({ coefficient: 0n, scale: 0n }, false);
      }
      let total = rational(0n, 1n);
      for (const value of computable)
        total = ratAdd(total, payloadRational(value));
      const exact = rationalToExactDecimal(total);
      if (exact === null)
        fail("overflow", "the exact sum is not representable");
      if (coefficientDigits(exact.coefficient) > LIMITS.coefficientDigits) {
        fail("overflow", "the exact sum exceeds 38 coefficient digits");
      }
      return decimalValue(exact, stale);
    }
    if (computable.length === 0) {
      fail("empty_input", `${node.op} has no present or stale contributor`);
    }
    if (node.op === "min" || node.op === "max") {
      let best = computable[0] as RuntimeValue;
      for (const candidate of computable.slice(1)) {
        const comparison = comparePayloads(
          best.type,
          candidate.value as ScalarPayload,
          best.value as ScalarPayload,
        );
        if (node.op === "min" ? comparison < 0 : comparison > 0)
          best = candidate;
      }
      return {
        state: stale ? "stale" : "present",
        type: best.type,
        value: best.value,
      };
    }
    let total = rational(0n, 1n);
    for (const value of computable)
      total = ratAdd(total, payloadRational(value));
    const mean = ratDivide(total, rational(BigInt(computable.length), 1n));
    if (mean === null) fail("divide_by_zero", "mean divided by a zero count");
    return decimalValue(
      this.quantizeOrFail(
        mean,
        node.scale as bigint,
        node.rounding as Rounding,
      ),
      stale,
    );
  }

  private quantizeOrFail(
    value: Rational,
    scale: bigint,
    rounding: Rounding,
  ): CanonicalDecimal {
    const quantized = quantize(value, scale, rounding);
    if (!quantized.ok) {
      fail(
        quantized.reason === "overflow" ? "overflow" : "inexact_arithmetic",
        "the one final quantization failed",
      );
    }
    return quantized.value;
  }

  private evaluateLagFamily(node: GraphNode): NodeOutput {
    const domain = this.rowsetOf(node.evaluation_rows_from as string);
    const inputRows = this.scalarOf(node.input as string).rows;
    const outputType = this.typeOf(node.node_id);
    const partitions = this.orderedPartitions(node);
    const offset = Number(node.offset as bigint);
    const lagged = new Array<RuntimeValue | null>(domain.rows.length).fill(
      null,
    );
    for (const indexes of partitions.values()) {
      indexes.forEach((rowIndex, position) => {
        const source = position - offset;
        lagged[rowIndex] =
          source >= 0
            ? (inputRows[indexes[source] as number] as ScalarRow).value
            : null;
      });
    }
    const rows = domain.rows.map((row, index) => {
      const current = (inputRows[index] as ScalarRow).value;
      const previous = lagged[index] ?? null;
      if (node.op === "lag") {
        const value: RuntimeValue =
          previous === null
            ? {
                state: "missing",
                type: outputType.scalar as ScalarType,
                value: null,
              }
            : previous;
        return { row_id: row.row_id, value };
      }
      const operands: readonly RuntimeValue[] =
        previous === null
          ? [current, { state: "missing", type: current.type, value: null }]
          : [current, previous];
      const propagated = propagateState(
        operands,
        outputType.scalar as ScalarType,
      );
      if (propagated !== null) return { row_id: row.row_id, value: propagated };
      const stale = operands.some((operand) => operand.state === "stale");
      const currentRational = payloadRational(current);
      const lagRational = payloadRational(operands[1] as RuntimeValue);
      if (node.op === "delta") {
        const difference = ratSubtract(currentRational, lagRational);
        return {
          row_id: row.row_id,
          value: this.observe(
            decimalValue(
              this.quantizeOrFail(
                difference,
                node.scale as bigint,
                node.rounding as Rounding,
              ),
              stale,
            ),
          ),
        };
      }
      const ratio = ratDivide(
        ratSubtract(currentRational, lagRational),
        lagRational,
      );
      if (ratio === null)
        fail("divide_by_zero", "percentage_change divided by a zero lag");
      const scaled = ratMultiply(ratio, rational(100n, 1n));
      return {
        row_id: row.row_id,
        value: this.observe(
          decimalValue(
            this.quantizeOrFail(
              scaled,
              node.scale as bigint,
              node.rounding as Rounding,
            ),
            stale,
          ),
        ),
      };
    });
    return { kind: "scalar", rows };
  }

  private evaluateWindow(node: GraphNode): NodeOutput {
    const domain = this.rowsetOf(node.evaluation_rows_from as string);
    const inputRows = this.scalarOf(node.input as string).rows;
    const partitions = this.orderedPartitions(node);
    const preceding = Number(node.preceding as bigint);
    const following = Number(node.following as bigint);
    const results = new Array<RuntimeValue | null>(domain.rows.length).fill(
      null,
    );
    for (const indexes of partitions.values()) {
      indexes.forEach((rowIndex, position) => {
        const start = Math.max(0, position - preceding);
        const end = Math.min(indexes.length - 1, position + following);
        const frame: RuntimeValue[] = [];
        for (let cursor = start; cursor <= end; cursor += 1) {
          frame.push((inputRows[indexes[cursor] as number] as ScalarRow).value);
        }
        if (frame.some((value) => value.state === "unavailable")) {
          results[rowIndex] = {
            state: "unavailable",
            type: "decimal",
            value: null,
          };
          return;
        }
        const computable = frame.filter(
          (value) => value.state === "present" || value.state === "stale",
        );
        const stale = computable.some((value) => value.state === "stale");
        if (node.op === "window_sum") {
          if (computable.length === 0) {
            results[rowIndex] = decimalValue(
              { coefficient: 0n, scale: 0n },
              false,
            );
            return;
          }
          let total = rational(0n, 1n);
          for (const value of computable)
            total = ratAdd(total, payloadRational(value));
          const exact = rationalToExactDecimal(total);
          if (exact === null)
            fail("overflow", "the exact window sum is not representable");
          results[rowIndex] = decimalValue(exact, stale);
          return;
        }
        if (computable.length === 0) {
          fail(
            "empty_input",
            "window_mean has no present or stale contributor",
          );
        }
        let total = rational(0n, 1n);
        for (const value of computable)
          total = ratAdd(total, payloadRational(value));
        const mean = ratDivide(total, rational(BigInt(computable.length), 1n));
        if (mean === null)
          fail("divide_by_zero", "window_mean divided by a zero count");
        results[rowIndex] = decimalValue(
          this.quantizeOrFail(
            mean,
            node.scale as bigint,
            node.rounding as Rounding,
          ),
          stale,
        );
      });
    }
    return {
      kind: "scalar",
      rows: domain.rows.map((row, index) => ({
        row_id: row.row_id,
        value: this.observe(results[index] as RuntimeValue),
      })),
    };
  }

  /** Every remaining scalar operation evaluates one row at a time. */
  private evaluateScalarwise(node: GraphNode): NodeOutput {
    const domain = this.rowsetOf(node.evaluation_rows_from as string);
    const outputType = this.typeOf(node.node_id);
    const scalar = outputType.scalar as ScalarType;
    const rows = domain.rows.map((row, index) => ({
      row_id: row.row_id,
      value: this.observe(this.evaluateScalarRow(node, index, scalar)),
    }));
    return { kind: "scalar", rows };
  }

  private operand(nodeId: string, index: number): RuntimeValue {
    return (this.scalarOf(nodeId).rows[index] as ScalarRow).value;
  }

  private evaluateScalarRow(
    node: GraphNode,
    index: number,
    scalar: ScalarType,
  ): RuntimeValue {
    switch (node.op) {
      case "add":
      case "subtract":
      case "multiply":
      case "divide": {
        const left = this.operand(node.left as string, index);
        const right = this.operand(node.right as string, index);
        const propagated = propagateState([left, right], scalar);
        if (propagated !== null) return propagated;
        const a = payloadRational(left);
        const b = payloadRational(right);
        let computed: Rational | null;
        if (node.op === "add") computed = ratAdd(a, b);
        else if (node.op === "subtract") computed = ratSubtract(a, b);
        else if (node.op === "multiply") computed = ratMultiply(a, b);
        else computed = ratDivide(a, b);
        if (computed === null) {
          fail("divide_by_zero", "divide checked an exact zero denominator");
        }
        return decimalValue(
          this.quantizeOrFail(
            computed,
            node.scale as bigint,
            node.rounding as Rounding,
          ),
          left.state === "stale" || right.state === "stale",
        );
      }
      case "absolute": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        const value = payloadRational(input);
        const absolute = value.n < 0n ? { n: -value.n, d: value.d } : value;
        const exact = rationalToExactDecimal(absolute);
        if (exact === null)
          fail("overflow", "the exact absolute is not representable");
        return decimalValue(exact, input.state === "stale");
      }
      case "clamp": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        const value = payloadRational(input);
        const minimum = boundRational(node.minimum as RuntimeValue);
        const maximum = boundRational(node.maximum as RuntimeValue);
        const lowered = ratCompare(value, minimum) < 0 ? minimum : value;
        const clamped = ratCompare(lowered, maximum) > 0 ? maximum : lowered;
        const exact = rationalToExactDecimal(clamped);
        if (exact === null)
          fail("overflow", "the exact clamp is not representable");
        return decimalValue(exact, input.state === "stale");
      }
      case "round": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        return decimalValue(
          this.quantizeOrFail(
            payloadRational(input),
            node.scale as bigint,
            node.rounding as Rounding,
          ),
          input.state === "stale",
        );
      }
      case "equal":
      case "not_equal":
      case "less":
      case "less_equal":
      case "greater":
      case "greater_equal": {
        const left = this.operand(node.left as string, index);
        const right = this.operand(node.right as string, index);
        const propagated = propagateState([left, right], scalar);
        if (propagated !== null) return propagated;
        const comparison = comparePayloads(
          left.type,
          left.value as ScalarPayload,
          right.value as ScalarPayload,
        );
        const result =
          node.op === "equal"
            ? comparison === 0
            : node.op === "not_equal"
              ? comparison !== 0
              : node.op === "less"
                ? comparison < 0
                : node.op === "less_equal"
                  ? comparison <= 0
                  : node.op === "greater"
                    ? comparison > 0
                    : comparison >= 0;
        return {
          state:
            left.state === "stale" || right.state === "stale"
              ? "stale"
              : "present",
          type: "boolean",
          value: result,
        };
      }
      case "and":
      case "or": {
        const left = this.operand(node.left as string, index);
        const right = this.operand(node.right as string, index);
        return shortCircuitBoolean(node.op, left, right);
      }
      case "not": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        return {
          state: input.state,
          type: "boolean",
          value: input.value !== true,
        };
      }
      case "if_then_else": {
        const condition = this.operand(node.condition as string, index);
        if (condition.state !== "present" && condition.state !== "stale") {
          return { state: condition.state, type: scalar, value: null };
        }
        const branch =
          condition.value === true
            ? this.operand(node.when_true as string, index)
            : this.operand(node.when_false as string, index);
        if (condition.state === "stale" && branch.state === "present") {
          return { ...branch, state: "stale" };
        }
        return branch;
      }
      case "coalesce": {
        const inputs = node.inputs ?? [];
        let sawNull = false;
        for (const id of inputs) {
          const value = this.operand(id, index);
          if (value.state === "present" || value.state === "stale")
            return value;
          if (value.state === "unavailable") {
            return { state: "unavailable", type: scalar, value: null };
          }
          if (value.state === "null") sawNull = true;
        }
        return {
          state: sawNull ? "null" : "missing",
          type: scalar,
          value: null,
        };
      }
      case "unit_convert": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        const converted = convertUnitValue(
          payloadRational(input),
          node.from_unit as string,
          node.to_unit as string,
          node.scale as bigint,
          node.rounding as Rounding,
        );
        if (!converted.ok) fail(converted.code, "unit conversion failed");
        return decimalValue(converted.value, input.state === "stale");
      }
      case "currency_convert": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        const exponent = lookupCurrency(node.to_currency) as bigint;
        const rate = node.rate as CanonicalDecimal;
        const converted = convertCurrencyValue(
          payloadRational(input),
          decimalToRational(rate),
          exponent,
        );
        if (!converted.ok) fail("overflow", "the FX result exceeded 38 digits");
        return decimalValue(converted.value, input.state === "stale");
      }
      case "classify_state": {
        const input = this.operand(node.input as string, index);
        const propagated = propagateState([input], scalar);
        if (propagated !== null) return propagated;
        const age =
          this.validated.graph.evaluation_micros - (input.value as bigint);
        const stale = age > (node.stale_after_millis as bigint) * 1000n;
        return {
          state: input.state === "stale" ? "stale" : "present",
          type: "text",
          value: stale ? "stale" : "current",
        };
      }
      default:
        fail("invalid_graph", `operation ${node.op} has no scalar evaluation`);
    }
  }
}

function boundRational(bound: RuntimeValue): Rational {
  if (bound.type === "integer") return integerToRational(bound.value as bigint);
  return decimalToRational(bound.value as CanonicalDecimal);
}

/** Strict propagation: unavailable, then missing, then null. */
function propagateState(
  operands: readonly RuntimeValue[],
  scalar: ScalarType,
): RuntimeValue | null {
  for (const state of ["unavailable", "missing", "null"] as const) {
    if (operands.some((operand) => operand.state === state)) {
      return { state, type: scalar, value: null };
    }
  }
  return null;
}

function shortCircuitBoolean(
  op: "and" | "or",
  left: RuntimeValue,
  right: RuntimeValue,
): RuntimeValue {
  const decisive = op === "and" ? false : true;
  const computable = [left, right].filter(
    (operand) => operand.state === "present" || operand.state === "stale",
  );
  const decisiveOperands = computable.filter(
    (operand) => operand.value === decisive,
  );
  if (decisiveOperands.length > 0) {
    const present = decisiveOperands.some(
      (operand) => operand.state === "present",
    );
    return {
      state: present ? "present" : "stale",
      type: "boolean",
      value: decisive,
    };
  }
  const propagated = propagateState([left, right], "boolean");
  if (propagated !== null) return propagated;
  return {
    state:
      left.state === "stale" || right.state === "stale" ? "stale" : "present",
    type: "boolean",
    value: !decisive,
  };
}

/**
 * Explicit sort order: the absent class moves to the requested end as one class
 * with its internal order preserved, and direction reverses only the value
 * comparison.
 */
function compareSortKey(
  left: RuntimeValue,
  right: RuntimeValue,
  direction: "asc" | "desc",
  nulls: "first" | "last",
): number {
  const leftAbsent = left.state !== "present" && left.state !== "stale";
  const rightAbsent = right.state !== "present" && right.state !== "stale";
  if (leftAbsent || rightAbsent) {
    if (leftAbsent && rightAbsent) {
      const rank = STATE_RANK[left.state] - STATE_RANK[right.state];
      return rank === 0 ? 0 : rank < 0 ? -1 : 1;
    }
    const absentFirst = nulls === "first" ? -1 : 1;
    return leftAbsent ? absentFirst : -absentFirst;
  }
  const stateOrder = STATE_RANK[left.state] - STATE_RANK[right.state];
  if (stateOrder !== 0) return stateOrder < 0 ? -1 : 1;
  const comparison = comparePayloads(
    left.type,
    left.value as ScalarPayload,
    right.value as ScalarPayload,
  );
  return direction === "asc" ? comparison : -comparison;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

export function deriveResultId(validated: ValidatedGraph): string {
  return uuidV8(RESULT_ID_DOMAIN, [
    canonicalBinaryUuid(validated.graph.graph_id),
    canonicalBinaryShaBytes(validated.graph.graph_sha256),
    canonicalBinaryShaBytes(validated.input.input_sha256),
    canonicalBinaryText(REGISTRY_NAME),
    canonicalBinaryText(LIMITS_NAME),
  ]);
}

function encodeMeter(
  graphId: string,
  resultId: string,
  meter: RuntimeMeter,
): CanonicalObject {
  const tag = (value: bigint): string => `i64:${value.toString(10)}`;
  return {
    schema: "calculation-meter-v1",
    graph_id: graphId,
    result_id: resultId,
    input_bytes: tag(meter.input_bytes),
    ast_bytes: tag(meter.ast_bytes),
    node_count: tag(meter.node_count),
    max_depth: tag(meter.max_depth),
    max_literal_bytes: tag(meter.max_literal_bytes),
    total_literal_bytes: tag(meter.total_literal_bytes),
    max_literal_list_length: tag(meter.max_literal_list_length),
    scanned_rows: tag(meter.scanned_rows),
    group_count: tag(meter.group_count),
    max_group_rows: tag(meter.max_group_rows),
    cumulative_intermediate_rows: tag(meter.cumulative_intermediate_rows),
    final_output_rows: tag(meter.final_output_rows),
    cumulative_intermediate_bytes: tag(meter.cumulative_intermediate_bytes),
    output_bytes: tag(meter.output_bytes),
    primitive_steps: tag(meter.primitive_steps),
    logical_allocation_bytes: tag(meter.logical_allocation_bytes),
    max_top_k: tag(meter.max_top_k),
    max_window_frame: tag(meter.max_window_frame),
    max_coefficient_digits: tag(meter.max_coefficient_digits),
    max_scale: tag(meter.max_scale),
  };
}

/**
 * Evaluates a validated graph and returns the exact
 * `calculation-result-v1`/`calculation-meter-v1` envelope. A failed envelope is
 * typed and deterministic; the fixed SQL commit writer accepts only success.
 */
export function evaluateGraph(validated: ValidatedGraph): CalculationOutcome {
  const resultId = deriveResultId(validated);
  const graph = validated.graph;
  const evaluator = new Evaluator(validated);
  const staticMeter = validated.staticMeter;

  let errorCode: ErrorCode | null = null;
  let outputsArray: readonly CanonicalValue[] = [];
  let outputEntrySha = new Map<string, string>();
  let finalRows = 0n;
  let intermediateByteVector: readonly bigint[] = [];

  try {
    const run = evaluator.run();
    intermediateByteVector = run.intermediateByteVector;
    const entries: CanonicalValue[] = [];
    for (const nodeId of graph.output_node_ids) {
      const node = validated.nodesById.get(nodeId) as GraphNode;
      const output = run.outputs.get(nodeId);
      if (output === undefined)
        fail("missing_field", `output node ${nodeId} was not run`);
      const type = validated.derivedTypes.get(nodeId) as OutputType;
      const rows =
        output.kind === "rowset"
          ? evaluator.encodeRowsetRows(type, output.rows)
          : evaluator.encodeScalarRows(output.rows);
      finalRows = checkedAddOrFail(finalRows, BigInt(output.rows.length));
      const entry: CanonicalObject = {
        node_id: nodeId,
        shape: output.kind,
        output_type: encodeOutputType(type),
        evaluation_rows_from: node.evaluation_rows_from,
        cardinality: `i64:${output.rows.length}`,
        rows,
      };
      entries.push(entry);
      outputEntrySha.set(nodeId, rowHash(OUTPUT_DOMAIN, jcsEncode(entry)));
    }
    outputsArray = entries;
    if (finalRows > LIMITS.finalOutputRows) {
      fail(
        "limit_exceeded",
        "final output rows exceeded the inclusive ceiling",
      );
    }
  } catch (error) {
    if (!(error instanceof CalculationFailure)) throw error;
    errorCode = error.code;
    outputsArray = [];
    outputEntrySha = new Map();
    finalRows = 0n;
    intermediateByteVector = [];
  }

  const outputBytesText = jcsEncode(outputsArray);
  const outputBytes = utf8ByteLength(outputBytesText);
  const meter: RuntimeMeter = {
    input_bytes: validated.input.canonicalBytes,
    ast_bytes: graph.canonicalBytes,
    node_count: BigInt(graph.nodes.length),
    max_depth: staticMeter.max_depth,
    max_literal_bytes: staticMeter.max_literal_bytes,
    total_literal_bytes: staticMeter.total_literal_bytes,
    max_literal_list_length: 0n,
    scanned_rows: evaluator.scannedRows,
    group_count: evaluator.groupCount,
    max_group_rows: evaluator.maxGroupRows,
    cumulative_intermediate_rows: evaluator.intermediateRows,
    final_output_rows: finalRows,
    cumulative_intermediate_bytes: evaluator.cumulativeIntermediateBytes,
    output_bytes: outputBytes,
    primitive_steps: evaluator.primitiveSteps,
    logical_allocation_bytes: checkedAddOrFail(
      checkedAddOrFail(
        checkedAddOrFail(validated.input.canonicalBytes, graph.canonicalBytes),
        checkedAddOrFail(evaluator.cumulativeIntermediateBytes, outputBytes),
      ),
      checkedMultiplyOrFail(64n, BigInt(graph.nodes.length)),
    ),
    max_top_k: staticMeter.max_top_k,
    max_window_frame: staticMeter.max_window_frame,
    max_coefficient_digits:
      evaluator.maxDigits > staticMeter.max_coefficient_digits
        ? evaluator.maxDigits
        : staticMeter.max_coefficient_digits,
    max_scale:
      evaluator.maxScale > staticMeter.max_scale
        ? evaluator.maxScale
        : staticMeter.max_scale,
  };
  if (errorCode === null) requireLimits(meter);

  const meterBytes = jcsEncode(encodeMeter(graph.graph_id, resultId, meter));
  const meterSha = rowHash(METER_DOMAIN, meterBytes);
  const result: CanonicalObject = {
    schema: "calculation-result-v1",
    result_id: resultId,
    graph_id: graph.graph_id,
    graph_sha256: graph.graph_sha256,
    state: errorCode === null ? "succeeded" : "failed",
    outputs: outputsArray,
    error_code: errorCode,
    meter_sha256: meterSha,
  };
  const resultBytes = jcsEncode(result);
  if (utf8ByteLength(resultBytes) > LIMITS.outputBytes + LIMITS.astBytes) {
    fail("limit_exceeded", "the canonical result exceeds its byte ceiling");
  }

  return {
    state: errorCode === null ? "succeeded" : "failed",
    error_code: errorCode,
    result_id: resultId,
    resultBytes,
    result_sha256: rowHash(RESULT_DOMAIN, resultBytes),
    meterBytes,
    meter_sha256: meterSha,
    meter,
    outputBytes: outputBytesText,
    intermediateByteVector,
    outputEntrySha256: outputEntrySha,
  };
}

/** The `calculation-output-value-v1` digest for one scalar row or rowset cell. */
export function outputValueDigest(input: {
  readonly result_id: string;
  readonly node_id: string;
  readonly row_id: string;
  readonly field_id: string | null;
  readonly value: RuntimeValue;
}): { readonly bytes: string; readonly sha256: string } {
  const bytes = jcsEncode({
    schema: "calculation-output-value-v1",
    result_id: input.result_id,
    node_id: input.node_id,
    row_id: input.row_id,
    field_id: input.field_id,
    value: encodeTypedValue(input.value),
  });
  return { bytes, sha256: rowHash(OUTPUT_VALUE_DOMAIN, bytes) };
}
