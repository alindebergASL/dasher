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

export { renderSchemaSnapshot } from "./schema-snapshot.js";

// `request-context.ts` is deliberately NOT exported. Its handle still accepts
// SQL, and a generic data-access capability in the public API is one import
// away from becoming an application's data layer. The public surface will be a
// repository facade that closes over a handle and exposes named domain
// operations; it cannot be designed until something persists. Until then this
// module is internal to the package and reachable only by its own tests.

export {
  DashboardRepositoryError,
  withDashboardRepository,
  type DashboardRepository,
  type DashboardRepositoryErrorCode,
  type LoadedDashboard,
  type SaveDashboardInput,
  type SavedDashboard,
} from "./dashboard-repository.js";

export {
  seedDevPrincipal,
  type DevPrincipalSeed,
  type DevSeedOptions,
} from "./dev-seed.js";
