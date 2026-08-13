import { randomUUID } from "node:crypto";
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
import {
  AGENT_RUN_VECTOR_FIELDS,
  CALCULATION_METER_FIELDS,
  type AgentCandidateProjection,
  type AgentRunAttemptState,
  type AgentRunEventKind,
  type AgentRunEventSummary,
  type AgentRunInvocationStatus,
  type AgentRunLeaseFence,
  type AgentRunMutation,
  type AgentRunOperatorRepositoryConfig,
  type AgentRunRecordedResultKind,
  type AgentRunRepositoryConfig,
  type AgentRunState,
  type AgentRunCheckpointProjection,
  type AgentRunSummary,
  type AgentRunValidationState,
  type AttemptAccountingResult,
  type AttemptInvocationResult,
  type AttemptReservationResult,
  type AttemptResourceVector,
  type AttemptStartResult,
  type AuthorizeAttemptInvocationInput,
  type CalculationCommitResult,
  type CalculationMeterVector,
  type CancelAgentRunInput,
  type CancelAgentRunResult,
  type CandidateSetResult,
  type CheckpointCommitResult,
  type ClaimAgentRunInput,
  type ClaimAgentRunResult,
  type ClaimSetResult,
  type ClaimedRunInputProjection,
  type CloseCandidateSetInput,
  type CommitBriefInput,
  type CommitCalculationGraphInput,
  type CommitCandidateClaimsInput,
  type CommitCandidateInput,
  type CommitCandidateManifestInput,
  type CommitCommonEvidenceBundleInput,
  type CommitRunAbstentionInput,
  type CommitValidationFindingsInput,
  type ConsumeReplayResultInput,
  type ContentCommitResult,
  type FinalizeRankingInput,
  type FinishRunInput,
  type GetAgentCandidateInput,
  type GetAgentRunCheckpointInput,
  type GetAgentRunInput,
  type ListAgentRunEventsInput,
  type ListClaimedReplayResultsInput,
  type RankingResult,
  type ReconcileAttemptInput,
  type ReleaseAttemptInput,
  type ReplayConsumeResult,
  type ReplayPrerequisiteResult,
  type ReplaySourceResult,
  type RequestAgentRunInput,
  type RequestAgentRunResult,
  type ReserveAttemptInput,
  type StartAttemptInput,
  type ValidationFindingsResult,
  type WriteCheckpointInput,
} from "./agent-run-types.js";

const randomUuidCapability = randomUUID;
const isProxyCapability = utilityTypes.isProxy;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
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

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nonnegativeIntegerPattern = /^(0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const runLoginPattern = /^[a-z][a-z0-9_]*$/;

const preflightInputInvalid = objectFreeze({});
const preflightInternalFault = objectFreeze({});
const keyRingBrandProbe =
  "s1.32767.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const maximumGeneratedUuidAttempts = 16;
const maximumDeploymentScalars = 64;
const maximumDeploymentUtf16CodeUnits = maximumDeploymentScalars * 2;
const maximumRevisionDigits = 19;
const maximumRunLoginLength = 63;
const maximumCanonicalBytes = 1_114_112;
const maximumCanonicalCheckpointBytes = 262_144;
const maximumCanonicalReasonBytes = 4_096;
const maximumLeaseSeconds = 900;
const maximumReplayResults = 5;
/** Frozen transport cap from section 3.4; the bytes stay opaque either way. */
const maximumAccountingBytes = 1_024;
const signedMinimum = -(2n ** 63n);
const signedMaximum = 2n ** 63n - 1n;

/**
 * Managed roles that must never be configured as a worker's restricted run
 * login. `dasher_run_operator` is the role the wrapper assumes with
 * `SET LOCAL ROLE`; it is not a login identity.
 */
const forbiddenRunLogins: readonly string[] = objectFreeze([
  "postgres",
  "dasher_app",
  "dasher_migration_owner",
  "dasher_owner",
  "dasher_run_operator",
  "dasher_run_definer",
  "dasher_security_definer",
  "dasher_retention_definer",
  "dasher_retention_operator",
]);

/**
 * The single admitted tenant cancellation reason. `dasher_api.cancel_agent_run`
 * compares these bytes literally, so there is no caller-supplied reason grammar
 * and no way to smuggle a reason code onto the run ledger.
 */
const runCancelReasonBytes = new uint8ArrayConstructor(
  new TextEncoder().encode(
    '{"reason":"user_requested","schema":"run-cancel-reason-v1"}',
  ),
);

function freshRunCancelReasonBytes(): Uint8Array {
  const snapshot = new uint8ArrayConstructor(runCancelReasonBytes.length);
  reflectApply(uint8ArraySet, snapshot, [runCancelReasonBytes]);
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* Fixed statements                                                    */
/* ------------------------------------------------------------------ */

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

const requestAgentRunSql = `SELECT
  result.run_id,
  result.run_revision,
  result.state,
  result.policy_revision,
  result.request_sha256
FROM dasher_api.request_agent_run(
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::text,
  $5::bigint,
  $6::bytea,
  $7::bytea,
  $8::uuid,
  $9::smallint,
  $10::bytea,
  $11::text,
  $12::uuid
) AS result`;

const cancelAgentRunSql = `SELECT
  result.run_id,
  result.run_revision,
  result.state,
  result.event_sequence,
  result.event_sha256
FROM dasher_api.cancel_agent_run(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::smallint,
  $6::bytea,
  $7::text
) AS result`;

const getAgentRunSql = `SELECT
  result.run_id,
  result.dashboard_id,
  result.state,
  result.run_revision,
  result.policy_revision,
  result.requested_at,
  result.terminal_at,
  result.latest_event_sequence,
  result.latest_checkpoint_revision,
  result.selected_candidate_id
FROM dasher_api.get_agent_run($1::uuid) AS result`;

const listAgentRunEventsSql = `SELECT
  result.run_id,
  result.event_sequence,
  result.event_kind,
  result.occurred_at,
  result.event_sha256,
  result.payload_available
FROM dasher_api.list_agent_run_events(
  $1::uuid,
  $2::bigint,
  $3::integer
) AS result`;

const getAgentRunCheckpointSql = `SELECT
  result.found,
  result.run_id,
  result.checkpoint_revision,
  result.source_event_sequence,
  result.source_event_sha256,
  result.state_sha256,
  result.checkpoint_sha256,
  result.canonical_checkpoint_bytes
FROM dasher_api.get_agent_run_checkpoint($1::uuid) AS result`;

const getAgentCandidateSql = `SELECT
  result.found,
  result.run_id,
  result.candidate_id,
  result.run_state,
  result.candidate_sha256,
  result.common_bundle_sha256,
  result.manifest_sha256,
  result.rank,
  result.selected,
  result.canonical_candidate_bytes,
  result.canonical_manifest_bytes
FROM dasher_api.get_agent_candidate(
  $1::uuid,
  $2::uuid
) AS result`;

function mutationColumns(source: string): string {
  return `  (${source}).run_id AS run_id,
  (${source}).run_revision AS run_revision,
  (${source}).state AS state,
  (${source}).event_sequence AS event_sequence,
  (${source}).event_sha256 AS event_sha256,
  (${source}).lease_epoch AS lease_epoch`;
}

function vectorColumns(source: string, prefix: string): string {
  return AGENT_RUN_VECTOR_FIELDS.map(
    (field) => `  (${source}).${field} AS ${prefix}_${field}`,
  ).join(",\n");
}

const vectorParameters = (start: number): string =>
  AGENT_RUN_VECTOR_FIELDS.map(
    (_field, index) => `    $${String(start + index)}::bigint`,
  ).join(",\n");

const meterParameters = (start: number): string =>
  CALCULATION_METER_FIELDS.map(
    (_field, index) => `    $${String(start + index)}::bigint`,
  ).join(",\n");

const claimAgentRunSql = `SELECT
  result.status,
  result.organization_id,
  result.dashboard_id,
  result.run_id,
  result.run_revision,
  result.state,
  result.lease_epoch,
  result.attempt_token,
  result.lease_expires_at,
  result.policy_revision,
  result.input_sha256
FROM dasher_run_api.claim_agent_run(
  $1::uuid,
  $2::integer
) AS result`;

const getClaimedRunInputSql = `SELECT
  result.run_id,
  result.purpose,
  result.evaluation_time,
  result.policy_revision,
  result.input_snapshot_id,
  result.input_sha256,
  result.input_row_count,
  result.field_catalog_snapshot_id,
  result.metric_contract_set_id,
  result.metric_contract_set_sha256,
${vectorColumns("result.generation_limit_vector", "generation_limit")},
${vectorColumns("result.review_limit_vector", "review_limit")},
  result.replay_source_run_id,
  result.replay_source_result_count,
  result.replay_source_head_sequence,
  result.replay_source_head_sha256,
  result.replay_source_candidate_set_sha256,
  result.replay_source_bundle_id,
  result.replay_source_bundle_sha256,
  result.replay_source_brief_id,
  result.replay_source_brief_sha256,
  result.replay_source_selected_candidate_id,
  result.canonical_input_bytes,
  result.canonical_request_bytes
FROM dasher_run_api.get_claimed_agent_run_input(
  $1::uuid,
  $2::bigint,
  $3::bytea
) AS result`;

const cloneReplayPrerequisitesSql = `SELECT
${mutationColumns("result.mutation")},
  result.source_run_id,
  result.bundle_id,
  result.bundle_sha256,
  result.brief_id,
  result.brief_sha256
FROM dasher_run_api.clone_claimed_replay_prerequisites(
  $1::uuid,
  $2::bigint,
  $3::bytea
) AS result`;

const listClaimedReplayResultsSql = `SELECT
  result.source_run_id,
  result.source_result_sequence,
  result.source_result_sha256,
  result.result_kind,
  result.canonical_result_bytes
FROM dasher_run_api.list_claimed_replay_results(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::bigint,
  $5::integer
) AS result`;

const consumeReplayResultSql = `SELECT
${mutationColumns("result.mutation")},
  result.source_result_sequence,
  result.source_result_sha256,
  result.replay_result_id
FROM dasher_run_api.consume_agent_replay_result(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::bigint,
  $5::bytea
) AS result`;

const writeCheckpointSql = `SELECT
${mutationColumns("result.mutation")},
  result.checkpoint_revision,
  result.state_sha256,
  result.checkpoint_sha256
FROM dasher_run_api.write_agent_run_checkpoint(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::bigint,
  $5::bytea,
  $6::bytea
) AS result`;

const commitBriefSql = `SELECT
${mutationColumns("result.mutation")},
  result.object_id,
  result.content_sha256
FROM dasher_run_api.commit_agent_brief(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const commitCommonBundleSql = `SELECT
${mutationColumns("result.mutation")},
  result.object_id,
  result.content_sha256
FROM dasher_run_api.commit_common_evidence_bundle(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const reserveAttemptSql = `SELECT
${mutationColumns("result.mutation")},
  result.attempt_id,
${vectorColumns("result.reserved_vector", "reserved")}
FROM dasher_run_api.reserve_agent_run_attempt(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::text,
  $6::text,
  ROW(
${vectorParameters(7)}
  )::dasher_run_api.attempt_resource_vector,
  $21::bytea
) AS result`;

const startAttemptSql = `SELECT
${mutationColumns("result.mutation")},
  result.attempt_id,
  result.dispatch_ready_at
FROM dasher_run_api.start_agent_run_attempt(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const authorizeInvocationSql = `SELECT
${mutationColumns("result.mutation")},
  result.attempt_id,
  result.status,
  result.invocation_authorized_at
FROM dasher_run_api.authorize_agent_run_attempt_invocation(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const accountingColumns = `${mutationColumns("result.mutation")},
  result.attempt_id,
  result.attempt_state,
${vectorColumns("result.reserved_vector", "reserved")},
${vectorColumns("result.used_vector", "used")},
${vectorColumns("result.released_vector", "released")},
${vectorColumns("result.outstanding_vector", "outstanding")}`;

const reconcileAttemptSql = `SELECT
${accountingColumns}
FROM dasher_run_api.reconcile_agent_run_attempt(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::text,
  $6::bytea,
  $7::bytea,
  $8::bytea
) AS result`;

const releaseAttemptSql = `SELECT
${accountingColumns}
FROM dasher_run_api.release_agent_run_attempt(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::text,
  $6::bytea
) AS result`;

const commitCalculationGraphSql = `SELECT
${mutationColumns("result.mutation")},
  result.graph_id,
  result.result_id,
  result.graph_sha256,
  result.result_sha256,
${CALCULATION_METER_FIELDS.map((field, index) => {
  const column = meterColumnName(index);
  return `  (result.meter_vector).${column} AS meter_${column}`;
}).join(",\n")}
FROM dasher_run_api.commit_calculation_graph(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea,
  $6::bytea,
  ROW(
${meterParameters(7)}
  )::dasher_run_api.calculation_meter_vector_v1,
  $27::bytea
) AS result`;

const commitCandidateSql = `SELECT
${mutationColumns("result.mutation")},
  result.object_id,
  result.content_sha256
FROM dasher_run_api.commit_agent_candidate(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea,
  $6::bytea,
  $7::uuid,
  $8::bytea,
  $9::bytea
) AS result`;

const commitValidationFindingsSql = `SELECT
${mutationColumns("result.mutation")},
  result.candidate_id,
  result.finding_count,
  result.findings_sha256,
  result.validation_state
FROM dasher_run_api.commit_agent_validation_findings(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const closeCandidateSetSql = `SELECT
${mutationColumns("result.mutation")},
  result.candidate_ids,
  result.candidate_count,
  result.candidate_set_sha256
FROM dasher_run_api.close_agent_candidate_set(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::bytea
) AS result`;

const commitCandidateClaimsSql = `SELECT
${mutationColumns("result.mutation")},
  result.candidate_id,
  result.claim_count,
  result.edge_count,
  result.claim_set_sha256
FROM dasher_run_api.commit_candidate_claims(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const commitCandidateManifestSql = `SELECT
${mutationColumns("result.mutation")},
  result.object_id,
  result.content_sha256
FROM dasher_run_api.commit_candidate_manifest(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea,
  $6::bytea
) AS result`;

const commitRunAbstentionSql = `SELECT
${mutationColumns("result.mutation")},
  result.object_id,
  result.content_sha256
FROM dasher_run_api.commit_run_abstention(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::bytea
) AS result`;

const finalizeRankingSql = `SELECT
${mutationColumns("result.mutation")},
  result.selected_candidate_id,
  result.ordered_candidate_ids,
  result.ordered_ranks,
  result.ranking_sha256
FROM dasher_run_api.finalize_agent_run_ranking(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::uuid,
  $6::bytea
) AS result`;

const finishRunSql = `SELECT
  result.run_id,
  result.run_revision,
  result.state,
  result.event_sequence,
  result.event_sha256,
  result.lease_epoch
FROM dasher_run_api.finish_agent_run(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::text,
  $6::bytea
) AS result`;

function meterColumnName(index: number): string {
  const names = [
    "input_bytes",
    "ast_bytes",
    "node_count",
    "max_depth",
    "max_literal_bytes",
    "total_literal_bytes",
    "max_literal_list_length",
    "scanned_rows",
    "group_count",
    "max_group_rows",
    "cumulative_intermediate_rows",
    "final_output_rows",
    "cumulative_intermediate_bytes",
    "output_bytes",
    "primitive_steps",
    "logical_allocation_bytes",
    "max_top_k",
    "max_window_frame",
    "max_coefficient_digits",
    "max_scale",
  ];
  return names[index]!;
}

/* ------------------------------------------------------------------ */
/* Validation primitives                                               */
/* ------------------------------------------------------------------ */

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

function uuid(candidate: unknown, mode: ValidationMode): string {
  return isCanonicalUuid(candidate) ? candidate : fail(mode);
}

function nullableUuid(candidate: unknown, mode: ValidationMode): string | null {
  return candidate === null ? null : uuid(candidate, mode);
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
    if (prototype !== objectPrototype) return fail(mode);
    const keys = ownKeys(candidate);
    if (keys.length !== expectedKeys.length) return fail(mode);
    const values = objectCreate(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = objectGetOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return fail(mode);
      }
      values[key] = descriptor.value;
    }
    for (const key of keys) {
      if (typeof key !== "string") return fail(mode);
      let expected = false;
      for (const known of expectedKeys) if (known === key) expected = true;
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

function nullableDatabaseInteger(
  candidate: unknown,
  positive: boolean,
): number | null {
  return candidate === null ? null : databaseInteger(candidate, positive);
}

function databaseBigInt(candidate: unknown): bigint {
  let parsed: bigint;
  if (
    typeof candidate === "string" &&
    candidate.length >= 1 &&
    candidate.length <= 20 &&
    reflectApply(regexpTest, nonnegativeIntegerPattern, [candidate])
  ) {
    parsed = BigInt(candidate);
  } else if (typeof candidate === "number" && numberIsSafeInteger(candidate)) {
    parsed = BigInt(candidate);
  } else if (typeof candidate === "bigint") {
    parsed = candidate;
  } else {
    return fail("row");
  }
  if (parsed < 0n || parsed > signedMaximum) return fail("row");
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
      mode === "input" &&
      objectGetPrototypeOf(candidate) !== uint8ArrayConstructor.prototype
    ) {
      return fail(mode);
    }
    const snapshot = new uint8ArrayConstructor(length);
    reflectApply(uint8ArraySet, snapshot, [candidate as Uint8Array]);
    return snapshot;
  } catch {
    return fail(mode);
  }
}

function digest(candidate: unknown, mode: ValidationMode): Uint8Array {
  return bytes(candidate, 32, 32, mode);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function nullableDigest(
  candidate: unknown,
  mode: ValidationMode,
): Uint8Array | null {
  return candidate === null ? null : digest(candidate, mode);
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

function validateRunLoginRole(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > maximumRunLoginLength ||
    !reflectApply(regexpTest, runLoginPattern, [candidate])
  ) {
    return internal();
  }
  for (const forbidden of forbiddenRunLogins) {
    if (forbidden === candidate) return internal();
  }
  return candidate;
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

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

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
  if (idleEpoch <= nowEpoch || absoluteEpoch < idleEpoch) fail("row");
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
  const length = reflectApply(typedArrayByteLengthGetter, value, []);
  const privateCopy = bytes(value, length, length, "row");
  objectDefineProperty(target, property, {
    configurable: false,
    enumerable: true,
    get() {
      return bytes(privateCopy, length, length, "row");
    },
  });
}

const runStates: readonly AgentRunState[] = objectFreeze([
  "requested",
  "authorized",
  "planning",
  "generating",
  "revising",
  "validating",
  "approval_required",
  "rejected",
  "cancelled",
  "expired",
  "failed",
]);

function runState(candidate: unknown, mode: ValidationMode): AgentRunState {
  for (const state of runStates) if (state === candidate) return state;
  return fail(mode);
}

const eventKinds: readonly AgentRunEventKind[] = objectFreeze([
  "run_requested",
  "lease_acquired",
  "indeterminate_quarantined",
  "replay_prerequisites_cloned",
  "replay_result_consumed",
  "checkpoint_written",
  "brief_committed",
  "common_bundle_committed",
  "attempt_reserved",
  "attempt_dispatch_prepared",
  "attempt_dispatch_started",
  "attempt_reconciled",
  "attempt_indeterminate",
  "attempt_released",
  "attempt_cancelled_released",
  "attempt_cancelled_charged",
  "calculation_graph_committed",
  "candidate_validation_findings_committed",
  "candidate_committed",
  "candidate_set_closed",
  "candidate_claims_committed",
  "candidate_manifest_committed",
  "run_abstained",
  "run_ranked",
  "run_finished",
  "run_cancelled",
  "run_cleanup_cancelled",
]);

function eventKind(candidate: unknown): AgentRunEventKind {
  for (const kind of eventKinds) if (kind === candidate) return kind;
  return fail("row");
}

const attemptStates: readonly AgentRunAttemptState[] = objectFreeze([
  "reserved_pre_dispatch",
  "dispatch_ready",
  "dispatch_started",
  "succeeded",
  "refused_charged",
  "failed_charged",
  "released_pre_dispatch",
  "released_takeover",
  "cancelled_released",
  "cancelled_charged",
  "indeterminate_quarantined",
]);

function attemptState(candidate: unknown): AgentRunAttemptState {
  for (const state of attemptStates) if (state === candidate) return state;
  return fail("row");
}

const resultKinds: readonly AgentRunRecordedResultKind[] = objectFreeze([
  "planner_output",
  "specialist_output",
  "candidate_output",
  "candidate_invalid",
  "repair_output",
  "reviewer_verdict_set",
  "refusal",
  "failure",
]);

function recordedResultKind(candidate: unknown): AgentRunRecordedResultKind {
  for (const kind of resultKinds) if (kind === candidate) return kind;
  return fail("row");
}

function readVector(
  row: Readonly<Record<string, unknown>>,
  prefix: string,
): AttemptResourceVector {
  const built = objectCreate(null) as Record<string, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = databaseBigInt(row[`${prefix}_${field}`]);
  }
  return objectFreeze(built) as AttemptResourceVector;
}

function vectorRowKeys(prefix: string): readonly string[] {
  return AGENT_RUN_VECTOR_FIELDS.map((field) => `${prefix}_${field}`);
}

function readMeter(
  row: Readonly<Record<string, unknown>>,
): CalculationMeterVector {
  const built = objectCreate(null) as Record<string, bigint>;
  CALCULATION_METER_FIELDS.forEach((field, index) => {
    built[field] = databaseBigInt(row[`meter_${meterColumnName(index)}`]);
  });
  return objectFreeze(built) as unknown as CalculationMeterVector;
}

const meterRowKeys: readonly string[] = objectFreeze(
  CALCULATION_METER_FIELDS.map(
    (_field, index) => `meter_${meterColumnName(index)}`,
  ),
);

const mutationRowKeys: readonly string[] = objectFreeze([
  "run_id",
  "run_revision",
  "state",
  "event_sequence",
  "event_sha256",
  "lease_epoch",
]);

function validateMutation(
  row: Readonly<Record<string, unknown>>,
  fence: NormalisedFence,
  expectedLeaseEpoch: number = fence.leaseEpoch,
): AgentRunMutation {
  const leaseEpoch = databaseInteger(row.lease_epoch, false);
  if (uuid(row.run_id, "row") !== fence.runId) fail("row");
  if (leaseEpoch !== expectedLeaseEpoch) fail("row");
  const value = {
    runId: fence.runId,
    runRevision: databaseInteger(row.run_revision, true),
    state: runState(row.state, "row"),
    eventSequence: databaseInteger(row.event_sequence, true),
    leaseEpoch,
  } as Omit<AgentRunMutation, "eventSha256"> & object;
  defineBytesProperty(value, "eventSha256", digest(row.event_sha256, "row"));
  return objectFreeze(value as AgentRunMutation);
}

/* ------------------------------------------------------------------ */
/* Client capture and transaction wrappers                             */
/* ------------------------------------------------------------------ */

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
  | "set_role"
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
  readonly rolledBack: boolean;
}

const transactionFailureAuthority = objectFreeze({});

function transactionFailure(
  stage: TransactionStage,
  error: unknown,
  outcome: OperationInternalOutcome = "not_committed",
  rolledBack = false,
): TransactionFailure {
  return objectFreeze({
    authority: transactionFailureAuthority,
    error,
    outcome,
    stage,
    rolledBack,
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

async function runTransaction<Result>(
  connect: () => Promise<PgCompatibleClient>,
  prelude: readonly string[],
  session: VerifiedSecretSnapshot | null,
  requestId: string | null,
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
    for (let index = 0; index < prelude.length; index += 1) {
      stage = index === 0 && prelude.length > 1 ? "set_role" : "set_local";
      await reflectApply(client.query, client.receiver, [prelude[index]!]);
    }
    if (session !== null && requestId !== null) {
      stage = "initialize_select";
      const initialized = await reflectApply(client.query, client.receiver, [
        initializeContextSql,
        [session.keyVersion, session.digest, requestId],
      ]);
      stage = "initialize_validation";
      validateContextResult(initialized);
    }
    stage = "operation_select";
    const selected = await reflectApply(client.query, client.receiver, [
      operation.sql,
      operation.parameters,
    ]);
    stage = "operation_validation";
    operationResult = operation.validate(selected);
  } catch (error) {
    let rolledBack = false;
    try {
      await reflectApply(client.query, client.receiver, ["ROLLBACK"]);
      rolledBack = true;
      normalRelease(client);
    } catch {
      destructiveRelease(client);
    }
    throw transactionFailure(stage, error, "not_committed", rolledBack);
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

const tenantPrelude: readonly string[] = objectFreeze([
  "SET LOCAL search_path = pg_catalog",
]);

/**
 * The run-operator prelude. `SET LOCAL ROLE dasher_run_operator` is a fixed
 * statement: the configured run login is validated before connecting and is
 * never interpolated into SQL.
 */
const operatorPrelude: readonly string[] = objectFreeze([
  "SET LOCAL ROLE dasher_run_operator",
  "SET LOCAL search_path = pg_catalog",
]);

function mapFailure(error: unknown): never {
  const failure = inspectTransactionFailure(error);
  const code =
    failure?.stage === "initialize_select" ||
    failure?.stage === "operation_select"
      ? databaseCode(failure.error)
      : undefined;
  if (code === "P1001") throw new OperationDeniedError();
  if (code === "P1002") throw new OperationConflictError();
  throw new OperationInternalError(failure?.outcome ?? "not_committed");
}

function preflight<Result>(prepare: () => Result): Result {
  try {
    return prepare();
  } catch (error) {
    if (error === preflightInputInvalid) throw new OperationDeniedError();
    if (
      error instanceof OperationDeniedError ||
      error instanceof OperationConflictError ||
      error instanceof OperationInternalError
    ) {
      throw error;
    }
    throw new OperationInternalError();
  }
}

/* ------------------------------------------------------------------ */
/* Tenant repository                                                   */
/* ------------------------------------------------------------------ */

export class AgentRunRepository {
  readonly #connect!: () => Promise<PgCompatibleClient>;
  readonly #keyRing!: SecretKeyRing;
  readonly #deploymentRevision!: string;
  readonly #uuidSource!: () => string;

  constructor(config: AgentRunRepositoryConfig) {
    let configSnapshot: Readonly<Record<string, unknown>>;
    try {
      if (
        config === null ||
        typeof config !== "object" ||
        isProxyCapability(config) ||
        objectGetPrototypeOf(config) !== objectPrototype
      ) {
        return internal();
      }
      const uuidDescriptor = objectGetOwnPropertyDescriptor(
        config,
        "uuidSource",
      );
      configSnapshot = strictObjectSnapshot(
        config,
        uuidDescriptor === undefined
          ? ["pool", "keyRing", "deploymentRevision"]
          : ["pool", "keyRing", "deploymentRevision", "uuidSource"],
        "row",
      );
    } catch {
      return internal();
    }
    const pool = configSnapshot.pool;
    const keyRing = configSnapshot.keyRing;
    const deploymentRevision = configSnapshot.deploymentRevision;
    const uuidSource = configSnapshot.uuidSource;
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
        for (const value of excluded) if (value === candidate) duplicate = true;
        for (const value of generated)
          if (value === candidate) duplicate = true;
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

  async #run<Result>(
    session: VerifiedSecretSnapshot,
    requestId: string,
    operation: OperationStep<Result>,
  ): Promise<Result> {
    try {
      return await runTransaction(
        this.#connect,
        tenantPrelude,
        session,
        requestId,
        operation,
      );
    } catch (error) {
      return mapFailure(error);
    }
  }

  async requestAgentRun(
    input: RequestAgentRunInput,
  ): Promise<RequestAgentRunResult> {
    const prepared = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        [
          "sessionToken",
          "currentCsrfValue",
          "dashboardId",
          "inputSnapshotId",
          "runRequestId",
          "purpose",
          "expectedLifecycleRevision",
          "expectedInputSha256",
          "idempotencySha256",
          "replaySourceRunId",
        ],
        "input",
      );
      const session = verifySecret(
        this.#keyRing,
        "session",
        snapshot.sessionToken,
      );
      const csrf = verifySecret(
        this.#keyRing,
        "csrf",
        snapshot.currentCsrfValue,
      );
      const purpose = snapshot.purpose;
      if (purpose !== "suggest" && purpose !== "replay") fail("input");
      const replaySourceRunId = nullableUuid(
        snapshot.replaySourceRunId,
        "input",
      );
      if ((purpose === "suggest") !== (replaySourceRunId === null)) {
        fail("input");
      }
      const dashboardId = uuid(snapshot.dashboardId, "input");
      const inputSnapshotId = uuid(snapshot.inputSnapshotId, "input");
      const runRequestId = uuid(snapshot.runRequestId, "input");
      const [requestId, auditEventId] = this.#generateUuids(2, [
        dashboardId,
        inputSnapshotId,
        runRequestId,
        ...(replaySourceRunId === null ? [] : [replaySourceRunId]),
      ]);
      if (requestId === undefined || auditEventId === undefined) {
        throw preflightInternalFault;
      }
      return objectFreeze({
        session,
        requestId,
        operation: objectFreeze({
          sql: requestAgentRunSql,
          parameters: objectFreeze([
            dashboardId,
            inputSnapshotId,
            runRequestId,
            purpose,
            safeInteger(
              snapshot.expectedLifecycleRevision,
              1,
              Number.MAX_SAFE_INTEGER,
              "input",
            ),
            digest(snapshot.expectedInputSha256, "input"),
            digest(snapshot.idempotencySha256, "input"),
            auditEventId,
            csrf.keyVersion,
            csrf.digest,
            this.#deploymentRevision,
            replaySourceRunId,
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                "run_id",
                "run_revision",
                "state",
                "policy_revision",
                "request_sha256",
              ],
              "row",
            );
            const value = {
              runId: uuid(row.run_id, "row"),
              runRevision: databaseInteger(row.run_revision, true),
              state: runState(row.state, "row"),
              policyRevision: databaseInteger(row.policy_revision, true),
            } as Omit<RequestAgentRunResult, "requestSha256"> & object;
            defineBytesProperty(
              value,
              "requestSha256",
              digest(row.request_sha256, "row"),
            );
            return objectFreeze(value as RequestAgentRunResult);
          },
        }),
      });
    });
    return this.#run(prepared.session, prepared.requestId, prepared.operation);
  }

  async cancelAgentRun(
    input: CancelAgentRunInput,
  ): Promise<CancelAgentRunResult> {
    const prepared = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        [
          "sessionToken",
          "currentCsrfValue",
          "runId",
          "expectedRunRevision",
          "cancelOperationAndAuditId",
        ],
        "input",
      );
      const session = verifySecret(
        this.#keyRing,
        "session",
        snapshot.sessionToken,
      );
      const csrf = verifySecret(
        this.#keyRing,
        "csrf",
        snapshot.currentCsrfValue,
      );
      const runId = uuid(snapshot.runId, "input");
      // The caller retains this UUID byte-identically so an exact transport
      // retry reconstructs the stored result with zero duplicate DML.
      const operationId = uuid(snapshot.cancelOperationAndAuditId, "input");
      const [requestId] = this.#generateUuids(1, [runId, operationId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        session,
        requestId,
        operation: objectFreeze({
          sql: cancelAgentRunSql,
          parameters: objectFreeze([
            runId,
            safeInteger(
              snapshot.expectedRunRevision,
              1,
              Number.MAX_SAFE_INTEGER,
              "input",
            ),
            freshRunCancelReasonBytes(),
            operationId,
            csrf.keyVersion,
            csrf.digest,
            this.#deploymentRevision,
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                "run_id",
                "run_revision",
                "state",
                "event_sequence",
                "event_sha256",
              ],
              "row",
            );
            if (uuid(row.run_id, "row") !== runId) fail("row");
            const value = {
              runId,
              runRevision: databaseInteger(row.run_revision, true),
              state: runState(row.state, "row"),
              eventSequence: databaseInteger(row.event_sequence, true),
            } as Omit<CancelAgentRunResult, "eventSha256"> & object;
            defineBytesProperty(
              value,
              "eventSha256",
              digest(row.event_sha256, "row"),
            );
            return objectFreeze(value as CancelAgentRunResult);
          },
        }),
      });
    });
    return this.#run(prepared.session, prepared.requestId, prepared.operation);
  }

  async getAgentRun(input: GetAgentRunInput): Promise<AgentRunSummary> {
    const prepared = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        ["sessionToken", "runId"],
        "input",
      );
      const session = verifySecret(
        this.#keyRing,
        "session",
        snapshot.sessionToken,
      );
      const runId = uuid(snapshot.runId, "input");
      const [requestId] = this.#generateUuids(1, [runId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        session,
        requestId,
        operation: objectFreeze({
          sql: getAgentRunSql,
          parameters: objectFreeze([runId]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                "run_id",
                "dashboard_id",
                "state",
                "run_revision",
                "policy_revision",
                "requested_at",
                "terminal_at",
                "latest_event_sequence",
                "latest_checkpoint_revision",
                "selected_candidate_id",
              ],
              "row",
            );
            if (uuid(row.run_id, "row") !== runId) fail("row");
            const state = runState(row.state, "row");
            const terminalAt = nullableTimestamp(row.terminal_at, "row");
            const terminal =
              state === "rejected" ||
              state === "cancelled" ||
              state === "expired" ||
              state === "failed";
            if (terminal !== (terminalAt !== null)) fail("row");
            const value = {
              runId,
              dashboardId: uuid(row.dashboard_id, "row"),
              state,
              runRevision: databaseInteger(row.run_revision, true),
              policyRevision: databaseInteger(row.policy_revision, true),
              latestEventSequence: databaseInteger(
                row.latest_event_sequence,
                true,
              ),
              latestCheckpointRevision: nullableDatabaseInteger(
                row.latest_checkpoint_revision,
                true,
              ),
              selectedCandidateId: nullableUuid(
                row.selected_candidate_id,
                "row",
              ),
            } as Omit<AgentRunSummary, "requestedAt" | "terminalAt"> & object;
            defineDateProperty(
              value,
              "requestedAt",
              timestamp(row.requested_at, "row"),
            );
            defineDateProperty(value, "terminalAt", terminalAt);
            return objectFreeze(value as AgentRunSummary);
          },
        }),
      });
    });
    return this.#run(prepared.session, prepared.requestId, prepared.operation);
  }

  async listAgentRunEvents(
    input: ListAgentRunEventsInput,
  ): Promise<readonly AgentRunEventSummary[]> {
    const prepared = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        ["sessionToken", "runId", "afterSequence", "limit"],
        "input",
      );
      const session = verifySecret(
        this.#keyRing,
        "session",
        snapshot.sessionToken,
      );
      const runId = uuid(snapshot.runId, "input");
      const afterSequence = safeInteger(
        snapshot.afterSequence,
        0,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      const limit = safeInteger(snapshot.limit, 1, 100, "input");
      const [requestId] = this.#generateUuids(1, [runId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        session,
        requestId,
        operation: objectFreeze({
          sql: listAgentRunEventsSql,
          parameters: objectFreeze([runId, afterSequence, limit]),
          validate: (result: PgCompatibleQueryResult) => {
            const rows = queryRows(result);
            if (rows.length > limit) fail("row");
            const projections: AgentRunEventSummary[] = [];
            let previous = afterSequence;
            for (const candidate of rows) {
              const row = strictObjectSnapshot(
                candidate,
                [
                  "run_id",
                  "event_sequence",
                  "event_kind",
                  "occurred_at",
                  "event_sha256",
                  "payload_available",
                ],
                "row",
              );
              if (uuid(row.run_id, "row") !== runId) fail("row");
              const sequence = databaseInteger(row.event_sequence, true);
              if (sequence <= previous) fail("row");
              previous = sequence;
              if (typeof row.payload_available !== "boolean") fail("row");
              const value = {
                runId,
                eventSequence: sequence,
                eventKind: eventKind(row.event_kind),
                payloadAvailable: row.payload_available,
              } as Omit<AgentRunEventSummary, "occurredAt" | "eventSha256"> &
                object;
              defineDateProperty(
                value,
                "occurredAt",
                timestamp(row.occurred_at, "row"),
              );
              defineBytesProperty(
                value,
                "eventSha256",
                digest(row.event_sha256, "row"),
              );
              projections.push(objectFreeze(value as AgentRunEventSummary));
            }
            return objectFreeze(projections);
          },
        }),
      });
    });
    return this.#run(prepared.session, prepared.requestId, prepared.operation);
  }

  async getAgentRunCheckpoint(
    input: GetAgentRunCheckpointInput,
  ): Promise<AgentRunCheckpointProjection> {
    const prepared = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        ["sessionToken", "runId"],
        "input",
      );
      const session = verifySecret(
        this.#keyRing,
        "session",
        snapshot.sessionToken,
      );
      const runId = uuid(snapshot.runId, "input");
      const [requestId] = this.#generateUuids(1, [runId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        session,
        requestId,
        operation: objectFreeze({
          sql: getAgentRunCheckpointSql,
          parameters: objectFreeze([runId]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                "found",
                "run_id",
                "checkpoint_revision",
                "source_event_sequence",
                "source_event_sha256",
                "state_sha256",
                "checkpoint_sha256",
                "canonical_checkpoint_bytes",
              ],
              "row",
            );
            if (typeof row.found !== "boolean") fail("row");
            if (uuid(row.run_id, "row") !== runId) fail("row");
            const checkpointRevision = nullableDatabaseInteger(
              row.checkpoint_revision,
              true,
            );
            const sourceEventSequence = nullableDatabaseInteger(
              row.source_event_sequence,
              true,
            );
            const sourceEventSha256 = nullableDigest(
              row.source_event_sha256,
              "row",
            );
            const checkpointSha256 = nullableDigest(
              row.checkpoint_sha256,
              "row",
            );
            // `state_sha256` alone is cleared by governed purge; the retained
            // envelope digest survives.
            const stateSha256 = nullableDigest(row.state_sha256, "row");
            const canonicalCheckpointBytes =
              row.canonical_checkpoint_bytes === null
                ? null
                : bytes(
                    row.canonical_checkpoint_bytes,
                    1,
                    maximumCanonicalCheckpointBytes,
                    "row",
                  );
            if (row.found) {
              if (
                checkpointRevision === null ||
                sourceEventSequence === null ||
                sourceEventSha256 === null ||
                checkpointSha256 === null
              ) {
                fail("row");
              }
              if (
                (stateSha256 === null) !==
                (canonicalCheckpointBytes === null)
              ) {
                fail("row");
              }
            } else if (
              checkpointRevision !== null ||
              sourceEventSequence !== null ||
              sourceEventSha256 !== null ||
              checkpointSha256 !== null ||
              stateSha256 !== null ||
              canonicalCheckpointBytes !== null
            ) {
              fail("row");
            }
            const value = {
              found: row.found,
              runId,
              checkpointRevision,
              sourceEventSequence,
            } as Omit<
              AgentRunCheckpointProjection,
              | "sourceEventSha256"
              | "stateSha256"
              | "checkpointSha256"
              | "canonicalCheckpointBytes"
            > &
              object;
            defineBytesProperty(value, "sourceEventSha256", sourceEventSha256);
            defineBytesProperty(value, "stateSha256", stateSha256);
            defineBytesProperty(value, "checkpointSha256", checkpointSha256);
            defineBytesProperty(
              value,
              "canonicalCheckpointBytes",
              canonicalCheckpointBytes,
            );
            return objectFreeze(value as AgentRunCheckpointProjection);
          },
        }),
      });
    });
    return this.#run(prepared.session, prepared.requestId, prepared.operation);
  }

  async getAgentCandidate(
    input: GetAgentCandidateInput,
  ): Promise<AgentCandidateProjection> {
    const prepared = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        ["sessionToken", "runId", "candidateId"],
        "input",
      );
      const session = verifySecret(
        this.#keyRing,
        "session",
        snapshot.sessionToken,
      );
      const runId = uuid(snapshot.runId, "input");
      const candidateId = uuid(snapshot.candidateId, "input");
      const [requestId] = this.#generateUuids(1, [runId, candidateId]);
      if (requestId === undefined) throw preflightInternalFault;
      return objectFreeze({
        session,
        requestId,
        operation: objectFreeze({
          sql: getAgentCandidateSql,
          parameters: objectFreeze([runId, candidateId]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                "found",
                "run_id",
                "candidate_id",
                "run_state",
                "candidate_sha256",
                "common_bundle_sha256",
                "manifest_sha256",
                "rank",
                "selected",
                "canonical_candidate_bytes",
                "canonical_manifest_bytes",
              ],
              "row",
            );
            if (
              typeof row.found !== "boolean" ||
              typeof row.selected !== "boolean" ||
              uuid(row.run_id, "row") !== runId ||
              uuid(row.candidate_id, "row") !== candidateId
            ) {
              fail("row");
            }
            const candidateSha256 = nullableDigest(row.candidate_sha256, "row");
            const commonBundleSha256 = nullableDigest(
              row.common_bundle_sha256,
              "row",
            );
            const manifestSha256 = nullableDigest(row.manifest_sha256, "row");
            const canonicalCandidateBytes =
              row.canonical_candidate_bytes === null
                ? null
                : bytes(
                    row.canonical_candidate_bytes,
                    1,
                    maximumCanonicalBytes,
                    "row",
                  );
            const canonicalManifestBytes =
              row.canonical_manifest_bytes === null
                ? null
                : bytes(
                    row.canonical_manifest_bytes,
                    1,
                    maximumCanonicalBytes,
                    "row",
                  );
            const rank = nullableDatabaseInteger(row.rank, true);
            if (row.found) {
              if (
                candidateSha256 === null ||
                commonBundleSha256 === null ||
                canonicalCandidateBytes === null
              ) {
                fail("row");
              }
              if (
                (manifestSha256 === null) !==
                (canonicalManifestBytes === null)
              ) {
                fail("row");
              }
              if (row.selected && rank === null) fail("row");
            } else if (
              candidateSha256 !== null ||
              commonBundleSha256 !== null ||
              manifestSha256 !== null ||
              canonicalCandidateBytes !== null ||
              canonicalManifestBytes !== null ||
              rank !== null ||
              row.selected
            ) {
              fail("row");
            }
            const value = {
              found: row.found,
              runId,
              candidateId,
              runState: runState(row.run_state, "row"),
              rank,
              selected: row.selected,
            } as Omit<
              AgentCandidateProjection,
              | "candidateSha256"
              | "commonBundleSha256"
              | "manifestSha256"
              | "canonicalCandidateBytes"
              | "canonicalManifestBytes"
            > &
              object;
            defineBytesProperty(value, "candidateSha256", candidateSha256);
            defineBytesProperty(
              value,
              "commonBundleSha256",
              commonBundleSha256,
            );
            defineBytesProperty(value, "manifestSha256", manifestSha256);
            defineBytesProperty(
              value,
              "canonicalCandidateBytes",
              canonicalCandidateBytes,
            );
            defineBytesProperty(
              value,
              "canonicalManifestBytes",
              canonicalManifestBytes,
            );
            return objectFreeze(value as AgentCandidateProjection);
          },
        }),
      });
    });
    return this.#run(prepared.session, prepared.requestId, prepared.operation);
  }
}

/* ------------------------------------------------------------------ */
/* Run-operator repository                                             */
/* ------------------------------------------------------------------ */

interface NormalisedFence {
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly attemptToken: Uint8Array;
}

function normaliseFence(
  snapshot: Readonly<Record<string, unknown>>,
): NormalisedFence {
  return objectFreeze({
    runId: uuid(snapshot.runId, "input"),
    leaseEpoch: safeInteger(
      snapshot.leaseEpoch,
      1,
      Number.MAX_SAFE_INTEGER,
      "input",
    ),
    attemptToken: digest(snapshot.attemptToken, "input"),
  });
}

const fenceKeys: readonly string[] = objectFreeze([
  "runId",
  "leaseEpoch",
  "attemptToken",
]);

function fenceParameters(fence: NormalisedFence): readonly unknown[] {
  return [fence.runId, fence.leaseEpoch, fence.attemptToken];
}

function vectorParameterValues(
  candidate: unknown,
  mode: ValidationMode,
): readonly string[] {
  const snapshot = strictObjectSnapshot(
    candidate,
    AGENT_RUN_VECTOR_FIELDS as unknown as readonly string[],
    mode,
  );
  return AGENT_RUN_VECTOR_FIELDS.map((field) => {
    const value = snapshot[field];
    if (
      typeof value !== "bigint" ||
      value < 0n ||
      value > signedMaximum ||
      value < signedMinimum
    ) {
      return fail(mode);
    }
    return String(value);
  });
}

function meterParameterValues(candidate: unknown): readonly string[] {
  const snapshot = strictObjectSnapshot(
    candidate,
    CALCULATION_METER_FIELDS as unknown as readonly string[],
    "input",
  );
  return CALCULATION_METER_FIELDS.map((field) => {
    const value = snapshot[field];
    if (typeof value !== "bigint" || value < 0n || value > signedMaximum) {
      return fail("input");
    }
    return String(value);
  });
}

function canonicalBytes(candidate: unknown, maximum: number): Uint8Array {
  return bytes(candidate, 1, maximum, "input");
}

export class AgentRunOperatorRepository {
  readonly #connect!: () => Promise<PgCompatibleClient>;
  readonly #runLoginRole!: string;

  constructor(config: AgentRunOperatorRepositoryConfig) {
    let configSnapshot: Readonly<Record<string, unknown>>;
    try {
      if (
        config === null ||
        typeof config !== "object" ||
        isProxyCapability(config) ||
        objectGetPrototypeOf(config) !== objectPrototype
      ) {
        return internal();
      }
      configSnapshot = strictObjectSnapshot(
        config,
        ["pool", "runLoginRole"],
        "row",
      );
    } catch {
      return internal();
    }
    const pool = configSnapshot.pool;
    const runLoginRole = configSnapshot.runLoginRole;
    if (pool === null || typeof pool !== "object") internal();
    let connect: unknown;
    try {
      connect = (pool as PgCompatiblePool).connect;
    } catch {
      return internal();
    }
    if (typeof connect !== "function") internal();
    this.#connect = () =>
      reflectApply(connect as PgCompatiblePool["connect"], pool, []);
    this.#runLoginRole = validateRunLoginRole(runLoginRole);
    objectFreeze(this);
  }

  async #run<Result>(operation: OperationStep<Result>): Promise<Result> {
    try {
      return await runTransaction(
        this.#connect,
        operatorPrelude,
        null,
        null,
        operation,
      );
    } catch (error) {
      return mapFailure(error);
    }
  }

  async claimAgentRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult> {
    const operation = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        ["claimRequestId", "leaseSeconds"],
        "input",
      );
      const claimRequestId = uuid(snapshot.claimRequestId, "input");
      const leaseSeconds = safeInteger(
        snapshot.leaseSeconds,
        1,
        maximumLeaseSeconds,
        "input",
      );
      return objectFreeze({
        sql: claimAgentRunSql,
        parameters: objectFreeze([claimRequestId, leaseSeconds]),
        validate: (result: PgCompatibleQueryResult) =>
          validateClaimResult(result),
      });
    });
    try {
      return await runTransaction(
        this.#connect,
        operatorPrelude,
        null,
        null,
        operation,
      );
    } catch (error) {
      const failure = inspectTransactionFailure(error);
      if (
        failure !== undefined &&
        failure.stage === "operation_select" &&
        databaseCode(failure.error) === "P1002"
      ) {
        // A lost race is only ever a no-claim after the rollback is proven; the
        // next attempt starts a fresh transaction. Without that proof the
        // transaction outcome is unknown, so it is never mapped to no-claim.
        return failure.rolledBack
          ? objectFreeze({ status: "no_eligible_run" })
          : internal();
      }
      return mapFailure(error);
    }
  }

  async getClaimedRunInput(
    input: AgentRunLeaseFence,
  ): Promise<ClaimedRunInputProjection> {
    const operation = preflight(() => {
      const fence = normaliseFence(
        strictObjectSnapshot(input, fenceKeys, "input"),
      );
      return objectFreeze({
        sql: getClaimedRunInputSql,
        parameters: objectFreeze(fenceParameters(fence)),
        validate: (result: PgCompatibleQueryResult) =>
          validateClaimedInput(result, fence),
      });
    });
    return this.#run(operation);
  }

  async cloneClaimedReplayPrerequisites(
    input: AgentRunLeaseFence,
  ): Promise<ReplayPrerequisiteResult> {
    const operation = preflight(() => {
      const fence = normaliseFence(
        strictObjectSnapshot(input, fenceKeys, "input"),
      );
      return objectFreeze({
        sql: cloneReplayPrerequisitesSql,
        parameters: objectFreeze(fenceParameters(fence)),
        validate: (result: PgCompatibleQueryResult) => {
          const row = strictObjectSnapshot(
            singleRow(result),
            [
              ...mutationRowKeys,
              "source_run_id",
              "bundle_id",
              "bundle_sha256",
              "brief_id",
              "brief_sha256",
            ],
            "row",
          );
          const value = {
            mutation: validateMutation(row, fence),
            sourceRunId: uuid(row.source_run_id, "row"),
            bundleId: uuid(row.bundle_id, "row"),
            briefId: uuid(row.brief_id, "row"),
          } as Omit<ReplayPrerequisiteResult, "bundleSha256" | "briefSha256"> &
            object;
          defineBytesProperty(
            value,
            "bundleSha256",
            digest(row.bundle_sha256, "row"),
          );
          defineBytesProperty(
            value,
            "briefSha256",
            digest(row.brief_sha256, "row"),
          );
          return objectFreeze(value as ReplayPrerequisiteResult);
        },
      });
    });
    return this.#run(operation);
  }

  async listClaimedReplayResults(
    input: ListClaimedReplayResultsInput,
  ): Promise<readonly ReplaySourceResult[]> {
    const operation = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        [...fenceKeys, "afterSourceSequence", "limit"],
        "input",
      );
      const fence = normaliseFence(snapshot);
      const afterSourceSequence = safeInteger(
        snapshot.afterSourceSequence,
        0,
        Number.MAX_SAFE_INTEGER,
        "input",
      );
      const limit = safeInteger(
        snapshot.limit,
        1,
        maximumReplayResults,
        "input",
      );
      return objectFreeze({
        sql: listClaimedReplayResultsSql,
        parameters: objectFreeze([
          ...fenceParameters(fence),
          afterSourceSequence,
          limit,
        ]),
        validate: (result: PgCompatibleQueryResult) => {
          const rows = queryRows(result);
          if (rows.length > limit) fail("row");
          const projections: ReplaySourceResult[] = [];
          let previous = afterSourceSequence;
          let sourceRunId: string | null = null;
          for (const candidate of rows) {
            const row = strictObjectSnapshot(
              candidate,
              [
                "source_run_id",
                "source_result_sequence",
                "source_result_sha256",
                "result_kind",
                "canonical_result_bytes",
              ],
              "row",
            );
            const runId = uuid(row.source_run_id, "row");
            if (sourceRunId === null) sourceRunId = runId;
            else if (sourceRunId !== runId) fail("row");
            const sequence = databaseInteger(row.source_result_sequence, true);
            if (sequence <= previous) fail("row");
            previous = sequence;
            const value = {
              sourceRunId: runId,
              sourceResultSequence: sequence,
              resultKind: recordedResultKind(row.result_kind),
            } as Omit<
              ReplaySourceResult,
              "sourceResultSha256" | "canonicalResultBytes"
            > &
              object;
            defineBytesProperty(
              value,
              "sourceResultSha256",
              digest(row.source_result_sha256, "row"),
            );
            defineBytesProperty(
              value,
              "canonicalResultBytes",
              bytes(
                row.canonical_result_bytes,
                1,
                maximumCanonicalBytes,
                "row",
              ),
            );
            projections.push(objectFreeze(value as ReplaySourceResult));
          }
          return objectFreeze(projections);
        },
      });
    });
    return this.#run(operation);
  }

  async consumeReplayResult(
    input: ConsumeReplayResultInput,
  ): Promise<ReplayConsumeResult> {
    const operation = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        [...fenceKeys, "sourceResultSequence", "sourceResultSha256"],
        "input",
      );
      const fence = normaliseFence(snapshot);
      const sequence = safeInteger(
        snapshot.sourceResultSequence,
        1,
        maximumReplayResults,
        "input",
      );
      const sha = digest(snapshot.sourceResultSha256, "input");
      return objectFreeze({
        sql: consumeReplayResultSql,
        parameters: objectFreeze([...fenceParameters(fence), sequence, sha]),
        validate: (result: PgCompatibleQueryResult) => {
          const row = strictObjectSnapshot(
            singleRow(result),
            [
              ...mutationRowKeys,
              "source_result_sequence",
              "source_result_sha256",
              "replay_result_id",
            ],
            "row",
          );
          if (databaseInteger(row.source_result_sequence, true) !== sequence) {
            fail("row");
          }
          const returnedSha = digest(row.source_result_sha256, "row");
          if (!bytesEqual(returnedSha, sha)) fail("row");
          const value = {
            mutation: validateMutation(row, fence),
            sourceResultSequence: sequence,
            replayResultId: uuid(row.replay_result_id, "row"),
          } as Omit<ReplayConsumeResult, "sourceResultSha256"> & object;
          defineBytesProperty(value, "sourceResultSha256", returnedSha);
          return objectFreeze(value as ReplayConsumeResult);
        },
      });
    });
    return this.#run(operation);
  }

  async writeCheckpoint(
    input: WriteCheckpointInput,
  ): Promise<CheckpointCommitResult> {
    const operation = preflight(() => {
      const snapshot = strictObjectSnapshot(
        input,
        [
          ...fenceKeys,
          "sourceEventSequence",
          "sourceEventSha256",
          "canonicalCheckpointBytes",
        ],
        "input",
      );
      const fence = normaliseFence(snapshot);
      return objectFreeze({
        sql: writeCheckpointSql,
        parameters: objectFreeze([
          ...fenceParameters(fence),
          safeInteger(
            snapshot.sourceEventSequence,
            1,
            Number.MAX_SAFE_INTEGER,
            "input",
          ),
          digest(snapshot.sourceEventSha256, "input"),
          canonicalBytes(
            snapshot.canonicalCheckpointBytes,
            maximumCanonicalCheckpointBytes,
          ),
        ]),
        validate: (result: PgCompatibleQueryResult) => {
          const row = strictObjectSnapshot(
            singleRow(result),
            [
              ...mutationRowKeys,
              "checkpoint_revision",
              "state_sha256",
              "checkpoint_sha256",
            ],
            "row",
          );
          const value = {
            mutation: validateMutation(row, fence),
            checkpointRevision: databaseInteger(row.checkpoint_revision, true),
          } as Omit<
            CheckpointCommitResult,
            "stateSha256" | "checkpointSha256"
          > &
            object;
          // The semantic digest and the retained envelope digest are separate
          // columns and are validated independently.
          defineBytesProperty(
            value,
            "stateSha256",
            digest(row.state_sha256, "row"),
          );
          defineBytesProperty(
            value,
            "checkpointSha256",
            digest(row.checkpoint_sha256, "row"),
          );
          return objectFreeze(value as CheckpointCommitResult);
        },
      });
    });
    return this.#run(operation);
  }

  async commitBrief(input: CommitBriefInput): Promise<ContentCommitResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "briefId", "canonicalBriefBytes"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const briefId = uuid(snapshot.briefId, "input");
        return objectFreeze({
          sql: commitBriefSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            briefId,
            canonicalBytes(snapshot.canonicalBriefBytes, maximumCanonicalBytes),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateContentCommit(result, fence, briefId),
        });
      }),
    );
  }

  async commitCommonEvidenceBundle(
    input: CommitCommonEvidenceBundleInput,
  ): Promise<ContentCommitResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "bundleId", "canonicalBundleBytes"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const bundleId = uuid(snapshot.bundleId, "input");
        return objectFreeze({
          sql: commitCommonBundleSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            bundleId,
            canonicalBytes(
              snapshot.canonicalBundleBytes,
              maximumCanonicalBytes,
            ),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateContentCommit(result, fence, bundleId),
        });
      }),
    );
  }

  async reserveAttempt(
    input: ReserveAttemptInput,
  ): Promise<AttemptReservationResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [
            ...fenceKeys,
            "attemptId",
            "partition",
            "attemptKind",
            "reservedVector",
            "canonicalRequestBytes",
          ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const attemptId = uuid(snapshot.attemptId, "input");
        const partition = snapshot.partition;
        if (partition !== "generation" && partition !== "review") fail("input");
        const attemptKind = snapshot.attemptKind;
        if (
          attemptKind !== "planner" &&
          attemptKind !== "generator" &&
          attemptKind !== "specialist" &&
          attemptKind !== "repair" &&
          attemptKind !== "reviewer"
        ) {
          fail("input");
        }
        return objectFreeze({
          sql: reserveAttemptSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            attemptId,
            partition,
            attemptKind,
            ...vectorParameterValues(snapshot.reservedVector, "input"),
            canonicalBytes(
              snapshot.canonicalRequestBytes,
              maximumCanonicalBytes,
            ),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [...mutationRowKeys, "attempt_id", ...vectorRowKeys("reserved")],
              "row",
            );
            if (uuid(row.attempt_id, "row") !== attemptId) fail("row");
            return objectFreeze({
              mutation: validateMutation(row, fence),
              attemptId,
              reservedVector: readVector(row, "reserved"),
            }) as AttemptReservationResult;
          },
        });
      }),
    );
  }

  async startAttempt(input: StartAttemptInput): Promise<AttemptStartResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "attemptId", "dispatchRequestSha256"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const attemptId = uuid(snapshot.attemptId, "input");
        return objectFreeze({
          sql: startAttemptSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            attemptId,
            digest(snapshot.dispatchRequestSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [...mutationRowKeys, "attempt_id", "dispatch_ready_at"],
              "row",
            );
            if (uuid(row.attempt_id, "row") !== attemptId) fail("row");
            const value = {
              mutation: validateMutation(row, fence),
              attemptId,
            } as Omit<AttemptStartResult, "dispatchReadyAt"> & object;
            defineDateProperty(
              value,
              "dispatchReadyAt",
              timestamp(row.dispatch_ready_at, "row"),
            );
            return objectFreeze(value as AttemptStartResult);
          },
        });
      }),
    );
  }

  async authorizeAttemptInvocation(
    input: AuthorizeAttemptInvocationInput,
  ): Promise<AttemptInvocationResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "attemptId", "dispatchRequestSha256"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const attemptId = uuid(snapshot.attemptId, "input");
        return objectFreeze({
          sql: authorizeInvocationSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            attemptId,
            digest(snapshot.dispatchRequestSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                ...mutationRowKeys,
                "attempt_id",
                "status",
                "invocation_authorized_at",
              ],
              "row",
            );
            if (uuid(row.attempt_id, "row") !== attemptId) fail("row");
            const status = row.status;
            if (
              status !== "authorized_now" &&
              status !== "already_authorized" &&
              status !== "denied"
            ) {
              fail("row");
            }
            const value = {
              mutation: validateMutation(row, fence),
              attemptId,
              // Only `authorized_now` may be followed by an adapter call, and
              // that call happens strictly after this transaction commits.
              status: status as AgentRunInvocationStatus,
            } as Omit<AttemptInvocationResult, "invocationAuthorizedAt"> &
              object;
            defineDateProperty(
              value,
              "invocationAuthorizedAt",
              nullableTimestamp(row.invocation_authorized_at, "row"),
            );
            return objectFreeze(value as AttemptInvocationResult);
          },
        });
      }),
    );
  }

  async reconcileAttempt(
    input: ReconcileAttemptInput,
  ): Promise<AttemptAccountingResult> {
    return this.#run(
      preflight(() => {
        const outcome = ownDataProperty(input, "outcome", "input");
        const indeterminate = outcome === "indeterminate";
        const snapshot = strictObjectSnapshot(
          input,
          indeterminate
            ? [...fenceKeys, "attemptId", "outcome"]
            : [
                ...fenceKeys,
                "attemptId",
                "outcome",
                "actualAccountingBytes",
                "resultSha256",
                "canonicalRecordedResultBytes",
              ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const attemptId = uuid(snapshot.attemptId, "input");
        if (
          !indeterminate &&
          outcome !== "succeeded" &&
          outcome !== "refused" &&
          outcome !== "failed"
        ) {
          fail("input");
        }
        // The accounting member is captured and forwarded unchanged. It is
        // never decoded, structurally validated, normalized, hashed, logged, or
        // persisted here: only its presence and the inclusive 0..1,024-byte
        // transport cap are enforced.
        const actualAccountingBytes = indeterminate
          ? null
          : bytes(
              snapshot.actualAccountingBytes,
              0,
              maximumAccountingBytes,
              "input",
            );
        return objectFreeze({
          sql: reconcileAttemptSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            attemptId,
            outcome,
            actualAccountingBytes,
            indeterminate ? null : digest(snapshot.resultSha256, "input"),
            indeterminate
              ? null
              : canonicalBytes(
                  snapshot.canonicalRecordedResultBytes,
                  maximumCanonicalBytes,
                ),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateAccounting(result, fence, attemptId),
        });
      }),
    );
  }

  async releaseAttempt(
    input: ReleaseAttemptInput,
  ): Promise<AttemptAccountingResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "attemptId", "reason", "releaseProofSha256"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const attemptId = uuid(snapshot.attemptId, "input");
        const reason = snapshot.reason;
        if (
          reason !== "adapter_setup_failed" &&
          reason !== "cancelled_before_dispatch" &&
          reason !== "retry_superseded"
        ) {
          fail("input");
        }
        return objectFreeze({
          sql: releaseAttemptSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            attemptId,
            reason,
            digest(snapshot.releaseProofSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateAccounting(result, fence, attemptId),
        });
      }),
    );
  }

  async commitCalculationGraph(
    input: CommitCalculationGraphInput,
  ): Promise<CalculationCommitResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [
            ...fenceKeys,
            "graphId",
            "canonicalGraphBytes",
            "canonicalResultBytes",
            "meterVector",
            "expectedInputSha256",
          ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const graphId = uuid(snapshot.graphId, "input");
        return objectFreeze({
          sql: commitCalculationGraphSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            graphId,
            canonicalBytes(snapshot.canonicalGraphBytes, maximumCanonicalBytes),
            canonicalBytes(
              snapshot.canonicalResultBytes,
              maximumCanonicalBytes,
            ),
            ...meterParameterValues(snapshot.meterVector),
            digest(snapshot.expectedInputSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                ...mutationRowKeys,
                "graph_id",
                "result_id",
                "graph_sha256",
                "result_sha256",
                ...meterRowKeys,
              ],
              "row",
            );
            if (uuid(row.graph_id, "row") !== graphId) fail("row");
            const value = {
              mutation: validateMutation(row, fence),
              graphId,
              resultId: uuid(row.result_id, "row"),
              meterVector: readMeter(row),
            } as Omit<CalculationCommitResult, "graphSha256" | "resultSha256"> &
              object;
            defineBytesProperty(
              value,
              "graphSha256",
              digest(row.graph_sha256, "row"),
            );
            defineBytesProperty(
              value,
              "resultSha256",
              digest(row.result_sha256, "row"),
            );
            return objectFreeze(value as CalculationCommitResult);
          },
        });
      }),
    );
  }

  async commitCandidate(
    input: CommitCandidateInput,
  ): Promise<ContentCommitResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [
            ...fenceKeys,
            "candidateId",
            "canonicalDashboardSpecBytes",
            "commonBundleSha256",
            "sourceResultId",
            "sourceResultSha256",
            "precommitValidationSha256",
          ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const candidateId = uuid(snapshot.candidateId, "input");
        return objectFreeze({
          sql: commitCandidateSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            candidateId,
            canonicalBytes(
              snapshot.canonicalDashboardSpecBytes,
              maximumCanonicalBytes,
            ),
            digest(snapshot.commonBundleSha256, "input"),
            uuid(snapshot.sourceResultId, "input"),
            digest(snapshot.sourceResultSha256, "input"),
            digest(snapshot.precommitValidationSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateContentCommit(result, fence, candidateId),
        });
      }),
    );
  }

  async commitValidationFindings(
    input: CommitValidationFindingsInput,
  ): Promise<ValidationFindingsResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "candidateId", "canonicalFindingsBytes"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const candidateId = uuid(snapshot.candidateId, "input");
        return objectFreeze({
          sql: commitValidationFindingsSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            candidateId,
            canonicalBytes(
              snapshot.canonicalFindingsBytes,
              maximumCanonicalBytes,
            ),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                ...mutationRowKeys,
                "candidate_id",
                "finding_count",
                "findings_sha256",
                "validation_state",
              ],
              "row",
            );
            if (uuid(row.candidate_id, "row") !== candidateId) fail("row");
            const state = row.validation_state;
            if (state !== "valid" && state !== "invalid") fail("row");
            const value = {
              mutation: validateMutation(row, fence),
              candidateId,
              findingCount: databaseInteger(row.finding_count, false),
              validationState: state as AgentRunValidationState,
            } as Omit<ValidationFindingsResult, "findingsSha256"> & object;
            defineBytesProperty(
              value,
              "findingsSha256",
              digest(row.findings_sha256, "row"),
            );
            return objectFreeze(value as ValidationFindingsResult);
          },
        });
      }),
    );
  }

  async closeCandidateSet(
    input: CloseCandidateSetInput,
  ): Promise<CandidateSetResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "orderedCandidateSetSha256"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        return objectFreeze({
          sql: closeCandidateSetSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            digest(snapshot.orderedCandidateSetSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                ...mutationRowKeys,
                "candidate_ids",
                "candidate_count",
                "candidate_set_sha256",
              ],
              "row",
            );
            const candidateIds = uuidArray(row.candidate_ids);
            const candidateCount = databaseInteger(row.candidate_count, true);
            if (candidateIds.length !== candidateCount) fail("row");
            const value = {
              mutation: validateMutation(row, fence),
              candidateIds,
              candidateCount,
            } as Omit<CandidateSetResult, "candidateSetSha256"> & object;
            defineBytesProperty(
              value,
              "candidateSetSha256",
              digest(row.candidate_set_sha256, "row"),
            );
            return objectFreeze(value as CandidateSetResult);
          },
        });
      }),
    );
  }

  async commitCandidateClaims(
    input: CommitCandidateClaimsInput,
  ): Promise<ClaimSetResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "candidateId", "canonicalClaimEdgeSetBytes"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const candidateId = uuid(snapshot.candidateId, "input");
        return objectFreeze({
          sql: commitCandidateClaimsSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            candidateId,
            canonicalBytes(
              snapshot.canonicalClaimEdgeSetBytes,
              maximumCanonicalBytes,
            ),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                ...mutationRowKeys,
                "candidate_id",
                "claim_count",
                "edge_count",
                "claim_set_sha256",
              ],
              "row",
            );
            if (uuid(row.candidate_id, "row") !== candidateId) fail("row");
            const value = {
              mutation: validateMutation(row, fence),
              candidateId,
              claimCount: databaseInteger(row.claim_count, false),
              edgeCount: databaseInteger(row.edge_count, false),
            } as Omit<ClaimSetResult, "claimSetSha256"> & object;
            defineBytesProperty(
              value,
              "claimSetSha256",
              digest(row.claim_set_sha256, "row"),
            );
            return objectFreeze(value as ClaimSetResult);
          },
        });
      }),
    );
  }

  async commitCandidateManifest(
    input: CommitCandidateManifestInput,
  ): Promise<ContentCommitResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [
            ...fenceKeys,
            "candidateId",
            "canonicalManifestBytes",
            "reviewerResultSha256",
          ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const candidateId = uuid(snapshot.candidateId, "input");
        return objectFreeze({
          sql: commitCandidateManifestSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            candidateId,
            canonicalBytes(
              snapshot.canonicalManifestBytes,
              maximumCanonicalBytes,
            ),
            digest(snapshot.reviewerResultSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateContentCommit(result, fence, candidateId),
        });
      }),
    );
  }

  async commitRunAbstention(
    input: CommitRunAbstentionInput,
  ): Promise<ContentCommitResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [...fenceKeys, "terminalOperationId", "canonicalAbstentionBytes"],
          "input",
        );
        const fence = normaliseFence(snapshot);
        return objectFreeze({
          sql: commitRunAbstentionSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            uuid(snapshot.terminalOperationId, "input"),
            canonicalBytes(
              snapshot.canonicalAbstentionBytes,
              maximumCanonicalBytes,
            ),
          ]),
          validate: (result: PgCompatibleQueryResult) =>
            validateContentCommit(result, fence, null, fence.leaseEpoch + 1),
        });
      }),
    );
  }

  async finalizeRanking(input: FinalizeRankingInput): Promise<RankingResult> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [
            ...fenceKeys,
            "terminalOperationId",
            "selectedCandidateId",
            "rankingProofSha256",
          ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const selectedCandidateId = uuid(snapshot.selectedCandidateId, "input");
        return objectFreeze({
          sql: finalizeRankingSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            uuid(snapshot.terminalOperationId, "input"),
            selectedCandidateId,
            digest(snapshot.rankingProofSha256, "input"),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              [
                ...mutationRowKeys,
                "selected_candidate_id",
                "ordered_candidate_ids",
                "ordered_ranks",
                "ranking_sha256",
              ],
              "row",
            );
            if (
              uuid(row.selected_candidate_id, "row") !== selectedCandidateId
            ) {
              fail("row");
            }
            const orderedCandidateIds = uuidArray(row.ordered_candidate_ids);
            const orderedRanks = rankArray(row.ordered_ranks);
            if (orderedCandidateIds.length !== orderedRanks.length) fail("row");
            const value = {
              mutation: validateMutation(row, fence, fence.leaseEpoch + 1),
              selectedCandidateId,
              orderedCandidateIds,
              orderedRanks,
            } as Omit<RankingResult, "rankingSha256"> & object;
            defineBytesProperty(
              value,
              "rankingSha256",
              digest(row.ranking_sha256, "row"),
            );
            return objectFreeze(value as RankingResult);
          },
        });
      }),
    );
  }

  async finishRun(input: FinishRunInput): Promise<AgentRunMutation> {
    return this.#run(
      preflight(() => {
        const snapshot = strictObjectSnapshot(
          input,
          [
            ...fenceKeys,
            "terminalOperationId",
            "terminalOutcome",
            "canonicalReasonBytes",
          ],
          "input",
        );
        const fence = normaliseFence(snapshot);
        const outcome = snapshot.terminalOutcome;
        if (
          outcome !== "rejected" &&
          outcome !== "cancelled" &&
          outcome !== "expired" &&
          outcome !== "failed"
        ) {
          fail("input");
        }
        return objectFreeze({
          sql: finishRunSql,
          parameters: objectFreeze([
            ...fenceParameters(fence),
            uuid(snapshot.terminalOperationId, "input"),
            outcome,
            canonicalBytes(
              snapshot.canonicalReasonBytes,
              maximumCanonicalReasonBytes,
            ),
          ]),
          validate: (result: PgCompatibleQueryResult) => {
            const row = strictObjectSnapshot(
              singleRow(result),
              mutationRowKeys,
              "row",
            );
            const mutation = validateMutation(row, fence, fence.leaseEpoch + 1);
            if (mutation.state !== outcome) fail("row");
            return mutation;
          },
        });
      }),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Shared operator validators                                          */
/* ------------------------------------------------------------------ */

function uuidArray(candidate: unknown): readonly string[] {
  if (
    !arrayIsArray(candidate) ||
    isProxyCapability(candidate) ||
    objectGetPrototypeOf(candidate) !== arrayPrototype ||
    candidate.length > 1_000
  ) {
    return fail("row");
  }
  const snapshot: string[] = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const descriptor = objectGetOwnPropertyDescriptor(candidate, String(index));
    if (descriptor === undefined || !("value" in descriptor)) fail("row");
    snapshot[index] = uuid(descriptor.value, "row");
  }
  return objectFreeze(snapshot);
}

function rankArray(candidate: unknown): readonly number[] {
  if (
    !arrayIsArray(candidate) ||
    isProxyCapability(candidate) ||
    objectGetPrototypeOf(candidate) !== arrayPrototype ||
    candidate.length > 1_000
  ) {
    return fail("row");
  }
  const snapshot: number[] = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const descriptor = objectGetOwnPropertyDescriptor(candidate, String(index));
    if (descriptor === undefined || !("value" in descriptor)) fail("row");
    snapshot[index] = databaseInteger(descriptor.value, true);
  }
  return objectFreeze(snapshot);
}

function validateContentCommit(
  result: PgCompatibleQueryResult,
  fence: NormalisedFence,
  expectedObjectId: string | null,
  expectedLeaseEpoch: number = fence.leaseEpoch,
): ContentCommitResult {
  const row = strictObjectSnapshot(
    singleRow(result),
    [...mutationRowKeys, "object_id", "content_sha256"],
    "row",
  );
  const objectId = uuid(row.object_id, "row");
  if (expectedObjectId !== null && objectId !== expectedObjectId) fail("row");
  const value = {
    mutation: validateMutation(row, fence, expectedLeaseEpoch),
    objectId,
  } as Omit<ContentCommitResult, "contentSha256"> & object;
  defineBytesProperty(
    value,
    "contentSha256",
    digest(row.content_sha256, "row"),
  );
  return objectFreeze(value as ContentCommitResult);
}

function validateAccounting(
  result: PgCompatibleQueryResult,
  fence: NormalisedFence,
  attemptId: string,
): AttemptAccountingResult {
  const row = strictObjectSnapshot(
    singleRow(result),
    [
      ...mutationRowKeys,
      "attempt_id",
      "attempt_state",
      ...vectorRowKeys("reserved"),
      ...vectorRowKeys("used"),
      ...vectorRowKeys("released"),
      ...vectorRowKeys("outstanding"),
    ],
    "row",
  );
  if (uuid(row.attempt_id, "row") !== attemptId) fail("row");
  const reservedVector = readVector(row, "reserved");
  const usedVector = readVector(row, "used");
  const releasedVector = readVector(row, "released");
  const outstandingVector = readVector(row, "outstanding");
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    if (
      outstandingVector[field] !==
      reservedVector[field] - usedVector[field] - releasedVector[field]
    ) {
      fail("row");
    }
  }
  return objectFreeze({
    mutation: validateMutation(row, fence),
    attemptId,
    attemptState: attemptState(row.attempt_state),
    reservedVector,
    usedVector,
    releasedVector,
    outstandingVector,
  }) as AttemptAccountingResult;
}

const claimRowKeys: readonly string[] = objectFreeze([
  "status",
  "organization_id",
  "dashboard_id",
  "run_id",
  "run_revision",
  "state",
  "lease_epoch",
  "attempt_token",
  "lease_expires_at",
  "policy_revision",
  "input_sha256",
]);

function validateClaimResult(
  result: PgCompatibleQueryResult,
): ClaimAgentRunResult {
  const row = strictObjectSnapshot(singleRow(result), claimRowKeys, "row");
  const status = row.status;
  if (status === "no_eligible_run") {
    for (const key of claimRowKeys) {
      if (key !== "status" && row[key] !== null) fail("row");
    }
    return objectFreeze({ status: "no_eligible_run" });
  }
  if (status !== "claimed" && status !== "terminalized_indeterminate") {
    return fail("row");
  }
  const organizationId = uuid(row.organization_id, "row");
  const dashboardId = uuid(row.dashboard_id, "row");
  const runId = uuid(row.run_id, "row");
  const runRevision = databaseInteger(row.run_revision, true);
  const state = runState(row.state, "row");
  const leaseEpoch = databaseInteger(row.lease_epoch, true);
  const policyRevision = databaseInteger(row.policy_revision, true);
  if (status === "terminalized_indeterminate") {
    if (
      state !== "failed" ||
      row.attempt_token !== null ||
      row.lease_expires_at !== null ||
      row.input_sha256 !== null
    ) {
      fail("row");
    }
    const terminal = {
      organizationId,
      dashboardId,
      runId,
      runRevision,
      state,
      leaseEpoch,
      policyRevision,
    } as Record<string, unknown>;
    return objectFreeze({
      status: "terminalized_indeterminate",
      terminal: objectFreeze(terminal),
    }) as unknown as ClaimAgentRunResult;
  }
  if (
    state === "rejected" ||
    state === "cancelled" ||
    state === "expired" ||
    state === "failed" ||
    state === "approval_required"
  ) {
    fail("row");
  }
  const lease = {
    organizationId,
    dashboardId,
    runId,
    runRevision,
    state,
    leaseEpoch,
    policyRevision,
  } as Record<string, unknown>;
  defineBytesProperty(lease, "attemptToken", digest(row.attempt_token, "row"));
  defineDateProperty(
    lease,
    "leaseExpiresAt",
    timestamp(row.lease_expires_at, "row"),
  );
  defineBytesProperty(lease, "inputSha256", digest(row.input_sha256, "row"));
  return objectFreeze({
    status: "claimed",
    lease: objectFreeze(lease),
  }) as unknown as ClaimAgentRunResult;
}

const claimedInputRowKeys: readonly string[] = objectFreeze([
  "run_id",
  "purpose",
  "evaluation_time",
  "policy_revision",
  "input_snapshot_id",
  "input_sha256",
  "input_row_count",
  "field_catalog_snapshot_id",
  "metric_contract_set_id",
  "metric_contract_set_sha256",
  ...vectorRowKeys("generation_limit"),
  ...vectorRowKeys("review_limit"),
  "replay_source_run_id",
  "replay_source_result_count",
  "replay_source_head_sequence",
  "replay_source_head_sha256",
  "replay_source_candidate_set_sha256",
  "replay_source_bundle_id",
  "replay_source_bundle_sha256",
  "replay_source_brief_id",
  "replay_source_brief_sha256",
  "replay_source_selected_candidate_id",
  "canonical_input_bytes",
  "canonical_request_bytes",
]);

function validateClaimedInput(
  result: PgCompatibleQueryResult,
  fence: NormalisedFence,
): ClaimedRunInputProjection {
  const row = strictObjectSnapshot(
    singleRow(result),
    claimedInputRowKeys,
    "row",
  );
  if (uuid(row.run_id, "row") !== fence.runId) fail("row");
  const purpose = row.purpose;
  if (purpose !== "suggest" && purpose !== "replay") fail("row");
  const replaySourceRunId = nullableUuid(row.replay_source_run_id, "row");
  if ((purpose === "replay") !== (replaySourceRunId !== null)) fail("row");
  const replayFields = [
    row.replay_source_result_count,
    row.replay_source_head_sequence,
    row.replay_source_head_sha256,
    row.replay_source_candidate_set_sha256,
    row.replay_source_bundle_id,
    row.replay_source_bundle_sha256,
    row.replay_source_brief_id,
    row.replay_source_brief_sha256,
    row.replay_source_selected_candidate_id,
  ];
  if (purpose === "suggest") {
    for (const field of replayFields) if (field !== null) fail("row");
  } else {
    for (const field of replayFields) if (field === null) fail("row");
  }
  const value = {
    runId: fence.runId,
    purpose,
    policyRevision: databaseInteger(row.policy_revision, true),
    inputSnapshotId: uuid(row.input_snapshot_id, "row"),
    inputRowCount: databaseInteger(row.input_row_count, false),
    fieldCatalogSnapshotId: uuid(row.field_catalog_snapshot_id, "row"),
    metricContractSetId: uuid(row.metric_contract_set_id, "row"),
    generationLimitVector: readVector(row, "generation_limit"),
    reviewLimitVector: readVector(row, "review_limit"),
    replaySourceRunId,
    replaySourceResultCount:
      row.replay_source_result_count === null
        ? null
        : safeInteger(row.replay_source_result_count, 3, 5, "row"),
    replaySourceHeadSequence: nullableDatabaseInteger(
      row.replay_source_head_sequence,
      true,
    ),
    replaySourceBundleId: nullableUuid(row.replay_source_bundle_id, "row"),
    replaySourceBriefId: nullableUuid(row.replay_source_brief_id, "row"),
    replaySourceSelectedCandidateId: nullableUuid(
      row.replay_source_selected_candidate_id,
      "row",
    ),
  } as Record<string, unknown>;
  defineDateProperty(
    value,
    "evaluationTime",
    timestamp(row.evaluation_time, "row"),
  );
  defineBytesProperty(value, "inputSha256", digest(row.input_sha256, "row"));
  defineBytesProperty(
    value,
    "metricContractSetSha256",
    digest(row.metric_contract_set_sha256, "row"),
  );
  defineBytesProperty(
    value,
    "replaySourceHeadSha256",
    nullableDigest(row.replay_source_head_sha256, "row"),
  );
  defineBytesProperty(
    value,
    "replaySourceCandidateSetSha256",
    nullableDigest(row.replay_source_candidate_set_sha256, "row"),
  );
  defineBytesProperty(
    value,
    "replaySourceBundleSha256",
    nullableDigest(row.replay_source_bundle_sha256, "row"),
  );
  defineBytesProperty(
    value,
    "replaySourceBriefSha256",
    nullableDigest(row.replay_source_brief_sha256, "row"),
  );
  defineBytesProperty(
    value,
    "canonicalInputBytes",
    bytes(row.canonical_input_bytes, 1, maximumCanonicalBytes, "row"),
  );
  defineBytesProperty(
    value,
    "canonicalRequestBytes",
    bytes(row.canonical_request_bytes, 1, 1_638_400, "row"),
  );
  return objectFreeze(value) as unknown as ClaimedRunInputProjection;
}
