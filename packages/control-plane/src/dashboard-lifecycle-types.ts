import type { PgCompatiblePool } from "./invitation-repository.js";
import type { SecretKeyRing } from "./secrets.js";

export type DashboardKind = "disposable" | "durable";

export type DashboardLifecycleState =
  | "draft"
  | "active"
  | "archived"
  | "access_revoked"
  | "quarantined"
  | "purge_eligible"
  | "cleaned";

export type DashboardEvidenceKind =
  "source_record" | "typed_value" | "calculation_result" | "event_record";

export type DashboardArtifactOwnershipClass = "dashboard_owned" | "shared";

export type DashboardPromotionDecision = "approved" | "denied";

export type DashboardValidationState = "validated";

export type DashboardCleanupStep =
  | "access_revoked"
  | "drain_and_cancel"
  | "quarantined"
  | "prepare_finalizers"
  | "purge_eligible"
  | "await_purge"
  | "purge_started"
  | "purge_finalizing"
  | "final_proof_ready"
  | "cleaned";

export type DashboardDisposableTtlPreset = 3600 | 86400 | 604800 | 2592000;

export interface DashboardSummary {
  readonly dashboardId: string;
  readonly title: string;
  readonly currentKind: DashboardKind;
  readonly lifecycleState: DashboardLifecycleState;
  readonly lifecycleRevision: number;
  readonly effectiveExpiresAt: Date | null;
  readonly headVersionId: string | null;
}

export interface DashboardVersionProjection {
  readonly dashboardId: string;
  readonly versionId: string;
  readonly parentVersionId: string | null;
  readonly canonicalSpecBytes: Uint8Array;
  readonly canonicalSpecSha256: Uint8Array;
  readonly validationState: DashboardValidationState;
  readonly validationSha256: Uint8Array;
  readonly plannerProvenanceSha256: Uint8Array;
  readonly policyRevision: number;
  readonly registryRevision: number;
  readonly calculationGraphSha256: Uint8Array | null;
  readonly createdAt: Date;
}

export interface DashboardEvidenceProjection {
  readonly dashboardId: string;
  readonly versionId: string;
  readonly evidenceId: string;
  readonly evidenceKind: DashboardEvidenceKind;
  readonly contentSha256: Uint8Array;
  readonly observedAt: Date;
  readonly retrievedAt: Date;
}

export interface DashboardLineageProjection {
  readonly dashboardId: string;
  readonly versionId: string;
  readonly parentVersionId: string | null;
  readonly snapshotId: string | null;
  readonly evidenceId: string | null;
  readonly artifactId: string | null;
  readonly artifactOwnershipClass: DashboardArtifactOwnershipClass | null;
}

export interface DashboardAdminProjection {
  readonly dashboardId: string;
  readonly lifecycleState: DashboardLifecycleState;
  readonly lifecycleRevision: number;
  readonly capabilityEpoch: number;
  readonly cacheEpoch: number;
  readonly accessRevokedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly purgeStartedAt: Date | null;
  readonly purgedAt: Date | null;
  readonly activeHoldCount: number;
  readonly cleanupStep: DashboardCleanupStep | null;
}

export interface DashboardLifecycleRepositoryConfig {
  readonly pool: PgCompatiblePool;
  readonly keyRing: SecretKeyRing;
  readonly deploymentRevision: string;
  readonly uuidSource?: () => string;
}

interface DashboardSessionInput {
  readonly sessionToken: string;
}

interface DashboardMutationInput extends DashboardSessionInput {
  readonly currentCsrfValue: string;
}

export interface ListDashboardsInput extends DashboardSessionInput {
  readonly limit: number;
}

export type ListDashboardsResult = readonly DashboardSummary[];

export interface GetDashboardSummaryInput extends DashboardSessionInput {
  readonly dashboardId: string;
}

export type GetDashboardSummaryResult = DashboardSummary;

export interface GetDashboardHeadInput extends DashboardSessionInput {
  readonly dashboardId: string;
}

export type GetDashboardHeadResult = DashboardVersionProjection;

export interface GetDashboardVersionInput extends DashboardSessionInput {
  readonly dashboardId: string;
  readonly versionId: string;
}

export type GetDashboardVersionResult = DashboardVersionProjection;

export interface GetDashboardEvidenceInput extends DashboardSessionInput {
  readonly dashboardId: string;
  readonly versionId: string;
}

export type GetDashboardEvidenceResult = readonly DashboardEvidenceProjection[];

export interface GetDashboardLineageInput extends DashboardSessionInput {
  readonly dashboardId: string;
  readonly versionId: string;
}

export type GetDashboardLineageResult = readonly DashboardLineageProjection[];

export interface GetDashboardAdminStatusInput extends DashboardSessionInput {
  readonly dashboardId: string;
}

export type GetDashboardAdminStatusResult = DashboardAdminProjection;

interface CreateDashboardBaseInput extends DashboardMutationInput {
  readonly title: string;
}

export type CreateDashboardInput =
  | (CreateDashboardBaseInput & {
      readonly kind: "durable";
    })
  | (CreateDashboardBaseInput & {
      readonly kind: "disposable";
      readonly ttl: DashboardDisposableTtlPreset | "organization_default";
    });

export interface CreateDashboardResult {
  readonly dashboardId: string;
  readonly createdAt: Date;
  readonly effectiveExpiresAt: Date | null;
  readonly effectiveTtlSeconds: number | null;
  readonly usedOrganizationDefault: boolean;
  readonly lifecyclePolicySeeded: boolean;
  readonly lifecyclePolicyRevision: number;
  readonly defaultDisposableTtlSeconds: number;
  readonly retentionPolicyRevision: number;
}

export interface CreateEvidenceRecordInput extends DashboardMutationInput {
  readonly dashboardId: string;
  readonly versionId: string;
  readonly snapshotId: string;
  readonly evidenceKind: DashboardEvidenceKind;
  readonly coordinates: string;
  readonly contentSha256: Uint8Array;
  readonly observedAt: Date;
  readonly retrievedAt: Date;
}

export interface CreateEvidenceRecordResult {
  readonly evidenceId: string;
}

export interface CreateDashboardVersionInput extends DashboardMutationInput {
  readonly dashboardId: string;
  readonly parentVersionId: string | null;
  readonly canonicalSpecBytes: Uint8Array;
  readonly canonicalSpecSha256: Uint8Array;
  readonly validationSha256: Uint8Array;
  readonly plannerProvenanceSha256: Uint8Array;
  readonly policyRevision: number;
  readonly registryRevision: number;
  readonly calculationGraphSha256: Uint8Array | null;
  readonly snapshotIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface CreateDashboardVersionResult {
  readonly versionId: string;
}

export interface CompareAndSwapDashboardHeadInput extends DashboardMutationInput {
  readonly dashboardId: string;
  readonly expectedHeadVersionId: string | null;
  readonly newHeadVersionId: string;
  readonly expectedLifecycleRevision: number;
}

export interface CompareAndSwapDashboardHeadResult {
  readonly lifecycleEventId: string;
}

export interface RequestDashboardPromotionInput extends DashboardMutationInput {
  readonly dashboardId: string;
  readonly expectedLifecycleRevision: number;
  readonly rationaleSha256: Uint8Array;
}

export interface RequestDashboardPromotionResult {
  readonly promotionRequestId: string;
}

export interface DecideDashboardPromotionInput extends DashboardMutationInput {
  readonly promotionRequestId: string;
  readonly expectedLifecycleRevision: number;
  readonly decision: DashboardPromotionDecision;
}

export interface DecideDashboardPromotionResult {
  readonly decision: DashboardPromotionDecision;
  readonly lifecycleEventId: string | null;
}

export interface SetDashboardArchiveInput extends DashboardMutationInput {
  readonly dashboardId: string;
  readonly archived: boolean;
  readonly expectedLifecycleRevision: number;
}

export interface SetDashboardArchiveResult {
  readonly lifecycleEventId: string;
}

export interface DeleteDashboardInput extends DashboardMutationInput {
  readonly dashboardId: string;
  readonly expectedLifecycleRevision: number;
}

export interface DeleteDashboardResult {
  readonly lifecycleEventId: string;
}

export interface RestoreDashboardAsNewInput extends DashboardMutationInput {
  readonly sourceDashboardId: string;
  readonly sourceVersionId: string;
  readonly expectedSourceLifecycleRevision: number;
  readonly title: string;
  readonly provenanceSha256: Uint8Array;
}

export interface RestoreDashboardAsNewResult {
  readonly dashboardId: string;
  readonly versionId: string;
}
