import { describe, expect, it } from "vitest";

import * as packageRoot from "@dasher/control-plane";
import * as emailExports from "@dasher/control-plane/email";
import * as invitationRepositoryExports from "@dasher/control-plane/invitation-repository";
import * as migratorExports from "@dasher/control-plane/migrator";
import * as secretExports from "@dasher/control-plane/secrets";
import * as sessionCookieExports from "@dasher/control-plane/session-cookie";
import * as sessionRepositoryExports from "@dasher/control-plane/session-repository";
import * as verifiedPrincipalExports from "@dasher/control-plane/verified-principal";

describe("control-plane public exports", () => {
  it("exposes exactly the expected root symbols", () => {
    expect(Object.keys(packageRoot).sort()).toEqual([
      "EmailNormalizationError",
      "IntegrationPreflightError",
      "InvitationRepository",
      "MigrationContractError",
      "OperationConflictError",
      "OperationDeniedError",
      "OperationInternalError",
      "POSTGRES_INTEGRATION_ENV_NAMES",
      "SecretKeyRing",
      "SecretPrimitiveError",
      "SessionCookieMetadataError",
      "SessionRepository",
      "VerifiedPrincipal",
      "VerifiedPrincipalError",
      "bootstrapManagedRoles",
      "constantTimeDigestEqual",
      "createSessionCookieMetadata",
      "createVerifiedPrincipalFromServerVerification",
      "discoverMigrations",
      "normalizeEmailAddress",
      "parsePostgresIntegrationEnv",
      "renderSchemaSnapshot",
      "runMigrations",
    ]);
  });

  it("does not re-export anything from the removed agent-run or lifecycle surfaces", () => {
    const removed = Object.keys(packageRoot).filter(
      (name) =>
        name.startsWith("AgentRun") ||
        name.startsWith("agentRun") ||
        name.startsWith("AGENT_RUN") ||
        name.startsWith("Dashboard"),
    );
    expect(removed).toEqual([]);
  });

  it("keeps each subpath entry point loadable", () => {
    expect(Object.keys(migratorExports)).toContain("runMigrations");
    expect(Object.keys(secretExports)).toContain("SecretKeyRing");
    expect(Object.keys(emailExports)).toContain("normalizeEmailAddress");
    expect(Object.keys(sessionCookieExports)).toContain(
      "createSessionCookieMetadata",
    );
    expect(Object.keys(sessionRepositoryExports)).toContain(
      "SessionRepository",
    );
    expect(Object.keys(invitationRepositoryExports)).toContain(
      "InvitationRepository",
    );
    expect(Object.keys(verifiedPrincipalExports)).toContain(
      "VerifiedPrincipal",
    );
  });
});
