import { describe, expect, it } from "vitest";

import * as packageRoot from "@dasher/control-plane";
import * as agentRunReducerExports from "@dasher/control-plane/agent-run-reducer";
import * as agentRunRepositoryExports from "@dasher/control-plane/agent-run-repository";
import * as agentRunTypeExports from "@dasher/control-plane/agent-run-types";
import * as emailExports from "@dasher/control-plane/email";
import * as invitationRepositoryExports from "@dasher/control-plane/invitation-repository";
import * as secretExports from "@dasher/control-plane/secrets";
import * as sessionCookieExports from "@dasher/control-plane/session-cookie";
import * as sessionRepositoryExports from "@dasher/control-plane/session-repository";
import * as verifiedPrincipalExports from "@dasher/control-plane/verified-principal";

describe("control-plane Task 5 through 9D public exports", () => {
  it("exposes the expected root symbols", () => {
    expect(Object.keys(packageRoot).sort()).toEqual([
      "AGENT_RUN_BUDGET_PARTITIONS",
      "AGENT_RUN_INDETERMINATE_REASONS",
      "AGENT_RUN_TERMINAL_STATES",
      "AGENT_RUN_VECTOR_FIELDS",
      "AgentRunReducerError",
      "AgentRunRepository",
      "DashboardLifecycleRepository",
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
      "agentRunCheckpointStateSha256",
      "agentRunEventSemanticSha256",
      "agentRunEventSha256",
      "agentRunRetainedEnvelopeSha256",
      "bootstrapManagedRoles",
      "constantTimeDigestEqual",
      "createSessionCookieMetadata",
      "createVerifiedPrincipalFromServerVerification",
      "discoverMigrations",
      "normalizeEmailAddress",
      "parsePostgresIntegrationEnv",
      "reduceAgentRun",
      "runMigrations",
    ]);
  });

  it("exposes only the expected agent run repository runtime symbols", () => {
    expect(Object.keys(agentRunRepositoryExports).sort()).toEqual([
      "AgentRunOperatorRepository",
      "AgentRunRepository",
    ]);
  });

  it("exposes only the expected agent run reducer runtime symbols", () => {
    expect(Object.keys(agentRunReducerExports).sort()).toEqual([
      "AGENT_RUN_EVENT_KINDS",
      "AgentRunReducerError",
      "agentRunCheckpointStateSha256",
      "agentRunEventSemanticSha256",
      "agentRunEventSha256",
      "agentRunRetainedEnvelopeSha256",
      "reduceAgentRun",
    ]);
  });

  it("exposes only frozen agent run vocabulary constants", () => {
    expect(Object.keys(agentRunTypeExports).sort()).toEqual([
      "AGENT_RUN_ATTEMPT_RELEASE_MODES",
      "AGENT_RUN_BUDGET_PARTITIONS",
      "AGENT_RUN_INDETERMINATE_REASONS",
      "AGENT_RUN_TERMINAL_STATES",
      "AGENT_RUN_VECTOR_FIELDS",
      "CALCULATION_METER_FIELDS",
    ]);
    for (const value of Object.values(agentRunTypeExports)) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("keeps every operator, retention and private seam out of the root", () => {
    expect(Object.keys(packageRoot)).not.toContain(
      "AgentRunOperatorRepository",
    );
    expect(
      Object.keys(packageRoot).some((name) =>
        /retention|operator|private|legal.?hold|purge/i.test(name),
      ),
    ).toBe(false);
    expect(agentRunRepositoryExports.AgentRunOperatorRepository).toBeTypeOf(
      "function",
    );
  });

  it("exposes no run SQL, credential, tool, publication or schedule symbol", () => {
    const forbidden = [
      "appendAgentRunEvent",
      "claimAgentRunSql",
      "providerCredentials",
      "runBudgetOverride",
      "runToolManifest",
      "publishAgentCandidate",
      "scheduleAgentRun",
      "updateDashboardHead",
    ];
    for (const name of forbidden) {
      expect(Object.keys(packageRoot)).not.toContain(name);
      expect(Object.keys(agentRunRepositoryExports)).not.toContain(name);
      expect(Object.keys(agentRunReducerExports)).not.toContain(name);
    }
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

  it("exposes only the expected session repository runtime symbols", () => {
    expect(Object.keys(sessionRepositoryExports).sort()).toEqual([
      "SessionRepository",
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
