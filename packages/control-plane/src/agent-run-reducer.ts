import { createHash } from "node:crypto";
import { types as utilityTypes } from "node:util";

import {
  AGENT_RUN_BUDGET_PARTITIONS,
  AGENT_RUN_INDETERMINATE_REASONS,
  AGENT_RUN_VECTOR_FIELDS,
  type AgentRunAttemptKind,
  type AgentRunAttemptProjection,
  type AgentRunAttemptReleaseMode,
  type AgentRunAttemptState,
  type AgentRunBudgetCounter,
  type AgentRunBudgetPartition,
  type AgentRunEventKind,
  type AgentRunIndeterminateReason,
  type AgentRunProjection,
  type AgentRunPurpose,
  type AgentRunReducerErrorCode,
  type AgentRunReducerInput,
  type AgentRunReduction,
  type AgentRunState,
  type AgentRunTerminalOperationKind,
  type AgentRunValidationState,
  type AgentRunVectorField,
  type AttemptResourceVector,
} from "./agent-run-types.js";

/**
 * A pure deterministic rebuild of the `agent_runs` projection and the
 * `agent-run-checkpoint-v1` digest from event 1. Nothing here reads a clock, a
 * random source, the filesystem, the network or a database handle; the module
 * imports only `node:crypto` for SHA-256 and `node:util` for proxy detection.
 *
 * Every literal is transcribed from migration 0007 as corrected by 0009:
 *   * body key sets from `dasher_private.append_agent_run_event_v1`,
 *     `dasher_api.request_agent_run`, `dasher_api.cancel_agent_run` and
 *     `dasher_run_api.claim_agent_run`;
 *   * run transitions from `dasher_private.agent_run_transition_guard_v1`;
 *   * the attempt state machine and the settlement equations from
 *     `dasher.agent_run_attempts` and the fixed reconcile/release/claim/cancel
 *     bodies;
 *   * the ordered takeover settlement walk and every digest it commits from
 *     `dasher_run_api.claim_agent_run`;
 *   * the checkpoint projection from `dasher_run_api.write_agent_run_checkpoint`.
 */

const createHashCapability = createHash;
const isProxyCapability = utilityTypes.isProxy;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const ownKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
const regexpExec = RegExp.prototype.exec;
const regexpTest = RegExp.prototype.test;
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lowercaseHex64Pattern = /^[0-9a-f]{64}$/;
const taggedIntegerPattern = /^i64:(0|-?[1-9][0-9]*)$/;
const occurredAtPattern =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{6})Z$/;
const signedMinimum = -(2n ** 63n);
const signedMaximum = 2n ** 63n - 1n;

const maximumLedgerEvents = 1_000_000;
const maximumCanonicalPayloadBytes = 1_114_112;
const maximumCanonicalRequestBytes = 1_638_400;
const maximumCanonicalCheckpointBytes = 262_144;
const maximumLeaseSeconds = 900n;
const maximumAttemptIdArrayLength = 1_000;

const eventPayloadSchema = "agent-run-event-payload-v1";
const checkpointSchema = "agent-run-checkpoint-v1";
const eventPayloadDomain = "dasher.agent-run-event-payload.v1";
const retainedEnvelopeDomain = "dasher.retained-payload-envelope.v1";
const eventDomain = "dasher.agent-run-event.v1";
const checkpointDomain = "dasher.agent-run-checkpoint.v1";
const terminalClaimInputDomain = "dasher.agent-run-terminal-claim-input.v1";
const claimResultDomain = "dasher.agent-run-claim-result.v1";
const settlementEventsDomain = "dasher.takeover-settlement-events.v1";
const terminalOperationDomain = "dasher.run-terminal-operation.v1";
const tenantCancelResultDomain = "dasher.run-tenant-cancel-result.v1";

export class AgentRunReducerError extends Error {
  readonly code: AgentRunReducerErrorCode;

  constructor(code: AgentRunReducerErrorCode) {
    super("dasher_agent_run_reducer_error");
    this.name = "AgentRunReducerError";
    this.code = code;
  }
}

function fail(code: AgentRunReducerErrorCode): never {
  throw new AgentRunReducerError(code);
}

/* ------------------------------------------------------------------ */
/* Byte and digest primitives                                          */
/* ------------------------------------------------------------------ */

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const joined = new uint8ArrayConstructor(total);
  let offset = 0;
  for (const part of parts) {
    reflectApply(uint8ArraySet, joined, [part, offset]);
    offset += part.length;
  }
  return joined;
}

function sha256(input: Uint8Array): Uint8Array {
  const hash = createHashCapability("sha256");
  hash.update(input);
  return new uint8ArrayConstructor(hash.digest());
}

function int32be(value: number): Uint8Array {
  const buffer = new uint8ArrayConstructor(4);
  new DataView(buffer.buffer).setInt32(0, value, false);
  return buffer;
}

function int64be(value: bigint): Uint8Array {
  if (value < signedMinimum || value > signedMaximum) fail("payload_corrupt");
  const buffer = new uint8ArrayConstructor(8);
  new DataView(buffer.buffer).setBigInt64(0, value, false);
  return buffer;
}

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** `int4send(octet_length(text)) || convert_to(text, 'UTF8')`. */
function lengthPrefixedUtf8(value: string): Uint8Array {
  const encoded = utf8(value);
  return concatBytes([int32be(encoded.length), encoded]);
}

function uuidToBytes(value: string): Uint8Array {
  const hex = `${value.slice(0, 8)}${value.slice(9, 13)}${value.slice(
    14,
    18,
  )}${value.slice(19, 23)}${value.slice(24)}`;
  const bytes = new uint8ArrayConstructor(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new uint8ArrayConstructor(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/** Ascending canonical `uuid_send` byte order, as the settlement walk uses. */
function compareUuidBytes(left: string, right: string): number {
  const a = uuidToBytes(left);
  const b = uuidToBytes(right);
  for (let index = 0; index < 16; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function toHex(value: Uint8Array): string {
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    text += value[index]!.toString(16).padStart(2, "0");
  }
  return text;
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new uint8ArrayConstructor(value.length);
  reflectApply(uint8ArraySet, copy, [value]);
  return copy;
}

/** `sha256('dasher.agent-run-event-payload.v1' || 0x00 || len || bytes)`. */
export function agentRunEventSemanticSha256(
  canonicalPayloadBytes: Uint8Array,
): Uint8Array {
  const bytes = snapshotBytes(
    canonicalPayloadBytes,
    1,
    maximumCanonicalPayloadBytes,
  );
  return sha256(
    concatBytes([
      utf8(eventPayloadDomain),
      new uint8ArrayConstructor([0]),
      int32be(bytes.length),
      bytes,
    ]),
  );
}

/**
 * `sha256('dasher.retained-payload-envelope.v1' || 0x00 || schema || nonce ||
 * semantic)`. The nonce is what makes the retained envelope digest independent
 * of the semantic digest, and it is exactly what governed purge deletes.
 */
export function agentRunRetainedEnvelopeSha256(
  schemaName: string,
  contentNonce: Uint8Array,
  semanticSha256: Uint8Array,
): Uint8Array {
  if (schemaName !== eventPayloadSchema && schemaName !== checkpointSchema) {
    fail("invalid_input");
  }
  const nonce = snapshotBytes(contentNonce, 1, 4_096);
  const semantic = snapshotBytes(semanticSha256, 32, 32);
  const name = utf8(schemaName);
  return sha256(
    concatBytes([
      utf8(retainedEnvelopeDomain),
      new uint8ArrayConstructor([0]),
      int32be(name.length),
      name,
      int32be(nonce.length),
      nonce,
      int32be(semantic.length),
      semantic,
    ]),
  );
}

/** `sha256('dasher.agent-run-checkpoint.v1' || 0x00 || len || bytes)`. */
export function agentRunCheckpointStateSha256(
  canonicalCheckpointBytes: Uint8Array,
): Uint8Array {
  const bytes = snapshotBytes(
    canonicalCheckpointBytes,
    1,
    maximumCanonicalCheckpointBytes,
  );
  return sha256(
    concatBytes([
      utf8(checkpointDomain),
      new uint8ArrayConstructor([0]),
      int32be(bytes.length),
      bytes,
    ]),
  );
}

export interface AgentRunEventDigestInput {
  readonly runId: string;
  readonly eventSequence: number;
  readonly eventKind: AgentRunEventKind;
  /** Exact signed Unix-epoch microseconds hashed by PostgreSQL. */
  readonly occurredAtMicros: bigint;
  readonly priorEventSequence: number | null;
  readonly priorEventSha256: Uint8Array | null;
  readonly payloadSha256: Uint8Array;
}

/**
 * The stored per-event digest. The chain it forms detects mutation but is not
 * externally sealed or attacker-proof: an actor able to rewrite the whole
 * retained ledger can rebuild a consistent chain.
 */
export function agentRunEventSha256(
  input: AgentRunEventDigestInput,
): Uint8Array {
  const values = strictSnapshot(
    input,
    [
      "runId",
      "eventSequence",
      "eventKind",
      "occurredAtMicros",
      "priorEventSequence",
      "priorEventSha256",
      "payloadSha256",
    ],
    "invalid_input",
  );
  const runId = canonicalUuid(values.runId, "invalid_input");
  const sequence = boundedInteger(
    values.eventSequence,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const kind = values.eventKind;
  if (!isEventKind(kind)) fail("invalid_input");
  const micros = values.occurredAtMicros;
  if (
    typeof micros !== "bigint" ||
    micros < signedMinimum ||
    micros > signedMaximum
  ) {
    fail("invalid_input");
  }
  const payloadSha256 = snapshotBytes(values.payloadSha256, 32, 32);
  const parts: Uint8Array[] = [
    utf8(eventDomain),
    new uint8ArrayConstructor([0]),
    uuidToBytes(runId),
    int64be(BigInt(sequence)),
    lengthPrefixedUtf8(kind),
    int64be(micros),
  ];
  if (values.priorEventSequence === null) {
    parts.push(new uint8ArrayConstructor([0]));
  } else {
    parts.push(
      new uint8ArrayConstructor([1]),
      int64be(
        BigInt(
          boundedInteger(values.priorEventSequence, 1, Number.MAX_SAFE_INTEGER),
        ),
      ),
    );
  }
  if (values.priorEventSha256 === null) {
    parts.push(new uint8ArrayConstructor([0]));
  } else {
    parts.push(
      new uint8ArrayConstructor([1]),
      snapshotBytes(values.priorEventSha256, 32, 32),
    );
  }
  parts.push(payloadSha256);
  return sha256(concatBytes(parts));
}

/* ------------------------------------------------------------------ */
/* Hostile-input snapshots                                             */
/* ------------------------------------------------------------------ */

function snapshotBytes(
  candidate: unknown,
  minimumLength: number,
  maximumLength: number,
): Uint8Array {
  let length: number;
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      isProxyCapability(candidate)
    ) {
      return fail("invalid_input");
    }
    length = reflectApply(typedArrayByteLengthGetter, candidate, []);
  } catch {
    return fail("invalid_input");
  }
  if (length < minimumLength || length > maximumLength) fail("invalid_input");
  try {
    const snapshot = new uint8ArrayConstructor(length);
    reflectApply(uint8ArraySet, snapshot, [candidate as Uint8Array]);
    return snapshot;
  } catch {
    return fail("invalid_input");
  }
}

/**
 * The single closed-object reader for every reducer boundary. It rejects
 * proxies, non-plain prototypes, accessor properties, symbol keys and any key
 * outside the expected set, and returns a frozen null-prototype snapshot taken
 * exactly once.
 */
function strictSnapshot(
  candidate: unknown,
  expectedKeys: readonly string[],
  code: AgentRunReducerErrorCode,
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    isProxyCapability(candidate)
  ) {
    return fail(code);
  }
  try {
    const prototype = objectGetPrototypeOf(candidate);
    if (prototype !== objectPrototype) return fail(code);
    const keys = ownKeys(candidate);
    if (keys.length !== expectedKeys.length) return fail(code);
    for (const key of keys) {
      if (typeof key !== "string") return fail(code);
      let expected = false;
      for (const known of expectedKeys) if (known === key) expected = true;
      if (!expected) return fail(code);
    }
    const values = objectCreate(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = objectGetOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return fail(code);
      }
      values[key] = descriptor.value;
    }
    return objectFreeze(values);
  } catch (error) {
    if (error instanceof AgentRunReducerError) throw error;
    return fail(code);
  }
}

function canonicalUuid(
  candidate: unknown,
  code: AgentRunReducerErrorCode,
): string {
  if (
    typeof candidate !== "string" ||
    !reflectApply(regexpTest, canonicalUuidPattern, [candidate])
  ) {
    fail(code);
  }
  return candidate;
}

function boundedInteger(
  candidate: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    fail("invalid_input");
  }
  return candidate;
}

function snapshotArray(candidate: unknown): readonly unknown[] {
  if (
    !arrayIsArray(candidate) ||
    isProxyCapability(candidate) ||
    objectGetPrototypeOf(candidate) !== arrayPrototype
  ) {
    fail("invalid_input");
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const descriptor = objectGetOwnPropertyDescriptor(candidate, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("invalid_input");
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* Canonical JSON, transcribed from canonical_jsonb_bytes_v1           */
/* ------------------------------------------------------------------ */

type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function compareUtf8(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  const shared = a.length < b.length ? a.length : b.length;
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function encodeCanonicalString(value: string): string {
  if (value.normalize("NFC") !== value) fail("payload_corrupt");
  for (let index = 0; index < value.length; index += 1) {
    const code = reflectApply(stringCharCodeAt, value, [index]);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next =
        index + 1 < value.length
          ? reflectApply(stringCharCodeAt, value, [index + 1])
          : 0;
      if (next < 0xdc00 || next > 0xdfff) fail("payload_corrupt");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("payload_corrupt");
    }
  }
  return JSON.stringify(value);
}

function canonicalText(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean") {
    return value === null ? "null" : value ? "true" : "false";
  }
  if (typeof value === "string") return encodeCanonicalString(value);
  if (arrayIsArray(value)) {
    let text = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) text += ",";
      text += canonicalText(value[index] as CanonicalValue);
    }
    return `${text}]`;
  }
  if (typeof value !== "object") fail("payload_corrupt");
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys: string[] = [];
  for (const key of ownKeys(record)) {
    if (typeof key !== "string") fail("payload_corrupt");
    keys.push(key);
  }
  keys.sort(compareUtf8);
  let text = "{";
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) text += ",";
    text += `${encodeCanonicalString(keys[index]!)}:${canonicalText(
      record[keys[index]!]!,
    )}`;
  }
  return `${text}}`;
}

/**
 * Canonical bytes for a checkpoint or event body. Numbers are rejected exactly
 * as `canonical_jsonb_bytes_v1` returns NULL for them: every integer on this
 * wire is an `i64:` tagged string.
 */
function canonicalJsonBytes(value: CanonicalValue): Uint8Array {
  return utf8(canonicalText(value));
}

function parseCanonicalJson(bytes: Uint8Array): CanonicalValue {
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    return fail("payload_corrupt");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("payload_corrupt");
  }
  assertCanonicalValue(parsed);
  // Re-rendering proves the stored bytes are already canonical: alternate key
  // order, whitespace, escape variants and duplicate keys all fail here.
  if (!bytesEqual(canonicalJsonBytes(parsed), bytes)) fail("payload_corrupt");
  return parsed;
}

function assertCanonicalValue(
  candidate: unknown,
): asserts candidate is CanonicalValue {
  if (candidate === null || typeof candidate === "boolean") return;
  if (typeof candidate === "string") return;
  if (typeof candidate === "number" || typeof candidate === "bigint") {
    fail("payload_corrupt");
  }
  if (arrayIsArray(candidate)) {
    for (const entry of candidate) assertCanonicalValue(entry);
    return;
  }
  if (typeof candidate !== "object") fail("payload_corrupt");
  if (objectGetPrototypeOf(candidate) !== objectPrototype) {
    fail("payload_corrupt");
  }
  for (const key of ownKeys(candidate)) {
    if (typeof key !== "string") fail("payload_corrupt");
    assertCanonicalValue(
      (candidate as Record<string, unknown>)[key] as unknown,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Body grammar                                                        */
/* ------------------------------------------------------------------ */

const bodyKeys: Readonly<Record<AgentRunEventKind, readonly string[]>> =
  objectFreeze({
    run_requested: [
      "run_request_id",
      "request_payload_id",
      "request_idempotency_sha256",
      "request_sha256",
      "policy_revision",
      "purpose",
      "replay_source_run_id",
    ],
    lease_acquired: [
      "claim_request_id",
      "claim_input_sha256",
      "claim_result_sha256",
      "mode",
      "prior_lease_epoch",
      "new_lease_epoch",
      "lease_token_sha256",
      "lease_expires_at",
      "principal_id",
      "principal_revision",
      "principal_sha256",
    ],
    indeterminate_quarantined: [
      "claim_request_id",
      "lease_seconds",
      "principal_id",
      "principal_revision",
      "principal_sha256",
      "claim_input_sha256",
      "claim_result_sha256",
      "terminal_claim_input_sha256",
      "source_event_sequence",
      "source_event_sha256",
      "released_attempt_ids",
      "charged_attempt_ids",
      "settled_attempt_count",
      "first_settlement_event_sequence",
      "last_settlement_event_sequence",
      "settlement_events_sha256",
      "used_vector",
      "released_vector",
      "prior_lease_epoch",
      "fenced_lease_epoch",
      "terminal_operation_sha256",
    ],
    replay_prerequisites_cloned: [
      "source_run_id",
      "bundle_id",
      "bundle_sha256",
      "brief_id",
      "brief_sha256",
      "candidate_set_sha256",
      "result_count",
      "result_head_sha256",
    ],
    replay_result_consumed: [
      "source_run_id",
      "source_result_sequence",
      "source_result_sha256",
      "replay_result_id",
    ],
    checkpoint_written: [
      "checkpoint_revision",
      "source_event_sequence",
      "source_event_sha256",
      "state_sha256",
      "checkpoint_sha256",
    ],
    brief_committed: ["brief_id", "brief_sha256"],
    common_bundle_committed: ["bundle_id", "bundle_sha256"],
    attempt_reserved: [
      "attempt_id",
      "partition",
      "attempt_kind",
      "candidate_slot",
      "retry_of_attempt_id",
      "request_payload_id",
      "request_sha256",
      "reserved_vector",
    ],
    attempt_dispatch_prepared: ["attempt_id", "dispatch_request_sha256"],
    attempt_dispatch_started: ["attempt_id", "dispatch_request_sha256"],
    attempt_reconciled: [
      "attempt_id",
      "outcome",
      "result_id",
      "result_sha256",
      "actual_vector",
      "used_vector",
      "released_vector",
    ],
    attempt_indeterminate: [
      "attempt_id",
      "reason_code",
      "used_vector",
      "released_vector",
      "fenced_lease_epoch",
    ],
    attempt_released: [
      "attempt_id",
      "release_mode",
      "release_proof_sha256",
      "released_vector",
    ],
    attempt_cancelled_released: [
      "attempt_id",
      "cancel_operation_id",
      "used_vector",
      "released_vector",
    ],
    attempt_cancelled_charged: [
      "attempt_id",
      "cancel_operation_id",
      "used_vector",
      "released_vector",
    ],
    calculation_graph_committed: [
      "graph_id",
      "graph_sha256",
      "result_id",
      "result_sha256",
      "meter_sha256",
    ],
    candidate_validation_findings_committed: [
      "candidate_id",
      "findings_sha256",
      "finding_count",
      "validation_state",
    ],
    candidate_committed: [
      "candidate_id",
      "candidate_spec_sha256",
      "source_result_id",
      "source_result_sha256",
      "precommit_validation_sha256",
      "bundle_sha256",
      "material_claim_count",
      "material_claim_set_sha256",
    ],
    candidate_set_closed: ["candidate_ids", "candidate_set_sha256"],
    candidate_claims_committed: [
      "candidate_id",
      "claims_sha256",
      "claim_count",
      "edge_count",
    ],
    candidate_manifest_committed: [
      "candidate_id",
      "manifest_sha256",
      "reviewer_result_sha256",
    ],
    run_abstained: [
      "terminal_operation_id",
      "abstention_id",
      "abstention_sha256",
    ],
    run_ranked: [
      "terminal_operation_id",
      "selected_candidate_id",
      "ordered_candidate_ids",
      "ordered_ranks",
      "ranking_sha256",
    ],
    run_finished: [
      "terminal_operation_id",
      "terminal_outcome",
      "reason_sha256",
    ],
    run_cancelled: [
      "cancel_operation_id",
      "cancel_operation_sha256",
      "reason_sha256",
      "released_attempt_ids",
      "charged_attempt_ids",
      "used_vector",
      "released_vector",
      "fenced_lease_epoch",
    ],
    run_cleanup_cancelled: [
      "cancel_operation_id",
      "reason_sha256",
      "released_attempt_ids",
      "charged_attempt_ids",
      "used_vector",
      "released_vector",
      "fenced_lease_epoch",
    ],
  });

/** Every event kind the ledger admits, in the frozen declaration order. */
export const AGENT_RUN_EVENT_KINDS: readonly AgentRunEventKind[] = objectFreeze(
  ownKeys(bodyKeys).filter(
    (key): key is AgentRunEventKind => typeof key === "string",
  ),
);

function isEventKind(candidate: unknown): candidate is AgentRunEventKind {
  return (
    typeof candidate === "string" &&
    objectGetOwnPropertyDescriptor(bodyKeys, candidate) !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* Body accessors                                                      */
/* ------------------------------------------------------------------ */

type Body = { readonly [key: string]: CanonicalValue };

function bodyString(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string") fail("payload_corrupt");
  return value;
}

function bodyDigestHex(body: Body, key: string): string {
  const value = bodyString(body, key);
  if (!reflectApply(regexpTest, lowercaseHex64Pattern, [value])) {
    fail("payload_corrupt");
  }
  return value;
}

function parseTagged(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !reflectApply(regexpTest, taggedIntegerPattern, [value])
  ) {
    fail("payload_corrupt");
  }
  const parsed = BigInt(value.slice(4));
  if (parsed < signedMinimum || parsed > signedMaximum) fail("payload_corrupt");
  return parsed;
}

/**
 * Every counter, epoch, sequence, count and vector component on this wire is a
 * nonnegative signed-64 value: `agent_run_attempts` and
 * `agent_run_budget_counters` both carry `CHECK (... >= 0)` on each of them.
 */
function parseUnsignedTagged(value: unknown): bigint {
  const parsed = parseTagged(value);
  if (parsed < 0n) fail("payload_corrupt");
  return parsed;
}

function bodyTagged(body: Body, key: string): bigint {
  return parseUnsignedTagged(body[key]);
}

function bodyNullableTagged(body: Body, key: string): bigint | null {
  return body[key] === null ? null : parseUnsignedTagged(body[key]);
}

function bodyUuid(body: Body, key: string): string {
  return canonicalUuid(body[key], "payload_corrupt");
}

function bodyNullableUuid(body: Body, key: string): string | null {
  return body[key] === null
    ? null
    : canonicalUuid(body[key], "payload_corrupt");
}

function bodyVector(body: Body, key: string): AttemptResourceVector {
  const value = body[key];
  if (
    value === null ||
    typeof value !== "object" ||
    arrayIsArray(value) ||
    objectGetPrototypeOf(value) !== objectPrototype ||
    ownKeys(value).length !== AGENT_RUN_VECTOR_FIELDS.length
  ) {
    fail("payload_corrupt");
  }
  const built = objectCreate(null) as Record<AgentRunVectorField, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    const descriptor = objectGetOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("payload_corrupt");
    }
    built[field] = parseUnsignedTagged(descriptor.value);
  }
  return objectFreeze(built) as AttemptResourceVector;
}

function bodyUuidArray(body: Body, key: string): readonly string[] {
  const value = body[key];
  if (
    !arrayIsArray(value) ||
    value.length > maximumAttemptIdArrayLength ||
    objectGetPrototypeOf(value) !== arrayPrototype
  ) {
    fail("payload_corrupt");
  }
  const snapshot: string[] = [];
  for (const entry of value) {
    snapshot.push(canonicalUuid(entry, "payload_corrupt"));
  }
  return snapshot;
}

function zeroVector(): AttemptResourceVector {
  const built = objectCreate(null) as Record<AgentRunVectorField, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) built[field] = 0n;
  return objectFreeze(built) as AttemptResourceVector;
}

function vectorsEqual(
  left: AttemptResourceVector,
  right: AttemptResourceVector,
): boolean {
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    if (left[field] !== right[field]) return false;
  }
  return true;
}

function subtractVectors(
  left: AttemptResourceVector,
  right: AttemptResourceVector,
): AttemptResourceVector {
  const built = objectCreate(null) as Record<AgentRunVectorField, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = left[field] - right[field];
  }
  return objectFreeze(built) as AttemptResourceVector;
}

/**
 * The indeterminate-settlement equation from section 3.4: every noncandidate
 * component is charged, the candidate proof slot is released, and outstanding
 * is exactly zero.
 */
function indeterminateUsed(
  reserved: AttemptResourceVector,
): AttemptResourceVector {
  const built = objectCreate(null) as Record<AgentRunVectorField, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = field === "candidates" ? 0n : reserved[field];
  }
  return objectFreeze(built) as AttemptResourceVector;
}

function indeterminateReleased(
  reserved: AttemptResourceVector,
): AttemptResourceVector {
  const built = objectCreate(null) as Record<AgentRunVectorField, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = field === "candidates" ? reserved.candidates : 0n;
  }
  return objectFreeze(built) as AttemptResourceVector;
}

function vectorToCanonical(vector: AttemptResourceVector): CanonicalValue {
  const built: Record<string, CanonicalValue> = {};
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = `i64:${String(vector[field])}`;
  }
  return built;
}

/** The frozen `attempt_resource_vector` field order as 14 big-endian int8s. */
function vectorToInt64Bytes(vector: AttemptResourceVector): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    parts.push(int64be(vector[field]));
  }
  return concatBytes(parts);
}

/* ------------------------------------------------------------------ */
/* Vocabulary guards                                                   */
/* ------------------------------------------------------------------ */

function asPartition(value: string): AgentRunBudgetPartition {
  if (value !== "generation" && value !== "review") fail("payload_corrupt");
  return value;
}

function asAttemptKind(value: string): AgentRunAttemptKind {
  if (
    value !== "planner" &&
    value !== "generator" &&
    value !== "specialist" &&
    value !== "repair" &&
    value !== "reviewer"
  ) {
    fail("payload_corrupt");
  }
  return value;
}

/** The frozen kind-to-partition mapping from section 3.4. */
function partitionForKind(kind: AgentRunAttemptKind): AgentRunBudgetPartition {
  return kind === "reviewer" ? "review" : "generation";
}

function asValidationState(value: string): AgentRunValidationState {
  if (value !== "pending" && value !== "valid" && value !== "invalid") {
    fail("payload_corrupt");
  }
  return value;
}

function asIndeterminateReason(value: string): AgentRunIndeterminateReason {
  for (const reason of AGENT_RUN_INDETERMINATE_REASONS) {
    if (reason === value) return reason;
  }
  return fail("unknown_indeterminate_reason");
}

function asReleaseMode(value: string): AgentRunAttemptReleaseMode {
  if (value !== "worker" && value !== "takeover") fail("payload_corrupt");
  return value;
}

function asPurpose(value: string): AgentRunPurpose {
  if (value !== "suggest" && value !== "replay") fail("payload_corrupt");
  return value;
}

const terminalStates: readonly AgentRunState[] = objectFreeze([
  "rejected",
  "cancelled",
  "expired",
  "failed",
]);

function isTerminalState(state: AgentRunState): boolean {
  for (const candidate of terminalStates) if (candidate === state) return true;
  return false;
}

const checkpointFenceStates: readonly AgentRunState[] = objectFreeze([
  "authorized",
  "planning",
  "generating",
  "revising",
  "validating",
]);

function insideCheckpointFence(state: AgentRunState): boolean {
  for (const candidate of checkpointFenceStates) {
    if (candidate === state) return true;
  }
  return false;
}

/** The six states `claim_agent_run` discovers, and the only ones a takeover
 * settlement walk can run against. */
const claimableStates: readonly AgentRunState[] = objectFreeze([
  "requested",
  "authorized",
  "planning",
  "generating",
  "revising",
  "validating",
]);

function isClaimableState(state: AgentRunState): boolean {
  for (const candidate of claimableStates) if (candidate === state) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Attempt state machine, transcribed from 0007                        */
/* ------------------------------------------------------------------ */

const attemptTransitions: Readonly<
  Record<AgentRunAttemptState, readonly AgentRunAttemptState[]>
> = objectFreeze({
  reserved_pre_dispatch: objectFreeze([
    "dispatch_ready",
    "released_pre_dispatch",
    "released_takeover",
    "cancelled_released",
  ] as const),
  dispatch_ready: objectFreeze([
    "dispatch_started",
    "released_pre_dispatch",
    "released_takeover",
    "cancelled_released",
  ] as const),
  dispatch_started: objectFreeze([
    "succeeded",
    "refused_charged",
    "failed_charged",
    "indeterminate_quarantined",
    "cancelled_charged",
  ] as const),
  succeeded: objectFreeze([] as const),
  refused_charged: objectFreeze([] as const),
  failed_charged: objectFreeze([] as const),
  released_pre_dispatch: objectFreeze([] as const),
  released_takeover: objectFreeze([] as const),
  cancelled_released: objectFreeze([] as const),
  cancelled_charged: objectFreeze([] as const),
  indeterminate_quarantined: objectFreeze([] as const),
});

function isTerminalAttemptState(state: AgentRunAttemptState): boolean {
  return attemptTransitions[state].length === 0;
}

function assertAttemptTransition(
  current: AgentRunAttemptState,
  next: AgentRunAttemptState,
): void {
  for (const admitted of attemptTransitions[current]) {
    if (admitted === next) return;
  }
  fail("invalid_transition");
}

/* ------------------------------------------------------------------ */
/* Normalised ledger events                                            */
/* ------------------------------------------------------------------ */

interface NormalisedEvent {
  readonly eventSequence: number;
  readonly eventId: string;
  readonly eventKind: AgentRunEventKind;
  readonly occurredAtMicros: bigint;
  readonly priorEventSequence: number | null;
  readonly priorEventSha256: Uint8Array | null;
  readonly eventSha256: Uint8Array;
  readonly payloadSha256: Uint8Array | null;
  readonly contentNonce: Uint8Array | null;
  readonly canonicalPayloadBytes: Uint8Array | null;
}

const ledgerEventKeys: readonly string[] = objectFreeze([
  "eventSequence",
  "eventId",
  "eventKind",
  "occurredAtMicros",
  "priorEventSequence",
  "priorEventSha256",
  "eventSha256",
  "payloadSha256",
  "contentNonce",
  "canonicalPayloadBytes",
]);

const reducerInputKeys: readonly string[] = objectFreeze([
  "runId",
  "organizationId",
  "dashboardId",
  "canonicalRequestBytes",
  "events",
]);

const canonicalRequestKeys: readonly string[] = objectFreeze([
  "schema",
  "run_request_id",
  "request_idempotency_sha256",
  "dashboard_id",
  "input_snapshot_id",
  "input_sha256",
  "input_table",
  "purpose",
  "evaluation_time",
  "policy_revision",
  "field_catalog",
  "metric_contract_set",
  "generation_limit_vector",
  "review_limit_vector",
  "orchestration_limits",
  "adapter_id",
  "model_id",
  "price_book_revision",
  "replay_source_run_id",
  "replay_source_result_count",
  "replay_source_head_sha256",
  "replay_source_candidate_set_sha256",
  "replay_source_bundle_id",
  "replay_source_bundle_sha256",
  "replay_source_brief_id",
  "replay_source_brief_sha256",
  "replay_source_selected_candidate_id",
]);

function normaliseEvent(candidate: unknown): NormalisedEvent {
  const values = strictSnapshot(
    candidate,
    ledgerEventKeys,
    "invalid_event_header",
  );
  const eventKind = values.eventKind;
  if (!isEventKind(eventKind)) fail("invalid_event_header");
  const occurredAtMicros = values.occurredAtMicros;
  if (
    typeof occurredAtMicros !== "bigint" ||
    occurredAtMicros < signedMinimum ||
    occurredAtMicros > signedMaximum
  ) {
    fail("invalid_event_header");
  }
  const sequence = boundedInteger(values.eventSequence, 1, maximumLedgerEvents);
  const priorSequence =
    values.priorEventSequence === null
      ? null
      : boundedInteger(values.priorEventSequence, 1, maximumLedgerEvents);
  const retained = values.canonicalPayloadBytes !== null;
  if (
    (values.payloadSha256 === null) !== !retained ||
    (values.contentNonce === null) !== !retained
  ) {
    fail("payload_retention_mixed");
  }
  return objectFreeze({
    eventSequence: sequence,
    eventId: canonicalUuid(values.eventId, "invalid_event_header"),
    eventKind,
    occurredAtMicros,
    priorEventSequence: priorSequence,
    priorEventSha256:
      values.priorEventSha256 === null
        ? null
        : snapshotBytes(values.priorEventSha256, 32, 32),
    eventSha256: snapshotBytes(values.eventSha256, 32, 32),
    payloadSha256: retained
      ? snapshotBytes(values.payloadSha256, 32, 32)
      : null,
    contentNonce: retained
      ? snapshotBytes(values.contentNonce, 1, 4_096)
      : null,
    canonicalPayloadBytes: retained
      ? snapshotBytes(
          values.canonicalPayloadBytes,
          1,
          maximumCanonicalPayloadBytes,
        )
      : null,
  });
}

function sameEvent(left: NormalisedEvent, right: NormalisedEvent): boolean {
  if (
    left.eventSequence !== right.eventSequence ||
    left.eventId !== right.eventId ||
    left.eventKind !== right.eventKind ||
    left.occurredAtMicros !== right.occurredAtMicros ||
    left.priorEventSequence !== right.priorEventSequence ||
    !bytesEqual(left.eventSha256, right.eventSha256)
  ) {
    return false;
  }
  const pairs: readonly (readonly [Uint8Array | null, Uint8Array | null])[] = [
    [left.priorEventSha256, right.priorEventSha256],
    [left.payloadSha256, right.payloadSha256],
    [left.contentNonce, right.contentNonce],
    [left.canonicalPayloadBytes, right.canonicalPayloadBytes],
  ];
  for (const [a, b] of pairs) {
    if (a === null || b === null) {
      if (a !== b) return false;
    } else if (!bytesEqual(a, b)) {
      return false;
    }
  }
  return true;
}

/**
 * `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
 * read back as exact epoch microseconds. The database hashes microseconds; the
 * header `Date` only carries milliseconds, so the two must agree to the
 * millisecond and the microsecond remainder comes from here.
 */
function parseOccurredAtMicros(value: unknown, expectedMicros: bigint): bigint {
  if (typeof value !== "string") fail("payload_corrupt");
  const matched = reflectApply(regexpExec, occurredAtPattern, [
    value,
  ]) as RegExpExecArray | null;
  if (matched === null) fail("payload_corrupt");
  const fraction = matched[7]!;
  const milliseconds = Date.parse(`${value.slice(0, 23)}Z`);
  if (!Number.isSafeInteger(milliseconds)) {
    fail("payload_corrupt");
  }
  const micros = BigInt(milliseconds) * 1000n + BigInt(fraction.slice(3));
  if (micros !== expectedMicros) fail("payload_corrupt");
  return micros;
}

/* ------------------------------------------------------------------ */
/* Recomputed operation digests                                        */
/* ------------------------------------------------------------------ */

interface ClaimPrincipal {
  readonly claimRequestId: string;
  readonly leaseSeconds: bigint;
  readonly principalId: string;
  readonly principalRevision: bigint;
  readonly principalSha256: string;
}

function terminalClaimInputSha256(principal: ClaimPrincipal): Uint8Array {
  return sha256(
    concatBytes([
      utf8(terminalClaimInputDomain),
      new uint8ArrayConstructor([0]),
      uuidToBytes(principal.claimRequestId),
      int64be(principal.leaseSeconds),
      uuidToBytes(principal.principalId),
      int64be(principal.principalRevision),
      hexToBytes(principal.principalSha256),
    ]),
  );
}

interface TerminalClaimResultInput {
  readonly claimRequestId: string;
  readonly inputSha256: Uint8Array;
  readonly organizationId: string;
  readonly dashboardId: string;
  readonly runId: string;
  readonly runRevision: bigint;
  readonly leaseEpoch: bigint;
  readonly policyRevision: bigint;
}

/**
 * The `terminalized_indeterminate` projection of
 * `dasher.agent-run-claim-result.v1`: no attempt token, no lease expiry and no
 * input digest, each encoded as the single absent-marker octet.
 */
function terminalClaimResultSha256(
  input: TerminalClaimResultInput,
): Uint8Array {
  return sha256(
    concatBytes([
      utf8(claimResultDomain),
      new uint8ArrayConstructor([0]),
      lengthPrefixedUtf8("indeterminate_takeover"),
      uuidToBytes(input.claimRequestId),
      input.inputSha256,
      lengthPrefixedUtf8("terminalized_indeterminate"),
      uuidToBytes(input.organizationId),
      uuidToBytes(input.dashboardId),
      uuidToBytes(input.runId),
      int64be(input.runRevision),
      lengthPrefixedUtf8("failed"),
      int64be(input.leaseEpoch),
      new uint8ArrayConstructor([0]),
      new uint8ArrayConstructor([0]),
      int64be(input.policyRevision),
      new uint8ArrayConstructor([0]),
    ]),
  );
}

interface SettlementRecord {
  readonly attemptId: string;
  readonly label: "charged" | "released";
  readonly eventSequence: bigint;
  readonly eventSha256: Uint8Array;
  readonly usedVector: AttemptResourceVector;
  readonly releasedVector: AttemptResourceVector;
}

function settlementEventsSha256(
  runId: string,
  priorEpoch: bigint,
  newEpoch: bigint,
  settlements: readonly SettlementRecord[],
): Uint8Array {
  const parts: Uint8Array[] = [
    utf8(settlementEventsDomain),
    new uint8ArrayConstructor([0]),
    uuidToBytes(runId),
    int64be(priorEpoch),
    int64be(newEpoch),
    int64be(BigInt(settlements.length)),
  ];
  for (const settlement of settlements) {
    parts.push(
      uuidToBytes(settlement.attemptId),
      lengthPrefixedUtf8(settlement.label),
      int64be(settlement.eventSequence),
      settlement.eventSha256,
      vectorToInt64Bytes(settlement.usedVector),
      vectorToInt64Bytes(settlement.releasedVector),
    );
  }
  return sha256(concatBytes(parts));
}

interface TerminalOperationInput {
  readonly claimRequestId: string;
  readonly runId: string;
  readonly claimInputSha256: Uint8Array;
  readonly sourceEventSequence: bigint;
  readonly sourceEventSha256: Uint8Array;
  readonly priorEpoch: bigint;
  readonly newEpoch: bigint;
  readonly settledCount: bigint;
  readonly settlementEventsSha256: Uint8Array;
  readonly eventSequence: bigint;
  readonly runRevision: bigint;
  readonly occurredAtMicros: bigint;
  readonly policyRevision: bigint;
}

function runTerminalOperationSha256(input: TerminalOperationInput): Uint8Array {
  return sha256(
    concatBytes([
      utf8(terminalOperationDomain),
      new uint8ArrayConstructor([0]),
      lengthPrefixedUtf8("indeterminate_takeover"),
      uuidToBytes(input.claimRequestId),
      uuidToBytes(input.runId),
      input.claimInputSha256,
      int64be(input.sourceEventSequence),
      input.sourceEventSha256,
      int64be(input.priorEpoch),
      int64be(input.newEpoch),
      int64be(input.settledCount),
      input.settlementEventsSha256,
      int64be(input.eventSequence),
      int64be(input.runRevision),
      lengthPrefixedUtf8("failed"),
      int64be(input.occurredAtMicros),
      int64be(input.policyRevision),
    ]),
  );
}

interface TenantCancelResultInput {
  readonly operationSha256: Uint8Array;
  readonly organizationId: string;
  readonly dashboardId: string;
  readonly runId: string;
  readonly runRevision: bigint;
  readonly eventSequence: bigint;
  readonly eventSha256: Uint8Array;
}

function tenantCancelResultSha256(input: TenantCancelResultInput): Uint8Array {
  return sha256(
    concatBytes([
      utf8(tenantCancelResultDomain),
      new uint8ArrayConstructor([0]),
      input.operationSha256,
      uuidToBytes(input.organizationId),
      uuidToBytes(input.dashboardId),
      uuidToBytes(input.runId),
      int64be(input.runRevision),
      lengthPrefixedUtf8("cancelled"),
      int64be(input.eventSequence),
      input.eventSha256,
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Mutable reduction state                                             */
/* ------------------------------------------------------------------ */

interface AttemptRecord {
  readonly attemptId: string;
  readonly attemptKind: AgentRunAttemptKind;
  readonly partition: AgentRunBudgetPartition;
  readonly candidateSlot: bigint | null;
  readonly retryOfAttemptId: string | null;
  readonly reservedVector: AttemptResourceVector;
  readonly requestSha256: string;
  readonly reservedAtSequence: number;
  leaseEpoch: bigint;
  state: AgentRunAttemptState;
  actualVector: AttemptResourceVector | null;
  usedVector: AttemptResourceVector;
  releasedVector: AttemptResourceVector;
  resultSha256: string | null;
  indeterminateReason: AgentRunIndeterminateReason | null;
}

/**
 * The explicit finite state of one ordered takeover settlement walk. It opens
 * on the first `attempt_released(mode=takeover)` or
 * `attempt_indeterminate(reason=takeover_after_dispatch)` event and closes only
 * on the matching `lease_acquired(mode=takeover)` or aggregate
 * `indeterminate_quarantined`.
 */
interface TakeoverWalk {
  readonly priorEpoch: bigint;
  readonly sourceEventSequence: bigint;
  readonly sourceEventSha256: Uint8Array;
  readonly settlements: SettlementRecord[];
  readonly releasedAttemptIds: string[];
  readonly chargedAttemptIds: string[];
  readonly expectedAttemptIds: readonly string[];
  lastAttemptId: string | null;
  hasDispatched: boolean;
}

interface ReductionState {
  state: AgentRunState;
  runRevision: bigint;
  leaseEpoch: bigint;
  runRequestId: string | null;
  requestIdempotencySha256: string | null;
  requestSha256: string | null;
  policyRevision: bigint | null;
  purpose: AgentRunPurpose | null;
  replaySourceRunId: string | null;
  readonly replaySourceResultCount: bigint | null;
  readonly replaySourceHeadSha256: string | null;
  readonly replaySourceCandidateSetSha256: string | null;
  readonly replaySourceBundleId: string | null;
  readonly replaySourceBundleSha256: string | null;
  readonly replaySourceBriefId: string | null;
  readonly replaySourceBriefSha256: string | null;
  latestBriefSha256: string | null;
  latestBundleSha256: string | null;
  candidateSetSha256: string | null;
  consumedReplaySequence: bigint | null;
  consumedReplaySha256: string | null;
  selectedCandidateId: string | null;
  terminalOperationKind: AgentRunTerminalOperationKind | null;
  terminalOperationId: string | null;
  terminalClaimInputSha256: string | null;
  terminalOperationSha256: string | null;
  tenantCancelOperationId: string | null;
  tenantCancelOperationSha256: string | null;
  tenantCancelResultSha256: string | null;
  tenantCancelResultRunRevision: bigint | null;
  tenantCancelResultEventSequence: bigint | null;
  tenantCancelResultEventSha256: string | null;
  walk: TakeoverWalk | null;
  pendingCancelOperationId: string | null;
  pendingCancelActorKind: "tenant" | "retention" | null;
  pendingCancelLastAttemptId: string | null;
  readonly organizationId: string;
  readonly dashboardId: string;
  readonly runId: string;
  readonly attempts: Map<string, AttemptRecord>;
  readonly attemptOrder: string[];
  readonly candidateIds: string[];
  readonly calculationResultIds: string[];
  readonly validationStates: Map<string, AgentRunValidationState>;
}

interface TransitionContext {
  readonly kind: AgentRunEventKind;
  readonly body: Body;
  readonly eventId: string;
  readonly sequence: number;
  readonly eventSha256: Uint8Array;
  readonly priorEventSequence: number | null;
  readonly priorEventSha256: Uint8Array | null;
  readonly occurredAtMicros: bigint;
  readonly actorKind: "tenant" | "run_operator" | "retention";
}

function requireAttempt(
  reduction: ReductionState,
  attemptId: string,
): AttemptRecord {
  const attempt = reduction.attempts.get(attemptId);
  if (attempt === undefined) fail("invalid_transition");
  return attempt;
}

function settleAttempt(
  attempt: AttemptRecord,
  state: AgentRunAttemptState,
  usedVector: AttemptResourceVector,
  releasedVector: AttemptResourceVector,
  actualVector: AttemptResourceVector | null,
  resultSha256: string | null,
  indeterminateReason: AgentRunIndeterminateReason | null,
): void {
  assertAttemptTransition(attempt.state, state);
  // Every settlement is once-only and exhausts the reservation: the equation
  // reserved = used + released + outstanding with outstanding = 0.
  if (
    !vectorsEqual(
      attempt.reservedVector,
      addVectorPair(usedVector, releasedVector),
    )
  ) {
    fail("budget_invariant_violated");
  }
  attempt.state = state;
  attempt.usedVector = usedVector;
  attempt.releasedVector = releasedVector;
  attempt.actualVector = actualVector;
  attempt.resultSha256 = resultSha256;
  attempt.indeterminateReason = indeterminateReason;
}

function addVectorPair(
  left: AttemptResourceVector,
  right: AttemptResourceVector,
): AttemptResourceVector {
  const built = objectCreate(null) as Record<AgentRunVectorField, bigint>;
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = left[field] + right[field];
  }
  return objectFreeze(built) as AttemptResourceVector;
}

/* ------------------------------------------------------------------ */
/* Ordered takeover settlement walk                                    */
/* ------------------------------------------------------------------ */

function openWalk(
  reduction: ReductionState,
  context: TransitionContext,
): TakeoverWalk {
  if (reduction.walk !== null) return reduction.walk;
  if (!isClaimableState(reduction.state)) fail("invalid_transition");
  if (
    context.priorEventSequence === null ||
    context.priorEventSha256 === null
  ) {
    fail("settlement_mismatch");
  }
  const expectedAttemptIds = reduction.attemptOrder
    .filter((attemptId) => {
      const attempt = reduction.attempts.get(attemptId)!;
      return (
        attempt.leaseEpoch === reduction.leaseEpoch &&
        (attempt.state === "reserved_pre_dispatch" ||
          attempt.state === "dispatch_ready" ||
          attempt.state === "dispatch_started")
      );
    })
    .sort(compareUuidBytes);
  if (expectedAttemptIds.length === 0) fail("settlement_mismatch");
  const walk: TakeoverWalk = {
    priorEpoch: reduction.leaseEpoch,
    sourceEventSequence: BigInt(context.priorEventSequence),
    sourceEventSha256: context.priorEventSha256,
    settlements: [],
    releasedAttemptIds: [],
    chargedAttemptIds: [],
    expectedAttemptIds: objectFreeze(expectedAttemptIds),
    lastAttemptId: null,
    hasDispatched: false,
  };
  reduction.walk = walk;
  return walk;
}

/**
 * Admits one settlement into the pending walk. It must concern the prior lease
 * epoch, an attempt that is still eligible, and must arrive strictly after
 * every previously settled attempt in ascending canonical UUID byte order.
 */
function recordSettlement(
  walk: TakeoverWalk,
  attempt: AttemptRecord,
  context: TransitionContext,
  label: "charged" | "released",
  usedVector: AttemptResourceVector,
  releasedVector: AttemptResourceVector,
): void {
  if (attempt.leaseEpoch !== walk.priorEpoch) fail("settlement_mismatch");
  const expectedAttemptId = walk.expectedAttemptIds[walk.settlements.length];
  if (attempt.attemptId !== expectedAttemptId) fail("settlement_mismatch");
  if (
    walk.lastAttemptId !== null &&
    compareUuidBytes(walk.lastAttemptId, attempt.attemptId) >= 0
  ) {
    fail("settlement_mismatch");
  }
  walk.lastAttemptId = attempt.attemptId;
  walk.settlements.push(
    objectFreeze({
      attemptId: attempt.attemptId,
      label,
      eventSequence: BigInt(context.sequence),
      eventSha256: context.eventSha256,
      usedVector,
      releasedVector,
    }),
  );
  if (label === "charged") {
    walk.chargedAttemptIds.push(attempt.attemptId);
    walk.hasDispatched = true;
  } else {
    walk.releasedAttemptIds.push(attempt.attemptId);
  }
}

function sameUuidList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The aggregate `indeterminate_quarantined` header. Every body field is
 * recomputed from the settlement events the walk actually observed, not merely
 * projected onto the run.
 */
function closeWalkWithAggregate(
  reduction: ReductionState,
  context: TransitionContext,
): void {
  const walk = reduction.walk;
  const body = context.body;
  if (walk === null || !walk.hasDispatched) fail("settlement_mismatch");
  const settlements = walk.settlements;
  if (settlements.length !== walk.expectedAttemptIds.length) {
    fail("settlement_mismatch");
  }
  const last = settlements[settlements.length - 1]!;
  if (
    context.priorEventSequence === null ||
    BigInt(context.priorEventSequence) !== last.eventSequence ||
    context.priorEventSha256 === null ||
    !bytesEqual(context.priorEventSha256, last.eventSha256)
  ) {
    // The aggregate must immediately follow the last settlement event.
    fail("settlement_mismatch");
  }
  if (reduction.policyRevision === null) fail("settlement_mismatch");

  const claimRequestId = bodyUuid(body, "claim_request_id");
  const leaseSeconds = bodyTagged(body, "lease_seconds");
  if (leaseSeconds < 1n || leaseSeconds > maximumLeaseSeconds) {
    fail("settlement_mismatch");
  }
  const principal: ClaimPrincipal = {
    claimRequestId,
    leaseSeconds,
    principalId: bodyUuid(body, "principal_id"),
    principalRevision: bodyTagged(body, "principal_revision"),
    principalSha256: bodyDigestHex(body, "principal_sha256"),
  };
  const priorEpoch = bodyTagged(body, "prior_lease_epoch");
  const fencedEpoch = bodyTagged(body, "fenced_lease_epoch");
  if (priorEpoch !== walk.priorEpoch || fencedEpoch !== walk.priorEpoch + 1n) {
    fail("settlement_mismatch");
  }
  if (
    bodyTagged(body, "source_event_sequence") !== walk.sourceEventSequence ||
    bodyDigestHex(body, "source_event_sha256") !==
      toHex(walk.sourceEventSha256) ||
    bodyTagged(body, "settled_attempt_count") !== BigInt(settlements.length) ||
    bodyTagged(body, "first_settlement_event_sequence") !==
      settlements[0]!.eventSequence ||
    bodyTagged(body, "last_settlement_event_sequence") !== last.eventSequence
  ) {
    fail("settlement_mismatch");
  }
  if (
    !sameUuidList(
      bodyUuidArray(body, "released_attempt_ids"),
      walk.releasedAttemptIds,
    ) ||
    !sameUuidList(
      bodyUuidArray(body, "charged_attempt_ids"),
      walk.chargedAttemptIds,
    )
  ) {
    fail("settlement_mismatch");
  }

  let usedTotal = zeroVector();
  let releasedTotal = zeroVector();
  for (const settlement of settlements) {
    usedTotal = addVectorPair(usedTotal, settlement.usedVector);
    releasedTotal = addVectorPair(releasedTotal, settlement.releasedVector);
  }
  if (
    !vectorsEqual(bodyVector(body, "used_vector"), usedTotal) ||
    !vectorsEqual(bodyVector(body, "released_vector"), releasedTotal)
  ) {
    fail("settlement_mismatch");
  }

  const claimInputSha256 = terminalClaimInputSha256(principal);
  const claimInputHex = toHex(claimInputSha256);
  if (
    bodyDigestHex(body, "claim_input_sha256") !== claimInputHex ||
    bodyDigestHex(body, "terminal_claim_input_sha256") !== claimInputHex
  ) {
    fail("settlement_mismatch");
  }
  const runRevision = reduction.runRevision;
  const claimResultHex = toHex(
    terminalClaimResultSha256({
      claimRequestId,
      inputSha256: claimInputSha256,
      organizationId: reduction.organizationId,
      dashboardId: reduction.dashboardId,
      runId: reduction.runId,
      runRevision,
      leaseEpoch: fencedEpoch,
      policyRevision: reduction.policyRevision,
    }),
  );
  if (bodyDigestHex(body, "claim_result_sha256") !== claimResultHex) {
    fail("settlement_mismatch");
  }
  const settlementDigest = settlementEventsSha256(
    reduction.runId,
    walk.priorEpoch,
    fencedEpoch,
    settlements,
  );
  if (
    bodyDigestHex(body, "settlement_events_sha256") !== toHex(settlementDigest)
  ) {
    fail("settlement_mismatch");
  }
  const terminalOperationHex = toHex(
    runTerminalOperationSha256({
      claimRequestId,
      runId: reduction.runId,
      claimInputSha256,
      sourceEventSequence: walk.sourceEventSequence,
      sourceEventSha256: walk.sourceEventSha256,
      priorEpoch: walk.priorEpoch,
      newEpoch: fencedEpoch,
      settledCount: BigInt(settlements.length),
      settlementEventsSha256: settlementDigest,
      eventSequence: BigInt(context.sequence),
      runRevision,
      occurredAtMicros: context.occurredAtMicros,
      policyRevision: reduction.policyRevision,
    }),
  );
  if (
    bodyDigestHex(body, "terminal_operation_sha256") !== terminalOperationHex
  ) {
    fail("settlement_mismatch");
  }

  reduction.state = "failed";
  reduction.leaseEpoch = fencedEpoch;
  reduction.terminalOperationKind = "indeterminate_takeover";
  reduction.terminalOperationId = claimRequestId;
  reduction.terminalClaimInputSha256 = claimInputHex;
  reduction.terminalOperationSha256 = terminalOperationHex;
  reduction.walk = null;
}

/* ------------------------------------------------------------------ */
/* Transitions, transcribed from agent_run_transition_guard_v1         */
/* ------------------------------------------------------------------ */

/**
 * The two per-attempt settlement kinds a takeover walk may append. Migration
 * 0009 makes an `attempt_indeterminate` carrying
 * `reason_code = takeover_after_dispatch` preserve the run state; every other
 * indeterminate reason still terminalizes the run in the same event.
 */
function continuesWalk(kind: AgentRunEventKind, body: Body): boolean {
  if (kind === "attempt_released") {
    return bodyString(body, "release_mode") === "takeover";
  }
  if (kind === "attempt_indeterminate") {
    return bodyString(body, "reason_code") === "takeover_after_dispatch";
  }
  return false;
}

function applyTransition(
  reduction: ReductionState,
  context: TransitionContext,
): void {
  const { kind, body, sequence } = context;
  if (reduction.walk !== null) {
    // A pending walk is a contiguous suffix: only its own settlement kinds and
    // its two exact terminators may appear until it closes.
    const continues = continuesWalk(kind, body);
    const terminates =
      (kind === "lease_acquired" && !reduction.walk.hasDispatched) ||
      (kind === "indeterminate_quarantined" && reduction.walk.hasDispatched);
    if (!continues && !terminates) fail("settlement_mismatch");
  }
  if (reduction.pendingCancelOperationId !== null) {
    const continues =
      kind === "attempt_cancelled_released" ||
      kind === "attempt_cancelled_charged";
    const terminates =
      (kind === "run_cancelled" &&
        reduction.pendingCancelActorKind === "tenant") ||
      (kind === "run_cleanup_cancelled" &&
        reduction.pendingCancelActorKind === "retention");
    if (!continues && !terminates) fail("settlement_mismatch");
  }
  if (reduction.terminalOperationKind !== null) fail("terminal_reopen");
  if (isTerminalState(reduction.state)) fail("terminal_reopen");
  switch (kind) {
    case "run_requested": {
      if (sequence !== 1) fail("invalid_transition");
      if (context.actorKind !== "tenant") fail("payload_corrupt");
      reduction.state = "requested";
      reduction.runRequestId = bodyUuid(body, "run_request_id");
      bodyUuid(body, "request_payload_id");
      reduction.requestIdempotencySha256 = bodyDigestHex(
        body,
        "request_idempotency_sha256",
      );
      reduction.requestSha256 = bodyDigestHex(body, "request_sha256");
      reduction.policyRevision = bodyTagged(body, "policy_revision");
      reduction.purpose = asPurpose(bodyString(body, "purpose"));
      reduction.replaySourceRunId = bodyNullableUuid(
        body,
        "replay_source_run_id",
      );
      if (
        (reduction.purpose === "replay") !==
        (reduction.replaySourceRunId !== null)
      ) {
        fail("payload_corrupt");
      }
      return;
    }
    case "lease_acquired": {
      const priorEpoch = bodyTagged(body, "prior_lease_epoch");
      const newEpoch = bodyTagged(body, "new_lease_epoch");
      const mode = bodyString(body, "mode");
      const walk = reduction.walk;
      const settledCount = walk === null ? 0 : walk.settlements.length;
      if (priorEpoch !== reduction.leaseEpoch || newEpoch !== priorEpoch + 1n) {
        fail("invalid_transition");
      }
      const expectedMode =
        settledCount > 0 ? "takeover" : priorEpoch === 0n ? "normal" : "resume";
      if (mode !== expectedMode) fail("settlement_mismatch");
      if (walk !== null) {
        // A non-dispatched all-release takeover terminates here and only here.
        if (walk.hasDispatched || settledCount === 0) {
          fail("settlement_mismatch");
        }
        if (settledCount !== walk.expectedAttemptIds.length) {
          fail("settlement_mismatch");
        }
        reduction.walk = null;
      }
      bodyUuid(body, "claim_request_id");
      bodyDigestHex(body, "claim_input_sha256");
      bodyDigestHex(body, "claim_result_sha256");
      bodyDigestHex(body, "lease_token_sha256");
      bodyUuid(body, "principal_id");
      bodyTagged(body, "principal_revision");
      bodyDigestHex(body, "principal_sha256");
      bodyString(body, "lease_expires_at");
      if (reduction.state === "requested") {
        reduction.state = "authorized";
      } else if (!insideCheckpointFence(reduction.state)) {
        fail("invalid_transition");
      }
      reduction.leaseEpoch = newEpoch;
      return;
    }
    case "indeterminate_quarantined": {
      closeWalkWithAggregate(reduction, context);
      return;
    }
    case "replay_prerequisites_cloned": {
      if (reduction.state !== "authorized") fail("invalid_transition");
      if (reduction.purpose !== "replay") fail("invalid_transition");
      if (bodyUuid(body, "source_run_id") !== reduction.replaySourceRunId) {
        fail("request_binding_mismatch");
      }
      if (
        bodyUuid(body, "bundle_id") !== reduction.replaySourceBundleId ||
        bodyUuid(body, "brief_id") !== reduction.replaySourceBriefId ||
        bodyDigestHex(body, "candidate_set_sha256") !==
          reduction.replaySourceCandidateSetSha256 ||
        bodyTagged(body, "result_count") !==
          reduction.replaySourceResultCount ||
        bodyDigestHex(body, "result_head_sha256") !==
          reduction.replaySourceHeadSha256 ||
        bodyDigestHex(body, "brief_sha256") !==
          reduction.replaySourceBriefSha256 ||
        bodyDigestHex(body, "bundle_sha256") !==
          reduction.replaySourceBundleSha256
      ) {
        fail("request_binding_mismatch");
      }
      reduction.state = "planning";
      reduction.latestBriefSha256 = reduction.replaySourceBriefSha256;
      reduction.latestBundleSha256 = reduction.replaySourceBundleSha256;
      return;
    }
    case "attempt_reserved": {
      const attemptKind = asAttemptKind(bodyString(body, "attempt_kind"));
      const partition = asPartition(bodyString(body, "partition"));
      if (partition !== partitionForKind(attemptKind)) {
        fail("payload_corrupt");
      }
      const previous = reduction.state;
      // `reserve_agent_run_attempt` derives the next state from the kind, and
      // `agent_run_transition_guard_v1` then admits only these exact pairs.
      const next: AgentRunState =
        attemptKind === "planner"
          ? "planning"
          : (attemptKind === "specialist" || attemptKind === "generator") &&
              previous === "planning"
            ? "generating"
            : attemptKind === "repair"
              ? "revising"
              : previous;
      const admitted =
        (previous === "authorized" && next === "planning") ||
        (previous === "planning" &&
          (next === "planning" || next === "generating")) ||
        (previous === "generating" &&
          (next === "generating" || next === "revising")) ||
        ((previous === "revising" || previous === "validating") &&
          next === previous);
      if (!admitted) fail("invalid_transition");
      const attemptId = bodyUuid(body, "attempt_id");
      if (reduction.attempts.has(attemptId)) fail("invalid_transition");
      if (reduction.leaseEpoch === 0n) fail("invalid_transition");
      bodyUuid(body, "request_payload_id");
      const record: AttemptRecord = {
        attemptId,
        attemptKind,
        partition,
        candidateSlot: bodyNullableTagged(body, "candidate_slot"),
        retryOfAttemptId: bodyNullableUuid(body, "retry_of_attempt_id"),
        reservedVector: bodyVector(body, "reserved_vector"),
        requestSha256: bodyDigestHex(body, "request_sha256"),
        reservedAtSequence: sequence,
        leaseEpoch: reduction.leaseEpoch,
        state: "reserved_pre_dispatch",
        actualVector: null,
        usedVector: zeroVector(),
        releasedVector: zeroVector(),
        resultSha256: null,
        indeterminateReason: null,
      };
      reduction.attempts.set(attemptId, record);
      reduction.attemptOrder.push(attemptId);
      reduction.state = next;
      return;
    }
    case "attempt_dispatch_prepared": {
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      bodyDigestHex(body, "dispatch_request_sha256");
      assertAttemptTransition(attempt.state, "dispatch_ready");
      attempt.state = "dispatch_ready";
      return;
    }
    case "attempt_dispatch_started": {
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      bodyDigestHex(body, "dispatch_request_sha256");
      assertAttemptTransition(attempt.state, "dispatch_started");
      attempt.state = "dispatch_started";
      return;
    }
    case "attempt_reconciled": {
      const outcome = bodyString(body, "outcome");
      const attemptState: AgentRunAttemptState =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "refused"
            ? "refused_charged"
            : outcome === "failed"
              ? "failed_charged"
              : fail("payload_corrupt");
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      const actual = bodyVector(body, "actual_vector");
      const used = bodyVector(body, "used_vector");
      const released = bodyVector(body, "released_vector");
      // The determinate equation: used = actual, released = reserved - actual,
      // outstanding = 0, with actual componentwise at most the reservation.
      for (const field of AGENT_RUN_VECTOR_FIELDS) {
        if (actual[field] > attempt.reservedVector[field]) {
          fail("budget_invariant_violated");
        }
      }
      if (
        !vectorsEqual(used, actual) ||
        !vectorsEqual(released, subtractVectors(attempt.reservedVector, actual))
      ) {
        fail("budget_invariant_violated");
      }
      bodyUuid(body, "result_id");
      settleAttempt(
        attempt,
        attemptState,
        used,
        released,
        actual,
        bodyDigestHex(body, "result_sha256"),
        null,
      );
      return;
    }
    case "attempt_indeterminate": {
      const reason = asIndeterminateReason(bodyString(body, "reason_code"));
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      const used = bodyVector(body, "used_vector");
      const released = bodyVector(body, "released_vector");
      const fencedEpoch = bodyTagged(body, "fenced_lease_epoch");
      if (
        !vectorsEqual(used, indeterminateUsed(attempt.reservedVector)) ||
        !vectorsEqual(released, indeterminateReleased(attempt.reservedVector))
      ) {
        fail("budget_invariant_violated");
      }
      if (attempt.state !== "dispatch_started") fail("invalid_transition");
      if (reason === "takeover_after_dispatch") {
        const walk = openWalk(reduction, context);
        if (fencedEpoch !== walk.priorEpoch + 1n) fail("settlement_mismatch");
        settleAttempt(
          attempt,
          "indeterminate_quarantined",
          used,
          released,
          null,
          null,
          reason,
        );
        recordSettlement(walk, attempt, context, "charged", used, released);
        // The run state and lease epoch are preserved until the aggregate.
        return;
      }
      // The three reconcile-derived reasons terminalize the run in the same
      // event and fence the lease exactly once.
      if (reduction.walk !== null) fail("settlement_mismatch");
      if (fencedEpoch !== reduction.leaseEpoch + 1n) {
        fail("invalid_transition");
      }
      if (attempt.leaseEpoch !== reduction.leaseEpoch) {
        fail("invalid_transition");
      }
      settleAttempt(
        attempt,
        "indeterminate_quarantined",
        used,
        released,
        null,
        null,
        reason,
      );
      reduction.leaseEpoch = fencedEpoch;
      reduction.state = "failed";
      return;
    }
    case "attempt_released": {
      const mode = asReleaseMode(bodyString(body, "release_mode"));
      const released = bodyVector(body, "released_vector");
      bodyDigestHex(body, "release_proof_sha256");
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      if (!vectorsEqual(released, attempt.reservedVector)) {
        fail("budget_invariant_violated");
      }
      if (mode === "takeover") {
        const walk = openWalk(reduction, context);
        settleAttempt(
          attempt,
          "released_takeover",
          zeroVector(),
          released,
          null,
          null,
          null,
        );
        recordSettlement(
          walk,
          attempt,
          context,
          "released",
          zeroVector(),
          released,
        );
        return;
      }
      settleAttempt(
        attempt,
        "released_pre_dispatch",
        zeroVector(),
        released,
        null,
        null,
        null,
      );
      return;
    }
    case "attempt_cancelled_released": {
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      const operationId = bodyUuid(body, "cancel_operation_id");
      assertCancellationWalkEvent(reduction, context, attempt, operationId);
      const used = bodyVector(body, "used_vector");
      const released = bodyVector(body, "released_vector");
      if (
        !vectorsEqual(used, zeroVector()) ||
        !vectorsEqual(released, attempt.reservedVector)
      ) {
        fail("budget_invariant_violated");
      }
      settleAttempt(
        attempt,
        "cancelled_released",
        used,
        released,
        null,
        null,
        null,
      );
      return;
    }
    case "attempt_cancelled_charged": {
      const attempt = requireAttempt(reduction, bodyUuid(body, "attempt_id"));
      const operationId = bodyUuid(body, "cancel_operation_id");
      assertCancellationWalkEvent(reduction, context, attempt, operationId);
      const used = bodyVector(body, "used_vector");
      const released = bodyVector(body, "released_vector");
      if (
        !vectorsEqual(used, indeterminateUsed(attempt.reservedVector)) ||
        !vectorsEqual(released, indeterminateReleased(attempt.reservedVector))
      ) {
        fail("budget_invariant_violated");
      }
      settleAttempt(
        attempt,
        "cancelled_charged",
        used,
        released,
        null,
        null,
        null,
      );
      return;
    }
    case "checkpoint_written": {
      if (!insideCheckpointFence(reduction.state)) fail("invalid_transition");
      bodyTagged(body, "checkpoint_revision");
      bodyTagged(body, "source_event_sequence");
      bodyDigestHex(body, "source_event_sha256");
      bodyDigestHex(body, "state_sha256");
      bodyDigestHex(body, "checkpoint_sha256");
      return;
    }
    case "brief_committed": {
      bodyUuid(body, "brief_id");
      reduction.latestBriefSha256 = bodyDigestHex(body, "brief_sha256");
      return;
    }
    case "common_bundle_committed": {
      bodyUuid(body, "bundle_id");
      reduction.latestBundleSha256 = bodyDigestHex(body, "bundle_sha256");
      return;
    }
    case "calculation_graph_committed": {
      bodyUuid(body, "graph_id");
      bodyDigestHex(body, "graph_sha256");
      bodyDigestHex(body, "result_sha256");
      bodyDigestHex(body, "meter_sha256");
      reduction.calculationResultIds.push(bodyUuid(body, "result_id"));
      return;
    }
    case "candidate_committed": {
      const candidateId = bodyUuid(body, "candidate_id");
      bodyDigestHex(body, "candidate_spec_sha256");
      bodyUuid(body, "source_result_id");
      bodyDigestHex(body, "source_result_sha256");
      bodyDigestHex(body, "precommit_validation_sha256");
      bodyDigestHex(body, "bundle_sha256");
      bodyTagged(body, "material_claim_count");
      bodyDigestHex(body, "material_claim_set_sha256");
      reduction.candidateIds.push(candidateId);
      return;
    }
    case "candidate_validation_findings_committed": {
      const candidateId = bodyUuid(body, "candidate_id");
      bodyDigestHex(body, "findings_sha256");
      bodyTagged(body, "finding_count");
      reduction.validationStates.set(
        candidateId,
        asValidationState(bodyString(body, "validation_state")),
      );
      return;
    }
    case "candidate_claims_committed": {
      if (reduction.state !== "validating") fail("invalid_transition");
      bodyUuid(body, "candidate_id");
      bodyDigestHex(body, "claims_sha256");
      bodyTagged(body, "claim_count");
      bodyTagged(body, "edge_count");
      return;
    }
    case "candidate_manifest_committed": {
      if (reduction.state !== "validating") fail("invalid_transition");
      bodyUuid(body, "candidate_id");
      bodyDigestHex(body, "manifest_sha256");
      bodyDigestHex(body, "reviewer_result_sha256");
      return;
    }
    case "candidate_set_closed": {
      if (reduction.state !== "generating" && reduction.state !== "revising") {
        fail("invalid_transition");
      }
      bodyUuidArray(body, "candidate_ids");
      reduction.state = "validating";
      reduction.candidateSetSha256 = bodyDigestHex(
        body,
        "candidate_set_sha256",
      );
      return;
    }
    case "replay_result_consumed": {
      if (reduction.purpose !== "replay" || reduction.state !== "planning") {
        fail("invalid_transition");
      }
      if (bodyUuid(body, "source_run_id") !== reduction.replaySourceRunId) {
        fail("request_binding_mismatch");
      }
      bodyUuid(body, "replay_result_id");
      const sequenceValue = bodyTagged(body, "source_result_sequence");
      const expectedSequence =
        reduction.consumedReplaySequence === null
          ? 1n
          : reduction.consumedReplaySequence + 1n;
      if (sequenceValue !== expectedSequence) {
        fail("invalid_transition");
      }
      if (reduction.replaySourceResultCount === null) {
        fail("request_binding_mismatch");
      }
      if (sequenceValue > reduction.replaySourceResultCount) {
        fail("invalid_transition");
      }
      reduction.consumedReplaySequence = sequenceValue;
      reduction.consumedReplaySha256 = bodyDigestHex(
        body,
        "source_result_sha256",
      );
      if (sequenceValue === reduction.replaySourceResultCount) {
        reduction.state = "generating";
      }
      return;
    }
    case "run_abstained": {
      reduction.state = "rejected";
      reduction.terminalOperationKind = "abstention";
      reduction.terminalOperationId = bodyUuid(body, "terminal_operation_id");
      bodyUuid(body, "abstention_id");
      bodyDigestHex(body, "abstention_sha256");
      return;
    }
    case "run_ranked": {
      reduction.state = "approval_required";
      reduction.terminalOperationKind = "ranking";
      reduction.terminalOperationId = bodyUuid(body, "terminal_operation_id");
      reduction.selectedCandidateId = bodyUuid(body, "selected_candidate_id");
      const ordered = bodyUuidArray(body, "ordered_candidate_ids");
      const ranks = body.ordered_ranks;
      if (!arrayIsArray(ranks) || ranks.length !== ordered.length) {
        fail("payload_corrupt");
      }
      for (const rank of ranks) parseUnsignedTagged(rank);
      let selected = false;
      for (const candidateId of ordered) {
        if (candidateId === reduction.selectedCandidateId) selected = true;
      }
      if (!selected) fail("payload_corrupt");
      bodyDigestHex(body, "ranking_sha256");
      return;
    }
    case "run_finished": {
      const outcome = bodyString(body, "terminal_outcome");
      if (
        outcome !== "rejected" &&
        outcome !== "cancelled" &&
        outcome !== "expired" &&
        outcome !== "failed"
      ) {
        fail("payload_corrupt");
      }
      reduction.state = outcome;
      reduction.terminalOperationKind = "finish";
      reduction.terminalOperationId = bodyUuid(body, "terminal_operation_id");
      bodyDigestHex(body, "reason_sha256");
      return;
    }
    case "run_cancelled": {
      if (context.actorKind !== "tenant") fail("payload_corrupt");
      const cancelOperationId = bodyUuid(body, "cancel_operation_id");
      // `dasher_api.cancel_agent_run` spends the caller-retained operation UUID
      // as the event id and as the immutable audit-header id.
      if (cancelOperationId !== context.eventId) fail("payload_corrupt");
      if (
        reduction.pendingCancelOperationId !== null &&
        (reduction.pendingCancelOperationId !== cancelOperationId ||
          reduction.pendingCancelActorKind !== "tenant")
      ) {
        fail("settlement_mismatch");
      }
      const operationSha256Hex = bodyDigestHex(body, "cancel_operation_sha256");
      const fencedEpoch = bodyTagged(body, "fenced_lease_epoch");
      if (fencedEpoch !== reduction.leaseEpoch + 1n) fail("invalid_transition");
      bodyDigestHex(body, "reason_sha256");
      assertCancellationSettlement(reduction, body);
      reduction.state = "cancelled";
      reduction.leaseEpoch = fencedEpoch;
      reduction.tenantCancelOperationId = cancelOperationId;
      reduction.tenantCancelOperationSha256 = operationSha256Hex;
      reduction.tenantCancelResultRunRevision = reduction.runRevision;
      reduction.tenantCancelResultEventSequence = BigInt(sequence);
      reduction.tenantCancelResultEventSha256 = toHex(context.eventSha256);
      reduction.tenantCancelResultSha256 = toHex(
        tenantCancelResultSha256({
          operationSha256: hexToBytes(operationSha256Hex),
          organizationId: reduction.organizationId,
          dashboardId: reduction.dashboardId,
          runId: reduction.runId,
          runRevision: reduction.runRevision,
          eventSequence: BigInt(sequence),
          eventSha256: context.eventSha256,
        }),
      );
      reduction.pendingCancelOperationId = null;
      reduction.pendingCancelActorKind = null;
      reduction.pendingCancelLastAttemptId = null;
      return;
    }
    case "run_cleanup_cancelled": {
      if (context.actorKind !== "retention") fail("payload_corrupt");
      const fencedEpoch = bodyTagged(body, "fenced_lease_epoch");
      if (fencedEpoch !== reduction.leaseEpoch + 1n) fail("invalid_transition");
      const cancelOperationId = bodyUuid(body, "cancel_operation_id");
      if (
        reduction.pendingCancelOperationId !== null &&
        (reduction.pendingCancelOperationId !== cancelOperationId ||
          reduction.pendingCancelActorKind !== "retention")
      ) {
        fail("settlement_mismatch");
      }
      bodyDigestHex(body, "reason_sha256");
      assertCancellationSettlement(reduction, body);
      reduction.state = "cancelled";
      reduction.leaseEpoch = fencedEpoch;
      reduction.pendingCancelOperationId = null;
      reduction.pendingCancelActorKind = null;
      reduction.pendingCancelLastAttemptId = null;
      return;
    }
  }
}

/**
 * Both cancellation headers publish the released/charged attempt-id
 * subsequences and the run-wide used/released totals. They are recomputed from
 * the attempt projection rather than trusted.
 */
function assertCancellationSettlement(
  reduction: ReductionState,
  body: Body,
): void {
  const released: string[] = [];
  const charged: string[] = [];
  const ordered = [...reduction.attemptOrder].sort(compareUuidBytes);
  let usedTotal = zeroVector();
  let releasedTotal = zeroVector();
  for (const attemptId of ordered) {
    const attempt = reduction.attempts.get(attemptId)!;
    if (attempt.state === "cancelled_released") released.push(attemptId);
    if (attempt.state === "cancelled_charged") charged.push(attemptId);
    if (!isTerminalAttemptState(attempt.state)) fail("invalid_transition");
    usedTotal = addVectorPair(usedTotal, attempt.usedVector);
    releasedTotal = addVectorPair(releasedTotal, attempt.releasedVector);
  }
  if (
    !sameUuidList(bodyUuidArray(body, "released_attempt_ids"), released) ||
    !sameUuidList(bodyUuidArray(body, "charged_attempt_ids"), charged)
  ) {
    fail("settlement_mismatch");
  }
  if (
    !vectorsEqual(bodyVector(body, "used_vector"), usedTotal) ||
    !vectorsEqual(bodyVector(body, "released_vector"), releasedTotal)
  ) {
    fail("settlement_mismatch");
  }
}

function assertCancellationWalkEvent(
  reduction: ReductionState,
  context: TransitionContext,
  attempt: AttemptRecord,
  operationId: string,
): void {
  if (context.actorKind !== "tenant" && context.actorKind !== "retention") {
    fail("payload_corrupt");
  }
  if (attempt.leaseEpoch !== reduction.leaseEpoch) fail("settlement_mismatch");
  if (reduction.pendingCancelOperationId === null) {
    reduction.pendingCancelOperationId = operationId;
    reduction.pendingCancelActorKind = context.actorKind;
  } else if (
    reduction.pendingCancelOperationId !== operationId ||
    reduction.pendingCancelActorKind !== context.actorKind
  ) {
    fail("settlement_mismatch");
  }
  if (
    reduction.pendingCancelLastAttemptId !== null &&
    compareUuidBytes(reduction.pendingCancelLastAttemptId, attempt.attemptId) >=
      0
  ) {
    fail("settlement_mismatch");
  }
  reduction.pendingCancelLastAttemptId = attempt.attemptId;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export function reduceAgentRun(input: AgentRunReducerInput): AgentRunReduction {
  const snapshot = strictSnapshot(input, reducerInputKeys, "invalid_input");
  const runId = canonicalUuid(snapshot.runId, "invalid_input");
  const organizationId = canonicalUuid(
    snapshot.organizationId,
    "invalid_input",
  );
  const dashboardId = canonicalUuid(snapshot.dashboardId, "invalid_input");
  const requestCandidate = snapshot.canonicalRequestBytes;
  const canonicalRequestBytes =
    requestCandidate === null
      ? null
      : snapshotBytes(requestCandidate, 1, maximumCanonicalRequestBytes);
  const rawEvents = snapshotArray(snapshot.events);
  if (rawEvents.length === 0 || rawEvents.length > maximumLedgerEvents) {
    fail("invalid_input");
  }

  const bySequence = new Map<number, NormalisedEvent>();
  let retainedCount = 0;
  let purgedCount = 0;
  for (const raw of rawEvents) {
    const event = normaliseEvent(raw);
    const existing = bySequence.get(event.eventSequence);
    if (existing !== undefined) {
      if (!sameEvent(existing, event)) fail("duplicate_conflict");
      continue;
    }
    bySequence.set(event.eventSequence, event);
    if (event.canonicalPayloadBytes === null) purgedCount += 1;
    else retainedCount += 1;
  }
  const eventCount = bySequence.size;
  const ordered: NormalisedEvent[] = [];
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const event = bySequence.get(sequence);
    if (event === undefined) fail("chain_broken");
    ordered.push(event);
  }

  let priorSha: Uint8Array | null = null;
  for (const event of ordered) {
    const expectedPriorSequence =
      event.eventSequence === 1 ? null : event.eventSequence - 1;
    if (event.priorEventSequence !== expectedPriorSequence)
      fail("chain_broken");
    if (priorSha === null) {
      if (event.priorEventSha256 !== null) fail("chain_broken");
    } else if (
      event.priorEventSha256 === null ||
      !bytesEqual(event.priorEventSha256, priorSha)
    ) {
      fail("chain_broken");
    }
    priorSha = event.eventSha256;
  }

  if (purgedCount > 0) {
    if (retainedCount > 0 || canonicalRequestBytes !== null) {
      fail("payload_retention_mixed");
    }
    const head = ordered[ordered.length - 1]!;
    return objectFreeze({
      mode: "cleaned",
      runId,
      eventCount,
      firstEventSha256: copyBytes(ordered[0]!.eventSha256),
      headEventSequence: head.eventSequence,
      headEventSha256: copyBytes(head.eventSha256),
      chainAdjacent: true,
      deletedPayloadCount: purgedCount,
    });
  }

  if (canonicalRequestBytes === null) fail("payload_retention_mixed");
  const request = parseCanonicalJson(canonicalRequestBytes);
  if (
    request === null ||
    typeof request !== "object" ||
    arrayIsArray(request)
  ) {
    fail("payload_corrupt");
  }
  const requestBody = request as Body;
  assertExactKeys(requestBody, canonicalRequestKeys);
  const replaySourceResultCount =
    requestBody.purpose === "replay" &&
    requestBody.replay_source_result_count !== null
      ? parseUnsignedTagged(requestBody.replay_source_result_count)
      : null;
  const replaySourceHeadSha256 =
    requestBody.purpose === "replay"
      ? bodyDigestHex(requestBody, "replay_source_head_sha256")
      : null;
  const replaySourceCandidateSetSha256 =
    requestBody.purpose === "replay"
      ? bodyDigestHex(requestBody, "replay_source_candidate_set_sha256")
      : null;
  const replaySourceBundleId =
    requestBody.purpose === "replay"
      ? bodyUuid(requestBody, "replay_source_bundle_id")
      : null;
  const replaySourceBundleSha256 =
    requestBody.purpose === "replay"
      ? bodyDigestHex(requestBody, "replay_source_bundle_sha256")
      : null;
  const replaySourceBriefId =
    requestBody.purpose === "replay"
      ? bodyUuid(requestBody, "replay_source_brief_id")
      : null;
  const replaySourceBriefSha256 =
    requestBody.purpose === "replay"
      ? bodyDigestHex(requestBody, "replay_source_brief_sha256")
      : null;

  const reduction: ReductionState = {
    state: "requested",
    runRevision: 0n,
    leaseEpoch: 0n,
    runRequestId: null,
    requestIdempotencySha256: null,
    requestSha256: null,
    policyRevision: null,
    purpose: null,
    replaySourceRunId: null,
    replaySourceResultCount,
    replaySourceHeadSha256,
    replaySourceCandidateSetSha256,
    replaySourceBundleId,
    replaySourceBundleSha256,
    replaySourceBriefId,
    replaySourceBriefSha256,
    latestBriefSha256: null,
    latestBundleSha256: null,
    candidateSetSha256: null,
    consumedReplaySequence: null,
    consumedReplaySha256: null,
    selectedCandidateId: null,
    terminalOperationKind: null,
    terminalOperationId: null,
    terminalClaimInputSha256: null,
    terminalOperationSha256: null,
    tenantCancelOperationId: null,
    tenantCancelOperationSha256: null,
    tenantCancelResultSha256: null,
    tenantCancelResultRunRevision: null,
    tenantCancelResultEventSequence: null,
    tenantCancelResultEventSha256: null,
    walk: null,
    pendingCancelOperationId: null,
    pendingCancelActorKind: null,
    pendingCancelLastAttemptId: null,
    organizationId,
    dashboardId,
    runId,
    attempts: new Map(),
    attemptOrder: [],
    candidateIds: [],
    calculationResultIds: [],
    validationStates: new Map(),
  };

  for (const event of ordered) {
    const payloadBytes = event.canonicalPayloadBytes!;
    const semantic = agentRunEventSemanticSha256(payloadBytes);
    const envelope = agentRunRetainedEnvelopeSha256(
      eventPayloadSchema,
      event.contentNonce!,
      semantic,
    );
    if (!bytesEqual(envelope, event.payloadSha256!)) fail("payload_corrupt");

    const payload = parseCanonicalJson(payloadBytes);
    if (
      payload === null ||
      typeof payload !== "object" ||
      arrayIsArray(payload) ||
      ownKeys(payload).length !== 11
    ) {
      fail("payload_corrupt");
    }
    const envelopeBody = payload as Body;
    reduction.runRevision += 1n;
    if (
      envelopeBody.schema !== eventPayloadSchema ||
      envelopeBody.event_id !== event.eventId ||
      envelopeBody.event_kind !== event.eventKind ||
      envelopeBody.event_sequence !== `i64:${String(event.eventSequence)}` ||
      envelopeBody.run_id !== runId ||
      envelopeBody.run_revision !== `i64:${String(reduction.runRevision)}`
    ) {
      fail("payload_corrupt");
    }
    if (typeof envelopeBody.actor_id !== "string") fail("payload_corrupt");
    const actorKind = envelopeBody.actor_kind;
    if (
      actorKind !== "tenant" &&
      actorKind !== "run_operator" &&
      actorKind !== "retention"
    ) {
      fail("payload_corrupt");
    }
    parseTagged(envelopeBody.actor_revision);
    const occurredAtMicros = parseOccurredAtMicros(
      envelopeBody.occurred_at,
      event.occurredAtMicros,
    );

    const computed = agentRunEventSha256({
      runId,
      eventSequence: event.eventSequence,
      eventKind: event.eventKind,
      occurredAtMicros,
      priorEventSequence: event.priorEventSequence,
      priorEventSha256: event.priorEventSha256,
      payloadSha256: envelope,
    });
    if (!bytesEqual(computed, event.eventSha256)) fail("payload_corrupt");

    const body = envelopeBody.body;
    if (
      body === null ||
      typeof body !== "object" ||
      arrayIsArray(body) ||
      objectGetPrototypeOf(body) !== objectPrototype
    ) {
      fail("payload_corrupt");
    }
    assertExactKeys(body as Body, bodyKeys[event.eventKind]);

    if (event.eventSequence === 1 && event.eventKind !== "run_requested") {
      fail("invalid_transition");
    }
    applyTransition(reduction, {
      kind: event.eventKind,
      body: body as Body,
      eventId: event.eventId,
      sequence: event.eventSequence,
      eventSha256: event.eventSha256,
      priorEventSequence: event.priorEventSequence,
      priorEventSha256: event.priorEventSha256,
      occurredAtMicros,
      actorKind,
    });
  }

  // An unterminated settlement walk is never a reconstructable run state.
  if (reduction.walk !== null) fail("settlement_mismatch");
  if (reduction.pendingCancelOperationId !== null) fail("settlement_mismatch");

  if (
    reduction.runRequestId === null ||
    reduction.requestIdempotencySha256 === null ||
    reduction.requestSha256 === null ||
    reduction.policyRevision === null ||
    reduction.purpose === null
  ) {
    fail("invalid_transition");
  }
  if (
    requestBody.schema !== "agent-run-request-v1" ||
    requestBody.run_request_id !== reduction.runRequestId ||
    requestBody.request_idempotency_sha256 !==
      reduction.requestIdempotencySha256 ||
    requestBody.dashboard_id !== dashboardId ||
    requestBody.policy_revision !== `i64:${String(reduction.policyRevision)}` ||
    requestBody.purpose !== reduction.purpose ||
    requestBody.replay_source_run_id !== reduction.replaySourceRunId
  ) {
    fail("request_binding_mismatch");
  }
  canonicalUuid(requestBody.input_snapshot_id, "request_binding_mismatch");
  bodyDigestHex(requestBody, "input_sha256");
  const replayRequestFields = [
    "replay_source_result_count",
    "replay_source_head_sha256",
    "replay_source_candidate_set_sha256",
    "replay_source_bundle_id",
    "replay_source_bundle_sha256",
    "replay_source_brief_id",
    "replay_source_brief_sha256",
    "replay_source_selected_candidate_id",
  ] as const;
  if (reduction.purpose === "suggest") {
    for (const key of replayRequestFields) {
      if (requestBody[key] !== null) fail("request_binding_mismatch");
    }
  } else {
    for (const key of replayRequestFields) {
      if (requestBody[key] === null) fail("request_binding_mismatch");
    }
    parseUnsignedTagged(requestBody.replay_source_result_count);
    bodyDigestHex(requestBody, "replay_source_head_sha256");
    bodyDigestHex(requestBody, "replay_source_candidate_set_sha256");
    bodyUuid(requestBody, "replay_source_bundle_id");
    bodyDigestHex(requestBody, "replay_source_bundle_sha256");
    bodyUuid(requestBody, "replay_source_brief_id");
    bodyDigestHex(requestBody, "replay_source_brief_sha256");
    bodyUuid(requestBody, "replay_source_selected_candidate_id");
  }
  const limits = objectFreeze({
    generation: bodyVector(requestBody, "generation_limit_vector"),
    review: bodyVector(requestBody, "review_limit_vector"),
  });

  const attempts: AgentRunAttemptProjection[] = [...reduction.attemptOrder]
    .sort(compareUuidBytes)
    .map((attemptId) => {
      const attempt = reduction.attempts.get(attemptId)!;
      const outstanding = subtractVectors(
        subtractVectors(attempt.reservedVector, attempt.usedVector),
        attempt.releasedVector,
      );
      for (const field of AGENT_RUN_VECTOR_FIELDS) {
        // Every attempt component is signed-64 and nonnegative, and a terminal
        // attempt has exhausted its reservation.
        if (
          attempt.reservedVector[field] < 0n ||
          attempt.usedVector[field] < 0n ||
          attempt.releasedVector[field] < 0n ||
          outstanding[field] < 0n ||
          attempt.reservedVector[field] > signedMaximum ||
          (attempt.actualVector !== null &&
            (attempt.actualVector[field] < 0n ||
              attempt.actualVector[field] > signedMaximum))
        ) {
          fail("budget_invariant_violated");
        }
        if (
          isTerminalAttemptState(attempt.state) &&
          outstanding[field] !== 0n
        ) {
          fail("budget_invariant_violated");
        }
      }
      return objectFreeze({
        attemptId: attempt.attemptId,
        attemptKind: attempt.attemptKind,
        partition: attempt.partition,
        state: attempt.state,
        leaseEpoch: attempt.leaseEpoch,
        candidateSlot: attempt.candidateSlot,
        retryOfAttemptId: attempt.retryOfAttemptId,
        reservedVector: attempt.reservedVector,
        actualVector: attempt.actualVector,
        usedVector: attempt.usedVector,
        releasedVector: attempt.releasedVector,
        outstandingVector: outstanding,
        requestSha256: attempt.requestSha256,
        resultSha256: attempt.resultSha256,
        indeterminateReason: attempt.indeterminateReason,
      });
    });

  const reservedTotals = newCounterMap();
  const usedTotals = newCounterMap();
  const releasedTotals = newCounterMap();
  for (const attempt of attempts) {
    addVector(reservedTotals, attempt.partition, attempt.reservedVector);
    addVector(usedTotals, attempt.partition, attempt.usedVector);
    addVector(releasedTotals, attempt.partition, attempt.releasedVector);
  }

  const budgetCounters: AgentRunBudgetCounter[] = [];
  for (const partition of AGENT_RUN_BUDGET_PARTITIONS) {
    for (const field of AGENT_RUN_VECTOR_FIELDS) {
      const reserved = reservedTotals[partition][field];
      const used = usedTotals[partition][field];
      const released = releasedTotals[partition][field];
      const outstanding = reserved - used - released;
      const limit = limits[partition][field];
      // `reserved = used + released + outstanding`, every term nonnegative and
      // signed-64, and the frozen admission rule `used + outstanding <= limit`.
      if (
        reserved < 0n ||
        used < 0n ||
        released < 0n ||
        outstanding < 0n ||
        reserved > signedMaximum ||
        used + outstanding > limit
      ) {
        fail("budget_invariant_violated");
      }
      budgetCounters.push(
        objectFreeze({
          partition,
          vectorField: field,
          limitUnits: limit,
          reservedUnits: reserved,
          usedUnits: used,
          releasedUnits: released,
          outstandingUnits: outstanding,
        }),
      );
    }
  }

  const candidateIds = [...reduction.candidateIds].sort();
  const validationStates = candidateIds.map(
    (candidateId) => reduction.validationStates.get(candidateId) ?? "pending",
  );
  const calculationResultIds = [...reduction.calculationResultIds].sort();
  const head = ordered[ordered.length - 1]!;

  const projection: AgentRunProjection = objectFreeze({
    runId,
    runRequestId: reduction.runRequestId,
    requestIdempotencySha256: reduction.requestIdempotencySha256,
    requestSha256: reduction.requestSha256,
    policyRevision: reduction.policyRevision,
    purpose: reduction.purpose,
    replaySourceRunId: reduction.replaySourceRunId,
    runRevision: reduction.runRevision,
    state: reduction.state,
    leaseEpoch: reduction.leaseEpoch,
    sourceEventSequence: BigInt(head.eventSequence),
    sourceEventSha256: copyBytes(head.eventSha256),
    budgetCounters: objectFreeze(budgetCounters),
    attempts: objectFreeze(attempts),
    latestBriefSha256: reduction.latestBriefSha256,
    latestBundleSha256: reduction.latestBundleSha256,
    calculationResultIds: objectFreeze(calculationResultIds),
    candidateIds: objectFreeze(candidateIds),
    candidateSetSha256: reduction.candidateSetSha256,
    validationStates: objectFreeze(validationStates),
    consumedReplaySequence: reduction.consumedReplaySequence,
    consumedReplaySha256: reduction.consumedReplaySha256,
    terminalOperationKind: reduction.terminalOperationKind,
    terminalOperationId: reduction.terminalOperationId,
    terminalClaimInputSha256: reduction.terminalClaimInputSha256,
    terminalOperationSha256: reduction.terminalOperationSha256,
    tenantCancelOperationId: reduction.tenantCancelOperationId,
    tenantCancelOperationSha256: reduction.tenantCancelOperationSha256,
    tenantCancelResultSha256: reduction.tenantCancelResultSha256,
    tenantCancelResultRunRevision: reduction.tenantCancelResultRunRevision,
    tenantCancelResultEventSequence: reduction.tenantCancelResultEventSequence,
    tenantCancelResultEventSha256: reduction.tenantCancelResultEventSha256,
    selectedCandidateId: reduction.selectedCandidateId,
  });

  const checkpointable =
    insideCheckpointFence(projection.state) &&
    projection.terminalOperationKind === null &&
    projection.tenantCancelOperationId === null &&
    projection.selectedCandidateId === null;

  if (!checkpointable) {
    return objectFreeze({
      mode: "retained",
      projection,
      checkpointable: false,
      canonicalCheckpointBytes: null,
      stateSha256: null,
    });
  }

  const canonicalCheckpointBytes = canonicalJsonBytes(
    buildCheckpointValue(projection),
  );
  return objectFreeze({
    mode: "retained",
    projection,
    checkpointable: true,
    canonicalCheckpointBytes,
    stateSha256: agentRunCheckpointStateSha256(canonicalCheckpointBytes),
  });
}

type CounterMap = Readonly<
  Record<AgentRunBudgetPartition, Record<AgentRunVectorField, bigint>>
>;

function newCounterMap(): CounterMap {
  const built = {} as Record<
    AgentRunBudgetPartition,
    Record<AgentRunVectorField, bigint>
  >;
  for (const partition of AGENT_RUN_BUDGET_PARTITIONS) {
    const fields = objectCreate(null) as Record<AgentRunVectorField, bigint>;
    for (const field of AGENT_RUN_VECTOR_FIELDS) fields[field] = 0n;
    built[partition] = fields;
  }
  return built;
}

function addVector(
  totals: CounterMap,
  partition: AgentRunBudgetPartition,
  vector: AttemptResourceVector,
): void {
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    totals[partition][field] += vector[field];
  }
}

function assertExactKeys(body: Body, expected: readonly string[]): void {
  const keys = ownKeys(body);
  if (keys.length !== expected.length) fail("payload_corrupt");
  for (const key of expected) {
    if (objectGetOwnPropertyDescriptor(body, key) === undefined) {
      fail("payload_corrupt");
    }
  }
}

function buildCheckpointValue(projection: AgentRunProjection): CanonicalValue {
  const counters: CanonicalValue[] = projection.budgetCounters.map((counter) =>
    objectFreeze({
      partition: counter.partition,
      vector_field: counter.vectorField,
      limit_units: `i64:${String(counter.limitUnits)}`,
      reserved_units: `i64:${String(counter.reservedUnits)}`,
      used_units: `i64:${String(counter.usedUnits)}`,
      released_units: `i64:${String(counter.releasedUnits)}`,
      outstanding_units: `i64:${String(counter.outstandingUnits)}`,
    }),
  );
  const attempts: CanonicalValue[] = projection.attempts.map((attempt) =>
    objectFreeze({
      attempt_id: attempt.attemptId,
      attempt_kind: attempt.attemptKind,
      state: attempt.state,
      lease_epoch: `i64:${String(attempt.leaseEpoch)}`,
      candidate_slot:
        attempt.candidateSlot === null
          ? null
          : `i64:${String(attempt.candidateSlot)}`,
      retry_of_attempt_id: attempt.retryOfAttemptId,
      reserved_vector: vectorToCanonical(attempt.reservedVector),
      actual_vector:
        attempt.actualVector === null
          ? null
          : vectorToCanonical(attempt.actualVector),
      used_vector: vectorToCanonical(attempt.usedVector),
      released_vector: vectorToCanonical(attempt.releasedVector),
      outstanding_vector: vectorToCanonical(attempt.outstandingVector),
      request_sha256: attempt.requestSha256,
      result_sha256: attempt.resultSha256,
    }),
  );
  return objectFreeze({
    schema: checkpointSchema,
    run_id: projection.runId,
    run_request_id: projection.runRequestId,
    request_idempotency_sha256: projection.requestIdempotencySha256,
    request_sha256: projection.requestSha256,
    policy_revision: `i64:${String(projection.policyRevision)}`,
    run_revision: `i64:${String(projection.runRevision)}`,
    state: projection.state,
    lease_epoch: `i64:${String(projection.leaseEpoch)}`,
    source_event_sequence: `i64:${String(projection.sourceEventSequence)}`,
    source_event_sha256: toHex(projection.sourceEventSha256),
    budget_counters: counters,
    attempts,
    latest_brief_sha256: projection.latestBriefSha256,
    latest_bundle_sha256: projection.latestBundleSha256,
    calculation_result_ids: projection.calculationResultIds,
    candidate_ids: projection.candidateIds,
    candidate_set_sha256: projection.candidateSetSha256,
    validation_states: projection.validationStates,
    consumed_replay_sequence:
      projection.consumedReplaySequence === null
        ? null
        : `i64:${String(projection.consumedReplaySequence)}`,
    consumed_replay_sha256: projection.consumedReplaySha256,
    terminal_operation_kind: null,
    terminal_operation_id: null,
    terminal_claim_input_sha256: null,
    terminal_operation_sha256: null,
    tenant_cancel_operation_id: null,
    tenant_cancel_operation_sha256: null,
    tenant_cancel_result_sha256: null,
    tenant_cancel_result_run_revision: null,
    tenant_cancel_result_event_sequence: null,
    tenant_cancel_result_event_sha256: null,
    selected_candidate_id: null,
  });
}
