import type { PgCompatiblePool } from "./invitation-repository.js";
import type { SecretKeyRing } from "./secrets.js";

/**
 * Closed vocabulary transcribed from migration 0007. Nothing here is derived at
 * runtime from a database response: every literal is checked against the exact
 * SQL CHECK constraint or fixed function guard it mirrors.
 */

export type AgentRunState =
  | "requested"
  | "authorized"
  | "planning"
  | "generating"
  | "revising"
  | "validating"
  | "approval_required"
  | "rejected"
  | "cancelled"
  | "expired"
  | "failed";

export const AGENT_RUN_TERMINAL_STATES = Object.freeze([
  "rejected",
  "cancelled",
  "expired",
  "failed",
] as const);

export type AgentRunTerminalState = (typeof AGENT_RUN_TERMINAL_STATES)[number];

export type AgentRunPurpose = "suggest" | "replay";

export type AgentRunEventKind =
  | "run_requested"
  | "lease_acquired"
  | "indeterminate_quarantined"
  | "replay_prerequisites_cloned"
  | "replay_result_consumed"
  | "checkpoint_written"
  | "brief_committed"
  | "common_bundle_committed"
  | "attempt_reserved"
  | "attempt_dispatch_prepared"
  | "attempt_dispatch_started"
  | "attempt_reconciled"
  | "attempt_indeterminate"
  | "attempt_released"
  | "attempt_cancelled_released"
  | "attempt_cancelled_charged"
  | "calculation_graph_committed"
  | "candidate_validation_findings_committed"
  | "candidate_committed"
  | "candidate_set_closed"
  | "candidate_claims_committed"
  | "candidate_manifest_committed"
  | "run_abstained"
  | "run_ranked"
  | "run_finished"
  | "run_cancelled"
  | "run_cleanup_cancelled";

export type AgentRunAttemptKind =
  "planner" | "generator" | "specialist" | "repair" | "reviewer";

export type AgentRunAttemptState =
  | "reserved_pre_dispatch"
  | "dispatch_ready"
  | "dispatch_started"
  | "succeeded"
  | "refused_charged"
  | "failed_charged"
  | "released_pre_dispatch"
  | "released_takeover"
  | "cancelled_released"
  | "cancelled_charged"
  | "indeterminate_quarantined";

export type AgentRunBudgetPartition = "generation" | "review";

export const AGENT_RUN_BUDGET_PARTITIONS = Object.freeze([
  "generation",
  "review",
] as const);

export type AgentRunVectorField =
  | "calls"
  | "candidates"
  | "specialist_attempts"
  | "reviewer_attempts"
  | "repair_attempts"
  | "input_tokens"
  | "output_tokens"
  | "reasoning_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
  | "total_tokens"
  | "wall_millis"
  | "work_millis"
  | "cost_micros";

/** Frozen field order of `dasher_run_api.attempt_resource_vector`. */
export const AGENT_RUN_VECTOR_FIELDS = Object.freeze([
  "calls",
  "candidates",
  "specialist_attempts",
  "reviewer_attempts",
  "repair_attempts",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "wall_millis",
  "work_millis",
  "cost_micros",
] as const);

export type AttemptResourceVector = Readonly<
  Record<AgentRunVectorField, bigint>
>;

export type AgentRunAttemptOutcome =
  "succeeded" | "refused" | "failed" | "indeterminate";

export type AgentRunReleaseReason =
  "adapter_setup_failed" | "cancelled_before_dispatch" | "retry_superseded";

/**
 * The complete set of indeterminate reason codes. Section 7 Task 9D requires the
 * reducer and every checkpoint rebuild to reject any other code outright.
 */
export const AGENT_RUN_INDETERMINATE_REASONS = Object.freeze([
  "caller_indeterminate",
  "malformed_accounting",
  "actual_over_reservation",
  "takeover_after_dispatch",
] as const);

export type AgentRunIndeterminateReason =
  (typeof AGENT_RUN_INDETERMINATE_REASONS)[number];

export type AgentRunTerminalOperationKind =
  "abstention" | "ranking" | "finish" | "indeterminate_takeover";

export type AgentRunTerminalOutcome =
  "rejected" | "cancelled" | "expired" | "failed";

export type AgentRunClaimOperationKind =
  "ordinary_claim" | "indeterminate_takeover";

export type AgentRunClaimMode = "normal" | "resume" | "takeover";

export type AgentRunClaimStatus =
  "claimed" | "terminalized_indeterminate" | "no_eligible_run";

export type AgentRunValidationState = "pending" | "valid" | "invalid";

export type AgentRunRecordedResultKind =
  | "planner_output"
  | "specialist_output"
  | "candidate_output"
  | "candidate_invalid"
  | "repair_output"
  | "reviewer_verdict_set"
  | "refusal"
  | "failure";

/**
 * The frozen `attempt_released.release_mode` vocabulary. `worker` is the fixed
 * `release_agent_run_attempt` path and lands the attempt in
 * `released_pre_dispatch`; `takeover` is the claim settlement walk and lands it
 * in `released_takeover`. There is no `pre_dispatch` event literal.
 */
export const AGENT_RUN_ATTEMPT_RELEASE_MODES = Object.freeze([
  "worker",
  "takeover",
] as const);

export type AgentRunAttemptReleaseMode =
  (typeof AGENT_RUN_ATTEMPT_RELEASE_MODES)[number];

export type AgentRunInvocationStatus =
  "authorized_now" | "already_authorized" | "denied";

/* ------------------------------------------------------------------ */
/* Reducer contracts                                                   */
/* ------------------------------------------------------------------ */

/**
 * One immutable governed event header. `canonicalPayloadBytes` is the retained
 * semantic body; after governed purge the payload columns are gone and every
 * payload-bearing field is null, which selects hash-only tombstone rebuild.
 */
export interface AgentRunLedgerEvent {
  readonly eventSequence: number;
  readonly eventId: string;
  readonly eventKind: AgentRunEventKind;
  /** Exact signed Unix-epoch microseconds hashed by PostgreSQL. */
  readonly occurredAtMicros: bigint;
  readonly priorEventSequence: number | null;
  readonly priorEventSha256: Uint8Array | null;
  readonly eventSha256: Uint8Array;
  readonly payloadSha256: Uint8Array | null;
  readonly contentNonce: Uint8Array | null;
  readonly canonicalPayloadBytes: Uint8Array | null;
}

/**
 * The closed reducer input. `organizationId` and `dashboardId` are the run's
 * own canonical owners: `dasher.run-tenant-cancel-result.v1` and
 * `dasher.agent-run-claim-result.v1` both bind them, and neither appears in any
 * retained event body, so a faithful rebuild cannot omit them.
 */
export interface AgentRunReducerInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly dashboardId: string;
  readonly canonicalRequestBytes: Uint8Array | null;
  readonly events: readonly AgentRunLedgerEvent[];
}

export interface AgentRunBudgetCounter {
  readonly partition: AgentRunBudgetPartition;
  readonly vectorField: AgentRunVectorField;
  readonly limitUnits: bigint;
  readonly reservedUnits: bigint;
  readonly usedUnits: bigint;
  readonly releasedUnits: bigint;
  readonly outstandingUnits: bigint;
}

export interface AgentRunAttemptProjection {
  readonly attemptId: string;
  readonly attemptKind: AgentRunAttemptKind;
  readonly partition: AgentRunBudgetPartition;
  readonly state: AgentRunAttemptState;
  readonly leaseEpoch: bigint;
  readonly candidateSlot: bigint | null;
  readonly retryOfAttemptId: string | null;
  readonly reservedVector: AttemptResourceVector;
  readonly actualVector: AttemptResourceVector | null;
  readonly usedVector: AttemptResourceVector;
  readonly releasedVector: AttemptResourceVector;
  readonly outstandingVector: AttemptResourceVector;
  readonly requestSha256: string;
  readonly resultSha256: string | null;
  readonly indeterminateReason: AgentRunIndeterminateReason | null;
}

export interface AgentRunProjection {
  readonly runId: string;
  readonly runRequestId: string;
  readonly requestIdempotencySha256: string;
  readonly requestSha256: string;
  readonly policyRevision: bigint;
  readonly purpose: AgentRunPurpose;
  readonly replaySourceRunId: string | null;
  readonly runRevision: bigint;
  readonly state: AgentRunState;
  readonly leaseEpoch: bigint;
  readonly sourceEventSequence: bigint;
  readonly sourceEventSha256: Uint8Array;
  readonly budgetCounters: readonly AgentRunBudgetCounter[];
  readonly attempts: readonly AgentRunAttemptProjection[];
  readonly latestBriefSha256: string | null;
  readonly latestBundleSha256: string | null;
  readonly calculationResultIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly candidateSetSha256: string | null;
  readonly validationStates: readonly AgentRunValidationState[];
  readonly consumedReplaySequence: bigint | null;
  readonly consumedReplaySha256: string | null;
  readonly terminalOperationKind: AgentRunTerminalOperationKind | null;
  readonly terminalOperationId: string | null;
  readonly terminalClaimInputSha256: string | null;
  readonly terminalOperationSha256: string | null;
  readonly tenantCancelOperationId: string | null;
  readonly tenantCancelOperationSha256: string | null;
  readonly tenantCancelResultSha256: string | null;
  readonly tenantCancelResultRunRevision: bigint | null;
  readonly tenantCancelResultEventSequence: bigint | null;
  readonly tenantCancelResultEventSha256: string | null;
  readonly selectedCandidateId: string | null;
}

/**
 * A rebuild from retained semantic payloads. `canonicalCheckpointBytes` and
 * `stateSha256` are present only while the run is inside the exact
 * `write_agent_run_checkpoint` fence, which is the only window in which the
 * database itself would accept a checkpoint.
 */
export interface RetainedAgentRunReduction {
  readonly mode: "retained";
  readonly projection: AgentRunProjection;
  readonly checkpointable: boolean;
  readonly canonicalCheckpointBytes: Uint8Array | null;
  readonly stateSha256: Uint8Array | null;
}

/**
 * A rebuild after governed purge. The payload nonce and bare content address are
 * deleted, so the semantic digest cannot be recomputed and deleted tenant content
 * cannot be reconstructed; only chain adjacency, count and deletion consistency
 * survive.
 */
export interface CleanedAgentRunReduction {
  readonly mode: "cleaned";
  readonly runId: string;
  readonly eventCount: number;
  readonly firstEventSha256: Uint8Array;
  readonly headEventSequence: number;
  readonly headEventSha256: Uint8Array;
  readonly chainAdjacent: boolean;
  readonly deletedPayloadCount: number;
}

export type AgentRunReduction =
  RetainedAgentRunReduction | CleanedAgentRunReduction;

export type AgentRunReducerErrorCode =
  | "invalid_input"
  | "invalid_event_header"
  | "chain_broken"
  | "duplicate_conflict"
  | "payload_retention_mixed"
  | "payload_corrupt"
  | "invalid_transition"
  | "terminal_reopen"
  | "unknown_indeterminate_reason"
  | "request_binding_mismatch"
  | "budget_invariant_violated"
  | "settlement_mismatch";

/* ------------------------------------------------------------------ */
/* Repository contracts                                                */
/* ------------------------------------------------------------------ */

export interface AgentRunRepositoryConfig {
  readonly pool: PgCompatiblePool;
  readonly keyRing: SecretKeyRing;
  readonly deploymentRevision: string;
  readonly uuidSource?: () => string;
}

/**
 * The run-operator repository never receives a tenant session, a CSRF value, a
 * tenant selector, or a key ring. Its only configured authority is the restricted
 * run-login role name that the pool must already be authenticated as.
 */
export interface AgentRunOperatorRepositoryConfig {
  readonly pool: PgCompatiblePool;
  readonly runLoginRole: string;
}

interface TenantSessionInput {
  readonly sessionToken: string;
}

interface TenantMutationInput extends TenantSessionInput {
  readonly currentCsrfValue: string;
}

export interface RequestAgentRunInput extends TenantMutationInput {
  readonly dashboardId: string;
  readonly inputSnapshotId: string;
  readonly runRequestId: string;
  readonly purpose: AgentRunPurpose;
  readonly expectedLifecycleRevision: number;
  readonly expectedInputSha256: Uint8Array;
  readonly idempotencySha256: Uint8Array;
  readonly replaySourceRunId: string | null;
}

export interface RequestAgentRunResult {
  readonly runId: string;
  readonly runRevision: number;
  readonly state: AgentRunState;
  readonly policyRevision: number;
  readonly requestSha256: Uint8Array;
}

export interface CancelAgentRunInput extends TenantMutationInput {
  readonly runId: string;
  readonly expectedRunRevision: number;
  /**
   * The caller-retained first-write operation and audit UUID. It is retained
   * byte-identically so that an exact transport retry reconstructs the stored
   * result with zero duplicate DML.
   */
  readonly cancelOperationAndAuditId: string;
}

export interface CancelAgentRunResult {
  readonly runId: string;
  readonly runRevision: number;
  readonly state: AgentRunState;
  readonly eventSequence: number;
  readonly eventSha256: Uint8Array;
}

export interface GetAgentRunInput extends TenantSessionInput {
  readonly runId: string;
}

export interface AgentRunSummary {
  readonly runId: string;
  readonly dashboardId: string;
  readonly state: AgentRunState;
  readonly runRevision: number;
  readonly policyRevision: number;
  readonly requestedAt: Date;
  readonly terminalAt: Date | null;
  readonly latestEventSequence: number;
  readonly latestCheckpointRevision: number | null;
  readonly selectedCandidateId: string | null;
}

export interface ListAgentRunEventsInput extends TenantSessionInput {
  readonly runId: string;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface AgentRunEventSummary {
  readonly runId: string;
  readonly eventSequence: number;
  readonly eventKind: AgentRunEventKind;
  readonly occurredAt: Date;
  readonly eventSha256: Uint8Array;
  readonly payloadAvailable: boolean;
}

export interface GetAgentRunCheckpointInput extends TenantSessionInput {
  readonly runId: string;
}

export interface AgentRunCheckpointProjection {
  readonly found: boolean;
  readonly runId: string;
  readonly checkpointRevision: number | null;
  readonly sourceEventSequence: number | null;
  readonly sourceEventSha256: Uint8Array | null;
  readonly stateSha256: Uint8Array | null;
  readonly checkpointSha256: Uint8Array | null;
  readonly canonicalCheckpointBytes: Uint8Array | null;
}

export interface GetAgentCandidateInput extends TenantSessionInput {
  readonly runId: string;
  readonly candidateId: string;
}

export interface AgentCandidateProjection {
  readonly found: boolean;
  readonly runId: string;
  readonly candidateId: string;
  readonly runState: AgentRunState;
  readonly candidateSha256: Uint8Array | null;
  readonly commonBundleSha256: Uint8Array | null;
  readonly manifestSha256: Uint8Array | null;
  readonly rank: number | null;
  readonly selected: boolean;
  readonly canonicalCandidateBytes: Uint8Array | null;
  readonly canonicalManifestBytes: Uint8Array | null;
}

/* ---------------------------- operator ---------------------------- */

export interface ClaimAgentRunInput {
  readonly claimRequestId: string;
  readonly leaseSeconds: number;
}

export interface AgentRunLeaseHandle {
  readonly organizationId: string;
  readonly dashboardId: string;
  readonly runId: string;
  readonly runRevision: number;
  readonly state: AgentRunState;
  readonly leaseEpoch: number;
  readonly attemptToken: Uint8Array;
  readonly leaseExpiresAt: Date;
  readonly policyRevision: number;
  readonly inputSha256: Uint8Array;
}

export interface TerminalizedIndeterminateHandle {
  readonly organizationId: string;
  readonly dashboardId: string;
  readonly runId: string;
  readonly runRevision: number;
  readonly state: AgentRunState;
  readonly leaseEpoch: number;
  readonly policyRevision: number;
}

export type ClaimAgentRunResult =
  | { readonly status: "claimed"; readonly lease: AgentRunLeaseHandle }
  | {
      readonly status: "terminalized_indeterminate";
      readonly terminal: TerminalizedIndeterminateHandle;
    }
  | { readonly status: "no_eligible_run" };

/** The fence tuple required on every post-claim call. */
export interface AgentRunLeaseFence {
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly attemptToken: Uint8Array;
}

export interface AgentRunMutation {
  readonly runId: string;
  readonly runRevision: number;
  readonly state: AgentRunState;
  readonly eventSequence: number;
  readonly eventSha256: Uint8Array;
  readonly leaseEpoch: number;
}

export interface ClaimedRunInputProjection {
  readonly runId: string;
  readonly purpose: AgentRunPurpose;
  readonly evaluationTime: Date;
  readonly policyRevision: number;
  readonly inputSnapshotId: string;
  readonly inputSha256: Uint8Array;
  readonly inputRowCount: number;
  readonly fieldCatalogSnapshotId: string;
  readonly metricContractSetId: string;
  readonly metricContractSetSha256: Uint8Array;
  readonly generationLimitVector: AttemptResourceVector;
  readonly reviewLimitVector: AttemptResourceVector;
  readonly replaySourceRunId: string | null;
  readonly replaySourceResultCount: number | null;
  readonly replaySourceHeadSequence: number | null;
  readonly replaySourceHeadSha256: Uint8Array | null;
  readonly replaySourceCandidateSetSha256: Uint8Array | null;
  readonly replaySourceBundleId: string | null;
  readonly replaySourceBundleSha256: Uint8Array | null;
  readonly replaySourceBriefId: string | null;
  readonly replaySourceBriefSha256: Uint8Array | null;
  readonly replaySourceSelectedCandidateId: string | null;
  readonly canonicalInputBytes: Uint8Array;
  readonly canonicalRequestBytes: Uint8Array;
}

export interface ReplayPrerequisiteResult {
  readonly mutation: AgentRunMutation;
  readonly sourceRunId: string;
  readonly bundleId: string;
  readonly bundleSha256: Uint8Array;
  readonly briefId: string;
  readonly briefSha256: Uint8Array;
}

export interface ListClaimedReplayResultsInput extends AgentRunLeaseFence {
  readonly afterSourceSequence: number;
  readonly limit: number;
}

export interface ReplaySourceResult {
  readonly sourceRunId: string;
  readonly sourceResultSequence: number;
  readonly sourceResultSha256: Uint8Array;
  readonly resultKind: AgentRunRecordedResultKind;
  readonly canonicalResultBytes: Uint8Array;
}

export interface ConsumeReplayResultInput extends AgentRunLeaseFence {
  readonly sourceResultSequence: number;
  readonly sourceResultSha256: Uint8Array;
}

export interface ReplayConsumeResult {
  readonly mutation: AgentRunMutation;
  readonly sourceResultSequence: number;
  readonly sourceResultSha256: Uint8Array;
  readonly replayResultId: string;
}

export interface WriteCheckpointInput extends AgentRunLeaseFence {
  readonly sourceEventSequence: number;
  readonly sourceEventSha256: Uint8Array;
  readonly canonicalCheckpointBytes: Uint8Array;
}

export interface CheckpointCommitResult {
  readonly mutation: AgentRunMutation;
  readonly checkpointRevision: number;
  readonly stateSha256: Uint8Array;
  readonly checkpointSha256: Uint8Array;
}

export interface ContentCommitResult {
  readonly mutation: AgentRunMutation;
  readonly objectId: string;
  readonly contentSha256: Uint8Array;
}

export interface CommitBriefInput extends AgentRunLeaseFence {
  readonly briefId: string;
  readonly canonicalBriefBytes: Uint8Array;
}

export interface CommitCommonEvidenceBundleInput extends AgentRunLeaseFence {
  readonly bundleId: string;
  readonly canonicalBundleBytes: Uint8Array;
}

export interface ReserveAttemptInput extends AgentRunLeaseFence {
  readonly attemptId: string;
  readonly partition: AgentRunBudgetPartition;
  readonly attemptKind: AgentRunAttemptKind;
  readonly reservedVector: AttemptResourceVector;
  readonly canonicalRequestBytes: Uint8Array;
}

export interface AttemptReservationResult {
  readonly mutation: AgentRunMutation;
  readonly attemptId: string;
  readonly reservedVector: AttemptResourceVector;
}

export interface StartAttemptInput extends AgentRunLeaseFence {
  readonly attemptId: string;
  readonly dispatchRequestSha256: Uint8Array;
}

export interface AttemptStartResult {
  readonly mutation: AgentRunMutation;
  readonly attemptId: string;
  readonly dispatchReadyAt: Date;
}

export interface AuthorizeAttemptInvocationInput extends AgentRunLeaseFence {
  readonly attemptId: string;
  readonly dispatchRequestSha256: Uint8Array;
}

export interface AttemptInvocationResult {
  readonly mutation: AgentRunMutation;
  readonly attemptId: string;
  readonly status: AgentRunInvocationStatus;
  readonly invocationAuthorizedAt: Date | null;
}

/**
 * `actualAccountingBytes` is an opaque byte sequence captured from the adapter.
 * It is transported unchanged to the fixed database parser: it is never decoded,
 * structurally validated, normalized, coerced, hashed, logged, or persisted here.
 */
export type ReconcileAttemptInput = AgentRunLeaseFence &
  (
    | {
        readonly attemptId: string;
        readonly outcome: "succeeded" | "refused" | "failed";
        readonly actualAccountingBytes: Uint8Array;
        readonly resultSha256: Uint8Array;
        readonly canonicalRecordedResultBytes: Uint8Array;
      }
    | {
        readonly attemptId: string;
        readonly outcome: "indeterminate";
      }
  );

export interface AttemptAccountingResult {
  readonly mutation: AgentRunMutation;
  readonly attemptId: string;
  readonly attemptState: AgentRunAttemptState;
  readonly reservedVector: AttemptResourceVector;
  readonly usedVector: AttemptResourceVector;
  readonly releasedVector: AttemptResourceVector;
  readonly outstandingVector: AttemptResourceVector;
}

export interface ReleaseAttemptInput extends AgentRunLeaseFence {
  readonly attemptId: string;
  readonly reason: AgentRunReleaseReason;
  readonly releaseProofSha256: Uint8Array;
}

export interface CalculationMeterVector {
  readonly inputBytes: bigint;
  readonly astBytes: bigint;
  readonly nodeCount: bigint;
  readonly maxDepth: bigint;
  readonly maxLiteralBytes: bigint;
  readonly totalLiteralBytes: bigint;
  readonly maxLiteralListLength: bigint;
  readonly scannedRows: bigint;
  readonly groupCount: bigint;
  readonly maxGroupRows: bigint;
  readonly cumulativeIntermediateRows: bigint;
  readonly finalOutputRows: bigint;
  readonly cumulativeIntermediateBytes: bigint;
  readonly outputBytes: bigint;
  readonly primitiveSteps: bigint;
  readonly logicalAllocationBytes: bigint;
  readonly maxTopK: bigint;
  readonly maxWindowFrame: bigint;
  readonly maxCoefficientDigits: bigint;
  readonly maxScale: bigint;
}

export const CALCULATION_METER_FIELDS = Object.freeze([
  "inputBytes",
  "astBytes",
  "nodeCount",
  "maxDepth",
  "maxLiteralBytes",
  "totalLiteralBytes",
  "maxLiteralListLength",
  "scannedRows",
  "groupCount",
  "maxGroupRows",
  "cumulativeIntermediateRows",
  "finalOutputRows",
  "cumulativeIntermediateBytes",
  "outputBytes",
  "primitiveSteps",
  "logicalAllocationBytes",
  "maxTopK",
  "maxWindowFrame",
  "maxCoefficientDigits",
  "maxScale",
] as const);

export interface CommitCalculationGraphInput extends AgentRunLeaseFence {
  readonly graphId: string;
  readonly canonicalGraphBytes: Uint8Array;
  readonly canonicalResultBytes: Uint8Array;
  readonly meterVector: CalculationMeterVector;
  readonly expectedInputSha256: Uint8Array;
}

export interface CalculationCommitResult {
  readonly mutation: AgentRunMutation;
  readonly graphId: string;
  readonly resultId: string;
  readonly graphSha256: Uint8Array;
  readonly resultSha256: Uint8Array;
  readonly meterVector: CalculationMeterVector;
}

export interface CommitCandidateInput extends AgentRunLeaseFence {
  readonly candidateId: string;
  readonly canonicalDashboardSpecBytes: Uint8Array;
  readonly commonBundleSha256: Uint8Array;
  readonly sourceResultId: string;
  readonly sourceResultSha256: Uint8Array;
  readonly precommitValidationSha256: Uint8Array;
}

export interface CommitValidationFindingsInput extends AgentRunLeaseFence {
  readonly candidateId: string;
  readonly canonicalFindingsBytes: Uint8Array;
}

export interface ValidationFindingsResult {
  readonly mutation: AgentRunMutation;
  readonly candidateId: string;
  readonly findingCount: number;
  readonly findingsSha256: Uint8Array;
  readonly validationState: AgentRunValidationState;
}

export interface CloseCandidateSetInput extends AgentRunLeaseFence {
  readonly orderedCandidateSetSha256: Uint8Array;
}

export interface CandidateSetResult {
  readonly mutation: AgentRunMutation;
  readonly candidateIds: readonly string[];
  readonly candidateCount: number;
  readonly candidateSetSha256: Uint8Array;
}

export interface CommitCandidateClaimsInput extends AgentRunLeaseFence {
  readonly candidateId: string;
  readonly canonicalClaimEdgeSetBytes: Uint8Array;
}

export interface ClaimSetResult {
  readonly mutation: AgentRunMutation;
  readonly candidateId: string;
  readonly claimCount: number;
  readonly edgeCount: number;
  readonly claimSetSha256: Uint8Array;
}

export interface CommitCandidateManifestInput extends AgentRunLeaseFence {
  readonly candidateId: string;
  readonly canonicalManifestBytes: Uint8Array;
  readonly reviewerResultSha256: Uint8Array;
}

export interface CommitRunAbstentionInput extends AgentRunLeaseFence {
  readonly terminalOperationId: string;
  readonly canonicalAbstentionBytes: Uint8Array;
}

export interface FinalizeRankingInput extends AgentRunLeaseFence {
  readonly terminalOperationId: string;
  readonly selectedCandidateId: string;
  readonly rankingProofSha256: Uint8Array;
}

export interface RankingResult {
  readonly mutation: AgentRunMutation;
  readonly selectedCandidateId: string;
  readonly orderedCandidateIds: readonly string[];
  readonly orderedRanks: readonly number[];
  readonly rankingSha256: Uint8Array;
}

export interface FinishRunInput extends AgentRunLeaseFence {
  readonly terminalOperationId: string;
  readonly terminalOutcome: AgentRunTerminalOutcome;
  readonly canonicalReasonBytes: Uint8Array;
}
