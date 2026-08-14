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
