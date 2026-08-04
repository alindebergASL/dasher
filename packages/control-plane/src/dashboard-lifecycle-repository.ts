import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { types as utilityTypes } from "node:util";

import {
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  type OperationInternalOutcome,
  type PgCompatibleClient,
  type PgCompatiblePool,
  type PgCompatibleQueryResult,
} from "./invitation-repository.js";
import {
  SecretKeyRing,
  SecretPrimitiveError,
  type SecretPersistenceMaterial,
} from "./secrets.js";
import type {
  CompareAndSwapDashboardHeadInput,
  CompareAndSwapDashboardHeadResult,
  CreateDashboardInput,
  CreateDashboardResult,
  CreateDashboardVersionInput,
  CreateDashboardVersionResult,
  CreateEvidenceRecordInput,
  CreateEvidenceRecordResult,
  DashboardAdminProjection,
  DashboardArtifactOwnershipClass,
  DashboardCleanupStep,
  DashboardEvidenceKind,
  DashboardEvidenceProjection,
  DashboardKind,
  DashboardLifecycleRepositoryConfig,
  DashboardLifecycleState,
  DashboardLineageProjection,
  DashboardPromotionDecision,
  DashboardSummary,
  DashboardVersionProjection,
  DecideDashboardPromotionInput,
  DecideDashboardPromotionResult,
  DeleteDashboardInput,
  DeleteDashboardResult,
  GetDashboardAdminStatusInput,
  GetDashboardAdminStatusResult,
  GetDashboardEvidenceInput,
  GetDashboardEvidenceResult,
  GetDashboardHeadInput,
  GetDashboardHeadResult,
  GetDashboardLineageInput,
  GetDashboardLineageResult,
  GetDashboardSummaryInput,
  GetDashboardSummaryResult,
  GetDashboardVersionInput,
  GetDashboardVersionResult,
  ListDashboardsInput,
  ListDashboardsResult,
  RequestDashboardPromotionInput,
  RequestDashboardPromotionResult,
  RestoreDashboardAsNewInput,
  RestoreDashboardAsNewResult,
  SetDashboardArchiveInput,
  SetDashboardArchiveResult,
} from "./dashboard-lifecycle-types.js";

const randomUuidCapability = randomUUID;
const createHashCapability = createHash;
const timingSafeEqualCapability = timingSafeEqual;
const isProxyCapability = utilityTypes.isProxy;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const arraySlice = Array.prototype.slice;
const dateConstructor = Date;
const dateGetTime = Date.prototype.getTime;
const datePrototype = Date.prototype;
const numberConstructor = Number;
const numberIsSafeInteger = Number.isSafeInteger;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const ownKeys = Reflect.ownKeys;
const promiseConstructor = Promise;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const regexpTest = RegExp.prototype.test;
const setAdd = Set.prototype.add;
const setConstructor = Set;
const setHas = Set.prototype.has;
const secretKeyRingVerify = SecretKeyRing.prototype.verify;
const secretPrimitiveErrorPrototype = SecretPrimitiveError.prototype;
const stringCharCodeAt = String.prototype.charCodeAt;
const uint8ArrayConstructor = Uint8Array;
const uint8ArraySet = Uint8Array.prototype.set;
const typedArrayPrototype = objectGetPrototypeOf(
  uint8ArrayConstructor.prototype,
);
const typedArrayByteLengthGetter = objectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const hashMethodProbe = createHashCapability("sha256");
const hashUpdate = hashMethodProbe.update;
const hashDigest = hashMethodProbe.digest;
reflectApply(hashDigest, hashMethodProbe, []);

const maximumGeneratedUuidAttempts = 16;
const maximumCanonicalSpecBytes = 1_048_576;
const maximumReferenceIds = 1_000;
const maximumRevisionDigits = 19;
const maximumDeploymentScalars = 64;
const maximumDeploymentUtf16CodeUnits = maximumDeploymentScalars * 2;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nonnegativeIntegerPattern = /^(0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const preflightInputInvalid = objectFreeze({});
const preflightInternalFault = objectFreeze({});
const keyRingBrandProbe =
  "s1.32767.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const initializeContextSql = `SELECT
  result.session_id,
  result.user_id,
  result.organization_id,
  result.membership_id,
  result.authority_revision,
  result.idle_expires_at,
  result.absolute_expires_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.initialize_context(
  $1::smallint,
  $2::bytea,
  $3::uuid
) AS result`;

const listDashboardsSql = `SELECT
  result.dashboard_id,
  result.title,
  result.current_kind,
  result.lifecycle_state,
  result.lifecycle_revision,
  result.effective_expires_at,
  result.head_version_id
FROM dasher_api.list_dashboards($1::integer) AS result`;

const getDashboardSummarySql = `SELECT
  result.dashboard_id,
  result.title,
  result.current_kind,
  result.lifecycle_state,
  result.lifecycle_revision,
  result.effective_expires_at,
  result.head_version_id
FROM dasher_api.get_dashboard_summary($1::uuid) AS result`;

const getDashboardHeadSql = `SELECT
  result.dashboard_id,
  result.version_id,
  result.parent_version_id,
  result.canonical_spec_bytes,
  result.canonical_spec_sha256,
  result.validation_state,
  result.validation_sha256,
  result.planner_provenance_sha256,
  result.policy_revision,
  result.registry_revision,
  result.calculation_graph_sha256,
  result.created_at
FROM dasher_api.get_dashboard_head($1::uuid) AS result`;

const getDashboardVersionSql = `SELECT
  result.dashboard_id,
  result.version_id,
  result.parent_version_id,
  result.canonical_spec_bytes,
  result.canonical_spec_sha256,
  result.validation_state,
  result.validation_sha256,
  result.planner_provenance_sha256,
  result.policy_revision,
  result.registry_revision,
  result.calculation_graph_sha256,
  result.created_at
FROM dasher_api.get_dashboard_version(
  $1::uuid,
  $2::uuid
) AS result`;

const getDashboardEvidenceSql = `SELECT
  result.dashboard_id,
  result.version_id,
  result.evidence_id,
  result.evidence_kind,
  result.content_sha256,
  result.observed_at,
  result.retrieved_at
FROM dasher_api.get_dashboard_evidence(
  $1::uuid,
  $2::uuid
) AS result`;

const getDashboardLineageSql = `SELECT
  result.dashboard_id,
  result.version_id,
  result.parent_version_id,
  result.snapshot_id,
  result.evidence_id,
  result.artifact_id,
  result.artifact_ownership_class
FROM dasher_api.get_dashboard_lineage(
  $1::uuid,
  $2::uuid
) AS result`;

const getDashboardAdminStatusSql = `SELECT
  result.dashboard_id,
  result.lifecycle_state,
  result.lifecycle_revision,
  result.capability_epoch,
  result.cache_epoch,
  result.access_revoked_at,
  result.purge_after,
  result.purge_started_at,
  result.purged_at,
  result.active_hold_count,
  result.cleanup_step
FROM dasher_api.get_dashboard_admin_status($1::uuid) AS result`;

const createDashboardSql = `SELECT
  result.dashboard_id,
  result.created_at,
  result.effective_expires_at,
  result.effective_ttl_seconds,
  result.used_organization_default,
  result.lifecycle_policy_seeded,
  result.lifecycle_policy_revision,
  result.default_disposable_ttl_seconds,
  result.retention_policy_revision
FROM dasher_api.create_dashboard(
  $1::uuid,
  $2::text,
  $3::text,
  $4::integer,
  $5::boolean,
  $6::uuid,
  $7::uuid,
  $8::smallint,
  $9::bytea,
  $10::text
) AS result`;

const createEvidenceRecordSql = `SELECT 1::integer AS acknowledged
FROM dasher_api.create_evidence_record(
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::uuid,
  $6::text,
  $7::text,
  $8::bytea,
  $9::timestamptz,
  $10::timestamptz,
  $11::uuid,
  $12::smallint,
  $13::bytea,
  $14::text
) AS operation_result`;

const createDashboardVersionSql = `SELECT dasher_api.create_dashboard_version(
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::bytea,
  $5::bytea,
  $6::bytea,
  $7::bytea,
  $8::bigint,
  $9::bigint,
  $10::bytea,
  $11::uuid[],
  $12::uuid[],
  $13::uuid[],
  $14::uuid[],
  $15::uuid,
  $16::smallint,
  $17::bytea,
  $18::text
) AS version_id`;

const compareAndSwapDashboardHeadSql = `SELECT 1::integer AS acknowledged
FROM dasher_api.compare_and_swap_dashboard_head(
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::bigint,
  $5::uuid,
  $6::smallint,
  $7::bytea,
  $8::text
) AS operation_result`;

const requestDashboardPromotionSql = `SELECT dasher_api.request_dashboard_promotion(
  $1::uuid,
  $2::uuid,
  $3::bigint,
  $4::bytea,
  $5::uuid,
  $6::smallint,
  $7::bytea,
  $8::text
) AS promotion_request_id`;

const decideDashboardPromotionSql = `SELECT 1::integer AS acknowledged
FROM dasher_api.decide_dashboard_promotion(
  $1::uuid,
  $2::bigint,
  $3::text,
  $4::uuid,
  $5::uuid,
  $6::smallint,
  $7::bytea,
  $8::text
) AS operation_result`;

const setDashboardArchiveSql = `SELECT 1::integer AS acknowledged
FROM dasher_api.set_dashboard_archive(
  $1::uuid,
  $2::boolean,
  $3::bigint,
  $4::uuid,
  $5::smallint,
  $6::bytea,
  $7::text
) AS operation_result`;

const deleteDashboardSql = `SELECT 1::integer AS acknowledged
FROM dasher_api.delete_dashboard(
  $1::uuid,
  $2::bigint,
  $3::uuid,
  $4::smallint,
  $5::bytea,
  $6::text
) AS operation_result`;

const restoreDashboardAsNewSql = `SELECT 1::integer AS acknowledged
FROM dasher_api.restore_dashboard_as_new(
  $1::uuid,
  $2::uuid,
  $3::bigint,
  $4::uuid,
  $5::uuid,
  $6::uuid,
  $7::text,
  $8::bytea,
  $9::uuid,
  $10::smallint,
  $11::bytea,
  $12::text
) AS operation_result`;

type ValidationMode = "input" | "row";

function fail(mode: ValidationMode): never {
  throw mode === "input" ? preflightInputInvalid : preflightInternalFault;
}

function internal(outcome: OperationInternalOutcome = "not_committed"): never {
  throw new OperationInternalError(outcome);
}

function isCanonicalUuid(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    reflectApply(regexpTest, canonicalUuidPattern, [candidate])
  );
}

function strictObjectSnapshot(
  candidate: unknown,
  expectedKeys: readonly string[],
  mode: ValidationMode,
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    isProxyCapability(candidate)
  ) {
    return fail(mode);
  }
  try {
    const prototype = objectGetPrototypeOf(candidate);
    if (prototype !== objectPrototype && prototype !== null) return fail(mode);
    const keys = ownKeys(candidate);
    if (keys.length !== expectedKeys.length) return fail(mode);
    const values = objectCreate(null) as Record<string, unknown>;
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index];
      if (key === undefined) return fail(mode);
      const descriptor = objectGetOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor))
        return fail(mode);
      values[key] = descriptor.value;
    }
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") return fail(mode);
      let expected = false;
      for (let keyIndex = 0; keyIndex < expectedKeys.length; keyIndex += 1) {
        if (expectedKeys[keyIndex] === key) expected = true;
      }
      if (!expected) return fail(mode);
    }
    return objectFreeze(values);
  } catch (error) {
    if (error === preflightInputInvalid || error === preflightInternalFault) {
      throw error;
    }
    return fail(mode);
  }
}

function ownDataProperty(
  candidate: unknown,
  key: string,
  mode: ValidationMode,
): unknown {
  if (candidate === null || typeof candidate !== "object") return fail(mode);
  try {
    const descriptor = objectGetOwnPropertyDescriptor(candidate, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : fail(mode);
  } catch {
    return fail(mode);
  }
}

function scalarLength(candidate: string, maximum: number): number {
  let count = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const first = reflectApply(stringCharCodeAt, candidate, [index]);
    if (first === 0) return -1;
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index + 1 >= candidate.length) return -1;
      const second = reflectApply(stringCharCodeAt, candidate, [index + 1]);
      if (second < 0xdc00 || second > 0xdfff) return -1;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return -1;
    }
    count += 1;
    if (count > maximum) return count;
  }
  return count;
}

function boundedDatabaseText(
  candidate: unknown,
  maximum: number,
  mode: ValidationMode,
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    reflectApply(stringCharCodeAt, candidate, [0]) === 0x20 ||
    reflectApply(stringCharCodeAt, candidate, [candidate.length - 1]) === 0x20
  ) {
    return fail(mode);
  }
  const length = scalarLength(candidate, maximum);
  return length >= 1 && length <= maximum ? candidate : fail(mode);
}

function validateDeploymentRevision(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > maximumDeploymentUtf16CodeUnits ||
    reflectApply(stringCharCodeAt, candidate, [0]) === 0x20 ||
    reflectApply(stringCharCodeAt, candidate, [candidate.length - 1]) === 0x20
  ) {
    return internal();
  }
  const length = scalarLength(candidate, maximumDeploymentScalars);
  if (length < 1 || length > maximumDeploymentScalars) return internal();
  for (let index = 0; index < candidate.length; index += 1) {
    const code = reflectApply(stringCharCodeAt, candidate, [index]);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return internal();
  }
  return candidate;
}

function uuid(candidate: unknown, mode: ValidationMode): string {
  return isCanonicalUuid(candidate) ? candidate : fail(mode);
}

function nullableUuid(candidate: unknown, mode: ValidationMode): string | null {
  return candidate === null ? null : uuid(candidate, mode);
}

function safeInteger(
  candidate: unknown,
  minimum: number,
  maximum: number,
  mode: ValidationMode,
): number {
  if (
    typeof candidate !== "number" ||
    !numberIsSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    return fail(mode);
  }
  return candidate;
}

function databaseInteger(candidate: unknown, positive: boolean): number {
  let parsed: number;
  const pattern = positive ? positiveIntegerPattern : nonnegativeIntegerPattern;
  if (
    typeof candidate === "string" &&
    candidate.length >= 1 &&
    candidate.length <= maximumRevisionDigits &&
    reflectApply(regexpTest, pattern, [candidate])
  ) {
    parsed = reflectApply(numberConstructor, undefined, [candidate]);
  } else if (typeof candidate === "number") {
    parsed = candidate;
  } else {
    return fail("row");
  }
  if (!numberIsSafeInteger(parsed) || (positive ? parsed < 1 : parsed < 0)) {
    return fail("row");
  }
  return parsed;
}

function timestamp(candidate: unknown, mode: ValidationMode): Date {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      isProxyCapability(candidate) ||
      objectGetPrototypeOf(candidate) !== datePrototype
    ) {
      return fail(mode);
    }
    if (ownKeys(candidate).length !== 0) return fail(mode);
    const epoch = reflectApply(dateGetTime, candidate, []);
    return numberIsSafeInteger(epoch) ? new dateConstructor(epoch) : fail(mode);
  } catch (error) {
    if (error === preflightInputInvalid || error === preflightInternalFault) {
      throw error;
    }
    return fail(mode);
  }
}

function nullableTimestamp(
  candidate: unknown,
  mode: ValidationMode,
): Date | null {
  return candidate === null ? null : timestamp(candidate, mode);
}

function bytes(
  candidate: unknown,
  minimumLength: number,
  maximumLength: number,
  mode: ValidationMode,
): Uint8Array {
  let length: number;
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      isProxyCapability(candidate)
    ) {
      return fail(mode);
    }
    length = reflectApply(typedArrayByteLengthGetter, candidate, []);
  } catch {
    return fail(mode);
  }
  if (length < minimumLength || length > maximumLength) return fail(mode);
  try {
    if (
      (mode === "input" &&
        objectGetPrototypeOf(candidate) !== uint8ArrayConstructor.prototype) ||
      ownKeys(candidate).length !== length
    ) {
      return fail(mode);
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = objectGetOwnPropertyDescriptor(
        candidate,
        String(index),
      );
      if (descriptor === undefined || !("value" in descriptor))
        return fail(mode);
    }
    const snapshot = new uint8ArrayConstructor(length);
    reflectApply(uint8ArraySet, snapshot, [candidate]);
    return snapshot;
  } catch {
    return fail(mode);
  }
}

function digest(candidate: unknown, mode: ValidationMode): Uint8Array {
  return bytes(candidate, 32, 32, mode);
}

function sha256(candidate: Uint8Array): Uint8Array {
  try {
    const hash = createHashCapability("sha256");
    reflectApply(hashUpdate, hash, [candidate]);
    return new uint8ArrayConstructor(reflectApply(hashDigest, hash, []));
  } catch {
    throw preflightInternalFault;
  }
}

function isDashboardKind(candidate: unknown): candidate is DashboardKind {
  return candidate === "disposable" || candidate === "durable";
}

function isLifecycleState(
  candidate: unknown,
): candidate is DashboardLifecycleState {
  return (
    candidate === "draft" ||
    candidate === "active" ||
    candidate === "archived" ||
    candidate === "access_revoked" ||
    candidate === "quarantined" ||
    candidate === "purge_eligible" ||
    candidate === "cleaned"
  );
}

function isEvidenceKind(
  candidate: unknown,
): candidate is DashboardEvidenceKind {
  return (
    candidate === "source_record" ||
    candidate === "typed_value" ||
    candidate === "calculation_result" ||
    candidate === "event_record"
  );
}

function isArtifactOwnershipClass(
  candidate: unknown,
): candidate is DashboardArtifactOwnershipClass {
  return candidate === "dashboard_owned" || candidate === "shared";
}

function isPromotionDecision(
  candidate: unknown,
): candidate is DashboardPromotionDecision {
  return candidate === "approved" || candidate === "denied";
}

function isCleanupStep(candidate: unknown): candidate is DashboardCleanupStep {
  return (
    candidate === "access_revoked" ||
    candidate === "drain_and_cancel" ||
    candidate === "quarantined" ||
    candidate === "prepare_finalizers" ||
    candidate === "purge_eligible" ||
    candidate === "await_purge" ||
    candidate === "purge_started" ||
    candidate === "purge_finalizing" ||
    candidate === "final_proof_ready" ||
    candidate === "cleaned"
  );
}

function snapshotUuidArray(
  candidate: unknown,
  minimumLength: number,
): readonly string[] {
  if (
    !arrayIsArray(candidate) ||
    isProxyCapability(candidate) ||
    objectGetPrototypeOf(candidate) !== arrayPrototype ||
    candidate.length < minimumLength ||
    candidate.length > maximumReferenceIds
  ) {
    return fail("input");
  }
  const snapshot: string[] = [];
  const seen = new setConstructor<string>();
  try {
    const keys = ownKeys(candidate);
    if (keys.length !== candidate.length + 1) return fail("input");
    const lengthDescriptor = objectGetOwnPropertyDescriptor(
      candidate,
      "length",
    );
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      return fail("input");
    }
    for (let index = 0; index < candidate.length; index += 1) {
      const descriptor = objectGetOwnPropertyDescriptor(
        candidate,
        String(index),
      );
      if (descriptor === undefined || !("value" in descriptor)) {
        return fail("input");
      }
      const value = uuid(descriptor.value, "input");
      if (reflectApply(setHas, seen, [value])) return fail("input");
      reflectApply(setAdd, seen, [value]);
      snapshot[index] = value;
    }
  } catch (error) {
    if (error === preflightInputInvalid) throw error;
    return fail("input");
  }
  return objectFreeze(snapshot);
}

function secretPrimitiveFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    return objectGetPrototypeOf(error) === secretPrimitiveErrorPrototype;
  } catch {
    return false;
  }
}

function validateKeyRing(candidate: unknown): SecretKeyRing {
  try {
    reflectApply(secretKeyRingVerify, candidate, [
      "session",
      keyRingBrandProbe,
    ]);
  } catch (error) {
    if (secretPrimitiveFailure(error)) return candidate as SecretKeyRing;
    return internal();
  }
  return candidate as SecretKeyRing;
}

interface VerifiedSecretSnapshot {
  readonly keyVersion: number;
  readonly digest: Uint8Array;
}

function snapshotPersistenceMaterial(
  candidate: unknown,
): VerifiedSecretSnapshot {
  try {
    const keyVersion = ownDataProperty(candidate, "keyVersion", "row");
    if (
      typeof keyVersion !== "number" ||
      !numberIsSafeInteger(keyVersion) ||
      keyVersion < 1 ||
      keyVersion > 32_767
    ) {
      throw preflightInternalFault;
    }
    return objectFreeze({
      keyVersion,
      digest: digest(ownDataProperty(candidate, "digest", "row"), "row"),
    });
  } catch {
    throw preflightInternalFault;
  }
}

function verifySecret(
  keyRing: SecretKeyRing,
  kind: "session" | "csrf",
  candidate: unknown,
): VerifiedSecretSnapshot {
  try {
    const material = reflectApply(secretKeyRingVerify, keyRing, [
      kind,
      candidate,
    ]) as SecretPersistenceMaterial;
    return snapshotPersistenceMaterial(material);
  } catch (error) {
    if (error === preflightInternalFault) throw error;
    throw secretPrimitiveFailure(error)
      ? preflightInputInvalid
      : preflightInternalFault;
  }
}

function queryRows(result: unknown): readonly unknown[] {
  const rowCount = ownDataProperty(result, "rowCount", "row");
  const rows = ownDataProperty(result, "rows", "row");
  if (
    typeof rowCount !== "number" ||
    !numberIsSafeInteger(rowCount) ||
    rowCount < 0 ||
    !arrayIsArray(rows) ||
    isProxyCapability(rows) ||
    objectGetPrototypeOf(rows) !== arrayPrototype ||
    rows.length !== rowCount
  ) {
    return fail("row");
  }
  const snapshot: unknown[] = [];
  try {
    const keys = ownKeys(rows);
    if (keys.length !== rows.length + 1) return fail("row");
    for (let index = 0; index < rows.length; index += 1) {
      const descriptor = objectGetOwnPropertyDescriptor(rows, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        return fail("row");
      }
      snapshot[index] = descriptor.value;
    }
  } catch (error) {
    if (error === preflightInternalFault) throw error;
    return fail("row");
  }
  return objectFreeze(snapshot);
}

function singleRow(result: unknown): unknown {
  const rows = queryRows(result);
  return rows.length === 1 ? rows[0] : fail("row");
}

function validateContextResult(result: unknown): void {
  const row = strictObjectSnapshot(
    singleRow(result),
    [
      "session_id",
      "user_id",
      "organization_id",
      "membership_id",
      "authority_revision",
      "idle_expires_at",
      "absolute_expires_at",
      "database_now",
    ],
    "row",
  );
  uuid(row.session_id, "row");
  uuid(row.user_id, "row");
  uuid(row.organization_id, "row");
  uuid(row.membership_id, "row");
  databaseInteger(row.authority_revision, true);
  const idle = timestamp(row.idle_expires_at, "row");
  const absolute = timestamp(row.absolute_expires_at, "row");
  const now = timestamp(row.database_now, "row");
  const idleEpoch = reflectApply(dateGetTime, idle, []);
  const absoluteEpoch = reflectApply(dateGetTime, absolute, []);
  const nowEpoch = reflectApply(dateGetTime, now, []);
  if (idleEpoch <= nowEpoch || absoluteEpoch < idleEpoch) {
    fail("row");
  }
}

function defineDateProperty(
  target: object,
  property: string,
  value: Date | null,
): void {
  if (value === null) {
    objectDefineProperty(target, property, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: null,
    });
    return;
  }
  const epoch = reflectApply(dateGetTime, value, []);
  objectDefineProperty(target, property, {
    configurable: false,
    enumerable: true,
    get() {
      return new dateConstructor(epoch);
    },
  });
}

function defineBytesProperty(
  target: object,
  property: string,
  value: Uint8Array | null,
): void {
  if (value === null) {
    objectDefineProperty(target, property, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: null,
    });
    return;
  }
  const valueLength = reflectApply(typedArrayByteLengthGetter, value, []);
  const privateCopy = bytes(value, valueLength, valueLength, "row");
  objectDefineProperty(target, property, {
    configurable: false,
    enumerable: true,
    get() {
      const privateLength = reflectApply(
        typedArrayByteLengthGetter,
        privateCopy,
        [],
      );
      return bytes(privateCopy, privateLength, privateLength, "row");
    },
  });
}

function validateSummaryRow(candidate: unknown): DashboardSummary {
  const row = strictObjectSnapshot(
    candidate,
    [
      "dashboard_id",
      "title",
      "current_kind",
      "lifecycle_state",
      "lifecycle_revision",
      "effective_expires_at",
      "head_version_id",
    ],
    "row",
  );
  const currentKind = row.current_kind;
  const lifecycleState = row.lifecycle_state;
  if (!isDashboardKind(currentKind) || !isLifecycleState(lifecycleState)) {
    return fail("row");
  }
  const effectiveExpiresAt = nullableTimestamp(row.effective_expires_at, "row");
  const headVersionId = nullableUuid(row.head_version_id, "row");
  if (
    (currentKind === "disposable" &&
      (effectiveExpiresAt === null ||
        (lifecycleState !== "draft" && lifecycleState !== "active"))) ||
    (currentKind === "durable" &&
      (effectiveExpiresAt !== null ||
        (lifecycleState !== "draft" &&
          lifecycleState !== "active" &&
          lifecycleState !== "archived"))) ||
    (lifecycleState === "draft" && headVersionId !== null) ||
    (lifecycleState !== "draft" && headVersionId === null)
  ) {
    return fail("row");
  }
  const result = {
    dashboardId: uuid(row.dashboard_id, "row"),
    title: boundedDatabaseText(row.title, 200, "row"),
    currentKind,
    lifecycleState,
    lifecycleRevision: databaseInteger(row.lifecycle_revision, false),
    headVersionId,
  } as Omit<DashboardSummary, "effectiveExpiresAt"> &
    Partial<Pick<DashboardSummary, "effectiveExpiresAt">>;
  defineDateProperty(result, "effectiveExpiresAt", effectiveExpiresAt);
  return objectFreeze(result as DashboardSummary);
}

function validateCreateDashboardResult(
  result: unknown,
  expectedDashboardId: string,
  kind: DashboardKind,
  requestedTtlSeconds: number | null,
  requestedOrganizationDefault: boolean,
): CreateDashboardResult {
  const row = strictObjectSnapshot(
    singleRow(result),
    [
      "dashboard_id",
      "created_at",
      "effective_expires_at",
      "effective_ttl_seconds",
      "used_organization_default",
      "lifecycle_policy_seeded",
      "lifecycle_policy_revision",
      "default_disposable_ttl_seconds",
      "retention_policy_revision",
    ],
    "row",
  );
  const dashboardId = uuid(row.dashboard_id, "row");
  const createdAt = timestamp(row.created_at, "row");
  const effectiveExpiresAt = nullableTimestamp(row.effective_expires_at, "row");
  const effectiveTtlSeconds =
    row.effective_ttl_seconds === null
      ? null
      : safeInteger(row.effective_ttl_seconds, 3_600, 2_592_000, "row");
  const defaultDisposableTtlSeconds = safeInteger(
    row.default_disposable_ttl_seconds,
    3_600,
    2_592_000,
    "row",
  );
  if (
    dashboardId !== expectedDashboardId ||
    typeof row.used_organization_default !== "boolean" ||
    row.used_organization_default !== requestedOrganizationDefault ||
    typeof row.lifecycle_policy_seeded !== "boolean" ||
    (kind === "durable" &&
      (effectiveExpiresAt !== null || effectiveTtlSeconds !== null)) ||
    (kind === "disposable" &&
      (effectiveExpiresAt === null || effectiveTtlSeconds === null)) ||
    (!requestedOrganizationDefault &&
      kind === "disposable" &&
      effectiveTtlSeconds !== requestedTtlSeconds) ||
    (requestedOrganizationDefault &&
      effectiveTtlSeconds !== defaultDisposableTtlSeconds)
  ) {
    return fail("row");
  }
  if (
    effectiveExpiresAt !== null &&
    effectiveTtlSeconds !== null &&
    reflectApply(dateGetTime, effectiveExpiresAt, []) -
      reflectApply(dateGetTime, createdAt, []) !==
      effectiveTtlSeconds * 1_000
  ) {
    return fail("row");
  }
  const value = {
    dashboardId,
    effectiveTtlSeconds,
    usedOrganizationDefault: row.used_organization_default,
    lifecyclePolicySeeded: row.lifecycle_policy_seeded,
    lifecyclePolicyRevision: databaseInteger(
      row.lifecycle_policy_revision,
      true,
    ),
    defaultDisposableTtlSeconds,
    retentionPolicyRevision: databaseInteger(
      row.retention_policy_revision,
      true,
    ),
  } as Omit<CreateDashboardResult, "createdAt" | "effectiveExpiresAt"> & object;
  defineDateProperty(value, "createdAt", createdAt);
  defineDateProperty(value, "effectiveExpiresAt", effectiveExpiresAt);
  return objectFreeze(value as CreateDashboardResult);
}

function validateVersionRow(candidate: unknown): DashboardVersionProjection {
  const row = strictObjectSnapshot(
    candidate,
    [
      "dashboard_id",
      "version_id",
      "parent_version_id",
      "canonical_spec_bytes",
      "canonical_spec_sha256",
      "validation_state",
      "validation_sha256",
      "planner_provenance_sha256",
      "policy_revision",
      "registry_revision",
      "calculation_graph_sha256",
      "created_at",
    ],
    "row",
  );
  if (row.validation_state !== "validated") return fail("row");
  const canonicalSpecBytes = bytes(
    row.canonical_spec_bytes,
    2,
    maximumCanonicalSpecBytes,
    "row",
  );
  const canonicalSpecSha256 = digest(row.canonical_spec_sha256, "row");
  const computed = sha256(canonicalSpecBytes);
  if (!timingSafeEqualCapability(computed, canonicalSpecSha256)) {
    return fail("row");
  }
  const validationSha256 = digest(row.validation_sha256, "row");
  const plannerProvenanceSha256 = digest(row.planner_provenance_sha256, "row");
  const calculationGraphSha256 =
    row.calculation_graph_sha256 === null
      ? null
      : digest(row.calculation_graph_sha256, "row");
  const createdAt = timestamp(row.created_at, "row");
  const result = {
    dashboardId: uuid(row.dashboard_id, "row"),
    versionId: uuid(row.version_id, "row"),
    parentVersionId: nullableUuid(row.parent_version_id, "row"),
    validationState: "validated",
    policyRevision: databaseInteger(row.policy_revision, true),
    registryRevision: databaseInteger(row.registry_revision, true),
  } as Omit<
    DashboardVersionProjection,
    | "canonicalSpecBytes"
    | "canonicalSpecSha256"
    | "validationSha256"
    | "plannerProvenanceSha256"
    | "calculationGraphSha256"
    | "createdAt"
  > &
    object;
  defineBytesProperty(result, "canonicalSpecBytes", canonicalSpecBytes);
  defineBytesProperty(result, "canonicalSpecSha256", canonicalSpecSha256);
  defineBytesProperty(result, "validationSha256", validationSha256);
  defineBytesProperty(
    result,
    "plannerProvenanceSha256",
    plannerProvenanceSha256,
  );
  defineBytesProperty(result, "calculationGraphSha256", calculationGraphSha256);
  defineDateProperty(result, "createdAt", createdAt);
  return objectFreeze(result as DashboardVersionProjection);
}

function validateEvidenceRow(candidate: unknown): DashboardEvidenceProjection {
  const row = strictObjectSnapshot(
    candidate,
    [
      "dashboard_id",
      "version_id",
      "evidence_id",
      "evidence_kind",
      "content_sha256",
      "observed_at",
      "retrieved_at",
    ],
    "row",
  );
  if (!isEvidenceKind(row.evidence_kind)) return fail("row");
  const observedAt = timestamp(row.observed_at, "row");
  const retrievedAt = timestamp(row.retrieved_at, "row");
  if (
    reflectApply(dateGetTime, observedAt, []) >
    reflectApply(dateGetTime, retrievedAt, [])
  ) {
    return fail("row");
  }
  const result = {
    dashboardId: uuid(row.dashboard_id, "row"),
    versionId: uuid(row.version_id, "row"),
    evidenceId: uuid(row.evidence_id, "row"),
    evidenceKind: row.evidence_kind,
  } as Omit<
    DashboardEvidenceProjection,
    "contentSha256" | "observedAt" | "retrievedAt"
  > &
    object;
  defineBytesProperty(
    result,
    "contentSha256",
    digest(row.content_sha256, "row"),
  );
  defineDateProperty(result, "observedAt", observedAt);
  defineDateProperty(result, "retrievedAt", retrievedAt);
  return objectFreeze(result as DashboardEvidenceProjection);
}

function validateLineageRow(candidate: unknown): DashboardLineageProjection {
  const row = strictObjectSnapshot(
    candidate,
    [
      "dashboard_id",
      "version_id",
      "parent_version_id",
      "snapshot_id",
      "evidence_id",
      "artifact_id",
      "artifact_ownership_class",
    ],
    "row",
  );
  const artifactId = nullableUuid(row.artifact_id, "row");
  let artifactOwnershipClass: DashboardArtifactOwnershipClass | null;
  if (artifactId === null) {
    if (row.artifact_ownership_class !== null) return fail("row");
    artifactOwnershipClass = null;
  } else if (isArtifactOwnershipClass(row.artifact_ownership_class)) {
    artifactOwnershipClass = row.artifact_ownership_class;
  } else {
    return fail("row");
  }
  return objectFreeze({
    dashboardId: uuid(row.dashboard_id, "row"),
    versionId: uuid(row.version_id, "row"),
    parentVersionId: nullableUuid(row.parent_version_id, "row"),
    snapshotId: nullableUuid(row.snapshot_id, "row"),
    evidenceId: nullableUuid(row.evidence_id, "row"),
    artifactId,
    artifactOwnershipClass,
  });
}

function validateAdminRow(candidate: unknown): DashboardAdminProjection {
  const row = strictObjectSnapshot(
    candidate,
    [
      "dashboard_id",
      "lifecycle_state",
      "lifecycle_revision",
      "capability_epoch",
      "cache_epoch",
      "access_revoked_at",
      "purge_after",
      "purge_started_at",
      "purged_at",
      "active_hold_count",
      "cleanup_step",
    ],
    "row",
  );
  if (!isLifecycleState(row.lifecycle_state)) return fail("row");
  if (row.cleanup_step !== null && !isCleanupStep(row.cleanup_step)) {
    return fail("row");
  }
  const lifecycleRevision = databaseInteger(row.lifecycle_revision, false);
  const capabilityEpoch = databaseInteger(row.capability_epoch, false);
  const cacheEpoch = databaseInteger(row.cache_epoch, false);
  if (capabilityEpoch > lifecycleRevision || cacheEpoch > lifecycleRevision) {
    return fail("row");
  }
  const accessRevokedAt = nullableTimestamp(row.access_revoked_at, "row");
  const purgeAfter = nullableTimestamp(row.purge_after, "row");
  const purgeStartedAt = nullableTimestamp(row.purge_started_at, "row");
  const purgedAt = nullableTimestamp(row.purged_at, "row");
  const accessible =
    row.lifecycle_state === "draft" ||
    row.lifecycle_state === "active" ||
    row.lifecycle_state === "archived";
  if (
    (accessible &&
      (accessRevokedAt !== null ||
        purgeAfter !== null ||
        purgeStartedAt !== null ||
        purgedAt !== null)) ||
    (!accessible && (accessRevokedAt === null || purgeAfter === null)) ||
    (row.lifecycle_state === "cleaned" &&
      (purgeStartedAt === null || purgedAt === null)) ||
    (row.lifecycle_state !== "cleaned" && purgedAt !== null) ||
    (purgeStartedAt !== null &&
      row.lifecycle_state !== "purge_eligible" &&
      row.lifecycle_state !== "cleaned")
  ) {
    return fail("row");
  }
  const result = {
    dashboardId: uuid(row.dashboard_id, "row"),
    lifecycleState: row.lifecycle_state,
    lifecycleRevision,
    capabilityEpoch,
    cacheEpoch,
    activeHoldCount: databaseInteger(row.active_hold_count, false),
    cleanupStep: row.cleanup_step,
  } as Omit<
    DashboardAdminProjection,
    "accessRevokedAt" | "purgeAfter" | "purgeStartedAt" | "purgedAt"
  > &
    object;
  defineDateProperty(result, "accessRevokedAt", accessRevokedAt);
  defineDateProperty(result, "purgeAfter", purgeAfter);
  defineDateProperty(result, "purgeStartedAt", purgeStartedAt);
  defineDateProperty(result, "purgedAt", purgedAt);
  return objectFreeze(result as DashboardAdminProjection);
}

function validateSet<Row>(
  result: unknown,
  validateRow: (row: unknown) => Row,
  minimumLength = 0,
): readonly Row[] {
  const rows = queryRows(result);
  if (rows.length < minimumLength) fail("row");
  const snapshot: Row[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    snapshot[index] = validateRow(rows[index]);
  }
  return objectFreeze(snapshot);
}

function validateSingle<Row>(
  result: unknown,
  validateRow: (row: unknown) => Row,
): Row {
  return validateRow(singleRow(result));
}

function validateAcknowledgement(result: unknown): void {
  const row = strictObjectSnapshot(singleRow(result), ["acknowledged"], "row");
  if (row.acknowledged !== 1) fail("row");
}

function validateReturnedUuid(
  result: unknown,
  property: string,
  expected: string,
): void {
  const row = strictObjectSnapshot(singleRow(result), [property], "row");
  if (uuid(row[property], "row") !== expected) fail("row");
}

function databaseCode(error: unknown): "P1001" | "P1002" | undefined {
  if (error === null || typeof error !== "object" || isProxyCapability(error)) {
    return undefined;
  }
  try {
    const descriptor = objectGetOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return descriptor.value === "P1001" || descriptor.value === "P1002"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

interface CapturedReleaseCapability {
  readonly release: PgCompatibleClient["release"];
  readonly receiver: object;
}

type CapturedClient =
  | (CapturedReleaseCapability & {
      readonly valid: true;
      readonly query: PgCompatibleClient["query"];
    })
  | {
      readonly valid: false;
      readonly release?: PgCompatibleClient["release"];
      readonly receiver?: object;
    };

function captureClient(candidate: unknown): CapturedClient {
  if (candidate === null || typeof candidate !== "object") {
    return objectFreeze({ valid: false });
  }
  let query: unknown;
  let release: unknown;
  try {
    query = (candidate as PgCompatibleClient).query;
  } catch {
    // The independently captured release capability may still destroy it.
  }
  try {
    release = (candidate as PgCompatibleClient).release;
  } catch {
    // A hostile release accessor is not read a second time.
  }
  if (typeof query === "function" && typeof release === "function") {
    return objectFreeze({
      valid: true,
      query: query as PgCompatibleClient["query"],
      release: release as PgCompatibleClient["release"],
      receiver: candidate,
    });
  }
  return objectFreeze({
    valid: false,
    ...(typeof release === "function"
      ? {
          release: release as PgCompatibleClient["release"],
          receiver: candidate,
        }
      : {}),
  });
}

function observeCleanupResult(result: unknown, rejected: () => void): void {
  if (
    (typeof result !== "object" || result === null) &&
    typeof result !== "function"
  ) {
    return;
  }
  try {
    const promise = reflectApply(promiseResolve, promiseConstructor, [result]);
    reflectApply(promiseThen, promise, [undefined, rejected]);
  } catch {
    rejected();
  }
}

function destructiveRelease(client: CapturedReleaseCapability): void {
  try {
    const result = reflectApply(client.release, client.receiver, [true]);
    observeCleanupResult(result, () => undefined);
  } catch {
    // Cleanup is best effort and never changes the normalized outcome.
  }
}

function normalRelease(client: CapturedReleaseCapability): void {
  try {
    const result = reflectApply(client.release, client.receiver, []);
    observeCleanupResult(result, () => destructiveRelease(client));
  } catch {
    destructiveRelease(client);
  }
}

type TransactionStage =
  | "connect"
  | "begin"
  | "set_local"
  | "initialize_select"
  | "initialize_validation"
  | "operation_select"
  | "operation_validation"
  | "commit";

interface TransactionFailure {
  readonly authority: object;
  readonly error: unknown;
  readonly outcome: OperationInternalOutcome;
  readonly stage: TransactionStage;
}

const transactionFailureAuthority = objectFreeze({});

function transactionFailure(
  stage: TransactionStage,
  error: unknown,
  outcome: OperationInternalOutcome = "not_committed",
): TransactionFailure {
  return objectFreeze({
    authority: transactionFailureAuthority,
    error,
    outcome,
    stage,
  });
}

function inspectTransactionFailure(
  error: unknown,
): TransactionFailure | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const descriptor = objectGetOwnPropertyDescriptor(error, "authority");
    return descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.value === transactionFailureAuthority
      ? (error as TransactionFailure)
      : undefined;
  } catch {
    return undefined;
  }
}

interface OperationStep<Result> {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly validate: (result: PgCompatibleQueryResult) => Result;
}

async function runPinnedTransaction<Result>(
  connect: () => Promise<PgCompatibleClient>,
  session: VerifiedSecretSnapshot,
  requestId: string,
  operation: OperationStep<Result>,
): Promise<Result> {
  let rawClient: PgCompatibleClient;
  try {
    rawClient = await connect();
  } catch (error) {
    throw transactionFailure("connect", error);
  }
  const captured = captureClient(rawClient);
  if (!captured.valid) {
    if (captured.release !== undefined && captured.receiver !== undefined) {
      destructiveRelease({
        release: captured.release,
        receiver: captured.receiver,
      });
    }
    throw transactionFailure("connect", new OperationInternalError());
  }
  const client = captured;
  let stage: Exclude<TransactionStage, "connect" | "commit"> = "begin";
  let operationResult: Result;
  try {
    await reflectApply(client.query, client.receiver, ["BEGIN"]);
    stage = "set_local";
    await reflectApply(client.query, client.receiver, [
      "SET LOCAL search_path = pg_catalog",
    ]);
    stage = "initialize_select";
    const initialized = await reflectApply(client.query, client.receiver, [
      initializeContextSql,
      [session.keyVersion, digest(session.digest, "row"), requestId],
    ]);
    stage = "initialize_validation";
    validateContextResult(initialized);
    stage = "operation_select";
    const selected = await reflectApply(client.query, client.receiver, [
      operation.sql,
      operation.parameters,
    ]);
    stage = "operation_validation";
    operationResult = operation.validate(selected);
  } catch (error) {
    try {
      await reflectApply(client.query, client.receiver, ["ROLLBACK"]);
      normalRelease(client);
    } catch {
      destructiveRelease(client);
    }
    throw transactionFailure(stage, error);
  }
  try {
    await reflectApply(client.query, client.receiver, ["COMMIT"]);
  } catch (error) {
    destructiveRelease(client);
    throw transactionFailure("commit", error, "commit_indeterminate");
  }
  normalRelease(client);
  return operationResult;
}

interface PreparedCall<Result> {
  readonly requestId: string;
  readonly session: VerifiedSecretSnapshot;
  readonly operation: OperationStep<Result>;
}

function frozenResult<Result extends object>(value: Result): Readonly<Result> {
  return objectFreeze(value);
}

export class DashboardLifecycleRepository {
  readonly #connect!: () => Promise<PgCompatibleClient>;
  readonly #keyRing!: SecretKeyRing;
  readonly #deploymentRevision!: string;
  readonly #uuidSource!: () => string;

  constructor(config: DashboardLifecycleRepositoryConfig) {
    if (
      config === null ||
      typeof config !== "object" ||
      isProxyCapability(config)
    ) {
      internal();
    }
    let pool: unknown;
    let keyRing: unknown;
    let deploymentRevision: unknown;
    let uuidSource: unknown;
    try {
      pool = config.pool;
      keyRing = config.keyRing;
      deploymentRevision = config.deploymentRevision;
      uuidSource = config.uuidSource;
    } catch {
      return internal();
    }
    if (pool === null || typeof pool !== "object") internal();
    let connect: unknown;
    try {
      connect = (pool as PgCompatiblePool).connect;
    } catch {
      return internal();
    }
    if (
      typeof connect !== "function" ||
      (uuidSource !== undefined && typeof uuidSource !== "function")
    ) {
      internal();
    }
    this.#connect = () =>
      reflectApply(connect as PgCompatiblePool["connect"], pool, []);
    this.#keyRing = validateKeyRing(keyRing);
    this.#deploymentRevision = validateDeploymentRevision(deploymentRevision);
    this.#uuidSource =
      (uuidSource as (() => string) | undefined) ?? randomUuidCapability;
    objectFreeze(this);
  }

  #generateUuids(
    count: number,
    excluded: readonly string[],
  ): readonly string[] {
    const generated: string[] = [];
    for (let index = 0; index < count; index += 1) {
      let accepted: string | undefined;
      for (
        let attempt = 0;
        attempt < maximumGeneratedUuidAttempts;
        attempt += 1
      ) {
        let candidate: unknown;
        try {
          candidate = reflectApply(this.#uuidSource, undefined, []);
        } catch {
          throw preflightInternalFault;
        }
        if (!isCanonicalUuid(candidate)) throw preflightInternalFault;
        let duplicate = false;
        for (
          let excludedIndex = 0;
          excludedIndex < excluded.length;
          excludedIndex += 1
        ) {
          if (excluded[excludedIndex] === candidate) duplicate = true;
        }
        for (
          let generatedIndex = 0;
          generatedIndex < generated.length;
          generatedIndex += 1
        ) {
          if (generated[generatedIndex] === candidate) duplicate = true;
        }
        if (!duplicate) {
          accepted = candidate;
          break;
        }
      }
      if (accepted === undefined) throw preflightInternalFault;
      generated[index] = accepted;
    }
    return objectFreeze(generated);
  }

  #preflight<Result>(prepare: () => Result): Result {
    try {
      return prepare();
    } catch (error) {
      if (error === preflightInputInvalid) throw new OperationDeniedError();
      throw new OperationInternalError();
    }
  }

  #common(
    input: unknown,
    keys: readonly string[],
  ): {
    readonly snapshot: Readonly<Record<string, unknown>>;
    readonly session: VerifiedSecretSnapshot;
  } {
    const snapshot = strictObjectSnapshot(input, keys, "input");
    return objectFreeze({
      snapshot,
      session: verifySecret(this.#keyRing, "session", snapshot.sessionToken),
    });
  }

  #mutation(
    input: unknown,
    keys: readonly string[],
  ): {
    readonly snapshot: Readonly<Record<string, unknown>>;
    readonly session: VerifiedSecretSnapshot;
    readonly csrf: VerifiedSecretSnapshot;
  } {
    const common = this.#common(input, keys);
    return objectFreeze({
      ...common,
      csrf: verifySecret(
        this.#keyRing,
        "csrf",
        common.snapshot.currentCsrfValue,
      ),
    });
  }

  async #run<Result>(prepared: PreparedCall<Result>): Promise<Result> {
    try {
      return await runPinnedTransaction(
        this.#connect,
        prepared.session,
        prepared.requestId,
        prepared.operation,
      );
    } catch (error) {
      const failure = inspectTransactionFailure(error);
      const selectable =
        failure?.stage === "initialize_select" ||
        failure?.stage === "operation_select";
      const code = selectable ? databaseCode(failure.error) : undefined;
      if (code === "P1001") throw new OperationDeniedError();
      if (code === "P1002") throw new OperationConflictError();
      throw new OperationInternalError(failure?.outcome ?? "not_committed");
    }
  }

  async listDashboards(
    input: ListDashboardsInput,
  ): Promise<ListDashboardsResult> {
    const prepared = this.#preflight<PreparedCall<ListDashboardsResult>>(() => {
      const { snapshot, session } = this.#common(input, [
        "sessionToken",
        "limit",
      ]);
      const limit = safeInteger(snapshot.limit, 1, 100, "input");
      const [requestId] = this.#generateUuids(1, []);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql: listDashboardsSql,
          parameters: objectFreeze([limit]),
          validate: (result: PgCompatibleQueryResult) =>
            validateSet(result, validateSummaryRow),
        }),
      });
    });
    return this.#run(prepared);
  }

  async getDashboardSummary(
    input: GetDashboardSummaryInput,
  ): Promise<GetDashboardSummaryResult> {
    const prepared = this.#prepareDashboardRead(
      input,
      getDashboardSummarySql,
      (result, dashboardId) => {
        const projection = validateSingle(result, validateSummaryRow);
        if (projection.dashboardId !== dashboardId) fail("row");
        return projection;
      },
    );
    return this.#run(prepared);
  }

  async getDashboardHead(
    input: GetDashboardHeadInput,
  ): Promise<GetDashboardHeadResult> {
    const prepared = this.#prepareDashboardRead(
      input,
      getDashboardHeadSql,
      (result, dashboardId) => {
        const projection = validateSingle(result, validateVersionRow);
        if (projection.dashboardId !== dashboardId) fail("row");
        return projection;
      },
    );
    return this.#run(prepared);
  }

  async getDashboardVersion(
    input: GetDashboardVersionInput,
  ): Promise<GetDashboardVersionResult> {
    const prepared = this.#prepareVersionRead(
      input,
      getDashboardVersionSql,
      (result, dashboardId, versionId) => {
        const projection = validateSingle(result, validateVersionRow);
        if (
          projection.dashboardId !== dashboardId ||
          projection.versionId !== versionId
        ) {
          fail("row");
        }
        return projection;
      },
    );
    return this.#run(prepared);
  }

  async getDashboardEvidence(
    input: GetDashboardEvidenceInput,
  ): Promise<GetDashboardEvidenceResult> {
    const prepared = this.#prepareVersionRead(
      input,
      getDashboardEvidenceSql,
      (result, dashboardId, versionId) =>
        validateSet(
          result,
          (row) => {
            const projection = validateEvidenceRow(row);
            if (
              projection.dashboardId !== dashboardId ||
              projection.versionId !== versionId
            ) {
              fail("row");
            }
            return projection;
          },
          1,
        ),
    );
    return this.#run(prepared);
  }

  async getDashboardLineage(
    input: GetDashboardLineageInput,
  ): Promise<GetDashboardLineageResult> {
    const prepared = this.#prepareVersionRead(
      input,
      getDashboardLineageSql,
      (result, dashboardId, versionId) =>
        validateSet(
          result,
          (row) => {
            const projection = validateLineageRow(row);
            if (
              projection.dashboardId !== dashboardId ||
              projection.versionId !== versionId
            ) {
              fail("row");
            }
            return projection;
          },
          1,
        ),
    );
    return this.#run(prepared);
  }

  async getDashboardAdminStatus(
    input: GetDashboardAdminStatusInput,
  ): Promise<GetDashboardAdminStatusResult> {
    const prepared = this.#prepareDashboardRead(
      input,
      getDashboardAdminStatusSql,
      (result, dashboardId) => {
        const projection = validateSingle(result, validateAdminRow);
        if (projection.dashboardId !== dashboardId) fail("row");
        return projection;
      },
    );
    return this.#run(prepared);
  }

  async createDashboard(
    input: CreateDashboardInput,
  ): Promise<CreateDashboardResult> {
    const prepared = this.#preflight<PreparedCall<CreateDashboardResult>>(
      () => {
        const kindCandidate = strictObjectSnapshot(
          input,
          input !== null &&
            typeof input === "object" &&
            !isProxyCapability(input) &&
            ownDataProperty(input, "kind", "input") === "disposable"
            ? ["sessionToken", "currentCsrfValue", "title", "kind", "ttl"]
            : ["sessionToken", "currentCsrfValue", "title", "kind"],
          "input",
        );
        const session = verifySecret(
          this.#keyRing,
          "session",
          kindCandidate.sessionToken,
        );
        const csrf = verifySecret(
          this.#keyRing,
          "csrf",
          kindCandidate.currentCsrfValue,
        );
        const title = boundedDatabaseText(kindCandidate.title, 200, "input");
        if (!isDashboardKind(kindCandidate.kind)) fail("input");
        const kind = kindCandidate.kind;
        let ttlSeconds: number | null = null;
        let useOrganizationDefault = false;
        if (kind === "disposable") {
          const ttl = kindCandidate.ttl;
          if (ttl === "organization_default") {
            useOrganizationDefault = true;
          } else if (
            ttl === 3600 ||
            ttl === 86400 ||
            ttl === 604800 ||
            ttl === 2592000
          ) {
            ttlSeconds = ttl;
          } else {
            fail("input");
          }
        }
        const [requestId, dashboardId, tombstoneLineageId, auditId] =
          this.#generateUuids(4, []);
        if (
          requestId === undefined ||
          dashboardId === undefined ||
          tombstoneLineageId === undefined ||
          auditId === undefined
        ) {
          throw preflightInternalFault;
        }
        return objectFreeze({
          requestId,
          session,
          operation: objectFreeze({
            sql: createDashboardSql,
            parameters: objectFreeze([
              dashboardId,
              title,
              kind,
              ttlSeconds,
              useOrganizationDefault,
              tombstoneLineageId,
              auditId,
              csrf.keyVersion,
              digest(csrf.digest, "row"),
              this.#deploymentRevision,
            ]),
            validate: (result: PgCompatibleQueryResult) =>
              validateCreateDashboardResult(
                result,
                dashboardId,
                kind,
                ttlSeconds,
                useOrganizationDefault,
              ),
          }),
        });
      },
    );
    return this.#run(prepared);
  }

  async createEvidenceRecord(
    input: CreateEvidenceRecordInput,
  ): Promise<CreateEvidenceRecordResult> {
    const prepared = this.#preflight<PreparedCall<CreateEvidenceRecordResult>>(
      () => {
        const { snapshot, session, csrf } = this.#mutation(input, [
          "sessionToken",
          "currentCsrfValue",
          "dashboardId",
          "versionId",
          "snapshotId",
          "evidenceKind",
          "coordinates",
          "contentSha256",
          "observedAt",
          "retrievedAt",
        ]);
        const dashboardId = uuid(snapshot.dashboardId, "input");
        const versionId = uuid(snapshot.versionId, "input");
        const snapshotId = uuid(snapshot.snapshotId, "input");
        if (!isEvidenceKind(snapshot.evidenceKind)) fail("input");
        const coordinates = boundedDatabaseText(
          snapshot.coordinates,
          200,
          "input",
        );
        const contentSha256 = digest(snapshot.contentSha256, "input");
        const observedAt = timestamp(snapshot.observedAt, "input");
        const retrievedAt = timestamp(snapshot.retrievedAt, "input");
        if (
          reflectApply(dateGetTime, observedAt, []) >
          reflectApply(dateGetTime, retrievedAt, [])
        ) {
          fail("input");
        }
        const [requestId, evidenceId, referenceClaimId, auditId] =
          this.#generateUuids(4, [dashboardId, versionId, snapshotId]);
        if (
          requestId === undefined ||
          evidenceId === undefined ||
          referenceClaimId === undefined ||
          auditId === undefined
        ) {
          throw preflightInternalFault;
        }
        return objectFreeze({
          requestId,
          session,
          operation: objectFreeze({
            sql: createEvidenceRecordSql,
            parameters: objectFreeze([
              dashboardId,
              versionId,
              evidenceId,
              snapshotId,
              referenceClaimId,
              snapshot.evidenceKind,
              coordinates,
              contentSha256,
              observedAt,
              retrievedAt,
              auditId,
              csrf.keyVersion,
              digest(csrf.digest, "row"),
              this.#deploymentRevision,
            ]),
            validate: (result: PgCompatibleQueryResult) => {
              validateAcknowledgement(result);
              return frozenResult<CreateEvidenceRecordResult>({ evidenceId });
            },
          }),
        });
      },
    );
    return this.#run(prepared);
  }

  async createDashboardVersion(
    input: CreateDashboardVersionInput,
  ): Promise<CreateDashboardVersionResult> {
    const prepared = this.#preflight<
      PreparedCall<CreateDashboardVersionResult>
    >(() => {
      const { snapshot, session, csrf } = this.#mutation(input, [
        "sessionToken",
        "currentCsrfValue",
        "dashboardId",
        "parentVersionId",
        "canonicalSpecBytes",
        "canonicalSpecSha256",
        "validationSha256",
        "plannerProvenanceSha256",
        "policyRevision",
        "registryRevision",
        "calculationGraphSha256",
        "snapshotIds",
        "evidenceIds",
      ]);
      const dashboardId = uuid(snapshot.dashboardId, "input");
      const parentVersionId = nullableUuid(snapshot.parentVersionId, "input");
      const canonicalSpecBytes = bytes(
        snapshot.canonicalSpecBytes,
        2,
        maximumCanonicalSpecBytes,
        "input",
      );
      const canonicalSpecSha256 = digest(snapshot.canonicalSpecSha256, "input");
      const computed = sha256(canonicalSpecBytes);
      if (!timingSafeEqualCapability(computed, canonicalSpecSha256)) {
        fail("input");
      }
      const validationSha256 = digest(snapshot.validationSha256, "input");
      const plannerProvenanceSha256 = digest(
        snapshot.plannerProvenanceSha256,
        "input",
      );
      const calculationGraphSha256 =
        snapshot.calculationGraphSha256 === null
          ? null
          : digest(snapshot.calculationGraphSha256, "input");
      const policyRevision = safeInteger(
        snapshot.policyRevision,
        1,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      const registryRevision = safeInteger(
        snapshot.registryRevision,
        1,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      const snapshotIds = snapshotUuidArray(snapshot.snapshotIds, 1);
      const evidenceIds = snapshotUuidArray(snapshot.evidenceIds, 0);
      const excluded = objectFreeze([
        dashboardId,
        ...(parentVersionId === null ? [] : [parentVersionId]),
        ...snapshotIds,
        ...evidenceIds,
      ]);
      const generated = this.#generateUuids(
        2 + snapshotIds.length + evidenceIds.length,
        excluded,
      );
      const requestId = generated[0];
      const versionId = generated[1];
      if (requestId === undefined || versionId === undefined) {
        throw preflightInternalFault;
      }
      const snapshotClaimIds = objectFreeze(
        reflectApply(arraySlice, generated, [2, 2 + snapshotIds.length]),
      );
      const evidenceClaimIds = objectFreeze(
        reflectApply(arraySlice, generated, [
          2 + snapshotIds.length,
          2 + snapshotIds.length + evidenceIds.length,
        ]),
      );
      const [auditId] = this.#generateUuids(1, [...excluded, ...generated]);
      if (auditId === undefined) throw preflightInternalFault;
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql: createDashboardVersionSql,
          parameters: objectFreeze([
            dashboardId,
            versionId,
            parentVersionId,
            canonicalSpecBytes,
            canonicalSpecSha256,
            validationSha256,
            plannerProvenanceSha256,
            policyRevision,
            registryRevision,
            calculationGraphSha256,
            snapshotIds,
            snapshotClaimIds,
            evidenceIds,
            evidenceClaimIds,
            auditId,
            csrf.keyVersion,
            digest(csrf.digest, "row"),
            this.#deploymentRevision,
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            validateReturnedUuid(result, "version_id", versionId);
            return frozenResult<CreateDashboardVersionResult>({ versionId });
          },
        }),
      });
    });
    return this.#run(prepared);
  }

  async compareAndSwapDashboardHead(
    input: CompareAndSwapDashboardHeadInput,
  ): Promise<CompareAndSwapDashboardHeadResult> {
    const prepared = this.#preflight<
      PreparedCall<CompareAndSwapDashboardHeadResult>
    >(() => {
      const { snapshot, session, csrf } = this.#mutation(input, [
        "sessionToken",
        "currentCsrfValue",
        "dashboardId",
        "expectedHeadVersionId",
        "newHeadVersionId",
        "expectedLifecycleRevision",
      ]);
      const dashboardId = uuid(snapshot.dashboardId, "input");
      const expectedHeadVersionId = nullableUuid(
        snapshot.expectedHeadVersionId,
        "input",
      );
      const newHeadVersionId = uuid(snapshot.newHeadVersionId, "input");
      const expectedLifecycleRevision = safeInteger(
        snapshot.expectedLifecycleRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      const [requestId, lifecycleEventId] = this.#generateUuids(2, [
        dashboardId,
        ...(expectedHeadVersionId === null ? [] : [expectedHeadVersionId]),
        newHeadVersionId,
      ]);
      if (requestId === undefined || lifecycleEventId === undefined) {
        throw preflightInternalFault;
      }
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql: compareAndSwapDashboardHeadSql,
          parameters: objectFreeze([
            dashboardId,
            expectedHeadVersionId,
            newHeadVersionId,
            expectedLifecycleRevision,
            lifecycleEventId,
            csrf.keyVersion,
            digest(csrf.digest, "row"),
            this.#deploymentRevision,
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            validateAcknowledgement(result);
            return frozenResult<CompareAndSwapDashboardHeadResult>({
              lifecycleEventId,
            });
          },
        }),
      });
    });
    return this.#run(prepared);
  }

  async requestDashboardPromotion(
    input: RequestDashboardPromotionInput,
  ): Promise<RequestDashboardPromotionResult> {
    const prepared = this.#preflight<
      PreparedCall<RequestDashboardPromotionResult>
    >(() => {
      const { snapshot, session, csrf } = this.#mutation(input, [
        "sessionToken",
        "currentCsrfValue",
        "dashboardId",
        "expectedLifecycleRevision",
        "rationaleSha256",
      ]);
      const dashboardId = uuid(snapshot.dashboardId, "input");
      const expectedLifecycleRevision = safeInteger(
        snapshot.expectedLifecycleRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      const rationaleSha256 = digest(snapshot.rationaleSha256, "input");
      const [requestId, promotionRequestId, auditId] = this.#generateUuids(3, [
        dashboardId,
      ]);
      if (
        requestId === undefined ||
        promotionRequestId === undefined ||
        auditId === undefined
      ) {
        throw preflightInternalFault;
      }
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql: requestDashboardPromotionSql,
          parameters: objectFreeze([
            dashboardId,
            promotionRequestId,
            expectedLifecycleRevision,
            rationaleSha256,
            auditId,
            csrf.keyVersion,
            digest(csrf.digest, "row"),
            this.#deploymentRevision,
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            validateReturnedUuid(
              result,
              "promotion_request_id",
              promotionRequestId,
            );
            return frozenResult<RequestDashboardPromotionResult>({
              promotionRequestId,
            });
          },
        }),
      });
    });
    return this.#run(prepared);
  }

  async decideDashboardPromotion(
    input: DecideDashboardPromotionInput,
  ): Promise<DecideDashboardPromotionResult> {
    const prepared = this.#preflight<
      PreparedCall<DecideDashboardPromotionResult>
    >(() => {
      const { snapshot, session, csrf } = this.#mutation(input, [
        "sessionToken",
        "currentCsrfValue",
        "promotionRequestId",
        "expectedLifecycleRevision",
        "decision",
      ]);
      const promotionRequestId = uuid(snapshot.promotionRequestId, "input");
      const expectedLifecycleRevision = safeInteger(
        snapshot.expectedLifecycleRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      if (!isPromotionDecision(snapshot.decision)) fail("input");
      const decision = snapshot.decision;
      const generated = this.#generateUuids(decision === "approved" ? 3 : 2, [
        promotionRequestId,
      ]);
      const requestId = generated[0];
      let lifecycleEventId: string | null = null;
      if (decision === "approved") {
        const generatedLifecycleEventId = generated[1];
        if (generatedLifecycleEventId === undefined) {
          throw preflightInternalFault;
        }
        lifecycleEventId = generatedLifecycleEventId;
      }
      const auditId = generated[decision === "approved" ? 2 : 1];
      if (requestId === undefined || auditId === undefined) {
        throw preflightInternalFault;
      }
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql: decideDashboardPromotionSql,
          parameters: objectFreeze([
            promotionRequestId,
            expectedLifecycleRevision,
            decision,
            lifecycleEventId,
            auditId,
            csrf.keyVersion,
            digest(csrf.digest, "row"),
            this.#deploymentRevision,
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            validateAcknowledgement(result);
            return frozenResult<DecideDashboardPromotionResult>({
              decision,
              lifecycleEventId,
            });
          },
        }),
      });
    });
    return this.#run(prepared);
  }

  async setDashboardArchive(
    input: SetDashboardArchiveInput,
  ): Promise<SetDashboardArchiveResult> {
    const prepared = this.#preflight<PreparedCall<SetDashboardArchiveResult>>(
      () => {
        const { snapshot, session, csrf } = this.#mutation(input, [
          "sessionToken",
          "currentCsrfValue",
          "dashboardId",
          "archived",
          "expectedLifecycleRevision",
        ]);
        const dashboardId = uuid(snapshot.dashboardId, "input");
        if (typeof snapshot.archived !== "boolean") fail("input");
        const archived = snapshot.archived;
        const expectedLifecycleRevision = safeInteger(
          snapshot.expectedLifecycleRevision,
          0,
          Number.MAX_SAFE_INTEGER,
          "input",
        );
        const [requestId, lifecycleEventId] = this.#generateUuids(2, [
          dashboardId,
        ]);
        if (requestId === undefined || lifecycleEventId === undefined) {
          throw preflightInternalFault;
        }
        return objectFreeze({
          requestId,
          session,
          operation: objectFreeze({
            sql: setDashboardArchiveSql,
            parameters: objectFreeze([
              dashboardId,
              archived,
              expectedLifecycleRevision,
              lifecycleEventId,
              csrf.keyVersion,
              digest(csrf.digest, "row"),
              this.#deploymentRevision,
            ]),
            validate: (result: PgCompatibleQueryResult) => {
              validateAcknowledgement(result);
              return frozenResult<SetDashboardArchiveResult>({
                lifecycleEventId,
              });
            },
          }),
        });
      },
    );
    return this.#run(prepared);
  }

  async deleteDashboard(
    input: DeleteDashboardInput,
  ): Promise<DeleteDashboardResult> {
    const prepared = this.#preflight<PreparedCall<DeleteDashboardResult>>(
      () => {
        const { snapshot, session, csrf } = this.#mutation(input, [
          "sessionToken",
          "currentCsrfValue",
          "dashboardId",
          "expectedLifecycleRevision",
        ]);
        const dashboardId = uuid(snapshot.dashboardId, "input");
        const expectedLifecycleRevision = safeInteger(
          snapshot.expectedLifecycleRevision,
          0,
          Number.MAX_SAFE_INTEGER,
          "input",
        );
        const [requestId, lifecycleEventId] = this.#generateUuids(2, [
          dashboardId,
        ]);
        if (requestId === undefined || lifecycleEventId === undefined) {
          throw preflightInternalFault;
        }
        return objectFreeze({
          requestId,
          session,
          operation: objectFreeze({
            sql: deleteDashboardSql,
            parameters: objectFreeze([
              dashboardId,
              expectedLifecycleRevision,
              lifecycleEventId,
              csrf.keyVersion,
              digest(csrf.digest, "row"),
              this.#deploymentRevision,
            ]),
            validate: (result: PgCompatibleQueryResult) => {
              validateAcknowledgement(result);
              return frozenResult<DeleteDashboardResult>({ lifecycleEventId });
            },
          }),
        });
      },
    );
    return this.#run(prepared);
  }

  async restoreDashboardAsNew(
    input: RestoreDashboardAsNewInput,
  ): Promise<RestoreDashboardAsNewResult> {
    const prepared = this.#preflight<PreparedCall<RestoreDashboardAsNewResult>>(
      () => {
        const { snapshot, session, csrf } = this.#mutation(input, [
          "sessionToken",
          "currentCsrfValue",
          "sourceDashboardId",
          "sourceVersionId",
          "expectedSourceLifecycleRevision",
          "title",
          "provenanceSha256",
        ]);
        const sourceDashboardId = uuid(snapshot.sourceDashboardId, "input");
        const sourceVersionId = uuid(snapshot.sourceVersionId, "input");
        const expectedSourceLifecycleRevision = safeInteger(
          snapshot.expectedSourceLifecycleRevision,
          0,
          Number.MAX_SAFE_INTEGER,
          "input",
        );
        const title = boundedDatabaseText(snapshot.title, 200, "input");
        const provenanceSha256 = digest(snapshot.provenanceSha256, "input");
        const [requestId, dashboardId, versionId, tombstoneLineageId, auditId] =
          this.#generateUuids(5, [sourceDashboardId, sourceVersionId]);
        if (
          requestId === undefined ||
          dashboardId === undefined ||
          versionId === undefined ||
          tombstoneLineageId === undefined ||
          auditId === undefined
        ) {
          throw preflightInternalFault;
        }
        return objectFreeze({
          requestId,
          session,
          operation: objectFreeze({
            sql: restoreDashboardAsNewSql,
            parameters: objectFreeze([
              sourceDashboardId,
              sourceVersionId,
              expectedSourceLifecycleRevision,
              dashboardId,
              versionId,
              tombstoneLineageId,
              title,
              provenanceSha256,
              auditId,
              csrf.keyVersion,
              digest(csrf.digest, "row"),
              this.#deploymentRevision,
            ]),
            validate: (result: PgCompatibleQueryResult) => {
              validateAcknowledgement(result);
              return frozenResult<RestoreDashboardAsNewResult>({
                dashboardId,
                versionId,
              });
            },
          }),
        });
      },
    );
    return this.#run(prepared);
  }

  #prepareDashboardRead<Result>(
    input: unknown,
    sql: string,
    validate: (result: PgCompatibleQueryResult, dashboardId: string) => Result,
  ): PreparedCall<Result> {
    return this.#preflight(() => {
      const { snapshot, session } = this.#common(input, [
        "sessionToken",
        "dashboardId",
      ]);
      const dashboardId = uuid(snapshot.dashboardId, "input");
      const [requestId] = this.#generateUuids(1, [dashboardId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql,
          parameters: objectFreeze([dashboardId]),
          validate: (result: PgCompatibleQueryResult) =>
            validate(result, dashboardId),
        }),
      });
    });
  }

  #prepareVersionRead<Result>(
    input: unknown,
    sql: string,
    validate: (
      result: PgCompatibleQueryResult,
      dashboardId: string,
      versionId: string,
    ) => Result,
  ): PreparedCall<Result> {
    return this.#preflight(() => {
      const { snapshot, session } = this.#common(input, [
        "sessionToken",
        "dashboardId",
        "versionId",
      ]);
      const dashboardId = uuid(snapshot.dashboardId, "input");
      const versionId = uuid(snapshot.versionId, "input");
      const [requestId] = this.#generateUuids(1, [dashboardId, versionId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        requestId,
        session,
        operation: objectFreeze({
          sql,
          parameters: objectFreeze([dashboardId, versionId]),
          validate: (result: PgCompatibleQueryResult) =>
            validate(result, dashboardId, versionId),
        }),
      });
    });
  }
}
