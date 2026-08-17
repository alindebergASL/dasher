import { describe, expect, it } from "vitest";

import * as packageRoot from "@dasher/control-plane";
import * as emailExports from "@dasher/control-plane/email";
import * as migratorExports from "@dasher/control-plane/migrator";
import * as secretExports from "@dasher/control-plane/secrets";
import * as sessionCookieExports from "@dasher/control-plane/session-cookie";
import * as verifiedPrincipalExports from "@dasher/control-plane/verified-principal";

describe("control-plane public exports", () => {
  it("exposes exactly the expected root symbols", () => {
    expect(Object.keys(packageRoot).sort()).toEqual([
      "EmailNormalizationError",
      "IntegrationPreflightError",
      "MigrationContractError",
      "POSTGRES_INTEGRATION_ENV_NAMES",
      "SecretKeyRing",
      "SecretPrimitiveError",
      "SessionCookieMetadataError",
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

  it("does not expose the generic transaction capability", () => {
    // `withRequestContext` hands its callback a handle whose `query` takes SQL.
    // Exported, that is a generic data-access capability any caller can reach,
    // and the repository facade that should own it never gets written. It stays
    // internal until named domain operations exist to expose instead.
    const names = Object.keys(packageRoot);
    expect(names).not.toContain("withRequestContext");
    expect(names).not.toContain("RequestContextError");
    expect(names.filter((name) => name.startsWith("Request"))).toEqual([]);
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
    expect(Object.keys(verifiedPrincipalExports)).toContain(
      "VerifiedPrincipal",
    );
  });
});
