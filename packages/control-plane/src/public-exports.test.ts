import { describe, expect, it } from "vitest";

import * as packageRoot from "@dasher/control-plane";
import * as emailExports from "@dasher/control-plane/email";
import * as invitationRepositoryExports from "@dasher/control-plane/invitation-repository";
import * as secretExports from "@dasher/control-plane/secrets";
import * as sessionCookieExports from "@dasher/control-plane/session-cookie";
import * as verifiedPrincipalExports from "@dasher/control-plane/verified-principal";

describe("control-plane Task 5 and 6 public exports", () => {
  it("exposes the expected root symbols", () => {
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
      "VerifiedPrincipal",
      "VerifiedPrincipalError",
      "bootstrapManagedRoles",
      "constantTimeDigestEqual",
      "createSessionCookieMetadata",
      "createVerifiedPrincipalFromServerVerification",
      "discoverMigrations",
      "normalizeEmailAddress",
      "parsePostgresIntegrationEnv",
      "runMigrations",
    ]);
  });

  it("exposes only the expected email runtime symbols", () => {
    expect(Object.keys(emailExports).sort()).toEqual([
      "EmailNormalizationError",
      "normalizeEmailAddress",
    ]);
  });

  it("exposes only the expected secret runtime symbols", () => {
    expect(Object.keys(secretExports).sort()).toEqual([
      "SecretKeyRing",
      "SecretPrimitiveError",
      "constantTimeDigestEqual",
    ]);
  });

  it("exposes only the expected session-cookie runtime symbols", () => {
    expect(Object.keys(sessionCookieExports).sort()).toEqual([
      "SessionCookieMetadataError",
      "createSessionCookieMetadata",
    ]);
  });

  it("exposes only the expected invitation repository runtime symbols", () => {
    expect(Object.keys(invitationRepositoryExports).sort()).toEqual([
      "InvitationRepository",
      "OperationConflictError",
      "OperationDeniedError",
      "OperationInternalError",
    ]);
  });

  it("exposes only the expected verified-principal runtime symbols", () => {
    expect(Object.keys(verifiedPrincipalExports).sort()).toEqual([
      "VerifiedPrincipal",
      "VerifiedPrincipalError",
      "createVerifiedPrincipalFromServerVerification",
    ]);
  });
});
