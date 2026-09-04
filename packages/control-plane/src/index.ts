export {
  IntegrationPreflightError,
  POSTGRES_INTEGRATION_ENV_NAMES,
  parsePostgresIntegrationEnv,
  type IntegrationPreflightErrorCode,
  type PostgresIntegrationConfig,
  type PostgresIntegrationEnvironment,
} from "./preflight";

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
} from "./migrator";

export {
  EmailNormalizationError,
  normalizeEmailAddress,
  type EmailNormalizationErrorCode,
} from "./email";

export {
  SessionCookieMetadataError,
  createSessionCookieMetadata,
  type SessionCookieMetadata,
  type SessionCookieMetadataErrorCode,
} from "./session-cookie";

export { renderSchemaSnapshot } from "./schema-snapshot";

// `request-context.ts` is deliberately NOT exported. Its handle still accepts
// SQL, and a generic data-access capability in the public API is one import
// away from becoming an application's data layer. The public surface will be a
// repository facade that closes over a handle and exposes named domain
// operations; it cannot be designed until something persists. Until then this
// module is internal to the package and reachable only by its own tests.

export {
  DashboardRepositoryError,
  withDashboardRepository,
  type DashboardListEntry,
  type DashboardRepository,
  type DashboardRepositoryErrorCode,
  type LoadedDashboard,
  type LoadedSourceSnapshot,
  type PersistedClaim,
  type RecordEvidenceInput,
  type RecordSourceSnapshotInput,
  type SaveDashboardInput,
  type SavedDashboard,
} from "./dashboard-repository";

export {
  checkRestore,
  formatRestoreCheck,
  runRestoreCheck,
  type RestoreCheckCounts,
  type RestoreCheckResult,
} from "./restore-check";

export {
  parseProvisionArgs,
  provisionPrincipal,
  type ProvisionOptions,
  type ProvisionedPrincipal,
} from "./provision-cli";

export {
  beginSignIn,
  decodeSignInToken,
  encodeSignInToken,
  redeemSignIn,
  revokeSession,
  SIGN_IN_LINK_MINUTES,
  type IssuedSignInLink,
  type RedeemedSignIn,
  type SignInRequest,
} from "./sign-in";

export {
  seedDevPrincipal,
  type DevPrincipalSeed,
  type DevSeedOptions,
} from "./dev-seed";
