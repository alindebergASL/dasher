import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentRunReducerError,
  agentRunCheckpointStateSha256,
  agentRunEventSha256,
  agentRunEventSemanticSha256,
  agentRunRetainedEnvelopeSha256,
  reduceAgentRun,
} from "./agent-run-reducer.js";
import {
  AGENT_RUN_VECTOR_FIELDS,
  type AgentRunEventKind,
  type AgentRunLedgerEvent,
  type AgentRunVectorField,
} from "./agent-run-types.js";

const encoder = new TextEncoder();

const ids = {
  organization: "40000000-0000-4000-8000-0000000000a0",
  dashboard: "40000000-0000-4000-8000-0000000000d0",
  run: "40000000-0000-4000-8000-000000000001",
  runRequest: "40000000-0000-4000-8000-000000000002",
  requestPayload: "40000000-0000-4000-8000-000000000003",
  attemptA: "40000000-0000-4000-8000-00000000000a",
  attemptB: "40000000-0000-4000-8000-00000000000b",
  candidateA: "40000000-0000-4000-8000-0000000000c1",
  candidateB: "40000000-0000-4000-8000-0000000000c2",
  briefA: "40000000-0000-4000-8000-0000000000d1",
  bundleA: "40000000-0000-4000-8000-0000000000d2",
  graphA: "40000000-0000-4000-8000-0000000000e1",
  resultA: "40000000-0000-4000-8000-0000000000e2",
  principal: "40000000-0000-4000-8000-0000000000f1",
  claimRequest: "40000000-0000-4000-8000-0000000000f2",
  terminalOperation: "40000000-0000-4000-8000-0000000000f3",
  cancelOperation: "40000000-0000-4000-8000-0000000000f4",
  sourceRun: "40000000-0000-4000-8000-0000000000f5",
  replayResult: "40000000-0000-4000-8000-0000000000f6",
} as const;

/* ---------------------------------------------------------------- */
/* Independent canonicalisation, transcribed from                     */
/* dasher_private.canonical_jsonb_bytes_v1.                           */
/* ---------------------------------------------------------------- */

type CanonicalJson =
  | string
  | boolean
  | null
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalJsonText(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonText(entry)).join(",")}]`;
  }
  const record = value as { readonly [key: string]: CanonicalJson };
  const keys = Object.keys(record).sort(compareUtf8);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonText(record[key]!)}`)
    .join(",")}}`;
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalJsonBytes(value: CanonicalJson): Uint8Array {
  return encoder.encode(canonicalJsonText(value));
}

function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function int32be(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  new DataView(buffer.buffer).setInt32(0, value, false);
  return buffer;
}

function int64be(value: bigint): Uint8Array {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setBigInt64(0, value, false);
  return buffer;
}

function textBytes(value: string): readonly Uint8Array[] {
  const bytes = encoder.encode(value);
  return [int32be(bytes.length), bytes];
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function digestOf(seed: string): Uint8Array {
  return sha256(encoder.encode(seed));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function terminalClaimInputDigest(leaseSeconds: bigint): Uint8Array {
  return sha256(
    encoder.encode("dasher.agent-run-terminal-claim-input.v1"),
    new Uint8Array([0]),
    uuidBytes(ids.claimRequest),
    int64be(leaseSeconds),
    uuidBytes(ids.principal),
    int64be(1n),
    digestOf("principal"),
  );
}

function terminalClaimResultDigest(
  inputSha256: Uint8Array,
  runRevision: bigint,
  leaseEpoch: bigint,
): Uint8Array {
  return sha256(
    encoder.encode("dasher.agent-run-claim-result.v1"),
    new Uint8Array([0]),
    ...textBytes("indeterminate_takeover"),
    uuidBytes(ids.claimRequest),
    inputSha256,
    ...textBytes("terminalized_indeterminate"),
    uuidBytes(ids.organization),
    uuidBytes(ids.dashboard),
    uuidBytes(ids.run),
    int64be(runRevision),
    ...textBytes("failed"),
    int64be(leaseEpoch),
    new Uint8Array([0]),
    new Uint8Array([0]),
    int64be(1n),
    new Uint8Array([0]),
  );
}

function vectorBytes(value: Record<string, string>): Uint8Array {
  return shaJoin(
    AGENT_RUN_VECTOR_FIELDS.map((field) =>
      int64be(BigInt(value[field]!.slice(4))),
    ),
  );
}

function shaJoin(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function formatOccurredAt(value: Date): string {
  return `${value.toISOString().slice(0, -1)}000Z`;
}

function tagged(value: bigint | number): string {
  return `i64:${String(value)}`;
}

function vector(
  overrides: Partial<Record<AgentRunVectorField, number>> = {},
): Record<string, string> {
  const built: Record<string, string> = {};
  for (const field of AGENT_RUN_VECTOR_FIELDS) {
    built[field] = tagged(overrides[field] ?? 0);
  }
  return built;
}

const limitVector = vector({
  calls: 4,
  candidates: 2,
  specialist_attempts: 1,
  repair_attempts: 1,
  input_tokens: 20_000,
  output_tokens: 8_000,
  reasoning_tokens: 8_000,
  cache_read_tokens: 20_000,
  cache_write_tokens: 8_000,
  total_tokens: 24_000,
  wall_millis: 36_000,
  work_millis: 32_000,
  cost_micros: 120_000,
});

const reviewLimitVector = vector({
  calls: 1,
  reviewer_attempts: 1,
  input_tokens: 5_000,
  output_tokens: 2_000,
  reasoning_tokens: 2_000,
  cache_read_tokens: 5_000,
  cache_write_tokens: 2_000,
  total_tokens: 6_000,
  wall_millis: 9_000,
  work_millis: 8_000,
  cost_micros: 30_000,
});

const requestIdempotencySha256 = digestOf("idempotency");
const requestSha256 = digestOf("request");

function canonicalRequestBytes(
  overrides: Readonly<Record<string, CanonicalJson>> = {},
): Uint8Array {
  return canonicalJsonBytes({
    schema: "agent-run-request-v1",
    run_request_id: ids.runRequest,
    request_idempotency_sha256: hex(requestIdempotencySha256),
    dashboard_id: ids.dashboard,
    input_snapshot_id: ids.requestPayload,
    input_sha256: hex(digestOf("input")),
    input_table: {},
    policy_revision: tagged(1),
    purpose: "suggest",
    evaluation_time: "2026-08-04T12:00:00.000000Z",
    field_catalog: {},
    metric_contract_set: {},
    generation_limit_vector: limitVector,
    review_limit_vector: reviewLimitVector,
    orchestration_limits: {},
    adapter_id: "fake-provider-v1",
    model_id: "fake-model-v1",
    price_book_revision: "fake-price-book-v1",
    replay_source_run_id: null,
    replay_source_result_count: null,
    replay_source_head_sha256: null,
    replay_source_candidate_set_sha256: null,
    replay_source_bundle_id: null,
    replay_source_bundle_sha256: null,
    replay_source_brief_id: null,
    replay_source_brief_sha256: null,
    replay_source_selected_candidate_id: null,
    ...overrides,
  });
}

interface EventSpec {
  readonly kind: AgentRunEventKind;
  readonly body:
    | CanonicalJson
    | ((context: {
        readonly sequence: number;
        readonly occurredAtMicros: bigint;
        readonly priorEvents: readonly AgentRunLedgerEvent[];
      }) => CanonicalJson);
  readonly eventId?: string;
  readonly actorKind?: string;
  readonly actorId?: string;
  readonly actorRevision?: number;
}

const baseOccurredAt = Date.UTC(2026, 7, 4, 12, 0, 0, 0);

function buildLedger(
  specs: readonly EventSpec[],
  options: {
    readonly runId?: string;
    readonly corruptPayloadAt?: number;
    readonly runRevisionAt?: { readonly index: number; readonly value: number };
  } = {},
): readonly AgentRunLedgerEvent[] {
  const runId = options.runId ?? ids.run;
  const events: AgentRunLedgerEvent[] = [];
  let priorSha: Uint8Array | null = null;
  specs.forEach((spec, index) => {
    const sequence = index + 1;
    const runRevision =
      options.runRevisionAt?.index === index
        ? options.runRevisionAt.value
        : sequence;
    const occurredAt = new Date(baseOccurredAt + sequence * 1_000);
    const occurredAtMicros = BigInt(occurredAt.getTime()) * 1000n;
    const eventId =
      spec.eventId ??
      `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    const body =
      typeof spec.body === "function"
        ? spec.body({ sequence, occurredAtMicros, priorEvents: events })
        : spec.body;
    const payload = canonicalJsonBytes({
      actor_id: spec.actorId ?? ids.principal,
      actor_kind: spec.actorKind ?? "run_operator",
      actor_revision: tagged(spec.actorRevision ?? 1),
      body,
      event_id: eventId,
      event_kind: spec.kind,
      event_sequence: tagged(sequence),
      occurred_at: formatOccurredAt(occurredAt),
      run_id: runId,
      run_revision: tagged(runRevision),
      schema: "agent-run-event-payload-v1",
    });
    const nonce = sha256(encoder.encode(`nonce-${String(sequence)}`));
    const semantic = agentRunEventSemanticSha256(payload);
    const payloadSha256 = agentRunRetainedEnvelopeSha256(
      "agent-run-event-payload-v1",
      nonce,
      semantic,
    );
    const eventSha256 = agentRunEventSha256({
      runId,
      eventSequence: sequence,
      eventKind: spec.kind,
      occurredAtMicros,
      priorEventSequence: sequence === 1 ? null : sequence - 1,
      priorEventSha256: priorSha,
      payloadSha256,
    });
    events.push({
      eventSequence: sequence,
      eventId,
      eventKind: spec.kind,
      occurredAtMicros,
      priorEventSequence: sequence === 1 ? null : sequence - 1,
      priorEventSha256: priorSha,
      eventSha256,
      payloadSha256,
      contentNonce: nonce,
      canonicalPayloadBytes:
        options.corruptPayloadAt === index
          ? canonicalJsonBytes({ schema: "tampered" })
          : payload,
    });
    priorSha = eventSha256;
  });
  return events;
}

function runRequested(
  overrides: Readonly<Record<string, CanonicalJson>> = {},
): EventSpec {
  return {
    kind: "run_requested",
    actorKind: "tenant",
    body: {
      run_request_id: ids.runRequest,
      request_payload_id: ids.requestPayload,
      request_idempotency_sha256: hex(requestIdempotencySha256),
      request_sha256: hex(requestSha256),
      policy_revision: tagged(1),
      purpose: "suggest",
      replay_source_run_id: null,
      ...overrides,
    },
  };
}

function leaseAcquired(
  priorEpoch: number,
  newEpoch: number,
  mode = "normal",
): EventSpec {
  return {
    kind: "lease_acquired",
    body: {
      claim_request_id: ids.claimRequest,
      claim_input_sha256: hex(digestOf("claim-input")),
      claim_result_sha256: hex(digestOf("claim-result")),
      mode,
      prior_lease_epoch: tagged(priorEpoch),
      new_lease_epoch: tagged(newEpoch),
      lease_token_sha256: hex(digestOf("lease-token")),
      lease_expires_at: formatOccurredAt(new Date(baseOccurredAt + 60_000)),
      principal_id: ids.principal,
      principal_revision: tagged(1),
      principal_sha256: hex(digestOf("principal")),
    },
  };
}

function attemptReserved(
  attemptId: string,
  attemptKind: string,
  partition: string,
  reserved: Record<string, string>,
  candidateSlot: string | null = null,
): EventSpec {
  return {
    kind: "attempt_reserved",
    body: {
      attempt_id: attemptId,
      partition,
      attempt_kind: attemptKind,
      candidate_slot: candidateSlot,
      retry_of_attempt_id: null,
      request_payload_id: ids.requestPayload,
      request_sha256: hex(digestOf(`request-${attemptId}`)),
      reserved_vector: reserved,
    },
  };
}

function attemptDispatchPrepared(attemptId: string): EventSpec {
  return {
    kind: "attempt_dispatch_prepared",
    body: {
      attempt_id: attemptId,
      dispatch_request_sha256: hex(digestOf(`dispatch-${attemptId}`)),
    },
  };
}

function attemptDispatchStarted(attemptId: string): EventSpec {
  return {
    kind: "attempt_dispatch_started",
    body: {
      attempt_id: attemptId,
      dispatch_request_sha256: hex(digestOf(`dispatch-${attemptId}`)),
    },
  };
}

function attemptReconciled(
  attemptId: string,
  outcome: string,
  actual: Record<string, string>,
  used: Record<string, string>,
  released: Record<string, string>,
): EventSpec {
  return {
    kind: "attempt_reconciled",
    body: {
      attempt_id: attemptId,
      outcome,
      result_id: ids.resultA,
      result_sha256: hex(digestOf(`result-${attemptId}`)),
      actual_vector: actual,
      used_vector: used,
      released_vector: released,
    },
  };
}

function attemptIndeterminate(
  attemptId: string,
  reasonCode: string,
  reserved: Record<string, string>,
  fencedEpoch: number,
): EventSpec {
  const used = { ...reserved, candidates: tagged(0) };
  const released = vector();
  released.candidates = reserved.candidates!;
  return {
    kind: "attempt_indeterminate",
    body: {
      attempt_id: attemptId,
      reason_code: reasonCode,
      used_vector: used,
      released_vector: released,
      fenced_lease_epoch: tagged(fencedEpoch),
    },
  };
}

function checkpointWritten(
  revision: number,
  sourceSequence: number,
): EventSpec {
  return {
    kind: "checkpoint_written",
    body: {
      checkpoint_revision: tagged(revision),
      source_event_sequence: tagged(sourceSequence),
      source_event_sha256: hex(digestOf(`source-${String(sourceSequence)}`)),
      state_sha256: hex(digestOf("state")),
      checkpoint_sha256: hex(digestOf("checkpoint")),
    },
  };
}

function replayRequestBytes(resultCount = 3): Uint8Array {
  return canonicalRequestBytes({
    purpose: "replay",
    replay_source_run_id: ids.sourceRun,
    replay_source_result_count: tagged(resultCount),
    replay_source_head_sha256: hex(digestOf("head")),
    replay_source_candidate_set_sha256: hex(digestOf("set")),
    replay_source_bundle_id: ids.bundleA,
    replay_source_bundle_sha256: hex(digestOf("bundle")),
    replay_source_brief_id: ids.briefA,
    replay_source_brief_sha256: hex(digestOf("brief")),
    replay_source_selected_candidate_id: ids.candidateA,
  });
}

function replayPrerequisites(resultCount = 3): EventSpec {
  return {
    kind: "replay_prerequisites_cloned",
    body: {
      source_run_id: ids.sourceRun,
      bundle_id: ids.bundleA,
      bundle_sha256: hex(digestOf("bundle")),
      brief_id: ids.briefA,
      brief_sha256: hex(digestOf("brief")),
      candidate_set_sha256: hex(digestOf("set")),
      result_count: tagged(resultCount),
      result_head_sha256: hex(digestOf("head")),
    },
  };
}

function replayResult(sequence: number): EventSpec {
  return {
    kind: "replay_result_consumed",
    body: {
      source_run_id: ids.sourceRun,
      source_result_sequence: tagged(sequence),
      source_result_sha256: hex(digestOf(`source-result-${String(sequence)}`)),
      replay_result_id: ids.replayResult,
    },
  };
}

function replayPrefix(resultCount = 3): readonly EventSpec[] {
  return [
    runRequested({
      purpose: "replay",
      replay_source_run_id: ids.sourceRun,
    }),
    leaseAcquired(0, 1),
    replayPrerequisites(resultCount),
  ];
}

function candidateClaimsCommitted(): EventSpec {
  return {
    kind: "candidate_claims_committed",
    body: {
      candidate_id: ids.candidateA,
      claims_sha256: hex(digestOf("claims")),
      claim_count: tagged(1),
      edge_count: tagged(1),
    },
  };
}

function candidateManifestCommitted(): EventSpec {
  return {
    kind: "candidate_manifest_committed",
    body: {
      candidate_id: ids.candidateA,
      manifest_sha256: hex(digestOf("manifest")),
      reviewer_result_sha256: hex(digestOf("reviewer")),
    },
  };
}

const plannerReservation = vector({
  calls: 1,
  input_tokens: 100,
  output_tokens: 50,
  reasoning_tokens: 50,
  cache_read_tokens: 100,
  cache_write_tokens: 50,
  total_tokens: 150,
  wall_millis: 100,
  work_millis: 90,
  cost_micros: 400,
});

const generatorReservation = vector({
  calls: 1,
  candidates: 1,
  input_tokens: 200,
  total_tokens: 200,
  cost_micros: 500,
});

function plannerRun(): readonly EventSpec[] {
  return [
    runRequested(),
    leaseAcquired(0, 1),
    attemptReserved(ids.attemptA, "planner", "generation", plannerReservation),
    attemptDispatchPrepared(ids.attemptA),
    attemptDispatchStarted(ids.attemptA),
    attemptReconciled(
      ids.attemptA,
      "succeeded",
      plannerReservation,
      plannerReservation,
      vector(),
    ),
  ];
}

function reduce(
  specs: readonly EventSpec[],
  options: Parameters<typeof buildLedger>[1] = {},
): ReturnType<typeof reduceAgentRun> {
  return reduceAgentRun({
    runId: options.runId ?? ids.run,
    organizationId: ids.organization,
    dashboardId: ids.dashboard,
    canonicalRequestBytes: canonicalRequestBytes(),
    events: buildLedger(specs, options),
  });
}

function reduceWithRequest(
  specs: readonly EventSpec[],
  requestBytes: Uint8Array,
): ReturnType<typeof reduceAgentRun> {
  return reduceAgentRun({
    runId: ids.run,
    organizationId: ids.organization,
    dashboardId: ids.dashboard,
    canonicalRequestBytes: requestBytes,
    events: buildLedger(specs),
  });
}

function expectRetained(
  reduction: ReturnType<typeof reduceAgentRun>,
): Extract<ReturnType<typeof reduceAgentRun>, { mode: "retained" }> {
  if (reduction.mode !== "retained") throw new Error("expected retained mode");
  return reduction;
}

function reducerCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof AgentRunReducerError) return error.code;
    throw error;
  }
  throw new Error("expected AgentRunReducerError");
}

describe("agent run reducer: complete event reconstruction", () => {
  it("rebuilds the request binding, state, revision and lease epoch", () => {
    const { projection } = expectRetained(reduce(plannerRun()));
    expect(projection.runId).toBe(ids.run);
    expect(projection.runRequestId).toBe(ids.runRequest);
    expect(projection.requestIdempotencySha256).toBe(
      hex(requestIdempotencySha256),
    );
    expect(projection.requestSha256).toBe(hex(requestSha256));
    expect(projection.policyRevision).toBe(1n);
    expect(projection.purpose).toBe("suggest");
    expect(projection.runRevision).toBe(6n);
    expect(projection.state).toBe("planning");
    expect(projection.leaseEpoch).toBe(1n);
    expect(projection.sourceEventSequence).toBe(6n);
  });

  it("projects the exact per-attempt reservation and settlement vectors", () => {
    const { projection } = expectRetained(reduce(plannerRun()));
    expect(projection.attempts).toHaveLength(1);
    const attempt = projection.attempts[0]!;
    expect(attempt.attemptId).toBe(ids.attemptA);
    expect(attempt.attemptKind).toBe("planner");
    expect(attempt.partition).toBe("generation");
    expect(attempt.state).toBe("succeeded");
    expect(attempt.leaseEpoch).toBe(1n);
    expect(attempt.candidateSlot).toBeNull();
    expect(attempt.retryOfAttemptId).toBeNull();
    expect(attempt.reservedVector.calls).toBe(1n);
    expect(attempt.usedVector.total_tokens).toBe(150n);
    expect(attempt.releasedVector.total_tokens).toBe(0n);
    expect(attempt.outstandingVector.total_tokens).toBe(0n);
    expect(attempt.actualVector?.cost_micros).toBe(400n);
    expect(attempt.resultSha256).toBe(hex(digestOf(`result-${ids.attemptA}`)));
  });

  it("aggregates budget counters per partition and field", () => {
    const { projection } = expectRetained(reduce(plannerRun()));
    expect(projection.budgetCounters).toHaveLength(28);
    const generationCalls = projection.budgetCounters[0]!;
    expect(generationCalls.partition).toBe("generation");
    expect(generationCalls.vectorField).toBe("calls");
    expect(generationCalls.limitUnits).toBe(4n);
    expect(generationCalls.reservedUnits).toBe(1n);
    expect(generationCalls.usedUnits).toBe(1n);
    expect(generationCalls.releasedUnits).toBe(0n);
    expect(generationCalls.outstandingUnits).toBe(0n);
    const reviewCalls = projection.budgetCounters[14]!;
    expect(reviewCalls.partition).toBe("review");
    expect(reviewCalls.limitUnits).toBe(1n);
    expect(reviewCalls.reservedUnits).toBe(0n);
  });

  it("keeps attempts ordered by attempt id byte order", () => {
    const specs = [
      ...plannerRun(),
      attemptReserved(
        ids.attemptB,
        "generator",
        "generation",
        generatorReservation,
        tagged(1),
      ),
    ];
    const { projection } = expectRetained(reduce(specs));
    expect(projection.attempts.map((entry) => entry.attemptId)).toEqual([
      ids.attemptA,
      ids.attemptB,
    ]);
    expect(projection.attempts[1]!.candidateSlot).toBe(1n);
    expect(projection.attempts[1]!.state).toBe("reserved_pre_dispatch");
    expect(projection.state).toBe("generating");
  });

  it("tracks the latest brief, bundle, candidates and validation states", () => {
    const specs: readonly EventSpec[] = [
      ...plannerRun(),
      {
        kind: "common_bundle_committed" as const,
        body: { bundle_id: ids.bundleA, bundle_sha256: hex(digestOf("b")) },
      },
      {
        kind: "brief_committed" as const,
        body: { brief_id: ids.briefA, brief_sha256: hex(digestOf("brief")) },
      },
      attemptReserved(
        ids.attemptB,
        "generator",
        "generation",
        generatorReservation,
        tagged(1),
      ),
      {
        kind: "candidate_committed" as const,
        body: {
          candidate_id: ids.candidateB,
          candidate_spec_sha256: hex(digestOf("spec-b")),
          source_result_id: ids.resultA,
          source_result_sha256: hex(digestOf("source-b")),
          precommit_validation_sha256: hex(digestOf("precommit-b")),
          bundle_sha256: hex(digestOf("b")),
          material_claim_count: tagged(2),
          material_claim_set_sha256: hex(digestOf("claims-b")),
        },
      },
      {
        kind: "candidate_committed" as const,
        body: {
          candidate_id: ids.candidateA,
          candidate_spec_sha256: hex(digestOf("spec-a")),
          source_result_id: ids.resultA,
          source_result_sha256: hex(digestOf("source-a")),
          precommit_validation_sha256: hex(digestOf("precommit-a")),
          bundle_sha256: hex(digestOf("b")),
          material_claim_count: tagged(2),
          material_claim_set_sha256: hex(digestOf("claims-a")),
        },
      },
      {
        kind: "candidate_validation_findings_committed" as const,
        body: {
          candidate_id: ids.candidateA,
          findings_sha256: hex(digestOf("findings")),
          finding_count: tagged(0),
          validation_state: "valid",
        },
      },
      {
        kind: "calculation_graph_committed" as const,
        body: {
          graph_id: ids.graphA,
          graph_sha256: hex(digestOf("graph")),
          result_id: ids.resultA,
          result_sha256: hex(digestOf("calc-result")),
          meter_sha256: hex(digestOf("meter")),
        },
      },
    ];
    const { projection } = expectRetained(reduce(specs));
    expect(projection.latestBriefSha256).toBe(hex(digestOf("brief")));
    expect(projection.latestBundleSha256).toBe(hex(digestOf("b")));
    expect(projection.candidateIds).toEqual([ids.candidateA, ids.candidateB]);
    expect(projection.validationStates).toEqual(["valid", "pending"]);
    expect(projection.calculationResultIds).toEqual([ids.resultA]);
  });
});

describe("agent run reducer: checkpoint equivalence", () => {
  it("emits canonical checkpoint bytes and a semantic state digest", () => {
    const reduction = expectRetained(reduce(plannerRun()));
    expect(reduction.checkpointable).toBe(true);
    const bytes = reduction.canonicalCheckpointBytes!;
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("{")).toBe(true);
    expect(text).toContain('"schema":"agent-run-checkpoint-v1"');
    expect(text).not.toContain(" ");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(32);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed.state).toBe("planning");
    expect(parsed.run_revision).toBe("i64:6");
    expect(parsed.lease_epoch).toBe("i64:1");
    expect(parsed.terminal_operation_kind).toBeNull();
    expect(parsed.selected_candidate_id).toBeNull();
  });

  it("derives state_sha256 and checkpoint_sha256 independently", () => {
    const reduction = expectRetained(reduce(plannerRun()));
    const bytes = reduction.canonicalCheckpointBytes!;
    const expectedState = sha256(
      encoder.encode("dasher.agent-run-checkpoint.v1"),
      new Uint8Array([0]),
      int32be(bytes.length),
      bytes,
    );
    expect(reduction.stateSha256).toEqual(expectedState);
    expect(agentRunCheckpointStateSha256(bytes)).toEqual(expectedState);

    const nonce = sha256(encoder.encode("checkpoint-nonce"));
    const expectedEnvelope = sha256(
      encoder.encode("dasher.retained-payload-envelope.v1"),
      new Uint8Array([0]),
      int32be("agent-run-checkpoint-v1".length),
      encoder.encode("agent-run-checkpoint-v1"),
      int32be(nonce.length),
      nonce,
      int32be(expectedState.length),
      expectedState,
    );
    expect(
      agentRunRetainedEnvelopeSha256(
        "agent-run-checkpoint-v1",
        nonce,
        expectedState,
      ),
    ).toEqual(expectedEnvelope);
    // The retained envelope is nonce-bound: the semantic digest alone never
    // reproduces it.
    expect(expectedEnvelope).not.toEqual(expectedState);
  });

  it("withholds checkpoint bytes once the run leaves the checkpoint fence", () => {
    const specs: readonly EventSpec[] = [
      ...plannerRun(),
      {
        kind: "run_finished" as const,
        body: {
          terminal_operation_id: ids.terminalOperation,
          terminal_outcome: "failed",
          reason_sha256: hex(digestOf("reason")),
        },
      },
    ];
    const reduction = expectRetained(reduce(specs));
    expect(reduction.checkpointable).toBe(false);
    expect(reduction.canonicalCheckpointBytes).toBeNull();
    expect(reduction.stateSha256).toBeNull();
    expect(reduction.projection.state).toBe("failed");
    expect(reduction.projection.terminalOperationKind).toBe("finish");
  });

  it("changes the state digest when any semantic field changes", () => {
    const first = expectRetained(reduce(plannerRun()));
    const second = expectRetained(
      reduce([
        ...plannerRun(),
        attemptReserved(
          ids.attemptB,
          "generator",
          "generation",
          generatorReservation,
          tagged(1),
        ),
      ]),
    );
    expect(second.stateSha256).not.toEqual(first.stateSha256);
  });

  it("admits a checkpoint_written header without advancing the run state", () => {
    const withCheckpoint: readonly EventSpec[] = [
      ...plannerRun(),
      checkpointWritten(1, 6),
    ];
    const reduction = expectRetained(reduce(withCheckpoint));
    expect(reduction.projection.state).toBe("planning");
    expect(reduction.projection.runRevision).toBe(7n);
    expect(reduction.projection.sourceEventSequence).toBe(7n);
    // The checkpoint header itself is part of the ledger, so the next
    // checkpoint covers strictly more events and has a different digest.
    expect(reduction.stateSha256).not.toEqual(
      expectRetained(reduce(plannerRun())).stateSha256,
    );
  });
});

describe("agent run reducer: cleaned tombstone rebuild", () => {
  function cleaned(
    events: readonly AgentRunLedgerEvent[],
  ): readonly AgentRunLedgerEvent[] {
    return events.map((event) => ({
      ...event,
      payloadSha256: null,
      contentNonce: null,
      canonicalPayloadBytes: null,
    }));
  }

  it("rebuilds only chain adjacency, count and deletion consistency", () => {
    const events = cleaned(buildLedger(plannerRun()));
    const reduction = reduceAgentRun({
      runId: ids.run,
      organizationId: ids.organization,
      dashboardId: ids.dashboard,
      canonicalRequestBytes: null,
      events,
    });
    if (reduction.mode !== "cleaned") throw new Error("expected cleaned mode");
    expect(reduction.runId).toBe(ids.run);
    expect(reduction.eventCount).toBe(6);
    expect(reduction.deletedPayloadCount).toBe(6);
    expect(reduction.chainAdjacent).toBe(true);
    expect(reduction.headEventSequence).toBe(6);
    expect(reduction.headEventSha256).toEqual(events[5]!.eventSha256);
    expect(reduction.firstEventSha256).toEqual(events[0]!.eventSha256);
    expect(reduction).not.toHaveProperty("stateSha256");
    expect(reduction).not.toHaveProperty("projection");
  });

  it("rejects a partially purged ledger", () => {
    const events = buildLedger(plannerRun());
    const mixed = [
      ...cleaned(events.slice(0, 3)),
      ...events.slice(3),
    ] as readonly AgentRunLedgerEvent[];
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: null,
          events: mixed,
        }),
      ),
    ).toBe("payload_retention_mixed");
  });

  it("rejects retained request bytes alongside purged payloads", () => {
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events: cleaned(buildLedger(plannerRun())),
        }),
      ),
    ).toBe("payload_retention_mixed");
  });

  it("still detects a broken chain after purge", () => {
    const events = cleaned(buildLedger(plannerRun())).map((event, index) =>
      index === 3
        ? { ...event, priorEventSha256: digestOf("wrong-prior") }
        : event,
    );
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: null,
          events,
        }),
      ),
    ).toBe("chain_broken");
  });
});

describe("agent run reducer: duplicate and idempotent handling", () => {
  it("collapses a byte-identical repeated event", () => {
    const events = buildLedger(plannerRun());
    const withDuplicate = [...events, events[2]!, events[5]!];
    const reduction = reduceAgentRun({
      runId: ids.run,
      organizationId: ids.organization,
      dashboardId: ids.dashboard,
      canonicalRequestBytes: canonicalRequestBytes(),
      events: withDuplicate,
    });
    const direct = reduceAgentRun({
      runId: ids.run,
      organizationId: ids.organization,
      dashboardId: ids.dashboard,
      canonicalRequestBytes: canonicalRequestBytes(),
      events,
    });
    expect(expectRetained(reduction).stateSha256).toEqual(
      expectRetained(direct).stateSha256,
    );
  });

  it("rejects a conflicting event at the same sequence", () => {
    const events = buildLedger(plannerRun());
    const conflicting = [
      ...events,
      { ...events[2]!, eventSha256: digestOf("other") },
    ];
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events: conflicting,
        }),
      ),
    ).toBe("duplicate_conflict");
  });

  it("rejects a sequence gap", () => {
    const events = buildLedger(plannerRun());
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events: [...events.slice(0, 2), ...events.slice(3)],
        }),
      ),
    ).toBe("chain_broken");
  });
});

describe("agent run reducer: transition and terminal fences", () => {
  it("denies a lease acquired after a terminal finish", () => {
    const specs: readonly EventSpec[] = [
      ...plannerRun(),
      {
        kind: "run_finished" as const,
        body: {
          terminal_operation_id: ids.terminalOperation,
          terminal_outcome: "failed",
          reason_sha256: hex(digestOf("reason")),
        },
      },
      leaseAcquired(1, 2, "resume"),
    ];
    expect(reducerCode(() => reduce(specs))).toBe("terminal_reopen");
  });

  it("denies closing a candidate set outside generating or revising", () => {
    const specs: readonly EventSpec[] = [
      runRequested(),
      leaseAcquired(0, 1),
      {
        kind: "candidate_set_closed" as const,
        body: {
          candidate_ids: [ids.candidateA],
          candidate_set_sha256: hex(digestOf("set")),
        },
      },
    ];
    expect(reducerCode(() => reduce(specs))).toBe("invalid_transition");
  });

  it("denies a replay prerequisite clone outside authorized", () => {
    const specs: readonly EventSpec[] = [
      ...plannerRun(),
      {
        kind: "replay_prerequisites_cloned" as const,
        body: {
          source_run_id: ids.sourceRun,
          bundle_id: ids.bundleA,
          bundle_sha256: hex(digestOf("b")),
          brief_id: ids.briefA,
          brief_sha256: hex(digestOf("brief")),
          candidate_set_sha256: hex(digestOf("set")),
          result_count: tagged(3),
          result_head_sha256: hex(digestOf("head")),
        },
      },
    ];
    expect(reducerCode(() => reduce(specs))).toBe("invalid_transition");
  });

  it("denies a run_requested event after sequence one", () => {
    expect(reducerCode(() => reduce([runRequested(), runRequested()]))).toBe(
      "invalid_transition",
    );
  });

  it("requires the first event to be run_requested", () => {
    expect(reducerCode(() => reduce([leaseAcquired(0, 1)]))).toBe(
      "invalid_transition",
    );
  });

  it("denies a run revision that does not advance by one", () => {
    expect(
      reducerCode(() =>
        reduce(plannerRun(), { runRevisionAt: { index: 3, value: 9 } }),
      ),
    ).toBe("payload_corrupt");
  });
});

describe("agent run reducer: indeterminate settlement", () => {
  const dispatched: readonly EventSpec[] = [
    runRequested(),
    leaseAcquired(0, 1),
    attemptReserved(ids.attemptA, "planner", "generation", plannerReservation),
    attemptDispatchPrepared(ids.attemptA),
    attemptDispatchStarted(ids.attemptA),
  ];

  it("releases only the candidate field and charges every other field", () => {
    // A generator reservation carries one candidate slot, so the released
    // candidate proof slot is observable; the planner reservation first is what
    // the database's own `attempt_reserved` transition requires out of
    // `authorized`.
    const withCandidate: readonly EventSpec[] = [
      runRequested(),
      leaseAcquired(0, 1),
      attemptReserved(
        ids.attemptA,
        "planner",
        "generation",
        plannerReservation,
      ),
      attemptReserved(
        ids.attemptB,
        "generator",
        "generation",
        generatorReservation,
        tagged(1),
      ),
      attemptDispatchPrepared(ids.attemptB),
      attemptDispatchStarted(ids.attemptB),
      attemptIndeterminate(
        ids.attemptB,
        "caller_indeterminate",
        generatorReservation,
        2,
      ),
    ];
    const { projection } = expectRetained(reduce(withCandidate));
    const attempt = projection.attempts[1]!;
    expect(attempt.state).toBe("indeterminate_quarantined");
    expect(attempt.actualVector).toBeNull();
    expect(attempt.indeterminateReason).toBe("caller_indeterminate");
    expect(attempt.releasedVector.candidates).toBe(1n);
    expect(attempt.usedVector.candidates).toBe(0n);
    expect(attempt.usedVector.calls).toBe(1n);
    expect(attempt.usedVector.cost_micros).toBe(500n);
    for (const field of AGENT_RUN_VECTOR_FIELDS) {
      if (field === "candidates") continue;
      expect(attempt.releasedVector[field]).toBe(0n);
    }
    expect(attempt.outstandingVector.candidates).toBe(0n);
    expect(projection.state).toBe("failed");
    expect(projection.leaseEpoch).toBe(2n);

    const candidatesCounter = projection.budgetCounters.find(
      (counter) =>
        counter.partition === "generation" &&
        counter.vectorField === "candidates",
    )!;
    expect(candidatesCounter.reservedUnits).toBe(1n);
    expect(candidatesCounter.releasedUnits).toBe(1n);
    expect(candidatesCounter.usedUnits).toBe(0n);
    expect(candidatesCounter.outstandingUnits).toBe(0n);
  });

  it("accepts every admitted reason code", () => {
    for (const reason of [
      "caller_indeterminate",
      "malformed_accounting",
      "actual_over_reservation",
    ]) {
      const { projection } = expectRetained(
        reduce([
          ...dispatched,
          attemptIndeterminate(ids.attemptA, reason, plannerReservation, 2),
        ]),
      );
      expect(projection.attempts[0]!.indeterminateReason).toBe(reason);
    }
  });

  it("rejects any reason outside the closed set", () => {
    for (const reason of [
      "provider_error",
      "unknown",
      "caller_Indeterminate",
      "",
    ]) {
      expect(
        reducerCode(() =>
          reduce([
            ...dispatched,
            attemptIndeterminate(ids.attemptA, reason, plannerReservation, 2),
          ]),
        ),
      ).toBe("unknown_indeterminate_reason");
    }
  });
});

describe("agent run reducer: mixed takeover terminal projection", () => {
  function takeover(): readonly EventSpec[] {
    const leaseSeconds = 60n;
    const claimInput = terminalClaimInputDigest(leaseSeconds);
    const used = { ...plannerReservation, candidates: tagged(0) };
    const released = vector();
    return [
      runRequested(),
      leaseAcquired(0, 1),
      attemptReserved(
        ids.attemptA,
        "planner",
        "generation",
        plannerReservation,
      ),
      attemptDispatchPrepared(ids.attemptA),
      attemptDispatchStarted(ids.attemptA),
      attemptIndeterminate(
        ids.attemptA,
        "takeover_after_dispatch",
        plannerReservation,
        2,
      ),
      {
        kind: "indeterminate_quarantined" as const,
        body: ({ sequence, occurredAtMicros, priorEvents }) => {
          const source = priorEvents[4]!;
          const settlement = priorEvents[5]!;
          const settlementDigest = sha256(
            encoder.encode("dasher.takeover-settlement-events.v1"),
            new Uint8Array([0]),
            uuidBytes(ids.run),
            int64be(1n),
            int64be(2n),
            int64be(1n),
            uuidBytes(ids.attemptA),
            ...textBytes("charged"),
            int64be(6n),
            settlement.eventSha256,
            vectorBytes(used),
            vectorBytes(released),
          );
          const terminalOperation = sha256(
            encoder.encode("dasher.run-terminal-operation.v1"),
            new Uint8Array([0]),
            ...textBytes("indeterminate_takeover"),
            uuidBytes(ids.claimRequest),
            uuidBytes(ids.run),
            claimInput,
            int64be(5n),
            source.eventSha256,
            int64be(1n),
            int64be(2n),
            int64be(1n),
            settlementDigest,
            int64be(BigInt(sequence)),
            int64be(BigInt(sequence)),
            ...textBytes("failed"),
            int64be(occurredAtMicros),
            int64be(1n),
          );
          return {
            claim_request_id: ids.claimRequest,
            lease_seconds: tagged(leaseSeconds),
            principal_id: ids.principal,
            principal_revision: tagged(1),
            principal_sha256: hex(digestOf("principal")),
            claim_input_sha256: hex(claimInput),
            claim_result_sha256: hex(
              terminalClaimResultDigest(claimInput, BigInt(sequence), 2n),
            ),
            terminal_claim_input_sha256: hex(claimInput),
            source_event_sequence: tagged(5),
            source_event_sha256: hex(source.eventSha256),
            released_attempt_ids: [],
            charged_attempt_ids: [ids.attemptA],
            settled_attempt_count: tagged(1),
            first_settlement_event_sequence: tagged(6),
            last_settlement_event_sequence: tagged(6),
            settlement_events_sha256: hex(settlementDigest),
            used_vector: used,
            released_vector: released,
            prior_lease_epoch: tagged(1),
            fenced_lease_epoch: tagged(2),
            terminal_operation_sha256: hex(terminalOperation),
          };
        },
      },
    ];
  }

  it("projects the exact terminal operation and claim input bindings", () => {
    const { projection } = expectRetained(reduce(takeover()));
    expect(projection.state).toBe("failed");
    expect(projection.leaseEpoch).toBe(2n);
    expect(projection.terminalOperationKind).toBe("indeterminate_takeover");
    expect(projection.terminalOperationId).toBe(ids.claimRequest);
    expect(projection.terminalClaimInputSha256).toBe(
      hex(terminalClaimInputDigest(60n)),
    );
    expect(projection.terminalOperationSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses to reopen a quarantined run", () => {
    expect(
      reducerCode(() => reduce([...takeover(), leaseAcquired(2, 3)])),
    ).toBe("terminal_reopen");
  });

  it("rejects direct, duplicate, noncontiguous, and digest-forged takeover walks", () => {
    const complete = takeover();
    const aggregateBody = JSON.parse(
      new TextDecoder().decode(
        buildLedger(complete).at(-1)!.canonicalPayloadBytes!,
      ),
    ).body as CanonicalJson;
    expect(
      reducerCode(() =>
        reduce([
          ...complete.slice(0, 5),
          { kind: "indeterminate_quarantined", body: aggregateBody },
        ]),
      ),
    ).toBe("settlement_mismatch");
    expect(
      reducerCode(() =>
        reduce([
          ...complete.slice(0, 6),
          {
            kind: "brief_committed",
            body: {
              brief_id: ids.briefA,
              brief_sha256: hex(digestOf("brief")),
            },
          },
          ...complete.slice(6),
        ]),
      ),
    ).toBe("settlement_mismatch");
    expect(
      reducerCode(() =>
        reduce([...complete.slice(0, 6), complete[5]!, ...complete.slice(6)]),
      ),
    ).toBe("invalid_transition");
    const forged: EventSpec = {
      kind: "indeterminate_quarantined",
      body: {
        ...(aggregateBody as Record<string, CanonicalJson>),
        settlement_events_sha256: hex(digestOf("forged")),
      },
    };
    expect(reducerCode(() => reduce([...complete.slice(0, -1), forged]))).toBe(
      "settlement_mismatch",
    );
  });
});

describe("agent run reducer: exact attempt FSM failures", () => {
  it("rejects dispatch skipping, repeated settlement, postterminal overwrite, and wrong release mode", () => {
    const reserved = [
      runRequested(),
      leaseAcquired(0, 1),
      attemptReserved(
        ids.attemptA,
        "planner",
        "generation",
        plannerReservation,
      ),
    ] as const;
    expect(
      reducerCode(() =>
        reduce([...reserved, attemptDispatchStarted(ids.attemptA)]),
      ),
    ).toBe("invalid_transition");
    expect(
      reducerCode(() =>
        reduce([
          ...plannerRun(),
          attemptReconciled(
            ids.attemptA,
            "failed",
            plannerReservation,
            plannerReservation,
            vector(),
          ),
        ]),
      ),
    ).toBe("invalid_transition");
    expect(
      reducerCode(() =>
        reduce([
          ...plannerRun(),
          {
            kind: "attempt_released",
            body: {
              attempt_id: ids.attemptA,
              release_mode: "worker",
              release_proof_sha256: hex(digestOf("release")),
              released_vector: plannerReservation,
            },
          },
        ]),
      ),
    ).toBe("invalid_transition");
    expect(
      reducerCode(() =>
        reduce([
          ...reserved,
          {
            kind: "attempt_released",
            body: {
              attempt_id: ids.attemptA,
              release_mode: "pre_dispatch",
              release_proof_sha256: hex(digestOf("release")),
              released_vector: plannerReservation,
            },
          },
        ]),
      ),
    ).toBe("payload_corrupt");
  });

  it("rejects negative, out-of-i64, and nonconserving attempt vectors", () => {
    for (const badCalls of [tagged(-1), tagged(2n ** 63n)]) {
      expect(
        reducerCode(() =>
          reduce([
            runRequested(),
            leaseAcquired(0, 1),
            attemptReserved(ids.attemptA, "planner", "generation", {
              ...plannerReservation,
              calls: badCalls,
            }),
          ]),
        ),
      ).toBe("payload_corrupt");
    }
    expect(
      reducerCode(() =>
        reduce([
          ...plannerRun().slice(0, -1),
          attemptReconciled(
            ids.attemptA,
            "succeeded",
            vector(),
            vector(),
            vector(),
          ),
        ]),
      ),
    ).toBe("budget_invariant_violated");
  });
});

describe("agent run reducer: tenant cancellation projection", () => {
  function cancelled(reasonBearing = false): readonly EventSpec[] {
    return [
      runRequested(),
      leaseAcquired(0, 1),
      {
        kind: "run_cancelled" as const,
        actorKind: "tenant",
        eventId: ids.cancelOperation,
        body: {
          cancel_operation_id: ids.cancelOperation,
          cancel_operation_sha256: hex(digestOf("cancel-operation")),
          reason_sha256: hex(digestOf("cancel-reason")),
          released_attempt_ids: [],
          charged_attempt_ids: [],
          used_vector: vector(),
          released_vector: vector(),
          fenced_lease_epoch: tagged(reasonBearing ? 2 : 2),
        },
      },
    ];
  }

  it("binds the tenant cancel operation, digest and result columns", () => {
    const events = buildLedger(cancelled());
    const { projection } = expectRetained(
      reduceAgentRun({
        runId: ids.run,
        organizationId: ids.organization,
        dashboardId: ids.dashboard,
        canonicalRequestBytes: canonicalRequestBytes(),
        events,
      }),
    );
    expect(projection.state).toBe("cancelled");
    expect(projection.tenantCancelOperationId).toBe(ids.cancelOperation);
    expect(projection.tenantCancelOperationSha256).toBe(
      hex(digestOf("cancel-operation")),
    );
    expect(projection.tenantCancelResultRunRevision).toBe(3n);
    expect(projection.tenantCancelResultEventSequence).toBe(3n);
    expect(projection.tenantCancelResultEventSha256).not.toBeNull();
    expect(projection.tenantCancelResultSha256).toBe(
      hex(
        sha256(
          encoder.encode("dasher.run-tenant-cancel-result.v1"),
          new Uint8Array([0]),
          digestOf("cancel-operation"),
          uuidBytes(ids.organization),
          uuidBytes(ids.dashboard),
          uuidBytes(ids.run),
          int64be(3n),
          ...textBytes("cancelled"),
          int64be(3n),
          events[2]!.eventSha256,
        ),
      ),
    );
    expect(projection.leaseEpoch).toBe(2n);
  });

  it("rejects a cancel body whose operation id is not the event and audit id", () => {
    const corrupted = cancelled().map((event, index) =>
      index === 2
        ? {
            ...event,
            body: {
              ...(event.body as Record<string, CanonicalJson>),
              cancel_operation_id: ids.claimRequest,
            },
          }
        : event,
    );
    expect(reducerCode(() => reduce(corrupted))).toBe("payload_corrupt");
  });

  it("does not bind tenant cancel columns for a cleanup cancellation", () => {
    const specs: readonly EventSpec[] = [
      runRequested(),
      leaseAcquired(0, 1),
      {
        kind: "run_cleanup_cancelled" as const,
        actorKind: "retention",
        body: {
          cancel_operation_id: ids.cancelOperation,
          reason_sha256: hex(digestOf("cleanup-reason")),
          released_attempt_ids: [],
          charged_attempt_ids: [],
          used_vector: vector(),
          released_vector: vector(),
          fenced_lease_epoch: tagged(2),
        },
      },
    ];
    const { projection } = expectRetained(reduce(specs));
    expect(projection.state).toBe("cancelled");
    expect(projection.tenantCancelOperationId).toBeNull();
    expect(projection.tenantCancelResultSha256).toBeNull();
  });
});

describe("agent run reducer: remaining positive event vocabulary", () => {
  it("accepts a worker pre-dispatch release with the exact worker literal", () => {
    const specs: readonly EventSpec[] = [
      runRequested(),
      leaseAcquired(0, 1),
      attemptReserved(
        ids.attemptA,
        "planner",
        "generation",
        plannerReservation,
      ),
      {
        kind: "attempt_released",
        body: {
          attempt_id: ids.attemptA,
          release_mode: "worker",
          release_proof_sha256: hex(digestOf("release")),
          released_vector: plannerReservation,
        },
      },
    ];
    const { projection } = expectRetained(reduce(specs));
    expect(projection.attempts[0]!.state).toBe("released_pre_dispatch");
  });

  it("accepts the exact released and charged cancellation attempt branches", () => {
    const releasedSpecs: readonly EventSpec[] = [
      runRequested(),
      leaseAcquired(0, 1),
      attemptReserved(
        ids.attemptA,
        "planner",
        "generation",
        plannerReservation,
      ),
      {
        kind: "attempt_cancelled_released",
        actorKind: "tenant",
        body: {
          attempt_id: ids.attemptA,
          cancel_operation_id: ids.cancelOperation,
          used_vector: vector(),
          released_vector: plannerReservation,
        },
      },
      {
        kind: "run_cancelled",
        actorKind: "tenant",
        eventId: ids.cancelOperation,
        body: {
          cancel_operation_id: ids.cancelOperation,
          cancel_operation_sha256: hex(digestOf("cancel-operation")),
          reason_sha256: hex(digestOf("cancel-reason")),
          released_attempt_ids: [ids.attemptA],
          charged_attempt_ids: [],
          used_vector: vector(),
          released_vector: plannerReservation,
          fenced_lease_epoch: tagged(2),
        },
      },
    ];
    expect(expectRetained(reduce(releasedSpecs)).projection.state).toBe(
      "cancelled",
    );

    const chargedUsed = { ...plannerReservation, candidates: tagged(0) };
    const chargedReleased = vector();
    const chargedSpecs: readonly EventSpec[] = [
      runRequested(),
      leaseAcquired(0, 1),
      attemptReserved(
        ids.attemptA,
        "planner",
        "generation",
        plannerReservation,
      ),
      attemptDispatchPrepared(ids.attemptA),
      attemptDispatchStarted(ids.attemptA),
      {
        kind: "attempt_cancelled_charged",
        actorKind: "tenant",
        body: {
          attempt_id: ids.attemptA,
          cancel_operation_id: ids.cancelOperation,
          used_vector: chargedUsed,
          released_vector: chargedReleased,
        },
      },
      {
        kind: "run_cancelled",
        actorKind: "tenant",
        eventId: ids.cancelOperation,
        body: {
          cancel_operation_id: ids.cancelOperation,
          cancel_operation_sha256: hex(digestOf("cancel-operation")),
          reason_sha256: hex(digestOf("cancel-reason")),
          released_attempt_ids: [],
          charged_attempt_ids: [ids.attemptA],
          used_vector: chargedUsed,
          released_vector: chargedReleased,
          fenced_lease_epoch: tagged(2),
        },
      },
    ];
    const charged = expectRetained(reduce(chargedSpecs)).projection;
    expect(charged.attempts[0]!.state).toBe("cancelled_charged");
  });

  it("consumes Replay results contiguously and enters generating only on N", () => {
    const prefix = replayPrefix();
    for (const sequence of [1, 2]) {
      const { projection } = expectRetained(
        reduceWithRequest(
          [...prefix, ...[1, 2].slice(0, sequence).map(replayResult)],
          replayRequestBytes(),
        ),
      );
      expect(projection.state).toBe("planning");
      expect(projection.consumedReplaySequence).toBe(BigInt(sequence));
    }

    const { projection } = expectRetained(
      reduceWithRequest(
        [...prefix, replayResult(1), replayResult(2), replayResult(3)],
        replayRequestBytes(),
      ),
    );
    expect(projection.state).toBe("generating");
    expect(projection.consumedReplaySequence).toBe(3n);
    expect(projection.consumedReplaySha256).toBe(
      hex(digestOf("source-result-3")),
    );
  });

  it.each([
    ["first sequence is zero", [0]],
    ["first sequence is not one", [2]],
    ["sequence has a gap", [1, 3]],
    ["sequence is duplicated", [1, 1]],
    ["sequence reverses", [1, 2, 1]],
    ["sequence overruns the request count", [1, 2, 3, 4]],
  ])("rejects Replay consumption when %s", (_label, sequences) => {
    expect(
      reducerCode(() =>
        reduceWithRequest(
          [...replayPrefix(), ...sequences.map(replayResult)],
          replayRequestBytes(),
        ),
      ),
    ).toBe("invalid_transition");
  });

  it("rejects Replay prerequisite count and head drift from the request", () => {
    const wrongHead = replayPrerequisites();
    const drifted = [
      replayPrerequisites(2),
      {
        ...wrongHead,
        body: {
          ...(wrongHead.body as Record<string, CanonicalJson>),
          result_head_sha256: hex(digestOf("wrong-head")),
        },
      },
    ];
    for (const prerequisite of drifted) {
      expect(
        reducerCode(() =>
          reduceWithRequest(
            [
              runRequested({
                purpose: "replay",
                replay_source_run_id: ids.sourceRun,
              }),
              leaseAcquired(0, 1),
              prerequisite,
            ],
            replayRequestBytes(),
          ),
        ),
      ).toBe("request_binding_mismatch");
    }
  });

  it("rejects Replay consumption outside planning or for Suggest", () => {
    expect(
      reducerCode(() =>
        reduceWithRequest(
          [
            runRequested({
              purpose: "replay",
              replay_source_run_id: ids.sourceRun,
            }),
            leaseAcquired(0, 1),
            replayResult(1),
          ],
          replayRequestBytes(),
        ),
      ),
    ).toBe("invalid_transition");
    expect(
      reducerCode(() =>
        reduce([runRequested(), leaseAcquired(0, 1), replayResult(1)]),
      ),
    ).toBe("invalid_transition");
  });

  it("accepts candidate Claims and manifest commits only after close", () => {
    const generating = [
      ...replayPrefix(),
      replayResult(1),
      replayResult(2),
      replayResult(3),
    ];
    const specs: readonly EventSpec[] = [
      ...generating,
      {
        kind: "candidate_set_closed",
        body: {
          candidate_ids: [ids.candidateA],
          candidate_set_sha256: hex(digestOf("set")),
        },
      },
      candidateClaimsCommitted(),
      candidateManifestCommitted(),
    ];
    expect(
      expectRetained(reduceWithRequest(specs, replayRequestBytes())).projection
        .state,
    ).toBe("validating");
  });

  it.each([
    ["planning", replayPrefix()],
    [
      "generating",
      [...replayPrefix(), replayResult(1), replayResult(2), replayResult(3)],
    ],
  ])("rejects candidate proof commits while %s", (_state, prefix) => {
    for (const proof of [
      candidateClaimsCommitted(),
      candidateManifestCommitted(),
    ]) {
      expect(
        reducerCode(() =>
          reduceWithRequest([...prefix, proof], replayRequestBytes()),
        ),
      ).toBe("invalid_transition");
    }
  });
});

describe("agent run reducer: ranking and abstention", () => {
  it("moves to approval_required and records the selected candidate", () => {
    const specs: readonly EventSpec[] = [
      ...plannerRun(),
      {
        kind: "candidate_set_closed" as const,
        body: {
          candidate_ids: [ids.candidateA],
          candidate_set_sha256: hex(digestOf("set")),
        },
      },
      {
        kind: "run_ranked" as const,
        body: {
          terminal_operation_id: ids.terminalOperation,
          selected_candidate_id: ids.candidateA,
          ordered_candidate_ids: [ids.candidateA],
          ordered_ranks: [tagged(1)],
          ranking_sha256: hex(digestOf("ranking")),
        },
      },
    ];
    const reduction = expectRetained(
      reduce([
        specs[0]!,
        specs[1]!,
        specs[2]!,
        specs[3]!,
        specs[4]!,
        specs[5]!,
        // candidate_set_closed requires generating or revising
        attemptReserved(
          ids.attemptB,
          "generator",
          "generation",
          generatorReservation,
          tagged(1),
        ),
        specs[6]!,
        specs[7]!,
      ]),
    );
    expect(reduction.projection.state).toBe("approval_required");
    expect(reduction.projection.selectedCandidateId).toBe(ids.candidateA);
    expect(reduction.projection.terminalOperationKind).toBe("ranking");
    expect(reduction.projection.candidateSetSha256).toBe(hex(digestOf("set")));
    expect(reduction.checkpointable).toBe(false);
  });

  it("moves to rejected on abstention", () => {
    const specs: readonly EventSpec[] = [
      ...plannerRun(),
      {
        kind: "run_abstained" as const,
        body: {
          terminal_operation_id: ids.terminalOperation,
          abstention_id: ids.resultA,
          abstention_sha256: hex(digestOf("abstention")),
        },
      },
    ];
    const { projection } = expectRetained(reduce(specs));
    expect(projection.state).toBe("rejected");
    expect(projection.terminalOperationKind).toBe("abstention");
  });
});

describe("agent run reducer: hostile input", () => {
  it("rejects a non-object input", () => {
    for (const candidate of [null, undefined, 1, "x", []]) {
      expect(
        reducerCode(() =>
          reduceAgentRun(
            candidate as unknown as Parameters<typeof reduceAgentRun>[0],
          ),
        ),
      ).toBe("invalid_input");
    }
  });

  it("rejects extra, symbol, accessor, inherited, and proxy reducer/event objects", () => {
    const base = {
      runId: ids.run,
      organizationId: ids.organization,
      dashboardId: ids.dashboard,
      canonicalRequestBytes: canonicalRequestBytes(),
      events: buildLedger(plannerRun()),
    };
    const hostileInputs: readonly unknown[] = [
      { ...base, extra: true },
      Object.assign(Object.create({ inherited: true }), base),
      Object.defineProperty({ ...base }, "runId", {
        get: () => ids.run,
        enumerable: true,
      }),
      Object.assign({ ...base }, { [Symbol("smuggled")]: true }),
      new Proxy(base, {}),
    ];
    for (const input of hostileInputs) {
      expect(reducerCode(() => reduceAgentRun(input as never))).toBe(
        "invalid_input",
      );
    }

    const event = buildLedger(plannerRun())[0]!;
    const hostileEvents: readonly unknown[] = [
      { ...event, extra: true },
      Object.assign(Object.create({ inherited: true }), event),
      Object.defineProperty({ ...event }, "eventKind", {
        get: () => "run_requested",
        enumerable: true,
      }),
      Object.assign({ ...event }, { [Symbol("smuggled")]: true }),
      new Proxy(event, {}),
    ];
    for (const hostile of hostileEvents) {
      expect(
        reducerCode(() =>
          reduceAgentRun({ ...base, events: [hostile] } as never),
        ),
      ).toBe("invalid_event_header");
    }
  });

  it("rejects a non canonical run identifier", () => {
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: "not-a-uuid",
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events: buildLedger(plannerRun()),
        }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects an empty ledger", () => {
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events: [],
        }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects an unknown event kind", () => {
    const events = buildLedger(plannerRun()).map((event, index) =>
      index === 3
        ? { ...event, eventKind: "run_exfiltrated" as AgentRunEventKind }
        : event,
    );
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events,
        }),
      ),
    ).toBe("invalid_event_header");
  });

  it("rejects a payload whose envelope digest does not match", () => {
    expect(
      reducerCode(() => reduce(plannerRun(), { corruptPayloadAt: 2 })),
    ).toBe("payload_corrupt");
  });

  it("rejects a payload bound to a different run", () => {
    const events = buildLedger(plannerRun(), { runId: ids.sourceRun });
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: canonicalRequestBytes(),
          events,
        }),
      ),
    ).toBe("payload_corrupt");
  });

  it("rejects an event body with an unexpected key set", () => {
    const specs: readonly EventSpec[] = [
      runRequested(),
      {
        kind: "brief_committed",
        body: {
          brief_id: ids.briefA,
          brief_sha256: hex(digestOf("brief")),
          smuggled: "value",
        },
      },
    ];
    expect(reducerCode(() => reduce(specs))).toBe("payload_corrupt");
  });

  it("rejects a request binding that disagrees with the ledger", () => {
    const events = buildLedger(plannerRun());
    const foreignRequest = canonicalRequestBytes({
      run_request_id: ids.sourceRun,
    });
    expect(
      reducerCode(() =>
        reduceAgentRun({
          runId: ids.run,
          organizationId: ids.organization,
          dashboardId: ids.dashboard,
          canonicalRequestBytes: foreignRequest,
          events,
        }),
      ),
    ).toBe("request_binding_mismatch");
  });

  it("rejects extra canonical request keys and replay-source drift", () => {
    expect(
      reducerCode(() =>
        reduceWithRequest(
          plannerRun(),
          canonicalRequestBytes({ smuggled: "value" }),
        ),
      ),
    ).toBe("payload_corrupt");
    expect(
      reducerCode(() =>
        reduceWithRequest(
          [
            runRequested({
              purpose: "replay",
              replay_source_run_id: ids.sourceRun,
            }),
          ],
          canonicalRequestBytes({
            purpose: "replay",
            replay_source_run_id: ids.run,
            replay_source_result_count: tagged(3),
            replay_source_head_sha256: hex(digestOf("head")),
            replay_source_candidate_set_sha256: hex(digestOf("set")),
            replay_source_bundle_id: ids.bundleA,
            replay_source_bundle_sha256: hex(digestOf("bundle")),
            replay_source_brief_id: ids.briefA,
            replay_source_brief_sha256: hex(digestOf("brief")),
            replay_source_selected_candidate_id: ids.candidateA,
          }),
        ),
      ),
    ).toBe("request_binding_mismatch");
  });

  it("never mutates the caller's event array or byte buffers", () => {
    const events = buildLedger(plannerRun());
    const snapshot = events.map((event) => ({
      eventSha256: new Uint8Array(event.eventSha256),
      payload: new Uint8Array(event.canonicalPayloadBytes!),
    }));
    const array = [...events];
    reduceAgentRun({
      runId: ids.run,
      organizationId: ids.organization,
      dashboardId: ids.dashboard,
      canonicalRequestBytes: canonicalRequestBytes(),
      events: array,
    });
    expect(array).toHaveLength(events.length);
    events.forEach((event, index) => {
      expect(event.eventSha256).toEqual(snapshot[index]!.eventSha256);
      expect(event.canonicalPayloadBytes).toEqual(snapshot[index]!.payload);
    });
  });

  it("returns frozen projections", () => {
    const reduction = expectRetained(reduce(plannerRun()));
    expect(Object.isFrozen(reduction)).toBe(true);
    expect(Object.isFrozen(reduction.projection)).toBe(true);
    expect(Object.isFrozen(reduction.projection.attempts)).toBe(true);
    expect(Object.isFrozen(reduction.projection.budgetCounters)).toBe(true);
    const first = reduction.projection.sourceEventSha256[0]!;
    (reduction.projection.sourceEventSha256 as Uint8Array)[0]! ^= 0xff;
    const rebuilt = expectRetained(reduce(plannerRun()));
    expect(rebuilt.projection.sourceEventSha256[0]).toBe(first);
  });
});

describe("agent run reducer: exported hash primitives", () => {
  it("matches the SQL event digest construction", () => {
    const payload = encoder.encode("{}");
    const semantic = agentRunEventSemanticSha256(payload);
    expect(semantic).toEqual(
      sha256(
        encoder.encode("dasher.agent-run-event-payload.v1"),
        new Uint8Array([0]),
        int32be(payload.length),
        payload,
      ),
    );
    const nonce = digestOf("nonce");
    const envelope = agentRunRetainedEnvelopeSha256(
      "agent-run-event-payload-v1",
      nonce,
      semantic,
    );
    const occurredAt = new Date(baseOccurredAt);
    const occurredAtMicros = BigInt(occurredAt.getTime()) * 1000n;
    const prior = digestOf("prior");
    expect(
      agentRunEventSha256({
        runId: ids.run,
        eventSequence: 4,
        eventKind: "attempt_reserved",
        occurredAtMicros,
        priorEventSequence: 3,
        priorEventSha256: prior,
        payloadSha256: envelope,
      }),
    ).toEqual(
      sha256(
        encoder.encode("dasher.agent-run-event.v1"),
        new Uint8Array([0]),
        uuidBytes(ids.run),
        int64be(4n),
        int32be("attempt_reserved".length),
        encoder.encode("attempt_reserved"),
        int64be(BigInt(occurredAt.getTime()) * 1000n),
        new Uint8Array([1]),
        int64be(3n),
        new Uint8Array([1]),
        prior,
        envelope,
      ),
    );
  });

  it("uses the zero tag for the genesis event", () => {
    const envelope = digestOf("envelope");
    const occurredAt = new Date(baseOccurredAt);
    const occurredAtMicros = BigInt(occurredAt.getTime()) * 1000n;
    expect(
      agentRunEventSha256({
        runId: ids.run,
        eventSequence: 1,
        eventKind: "run_requested",
        occurredAtMicros,
        priorEventSequence: null,
        priorEventSha256: null,
        payloadSha256: envelope,
      }),
    ).toEqual(
      sha256(
        encoder.encode("dasher.agent-run-event.v1"),
        new Uint8Array([0]),
        uuidBytes(ids.run),
        int64be(1n),
        int32be("run_requested".length),
        encoder.encode("run_requested"),
        int64be(BigInt(occurredAt.getTime()) * 1000n),
        new Uint8Array([0]),
        new Uint8Array([0]),
        envelope,
      ),
    );
  });

  it("preserves a nonzero sub-millisecond PostgreSQL event timestamp", () => {
    const envelope = digestOf("microsecond-envelope");
    const occurredAtMicros = BigInt(baseOccurredAt) * 1000n + 789n;
    const actual = agentRunEventSha256({
      runId: ids.run,
      eventSequence: 1,
      eventKind: "run_requested",
      occurredAtMicros,
      priorEventSequence: null,
      priorEventSha256: null,
      payloadSha256: envelope,
    });
    const expected = sha256(
      encoder.encode("dasher.agent-run-event.v1"),
      new Uint8Array([0]),
      uuidBytes(ids.run),
      int64be(1n),
      int32be("run_requested".length),
      encoder.encode("run_requested"),
      int64be(occurredAtMicros),
      new Uint8Array([0]),
      new Uint8Array([0]),
      envelope,
    );
    expect(actual).toEqual(expected);
    expect(actual).not.toEqual(
      agentRunEventSha256({
        runId: ids.run,
        eventSequence: 1,
        eventKind: "run_requested",
        occurredAtMicros: BigInt(baseOccurredAt) * 1000n,
        priorEventSequence: null,
        priorEventSha256: null,
        payloadSha256: envelope,
      }),
    );
  });

  it("normalizes every hostile event-hash input fault", () => {
    const valid = {
      runId: ids.run,
      eventSequence: 1,
      eventKind: "run_requested",
      occurredAtMicros: BigInt(baseOccurredAt) * 1000n,
      priorEventSequence: null,
      priorEventSha256: null,
      payloadSha256: digestOf("payload"),
    };
    const hostile: readonly unknown[] = [
      { ...valid, extra: true },
      { ...valid, eventKind: "invented_event_kind" },
      Object.assign(Object.create({ inherited: true }), valid),
      Object.defineProperty({ ...valid }, "eventKind", {
        get: () => {
          throw new Error("attacker");
        },
        enumerable: true,
      }),
      Object.assign({ ...valid }, { [Symbol("smuggled")]: true }),
      new Proxy(valid, {
        ownKeys: () => {
          throw new Error("attacker");
        },
      }),
    ];
    for (const candidate of hostile) {
      expect(reducerCode(() => agentRunEventSha256(candidate as never))).toBe(
        "invalid_input",
      );
    }
  });
});
