export {
  IntegrationPreflightError,
  POSTGRES_INTEGRATION_ENV_NAMES,
  parsePostgresIntegrationEnv,
  type IntegrationPreflightErrorCode,
  type PostgresIntegrationConfig,
  type PostgresIntegrationEnvironment,
} from "./preflight.js";

export {
  MigrationContractError,
  bootstrapManagedRoles,
  discoverMigrations,
  runMigrations,
  type DiscoveredMigration,
  type MigrationClient,
  type MigrationContractErrorCode,
  type MigrationPool,
  type MigrationRunResult,
} from "./migrator.js";

export {
  SecretKeyRing,
  SecretPrimitiveError,
  constantTimeDigestEqual,
  type IssuedSecret,
  type SecretKeyRingConfig,
  type SecretKind,
  type SecretPersistenceMaterial,
  type SecretPrimitiveErrorCode,
} from "./secrets.js";

export {
  EmailNormalizationError,
  normalizeEmailAddress,
  type EmailNormalizationErrorCode,
} from "./email.js";

export {
  SessionCookieMetadataError,
  createSessionCookieMetadata,
  type SessionCookieMetadata,
  type SessionCookieMetadataErrorCode,
} from "./session-cookie.js";

export {
  VerifiedPrincipal,
  VerifiedPrincipalError,
  createVerifiedPrincipalFromServerVerification,
  type ServerVerifiedPrincipalInput,
  type VerifiedPrincipalErrorCode,
} from "./verified-principal.js";

export {
  InvitationRepository,
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  type AcceptInvitationInput,
  type AcceptInvitationResult,
  type InvitationRepositoryConfig,
  type InvitationRole,
  type InvitationSecurityEvent,
  type InvitationSecurityEventSink,
  type IssueInvitationInput,
  type IssueInvitationResult,
  type OperationInternalOutcome,
  type PgCompatibleClient,
  type PgCompatiblePool,
  type PgCompatibleQueryResult,
  type SecurityEventReason,
} from "./invitation-repository.js";

export {
  SessionRepository,
  type ChangeMembershipRoleInput,
  type ChangeMembershipRoleResult,
  type IssueSessionInput,
  type IssueSessionResult,
  type ResolveSessionInput,
  type ResolveSessionResult,
  type RevokeMembershipInput,
  type RevokeMembershipResult,
  type RevokeSessionInput,
  type RevokeSessionResult,
  type RotateSessionInput,
  type RotateSessionResult,
  type SessionRepositoryConfig,
  type SessionRole,
  type SessionSecurityEvent,
  type SessionSecurityEventReason,
  type SessionSecurityEventSink,
} from "./session-repository.js";

export { DashboardLifecycleRepository } from "./dashboard-lifecycle-repository.js";

export type {
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
  DashboardDisposableTtlPreset,
  DashboardEvidenceKind,
  DashboardEvidenceProjection,
  DashboardKind,
  DashboardLifecycleRepositoryConfig,
  DashboardLifecycleState,
  DashboardLineageProjection,
  DashboardPromotionDecision,
  DashboardSummary,
  DashboardValidationState,
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
