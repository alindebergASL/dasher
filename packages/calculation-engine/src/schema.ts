/**
 * Strict Task 9 calculation schemas.
 *
 * Every object rejects unknown keys, every signed-64 value is the tagged string
 * form, and every instant is exact UTC RFC 3339 with six fractional digits. These
 * parsers accept only `calculation-graph-v1`, `canonical-input-table-v1`,
 * `field-catalog-snapshot-v1`, `metric-contract-set-v1`,
 * `common-evidence-bundle-v1`, and `fx-rate-evidence-v1`.
 *
 * This package deliberately does not accept or parse
 * `attempt-actual-accounting-v1`; its tagged-i64 helpers are not an adapter-boundary
 * prevalidator for `actual_accounting_bytes` and do not substitute for the fixed
 * SQL parser.
 */

import {
  type CanonicalObject,
  type CanonicalValue,
  compareUtf8,
  isSha256Hex,
  isUuidText,
  jcsEncode,
  jcsStringTokenBytes,
  parseDateText,
  parseTimestampMicros,
  rowHash,
  snapshotUntrusted,
  utf8ByteLength,
} from "./canonical";
import {
  type CanonicalDecimal,
  type Rational,
  type Rounding,
  I64_MAX,
  parseDecimalObject,
  parseTaggedI64,
  rational,
} from "./decimal";
import {
  GRAPH_SCHEMA_NAME,
  INPUT_SCALAR_TYPES,
  LIMITS,
  LIMITS_NAME,
  type Op,
  OP_FIELDS,
  REGISTRY_NAME,
  ROWSET_OPS,
  SCALAR_TYPES,
  type ScalarType,
  TZDB_VERSION,
  UNIT_REGISTRY_VERSION,
  isOp,
  lookupCurrency,
  lookupUnit,
} from "./registry";
import { isPinnedIanaZoneName } from "./timezones";

/* ------------------------------------------------------------------ *
 * Closed semantic error codes
 * ------------------------------------------------------------------ */

export const ERROR_CODES = [
  "invalid_graph",
  "type_mismatch",
  "unit_mismatch",
  "currency_mismatch",
  "grain_mismatch",
  "missing_field",
  "cycle",
  "limit_exceeded",
  "overflow",
  "divide_by_zero",
  "empty_input",
  "invalid_timezone",
  "invalid_unit_conversion",
  "inexact_arithmetic",
  "missing_fx_evidence",
  "stale_fx",
  "invalid_group_key",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A closed semantic failure; no exception text enters canonical bytes. */
export class CalculationFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CalculationFailure";
  }
}

export function fail(code: ErrorCode, detail: string): never {
  throw new CalculationFailure(code, detail);
}

/* ------------------------------------------------------------------ *
 * Primitive readers
 * ------------------------------------------------------------------ */

function isObject(value: CanonicalValue): value is CanonicalObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readObject(
  value: CanonicalValue,
  path: string,
): CanonicalObject {
  if (!isObject(value)) fail("invalid_graph", `${path} must be an object`);
  return value;
}

export function readArray(
  value: CanonicalValue,
  path: string,
): readonly CanonicalValue[] {
  if (!Array.isArray(value)) fail("invalid_graph", `${path} must be an array`);
  return value;
}

/**
 * Requires exactly the listed keys: no unknown, aliased, or missing key.
 *
 * Presence is `Object.hasOwn`, never `in`: an inherited member such as
 * `toString` or `__proto__` is not a document key, and a parsed document must
 * carry the key as its own property to satisfy the schema.
 */
export function requireExactKeys(
  object: CanonicalObject,
  keys: readonly string[],
  path: string,
): void {
  const present = Object.keys(object);
  for (const key of present) {
    if (!keys.includes(key))
      fail("invalid_graph", `unknown key ${path}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) {
      fail("invalid_graph", `missing key ${path}.${key}`);
    }
  }
}

function readText(value: CanonicalValue, path: string): string {
  if (typeof value !== "string")
    fail("invalid_graph", `${path} must be a string`);
  return value;
}

function readBoolean(value: CanonicalValue, path: string): boolean {
  if (typeof value !== "boolean") {
    fail("invalid_graph", `${path} must be a JSON boolean`);
  }
  return value;
}

export function readTaggedI64(value: CanonicalValue, path: string): bigint {
  const parsed = parseTaggedI64(value);
  if (parsed === null) fail("invalid_graph", `${path} must be a tagged i64`);
  return parsed;
}

function readBoundedI64(
  value: CanonicalValue,
  path: string,
  minimum: bigint,
  maximum: bigint,
): bigint {
  const parsed = readTaggedI64(value, path);
  if (parsed < minimum || parsed > maximum) {
    fail("invalid_graph", `${path} must be within ${minimum}..${maximum}`);
  }
  return parsed;
}

function readUuid(value: CanonicalValue, path: string): string {
  if (!isUuidText(value)) fail("invalid_graph", `${path} must be a UUID`);
  return value;
}

function readSha256(value: CanonicalValue, path: string): string {
  if (!isSha256Hex(value)) {
    fail("invalid_graph", `${path} must be 64 lowercase hex characters`);
  }
  return value;
}

function readLiteralText(
  value: CanonicalValue,
  path: string,
  expected: string,
): string {
  const text = readText(value, path);
  if (text !== expected) fail("invalid_graph", `${path} must be ${expected}`);
  return text;
}

function readEnum<T extends string>(
  value: CanonicalValue,
  path: string,
  allowed: readonly T[],
): T {
  const text = readText(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    fail("invalid_graph", `${path} must be one of ${allowed.join("|")}`);
  }
  return text as T;
}

function readNullable<T>(
  value: CanonicalValue,
  reader: (inner: CanonicalValue) => T,
): T | null {
  return value === null ? null : reader(value);
}

function readTimestamp(value: CanonicalValue, path: string): bigint {
  const micros = parseTimestampMicros(value);
  if (micros === null) {
    fail(
      "invalid_graph",
      `${path} must be UTC RFC 3339 with six fractional digits`,
    );
  }
  return micros;
}

function readSortedUniqueUuids(
  value: CanonicalValue,
  path: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  const items = readArray(value, path);
  if (items.length < minimum || items.length > maximum) {
    fail("invalid_graph", `${path} must hold ${minimum}..${maximum} entries`);
  }
  const uuids = items.map((item, index) => readUuid(item, `${path}[${index}]`));
  for (let index = 1; index < uuids.length; index += 1) {
    if (compareUtf8(uuids[index - 1] as string, uuids[index] as string) >= 0) {
      fail("invalid_graph", `${path} must be sorted and unique by UUID`);
    }
  }
  return uuids;
}

function readSortedUniqueTexts(
  value: CanonicalValue,
  path: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  const items = readArray(value, path);
  if (items.length < minimum || items.length > maximum) {
    fail("invalid_graph", `${path} must hold ${minimum}..${maximum} entries`);
  }
  const texts = items.map((item, index) => readText(item, `${path}[${index}]`));
  for (let index = 1; index < texts.length; index += 1) {
    if (compareUtf8(texts[index - 1] as string, texts[index] as string) >= 0) {
      fail("invalid_graph", `${path} must be sorted and unique`);
    }
  }
  return texts;
}

function readBoundedTextBytes(
  value: CanonicalValue,
  path: string,
  minimum: bigint,
  maximum: bigint,
): string {
  const text = readText(value, path);
  const bytes = utf8ByteLength(text);
  if (bytes < minimum || bytes > maximum) {
    fail("invalid_graph", `${path} must be ${minimum}..${maximum} UTF-8 bytes`);
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Tagged runtime values
 * ------------------------------------------------------------------ */

export type ValueState =
  "present" | "null" | "missing" | "unavailable" | "stale";

export type ScalarPayload = boolean | bigint | string | CanonicalDecimal;

export interface RuntimeValue {
  readonly state: ValueState;
  readonly type: ScalarType;
  /** Present and stale carry a payload; every other state carries none. */
  readonly value: ScalarPayload | null;
}

export function isComputable(value: RuntimeValue): boolean {
  return value.state === "present" || value.state === "stale";
}

function readScalarPayload(
  raw: CanonicalValue,
  type: ScalarType,
  path: string,
): ScalarPayload {
  switch (type) {
    case "boolean":
      return readBoolean(raw, path);
    case "integer":
      return readTaggedI64(raw, path);
    case "decimal": {
      const decimal = parseDecimalObject(raw);
      if (decimal === null) {
        fail("invalid_graph", `${path} must be a canonical decimal object`);
      }
      return decimal;
    }
    case "text":
      return readBoundedTextBytes(raw, path, 0n, LIMITS.literalBytes);
    case "date": {
      const days = parseDateText(raw);
      if (days === null) fail("invalid_graph", `${path} must be YYYY-MM-DD`);
      return days;
    }
    case "timestamp":
      return readTimestamp(raw, path);
    case "duration":
      return readTaggedI64(raw, path);
  }
}

export interface TypedValueOptions {
  readonly allowStale?: boolean;
  readonly allowedTypes?: readonly ScalarType[];
  readonly expectedType?: ScalarType;
  readonly requirePresent?: boolean;
}

/** Parses the exact `{state,type,value}` tagged value. */
export function parseTypedValue(
  raw: CanonicalValue,
  path: string,
  options: TypedValueOptions = {},
): RuntimeValue {
  const object = readObject(raw, path);
  requireExactKeys(object, ["state", "type", "value"], path);
  const states: readonly ValueState[] = options.allowStale
    ? ["present", "null", "missing", "unavailable", "stale"]
    : ["present", "null", "missing", "unavailable"];
  const state = readEnum(
    object.state as CanonicalValue,
    `${path}.state`,
    states,
  );
  const allowed = options.allowedTypes ?? SCALAR_TYPES;
  const type = readEnum(object.type as CanonicalValue, `${path}.type`, allowed);
  if (options.expectedType !== undefined && type !== options.expectedType) {
    fail("invalid_graph", `${path}.type must be ${options.expectedType}`);
  }
  if (options.requirePresent === true && state !== "present") {
    fail("invalid_graph", `${path}.state must be present`);
  }
  const rawValue = object.value as CanonicalValue;
  if (state === "present" || state === "stale") {
    return {
      state,
      type,
      value: readScalarPayload(rawValue, type, `${path}.value`),
    };
  }
  if (rawValue !== null) {
    fail("invalid_graph", `${path}.value must be null for state ${state}`);
  }
  return { state, type, value: null };
}

export function encodeScalarPayload(
  type: ScalarType,
  value: ScalarPayload,
): CanonicalValue {
  switch (type) {
    case "boolean":
      return value as boolean;
    case "integer":
    case "duration":
      return `i64:${(value as bigint).toString(10)}`;
    case "decimal": {
      const decimal = value as CanonicalDecimal;
      return {
        coefficient: decimal.coefficient.toString(10),
        scale: `i64:${decimal.scale.toString(10)}`,
      };
    }
    case "text":
      return value as string;
    case "date":
      return formatDate(value as bigint);
    case "timestamp":
      return formatTimestamp(value as bigint);
  }
}

export function encodeTypedValue(value: RuntimeValue): CanonicalObject {
  return {
    state: value.state,
    type: value.type,
    value:
      value.value === null
        ? null
        : encodeScalarPayload(value.type, value.value),
  };
}

/* Re-exported so evaluation can render date/timestamp payloads canonically. */
import {
  formatDateText as formatDate,
  formatTimestampMicros as formatTimestamp,
} from "./canonical";

/* ------------------------------------------------------------------ *
 * Output types
 * ------------------------------------------------------------------ */

export interface OutputFieldType {
  readonly field_id: string;
  readonly name: string;
  readonly scalar: ScalarType;
  readonly nullable: boolean;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly grain: string | null;
  readonly max_value_bytes: bigint;
}

export interface OutputType {
  readonly shape: "scalar" | "rowset";
  readonly scalar: ScalarType | null;
  readonly nullable: boolean | null;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly grain: string | null;
  readonly max_value_bytes: bigint | null;
  readonly fields: readonly OutputFieldType[] | null;
}

const OUTPUT_TYPE_KEYS = [
  "shape",
  "scalar",
  "nullable",
  "unit",
  "currency",
  "grain",
  "max_value_bytes",
  "fields",
] as const;

const OUTPUT_FIELD_KEYS = [
  "field_id",
  "name",
  "scalar",
  "nullable",
  "unit",
  "currency",
  "grain",
  "max_value_bytes",
] as const;

function readUnitLiteral(value: CanonicalValue, path: string): string {
  const text = readText(value, path);
  if (lookupUnit(text) === null) {
    fail("unit_mismatch", `${path} is not a ucum-subset-v1 literal`);
  }
  return text;
}

function readCurrencyLiteral(value: CanonicalValue, path: string): string {
  const text = readText(value, path);
  if (lookupCurrency(text) === null) {
    fail("currency_mismatch", `${path} is not an iso4217-task9-v1 code`);
  }
  return text;
}

function parseOutputFieldType(
  raw: CanonicalValue,
  path: string,
): OutputFieldType {
  const object = readObject(raw, path);
  requireExactKeys(object, OUTPUT_FIELD_KEYS, path);
  const scalar = readEnum(
    object.scalar as CanonicalValue,
    `${path}.scalar`,
    SCALAR_TYPES,
  );
  const unit = readNullable(object.unit as CanonicalValue, (inner) =>
    readUnitLiteral(inner, `${path}.unit`),
  );
  const currency = readNullable(object.currency as CanonicalValue, (inner) =>
    readCurrencyLiteral(inner, `${path}.currency`),
  );
  requireScalarMetadataValidity(scalar, unit, currency, path);
  const width = readTaggedI64(
    object.max_value_bytes as CanonicalValue,
    `${path}.max_value_bytes`,
  );
  if (width <= 0n)
    fail("type_mismatch", `${path}.max_value_bytes must be positive`);
  return {
    field_id: readUuid(object.field_id as CanonicalValue, `${path}.field_id`),
    name: readBoundedTextBytes(
      object.name as CanonicalValue,
      `${path}.name`,
      1n,
      256n,
    ),
    scalar,
    nullable: readBoolean(
      object.nullable as CanonicalValue,
      `${path}.nullable`,
    ),
    unit,
    currency,
    grain: readNullable(object.grain as CanonicalValue, (inner) =>
      readBoundedTextBytes(inner, `${path}.grain`, 1n, 128n),
    ),
    max_value_bytes: width,
  };
}

/**
 * Scalar metadata validity is global and precedes operation validation: only
 * integer and decimal may carry a unit or a currency, and never both.
 */
export function requireScalarMetadataValidity(
  scalar: ScalarType,
  unit: string | null,
  currency: string | null,
  path: string,
): void {
  if (unit !== null && currency !== null) {
    fail("unit_mismatch", `${path} cannot carry both a unit and a currency`);
  }
  if (scalar !== "integer" && scalar !== "decimal") {
    if (unit !== null)
      fail("unit_mismatch", `${path} scalar cannot carry a unit`);
    if (currency !== null) {
      fail("currency_mismatch", `${path} scalar cannot carry a currency`);
    }
  }
}

export function parseOutputType(raw: CanonicalValue, path: string): OutputType {
  const object = readObject(raw, path);
  requireExactKeys(object, OUTPUT_TYPE_KEYS, path);
  const shape = readEnum(object.shape as CanonicalValue, `${path}.shape`, [
    "scalar",
    "rowset",
  ] as const);
  if (shape === "rowset") {
    for (const key of [
      "scalar",
      "nullable",
      "unit",
      "currency",
      "grain",
      "max_value_bytes",
    ] as const) {
      if (object[key] !== null) {
        fail("type_mismatch", `${path}.${key} must be null for a rowset`);
      }
    }
    const rawFields = readArray(
      object.fields as CanonicalValue,
      `${path}.fields`,
    );
    if (rawFields.length > 64) {
      fail("invalid_graph", `${path}.fields must hold at most 64 entries`);
    }
    const fields = rawFields.map((field, index) =>
      parseOutputFieldType(field, `${path}.fields[${index}]`),
    );
    for (let index = 1; index < fields.length; index += 1) {
      const previous = fields[index - 1] as OutputFieldType;
      const current = fields[index] as OutputFieldType;
      if (compareUtf8(previous.field_id, current.field_id) >= 0) {
        fail(
          "type_mismatch",
          `${path}.fields must be sorted and unique by field UUID`,
        );
      }
    }
    return {
      shape,
      scalar: null,
      nullable: null,
      unit: null,
      currency: null,
      grain: null,
      max_value_bytes: null,
      fields,
    };
  }
  if (object.fields !== null) {
    fail("type_mismatch", `${path}.fields must be null for a scalar`);
  }
  const scalar = readEnum(
    object.scalar as CanonicalValue,
    `${path}.scalar`,
    SCALAR_TYPES,
  );
  const unit = readNullable(object.unit as CanonicalValue, (inner) =>
    readUnitLiteral(inner, `${path}.unit`),
  );
  const currency = readNullable(object.currency as CanonicalValue, (inner) =>
    readCurrencyLiteral(inner, `${path}.currency`),
  );
  requireScalarMetadataValidity(scalar, unit, currency, path);
  const width = readTaggedI64(
    object.max_value_bytes as CanonicalValue,
    `${path}.max_value_bytes`,
  );
  if (width <= 0n)
    fail("type_mismatch", `${path}.max_value_bytes must be positive`);
  return {
    shape,
    scalar,
    nullable: readBoolean(
      object.nullable as CanonicalValue,
      `${path}.nullable`,
    ),
    unit,
    currency,
    grain: readNullable(object.grain as CanonicalValue, (inner) =>
      readBoundedTextBytes(inner, `${path}.grain`, 1n, 128n),
    ),
    max_value_bytes: width,
    fields: null,
  };
}

export function encodeOutputFieldType(field: OutputFieldType): CanonicalObject {
  return {
    field_id: field.field_id,
    name: field.name,
    scalar: field.scalar,
    nullable: field.nullable,
    unit: field.unit,
    currency: field.currency,
    grain: field.grain,
    max_value_bytes: `i64:${field.max_value_bytes.toString(10)}`,
  };
}

export function encodeOutputType(type: OutputType): CanonicalObject {
  return {
    shape: type.shape,
    scalar: type.scalar,
    nullable: type.nullable,
    unit: type.unit,
    currency: type.currency,
    grain: type.grain,
    max_value_bytes:
      type.max_value_bytes === null
        ? null
        : `i64:${type.max_value_bytes.toString(10)}`,
    fields:
      type.fields === null ? null : type.fields.map(encodeOutputFieldType),
  };
}

/** Byte-exact output-type comparison used by every caller-mismatch gate. */
export function outputTypesEqual(left: OutputType, right: OutputType): boolean {
  return (
    jcsEncode(encodeOutputType(left)) === jcsEncode(encodeOutputType(right))
  );
}

/* ------------------------------------------------------------------ *
 * calculation-graph-v1
 * ------------------------------------------------------------------ */

export interface SortKeySpec {
  readonly value_node_id: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
  readonly tie: boolean;
}

export interface ProjectionSpec {
  readonly field_id: string;
  readonly name: string;
  readonly value_node_id: string;
}

export interface GraphNode {
  readonly node_id: string;
  readonly op: Op;
  readonly output_type: OutputType;
  readonly evaluation_rows_from: string | null;
  readonly field_ids?: readonly string[];
  readonly input?: string;
  readonly field_id?: string;
  readonly literal?: RuntimeValue;
  readonly projections?: readonly ProjectionSpec[];
  readonly predicate?: string;
  readonly key_node_ids?: readonly string[];
  readonly keys?: readonly SortKeySpec[];
  readonly k?: bigint;
  readonly partition_node_ids?: readonly string[];
  readonly group_node_id?: string;
  readonly scale?: bigint;
  readonly rounding?: Rounding;
  readonly left?: string;
  readonly right?: string;
  readonly minimum?: RuntimeValue;
  readonly maximum?: RuntimeValue;
  readonly condition?: string;
  readonly when_true?: string;
  readonly when_false?: string;
  readonly inputs?: readonly string[];
  readonly offset?: bigint;
  readonly preceding?: bigint;
  readonly following?: bigint;
  readonly from_unit?: string;
  readonly to_unit?: string;
  readonly registry_version?: string;
  readonly from_currency?: string;
  readonly to_currency?: string;
  readonly fx_evidence_id?: string;
  readonly rate?: CanonicalDecimal;
  readonly stale_after_millis?: bigint;
  readonly evaluation_time?: string;
}

export interface CalculationGraph {
  readonly schema: string;
  readonly registry: string;
  readonly limits: string;
  readonly graph_id: string;
  readonly contract_set_id: string;
  readonly contract_id: string;
  readonly contract_version: bigint;
  readonly contract_output_node_id: string;
  readonly threshold_node_id: string | null;
  readonly target_node_id: string | null;
  readonly input_snapshot_id: string;
  readonly input_sha256: string;
  readonly field_catalog_snapshot_id: string;
  readonly field_catalog_sha256: string;
  readonly common_bundle_id: string;
  readonly common_bundle_sha256: string;
  readonly evaluation_time: string;
  readonly evaluation_micros: bigint;
  readonly timezone: string;
  readonly tzdb_version: string;
  readonly unit_registry_version: string;
  readonly fx_evidence_id: string | null;
  readonly fx_evidence_sha256: string | null;
  readonly nodes: readonly GraphNode[];
  readonly output_node_ids: readonly string[];
  readonly canonicalText: string;
  readonly canonicalBytes: bigint;
  readonly graph_sha256: string;
}

const GRAPH_KEYS = [
  "schema",
  "registry",
  "limits",
  "graph_id",
  "contract_set_id",
  "contract_id",
  "contract_version",
  "contract_output_node_id",
  "threshold_node_id",
  "target_node_id",
  "input_snapshot_id",
  "input_sha256",
  "field_catalog_snapshot_id",
  "field_catalog_sha256",
  "common_bundle_id",
  "common_bundle_sha256",
  "evaluation_time",
  "timezone",
  "tzdb_version",
  "unit_registry_version",
  "fx_evidence_id",
  "fx_evidence_sha256",
  "nodes",
  "output_node_ids",
] as const;

/**
 * Exact membership in the pinned `tzdb 2025b` name table.
 *
 * Syntax is not the rule: a well-formed name that no tzdb release defines is a
 * nonexistent zone and is `invalid_timezone`. The table is embedded in this
 * package, so the engine never consults a host time-zone database and never
 * defers existence to PostgreSQL.
 */
function isIanaZoneName(text: string): boolean {
  return isPinnedIanaZoneName(text);
}

function readScale(value: CanonicalValue, path: string): bigint {
  return readBoundedI64(value, path, 0n, LIMITS.scale);
}

function readRounding(value: CanonicalValue, path: string): Rounding {
  return readEnum(value, path, ["none", "half_even"] as const);
}

function readNodeRefList(
  value: CanonicalValue,
  path: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  const items = readArray(value, path);
  if (items.length < minimum || items.length > maximum) {
    fail("invalid_graph", `${path} must hold ${minimum}..${maximum} entries`);
  }
  return items.map((item, index) => readUuid(item, `${path}[${index}]`));
}

function readSortKeys(
  value: CanonicalValue,
  path: string,
): readonly SortKeySpec[] {
  const items = readArray(value, path);
  if (items.length < 1 || items.length > 16) {
    fail("invalid_graph", `${path} must hold 1..16 entries`);
  }
  const keys = items.map((item, index) => {
    const object = readObject(item, `${path}[${index}]`);
    requireExactKeys(
      object,
      ["value_node_id", "direction", "nulls", "tie"],
      `${path}[${index}]`,
    );
    return {
      value_node_id: readUuid(
        object.value_node_id as CanonicalValue,
        `${path}[${index}].value_node_id`,
      ),
      direction: readEnum(
        object.direction as CanonicalValue,
        `${path}[${index}].direction`,
        ["asc", "desc"] as const,
      ),
      nulls: readEnum(
        object.nulls as CanonicalValue,
        `${path}[${index}].nulls`,
        ["first", "last"] as const,
      ),
      tie: readBoolean(object.tie as CanonicalValue, `${path}[${index}].tie`),
    };
  });
  const tieIndexes = keys
    .map((key, index) => (key.tie ? index : -1))
    .filter((index) => index >= 0);
  if (tieIndexes.length !== 1 || tieIndexes[0] !== keys.length - 1) {
    fail("invalid_graph", `${path} must end with exactly one tie=true key`);
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.value_node_id)) {
      fail("invalid_graph", `${path} must reference unique key nodes`);
    }
    seen.add(key.value_node_id);
  }
  return keys;
}

function readProjections(
  value: CanonicalValue,
  path: string,
): readonly ProjectionSpec[] {
  const items = readArray(value, path);
  if (items.length < 1 || items.length > 64) {
    fail("invalid_graph", `${path} must hold 1..64 entries`);
  }
  const projections = items.map((item, index) => {
    const object = readObject(item, `${path}[${index}]`);
    requireExactKeys(
      object,
      ["field_id", "name", "value_node_id"],
      `${path}[${index}]`,
    );
    return {
      field_id: readUuid(
        object.field_id as CanonicalValue,
        `${path}[${index}].field_id`,
      ),
      name: readBoundedTextBytes(
        object.name as CanonicalValue,
        `${path}[${index}].name`,
        1n,
        256n,
      ),
      value_node_id: readUuid(
        object.value_node_id as CanonicalValue,
        `${path}[${index}].value_node_id`,
      ),
    };
  });
  for (let index = 1; index < projections.length; index += 1) {
    const previous = projections[index - 1] as ProjectionSpec;
    const current = projections[index] as ProjectionSpec;
    if (compareUtf8(previous.field_id, current.field_id) >= 0) {
      fail(
        "invalid_graph",
        `${path} must be sorted and unique by derived field UUID`,
      );
    }
  }
  const names = new Set<string>();
  for (const projection of projections) {
    if (names.has(projection.name)) {
      fail("invalid_graph", `${path} must have unique projection names`);
    }
    names.add(projection.name);
  }
  return projections;
}

function readBoundLiteral(value: CanonicalValue, path: string): RuntimeValue {
  return parseTypedValue(value, path, {
    allowedTypes: ["integer", "decimal"],
    requirePresent: true,
  });
}

function parseGraphNode(raw: CanonicalValue, path: string): GraphNode {
  const object = readObject(raw, path);
  const op = object.op;
  if (!isOp(op))
    fail("invalid_graph", `${path}.op is not a registry operation`);
  const opFields = OP_FIELDS[op] as readonly string[];
  requireExactKeys(
    object,
    ["node_id", "op", "output_type", "evaluation_rows_from", ...opFields],
    path,
  );
  const node_id = readUuid(object.node_id as CanonicalValue, `${path}.node_id`);
  const output_type = parseOutputType(
    object.output_type as CanonicalValue,
    `${path}.output_type`,
  );
  const evaluationRowsFrom = readNullable(
    object.evaluation_rows_from as CanonicalValue,
    (inner) => readUuid(inner, `${path}.evaluation_rows_from`),
  );
  if (ROWSET_OPS.has(op)) {
    if (evaluationRowsFrom !== null) {
      fail(
        "invalid_graph",
        `${path}.evaluation_rows_from must be null for ${op}`,
      );
    }
    if (output_type.shape !== "rowset") {
      fail("type_mismatch", `${path}.output_type must be a rowset for ${op}`);
    }
  } else {
    if (evaluationRowsFrom === null) {
      fail(
        "invalid_graph",
        `${path}.evaluation_rows_from is required for ${op}`,
      );
    }
    if (output_type.shape !== "scalar") {
      fail("type_mismatch", `${path}.output_type must be a scalar for ${op}`);
    }
  }

  const node: Record<string, unknown> = {
    node_id,
    op,
    output_type,
    evaluation_rows_from: evaluationRowsFrom,
  };

  for (const field of opFields) {
    const value = object[field] as CanonicalValue;
    const fieldPath = `${path}.${field}`;
    switch (field) {
      case "field_ids":
        node.field_ids = readSortedUniqueUuids(value, fieldPath, 1, 64);
        break;
      case "input":
      case "predicate":
      case "left":
      case "right":
      case "condition":
      case "when_true":
      case "when_false":
      case "group_node_id":
        node[field] = readUuid(value, fieldPath);
        break;
      case "field_id":
      case "fx_evidence_id":
        node[field] = readUuid(value, fieldPath);
        break;
      case "value":
        node.literal = parseTypedValue(value, fieldPath);
        break;
      case "projections":
        node.projections = readProjections(value, fieldPath);
        break;
      case "key_node_ids":
        node.key_node_ids = readNodeRefList(value, fieldPath, 0, 16);
        break;
      case "partition_node_ids":
        node.partition_node_ids = readNodeRefList(value, fieldPath, 0, 16);
        break;
      case "keys":
        node.keys = readSortKeys(value, fieldPath);
        break;
      case "inputs":
        node.inputs = readNodeRefList(value, fieldPath, 1, 16);
        break;
      case "k":
        node.k = readBoundedI64(value, fieldPath, 1n, LIMITS.topK);
        break;
      case "offset":
        node.offset = readBoundedI64(value, fieldPath, 1n, LIMITS.windowFrame);
        break;
      case "preceding":
      case "following":
        node[field] = readBoundedI64(value, fieldPath, 0n, LIMITS.windowFrame);
        break;
      case "scale":
        node.scale = readScale(value, fieldPath);
        break;
      case "rounding":
        node.rounding = readRounding(value, fieldPath);
        break;
      case "minimum":
      case "maximum":
        node[field] = readBoundLiteral(value, fieldPath);
        break;
      case "from_unit":
      case "to_unit":
        // Registry membership is deliberately not checked here. The plan's static
        // order runs type and currency validation before conversion validity, and
        // an unknown `unit_convert` literal is `invalid_unit_conversion`, not
        // `unit_mismatch`, so `validate` decides both after the type checks.
        node[field] = readText(value, fieldPath);
        break;
      case "registry_version":
        node.registry_version = readLiteralText(
          value,
          fieldPath,
          UNIT_REGISTRY_VERSION,
        );
        break;
      case "from_currency":
      case "to_currency":
        node[field] = readCurrencyLiteral(value, fieldPath);
        break;
      case "rate": {
        const rate = parseDecimalObject(value);
        if (rate === null) {
          fail(
            "invalid_graph",
            `${fieldPath} must be a canonical decimal object`,
          );
        }
        if (rate.coefficient <= 0n) {
          fail("invalid_graph", `${fieldPath} must be strictly positive`);
        }
        if (rate.coefficient.toString(10).length > 18) {
          fail("invalid_graph", `${fieldPath} must have at most 18 digits`);
        }
        node.rate = rate;
        break;
      }
      case "stale_after_millis":
        node.stale_after_millis = readBoundedI64(value, fieldPath, 0n, I64_MAX);
        break;
      case "evaluation_time":
        readTimestamp(value, fieldPath);
        node.evaluation_time = readText(value, fieldPath);
        break;
      default:
        fail("invalid_graph", `unhandled op field ${fieldPath}`);
    }
  }

  if (op === "window_sum" || op === "window_mean") {
    const width = 1n + (node.preceding as bigint) + (node.following as bigint);
    if (width > LIMITS.windowFrame) {
      fail(
        "invalid_graph",
        `${path} declared window width exceeds the frame limit`,
      );
    }
  }
  if (op === "clamp") {
    const minimum = node.minimum as RuntimeValue;
    const maximum = node.maximum as RuntimeValue;
    if (compareBoundLiterals(minimum, maximum) > 0) {
      fail("invalid_graph", `${path} requires minimum <= maximum`);
    }
  }
  return node as unknown as GraphNode;
}

/** Bounds may mix integer and decimal, so they compare as exact rationals. */
export function boundLiteralToRational(value: RuntimeValue): Rational {
  if (value.type === "integer") return rational(value.value as bigint, 1n);
  const decimal = value.value as CanonicalDecimal;
  return rational(decimal.coefficient, 10n ** decimal.scale);
}

function compareBoundLiterals(left: RuntimeValue, right: RuntimeValue): number {
  const a = boundLiteralToRational(left);
  const b = boundLiteralToRational(right);
  const difference = a.n * b.d - b.n * a.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/**
 * Parses one already-snapshotted `calculation-graph-v1` object. The caller has
 * already applied the raw and canonical byte ceilings.
 */
export function parseCalculationGraph(
  value: CanonicalValue,
  canonicalText: string,
): CalculationGraph {
  const object = readObject(value, "graph");
  requireExactKeys(object, GRAPH_KEYS, "graph");
  readLiteralText(
    object.schema as CanonicalValue,
    "graph.schema",
    GRAPH_SCHEMA_NAME,
  );
  readLiteralText(
    object.registry as CanonicalValue,
    "graph.registry",
    REGISTRY_NAME,
  );
  readLiteralText(object.limits as CanonicalValue, "graph.limits", LIMITS_NAME);
  const tzdb = readText(
    object.tzdb_version as CanonicalValue,
    "graph.tzdb_version",
  );
  if (tzdb !== TZDB_VERSION) {
    fail("invalid_timezone", "graph.tzdb_version is not the pinned release");
  }
  const timezone = readText(
    object.timezone as CanonicalValue,
    "graph.timezone",
  );
  if (!isIanaZoneName(timezone)) {
    fail("invalid_timezone", "graph.timezone is not an exact IANA name");
  }
  readLiteralText(
    object.unit_registry_version as CanonicalValue,
    "graph.unit_registry_version",
    UNIT_REGISTRY_VERSION,
  );

  const rawNodes = readArray(object.nodes as CanonicalValue, "graph.nodes");
  if (rawNodes.length < 1 || rawNodes.length > Number(LIMITS.nodeCount)) {
    fail("limit_exceeded", "graph.nodes must hold 1..128 nodes");
  }
  const nodes = rawNodes.map((node, index) =>
    parseGraphNode(node, `graph.nodes[${index}]`),
  );
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.node_id)) {
      fail("invalid_graph", "graph.nodes must have unique node IDs");
    }
    nodeIds.add(node.node_id);
  }

  const outputNodeIds = readSortedUniqueUuids(
    object.output_node_ids as CanonicalValue,
    "graph.output_node_ids",
    1,
    32,
  );

  const evaluationMicros = readTimestamp(
    object.evaluation_time as CanonicalValue,
    "graph.evaluation_time",
  );

  const fxEvidenceId = readNullable(
    object.fx_evidence_id as CanonicalValue,
    (inner) => readUuid(inner, "graph.fx_evidence_id"),
  );
  const fxEvidenceSha = readNullable(
    object.fx_evidence_sha256 as CanonicalValue,
    (inner) => readSha256(inner, "graph.fx_evidence_sha256"),
  );
  if ((fxEvidenceId === null) !== (fxEvidenceSha === null)) {
    fail(
      "invalid_graph",
      "graph FX evidence ID and SHA must both be null or both set",
    );
  }

  return {
    schema: GRAPH_SCHEMA_NAME,
    registry: REGISTRY_NAME,
    limits: LIMITS_NAME,
    graph_id: readUuid(object.graph_id as CanonicalValue, "graph.graph_id"),
    contract_set_id: readUuid(
      object.contract_set_id as CanonicalValue,
      "graph.contract_set_id",
    ),
    contract_id: readUuid(
      object.contract_id as CanonicalValue,
      "graph.contract_id",
    ),
    contract_version: readBoundedI64(
      object.contract_version as CanonicalValue,
      "graph.contract_version",
      1n,
      I64_MAX,
    ),
    contract_output_node_id: readUuid(
      object.contract_output_node_id as CanonicalValue,
      "graph.contract_output_node_id",
    ),
    threshold_node_id: readNullable(
      object.threshold_node_id as CanonicalValue,
      (inner) => readUuid(inner, "graph.threshold_node_id"),
    ),
    target_node_id: readNullable(
      object.target_node_id as CanonicalValue,
      (inner) => readUuid(inner, "graph.target_node_id"),
    ),
    input_snapshot_id: readUuid(
      object.input_snapshot_id as CanonicalValue,
      "graph.input_snapshot_id",
    ),
    input_sha256: readSha256(
      object.input_sha256 as CanonicalValue,
      "graph.input_sha256",
    ),
    field_catalog_snapshot_id: readUuid(
      object.field_catalog_snapshot_id as CanonicalValue,
      "graph.field_catalog_snapshot_id",
    ),
    field_catalog_sha256: readSha256(
      object.field_catalog_sha256 as CanonicalValue,
      "graph.field_catalog_sha256",
    ),
    common_bundle_id: readUuid(
      object.common_bundle_id as CanonicalValue,
      "graph.common_bundle_id",
    ),
    common_bundle_sha256: readSha256(
      object.common_bundle_sha256 as CanonicalValue,
      "graph.common_bundle_sha256",
    ),
    evaluation_time: readText(
      object.evaluation_time as CanonicalValue,
      "graph.evaluation_time",
    ),
    evaluation_micros: evaluationMicros,
    timezone,
    tzdb_version: tzdb,
    unit_registry_version: UNIT_REGISTRY_VERSION,
    fx_evidence_id: fxEvidenceId,
    fx_evidence_sha256: fxEvidenceSha,
    nodes,
    output_node_ids: outputNodeIds,
    canonicalText,
    canonicalBytes: utf8ByteLength(canonicalText),
    graph_sha256: rowHash("dasher.calculation-graph.v1", canonicalText),
  };
}

/** Every node ID referenced by one node, used for depth, cycle, and reference checks. */
export function referencedNodeIds(node: GraphNode): readonly string[] {
  const refs: string[] = [];
  const push = (value: string | undefined): void => {
    if (value !== undefined) refs.push(value);
  };
  push(node.input);
  push(node.predicate);
  push(node.left);
  push(node.right);
  push(node.condition);
  push(node.when_true);
  push(node.when_false);
  push(node.group_node_id);
  for (const id of node.key_node_ids ?? []) refs.push(id);
  for (const id of node.partition_node_ids ?? []) refs.push(id);
  for (const id of node.inputs ?? []) refs.push(id);
  for (const key of node.keys ?? []) refs.push(key.value_node_id);
  for (const projection of node.projections ?? []) {
    refs.push(projection.value_node_id);
  }
  if (node.evaluation_rows_from !== null) refs.push(node.evaluation_rows_from);
  return refs;
}

/* ------------------------------------------------------------------ *
 * canonical-input-table-v1
 * ------------------------------------------------------------------ */

export interface InputField {
  readonly field_id: string;
  readonly scalar_type: ScalarType;
  readonly nullable: boolean;
  readonly stable_key_ordinal: bigint | null;
}

export interface InputRow {
  readonly row_id: string;
  readonly values: ReadonlyMap<string, RuntimeValue>;
}

export interface CanonicalInputTable {
  readonly input_snapshot_id: string;
  readonly row_count: bigint;
  readonly fields: readonly InputField[];
  readonly rows: readonly InputRow[];
  readonly canonicalText: string;
  readonly canonicalBytes: bigint;
  readonly input_sha256: string;
}

/**
 * Parses the sole Task 9 calculation input representation from its exact bytes.
 * The engine accepts only the bytes returned by the claimed-input read.
 */
export function parseCanonicalInputTable(
  value: CanonicalValue,
  canonicalText: string,
): CanonicalInputTable {
  const canonicalBytes = utf8ByteLength(canonicalText);
  if (canonicalBytes < 1n || canonicalBytes > LIMITS.canonicalInputBytes) {
    fail(
      "limit_exceeded",
      "canonical input bytes exceed the inclusive ceiling",
    );
  }
  const object = readObject(value, "input");
  requireExactKeys(
    object,
    ["schema", "input_snapshot_id", "row_count", "fields", "rows"],
    "input",
  );
  readLiteralText(
    object.schema as CanonicalValue,
    "input.schema",
    "canonical-input-table-v1",
  );
  const rawFields = readArray(object.fields as CanonicalValue, "input.fields");
  if (rawFields.length < 1 || rawFields.length > 512) {
    fail("invalid_graph", "input.fields must hold 1..512 entries");
  }
  const fields = rawFields.map((field, index) => {
    const path = `input.fields[${index}]`;
    const entry = readObject(field, path);
    requireExactKeys(
      entry,
      ["field_id", "scalar_type", "nullable", "stable_key_ordinal"],
      path,
    );
    return {
      field_id: readUuid(entry.field_id as CanonicalValue, `${path}.field_id`),
      scalar_type: readEnum(
        entry.scalar_type as CanonicalValue,
        `${path}.scalar_type`,
        INPUT_SCALAR_TYPES,
      ),
      nullable: readBoolean(
        entry.nullable as CanonicalValue,
        `${path}.nullable`,
      ),
      stable_key_ordinal: readNullable(
        entry.stable_key_ordinal as CanonicalValue,
        (inner) =>
          readBoundedI64(inner, `${path}.stable_key_ordinal`, 0n, I64_MAX),
      ),
    } satisfies InputField;
  });
  for (let index = 1; index < fields.length; index += 1) {
    const previous = fields[index - 1] as InputField;
    const current = fields[index] as InputField;
    if (compareUtf8(previous.field_id, current.field_id) >= 0) {
      fail(
        "invalid_graph",
        "input.fields must be sorted and unique by field UUID",
      );
    }
  }
  const ordinals = fields
    .map((field) => field.stable_key_ordinal)
    .filter((ordinal): ordinal is bigint => ordinal !== null)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (ordinals.length === 0) {
    fail("invalid_graph", "input.fields must declare at least one stable key");
  }
  for (let index = 0; index < ordinals.length; index += 1) {
    if (ordinals[index] !== BigInt(index)) {
      fail(
        "invalid_graph",
        "stable key ordinals must be exactly i64:0..i64:k-1",
      );
    }
  }

  const rawRows = readArray(object.rows as CanonicalValue, "input.rows");
  if (rawRows.length > Number(LIMITS.scannedRows)) {
    fail("limit_exceeded", "input.rows exceeds 10,000 rows");
  }
  const rows = rawRows.map((row, index) => {
    const path = `input.rows[${index}]`;
    const entry = readObject(row, path);
    requireExactKeys(entry, ["row_id", "values"], path);
    const rawValues = readArray(
      entry.values as CanonicalValue,
      `${path}.values`,
    );
    if (rawValues.length !== fields.length) {
      fail("invalid_graph", `${path}.values must hold one entry per field`);
    }
    const values = new Map<string, RuntimeValue>();
    for (let cell = 0; cell < rawValues.length; cell += 1) {
      const cellPath = `${path}.values[${cell}]`;
      const field = fields[cell] as InputField;
      const cellObject = readObject(
        rawValues[cell] as CanonicalValue,
        cellPath,
      );
      requireExactKeys(
        cellObject,
        ["field_id", "state", "type", "value"],
        cellPath,
      );
      const fieldId = readUuid(
        cellObject.field_id as CanonicalValue,
        `${cellPath}.field_id`,
      );
      if (fieldId !== field.field_id) {
        fail("invalid_graph", `${cellPath} must be sorted by field UUID`);
      }
      const typed = parseTypedValue(
        {
          state: cellObject.state as CanonicalValue,
          type: cellObject.type as CanonicalValue,
          value: cellObject.value as CanonicalValue,
        },
        cellPath,
        { expectedType: field.scalar_type, allowedTypes: INPUT_SCALAR_TYPES },
      );
      if (typed.state === "null" && !field.nullable) {
        fail(
          "invalid_graph",
          `${cellPath} may not be null for a nonnullable field`,
        );
      }
      if (field.stable_key_ordinal !== null && typed.state !== "present") {
        fail("invalid_graph", `${cellPath} stable-key values must be present`);
      }
      values.set(fieldId, typed);
    }
    return {
      row_id: readUuid(entry.row_id as CanonicalValue, `${path}.row_id`),
      values,
    };
  });

  const rowCount = readTaggedI64(
    object.row_count as CanonicalValue,
    "input.row_count",
  );
  if (rowCount !== BigInt(rows.length)) {
    fail("invalid_graph", "input.row_count must equal rows.length");
  }
  const rowIds = new Set<string>();
  for (const row of rows) {
    if (rowIds.has(row.row_id))
      fail("invalid_graph", "input row IDs must be unique");
    rowIds.add(row.row_id);
  }

  return {
    input_snapshot_id: readUuid(
      object.input_snapshot_id as CanonicalValue,
      "input.input_snapshot_id",
    ),
    row_count: rowCount,
    fields,
    rows,
    canonicalText,
    canonicalBytes,
    input_sha256: rowHash("dasher.canonical-input-table.v1", canonicalText),
  };
}

/* ------------------------------------------------------------------ *
 * field-catalog-snapshot-v1
 * ------------------------------------------------------------------ */

export const AGGREGATIONS = [
  "count",
  "count_distinct",
  "sum",
  "min",
  "max",
  "mean",
  "median",
  "ratio",
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const SEMANTIC_TYPES = [
  "identifier",
  "measure",
  "dimension",
  "event_time",
  "attribute",
] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

export interface CatalogField {
  readonly field_id: string;
  readonly source_path: string;
  readonly logical_name: string;
  readonly scalar_type: ScalarType;
  readonly nullable: boolean;
  readonly semantic_type: SemanticType;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly grain: string | null;
  readonly event_time_field_id: string | null;
  readonly stable_key_ordinal: bigint | null;
  readonly max_value_bytes: bigint;
  readonly allowed_aggregations: readonly Aggregation[];
  readonly allowed_dimensions: readonly string[];
  readonly lineage_evidence_ids: readonly string[];
  readonly entry_sha256: string;
}

export interface FieldCatalogSnapshot {
  readonly catalog_snapshot_id: string;
  readonly input_snapshot_id: string;
  readonly input_sha256: string;
  readonly input_row_count: bigint;
  readonly evaluated_at: string;
  readonly evaluated_micros: bigint;
  readonly fields: readonly CatalogField[];
  readonly canonicalText: string;
  readonly catalog_sha256: string;
}

const CATALOG_FIELD_KEYS = [
  "field_id",
  "source_path",
  "logical_name",
  "scalar_type",
  "nullable",
  "semantic_type",
  "unit",
  "currency",
  "grain",
  "event_time_field_id",
  "stable_key_ordinal",
  "max_value_bytes",
  "allowed_aggregations",
  "allowed_dimensions",
  "lineage_evidence_ids",
] as const;

export function parseFieldCatalogSnapshot(
  value: CanonicalValue,
  canonicalText: string,
): FieldCatalogSnapshot {
  const object = readObject(value, "catalog");
  requireExactKeys(
    object,
    [
      "schema",
      "catalog_snapshot_id",
      "input_snapshot_id",
      "input_sha256",
      "input_row_count",
      "evaluated_at",
      "fields",
    ],
    "catalog",
  );
  readLiteralText(
    object.schema as CanonicalValue,
    "catalog.schema",
    "field-catalog-snapshot-v1",
  );
  const rawFields = readArray(
    object.fields as CanonicalValue,
    "catalog.fields",
  );
  if (rawFields.length < 1 || rawFields.length > 512) {
    fail("invalid_graph", "catalog.fields must hold 1..512 entries");
  }
  const fields = rawFields.map((field, index) => {
    const path = `catalog.fields[${index}]`;
    const entry = readObject(field, path);
    requireExactKeys(entry, CATALOG_FIELD_KEYS, path);
    const scalarType = readEnum(
      entry.scalar_type as CanonicalValue,
      `${path}.scalar_type`,
      INPUT_SCALAR_TYPES,
    );
    const unit = readNullable(entry.unit as CanonicalValue, (inner) =>
      readUnitLiteral(inner, `${path}.unit`),
    );
    const currency = readNullable(entry.currency as CanonicalValue, (inner) =>
      readCurrencyLiteral(inner, `${path}.currency`),
    );
    requireScalarMetadataValidity(scalarType, unit, currency, path);
    const width = readTaggedI64(
      entry.max_value_bytes as CanonicalValue,
      `${path}.max_value_bytes`,
    );
    if (width <= 0n) {
      fail("type_mismatch", `${path}.max_value_bytes must be positive`);
    }
    return {
      field_id: readUuid(entry.field_id as CanonicalValue, `${path}.field_id`),
      source_path: readBoundedTextBytes(
        entry.source_path as CanonicalValue,
        `${path}.source_path`,
        1n,
        256n,
      ),
      logical_name: readBoundedTextBytes(
        entry.logical_name as CanonicalValue,
        `${path}.logical_name`,
        1n,
        256n,
      ),
      scalar_type: scalarType,
      nullable: readBoolean(
        entry.nullable as CanonicalValue,
        `${path}.nullable`,
      ),
      semantic_type: readEnum(
        entry.semantic_type as CanonicalValue,
        `${path}.semantic_type`,
        SEMANTIC_TYPES,
      ),
      unit,
      currency,
      grain: readNullable(entry.grain as CanonicalValue, (inner) =>
        readBoundedTextBytes(inner, `${path}.grain`, 1n, 128n),
      ),
      event_time_field_id: readNullable(
        entry.event_time_field_id as CanonicalValue,
        (inner) => readUuid(inner, `${path}.event_time_field_id`),
      ),
      stable_key_ordinal: readNullable(
        entry.stable_key_ordinal as CanonicalValue,
        (inner) =>
          readBoundedI64(inner, `${path}.stable_key_ordinal`, 0n, I64_MAX),
      ),
      max_value_bytes: width,
      allowed_aggregations: readSortedUniqueTexts(
        entry.allowed_aggregations as CanonicalValue,
        `${path}.allowed_aggregations`,
        0,
        8,
      ).map((text) => {
        if (!(AGGREGATIONS as readonly string[]).includes(text)) {
          fail(
            "invalid_graph",
            `${path}.allowed_aggregations holds an unknown value`,
          );
        }
        return text as Aggregation;
      }),
      allowed_dimensions: readSortedUniqueUuids(
        entry.allowed_dimensions as CanonicalValue,
        `${path}.allowed_dimensions`,
        0,
        64,
      ),
      lineage_evidence_ids: readSortedUniqueUuids(
        entry.lineage_evidence_ids as CanonicalValue,
        `${path}.lineage_evidence_ids`,
        1,
        64,
      ),
      entry_sha256: rowHash("dasher.field-catalog-entry.v1", jcsEncode(entry)),
    } satisfies CatalogField;
  });
  for (let index = 1; index < fields.length; index += 1) {
    const previous = fields[index - 1] as CatalogField;
    const current = fields[index] as CatalogField;
    if (compareUtf8(previous.field_id, current.field_id) >= 0) {
      fail(
        "invalid_graph",
        "catalog.fields must be sorted and unique by field UUID",
      );
    }
  }
  const ordinals = fields
    .map((field) => field.stable_key_ordinal)
    .filter((ordinal): ordinal is bigint => ordinal !== null)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (ordinals.length === 0) {
    fail(
      "invalid_graph",
      "catalog.fields must declare at least one stable key",
    );
  }
  for (let index = 0; index < ordinals.length; index += 1) {
    if (ordinals[index] !== BigInt(index)) {
      fail(
        "invalid_graph",
        "catalog stable key ordinals must be i64:0..i64:k-1",
      );
    }
  }
  const evaluatedAt = readText(
    object.evaluated_at as CanonicalValue,
    "catalog.evaluated_at",
  );
  return {
    catalog_snapshot_id: readUuid(
      object.catalog_snapshot_id as CanonicalValue,
      "catalog.catalog_snapshot_id",
    ),
    input_snapshot_id: readUuid(
      object.input_snapshot_id as CanonicalValue,
      "catalog.input_snapshot_id",
    ),
    input_sha256: readSha256(
      object.input_sha256 as CanonicalValue,
      "catalog.input_sha256",
    ),
    input_row_count: readBoundedI64(
      object.input_row_count as CanonicalValue,
      "catalog.input_row_count",
      0n,
      I64_MAX,
    ),
    evaluated_at: evaluatedAt,
    evaluated_micros: readTimestamp(evaluatedAt, "catalog.evaluated_at"),
    fields,
    canonicalText,
    catalog_sha256: rowHash("dasher.field-catalog-snapshot.v1", canonicalText),
  };
}

/* ------------------------------------------------------------------ *
 * metric-contract-set-v1
 * ------------------------------------------------------------------ */

export const VALUE_TYPES = [
  "integer",
  "decimal",
  "currency",
  "percentage",
  "duration",
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export const DIRECTIONS = [
  "higher_is_better",
  "lower_is_better",
  "target_band",
  "neutral",
] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const CALENDARS = ["gregorian", "iso_week", "fiscal_445"] as const;
export type Calendar = (typeof CALENDARS)[number];

export interface MetricContractVersion {
  readonly contract_id: string;
  readonly version: bigint;
  readonly business_owner_membership_id: string;
  readonly data_owner_membership_id: string;
  readonly name: string;
  readonly definition: string;
  readonly measure_field_id: string;
  readonly aggregation: Aggregation;
  readonly denominator_contract_id: string | null;
  readonly denominator_contract_version: bigint | null;
  readonly value_type: ValueType;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly direction: Direction;
  readonly threshold: string | null;
  readonly target: string | null;
  readonly grain: string;
  readonly lag_millis: bigint;
  readonly freshness_slo_millis: bigint;
  readonly allowed_dimension_field_ids: readonly string[];
  readonly calendar: Calendar;
  readonly timezone: string;
  readonly lineage_evidence_ids: readonly string[];
  readonly review_state: "reviewed";
  readonly contract_sha256: string;
}

export interface MetricContractSet {
  readonly contract_set_id: string;
  readonly catalog_snapshot_id: string;
  readonly contracts: readonly MetricContractVersion[];
  readonly canonicalText: string;
  readonly contract_set_sha256: string;
}

const CONTRACT_KEYS = [
  "contract_id",
  "version",
  "business_owner_membership_id",
  "data_owner_membership_id",
  "name",
  "definition",
  "measure_field_id",
  "aggregation",
  "denominator_contract_id",
  "denominator_contract_version",
  "value_type",
  "unit",
  "currency",
  "direction",
  "threshold",
  "target",
  "grain",
  "lag_millis",
  "freshness_slo_millis",
  "allowed_dimension_field_ids",
  "calendar",
  "timezone",
  "lineage_evidence_ids",
  "review_state",
] as const;

/**
 * The exact threshold/target grammar `0|-?[1-9][0-9]*(\.[0-9]*[1-9])?`, parsed
 * directly to a reduced rational. Negative zero and trailing fractional zeroes
 * are rejected.
 */
export function parseContractDecimalText(
  text: string,
  path: string,
): { readonly value: Rational; readonly scale: bigint } {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const integerPart = dot < 0 ? body : body.slice(0, dot);
  const fractionPart = dot < 0 ? "" : body.slice(dot + 1);
  const isDigits = (value: string): boolean => {
    if (value.length === 0) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x30 || code > 0x39) return false;
    }
    return true;
  };
  if (!isDigits(integerPart))
    fail("invalid_graph", `${path} is not canonical decimal text`);
  if (integerPart.length > 1 && integerPart.startsWith("0")) {
    fail("invalid_graph", `${path} has a leading zero`);
  }
  if (integerPart === "0" && negative) {
    fail("invalid_graph", `${path} forbids negative zero`);
  }
  if (dot >= 0) {
    if (!isDigits(fractionPart)) {
      fail("invalid_graph", `${path} is not canonical decimal text`);
    }
    if (fractionPart.endsWith("0")) {
      fail("invalid_graph", `${path} has a trailing fractional zero`);
    }
    if (fractionPart.length > Number(LIMITS.scale)) {
      fail(
        "invalid_graph",
        `${path} exceeds ${Number(LIMITS.scale)} fractional digits`,
      );
    }
  }
  const digits = `${integerPart}${fractionPart}`;
  if (
    digits.replace("0", "").length > 0 &&
    digits.length > Number(LIMITS.coefficientDigits)
  ) {
    fail(
      "invalid_graph",
      `${path} exceeds ${Number(LIMITS.coefficientDigits)} coefficient digits`,
    );
  }
  const scale = BigInt(fractionPart.length);
  const coefficient = BigInt(digits) * (negative ? -1n : 1n);
  return { value: rational(coefficient, 10n ** scale), scale };
}

export function parseMetricContractSet(
  value: CanonicalValue,
  canonicalText: string,
): MetricContractSet {
  const object = readObject(value, "contract_set");
  requireExactKeys(
    object,
    ["schema", "contract_set_id", "catalog_snapshot_id", "contracts"],
    "contract_set",
  );
  readLiteralText(
    object.schema as CanonicalValue,
    "contract_set.schema",
    "metric-contract-set-v1",
  );
  const rawContracts = readArray(
    object.contracts as CanonicalValue,
    "contract_set.contracts",
  );
  if (rawContracts.length < 1 || rawContracts.length > 64) {
    fail("invalid_graph", "contract_set.contracts must hold 1..64 entries");
  }
  const contracts = rawContracts.map((contract, index) => {
    const path = `contract_set.contracts[${index}]`;
    const entry = readObject(contract, path);
    requireExactKeys(entry, CONTRACT_KEYS, path);
    const unit = readNullable(entry.unit as CanonicalValue, (inner) =>
      readUnitLiteral(inner, `${path}.unit`),
    );
    const currency = readNullable(entry.currency as CanonicalValue, (inner) =>
      readCurrencyLiteral(inner, `${path}.currency`),
    );
    if (unit !== null && currency !== null) {
      fail("unit_mismatch", `${path} cannot carry both a unit and a currency`);
    }
    const readDecimalText = (
      raw: CanonicalValue,
      name: string,
    ): string | null =>
      readNullable(raw, (inner) => {
        const text = readText(inner, `${path}.${name}`);
        parseContractDecimalText(text, `${path}.${name}`);
        return text;
      });
    return {
      contract_id: readUuid(
        entry.contract_id as CanonicalValue,
        `${path}.contract_id`,
      ),
      version: readBoundedI64(
        entry.version as CanonicalValue,
        `${path}.version`,
        1n,
        I64_MAX,
      ),
      business_owner_membership_id: readUuid(
        entry.business_owner_membership_id as CanonicalValue,
        `${path}.business_owner_membership_id`,
      ),
      data_owner_membership_id: readUuid(
        entry.data_owner_membership_id as CanonicalValue,
        `${path}.data_owner_membership_id`,
      ),
      name: readBoundedTextBytes(
        entry.name as CanonicalValue,
        `${path}.name`,
        1n,
        256n,
      ),
      definition: readBoundedTextBytes(
        entry.definition as CanonicalValue,
        `${path}.definition`,
        1n,
        4096n,
      ),
      measure_field_id: readUuid(
        entry.measure_field_id as CanonicalValue,
        `${path}.measure_field_id`,
      ),
      aggregation: readEnum(
        entry.aggregation as CanonicalValue,
        `${path}.aggregation`,
        AGGREGATIONS,
      ),
      denominator_contract_id: readNullable(
        entry.denominator_contract_id as CanonicalValue,
        (inner) => readUuid(inner, `${path}.denominator_contract_id`),
      ),
      denominator_contract_version: readNullable(
        entry.denominator_contract_version as CanonicalValue,
        (inner) =>
          readBoundedI64(
            inner,
            `${path}.denominator_contract_version`,
            1n,
            I64_MAX,
          ),
      ),
      value_type: readEnum(
        entry.value_type as CanonicalValue,
        `${path}.value_type`,
        VALUE_TYPES,
      ),
      unit,
      currency,
      direction: readEnum(
        entry.direction as CanonicalValue,
        `${path}.direction`,
        DIRECTIONS,
      ),
      threshold: readDecimalText(
        entry.threshold as CanonicalValue,
        "threshold",
      ),
      target: readDecimalText(entry.target as CanonicalValue, "target"),
      grain: readBoundedTextBytes(
        entry.grain as CanonicalValue,
        `${path}.grain`,
        1n,
        128n,
      ),
      lag_millis: readBoundedI64(
        entry.lag_millis as CanonicalValue,
        `${path}.lag_millis`,
        0n,
        31536000000n,
      ),
      freshness_slo_millis: readBoundedI64(
        entry.freshness_slo_millis as CanonicalValue,
        `${path}.freshness_slo_millis`,
        1n,
        31536000000n,
      ),
      allowed_dimension_field_ids: readSortedUniqueUuids(
        entry.allowed_dimension_field_ids as CanonicalValue,
        `${path}.allowed_dimension_field_ids`,
        0,
        32,
      ),
      calendar: readEnum(
        entry.calendar as CanonicalValue,
        `${path}.calendar`,
        CALENDARS,
      ),
      timezone: readText(entry.timezone as CanonicalValue, `${path}.timezone`),
      lineage_evidence_ids: readSortedUniqueUuids(
        entry.lineage_evidence_ids as CanonicalValue,
        `${path}.lineage_evidence_ids`,
        1,
        64,
      ),
      review_state: readLiteralText(
        entry.review_state as CanonicalValue,
        `${path}.review_state`,
        "reviewed",
      ) as "reviewed",
      contract_sha256: rowHash(
        "dasher.metric-contract-version.v1",
        jcsEncode(entry),
      ),
    } satisfies MetricContractVersion;
  });
  for (const contract of contracts) {
    if (!isIanaZoneName(contract.timezone)) {
      fail("invalid_timezone", "contract timezone is not an exact IANA name");
    }
  }
  return {
    contract_set_id: readUuid(
      object.contract_set_id as CanonicalValue,
      "contract_set.contract_set_id",
    ),
    catalog_snapshot_id: readUuid(
      object.catalog_snapshot_id as CanonicalValue,
      "contract_set.catalog_snapshot_id",
    ),
    contracts,
    canonicalText,
    contract_set_sha256: rowHash(
      "dasher.metric-contract-set.v1",
      canonicalText,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * common-evidence-bundle-v1 and fx-rate-evidence-v1
 * ------------------------------------------------------------------ */

export interface BundleEntry {
  readonly evidence_id: string;
  readonly evidence_sha256: string;
  readonly source_snapshot_id: string;
  readonly source_sha256: string;
  readonly freshness: "current" | "stale";
  readonly observed_at: string;
  readonly observed_micros: bigint;
}

export interface CommonEvidenceBundle {
  readonly bundle_id: string;
  readonly source_snapshot_id: string;
  readonly entries: readonly BundleEntry[];
  readonly canonicalText: string;
  readonly bundle_sha256: string;
}

export function parseCommonEvidenceBundle(
  value: CanonicalValue,
  canonicalText: string,
): CommonEvidenceBundle {
  const object = readObject(value, "bundle");
  requireExactKeys(
    object,
    ["schema", "bundle_id", "source_snapshot_id", "entries"],
    "bundle",
  );
  readLiteralText(
    object.schema as CanonicalValue,
    "bundle.schema",
    "common-evidence-bundle-v1",
  );
  const rawEntries = readArray(
    object.entries as CanonicalValue,
    "bundle.entries",
  );
  if (rawEntries.length < 1 || rawEntries.length > 256) {
    fail("invalid_graph", "bundle.entries must hold 1..256 entries");
  }
  const entries = rawEntries.map((entry, index) => {
    const path = `bundle.entries[${index}]`;
    const object_ = readObject(entry, path);
    requireExactKeys(
      object_,
      [
        "evidence_id",
        "evidence_sha256",
        "source_snapshot_id",
        "source_sha256",
        "freshness",
        "observed_at",
      ],
      path,
    );
    const observedAt = readText(
      object_.observed_at as CanonicalValue,
      `${path}.observed_at`,
    );
    return {
      evidence_id: readUuid(
        object_.evidence_id as CanonicalValue,
        `${path}.evidence_id`,
      ),
      evidence_sha256: readSha256(
        object_.evidence_sha256 as CanonicalValue,
        `${path}.evidence_sha256`,
      ),
      source_snapshot_id: readUuid(
        object_.source_snapshot_id as CanonicalValue,
        `${path}.source_snapshot_id`,
      ),
      source_sha256: readSha256(
        object_.source_sha256 as CanonicalValue,
        `${path}.source_sha256`,
      ),
      freshness: readEnum(
        object_.freshness as CanonicalValue,
        `${path}.freshness`,
        ["current", "stale"] as const,
      ),
      observed_at: observedAt,
      observed_micros: readTimestamp(observedAt, `${path}.observed_at`),
    } satisfies BundleEntry;
  });
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as BundleEntry;
    const current = entries[index] as BundleEntry;
    if (compareUtf8(previous.evidence_id, current.evidence_id) >= 0) {
      fail(
        "invalid_graph",
        "bundle.entries must be sorted and unique by evidence UUID",
      );
    }
  }
  return {
    bundle_id: readUuid(object.bundle_id as CanonicalValue, "bundle.bundle_id"),
    source_snapshot_id: readUuid(
      object.source_snapshot_id as CanonicalValue,
      "bundle.source_snapshot_id",
    ),
    entries,
    canonicalText,
    bundle_sha256: rowHash("dasher.common-evidence-bundle.v1", canonicalText),
  };
}

export interface FxRateEvidence {
  readonly from_currency: string;
  readonly to_currency: string;
  readonly rate: CanonicalDecimal;
  readonly observed_at: string;
  readonly observed_micros: bigint;
  readonly canonicalText: string;
  readonly evidence_sha256: string;
  readonly coordinates: string;
}

export function parseFxRateEvidence(
  value: CanonicalValue,
  canonicalText: string,
): FxRateEvidence {
  if (utf8ByteLength(canonicalText) > LIMITS.literalBytes) {
    fail(
      "missing_fx_evidence",
      `fx evidence exceeds ${LIMITS.literalBytes} canonical bytes`,
    );
  }
  const object = readObject(value, "fx_evidence");
  requireExactKeys(
    object,
    ["schema", "from_currency", "to_currency", "rate", "observed_at"],
    "fx_evidence",
  );
  readLiteralText(
    object.schema as CanonicalValue,
    "fx_evidence.schema",
    "fx-rate-evidence-v1",
  );
  const fromCurrency = readCurrencyLiteral(
    object.from_currency as CanonicalValue,
    "fx_evidence.from_currency",
  );
  const toCurrency = readCurrencyLiteral(
    object.to_currency as CanonicalValue,
    "fx_evidence.to_currency",
  );
  const rate = parseDecimalObject(object.rate as CanonicalValue);
  if (rate === null || rate.coefficient <= 0n) {
    fail(
      "missing_fx_evidence",
      "fx_evidence.rate must be a positive canonical decimal",
    );
  }
  if (rate.coefficient.toString(10).length > 18) {
    fail(
      "missing_fx_evidence",
      "fx_evidence.rate exceeds 18 coefficient digits",
    );
  }
  const observedAt = readText(
    object.observed_at as CanonicalValue,
    "fx_evidence.observed_at",
  );
  return {
    from_currency: fromCurrency,
    to_currency: toCurrency,
    rate,
    observed_at: observedAt,
    observed_micros: readTimestamp(observedAt, "fx_evidence.observed_at"),
    canonicalText,
    evidence_sha256: rowHash("dasher.fx-rate-evidence.v1", canonicalText),
    coordinates: `task9-fx:${fromCurrency}/${toCurrency}`,
  };
}

/* ------------------------------------------------------------------ *
 * Document snapshotting helpers
 * ------------------------------------------------------------------ */

export interface CanonicalDocument {
  readonly value: CanonicalValue;
  readonly canonicalText: string;
}

/**
 * Snapshots an untrusted document exactly once and re-encodes it canonically.
 * Callers pass the resulting frozen value to the strict parsers.
 */
export function canonicalizeDocument(value: unknown): CanonicalDocument {
  const snapshot = snapshotUntrusted(value);
  return { value: snapshot, canonicalText: jcsEncode(snapshot) };
}

/** The exact JCS token width of a text value, for `W(text)` accounting. */
export function textTokenWidth(text: string): bigint {
  return jcsStringTokenBytes(text);
}
