import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import {
  discoverMigrations,
  getCanonical0004ExactCatalogContractForTests,
  getCanonical0005ExactCatalogContractForTests,
  getCanonical0006ExactCatalogContractForTests,
  getModeled0003StaticCatalogContractForTests,
} from "./migrator.js";
import {
  modeled0003CatalogMatrix,
  modeled0003CheckConstraints,
  modeled0003ColumnCatalog,
  modeled0003FixtureIds,
  modeled0003Functions,
  modeled0003ManagedRoles,
  modeled0003NonNullableColumnIdentities,
  modeled0003NullableColumnIdentities,
  modeled0003Policies,
  modeled0003SafetyMatrix,
} from "../test/fixtures/migrations-0003-allowlist/modeled-0003-inventory.js";

const canonicalMigrationDirectory = new URL("../migrations", import.meta.url)
  .pathname;
const initializerBarrierHarness = new URL(
  "../test/fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
  import.meta.url,
);
const migratorSource = new URL("./migrator.ts", import.meta.url);
const modeledInventorySource = new URL(
  "../test/fixtures/migrations-0003-allowlist/modeled-0003-inventory.ts",
  import.meta.url,
);
const task9PlanSource = new URL(
  "../../../docs/plans/2026-08-04-agent-run-ledger-and-deterministic-calculations.md",
  import.meta.url,
);

function hasExactBindingCardinalityProof(source: string): boolean {
  const normalized = source.replace(/\s+/gu, " ").trim();
  return (
    /binding_proof AS \( SELECT count\(DISTINCT retention_service_principal_id\) AS distinct_principal_count, max\(principal_revision\) AS max_principal_revision FROM exact_binding \)/u.test(
      normalized,
    ) &&
    /unique_latest AS \( SELECT authority[.]\* FROM exact_binding AS authority CROSS JOIN binding_proof AS proof WHERE proof[.]distinct_principal_count = 1 AND authority[.]principal_revision = proof[.]max_principal_revision AND \( SELECT count\(\*\) FROM exact_binding AS latest WHERE latest[.]principal_revision = proof[.]max_principal_revision \) = 1 \)/u.test(
      normalized,
    ) &&
    !/\bDISTINCT ON\b|\bLIMIT\b|ORDER BY\s+(?:authority[.])?principal_revision/iu.test(
      normalized,
    )
  );
}

function weakenBindingCardinalityProofs(source: string): readonly string[] {
  return [
    source.replace("count(DISTINCT retention_service_principal_id)", "1"),
    source.replace("proof.distinct_principal_count = 1", "true"),
    source.replace(
      "proof.distinct_principal_count = 1",
      "proof.distinct_principal_count >= 1",
    ),
    source.replace(
      "      AND (\n        SELECT count(*)\n        FROM exact_binding AS latest\n        WHERE latest.principal_revision = proof.max_principal_revision\n      ) = 1\n",
      "",
    ),
    source.replace("      ) = 1\n", "      ) >= 1\n"),
  ];
}

function markedSourceSection(
  source: string,
  begin: string,
  end: string,
): string {
  const beginIndex = source.indexOf(begin);
  const endIndex = source.indexOf(end, beginIndex + begin.length);
  if (beginIndex < 0 || endIndex < 0) return "";
  return source.slice(beginIndex + begin.length, endIndex);
}

function containsFragmentsInOrder(
  source: string,
  fragments: readonly string[],
): boolean {
  const positions = fragments.map((fragment) => source.indexOf(fragment));
  return (
    positions.every((position) => position >= 0) &&
    positions.every(
      (position, index) => index === 0 || position > positions[index - 1]!,
    )
  );
}

const mutationMinimumRoleContract = [
  { name: "create_dashboard", role: "editor" },
  { name: "create_evidence_record", role: "editor" },
  { name: "create_dashboard_version", role: "editor" },
  { name: "compare_and_swap_dashboard_head", role: "editor" },
  { name: "request_dashboard_promotion", role: "editor" },
  { name: "decide_dashboard_promotion", role: "admin" },
  { name: "set_dashboard_archive", role: "admin" },
  { name: "delete_dashboard", role: "admin" },
  { name: "restore_dashboard_as_new", role: "admin" },
] as const;

function hasExactPreTenantMutationRoleGate(
  source: string,
  minimumRole: "admin" | "editor",
): boolean {
  const gates = [
    ...source.matchAll(
      /dasher_private[.]context_allows\(([^,]+), '([^']+)'\)/gu,
    ),
  ];
  const gateText = `dasher_private.context_allows(v_organization_id, '${minimumRole}')`;
  const gate = source.indexOf(gateText);
  const gateIf = source.lastIndexOf("IF NOT ", gate);
  const gateEnd = source.indexOf("  END IF;", gate);
  const firstTenantWork = source.search(
    /\b(?:FROM|JOIN|UPDATE|DELETE FROM|INSERT INTO)\s+dasher[.](?!private\b)/u,
  );
  return (
    gates.length === 1 &&
    gates[0]?.[1]?.trim() === "v_organization_id" &&
    gates[0]?.[2] === minimumRole &&
    gate >= 0 &&
    gateIf >= 0 &&
    source.slice(gateIf, gate).trim() === "IF NOT" &&
    gateEnd > gate &&
    source
      .slice(gate, gateEnd)
      .includes("ERRCODE = 'P1001', MESSAGE = 'dasher_denied'") &&
    firstTenantWork > gateEnd
  );
}

function authoritativeMaterialization(source: string): string {
  const materialization = source.indexOf("  RETURN QUERY\n");
  if (
    materialization < 0 ||
    source.indexOf("  RETURN QUERY\n", materialization + 1) >= 0
  ) {
    return "";
  }
  return source.slice(materialization);
}

function hasAtomicEvidenceProjection(source: string): boolean {
  const finalStatement = authoritativeMaterialization(source);
  return (
    finalStatement.length > 0 &&
    containsFragmentsInOrder(finalStatement, [
      "FROM dasher.dashboard_version_evidence AS link",
      "JOIN dasher.evidence_records AS evidence",
      "JOIN dasher.dashboard_versions AS version",
      "JOIN dasher.dashboards AS dashboard",
      "dashboard.organization_id = dasher_private.context_organization_id()",
      "dashboard.dashboard_id = $1",
      "version.dashboard_id = $1 AND version.version_id = $2",
      "link.dashboard_id = $1 AND link.version_id = $2",
      "version.validation_state = 'validated'",
      "dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL",
      "v_now < dashboard.effective_expires_at",
      "dashboard.effective_expires_at IS NULL",
      "FROM dasher.snapshot_reference_claims AS version_claim",
      "version_claim.organization_id = version.organization_id",
      "version_claim.dashboard_id = version.dashboard_id",
      "version_claim.version_id = version.version_id",
      "version_claim.claim_kind = 'access_bearing'",
      "version_claim.hold_id IS NULL",
      "FROM dasher.dashboard_version_snapshots AS missing_snapshot",
      "FROM dasher.dashboard_version_evidence AS missing_evidence",
      "FROM dasher.dashboard_version_snapshots AS source_link",
      "JOIN dasher.snapshot_reference_claims AS source_claim",
      "source_link.snapshot_id = evidence.snapshot_id",
      "FROM dasher.evidence_reference_claims AS evidence_claim",
      "ORDER BY evidence.evidence_id;",
      "IF NOT FOUND THEN",
      "ERRCODE = 'P1001', MESSAGE = 'dasher_denied'",
    ]) &&
    finalStatement.includes(
      "missing_claim.dashboard_id = missing_evidence.dashboard_id",
    ) &&
    finalStatement.includes(
      "missing_claim.version_id = missing_evidence.version_id",
    ) &&
    finalStatement.includes(
      "evidence_claim.dashboard_id = link.dashboard_id",
    ) &&
    finalStatement.includes("evidence_claim.version_id = link.version_id")
  );
}

function hasAtomicLineageProjection(source: string): boolean {
  const finalStatement = authoritativeMaterialization(source);
  return (
    finalStatement.length > 0 &&
    containsFragmentsInOrder(finalStatement, [
      "FROM dasher.dashboard_versions AS version",
      "LEFT JOIN dasher.dashboard_version_snapshots AS snapshot",
      "LEFT JOIN dasher.dashboard_version_evidence AS evidence",
      "LEFT JOIN dasher.dashboard_artifacts AS artifact",
      "JOIN dasher.dashboards AS dashboard",
      "dashboard.organization_id = dasher_private.context_organization_id()",
      "dashboard.dashboard_id = $1",
      "version.dashboard_id = $1 AND version.version_id = $2",
      "version.validation_state = 'validated'",
      "dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL",
      "v_now < dashboard.effective_expires_at",
      "dashboard.effective_expires_at IS NULL",
      "FROM dasher.snapshot_reference_claims AS version_claim",
      "version_claim.organization_id = version.organization_id",
      "version_claim.dashboard_id = version.dashboard_id",
      "version_claim.version_id = version.version_id",
      "version_claim.claim_kind = 'access_bearing'",
      "version_claim.hold_id IS NULL",
      "version.parent_version_id IS NULL OR EXISTS",
      "FROM dasher.dashboard_versions AS parent",
      "FROM dasher.snapshot_reference_claims AS parent_claim",
      "dashboard.head_version_id IS NULL OR EXISTS",
      "FROM dasher.dashboard_versions AS head",
      "FROM dasher.snapshot_reference_claims AS head_claim",
      "FROM dasher.dashboard_version_snapshots AS missing_snapshot",
      "FROM dasher.dashboard_version_evidence AS missing_evidence",
      "FROM dasher.dashboard_artifacts AS missing_artifact",
      "FROM dasher.snapshot_reference_claims AS snapshot_claim",
      "FROM dasher.evidence_reference_claims AS evidence_claim",
      "FROM dasher.artifact_reference_claims AS artifact_claim",
      "ORDER BY snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id;",
      "IF NOT FOUND THEN",
      "ERRCODE = 'P1001', MESSAGE = 'dasher_denied'",
    ]) &&
    finalStatement.includes(
      "snapshot_claim.dashboard_id = version.dashboard_id",
    ) &&
    finalStatement.includes("snapshot_claim.version_id = version.version_id") &&
    finalStatement.includes(
      "evidence_claim.dashboard_id = version.dashboard_id",
    ) &&
    finalStatement.includes(
      "artifact_claim.dashboard_id = version.dashboard_id",
    )
  );
}

function hasExactHarnessArtifactHelperExecuteAcl(source: string): boolean {
  const helperSection = markedSourceSection(
    source,
    "CREATE FUNCTION task8a_retention_barrier.artifact_expected_claim_hash(",
    "CREATE FUNCTION task8a_retention_barrier.artifact_is_governable(",
  );
  const aclStatements = [
    ...helperSection.matchAll(/\b(?:GRANT|REVOKE)\b[\s\S]*?;/gu),
  ].map((match) => match[0].replace(/\s+/gu, " ").trim());
  return isDeepStrictEqual(aclStatements, [
    "REVOKE ALL ON FUNCTION task8a_retention_barrier.artifact_expected_claim_hash(uuid, uuid, uuid) FROM PUBLIC;",
    "GRANT EXECUTE ON FUNCTION task8a_retention_barrier.artifact_expected_claim_hash(uuid, uuid, uuid) TO task8a_security_harness_definer;",
  ]);
}

type ExactModeledFunction = Readonly<{
  defaults: readonly string[];
  execute: readonly string[];
  identityArguments: string;
  language: string;
  name: string;
  owner: string;
  proconfig: readonly string[];
  returns: string;
  schema: string;
  securityDefiner: boolean;
  source: string;
  variadic: boolean;
  volatility: string;
}>;

const exactModeled0003FunctionIdentities = [
  "dasher_api.list_dashboards(integer)",
  "dasher_api.get_dashboard_summary(uuid)",
  "dasher_api.get_dashboard_head(uuid)",
  "dasher_api.get_dashboard_version(uuid, uuid)",
  "dasher_api.get_dashboard_evidence(uuid, uuid)",
  "dasher_api.get_dashboard_lineage(uuid, uuid)",
  "dasher_api.get_dashboard_admin_status(uuid)",
  "dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text)",
  "dasher_api.create_evidence_record(uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text)",
  "dasher_api.create_dashboard_version(uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, text)",
  "dasher_api.compare_and_swap_dashboard_head(uuid, uuid, uuid, bigint, uuid, text)",
  "dasher_api.request_dashboard_promotion(uuid, uuid, bigint, bytea, uuid, text)",
  "dasher_api.decide_dashboard_promotion(uuid, bigint, text, uuid, uuid, text)",
  "dasher_api.set_dashboard_archive(uuid, boolean, bigint, uuid, text)",
  "dasher_api.delete_dashboard(uuid, bigint, uuid, text)",
  "dasher_api.restore_dashboard_as_new(uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text)",
  "dasher_retention_api.initialize_operator_context(uuid, text, uuid, text, uuid)",
  "dasher_retention_api.materialize_dashboard_expiry(uuid, bigint, uuid, text, uuid)",
  "dasher_retention_api.place_dashboard_legal_hold(uuid, uuid, text, bytea, bigint, uuid, text, uuid)",
  "dasher_retention_api.release_dashboard_legal_hold(uuid, uuid, bytea, bigint, uuid, text, uuid)",
  "dasher_retention_api.claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid)",
  "dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid)",
  "dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid)",
  "dasher_private.reject_dashboard_append_mutation()",
  "dasher_private.enforce_dashboard_transition()",
  "dasher_private.enforce_retention_mutation()",
] as const;

const exactModeledFunctionDimensions = [
  "schema",
  "name",
  "identityArguments",
  "returns",
  "language",
  "volatility",
  "securityDefiner",
  "owner",
  "proconfig",
  "execute",
  "defaults",
  "variadic",
  "source",
] as const satisfies readonly (keyof ExactModeledFunction)[];

function exactModeledFunctionIdentity(routine: ExactModeledFunction): string {
  return `${routine.schema}.${routine.name}(${routine.identityArguments})`;
}

function exactModeledFunctionBridgeMismatches(
  semanticFunctions: readonly ExactModeledFunction[],
  catalogFunctions: readonly ExactModeledFunction[],
): readonly string[] {
  const mismatches: string[] = [];
  const expectedIdentities = new Set<string>(
    exactModeled0003FunctionIdentities,
  );
  const semanticIdentities = semanticFunctions.map(
    exactModeledFunctionIdentity,
  );
  const catalogIdentities = catalogFunctions.map(exactModeledFunctionIdentity);

  for (const [side, identities] of [
    ["semantic", semanticIdentities],
    ["catalog", catalogIdentities],
  ] as const) {
    for (const identity of exactModeled0003FunctionIdentities) {
      const count = identities.filter(
        (candidate) => candidate === identity,
      ).length;
      if (count !== 1) mismatches.push(`${side}:${identity}:count=${count}`);
    }
    for (const identity of identities) {
      if (!expectedIdentities.has(identity)) {
        mismatches.push(`${side}:${identity}:unexpected`);
      }
    }
  }

  for (const identity of exactModeled0003FunctionIdentities) {
    const semanticMatches = semanticFunctions.filter(
      (routine) => exactModeledFunctionIdentity(routine) === identity,
    );
    const catalogMatches = catalogFunctions.filter(
      (routine) => exactModeledFunctionIdentity(routine) === identity,
    );
    if (semanticMatches.length !== 1 || catalogMatches.length !== 1) continue;
    const semantic = semanticMatches[0]!;
    const catalog = catalogMatches[0]!;
    for (const dimension of exactModeledFunctionDimensions) {
      if (!isDeepStrictEqual(semantic[dimension], catalog[dimension])) {
        mismatches.push(`${identity}:${dimension}`);
      }
    }
  }

  return mismatches;
}

type ExactModeledPolicy = Readonly<{
  bootstrap: boolean;
  catalogCommand: string;
  command: string;
  name: string;
  permissive: boolean;
  relation: string;
  roles: readonly string[];
  shutsOffWhenPhase: string | null;
  using: string | null;
  withCheck: string | null;
}>;

const exactModeledPolicyDimensions = [
  "name",
  "relation",
  "command",
  "catalogCommand",
  "permissive",
  "roles",
  "bootstrap",
  "shutsOffWhenPhase",
  "using",
  "withCheck",
] as const satisfies readonly (keyof ExactModeledPolicy)[];

function exactModeledPolicyIdentity(policy: ExactModeledPolicy): string {
  return `dasher.${policy.relation}.${policy.name}`;
}

function exactModeledPolicyBridgeMismatches(
  sources: readonly Readonly<{
    label: string;
    policies: readonly ExactModeledPolicy[];
  }>[],
): readonly string[] {
  const mismatches: string[] = [];
  const identities = new Set(
    sources.flatMap(({ policies }) => policies.map(exactModeledPolicyIdentity)),
  );

  for (const identity of identities) {
    const matches = sources.map(({ label, policies }) => {
      const exact = policies.filter(
        (policy) => exactModeledPolicyIdentity(policy) === identity,
      );
      if (exact.length !== 1) {
        mismatches.push(`${label}:${identity}:count=${exact.length}`);
      }
      return exact;
    });
    if (matches.some((exact) => exact.length !== 1)) continue;

    const baseline = matches[0]![0]!;
    for (let sourceIndex = 1; sourceIndex < sources.length; sourceIndex += 1) {
      const candidate = matches[sourceIndex]![0]!;
      for (const dimension of exactModeledPolicyDimensions) {
        if (!isDeepStrictEqual(baseline[dimension], candidate[dimension])) {
          mismatches.push(
            `${sources[0]!.label}<->${sources[sourceIndex]!.label}:${identity}:${dimension}`,
          );
        }
      }
    }
  }

  return mismatches;
}

type ExactModeledPolicyDependencyRow = Readonly<{
  catalog: string;
  command: string;
  dependencyType: string;
  identity: string;
  objectKind: string;
  permissive: boolean;
  roleName: string;
  roles: readonly string[];
  using: string | null;
  withCheck: string | null;
}>;

const exactModeledPolicyDependencyDimensions = [
  "dependencyType",
  "catalog",
  "objectKind",
  "identity",
  "roleName",
  "roles",
  "command",
  "permissive",
  "using",
  "withCheck",
] as const satisfies readonly (keyof ExactModeledPolicyDependencyRow)[];

function exactModeledPolicyDependencyMismatches(
  policies: readonly ExactModeledPolicy[],
  rows: readonly ExactModeledPolicyDependencyRow[],
): readonly string[] {
  const mismatches: string[] = [];
  const identities = new Set([
    ...policies.map(exactModeledPolicyIdentity),
    ...rows.map(({ identity }) => identity),
  ]);

  for (const identity of identities) {
    const policyMatches = policies.filter(
      (policy) => exactModeledPolicyIdentity(policy) === identity,
    );
    const rowMatches = rows.filter((row) => row.identity === identity);
    if (policyMatches.length !== 1) {
      mismatches.push(`policy:${identity}:count=${policyMatches.length}`);
    }
    if (rowMatches.length !== 1) {
      mismatches.push(`dependency:${identity}:count=${rowMatches.length}`);
    }
    if (policyMatches.length !== 1 || rowMatches.length !== 1) continue;

    const policy = policyMatches[0]!;
    const row = rowMatches[0]!;
    const expected: ExactModeledPolicyDependencyRow = {
      dependencyType: "r",
      catalog: "pg_policy",
      objectKind: "policy",
      identity,
      roleName: policy.roles[0] ?? "<missing-role>",
      roles: policy.roles,
      command: policy.catalogCommand,
      permissive: policy.permissive,
      using: policy.using,
      withCheck: policy.withCheck,
    };
    if (policy.roles.length !== 1) {
      mismatches.push(`${identity}:roles:count=${policy.roles.length}`);
    }
    for (const dimension of exactModeledPolicyDependencyDimensions) {
      if (!isDeepStrictEqual(row[dimension], expected[dimension])) {
        mismatches.push(`${identity}:${dimension}`);
      }
    }
  }

  return mismatches;
}

const exactSnapshotFinalizerPolicyExpression =
  "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name)))))";
const exactEvidenceFinalizerPolicyExpression =
  "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name)))))";
const exactArtifactFinalizerPolicyExpression =
  "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(artifact_id)) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name)))))";

type ExactFinalizerPolicyClause = Readonly<{
  catalogCommand: string;
  clause: "using" | "withCheck";
  command: string;
  expression: string;
  name: string;
  relation: string;
}>;

const exactFinalizerPolicyClauses = [
  {
    name: "snapshot_deletion_finalizers_retention_select",
    relation: "snapshot_deletion_finalizers",
    command: "SELECT",
    catalogCommand: "r",
    clause: "using",
    expression: exactSnapshotFinalizerPolicyExpression,
  },
  {
    name: "snapshot_deletion_finalizers_retention_insert",
    relation: "snapshot_deletion_finalizers",
    command: "INSERT",
    catalogCommand: "a",
    clause: "withCheck",
    expression: exactSnapshotFinalizerPolicyExpression,
  },
  {
    name: "snapshot_deletion_finalizers_retention_update",
    relation: "snapshot_deletion_finalizers",
    command: "UPDATE",
    catalogCommand: "w",
    clause: "using",
    expression: exactSnapshotFinalizerPolicyExpression,
  },
  {
    name: "snapshot_deletion_finalizers_retention_update",
    relation: "snapshot_deletion_finalizers",
    command: "UPDATE",
    catalogCommand: "w",
    clause: "withCheck",
    expression: exactSnapshotFinalizerPolicyExpression,
  },
  {
    name: "evidence_deletion_finalizers_retention_select",
    relation: "evidence_deletion_finalizers",
    command: "SELECT",
    catalogCommand: "r",
    clause: "using",
    expression: exactEvidenceFinalizerPolicyExpression,
  },
  {
    name: "evidence_deletion_finalizers_retention_insert",
    relation: "evidence_deletion_finalizers",
    command: "INSERT",
    catalogCommand: "a",
    clause: "withCheck",
    expression: exactEvidenceFinalizerPolicyExpression,
  },
  {
    name: "evidence_deletion_finalizers_retention_update",
    relation: "evidence_deletion_finalizers",
    command: "UPDATE",
    catalogCommand: "w",
    clause: "using",
    expression: exactEvidenceFinalizerPolicyExpression,
  },
  {
    name: "evidence_deletion_finalizers_retention_update",
    relation: "evidence_deletion_finalizers",
    command: "UPDATE",
    catalogCommand: "w",
    clause: "withCheck",
    expression: exactEvidenceFinalizerPolicyExpression,
  },
  {
    name: "artifact_deletion_finalizers_retention_select",
    relation: "artifact_deletion_finalizers",
    command: "SELECT",
    catalogCommand: "r",
    clause: "using",
    expression: exactArtifactFinalizerPolicyExpression,
  },
  {
    name: "artifact_deletion_finalizers_retention_insert",
    relation: "artifact_deletion_finalizers",
    command: "INSERT",
    catalogCommand: "a",
    clause: "withCheck",
    expression: exactArtifactFinalizerPolicyExpression,
  },
  {
    name: "artifact_deletion_finalizers_retention_update",
    relation: "artifact_deletion_finalizers",
    command: "UPDATE",
    catalogCommand: "w",
    clause: "using",
    expression: exactArtifactFinalizerPolicyExpression,
  },
  {
    name: "artifact_deletion_finalizers_retention_update",
    relation: "artifact_deletion_finalizers",
    command: "UPDATE",
    catalogCommand: "w",
    clause: "withCheck",
    expression: exactArtifactFinalizerPolicyExpression,
  },
] as const satisfies readonly ExactFinalizerPolicyClause[];

function exactFinalizerPolicyContractMismatches(
  policies: readonly ExactModeledPolicy[],
): readonly string[] {
  const mismatches: string[] = [];
  const expectedNames = new Set<string>(
    exactFinalizerPolicyClauses.map(({ name }) => name),
  );
  const expectedRelations = new Set<string>(
    exactFinalizerPolicyClauses.map(({ relation }) => relation),
  );
  const candidates = policies.filter(
    (policy) =>
      expectedRelations.has(policy.relation) &&
      isDeepStrictEqual(policy.roles, ["dasher_retention_definer"]),
  );

  for (const name of expectedNames) {
    const contracts = exactFinalizerPolicyClauses.filter(
      (contract) => contract.name === name,
    );
    const identity = `dasher.${contracts[0]!.relation}.${name}`;
    const matches = candidates.filter(
      (policy) =>
        policy.name === name && policy.relation === contracts[0]!.relation,
    );
    if (matches.length !== 1) {
      mismatches.push(`${identity}:count=${matches.length}`);
      continue;
    }

    const policy = matches[0]!;
    const expected = contracts[0]!;
    for (const [dimension, value] of [
      ["command", expected.command],
      ["catalogCommand", expected.catalogCommand],
      ["permissive", true],
      ["roles", ["dasher_retention_definer"]],
      ["bootstrap", false],
      ["shutsOffWhenPhase", null],
    ] as const) {
      if (!isDeepStrictEqual(policy[dimension], value)) {
        mismatches.push(`${identity}:${dimension}`);
      }
    }
    for (const contract of contracts) {
      if (policy[contract.clause] !== contract.expression) {
        mismatches.push(`${identity}:${contract.clause}`);
      }
    }
    if (policy.command === "SELECT" && policy.withCheck !== null) {
      mismatches.push(`${identity}:withCheck`);
    }
    if (policy.command === "INSERT" && policy.using !== null) {
      mismatches.push(`${identity}:using`);
    }
  }

  for (const policy of candidates) {
    if (!expectedNames.has(policy.name)) {
      mismatches.push(`${exactModeledPolicyIdentity(policy)}:unexpected`);
    }
  }

  return mismatches;
}

function hasExactCanonicalSpecBounds(
  constraintDefinition: string,
  functionSource: string,
): boolean {
  return (
    constraintDefinition ===
      "CHECK (((octet_length(canonical_spec_bytes) >= 2) AND (octet_length(canonical_spec_bytes) <= 1048576)))" &&
    functionSource.includes("octet_length($4) NOT BETWEEN 2 AND 1048576")
  );
}

function hasExactCanonicalSpecHashBinding(
  constraintDefinition: string,
  functionSource: string,
): boolean {
  const rawBound = functionSource.indexOf(
    "octet_length($4) NOT BETWEEN 2 AND 1048576",
  );
  const functionHash = functionSource.indexOf("$5 <> pg_catalog.sha256($4)");
  const firstTenantDml = functionSource.indexOf(
    "PERFORM 1 FROM dasher.dashboard_lifecycle_policies",
  );
  return (
    constraintDefinition ===
      "CHECK ((canonical_spec_sha256 = sha256(canonical_spec_bytes)))" &&
    rawBound >= 0 &&
    functionHash > rawBound &&
    firstTenantDml > functionHash &&
    functionSource.match(/[.]sha256\(\$4\)/gu)?.length === 1
  );
}

function hasExactPromotionRequestAuthorization(
  functionSource: string,
): boolean {
  const editorGate = functionSource.indexOf(
    "IF NOT dasher_private.context_allows(v_organization_id, 'editor')",
  );
  const firstTenantRead = functionSource.indexOf(
    "PERFORM 1 FROM dasher.dashboard_lifecycle_policies",
  );
  return (
    editorGate >= 0 &&
    firstTenantRead > editorGate &&
    functionSource.match(/context_allows\(v_organization_id, 'editor'\)/gu)
      ?.length === 1 &&
    !functionSource.includes("context_allows(v_organization_id, 'viewer')")
  );
}

function hasExactVersionContentAuthority(functionSource: string): boolean {
  const normalized = functionSource.replace(/\s+/gu, " ");
  const snapshotLock = normalized.slice(
    normalized.indexOf("PERFORM 1 FROM dasher.source_snapshots"),
    normalized.indexOf("IF (SELECT count(*) FROM dasher.source_snapshots"),
  );
  const snapshotCount = normalized.slice(
    normalized.indexOf("IF (SELECT count(*) FROM dasher.source_snapshots"),
    normalized.indexOf("PERFORM 1 FROM dasher.evidence_records"),
  );
  const evidenceLock = normalized.slice(
    normalized.indexOf("PERFORM 1 FROM dasher.evidence_records"),
    normalized.indexOf("IF (SELECT count(*) FROM dasher.evidence_records"),
  );
  const evidenceCount = normalized.slice(
    normalized.indexOf("IF (SELECT count(*) FROM dasher.evidence_records"),
    normalized.indexOf("PERFORM 1 FROM dasher.dashboards"),
  );
  const exactEvidenceAuthority =
    /evidence[.]evidence_id = ANY\(\$13\) AND evidence[.]snapshot_id = ANY\(\$11\)[\s\S]*authority_claim[.]dashboard_id = \$1[\s\S]*authority_claim[.]claim_kind = 'access_bearing'[\s\S]*authority_claim[.]hold_id IS NULL/u;
  return (
    ["$11", "$12", "$13", "$14"].every((parameter) =>
      normalized.includes(
        `(SELECT count(*) <> count(DISTINCT value) FROM unnest(${parameter}) AS value)`,
      ),
    ) &&
    snapshotLock.includes("snapshot.snapshot_id = ANY($11)") &&
    snapshotCount.includes("snapshot.snapshot_id = ANY($11)") &&
    snapshotCount.includes("<> cardinality($11)") &&
    exactEvidenceAuthority.test(evidenceLock) &&
    exactEvidenceAuthority.test(evidenceCount) &&
    evidenceCount.includes("<> cardinality($13)")
  );
}

function replaceAfter(
  source: string,
  marker: string,
  expected: string,
  replacement: string,
): string {
  const markerPosition = source.indexOf(marker);
  const expectedPosition = source.indexOf(expected, markerPosition);
  if (markerPosition < 0 || expectedPosition < 0) return source;
  return (
    source.slice(0, expectedPosition) +
    replacement +
    source.slice(expectedPosition + expected.length)
  );
}

function removeCompletenessRecheck(source: string, variable: string): string {
  const start = source.indexOf(`  IF ${variable} IS NOT NULL AND EXISTS (`);
  const end = source.indexOf("\n\n", start);
  if (start < 0 || end < 0) return source;
  return source.slice(0, start) + source.slice(end + 2);
}

function hasLifecycleWriteSemantics(
  functionSource: string,
  mutation: string,
  eventKind: string,
  auditAction: string,
  dependentWrites: readonly string[] = [],
): boolean {
  const eventWrite = functionSource.indexOf(
    "INSERT INTO dasher.dashboard_lifecycle_events",
  );
  const auditWrite = functionSource.indexOf(
    "INSERT INTO dasher.audit_events",
    eventWrite,
  );
  const eventStatementEnd = functionSource.indexOf(");", eventWrite);
  const eventSegment = functionSource.slice(eventWrite, eventStatementEnd + 2);
  const auditSegment = functionSource.slice(auditWrite);
  const eventWrites = functionSource.match(
    /INSERT INTO dasher[.]dashboard_lifecycle_events/gu,
  );
  const auditWrites = functionSource.match(
    /INSERT INTO dasher[.]audit_events/gu,
  );
  const auditStatementEnd = functionSource.indexOf(");", auditWrite);
  const writesAfterAudit = functionSource
    .slice(auditStatementEnd + 2)
    .match(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+dasher[.]/gu);
  const boundValue = (variable: string, expected: string): boolean => {
    const assignment = functionSource.indexOf(`${variable} :=`);
    const declarationAssignment = functionSource.indexOf(`${variable} text :=`);
    const start = assignment >= 0 ? assignment : declarationAssignment;
    if (start < 0) return false;
    const end = functionSource.indexOf(";", start);
    return end > start && functionSource.slice(start, end).includes(expected);
  };
  return (
    eventWrite >= 0 &&
    eventWrites?.length === 1 &&
    auditWrites?.length === 1 &&
    auditWrite > eventWrite &&
    auditStatementEnd > auditWrite &&
    writesAfterAudit === null &&
    (eventSegment.includes(eventKind) ||
      (eventSegment.includes("v_event_kind") &&
        boundValue("v_event_kind", eventKind))) &&
    (auditSegment.includes(auditAction) ||
      (auditSegment.includes("v_audit_action") &&
        boundValue("v_audit_action", auditAction))) &&
    containsFragmentsInOrder(functionSource, [
      mutation,
      "INSERT INTO dasher.dashboard_lifecycle_events",
      "INSERT INTO dasher.audit_events",
    ]) &&
    dependentWrites.every((dependentWrite) => {
      const position = functionSource.lastIndexOf(dependentWrite, eventWrite);
      return position >= 0 && position < eventWrite;
    })
  );
}

const retentionWrapperContracts = [
  {
    identityArguments: "uuid, bigint, uuid, text, uuid",
    name: "materialize_dashboard_expiry",
    initializer:
      "initialize_operator_context(\n    $1, 'materialize_expiry', $3, $4, $5\n  );",
    organizationArgument: "$5",
  },
  {
    identityArguments: "uuid, uuid, text, bytea, bigint, uuid, text, uuid",
    name: "place_dashboard_legal_hold",
    initializer:
      "initialize_operator_context(\n    $1, 'place_hold', $6, $3, $8\n  );",
    organizationArgument: "$8",
  },
  {
    identityArguments: "uuid, uuid, bytea, bigint, uuid, text, uuid",
    name: "release_dashboard_legal_hold",
    initializer:
      "initialize_operator_context(\n    $1, 'release_hold', $5, $6, $7\n  );",
    organizationArgument: "$7",
  },
  {
    identityArguments: "uuid, bigint, bytea, interval, uuid, text, uuid",
    name: "claim_dashboard_cleanup",
    initializer:
      "initialize_operator_context(\n    $1, 'claim_cleanup', $5, $6, $7\n  );",
    organizationArgument: "$7",
  },
  {
    identityArguments:
      "uuid, uuid, text, text, integer, integer, integer, bytea, uuid",
    name: "record_dashboard_cleanup_attempt",
    initializer:
      "initialize_operator_context(\n    $1, 'record_attempt', $2, $3, $9\n  );",
    organizationArgument: "$9",
  },
  {
    identityArguments: "uuid, bigint, bytea, uuid, text, uuid",
    name: "purge_dashboard",
    initializer:
      "initialize_operator_context(\n    $1, 'purge', $4, $5, $6\n  );",
    organizationArgument: "$6",
  },
] as const;

function hasExactRetentionTypedSignatureMatrix(
  routines: readonly ExactModeledFunction[],
): boolean {
  const expected = new Map<string, string>([
    ["initialize_operator_context", "uuid, text, uuid, text, uuid"],
    ...retentionWrapperContracts.map(
      (contract) => [contract.name, contract.identityArguments] as const,
    ),
  ]);
  const actual = routines.filter((routine) => expected.has(routine.name));
  return (
    actual.length === expected.size &&
    actual.every(
      (routine) => expected.get(routine.name) === routine.identityArguments,
    )
  );
}

function hasAtomicRetentionWrapperSemantics(
  functionSource: string,
  exactInitializer: string,
): boolean {
  const initializer = functionSource.indexOf(exactInitializer);
  const firstContextRead = functionSource.indexOf("current_setting(");
  const firstTenantRead = functionSource.indexOf("FROM dasher.");
  const firstReturn = functionSource.indexOf("RETURN;", initializer);
  const lockedAuthorityRevalidation = functionSource.indexOf(
    "FROM dasher.retention_service_principal_allowlist AS authority",
    initializer,
  );
  const latestRevalidation = functionSource.indexOf(
    "FROM dasher.retention_service_principal_allowlist AS later",
    lockedAuthorityRevalidation,
  );
  const policyLock = functionSource.indexOf(
    "FROM dasher.dashboard_lifecycle_policies",
    latestRevalidation,
  );
  const dashboardLock = functionSource.indexOf(
    "FROM dasher.dashboards AS dashboard",
    policyLock,
  );
  return (
    initializer >= 0 &&
    functionSource.match(
      /PERFORM dasher_retention_api[.]initialize_operator_context\(/gu,
    )?.length === 1 &&
    firstContextRead > initializer &&
    firstTenantRead > initializer &&
    lockedAuthorityRevalidation > initializer &&
    latestRevalidation > lockedAuthorityRevalidation &&
    policyLock > latestRevalidation &&
    dashboardLock > policyLock &&
    (firstReturn < 0 || firstReturn > dashboardLock) &&
    !functionSource.includes("set_config('dasher.retention_capability'") &&
    !/initialize_operator_context\(\s*\$1\s*,\s*\$2\s*,/u.test(functionSource)
  );
}

function hasCanonicalRetentionTargetLockOrder(
  initializerSource: string,
  wrapperSource: string,
  exactInitializer: string,
): boolean {
  const initializerCall = wrapperSource.indexOf(exactInitializer);
  const authorityRevalidation = wrapperSource.indexOf(
    "FROM dasher.retention_service_principal_allowlist AS authority",
    initializerCall,
  );
  const policyRead = wrapperSource.indexOf(
    "FROM dasher.dashboard_lifecycle_policies",
    authorityRevalidation,
  );
  const policyEnd = wrapperSource.indexOf(";", policyRead);
  const dashboardRead = wrapperSource.indexOf(
    "FROM dasher.dashboards AS dashboard",
    policyEnd,
  );
  const dashboardEnd = wrapperSource.indexOf(";", dashboardRead);
  const prePolicyTenantResources = wrapperSource.slice(
    initializerCall + exactInitializer.length,
    policyRead,
  );
  return (
    initializerCall >= 0 &&
    authorityRevalidation > initializerCall &&
    policyRead > authorityRevalidation &&
    policyEnd > policyRead &&
    dashboardRead > policyEnd &&
    dashboardEnd > dashboardRead &&
    initializerSource.match(/FROM dasher[.]dashboards/gu)?.length === 1 &&
    !/FOR\s+(?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)/iu.test(
      initializerSource,
    ) &&
    !/FROM\s+dasher[.]dashboards|UPDATE\s+dasher[.]dashboards/iu.test(
      prePolicyTenantResources,
    ) &&
    /ORDER BY\s+(?:policy[.])?policy_revision DESC LIMIT 1 FOR UPDATE(?: OF policy)?/u.test(
      wrapperSource.slice(policyRead, policyEnd),
    ) &&
    /FOR UPDATE(?: OF dashboard)?/u.test(
      wrapperSource.slice(dashboardRead, dashboardEnd),
    )
  );
}

const exactLockColumnPrivileges = [
  ["dasher_security_definer", "dashboards", "head_version_id"],
  ["dasher_security_definer", "dashboards", "lifecycle_state"],
  ["dasher_security_definer", "dashboards", "lifecycle_revision"],
  ["dasher_security_definer", "dashboards", "capability_epoch"],
  ["dasher_security_definer", "dashboards", "cache_epoch"],
  ["dasher_security_definer", "dashboards", "current_kind"],
  ["dasher_security_definer", "dashboards", "effective_expires_at"],
  ["dasher_security_definer", "dashboards", "promoted_at"],
  ["dasher_security_definer", "dashboards", "archived_at"],
  ["dasher_security_definer", "dashboards", "access_revoked_at"],
  ["dasher_security_definer", "dashboards", "revocation_reason"],
  ["dasher_security_definer", "dashboards", "purge_after"],
  ["dasher_retention_definer", "dashboards", "lifecycle_state"],
  ["dasher_retention_definer", "dashboards", "lifecycle_revision"],
  ["dasher_retention_definer", "dashboards", "capability_epoch"],
  ["dasher_retention_definer", "dashboards", "cache_epoch"],
  ["dasher_retention_definer", "dashboards", "access_revoked_at"],
  ["dasher_retention_definer", "dashboards", "revocation_reason"],
  ["dasher_retention_definer", "dashboards", "purge_after"],
  ["dasher_retention_definer", "dashboards", "purge_started_at"],
  ["dasher_retention_definer", "dashboards", "purged_at"],
  [
    "dasher_retention_definer",
    "dashboard_cleanup_coordination",
    "current_step",
  ],
  ["dasher_retention_definer", "dashboard_cleanup_coordination", "lease_owner"],
  [
    "dasher_retention_definer",
    "dashboard_cleanup_coordination",
    "lease_expires_at",
  ],
  [
    "dasher_retention_definer",
    "dashboard_cleanup_coordination",
    "expected_lifecycle_revision",
  ],
  [
    "dasher_retention_definer",
    "dashboard_cleanup_coordination",
    "next_attempt_at",
  ],
  [
    "dasher_retention_definer",
    "dashboard_cleanup_coordination",
    "completion_proof_sha256",
  ],
  ["dasher_retention_definer", "dashboard_legal_holds", "released_at"],
  [
    "dasher_retention_definer",
    "dashboard_legal_holds",
    "released_by_principal_id",
  ],
  [
    "dasher_retention_definer",
    "dashboard_legal_holds",
    "released_authority_revision",
  ],
  ["dasher_retention_definer", "dashboard_legal_holds", "released_actor"],
  [
    "dasher_retention_definer",
    "dashboard_legal_holds",
    "released_reason_sha256",
  ],
  ["dasher_retention_definer", "dashboard_tombstones", "purged_at"],
  [
    "dasher_retention_definer",
    "dashboard_tombstones",
    "purged_lifecycle_revision",
  ],
  ["dasher_retention_definer", "dashboard_tombstones", "purged_proof_sha256"],
  ["dasher_retention_definer", "snapshot_deletion_finalizers", "state"],
  ["dasher_retention_definer", "snapshot_deletion_finalizers", "lease_owner"],
  [
    "dasher_retention_definer",
    "snapshot_deletion_finalizers",
    "lease_expires_at",
  ],
  ["dasher_retention_definer", "snapshot_deletion_finalizers", "proof_sha256"],
  [
    "dasher_retention_definer",
    "snapshot_deletion_finalizers",
    "bytes_deleted_at",
  ],
  ["dasher_retention_definer", "evidence_deletion_finalizers", "state"],
  ["dasher_retention_definer", "evidence_deletion_finalizers", "lease_owner"],
  [
    "dasher_retention_definer",
    "evidence_deletion_finalizers",
    "lease_expires_at",
  ],
  ["dasher_retention_definer", "evidence_deletion_finalizers", "proof_sha256"],
  [
    "dasher_retention_definer",
    "evidence_deletion_finalizers",
    "bytes_deleted_at",
  ],
  ["dasher_retention_definer", "artifact_deletion_finalizers", "state"],
  ["dasher_retention_definer", "artifact_deletion_finalizers", "lease_owner"],
  [
    "dasher_retention_definer",
    "artifact_deletion_finalizers",
    "lease_expires_at",
  ],
  ["dasher_retention_definer", "artifact_deletion_finalizers", "proof_sha256"],
  [
    "dasher_retention_definer",
    "artifact_deletion_finalizers",
    "bytes_deleted_at",
  ],
  ["dasher_retention_definer", "source_snapshots", "organization_id"],
  ["dasher_retention_definer", "evidence_records", "organization_id"],
  [
    "dasher_security_definer",
    "dashboard_lifecycle_policies",
    "organization_id",
  ],
  ["dasher_security_definer", "source_snapshots", "organization_id"],
  ["dasher_security_definer", "dashboard_versions", "organization_id"],
  ["dasher_security_definer", "evidence_records", "organization_id"],
  [
    "dasher_security_definer",
    "dashboard_promotion_requests",
    "organization_id",
  ],
  ["dasher_security_definer", "dashboard_tombstones", "organization_id"],
  [
    "dasher_retention_definer",
    "dashboard_lifecycle_policies",
    "organization_id",
  ],
  [
    "dasher_retention_definer",
    "dashboard_version_snapshots",
    "organization_id",
  ],
  ["dasher_retention_definer", "dashboard_version_evidence", "organization_id"],
  ["dasher_retention_definer", "dashboard_artifacts", "organization_id"],
  ["dasher_retention_definer", "snapshot_reference_claims", "organization_id"],
  ["dasher_retention_definer", "evidence_reference_claims", "organization_id"],
  ["dasher_retention_definer", "artifact_reference_claims", "organization_id"],
  ["dasher_retention_definer", "dashboard_restore_lineage", "organization_id"],
  ["dasher_retention_definer", "dashboard_versions", "organization_id"],
] as const;

type ExactLockPolicyContract = Readonly<{
  capabilities: readonly string[] | null;
  name: string;
}>;

type ExactRowLockTarget = Readonly<{
  modes: readonly string[];
  policies: readonly ExactLockPolicyContract[];
  relation: string;
  role: "dasher_retention_definer" | "dasher_security_definer";
}>;

const exactRowLockTargets = [
  {
    role: "dasher_security_definer",
    relation: "dashboard_lifecycle_policies",
    modes: ["UPDATE"],
    policies: [
      {
        name: "dashboard_lifecycle_policies_security_lock_update",
        capabilities: null,
      },
    ],
  },
  {
    role: "dasher_security_definer",
    relation: "dashboards",
    modes: ["UPDATE"],
    policies: [{ name: "dashboards_security_lock_update", capabilities: null }],
  },
  {
    role: "dasher_security_definer",
    relation: "source_snapshots",
    modes: ["SHARE"],
    policies: [
      { name: "source_snapshots_security_lock_update", capabilities: null },
    ],
  },
  {
    role: "dasher_security_definer",
    relation: "dashboard_versions",
    modes: ["SHARE"],
    policies: [
      { name: "dashboard_versions_security_lock_update", capabilities: null },
    ],
  },
  {
    role: "dasher_security_definer",
    relation: "evidence_records",
    modes: ["SHARE"],
    policies: [
      { name: "evidence_records_security_lock_update", capabilities: null },
    ],
  },
  {
    role: "dasher_security_definer",
    relation: "dashboard_promotion_requests",
    modes: ["SHARE"],
    policies: [
      {
        name: "dashboard_promotion_requests_security_lock_update",
        capabilities: null,
      },
    ],
  },
  {
    role: "dasher_security_definer",
    relation: "dashboard_tombstones",
    modes: ["SHARE"],
    policies: [
      {
        name: "dashboard_tombstones_security_lock_update",
        capabilities: null,
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "artifact_deletion_finalizers",
    modes: ["UPDATE"],
    policies: [
      {
        name: "artifact_deletion_finalizers_retention_update",
        capabilities: ["purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "artifact_reference_claims",
    modes: ["UPDATE"],
    policies: [
      {
        name: "artifact_reference_claims_retention_lock_update",
        capabilities: ["release_hold", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_artifacts",
    modes: ["SHARE", "UPDATE"],
    policies: [
      {
        name: "dashboard_artifacts_retention_lock_update",
        capabilities: ["place_hold", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_cleanup_coordination",
    modes: ["UPDATE"],
    policies: [
      {
        name: "dashboard_cleanup_coordination_retention_update",
        capabilities: ["claim_cleanup", "record_attempt", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_legal_holds",
    modes: ["SHARE", "UPDATE"],
    policies: [
      {
        name: "dashboard_legal_holds_retention_update",
        capabilities: ["release_hold"],
      },
      {
        name: "dashboard_legal_holds_retention_lock_update",
        capabilities: ["claim_cleanup", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_lifecycle_policies",
    modes: ["UPDATE"],
    policies: [
      {
        name: "dashboard_lifecycle_policies_retention_lock_update",
        capabilities: [
          "materialize_expiry",
          "place_hold",
          "release_hold",
          "claim_cleanup",
          "record_attempt",
          "purge",
        ],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_restore_lineage",
    modes: ["UPDATE"],
    policies: [
      {
        name: "dashboard_restore_lineage_retention_lock_update",
        capabilities: ["purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_version_evidence",
    modes: ["SHARE", "UPDATE"],
    policies: [
      {
        name: "dashboard_version_evidence_retention_lock_update",
        capabilities: ["place_hold", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_version_snapshots",
    modes: ["SHARE", "UPDATE"],
    policies: [
      {
        name: "dashboard_version_snapshots_retention_lock_update",
        capabilities: ["place_hold", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboard_versions",
    modes: ["UPDATE"],
    policies: [
      {
        name: "dashboard_versions_retention_lock_update",
        capabilities: ["purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "dashboards",
    modes: ["UPDATE"],
    policies: [
      {
        name: "dashboards_retention_update",
        capabilities: [
          "materialize_expiry",
          "place_hold",
          "release_hold",
          "claim_cleanup",
          "purge",
        ],
      },
      {
        name: "dashboards_retention_record_attempt_lock_update",
        capabilities: ["record_attempt"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "evidence_deletion_finalizers",
    modes: ["UPDATE"],
    policies: [
      {
        name: "evidence_deletion_finalizers_retention_update",
        capabilities: ["purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "evidence_records",
    modes: ["UPDATE"],
    policies: [
      {
        name: "evidence_records_retention_lock_update",
        capabilities: ["purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "evidence_reference_claims",
    modes: ["UPDATE"],
    policies: [
      {
        name: "evidence_reference_claims_retention_lock_update",
        capabilities: ["release_hold", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "snapshot_deletion_finalizers",
    modes: ["UPDATE"],
    policies: [
      {
        name: "snapshot_deletion_finalizers_retention_update",
        capabilities: ["purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "snapshot_reference_claims",
    modes: ["UPDATE"],
    policies: [
      {
        name: "snapshot_reference_claims_retention_lock_update",
        capabilities: ["release_hold", "purge"],
      },
    ],
  },
  {
    role: "dasher_retention_definer",
    relation: "source_snapshots",
    modes: ["UPDATE"],
    policies: [
      {
        name: "source_snapshots_retention_lock_update",
        capabilities: ["purge"],
      },
    ],
  },
] as const satisfies readonly ExactRowLockTarget[];

const exactLockOnlyTriggerContracts = [
  {
    relation: "dashboard_lifecycle_policies",
    trigger: "dashboard_lifecycle_policies_immutable",
    functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
  },
  {
    relation: "source_snapshots",
    trigger: "source_snapshots_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "dashboard_versions",
    trigger: "dashboard_versions_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "evidence_records",
    trigger: "evidence_records_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "dashboard_promotion_requests",
    trigger: "dashboard_promotion_requests_immutable",
    functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
  },
  {
    relation: "dashboard_tombstones",
    trigger: "dashboard_tombstones_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "dashboard_version_snapshots",
    trigger: "dashboard_version_snapshots_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "dashboard_version_evidence",
    trigger: "dashboard_version_evidence_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "dashboard_artifacts",
    trigger: "dashboard_artifacts_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "snapshot_reference_claims",
    trigger: "snapshot_reference_claims_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "evidence_reference_claims",
    trigger: "evidence_reference_claims_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "artifact_reference_claims",
    trigger: "artifact_reference_claims_retention_guard",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
  {
    relation: "dashboard_restore_lineage",
    trigger: "dashboard_restore_lineage_immutable",
    functionIdentity: "dasher_private.enforce_retention_mutation()",
  },
] as const;

function hasExactLockColumnPrivilegeMatrix(
  columnAcls: readonly Readonly<{
    columnName: string;
    grantee: string;
    privilege: string;
    relationName: string;
  }>[],
  relationAcls: readonly Readonly<{
    grantee: string;
    privilege: string;
    relationName: string;
  }>[],
): boolean {
  const relevantColumnAcls = columnAcls.filter(
    (acl) =>
      acl.privilege === "UPDATE" &&
      (acl.grantee === "dasher_security_definer" ||
        acl.grantee === "dasher_retention_definer"),
  );
  return (
    relevantColumnAcls.length === exactLockColumnPrivileges.length &&
    exactLockColumnPrivileges.every(
      ([grantee, relationName, columnName]) =>
        relevantColumnAcls.filter(
          (acl) =>
            acl.grantee === grantee &&
            acl.relationName === relationName &&
            acl.columnName === columnName &&
            acl.privilege === "UPDATE",
        ).length === 1,
    ) &&
    relevantColumnAcls.every((acl) =>
      exactLockColumnPrivileges.some(
        ([grantee, relationName, columnName]) =>
          acl.grantee === grantee &&
          acl.relationName === relationName &&
          acl.columnName === columnName,
      ),
    ) &&
    !relationAcls.some(
      (acl) =>
        acl.privilege === "UPDATE" &&
        (acl.grantee === "dasher_security_definer" ||
          acl.grantee === "dasher_retention_definer"),
    )
  );
}

type ModeledLockPolicy = Readonly<{
  bootstrap: boolean;
  catalogCommand: string;
  command: string;
  name: string;
  permissive: boolean;
  relation: string;
  roles: readonly string[];
  using: string | null;
  withCheck: string | null;
}>;

function sourceDepthAt(source: string, end: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < end; index += 1) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === "(") {
      depth += 1;
    } else if (!quoted && character === ")") {
      depth -= 1;
    }
  }
  return depth;
}

function exactLockedRelationModes(
  functions: readonly Readonly<{
    owner: string;
    source: string;
  }>[],
): readonly Readonly<{
  modes: readonly string[];
  relation: string;
  role: string;
}>[] {
  const results: Array<{
    modes: string[];
    relation: string;
    role: string;
  }> = [];
  for (const routine of functions) {
    if (
      routine.owner !== "dasher_security_definer" &&
      routine.owner !== "dasher_retention_definer"
    ) {
      continue;
    }
    for (const statement of routine.source.split(";")) {
      const relationRows: Array<{
        alias: string;
        depth: number;
        relation: string;
      }> = [];
      for (const match of statement.matchAll(
        /\b(?:FROM|JOIN)\s+dasher[.]([a-z_][a-z0-9_]*)(?:\s+AS\s+([a-z_][a-z0-9_]*))?/giu,
      )) {
        const relation = match[1]!;
        relationRows.push({
          alias: match[2] ?? relation,
          depth: sourceDepthAt(statement, match.index),
          relation,
        });
      }
      for (const lock of statement.matchAll(
        /\bFOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)(?:\s+OF\s+([a-z_][a-z0-9_]*))?/giu,
      )) {
        const mode = lock[1]!.toUpperCase();
        const lockDepth = sourceDepthAt(statement, lock.index);
        const explicitAlias = lock[2];
        for (const relationRow of relationRows) {
          if (
            relationRow.depth !== lockDepth ||
            (explicitAlias !== undefined &&
              relationRow.alias !== explicitAlias.toLowerCase())
          ) {
            continue;
          }
          let target = results.find(
            (candidate) =>
              candidate.role === routine.owner &&
              candidate.relation === relationRow.relation,
          );
          if (target === undefined) {
            target = {
              modes: [],
              relation: relationRow.relation,
              role: routine.owner,
            };
            results.push(target);
          }
          if (!target.modes.includes(mode)) target.modes.push(mode);
        }
      }
    }
  }
  return results;
}

function hasExactLockPolicySemantics(
  policy: ModeledLockPolicy,
  contract: ExactLockPolicyContract,
  target: ExactRowLockTarget,
): boolean {
  if (
    policy.name !== contract.name ||
    policy.relation !== target.relation ||
    policy.command !== "UPDATE" ||
    policy.catalogCommand !== "w" ||
    !policy.permissive ||
    policy.bootstrap ||
    policy.roles.length !== 1 ||
    policy.roles[0] !== target.role ||
    policy.using === null ||
    policy.withCheck === null ||
    policy.using !== policy.withCheck
  ) {
    return false;
  }
  if (target.role === "dasher_security_definer") {
    return (
      contract.capabilities === null &&
      policy.using ===
        "((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id()))"
    );
  }
  return (
    contract.capabilities !== null &&
    hasExactPolicyCapabilities(policy, contract.capabilities) &&
    policy.using.includes(
      "organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid",
    ) &&
    policy.using.includes(
      "current_setting('dasher.retention_target_dashboard_id'::text, true)",
    )
  );
}

function hasExactRowLockPolicyClosure(
  functions: readonly Readonly<{ owner: string; source: string }>[],
  policies: readonly ModeledLockPolicy[],
  columnAcls: readonly Readonly<{
    columnName: string;
    grantee: string;
    privilege: string;
    relationName: string;
  }>[],
  relationAcls: readonly Readonly<{
    grantee: string;
    privilege: string;
    relationName: string;
  }>[],
): boolean {
  if (
    exactRowLockTargets.length !== 24 ||
    !hasExactLockColumnPrivilegeMatrix(columnAcls, relationAcls)
  ) {
    return false;
  }
  const lockedRelations = exactLockedRelationModes(functions);
  if (lockedRelations.length !== exactRowLockTargets.length) return false;

  const expectedPolicyNames = new Set<string>();
  let expectedPolicyCount = 0;
  for (const target of exactRowLockTargets) {
    const actualLocks = lockedRelations.filter(
      (actual) =>
        actual.role === target.role && actual.relation === target.relation,
    );
    if (
      actualLocks.length !== 1 ||
      actualLocks[0]!.modes.length !== target.modes.length ||
      !target.modes.every((mode) => actualLocks[0]!.modes.includes(mode)) ||
      !columnAcls.some(
        (acl) =>
          acl.grantee === target.role &&
          acl.relationName === target.relation &&
          acl.privilege === "UPDATE",
      )
    ) {
      return false;
    }
    for (const contract of target.policies) {
      expectedPolicyCount += 1;
      if (expectedPolicyNames.has(contract.name)) return false;
      expectedPolicyNames.add(contract.name);
      const exactPolicies = policies.filter(
        (policy) => policy.name === contract.name,
      );
      if (
        exactPolicies.length !== 1 ||
        !hasExactLockPolicySemantics(exactPolicies[0]!, contract, target)
      ) {
        return false;
      }
    }
  }
  if (expectedPolicyCount !== 26) return false;

  const definerUpdatePolicies = policies.filter(
    (policy) =>
      policy.command === "UPDATE" &&
      (policy.roles.includes("dasher_security_definer") ||
        policy.roles.includes("dasher_retention_definer")),
  );
  if (definerUpdatePolicies.length !== 27) return false;
  for (const policy of definerUpdatePolicies) {
    if (expectedPolicyNames.has(policy.name)) continue;
    if (
      policy.name !== "dashboard_tombstones_retention_update" ||
      policy.relation !== "dashboard_tombstones" ||
      !hasExactPolicyCapabilities(policy, ["purge"]) ||
      policy.using === null ||
      policy.withCheck === null ||
      policy.using !== policy.withCheck ||
      !policy.using.includes(
        "current_setting('dasher.retention_target_dashboard_id'::text, true)",
      )
    ) {
      return false;
    }
  }
  return true;
}

const purgeStageContracts = [
  {
    name: "create snapshot finalizer intent",
    stageStart: "  v_snapshot_ids := ARRAY(",
    selector:
      "SELECT snapshot.snapshot_id\n    FROM dasher.source_snapshots AS snapshot",
    orderBy: "ORDER BY snapshot.snapshot_id",
    anchors: [
      "FROM dasher.snapshot_deletion_finalizers AS existing",
      "existing.snapshot_id = snapshot.snapshot_id",
      "FROM dasher.snapshot_reference_claims AS other_claim",
      "FOR UPDATE OF snapshot",
      "FROM dasher.snapshot_reference_claims AS claim",
      "FOR UPDATE OF claim",
      "INSERT INTO dasher.snapshot_deletion_finalizers",
      "FROM unnest(v_snapshot_ids) AS candidate(snapshot_id)",
      "ORDER BY candidate.snapshot_id",
    ],
    standardReturn: true,
  },
  {
    name: "create evidence finalizer intent",
    stageStart: "  v_evidence_ids := ARRAY(",
    selector:
      "SELECT evidence.evidence_id\n    FROM dasher.evidence_records AS evidence",
    orderBy: "ORDER BY evidence.evidence_id",
    anchors: [
      "FROM dasher.evidence_deletion_finalizers AS existing",
      "existing.evidence_id = evidence.evidence_id",
      "FROM dasher.evidence_reference_claims AS other_claim",
      "FOR UPDATE OF evidence",
      "FROM dasher.evidence_reference_claims AS claim",
      "FOR UPDATE OF claim",
      "INSERT INTO dasher.evidence_deletion_finalizers",
      "FROM unnest(v_evidence_ids) AS candidate(evidence_id)",
      "ORDER BY candidate.evidence_id",
    ],
    standardReturn: true,
  },
  {
    name: "create artifact finalizer intent",
    stageStart: "  v_artifact_ids := ARRAY(",
    selector:
      "SELECT artifact.artifact_id\n    FROM dasher.dashboard_artifacts AS artifact",
    orderBy: "ORDER BY artifact.artifact_id",
    anchors: [
      "FROM dasher.artifact_deletion_finalizers AS existing",
      "existing.artifact_id = artifact.artifact_id",
      "FROM dasher.artifact_reference_claims AS other_claim",
      "FOR UPDATE OF artifact",
      "FROM dasher.artifact_reference_claims AS claim",
      "FOR UPDATE OF claim",
      "INSERT INTO dasher.artifact_deletion_finalizers",
      "FROM unnest(v_artifact_ids) AS candidate(artifact_id)",
      "ORDER BY candidate.artifact_id",
    ],
    standardReturn: true,
  },
  {
    name: "delete snapshot source-dashboard access claims",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT claim.organization_id, claim.snapshot_id, claim.reference_claim_id\n    FROM dasher.snapshot_reference_claims AS claim\n    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1",
    orderBy: "ORDER BY claim.snapshot_id, claim.reference_claim_id",
    anchors: ["DELETE FROM dasher.snapshot_reference_claims AS claim"],
    standardReturn: true,
  },
  {
    name: "delete evidence source-dashboard access claims",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT claim.organization_id, claim.evidence_id, claim.reference_claim_id\n    FROM dasher.evidence_reference_claims AS claim\n    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1",
    orderBy: "ORDER BY claim.evidence_id, claim.reference_claim_id",
    anchors: ["DELETE FROM dasher.evidence_reference_claims AS claim"],
    standardReturn: true,
  },
  {
    name: "delete artifact source-dashboard access claims",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT claim.organization_id, claim.artifact_id, claim.reference_claim_id\n    FROM dasher.artifact_reference_claims AS claim\n    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1",
    orderBy: "ORDER BY claim.artifact_id, claim.reference_claim_id",
    anchors: ["DELETE FROM dasher.artifact_reference_claims AS claim"],
    standardReturn: true,
  },
  {
    name: "transition snapshot intent to eligible",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT finalizer.organization_id, finalizer.snapshot_id\n    FROM dasher.snapshot_deletion_finalizers AS finalizer\n    WHERE finalizer.organization_id = v_organization_id\n      AND finalizer.state = 'intent'",
    orderBy: "ORDER BY finalizer.snapshot_id",
    anchors: [
      "UPDATE dasher.snapshot_deletion_finalizers AS finalizer",
      "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
    ],
    standardReturn: true,
  },
  {
    name: "transition evidence intent to eligible",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT finalizer.organization_id, finalizer.evidence_id\n    FROM dasher.evidence_deletion_finalizers AS finalizer\n    WHERE finalizer.organization_id = v_organization_id\n      AND finalizer.state = 'intent'",
    orderBy: "ORDER BY finalizer.evidence_id",
    anchors: [
      "UPDATE dasher.evidence_deletion_finalizers AS finalizer",
      "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
    ],
    standardReturn: true,
  },
  {
    name: "transition artifact intent to eligible",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT finalizer.organization_id, finalizer.artifact_id\n    FROM dasher.artifact_deletion_finalizers AS finalizer\n    WHERE finalizer.organization_id = v_organization_id\n      AND finalizer.state = 'intent'",
    orderBy: "ORDER BY finalizer.artifact_id",
    anchors: [
      "UPDATE dasher.artifact_deletion_finalizers AS finalizer",
      "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
    ],
    standardReturn: true,
  },
  {
    name: "delete restore lineage",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT lineage.organization_id, lineage.dashboard_id, lineage.version_id",
    orderBy: "ORDER BY lineage.version_id",
    anchors: ["DELETE FROM dasher.dashboard_restore_lineage AS lineage"],
    standardReturn: true,
  },
  {
    name: "delete version-evidence links",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT link.organization_id, link.dashboard_id, link.version_id,\n      link.evidence_id",
    orderBy: "ORDER BY link.version_id, link.evidence_id",
    anchors: ["DELETE FROM dasher.dashboard_version_evidence AS link"],
    standardReturn: true,
  },
  {
    name: "delete version-snapshot links",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT link.organization_id, link.dashboard_id, link.version_id,\n      link.snapshot_id",
    orderBy: "ORDER BY link.version_id, link.snapshot_id",
    anchors: ["DELETE FROM dasher.dashboard_version_snapshots AS link"],
    standardReturn: true,
  },
  {
    name: "transition and delete artifact bytes",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT finalizer.organization_id, finalizer.artifact_id\n    FROM dasher.artifact_deletion_finalizers AS finalizer\n    WHERE finalizer.organization_id = v_organization_id\n      AND finalizer.state = 'eligible'",
    orderBy: "ORDER BY finalizer.artifact_id",
    anchors: [
      "UPDATE dasher.artifact_deletion_finalizers AS finalizer",
      "SET state = 'deleted', bytes_deleted_at = v_now",
      "SELECT count(*) INTO v_expected_delete_count\n    FROM dasher.dashboard_artifacts AS artifact",
      "DELETE FROM dasher.dashboard_artifacts AS artifact",
      "GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;",
      "v_deleted_row_count <> v_expected_delete_count OR EXISTS",
    ],
    standardReturn: false,
  },
  {
    name: "delete leaf dashboard versions",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT version.organization_id, version.dashboard_id, version.version_id",
    orderBy: "ORDER BY version.version_id",
    anchors: ["DELETE FROM dasher.dashboard_versions AS version"],
    standardReturn: true,
  },
  {
    name: "transition and delete evidence bytes",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT finalizer.organization_id, finalizer.evidence_id\n    FROM dasher.evidence_deletion_finalizers AS finalizer\n    WHERE finalizer.organization_id = v_organization_id\n      AND finalizer.state = 'eligible'",
    orderBy: "ORDER BY finalizer.evidence_id",
    anchors: [
      "UPDATE dasher.evidence_deletion_finalizers AS finalizer",
      "SET state = 'deleted', bytes_deleted_at = v_now",
      "SELECT count(*) INTO v_expected_delete_count\n    FROM dasher.evidence_records AS evidence",
      "DELETE FROM dasher.evidence_records AS evidence",
      "GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;",
      "v_deleted_row_count <> v_expected_delete_count OR EXISTS",
    ],
    standardReturn: false,
  },
  {
    name: "transition and delete snapshot bytes",
    stageStart: "  WITH candidates AS MATERIALIZED (",
    selector:
      "SELECT finalizer.organization_id, finalizer.snapshot_id\n    FROM dasher.snapshot_deletion_finalizers AS finalizer\n    WHERE finalizer.organization_id = v_organization_id\n      AND finalizer.state = 'eligible'",
    orderBy: "ORDER BY finalizer.snapshot_id",
    anchors: [
      "UPDATE dasher.snapshot_deletion_finalizers AS finalizer",
      "SET state = 'deleted', bytes_deleted_at = v_now",
      "SELECT count(*) INTO v_expected_delete_count\n    FROM dasher.source_snapshots AS snapshot",
      "DELETE FROM dasher.source_snapshots AS snapshot",
      "GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;",
      "v_deleted_row_count <> v_expected_delete_count OR EXISTS",
    ],
    standardReturn: false,
  },
] as const;

function purgeStageRanges(
  purgeSource: string,
): readonly Readonly<{ end: number; start: number }>[] | undefined {
  const starts: number[] = [];
  let priorSelector = -1;
  for (const contract of purgeStageContracts) {
    const selector = purgeSource.indexOf(contract.selector);
    if (
      selector <= priorSelector ||
      purgeSource.indexOf(contract.selector, selector + 1) >= 0
    ) {
      return undefined;
    }
    const start = purgeSource.lastIndexOf(contract.stageStart, selector);
    if (start < 0 || (starts.at(-1) ?? -1) >= start) return undefined;
    starts.push(start);
    priorSelector = selector;
  }
  const finalBoundary = purgeSource.indexOf(
    "\n  IF EXISTS (\n    SELECT 1 FROM dasher.dashboard_versions AS version",
    starts.at(-1),
  );
  if (finalBoundary < 0) return undefined;
  const ranges: Array<Readonly<{ end: number; start: number }>> = [];
  for (let index = 0; index < starts.length; index += 1) {
    ranges.push({
      start: starts[index]!,
      end: starts[index + 1] ?? finalBoundary,
    });
  }
  return ranges;
}

function hasExactPurgeStageContract(purgeSource: string): boolean {
  const ranges = purgeStageRanges(purgeSource);
  if (
    ranges === undefined ||
    ranges.length !== 16 ||
    (purgeSource.match(/LIMIT v_batch_limit/gu)?.length ?? 0) !== 16
  ) {
    return false;
  }
  for (let index = 0; index < purgeStageContracts.length; index += 1) {
    const contract = purgeStageContracts[index]!;
    const range = ranges[index]!;
    const stage = purgeSource.slice(range.start, range.end);
    if (
      !stage.includes(contract.selector) ||
      !stage.includes(contract.orderBy) ||
      !stage.includes(`${contract.orderBy}\n    LIMIT v_batch_limit`) ||
      (stage.match(/LIMIT v_batch_limit/gu)?.length ?? 0) !== 1 ||
      (stage.match(/GET DIAGNOSTICS v_row_count = ROW_COUNT;/gu)?.length ??
        0) !== 1 ||
      !contract.anchors.every((anchor) => stage.includes(anchor))
    ) {
      return false;
    }
    if (
      contract.standardReturn
        ? !stage.includes("IF v_row_count > 0 THEN RETURN; END IF;")
        : !containsFragmentsInOrder(stage, [
            "IF v_row_count > 0 THEN",
            "GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;",
            "v_deleted_row_count <> v_expected_delete_count OR EXISTS",
            "RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';\n    END IF;\n    RETURN;\n  END IF;",
          ])
    ) {
      return false;
    }
  }
  return true;
}

function hasExactFinalizerPaginationClosure(purgeSource: string): boolean {
  const ranges = purgeStageRanges(purgeSource);
  if (ranges === undefined) return false;
  const contracts = [
    {
      arrayName: "v_snapshot_ids",
      candidateId: "snapshot_id",
      finalizer: "snapshot_deletion_finalizers",
      resourceAlias: "snapshot",
      resourceId: "snapshot_id",
      claim: "snapshot_reference_claims",
    },
    {
      arrayName: "v_evidence_ids",
      candidateId: "evidence_id",
      finalizer: "evidence_deletion_finalizers",
      resourceAlias: "evidence",
      resourceId: "evidence_id",
      claim: "evidence_reference_claims",
    },
    {
      arrayName: "v_artifact_ids",
      candidateId: "artifact_id",
      finalizer: "artifact_deletion_finalizers",
      resourceAlias: "artifact",
      resourceId: "artifact_id",
      claim: "artifact_reference_claims",
    },
  ] as const;
  for (let index = 0; index < contracts.length; index += 1) {
    const contract = contracts[index]!;
    const range = ranges[index]!;
    const stage = purgeSource.slice(range.start, range.end);
    const limit = stage.indexOf("    LIMIT v_batch_limit");
    const resourceLock = stage.indexOf(
      `    FOR UPDATE OF ${contract.resourceAlias}`,
    );
    const claimLock = stage.indexOf(`FROM dasher.${contract.claim} AS claim`);
    const insert = stage.indexOf(`INSERT INTO dasher.${contract.finalizer}`);
    const preLimitFinalizer = stage.indexOf(
      `AND NOT EXISTS (\n        SELECT 1 FROM dasher.${contract.finalizer} AS existing\n        WHERE existing.organization_id = ${contract.resourceAlias}.organization_id\n          AND existing.${contract.resourceId} = ${contract.resourceAlias}.${contract.resourceId}`,
    );
    const preLimitExclusivity = stage.indexOf(
      `AND NOT EXISTS (\n        SELECT 1 FROM dasher.${contract.claim} AS other_claim\n        WHERE other_claim.organization_id = ${contract.resourceAlias}.organization_id\n          AND other_claim.${contract.resourceId} = ${contract.resourceAlias}.${contract.resourceId}`,
    );
    const recheckFinalizer = stage.indexOf(
      `${contract.resourceAlias === "artifact" ? "AND" : "WHERE"} NOT EXISTS (\n        SELECT 1 FROM dasher.${contract.finalizer} AS existing\n        WHERE existing.organization_id = v_organization_id\n          AND existing.${contract.resourceId} = candidate.${contract.candidateId}`,
      insert,
    );
    const recheckExclusivity = stage.indexOf(
      `AND NOT EXISTS (\n        SELECT 1 FROM dasher.${contract.claim} AS other_claim\n        WHERE other_claim.organization_id = v_organization_id\n          AND other_claim.${contract.resourceId} = candidate.${contract.candidateId}`,
      insert,
    );
    if (
      preLimitFinalizer < 0 ||
      preLimitExclusivity < 0 ||
      limit <= preLimitFinalizer ||
      limit <= preLimitExclusivity ||
      resourceLock <= limit ||
      claimLock <= resourceLock ||
      insert <= claimLock ||
      recheckFinalizer <= insert ||
      recheckExclusivity <= insert ||
      !stage.includes(
        `FROM unnest(${contract.arrayName}) AS candidate(${contract.candidateId})`,
      ) ||
      !stage.includes(`ORDER BY candidate.${contract.candidateId}`)
    ) {
      return false;
    }
  }
  const snapshotStage = purgeSource.slice(ranges[0]!.start, ranges[0]!.end);
  return (
    snapshotStage.match(
      /JOIN dasher[.]evidence_reference_claims AS evidence_claim/gu,
    )?.length === 2
  );
}

function hasExactPurgeCompletenessGate(purgeSource: string): boolean {
  const ranges = purgeStageRanges(purgeSource);
  if (ranges === undefined) return false;
  const artifactStage = purgeSource.slice(ranges[2]!.start, ranges[2]!.end);
  const discoveryReturn = artifactStage.indexOf(
    "IF v_row_count > 0 THEN RETURN; END IF;",
  );
  const gateStart = artifactStage.indexOf("\n\n", discoveryReturn);
  if (discoveryReturn < 0 || gateStart < 0) return false;
  const gate = artifactStage.slice(gateStart + 2);
  const contracts = [
    {
      alias: "snapshot",
      claim: "snapshot_reference_claims",
      finalizer: "snapshot_deletion_finalizers",
      id: "snapshot_id",
      link: "dashboard_version_snapshots",
      relation: "source_snapshots",
      variable: "v_gap_snapshot_id",
    },
    {
      alias: "evidence",
      claim: "evidence_reference_claims",
      finalizer: "evidence_deletion_finalizers",
      id: "evidence_id",
      link: "dashboard_version_evidence",
      relation: "evidence_records",
      variable: "v_gap_evidence_id",
    },
    {
      alias: "artifact",
      claim: "artifact_reference_claims",
      finalizer: "artifact_deletion_finalizers",
      id: "artifact_id",
      link: undefined,
      relation: "dashboard_artifacts",
      variable: "v_gap_artifact_id",
    },
  ] as const;
  const starts = contracts.map((contract) =>
    gate.indexOf(
      `SELECT ${contract.alias}.${contract.id} INTO ${contract.variable}\n` +
        `  FROM dasher.${contract.relation} AS ${contract.alias}`,
    ),
  );
  if (
    starts.some((start) => start < 0) ||
    starts.some((start, index) => index > 0 && start <= starts[index - 1]!) ||
    contracts.some(
      (contract) =>
        purgeSource.split(`  ${contract.variable} uuid;`).length !== 2,
    ) ||
    (gate.match(/\bLIMIT 1\b/gu)?.length ?? 0) !== 3 ||
    (gate.match(/FOR UPDATE OF (?:snapshot|evidence|artifact);/gu)?.length ??
      0) !== 3 ||
    (gate.match(/FOR UPDATE OF (?:claim|other_claim|evidence_claim);/gu)
      ?.length ?? 0) !== 0 ||
    (gate.match(
      /PERFORM 1 FROM dasher[.](?:source_snapshots|evidence_records|dashboard_artifacts)/gu,
    )?.length ?? 0) !== 0
  ) {
    return false;
  }
  for (let index = 0; index < contracts.length; index += 1) {
    const contract = contracts[index]!;
    const block = gate.slice(starts[index], starts[index + 1] ?? gate.length);
    const probe =
      `SELECT ${contract.alias}.${contract.id} INTO ${contract.variable}\n` +
      `  FROM dasher.${contract.relation} AS ${contract.alias}`;
    const lockAndRecheck =
      `  ORDER BY ${contract.alias}.${contract.id}\n` +
      "  LIMIT 1\n" +
      `  FOR UPDATE OF ${contract.alias};\n` +
      `  IF ${contract.variable} IS NOT NULL AND EXISTS (\n` +
      `    SELECT 1 FROM dasher.${contract.relation} AS ${contract.alias}`;
    const probeExclusivity =
      "AND NOT (other_claim.dashboard_id = $1\n" +
      "          AND other_claim.claim_kind = 'access_bearing'\n" +
      "          AND other_claim.hold_id IS NULL)";
    const recheckExclusivity =
      "AND NOT (other_claim.dashboard_id = $1\n" +
      "            AND other_claim.claim_kind = 'access_bearing'\n" +
      "            AND other_claim.hold_id IS NULL)";
    const probeFinalizerGap =
      `AND NOT EXISTS (\n      SELECT 1 FROM dasher.${contract.finalizer} AS finalizer\n` +
      `      WHERE finalizer.organization_id = ${contract.alias}.organization_id\n` +
      `        AND finalizer.${contract.id} = ${contract.alias}.${contract.id}\n` +
      "    )";
    const recheckFinalizerGap =
      `AND NOT EXISTS (\n        SELECT 1 FROM dasher.${contract.finalizer} AS finalizer\n` +
      `        WHERE finalizer.organization_id = ${contract.alias}.organization_id\n` +
      `          AND finalizer.${contract.id} = ${contract.alias}.${contract.id}\n` +
      "      )";
    if (
      !block.startsWith(probe) ||
      !block.includes(lockAndRecheck) ||
      block.split("LIMIT 1").length !== 2 ||
      block.split(`FOR UPDATE OF ${contract.alias};`).length !== 2 ||
      block.split(`dasher.${contract.finalizer} AS finalizer`).length !== 3 ||
      block.split(`dasher.${contract.claim} AS other_claim`).length !== 3 ||
      block.split(probeFinalizerGap).length !== 2 ||
      block.split(recheckFinalizerGap).length !== 2 ||
      block.split(probeExclusivity).length !== 2 ||
      block.split(recheckExclusivity).length !== 2 ||
      block.split(`${contract.alias}.${contract.id} = ${contract.variable}`)
        .length !== 2 ||
      block.split(
        "RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';",
      ).length !== 2 ||
      (contract.link === undefined
        ? block.split("artifact.ownership_class = 'dashboard_owned'").length !==
            3 ||
          block.split("artifact.ownership_class = 'shared'").length !== 3 ||
          block.split("FROM dasher.artifact_reference_claims AS target_claim")
            .length !== 3 ||
          block.split("target_claim.dashboard_id = $1").length !== 3 ||
          block.split("target_claim.claim_kind = 'access_bearing'").length !==
            3 ||
          block.split("target_claim.hold_id IS NULL").length !== 3
        : block.split(`dasher.${contract.link} AS link`).length !== 3)
    ) {
      return false;
    }
    if (
      contract.alias === "snapshot" &&
      (block.split("dasher.evidence_records AS related_evidence").length !==
        3 ||
        block.split("dasher.evidence_reference_claims AS evidence_claim")
          .length !== 3)
    ) {
      return false;
    }
  }
  return true;
}

function hasExactSharedArtifactGovernance(
  purgeSource: string,
  retentionTriggerSource: string,
  policies: readonly Readonly<{
    name: string;
    using: string | null;
    withCheck: string | null;
  }>[],
): boolean {
  const ranges = purgeStageRanges(purgeSource);
  if (ranges === undefined) return false;
  const artifactStage = purgeSource.slice(ranges[2]!.start, ranges[2]!.end);
  const artifactIntentEnd = artifactStage.indexOf(
    "  SELECT snapshot.snapshot_id INTO v_gap_snapshot_id",
  );
  if (artifactIntentEnd < 0) return false;
  const artifactIntentStage = artifactStage.slice(0, artifactIntentEnd);
  const finalProofStart = purgeSource.indexOf(
    "  IF EXISTS (\n    SELECT 1 FROM dasher.dashboard_versions AS version",
  );
  const finalProofEnd = purgeSource.indexOf(
    "  IF v_coordination.current_step <> 'final_proof_ready' THEN",
    finalProofStart,
  );
  const finalProof = purgeSource.slice(finalProofStart, finalProofEnd);
  const artifactDeleteStart = retentionTriggerSource.indexOf(
    "      TG_TABLE_NAME = 'dashboard_artifacts'",
  );
  const artifactDeleteEnd = retentionTriggerSource.indexOf(
    "    )\n  ) THEN",
    artifactDeleteStart,
  );
  const artifactDelete = retentionTriggerSource.slice(
    artifactDeleteStart,
    artifactDeleteEnd,
  );
  const policyByName = new Map(
    policies.map((policy) => [policy.name, policy] as const),
  );
  const selectPolicy = policyByName.get("dashboard_artifacts_retention_select");
  const deletePolicy = policyByName.get("dashboard_artifacts_retention_delete");
  const lockPolicy = policyByName.get(
    "dashboard_artifacts_retention_lock_update",
  );
  const selectUsing = selectPolicy?.using ?? "";
  const deleteUsing = deletePolicy?.using ?? "";
  const lockUsing = lockPolicy?.using ?? "";
  const lockCheck = lockPolicy?.withCheck ?? "";
  return (
    artifactIntentStage.split("artifact.ownership_class = 'dashboard_owned'")
      .length === 3 &&
    artifactIntentStage.split("artifact.ownership_class = 'shared'").length ===
      3 &&
    artifactIntentStage.split(
      "FROM dasher.artifact_reference_claims AS target_claim",
    ).length === 3 &&
    artifactIntentStage.split("target_claim.dashboard_id = $1").length === 3 &&
    artifactIntentStage.includes(
      "FROM dasher.dashboard_artifacts AS artifact\n        WHERE artifact.organization_id = v_organization_id\n          AND artifact.artifact_id = candidate.artifact_id",
    ) &&
    hasExactPurgeCompletenessGate(purgeSource) &&
    finalProofStart >= 0 &&
    finalProofEnd > finalProofStart &&
    finalProof.includes("artifact.ownership_class = 'dashboard_owned'") &&
    finalProof.includes("artifact.ownership_class = 'shared'") &&
    finalProof.includes(
      "FROM dasher.artifact_reference_claims AS target_claim",
    ) &&
    finalProof.includes("target_claim.dashboard_id = $1") &&
    finalProof.includes(
      "FROM dasher.artifact_deletion_finalizers AS finalizer",
    ) &&
    finalProof.includes("uuid_send(v_organization_id) || uuid_send($1)") &&
    artifactDeleteStart >= 0 &&
    artifactDeleteEnd > artifactDeleteStart &&
    artifactDelete.includes("OLD.ownership_class = 'dashboard_owned'") &&
    artifactDelete.includes(
      "OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id",
    ) &&
    artifactDelete.includes("OLD.ownership_class = 'shared'") &&
    artifactDelete.includes(
      "FROM dasher.artifact_deletion_finalizers AS finalizer",
    ) &&
    artifactDelete.includes("finalizer.state = 'deleted'") &&
    artifactDelete.includes("finalizer.proof_sha256 IS NOT NULL") &&
    artifactDelete.includes("finalizer.bytes_deleted_at IS NOT NULL") &&
    artifactDelete.includes(
      "uuid_send(v_organization_id) || uuid_send(v_dashboard_id)",
    ) &&
    artifactDelete.includes("artifact|expected_claim_set=empty") &&
    [selectUsing, lockUsing, lockCheck].every(
      (expression) =>
        expression.includes("ownership_class = 'dashboard_owned'::text") &&
        expression.includes("ownership_class = 'shared'::text") &&
        expression.includes(
          "dasher.artifact_reference_claims AS target_claim",
        ) &&
        expression.includes(
          "target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid",
        ),
    ) &&
    selectUsing.includes(
      "dasher.artifact_deletion_finalizers AS target_finalizer",
    ) &&
    selectUsing.includes("artifact|expected_claim_set=empty") &&
    deleteUsing.includes("ownership_class = 'dashboard_owned'::text") &&
    deleteUsing.includes("ownership_class = 'shared'::text") &&
    deleteUsing.includes(
      "dasher.artifact_deletion_finalizers AS target_finalizer",
    ) &&
    deleteUsing.includes("target_finalizer.state = 'deleted'::text") &&
    deleteUsing.includes("target_finalizer.proof_sha256 IS NOT NULL") &&
    deleteUsing.includes("target_finalizer.bytes_deleted_at IS NOT NULL") &&
    deleteUsing.includes(
      "uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid)",
    ) &&
    deleteUsing.includes(
      "uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)",
    ) &&
    deleteUsing.includes("artifact|expected_claim_set=empty")
  );
}

function hasCrashResumablePurgeSemantics(
  purgeSource: string,
  retentionTriggerSource: string,
): boolean {
  const purgeStart = purgeSource.indexOf(
    "UPDATE dasher.dashboards\n    SET purge_started_at = v_now",
  );
  const startReturn = purgeSource.indexOf("    RETURN;", purgeStart);
  const intent = purgeSource.indexOf(
    "INSERT INTO dasher.snapshot_deletion_finalizers",
  );
  const eligible = purgeSource.indexOf(
    "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
  );
  const deleted = purgeSource.indexOf(
    "SET state = 'deleted', bytes_deleted_at = v_now",
  );
  const finalProof = purgeSource.indexOf(
    "SET current_step = 'final_proof_ready'",
  );
  const clean = purgeSource.indexOf(
    "UPDATE dasher.dashboards SET lifecycle_state = 'cleaned'",
  );
  const event = purgeSource.indexOf(
    "INSERT INTO dasher.dashboard_lifecycle_events",
  );
  const audit = purgeSource.indexOf("INSERT INTO dasher.audit_events");
  return (
    purgeSource.match(/v_batch_limit constant integer := 100;/gu)?.length ===
      1 &&
    hasExactPurgeStageContract(purgeSource) &&
    hasExactFinalizerPaginationClosure(purgeSource) &&
    hasExactPurgeCompletenessGate(purgeSource) &&
    purgeStart >= 0 &&
    startReturn > purgeStart &&
    intent > startReturn &&
    eligible > intent &&
    deleted > eligible &&
    purgeSource.match(
      /SET state = 'eligible', proof_sha256 = finalizer[.]expected_claim_set_sha256/gu,
    )?.length === 3 &&
    purgeSource.match(/SET state = 'deleted', bytes_deleted_at = v_now/gu)
      ?.length === 3 &&
    finalProof > deleted &&
    clean > finalProof &&
    event > clean &&
    audit > event &&
    purgeSource.match(/dashboard_lifecycle_events/gu)?.length === 1 &&
    purgeSource.match(/lifecycle_revision = lifecycle_revision \+ 1/gu)
      ?.length === 1 &&
    retentionTriggerSource.includes(
      "OLD.state = 'intent' AND NEW.state = 'eligible'",
    ) &&
    retentionTriggerSource.includes(
      "OLD.state = 'eligible' AND NEW.state = 'deleted'",
    ) &&
    !retentionTriggerSource.includes(
      "OLD.state IN ('intent', 'eligible')\n      AND NEW.state = 'deleted'",
    )
  );
}

const evidencePurgeReachabilityNodes = [
  "evidence_record",
  "dashboard_version_evidence",
  "evidence_access_claim",
  "audit",
  "evidence_finalizer_intent",
  "evidence_finalizer_eligible",
  "evidence_deleted",
  "snapshot_deleted",
] as const;

type EvidencePurgeReachabilityNode =
  (typeof evidencePurgeReachabilityNodes)[number];

const exactCreateEvidenceLinkInsert =
  "INSERT INTO dasher.dashboard_version_evidence (\n" +
  "    organization_id, dashboard_id, version_id, evidence_id\n" +
  "  ) VALUES (v_organization_id, $1, $2, $3);";

function hasExactCreateEvidenceWriteOrder(functionSource: string): boolean {
  const evidenceWrite = functionSource.indexOf(
    "INSERT INTO dasher.evidence_records",
  );
  const linkWrite = functionSource.indexOf(exactCreateEvidenceLinkInsert);
  const claimWrite = functionSource.indexOf(
    "INSERT INTO dasher.evidence_reference_claims",
  );
  const auditWrite = functionSource.indexOf("INSERT INTO dasher.audit_events");
  const auditStatementEnd = functionSource.indexOf("  );", auditWrite);
  const writesAfterAudit = functionSource
    .slice(auditStatementEnd + 4)
    .match(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+dasher[.]/gu);
  return (
    evidenceWrite >= 0 &&
    linkWrite > evidenceWrite &&
    claimWrite > linkWrite &&
    auditWrite > claimWrite &&
    auditStatementEnd > auditWrite &&
    writesAfterAudit === null &&
    functionSource.match(/INSERT INTO dasher[.]evidence_records/gu)?.length ===
      1 &&
    functionSource.match(/INSERT INTO dasher[.]dashboard_version_evidence/gu)
      ?.length === 1 &&
    functionSource.match(/INSERT INTO dasher[.]evidence_reference_claims/gu)
      ?.length === 1 &&
    functionSource.match(/INSERT INTO dasher[.]audit_events/gu)?.length === 1
  );
}

function hasExactPurgeEvidenceIntentSelector(purgeSource: string): boolean {
  const start = purgeSource.indexOf(
    "  v_evidence_ids := ARRAY(\n" +
      "    SELECT evidence.evidence_id\n" +
      "    FROM dasher.evidence_records AS evidence",
  );
  const end = purgeSource.indexOf("  );\n  PERFORM 1", start);
  if (start < 0 || end < 0) return false;
  const selector = purgeSource.slice(start, end);
  return (
    containsFragmentsInOrder(selector, [
      "WHERE evidence.organization_id = v_organization_id",
      "SELECT 1 FROM dasher.dashboard_version_evidence AS link",
      "link.organization_id = evidence.organization_id",
      "link.dashboard_id = $1",
      "link.evidence_id = evidence.evidence_id",
      "FROM dasher.evidence_deletion_finalizers AS existing",
      "existing.evidence_id = evidence.evidence_id",
      "FROM dasher.evidence_reference_claims AS other_claim",
      "ORDER BY evidence.evidence_id",
      "LIMIT v_batch_limit",
      "FOR UPDATE OF evidence",
    ]) &&
    selector.match(/FROM dasher[.]dashboard_version_evidence AS link/gu)
      ?.length === 1 &&
    selector.match(/FROM dasher[.]evidence_deletion_finalizers AS existing/gu)
      ?.length === 1
  );
}

function evidencePurgeReachabilityGraph(
  createEvidenceSource: string,
  purgeSource: string,
): ReadonlySet<EvidencePurgeReachabilityNode> {
  const edges = new Map<
    EvidencePurgeReachabilityNode,
    EvidencePurgeReachabilityNode[]
  >();
  const addEdge = (
    from: EvidencePurgeReachabilityNode,
    to: EvidencePurgeReachabilityNode,
  ): void => {
    edges.set(from, [...(edges.get(from) ?? []), to]);
  };

  if (hasExactCreateEvidenceWriteOrder(createEvidenceSource)) {
    addEdge("evidence_record", "dashboard_version_evidence");
    addEdge("dashboard_version_evidence", "evidence_access_claim");
    addEdge("evidence_access_claim", "audit");
  }
  if (hasExactPurgeEvidenceIntentSelector(purgeSource)) {
    addEdge("evidence_access_claim", "evidence_finalizer_intent");
  }

  const claimDelete = purgeSource.indexOf(
    "DELETE FROM dasher.evidence_reference_claims AS claim",
  );
  const eligible = purgeSource.indexOf(
    "UPDATE dasher.evidence_deletion_finalizers AS finalizer\n" +
      "  SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
  );
  const evidenceDelete = purgeSource.indexOf(
    "DELETE FROM dasher.evidence_records AS evidence",
  );
  const snapshotDelete = purgeSource.indexOf(
    "DELETE FROM dasher.source_snapshots AS snapshot",
  );
  const snapshotDependencyProof = purgeSource.indexOf(
    "SELECT 1 FROM dasher.evidence_records AS evidence\n" +
      "        WHERE evidence.organization_id = finalizer.organization_id\n" +
      "          AND evidence.snapshot_id = finalizer.snapshot_id",
    evidenceDelete,
  );
  if (claimDelete >= 0 && eligible > claimDelete) {
    addEdge("evidence_finalizer_intent", "evidence_finalizer_eligible");
  }
  if (evidenceDelete > eligible) {
    addEdge("evidence_finalizer_eligible", "evidence_deleted");
  }
  if (
    snapshotDependencyProof > evidenceDelete &&
    snapshotDelete > snapshotDependencyProof
  ) {
    addEdge("evidence_deleted", "snapshot_deleted");
  }

  const reachable = new Set<EvidencePurgeReachabilityNode>(["evidence_record"]);
  const pending: EvidencePurgeReachabilityNode[] = ["evidence_record"];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const next of edges.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        pending.push(next);
      }
    }
  }
  return reachable;
}

function hasClosedResourceFinalizerProtocol(
  createEvidenceSource: string,
  createVersionSource: string,
  restoreSource: string,
  purgeSource: string,
): boolean {
  return (
    hasExactCreateEvidenceWriteOrder(createEvidenceSource) &&
    containsFragmentsInOrder(createEvidenceSource, [
      "FROM dasher.source_snapshots AS snapshot",
      "FOR SHARE;",
      "FROM dasher.snapshot_deletion_finalizers AS finalizer",
      "finalizer.snapshot_id = $4",
      "FROM dasher.evidence_deletion_finalizers AS finalizer",
      "finalizer.evidence_id = $3",
      "INSERT INTO dasher.evidence_records",
      "INSERT INTO dasher.dashboard_version_evidence",
      "INSERT INTO dasher.evidence_reference_claims",
      "INSERT INTO dasher.audit_events",
    ]) &&
    containsFragmentsInOrder(createVersionSource, [
      "FROM dasher.source_snapshots AS snapshot",
      "ORDER BY snapshot.snapshot_id FOR SHARE;",
      "FROM dasher.snapshot_deletion_finalizers AS finalizer",
      "finalizer.snapshot_id = ANY($11)",
      "FROM dasher.evidence_records AS evidence",
      "ORDER BY evidence.evidence_id FOR SHARE;",
      "FROM dasher.evidence_deletion_finalizers AS finalizer",
      "finalizer.evidence_id = ANY($13)",
      "INSERT INTO dasher.dashboard_versions",
      "INSERT INTO dasher.dashboard_version_snapshots",
      "INSERT INTO dasher.dashboard_version_evidence",
      "INSERT INTO dasher.snapshot_reference_claims",
      "INSERT INTO dasher.evidence_reference_claims",
    ]) &&
    containsFragmentsInOrder(restoreSource, [
      "FROM dasher.source_snapshots AS snapshot",
      "ORDER BY snapshot.snapshot_id FOR SHARE;",
      "FROM dasher.snapshot_deletion_finalizers AS finalizer",
      "JOIN dasher.dashboard_version_snapshots AS link",
      "FROM dasher.evidence_records AS evidence",
      "ORDER BY evidence.evidence_id FOR SHARE;",
      "FROM dasher.evidence_deletion_finalizers AS finalizer",
      "JOIN dasher.dashboard_version_evidence AS link",
      "INSERT INTO dasher.dashboards",
      "INSERT INTO dasher.dashboard_versions",
      "INSERT INTO dasher.dashboard_version_snapshots",
      "INSERT INTO dasher.dashboard_version_evidence",
      "INSERT INTO dasher.snapshot_reference_claims",
      "INSERT INTO dasher.evidence_reference_claims",
    ]) &&
    hasExactPurgeStageContract(purgeSource) &&
    hasExactFinalizerPaginationClosure(purgeSource) &&
    hasExactPurgeCompletenessGate(purgeSource) &&
    purgeSource.match(/FOR UPDATE OF snapshot[;\n]/gu)?.length === 2 &&
    purgeSource.match(/FOR UPDATE OF evidence[;\n]/gu)?.length === 2 &&
    purgeSource.match(/FOR UPDATE OF artifact[;\n]/gu)?.length === 2 &&
    purgeSource.match(/FROM unnest\(v_(?:snapshot|evidence|artifact)_ids\)/gu)
      ?.length === 3 &&
    hasExactPurgeEvidenceIntentSelector(purgeSource) &&
    evidencePurgeReachabilityGraph(createEvidenceSource, purgeSource).size ===
      evidencePurgeReachabilityNodes.length
  );
}

function hasExactCreateSemantics(functionSource: string): boolean {
  return (
    functionSource.includes("$4 NOT IN (3600, 86400, 604800, 2592000)") &&
    functionSource.includes("SELECT v_organization_id, 1, 86400, 1") &&
    functionSource.includes(
      "v_ttl_seconds := CASE WHEN $5 THEN v_default_ttl_seconds ELSE $4 END",
    ) &&
    functionSource.includes("'draft', 0, 0, 0") &&
    !functionSource.includes("dashboard_lifecycle_events") &&
    containsFragmentsInOrder(functionSource, [
      "INSERT INTO dasher.dashboard_lifecycle_policies",
      "WHERE NOT EXISTS",
      "SELECT policy_revision, default_disposable_ttl_seconds",
      "ORDER BY policy_revision DESC",
      "LIMIT 1",
      "FOR UPDATE",
      "policy_revision > v_policy_row_revision",
      "INSERT INTO dasher.dashboards",
      "INSERT INTO dasher.audit_events",
    ]) &&
    functionSource.includes("'dashboard.created'")
  );
}

function hasExactCasSemantics(functionSource: string): boolean {
  const lockedSelectionPosition = functionSource.indexOf(
    "SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard",
  );
  const lockedSelection = functionSource.slice(
    lockedSelectionPosition,
    functionSource.indexOf("IF NOT FOUND THEN", lockedSelectionPosition),
  );
  const updatePosition = functionSource.indexOf("UPDATE dasher.dashboards");
  const losingCasDenial = functionSource.indexOf(
    "IF NOT FOUND THEN",
    updatePosition,
  );
  const eventWrite = functionSource.indexOf(
    "INSERT INTO dasher.dashboard_lifecycle_events",
    updatePosition,
  );
  const updateStatement = functionSource.slice(
    updatePosition,
    functionSource.indexOf(";", updatePosition) + 1,
  );
  return (
    lockedSelection.includes(
      "dashboard.head_version_id IS NOT DISTINCT FROM $2",
    ) &&
    lockedSelection.includes("dashboard.lifecycle_revision = $4") &&
    lockedSelection.includes("FOR UPDATE") &&
    lockedSelection.includes(
      "dashboard.lifecycle_state IN ('draft', 'active')",
    ) &&
    functionSource.includes(
      "CASE WHEN v_dashboard.lifecycle_state = 'draft'\n    THEN 'head_activated' ELSE 'head_advanced' END",
    ) &&
    functionSource.includes(
      "lifecycle_state = CASE WHEN lifecycle_state = 'draft' THEN 'active'",
    ) &&
    functionSource.includes("lifecycle_revision = lifecycle_revision + 1") &&
    functionSource.includes("v_now >= v_dashboard.effective_expires_at") &&
    containsFragmentsInOrder(functionSource, [
      "set_config('dasher.lifecycle_expected_revision', $4::text, true)",
      "UPDATE dasher.dashboards",
    ]) &&
    updateStatement.includes("head_version_id IS NOT DISTINCT FROM $2") &&
    updateStatement.includes("lifecycle_revision = $4") &&
    functionSource
      .slice(eventWrite, functionSource.indexOf(");", eventWrite) + 2)
      .includes("$4 + 1, v_event_kind") &&
    !/SET[\s\S]{0,300}(?:capability_epoch|cache_epoch)\s*=/u.test(
      functionSource.slice(updatePosition, eventWrite),
    ) &&
    updatePosition >= 0 &&
    losingCasDenial > updatePosition &&
    eventWrite > losingCasDenial &&
    hasLifecycleWriteSemantics(
      functionSource,
      "UPDATE dasher.dashboards",
      "'head_activated'",
      "'dashboard_head.promoted'",
    ) &&
    functionSource.includes("'head_advanced'")
  );
}

function policyCapabilities(expression: string): readonly string[] | null {
  const match =
    /current_setting\('dasher[.]retention_capability'::text, true\) = ANY \(ARRAY\[([^\]]+)\]\)/u.exec(
      expression,
    );
  if (match?.[1] === undefined) return null;
  return [...match[1].matchAll(/'([^']+)'::text/gu)].map(
    (capability) => capability[1]!,
  );
}

function hasBoundAuthoritySemantics(expression: string): boolean {
  return (
    expression.includes("CURRENT_USER = 'dasher_retention_definer'::name") &&
    expression.includes(
      "current_setting('dasher.retention_phase'::text, true) = 'authorized'::text",
    ) &&
    expression.includes("bound_authority.binding_subject = SESSION_USER") &&
    expression.includes(
      "later_authority.principal_revision > bound_authority.principal_revision",
    ) &&
    expression.includes(
      "CASE current_setting('dasher.retention_capability'::text, true)",
    )
  );
}

function hasExactPolicyCapabilities(
  policy: Readonly<{
    bootstrap: boolean;
    command: string;
    roles: readonly string[];
    using: string | null;
    withCheck: string | null;
  }>,
  expectedCapabilities: readonly string[],
): boolean {
  const expressions = [
    ...(policy.command === "INSERT" ? [] : [policy.using ?? ""]),
    ...(policy.command === "INSERT" || policy.command === "UPDATE"
      ? [policy.withCheck ?? ""]
      : []),
  ];
  return (
    !policy.bootstrap &&
    policy.roles.length === 1 &&
    policy.roles[0] === "dasher_retention_definer" &&
    expressions.length > 0 &&
    expressions.every(
      (expression) =>
        JSON.stringify(policyCapabilities(expression)) ===
          JSON.stringify(expectedCapabilities) &&
        hasBoundAuthoritySemantics(expression),
    )
  );
}

function hasExactDiscoveryPolicySemantics(expression: string): boolean {
  return (
    JSON.stringify(policyCapabilities(expression)) ===
      JSON.stringify([
        "materialize_expiry",
        "place_hold",
        "release_hold",
        "claim_cleanup",
        "record_attempt",
        "purge",
      ]) &&
    expression.includes(
      "current_setting('dasher.retention_phase'::text, true) = 'target_discovery'::text",
    ) &&
    expression.includes("bound_authority.binding_subject = SESSION_USER") &&
    expression.includes(
      "organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid",
    ) &&
    expression.includes(
      "dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid",
    ) &&
    !expression.includes("'initialize'::text")
  );
}

function establishesInitializerContextOnlyAfterValidation(
  functionSource: string,
): boolean {
  const firstContextWrite = functionSource.indexOf("set_config(");
  return (
    firstContextWrite >= 0 &&
    containsFragmentsInOrder(functionSource, [
      "pg_advisory_xact_lock",
      "WITH exact_binding AS MATERIALIZED",
      "proof.distinct_principal_count = 1",
      "FROM unique_latest",
      "WITH RECURSIVE authority_chain",
      "OR NOT v_can_initialize OR NOT v_capability_allowed",
      "set_config(",
    ]) &&
    firstContextWrite >
      functionSource.indexOf(
        "OR NOT v_can_initialize OR NOT v_capability_allowed",
      )
  );
}

function hasInitializerAuthoritySemantics(functionSource: string): boolean {
  return (
    establishesInitializerContextOnlyAfterValidation(functionSource) &&
    hasExactBindingCardinalityProof(functionSource) &&
    functionSource.includes(
      "v_chain_count <> v_principal_revision OR v_chain_min_revision <> 1",
    ) &&
    functionSource.includes(
      "OR NOT v_can_initialize OR NOT v_capability_allowed",
    ) &&
    functionSource.includes(
      "set_config('dasher.retention_capability', $2, true)",
    ) &&
    functionSource.includes("IF $1 IS NULL OR $5 IS NULL OR $2 NOT IN (") &&
    functionSource.includes(
      "set_config('dasher.retention_target_organization_id', $5::text, true)",
    ) &&
    functionSource.includes(
      "WHERE dashboard.organization_id = $5\n    AND dashboard.dashboard_id = $1;",
    ) &&
    !/FROM dasher[.]dashboards[\s\S]*FOR UPDATE/iu.test(functionSource) &&
    !functionSource.includes(
      "set_config('dasher.retention_capability', 'initialize', true)",
    )
  );
}

function harnessContextFollowsUniqueLatestValidation(
  functionSource: string,
): boolean {
  const firstContextWrite = functionSource.indexOf("set_config(");
  const latestValidation = functionSource.indexOf(
    "IF NOT FOUND OR NOT v_enabled",
  );
  return (
    hasExactBindingCardinalityProof(functionSource) &&
    containsFragmentsInOrder(functionSource, [
      "pg_advisory_xact_lock",
      "WITH exact_binding AS MATERIALIZED",
      "proof.distinct_principal_count = 1",
      "FROM unique_latest",
      "IF NOT FOUND OR NOT v_enabled",
      "set_config(",
    ]) &&
    firstContextWrite > latestValidation
  );
}

const identityAuditMigration = {
  sequence: 1,
  filename: "0001_identity_audit.sql",
  checksum: "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
} as const;

const securityBoundaryMigration = {
  sequence: 2,
  filename: "0002_security_boundary.sql",
  checksum: "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
} as const;

const immutableContentMigration = {
  sequence: 3,
  filename: "0003_immutable_content.sql",
  checksum: "270ba6f5b8756425835ebb0df0ea8f8c4739b81202d2b4f2b48172a016db9c40",
} as const;

const lifecycleApiCorrectionMigration = {
  sequence: 4,
  filename: "0004_lifecycle_api_correction.sql",
  checksum: "353021e04bd32183cba82e0069948d43fecf27f4b5ec9995bfb143419279e5d9",
} as const;

const securityDefinerCleanupCoordinationMigration = {
  sequence: 5,
  filename: "0005_security_definer_cleanup_coordination.sql",
  checksum: "f9e33e7a4033d77c1e56f098de68a519f2cfe434119c3bf5ffe13b8a3f9713e7",
} as const;

const lifecycleAccessRetentionGuardCorrectionMigration = {
  sequence: 6,
  filename: "0006_lifecycle_access_retention_guard_correction.sql",
  checksum: "26a6075696c5aba6562a87f63564860e49b22cdbc1c8015335e19006044bd499",
} as const;

const task4FunctionIdentities = [
  "dasher_api.accept_invitation",
  "dasher_api.change_membership_role",
  "dasher_api.initialize_context",
  "dasher_api.issue_invitation",
  "dasher_api.issue_session",
  "dasher_api.revoke_invitation",
  "dasher_api.revoke_membership",
  "dasher_api.revoke_session",
  "dasher_api.rotate_session",
  "dasher_private.context_allows",
  "dasher_private.context_authority_revision",
  "dasher_private.context_membership_id",
  "dasher_private.context_organization_id",
  "dasher_private.context_request_id",
  "dasher_private.context_session_id",
  "dasher_private.context_user_id",
] as const;

describe("Task 3, Task 4, Task 8, and Task 9 canonical migration golden guard", () => {
  it("pins immutable 0001-0006 and exact canonical 0007 source bytes", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    expect(
      migrations.map((migration) => ({
        sequence: migration.sequence,
        filename: migration.filename,
        checksum: Buffer.from(migration.checksumSha256).toString("hex"),
      })),
    ).toEqual([
      identityAuditMigration,
      securityBoundaryMigration,
      immutableContentMigration,
      lifecycleApiCorrectionMigration,
      securityDefinerCleanupCoordinationMigration,
      lifecycleAccessRetentionGuardCorrectionMigration,
      phase7Migration,
    ]);
    expect(
      migrations.slice(0, 4).map((migration) => migration.bytes.byteLength),
    ).toEqual([17_033, 101_747, 482_279, 104_489]);
    expect(Buffer.byteLength(migrations[4]?.sql ?? "")).toBe(556);
    expect(Buffer.byteLength(migrations[5]?.sql ?? "")).toBe(34_952);
  });

  it("contains no extension, credential, or UUID-generation source", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    for (const migration of migrations) {
      expect(migration.sql).not.toMatch(
        /CREATE\s+EXTENSION|gen_random_uuid|uuid_generate|PASSWORD\s+'|sk-proj|BEGIN\s+(?:RSA|OPENSSH)\s+PRIVATE|postgres(?:ql)?:\/\/|DASHER_TEST_(?:OWNER|APP)_DSN/iu,
      );
    }
  });

  it("closes canonical 0003 source over every frozen catalog identity and function body", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const sql = migrations[2]?.sql ?? "";
    const contract = modeled0003CatalogMatrix;
    const relationNames = new Set<string>(
      contract.relationCatalog.map((relation) => relation.name),
    );
    const occurrences = (fragment: string): number =>
      sql.split(fragment).length - 1;

    expect(Buffer.byteLength(sql)).toBe(482_279);
    expect(
      [...sql.matchAll(/\bCREATE TABLE ([a-z_]+[.][a-z_]+) \(/gu)].map(
        (match) => match[1],
      ),
    ).toEqual(
      contract.relationCatalog.map(
        (relation) => `${relation.schema}.${relation.name}`,
      ),
    );
    expect(
      [...sql.matchAll(/\bCREATE TYPE ([a-z_]+[.][a-z_]+) AS \(/gu)].map(
        (match) => match[1],
      ),
    ).toEqual(
      contract.types
        .filter((type) => !relationNames.has(type.name))
        .map((type) => `${type.schema}.${type.name}`),
    );

    for (const relation of contract.relationCatalog) {
      expect(
        occurrences(
          `ALTER TABLE ${relation.schema}.${relation.name} ENABLE ROW LEVEL SECURITY;`,
        ),
        `${relation.name} ENABLE RLS`,
      ).toBe(1);
      expect(
        occurrences(
          `ALTER TABLE ${relation.schema}.${relation.name} FORCE ROW LEVEL SECURITY;`,
        ),
        `${relation.name} FORCE RLS`,
      ).toBe(1);
    }
    for (const constraint of contract.constraints) {
      expect(
        occurrences(
          `ADD CONSTRAINT ${constraint.name} ${constraint.definition};`,
        ),
        constraint.name,
      ).toBe(1);
    }
    for (const index of contract.indexes.filter((index) => !index.primary)) {
      const expected =
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.name} ` +
        `ON dasher.${index.relation} USING btree (${index.keyExpressions.join(", ")})` +
        `${index.predicate === null ? "" : ` WHERE ${index.predicate}`};`;
      expect(occurrences(expected), index.name).toBe(1);
    }
    for (const trigger of contract.triggers) {
      expect(occurrences(`${trigger.definition};`), trigger.name).toBe(1);
    }
    for (const policy of contract.policies) {
      const expected = [
        `CREATE POLICY ${policy.name}`,
        `ON dasher.${policy.relation}`,
        "AS PERMISSIVE",
        `FOR ${policy.command}`,
        `TO ${policy.roles.join(", ")}`,
        ...(policy.using === null ? [] : [`USING (${policy.using})`]),
        ...(policy.withCheck === null
          ? []
          : [`WITH CHECK (${policy.withCheck})`]),
        ";",
      ].join("\n");
      expect(occurrences(expected), policy.name).toBe(1);
    }
    for (const routine of contract.functions) {
      const identity = `${routine.schema}.${routine.name}(${routine.identityArguments})`;
      const expected = [
        `CREATE FUNCTION ${identity}`,
        `RETURNS ${routine.returns}`,
        `LANGUAGE ${routine.language}`,
        routine.volatility,
        ...(routine.securityDefiner ? ["SECURITY DEFINER"] : []),
        "SET search_path = pg_catalog",
        `AS $function$${routine.source}$function$;`,
      ].join("\n");
      expect(occurrences(expected), identity).toBe(1);
      expect(routine.defaults, `${identity} defaults`).toEqual([]);
      expect(routine.variadic, `${identity} variadic`).toBe(false);
    }
    for (const acl of contract.relationAcls) {
      expect(
        occurrences(
          `GRANT ${acl.privilege} ON TABLE dasher.${acl.relationName} TO ${acl.role};`,
        ),
        `${acl.role} ${acl.relationName} ${acl.privilege}`,
      ).toBe(1);
    }
    for (const acl of contract.aclDependencyRows.filter(
      (row) => row.objectKind === "schema",
    )) {
      expect(
        occurrences(
          `GRANT ${acl.privilege} ON SCHEMA ${acl.identity} TO ${acl.grantee};`,
        ),
        `${acl.grantee} ${acl.identity} ${acl.privilege}`,
      ).toBe(1);
    }
    for (const acl of contract.catalogColumnAcls) {
      expect(
        occurrences(
          `GRANT ${acl.privilege} (${acl.columnName}) ON TABLE ${acl.schema}.${acl.relationName} TO ${acl.grantee};`,
        ),
        `${acl.grantee} ${acl.relationName}.${acl.columnName} ${acl.privilege}`,
      ).toBe(1);
    }
    for (const relation of contract.relationCatalog) {
      expect(
        occurrences(
          `REVOKE ALL ON TYPE ${relation.schema}.${relation.name} FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;`,
        ),
        `${relation.name} composite type ACL closure`,
      ).toBe(1);
    }

    expect(sql).not.toMatch(
      /\bCREATE\s+(?:ROLE|USER|EXTENSION|DATABASE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b/iu,
    );
    expect(sql.match(/\bCREATE FUNCTION\b/gu)).toHaveLength(26);
    expect(sql.match(/\bCREATE POLICY\b/gu)).toHaveLength(75);
    expect(sql.match(/\bCREATE TRIGGER\b/gu)).toHaveLength(23);
  });

  it("pins the exact Task 4 function set and closes every persistent function search path", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const functionDefinitions = migrations.slice(0, 2).flatMap((migration) =>
      migration.sql
        .split(/(?=CREATE FUNCTION )/gu)
        .slice(1)
        .map((fragment) => fragment.split(/\n\$function\$;/u)[0] ?? ""),
    );
    const securityBoundaryDefinitions =
      migrations[1]?.sql
        .split(/(?=CREATE FUNCTION )/gu)
        .slice(1)
        .map((fragment) => fragment.split(/\n\$function\$;/u)[0] ?? "") ?? [];
    const securityBoundaryIdentities = securityBoundaryDefinitions
      .map((definition) =>
        /^CREATE FUNCTION ([^(]+)\(/u.exec(definition)?.[1]?.trim(),
      )
      .filter((identity): identity is string => identity !== undefined)
      .sort();

    expect(functionDefinitions).toHaveLength(17);
    expect(securityBoundaryIdentities).toEqual(task4FunctionIdentities);
    for (const definition of functionDefinitions) {
      expect(definition).toContain("SET search_path = pg_catalog");
      expect(definition).not.toMatch(/\bEXECUTE\b/u);
    }
  });

  it("pins one database clock per entry or policy helper and exactly eight audit writers", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const sql = migrations[1]?.sql ?? "";

    expect(sql.match(/pg_catalog\.clock_timestamp\(\)/gu)).toHaveLength(10);
    expect(sql.match(/INSERT INTO dasher\.audit_events/gu)).toHaveLength(8);
    expect(sql).not.toMatch(
      /\b(?:now|statement_timestamp|transaction_timestamp)\s*\(/iu,
    );
  });

  it("pins 0002 responsibility for enabling and forcing RLS on every protected table", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const sql = migrations[1]?.sql ?? "";
    const rlsStatements = [
      "ALTER TABLE dasher.users ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.users FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.external_identities ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.external_identities FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.organizations ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.organizations FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.memberships ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.memberships FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.invitations ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.invitations FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.sessions ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.sessions FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.audit_events ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE dasher.audit_events FORCE ROW LEVEL SECURITY;",
    ];

    expect(
      sql.match(
        /ALTER TABLE dasher\.[a-z_]+ (?:ENABLE|FORCE) ROW LEVEL SECURITY;/gu,
      ),
    ).toEqual(rlsStatements);
    expect(sql.indexOf(rlsStatements.at(-1) ?? "")).toBeLessThan(
      sql.indexOf("CREATE POLICY organizations_select"),
    );
  });

  it("pins trusted advisory ordering, nonlocking proposed IDs, and exact session uniqueness handlers", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const sql = migrations[1]?.sql ?? "";
    const definitions = new Map(
      sql
        .split(/(?=CREATE FUNCTION )/gu)
        .slice(1)
        .map((fragment) => fragment.split(/\n\$function\$;/u)[0] ?? "")
        .map((definition) => [
          /^CREATE FUNCTION ([^(]+)\(/u.exec(definition)?.[1]?.trim() ?? "",
          definition,
        ]),
    );

    expect(sql.match(/'dasher:task4-organization:v1:'::text/gu)).toHaveLength(
      9,
    );
    expect(sql.match(/'dasher:invitation-family:v1:'::text/gu)).toHaveLength(3);
    expect(sql.match(/FOR v_advisory_key IN/gu)).toHaveLength(3);
    expect(sql.match(/ORDER BY key_set\.advisory_key/gu)).toHaveLength(3);

    for (const [identity, proposedParameter] of [
      ["dasher_api.accept_invitation", "p_new_session_id"],
      ["dasher_api.issue_session", "p_session_id"],
      ["dasher_api.rotate_session", "p_successor_session_id"],
    ] as const) {
      const definition = definitions.get(identity) ?? "";
      const rowLockStatements = definition
        .split(";")
        .filter((statement) => /\bFOR UPDATE\b/u.test(statement));
      const advisoryStatements = definition
        .split(";")
        .filter((statement) => /pg_advisory_xact_lock/u.test(statement));

      expect(definition).toContain("AS session_collision");
      expect(definition).toContain("v_constraint_name = CONSTRAINT_NAME");
      expect(definition).toContain("'sessions_pkey'");
      expect(definition).toContain("'sessions_token_key'");
      expect(definition).toContain("'sessions_csrf_key'");
      expect(definition).toMatch(/\bRAISE;\s+END;/u);
      for (const statement of [...rowLockStatements, ...advisoryStatements]) {
        expect(statement).not.toContain(proposedParameter);
      }
    }

    const rotation = definitions.get("dasher_api.rotate_session") ?? "";
    const rotationSessionLock = rotation
      .split(";")
      .find(
        (statement) =>
          statement.includes("FROM dasher.sessions AS session_row") &&
          statement.includes("FOR UPDATE"),
      );
    expect(rotationSessionLock).toContain("v_context_session_id");
    expect(rotationSessionLock).toContain("v_rotated_from_session_id");
    expect(rotationSessionLock).toContain("v_replaced_by_session_id");
  });
});

describe("Task 8A noncanonical modeled-0003 inventory", () => {
  it("keeps the modeled probe separate from the exact canonical 0003 identity", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      identityAuditMigration.filename,
      securityBoundaryMigration.filename,
      immutableContentMigration.filename,
      lifecycleApiCorrectionMigration.filename,
      securityDefinerCleanupCoordinationMigration.filename,
      lifecycleAccessRetentionGuardCorrectionMigration.filename,
      phase7Migration.filename,
    ]);
    expect(
      Buffer.from(migrations[2]?.checksumSha256 ?? []).toString("hex"),
    ).toBe(immutableContentMigration.checksum);
    expect(immutableContentMigration.checksum).not.toBe(
      "2feea09a7459e86bc64a34d728b191437b06439be4092daf0ac4ead586f43524",
    );
  });

  it("freezes the exact NOBYPASSRLS prepared pair and dependency-free prefix", () => {
    expect(modeled0003ManagedRoles.map((role) => role.name)).toEqual([
      "dasher_retention_definer",
      "dasher_retention_operator",
    ]);
    for (const role of modeled0003ManagedRoles) {
      expect(role.flags).toContain("NOBYPASSRLS");
      expect(role.flags).toContain("PASSWORD NULL");
      expect(role.flags).toContain("VALID UNTIL infinity");
      expect(role.settings).toEqual([]);
      expect(role.incomingMemberships).toEqual([]);
      expect(role.outgoingMemberships).toEqual([]);
    }
    expect(
      modeled0003CatalogMatrix.ownershipDependencyRows.some((row) =>
        row.identity.startsWith("dasher_retention_api."),
      ),
    ).toBe(true);
  });

  it("materializes every modeled column and index dimension in both independent sources", async () => {
    const [production, fixture] = await Promise.all([
      readFile(migratorSource, "utf8"),
      readFile(modeledInventorySource, "utf8"),
    ]);
    const fieldCount = (source: string, field: string): number =>
      [...source.matchAll(new RegExp(`^\\s+(?:"?${field}"?):`, "gmu"))].length;
    const productionContract = production.slice(
      production.indexOf("// STATIC EXPECTED CATALOG CONTRACT BEGIN"),
      production.indexOf("// STATIC EXPECTED CATALOG CONTRACT END"),
    );
    const productionColumns = productionContract.slice(
      productionContract.indexOf("  columns: ["),
      productionContract.indexOf("\n  types: ["),
    );
    const productionIndexes = productionContract.slice(
      productionContract.indexOf("  indexes: ["),
      productionContract.indexOf("\n  constraints: ["),
    );
    const fixtureColumns = fixture.slice(
      fixture.indexOf("export const modeled0003ColumnCatalog = ["),
      fixture.indexOf("const typedColumnIdentities"),
    );
    const fixtureMatrix = fixture.slice(
      fixture.indexOf("export const modeled0003CatalogMatrix ="),
    );
    const fixtureIndexes = fixtureMatrix.slice(
      fixtureMatrix.indexOf("  indexes: ["),
      fixtureMatrix.indexOf("\n  constraints: ["),
    );

    expect(fieldCount(productionColumns, "collation")).toBe(
      modeled0003CatalogMatrix.columns.length,
    );
    expect(fieldCount(fixtureColumns, "collation")).toBe(
      modeled0003CatalogMatrix.columns.length,
    );
    for (const field of ["includedColumns", "collations", "clustered"]) {
      expect(fieldCount(productionIndexes, field)).toBe(
        modeled0003CatalogMatrix.indexes.length,
      );
      expect(fieldCount(fixtureIndexes, field)).toBe(
        modeled0003CatalogMatrix.indexes.length,
      );
    }
    expect(productionIndexes).not.toMatch(/\.map\s*\(/u);
    expect(fixtureIndexes).not.toMatch(/\.map\s*\(/u);
  });

  it("keeps both expected catalog manifests static, explicit, and free of row inference", async () => {
    const [production, fixture] = await Promise.all([
      readFile(migratorSource, "utf8"),
      readFile(modeledInventorySource, "utf8"),
    ]);
    const forbiddenInference =
      /Object[.](?:keys|entries)\s*\(|[.](?:map|flatMap|filter)\s*\(|\bauthorizedPolicy\s*\(|\bproductionAuthorizedPolicy\s*\(|\bcolumnAcl\s*\(|\btriggerContract\s*\(/u;
    const productionManifest = markedSourceSection(
      production,
      "// STATIC EXPECTED CATALOG CONTRACT BEGIN",
      "// STATIC EXPECTED CATALOG CONTRACT END",
    );
    expect(productionManifest).not.toBe("");
    expect(productionManifest).not.toMatch(forbiddenInference);

    for (const sectionName of [
      "FUNCTIONS",
      "POLICIES",
      "PRIVILEGES",
      "TRIGGERS",
      "CHECK CONSTRAINTS",
      "CATALOG MATRIX",
    ]) {
      const section = markedSourceSection(
        fixture,
        `// STATIC EXPECTED ${sectionName} BEGIN`,
        `// STATIC EXPECTED ${sectionName} END`,
      );
      expect(section, sectionName).not.toBe("");
      expect(section, sectionName).not.toMatch(forbiddenInference);
    }

    const safetyMatrix = fixture.slice(
      fixture.indexOf("export const modeled0003SafetyMatrix ="),
      fixture.indexOf("function assertUniqueIdentities"),
    );
    expect(safetyMatrix).toContain(
      'bootstrapSelectPolicyNames: [\n    "retention_service_principal_self_binding_select",\n    "dashboards_retention_target_discovery_select",\n  ]',
    );
    expect(safetyMatrix).not.toMatch(
      /bootstrapSelectPolicyNames:[\s\S]*[.](?:map|filter)\s*\(/u,
    );
  });

  it("bridges all 26 semantic and catalog functions bidirectionally by exact identity and dimensions", () => {
    const semanticFunctions: readonly ExactModeledFunction[] =
      modeled0003Functions;
    const catalogFunctions: readonly ExactModeledFunction[] =
      modeled0003CatalogMatrix.functions;
    const mutate = (
      functions: readonly ExactModeledFunction[],
      identity: string,
      changes: Partial<ExactModeledFunction>,
    ): readonly ExactModeledFunction[] =>
      functions.map((routine) =>
        exactModeledFunctionIdentity(routine) === identity
          ? { ...routine, ...changes }
          : routine,
      );
    const listIdentity = "dasher_api.list_dashboards(integer)";
    const createIdentity =
      "dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text)";
    const getSummaryIdentity = "dasher_api.get_dashboard_summary(uuid)";
    const listFunction = semanticFunctions.find(
      (routine) => exactModeledFunctionIdentity(routine) === listIdentity,
    );
    expect(listFunction).toBeDefined();

    expect(exactModeled0003FunctionIdentities).toHaveLength(26);
    expect(new Set(exactModeled0003FunctionIdentities).size).toBe(26);
    expect(
      exactModeledFunctionBridgeMismatches(semanticFunctions, catalogFunctions),
    ).toEqual([]);

    const semanticSourceMutant = mutate(semanticFunctions, createIdentity, {
      source:
        semanticFunctions.find(
          (routine) => exactModeledFunctionIdentity(routine) === createIdentity,
        )!.source + "\n-- semantic body mutant",
    });
    expect(
      exactModeledFunctionBridgeMismatches(
        semanticSourceMutant,
        catalogFunctions,
      ),
    ).toEqual([`${createIdentity}:source`]);

    const catalogSourceMutant = mutate(catalogFunctions, getSummaryIdentity, {
      source:
        catalogFunctions.find(
          (routine) =>
            exactModeledFunctionIdentity(routine) === getSummaryIdentity,
        )!.source + "\n-- catalog body mutant",
    });
    expect(
      exactModeledFunctionBridgeMismatches(
        semanticFunctions,
        catalogSourceMutant,
      ),
    ).toEqual([`${getSummaryIdentity}:source`]);

    for (const [side, semanticMutant, catalogMutant, expected] of [
      [
        "semantic removal",
        semanticFunctions.filter(
          (routine) => exactModeledFunctionIdentity(routine) !== listIdentity,
        ),
        catalogFunctions,
        [`semantic:${listIdentity}:count=0`],
      ],
      [
        "catalog removal",
        semanticFunctions,
        catalogFunctions.filter(
          (routine) => exactModeledFunctionIdentity(routine) !== listIdentity,
        ),
        [`catalog:${listIdentity}:count=0`],
      ],
      [
        "semantic duplicate",
        [...semanticFunctions, listFunction!],
        catalogFunctions,
        [`semantic:${listIdentity}:count=2`],
      ],
      [
        "catalog duplicate",
        semanticFunctions,
        [...catalogFunctions, listFunction!],
        [`catalog:${listIdentity}:count=2`],
      ],
    ] as const) {
      expect(
        exactModeledFunctionBridgeMismatches(semanticMutant, catalogMutant),
        side,
      ).toEqual(expected);
    }

    for (const [label, semanticMutant, catalogMutant, missing, unexpected] of [
      [
        "semantic schema identity",
        mutate(semanticFunctions, listIdentity, { schema: "dasher_private" }),
        catalogFunctions,
        `semantic:${listIdentity}:count=0`,
        "semantic:dasher_private.list_dashboards(integer):unexpected",
      ],
      [
        "catalog name identity",
        semanticFunctions,
        mutate(catalogFunctions, listIdentity, {
          name: "list_dashboards_mutant",
        }),
        `catalog:${listIdentity}:count=0`,
        "catalog:dasher_api.list_dashboards_mutant(integer):unexpected",
      ],
      [
        "semantic argument identity",
        mutate(semanticFunctions, listIdentity, {
          identityArguments: "bigint",
        }),
        catalogFunctions,
        `semantic:${listIdentity}:count=0`,
        "semantic:dasher_api.list_dashboards(bigint):unexpected",
      ],
    ] as const) {
      expect(
        exactModeledFunctionBridgeMismatches(semanticMutant, catalogMutant),
        label,
      ).toEqual([missing, unexpected]);
    }

    for (const [dimension, changes] of [
      ["returns", { returns: "record" }],
      ["language", { language: "sql" }],
      ["volatility", { volatility: "STABLE" }],
      ["securityDefiner", { securityDefiner: false }],
      ["owner", { owner: "migration_owner" }],
      ["proconfig", { proconfig: ["search_path=public"] }],
      ["execute", { execute: ["dasher_admin"] }],
      ["defaults", { defaults: ["100"] }],
      ["variadic", { variadic: true }],
    ] as const satisfies readonly (readonly [
      keyof ExactModeledFunction,
      Partial<ExactModeledFunction>,
    ])[]) {
      const mutant = mutate(catalogFunctions, listIdentity, changes);
      expect(
        exactModeledFunctionBridgeMismatches(semanticFunctions, mutant),
        dimension,
      ).toEqual([`${listIdentity}:${dimension}`]);
    }
  });

  it("bridges all 75 policies and semantically rejects every reintroduced finalizer parenthesis", () => {
    const production = getModeled0003StaticCatalogContractForTests() as {
      readonly policies: readonly ExactModeledPolicy[];
      readonly policyDependencyRows: readonly ExactModeledPolicyDependencyRow[];
    };
    const fixturePolicyDependencyRows =
      modeled0003CatalogMatrix.policyDependencyRows as readonly ExactModeledPolicyDependencyRow[];
    const sources = [
      {
        label: "fixture-semantic",
        policies: modeled0003Policies,
      },
      {
        label: "fixture-catalog",
        policies: modeled0003CatalogMatrix.policies,
      },
      {
        label: "production-catalog",
        policies: production.policies,
      },
    ] as const;

    expect(modeled0003Policies).toHaveLength(75);
    expect(modeled0003CatalogMatrix.policies).toHaveLength(75);
    expect(production.policies).toHaveLength(75);
    expect(exactModeledPolicyBridgeMismatches(sources)).toEqual([]);
    expect(fixturePolicyDependencyRows).toHaveLength(75);
    expect(production.policyDependencyRows).toHaveLength(75);
    expect(
      new Set(fixturePolicyDependencyRows.map(({ identity }) => identity)).size,
    ).toBe(75);
    expect(
      new Set(production.policyDependencyRows.map(({ identity }) => identity))
        .size,
    ).toBe(75);
    expect(
      isDeepStrictEqual(
        production.policyDependencyRows,
        fixturePolicyDependencyRows,
      ),
    ).toBe(true);
    expect(
      exactModeledPolicyDependencyMismatches(
        modeled0003Policies,
        fixturePolicyDependencyRows,
      ),
    ).toEqual([]);
    expect(
      exactModeledPolicyDependencyMismatches(
        modeled0003CatalogMatrix.policies,
        fixturePolicyDependencyRows,
      ),
    ).toEqual([]);
    expect(
      exactModeledPolicyDependencyMismatches(
        production.policies,
        production.policyDependencyRows,
      ),
    ).toEqual([]);

    expect(exactFinalizerPolicyClauses).toHaveLength(12);
    expect(
      new Set(exactFinalizerPolicyClauses.map(({ name }) => name)).size,
    ).toBe(9);
    for (const source of sources) {
      expect(
        exactFinalizerPolicyContractMismatches(source.policies),
        source.label,
      ).toEqual([]);
    }

    for (const contract of exactFinalizerPolicyClauses) {
      const original = modeled0003Policies.find(
        (policy) =>
          policy.name === contract.name &&
          policy.relation === contract.relation,
      );
      expect(original, `${contract.name}.${contract.clause}`).toBeDefined();
      const expression = original?.[contract.clause];
      expect(expression, `${contract.name}.${contract.clause}`).toBe(
        contract.expression,
      );
      const mutant = modeled0003Policies.map((policy) =>
        policy === original
          ? {
              ...policy,
              [contract.clause]: `${expression})`,
            }
          : policy,
      );
      expect(mutant).not.toEqual(modeled0003Policies);
      const identity = `dasher.${contract.relation}.${contract.name}`;
      expect(
        exactFinalizerPolicyContractMismatches(mutant),
        `${identity}.${contract.clause}`,
      ).toContain(`${identity}:${contract.clause}`);
      expect(
        exactModeledPolicyBridgeMismatches([
          sources[1],
          sources[2],
          { label: "semantic-mutant", policies: mutant },
        ]),
        `${identity}.${contract.clause}`,
      ).not.toEqual([]);
      const dependencyMutant = fixturePolicyDependencyRows.map((row) =>
        row.identity === identity
          ? {
              ...row,
              [contract.clause]: `${row[contract.clause]})`,
            }
          : row,
      );
      expect(dependencyMutant).not.toEqual(fixturePolicyDependencyRows);
      expect(
        exactModeledPolicyDependencyMismatches(
          modeled0003Policies,
          dependencyMutant,
        ),
        `${identity}.${contract.clause}.dependency`,
      ).toContain(`${identity}:${contract.clause}`);
      expect(
        isDeepStrictEqual(production.policyDependencyRows, dependencyMutant),
      ).toBe(false);
    }
  });

  it("freezes every modeled catalog category and the closed function owners", () => {
    expect(Object.keys(modeled0003CatalogMatrix.relations)).toHaveLength(24);
    expect(modeled0003CatalogMatrix.columns).toHaveLength(245);
    expect(modeled0003CatalogMatrix.types).toHaveLength(29);
    expect(modeled0003CatalogMatrix.indexes).toHaveLength(65);
    expect(modeled0003CatalogMatrix.constraints).toHaveLength(100);
    expect(modeled0003CatalogMatrix.triggers).toHaveLength(23);
    expect(modeled0003CatalogMatrix.policies).toHaveLength(75);
    expect(modeled0003CatalogMatrix.functions).toHaveLength(26);
    expect(Object.keys(modeled0003CatalogMatrix.relations)).toEqual([
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_promotion_requests",
      "dashboard_promotion_decisions",
      "dashboard_cleanup_coordination",
      "dashboard_cleanup_attempts",
      "dashboard_legal_holds",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "retention_service_principal_allowlist",
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ]);
    expect(modeled0003CatalogMatrix.schemas).toEqual([
      expect.objectContaining({ name: "dasher_retention_api" }),
    ]);
    expect(
      modeled0003CatalogMatrix.indexes.every(
        (index) =>
          index.method === "btree" &&
          index.valid &&
          index.ready &&
          index.live &&
          !index.clustered &&
          !index.nullsNotDistinct &&
          index.keyExpressions.length === index.opclasses.length &&
          index.keyExpressions.length === index.options.length &&
          index.keyExpressions.length + index.includedColumns.length ===
            index.collations.length,
      ),
    ).toBe(true);
    expect(
      modeled0003CatalogMatrix.constraints.map(
        (constraint) => `${constraint.relation}.${constraint.name}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        "audit_events.audit_events_action_check",
        "dashboards.dashboards_kind_check",
        "dashboards.dashboards_lifecycle_state_check",
        "dashboards.dashboards_lifecycle_fences_check",
        "dashboards.dashboards_expiry_kind_check",
        "source_snapshots.source_snapshots_source_kind_check",
        "evidence_records.evidence_records_evidence_kind_check",
        "dashboard_artifacts.dashboard_artifacts_ownership_class_check",
        "snapshot_reference_claims.snapshot_reference_claims_claim_kind_check",
        "evidence_reference_claims.evidence_reference_claims_claim_kind_check",
        "artifact_reference_claims.artifact_reference_claims_claim_kind_check",
        "snapshot_deletion_finalizers.snapshot_deletion_finalizers_state_check",
        "evidence_deletion_finalizers.evidence_deletion_finalizers_state_check",
        "artifact_deletion_finalizers.artifact_deletion_finalizers_state_check",
        "dashboard_lifecycle_events.dashboard_lifecycle_events_kind_check",
        "dashboard_promotion_decisions.dashboard_promotion_decisions_requester_approver_check",
      ]),
    );
    expect(modeled0003CatalogMatrix.types.map((type) => type.name)).toEqual(
      expect.arrayContaining([
        "dashboard_summary",
        "dashboard_version_projection",
        "dashboard_evidence_projection",
        "dashboard_lineage_projection",
        "dashboard_admin_projection",
        ...Object.keys(modeled0003CatalogMatrix.relations),
      ]),
    );
    expect(modeled0003CatalogMatrix.sequences).toEqual([]);
    expect(modeled0003CatalogMatrix.columns.length).toBeGreaterThan(200);
    expect(
      modeled0003CatalogMatrix.columns.every(
        (column) =>
          column.type.length > 0 &&
          column.collation.length > 0 &&
          column.defaultExpression === null &&
          column.generated === "" &&
          column.identity === "",
      ),
    ).toBe(true);
    const allColumnIdentities = modeled0003ColumnCatalog.map(
      (column) => `${column.relationName}.${column.columnName}`,
    );
    expect(
      [...modeled0003NullableColumnIdentities].filter((identity) =>
        modeled0003NonNullableColumnIdentities.has(identity),
      ),
    ).toEqual([]);
    expect(
      [
        ...modeled0003NullableColumnIdentities,
        ...modeled0003NonNullableColumnIdentities,
      ].sort(),
    ).toEqual([...allColumnIdentities].sort());
    expect(
      modeled0003CatalogMatrix.columns.find(
        (column) =>
          column.relationName === "source_snapshots" &&
          column.columnName === "canonical_bytes",
      ),
    ).toMatchObject({ nullable: false, type: "bytea" });
    expect(
      modeled0003ColumnCatalog.find(
        (column) =>
          column.relationName === "dashboard_legal_holds" &&
          column.columnName === "hold_id",
      ),
    ).toMatchObject({ nullable: false, type: "uuid" });
    expect(
      modeled0003ColumnCatalog
        .filter((column) => column.columnName === "hold_id" && column.nullable)
        .map((column) => `${column.relationName}.${column.columnName}`),
    ).toEqual([
      "snapshot_reference_claims.hold_id",
      "evidence_reference_claims.hold_id",
      "artifact_reference_claims.hold_id",
    ]);
    for (const [relationName, relation] of Object.entries(
      modeled0003CatalogMatrix.relations,
    )) {
      for (const primaryKeyColumn of relation.primaryKey) {
        expect(
          modeled0003ColumnCatalog.filter(
            (column) =>
              column.relationName === relationName &&
              column.columnName === primaryKeyColumn &&
              !column.nullable,
          ),
        ).toHaveLength(1);
      }
    }
    expect(
      modeled0003CheckConstraints.every(
        (constraint) =>
          constraint.definition.startsWith("CHECK (") &&
          !/closed|exact|context|allowlist/iu.test(constraint.definition),
      ),
    ).toBe(true);
    expect(modeled0003CatalogMatrix.triggers).toHaveLength(23);
    for (const trigger of modeled0003CatalogMatrix.triggers) {
      expect(trigger).toMatchObject({
        level: "ROW",
        timing: "BEFORE",
      });
      expect(trigger.definition).toBe(
        `CREATE TRIGGER ${trigger.name} BEFORE ${trigger.events.join(" OR ")} ON dasher.${trigger.relationName} FOR EACH ROW EXECUTE FUNCTION ${trigger.functionIdentity}`,
      );
    }
    expect(modeled0003Functions).toHaveLength(26);
    expect(
      modeled0003Functions.filter(
        (routine) => routine.owner === "dasher_retention_definer",
      ),
    ).toHaveLength(7);
    for (const routine of modeled0003Functions) {
      expect(routine.language).toBe("plpgsql");
      expect(routine.volatility).toBe("VOLATILE");
      expect(routine.securityDefiner).toBe(routine.schema !== "dasher_private");
      expect(routine.proconfig).toEqual(["search_path=pg_catalog"]);
      expect(routine.defaults).toEqual([]);
      expect(routine.variadic).toBe(false);
      expect(routine.identityArguments).not.toMatch(
        /jsonb|regclass|regprocedure|record/iu,
      );
      expect(routine.source).toMatch(/\bBEGIN\b[\s\S]*\bEND\b/u);
      expect(routine.source).not.toMatch(
        /<modeled-body>|task-8a-body|\bEXECUTE\b|pg_backend_pid|pg_stat_activity/iu,
      );
      if (routine.schema === "dasher_private") {
        expect(routine.execute).toEqual([]);
        expect(routine.returns).toBe("trigger");
      }
    }
    expect(
      modeled0003Functions.find(
        (routine) => routine.name === "initialize_operator_context",
      ),
    ).toMatchObject({
      execute: [],
      identityArguments: "uuid, text, uuid, text, uuid",
      owner: "dasher_retention_definer",
      returns: "void",
      schema: "dasher_retention_api",
    });
    expect(
      modeled0003Functions
        .filter((routine) =>
          routine.execute.some(
            (grantee) => String(grantee) === "dasher_retention_operator",
          ),
        )
        .map((routine) => routine.name),
    ).toEqual(retentionWrapperContracts.map((contract) => contract.name));
    expect(
      modeled0003CheckConstraints.find(
        (constraint) =>
          constraint.name ===
          "dashboard_promotion_decisions_requester_approver_check",
      ),
    ).toEqual(
      expect.objectContaining({
        columns: ["requested_by_user_id", "decided_by_user_id"],
        definition: "CHECK ((requested_by_user_id <> decided_by_user_id))",
      }),
    );

    const transitionTrigger = modeled0003Functions.find(
      (routine) => routine.name === "enforce_dashboard_transition",
    )?.source;
    expect(transitionTrigger).toContain(
      "current_user = 'dasher_security_definer'::name",
    );
    expect(transitionTrigger).toContain(
      "current_user = 'dasher_retention_definer'::name",
    );
    expect(transitionTrigger).toContain(
      "v_revision_increment boolean := NEW.lifecycle_revision = OLD.lifecycle_revision + 1",
    );
    for (const exactBranch of [
      "OLD.lifecycle_state IN ('draft', 'active')",
      "NEW.lifecycle_state = 'active'",
      "NEW.head_version_id IS DISTINCT FROM OLD.head_version_id",
      "NEW.capability_epoch = OLD.capability_epoch\n          AND NEW.cache_epoch = OLD.cache_epoch",
      "v_capability IN ('place_hold', 'release_hold')",
      "v_capability = 'claim_cleanup'",
      "v_capability = 'purge'\n          AND v_purge_start",
      "authority.scope_organization_id IS NULL",
      "OLD.lifecycle_state = 'purge_eligible'\n          AND NEW.lifecycle_state = 'cleaned'",
    ]) {
      expect(transitionTrigger).toContain(exactBranch);
    }

    const retentionTrigger = modeled0003Functions.find(
      (routine) => routine.name === "enforce_retention_mutation",
    )?.source;
    expect(retentionTrigger).toContain(
      "current_user <> 'dasher_retention_definer'::name",
    );
    for (const identity of [
      "OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id",
      "target.lifecycle_revision = current_setting(",
      "'dasher.retention_expected_lifecycle_revision', true",
      "dasher.snapshot_deletion_finalizers",
      "dasher.evidence_deletion_finalizers",
      "dasher.artifact_deletion_finalizers",
      "finalizer.state = 'deleted'",
      "finalizer.proof_sha256 IS NOT NULL",
      "finalizer.bytes_deleted_at IS NOT NULL",
    ]) {
      expect(retentionTrigger).toContain(identity);
    }
    for (const exactPurgeTransition of [
      "OLD.purged_at IS NULL",
      "OLD.purged_lifecycle_revision IS NULL",
      "OLD.purged_proof_sha256 IS NULL",
      "NEW.purged_at IS NOT NULL",
      "NEW.purged_lifecycle_revision IS NOT NULL",
      "NEW.purged_proof_sha256 IS NOT NULL",
      "OLD.retention_policy_revision, OLD.access_revoked_at",
      "OLD.access_revoked_lifecycle_revision",
      "OLD.access_revoked_proof_sha256",
      "OLD.claim_kind = 'access_bearing'",
      "OLD.claim_kind = 'retention_only'",
      "OLD.hold_id IS NULL",
      "authority.scope_organization_id IS NULL",
    ]) {
      expect(retentionTrigger).toContain(exactPurgeTransition);
    }
    const recordedPurgeRewriteMutant = retentionTrigger?.replace(
      "      AND OLD.purged_at IS NULL\n      AND OLD.purged_lifecycle_revision IS NULL\n      AND OLD.purged_proof_sha256 IS NULL\n",
      "",
    );
    const immutableTombstoneMutant = retentionTrigger?.replace(
      "        OLD.retention_policy_revision, OLD.access_revoked_at,\n",
      "",
    );
    expect(recordedPurgeRewriteMutant).not.toBe(retentionTrigger);
    expect(recordedPurgeRewriteMutant).not.toContain(
      "OLD.purged_proof_sha256 IS NULL",
    );
    expect(immutableTombstoneMutant).not.toBe(retentionTrigger);
    expect(immutableTombstoneMutant).not.toContain(
      "OLD.retention_policy_revision, OLD.access_revoked_at",
    );
    expect(retentionTrigger).not.toMatch(/to_jsonb|\bEXECUTE\b/iu);
  });

  it("freezes exactly two bootstrap SELECT policies and no allowlist mutation authority", () => {
    const bootstrapPolicies = modeled0003Policies.filter(
      (policy) => policy.bootstrap,
    );
    expect(bootstrapPolicies).toHaveLength(2);
    expect(
      bootstrapPolicies.map((policy) => [policy.relation, policy.command]),
    ).toEqual([
      ["retention_service_principal_allowlist", "SELECT"],
      ["dashboards", "SELECT"],
    ]);
    expect(bootstrapPolicies[1]).toMatchObject({
      shutsOffWhenPhase: "authorized",
    });
    expect(modeled0003SafetyMatrix.allowlistRuntimePrivileges).toEqual([
      "SELECT",
    ]);
    expect(
      modeled0003CatalogMatrix.catalogRelationAcls.filter(
        (acl) => String(acl.grantee) === "dasher_retention_operator",
      ),
    ).toEqual([]);
    expect(
      modeled0003CatalogMatrix.relationAcls.filter(
        (acl) => acl.relationName === "retention_service_principal_allowlist",
      ),
    ).toEqual([
      expect.objectContaining({
        privilege: "SELECT",
        role: "dasher_retention_definer",
      }),
    ]);
    expect(
      modeled0003CatalogMatrix.effectiveColumnPrivileges.some(
        (acl) =>
          acl.relationName === "retention_service_principal_allowlist" &&
          ["UPDATE", "DELETE"].includes(String(acl.privilege)),
      ),
    ).toBe(false);
  });

  it("enforces the literal mutation minimum-role matrix before tenant work", () => {
    const source = (name: string): string =>
      modeled0003Functions.find((routine) => routine.name === name)?.source ??
      "";
    expect(mutationMinimumRoleContract).toEqual([
      { name: "create_dashboard", role: "editor" },
      { name: "create_evidence_record", role: "editor" },
      { name: "create_dashboard_version", role: "editor" },
      { name: "compare_and_swap_dashboard_head", role: "editor" },
      { name: "request_dashboard_promotion", role: "editor" },
      { name: "decide_dashboard_promotion", role: "admin" },
      { name: "set_dashboard_archive", role: "admin" },
      { name: "delete_dashboard", role: "admin" },
      { name: "restore_dashboard_as_new", role: "admin" },
    ]);
    for (const contract of mutationMinimumRoleContract) {
      const body = source(contract.name);
      expect(
        hasExactPreTenantMutationRoleGate(body, contract.role),
        contract.name,
      ).toBe(true);
      for (const [label, mutant] of [
        [
          "missing",
          body.replace(
            `dasher_private.context_allows(v_organization_id, '${contract.role}')`,
            "true",
          ),
        ],
        [
          "wrong organization",
          body.replace(
            "dasher_private.context_allows(v_organization_id,",
            "dasher_private.context_allows(dasher_private.context_organization_id(),",
          ),
        ],
        [
          "duplicate",
          body.replace(
            `IF NOT dasher_private.context_allows(v_organization_id, '${contract.role}')`,
            `IF NOT dasher_private.context_allows(v_organization_id, '${contract.role}')\n    OR NOT dasher_private.context_allows(v_organization_id, '${contract.role}')`,
          ),
        ],
        [
          "weakened",
          body.replace(
            `'${contract.role}'`,
            contract.role === "admin" ? "'editor'" : "'viewer'",
          ),
        ],
      ] as const) {
        expect(mutant, `${contract.name}: ${label}`).not.toBe(body);
        expect(
          hasExactPreTenantMutationRoleGate(mutant, contract.role),
          `${contract.name}: ${label}`,
        ).toBe(false);
      }
    }

    const create = source("create_dashboard");
    const gate =
      "  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN\n" +
      "    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';\n" +
      "  END IF;\n";
    const withoutGate = create.replace(gate, "");
    const firstTenantWork = withoutGate.indexOf(
      "INSERT INTO dasher.dashboard_lifecycle_policies",
    );
    const lateGate =
      withoutGate.slice(0, firstTenantWork) +
      "INSERT INTO dasher.dashboard_lifecycle_policies\n" +
      gate +
      withoutGate.slice(
        firstTenantWork +
          "INSERT INTO dasher.dashboard_lifecycle_policies".length +
          1,
      );
    expect(lateGate).not.toBe(create);
    expect(hasExactPreTenantMutationRoleGate(lateGate, "editor")).toBe(false);
  });

  it("makes read projection materialization atomically authoritative", () => {
    const source = (name: string): string =>
      modeled0003Functions.find((routine) => routine.name === name)?.source ??
      "";
    const evidence = source("get_dashboard_evidence");
    const lineage = source("get_dashboard_lineage");
    expect(hasAtomicEvidenceProjection(evidence)).toBe(true);
    expect(hasAtomicLineageProjection(lineage)).toBe(true);

    const cases = [
      {
        name: "evidence",
        body: evidence,
        validate: hasAtomicEvidenceProjection,
        missingRelation:
          "FROM dasher.dashboard_version_evidence AS missing_evidence",
      },
      {
        name: "lineage",
        body: lineage,
        validate: hasAtomicLineageProjection,
        missingRelation: "FROM dasher.dashboard_artifacts AS missing_artifact",
      },
    ] as const;
    for (const contract of cases) {
      const mutants = [
        [
          "revoked access",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "dashboard.access_revoked_at IS NULL",
            "dashboard.access_revoked_at IS NOT NULL",
          ),
        ],
        [
          "expiry boundary",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "v_now < dashboard.effective_expires_at",
            "v_now <= dashboard.effective_expires_at",
          ),
        ],
        [
          "dashboard identity",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "dashboard.dashboard_id = $1",
            "dashboard.dashboard_id IS NOT NULL",
          ),
        ],
        [
          "claim completeness",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            contract.missingRelation,
            contract.missingRelation.replace("missing_", "unchecked_"),
          ),
        ],
        [
          "version claim organization identity",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "        WHERE version_claim.organization_id = version.organization_id\n",
            "",
          ),
        ],
        [
          "version claim dashboard identity",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "          AND version_claim.dashboard_id = version.dashboard_id\n",
            "",
          ),
        ],
        [
          "version claim version identity",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "          AND version_claim.version_id = version.version_id\n",
            "",
          ),
        ],
        [
          "version access-bearing claim kind",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "          AND version_claim.claim_kind = 'access_bearing'\n",
            "",
          ),
        ],
        [
          "version access-bearing claim hold exclusion",
          replaceAfter(
            contract.body,
            "  RETURN QUERY\n",
            "          AND version_claim.hold_id IS NULL\n",
            "",
          ),
        ],
      ] as const;
      for (const [mutantName, mutant] of mutants) {
        const name = `${contract.name}: ${mutantName}`;
        expect(mutant, name).not.toBe(contract.body);
        expect(contract.validate(mutant), name).toBe(false);
      }
    }
  });

  it("pins routine-specific lifecycle events, audit actions, ordering, and epoch effects", () => {
    const source = (name: string): string =>
      modeled0003Functions.find((routine) => routine.name === name)?.source ??
      "";

    const create = source("create_dashboard");
    expect(hasExactCreateSemantics(create)).toBe(true);
    for (const mutant of [
      create.replace("'draft', 0, 0, 0", "'active', 0, 0, 0"),
      create.replace(
        "$4 NOT IN (3600, 86400, 604800, 2592000)",
        "$4 NOT BETWEEN 3600 AND 2592000",
      ),
      create.replace(
        "SELECT v_organization_id, 1, 86400, 1",
        "SELECT v_organization_id, 1, 7200, 1",
      ),
      create.replace("  FOR UPDATE;", ";"),
      create.replace(
        "v_ttl_seconds := CASE WHEN $5 THEN v_default_ttl_seconds ELSE $4 END",
        "v_ttl_seconds := $4",
      ),
      create.replace("WHERE NOT EXISTS", "WHERE EXISTS"),
      create.replace(
        "policy_revision > v_policy_row_revision",
        "policy_revision >= v_policy_row_revision",
      ),
    ]) {
      expect(mutant).not.toBe(create);
      expect(hasExactCreateSemantics(mutant)).toBe(false);
    }

    const cases = [
      [
        "compare_and_swap_dashboard_head",
        "UPDATE dasher.dashboards",
        "'head_activated'",
        "'dashboard_head.promoted'",
        [],
      ],
      [
        "decide_dashboard_promotion",
        "UPDATE dasher.dashboards",
        "'promotion_approved'",
        "'dashboard.promotion_approved'",
        ["INSERT INTO dasher.dashboard_promotion_decisions"],
      ],
      [
        "set_dashboard_archive",
        "UPDATE dasher.dashboards",
        "THEN 'archived' ELSE 'unarchived' END",
        "'dashboard.archived'",
        [],
      ],
      [
        "delete_dashboard",
        "UPDATE dasher.dashboards",
        "'deleted'",
        "'dashboard.deleted'",
        [
          "INSERT INTO dasher.dashboard_tombstones",
          "INSERT INTO dasher.dashboard_cleanup_coordination",
          "INSERT INTO dasher.backup_deletion_ledger",
        ],
      ],
      [
        "materialize_dashboard_expiry",
        "UPDATE dasher.dashboards",
        "'expired'",
        "'dashboard.expired'",
        [
          "INSERT INTO dasher.dashboard_tombstones",
          "INSERT INTO dasher.dashboard_cleanup_coordination",
          "INSERT INTO dasher.backup_deletion_ledger",
        ],
      ],
      [
        "place_dashboard_legal_hold",
        "UPDATE dasher.dashboards",
        "'legal_hold_placed'",
        "'dashboard.legal_hold_placed'",
        [
          "INSERT INTO dasher.dashboard_legal_holds",
          "INSERT INTO dasher.snapshot_reference_claims",
          "INSERT INTO dasher.evidence_reference_claims",
          "INSERT INTO dasher.artifact_reference_claims",
        ],
      ],
      [
        "release_dashboard_legal_hold",
        "UPDATE dasher.dashboards",
        "'legal_hold_released'",
        "'dashboard.legal_hold_released'",
        [
          "UPDATE dasher.dashboard_legal_holds",
          "DELETE FROM dasher.snapshot_reference_claims",
          "DELETE FROM dasher.evidence_reference_claims",
          "DELETE FROM dasher.artifact_reference_claims",
        ],
      ],
      [
        "claim_dashboard_cleanup",
        "UPDATE dasher.dashboards",
        "v_event_kind := 'cleanup_started'",
        "v_audit_action := 'dashboard.cleanup_started'",
        ["INSERT INTO dasher.dashboard_cleanup_coordination"],
      ],
      [
        "purge_dashboard",
        "UPDATE dasher.dashboards SET lifecycle_state = 'cleaned'",
        "'purged'",
        "'dashboard.purged'",
        [
          "UPDATE dasher.dashboard_tombstones SET purged_at",
          "INSERT INTO dasher.backup_deletion_ledger",
          ") VALUES (v_organization_id, $1, $4, 'purged'",
          "SET current_step = 'cleaned'",
        ],
      ],
    ] as const;
    for (const [name, mutation, event, audit, dependentWrites] of cases) {
      const body = source(name);
      expect(body, name).toContain("v_now := clock_timestamp()");
      expect(body, name).not.toContain("statement_timestamp()");
      expect(
        hasLifecycleWriteSemantics(
          body,
          mutation,
          event,
          audit,
          dependentWrites,
        ),
        name,
      ).toBe(true);
      const missingEventMutant = replaceAfter(
        body,
        body
          .slice(
            body.indexOf("INSERT INTO dasher.dashboard_lifecycle_events"),
            body.indexOf("INSERT INTO dasher.audit_events"),
          )
          .includes("v_event_kind")
          ? "v_event_kind"
          : "INSERT INTO dasher.dashboard_lifecycle_events",
        event,
        "'mutated_event'",
      );
      const wrongAuditMutant = replaceAfter(
        body,
        body
          .slice(body.indexOf("INSERT INTO dasher.audit_events"))
          .includes("v_audit_action")
          ? "v_audit_action"
          : "INSERT INTO dasher.audit_events",
        audit,
        "'dashboard.wrong_action'",
      );
      const earlyAuditMutant = body
        .replace(mutation, "__TASK8A_MUTATION__")
        .replace("INSERT INTO dasher.audit_events", mutation)
        .replace("__TASK8A_MUTATION__", "INSERT INTO dasher.audit_events");
      expect(missingEventMutant, name).not.toBe(body);
      expect(
        hasLifecycleWriteSemantics(
          missingEventMutant,
          mutation,
          event,
          audit,
          dependentWrites,
        ),
        `${name} missing event`,
      ).toBe(false);
      expect(wrongAuditMutant, name).not.toBe(body);
      expect(
        hasLifecycleWriteSemantics(
          wrongAuditMutant,
          mutation,
          event,
          audit,
          dependentWrites,
        ),
        `${name} wrong audit`,
      ).toBe(false);
      expect(earlyAuditMutant, name).not.toBe(body);
      expect(
        hasLifecycleWriteSemantics(
          earlyAuditMutant,
          mutation,
          event,
          audit,
          dependentWrites,
        ),
        `${name} early audit`,
      ).toBe(false);
      for (const dependentWrite of dependentWrites) {
        const eventStart = body.indexOf(
          "INSERT INTO dasher.dashboard_lifecycle_events",
        );
        const eventEnd = body.indexOf(");", eventStart) + 2;
        const dependentPosition = body.lastIndexOf(dependentWrite, eventStart);
        const eventBlock = body.slice(eventStart, eventEnd);
        const withoutEvent = body.slice(0, eventStart) + body.slice(eventEnd);
        const adjustedDependentPosition = withoutEvent.lastIndexOf(
          dependentWrite,
          dependentPosition,
        );
        const earlyEventMutant =
          withoutEvent.slice(0, adjustedDependentPosition) +
          eventBlock +
          withoutEvent.slice(adjustedDependentPosition);
        expect(dependentPosition, `${name} ${dependentWrite}`).toBeGreaterThan(
          0,
        );
        expect(
          hasLifecycleWriteSemantics(
            earlyEventMutant,
            mutation,
            event,
            audit,
            dependentWrites,
          ),
          `${name} early event before ${dependentWrite}`,
        ).toBe(false);
      }
    }

    const cas = source("compare_and_swap_dashboard_head");
    expect(hasExactCasSemantics(cas)).toBe(true);
    for (const mutant of [
      cas.replace(
        "THEN 'head_activated' ELSE 'head_advanced' END",
        "THEN 'head_advanced' ELSE 'head_advanced' END",
      ),
      cas.replace(
        "v_now >= v_dashboard.effective_expires_at",
        "v_now > v_dashboard.effective_expires_at",
      ),
      cas.replace(
        "lifecycle_revision = lifecycle_revision + 1",
        "lifecycle_revision = lifecycle_revision + 1, cache_epoch = cache_epoch + 1",
      ),
      replaceAfter(
        cas,
        "SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard",
        "dashboard.head_version_id IS NOT DISTINCT FROM $2",
        "true",
      ),
      replaceAfter(
        cas,
        "UPDATE dasher.dashboards",
        "head_version_id IS NOT DISTINCT FROM $2",
        "true",
      ),
      cas.replace(
        "set_config('dasher.lifecycle_expected_revision', $4::text, true)",
        "set_config('dasher.lifecycle_expected_revision', '0', true)",
      ),
      cas.replace("'head_advanced'", "'head_activated'"),
      cas.replace(
        "IF NOT FOUND THEN\n    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';\n  END IF;\n  INSERT INTO dasher.dashboard_lifecycle_events",
        "INSERT INTO dasher.dashboard_lifecycle_events",
      ),
    ]) {
      expect(mutant).not.toBe(cas);
      expect(hasExactCasSemantics(mutant)).toBe(false);
    }
    const holds = [
      source("place_dashboard_legal_hold"),
      source("release_dashboard_legal_hold"),
    ];
    for (const hold of holds) {
      expect(hold).not.toMatch(/capability_epoch\s*=|cache_epoch\s*=/u);
    }
    expect(source("restore_dashboard_as_new")).not.toContain(
      "dashboard_lifecycle_events",
    );
    for (const auditOnlyName of [
      "create_dashboard",
      "restore_dashboard_as_new",
    ]) {
      const auditOnlyBody = source(auditOnlyName);
      const auditWrite = auditOnlyBody.indexOf(
        "INSERT INTO dasher.audit_events",
      );
      const auditEnd = auditOnlyBody.indexOf(");", auditWrite);
      expect(
        auditOnlyBody.match(/INSERT INTO dasher[.]audit_events/gu),
      ).toHaveLength(1);
      expect(auditOnlyBody).not.toContain(
        "INSERT INTO dasher.dashboard_lifecycle_events",
      );
      expect(
        auditOnlyBody
          .slice(auditEnd + 2)
          .match(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+dasher[.]/gu),
        auditOnlyName,
      ).toBeNull();
    }
    expect(source("restore_dashboard_as_new")).toContain(
      "tombstone.purged_at IS NULL\n  FOR SHARE;\n  IF NOT FOUND THEN",
    );
    for (const name of [
      "decide_dashboard_promotion",
      "set_dashboard_archive",
      "delete_dashboard",
      "materialize_dashboard_expiry",
      "claim_dashboard_cleanup",
    ]) {
      expect(source(name), name).not.toContain(
        "decode(repeat('00', 32), 'hex')",
      );
    }
    expect(source("decide_dashboard_promotion")).toContain(
      "v_rationale_sha256",
    );
    expect(source("set_dashboard_archive")).toContain(
      "sha256(timestamptz_send(",
    );
    for (const name of ["delete_dashboard", "materialize_dashboard_expiry"]) {
      expect(source(name), name).toContain("v_proof_sha256 := sha256(");
      expect(source(name), name).toContain("timestamptz_send(v_now)");
    }
    expect(source("claim_dashboard_cleanup")).toContain(
      "v_transition_proof_sha256 := COALESCE($3, sha256(",
    );
  });

  it("pins expiry predicates, content bounds, claim authority, and exact retention policies", () => {
    const source = (name: string): string =>
      modeled0003Functions.find((routine) => routine.name === name)?.source ??
      "";
    for (const name of [
      "list_dashboards",
      "get_dashboard_summary",
      "get_dashboard_head",
      "get_dashboard_version",
      "get_dashboard_evidence",
      "get_dashboard_lineage",
    ]) {
      const body = source(name);
      expect(body, name).toContain("access_revoked_at IS NULL");
      expect(body, name).toContain("purged_at IS NULL");
      expect(body, name).toMatch(
        /v_now < (?:dashboard[.])?effective_expires_at/u,
      );
    }

    const version = source("create_dashboard_version");
    const canonicalSpecConstraint =
      modeled0003CheckConstraints.find(
        (constraint) =>
          constraint.name ===
          "dashboard_versions_canonical_spec_bytes_length_check",
      )?.definition ?? "";
    const canonicalSpecHashConstraint =
      modeled0003CheckConstraints.find(
        (constraint) =>
          constraint.name ===
          "dashboard_versions_canonical_spec_sha256_bytes_check",
      )?.definition ?? "";
    expect(hasExactCanonicalSpecBounds(canonicalSpecConstraint, version)).toBe(
      true,
    );
    expect(
      hasExactCanonicalSpecHashBinding(canonicalSpecHashConstraint, version),
    ).toBe(true);
    expect(hasExactVersionContentAuthority(version)).toBe(true);
    const boundsMutants = [
      {
        constraint: canonicalSpecConstraint.replace(">= 2", ">= 1"),
        source: version,
      },
      {
        constraint: canonicalSpecConstraint,
        source: version.replace(
          "BETWEEN 2 AND 1048576",
          "BETWEEN 1 AND 1048576",
        ),
      },
      {
        constraint: canonicalSpecConstraint.replace("<= 1048576", "<= 1048577"),
        source: version,
      },
    ];
    for (const mutant of boundsMutants) {
      expect(
        mutant.constraint !== canonicalSpecConstraint ||
          mutant.source !== version,
      ).toBe(true);
      expect(
        hasExactCanonicalSpecBounds(mutant.constraint, mutant.source),
      ).toBe(false);
    }
    const hashBindingMutants = [
      {
        constraint: canonicalSpecHashConstraint,
        source: version.replace("    OR $5 <> pg_catalog.sha256($4)", ""),
      },
      {
        constraint: canonicalSpecHashConstraint,
        source: version.replace(
          "$5 <> pg_catalog.sha256($4)",
          "$5 = pg_catalog.sha256($4)",
        ),
      },
      {
        constraint: canonicalSpecHashConstraint.replace(
          "canonical_spec_sha256 = sha256(canonical_spec_bytes)",
          "octet_length(canonical_spec_sha256) = 32",
        ),
        source: version,
      },
      {
        constraint: "",
        source: version,
      },
    ];
    for (const [index, mutant] of hashBindingMutants.entries()) {
      expect(
        mutant.constraint !== canonicalSpecHashConstraint ||
          mutant.source !== version,
      ).toBe(true);
      expect(
        hasExactCanonicalSpecHashBinding(mutant.constraint, mutant.source),
        `canonical hash-binding mutant ${index + 1}`,
      ).toBe(false);
    }
    for (const [mutantIndex, weakened] of [
      replaceAfter(
        version,
        "PERFORM 1 FROM dasher.source_snapshots",
        "snapshot.snapshot_id = ANY($11)",
        "true",
      ),
      replaceAfter(
        version,
        "PERFORM 1 FROM dasher.evidence_records",
        "evidence.snapshot_id = ANY($11)",
        "true",
      ),
      replaceAfter(
        version,
        "PERFORM 1 FROM dasher.evidence_records",
        "authority_claim.claim_kind = 'access_bearing'",
        "authority_claim.claim_kind = 'retention_only'",
      ),
      replaceAfter(
        version,
        "IF (SELECT count(*) FROM dasher.evidence_records",
        "<> cardinality($13)",
        "> cardinality($13)",
      ),
      version.replace(
        "(SELECT count(*) <> count(DISTINCT value) FROM unnest($11) AS value)",
        "false",
      ),
    ].entries()) {
      expect(weakened).not.toBe(version);
      expect(
        hasExactVersionContentAuthority(weakened),
        `content-authority mutant ${mutantIndex + 1}`,
      ).toBe(false);
    }

    const evidence = source("create_evidence_record");
    expect(evidence).toContain("v_dashboard dasher.dashboards%ROWTYPE;");
    expect(evidence).toContain("snapshot.snapshot_id = $4");
    expect(evidence).toContain("claim.snapshot_id = $4");
    expect(evidence).toContain("claim.version_id = $2");
    expect(evidence).toContain("source_link.snapshot_id = $4");
    expect(evidence).toContain("INSERT INTO dasher.evidence_reference_claims");

    const evidenceProjection = source("get_dashboard_evidence");
    expect(evidenceProjection).toContain("version.version_id = $2");
    expect(evidenceProjection).toContain(
      "version.validation_state = 'validated'",
    );
    expect(evidenceProjection).toContain(
      "version_claim.claim_kind = 'access_bearing'",
    );
    expect(evidenceProjection).toContain(
      "FROM dasher.dashboard_version_evidence AS missing_evidence",
    );
    const lineageProjection = source("get_dashboard_lineage");
    for (const exactMissingClaimDenial of [
      "FROM dasher.dashboard_version_snapshots AS missing_snapshot",
      "FROM dasher.dashboard_version_evidence AS missing_evidence",
      "FROM dasher.dashboard_artifacts AS missing_artifact",
    ]) {
      expect(lineageProjection).toContain(exactMissingClaimDenial);
    }

    expect(canonicalSpecConstraint).toBe(
      "CHECK (((octet_length(canonical_spec_bytes) >= 2) AND (octet_length(canonical_spec_bytes) <= 1048576)))",
    );
    expect(canonicalSpecHashConstraint).toBe(
      "CHECK ((canonical_spec_sha256 = sha256(canonical_spec_bytes)))",
    );

    const promotionRequest = source("request_dashboard_promotion");
    expect(hasExactPromotionRequestAuthorization(promotionRequest)).toBe(true);
    for (const mutant of [
      promotionRequest.replace(
        "  IF NOT dasher_private.context_allows(v_organization_id, 'editor')\n",
        "  IF ",
      ),
      promotionRequest.replace("'editor'", "'viewer'"),
      promotionRequest.replace(
        "NOT dasher_private.context_allows(v_organization_id, 'editor')",
        "false",
      ),
    ]) {
      expect(mutant).not.toBe(promotionRequest);
      expect(hasExactPromotionRequestAuthorization(mutant)).toBe(false);
    }
    for (const policy of modeled0003Policies) {
      expect(policy.command).not.toBe("ALL");
      if (!policy.bootstrap) {
        const expression = `${policy.using ?? ""} ${policy.withCheck ?? ""}`;
        if (
          policy.roles.length === 1 &&
          policy.roles[0] === "dasher_security_definer"
        ) {
          expect(policy.roles).toEqual(["dasher_security_definer"]);
          expect(policy.using).toBe(
            "((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id()))",
          );
          if (policy.command === "UPDATE") {
            expect(policy.name).toMatch(/_security_lock_update$/u);
            expect(policy.withCheck).toBe(policy.using);
          } else {
            expect(policy.relation).toMatch(
              /^(?:snapshot|evidence|artifact)_deletion_finalizers$/u,
            );
            expect(policy.command).toBe("SELECT");
            expect(policy.withCheck).toBeNull();
          }
        } else {
          expect(expression).toContain("dasher.retention_capability");
          expect(expression).toContain(
            "FROM dasher.retention_service_principal_allowlist AS bound_authority",
          );
          expect(expression).toContain(
            "bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint",
          );
          expect(expression).toContain(
            "bound_authority.binding_subject = SESSION_USER",
          );
        }
      }
    }
    const dashboardUpdatePolicy = modeled0003Policies.find(
      (policy) => policy.name === "dashboards_retention_update",
    );
    expect(dashboardUpdatePolicy).toBeDefined();
    expect(
      hasExactPolicyCapabilities(dashboardUpdatePolicy!, [
        "materialize_expiry",
        "place_hold",
        "release_hold",
        "claim_cleanup",
        "purge",
      ]),
    ).toBe(true);
    for (const mutantExpression of [
      (dashboardUpdatePolicy?.using ?? "").replace(
        "= ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])",
        "<> ''::text",
      ),
      (dashboardUpdatePolicy?.using ?? "").replace(
        "'purge'::text]",
        "'initialize'::text]",
      ),
      (dashboardUpdatePolicy?.using ?? "").replace(
        "bound_authority.binding_subject = SESSION_USER",
        "true",
      ),
    ]) {
      expect(mutantExpression).not.toBe(dashboardUpdatePolicy?.using);
      expect(
        hasExactPolicyCapabilities(
          { ...dashboardUpdatePolicy!, using: mutantExpression },
          [
            "materialize_expiry",
            "place_hold",
            "release_hold",
            "claim_cleanup",
            "purge",
          ],
        ),
      ).toBe(false);
    }
    expect(
      modeled0003Policies.filter(
        (policy) =>
          policy.relation === "dashboard_lifecycle_events" &&
          policy.command === "INSERT",
      ),
    ).toHaveLength(1);
    expect(
      modeled0003Policies.filter(
        (policy) =>
          policy.relation === "audit_events" && policy.command === "INSERT",
      ),
    ).toHaveLength(1);
    const purge = source("purge_dashboard");
    expect(purge).toContain("SET current_step = 'purge_finalizing'");
    expect(purge).toContain("completion_proof_sha256 = $3");
    const purgeStart = purge.indexOf(
      "UPDATE dasher.dashboards\n    SET purge_started_at = v_now",
    );
    const stagedReturn = purge.indexOf("    RETURN;", purgeStart);
    const firstFinalizer = purge.indexOf(
      "INSERT INTO dasher.snapshot_deletion_finalizers",
    );
    expect(purgeStart).toBeGreaterThanOrEqual(0);
    expect(stagedReturn).toBeGreaterThan(purgeStart);
    expect(firstFinalizer).toBeGreaterThan(stagedReturn);
    const retentionTrigger = source("enforce_retention_mutation");
    expect(retentionTrigger).toContain(
      "NEW.proof_sha256 = NEW.expected_claim_set_sha256",
    );
    expect(retentionTrigger).not.toContain(
      "artifact_deletion_finalizers.dashboard_id",
    );
    expect(retentionTrigger).not.toContain("finalizer.dashboard_id");
    expect(
      modeled0003CatalogMatrix.triggers.filter((trigger) =>
        trigger.relationName.endsWith("_deletion_finalizers"),
      ),
    ).toHaveLength(3);

    const recordAttempt = source("record_dashboard_cleanup_attempt");
    expect(recordAttempt).toContain("v_dashboard dasher.dashboards%ROWTYPE;");
    expect(recordAttempt).toContain(
      "coordination.expected_lifecycle_revision = v_dashboard.lifecycle_revision",
    );
    for (const retryDelay of [
      "interval '5 minutes'",
      "interval '30 minutes'",
      "interval '2 hours'",
      "interval '12 hours'",
      "interval '1 day'",
    ]) {
      expect(recordAttempt).toContain(retryDelay);
    }
    expect(recordAttempt).not.toContain("attempt.step = $3");
    expect(source("claim_dashboard_cleanup")).toContain(
      "dashboard_cleanup_coordination.next_attempt_at <= v_now",
    );

    const transition = source("enforce_dashboard_transition");
    expect(transition).toContain(
      "current_setting('dasher.lifecycle_expected_revision', true)::bigint",
    );
    expect(transition).toContain(
      "current_setting('dasher.retention_expected_lifecycle_revision', true)::bigint",
    );
    for (const name of [
      "compare_and_swap_dashboard_head",
      "decide_dashboard_promotion",
      "set_dashboard_archive",
      "delete_dashboard",
    ]) {
      expect(source(name), name).toContain(
        "set_config('dasher.lifecycle_expected_revision'",
      );
    }
    for (const name of [
      "materialize_dashboard_expiry",
      "place_dashboard_legal_hold",
      "release_dashboard_legal_hold",
      "claim_dashboard_cleanup",
      "purge_dashboard",
    ]) {
      expect(source(name), name).toContain(
        "'dasher.retention_expected_lifecycle_revision'",
      );
    }

    expect(source("create_dashboard_version")).toContain(
      "later.policy_revision > policy.policy_revision",
    );
    for (const relation of [
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ]) {
      const completion = modeled0003CheckConstraints.find(
        (constraint) => constraint.name === `${relation}_completion_check`,
      );
      expect(completion?.definition, relation).toContain(
        "(state = 'eligible'::text) AND (proof_sha256 = expected_claim_set_sha256)",
      );
      expect(completion?.definition, relation).toContain(
        "((lease_owner IS NULL) = (lease_expires_at IS NULL))",
      );
    }
  });

  it("declares every modeled PL/pgSQL local referenced by an exact routine body", () => {
    for (const routine of modeled0003Functions) {
      const routineSource = routine.source ?? "";
      const referenced = new Set(
        routineSource.match(/\bv_[a-z0-9_]+\b/gu) ?? [],
      );
      const declared = new Set(
        [...routineSource.matchAll(/^\s*(v_[a-z0-9_]+)\s+/gmu)].map(
          (match) => match[1],
        ),
      );
      expect(
        [...referenced].filter((name) => !declared.has(name)),
        `${routine.schema}.${routine.name}`,
      ).toEqual([]);
    }
  });

  it("pins VOLATILE READ COMMITTED gate-first initializer semantics", () => {
    expect(modeled0003SafetyMatrix).toMatchObject({
      initializerProconfig: ["search_path=pg_catalog"],
      initializerProvolatile: "v",
      initializerSecurityDefiner: true,
      initializerVolatility: "VOLATILE",
      transactionIsolation: "read committed",
      usesDynamicSql: false,
    });
    const initializer = modeled0003Functions.find(
      (routine) => routine.name === "initialize_operator_context",
    )?.source;
    expect(initializer).toBeDefined();
    const exactSource = initializer ?? "";
    const order = [
      "current_setting('transaction_isolation')",
      "current_setting('dasher.retention_phase', true)",
      "dasher:retention-principal-binding:v1|postgres_session_user|",
      "pg_advisory_xact_lock(v_binding_gate)",
      "WITH exact_binding AS MATERIALIZED",
      "FROM dasher.retention_service_principal_allowlist",
      "binding_proof AS",
      "proof.distinct_principal_count = 1",
      "FROM unique_latest",
      "WITH RECURSIVE authority_chain",
      "NOT v_enabled",
      "set_config('dasher.retention_phase', 'target_discovery'",
      "FROM dasher.dashboards",
      "pg_advisory_xact_lock(v_organization_gate)",
      "set_config('dasher.retention_phase', 'authorized'",
      "PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority",
    ].map((fragment) => exactSource.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(exactSource).not.toMatch(
      /\bEXECUTE\b|pg_backend_pid|pg_stat_activity/iu,
    );
    expect(exactSource).not.toMatch(/FOR UPDATE/gu);
    expect(hasInitializerAuthoritySemantics(exactSource)).toBe(true);
    expect(exactSource).toContain(
      "v_chain_count <> v_principal_revision OR v_chain_min_revision <> 1",
    );
    for (const contextKey of [
      "retention_principal_id",
      "retention_principal_revision",
      "retention_authority_scope",
      "retention_capability",
      "retention_target_dashboard_id",
      "retention_target_organization_id",
      "retention_request_id",
      "retention_case_matter_reference",
      "retention_expected_lifecycle_revision",
    ]) {
      expect(exactSource).toContain(
        `current_setting('dasher.${contextKey}', true)`,
      );
    }
    const latestLookup = exactSource.slice(
      exactSource.indexOf("WITH exact_binding AS MATERIALIZED"),
      exactSource.indexOf("IF NOT FOUND THEN"),
    );
    expect(latestLookup).not.toMatch(/enabled\s*=|AND\s+enabled/iu);
    expect(exactSource).toContain(
      "scope_organization_id, enabled, can_initialize",
    );
    expect(exactSource).toContain(
      "OR NOT v_can_initialize OR NOT v_capability_allowed",
    );
    expect(exactSource).toContain(
      "set_config('dasher.retention_capability', $2, true)",
    );
    expect(exactSource).not.toContain(
      "set_config('dasher.retention_capability', 'initialize', true)",
    );
    expect(modeled0003Policies[0]?.using).toBe(
      "((CURRENT_USER = 'dasher_retention_definer'::name) AND (binding_kind = 'postgres_session_user'::text) AND (binding_subject = SESSION_USER))",
    );
    expect(modeled0003Policies[0]?.using).not.toMatch(
      /current_setting|retention_phase|retention_capability/iu,
    );
    const targetDiscoveryPolicy = modeled0003Policies.find(
      (policy) =>
        policy.name === "dashboards_retention_target_discovery_select",
    );
    expect(targetDiscoveryPolicy?.using).toContain(
      "current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])",
    );
    expect(targetDiscoveryPolicy?.using).toContain(
      "FROM dasher.retention_service_principal_allowlist AS bound_authority",
    );
    expect(targetDiscoveryPolicy?.using).toContain(
      "bound_authority.binding_subject = SESSION_USER",
    );
    expect(targetDiscoveryPolicy?.using).toContain(
      "later_authority.principal_revision > bound_authority.principal_revision",
    );
    expect(targetDiscoveryPolicy?.using).toContain(
      "organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid",
    );
    expect(targetDiscoveryPolicy?.using).not.toContain("'initialize'::text");
    expect(
      hasExactDiscoveryPolicySemantics(targetDiscoveryPolicy?.using ?? ""),
    ).toBe(true);

    const initializerMutants = [
      exactSource.replace(
        "OR NOT v_can_initialize OR NOT v_capability_allowed",
        "OR NOT v_capability_allowed",
      ),
      exactSource.replace(
        "set_config('dasher.retention_capability', $2, true)",
        "set_config('dasher.retention_capability', 'initialize', true)",
      ),
      exactSource.replace(
        "WITH exact_binding AS MATERIALIZED",
        "PERFORM pg_catalog.set_config('dasher.retention_phase', 'target_discovery', true);\n  WITH exact_binding AS MATERIALIZED",
      ),
      exactSource.replace("IF $1 IS NULL OR $5 IS NULL", "IF $1 IS NULL"),
      exactSource.replace(
        "  PERFORM set_config('dasher.retention_target_organization_id', $5::text, true);\n",
        "",
      ),
      exactSource.replace(
        "WHERE dashboard.organization_id = $5\n    AND dashboard.dashboard_id = $1;",
        "WHERE dashboard.dashboard_id = $1;",
      ),
    ];
    expect(initializerMutants[0]).not.toContain("OR NOT v_can_initialize");
    expect(initializerMutants[1]).toContain(
      "set_config('dasher.retention_capability', 'initialize', true)",
    );
    expect(initializerMutants[2]).not.toBe(exactSource);
    for (const mutant of initializerMutants) {
      expect(mutant).not.toBe(exactSource);
      expect(hasInitializerAuthoritySemantics(mutant)).toBe(false);
    }

    const mismatchedCapabilityPolicy = targetDiscoveryPolicy?.using?.replace(
      "'purge'::text]",
      "'initialize'::text]",
    );
    expect(mismatchedCapabilityPolicy).not.toBe(targetDiscoveryPolicy?.using);
    expect(mismatchedCapabilityPolicy).not.toContain(
      "'record_attempt'::text, 'purge'::text]",
    );
    expect(
      hasExactDiscoveryPolicySemantics(mismatchedCapabilityPolicy ?? ""),
    ).toBe(false);
    const broadCapabilityPolicy = targetDiscoveryPolicy?.using?.replace(
      "= ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])",
      "<> ''::text",
    );
    expect(broadCapabilityPolicy).not.toBe(targetDiscoveryPolicy?.using);
    expect(hasExactDiscoveryPolicySemantics(broadCapabilityPolicy ?? "")).toBe(
      false,
    );
    const dashboardOnlyDiscoveryPolicy = targetDiscoveryPolicy?.using?.replace(
      " AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid)",
      "",
    );
    expect(dashboardOnlyDiscoveryPolicy).not.toBe(targetDiscoveryPolicy?.using);
    expect(
      hasExactDiscoveryPolicySemantics(dashboardOnlyDiscoveryPolicy ?? ""),
    ).toBe(false);
  });

  it("exposes only atomic fixed-capability retention wrappers and exact lock grants", () => {
    const initializer = modeled0003Functions.find(
      (routine) => routine.name === "initialize_operator_context",
    );
    expect(initializer?.execute).toEqual([]);
    expect(hasInitializerAuthoritySemantics(initializer?.source ?? "")).toBe(
      true,
    );
    expect(initializer?.source).toContain(
      "COALESCE(current_setting('dasher.retention_phase', true), '') <> ''",
    );
    expect(initializer?.source).toContain(
      "v_chain_count <> v_principal_revision OR v_chain_min_revision <> 1",
    );
    expect(hasExactRetentionTypedSignatureMatrix(modeled0003Functions)).toBe(
      true,
    );
    for (const routineName of [
      "initialize_operator_context",
      ...retentionWrapperContracts.map((contract) => contract.name),
    ]) {
      const typedSignatureMutant = modeled0003Functions.map((routine) =>
        routine.name === routineName
          ? {
              ...routine,
              identityArguments: routine.identityArguments.replace(
                /, uuid$/u,
                "",
              ),
            }
          : routine,
      );
      expect(
        typedSignatureMutant.find((routine) => routine.name === routineName)
          ?.identityArguments,
        routineName,
      ).not.toBe(
        modeled0003Functions.find((routine) => routine.name === routineName)
          ?.identityArguments,
      );
      expect(
        hasExactRetentionTypedSignatureMatrix(typedSignatureMutant),
        routineName,
      ).toBe(false);
    }

    for (const contract of retentionWrapperContracts) {
      const routine = modeled0003Functions.find(
        (candidate) => candidate.name === contract.name,
      );
      expect(routine?.execute, contract.name).toEqual([
        "dasher_retention_operator",
      ]);
      expect(routine?.identityArguments, contract.name).toBe(
        contract.identityArguments,
      );
      const body = routine?.source ?? "";
      expect(
        hasAtomicRetentionWrapperSemantics(body, contract.initializer),
        contract.name,
      ).toBe(true);
      const removedInitializer = body.replace(
        `  PERFORM dasher_retention_api.${contract.initializer}\n`,
        "",
      );
      const callerSelectedCapability = body.replace(
        contract.initializer,
        contract.initializer.replace(/'[^']+'/u, "$2"),
      );
      const earlyContextRead = body.replace(
        `  PERFORM dasher_retention_api.${contract.initializer}`,
        `  PERFORM current_setting('dasher.retention_phase', true);\n  PERFORM dasher_retention_api.${contract.initializer}`,
      );
      const earlyReturn = body.replace(
        `  PERFORM dasher_retention_api.${contract.initializer}`,
        `  PERFORM dasher_retention_api.${contract.initializer}\n  RETURN;`,
      );
      const missingOrganizationArgument = body.replace(
        `, ${contract.organizationArgument}\n  );`,
        "\n  );",
      );
      for (const [mutantName, mutant] of [
        ["missing initializer", removedInitializer],
        ["caller-selected capability", callerSelectedCapability],
        ["authority read before initializer", earlyContextRead],
        ["locked revalidation unreachable", earlyReturn],
        [
          "initializer organization argument omitted",
          missingOrganizationArgument,
        ],
      ] as const) {
        expect(mutant, `${contract.name} ${mutantName}`).not.toBe(body);
        expect(
          hasAtomicRetentionWrapperSemantics(mutant, contract.initializer),
          `${contract.name} ${mutantName}`,
        ).toBe(false);
      }
    }

    const initializerSource = initializer?.source ?? "";
    expect(initializerSource).not.toMatch(/FOR UPDATE/iu);
    for (const contract of retentionWrapperContracts) {
      const body =
        modeled0003Functions.find(
          (candidate) => candidate.name === contract.name,
        )?.source ?? "";
      expect(
        hasCanonicalRetentionTargetLockOrder(
          initializerSource,
          body,
          contract.initializer,
        ),
        contract.name,
      ).toBe(true);
      const policyStatement =
        /  PERFORM 1 FROM dasher[.]dashboard_lifecycle_policies(?: AS policy)?[\s\S]*?FOR UPDATE(?: OF policy)?;/u.exec(
          body,
        )?.[0] ?? "";
      const dashboardStatement =
        /  SELECT \* INTO v_dashboard FROM dasher[.]dashboards AS dashboard[\s\S]*?FOR UPDATE(?: OF dashboard)?;/u.exec(
          body,
        )?.[0] ?? "";
      const reversedLocks = body
        .replace(policyStatement, "__TASK8A_POLICY_LOCK__")
        .replace(dashboardStatement, policyStatement)
        .replace("__TASK8A_POLICY_LOCK__", dashboardStatement);
      const missingPolicyLock = body.replace(
        /ORDER BY (?:policy[.])?policy_revision DESC LIMIT 1 FOR UPDATE(?: OF policy)?;/u,
        "ORDER BY policy_revision DESC LIMIT 1;",
      );
      const missingDashboardLock = body.replace(
        dashboardStatement,
        dashboardStatement.replace(/FOR UPDATE(?: OF dashboard)?;/u, ";"),
      );
      const earlyDashboardRead = body.replace(
        `  PERFORM dasher_retention_api.${contract.initializer}\n`,
        `  PERFORM dasher_retention_api.${contract.initializer}\n  PERFORM 1 FROM dasher.dashboards AS early_dashboard\n  WHERE early_dashboard.dashboard_id = $1;\n`,
      );
      const initializerDashboardLock = initializerSource.replace(
        "    AND dashboard.dashboard_id = $1;",
        "    AND dashboard.dashboard_id = $1\n  FOR UPDATE;",
      );
      for (const [mutantName, initializerMutant, wrapperMutant] of [
        ["initializer dashboard lock", initializerDashboardLock, body],
        ["policy/dashboard reversed", initializerSource, reversedLocks],
        ["policy lock omitted", initializerSource, missingPolicyLock],
        ["dashboard lock omitted", initializerSource, missingDashboardLock],
        ["early dashboard read", initializerSource, earlyDashboardRead],
      ] as const) {
        expect(
          initializerMutant !== initializerSource || wrapperMutant !== body,
          `${contract.name}: ${mutantName} effective`,
        ).toBe(true);
        expect(
          hasCanonicalRetentionTargetLockOrder(
            initializerMutant,
            wrapperMutant,
            contract.initializer,
          ),
          `${contract.name}: ${mutantName}`,
        ).toBe(false);
      }
    }

    expect(
      hasExactLockColumnPrivilegeMatrix(
        modeled0003CatalogMatrix.catalogColumnAcls,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ),
    ).toBe(true);
    expect(
      hasExactRowLockPolicyClosure(
        modeled0003Functions,
        modeled0003Policies,
        modeled0003CatalogMatrix.catalogColumnAcls,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ),
    ).toBe(true);
    expect(exactLockOnlyTriggerContracts).toHaveLength(13);
    for (const contract of exactLockOnlyTriggerContracts) {
      const triggers = modeled0003CatalogMatrix.triggers.filter(
        (trigger) =>
          trigger.relationName === contract.relation &&
          trigger.name === contract.trigger,
      );
      expect(triggers, contract.relation).toHaveLength(1);
      expect(triggers[0], contract.relation).toMatchObject({
        enabled: "O",
        events: ["UPDATE", "DELETE"],
        functionIdentity: contract.functionIdentity,
        level: "ROW",
        timing: "BEFORE",
      });
    }
    expect(exactRowLockTargets).toHaveLength(24);
    let lockPolicyCount = 0;
    for (const target of exactRowLockTargets) {
      for (const policyContract of target.policies) {
        lockPolicyCount += 1;
        const exactPolicy = modeled0003Policies.find(
          (policy) => policy.name === policyContract.name,
        );
        expect(exactPolicy, policyContract.name).toBeDefined();
        const missingPolicy = modeled0003Policies.filter(
          (policy) => policy.name !== policyContract.name,
        );
        const broadUsing = modeled0003Policies.map((policy) =>
          policy.name === policyContract.name
            ? { ...policy, using: "true" }
            : policy,
        );
        const broadWithCheck = modeled0003Policies.map((policy) =>
          policy.name === policyContract.name
            ? { ...policy, withCheck: "true" }
            : policy,
        );
        for (const [mutantName, policies] of [
          ["missing", missingPolicy],
          ["broad USING", broadUsing],
          ["broad WITH CHECK", broadWithCheck],
        ] as const) {
          expect(
            hasExactRowLockPolicyClosure(
              modeled0003Functions,
              policies,
              modeled0003CatalogMatrix.catalogColumnAcls,
              modeled0003CatalogMatrix.catalogRelationAcls,
            ),
            `${policyContract.name}: ${mutantName}`,
          ).toBe(false);
        }
      }
    }
    expect(lockPolicyCount).toBe(26);

    const representativeLockPolicy = modeled0003Policies.find(
      (policy) =>
        policy.name === "dashboard_lifecycle_policies_retention_lock_update",
    );
    expect(representativeLockPolicy).toBeDefined();
    const lockPolicyMutants = [
      ["duplicate", [...modeled0003Policies, { ...representativeLockPolicy! }]],
      [
        "wrong command",
        modeled0003Policies.map((policy) =>
          policy === representativeLockPolicy
            ? { ...policy, command: "SELECT", catalogCommand: "r" }
            : policy,
        ),
      ],
      [
        "wrong role",
        modeled0003Policies.map((policy) =>
          policy === representativeLockPolicy
            ? { ...policy, roles: ["dasher_app"] }
            : policy,
        ),
      ],
      [
        "wrong relation",
        modeled0003Policies.map((policy) =>
          policy === representativeLockPolicy
            ? { ...policy, relation: "audit_events" }
            : policy,
        ),
      ],
      [
        "missing WITH CHECK",
        modeled0003Policies.map((policy) =>
          policy === representativeLockPolicy
            ? { ...policy, withCheck: null }
            : policy,
        ),
      ],
      [
        "bootstrap UPDATE",
        modeled0003Policies.map((policy) =>
          policy === representativeLockPolicy
            ? { ...policy, bootstrap: true }
            : policy,
        ),
      ],
      [
        "extra non-lock relation UPDATE policy",
        [
          ...modeled0003Policies,
          {
            ...representativeLockPolicy!,
            name: "audit_events_retention_lock_update",
            relation: "audit_events",
          },
        ],
      ],
    ] as const;
    for (const [mutantName, policies] of lockPolicyMutants) {
      expect(
        hasExactRowLockPolicyClosure(
          modeled0003Functions,
          policies,
          modeled0003CatalogMatrix.catalogColumnAcls,
          modeled0003CatalogMatrix.catalogRelationAcls,
        ),
        mutantName,
      ).toBe(false);
    }
    const missingLiteralLock = modeled0003Functions.map((routine) =>
      routine.name === "decide_dashboard_promotion"
        ? {
            ...routine,
            source: routine.source.replace(
              "    AND requested_lifecycle_revision = $2\n  FOR SHARE;",
              "    AND requested_lifecycle_revision = $2;",
            ),
          }
        : routine,
    );
    expect(
      missingLiteralLock.find(
        (routine) => routine.name === "decide_dashboard_promotion",
      )?.source,
    ).not.toBe(
      modeled0003Functions.find(
        (routine) => routine.name === "decide_dashboard_promotion",
      )?.source,
    );
    expect(
      hasExactRowLockPolicyClosure(
        missingLiteralLock,
        modeled0003Policies,
        modeled0003CatalogMatrix.catalogColumnAcls,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ),
    ).toBe(false);
    const expectedLockGrant = modeled0003CatalogMatrix.catalogColumnAcls.find(
      (acl) =>
        acl.grantee === "dasher_retention_definer" &&
        acl.relationName === "dashboard_restore_lineage" &&
        acl.columnName === "organization_id" &&
        acl.privilege === "UPDATE",
    );
    expect(expectedLockGrant).toBeDefined();
    const extraColumnGrant = [
      ...modeled0003CatalogMatrix.catalogColumnAcls,
      {
        ...expectedLockGrant!,
        relationName: "dashboards",
        columnName: "title",
      },
    ];
    const duplicateLockGrant = [
      ...modeled0003CatalogMatrix.catalogColumnAcls,
      { ...expectedLockGrant! },
    ];
    const missingLockGrant = modeled0003CatalogMatrix.catalogColumnAcls.filter(
      (acl) =>
        !(
          acl.grantee === "dasher_retention_definer" &&
          acl.relationName === "dashboard_restore_lineage" &&
          acl.columnName === "organization_id" &&
          acl.privilege === "UPDATE"
        ),
    );
    const wrongDefinerGrant = modeled0003CatalogMatrix.catalogColumnAcls.map(
      (acl) =>
        acl === expectedLockGrant ? { ...acl, grantee: "dasher_app" } : acl,
    );
    const wrongColumnGrant = modeled0003CatalogMatrix.catalogColumnAcls.map(
      (acl) =>
        acl === expectedLockGrant ? { ...acl, columnName: "version_id" } : acl,
    );
    const broadRelationUpdate = [
      ...modeled0003CatalogMatrix.catalogRelationAcls,
      {
        schema: "dasher",
        relationName: "dashboard_restore_lineage",
        grantor: "migration_owner",
        grantee: "dasher_retention_definer",
        privilege: "UPDATE",
        isGrantable: false,
      },
    ];
    for (const [mutantName, columnAcls, relationAcls] of [
      [
        "extra UPDATE(title)",
        extraColumnGrant,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ],
      [
        "duplicate expected grant",
        duplicateLockGrant,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ],
      [
        "missing expected grant",
        missingLockGrant,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ],
      [
        "wrong definer",
        wrongDefinerGrant,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ],
      [
        "wrong column",
        wrongColumnGrant,
        modeled0003CatalogMatrix.catalogRelationAcls,
      ],
      [
        "relation-wide UPDATE",
        modeled0003CatalogMatrix.catalogColumnAcls,
        broadRelationUpdate,
      ],
    ] as const) {
      expect(
        hasExactLockColumnPrivilegeMatrix(columnAcls, relationAcls),
        mutantName,
      ).toBe(false);
      expect(
        hasExactRowLockPolicyClosure(
          modeled0003Functions,
          modeled0003Policies,
          columnAcls,
          relationAcls,
        ),
        `${mutantName}: bidirectional closure`,
      ).toBe(false);
    }
  });

  it("keeps restored purge reachable and models bounded crash-resumable stages", () => {
    const purge =
      modeled0003Functions.find((routine) => routine.name === "purge_dashboard")
        ?.source ?? "";
    const retentionTrigger =
      modeled0003Functions.find(
        (routine) => routine.name === "enforce_retention_mutation",
      )?.source ?? "";
    expect(
      modeled0003CatalogMatrix.constraints.some(
        (constraint) =>
          constraint.name === "dashboard_restore_lineage_dashboard_version_fk",
      ),
    ).toBe(true);
    expect(
      modeled0003CatalogMatrix.constraints.some(
        (constraint) =>
          String(constraint.name) === "dashboard_artifacts_version_fk",
      ),
    ).toBe(false);
    expect(
      modeled0003CatalogMatrix.constraints.some((constraint) =>
        /deletion_finalizers_(?:snapshot|evidence|artifact)_fk/u.test(
          constraint.name,
        ),
      ),
    ).toBe(false);
    expect(
      modeled0003CatalogMatrix.triggers.find(
        (trigger) => trigger.name === "dashboard_restore_lineage_immutable",
      ),
    ).toMatchObject({
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      events: ["UPDATE", "DELETE"],
    });
    const restoreLineagePolicies = modeled0003Policies.filter(
      (policy) => policy.relation === "dashboard_restore_lineage",
    );
    expect(restoreLineagePolicies.map((policy) => policy.command)).toEqual([
      "SELECT",
      "DELETE",
      "UPDATE",
    ]);
    expect(
      restoreLineagePolicies.every((policy) =>
        hasExactPolicyCapabilities(policy, ["purge"]),
      ),
    ).toBe(true);
    expect(
      modeled0003CatalogMatrix.catalogRelationAcls.filter(
        (acl) =>
          acl.relationName === "dashboard_restore_lineage" &&
          acl.privilege === "DELETE",
      ),
    ).toEqual([
      expect.objectContaining({ grantee: "dasher_retention_definer" }),
    ]);
    expect(retentionTrigger).toContain(
      "TG_TABLE_NAME = 'dashboard_restore_lineage'\n      AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id",
    );
    expect(
      retentionTrigger.replace(
        "    ) OR (\n      TG_TABLE_NAME = 'dashboard_restore_lineage'\n      AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id\n",
        "",
      ),
    ).not.toContain("TG_TABLE_NAME = 'dashboard_restore_lineage'");
    expect(
      modeled0003CatalogMatrix.catalogRelationAcls.some(
        (acl) =>
          acl.relationName === "dashboard_restore_lineage" &&
          acl.privilege === "DELETE" &&
          ["dasher_app", "dasher_security_definer"].includes(acl.grantee),
      ),
    ).toBe(false);
    expect(
      containsFragmentsInOrder(purge, [
        "DELETE FROM dasher.dashboard_restore_lineage AS lineage",
        "DELETE FROM dasher.dashboard_versions AS version",
      ]),
    ).toBe(true);

    expect(purge).toContain("v_batch_limit constant integer := 100;");
    expect(purge.match(/LIMIT v_batch_limit/gu)).toHaveLength(16);
    expect(
      purge.match(
        /\n  LIMIT 1\n  FOR UPDATE OF (?:snapshot|evidence|artifact);/gu,
      ),
    ).toHaveLength(3);
    expect(purgeStageContracts).toHaveLength(16);
    expect(hasExactPurgeStageContract(purge)).toBe(true);
    const purgeStart = purge.indexOf(
      "UPDATE dasher.dashboards\n    SET purge_started_at = v_now",
    );
    const startReturn = purge.indexOf("    RETURN;", purgeStart);
    const firstIntent = purge.indexOf(
      "INSERT INTO dasher.snapshot_deletion_finalizers",
    );
    expect(purgeStart).toBeGreaterThanOrEqual(0);
    expect(startReturn).toBeGreaterThan(purgeStart);
    expect(firstIntent).toBeGreaterThan(startReturn);
    expect(
      containsFragmentsInOrder(purge, [
        "INSERT INTO dasher.snapshot_deletion_finalizers",
        "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
        "AND finalizer.state = 'eligible'",
        "SET state = 'deleted', bytes_deleted_at = v_now",
        "SET current_step = 'final_proof_ready'",
        "UPDATE dasher.dashboard_tombstones SET purged_at",
        "UPDATE dasher.dashboards SET lifecycle_state = 'cleaned'",
        "INSERT INTO dasher.dashboard_lifecycle_events",
        "INSERT INTO dasher.audit_events",
      ]),
    ).toBe(true);
    expect(purge).toContain("IF v_row_count > 0 THEN RETURN; END IF;");
    expect(purge.match(/dashboard_lifecycle_events/gu)).toHaveLength(1);
    expect(
      purge.match(/lifecycle_revision = lifecycle_revision \+ 1/gu),
    ).toHaveLength(1);
    expect(retentionTrigger).toContain(
      "OLD.state = 'intent' AND NEW.state = 'eligible'",
    );
    expect(retentionTrigger).toContain(
      "OLD.state = 'eligible' AND NEW.state = 'deleted'",
    );
    expect(retentionTrigger).not.toContain(
      "OLD.state IN ('intent', 'eligible')\n      AND NEW.state = 'deleted'",
    );
    expect(retentionTrigger).toContain(
      "uuid_send(v_organization_id) || uuid_send(v_dashboard_id)",
    );
    for (const resourceKind of ["snapshot", "evidence", "artifact"]) {
      expect(purge).toContain(`${resourceKind}|expected_claim_set=empty`);
      for (const policy of modeled0003Policies.filter(
        (candidate) =>
          candidate.relation.startsWith(
            `${resourceKind}_deletion_finalizers`,
          ) &&
          candidate.roles.length === 1 &&
          candidate.roles[0] === "dasher_retention_definer",
      )) {
        expect(
          `${policy.using ?? ""} ${policy.withCheck ?? ""}`,
          policy.name,
        ).toContain(`${resourceKind}|expected_claim_set=empty`);
      }
    }
    expect(hasExactPurgeStageContract(purge)).toBe(true);
    expect(hasExactFinalizerPaginationClosure(purge)).toBe(true);
    expect(hasExactPurgeCompletenessGate(purge)).toBe(true);
    expect(
      hasExactSharedArtifactGovernance(
        purge,
        retentionTrigger,
        modeled0003Policies,
      ),
    ).toBe(true);
    expect(hasCrashResumablePurgeSemantics(purge, retentionTrigger)).toBe(true);
    const ranges = purgeStageRanges(purge);
    expect(ranges).toHaveLength(16);
    const paginationMutants: Array<readonly [string, string]> = [];
    for (const [resource, relation] of [
      ["snapshot", "snapshot_deletion_finalizers"],
      ["evidence", "evidence_deletion_finalizers"],
      ["artifact", "artifact_deletion_finalizers"],
    ] as const) {
      paginationMutants.push([
        `${resource} pre-limit finalizer exclusion`,
        replaceAfter(
          purge,
          `v_${resource}_ids := ARRAY(`,
          `AND NOT EXISTS (\n        SELECT 1 FROM dasher.${relation} AS existing`,
          `AND EXISTS (\n        SELECT 1 FROM dasher.${relation} AS existing`,
        ),
      ]);
      paginationMutants.push([
        `${resource} pre-limit exclusivity`,
        replaceAfter(
          purge,
          `v_${resource}_ids := ARRAY(`,
          `AND NOT EXISTS (\n        SELECT 1 FROM dasher.${resource}_reference_claims AS other_claim`,
          `AND EXISTS (\n        SELECT 1 FROM dasher.${resource}_reference_claims AS other_claim`,
        ),
      ]);
    }
    paginationMutants.push([
      "snapshot candidate order",
      replaceAfter(
        purge,
        "v_snapshot_ids := ARRAY(",
        "ORDER BY snapshot.snapshot_id\n    LIMIT v_batch_limit",
        "ORDER BY snapshot.snapshot_id DESC\n    LIMIT v_batch_limit",
      ),
    ]);
    paginationMutants.push([
      "snapshot link order",
      purge.replace(
        "ORDER BY link.version_id, link.snapshot_id\n    LIMIT v_batch_limit",
        "ORDER BY link.snapshot_id, link.version_id\n    LIMIT v_batch_limit",
      ),
    ]);
    for (const [name, mutant] of paginationMutants) {
      expect(mutant, name).not.toBe(purge);
      expect(
        hasCrashResumablePurgeSemantics(mutant, retentionTrigger),
        name,
      ).toBe(false);
    }
    const completenessMutants: Array<readonly [string, string]> = [];
    for (const contract of [
      {
        alias: "snapshot",
        finalizer: "snapshot_deletion_finalizers",
        id: "snapshot_id",
        variable: "v_gap_snapshot_id",
      },
      {
        alias: "evidence",
        finalizer: "evidence_deletion_finalizers",
        id: "evidence_id",
        variable: "v_gap_evidence_id",
      },
      {
        alias: "artifact",
        finalizer: "artifact_deletion_finalizers",
        id: "artifact_id",
        variable: "v_gap_artifact_id",
      },
    ] as const) {
      const probe = `SELECT ${contract.alias}.${contract.id} INTO ${contract.variable}`;
      completenessMutants.push([
        `${contract.alias} completeness bound`,
        replaceAfter(
          purge,
          probe,
          `ORDER BY ${contract.alias}.${contract.id}\n  LIMIT 1\n  FOR UPDATE OF ${contract.alias}`,
          `ORDER BY ${contract.alias}.${contract.id}\n  FOR UPDATE OF ${contract.alias}`,
        ),
      ]);
      completenessMutants.push([
        `${contract.alias} fresh completeness recheck`,
        removeCompletenessRecheck(purge, contract.variable),
      ]);
      completenessMutants.push([
        `${contract.alias} completeness gap predicate`,
        replaceAfter(
          purge,
          probe,
          `AND NOT EXISTS (\n      SELECT 1 FROM dasher.${contract.finalizer} AS finalizer`,
          `AND EXISTS (\n      SELECT 1 FROM dasher.${contract.finalizer} AS finalizer`,
        ),
      ]);
    }
    const unboundedCompletenessLock =
      "  PERFORM 1 FROM dasher.source_snapshots AS snapshot\n" +
      "  WHERE snapshot.organization_id = v_organization_id\n" +
      "    AND EXISTS (\n" +
      "      SELECT 1 FROM dasher.dashboard_version_snapshots AS link\n" +
      "      WHERE link.organization_id = snapshot.organization_id\n" +
      "        AND link.dashboard_id = $1\n" +
      "        AND link.snapshot_id = snapshot.snapshot_id\n" +
      "    )\n" +
      "  ORDER BY snapshot.snapshot_id\n" +
      "  FOR UPDATE OF snapshot;\n\n";
    completenessMutants.push([
      "unbounded completeness lock",
      purge.replace(
        "  SELECT snapshot.snapshot_id INTO v_gap_snapshot_id",
        unboundedCompletenessLock +
          "  SELECT snapshot.snapshot_id INTO v_gap_snapshot_id",
      ),
    ]);
    for (const [name, mutant] of completenessMutants) {
      expect(mutant, name).not.toBe(purge);
      expect(hasExactPurgeCompletenessGate(mutant), name).toBe(false);
      expect(
        hasCrashResumablePurgeSemantics(mutant, retentionTrigger),
        name,
      ).toBe(false);
    }
    const ownerOnlySelectorMutant = replaceAfter(
      purge,
      "v_artifact_ids := ARRAY(",
      "artifact.ownership_class = 'shared'",
      "artifact.ownership_class = 'dashboard_owned'",
    );
    const missingTargetClaimMutant = replaceAfter(
      purge,
      "v_artifact_ids := ARRAY(",
      "target_claim.dashboard_id = $1",
      "target_claim.dashboard_id IS NOT NULL",
    );
    const broadSharedDeleteMutant = replaceAfter(
      retentionTrigger,
      "TG_TABLE_NAME = 'dashboard_artifacts'",
      "finalizer.state = 'deleted'",
      "finalizer.state <> 'intent'",
    );
    const missingSharedFinalizerMutant = replaceAfter(
      retentionTrigger,
      "TG_TABLE_NAME = 'dashboard_artifacts'",
      "FROM dasher.artifact_deletion_finalizers AS finalizer",
      "FROM dasher.snapshot_deletion_finalizers AS finalizer",
    );
    const missingSharedHashMutant = replaceAfter(
      retentionTrigger,
      "TG_TABLE_NAME = 'dashboard_artifacts'",
      "artifact|expected_claim_set=empty",
      "artifact|unchecked_claim_set",
    );
    const missingSharedTriggerProofMutant = replaceAfter(
      retentionTrigger,
      "TG_TABLE_NAME = 'dashboard_artifacts'",
      "          AND finalizer.proof_sha256 IS NOT NULL\n",
      "",
    );
    const finalProofIgnoresSharedMutant = replaceAfter(
      purge,
      "IF EXISTS (\n    SELECT 1 FROM dasher.dashboard_versions AS version",
      "artifact.ownership_class = 'shared'",
      "artifact.ownership_class = 'dashboard_owned'",
    );
    const broadDeletePolicyMutant = modeled0003Policies.map((policy) =>
      policy.name === "dashboard_artifacts_retention_delete"
        ? {
            ...policy,
            using:
              policy.using?.replace(
                "target_finalizer.state = 'deleted'::text",
                "target_finalizer.state <> 'intent'::text",
              ) ?? null,
          }
        : policy,
    );
    const missingDeletePolicyHashMutant = modeled0003Policies.map((policy) =>
      policy.name === "dashboard_artifacts_retention_delete"
        ? {
            ...policy,
            using:
              policy.using?.replace(
                "artifact|expected_claim_set=empty",
                "artifact|unchecked_claim_set",
              ) ?? null,
          }
        : policy,
    );
    const missingDeletePolicyProofMutant = modeled0003Policies.map((policy) =>
      policy.name === "dashboard_artifacts_retention_delete"
        ? {
            ...policy,
            using:
              policy.using?.replace(
                " AND target_finalizer.proof_sha256 IS NOT NULL",
                "",
              ) ?? null,
          }
        : policy,
    );
    for (const [name, purgeMutant, triggerMutant, policyMutant] of [
      [
        "owner-only artifact selector",
        ownerOnlySelectorMutant,
        retentionTrigger,
        modeled0003Policies,
      ],
      [
        "missing exact target claim",
        missingTargetClaimMutant,
        retentionTrigger,
        modeled0003Policies,
      ],
      [
        "broad shared trigger deletion",
        purge,
        broadSharedDeleteMutant,
        modeled0003Policies,
      ],
      [
        "shared trigger deletion without exact finalizer",
        purge,
        missingSharedFinalizerMutant,
        modeled0003Policies,
      ],
      [
        "shared trigger deletion without exact hash domain",
        purge,
        missingSharedHashMutant,
        modeled0003Policies,
      ],
      [
        "shared trigger deletion without non-null proof",
        purge,
        missingSharedTriggerProofMutant,
        modeled0003Policies,
      ],
      [
        "broad shared policy deletion",
        purge,
        retentionTrigger,
        broadDeletePolicyMutant,
      ],
      [
        "shared delete policy without exact hash domain",
        purge,
        retentionTrigger,
        missingDeletePolicyHashMutant,
      ],
      [
        "shared delete policy without non-null finalizer proof",
        purge,
        retentionTrigger,
        missingDeletePolicyProofMutant,
      ],
      [
        "final proof ignores governed shared artifact",
        finalProofIgnoresSharedMutant,
        retentionTrigger,
        modeled0003Policies,
      ],
    ] as const) {
      expect(
        purgeMutant !== purge ||
          triggerMutant !== retentionTrigger ||
          !isDeepStrictEqual(policyMutant, modeled0003Policies),
        name,
      ).toBe(true);
      expect(
        hasExactSharedArtifactGovernance(
          purgeMutant,
          triggerMutant,
          policyMutant,
        ),
        name,
      ).toBe(false);
    }
    for (let index = 0; index < purgeStageContracts.length; index += 1) {
      const range = ranges?.[index];
      expect(range, purgeStageContracts[index]!.name).toBeDefined();
      const stage = purge.slice(range!.start, range!.end);
      const unboundedStage = stage.replace("    LIMIT v_batch_limit\n", "");
      expect(unboundedStage, purgeStageContracts[index]!.name).not.toBe(stage);
      const missingBoundMutant =
        purge.slice(0, range!.start) + unboundedStage + purge.slice(range!.end);
      const missingStageMutant =
        purge.slice(0, range!.start) + purge.slice(range!.end);
      expect(
        hasCrashResumablePurgeSemantics(missingBoundMutant, retentionTrigger),
        `${purgeStageContracts[index]!.name}: missing bound`,
      ).toBe(false);
      expect(
        hasCrashResumablePurgeSemantics(missingStageMutant, retentionTrigger),
        `${purgeStageContracts[index]!.name}: missing stage`,
      ).toBe(false);
    }
    const restoreLineageRange = ranges?.[9];
    const restoredLineageMutant =
      purge.slice(0, restoreLineageRange!.start) +
      purge.slice(restoreLineageRange!.end);
    expect(restoredLineageMutant).not.toContain(
      "DELETE FROM dasher.dashboard_restore_lineage AS lineage",
    );
    expect(
      hasCrashResumablePurgeSemantics(restoredLineageMutant, retentionTrigger),
    ).toBe(false);
    const firstReorderedRange = ranges?.[9];
    const secondReorderedRange = ranges?.[10];
    const reorderedStagesMutant =
      purge.slice(0, firstReorderedRange!.start) +
      purge.slice(secondReorderedRange!.start, secondReorderedRange!.end) +
      purge.slice(firstReorderedRange!.start, firstReorderedRange!.end) +
      purge.slice(secondReorderedRange!.end);
    const missingImmediateReturnMutant = purge
      .replace(
        "DELETE FROM dasher.dashboard_restore_lineage AS lineage\n  USING candidates AS candidate",
        "DELETE FROM dasher.dashboard_restore_lineage AS lineage\n  USING candidates AS candidate",
      )
      .replace(
        "IF v_row_count > 0 THEN RETURN; END IF;\n\n  WITH candidates AS MATERIALIZED (\n    SELECT link.organization_id, link.dashboard_id, link.version_id,\n      link.evidence_id",
        "IF v_row_count > 0 THEN NULL; END IF;\n\n  WITH candidates AS MATERIALIZED (\n    SELECT link.organization_id, link.dashboard_id, link.version_id,\n      link.evidence_id",
      );
    const wrongFixedBoundMutant = purge.replace(
      "v_batch_limit constant integer := 100;",
      "v_batch_limit constant integer := 101;",
    );
    const falseDeletedProofMutant = purge.replace(
      "v_deleted_row_count <> v_expected_delete_count OR EXISTS",
      "false OR EXISTS",
    );
    const artifactDeleteRange = ranges?.[12];
    const artifactDeleteStage = purge.slice(
      artifactDeleteRange!.start,
      artifactDeleteRange!.end,
    );
    const artifactDeleteProofStart = artifactDeleteStage.indexOf(
      "    SELECT count(*) INTO v_expected_delete_count",
    );
    const artifactDeleteProofEnd = artifactDeleteStage.lastIndexOf(
      "    RETURN;\n  END IF;",
    );
    expect(artifactDeleteProofStart).toBeGreaterThanOrEqual(0);
    expect(artifactDeleteProofEnd).toBeGreaterThan(artifactDeleteProofStart);
    const missingDeletedProofStage =
      artifactDeleteStage.slice(0, artifactDeleteProofStart) +
      artifactDeleteStage.slice(artifactDeleteProofEnd);
    const missingDeletedProofMutant =
      purge.slice(0, artifactDeleteRange!.start) +
      missingDeletedProofStage +
      purge.slice(artifactDeleteRange!.end);
    const deadEligibleMutant = retentionTrigger.replace(
      "OLD.state = 'intent' AND NEW.state = 'eligible'",
      "OLD.state = 'intent' AND NEW.state = 'deleted'",
    );
    expect(deadEligibleMutant).not.toContain(
      "OLD.state = 'intent' AND NEW.state = 'eligible'",
    );
    const prematureCleanMutant = purge.replace(
      "    RETURN;\n  END IF;\n\n  WITH candidates AS MATERIALIZED (",
      "    UPDATE dasher.dashboards SET lifecycle_state = 'cleaned';\n    RETURN;\n  END IF;\n\n  WITH candidates AS MATERIALIZED (",
    );
    expect(prematureCleanMutant).not.toBe(purge);
    expect(
      prematureCleanMutant.indexOf(
        "UPDATE dasher.dashboards SET lifecycle_state = 'cleaned'",
      ),
    ).toBeLessThan(
      prematureCleanMutant.indexOf("SET current_step = 'final_proof_ready'"),
    );
    const prematureEventMutant = purge.replace(
      "    RETURN;\n  END IF;\n\n  IF $3 IS NULL THEN",
      "    INSERT INTO dasher.dashboard_lifecycle_events DEFAULT VALUES;\n    RETURN;\n  END IF;\n\n  IF $3 IS NULL THEN",
    );
    expect(prematureEventMutant).not.toBe(purge);
    expect(
      prematureEventMutant.indexOf(
        "INSERT INTO dasher.dashboard_lifecycle_events",
      ),
    ).toBeLessThan(
      prematureEventMutant.indexOf("SET current_step = 'final_proof_ready'"),
    );
    const missingBoundaryMutant = purge.replace(
      "    RETURN;\n  END IF;\n\n  IF $3 IS NULL THEN",
      "  END IF;\n\n  IF $3 IS NULL THEN",
    );
    const directIntentDeleteMutant = purge.replace(
      "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
      "SET state = 'deleted', proof_sha256 = finalizer.expected_claim_set_sha256",
    );
    for (const mutant of [
      [missingBoundaryMutant, retentionTrigger],
      [directIntentDeleteMutant, retentionTrigger],
      [purge, deadEligibleMutant],
      [prematureCleanMutant, retentionTrigger],
      [prematureEventMutant, retentionTrigger],
      [reorderedStagesMutant, retentionTrigger],
      [missingImmediateReturnMutant, retentionTrigger],
      [wrongFixedBoundMutant, retentionTrigger],
      [falseDeletedProofMutant, retentionTrigger],
      [missingDeletedProofMutant, retentionTrigger],
    ] as const) {
      expect(mutant[0] !== purge || mutant[1] !== retentionTrigger).toBe(true);
      expect(hasCrashResumablePurgeSemantics(mutant[0], mutant[1])).toBe(false);
    }
  });

  it("closes resource re-reference races across every modeled admission path", () => {
    const source = (name: string): string =>
      modeled0003Functions.find((routine) => routine.name === name)?.source ??
      "";
    const createEvidence = source("create_evidence_record");
    const createVersion = source("create_dashboard_version");
    const restore = source("restore_dashboard_as_new");
    const purge = source("purge_dashboard");
    expect(
      hasClosedResourceFinalizerProtocol(
        createEvidence,
        createVersion,
        restore,
        purge,
      ),
    ).toBe(true);
    expect(
      [...evidencePurgeReachabilityGraph(createEvidence, purge)].sort(),
    ).toEqual([...evidencePurgeReachabilityNodes].sort());
    expect(
      modeled0003Policies
        .filter((policy) =>
          policy.name.endsWith("_deletion_finalizers_security_select"),
        )
        .map((policy) => [policy.relation, policy.roles, policy.command]),
    ).toEqual([
      ["snapshot_deletion_finalizers", ["dasher_security_definer"], "SELECT"],
      ["evidence_deletion_finalizers", ["dasher_security_definer"], "SELECT"],
      ["artifact_deletion_finalizers", ["dasher_security_definer"], "SELECT"],
    ]);
    expect(
      modeled0003CatalogMatrix.catalogColumnAcls
        .filter(
          (acl) =>
            acl.grantee === "dasher_security_definer" &&
            acl.privilege === "SELECT" &&
            acl.relationName.endsWith("_deletion_finalizers"),
        )
        .map((acl) => [acl.relationName, acl.columnName]),
    ).toEqual([
      ["snapshot_deletion_finalizers", "organization_id"],
      ["snapshot_deletion_finalizers", "snapshot_id"],
      ["evidence_deletion_finalizers", "organization_id"],
      ["evidence_deletion_finalizers", "evidence_id"],
      ["artifact_deletion_finalizers", "organization_id"],
      ["artifact_deletion_finalizers", "artifact_id"],
    ]);
    expect(
      modeled0003CatalogMatrix.catalogRelationAcls.some(
        (acl) =>
          acl.grantee === "dasher_security_definer" &&
          acl.privilege === "SELECT" &&
          acl.relationName.endsWith("_deletion_finalizers"),
      ),
    ).toBe(false);
    expect(
      modeled0003CatalogMatrix.aclDependencyRows.filter(
        (row) =>
          row.objectKind === "column" &&
          ((row.grantee === "dasher_security_definer" &&
            row.privilege === "SELECT" &&
            /_deletion_finalizers[.]/u.test(row.identity)) ||
            (row.grantee === "dasher_retention_definer" &&
              row.privilege === "UPDATE" &&
              (row.identity === "dasher.source_snapshots.organization_id" ||
                row.identity === "dasher.evidence_records.organization_id"))),
      ),
    ).toHaveLength(8);
    expect(
      modeled0003CatalogMatrix.policyDependencyRows.filter(
        (row) =>
          row.roleName === "dasher_security_definer" &&
          row.identity.endsWith("_deletion_finalizers_security_select"),
      ),
    ).toHaveLength(3);

    const missingCreateEvidenceChecks = createEvidence.replace(
      /  IF EXISTS \(\n    SELECT 1 FROM dasher[.]snapshot_deletion_finalizers[\s\S]*?  END IF;\n/u,
      "",
    );
    const missingCreateVersionSnapshotCheck = createVersion.replace(
      /  IF EXISTS \(\n    SELECT 1 FROM dasher[.]snapshot_deletion_finalizers[\s\S]*?  END IF;\n/u,
      "",
    );
    const missingCreateVersionEvidenceCheck = createVersion.replace(
      /  IF EXISTS \(\n    SELECT 1 FROM dasher[.]evidence_deletion_finalizers[\s\S]*?  END IF;\n/u,
      "",
    );
    const missingRestoreSnapshotCheck = restore.replace(
      / OR EXISTS \(\n    SELECT 1 FROM dasher[.]snapshot_deletion_finalizers[\s\S]*?  \) THEN\n/u,
      " THEN\n",
    );
    const missingRestoreEvidenceCheck = restore.replace(
      / OR EXISTS \(\n    SELECT 1 FROM dasher[.]evidence_deletion_finalizers[\s\S]*?  \) THEN\n/u,
      " THEN\n",
    );
    const missingCreateEvidenceResourceLock = createEvidence.replace(
      "  FOR SHARE;\n  IF NOT FOUND THEN",
      ";\n  IF NOT FOUND THEN",
    );
    const missingCreateVersionSnapshotLock = createVersion.replace(
      "ORDER BY snapshot.snapshot_id FOR SHARE;",
      "ORDER BY snapshot.snapshot_id;",
    );
    const missingCreateVersionEvidenceLock = createVersion.replace(
      "ORDER BY evidence.evidence_id FOR SHARE;",
      "ORDER BY evidence.evidence_id;",
    );
    const missingRestoreSnapshotLock = restore.replace(
      "ORDER BY snapshot.snapshot_id FOR SHARE;",
      "ORDER BY snapshot.snapshot_id;",
    );
    const missingRestoreEvidenceLock = restore.replace(
      "ORDER BY evidence.evidence_id FOR SHARE;",
      "ORDER BY evidence.evidence_id;",
    );
    const missingPurgeSnapshotLock = purge.replace(
      "    FOR UPDATE OF snapshot\n",
      "",
    );
    const missingPurgeEvidenceLock = purge.replace(
      "    FOR UPDATE OF evidence\n",
      "",
    );
    const missingPurgeArtifactLock = purge.replace(
      "    FOR UPDATE OF artifact\n",
      "",
    );
    const missingCreateEvidenceLink = createEvidence.replace(
      exactCreateEvidenceLinkInsert,
      "",
    );
    const movedCreateEvidenceLinkAfterAudit = missingCreateEvidenceLink.replace(
      "\nEND\n",
      `\n  ${exactCreateEvidenceLinkInsert}\nEND\n`,
    );
    const weakenedCreateEvidenceVersionIdentity = createEvidence.replace(
      exactCreateEvidenceLinkInsert,
      exactCreateEvidenceLinkInsert.replace("$1, $2, $3", "$1, $1, $3"),
    );
    const unrelatedPurgeEvidenceIdentity = purge.replace(
      "link.evidence_id = evidence.evidence_id",
      "link.evidence_id = $4",
    );
    for (const [mutantName, evidenceSource, purgeSource] of [
      ["missing evidence reachability link", missingCreateEvidenceLink, purge],
      [
        "evidence reachability link after audit",
        movedCreateEvidenceLinkAfterAudit,
        purge,
      ],
      [
        "weakened evidence version identity",
        weakenedCreateEvidenceVersionIdentity,
        purge,
      ],
      [
        "unrelated purge evidence identity",
        createEvidence,
        unrelatedPurgeEvidenceIdentity,
      ],
    ] as const) {
      const reachable = evidencePurgeReachabilityGraph(
        evidenceSource,
        purgeSource,
      );
      expect(reachable.has("snapshot_deleted"), mutantName).toBe(false);
      expect(
        hasClosedResourceFinalizerProtocol(
          evidenceSource,
          createVersion,
          restore,
          purgeSource,
        ),
        mutantName,
      ).toBe(false);
    }
    for (const [
      mutantName,
      evidenceSource,
      versionSource,
      restoreSource,
      purgeSource,
    ] of [
      [
        "create evidence finalizer checks",
        missingCreateEvidenceChecks,
        createVersion,
        restore,
        purge,
      ],
      [
        "create version snapshot finalizer check",
        createEvidence,
        missingCreateVersionSnapshotCheck,
        restore,
        purge,
      ],
      [
        "create version evidence finalizer check",
        createEvidence,
        missingCreateVersionEvidenceCheck,
        restore,
        purge,
      ],
      [
        "restore snapshot finalizer check",
        createEvidence,
        createVersion,
        missingRestoreSnapshotCheck,
        purge,
      ],
      [
        "restore evidence finalizer check",
        createEvidence,
        createVersion,
        missingRestoreEvidenceCheck,
        purge,
      ],
      [
        "create evidence snapshot resource lock",
        missingCreateEvidenceResourceLock,
        createVersion,
        restore,
        purge,
      ],
      [
        "create version snapshot resource lock",
        createEvidence,
        missingCreateVersionSnapshotLock,
        restore,
        purge,
      ],
      [
        "create version evidence resource lock",
        createEvidence,
        missingCreateVersionEvidenceLock,
        restore,
        purge,
      ],
      [
        "restore snapshot resource lock",
        createEvidence,
        createVersion,
        missingRestoreSnapshotLock,
        purge,
      ],
      [
        "restore evidence resource lock",
        createEvidence,
        createVersion,
        missingRestoreEvidenceLock,
        purge,
      ],
      [
        "purge snapshot resource lock",
        createEvidence,
        createVersion,
        restore,
        missingPurgeSnapshotLock,
      ],
      [
        "purge evidence resource lock",
        createEvidence,
        createVersion,
        restore,
        missingPurgeEvidenceLock,
      ],
      [
        "purge artifact resource lock",
        createEvidence,
        createVersion,
        restore,
        missingPurgeArtifactLock,
      ],
      [
        "missing create evidence version link",
        missingCreateEvidenceLink,
        createVersion,
        restore,
        purge,
      ],
      [
        "create evidence version link after audit",
        movedCreateEvidenceLinkAfterAudit,
        createVersion,
        restore,
        purge,
      ],
      [
        "weakened create evidence version identity",
        weakenedCreateEvidenceVersionIdentity,
        createVersion,
        restore,
        purge,
      ],
      [
        "unrelated purge evidence discovery",
        createEvidence,
        createVersion,
        restore,
        unrelatedPurgeEvidenceIdentity,
      ],
    ] as const) {
      expect(
        evidenceSource !== createEvidence ||
          versionSource !== createVersion ||
          restoreSource !== restore ||
          purgeSource !== purge,
        mutantName,
      ).toBe(true);
      expect(
        hasClosedResourceFinalizerProtocol(
          evidenceSource,
          versionSource,
          restoreSource,
          purgeSource,
        ),
        mutantName,
      ).toBe(false);
    }
  });

  it("rejects removed or weakened binding identity and unique-max cardinality proofs in every independent source", async () => {
    const fixtureInitializer = modeled0003Functions.find(
      (routine) => routine.name === "initialize_operator_context",
    )?.source;
    expect(fixtureInitializer).toBeDefined();

    const productionText = await readFile(migratorSource, "utf8");
    const productionInitializer =
      /"dasher_retention_api[.]initialize_operator_context": `([\s\S]*?\n)`,/u.exec(
        productionText,
      )?.[1];
    expect(productionInitializer).toBeDefined();
    expect(productionInitializer).toBe(fixtureInitializer);

    const harnessText = await readFile(initializerBarrierHarness, "utf8");
    expect(harnessText).toContain(
      "dasher:retention-principal-binding:v1|postgres_session_user|",
    );
    const harnessInitializer =
      /CREATE FUNCTION task8a_retention_barrier[.]initialize[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        harnessText,
      )?.[1];
    expect(harnessInitializer).toBeDefined();

    for (const [sourceName, source] of [
      ["production", productionInitializer ?? ""],
      ["independent fixture", fixtureInitializer ?? ""],
      ["executable harness", harnessInitializer ?? ""],
    ] as const) {
      expect(hasExactBindingCardinalityProof(source), sourceName).toBe(true);
      for (const mutant of weakenBindingCardinalityProofs(source)) {
        expect(mutant, sourceName).not.toBe(source);
        expect(hasExactBindingCardinalityProof(mutant), sourceName).toBe(false);
      }
    }
  });

  it("pins the noncanonical artifact hash helper to a closed execute ACL", async () => {
    const sql = await readFile(initializerBarrierHarness, "utf8");
    expect(hasExactHarnessArtifactHelperExecuteAcl(sql)).toBe(true);

    const droppedPublicRevoke = sql.replace(
      "REVOKE ALL ON FUNCTION\n" +
        "  task8a_retention_barrier.artifact_expected_claim_hash(uuid, uuid, uuid)\n" +
        "  FROM PUBLIC;\n",
      "",
    );
    expect(droppedPublicRevoke).not.toBe(sql);
    expect(hasExactHarnessArtifactHelperExecuteAcl(droppedPublicRevoke)).toBe(
      false,
    );

    const broadenedHelperGrant = sql.replace(
      "  TO task8a_security_harness_definer;\n\n" +
        "CREATE FUNCTION task8a_retention_barrier.artifact_is_governable(",
      "  TO task8a_security_harness_definer, task8a_synthetic_operator_a;\n\n" +
        "CREATE FUNCTION task8a_retention_barrier.artifact_is_governable(",
    );
    expect(broadenedHelperGrant).not.toBe(sql);
    expect(hasExactHarnessArtifactHelperExecuteAcl(broadenedHelperGrant)).toBe(
      false,
    );
  });

  it("binds the initializer ordering contract to an executable same-gate PostgreSQL harness", async () => {
    const sql = await readFile(initializerBarrierHarness, "utf8");
    const initializer =
      /CREATE FUNCTION task8a_retention_barrier[.]initialize[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        sql,
      )?.[1] ?? "";
    const order = [
      "transaction_isolation",
      "task8a.bound_revision",
      "PERFORM 1",
      "pg_advisory_xact_lock",
      "WITH exact_binding AS MATERIALIZED",
      "FROM task8a_retention_barrier.authority_revisions",
      "proof.distinct_principal_count = 1",
      "FROM unique_latest",
      "NOT v_enabled",
      "set_config",
    ].map((fragment) => initializer.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(initializer).not.toMatch(/FOR\s+(?:UPDATE|SHARE)|\bEXECUTE\b/iu);
    expect(initializer).toContain("task8a.binding_phase");
    expect(initializer).toContain("task8a.target_organization_id");
    expect(initializer).toContain("task8a.target_dashboard_id");
    expect(initializer).toContain("v_subject name := session_user");
    expect(initializer).toContain(
      "WHERE authority.binding_subject = session_user",
    );
    expect(harnessContextFollowsUniqueLatestValidation(initializer)).toBe(true);
    expect(
      containsFragmentsInOrder(initializer, [
        "IF NOT FOUND OR NOT v_enabled",
        "'task8a.target_organization_id', p_organization_id::text",
        "'task8a.target_dashboard_id', p_dashboard_id::text",
        "'task8a.binding_phase', 'target_discovery'",
        "FROM task8a_retention_barrier.target_dashboards AS dashboard",
        "WHERE dashboard.organization_id = p_organization_id",
        "AND dashboard.dashboard_id = p_dashboard_id",
        "'dasher:organization:v1|' || v_target_organization_id::text",
        "'task8a.binding_phase', 'authorized'",
        "PERFORM 1\n  FROM task8a_retention_barrier.authority_revisions AS authority",
      ]),
    ).toBe(true);
    expect(sql).toContain(
      "CREATE POLICY target_dashboards_retention_discovery_select",
    );
    expect(sql).toContain(
      "organization_id = pg_catalog.current_setting(\n    'task8a.target_organization_id', true",
    );
    expect(sql).toContain(
      "dashboard_id = pg_catalog.current_setting(\n    'task8a.target_dashboard_id', true",
    );
    const earlyContextMutant = initializer.replace(
      "WITH exact_binding AS MATERIALIZED",
      "PERFORM pg_catalog.set_config('task8a.binding_phase', 'authorized', true);\n  WITH exact_binding AS MATERIALIZED",
    );
    expect(earlyContextMutant).not.toBe(initializer);
    expect(
      harnessContextFollowsUniqueLatestValidation(earlyContextMutant),
    ).toBe(false);
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain(
      "CURRENT_USER = 'task8a_retention_harness_definer'::name",
    );
    expect(sql).toContain("AND binding_subject = SESSION_USER");
    expect(sql).toMatch(
      /CREATE FUNCTION task8a_retention_barrier[.]initialize\(\s*p_organization_id uuid,\s*p_dashboard_id uuid\s*\)[\s\S]*?SECURITY DEFINER/u,
    );
    expect(sql).toMatch(
      /CREATE FUNCTION task8a_retention_barrier[.]revalidate\(\)[\s\S]*?SECURITY DEFINER/u,
    );
    expect(sql).not.toMatch(
      /CREATE FUNCTION task8a_retention_barrier[.](?:initialize|revalidate)\(p_subject/iu,
    );
    const applicationAdmission =
      /CREATE FUNCTION task8a_retention_barrier[.]request_promotion\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        sql,
      )?.[1] ?? "";
    const retentionAction =
      /CREATE FUNCTION task8a_retention_barrier[.]purge_snapshot_batch\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        sql,
      )?.[1] ?? "";
    for (const [name, body] of [
      ["application admission", applicationAdmission],
      ["retention action", retentionAction],
    ] as const) {
      expect(
        containsFragmentsInOrder(body, [
          "FROM task8a_retention_barrier.target_lifecycle_policies AS policy",
          "ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE OF policy;",
          "pg_advisory_xact_lock(p_lock_barrier)",
          "FROM task8a_retention_barrier.target_dashboards AS dashboard",
          "FOR UPDATE OF dashboard;",
        ]),
        name,
      ).toBe(true);
      const reversed = body
        .replace(
          "FROM task8a_retention_barrier.target_lifecycle_policies AS policy",
          "__TASK8A_POLICY__",
        )
        .replace(
          "FROM task8a_retention_barrier.target_dashboards AS dashboard",
          "FROM task8a_retention_barrier.target_lifecycle_policies AS policy",
        )
        .replace(
          "__TASK8A_POLICY__",
          "FROM task8a_retention_barrier.target_dashboards AS dashboard",
        );
      expect(reversed).not.toBe(body);
      expect(
        containsFragmentsInOrder(reversed, [
          "FROM task8a_retention_barrier.target_lifecycle_policies AS policy",
          "FROM task8a_retention_barrier.target_dashboards AS dashboard",
        ]),
        `${name}: reversed mutant`,
      ).toBe(false);
    }
    expect(retentionAction).toContain(
      "PERFORM task8a_retention_barrier.initialize(\n      p_organization_id, p_dashboard_id\n    );",
    );
    expect(sql).not.toContain(
      "PRIMARY KEY (binding_subject, principal_revision)",
    );
    expect(sql).toContain("retention_service_principal_id uuid NOT NULL");
    expect(sql).toContain(
      "CREATE FUNCTION task8a_retention_barrier.append_revision",
    );
    expect(sql).toContain(
      "CREATE FUNCTION task8a_retention_barrier.insert_adversarial_revision",
    );
    expect(sql).toContain(
      "CREATE FUNCTION task8a_retention_barrier.cleanup_subject",
    );
    for (const exactLockContract of [
      [
        "task8a_security_harness_definer",
        "security_lock_target",
        "exercise_security_lock_modes",
      ],
      [
        "task8a_retention_harness_definer",
        "retention_lock_target",
        "exercise_retention_lock_modes",
      ],
    ] as const) {
      const [role, relation, routine] = exactLockContract;
      const updatePolicy =
        relation === "security_lock_target"
          ? "security_lock_target_security_update"
          : "retention_lock_target_retention_update";
      expect(sql).toContain(
        `GRANT SELECT ON task8a_retention_barrier.${relation}`,
      );
      expect(sql).toContain(
        `GRANT UPDATE (organization_id)\n  ON task8a_retention_barrier.${relation}`,
      );
      expect(sql).toContain(`TO ${role};`);
      expect(sql).toContain(
        `ALTER TABLE task8a_retention_barrier.${relation}\n  FORCE ROW LEVEL SECURITY;`,
      );
      const updatePolicyBody =
        new RegExp(
          `CREATE POLICY ${updatePolicy}[\\s\\S]*?FOR UPDATE TO ${role}([\\s\\S]*?);`,
          "u",
        ).exec(sql)?.[1] ?? "";
      expect(updatePolicyBody, updatePolicy).toContain("USING (");
      expect(updatePolicyBody, updatePolicy).toContain("WITH CHECK (");
      expect(updatePolicyBody, updatePolicy).toContain(
        `CURRENT_USER = '${role}'::name`,
      );
      expect(updatePolicyBody, updatePolicy).toContain("organization_id =");
      const body =
        new RegExp(
          `CREATE FUNCTION task8a_retention_barrier[.]${routine}\\(\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`,
          "u",
        ).exec(sql)?.[1] ?? "";
      for (const lockMode of [
        "FOR UPDATE",
        "FOR NO KEY UPDATE",
        "FOR SHARE",
        "FOR KEY SHARE",
      ]) {
        expect(body, `${routine} ${lockMode}`).toContain(lockMode);
      }
      expect(body).toContain(`CURRENT_USER <> '${role}'::name`);
      expect(body.match(/IF NOT FOUND THEN/gu)).toHaveLength(4);
    }
    expect(sql).not.toMatch(
      /GRANT UPDATE ON task8a_retention_barrier[.](?:security|retention)_lock_target/iu,
    );
    for (const [routine, mutation] of [
      [
        "admit_version_reference",
        "INSERT INTO task8a_retention_barrier.snapshot_claims",
      ],
      [
        "admit_evidence_reference",
        "INSERT INTO task8a_retention_barrier.evidence_attachments",
      ],
      [
        "admit_restore_reference",
        "INSERT INTO task8a_retention_barrier.snapshot_claims",
      ],
    ] as const) {
      const body =
        new RegExp(
          `CREATE FUNCTION task8a_retention_barrier[.]${routine}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`,
          "u",
        ).exec(sql)?.[1] ?? "";
      expect(
        containsFragmentsInOrder(body, [
          "FROM task8a_retention_barrier.snapshot_resources AS snapshot",
          "FOR SHARE OF snapshot;",
          "FROM task8a_retention_barrier.snapshot_finalizers AS finalizer",
          mutation,
        ]),
        routine,
      ).toBe(true);
    }
    const createIntent =
      /CREATE FUNCTION task8a_retention_barrier[.]create_snapshot_intent\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        sql,
      )?.[1] ?? "";
    expect(
      containsFragmentsInOrder(createIntent, [
        "FROM task8a_retention_barrier.snapshot_resources AS snapshot",
        "FOR UPDATE OF snapshot;",
        "FROM task8a_retention_barrier.snapshot_finalizers AS finalizer",
        "FOR UPDATE OF finalizer;",
        "FROM task8a_retention_barrier.snapshot_claims AS claim",
        "FOR UPDATE OF claim;",
        "FROM task8a_retention_barrier.evidence_attachments AS evidence",
        "ORDER BY evidence.evidence_id\n  FOR UPDATE OF evidence;",
        "FROM task8a_retention_barrier.evidence_finalizers AS finalizer",
        "ORDER BY finalizer.evidence_id\n  FOR UPDATE OF finalizer;",
        "INSERT INTO task8a_retention_barrier.evidence_finalizers",
        "INSERT INTO task8a_retention_barrier.snapshot_finalizers",
      ]),
    ).toBe(true);
    const finalizeEvidence =
      /CREATE FUNCTION task8a_retention_barrier[.]finalize_evidence\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        sql,
      )?.[1] ?? "";
    expect(
      containsFragmentsInOrder(finalizeEvidence, [
        "UPDATE task8a_retention_barrier.evidence_finalizers AS finalizer",
        "SET state = 'deleted'",
        "SELECT count(*) INTO v_expected_count",
        "DELETE FROM task8a_retention_barrier.evidence_attachments AS evidence",
        "GET DIAGNOSTICS v_deleted_count = ROW_COUNT;",
        "v_deleted_count <> v_expected_count OR EXISTS",
        "MESSAGE = 'task8a_conflict';",
        "RETURN true;",
      ]),
    ).toBe(true);
    const finalizeSnapshot =
      /CREATE FUNCTION task8a_retention_barrier[.]finalize_snapshot\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u.exec(
        sql,
      )?.[1] ?? "";
    expect(
      containsFragmentsInOrder(finalizeSnapshot, [
        "SET state = 'deleted'",
        "FROM task8a_retention_barrier.evidence_attachments AS evidence",
        "evidence.snapshot_id = finalizer.snapshot_id",
        "SELECT count(*) INTO v_expected_count",
        "DELETE FROM task8a_retention_barrier.snapshot_resources AS snapshot",
        "GET DIAGNOSTICS v_deleted_count = ROW_COUNT;",
        "v_deleted_count <> v_expected_count OR EXISTS",
        "MESSAGE = 'task8a_conflict';",
        "RETURN true;",
      ]),
    ).toBe(true);
    const strandedSnapshotMutant = finalizeSnapshot.replace(
      /    AND NOT EXISTS \(\n      SELECT 1\n      FROM task8a_retention_barrier[.]evidence_attachments AS evidence[\s\S]*?    \);\n/u,
      ";\n",
    );
    expect(strandedSnapshotMutant).not.toBe(finalizeSnapshot);
    expect(strandedSnapshotMutant).not.toContain(
      "FROM task8a_retention_barrier.evidence_attachments AS evidence",
    );
    expect(sql).toContain(
      "GRANT UPDATE (organization_id)\n  ON task8a_retention_barrier.snapshot_resources",
    );
    expect(sql).not.toContain(
      "GRANT UPDATE ON task8a_retention_barrier.snapshot_resources",
    );
    for (const exactRlsLockPolicy of [
      "snapshot_resources_security_update",
      "snapshot_resources_retention_update",
      "snapshot_claims_retention_update",
    ]) {
      expect(sql, exactRlsLockPolicy).toContain(
        `CREATE POLICY ${exactRlsLockPolicy}`,
      );
    }
    const missingLockColumnMutant = sql.replace(
      "GRANT UPDATE (organization_id)\n  ON task8a_retention_barrier.retention_lock_target",
      "GRANT SELECT\n  ON task8a_retention_barrier.retention_lock_target",
    );
    expect(missingLockColumnMutant).not.toBe(sql);
    expect(missingLockColumnMutant).not.toContain(
      "GRANT UPDATE (organization_id)\n  ON task8a_retention_barrier.retention_lock_target",
    );
    const missingLockPolicyMutant = sql.replace(
      "CREATE POLICY retention_lock_target_retention_update",
      "CREATE POLICY retention_lock_target_retention_update_removed",
    );
    expect(missingLockPolicyMutant).not.toBe(sql);
    expect(missingLockPolicyMutant).not.toContain(
      "CREATE POLICY retention_lock_target_retention_update\n",
    );
  });

  it("uses only deterministic synthetic bounded fixture material", () => {
    expect(modeled0003SafetyMatrix).toMatchObject({
      canonicalBytesMaximum: 1_048_576,
      canonicalBytesMinimum: 1,
      includesCredentials: false,
      includesNetworkOperations: false,
      includesProductSideEffects: false,
      includesProviders: false,
      sourceKinds: ["synthetic_fixture", "public_usgs_fixture"],
    });
    expect(JSON.stringify(modeled0003CatalogMatrix)).not.toMatch(
      /postgres(?:ql)?:\/\/|PASSWORD\s+'|credential[_-]?(?:secret|token|key)|provider[_-]?key|sk-proj/iu,
    );
    expect(Object.values(modeled0003FixtureIds)).toHaveLength(9);
    expect(new Set(Object.values(modeled0003FixtureIds)).size).toBe(9);
    for (const fixtureId of Object.values(modeled0003FixtureIds)) {
      expect(fixtureId).toMatch(/^[1-9]0000000-0000-4000-8000-000000000001$/u);
    }
  });
});

function lifecycleCorrectionFunctionSource(
  sql: string,
  qualifiedName: string,
): string {
  const escapedName = qualifiedName.replaceAll(".", "[.]");
  const expression = new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION ${escapedName}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`,
    "u",
  );
  return expression.exec(sql)?.[1] ?? "";
}

function migrationPolicyExpression(sql: string, policyName: string): string {
  const expression = new RegExp(
    `^CREATE POLICY ${policyName}\\nON dasher[.][a-z_]+\\nAS PERMISSIVE\\nFOR (?:SELECT|DELETE)\\nTO dasher_retention_definer\\nUSING \\((.+)\\)\\n;$`,
    "mu",
  );
  return expression.exec(sql)?.[1] ?? "";
}

function normalizedSql(source: string): string {
  return source.replace(/\s+/gu, " ").trim();
}

function normalizedIdentitySql(source: string): string {
  return normalizedSql(source).replace(/\(\s+/gu, "(").replace(/\s+\)/gu, ")");
}

function hasExactLifecycleHelperLockProtocol(source: string): boolean {
  const trustedBinding = source.indexOf(
    "SELECT\n    session_row.organization_id,\n    session_row.rotated_from_session_id,\n    session_row.replaced_by_session_id",
  );
  const advisoryLock = source.indexOf("pg_advisory_xact_lock(");
  const membershipLock = source.indexOf(
    "FROM dasher.memberships AS membership\n  WHERE membership.membership_id = v_context_membership_id",
  );
  const sessionLock = source.indexOf(
    "FROM dasher.sessions AS session_row\n  WHERE session_row.organization_id = v_trusted_organization_id",
    membershipLock,
  );
  const databaseTime = source.indexOf("v_now := pg_catalog.clock_timestamp();");
  const postWaitRevalidation = source.indexOf("RETURN EXISTS (", databaseTime);
  return (
    trustedBinding >= 0 &&
    trustedBinding < advisoryLock &&
    advisoryLock < membershipLock &&
    membershipLock < sessionLock &&
    sessionLock < databaseTime &&
    databaseTime < postWaitRevalidation &&
    containsFragmentsInOrder(source.slice(trustedBinding, advisoryLock), [
      "session_row.session_id = v_context_session_id",
      "session_row.organization_id = v_context_organization_id",
      "session_row.user_id = v_context_user_id",
      "session_row.token_key_version = v_context_session_key_version",
      "session_row.token_digest = v_context_session_digest",
      "membership.membership_id = v_context_membership_id",
      "membership.authority_revision = v_context_authority_revision",
      "v_trusted_organization_id IS DISTINCT FROM v_context_organization_id",
    ]) &&
    source.includes("'dasher:task4-organization:v1:'::text") &&
    source.includes("20260730::bigint") &&
    source.slice(membershipLock, sessionLock).includes("FOR UPDATE;") &&
    containsFragmentsInOrder(source.slice(sessionLock, databaseTime), [
      "session_row.session_id = v_context_session_id",
      "session_row.session_id = v_rotated_from_session_id",
      "session_row.session_id = v_replaced_by_session_id",
      "ORDER BY session_row.organization_id, session_row.session_id",
      "FOR UPDATE;",
    ]) &&
    containsFragmentsInOrder(source.slice(postWaitRevalidation), [
      "session_row.session_id = v_context_session_id",
      "session_row.organization_id = v_trusted_organization_id",
      "session_row.user_id = v_context_user_id",
      "session_row.authority_revision = v_context_authority_revision",
      "session_row.token_key_version = v_context_session_key_version",
      "session_row.token_digest = v_context_session_digest",
      "session_row.csrf_key_version = p_current_csrf_key_version",
      "session_row.csrf_digest = p_current_csrf_digest",
      "session_row.replaced_by_session_id IS NULL",
      "session_row.revoked_at IS NULL",
      "v_now < session_row.idle_expires_at",
      "v_now < session_row.absolute_expires_at",
      "membership.membership_id = v_context_membership_id",
      "membership.organization_id = v_trusted_organization_id",
      "membership.user_id = v_context_user_id",
      "membership.state = 'active'",
      "membership.authority_revision = v_context_authority_revision",
    ]) &&
    source.includes("EXCEPTION\n  WHEN OTHERS THEN\n    RETURN false;")
  );
}

function hasExactLifecycleAuditHandler(source: string): boolean {
  const handler = normalizedSql(source.slice(source.indexOf("EXCEPTION")));
  return (
    handler.includes(
      "WHEN unique_violation THEN GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME; IF v_constraint_name IN ( 'audit_events_pkey', 'audit_events_org_id_key' ) THEN RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict'; END IF; RAISE; WHEN foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied'; END",
    ) && !/deadlock|serialization|query_canceled|commit/iu.test(handler)
  );
}

const lifecycleMutationContracts = [
  {
    name: "create_dashboard",
    role: "editor",
    oldArguments: "uuid, text, text, integer, boolean, uuid, uuid, text",
    newArguments:
      "uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text",
    csrf: "$8, $9",
  },
  {
    name: "create_evidence_record",
    role: "editor",
    oldArguments:
      "uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text",
    newArguments:
      "uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, smallint, bytea, text",
    csrf: "$12, $13",
  },
  {
    name: "create_dashboard_version",
    role: "editor",
    oldArguments:
      "uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, text",
    newArguments:
      "uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, smallint, bytea, text",
    csrf: "$16, $17",
  },
  {
    name: "compare_and_swap_dashboard_head",
    role: "editor",
    oldArguments: "uuid, uuid, uuid, bigint, uuid, text",
    newArguments: "uuid, uuid, uuid, bigint, uuid, smallint, bytea, text",
    csrf: "$6, $7",
  },
  {
    name: "request_dashboard_promotion",
    role: "editor",
    oldArguments: "uuid, uuid, bigint, bytea, uuid, text",
    newArguments: "uuid, uuid, bigint, bytea, uuid, smallint, bytea, text",
    csrf: "$6, $7",
  },
  {
    name: "decide_dashboard_promotion",
    role: "admin",
    oldArguments: "uuid, bigint, text, uuid, uuid, text",
    newArguments: "uuid, bigint, text, uuid, uuid, smallint, bytea, text",
    csrf: "$6, $7",
  },
  {
    name: "set_dashboard_archive",
    role: "admin",
    oldArguments: "uuid, boolean, bigint, uuid, text",
    newArguments: "uuid, boolean, bigint, uuid, smallint, bytea, text",
    csrf: "$5, $6",
  },
  {
    name: "delete_dashboard",
    role: "admin",
    oldArguments: "uuid, bigint, uuid, text",
    newArguments: "uuid, bigint, uuid, smallint, bytea, text",
    csrf: "$4, $5",
  },
  {
    name: "restore_dashboard_as_new",
    role: "admin",
    oldArguments:
      "uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text",
    newArguments:
      "uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, smallint, bytea, text",
    csrf: "$10, $11",
  },
] as const;

describe("Task 8B.3 canonical lifecycle-correction source contract", () => {
  it("pins the seven-row chain while leaving the modeled probe at three", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    expect(migrations).toHaveLength(7);
    expect(
      migrations.map((migration) =>
        Buffer.from(migration.checksumSha256).toString("hex"),
      ),
    ).toEqual([
      identityAuditMigration.checksum,
      securityBoundaryMigration.checksum,
      immutableContentMigration.checksum,
      lifecycleApiCorrectionMigration.checksum,
      securityDefinerCleanupCoordinationMigration.checksum,
      lifecycleAccessRetentionGuardCorrectionMigration.checksum,
      phase7Migration.checksum,
    ]);
    expect(Buffer.byteLength(migrations[3]?.sql ?? "")).toBe(104_489);
    expect(modeled0003Functions.length).toBeGreaterThan(0);
    expect(
      modeled0003CatalogMatrix.functions.some(
        (routine) => String(routine.name) === "context_csrf_allows",
      ),
    ).toBe(false);
  });

  it("binds every corrected routine identity to the frozen PostgreSQL body hash", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    const contract = getCanonical0004ExactCatalogContractForTests(
      "migration_owner",
    ) as { readonly functions: readonly string[] };
    const names = [
      "dasher_private.context_csrf_allows",
      "dasher_api.list_dashboards",
      "dasher_api.get_dashboard_summary",
      "dasher_api.get_dashboard_head",
      "dasher_api.get_dashboard_version",
      "dasher_api.get_dashboard_admin_status",
      "dasher_api.get_dashboard_evidence",
      "dasher_api.get_dashboard_lineage",
      ...lifecycleMutationContracts.map(
        (mutation) => `dasher_api.${mutation.name}`,
      ),
    ];
    expect(new Set(names).size).toBe(17);
    for (const name of names) {
      const source = lifecycleCorrectionFunctionSource(sql, name);
      const expectedRows = contract.functions.filter((row) =>
        row.startsWith(`${name}(`),
      );
      expect(expectedRows, name).toHaveLength(1);
      expect(expectedRows[0], name).toMatch(
        new RegExp(`${createHash("md5").update(source).digest("hex")}$`, "u"),
      );
    }
  });

  it("derives trusted organization authority before the canonical lock sequence and fully revalidates after waiting", async () => {
    const sql = (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql;
    const source = lifecycleCorrectionFunctionSource(
      sql ?? "",
      "dasher_private.context_csrf_allows",
    );
    expect(hasExactLifecycleHelperLockProtocol(source)).toBe(true);
    expect(normalizedSql(sql ?? "")).toContain(
      "REVOKE ALL ON FUNCTION dasher_private.context_csrf_allows(smallint, bytea) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;",
    );
    expect(sql).not.toContain(
      "GRANT EXECUTE ON FUNCTION dasher_private.context_csrf_allows",
    );

    const weakened = [
      source.replace(
        "session_row.token_digest = v_context_session_digest",
        "true",
      ),
      source.replace("v_trusted_organization_id IS DISTINCT FROM", "false AND"),
      source.replace("FOR UPDATE;", "FOR SHARE;"),
      source.replace(
        "ORDER BY session_row.organization_id, session_row.session_id",
        "ORDER BY session_row.session_id DESC",
      ),
      source.replace("session_row.csrf_digest = p_current_csrf_digest", "true"),
      source.replace(
        "v_now := pg_catalog.clock_timestamp();",
        "v_now := statement_timestamp();",
      ),
      source.replace(
        "WHEN OTHERS THEN\n    RETURN false;",
        "WHEN OTHERS THEN\n    RAISE;",
      ),
    ];
    for (const mutant of weakened) {
      expect(mutant).not.toBe(source);
      expect(hasExactLifecycleHelperLockProtocol(mutant)).toBe(false);
    }
  });

  it("hard-cuts all nine mutations with helper-first CSRF, retained roles, ACL closure, and exact audit normalization", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    const normalized = normalizedIdentitySql(sql);
    for (const contract of lifecycleMutationContracts) {
      const qualifiedName = `dasher_api.${contract.name}`;
      const source = lifecycleCorrectionFunctionSource(sql, qualifiedName);
      const helperGate = source.indexOf(
        `IF NOT dasher_private.context_csrf_allows(${contract.csrf}) THEN`,
      );
      const roleGate = source.indexOf(
        `IF NOT dasher_private.context_allows(v_organization_id, '${contract.role}')`,
      );
      expect(source, contract.name).not.toBe("");
      expect(helperGate, `${contract.name} helper`).toBeGreaterThanOrEqual(0);
      expect(roleGate, `${contract.name} role`).toBeGreaterThan(helperGate);
      expect(normalized, `${contract.name} predecessor drop`).toContain(
        `DROP FUNCTION ${qualifiedName}(${contract.oldArguments}) RESTRICT;`,
      );
      expect(normalized, `${contract.name} successor identity`).toContain(
        `CREATE FUNCTION ${qualifiedName}(${contract.newArguments})`,
      );
      expect(normalized, `${contract.name} owner`).toContain(
        `ALTER FUNCTION ${qualifiedName}(${contract.newArguments}) OWNER TO dasher_security_definer;`,
      );
      expect(normalized, `${contract.name} revoke`).toContain(
        `REVOKE ALL ON FUNCTION ${qualifiedName}(${contract.newArguments}) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;`,
      );
      expect(normalized, `${contract.name} grant`).toContain(
        `GRANT EXECUTE ON FUNCTION ${qualifiedName}(${contract.newArguments}) TO dasher_app;`,
      );
      expect(source).toContain("v_constraint_name text;");
      expect(hasExactLifecycleAuditHandler(source), contract.name).toBe(true);

      const missingHelper = source.replace(
        `IF NOT dasher_private.context_csrf_allows(${contract.csrf}) THEN`,
        "IF false THEN",
      );
      expect(missingHelper).not.toBe(source);
      expect(missingHelper).not.toContain(
        `IF NOT dasher_private.context_csrf_allows(${contract.csrf}) THEN`,
      );
      const broadenedCollision = source.replace(
        "'audit_events_org_id_key'",
        "'unrelated_unique_key'",
      );
      expect(hasExactLifecycleAuditHandler(broadenedCollision)).toBe(false);
      const swallowedUnknown = source.replace(
        "    RAISE;\n  WHEN foreign_key_violation",
        "    RETURN;\n  WHEN foreign_key_violation",
      );
      expect(hasExactLifecycleAuditHandler(swallowedUnknown)).toBe(false);
    }
    expect(sql.match(/\bDROP FUNCTION dasher_api[.]/gu)).toHaveLength(9);
    expect(sql).not.toContain(" CASCADE");
  });

  it("requires live viewer context on all six non-admin public read projections and admin context on the bounded admin projection", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    for (const name of [
      "list_dashboards",
      "get_dashboard_summary",
      "get_dashboard_head",
      "get_dashboard_version",
      "get_dashboard_evidence",
      "get_dashboard_lineage",
    ]) {
      const source = lifecycleCorrectionFunctionSource(
        sql,
        `dasher_api.${name}`,
      );
      const normalized = normalizedSql(source);
      const gate = normalized.indexOf(
        "IF NOT dasher_private.context_allows( dasher_private.context_organization_id(), 'viewer' ) THEN",
      );
      expect(gate, name).toBeGreaterThanOrEqual(0);
      expect(normalized.indexOf("FROM dasher."), name).toBeGreaterThan(gate);
      expect(
        /context_allows\([^)]*(?:content|title|component|spec)/iu.test(source),
        name,
      ).toBe(false);
      const mutant = source.replace("'viewer'", "'viewer_removed'");
      expect(mutant).not.toBe(source);
      expect(normalizedSql(mutant)).not.toContain(
        "IF NOT dasher_private.context_allows( dasher_private.context_organization_id(), 'viewer' ) THEN",
      );
    }
    const admin = lifecycleCorrectionFunctionSource(
      sql,
      "dasher_api.get_dashboard_admin_status",
    );
    expect(normalizedSql(admin)).toContain(
      "dasher_private.context_allows( dasher_private.context_organization_id(), 'admin' )",
    );
    expect(admin).not.toContain("'viewer'");
  });

  it("uses direct expanded scalar and SETOF projections with exact field order and nonleaking misses", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    for (const name of [
      "get_dashboard_summary",
      "get_dashboard_head",
      "get_dashboard_version",
      "get_dashboard_admin_status",
    ]) {
      const source = lifecycleCorrectionFunctionSource(
        sql,
        `dasher_api.${name}`,
      );
      expect(source, name).not.toContain("SELECT ROW(");
      expect(source, name).toContain("INTO v_result");
      expect(source, name).toContain("IF NOT FOUND THEN");
      expect(source, name).toContain(
        "ERRCODE = 'P1001', MESSAGE = 'dasher_denied'",
      );
    }

    const setReturning = [
      {
        name: "list_dashboards",
        fields:
          "SELECT dashboard_id, title, current_kind, lifecycle_state, lifecycle_revision, effective_expires_at, head_version_id FROM",
      },
      {
        name: "get_dashboard_evidence",
        fields:
          "SELECT link.dashboard_id, link.version_id, evidence.evidence_id, evidence.evidence_kind, evidence.content_sha256, evidence.observed_at, evidence.retrieved_at FROM",
      },
      {
        name: "get_dashboard_lineage",
        fields:
          "SELECT version.dashboard_id, version.version_id, version.parent_version_id, snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id, artifact.ownership_class FROM",
      },
    ] as const;
    for (const contract of setReturning) {
      const source = lifecycleCorrectionFunctionSource(
        sql,
        `dasher_api.${contract.name}`,
      );
      expect(normalizedSql(source), contract.name).toContain(contract.fields);
      const hasDirectProjection = (candidate: string): boolean =>
        !/RETURN QUERY\s+SELECT ROW\(/u.test(candidate);
      expect(hasDirectProjection(source), contract.name).toBe(true);
      if (contract.name !== "list_dashboards") {
        expect(source, contract.name).toContain("IF NOT FOUND THEN");
      }
      const wrapperMutant = source.replace(
        "RETURN QUERY\n    SELECT ",
        "RETURN QUERY\n    SELECT ROW(",
      );
      expect(wrapperMutant).not.toBe(source);
      expect(wrapperMutant).toContain("RETURN QUERY\n    SELECT ROW(");
      expect(hasDirectProjection(wrapperMutant)).toBe(false);
    }
  });

  it("returns exact database-derived creation facts and atomically denies archived evidence writes", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    const creationTypeContract =
      "CREATE TYPE dasher.dashboard_creation_result AS ( dashboard_id uuid, created_at timestamptz, effective_expires_at timestamptz, effective_ttl_seconds integer, used_organization_default boolean, lifecycle_policy_seeded boolean, lifecycle_policy_revision bigint, default_disposable_ttl_seconds integer, retention_policy_revision bigint );";
    expect(normalizedSql(sql)).toContain(creationTypeContract);
    const reorderedType = normalizedSql(sql).replace(
      "dashboard_id uuid, created_at timestamptz",
      "created_at timestamptz, dashboard_id uuid",
    );
    expect(reorderedType).not.toContain(creationTypeContract);
    const create = lifecycleCorrectionFunctionSource(
      sql,
      "dasher_api.create_dashboard",
    );
    expect(create).toContain(
      "GET DIAGNOSTICS v_policy_insert_count = ROW_COUNT;",
    );
    expect(create).toContain("v_policy_insert_count NOT IN (0, 1)");
    expect(create.match(/v_now := clock_timestamp\(\);/gu)).toHaveLength(1);
    expect(create).toContain("v_effective_expires_at, v_effective_expires_at");
    expect(create).toContain("v_policy_insert_count = 1");
    expect(create).toContain("v_policy_row_revision");
    expect(create).toContain("v_default_ttl_seconds");
    expect(create).toContain("v_policy_revision");

    const evidence = lifecycleCorrectionFunctionSource(
      sql,
      "dasher_api.create_evidence_record",
    );
    expect(
      evidence.match(
        /dashboard[.]current_kind = 'durable'[\s\S]{0,100}?dashboard[.]lifecycle_state IN \('draft', 'active'\)/gu,
      ),
    ).toHaveLength(2);
    expect(evidence).not.toMatch(
      /current_kind = 'durable'[\s\S]{0,120}?lifecycle_state IN \([^)]*'archived'/gu,
    );
    const archivedAdmissionMutant = evidence.replace(
      "OR (dashboard.current_kind = 'durable'\n        AND dashboard.lifecycle_state IN ('draft', 'active')",
      "OR (dashboard.current_kind = 'durable'\n        AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')",
    );
    expect(archivedAdmissionMutant).not.toBe(evidence);
    expect(archivedAdmissionMutant).toMatch(
      /current_kind = 'durable'[\s\S]{0,120}?lifecycle_state IN \([^)]*'archived'/gu,
    );
    expect(
      evidence.indexOf("INSERT INTO dasher.evidence_records"),
    ).toBeGreaterThan(evidence.lastIndexOf("v_now := clock_timestamp();"));
  });

  it("binds lineage ownership to exact target access-bearing claims and adds only the two projection SELECT grants", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    const lineage = lifecycleCorrectionFunctionSource(
      sql,
      "dasher_api.get_dashboard_lineage",
    );
    expect(
      lineage.match(/artifact[.]ownership_class = 'dashboard_owned'/gu),
    ).toHaveLength(3);
    expect(
      lineage.match(/artifact[.]ownership_class = 'shared'/gu),
    ).toHaveLength(3);
    expect(
      lineage.match(/relevance_claim[.]claim_kind = 'access_bearing'/gu),
    ).toHaveLength(3);
    expect(lineage.match(/relevance_claim[.]hold_id IS NULL/gu)).toHaveLength(
      3,
    );
    expect(lineage).toContain("artifact_claim.claim_kind = 'access_bearing'");
    expect(lineage).toContain("artifact_claim.hold_id IS NULL");
    expect(lineage).toContain(
      "artifact_claim.organization_id = version.organization_id",
    );
    expect(lineage).toContain(
      "artifact_claim.dashboard_id = version.dashboard_id",
    );
    expect(lineage).toContain("artifact_claim.version_id = version.version_id");
    expect(lineage).not.toContain("claim_kind = 'retention_only'");
    expect(lineage).toContain("artifact.ownership_class");
    const retentionExposureMutant = lineage.replace(
      "relevance_claim.claim_kind = 'access_bearing'",
      "relevance_claim.claim_kind IN ('access_bearing', 'retention_only')",
    );
    expect(retentionExposureMutant).not.toBe(lineage);
    expect(
      retentionExposureMutant.match(
        /relevance_claim[.]claim_kind = 'access_bearing'/gu,
      ),
    ).toHaveLength(2);

    const relationGrants = [
      ...sql.matchAll(
        /GRANT SELECT ON TABLE dasher[.]([a-z_]+)\s+TO dasher_security_definer;/gu,
      ),
    ].map((match) => match[1]);
    expect(relationGrants).toEqual([
      "dashboard_cleanup_coordination",
      "dashboard_legal_holds",
    ]);
    expect(sql.match(/\bGRANT SELECT ON TABLE\b/gu)).toHaveLength(2);
    const expandedGrantMutant = `${sql}\nGRANT SELECT ON TABLE dasher.dashboards TO dasher_security_definer;\n`;
    expect(
      expandedGrantMutant.match(/\bGRANT SELECT ON TABLE\b/gu),
    ).toHaveLength(3);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE) ON TABLE/iu);
  });

  it("contains no out-of-scope migration mechanism or privilege expansion", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "";
    expect(sql).not.toMatch(
      /\bCASCADE\b|\bEXECUTE\s+format\b|\bBEGIN;|\bCOMMIT;/iu,
    );
    expect(sql).not.toMatch(
      /CREATE\s+EXTENSION|CREATE\s+ROLE|ALTER\s+POLICY|CREATE\s+POLICY/iu,
    );
    expect(sql).not.toMatch(
      /hmac|proof_guc|csrf_proof|set_config\([^)]*csrf/iu,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\s+ON\s+TABLE[^;]+TO\s+dasher_app/iu,
    );
    expect(sql).not.toMatch(/GRANT\s+EXECUTE[^;]+dasher_retention_api/iu);
    expect(sql).not.toMatch(/postgres(?:ql)?:\/\/|PASSWORD\s+'|sk-proj/iu);
  });
});

describe("Task 8D canonical 0006 lifecycle and retention correction", () => {
  it("contains exactly two function and four plain policy replacements plus the approved column grant", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const sql = migrations[5]?.sql ?? "";
    const declarations = [
      ...sql.matchAll(
        /^CREATE OR REPLACE FUNCTION ([a-z_]+[.][a-z_]+\([^\n]*\))$/gmu,
      ),
    ].map((match) => match[1]);

    expect(declarations).toEqual([
      "dasher_api.get_dashboard_admin_status(uuid)",
      "dasher_private.enforce_retention_mutation()",
    ]);
    expect(sql.match(/^CREATE OR REPLACE FUNCTION /gmu)).toHaveLength(2);
    expect(sql.match(/\$function\$;/gu)).toHaveLength(2);
    expect(normalizedIdentitySql(sql)).toContain(
      "GRANT UPDATE (head_version_id) ON TABLE dasher.dashboards TO dasher_retention_definer;",
    );
    expect(sql.match(/^GRANT\b/gmu)).toHaveLength(1);
    expect(
      [
        ...sql.matchAll(/^DROP POLICY ([a-z_]+) ON dasher[.]([a-z_]+);$/gmu),
      ].map((match) => `${match[2]}.${match[1]}`),
    ).toEqual([
      "source_snapshots.source_snapshots_retention_select",
      "source_snapshots.source_snapshots_retention_delete",
      "evidence_records.evidence_records_retention_select",
      "evidence_records.evidence_records_retention_delete",
    ]);
    expect(
      [
        ...sql.matchAll(
          /^CREATE POLICY ([a-z_]+)\nON dasher[.]([a-z_]+)\nAS (PERMISSIVE)\nFOR (SELECT|DELETE)\nTO (dasher_retention_definer)\nUSING \((.+)\)\n;$/gmu,
        ),
      ].map((match) => [match[2], match[1], match[4], match[3], match[5]]),
    ).toEqual([
      [
        "source_snapshots",
        "source_snapshots_retention_select",
        "SELECT",
        "PERMISSIVE",
        "dasher_retention_definer",
      ],
      [
        "source_snapshots",
        "source_snapshots_retention_delete",
        "DELETE",
        "PERMISSIVE",
        "dasher_retention_definer",
      ],
      [
        "evidence_records",
        "evidence_records_retention_select",
        "SELECT",
        "PERMISSIVE",
        "dasher_retention_definer",
      ],
      [
        "evidence_records",
        "evidence_records_retention_delete",
        "DELETE",
        "PERMISSIVE",
        "dasher_retention_definer",
      ],
    ]);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS/iu);
    expect(sql).not.toMatch(
      /^\s*(?:ALTER|REVOKE|CREATE\s+(?:TRIGGER|ROLE|SCHEMA|TABLE|TYPE|EXTENSION))\b/imu,
    );
    expect(sql.match(/^DROP\b/gmu)).toHaveLength(4);
    expect(sql.match(/^CREATE POLICY\b/gmu)).toHaveLength(4);
    expect(sql).not.toMatch(
      /GRANT\s+UPDATE\s+ON|GRANT\s+UPDATE\s*\([^)]*(?:,|\b(?!head_version_id\b)[a-z_]+)|\bWITH\s+GRANT\s+OPTION\b/iu,
    );
    expect(sql).not.toMatch(
      /\bEXECUTE\b|\bto_jsonb\b|\bjsonb?\b|\bhstore\b|\bformat\s*\(/iu,
    );
    expect(sql).not.toMatch(/\bSECURITY\s+INVOKER\b/iu);
    expect(sql.match(/\bSECURITY\s+DEFINER\b/gu)).toHaveLength(1);
  });

  it("preserves each phase-3 claim prefix and freezes the stricter post-claim finalizer arm", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const phase3Sql = migrations[2]?.sql ?? "";
    const phase6Sql = migrations[5]?.sql ?? "";
    const policies = [
      {
        domain: "snapshot",
        id: "snapshot_id",
        name: "source_snapshots_retention_select",
        relation: "source_snapshots",
      },
      {
        domain: "snapshot",
        id: "snapshot_id",
        name: "source_snapshots_retention_delete",
        relation: "source_snapshots",
      },
      {
        domain: "evidence",
        id: "evidence_id",
        name: "evidence_records_retention_select",
        relation: "evidence_records",
      },
      {
        domain: "evidence",
        id: "evidence_id",
        name: "evidence_records_retention_delete",
        relation: "evidence_records",
      },
    ] as const;

    for (const policy of policies) {
      const before = migrationPolicyExpression(phase3Sql, policy.name);
      const after = migrationPolicyExpression(phase6Sql, policy.name);
      const finalizerMarker = ` OR EXISTS (SELECT 1 FROM dasher.${policy.domain}_deletion_finalizers AS target_finalizer`;
      const beforeFinalizer = before.indexOf(finalizerMarker);
      const afterFinalizer = after.indexOf(finalizerMarker);
      expect(beforeFinalizer, policy.name).toBeGreaterThan(0);
      expect(afterFinalizer, policy.name).toBe(beforeFinalizer);
      expect(after.slice(0, afterFinalizer), policy.name).toBe(
        before.slice(0, beforeFinalizer),
      );
      const arm = after.slice(afterFinalizer);
      for (const fragment of [
        `target_finalizer.organization_id = ${policy.relation}.organization_id`,
        `target_finalizer.${policy.id} = ${policy.relation}.${policy.id}`,
        "target_cleanup.organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid",
        "target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid",
        "target_cleanup.current_step = 'purge_finalizing'::text",
        "target_cleanup.expected_lifecycle_revision = (current_setting('dasher.retention_expected_lifecycle_revision'::text, true))::bigint",
        "octet_length(target_cleanup.completion_proof_sha256) = 32",
        "target_cleanup.lease_owner IS NULL",
        "target_cleanup.lease_expires_at IS NULL",
        "target_finalizer.state = 'deleted'::text",
        "target_finalizer.proof_sha256 = target_finalizer.expected_claim_set_sha256",
        "target_finalizer.bytes_deleted_at IS NOT NULL",
        "target_finalizer.bytes_deleted_at >= target_finalizer.intent_at",
        `uuid_send(${policy.relation}.organization_id)`,
        "uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)",
        `uuid_send(${policy.relation}.${policy.id})`,
        `convert_to('${policy.domain}|expected_claim_set=empty'::text, 'UTF8'::name)`,
        `NOT EXISTS (SELECT 1 FROM dasher.${policy.domain}_reference_claims AS remaining_claim`,
      ]) {
        expect(arm, `${policy.name}: ${fragment}`).toContain(fragment);
      }
      expect(arm).not.toContain(
        "target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256",
      );
      expect(arm).not.toMatch(
        /target_finalizer[.]state = '(?:intent|eligible)'/u,
      );
    }
    expect(
      migrationPolicyExpression(phase6Sql, "source_snapshots_retention_select"),
    ).toBe(
      migrationPolicyExpression(phase6Sql, "source_snapshots_retention_delete"),
    );
    expect(
      migrationPolicyExpression(phase6Sql, "evidence_records_retention_select"),
    ).toBe(
      migrationPolicyExpression(phase6Sql, "evidence_records_retention_delete"),
    );
  });

  it("adds the exact inclusive-expiry lifecycle predicate to only admin status", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[5]?.sql ?? "";
    const source = lifecycleCorrectionFunctionSource(
      sql,
      "dasher_api.get_dashboard_admin_status",
    );
    const original = lifecycleCorrectionFunctionSource(
      (await discoverMigrations(canonicalMigrationDirectory))[3]?.sql ?? "",
      "dasher_api.get_dashboard_admin_status",
    );
    const normalized = normalizedSql(source);
    const expected = original
      .replace(
        "  v_result dasher.dashboard_admin_projection;\n",
        "  v_result dasher.dashboard_admin_projection;\n  v_now timestamptz := statement_timestamp();\n",
      )
      .replace(
        "    AND dashboard.dashboard_id = $1;",
        "    AND dashboard.dashboard_id = $1\n    AND NOT (\n      dashboard.current_kind = 'disposable'\n      AND dashboard.effective_expires_at IS NOT NULL\n      AND v_now >= dashboard.effective_expires_at\n    );",
      );

    expect(source).not.toBe("");
    expect(source).toBe(expected);
    expect(normalized).toContain("v_now timestamptz := statement_timestamp();");
    expect(normalized).toContain(
      "AND NOT ( dashboard.current_kind = 'disposable' AND dashboard.effective_expires_at IS NOT NULL AND v_now >= dashboard.effective_expires_at )",
    );
    expect(normalized).not.toMatch(
      /dashboard[.]access_revoked_at\s+IS\s+NULL|dashboard[.]purged_at\s+IS\s+NULL|dashboard[.]lifecycle_state\s+(?:=|IN\b)|dashboard[.]current_kind\s*=\s*'durable'/u,
    );
    expect(normalized).toContain(
      "IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';",
    );
  });

  it("dispatches by operation and one exact relation before heterogeneous fields", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[5]?.sql ?? "";
    const source = lifecycleCorrectionFunctionSource(
      sql,
      "dasher_private.enforce_retention_mutation",
    );
    const dispatchTables = [
      ...source.matchAll(/(?:IF|ELSIF) TG_TABLE_NAME = '([^']+)' THEN/gu),
    ].map((match) => match[1]);

    expect(dispatchTables).toEqual([
      "dashboard_legal_holds",
      "dashboard_tombstones",
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_restore_lineage",
      "source_snapshots",
      "evidence_records",
      "dashboard_artifacts",
    ]);
    expect(source).not.toMatch(/TG_TABLE_NAME\s+IN\s*\(/u);
    const updateDispatch = source.indexOf("IF TG_OP = 'UPDATE' THEN");
    const deleteDispatch = source.indexOf("ELSIF TG_OP = 'DELETE' THEN");
    const firstTableDispatch = source.indexOf("IF TG_TABLE_NAME =");
    expect(updateDispatch).toBeGreaterThan(0);
    expect(firstTableDispatch).toBeGreaterThan(updateDispatch);
    expect(deleteDispatch).toBeGreaterThan(firstTableDispatch);

    const exactFieldOwners = {
      tombstone_lineage_id: ["dashboard_tombstones"],
      snapshot_id: ["snapshot_deletion_finalizers", "source_snapshots"],
      evidence_id: ["evidence_deletion_finalizers", "evidence_records"],
      artifact_id: ["artifact_deletion_finalizers", "dashboard_artifacts"],
      case_matter_reference: ["dashboard_legal_holds"],
      ownership_class: ["dashboard_artifacts"],
    } as const;
    for (const [field, owner] of Object.entries(exactFieldOwners)) {
      for (const match of source.matchAll(
        new RegExp(`(?:OLD|NEW)[.]${field}\\b`, "gu"),
      )) {
        const preceding = [
          ...source
            .slice(0, match.index)
            .matchAll(/(?:IF|ELSIF) TG_TABLE_NAME = '([^']+)' THEN/gu),
        ].at(-1)?.[1];
        expect(owner, `${field} at ${String(match.index)}`).toContain(
          preceding,
        );
      }
    }
  });

  it("changes only two functions, fifteen trigger sources, four policy predicates, and one ACL from phase 5", async () => {
    type ExactCatalog = Record<string, readonly string[]>;
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const phase6Sql = migrations[5]?.sql ?? "";
    const catalog5 = getCanonical0005ExactCatalogContractForTests(
      "migration_owner",
    ) as ExactCatalog;
    const catalog6 = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as ExactCatalog;

    for (const category of Object.keys(catalog5).filter(
      (name) =>
        name !== "functions" &&
        name !== "triggers" &&
        name !== "policies" &&
        name !== "acls",
    )) {
      expect(catalog6[category], category).toEqual(catalog5[category]);
    }

    const byKey = (rows: readonly string[], keyParts: number) =>
      new Map(
        rows.map((row) => [row.split("|").slice(0, keyParts).join("|"), row]),
      );
    const policies5 = byKey(catalog5.policies ?? [], 3);
    const policies6 = byKey(catalog6.policies ?? [], 3);
    expect(policies6.size).toBe(policies5.size);
    const changedPolicies = [...policies5.keys()].filter(
      (key) => policies5.get(key) !== policies6.get(key),
    );
    expect(changedPolicies).toEqual([
      "dasher|evidence_records|evidence_records_retention_delete",
      "dasher|evidence_records|evidence_records_retention_select",
      "dasher|source_snapshots|source_snapshots_retention_delete",
      "dasher|source_snapshots|source_snapshots_retention_select",
    ]);
    for (const key of changedPolicies) {
      expect(policies6.get(key)?.split("|").slice(0, 6)).toEqual(
        policies5.get(key)?.split("|").slice(0, 6),
      );
      expect(policies6.get(key)).toContain("|<none>");
      expect(policies6.get(key)).not.toContain(
        "target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256",
      );
    }

    const phase6Acl =
      "column|dasher.dashboards.head_version_id|migration_owner|dasher_retention_definer|UPDATE|false";
    expect(
      catalog5.acls?.filter((acl) => acl.startsWith("column|")),
    ).toHaveLength(258);
    expect(
      catalog6.acls?.filter((acl) => acl.startsWith("column|")),
    ).toHaveLength(259);
    expect(catalog6.acls).toHaveLength((catalog5.acls?.length ?? 0) + 1);
    expect(catalog6.acls).toEqual([...(catalog5.acls ?? []), phase6Acl].sort());
    expect(catalog5.acls).not.toContain(phase6Acl);

    const functions5 = byKey(catalog5.functions ?? [], 1);
    const functions6 = byKey(catalog6.functions ?? [], 1);
    const changedFunctions = [...functions5.keys()].filter(
      (key) => functions5.get(key) !== functions6.get(key),
    );
    expect(changedFunctions).toEqual([
      "dasher_api.get_dashboard_admin_status(uuid)",
      "dasher_private.enforce_retention_mutation()",
    ]);
    expect(functions6.get(changedFunctions[0]!)).toMatch(
      /059c7ab3e72146897a750ff61e115e44$/u,
    );
    expect(functions6.get(changedFunctions[1]!)).toMatch(
      /0ce6dde7b62f41a1149fa7cd4171b95a$/u,
    );
    for (const key of changedFunctions) {
      expect(functions6.get(key)?.split("|").slice(0, -1)).toEqual(
        functions5.get(key)?.split("|").slice(0, -1),
      );
    }

    const triggers5 = byKey(catalog5.triggers ?? [], 3);
    const triggers6 = byKey(catalog6.triggers ?? [], 3);
    const changedTriggers = [...triggers5.keys()].filter(
      (key) => triggers5.get(key) !== triggers6.get(key),
    );
    expect(changedTriggers).toHaveLength(15);
    const oldRetentionSource = lifecycleCorrectionFunctionSource(
      migrations[2]?.sql ?? "",
      "dasher_private.enforce_retention_mutation",
    );
    const newRetentionSource = lifecycleCorrectionFunctionSource(
      phase6Sql,
      "dasher_private.enforce_retention_mutation",
    );
    for (const key of changedTriggers) {
      expect(triggers5.get(key)).toContain(
        "dasher_private.enforce_retention_mutation()",
      );
      expect(
        triggers5.get(key)?.replace(oldRetentionSource, newRetentionSource),
      ).toBe(triggers6.get(key));
    }
  });
});

describe("Task 8B.4 cleanup-coordination corrective migration contract", () => {
  it("contains only the exact five-column grant and tenant-bound insert policy", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[4]?.sql ?? "";
    const normalized = normalizedIdentitySql(sql);

    expect(normalized).toContain(
      "GRANT INSERT (organization_id, dashboard_id, current_step, expected_lifecycle_revision, next_attempt_at) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_security_definer;",
    );
    expect(normalized).toContain(
      "CREATE POLICY dashboard_cleanup_coordination_security_definer_insert ON dasher.dashboard_cleanup_coordination AS PERMISSIVE FOR INSERT TO dasher_security_definer WITH CHECK (CURRENT_USER = 'dasher_security_definer'::name AND organization_id = dasher_private.context_organization_id());",
    );
    expect(sql.match(/\bGRANT\b/gu)).toHaveLength(1);
    expect(sql.match(/\bCREATE POLICY\b/gu)).toHaveLength(1);
    expect(sql).not.toMatch(/\bUSING\s*\(/iu);
    expect(sql).not.toMatch(
      /\bTO\s+(?:dasher_app|PUBLIC|dasher_retention_definer|dasher_retention_operator)\b/iu,
    );
  });

  it("adds exactly five column ACLs and one policy to the exact 0004 catalog", () => {
    type ExactCatalog = Record<string, readonly string[]> & {
      readonly acls: readonly string[];
      readonly policies: readonly string[];
    };
    const catalog0004 = getCanonical0004ExactCatalogContractForTests(
      "migration_owner",
    ) as ExactCatalog;
    const catalog0005 = getCanonical0005ExactCatalogContractForTests(
      "migration_owner",
    ) as ExactCatalog;
    const priorAcls = new Set(catalog0004.acls);
    const priorPolicies = new Set(catalog0004.policies);
    const addedAcls = catalog0005.acls.filter((row) => !priorAcls.has(row));
    const addedPolicies = catalog0005.policies.filter(
      (row) => !priorPolicies.has(row),
    );

    expect(addedAcls).toEqual(
      [
        "organization_id",
        "dashboard_id",
        "current_step",
        "expected_lifecycle_revision",
        "next_attempt_at",
      ]
        .map(
          (column) =>
            `column|dasher.dashboard_cleanup_coordination.${column}|migration_owner|dasher_security_definer|INSERT|false`,
        )
        .sort(),
    );
    expect(addedPolicies).toEqual([
      "dasher|dashboard_cleanup_coordination|dashboard_cleanup_coordination_security_definer_insert|true|a|{dasher_security_definer}|<none>|((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id()))",
    ]);
    expect(catalog0005.acls).not.toContain(
      "relation|dasher.dashboard_cleanup_coordination|migration_owner|dasher_security_definer|INSERT|false",
    );

    for (const category of Object.keys(catalog0004).filter(
      (name) => name !== "acls" && name !== "policies",
    )) {
      expect(catalog0005[category], category).toEqual(catalog0004[category]);
    }
    expect([...addedAcls, ...addedPolicies].join("|")).not.toMatch(
      /dasher_app|PUBLIC|dasher_retention_definer|dasher_retention_operator/u,
    );
  });

  it("introduces no extension, credential, UUID generation, dynamic SQL, or transaction wrapper", async () => {
    const sql =
      (await discoverMigrations(canonicalMigrationDirectory))[4]?.sql ?? "";
    expect(sql).not.toMatch(
      /CREATE\s+EXTENSION|gen_random_uuid|uuid_generate|PASSWORD\s+'|sk-proj|BEGIN\s+(?:RSA|OPENSSH)\s+PRIVATE|postgres(?:ql)?:\/\//iu,
    );
    expect(sql).not.toMatch(
      /\bEXECUTE\b|\bformat\s*\(|\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/iu,
    );
    expect(sql).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION|SECURITY\s+DEFINER/iu,
    );
  });
});

const phase7Migration = {
  sequence: 7,
  filename: "0007_agent_run_ledger_and_calculations.sql",
  checksum: "dfe0ca8eef30b9b5a599657eaf0da6c93a330a90d3fa9b01c75a2f730d8db3d5",
} as const;

function phase7FixedFunctionDefinitions(
  sql: string,
): ReadonlyMap<string, string> {
  return new Map(
    Array.from(
      sql.matchAll(
        /^CREATE (?:OR REPLACE )?FUNCTION ([a-z0-9_]+[.][a-z0-9_]+)\([\s\S]*?^\$function\$;/gmu,
      ),
      (match) => [match[1]!, match[0]] as const,
    ),
  );
}

const phase7ManagedRoles = [
  {
    name: "dasher_run_definer",
    owner: "run-operator functions only",
    comment: "dasher:managed-role:v1:run-definer",
  },
  {
    name: "dasher_run_operator",
    owner: "nothing",
    comment: "dasher:managed-role:v1:run-operator",
  },
] as const;

const phase7ManagedRoleFlags = {
  login: false,
  inherit: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  password: null,
  validUntil: "infinity",
  settings: [],
  memberships: [],
  defaultPrivileges: [],
} as const;

const phase7RelationColumns = {
  agent_run_policy_revisions:
    "policy_revision bigint, previous_policy_revision bigint N, previous_policy_sha256 bytea N, policy_sha256 bytea, enabled boolean, adapter_id text, model_id text, price_book_revision text, input_token_micros bigint, output_token_micros bigint, generation_limit_vector dasher_run_api.attempt_resource_vector, review_limit_vector dasher_run_api.attempt_resource_vector, active_organization_run_limit smallint, active_dashboard_run_limit smallint, approval_required_dashboard_limit smallint, provider_concurrency_limit smallint, tool_attempt_limit smallint, retry_limit smallint, planner_instructions_sha256 bytea, generator_instructions_sha256 bytea, specialist_instructions_sha256 bytea, repair_instructions_sha256 bytea, reviewer_instructions_sha256 bytea, created_at timestamptz",
  run_service_principal_allowlist:
    "run_service_principal_id uuid, principal_revision bigint, session_login name, enabled boolean, capabilities text[], capabilities_sha256 bytea, previous_principal_revision bigint N, previous_principal_sha256 bytea N, principal_sha256 bytea, database_oid oid, database_name name, created_at timestamptz",
  agent_runs:
    "organization_id uuid, dashboard_id uuid, run_id uuid, run_request_id uuid, request_payload_id uuid N, requesting_user_id uuid, requesting_membership_id uuid, requesting_authority_revision bigint, policy_revision bigint, requested_at timestamptz, state text, run_revision bigint, current_event_sequence bigint, current_event_sha256 bytea, lease_epoch bigint, lease_token_sha256 bytea N, lease_owner_principal_id uuid N, lease_owner_principal_revision bigint N, lease_expires_at timestamptz N, latest_checkpoint_revision bigint N, candidate_set_sha256 bytea N, candidate_set_closed_at timestamptz N, terminal_at timestamptz N, terminal_reason_sha256 bytea N, selected_candidate_id uuid N, consumed_replay_sequence bigint N, consumed_replay_sha256 bytea N, terminal_operation_kind text N, terminal_operation_id uuid N, terminal_claim_input_sha256 bytea N, terminal_operation_sha256 bytea N, tenant_cancel_operation_id uuid N, tenant_cancel_operation_sha256 bytea N, tenant_cancel_result_sha256 bytea N, tenant_cancel_result_run_revision bigint N, tenant_cancel_result_event_sequence bigint N, tenant_cancel_result_event_sha256 bytea N",
  agent_run_request_payloads:
    "organization_id uuid, dashboard_id uuid, request_payload_id uuid, run_request_id uuid, request_idempotency_sha256 bytea, content_nonce bytea, canonical_bytes bytea, request_sha256 bytea, created_at timestamptz",
  agent_run_events:
    "organization_id uuid, dashboard_id uuid, run_id uuid, event_sequence bigint, event_id uuid, event_kind text, occurred_at timestamptz, prior_event_sequence bigint N, prior_event_sha256 bytea N, event_payload_id uuid N, event_sha256 bytea, claim_operation_kind text N, claim_request_id uuid N, claim_input_sha256 bytea N, claim_result_sha256 bytea N, claim_result_run_revision bigint N, claim_result_state text N, claim_result_lease_epoch bigint N, claim_result_attempt_token bytea N, claim_result_lease_expires_at timestamptz N, claim_result_policy_revision bigint N, claim_result_input_sha256 bytea N",
  agent_run_event_payloads:
    "organization_id uuid, dashboard_id uuid, run_id uuid, event_payload_id uuid, event_id uuid, event_sequence bigint, content_nonce bytea, canonical_bytes bytea, payload_sha256 bytea, created_at timestamptz",
  agent_run_checkpoints:
    "organization_id uuid, dashboard_id uuid, run_id uuid, checkpoint_revision bigint, source_event_sequence bigint, source_event_sha256 bytea, state_sha256 bytea N, checkpoint_sha256 bytea, checkpoint_payload_id uuid N, created_at timestamptz",
  agent_run_checkpoint_payloads:
    "organization_id uuid, dashboard_id uuid, run_id uuid, checkpoint_payload_id uuid, checkpoint_revision bigint, content_nonce bytea, canonical_bytes bytea, state_sha256 bytea, checkpoint_sha256 bytea, created_at timestamptz",
  agent_run_budget_counters:
    "organization_id uuid, dashboard_id uuid, run_id uuid, partition text, vector_field text, limit_units bigint, reserved_units bigint, used_units bigint, released_units bigint, updated_at timestamptz",
  agent_run_calculation_meters:
    "organization_id uuid, dashboard_id uuid, run_id uuid, meter_id uuid, graph_id uuid, result_id uuid, meter_vector dasher_run_api.calculation_meter_vector_v1, meter_sha256 bytea, created_at timestamptz",
  agent_run_attempts:
    "organization_id uuid, dashboard_id uuid, run_id uuid, attempt_id uuid, lease_epoch bigint, partition text, attempt_kind text, candidate_slot smallint N, retry_of_attempt_id uuid N, state text, request_payload_id uuid N, result_payload_id uuid N, reserved_vector dasher_run_api.attempt_resource_vector, actual_vector dasher_run_api.attempt_resource_vector N, used_vector dasher_run_api.attempt_resource_vector, released_vector dasher_run_api.attempt_resource_vector, outstanding_vector dasher_run_api.attempt_resource_vector, reserved_at timestamptz, dispatch_ready_at timestamptz N, dispatch_started_at timestamptz N, reconciled_at timestamptz N, terminal_reason_sha256 bytea N",
  agent_run_attempt_payloads:
    "organization_id uuid, dashboard_id uuid, run_id uuid, attempt_id uuid, payload_kind text, payload_id uuid, content_nonce bytea, canonical_bytes bytea, payload_sha256 bytea, created_at timestamptz",
  agent_recorded_results:
    "organization_id uuid, dashboard_id uuid, run_id uuid, result_sequence bigint, result_id uuid, attempt_id uuid N, result_payload_id uuid N, replay_source_run_id uuid N, replay_source_result_sequence bigint N, replay_source_result_sha256 bytea N, result_kind text, canonical_bytes bytea, result_sha256 bytea, prior_result_head_sha256 bytea N, result_head_sha256 bytea, created_at timestamptz",
  field_catalog_snapshots:
    "organization_id uuid, dashboard_id uuid, catalog_snapshot_id uuid, input_snapshot_id uuid, input_sha256 bytea, input_row_count bigint, catalog_sha256 bytea, evaluated_at timestamptz, canonical_bytes bytea, created_at timestamptz",
  field_catalog_entries:
    "organization_id uuid, dashboard_id uuid, catalog_snapshot_id uuid, field_id uuid, source_path text, logical_name text, scalar_type text, nullable boolean, semantic_type text, unit text N, currency text N, grain text N, event_time_field_id uuid N, stable_key_ordinal integer N, max_value_bytes bigint, allowed_aggregations text[], allowed_dimensions uuid[], lineage_evidence_ids uuid[], entry_sha256 bytea",
  metric_contract_versions:
    "organization_id uuid, dashboard_id uuid, contract_set_id uuid, contract_set_sha256 bytea, contract_id uuid, contract_version bigint, catalog_snapshot_id uuid, business_owner_membership_id uuid, data_owner_membership_id uuid, name text, definition text, measure_field_id uuid, aggregation text, denominator_contract_id uuid N, denominator_contract_version bigint N, value_type text, unit text N, currency text N, direction text, threshold text N, target text N, grain text, lag_millis bigint, freshness_slo_millis bigint, allowed_dimension_field_ids uuid[], calendar text, timezone text, lineage_evidence_ids uuid[], review_state text, contract_sha256 bytea, created_at timestamptz",
  calculation_graphs:
    "organization_id uuid, dashboard_id uuid, run_id uuid, graph_id uuid, contract_set_id uuid, contract_id uuid, contract_version bigint, catalog_snapshot_id uuid, common_bundle_id uuid, freshness_classifier_node_id uuid N, freshness_input_node_id uuid N, freshness_source_row_id uuid N, graph_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  calculation_results:
    "organization_id uuid, dashboard_id uuid, run_id uuid, result_id uuid, graph_id uuid, result_sha256 bytea, meter_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  briefs:
    "organization_id uuid, dashboard_id uuid, run_id uuid, brief_id uuid, common_bundle_id uuid, brief_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  candidate_comparison_bundles:
    "organization_id uuid, dashboard_id uuid, run_id uuid, bundle_id uuid, source_snapshot_id uuid, evidence_count bigint, bundle_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  candidate_comparison_bundle_evidence:
    "organization_id uuid, dashboard_id uuid, run_id uuid, bundle_id uuid, evidence_id uuid, source_snapshot_id uuid, evidence_sha256 bytea, source_sha256 bytea, freshness text, observed_at timestamptz",
  agent_candidates:
    "organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, brief_id uuid, common_bundle_id uuid, source_result_id uuid, source_result_sha256 bytea, precommit_validation_sha256 bytea, candidate_spec_sha256 bytea, material_claim_count bigint, material_claim_set_sha256 bytea, validation_state text, review_state text, manifest_sha256 bytea N, rank integer N, selected boolean, created_at timestamptz",
  agent_candidate_payloads:
    "organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, canonical_bytes bytea, candidate_spec_sha256 bytea, created_at timestamptz",
  agent_validation_findings:
    "organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, finding_count integer, validation_state text, findings_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  claims:
    "organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, claim_id uuid, json_pointer text, assertion_sha256 bytea, label text, statement text, salience text, evidence_state text, calculation_result_id uuid N, calculation_output_identity_kind text N, calculation_output_node_id uuid N, calculation_output_sha256 bytea N, calculation_output_row_id uuid N, calculation_output_field_id uuid N, calculation_output_value_sha256 bytea N, claim_set_sha256 bytea, claim_sha256 bytea, created_at timestamptz",
  claim_evidence:
    "organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, claim_id uuid, bundle_id uuid, evidence_id uuid, relation text",
  candidate_evidence_manifests:
    "organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, reviewer_result_id uuid, reviewer_result_sha256 bytea, manifest_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  run_abstentions:
    "organization_id uuid, dashboard_id uuid, run_id uuid, abstention_id uuid, abstention_sha256 bytea, canonical_bytes bytea, created_at timestamptz",
  dashboard_agent_drain_proofs:
    "organization_id uuid, dashboard_id uuid, proof_id uuid, lifecycle_revision bigint, cleanup_attempt_id uuid, cleanup_lease_owner text, cleanup_lease_expires_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, pre_drain_run_count bigint, cancelled_run_count bigint, released_attempt_count bigint, charged_attempt_count bigint, remaining_nonterminal_run_count bigint, remaining_claimed_run_count bigint, first_event_run_id uuid N, first_event_sequence bigint N, first_event_sha256 bytea N, last_event_run_id uuid N, last_event_sequence bigint N, last_event_sha256 bytea N, event_count bigint, event_range_sha256 bytea, generated_at timestamptz, drain_request_proof_sha256 bytea, drain_proof_sha256 bytea",
  dashboard_agent_drain_proof_consumptions:
    "organization_id uuid, dashboard_id uuid, proof_id uuid, lifecycle_revision bigint, drain_proof_sha256 bytea, preceding_cleanup_attempt_id uuid, preceding_cleanup_lease_owner text, preceding_cleanup_lease_expires_at timestamptz, new_cleanup_lease_owner text, new_cleanup_lease_expires_at timestamptz, claim_event_and_audit_id uuid, consumed_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, consumption_sha256 bytea",
  dashboard_agent_run_age_out_proofs:
    "organization_id uuid, dashboard_id uuid, age_out_operation_id uuid, lifecycle_revision bigint, source_purge_proof_sha256 bytea, backup_deletion_proof_sha256 bytea, eligible_run_count bigint, deleted_run_count bigint, deleted_event_count bigint, deleted_checkpoint_count bigint, deleted_attempt_count bigint, deleted_counter_count bigint, deleted_drain_proof_consumption_count bigint, deleted_drain_proof_count bigint, retained_chain_head_sha256 bytea, retained_event_count bigint, deleted_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, age_out_proof_sha256 bytea",
} as const;

type Phase7RetentionDisposition =
  | "external_policy_or_principal_history_lifecycle"
  | "held_aware_365_day_metadata_age_out"
  | "immediate_dashboard_content_purge"
  | "separate_immutable_proof_record_lifecycle";

const phase7RelationCatalogRules = {
  owner: "migration_owner",
  columns: {
    nullableMarker: "N",
    unmarkedNullable: false,
    defaults: null,
    identity: false,
    generated: false,
  },
  foreignKeyDefaults: {
    match: "SIMPLE",
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    deferrable: false,
    initially: "IMMEDIATE",
  },
  uniqueNullTreatment: "NULLS DISTINCT",
  indexes: {
    method: "btree",
    unannotatedDirection: "ASC",
    unannotatedNulls: "LAST",
  },
  names: {
    primaryKey: "<relation>_pkey",
    unique: "<relation>_uq_<two-digit appearance order>",
    foreignKey: "<relation>_fk_<two-digit appearance order>",
    check: "<relation>_check_<two-digit appearance order>",
    extraIndex: "<relation>_ix_<two-digit appearance order>",
  },
  rowLevelSecurity: { enabled: true, forced: true },
  sequences: [],
} as const;

const phase7PolicyExpressionTemplates = {
  securityDefiner: {
    role: "dasher_security_definer",
    using: [
      "current_user = 'dasher_security_definer'",
      "full initialized tenant context",
      "context_allows for the exact organization and resource",
      "current dashboard/run lifecycle",
      "exact fixed-function phase",
    ],
    withCheck: [
      "current_user = 'dasher_security_definer'",
      "the same exact organization/resource keys",
      "the exact fixed-function phase",
    ],
  },
  runDefiner: {
    role: "dasher_run_definer",
    using: [
      "current_user = 'dasher_run_definer'",
      "latest enabled database-bound principal revision",
      "required function capability",
      "exact phase, organization, dashboard, run, lease epoch, and attempt-token hash",
      "current lifecycle and unique-maximum request-bound policy",
    ],
    withCheck: [
      "the same exact principal revision, capability, phase, organization, run, lease, lifecycle, and policy values",
    ],
  },
  retentionDefiner: {
    role: "dasher_retention_definer",
    using: [
      "current_user = 'dasher_retention_definer'",
      "exact initialized target organization and dashboard",
      "latest enabled retention principal revision and required capability",
      "expected lifecycle revision and live cleanup lease",
      "legal-hold predicate",
    ],
    withCheck: [
      "the same exact target, principal, capability, lifecycle, cleanup-lease, and hold values",
    ],
  },
  lockOnly: {
    role: "dasher_run_definer",
    using: [
      "current_user = 'dasher_run_definer'",
      "phase = 'locking'",
      "exact proven transaction-local key equality",
    ],
    withCheck: ["false"],
  },
  membershipReauthorizationSelect: {
    name: "memberships_run_reauthorization_select",
    relation: "memberships",
    command: "SELECT",
    roles: ["dasher_run_definer"],
    using: [
      "current_user = 'dasher_run_definer'",
      "phase IN ('locking','authorized','checkpoint_replay')",
      "exact proven transaction-local principal revision",
      "exact transaction-local organization, dashboard, run, requesting membership, requesting user, and requesting authority revision",
    ],
    withCheck: null,
  },
  membershipReauthorizationLock: {
    name: "memberships_run_reauthorization_lock",
    relation: "memberships",
    command: "UPDATE",
    roles: ["dasher_run_definer"],
    using: [
      "current_user = 'dasher_run_definer'",
      "phase = 'locking'",
      "exact proven transaction-local principal revision",
      "exact transaction-local organization, dashboard, run, requesting membership, requesting user, and requesting authority revision",
    ],
    withCheck: ["false"],
  },
  checkpointReplay: {
    name: "agent_run_event_payloads_run_definer_select",
    role: "dasher_run_definer",
    command: "SELECT",
    columns: [
      "organization_id",
      "dashboard_id",
      "run_id",
      "event_payload_id",
      "event_id",
      "event_sequence",
      "content_nonce",
      "canonical_bytes",
      "payload_sha256",
    ],
    using: [
      "current_user = 'dasher_run_definer'",
      "phase = 'checkpoint_replay'",
      "required capability = 'checkpoint'",
      "latest enabled database-bound principal revision",
      "exact transaction-local organization, dashboard, run, lease epoch, attempt-token hash, source event sequence/hash, lifecycle, and policy",
      "same organization/dashboard/run and event_sequence BETWEEN 1 AND source_event_sequence",
    ],
  },
  claimRetry: {
    name: "agent_run_events_run_claim_retry_select",
    role: "dasher_run_definer",
    command: "SELECT",
    using: [
      "current_user = 'dasher_run_definer'",
      "phase = 'claim_retry_discovering'",
      "complete latest database-bound principal proof with capability 'claim'",
      "claim_request_id = transaction-local claim operation UUID",
    ],
    withCheck: null,
    lockMode: "nonlocking",
  },
  runDiscovery: {
    name: "agent_runs_run_discovery_select",
    role: "dasher_run_definer",
    command: "SELECT",
    columns: [
      "organization_id",
      "dashboard_id",
      "run_id",
      "requested_at",
      "state",
      "requesting_membership_id",
      "requesting_user_id",
      "requesting_authority_revision",
    ],
    using: [
      "current_user = 'dasher_run_definer'",
      "phase = 'discovering'",
      "latest enabled database-bound principal revision with capability 'claim'",
      "state IN ('requested','authorized','planning','generating','validating','revising') OR (state = 'failed' AND capability = 'reconcile')",
    ],
  },
  principalBootstrap: {
    name: "run_service_principal_allowlist_bootstrap_select",
    role: "dasher_run_definer",
    command: "SELECT",
    columns: [
      "run_service_principal_id",
      "principal_revision",
      "session_login",
      "enabled",
      "capabilities",
      "capabilities_sha256",
      "previous_principal_revision",
      "previous_principal_sha256",
      "principal_sha256",
      "database_oid",
      "database_name",
    ],
    using: [
      "session_login = SESSION_USER",
      "database_oid = (SELECT oid FROM pg_database WHERE datname = current_database())",
      "database_name = current_database()",
      "session login has exact run-login marker",
    ],
  },
  tenantCancelRunProbe: {
    name: "agent_runs_security_definer_select",
    arm: "cancel_operation_probe",
    role: "dasher_security_definer",
    command: "SELECT",
    columns: [
      "organization_id",
      "dashboard_id",
      "run_id",
      "tenant_cancel_operation_id",
      "tenant_cancel_operation_sha256",
      "tenant_cancel_result_sha256",
      "tenant_cancel_result_run_revision",
      "tenant_cancel_result_event_sequence",
      "tenant_cancel_result_event_sha256",
    ],
    using: [
      "initialized organization",
      "phase = 'cancel_operation_probe'",
      "tenant_cancel_operation_id = exact transaction-local operation UUID",
    ],
    lockMode: "nonlocking",
  },
  tenantCancelAuditProbe: {
    name: "audit_events_security_definer_cancel_operation_select",
    role: "dasher_security_definer",
    command: "SELECT",
    columns: [
      "audit_event_id",
      "organization_id",
      "occurred_at",
      "actor_kind",
      "actor_user_id",
      "actor_service",
      "authority_revision",
      "request_id",
      "job_id",
      "action",
      "target_type",
      "target_id",
      "outcome",
      "content_sha256",
      "source_ref",
      "provider",
      "credential_version",
      "usage_units",
      "cost_minor_units",
      "deployment_revision",
    ],
    using: [
      "current_user = 'dasher_security_definer'",
      "function = 'cancel_agent_run'",
      "phase = 'cancel_operation_probe'",
      "audit_event_id = exact transaction-local operation UUID",
    ],
    lockMode: "nonlocking",
  },
} as const;

const phase7AclAndMutableColumnContract = {
  authorityCodes: {
    A: {
      role: "dasher_security_definer",
      policyStem: "security_definer",
    },
    R: { role: "dasher_run_definer", policyStem: "run_definer" },
    T: {
      role: "dasher_retention_definer",
      policyStem: "retention_definer",
    },
    B: {
      role: "dasher_run_definer",
      policyStem: "bootstrap",
      scope: "all-revision bootstrap SELECT only",
    },
  },
  suffixes: {
    S: "SELECT ALL columns unless the matrix names a narrowed projection",
    I: "INSERT ALL columns",
    U: "UPDATE only the parenthesized exact column set",
    D: "DELETE table privilege",
  },
  policyName:
    "<relation>_<security_definer|run_definer|retention_definer|bootstrap>_<select|insert|update|delete>",
  noCell: "no policy and no grant",
  forbiddenPrivileges: [
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "ownership",
    "grant option",
    "role membership",
    "sequence authority",
  ],
  narrowedSelect: {
    relation: "agent_run_event_payloads",
    role: "dasher_run_definer",
    policy: "agent_run_event_payloads_run_definer_select",
    columns: phase7PolicyExpressionTemplates.checkpointReplay.columns,
    expression: phase7PolicyExpressionTemplates.checkpointReplay.using,
  },
  existingRelationSelectColumns: {
    memberships: [
      "organization_id",
      "membership_id",
      "user_id",
      "role",
      "state",
      "authority_revision",
      "revoked_at",
    ],
    dashboard_lifecycle_policies: ["organization_id", "policy_revision"],
    dashboards: [
      "organization_id",
      "dashboard_id",
      "current_kind",
      "lifecycle_state",
      "lifecycle_revision",
      "effective_expires_at",
      "access_revoked_at",
      "purged_at",
      "head_version_id",
    ],
    dashboard_versions: ["organization_id", "dashboard_id", "version_id"],
    source_snapshots: [
      "organization_id",
      "snapshot_id",
      "source_kind",
      "canonical_bytes",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
    evidence_records: [
      "organization_id",
      "evidence_id",
      "snapshot_id",
      "evidence_kind",
      "coordinates",
      "transformation",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
  },
  existingRelationLockOnlyUpdateColumns: {
    memberships: ["organization_id", "membership_id"],
    dashboard_lifecycle_policies: ["organization_id", "policy_revision"],
    dashboards: ["organization_id", "dashboard_id"],
    dashboard_versions: ["organization_id", "dashboard_id", "version_id"],
    source_snapshots: ["organization_id", "snapshot_id"],
    evidence_records: ["organization_id", "evidence_id"],
  },
  plannedRelationLockOnlyUpdateColumns: {
    run_service_principal_allowlist: [
      "run_service_principal_id",
      "principal_revision",
    ],
    agent_run_policy_revisions: ["policy_revision"],
    agent_runs: ["organization_id", "run_id"],
    candidate_comparison_bundles: [
      "organization_id",
      "dashboard_id",
      "run_id",
      "bundle_id",
    ],
    agent_run_budget_counters: [
      "organization_id",
      "run_id",
      "partition",
      "vector_field",
    ],
    agent_run_attempts: ["organization_id", "run_id", "attempt_id"],
  },
  mutableColumns: {
    agent_runs: [
      "state",
      "run_revision",
      "current_event_sequence",
      "current_event_sha256",
      "lease_epoch",
      "lease_token_sha256",
      "lease_owner_principal_id",
      "lease_owner_principal_revision",
      "lease_expires_at",
      "latest_checkpoint_revision",
      "candidate_set_sha256",
      "candidate_set_closed_at",
      "terminal_at",
      "terminal_reason_sha256",
      "selected_candidate_id",
      "consumed_replay_sequence",
      "consumed_replay_sha256",
      "terminal_operation_kind",
      "terminal_operation_id",
      "terminal_claim_input_sha256",
      "terminal_operation_sha256",
      "tenant_cancel_operation_id",
      "tenant_cancel_operation_sha256",
      "tenant_cancel_result_sha256",
      "tenant_cancel_result_run_revision",
      "tenant_cancel_result_event_sequence",
      "tenant_cancel_result_event_sha256",
    ],
    agent_run_eventsRetentionClear: [
      "event_payload_id",
      "claim_input_sha256",
      "claim_result_sha256",
      "claim_result_attempt_token",
      "claim_result_input_sha256",
    ],
    agent_run_checkpointsRetentionClear: [
      "state_sha256",
      "checkpoint_payload_id",
    ],
    agent_run_budget_counters: [
      "reserved_units",
      "used_units",
      "released_units",
      "updated_at",
    ],
    agent_run_attempts: [
      "state",
      "dispatch_ready_at",
      "dispatch_started_at",
      "actual_vector",
      "used_vector",
      "released_vector",
      "outstanding_vector",
      "reconciled_at",
      "terminal_reason_sha256",
      "result_payload_id",
    ],
    agent_candidates: [
      "validation_state",
      "review_state",
      "manifest_sha256",
      "rank",
      "selected",
    ],
    tenantCancelWriteOnce: [
      "tenant_cancel_operation_id",
      "tenant_cancel_operation_sha256",
      "tenant_cancel_result_sha256",
      "tenant_cancel_result_run_revision",
      "tenant_cancel_result_event_sequence",
      "tenant_cancel_result_event_sha256",
    ],
  },
  invariants: {
    lockOnlyWithCheck: "false",
    nonlockingBundleMembership: "candidate_comparison_bundle_evidence",
    eventRowLockAuthority: false,
    rawAccountingStorage: false,
    defaultPrivileges: [],
    sequences: [],
  },
} as const;

const phase7RelationMatrixCells = [
  {
    ordinal: 1,
    relation: "agent_run_policy_revisions",
    columns:
      "`policy_revision bigint, previous_policy_revision bigint N, previous_policy_sha256 bytea N, policy_sha256 bytea, enabled boolean, adapter_id text, model_id text, price_book_revision text, input_token_micros bigint, output_token_micros bigint, generation_limit_vector dasher_run_api.attempt_resource_vector, review_limit_vector dasher_run_api.attempt_resource_vector, active_organization_run_limit smallint, active_dashboard_run_limit smallint, approval_required_dashboard_limit smallint, provider_concurrency_limit smallint, tool_attempt_limit smallint, retry_limit smallint, planner_instructions_sha256 bytea, generator_instructions_sha256 bytea, specialist_instructions_sha256 bytea, repair_instructions_sha256 bytea, reviewer_instructions_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(policy_revision)`; UQ `(policy_sha256)`; nullable self FK `(previous_policy_revision)` to `(policy_revision)`; revision 1 has both predecessor fields null, `enabled=TRUE`, and the six non-vector limit columns equal `2,1,2,1,0,1` in column order; later rows bind exactly `n-1`/hash by fixed trigger; request/claim use only the unique maximum revision and deny when it is disabled, never falling back",
    extraIndexes: "none",
    rlsGrants: "`A:S,I`; `R:S,U(lock-only policy key)`",
    soleWriters:
      "`request_agent_run` may convergently insert only exact revision 1; later revisions migration-owner provisioning only. The run lock-only UPDATE authority is not a writer; no runtime UPDATE/DELETE exists, and the immutable guard denies actual/no-op mutation.",
  },
  {
    ordinal: 2,
    relation: "run_service_principal_allowlist",
    columns:
      "`run_service_principal_id uuid, principal_revision bigint, session_login name, enabled boolean, capabilities text[], capabilities_sha256 bytea, previous_principal_revision bigint N, previous_principal_sha256 bytea N, principal_sha256 bytea, database_oid oid, database_name name, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(run_service_principal_id,principal_revision)`; UQ `(session_login,database_oid,principal_revision)` and `(principal_sha256)`; nullable self FK `(run_service_principal_id,previous_principal_revision)` to `(run_service_principal_id,principal_revision)` with both predecessor fields null for revision 1 and both nonnull thereafter",
    extraIndexes: "`(session_login,database_oid,principal_revision DESC)`",
    rlsGrants: "`B:S`; `R:S,U(lock-only principal key)`",
    soleWriters:
      "migration-owner/preflight provisioning only; append revisions, never UPDATE/DELETE. The run lock-only UPDATE authority is not a writer, and the immutable guard denies actual/no-op mutation.",
  },
  {
    ordinal: 3,
    relation: "agent_runs",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, run_request_id uuid, request_payload_id uuid N, requesting_user_id uuid, requesting_membership_id uuid, requesting_authority_revision bigint, policy_revision bigint, requested_at timestamptz, state text, run_revision bigint, current_event_sequence bigint, current_event_sha256 bytea, lease_epoch bigint, lease_token_sha256 bytea N, lease_owner_principal_id uuid N, lease_owner_principal_revision bigint N, lease_expires_at timestamptz N, latest_checkpoint_revision bigint N, candidate_set_sha256 bytea N, candidate_set_closed_at timestamptz N, terminal_at timestamptz N, terminal_reason_sha256 bytea N, selected_candidate_id uuid N, consumed_replay_sequence bigint N, consumed_replay_sha256 bytea N, terminal_operation_kind text N, terminal_operation_id uuid N, terminal_claim_input_sha256 bytea N, terminal_operation_sha256 bytea N, tenant_cancel_operation_id uuid N, tenant_cancel_operation_sha256 bytea N, tenant_cancel_result_sha256 bytea N, tenant_cancel_result_run_revision bigint N, tenant_cancel_result_event_sequence bigint N, tenant_cancel_result_event_sha256 bytea N`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id)`; UQ `(organization_id,run_id)` and `(organization_id,run_request_id)`; FKs `dashboard` and `policy` use the global immediate rule; `request_payload` and nullable `selected_candidate` are `DEFERRABLE INITIALLY DEFERRED`. `terminal_operation_kind` is NULL or exactly `abstention|ranking|finish|indeterminate_takeover`; `terminal_claim_input_sha256` is NULL for the first three kinds and is nonnull exactly with the pre-purge `indeterminate_takeover` operation digest. The six `tenant_cancel_*` columns are all NULL or all nonnull; the nonnull form is written exactly once only by tenant `cancel_agent_run`, requires state `cancelled`, positive result revision/sequence, exact 32-byte operation/result/event digests, and an immutable `run_cancelled` event at that sequence/hash. Cleanup cancellation and operator `finish_agent_run(...,'cancelled',...)` leave all six NULL. The transition/retention trigger enforces that terminal operation kind/ID are written once together, only the mixed-takeover branch writes `terminal_claim_input_sha256`, both mixed digests are 32 bytes, and content purge may clear those two mixed digests together but may not clear or change kind/ID. Tenant-cancel fields are write-once and never content-purge-clearable.",
    extraIndexes:
      "`(state,requested_at,run_id)` with exact predicate `state IN ('requested','authorized','planning','generating','validating','revising')`; unique `(organization_id,dashboard_id)` with exact predicate `state IN ('requested','authorized','planning','generating','validating','revising')`; `(organization_id,requesting_membership_id,state)`; unique `(terminal_operation_id)` with exact predicate `terminal_operation_kind = 'indeterminate_takeover'`; unique `(tenant_cancel_operation_id)` with exact predicate `tenant_cancel_operation_id IS NOT NULL`. The fourth index remains the mixed-takeover run-projection uniqueness check; the fifth is the database-global retained tenant-cancel operation identity. Global cross-kind claim-ID uniqueness and retry discovery use `agent_run_events_ix_02` below. A fixed dashboard-locked request/ranking trigger enforces at most two rows in `approval_required`; there is deliberately no uniqueness index on that quiescent state because source plus replay must both reach it.",
    rlsGrants:
      "`A:S,I,U(run/cancel set)`; `R:S,U(run set)`; `T:S,U(retention/run set),D`",
    soleWriters:
      "request/cancel; operator transition functions, with only `claim_agent_run` writing the mixed-takeover operation/input fields; drain/purge/age-out only as matrixed",
  },
  {
    ordinal: 4,
    relation: "agent_run_request_payloads",
    columns:
      "`organization_id uuid, dashboard_id uuid, request_payload_id uuid, run_request_id uuid, request_idempotency_sha256 bytea, content_nonce bytea, canonical_bytes bytea, request_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,request_payload_id)`; UQ `(organization_id,run_request_id)`; FK `dashboard`; the request digest's matrix-wide exact CHECK is explicitly `octet_length(request_idempotency_sha256) = 32`",
    extraIndexes: "none",
    rlsGrants: "`A:S,I`; `R:S`; `T:S,D`",
    soleWriters: "`request_agent_run`",
  },
  {
    ordinal: 5,
    relation: "agent_run_events",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, event_sequence bigint, event_id uuid, event_kind text, occurred_at timestamptz, prior_event_sequence bigint N, prior_event_sha256 bytea N, event_payload_id uuid N, event_sha256 bytea, claim_operation_kind text N, claim_request_id uuid N, claim_input_sha256 bytea N, claim_result_sha256 bytea N, claim_result_run_revision bigint N, claim_result_state text N, claim_result_lease_epoch bigint N, claim_result_attempt_token bytea N, claim_result_lease_expires_at timestamptz N, claim_result_policy_revision bigint N, claim_result_input_sha256 bytea N`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,event_sequence)`; UQ `(organization_id,event_id)`, `(organization_id,dashboard_id,run_id,event_sha256)`, and `(organization_id,dashboard_id,run_id,event_sequence,event_sha256)`; FK `run`; nullable FK `(organization_id,dashboard_id,event_payload_id)` to `agent_run_event_payloads(organization_id,dashboard_id,event_payload_id)` is `DEFERRABLE INITIALLY DEFERRED`. The fixed append/retention trigger requires all eleven claim columns NULL for every event except `lease_acquired|indeterminate_quarantined`; before purge those two events require nonnull operation kind/ID/input/result digests and common result revision/state/epoch/policy. `lease_acquired` requires kind `ordinary_claim` and nonnull 32-byte result token, expiry, and input SHA; `indeterminate_quarantined` requires kind `indeterminate_takeover` and those three fields NULL. All digest/token byte strings are exactly 32 bytes. The operation kind/ID and common result revision/state/epoch/policy are immutable forever; content purge alone transitions a claim event to the exact cleared form by nulling `claim_input_sha256`, `claim_result_sha256`, `claim_result_attempt_token`, and `claim_result_input_sha256` together, never restores them, and may not clear the ID/kind.",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,occurred_at,event_sequence)`; unique `(claim_request_id)` with exact predicate `claim_request_id IS NOT NULL`. The second index is database-global across ordinary and mixed-terminal claim kinds and survives content purge until final metadata age-out.",
    rlsGrants: "`A:S,I`; `R:S,I`; `T:S,I,U(retention/event clear),D`",
    soleWriters:
      "fixed event helper called only by request/cancel/operator/drain bodies",
  },
  {
    ordinal: 6,
    relation: "agent_run_event_payloads",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, event_payload_id uuid, event_id uuid, event_sequence bigint, content_nonce bytea, canonical_bytes bytea, payload_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,event_payload_id)`; UQ `(organization_id,event_id)` and `(organization_id,dashboard_id,run_id,event_sequence)`; FK `run`",
    extraIndexes: "none",
    rlsGrants: "`A:I`; `R:S(checkpoint_event_payload_columns),I`; `T:I,D`",
    soleWriters: "same fixed event helper; no direct function",
  },
  {
    ordinal: 7,
    relation: "agent_run_checkpoints",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, checkpoint_revision bigint, source_event_sequence bigint, source_event_sha256 bytea, state_sha256 bytea N, checkpoint_sha256 bytea, checkpoint_payload_id uuid N, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,checkpoint_revision)`; UQ `(organization_id,dashboard_id,run_id,source_event_sequence,source_event_sha256)`; FKs `run`, `event_with_hash`, and `checkpoint_payload`. The writer/trigger require nonnull `state_sha256` and payload pointer before purge, require both hashes to equal the referenced payload row, and admit only the fixed retention transition that clears `state_sha256` and `checkpoint_payload_id` together while preserving `checkpoint_sha256`.",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,checkpoint_revision DESC)`",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,U(retention/checkpoint clear),D`",
    soleWriters: "`write_agent_run_checkpoint`",
  },
  {
    ordinal: 8,
    relation: "agent_run_checkpoint_payloads",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, checkpoint_payload_id uuid, checkpoint_revision bigint, content_nonce bytea, canonical_bytes bytea, state_sha256 bytea, checkpoint_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,checkpoint_payload_id)`; UQ `(organization_id,dashboard_id,run_id,checkpoint_revision)`; FK `run`; fixed trigger requires `state_sha256` to be the semantic row hash of `canonical_bytes` and `checkpoint_sha256` to be the nonce-bearing retained checkpoint-envelope digest over that state hash",
    extraIndexes: "none",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,D`",
    soleWriters: "`write_agent_run_checkpoint`",
  },
  {
    ordinal: 9,
    relation: "agent_run_budget_counters",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, partition text, vector_field text, limit_units bigint, reserved_units bigint, used_units bigint, released_units bigint, updated_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,partition,vector_field)`; UQ `(organization_id,run_id,partition,vector_field)`; FK `run`; exact partition/field enum and conservation/nonnegative checks",
    extraIndexes: "`(organization_id,dashboard_id,run_id,partition)`",
    rlsGrants:
      "`A:S,I,U(reserved_units,used_units,released_units,updated_at)`; `R:S,U(same)`; `T:S,U(same),D`",
    soleWriters: "request seeds; cancel/operator/drain accounting only",
  },
  {
    ordinal: 10,
    relation: "agent_run_calculation_meters",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, meter_id uuid, graph_id uuid, result_id uuid, meter_vector dasher_run_api.calculation_meter_vector_v1, meter_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,meter_id)`; UQ `(organization_id,dashboard_id,run_id,graph_id)` and `(organization_id,dashboard_id,run_id,result_id)`; FKs `run`, `graph`, and `result`",
    extraIndexes: "`(organization_id,dashboard_id,run_id,created_at,meter_id)`",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_calculation_graph`",
  },
  {
    ordinal: 11,
    relation: "agent_run_attempts",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, attempt_id uuid, lease_epoch bigint, partition text, attempt_kind text, candidate_slot smallint N, retry_of_attempt_id uuid N, state text, request_payload_id uuid N, result_payload_id uuid N, reserved_vector dasher_run_api.attempt_resource_vector, actual_vector dasher_run_api.attempt_resource_vector N, used_vector dasher_run_api.attempt_resource_vector, released_vector dasher_run_api.attempt_resource_vector, outstanding_vector dasher_run_api.attempt_resource_vector, reserved_at timestamptz, dispatch_ready_at timestamptz N, dispatch_started_at timestamptz N, reconciled_at timestamptz N, terminal_reason_sha256 bytea N`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,attempt_id)`; UQ `(organization_id,run_id,attempt_id)`; FKs `run`, `attempt_request_payload`, `attempt_result_payload`, and nullable self FK `(organization_id,dashboard_id,run_id,retry_of_attempt_id)` to the attempt PK, with the two payload FKs `DEFERRABLE INITIALLY DEFERRED`; fixed trigger additionally requires the request pointer to name `payload_kind='request'` and result pointer to name `payload_kind='result'`. `candidate_slot` is nonnull in `1..2` exactly for generator attempts and equals a tagged request field; it is null for every other kind. `retry_of_attempt_id` is nonnull exactly for the one legal immediate planner/generator retry and names that same-kind/same-slot failed predecessor. State is exactly the section 3.4 union. `reserved_pre_dispatch` has all three later timestamps NULL; `dispatch_ready` has ready nonnull and start/reconciled NULL; `dispatch_started` has ready/start nonnull and reconciled NULL. Those three nonterminal states have null actual, zero used/released, and outstanding equal to reserved. Every terminal state has reconciled nonnull and preserves ready/start exactly when those milestones occurred; `dispatch_started_at` nonnull proves invocation authorization. `actual_vector` is nonnull exactly for `succeeded|refused_charged|failed_charged`; it is the typed vector constructed inside reconcile from valid `actual_accounting_bytes`, never the raw bytes themselves. No relation has an `actual_accounting_bytes` column. The fixed trigger enforces kind/outcome/result categorical equalities, componentwise bound, and exact used/released/outstanding equations from section 3.4 using only stored typed vectors. Release states use `used=0,released=reserved,outstanding=0`. Every indeterminate/charged-cancellation state has null actual and zero outstanding; for `candidates` it requires `used=0,released=reserved`, and for each other field it requires `used=reserved,released=0`, all componentwise within signed 64-bit.",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,state,attempt_id)`; unique `(organization_id,dashboard_id,run_id)` with exact predicate `state IN ('dispatch_ready','dispatch_started')`; unique `(organization_id,dashboard_id,run_id,candidate_slot)` with exact predicate `candidate_slot IS NOT NULL AND state IN ('reserved_pre_dispatch','dispatch_ready','dispatch_started')`",
    rlsGrants:
      "`A:S,U(cancel-set)`; `R:S,I,U(attempt-set)`; `T:S,U(cancel/retention-clear set),D`",
    soleWriters:
      "reserve/start/reconcile/release; cancel/drain/takeover; purge clear/age-out",
  },
  {
    ordinal: 12,
    relation: "agent_run_attempt_payloads",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, attempt_id uuid, payload_kind text, payload_id uuid, content_nonce bytea, canonical_bytes bytea, payload_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,attempt_id,payload_kind,payload_id)`; UQ `(organization_id,payload_id)`, `(organization_id,dashboard_id,run_id,attempt_id,payload_id)`, and `(organization_id,dashboard_id,run_id,attempt_id,payload_kind)`; FK `run`; CHECK `payload_kind IN ('request','result')`",
    extraIndexes: "none",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters:
      "reserve inserts request; determinate reconcile inserts result",
  },
  {
    ordinal: 13,
    relation: "agent_recorded_results",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, result_sequence bigint, result_id uuid, attempt_id uuid N, result_payload_id uuid N, replay_source_run_id uuid N, replay_source_result_sequence bigint N, replay_source_result_sha256 bytea N, result_kind text, canonical_bytes bytea, result_sha256 bytea, prior_result_head_sha256 bytea N, result_head_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,result_sequence)`; UQ `(organization_id,dashboard_id,run_id,result_id)`; FK `run`; nullable local-attempt FK `(organization_id,dashboard_id,run_id,attempt_id)` to the attempt PK and local-payload FK `(organization_id,dashboard_id,run_id,attempt_id,result_payload_id)` to the payload UQ; CHECK sequence 1..5 and exactly one origin: local attempt+payload with null replay fields, or all three replay fields with null local fields; replay origin is trigger-verified then copied and deliberately has no retention-extending source FK",
    extraIndexes:
      "unique `(organization_id,dashboard_id,run_id,attempt_id)` with exact predicate `attempt_id IS NOT NULL`; `(organization_id,dashboard_id,run_id,result_sequence,result_head_sha256)`",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,D`",
    soleWriters:
      "determinate reconcile; replay consume creates a new run-local row bound to source",
  },
  {
    ordinal: 14,
    relation: "field_catalog_snapshots",
    columns:
      "`organization_id uuid, dashboard_id uuid, catalog_snapshot_id uuid, input_snapshot_id uuid, input_sha256 bytea, input_row_count bigint, catalog_sha256 bytea, evaluated_at timestamptz, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,catalog_snapshot_id)`; UQ `(organization_id,dashboard_id,catalog_sha256)`; FKs `dashboard` and `(organization_id,input_snapshot_id)` to `dasher.source_snapshots(organization_id,snapshot_id)`",
    extraIndexes: "`(organization_id,input_snapshot_id,evaluated_at DESC)`",
    rlsGrants: "`A:S`; `R:S`; `T:S,D`",
    soleWriters:
      "no production writer; migration-owner synthetic owner harness only",
  },
  {
    ordinal: 15,
    relation: "field_catalog_entries",
    columns:
      "`organization_id uuid, dashboard_id uuid, catalog_snapshot_id uuid, field_id uuid, source_path text, logical_name text, scalar_type text, nullable boolean, semantic_type text, unit text N, currency text N, grain text N, event_time_field_id uuid N, stable_key_ordinal integer N, max_value_bytes bigint, allowed_aggregations text[], allowed_dimensions uuid[], lineage_evidence_ids uuid[], entry_sha256 bytea`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,catalog_snapshot_id,field_id)`; FK `catalog`; nullable self FK `(organization_id,dashboard_id,catalog_snapshot_id,event_time_field_id)` to the PK; every lineage UUID validated by trigger against the same source snapshot/current authority",
    extraIndexes: "`(organization_id,dashboard_id,field_id)`",
    rlsGrants: "`A:S`; `R:S`; `T:S,D`",
    soleWriters:
      "no production writer; migration-owner synthetic owner harness only",
  },
  {
    ordinal: 16,
    relation: "metric_contract_versions",
    columns:
      "`organization_id uuid, dashboard_id uuid, contract_set_id uuid, contract_set_sha256 bytea, contract_id uuid, contract_version bigint, catalog_snapshot_id uuid, business_owner_membership_id uuid, data_owner_membership_id uuid, name text, definition text, measure_field_id uuid, aggregation text, denominator_contract_id uuid N, denominator_contract_version bigint N, value_type text, unit text N, currency text N, direction text, threshold text N, target text N, grain text, lag_millis bigint, freshness_slo_millis bigint, allowed_dimension_field_ids uuid[], calendar text, timezone text, lineage_evidence_ids uuid[], review_state text, contract_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,contract_id,contract_version)`; UQ `(organization_id,dashboard_id,contract_set_id,contract_id,contract_version)` and `(organization_id,dashboard_id,contract_sha256)`; every row in a set has one set hash; FK `catalog`; measure FK `(organization_id,dashboard_id,catalog_snapshot_id,measure_field_id)` to the field-entry PK; nullable denominator FK `(organization_id,dashboard_id,denominator_contract_id,denominator_contract_version)` to the contract PK with both fields null or both nonnull and a trigger requiring the same contract set; business/data owner FKs `(organization_id,business_owner_membership_id)` and `(organization_id,data_owner_membership_id)` to `dasher.memberships(organization_id,membership_id)`; dimension/lineage arrays and every type/unit/currency/direction/threshold/target/grain/lag/SLO/calendar/timezone/owner/review/aggregation cross-field rule use the exact section 5.1 immutable constraint trigger",
    extraIndexes:
      "`(organization_id,dashboard_id,contract_set_id,contract_id,contract_version)` and `(organization_id,dashboard_id,review_state,contract_id,contract_version DESC)`",
    rlsGrants: "`A:S`; `R:S`; `T:S,D`",
    soleWriters:
      "no production writer; migration-owner synthetic owner harness only",
  },
  {
    ordinal: 17,
    relation: "calculation_graphs",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, graph_id uuid, contract_set_id uuid, contract_id uuid, contract_version bigint, catalog_snapshot_id uuid, common_bundle_id uuid, freshness_classifier_node_id uuid N, freshness_input_node_id uuid N, freshness_source_row_id uuid N, graph_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,graph_id)`; UQ `(organization_id,dashboard_id,run_id,graph_sha256)`; FKs `run`, `contract_member`, `catalog`, and `common_bundle`; the three freshness columns are all NULL or all nonnull and are immutable derived projections rather than caller-selected FKs. The fixed INSERT trigger parses the graph/input and requires exact contract output/threshold/target node identities and catalog/dimension/group/aggregation/output/freshness/lineage conformance from section 5.1, including byte-exact rederivation of any nonnull classifier/input/source-row trio",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,contract_id,contract_version)`",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_calculation_graph`",
  },
  {
    ordinal: 18,
    relation: "calculation_results",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, result_id uuid, graph_id uuid, result_sha256 bytea, meter_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,result_id)`; UQ `(organization_id,dashboard_id,run_id,graph_id)` and `(organization_id,dashboard_id,run_id,result_sha256)`; FK `graph`; one fixed `DEFERRABLE INITIALLY DEFERRED` result constraint trigger re-parses graph/result and, after the writer's graph -> result -> meter INSERT order, requires the exact unique meter row plus all result/output/hash/meter conformance from section 5.1",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,created_at,result_id)`",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_calculation_graph`",
  },
  {
    ordinal: 19,
    relation: "briefs",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, brief_id uuid, common_bundle_id uuid, brief_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,brief_id)`; UQ `(organization_id,dashboard_id,run_id)` and `(organization_id,dashboard_id,run_id,brief_sha256)`; FKs `run`, `common_bundle`",
    extraIndexes: "none",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,D`",
    soleWriters:
      "Suggest `commit_agent_brief`; replay `clone_claimed_replay_prerequisites`",
  },
  {
    ordinal: 20,
    relation: "candidate_comparison_bundles",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, bundle_id uuid, source_snapshot_id uuid, evidence_count bigint, bundle_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,bundle_id)`; UQ `(organization_id,dashboard_id,run_id)` and `(organization_id,dashboard_id,run_id,bundle_sha256)`; FKs `run`, `source_snapshot`; `evidence_count` is `1..256`, equals the canonical bundle `entries.length`, and a fixed deferred constraint trigger requires exactly that many child membership rows with the identical entry set before commit. No later child INSERT is admitted once the bundle-commit/clone statement phase ends.",
    extraIndexes: "none",
    rlsGrants:
      "`A:S`; `R:S,I,U(lock-only bundle key)`; `T:S,D`. The run UPDATE grant is exactly `(organization_id,dashboard_id,run_id,bundle_id)` and exists only for the named lock-only policy; the immutable guard rejects actual/no-op UPDATE.",
    soleWriters:
      "Suggest `commit_common_evidence_bundle`; replay `clone_claimed_replay_prerequisites`",
  },
  {
    ordinal: 21,
    relation: "candidate_comparison_bundle_evidence",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, bundle_id uuid, evidence_id uuid, source_snapshot_id uuid, evidence_sha256 bytea, source_sha256 bytea, freshness text, observed_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,bundle_id,evidence_id)`; FK `bundle`; FK `(organization_id,evidence_id)` to `dasher.evidence_records(organization_id,evidence_id)`; FK `(organization_id,source_snapshot_id)` to `dasher.source_snapshots(organization_id,snapshot_id)`; fixed trigger requires the evidence row's snapshot ID and both stored hashes to equal the row-locked source/evidence predecessors. Existing membership rows are immutable nonlocking dependencies under the locked run and bundle header contract in sections 4.4/4.6.",
    extraIndexes: "`(organization_id,evidence_id,bundle_id)`",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,D`",
    soleWriters:
      "Suggest `commit_common_evidence_bundle`; replay `clone_claimed_replay_prerequisites`",
  },
  {
    ordinal: 22,
    relation: "agent_candidates",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, brief_id uuid, common_bundle_id uuid, source_result_id uuid, source_result_sha256 bytea, precommit_validation_sha256 bytea, candidate_spec_sha256 bytea, material_claim_count bigint, material_claim_set_sha256 bytea, validation_state text, review_state text, manifest_sha256 bytea N, rank integer N, selected boolean, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,candidate_id)`; UQ `(organization_id,dashboard_id,run_id,candidate_spec_sha256)`; FKs `run`, `brief`, `common_bundle`, `recorded_result`; material count is `1..64`; rank and selected uniqueness are the partial indexes below",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,validation_state,review_state,candidate_id)`; unique `(organization_id,dashboard_id,run_id,rank)` with exact predicate `rank IS NOT NULL`; unique `(organization_id,dashboard_id,run_id)` with exact predicate `selected IS TRUE`; unique `(organization_id,dashboard_id,run_id,source_result_id)`. The last index makes a valid reconciled candidate-producing result materializable as at most one durable candidate and is independent of categorical accounting.",
    rlsGrants:
      "`A:S`; `R:S,I,U(validation/review/manifest/rank/selected set)`; `T:S,D`",
    soleWriters: "candidate/validation/manifest/ranking functions only",
  },
  {
    ordinal: 23,
    relation: "agent_candidate_payloads",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, canonical_bytes bytea, candidate_spec_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,candidate_id)`; FK `candidate`",
    extraIndexes: "none",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,D`",
    soleWriters: "`commit_agent_candidate`",
  },
  {
    ordinal: 24,
    relation: "agent_validation_findings",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, finding_count integer, validation_state text, findings_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,candidate_id)`; FK `candidate`; fixed trigger validates every calculation/evidence subject ID+hash against the same run graph/result or common-bundle membership before INSERT",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,validation_state,candidate_id)`",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_agent_validation_findings`",
  },
  {
    ordinal: 25,
    relation: "claims",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, claim_id uuid, json_pointer text, assertion_sha256 bytea, label text, statement text, salience text, evidence_state text, calculation_result_id uuid N, calculation_output_identity_kind text N, calculation_output_node_id uuid N, calculation_output_sha256 bytea N, calculation_output_row_id uuid N, calculation_output_field_id uuid N, calculation_output_value_sha256 bytea N, claim_set_sha256 bytea, claim_sha256 bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,candidate_id,claim_id)`; UQ `(organization_id,dashboard_id,run_id,candidate_id,json_pointer)`; FK `candidate` and nullable FK `(organization_id,dashboard_id,run_id,calculation_result_id)` to the calculation-result PK. A non-`calculated` label requires all seven calculation identity columns NULL. A `calculated` label requires a successful exact result plus nonnull identity kind, node, and output digest; `output` requires row/field/value NULL, `scalar_row` requires row/value nonnull and field NULL, and `rowset_cell` requires row/field/value all nonnull. Identity kind is only that three-literal union; both digests are exactly 32 bytes. The sole writer inserts one candidate's complete claim array in one statement; a fixed `AFTER INSERT ... REFERENCING NEW TABLE` statement trigger re-extracts candidate/result bytes and requires claim ID/pointer/assertion hash/allowed label, exact output/value hash and row/cell membership, the server-side subtree mapping below, and complete claim-array equality before the statement returns. A fixed `DEFERRABLE INITIALLY DEFERRED` claim constraint trigger reassembles the final bounded Claims plus zero-or-more `claim_evidence` edges and requires every claim/edge/claim-set hash, including the zero-edge case, before commit",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,candidate_id,salience,evidence_state,claim_id)` and `(organization_id,dashboard_id,run_id,calculation_result_id,calculation_output_node_id,calculation_output_row_id,calculation_output_field_id)` with exact predicate `calculation_result_id IS NOT NULL`",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_candidate_claims`",
  },
  {
    ordinal: 26,
    relation: "claim_evidence",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, claim_id uuid, bundle_id uuid, evidence_id uuid, relation text`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,candidate_id,claim_id,bundle_id,evidence_id,relation)`; FK `(organization_id,dashboard_id,run_id,candidate_id,claim_id)` to the claim PK and FK `(organization_id,dashboard_id,run_id,bundle_id,evidence_id)` to the bundle-evidence PK",
    extraIndexes:
      "`(organization_id,dashboard_id,run_id,candidate_id,relation,evidence_id)`",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_candidate_claims`",
  },
  {
    ordinal: 27,
    relation: "candidate_evidence_manifests",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, reviewer_result_id uuid, reviewer_result_sha256 bytea, manifest_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id,candidate_id)`; UQ `(organization_id,dashboard_id,run_id,manifest_sha256)`; FKs `candidate` and reviewer `recorded_result`; fixed trigger requires the result kind to be `reviewer_verdict_set`, its stored SHA to equal `reviewer_result_sha256`, and its candidate/validation/claim aggregate hashes to equal the current frozen rows",
    extraIndexes: "none",
    rlsGrants: "`A:S`; `R:S,I`; `T:S,D`",
    soleWriters: "`commit_candidate_manifest`",
  },
  {
    ordinal: 28,
    relation: "run_abstentions",
    columns:
      "`organization_id uuid, dashboard_id uuid, run_id uuid, abstention_id uuid, abstention_sha256 bytea, canonical_bytes bytea, created_at timestamptz`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,run_id)`; UQ `(organization_id,abstention_id)` and `(organization_id,dashboard_id,run_id,abstention_sha256)`; FK `run`",
    extraIndexes: "none",
    rlsGrants: "`R:S,I`; `T:S,D`",
    soleWriters: "`commit_run_abstention`",
  },
  {
    ordinal: 29,
    relation: "dashboard_agent_drain_proofs",
    columns:
      "`organization_id uuid, dashboard_id uuid, proof_id uuid, lifecycle_revision bigint, cleanup_attempt_id uuid, cleanup_lease_owner text, cleanup_lease_expires_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, pre_drain_run_count bigint, cancelled_run_count bigint, released_attempt_count bigint, charged_attempt_count bigint, remaining_nonterminal_run_count bigint, remaining_claimed_run_count bigint, first_event_run_id uuid N, first_event_sequence bigint N, first_event_sha256 bytea N, last_event_run_id uuid N, last_event_sequence bigint N, last_event_sha256 bytea N, event_count bigint, event_range_sha256 bytea, generated_at timestamptz, drain_request_proof_sha256 bytea, drain_proof_sha256 bytea`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,proof_id)`; UQ `(organization_id,dashboard_id,proof_id,drain_proof_sha256)`, `(organization_id,dashboard_id,drain_request_proof_sha256)`, and `(organization_id,dashboard_id,drain_proof_sha256)`; `proof_id = cleanup_attempt_id`; all counts are nonnegative and both remaining counts are zero. `charged_attempt_count` counts dispatched indeterminate settlements whose noncandidate fields are charged and candidate field is released; it is a disposition count, not a candidate-used count. `event_count=0` iff all six first/last event boundary fields are NULL, otherwise all are nonnull and the first `(run_id,sequence)` is not after the last; FK `dashboard` only; cleanup attempt/lease/principal values are immutable proof fields without retention-blocking FKs",
    extraIndexes: "`(organization_id,dashboard_id,generated_at DESC,proof_id)`",
    rlsGrants: "`T:S,I,D`",
    soleWriters: "`drain_dashboard_agent_runs`; final age-out deletes",
  },
  {
    ordinal: 30,
    relation: "dashboard_agent_drain_proof_consumptions",
    columns:
      "`organization_id uuid, dashboard_id uuid, proof_id uuid, lifecycle_revision bigint, drain_proof_sha256 bytea, preceding_cleanup_attempt_id uuid, preceding_cleanup_lease_owner text, preceding_cleanup_lease_expires_at timestamptz, new_cleanup_lease_owner text, new_cleanup_lease_expires_at timestamptz, claim_event_and_audit_id uuid, consumed_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, consumption_sha256 bytea`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,proof_id)`; UQ `(organization_id,dashboard_id,claim_event_and_audit_id)` and `(organization_id,dashboard_id,consumption_sha256)`; composite FK `(organization_id,dashboard_id,proof_id,drain_proof_sha256)` to the exact drain-proof UQ, `ON UPDATE RESTRICT ON DELETE RESTRICT NOT DEFERRABLE INITIALLY IMMEDIATE`; the fixed writer requires the preceding attempt/lease fields equal the locked proof and successful attempt and requires `new_cleanup_lease_expires_at > consumed_at`",
    extraIndexes: "`(organization_id,dashboard_id,consumed_at DESC)`",
    rlsGrants: "`T:S,I,D`",
    soleWriters: "replaced `claim_dashboard_cleanup`; final age-out deletes",
  },
  {
    ordinal: 31,
    relation: "dashboard_agent_run_age_out_proofs",
    columns:
      "`organization_id uuid, dashboard_id uuid, age_out_operation_id uuid, lifecycle_revision bigint, source_purge_proof_sha256 bytea, backup_deletion_proof_sha256 bytea, eligible_run_count bigint, deleted_run_count bigint, deleted_event_count bigint, deleted_checkpoint_count bigint, deleted_attempt_count bigint, deleted_counter_count bigint, deleted_drain_proof_consumption_count bigint, deleted_drain_proof_count bigint, retained_chain_head_sha256 bytea, retained_event_count bigint, deleted_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, age_out_proof_sha256 bytea`",
    keysForeignKeysChecks:
      "PK `(organization_id,dashboard_id,age_out_operation_id)`; UQ `(organization_id,dashboard_id,lifecycle_revision)` and `(organization_id,dashboard_id,age_out_proof_sha256)`; deliberately no content/dashboard FK; every count is nonnegative, `eligible_run_count = deleted_run_count`, `retained_event_count = deleted_event_count`, and `source_purge_proof_sha256`, `backup_deletion_proof_sha256`, `age_out_proof_sha256`, and `retained_chain_head_sha256` are exactly 32 bytes. `retained_chain_head_sha256` is always nonnull and is exactly the section 4.5 chain-set digest, including for zero eligible runs; no null or sentinel is admitted.",
    extraIndexes: "`(organization_id,dashboard_id,deleted_at DESC)`",
    rlsGrants: "`T:S,I`; no UPDATE/DELETE",
    soleWriters: "`age_out_dashboard_agent_run_metadata`",
  },
] as const;

const phase7RelationRetentionDisposition = {
  agent_run_policy_revisions: "external_policy_or_principal_history_lifecycle",
  run_service_principal_allowlist:
    "external_policy_or_principal_history_lifecycle",
  agent_runs: "held_aware_365_day_metadata_age_out",
  agent_run_request_payloads: "immediate_dashboard_content_purge",
  agent_run_events: "held_aware_365_day_metadata_age_out",
  agent_run_event_payloads: "immediate_dashboard_content_purge",
  agent_run_checkpoints: "held_aware_365_day_metadata_age_out",
  agent_run_checkpoint_payloads: "immediate_dashboard_content_purge",
  agent_run_budget_counters: "held_aware_365_day_metadata_age_out",
  agent_run_calculation_meters: "immediate_dashboard_content_purge",
  agent_run_attempts: "held_aware_365_day_metadata_age_out",
  agent_run_attempt_payloads: "immediate_dashboard_content_purge",
  agent_recorded_results: "immediate_dashboard_content_purge",
  field_catalog_snapshots: "immediate_dashboard_content_purge",
  field_catalog_entries: "immediate_dashboard_content_purge",
  metric_contract_versions: "immediate_dashboard_content_purge",
  calculation_graphs: "immediate_dashboard_content_purge",
  calculation_results: "immediate_dashboard_content_purge",
  briefs: "immediate_dashboard_content_purge",
  candidate_comparison_bundles: "immediate_dashboard_content_purge",
  candidate_comparison_bundle_evidence: "immediate_dashboard_content_purge",
  agent_candidates: "immediate_dashboard_content_purge",
  agent_candidate_payloads: "immediate_dashboard_content_purge",
  agent_validation_findings: "immediate_dashboard_content_purge",
  claims: "immediate_dashboard_content_purge",
  claim_evidence: "immediate_dashboard_content_purge",
  candidate_evidence_manifests: "immediate_dashboard_content_purge",
  run_abstentions: "immediate_dashboard_content_purge",
  dashboard_agent_drain_proofs: "held_aware_365_day_metadata_age_out",
  dashboard_agent_drain_proof_consumptions:
    "held_aware_365_day_metadata_age_out",
  dashboard_agent_run_age_out_proofs:
    "separate_immutable_proof_record_lifecycle",
} as const satisfies Record<
  keyof typeof phase7RelationColumns,
  Phase7RetentionDisposition
>;

const phase7RelationExtraIndexNames = {
  agent_run_policy_revisions: [],
  run_service_principal_allowlist: ["run_service_principal_allowlist_ix_01"],
  agent_runs: [
    "agent_runs_ix_01",
    "agent_runs_ix_02",
    "agent_runs_ix_03",
    "agent_runs_ix_04",
    "agent_runs_ix_05",
  ],
  agent_run_request_payloads: [],
  agent_run_events: ["agent_run_events_ix_01", "agent_run_events_ix_02"],
  agent_run_event_payloads: [],
  agent_run_checkpoints: ["agent_run_checkpoints_ix_01"],
  agent_run_checkpoint_payloads: [],
  agent_run_budget_counters: ["agent_run_budget_counters_ix_01"],
  agent_run_calculation_meters: ["agent_run_calculation_meters_ix_01"],
  agent_run_attempts: [
    "agent_run_attempts_ix_01",
    "agent_run_attempts_ix_02",
    "agent_run_attempts_ix_03",
  ],
  agent_run_attempt_payloads: [],
  agent_recorded_results: [
    "agent_recorded_results_ix_01",
    "agent_recorded_results_ix_02",
  ],
  field_catalog_snapshots: ["field_catalog_snapshots_ix_01"],
  field_catalog_entries: ["field_catalog_entries_ix_01"],
  metric_contract_versions: [
    "metric_contract_versions_ix_01",
    "metric_contract_versions_ix_02",
  ],
  calculation_graphs: ["calculation_graphs_ix_01"],
  calculation_results: ["calculation_results_ix_01"],
  briefs: [],
  candidate_comparison_bundles: [],
  candidate_comparison_bundle_evidence: [
    "candidate_comparison_bundle_evidence_ix_01",
  ],
  agent_candidates: [
    "agent_candidates_ix_01",
    "agent_candidates_ix_02",
    "agent_candidates_ix_03",
    "agent_candidates_ix_04",
  ],
  agent_candidate_payloads: [],
  agent_validation_findings: ["agent_validation_findings_ix_01"],
  claims: ["claims_ix_01", "claims_ix_02"],
  claim_evidence: ["claim_evidence_ix_01"],
  candidate_evidence_manifests: [],
  run_abstentions: [],
  dashboard_agent_drain_proofs: ["dashboard_agent_drain_proofs_ix_01"],
  dashboard_agent_drain_proof_consumptions: [
    "dashboard_agent_drain_proof_consumptions_ix_01",
  ],
  dashboard_agent_run_age_out_proofs: [
    "dashboard_agent_run_age_out_proofs_ix_01",
  ],
} as const satisfies Record<
  keyof typeof phase7RelationColumns,
  readonly string[]
>;

type Phase7ForeignKeyOptions = {
  nullable?: boolean;
  deferred?: boolean;
};

function phase7ForeignKey(
  name: string,
  columns: readonly string[],
  referencedRelation: string,
  referencedColumns: readonly string[],
  options: Phase7ForeignKeyOptions = {},
) {
  return {
    name,
    columns,
    referencedRelation,
    referencedColumns,
    match: "SIMPLE",
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    deferrable: options.deferred ?? false,
    initially: options.deferred ? "DEFERRED" : "IMMEDIATE",
    nullable: options.nullable ?? false,
  } as const;
}

function phase7PrimaryKey(relation: string, columns: readonly string[]) {
  return { name: `${relation}_pkey`, method: "btree", columns } as const;
}

function phase7Unique(
  relation: string,
  ordinal: number,
  columns: readonly string[],
) {
  return {
    name: `${relation}_uq_${String(ordinal).padStart(2, "0")}`,
    method: "btree",
    columns,
    nullTreatment: "NULLS DISTINCT",
  } as const;
}

const phase7RelationKeyCatalog = {
  agent_run_policy_revisions: {
    primaryKey: phase7PrimaryKey("agent_run_policy_revisions", [
      "policy_revision",
    ]),
    uniques: [phase7Unique("agent_run_policy_revisions", 1, ["policy_sha256"])],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_policy_revisions_fk_01",
        ["previous_policy_revision"],
        "agent_run_policy_revisions",
        ["policy_revision"],
        { nullable: true },
      ),
    ],
  },
  run_service_principal_allowlist: {
    primaryKey: phase7PrimaryKey("run_service_principal_allowlist", [
      "run_service_principal_id",
      "principal_revision",
    ]),
    uniques: [
      phase7Unique("run_service_principal_allowlist", 1, [
        "session_login",
        "database_oid",
        "principal_revision",
      ]),
      phase7Unique("run_service_principal_allowlist", 2, ["principal_sha256"]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "run_service_principal_allowlist_fk_01",
        ["run_service_principal_id", "previous_principal_revision"],
        "run_service_principal_allowlist",
        ["run_service_principal_id", "principal_revision"],
        { nullable: true },
      ),
    ],
  },
  agent_runs: {
    primaryKey: phase7PrimaryKey("agent_runs", [
      "organization_id",
      "dashboard_id",
      "run_id",
    ]),
    uniques: [
      phase7Unique("agent_runs", 1, ["organization_id", "run_id"]),
      phase7Unique("agent_runs", 2, ["organization_id", "run_request_id"]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_runs_fk_01",
        ["organization_id", "dashboard_id"],
        "dasher.dashboards",
        ["organization_id", "dashboard_id"],
      ),
      phase7ForeignKey(
        "agent_runs_fk_02",
        ["policy_revision"],
        "agent_run_policy_revisions",
        ["policy_revision"],
      ),
      phase7ForeignKey(
        "agent_runs_fk_03",
        ["organization_id", "dashboard_id", "request_payload_id"],
        "agent_run_request_payloads",
        ["organization_id", "dashboard_id", "request_payload_id"],
        { nullable: true, deferred: true },
      ),
      phase7ForeignKey(
        "agent_runs_fk_04",
        ["organization_id", "dashboard_id", "run_id", "selected_candidate_id"],
        "agent_candidates",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
        { nullable: true, deferred: true },
      ),
    ],
  },
  agent_run_request_payloads: {
    primaryKey: phase7PrimaryKey("agent_run_request_payloads", [
      "organization_id",
      "dashboard_id",
      "request_payload_id",
    ]),
    uniques: [
      phase7Unique("agent_run_request_payloads", 1, [
        "organization_id",
        "run_request_id",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_request_payloads_fk_01",
        ["organization_id", "dashboard_id"],
        "dasher.dashboards",
        ["organization_id", "dashboard_id"],
      ),
    ],
  },
  agent_run_events: {
    primaryKey: phase7PrimaryKey("agent_run_events", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "event_sequence",
    ]),
    uniques: [
      phase7Unique("agent_run_events", 1, ["organization_id", "event_id"]),
      phase7Unique("agent_run_events", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "event_sha256",
      ]),
      phase7Unique("agent_run_events", 3, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "event_sequence",
        "event_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_events_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "agent_run_events_fk_02",
        ["organization_id", "dashboard_id", "event_payload_id"],
        "agent_run_event_payloads",
        ["organization_id", "dashboard_id", "event_payload_id"],
        { nullable: true, deferred: true },
      ),
    ],
  },
  agent_run_event_payloads: {
    primaryKey: phase7PrimaryKey("agent_run_event_payloads", [
      "organization_id",
      "dashboard_id",
      "event_payload_id",
    ]),
    uniques: [
      phase7Unique("agent_run_event_payloads", 1, [
        "organization_id",
        "event_id",
      ]),
      phase7Unique("agent_run_event_payloads", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "event_sequence",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_event_payloads_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
    ],
  },
  agent_run_checkpoints: {
    primaryKey: phase7PrimaryKey("agent_run_checkpoints", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "checkpoint_revision",
    ]),
    uniques: [
      phase7Unique("agent_run_checkpoints", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "source_event_sequence",
        "source_event_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_checkpoints_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "agent_run_checkpoints_fk_02",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "source_event_sequence",
          "source_event_sha256",
        ],
        "agent_run_events",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "event_sequence",
          "event_sha256",
        ],
      ),
      phase7ForeignKey(
        "agent_run_checkpoints_fk_03",
        ["organization_id", "dashboard_id", "checkpoint_payload_id"],
        "agent_run_checkpoint_payloads",
        ["organization_id", "dashboard_id", "checkpoint_payload_id"],
        { nullable: true },
      ),
    ],
  },
  agent_run_checkpoint_payloads: {
    primaryKey: phase7PrimaryKey("agent_run_checkpoint_payloads", [
      "organization_id",
      "dashboard_id",
      "checkpoint_payload_id",
    ]),
    uniques: [
      phase7Unique("agent_run_checkpoint_payloads", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "checkpoint_revision",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_checkpoint_payloads_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
    ],
  },
  agent_run_budget_counters: {
    primaryKey: phase7PrimaryKey("agent_run_budget_counters", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "partition",
      "vector_field",
    ]),
    uniques: [
      phase7Unique("agent_run_budget_counters", 1, [
        "organization_id",
        "run_id",
        "partition",
        "vector_field",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_budget_counters_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
    ],
  },
  agent_run_calculation_meters: {
    primaryKey: phase7PrimaryKey("agent_run_calculation_meters", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "meter_id",
    ]),
    uniques: [
      phase7Unique("agent_run_calculation_meters", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "graph_id",
      ]),
      phase7Unique("agent_run_calculation_meters", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "result_id",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_calculation_meters_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "agent_run_calculation_meters_fk_02",
        ["organization_id", "dashboard_id", "run_id", "graph_id"],
        "calculation_graphs",
        ["organization_id", "dashboard_id", "run_id", "graph_id"],
      ),
      phase7ForeignKey(
        "agent_run_calculation_meters_fk_03",
        ["organization_id", "dashboard_id", "run_id", "result_id"],
        "calculation_results",
        ["organization_id", "dashboard_id", "run_id", "result_id"],
      ),
    ],
  },
  agent_run_attempts: {
    primaryKey: phase7PrimaryKey("agent_run_attempts", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "attempt_id",
    ]),
    uniques: [
      phase7Unique("agent_run_attempts", 1, [
        "organization_id",
        "run_id",
        "attempt_id",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_attempts_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "agent_run_attempts_fk_02",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "attempt_id",
          "request_payload_id",
        ],
        "agent_run_attempt_payloads",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "attempt_id",
          "payload_id",
        ],
        { nullable: true, deferred: true },
      ),
      phase7ForeignKey(
        "agent_run_attempts_fk_03",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "attempt_id",
          "result_payload_id",
        ],
        "agent_run_attempt_payloads",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "attempt_id",
          "payload_id",
        ],
        { nullable: true, deferred: true },
      ),
      phase7ForeignKey(
        "agent_run_attempts_fk_04",
        ["organization_id", "dashboard_id", "run_id", "retry_of_attempt_id"],
        "agent_run_attempts",
        ["organization_id", "dashboard_id", "run_id", "attempt_id"],
        { nullable: true },
      ),
    ],
  },
  agent_run_attempt_payloads: {
    primaryKey: phase7PrimaryKey("agent_run_attempt_payloads", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "attempt_id",
      "payload_kind",
      "payload_id",
    ]),
    uniques: [
      phase7Unique("agent_run_attempt_payloads", 1, [
        "organization_id",
        "payload_id",
      ]),
      phase7Unique("agent_run_attempt_payloads", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "attempt_id",
        "payload_id",
      ]),
      phase7Unique("agent_run_attempt_payloads", 3, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "attempt_id",
        "payload_kind",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_run_attempt_payloads_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
    ],
  },
  agent_recorded_results: {
    primaryKey: phase7PrimaryKey("agent_recorded_results", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "result_sequence",
    ]),
    uniques: [
      phase7Unique("agent_recorded_results", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "result_id",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_recorded_results_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "agent_recorded_results_fk_02",
        ["organization_id", "dashboard_id", "run_id", "attempt_id"],
        "agent_run_attempts",
        ["organization_id", "dashboard_id", "run_id", "attempt_id"],
        { nullable: true },
      ),
      phase7ForeignKey(
        "agent_recorded_results_fk_03",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "attempt_id",
          "result_payload_id",
        ],
        "agent_run_attempt_payloads",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "attempt_id",
          "payload_id",
        ],
        { nullable: true },
      ),
    ],
  },
  field_catalog_snapshots: {
    primaryKey: phase7PrimaryKey("field_catalog_snapshots", [
      "organization_id",
      "dashboard_id",
      "catalog_snapshot_id",
    ]),
    uniques: [
      phase7Unique("field_catalog_snapshots", 1, [
        "organization_id",
        "dashboard_id",
        "catalog_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "field_catalog_snapshots_fk_01",
        ["organization_id", "dashboard_id"],
        "dasher.dashboards",
        ["organization_id", "dashboard_id"],
      ),
      phase7ForeignKey(
        "field_catalog_snapshots_fk_02",
        ["organization_id", "input_snapshot_id"],
        "dasher.source_snapshots",
        ["organization_id", "snapshot_id"],
      ),
    ],
  },
  field_catalog_entries: {
    primaryKey: phase7PrimaryKey("field_catalog_entries", [
      "organization_id",
      "dashboard_id",
      "catalog_snapshot_id",
      "field_id",
    ]),
    uniques: [],
    foreignKeys: [
      phase7ForeignKey(
        "field_catalog_entries_fk_01",
        ["organization_id", "dashboard_id", "catalog_snapshot_id"],
        "field_catalog_snapshots",
        ["organization_id", "dashboard_id", "catalog_snapshot_id"],
      ),
      phase7ForeignKey(
        "field_catalog_entries_fk_02",
        [
          "organization_id",
          "dashboard_id",
          "catalog_snapshot_id",
          "event_time_field_id",
        ],
        "field_catalog_entries",
        ["organization_id", "dashboard_id", "catalog_snapshot_id", "field_id"],
        { nullable: true },
      ),
    ],
  },
  metric_contract_versions: {
    primaryKey: phase7PrimaryKey("metric_contract_versions", [
      "organization_id",
      "dashboard_id",
      "contract_id",
      "contract_version",
    ]),
    uniques: [
      phase7Unique("metric_contract_versions", 1, [
        "organization_id",
        "dashboard_id",
        "contract_set_id",
        "contract_id",
        "contract_version",
      ]),
      phase7Unique("metric_contract_versions", 2, [
        "organization_id",
        "dashboard_id",
        "contract_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "metric_contract_versions_fk_01",
        ["organization_id", "dashboard_id", "catalog_snapshot_id"],
        "field_catalog_snapshots",
        ["organization_id", "dashboard_id", "catalog_snapshot_id"],
      ),
      phase7ForeignKey(
        "metric_contract_versions_fk_02",
        [
          "organization_id",
          "dashboard_id",
          "catalog_snapshot_id",
          "measure_field_id",
        ],
        "field_catalog_entries",
        ["organization_id", "dashboard_id", "catalog_snapshot_id", "field_id"],
      ),
      phase7ForeignKey(
        "metric_contract_versions_fk_03",
        [
          "organization_id",
          "dashboard_id",
          "denominator_contract_id",
          "denominator_contract_version",
        ],
        "metric_contract_versions",
        ["organization_id", "dashboard_id", "contract_id", "contract_version"],
        { nullable: true },
      ),
      phase7ForeignKey(
        "metric_contract_versions_fk_04",
        ["organization_id", "business_owner_membership_id"],
        "dasher.memberships",
        ["organization_id", "membership_id"],
      ),
      phase7ForeignKey(
        "metric_contract_versions_fk_05",
        ["organization_id", "data_owner_membership_id"],
        "dasher.memberships",
        ["organization_id", "membership_id"],
      ),
    ],
  },
  calculation_graphs: {
    primaryKey: phase7PrimaryKey("calculation_graphs", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "graph_id",
    ]),
    uniques: [
      phase7Unique("calculation_graphs", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "graph_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "calculation_graphs_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "calculation_graphs_fk_02",
        [
          "organization_id",
          "dashboard_id",
          "contract_set_id",
          "contract_id",
          "contract_version",
        ],
        "metric_contract_versions",
        [
          "organization_id",
          "dashboard_id",
          "contract_set_id",
          "contract_id",
          "contract_version",
        ],
      ),
      phase7ForeignKey(
        "calculation_graphs_fk_03",
        ["organization_id", "dashboard_id", "catalog_snapshot_id"],
        "field_catalog_snapshots",
        ["organization_id", "dashboard_id", "catalog_snapshot_id"],
      ),
      phase7ForeignKey(
        "calculation_graphs_fk_04",
        ["organization_id", "dashboard_id", "run_id", "common_bundle_id"],
        "candidate_comparison_bundles",
        ["organization_id", "dashboard_id", "run_id", "bundle_id"],
      ),
    ],
  },
  calculation_results: {
    primaryKey: phase7PrimaryKey("calculation_results", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "result_id",
    ]),
    uniques: [
      phase7Unique("calculation_results", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "graph_id",
      ]),
      phase7Unique("calculation_results", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "result_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "calculation_results_fk_01",
        ["organization_id", "dashboard_id", "run_id", "graph_id"],
        "calculation_graphs",
        ["organization_id", "dashboard_id", "run_id", "graph_id"],
      ),
    ],
  },
  briefs: {
    primaryKey: phase7PrimaryKey("briefs", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "brief_id",
    ]),
    uniques: [
      phase7Unique("briefs", 1, ["organization_id", "dashboard_id", "run_id"]),
      phase7Unique("briefs", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "brief_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "briefs_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "briefs_fk_02",
        ["organization_id", "dashboard_id", "run_id", "common_bundle_id"],
        "candidate_comparison_bundles",
        ["organization_id", "dashboard_id", "run_id", "bundle_id"],
      ),
    ],
  },
  candidate_comparison_bundles: {
    primaryKey: phase7PrimaryKey("candidate_comparison_bundles", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "bundle_id",
    ]),
    uniques: [
      phase7Unique("candidate_comparison_bundles", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
      ]),
      phase7Unique("candidate_comparison_bundles", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "bundle_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "candidate_comparison_bundles_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "candidate_comparison_bundles_fk_02",
        ["organization_id", "source_snapshot_id"],
        "dasher.source_snapshots",
        ["organization_id", "snapshot_id"],
      ),
    ],
  },
  candidate_comparison_bundle_evidence: {
    primaryKey: phase7PrimaryKey("candidate_comparison_bundle_evidence", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "bundle_id",
      "evidence_id",
    ]),
    uniques: [],
    foreignKeys: [
      phase7ForeignKey(
        "candidate_comparison_bundle_evidence_fk_01",
        ["organization_id", "dashboard_id", "run_id", "bundle_id"],
        "candidate_comparison_bundles",
        ["organization_id", "dashboard_id", "run_id", "bundle_id"],
      ),
      phase7ForeignKey(
        "candidate_comparison_bundle_evidence_fk_02",
        ["organization_id", "evidence_id"],
        "dasher.evidence_records",
        ["organization_id", "evidence_id"],
      ),
      phase7ForeignKey(
        "candidate_comparison_bundle_evidence_fk_03",
        ["organization_id", "source_snapshot_id"],
        "dasher.source_snapshots",
        ["organization_id", "snapshot_id"],
      ),
    ],
  },
  agent_candidates: {
    primaryKey: phase7PrimaryKey("agent_candidates", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "candidate_id",
    ]),
    uniques: [
      phase7Unique("agent_candidates", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "candidate_spec_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "agent_candidates_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
      phase7ForeignKey(
        "agent_candidates_fk_02",
        ["organization_id", "dashboard_id", "run_id", "brief_id"],
        "briefs",
        ["organization_id", "dashboard_id", "run_id", "brief_id"],
      ),
      phase7ForeignKey(
        "agent_candidates_fk_03",
        ["organization_id", "dashboard_id", "run_id", "common_bundle_id"],
        "candidate_comparison_bundles",
        ["organization_id", "dashboard_id", "run_id", "bundle_id"],
      ),
      phase7ForeignKey(
        "agent_candidates_fk_04",
        ["organization_id", "dashboard_id", "run_id", "source_result_id"],
        "agent_recorded_results",
        ["organization_id", "dashboard_id", "run_id", "result_id"],
      ),
    ],
  },
  agent_candidate_payloads: {
    primaryKey: phase7PrimaryKey("agent_candidate_payloads", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "candidate_id",
    ]),
    uniques: [],
    foreignKeys: [
      phase7ForeignKey(
        "agent_candidate_payloads_fk_01",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
        "agent_candidates",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
      ),
    ],
  },
  agent_validation_findings: {
    primaryKey: phase7PrimaryKey("agent_validation_findings", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "candidate_id",
    ]),
    uniques: [],
    foreignKeys: [
      phase7ForeignKey(
        "agent_validation_findings_fk_01",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
        "agent_candidates",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
      ),
    ],
  },
  claims: {
    primaryKey: phase7PrimaryKey("claims", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "candidate_id",
      "claim_id",
    ]),
    uniques: [
      phase7Unique("claims", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "candidate_id",
        "json_pointer",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "claims_fk_01",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
        "agent_candidates",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
      ),
      phase7ForeignKey(
        "claims_fk_02",
        ["organization_id", "dashboard_id", "run_id", "calculation_result_id"],
        "calculation_results",
        ["organization_id", "dashboard_id", "run_id", "result_id"],
        { nullable: true },
      ),
    ],
  },
  claim_evidence: {
    primaryKey: phase7PrimaryKey("claim_evidence", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "candidate_id",
      "claim_id",
      "bundle_id",
      "evidence_id",
      "relation",
    ]),
    uniques: [],
    foreignKeys: [
      phase7ForeignKey(
        "claim_evidence_fk_01",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "candidate_id",
          "claim_id",
        ],
        "claims",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "candidate_id",
          "claim_id",
        ],
      ),
      phase7ForeignKey(
        "claim_evidence_fk_02",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "bundle_id",
          "evidence_id",
        ],
        "candidate_comparison_bundle_evidence",
        [
          "organization_id",
          "dashboard_id",
          "run_id",
          "bundle_id",
          "evidence_id",
        ],
      ),
    ],
  },
  candidate_evidence_manifests: {
    primaryKey: phase7PrimaryKey("candidate_evidence_manifests", [
      "organization_id",
      "dashboard_id",
      "run_id",
      "candidate_id",
    ]),
    uniques: [
      phase7Unique("candidate_evidence_manifests", 1, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "manifest_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "candidate_evidence_manifests_fk_01",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
        "agent_candidates",
        ["organization_id", "dashboard_id", "run_id", "candidate_id"],
      ),
      phase7ForeignKey(
        "candidate_evidence_manifests_fk_02",
        ["organization_id", "dashboard_id", "run_id", "reviewer_result_id"],
        "agent_recorded_results",
        ["organization_id", "dashboard_id", "run_id", "result_id"],
      ),
    ],
  },
  run_abstentions: {
    primaryKey: phase7PrimaryKey("run_abstentions", [
      "organization_id",
      "dashboard_id",
      "run_id",
    ]),
    uniques: [
      phase7Unique("run_abstentions", 1, ["organization_id", "abstention_id"]),
      phase7Unique("run_abstentions", 2, [
        "organization_id",
        "dashboard_id",
        "run_id",
        "abstention_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "run_abstentions_fk_01",
        ["organization_id", "dashboard_id", "run_id"],
        "agent_runs",
        ["organization_id", "dashboard_id", "run_id"],
      ),
    ],
  },
  dashboard_agent_drain_proofs: {
    primaryKey: phase7PrimaryKey("dashboard_agent_drain_proofs", [
      "organization_id",
      "dashboard_id",
      "proof_id",
    ]),
    uniques: [
      phase7Unique("dashboard_agent_drain_proofs", 1, [
        "organization_id",
        "dashboard_id",
        "proof_id",
        "drain_proof_sha256",
      ]),
      phase7Unique("dashboard_agent_drain_proofs", 2, [
        "organization_id",
        "dashboard_id",
        "drain_request_proof_sha256",
      ]),
      phase7Unique("dashboard_agent_drain_proofs", 3, [
        "organization_id",
        "dashboard_id",
        "drain_proof_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "dashboard_agent_drain_proofs_fk_01",
        ["organization_id", "dashboard_id"],
        "dasher.dashboards",
        ["organization_id", "dashboard_id"],
      ),
    ],
  },
  dashboard_agent_drain_proof_consumptions: {
    primaryKey: phase7PrimaryKey("dashboard_agent_drain_proof_consumptions", [
      "organization_id",
      "dashboard_id",
      "proof_id",
    ]),
    uniques: [
      phase7Unique("dashboard_agent_drain_proof_consumptions", 1, [
        "organization_id",
        "dashboard_id",
        "claim_event_and_audit_id",
      ]),
      phase7Unique("dashboard_agent_drain_proof_consumptions", 2, [
        "organization_id",
        "dashboard_id",
        "consumption_sha256",
      ]),
    ],
    foreignKeys: [
      phase7ForeignKey(
        "dashboard_agent_drain_proof_consumptions_fk_01",
        ["organization_id", "dashboard_id", "proof_id", "drain_proof_sha256"],
        "dashboard_agent_drain_proofs",
        ["organization_id", "dashboard_id", "proof_id", "drain_proof_sha256"],
      ),
    ],
  },
  dashboard_agent_run_age_out_proofs: {
    primaryKey: phase7PrimaryKey("dashboard_agent_run_age_out_proofs", [
      "organization_id",
      "dashboard_id",
      "age_out_operation_id",
    ]),
    uniques: [
      phase7Unique("dashboard_agent_run_age_out_proofs", 1, [
        "organization_id",
        "dashboard_id",
        "lifecycle_revision",
      ]),
      phase7Unique("dashboard_agent_run_age_out_proofs", 2, [
        "organization_id",
        "dashboard_id",
        "age_out_proof_sha256",
      ]),
    ],
    foreignKeys: [],
  },
} as const satisfies Record<
  keyof typeof phase7RelationColumns,
  {
    primaryKey: { name: string; columns: readonly string[] };
    uniques: readonly { name: string; columns: readonly string[] }[];
    foreignKeys: readonly {
      name: string;
      columns: readonly string[];
      referencedRelation: string;
      referencedColumns: readonly string[];
      match: string;
      onUpdate: string;
      onDelete: string;
      deferrable: boolean;
      initially: string;
      nullable: boolean;
    }[];
  }
>;

const phase7AttemptResourceVectorFields = [
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
] as const;

const phase7ActualAccountingTemplate =
  '{"cache_read_tokens":"<i64:D>","cache_write_tokens":"<i64:D>","calls":"<i64:D>","candidates":"<i64:D>","cost_micros":"<i64:D>","input_tokens":"<i64:D>","output_tokens":"<i64:D>","reasoning_tokens":"<i64:D>","repair_attempts":"<i64:D>","reviewer_attempts":"<i64:D>","schema":"attempt-actual-accounting-v1","specialist_attempts":"<i64:D>","total_tokens":"<i64:D>","wall_millis":"<i64:D>","work_millis":"<i64:D>"}';

const phase7AccountingByteVectors = {
  signedMinimum: {
    replacement: "i64:-9223372036854775808",
    bytes: 648,
    sha256: "45e80d882166095e09c6dcf0e9e340b8689cc0dcfbfc4f8cabeea96135779b2f",
  },
  signedMaximum: {
    replacement: "i64:9223372036854775807",
    bytes: 634,
    sha256: "b6e45d51e9c8b555bcbdf910d7e82ec88f8c8e568e02dccd5be8f9dce527af08",
  },
  planner: {
    values: [100, 50, 1, 0, 400, 100, 50, 50, 0, 0, 0, 150, 100, 90],
    bytes: 396,
    sha256: "c7f516af474a1da3617dbdcef20ffa9191872ff2f23154670500f819083b95ef",
  },
  transportCapInclusive: 1024,
  parserSqlstates: ["22021", "22P02", "22003"],
} as const;

const phase7TenantFunctionSignatures = [
  "dasher_api.request_agent_run(uuid, uuid, uuid, text, bigint, bytea, bytea, uuid, smallint, bytea, text, uuid)",
  "dasher_api.cancel_agent_run(uuid, bigint, bytea, uuid, smallint, bytea, text)",
  "dasher_api.get_agent_run(uuid)",
  "dasher_api.list_agent_run_events(uuid, bigint, integer)",
  "dasher_api.get_agent_run_checkpoint(uuid)",
  "dasher_api.get_agent_candidate(uuid, uuid)",
] as const;

const phase7OperatorFunctionSignatures = [
  "dasher_run_api.claim_agent_run(uuid, integer)",
  "dasher_run_api.get_claimed_agent_run_input(uuid, bigint, bytea)",
  "dasher_run_api.clone_claimed_replay_prerequisites(uuid, bigint, bytea)",
  "dasher_run_api.list_claimed_replay_results(uuid, bigint, bytea, bigint, integer)",
  "dasher_run_api.consume_agent_replay_result(uuid, bigint, bytea, bigint, bytea)",
  "dasher_run_api.write_agent_run_checkpoint(uuid, bigint, bytea, bigint, bytea, bytea)",
  "dasher_run_api.commit_agent_brief(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.commit_common_evidence_bundle(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.reserve_agent_run_attempt(uuid, bigint, bytea, uuid, text, text, dasher_run_api.attempt_resource_vector, bytea)",
  "dasher_run_api.start_agent_run_attempt(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.authorize_agent_run_attempt_invocation(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.reconcile_agent_run_attempt(uuid, bigint, bytea, uuid, text, bytea, bytea, bytea)",
  "dasher_run_api.release_agent_run_attempt(uuid, bigint, bytea, uuid, text, bytea)",
  "dasher_run_api.commit_calculation_graph(uuid, bigint, bytea, uuid, bytea, bytea, dasher_run_api.calculation_meter_vector_v1, bytea)",
  "dasher_run_api.commit_agent_validation_findings(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.commit_agent_candidate(uuid, bigint, bytea, uuid, bytea, bytea, uuid, bytea, bytea)",
  "dasher_run_api.close_agent_candidate_set(uuid, bigint, bytea, bytea)",
  "dasher_run_api.commit_candidate_claims(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.commit_candidate_manifest(uuid, bigint, bytea, uuid, bytea, bytea)",
  "dasher_run_api.commit_run_abstention(uuid, bigint, bytea, uuid, bytea)",
  "dasher_run_api.finalize_agent_run_ranking(uuid, bigint, bytea, uuid, uuid, bytea)",
  "dasher_run_api.finish_agent_run(uuid, bigint, bytea, uuid, text, bytea)",
] as const;

const phase7RetentionFunctionSignatures = [
  "dasher_retention_api.claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid)",
  "dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid)",
  "dasher_retention_api.drain_dashboard_agent_runs(uuid, bigint, bytea, uuid, text, uuid)",
  "dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid)",
  "dasher_retention_api.age_out_dashboard_agent_run_metadata(uuid, bigint, bytea, uuid, text, uuid)",
] as const;

const phase7CompositeTypes = {
  "dasher_api.agent_run_request_result":
    "run_id uuid, run_revision bigint, state text, policy_revision bigint, request_sha256 bytea",
  "dasher_api.agent_run_mutation_result":
    "run_id uuid, run_revision bigint, state text, event_sequence bigint, event_sha256 bytea",
  "dasher_api.agent_run_summary":
    "run_id uuid, dashboard_id uuid, state text, run_revision bigint, policy_revision bigint, requested_at timestamptz, terminal_at timestamptz, latest_event_sequence bigint, latest_checkpoint_revision bigint, selected_candidate_id uuid",
  "dasher_api.agent_run_event_summary":
    "run_id uuid, event_sequence bigint, event_kind text, occurred_at timestamptz, event_sha256 bytea, payload_available boolean",
  "dasher_api.agent_run_checkpoint_result":
    "found boolean, run_id uuid, checkpoint_revision bigint, source_event_sequence bigint, source_event_sha256 bytea, state_sha256 bytea, checkpoint_sha256 bytea, canonical_checkpoint_bytes bytea",
  "dasher_api.agent_candidate_result":
    "found boolean, run_id uuid, candidate_id uuid, run_state text, candidate_sha256 bytea, common_bundle_sha256 bytea, manifest_sha256 bytea, rank integer, selected boolean, canonical_candidate_bytes bytea, canonical_manifest_bytes bytea",
  "dasher_run_api.run_mutation_result":
    "run_id uuid, run_revision bigint, state text, event_sequence bigint, event_sha256 bytea, lease_epoch bigint",
  "dasher_run_api.agent_run_claim_result":
    "status text, organization_id uuid, dashboard_id uuid, run_id uuid, run_revision bigint, state text, lease_epoch bigint, attempt_token bytea, lease_expires_at timestamptz, policy_revision bigint, input_sha256 bytea",
  "dasher_run_api.claimed_run_input_result":
    "run_id uuid, purpose text, evaluation_time timestamptz, policy_revision bigint, input_snapshot_id uuid, input_sha256 bytea, input_row_count bigint, field_catalog_snapshot_id uuid, metric_contract_set_id uuid, metric_contract_set_sha256 bytea, generation_limit_vector dasher_run_api.attempt_resource_vector, review_limit_vector dasher_run_api.attempt_resource_vector, replay_source_run_id uuid, replay_source_result_count integer, replay_source_head_sequence bigint, replay_source_head_sha256 bytea, replay_source_candidate_set_sha256 bytea, replay_source_bundle_id uuid, replay_source_bundle_sha256 bytea, replay_source_brief_id uuid, replay_source_brief_sha256 bytea, replay_source_selected_candidate_id uuid, canonical_input_bytes bytea, canonical_request_bytes bytea",
  "dasher_run_api.replay_prerequisite_result":
    "mutation dasher_run_api.run_mutation_result, source_run_id uuid, bundle_id uuid, bundle_sha256 bytea, brief_id uuid, brief_sha256 bytea",
  "dasher_run_api.replay_source_result":
    "source_run_id uuid, source_result_sequence bigint, source_result_sha256 bytea, result_kind text, canonical_result_bytes bytea",
  "dasher_run_api.checkpoint_commit_result":
    "mutation dasher_run_api.run_mutation_result, checkpoint_revision bigint, state_sha256 bytea, checkpoint_sha256 bytea",
  "dasher_run_api.content_commit_result":
    "mutation dasher_run_api.run_mutation_result, object_id uuid, content_sha256 bytea",
  "dasher_run_api.attempt_reservation_result":
    "mutation dasher_run_api.run_mutation_result, attempt_id uuid, reserved_vector dasher_run_api.attempt_resource_vector",
  "dasher_run_api.attempt_start_result":
    "mutation dasher_run_api.run_mutation_result, attempt_id uuid, dispatch_ready_at timestamptz",
  "dasher_run_api.attempt_invocation_result":
    "mutation dasher_run_api.run_mutation_result, attempt_id uuid, status text, invocation_authorized_at timestamptz",
  "dasher_run_api.attempt_accounting_result":
    "mutation dasher_run_api.run_mutation_result, attempt_id uuid, attempt_state text, reserved_vector dasher_run_api.attempt_resource_vector, used_vector dasher_run_api.attempt_resource_vector, released_vector dasher_run_api.attempt_resource_vector, outstanding_vector dasher_run_api.attempt_resource_vector",
  "dasher_run_api.calculation_commit_result":
    "mutation dasher_run_api.run_mutation_result, graph_id uuid, result_id uuid, graph_sha256 bytea, result_sha256 bytea, meter_vector dasher_run_api.calculation_meter_vector_v1",
  "dasher_run_api.replay_consume_result":
    "mutation dasher_run_api.run_mutation_result, source_result_sequence bigint, source_result_sha256 bytea, replay_result_id uuid",
  "dasher_run_api.validation_findings_result":
    "mutation dasher_run_api.run_mutation_result, candidate_id uuid, finding_count integer, findings_sha256 bytea, validation_state text",
  "dasher_run_api.candidate_set_result":
    "mutation dasher_run_api.run_mutation_result, candidate_ids uuid[], candidate_count integer, candidate_set_sha256 bytea",
  "dasher_run_api.claim_set_result":
    "mutation dasher_run_api.run_mutation_result, candidate_id uuid, claim_count integer, edge_count integer, claim_set_sha256 bytea",
  "dasher_run_api.ranking_result":
    "mutation dasher_run_api.run_mutation_result, selected_candidate_id uuid, ordered_candidate_ids uuid[], ordered_ranks integer[], ranking_sha256 bytea",
} as const;

const phase7FunctionOwners = {
  tenant: "dasher_security_definer",
  operator: "dasher_run_definer",
  retention: "dasher_retention_definer",
  triggerHelpers: "migration_owner",
} as const;

const phase7FunctionSettings = {
  securityDefiner: true,
  volatility: "VOLATILE",
  proconfig: ["search_path=pg_catalog"],
  publicExecute: false,
} as const;

const phase7SemanticSchemas = {
  "canonical-input-table-v1": {
    domain: "dasher.canonical-input-table.v1",
    fields: ["schema", "input_snapshot_id", "row_count", "fields", "rows"],
    bytes: [1, 1_048_576],
    fieldCount: [1, 512],
    rowCount: [0, 10_000],
  },
  "common-evidence-bundle-v1": {
    domain: "dasher.common-evidence-bundle.v1",
    fields: ["schema", "bundle_id", "source_snapshot_id", "entries"],
    bytes: [1, 262_144],
    entries: [1, 256],
  },
  "agent-brief-v1": {
    domain: "dasher.agent-brief.v1",
    fields: [
      "schema",
      "brief_id",
      "bundle_id",
      "goal",
      "metric_contract_ids",
      "dimension_field_ids",
      "requested_views",
      "constraints",
      "specialist_required",
      "candidate_target_count",
    ],
    bytes: [1, 32_768],
  },
  "agent-validation-findings-v1": {
    domain: "dasher.agent-validation-findings.v1",
    fields: ["schema", "candidate_id", "candidate_spec_sha256", "findings"],
    bytes: [1, 65_536],
    findings: [0, 64],
  },
  "candidate-claims-v1": {
    domain: "dasher.candidate-claims.v1",
    fields: [
      "schema",
      "candidate_id",
      "candidate_spec_sha256",
      "material_claim_set_sha256",
      "claims",
      "edges",
    ],
    bytes: [1, 262_144],
    claims: [1, 64],
    edges: [0, 256],
  },
  "reviewer-verdict-set-v1": {
    domain: "dasher.reviewer-verdict-set.v1",
    fields: [
      "schema",
      "candidate_set_sha256",
      "candidate_validation_set_sha256",
      "candidate_claim_sets_sha256",
      "verdicts",
    ],
    bytes: [1, 16_384],
    verdicts: [1, 2],
  },
  "candidate-evidence-manifest-v1": {
    domain: "dasher.candidate-evidence-manifest.v1",
    fields: [
      "schema",
      "candidate_id",
      "candidate_spec_sha256",
      "bundle_sha256",
      "claims_sha256",
      "validation_findings_sha256",
      "reviewer_verdict_sha256",
      "material_claim_set_sha256",
      "entries",
    ],
    bytes: [1, 65_536],
    entries: [1, 64],
  },
  "run-abstention-v1": {
    domain: "dasher.run-abstention.v1",
    fields: [
      "schema",
      "abstention_id",
      "reason",
      "retryable",
      "next_safe_step",
    ],
    bytes: [1, 4_096],
  },
  "calculation-graph-v1": {
    domain: "dasher.calculation-graph.v1",
    rawBytes: [1, 131_072],
    canonicalBytes: [1, 65_536],
    nodes: [1, 128],
    outputs: [1, 32],
  },
  "calculation-result-v1": {
    domain: "dasher.calculation-result.v1",
    fields: [
      "schema",
      "result_id",
      "graph_id",
      "graph_sha256",
      "state",
      "outputs",
      "error_code",
      "meter_sha256",
    ],
    bytes: [1, 1_114_112],
    outputRows: [0, 2_000],
  },
} as const;

const phase7CanonicalJsonContract = {
  encoding: "UTF-8 RFC 8785 JCS",
  strings: "NFC",
  rejects: [
    "duplicate keys",
    "unknown keys",
    "unpaired surrogates",
    "control characters outside JSON escapes",
    "negative zero",
    "noncanonical key order or number spelling",
  ],
  uuid: "lowercase hyphenated RFC 9562 text",
  sha256: "64 lowercase hexadecimal characters",
  signed64: {
    json: "i64:<decimal>",
    decimal: "0|-?[1-9][0-9]*",
    minimum: "-9223372036854775808",
    maximum: "9223372036854775807",
    typescript: "bigint",
    postgresql: "numeric range-check before bigint cast",
    jsonNumberAllowed: false,
  },
  instants:
    "UTC RFC 3339 strings with exactly six fractional digits and exact PostgreSQL microsecond round-trip",
  namedNumberExceptions: {
    kind: "jcs-binary64",
    dashboardSpecFields: [
      "latitude",
      "longitude",
      "stage",
      "streamflow",
      "trend point value",
    ],
    finite: true,
    absoluteMaximum: 9_007_199_254_740_991,
    negativeZero: false,
    spelling: "RFC 8785 shortest ECMAScript binary64 rendering",
  },
  arrays:
    "unique and sorted by each schema's stated tuple using unsigned UTF-8 byte order",
  semanticRowHash: [
    "listed ASCII domain plus NUL",
    "unsigned big-endian 32-bit canonical-byte length",
    "exact canonical bytes",
  ],
  retainedPayloadEnvelope: {
    domain: "dasher.retained-payload-envelope.v1",
    orderedValues: [
      "content-kind text",
      "database-generated 32-byte nonce as a byte string",
      "semantic row SHA as a byte string",
    ],
  },
  canonicalBinaryV1: {
    uuid: "16 network-order bytes",
    signed64: "big-endian two's-complement",
    count: "nonnegative signed-64",
    timestamp: "signed-64 epoch microseconds UTC",
    boolean: "one byte 00|01",
    bytes: "unsigned-32 length plus bytes",
    text: "unsigned-32 UTF-8 length plus NFC bytes",
    nullable: "00 absent; 01 followed by present encoding",
    shaByteString: "unsigned-32 length plus 32 digest bytes",
    shaBytes: "raw fixed-width 32 digest bytes",
  },
  uuidV8: {
    algorithm:
      "SHA-256 the exact domain/preimage, take bytes 0..15, set byte 6 high nibble to 8 and byte 8 high bits to 10, render lowercase RFC 9562 UUID",
  },
} as const;

const phase7CanonicalSemanticContracts = {
  "canonical-input-table-v1": {
    domain: "dasher.canonical-input-table.v1",
    fields: ["schema", "input_snapshot_id", "row_count", "fields", "rows"],
    canonicalBytes: [1, 1_048_576],
    fieldCount: [1, 512],
    rowCount: [0, 10_000],
    rowCountRule: "tagged i64 equal to rows.length",
    field: {
      fields: ["field_id", "scalar_type", "nullable", "stable_key_ordinal"],
      scalarType: [
        "boolean",
        "integer",
        "decimal",
        "text",
        "date",
        "timestamp",
      ],
      order: "unique ascending field UUID",
      stableKeyOrdinal:
        "null or tagged nonnegative i64; nonnull values unique and exactly i64:0..i64:k-1 with k >= 1",
    },
    row: {
      fields: ["row_id", "values"],
      values:
        "exactly one value for every field, sorted by field UUID; stable-key values present",
      order: "unsigned stable-key byte string then row UUID",
      uniqueness: ["stable-key byte string", "row_id"],
      rowId: [
        "UUIDv8",
        "dasher.input-row-id.v1",
        "input snapshot UUID",
        "complete typed stable-key byte string",
      ],
    },
    value: {
      fields: ["field_id", "state", "type", "value"],
      states: ["present", "null", "missing", "unavailable"],
      stateBytes: {
        present: "00",
        null: "01",
        missing: "02",
        unavailable: "03",
      },
      typeBytes: {
        boolean: "00",
        integer: "01",
        decimal: "02",
        text: "03",
        date: "04",
        timestamp: "05",
      },
      integer: "tagged signed i64",
      decimal: {
        fields: ["coefficient", "scale"],
        coefficient: "canonical signed decimal, <= 38 digits excluding sign",
        scale: "tagged i64:0..i64:18",
        reduced:
          "strip coefficient trailing zeroes while scale is positive; zero is coefficient 0 and scale i64:0",
        binary: "signed-128 coefficient followed by one unsigned scale byte",
      },
      text: "NFC; complete canonical JCS string token length <= catalog max_value_bytes",
      date: "YYYY-MM-DD and signed-32 days since 1970-01-01 in binary",
      timestamp:
        "UTC RFC 3339 with six fractional digits and signed-64 epoch microseconds in binary",
    },
    sourceEligibility: {
      sourceKind: "synthetic_fixture",
      contentHash:
        "row hash over dasher.canonical-input-table.v1 and the exact source bytes",
      equality:
        "source bytes/hash, nested request input_table, field catalog IDs/types/nullability/stable ordinals/input ID/hash/row count, and claimed bytes all byte-equal",
    },
  },
  "common-evidence-bundle-v1": {
    domain: "dasher.common-evidence-bundle.v1",
    fields: ["schema", "bundle_id", "source_snapshot_id", "entries"],
    canonicalBytes: [1, 262_144],
    entries: [1, 256],
    entry: {
      fields: [
        "evidence_id",
        "evidence_sha256",
        "source_snapshot_id",
        "source_sha256",
        "freshness",
        "observed_at",
      ],
      freshness: ["current", "stale"],
      observedAt: "UTC RFC 3339 with six fractional digits",
    },
    order: "evidence UUID; unique by evidence and source IDs",
    membership:
      "exact sorted union of every field-catalog and metric-contract lineage evidence ID; every entry uses the request input snapshot",
    overLimit:
      "typed unsupported_capability abstention before planner dispatch; never truncate",
  },
  "agent-brief-v1": {
    domain: "dasher.agent-brief.v1",
    fields: [
      "schema",
      "brief_id",
      "bundle_id",
      "goal",
      "metric_contract_ids",
      "dimension_field_ids",
      "requested_views",
      "constraints",
      "specialist_required",
      "candidate_target_count",
    ],
    canonicalBytes: [1, 32_768],
    goalUtf8Bytes: [1, 1_000],
    metricContractIds: [1, 16, "sorted unique UUID"],
    dimensionFieldIds: [0, 32, "sorted unique governed field UUID"],
    requestedViews: {
      count: [1, 8],
      order: ["metric", "table", "bar", "line", "scatter"],
      unique: true,
    },
    constraints: [0, 16, "sorted unique NFC strings of 1..256 UTF-8 bytes"],
    specialistRequired: "JSON boolean",
    candidateTargetCount: ["i64:1", "i64:2"],
  },
  "agent-validation-findings-v1": {
    domain: "dasher.agent-validation-findings.v1",
    fields: ["schema", "candidate_id", "candidate_spec_sha256", "findings"],
    canonicalBytes: [1, 65_536],
    findings: [0, 64],
    finding: {
      fields: [
        "kind",
        "severity",
        "subject_kind",
        "subject_id",
        "json_pointer",
        "related_sha256",
      ],
      kind: [
        "schema_violation",
        "unsupported_component",
        "unknown_field",
        "metric_contract_mismatch",
        "calculation_error",
        "evidence_incomplete",
        "policy_violation",
      ],
      severity: ["error", "warning"],
      subjectKind: ["candidate", "calculation", "evidence"],
      jsonPointerAsciiBytes: [0, 256],
      subjectRules: {
        candidate: "subject_id and related_sha256 null",
        calculation:
          "same-run calculation_result_id and exact result SHA required",
        evidence: "common-bundle evidence ID and exact evidence SHA required",
      },
    },
    order:
      "severity error-before-warning, kind enum, subject_kind enum, subject_id null-before-UUID, json_pointer, related_sha256",
    derivedState: {
      empty: "passed",
      warningsOnly: "passed_with_warnings",
      anyError: "failed",
    },
  },
  "candidate-claims-v1": {
    domain: "dasher.candidate-claims.v1",
    fields: [
      "schema",
      "candidate_id",
      "candidate_spec_sha256",
      "material_claim_set_sha256",
      "claims",
      "edges",
    ],
    canonicalBytes: [1, 262_144],
    claims: [1, 64],
    edges: [0, 256],
    claim: {
      fields: [
        "claim_id",
        "json_pointer",
        "assertion_sha256",
        "label",
        "statement",
        "salience",
        "evidence_state",
        "calculation_result_id",
        "calculation_output_identity_kind",
        "calculation_output_node_id",
        "calculation_output_sha256",
        "calculation_output_row_id",
        "calculation_output_field_id",
        "calculation_output_value_sha256",
      ],
      label: [
        "observed",
        "calculated",
        "hypothesis",
        "recommendation",
        "unknown",
        "blocked",
      ],
      salience: ["high", "normal"],
      evidenceState: [
        "complete",
        "partial",
        "contradicted",
        "stale",
        "unsupported",
      ],
      jsonPointerAsciiBytes: [1, 512],
      statement:
        "json_pointer + one ASCII space + 'sha256:' + lowercase assertion_sha256 hex",
      calculationIdentityKind: ["output", "scalar_row", "rowset_cell"],
      calculationNullability:
        "all seven calculation identity fields null for non-calculated; output has row/field/value null; scalar_row has row/value nonnull and field null; rowset_cell has row/field/value nonnull",
      claimHash:
        "dasher.candidate-claim.v1 row hash over all fourteen claim fields in listed order",
    },
    edge: {
      fields: ["claim_id", "evidence_id", "relation"],
      relation: ["supports", "contradicts", "context"],
      order: "claim_id, evidence_id, relation enum",
    },
    order:
      "claims by claim UUID; edges by declared tuple; duplicates forbidden",
    completeRule: "at least one current supports edge",
    contradictedRule: "at least one contradicts edge",
    nonCompleteLabels: ["hypothesis", "recommendation", "unknown", "blocked"],
    setHash:
      "canonical semantic row hash of complete candidate-claims-v1 bytes",
  },
  "reviewer-verdict-set-v1": {
    domain: "dasher.reviewer-verdict-set.v1",
    fields: [
      "schema",
      "candidate_set_sha256",
      "candidate_validation_set_sha256",
      "candidate_claim_sets_sha256",
      "verdicts",
    ],
    canonicalBytes: [1, 16_384],
    verdicts: [1, 2],
    verdict: {
      fields: [
        "candidate_id",
        "candidate_spec_sha256",
        "verdict",
        "reason_codes",
      ],
      verdict: ["preferred", "acceptable", "reject"],
      reasonCodes: [
        "evidence_gap",
        "calculation_error",
        "policy_violation",
        "misleading_encoding",
        "unsupported_claim",
        "stale_source",
        "inconsistent_bundle",
        "invalid_spec",
      ],
      reasonCount: [0, 8],
      order: "sorted unique reason enum",
      rules: [
        "preferred|acceptable forbids policy_violation|misleading_encoding|invalid_spec",
        "reject requires at least one reason",
      ],
    },
    order: "unique by candidate UUID; exactly the frozen candidate set",
  },
  "candidate-evidence-manifest-v1": {
    domain: "dasher.candidate-evidence-manifest.v1",
    fields: [
      "schema",
      "candidate_id",
      "candidate_spec_sha256",
      "bundle_sha256",
      "claims_sha256",
      "validation_findings_sha256",
      "reviewer_verdict_sha256",
      "material_claim_set_sha256",
      "entries",
    ],
    canonicalBytes: [1, 65_536],
    entries: [1, 64],
    entry: {
      fields: ["claim_id", "supporting_evidence_ids"],
      supportingEvidenceIds: "sorted unique common-bundle UUIDs",
    },
    order: "claim UUID",
    exactness:
      "entry claim set equals trusted material claims and each evidence list equals that claim's current supports edges",
  },
  "run-abstention-v1": {
    domain: "dasher.run-abstention.v1",
    fields: [
      "schema",
      "abstention_id",
      "reason",
      "retryable",
      "next_safe_step",
    ],
    canonicalBytes: [1, 4_096],
    reason: [
      "insufficient_evidence",
      "ambiguous_request",
      "missing_governed_metric",
      "unsupported_capability",
      "calculation_limit",
      "budget_exhausted",
      "authority_revoked",
    ],
    retryableReasons: [
      "insufficient_evidence",
      "ambiguous_request",
      "missing_governed_metric",
      "budget_exhausted",
    ],
    nextSafeStep: [
      "select_source",
      "refresh_snapshot",
      "define_metric",
      "resolve_grain",
      "add_evidence",
      "reduce_scope",
      "retry_later",
      "none",
    ],
    noneRequired: ["unsupported_capability", "authority_revoked"],
    abstentionId: "equals terminal operation UUID",
  },
  "dashboard-spec-v1": {
    domain: "dasher.dashboard-spec.v1",
    discriminator: "schemaVersion",
    package: "@dasher/dashboard-schema@0.1.0",
    parser: "parseDashboardSpec",
    source: "packages/dashboard-schema/src/schema.ts",
    sourceSha256:
      "dfdbbba8f6202cff2eeddaf82cbc4e2989f30982334351b174926dcd568fd8b2",
    versions: ["1.0", "1.1"],
    unions: "exact strict unions and aggregate budgets in the pinned source",
    materialPaths: [
      "/freshness",
      "/nextAction",
      "/notice",
      "/executiveBrief/{known|changed|important} when present",
      "/pages/<p>/description",
      "every present component subtitle",
      "summary claims/<i>",
      "metric-grid metrics/<i>",
      "gauge-map/table gauges/<i>",
      "ranking items/<i>",
      "trend-list series/<i> including all points",
      "alert-list alerts/<i>",
      "/evidence/<i>",
      "/architecture/summary",
      "every architecture node",
      "every architecture edge",
    ],
    externalCandidateConstraints: [
      "all evidence IDs are lowercase UUIDs and exact common-bundle members",
      "dataMode = 'demo'",
      "trusted material assertion count is 1..64",
    ],
    materialAssertion: {
      fields: [
        "claim_id",
        "json_pointer",
        "assertion_sha256",
        "allowed_labels",
      ],
      assertionDomain: "dasher.material-assertion.v1",
      assertionFields: [
        "schema",
        "candidate_spec_sha256",
        "json_pointer",
        "value",
      ],
      claimIdDomain: "dasher.material-claim-id.v1",
      setDomain: "dasher.material-claim-set.v1",
      order: "JSON pointer unsigned UTF-8 bytes",
      labelEnum: [
        "observed",
        "calculated",
        "hypothesis",
        "recommendation",
        "unknown",
        "blocked",
      ],
    },
    calculatedMappingKinds: ["output", "scalar_row", "rowset_cell"],
    calculatedMappedSubtrees: [
      "summary claim",
      "metric item",
      "ranking item",
      "executive entry",
      "trend series",
      "/freshness",
    ],
    calculatedForbiddenSubtrees: [
      "evidence entries",
      "gauges",
      "prose",
      "architecture",
      "notice",
      "page descriptions",
      "subtitles",
      "next action",
      "alerts",
    ],
  },
  "precommit-dashboard-validation-v1": {
    domain: "dasher.precommit-dashboard-validation.v1",
    fields: [
      "schema",
      "candidate_spec_sha256",
      "validator_id",
      "validator_source_sha256",
      "state",
      "error_codes",
    ],
    canonicalBytes: [1, 16_384],
    validatorId: "@dasher/dashboard-schema@0.1.0+task9-candidate-v1",
    validatorSourcePreimage: [
      "dasher.precommit-validator-source.v1",
      "dashboard-schema source SHA bytes",
      "material-assertions-v1",
      "bundle-evidence-uuid-v1",
      "demo-data-mode-v1",
    ],
    state: ["valid", "invalid"],
    errorCodes: [
      "schema",
      "size",
      "complexity",
      "duplicate_id",
      "missing_evidence",
      "invalid_evidence_time",
      "invalid_architecture_edge",
      "unsupported_version",
      "material_claim_limit",
      "unsupported_data_mode",
    ],
    errorCount: [0, 64],
    order: "sorted unique error enum",
    rules: [
      "valid requires zero errors and trusted material claim count 1..64",
      "invalid requires at least one error",
    ],
  },
  "field-catalog-snapshot-v1": {
    domain: "dasher.field-catalog-snapshot.v1",
    fields: [
      "schema",
      "catalog_snapshot_id",
      "input_snapshot_id",
      "input_sha256",
      "input_row_count",
      "evaluated_at",
      "fields",
    ],
    canonicalBytes: [1, 262_144],
    fieldCount: [1, 512],
    inputRowCount: "nonnegative tagged i64 equal to source snapshot rows",
    field: {
      fields: [
        "field_id",
        "source_path",
        "logical_name",
        "scalar_type",
        "nullable",
        "semantic_type",
        "unit",
        "currency",
        "grain",
        "event_time_field_id",
        "stable_key_ordinal",
        "max_value_bytes",
        "allowed_aggregations",
        "allowed_dimensions",
        "lineage_evidence_ids",
      ],
      scalarType: [
        "boolean",
        "integer",
        "decimal",
        "text",
        "date",
        "timestamp",
      ],
      semanticType: [
        "identifier",
        "measure",
        "dimension",
        "event_time",
        "attribute",
      ],
      aggregations: [
        "count",
        "count_distinct",
        "sum",
        "min",
        "max",
        "mean",
        "median",
        "ratio",
      ],
      pathAndNameUtf8Bytes: [1, 256],
      allowedDimensions: [0, 64],
      lineageEvidenceIds: [1, 64],
      order: "field UUID",
    },
    stableKeyOrdinals: "at least one; unique contiguous tagged i64:0..i64:k-1",
  },
  "metric-contract-set-v1": {
    domain: "dasher.metric-contract-set.v1",
    fields: ["schema", "contract_set_id", "catalog_snapshot_id", "contracts"],
    canonicalBytes: [1, 262_144],
    contracts: [1, 64],
    order: "unique (contract_id,version)",
    contract: {
      fields: [
        "contract_id",
        "version",
        "business_owner_membership_id",
        "data_owner_membership_id",
        "name",
        "definition",
        "measure_field_id",
        "aggregation",
        "denominator_contract_id",
        "denominator_contract_version",
        "value_type",
        "unit",
        "currency",
        "direction",
        "threshold",
        "target",
        "grain",
        "lag_millis",
        "freshness_slo_millis",
        "allowed_dimension_field_ids",
        "calendar",
        "timezone",
        "lineage_evidence_ids",
        "review_state",
      ],
      version: "positive tagged i64",
      nameUtf8Bytes: [1, 256],
      definitionUtf8Bytes: [1, 4_096],
      aggregation: [
        "count",
        "count_distinct",
        "sum",
        "min",
        "max",
        "mean",
        "median",
        "ratio",
      ],
      valueType: ["integer", "decimal", "currency", "percentage", "duration"],
      direction: [
        "higher_is_better",
        "lower_is_better",
        "target_band",
        "neutral",
      ],
      thresholdTarget:
        "nullable canonical decimal 0|-?[1-9][0-9]*(\\.[0-9]*[1-9])?, <=38 coefficient digits and <=18 fractional digits, no negative zero",
      grainUtf8Bytes: [1, 128],
      lagMillis: "nonnegative tagged i64",
      freshnessSloMillis: "nonnegative tagged i64",
      allowedDimensionFieldIds: [0, 32],
      lineageEvidenceIds: [1, 64],
      calendar: ["gregorian", "iso_week", "fiscal_445"],
      timezone: "exact IANA name",
      reviewState: "reviewed",
    },
  },
  "agent-run-request-v1": {
    domain: "dasher.agent-run-request.v1",
    fields: [
      "schema",
      "run_request_id",
      "request_idempotency_sha256",
      "dashboard_id",
      "input_snapshot_id",
      "input_sha256",
      "input_table",
      "purpose",
      "evaluation_time",
      "policy_revision",
      "field_catalog",
      "metric_contract_set",
      "generation_limit_vector",
      "review_limit_vector",
      "orchestration_limits",
      "adapter_id",
      "model_id",
      "price_book_revision",
      "replay_source_run_id",
      "replay_source_result_count",
      "replay_source_head_sha256",
      "replay_source_candidate_set_sha256",
      "replay_source_bundle_id",
      "replay_source_bundle_sha256",
      "replay_source_brief_id",
      "replay_source_brief_sha256",
      "replay_source_selected_candidate_id",
    ],
    canonicalBytes: [1, 1_638_400],
    purpose: ["suggest", "replay"],
    vectorFields: phase7AttemptResourceVectorFields,
    orchestrationLimits: {
      fields: [
        "active_organization_runs",
        "active_dashboard_runs",
        "approval_required_dashboard_runs",
        "provider_concurrency",
        "tool_attempts",
        "transient_retries",
      ],
      values: ["i64:2", "i64:1", "i64:2", "i64:1", "i64:0", "i64:1"],
    },
    evaluationTime: "UTC RFC 3339 with six fractional digits; sole run clock",
    suggestReplayFields: "all null",
    replayReplayFields:
      "all nonnull and equal current authorized approval_required source with exact 3..5 retry grammar/head/candidate-set/bundle/Brief/selection",
    hashOrder: [
      "request idempotency proof",
      "insert digest into request object",
      "JCS encode and semantic row hash",
      "nonce-bearing retained request envelope",
    ],
  },
  "attempt-request-v1": {
    domain: "dasher.attempt-request.v1",
    fields: [
      "schema",
      "attempt_id",
      "attempt_kind",
      "adapter_id",
      "model_id",
      "policy_revision",
      "price_book_revision",
      "candidate_slot",
      "retry_of_attempt_id",
      "input_sha256",
      "common_bundle_sha256",
      "brief_sha256",
      "specialist_result_id",
      "specialist_result_sha256",
      "candidate_set_sha256",
      "candidate_validation_set_sha256",
      "candidate_claim_sets_sha256",
      "invalid_result_id",
      "invalid_result_sha256",
      "invalid_validation_sha256",
      "instructions_sha256",
    ],
    canonicalBytes: [1, 65_536],
    attemptKind: ["planner", "generator", "specialist", "repair", "reviewer"],
    routingFixtures: {
      planner: [
        "dasher-task9-planner-v1",
        23,
        "d57dc1caa47bb25cfe39dd8d44f22167f887414c23fa56a9838947605e87b269",
      ],
      generator: [
        "dasher-task9-generator-v1",
        25,
        "8d302cfdc12d2688ac685c587ba12dcffb533adabd32ac8dd2371e1eec300021",
      ],
      specialist: [
        "dasher-task9-specialist-v1",
        26,
        "a7607000dbd2cd782f0fc42e621fe55299c9507e458015d3ca7671e80e1df714",
      ],
      repair: [
        "dasher-task9-repair-v1",
        22,
        "da21c80354847f46eacb65d09361eeb84abff4b1d41fa31804b16911a9b19026",
      ],
      reviewer: [
        "dasher-task9-reviewer-v1",
        24,
        "13c81cc91b6ca0a3d36b13b61c2222303e93e40d239bcbb8014a89b473b22751",
      ],
    },
    candidateSlot:
      "null except generator; generator tagged i64:1|i64:2 and <= Brief target",
    retry:
      "null except one immediate planner/generator retry naming exact failed same-kind/same-slot predecessor",
    commonRequired: [
      "input_sha256",
      "common_bundle_sha256",
      "instructions_sha256",
    ],
    kindBindings: {
      planner:
        "null slot, Brief, specialist, candidate-set, validation-set, claim-set, invalid fields",
      specialist:
        "null slot/retry; exact successful planner-derived Brief; later fields null",
      generator:
        "exact slot/bundle/Brief, optional sole successful specialist pair, candidate/validation/claim/invalid fields null",
      repair:
        "null slot/retry; exact bundle/Brief/invalid result and invalid validation; same optional specialist pair; set hashes null",
      reviewer:
        "null slot/retry/specialist/invalid; exact bundle/Brief/candidate-set/validation-set/claim-set hashes",
    },
  },
  "recorded-result-v1": {
    domain: "dasher.recorded-result.v1",
    fields: [
      "schema",
      "result_id",
      "attempt_id",
      "attempt_kind",
      "adapter_id",
      "model_id",
      "request_sha256",
      "result_kind",
      "result",
    ],
    canonicalBytes: [1, 1_114_112],
    successKinds: [
      "planner_output",
      "specialist_output",
      "candidate_output",
      "candidate_invalid",
      "repair_output",
      "reviewer_verdict_set",
    ],
    failureKinds: ["refusal", "failure"],
    nestedResults: {
      planner_output: "exact agent-brief-v1 object",
      specialist_output: {
        fields: ["schema", "bundle_sha256", "observations"],
        observations: [
          1,
          32,
          "sorted unique NFC strings of 1..1000 UTF-8 bytes",
        ],
      },
      candidate_output: ["dashboard_spec", "precommit_validation valid"],
      candidate_invalid: ["dashboard_spec", "precommit_validation invalid"],
      repair_output: ["dashboard_spec", "precommit_validation valid"],
      reviewer_verdict_set: "exact reviewer-verdict-set-v1 object",
      refusalOrFailure: {
        fields: ["schema", "reason_code", "retryable"],
        reasonCode: [
          "policy_refusal",
          "insufficient_context",
          "adapter_error",
          "timeout",
          "malformed_output",
        ],
        retryableOnly: ["adapter_error", "timeout"],
      },
    },
    outcomeMapping: {
      succeeded:
        "kind-position legal planner_output|specialist_output|generator candidate_output|candidate_invalid|repair_output|reviewer_verdict_set",
      refused: "refusal",
      failed: "failure",
      indeterminate:
        "actual_accounting_bytes, result_sha256, and result bytes all SQL NULL; no payload/result row",
    },
  },
  "agent-run-checkpoint-v1": {
    domain: "dasher.agent-run-checkpoint.v1",
    fields: [
      "schema",
      "run_id",
      "run_request_id",
      "request_idempotency_sha256",
      "request_sha256",
      "policy_revision",
      "run_revision",
      "state",
      "lease_epoch",
      "source_event_sequence",
      "source_event_sha256",
      "budget_counters",
      "attempts",
      "latest_brief_sha256",
      "latest_bundle_sha256",
      "calculation_result_ids",
      "candidate_ids",
      "candidate_set_sha256",
      "validation_states",
      "consumed_replay_sequence",
      "consumed_replay_sha256",
      "terminal_operation_kind",
      "terminal_operation_id",
      "terminal_claim_input_sha256",
      "terminal_operation_sha256",
      "tenant_cancel_operation_id",
      "tenant_cancel_operation_sha256",
      "tenant_cancel_result_sha256",
      "tenant_cancel_result_run_revision",
      "tenant_cancel_result_event_sequence",
      "tenant_cancel_result_event_sha256",
      "selected_candidate_id",
    ],
    canonicalBytes: [1, 262_144],
    budgetCounters:
      "one row for each (generation|review, vector_field) in partition/field enum order with exact reserved/used/released/outstanding signed-i64 values",
    attempts:
      "attempt UUID order; exact ID/kind/state/epoch/slot/retry/four vectors/request/result hashes",
    writableTerminalFields:
      "all four terminal-operation and all six tenant-cancel fields null",
    arrays:
      "parallel, UUID-sorted, policy-bounded; null only before semantic exists",
    reducer:
      "complete event-1-through-source projection; exact request identities derived from event 1",
    hashes: {
      state_sha256: "semantic row hash of exact checkpoint bytes",
      checkpoint_sha256:
        "retained payload envelope with content kind agent-run-checkpoint-v1 and database nonce",
    },
  },
  "agent-run-event-payload-v1": {
    domain: "dasher.agent-run-event-payload.v1",
    fields: [
      "schema",
      "event_id",
      "run_id",
      "event_sequence",
      "run_revision",
      "event_kind",
      "occurred_at",
      "actor_kind",
      "actor_id",
      "actor_revision",
      "body",
    ],
    canonicalBytes: [1, 262_144],
    actorKind: ["tenant", "run_operator", "retention"],
    bodyRegistry: {
      run_requested: [
        "run_request_id",
        "request_payload_id",
        "request_idempotency_sha256",
        "request_sha256",
        "policy_revision",
        "purpose",
        "replay_source_run_id",
      ],
      lease_acquired: [
        "claim_request_id",
        "claim_input_sha256",
        "claim_result_sha256",
        "mode",
        "prior_lease_epoch",
        "new_lease_epoch",
        "lease_token_sha256",
        "lease_expires_at",
        "principal_id",
        "principal_revision",
        "principal_sha256",
      ],
      attempt_reserved: [
        "attempt_id",
        "partition",
        "attempt_kind",
        "candidate_slot",
        "retry_of_attempt_id",
        "request_payload_id",
        "request_sha256",
        "reserved_vector",
      ],
      attempt_dispatch_prepared: ["attempt_id", "dispatch_request_sha256"],
      attempt_dispatch_started: ["attempt_id", "dispatch_request_sha256"],
      attempt_reconciled: [
        "attempt_id",
        "outcome",
        "result_id",
        "result_sha256",
        "actual_vector",
        "used_vector",
        "released_vector",
      ],
      attempt_indeterminate: [
        "attempt_id",
        "reason_code",
        "used_vector",
        "released_vector",
        "fenced_lease_epoch",
      ],
      attempt_released: [
        "attempt_id",
        "release_mode",
        "release_proof_sha256",
        "released_vector",
      ],
      attempt_cancelled_released: [
        "attempt_id",
        "cancel_operation_id",
        "used_vector",
        "released_vector",
      ],
      attempt_cancelled_charged: [
        "attempt_id",
        "cancel_operation_id",
        "used_vector",
        "released_vector",
      ],
      indeterminate_quarantined: [
        "claim_request_id",
        "lease_seconds",
        "principal_id",
        "principal_revision",
        "principal_sha256",
        "claim_input_sha256",
        "claim_result_sha256",
        "terminal_claim_input_sha256",
        "source_event_sequence",
        "source_event_sha256",
        "released_attempt_ids",
        "charged_attempt_ids",
        "settled_attempt_count",
        "first_settlement_event_sequence",
        "last_settlement_event_sequence",
        "settlement_events_sha256",
        "used_vector",
        "released_vector",
        "prior_lease_epoch",
        "fenced_lease_epoch",
        "terminal_operation_sha256",
      ],
      replay_prerequisites_cloned: [
        "source_run_id",
        "bundle_id",
        "bundle_sha256",
        "brief_id",
        "brief_sha256",
        "candidate_set_sha256",
        "result_count",
        "result_head_sha256",
      ],
      replay_result_consumed: [
        "source_run_id",
        "source_result_sequence",
        "source_result_sha256",
        "replay_result_id",
      ],
      checkpoint_written: [
        "checkpoint_revision",
        "source_event_sequence",
        "source_event_sha256",
        "state_sha256",
        "checkpoint_sha256",
      ],
      brief_committed: ["brief_id", "brief_sha256"],
      common_bundle_committed: ["bundle_id", "bundle_sha256"],
      calculation_graph_committed: [
        "graph_id",
        "graph_sha256",
        "result_id",
        "result_sha256",
        "meter_sha256",
      ],
      candidate_committed: [
        "candidate_id",
        "candidate_spec_sha256",
        "source_result_id",
        "source_result_sha256",
        "precommit_validation_sha256",
        "bundle_sha256",
        "material_claim_count",
        "material_claim_set_sha256",
      ],
      candidate_set_closed: ["candidate_ids", "candidate_set_sha256"],
      candidate_validation_findings_committed: [
        "candidate_id",
        "findings_sha256",
        "finding_count",
        "validation_state",
      ],
      candidate_claims_committed: [
        "candidate_id",
        "claims_sha256",
        "claim_count",
        "edge_count",
      ],
      candidate_manifest_committed: [
        "candidate_id",
        "manifest_sha256",
        "reviewer_result_sha256",
      ],
      run_abstained: [
        "terminal_operation_id",
        "abstention_id",
        "abstention_sha256",
      ],
      run_ranked: [
        "terminal_operation_id",
        "selected_candidate_id",
        "ordered_candidate_ids",
        "ordered_ranks",
        "ranking_sha256",
      ],
      run_finished: [
        "terminal_operation_id",
        "terminal_outcome",
        "reason_sha256",
      ],
      run_cancelled: [
        "cancel_operation_id",
        "cancel_operation_sha256",
        "reason_sha256",
        "released_attempt_ids",
        "charged_attempt_ids",
        "used_vector",
        "released_vector",
        "fenced_lease_epoch",
      ],
      run_cleanup_cancelled: [
        "cancel_operation_id",
        "reason_sha256",
        "released_attempt_ids",
        "charged_attempt_ids",
        "used_vector",
        "released_vector",
        "fenced_lease_epoch",
      ],
    },
    bodyEnumRegistry: {
      run_requested: {
        purpose: ["suggest", "replay"],
      },
      lease_acquired: {
        mode: ["normal", "resume", "takeover"],
      },
      attempt_reserved: {
        partition: ["generation", "review"],
        attempt_kind: [
          "planner",
          "generator",
          "specialist",
          "repair",
          "reviewer",
        ],
      },
      attempt_reconciled: {
        outcome: ["succeeded", "refused", "failed", "indeterminate"],
      },
      attempt_indeterminate: {
        reason_code: [
          "caller_indeterminate",
          "malformed_accounting",
          "actual_over_reservation",
          "takeover_after_dispatch",
        ],
      },
      attempt_released: {
        release_mode: ["worker", "takeover"],
      },
      candidate_validation_findings_committed: {
        validation_state: ["passed", "passed_with_warnings", "failed"],
      },
      run_finished: {
        terminal_outcome: ["rejected", "cancelled", "expired", "failed"],
      },
    },
    rawAccountingBytesForbidden: true,
  },
  "calculation-graph-v1": {
    domain: "dasher.calculation-graph.v1",
    fields: [
      "schema",
      "registry",
      "limits",
      "graph_id",
      "contract_set_id",
      "contract_id",
      "contract_version",
      "contract_output_node_id",
      "threshold_node_id",
      "target_node_id",
      "input_snapshot_id",
      "input_sha256",
      "field_catalog_snapshot_id",
      "field_catalog_sha256",
      "common_bundle_id",
      "common_bundle_sha256",
      "evaluation_time",
      "timezone",
      "tzdb_version",
      "unit_registry_version",
      "fx_evidence_id",
      "fx_evidence_sha256",
      "nodes",
      "output_node_ids",
    ],
    rawBytes: [1, 131_072],
    canonicalBytes: [1, 65_536],
    nodes: [1, 128],
    outputNodeIds: [1, 32],
    registry: "calculation-registry-v1",
    limits: "calculation-limits-v1",
    tzdbVersion: "2025b",
    unitRegistryVersion: "ucum-subset-v1",
    nodeCommonFields: ["node_id", "op", "output_type", "evaluation_rows_from"],
    topologicalOrder:
      "at each step lexicographically smallest ready UUID; every input references an earlier node",
    rowsetOps: ["source", "select", "filter", "group", "sort", "top_k"],
    scalarOps:
      "every remaining registered operation; exact nonnull evaluation_rows_from",
    outputTypeFields: [
      "shape",
      "scalar",
      "nullable",
      "unit",
      "currency",
      "grain",
      "max_value_bytes",
      "fields",
    ],
  },
  "calculation-result-v1": {
    domain: "dasher.calculation-result.v1",
    fields: [
      "schema",
      "result_id",
      "graph_id",
      "graph_sha256",
      "state",
      "outputs",
      "error_code",
      "meter_sha256",
    ],
    canonicalBytes: [1, 1_114_112],
    state: ["succeeded", "failed"],
    success:
      "null error and one output for each output_node_id in sorted order",
    failure: "empty outputs and one closed semantic error code",
    output: {
      fields: [
        "node_id",
        "shape",
        "output_type",
        "evaluation_rows_from",
        "cardinality",
        "rows",
      ],
      cardinality: "tagged nonnegative i64 equal rows.length",
      totalRows: [0, 2_000],
      scalarRow: ["ordinal", "row_id", "value"],
      rowsetRow: ["ordinal", "row_id", "cells"],
      cell: ["field_id", "value"],
      ordinals: "tagged i64:0..i64:n-1",
    },
    resultIdPreimage: [
      "dasher.calculation-result-id.v1",
      "graph UUID",
      "raw graph SHA bytes",
      "raw input SHA bytes",
      "registry text",
      "limits text",
    ],
  },
} as const;

const phase7AuxiliarySemanticContracts = {
  "attempt-actual-accounting-v1": {
    fields: ["schema", ...phase7AttemptResourceVectorFields],
    exactJcsTemplate: phase7ActualAccountingTemplate,
    bytes: [1, 1_024],
    values: "fourteen canonical tagged i64 strings",
  },
  "fake-provider-input-v1": {
    fields: [
      "schema",
      "attempt_request",
      "attempt_request_sha256",
      "dispatch_request_sha256",
      "instructions",
    ],
    persisted: false,
  },
  "calculation-meter-v1": {
    domain: "dasher.calculation-meter.v1",
    fields: [
      "schema",
      "graph_id",
      "result_id",
      "input_bytes",
      "ast_bytes",
      "node_count",
      "max_depth",
      "max_literal_bytes",
      "total_literal_bytes",
      "max_literal_list_length",
      "scanned_rows",
      "group_count",
      "max_group_rows",
      "cumulative_intermediate_rows",
      "final_output_rows",
      "cumulative_intermediate_bytes",
      "output_bytes",
      "primitive_steps",
      "logical_allocation_bytes",
      "max_top_k",
      "max_window_frame",
      "max_coefficient_digits",
      "max_scale",
    ],
    values: "all meter fields tagged nonnegative i64",
  },
  "calculation-output-value-v1": {
    domain: "dasher.calculation-output-value.v1",
    fields: ["schema", "result_id", "node_id", "row_id", "field_id", "value"],
    fieldId: "null only for scalar output",
  },
  "run-finish-reason-v1": {
    domain: "dasher.run-finish-reason.v1",
    fields: ["schema", "reason"],
    reason: [
      "insufficient_evidence",
      "policy_rejected",
      "budget_exhausted",
      "expired",
      "operator_cancelled",
      "indeterminate",
      "internal_failure",
    ],
    outcome: {
      rejected: [
        "insufficient_evidence",
        "policy_rejected",
        "budget_exhausted",
      ],
      expired: ["expired"],
      cancelled: ["operator_cancelled"],
      failed: ["indeterminate", "internal_failure"],
    },
  },
  "run-cancel-reason-v1": {
    domain: "dasher.run-cancel-reason.v1",
    fields: ["schema", "reason"],
    reason: ["user_requested", "authority_revoked", "dashboard_cleanup"],
    writer: {
      tenant: "user_requested",
      authorityFence: "authority_revoked",
      cleanup: "dashboard_cleanup",
    },
  },
  "material-assertions-v1": {
    entryFields: [
      "claim_id",
      "json_pointer",
      "assertion_sha256",
      "allowed_labels",
    ],
    assertionDomain: "dasher.material-assertion.v1",
    claimIdDomain: "dasher.material-claim-id.v1",
    claimSetDomain: "dasher.material-claim-set.v1",
    count: [1, 64],
  },
  "calculated-assertion-mapping-v1": {
    identityKinds: ["output", "scalar_row", "rowset_cell"],
    outputDomain: "dasher.calculation-output.v1",
    valueDomain: "dasher.calculation-output-value.v1",
    lookup: "result output/node/row/field identity, never caller indexes",
  },
} as const;

const phase7NormativePlanSliceHashes = {
  productThroughCalculations:
    "d8764cb136a41a72f1f9d5ae9e221612942c84edea005fc6be3dad8ec13cfaff",
  semanticAndProofEncoding:
    "3136f55d17a0c3e097d7bef6c8b96446593af2725a69495d362ea2e931261953",
  fixedFunctionIdentities:
    "bce24db81498d5782d9fd2067eca5f757645f240a0f61174327ddd31fd0e5b6d",
  retentionRlsAclAndDml:
    "c7ac872b807fb1c8621b6dd86b5645aa6b518e89e789ba93f805d1286d6110b8",
  deterministicCalculations:
    "ca11c962398a423c90a22e6d199b214ae372dd2786c3ac38254858c0666c5fa6",
} as const;

const phase7RunLifecycle = {
  states: [
    "requested",
    "authorized",
    "planning",
    "generating",
    "revising",
    "validating",
    "approval_required",
    "accepted",
    "rejected",
    "cancelled",
    "expired",
    "failed",
  ],
  terminal: ["rejected", "cancelled", "expired", "failed"],
  reservedNoEntry: "accepted",
  suggestGrammar:
    "planner_output,[specialist_output],(candidate_output[,candidate_output]|candidate_invalid,repair_output),reviewer_verdict_set",
  retryableResultKinds: ["planner", "generator"],
  resultCount: [3, 5],
} as const;

const phase7TransitionEventMatrix = [
  ["request_agent_run", "<none>", "requested", "run_requested"],
  ["claim_agent_run", "requested", "authorized", "lease_acquired"],
  [
    "claim_agent_run",
    "authorized|planning|generating|revising|validating",
    "same",
    "lease_acquired",
  ],
  [
    "clone_claimed_replay_prerequisites",
    "authorized",
    "planning",
    "replay_prerequisites_cloned",
  ],
  [
    "consume_agent_replay_result",
    "planning|generating",
    "same|generating",
    "replay_result_consumed",
  ],
  [
    "write_agent_run_checkpoint",
    "claimed nonterminal",
    "same",
    "checkpoint_written",
  ],
  [
    "commit_common_evidence_bundle",
    "authorized",
    "authorized",
    "common_bundle_committed",
  ],
  ["reserve planner", "authorized", "planning", "attempt_reserved"],
  ["commit_agent_brief", "planning", "planning", "brief_committed"],
  [
    "reserve specialist|generator",
    "planning|generating",
    "generating",
    "attempt_reserved",
  ],
  ["reserve repair", "generating", "revising", "attempt_reserved"],
  ["reserve reviewer", "validating", "validating", "attempt_reserved"],
  [
    "start_agent_run_attempt",
    "claimed phase",
    "same",
    "attempt_dispatch_prepared",
  ],
  [
    "authorize_agent_run_attempt_invocation",
    "claimed phase",
    "same",
    "attempt_dispatch_started",
  ],
  [
    "reconcile_agent_run_attempt",
    "claimed phase",
    "same",
    "attempt_reconciled|attempt_indeterminate",
  ],
  ["release_agent_run_attempt", "claimed phase", "same", "attempt_released"],
  [
    "commit_calculation_graph",
    "generating|revising",
    "same",
    "calculation_graph_committed",
  ],
  [
    "commit_agent_validation_findings",
    "validating",
    "validating",
    "candidate_validation_findings_committed",
  ],
  [
    "commit_agent_candidate",
    "generating|revising",
    "same",
    "candidate_committed",
  ],
  [
    "close_agent_candidate_set",
    "generating|revising",
    "validating",
    "candidate_set_closed",
  ],
  [
    "commit_candidate_claims",
    "validating",
    "validating",
    "candidate_claims_committed",
  ],
  [
    "commit_candidate_manifest",
    "validating",
    "validating",
    "candidate_manifest_committed",
  ],
  [
    "commit_run_abstention",
    "claimed nonterminal except approval_required",
    "rejected",
    "run_abstained",
  ],
  [
    "finalize_agent_run_ranking",
    "validating",
    "approval_required",
    "run_ranked",
  ],
  [
    "finish_agent_run",
    "claimed nonterminal except approval_required",
    "rejected|cancelled|expired|failed",
    "run_finished",
  ],
  [
    "cancel_agent_run|retention drain",
    "any nonterminal including approval_required",
    "cancelled",
    "attempt_cancelled_released|attempt_cancelled_charged then run_cancelled|run_cleanup_cancelled",
  ],
] as const;

const phase7GlobalLockOrder = [
  "principal-binding advisory gate",
  "claim-operation advisory gate",
  "tenant-cancel-operation advisory gate",
  "policy-seed advisory gate",
  "organization advisory gate",
  "organization/run-request advisory gate",
  "memberships",
  "run_service_principal_allowlist",
  "retention_service_principal_allowlist",
  "dashboard_lifecycle_policies",
  "agent_run_policy_revisions",
  "dashboards",
  "dashboard_legal_holds",
  "dashboard_tombstones",
  "backup_deletion_ledger",
  "agent_runs",
  "dashboard_versions",
  "source_snapshots",
  "evidence_records",
  "field_catalog_snapshots",
  "field_catalog_entries",
  "metric_contract_versions",
  "agent_run_request_payloads",
  "agent_run_events",
  "agent_run_event_payloads",
  "agent_run_checkpoints",
  "agent_run_checkpoint_payloads",
  "candidate_comparison_bundles",
  "candidate_comparison_bundle_evidence (nonlocking)",
  "briefs",
  "agent_run_budget_counters",
  "agent_run_attempts",
  "agent_run_attempt_payloads",
  "agent_recorded_results",
  "calculation_graphs",
  "calculation_results",
  "agent_run_calculation_meters",
  "agent_candidates",
  "agent_candidate_payloads",
  "agent_validation_findings",
  "claims",
  "claim_evidence",
  "candidate_evidence_manifests",
  "run_abstentions",
  "dashboard_cleanup_attempts",
  "dashboard_agent_drain_proofs",
  "dashboard_agent_drain_proof_consumptions",
  "dashboard_agent_run_age_out_proofs",
] as const;

const phase7BudgetContract = {
  generation: [
    4, 2, 1, 0, 1, 20_000, 8_000, 8_000, 20_000, 8_000, 24_000, 36_000, 32_000,
    120_000,
  ],
  review: [
    1, 0, 0, 1, 0, 5_000, 2_000, 2_000, 5_000, 2_000, 6_000, 9_000, 8_000,
    30_000,
  ],
  activeOrganizationRuns: 2,
  activeDashboardRuns: 1,
  approvalRequiredDashboardRuns: 2,
  providerConcurrency: 1,
  toolAttempts: 0,
  retries: 1,
  thresholdNumerator: 4,
  thresholdDenominator: 5,
  adapter: "fake-provider-v1",
  model: "fake-model-v1",
  priceBook: "fake-price-book-v1",
  currency: "USD",
  inputTokenMicros: 2,
  outputTokenMicros: 4,
} as const;

const phase7AttemptContract = {
  kinds: ["planner", "generator", "specialist", "repair", "reviewer"],
  partitions: {
    planner: "generation",
    generator: "generation",
    specialist: "generation",
    repair: "generation",
    reviewer: "review",
  },
  callerOutcomes: ["succeeded", "refused", "failed", "indeterminate"],
  releaseReasons: [
    "adapter_setup_failed",
    "cancelled_before_dispatch",
    "retry_superseded",
  ],
  states: [
    "reserved_pre_dispatch",
    "dispatch_ready",
    "dispatch_started",
    "succeeded",
    "refused_charged",
    "failed_charged",
    "released_pre_dispatch",
    "released_takeover",
    "cancelled_released",
    "cancelled_charged",
    "indeterminate_quarantined",
  ],
  indeterminateReasons: [
    "caller_indeterminate",
    "malformed_accounting",
    "actual_over_reservation",
    "takeover_after_dispatch",
  ],
  precedence: [
    "caller_indeterminate",
    "malformed_accounting",
    "actual_over_reservation",
    "normal_determinate",
    "takeover_after_dispatch",
  ],
  reasonlessCancellationEvent: "attempt_cancelled_charged",
  conservation:
    "reserved = used + released + outstanding; every term is 0..9223372036854775807",
  indeterminateCandidateException:
    "candidates: used=0,released=reserved,outstanding=0; every other field: used=reserved,released=0,outstanding=0",
} as const;

const phase7AttemptReservationVectors = {
  planner: {
    partition: "generation",
    values: [
      1, 0, 0, 0, 0, 4_000, 2_000, 2_000, 4_000, 2_000, 6_000, 9_000, 8_000,
      16_000,
    ],
  },
  generator: {
    partition: "generation",
    values: [
      1, 1, 0, 0, 0, 6_000, 3_000, 3_000, 6_000, 3_000, 9_000, 9_000, 8_000,
      24_000,
    ],
  },
  specialist: {
    partition: "generation",
    values: [
      1, 0, 1, 0, 0, 4_000, 1_000, 1_000, 4_000, 1_000, 5_000, 9_000, 8_000,
      12_000,
    ],
  },
  repair: {
    partition: "generation",
    values: [
      1, 1, 0, 0, 1, 6_000, 2_000, 2_000, 6_000, 2_000, 8_000, 9_000, 8_000,
      20_000,
    ],
  },
  reviewer: {
    partition: "review",
    values: [
      1, 0, 0, 1, 0, 4_000, 2_000, 2_000, 4_000, 2_000, 6_000, 9_000, 8_000,
      16_000,
    ],
  },
} as const;

const phase7DeterminateAccountingEqualities = {
  common: [
    "calls = 1",
    "total_tokens = input_tokens + output_tokens",
    "reasoning_tokens <= output_tokens",
    "cache_read_tokens <= input_tokens",
    "cost_micros = 2 * input_tokens + 4 * output_tokens",
    "every component is nonnegative and <= its reservation",
    "used_vector = actual_vector",
    "released_vector = reserved_vector - actual_vector",
    "outstanding_vector = 0",
  ],
  categoricalByKind: {
    planner: {
      specialist_attempts: 0,
      reviewer_attempts: 0,
      repair_attempts: 0,
    },
    generator: {
      specialist_attempts: 0,
      reviewer_attempts: 0,
      repair_attempts: 0,
    },
    specialist: {
      specialist_attempts: 1,
      reviewer_attempts: 0,
      repair_attempts: 0,
    },
    repair: {
      specialist_attempts: 0,
      reviewer_attempts: 0,
      repair_attempts: 1,
    },
    reviewer: {
      specialist_attempts: 0,
      reviewer_attempts: 1,
      repair_attempts: 0,
    },
  },
  candidateMatrix: [
    ["generator", "succeeded", "candidate_output+valid", 1],
    ["repair", "succeeded", "repair_output+valid", 1],
    ["generator", "succeeded", "candidate_invalid", 0],
    ["planner", "succeeded", "planner_output", 0],
    ["specialist", "succeeded", "specialist_output", 0],
    ["reviewer", "succeeded", "reviewer_verdict_set", 0],
    ["planner", "refused", "refusal", 0],
    ["generator", "refused", "refusal", 0],
    ["specialist", "refused", "refusal", 0],
    ["repair", "refused", "refusal", 0],
    ["reviewer", "refused", "refusal", 0],
    ["planner", "failed", "failure", 0],
    ["generator", "failed", "failure", 0],
    ["specialist", "failed", "failure", 0],
    ["repair", "failed", "failure", 0],
    ["reviewer", "failed", "failure", 0],
  ],
} as const;

const phase7IndeterminateSettlementVector = {
  actualVector: null,
  resultPayload: null,
  recordedResult: null,
  outstanding: "zero for every field",
  candidates: "used=0; released=reserved",
  everyOtherField: "used=reserved; released=0",
  conservation: "reserved=used+released+outstanding",
} as const;

const phase7RetryMatrix = [
  {
    kind: "planner",
    permitted: true,
    predecessor:
      "immediately preceding determinate failed result with calls=1,candidates=0,retryable=true",
    sameBinding:
      "all semantics byte-identical except new attempt and retry IDs",
  },
  {
    kind: "generator",
    permitted: true,
    predecessor:
      "immediately preceding determinate failed same-slot result with calls=1,candidates=0,retryable=true",
    sameBinding:
      "all semantics byte-identical except new attempt and retry IDs",
  },
  {
    kind: "specialist",
    permitted: false,
    reason: "every outcome nonretryable",
  },
  { kind: "repair", permitted: false, reason: "kind excluded" },
  { kind: "reviewer", permitted: false, reason: "kind excluded" },
  { outcome: "refused", permitted: false },
  { outcome: "candidate_invalid", permitted: false },
  { outcome: "indeterminate", permitted: false },
  {
    global:
      "at most one transient retry per run; no later result/artifact or prepared/dispatched attempt; untouched higher reserved generator slot allowed; retry reserves the complete same vector and never discounts predecessor usage",
  },
] as const;

const phase7GeneratorSlotMatrix = [
  ["target=1", "reserve initial slot 1", "slot=1,retry=null", "required"],
  ["target=1", "reserve slot 2", "slot=2,retry=null", "deny"],
  [
    "target=2",
    "reserve initial slot 1",
    "slot=1,retry=null",
    "preflight capacity for both slots, write slot 1 only",
  ],
  [
    "target=2",
    "reserve initial slot 2",
    "slot=2,retry=null",
    "required before any start",
  ],
  [
    "target=2",
    "start/authorize",
    "lowest unresolved slot or its retry",
    "sole dispatch lane",
  ],
  [
    "target=2",
    "slot 1 valid",
    "candidate materialized",
    "required before slot 2 start",
  ],
  [
    "target=2",
    "slot 1 invalid/refused/exhausted",
    "release later slots by attempt UUID",
    "retry_superseded",
  ],
  [
    "takeover",
    "released_takeover unresolved slot",
    "new null-retry replacement",
    "one replacement per slot",
  ],
  [
    "takeover",
    "worker-released/cancelled/dispatched/result-bearing slot",
    "replacement",
    "deny",
  ],
  [
    "retry",
    "same terminal failed slot",
    "one immediate retry row",
    "may replace current slot only",
  ],
] as const;

const phase7InvocationVectors = [
  [
    "reserved_pre_dispatch",
    "start",
    "dispatch_ready",
    "attempt_dispatch_prepared",
    "no invocation authority",
  ],
  [
    "dispatch_ready",
    "authorize commits",
    "dispatch_started",
    "attempt_dispatch_started",
    "authorized_now; invoke once",
  ],
  [
    "dispatch_started",
    "same attempt/digest replay",
    "dispatch_started",
    "no event",
    "already_authorized; do not invoke",
  ],
  [
    "dispatch_ready",
    "authorization denial",
    "dispatch_ready",
    "no event",
    "zero provider calls",
  ],
  [
    "exception or missing/other status",
    "orchestrator",
    "unchanged",
    "no event",
    "zero provider calls",
  ],
  [
    "replay purpose",
    "reserve/start/authorize/reconcile/release",
    "deny",
    "no event",
    "zero attempts/calls/tokens/time/cost",
  ],
] as const;

const phase7TakeoverCancellationDrainVectors = [
  {
    operation: "takeover-all-pre-invocation",
    inputs: ["reserved_pre_dispatch", "dispatch_ready"],
    perAttempt: [
      "released_takeover",
      "full vector released",
      "attempt_released",
      "release_mode=takeover",
    ],
    terminal: "after all releases, increment epoch and append lease_acquired",
  },
  {
    operation: "takeover-mixed",
    ordering: "ascending unsigned attempt UUID",
    preInvocation: [
      "released_takeover",
      "full vector released",
      "attempt_released",
    ],
    dispatched: [
      "indeterminate_quarantined",
      "candidate-only release",
      "attempt_indeterminate",
      "takeover_after_dispatch",
    ],
    aggregate:
      "one indeterminate_quarantined event after all per-attempt events; exact released/charged subsequences, component sums, source head, prior/fenced epochs, count/range, settlement hash",
    terminal:
      "failed, epoch+1, lease cleared, terminalized_indeterminate, no lease_acquired",
  },
  {
    operation: "tenant-cancel",
    ordering: "ascending unsigned attempt UUID",
    preInvocation: [
      "cancelled_released",
      "full vector released",
      "attempt_cancelled_released",
    ],
    dispatched: [
      "cancelled_charged",
      "candidate-only release",
      "attempt_cancelled_charged",
      "no reason_code",
    ],
    terminal:
      "after zero outstanding, epoch+1, lease cleared, run_cancelled, six durable tenant-cancel fields plus digest-bound audit",
  },
  {
    operation: "retention-drain",
    ordering: "ascending unsigned attempt UUID",
    preInvocation: [
      "cancelled_released",
      "full vector released",
      "attempt_cancelled_released",
    ],
    dispatched: [
      "cancelled_charged",
      "candidate-only release",
      "attempt_cancelled_charged",
      "no reason_code",
    ],
    terminal:
      "after zero outstanding, epoch+1, lease cleared, run_cleanup_cancelled, drain proof and audit",
  },
  {
    operation: "same-operation-retry",
    outcome: "no duplicate settlement/event/charge/DML",
  },
] as const;

const phase7ReplayGrammarVectors = {
  baseSequences: [
    ["planner_output", "candidate_output", "reviewer_verdict_set"],
    [
      "planner_output",
      "candidate_output",
      "candidate_output",
      "reviewer_verdict_set",
    ],
    [
      "planner_output",
      "specialist_output",
      "candidate_output",
      "reviewer_verdict_set",
    ],
    [
      "planner_output",
      "specialist_output",
      "candidate_output",
      "candidate_output",
      "reviewer_verdict_set",
    ],
    [
      "planner_output",
      "candidate_invalid",
      "repair_output",
      "reviewer_verdict_set",
    ],
    [
      "planner_output",
      "specialist_output",
      "candidate_invalid",
      "repair_output",
      "reviewer_verdict_set",
    ],
  ],
  retryInsertion: {
    kinds: ["planner", "generator"],
    insertedKind: "failure",
    adjacency: "immediately before the same kind's ordinary grammar result",
    maximum: 1,
    totalResultCount: [3, 5],
  },
  rejects: [
    "zero, one, or two results",
    "more than five results",
    "noncontiguous sequence",
    "wrong kind or order",
    "more than one retry failure",
    "specialist/repair/reviewer retry",
    "source head drift",
    "candidate count or specialist presence differing from Brief",
    "reviewer verdict set not exactly covering result-derived candidates",
    "source state other than approval_required",
    "rejected, abstained, failed, cancelled, or expired source",
  ],
  consume:
    "clone exact source bundle/membership and Brief first; copy one exact source result per sequence; exact same sequence/hash retry no-op; final consume moves planning to generating; never touches attempts or counters",
} as const;

const phase7RetentionContract = {
  clearColumns: {
    agent_runs: [
      "request_payload_id",
      "candidate_set_sha256",
      "terminal_reason_sha256",
      "selected_candidate_id",
      "consumed_replay_sequence",
      "consumed_replay_sha256",
      "terminal_claim_input_sha256",
      "terminal_operation_sha256",
    ],
    agent_run_events: [
      "event_payload_id",
      "claim_input_sha256",
      "claim_result_sha256",
      "claim_result_attempt_token",
      "claim_result_input_sha256",
    ],
    agent_run_checkpoints: ["state_sha256", "checkpoint_payload_id"],
    agent_run_attempts: [
      "request_payload_id",
      "result_payload_id",
      "terminal_reason_sha256",
    ],
  },
  contentDelete: [
    "agent_run_request_payloads",
    "agent_run_event_payloads",
    "agent_run_checkpoint_payloads",
    "agent_run_attempt_payloads",
    "agent_candidate_payloads",
    "agent_recorded_results",
    "field_catalog_entries",
    "field_catalog_snapshots",
    "agent_run_calculation_meters",
    "calculation_results",
    "calculation_graphs",
    "metric_contract_versions",
    "candidate_evidence_manifests",
    "claim_evidence",
    "claims",
    "agent_validation_findings",
    "agent_candidates",
    "candidate_comparison_bundle_evidence",
    "candidate_comparison_bundles",
    "briefs",
    "run_abstentions",
  ],
  ageOutDelete: [
    "agent_run_attempts",
    "agent_run_budget_counters",
    "agent_run_checkpoints",
    "agent_run_events",
    "dashboard_agent_drain_proof_consumptions",
    "dashboard_agent_drain_proofs",
    "agent_runs",
  ],
  purgeDag: [
    ["candidate_evidence_manifests"],
    ["claim_evidence", "claims", "agent_validation_findings"],
    ["agent_candidate_payloads", "agent_candidates"],
    [
      "agent_run_calculation_meters",
      "calculation_results",
      "calculation_graphs",
    ],
    ["briefs", "run_abstentions"],
    ["candidate_comparison_bundle_evidence", "candidate_comparison_bundles"],
    ["agent_recorded_results"],
    [
      "agent_run_request_payloads",
      "agent_run_attempt_payloads",
      "agent_run_checkpoint_payloads",
      "agent_run_event_payloads",
    ],
    [
      "metric_contract_versions",
      "field_catalog_entries",
      "field_catalog_snapshots",
    ],
  ],
  ageOutDag: [
    "agent_run_attempts",
    "agent_run_checkpoints",
    "agent_run_budget_counters",
    "agent_run_events",
    "dashboard_agent_drain_proof_consumptions",
    "dashboard_agent_drain_proofs",
    "agent_runs",
  ],
  retainedChainDomain: "dasher.agent-run-retained-chain-set.v1\0",
  retainedChainOrder:
    "organization UUID,dashboard UUID,lifecycle revision,eligible run count,then every run sorted by uuid_send(run_id): run UUID,current event sequence,current event SHA byte string",
  metadataAgeMillis: 365 * 24 * 60 * 60 * 1000,
} as const;

const phase7ProofDomains = {
  eventRange: "dasher.agent-run-drain-event-range.v1\0",
  drainRequest: "dasher.agent-run-drain-request.v1\0",
  drainProof: "dasher.agent-run-drain-proof.v1\0",
  drainConsumption: "dasher.agent-run-drain-consumption.v1\0",
  cleanupCompletion: "dasher.dashboard-cleanup-completion.v1\0",
  ageOutSource: "dasher.agent-run-age-out-source.v1\0",
  ageOutProof: "dasher.agent-run-age-out-proof.v1\0",
} as const;

type Phase7ProofFieldEncoding =
  | "uuid"
  | "i64"
  | "timestamp"
  | "text"
  | "sha-byte-string"
  | "nullable-uuid"
  | "nullable-i64"
  | "nullable-sha-byte-string";

type Phase7ProofFieldFixture = readonly [
  name: string,
  encoding: Phase7ProofFieldEncoding,
  input: string | null,
  encodedHex: string,
];

type Phase7ProofByteVector = {
  domain: string;
  fields: readonly Phase7ProofFieldFixture[];
  preimageHex: string;
  sha256: string;
  oneBitMutation: {
    byteOffset: number;
    xorMask: number;
    sha256: string;
  };
  crossDomain: { domain: string; sha256: string };
};

const phase7RetentionProofByteVectors = {
  eventRange: {
    domain: phase7ProofDomains.eventRange,
    fields: [
      ["event_count", "i64", "2", "0000000000000002"],
      [
        "event_1_run_id",
        "uuid",
        "00000000-0000-8000-8000-0000000000ff",
        "000000000000800080000000000000ff",
      ],
      ["event_1_sequence", "i64", "1", "0000000000000001"],
      [
        "event_1_sha256",
        "sha-byte-string",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "000000201111111111111111111111111111111111111111111111111111111111111111",
      ],
      [
        "event_2_run_id",
        "uuid",
        "00000000-0000-8000-8000-000000000100",
        "00000000000080008000000000000100",
      ],
      ["event_2_sequence", "i64", "2", "0000000000000002"],
      [
        "event_2_sha256",
        "sha-byte-string",
        "2222222222222222222222222222222222222222222222222222222222222222",
        "000000202222222222222222222222222222222222222222222222222222222222222222",
      ],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d647261696e2d6576656e742d72616e67652e7631000000000000000002000000000000800080000000000000ff0000000000000001000000201111111111111111111111111111111111111111111111111111111111111111000000000000800080000000000001000000000000000002000000202222222222222222222222222222222222222222222222222222222222222222",
    sha256: "ae90f3e341a4d5cb1789a8e50d5cdbc825acb5c76a5bc0928fa0372f1d67db29",
    oneBitMutation: {
      byteOffset: 165,
      xorMask: 0x01,
      sha256:
        "3f86aef1392504b904a86eaf426739437e7e1652a23b6bcf7bb085d36e19b967",
    },
    crossDomain: {
      domain: phase7ProofDomains.drainRequest,
      sha256:
        "c9f1b0d3aa15d084f9ea80a10253ab715bfeea262b27fe85150d2e0db46128de",
    },
  },
  drainRequest: {
    domain: phase7ProofDomains.drainRequest,
    fields: [
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["expected_lifecycle_revision", "i64", "7", "0000000000000007"],
      [
        "operation_id",
        "uuid",
        "00000000-0000-8000-8000-000000000401",
        "00000000000080008000000000000401",
      ],
      ["deployment_revision", "text", "task9-r2", "000000087461736b392d7232"],
      [
        "target_organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "coordination_step",
        "text",
        "drain_and_cancel",
        "00000010647261696e5f616e645f63616e63656c",
      ],
      [
        "cleanup_lease_owner",
        "text",
        "retention-worker-01",
        "00000013726574656e74696f6e2d776f726b65722d3031",
      ],
      [
        "cleanup_lease_expires_at",
        "timestamp",
        "2026-08-05T12:30:00.000000Z",
        "0006584bee0ec200",
      ],
      [
        "retention_principal_id",
        "uuid",
        "00000000-0000-8000-8000-000000000402",
        "00000000000080008000000000000402",
      ],
      ["retention_principal_revision", "i64", "3", "0000000000000003"],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d647261696e2d726571756573742e76310000000000000080008000000000000002000000000000000700000000000080008000000000000401000000087461736b392d72320000000000008000800000000000000100000010647261696e5f616e645f63616e63656c00000013726574656e74696f6e2d776f726b65722d30310006584bee0ec200000000000000800080000000000004020000000000000003",
    sha256: "411a12a68b486c408286ff0e7b42d0e90e121a5df5ce115ff732f5fa8c06acfa",
    oneBitMutation: {
      byteOffset: 176,
      xorMask: 0x01,
      sha256:
        "42dca3125c6c16ef977a1e786d7381a52ae680a3c5ddee4e15b937388721f860",
    },
    crossDomain: {
      domain: phase7ProofDomains.drainProof,
      sha256:
        "1e9e7628f7f94edc504def78268e7b21d8925668d8eb6248552c8dce01dfccf5",
    },
  },
  drainProof: {
    domain: phase7ProofDomains.drainProof,
    fields: [
      [
        "drain_request_proof_sha256",
        "sha-byte-string",
        "411a12a68b486c408286ff0e7b42d0e90e121a5df5ce115ff732f5fa8c06acfa",
        "00000020411a12a68b486c408286ff0e7b42d0e90e121a5df5ce115ff732f5fa8c06acfa",
      ],
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["expected_lifecycle_revision", "i64", "7", "0000000000000007"],
      [
        "operation_id",
        "uuid",
        "00000000-0000-8000-8000-000000000401",
        "00000000000080008000000000000401",
      ],
      ["deployment_revision", "text", "task9-r2", "000000087461736b392d7232"],
      [
        "target_organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "coordination_step",
        "text",
        "drain_and_cancel",
        "00000010647261696e5f616e645f63616e63656c",
      ],
      [
        "cleanup_lease_owner",
        "text",
        "retention-worker-01",
        "00000013726574656e74696f6e2d776f726b65722d3031",
      ],
      [
        "cleanup_lease_expires_at",
        "timestamp",
        "2026-08-05T12:30:00.000000Z",
        "0006584bee0ec200",
      ],
      [
        "retention_principal_id",
        "uuid",
        "00000000-0000-8000-8000-000000000402",
        "00000000000080008000000000000402",
      ],
      ["retention_principal_revision", "i64", "3", "0000000000000003"],
      ["pre_drain_run_count", "i64", "2", "0000000000000002"],
      ["cancelled_run_count", "i64", "2", "0000000000000002"],
      ["released_attempt_count", "i64", "1", "0000000000000001"],
      ["charged_attempt_count", "i64", "1", "0000000000000001"],
      ["remaining_nonterminal_run_count", "i64", "0", "0000000000000000"],
      ["remaining_claimed_run_count", "i64", "0", "0000000000000000"],
      [
        "first_event_run_id",
        "nullable-uuid",
        "00000000-0000-8000-8000-0000000000ff",
        "01000000000000800080000000000000ff",
      ],
      ["first_event_sequence", "nullable-i64", "1", "010000000000000001"],
      [
        "first_event_sha256",
        "nullable-sha-byte-string",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "01000000201111111111111111111111111111111111111111111111111111111111111111",
      ],
      [
        "last_event_run_id",
        "nullable-uuid",
        "00000000-0000-8000-8000-000000000100",
        "0100000000000080008000000000000100",
      ],
      ["last_event_sequence", "nullable-i64", "2", "010000000000000002"],
      [
        "last_event_sha256",
        "nullable-sha-byte-string",
        "2222222222222222222222222222222222222222222222222222222222222222",
        "01000000202222222222222222222222222222222222222222222222222222222222222222",
      ],
      ["event_count", "i64", "2", "0000000000000002"],
      [
        "event_range_sha256",
        "sha-byte-string",
        "ae90f3e341a4d5cb1789a8e50d5cdbc825acb5c76a5bc0928fa0372f1d67db29",
        "00000020ae90f3e341a4d5cb1789a8e50d5cdbc825acb5c76a5bc0928fa0372f1d67db29",
      ],
      [
        "generated_at",
        "timestamp",
        "2026-08-05T12:10:00.000000Z",
        "0006584ba6883600",
      ],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d647261696e2d70726f6f662e76310000000020411a12a68b486c408286ff0e7b42d0e90e121a5df5ce115ff732f5fa8c06acfa00000000000080008000000000000002000000000000000700000000000080008000000000000401000000087461736b392d72320000000000008000800000000000000100000010647261696e5f616e645f63616e63656c00000013726574656e74696f6e2d776f726b65722d30310006584bee0ec20000000000000080008000000000000402000000000000000300000000000000020000000000000002000000000000000100000000000000010000000000000000000000000000000001000000000000800080000000000000ff01000000000000000101000000201111111111111111111111111111111111111111111111111111111111111111010000000000008000800000000000010001000000000000000201000000202222222222222222222222222222222222222222222222222222222222222222000000000000000200000020ae90f3e341a4d5cb1789a8e50d5cdbc825acb5c76a5bc0928fa0372f1d67db290006584ba6883600",
    sha256: "9eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c87",
    oneBitMutation: {
      byteOffset: 436,
      xorMask: 0x01,
      sha256:
        "c620c9b6f38a42b40dd0eaddd44fc5782f0637801cec37cb386bbed0b16ce45f",
    },
    crossDomain: {
      domain: phase7ProofDomains.drainConsumption,
      sha256:
        "fa2ecdd517e7f56ae03a590dc67163bc9a383360098d9ae841a4dd0a9b6cb37a",
    },
  },
  drainConsumption: {
    domain: phase7ProofDomains.drainConsumption,
    fields: [
      [
        "organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      [
        "proof_id",
        "uuid",
        "00000000-0000-8000-8000-000000000401",
        "00000000000080008000000000000401",
      ],
      ["lifecycle_revision", "i64", "7", "0000000000000007"],
      [
        "drain_proof_sha256",
        "sha-byte-string",
        "9eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c87",
        "000000209eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c87",
      ],
      [
        "preceding_cleanup_attempt_id",
        "uuid",
        "00000000-0000-8000-8000-000000000401",
        "00000000000080008000000000000401",
      ],
      [
        "preceding_cleanup_lease_owner",
        "text",
        "retention-worker-01",
        "00000013726574656e74696f6e2d776f726b65722d3031",
      ],
      [
        "preceding_cleanup_lease_expires_at",
        "timestamp",
        "2026-08-05T12:30:00.000000Z",
        "0006584bee0ec200",
      ],
      [
        "new_cleanup_lease_owner",
        "text",
        "retention-worker-02",
        "00000013726574656e74696f6e2d776f726b65722d3032",
      ],
      [
        "new_cleanup_lease_expires_at",
        "timestamp",
        "2026-08-05T13:00:00.000000Z",
        "0006584c59589400",
      ],
      [
        "claim_event_and_audit_id",
        "uuid",
        "00000000-0000-8000-8000-000000000403",
        "00000000000080008000000000000403",
      ],
      [
        "consumed_at",
        "timestamp",
        "2026-08-05T12:35:00.000000Z",
        "0006584bfff06500",
      ],
      [
        "retention_principal_id",
        "uuid",
        "00000000-0000-8000-8000-000000000402",
        "00000000000080008000000000000402",
      ],
      ["retention_principal_revision", "i64", "3", "0000000000000003"],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d647261696e2d636f6e73756d7074696f6e2e7631000000000000008000800000000000000100000000000080008000000000000002000000000000800080000000000004010000000000000007000000209eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c870000000000008000800000000000040100000013726574656e74696f6e2d776f726b65722d30310006584bee0ec20000000013726574656e74696f6e2d776f726b65722d30320006584c59589400000000000000800080000000000004030006584bfff06500000000000000800080000000000004020000000000000003",
    sha256: "752362a3085b9155e490912e5db592e1074025a2418448b58a7b85074990c487",
    oneBitMutation: {
      byteOffset: 255,
      xorMask: 0x01,
      sha256:
        "114f0dc9be2f3d5e319beb1b963e945f10192f94f1fbebd103f3c16f225c433e",
    },
    crossDomain: {
      domain: phase7ProofDomains.cleanupCompletion,
      sha256:
        "021b2ab98a38c7e4099068b00fa837ee1eeef54ce4c55dfca4009a19ba17d3e6",
    },
  },
  cleanupCompletion: {
    domain: phase7ProofDomains.cleanupCompletion,
    fields: [
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["lifecycle_revision", "i64", "7", "0000000000000007"],
      [
        "cleanup_attempt_id",
        "uuid",
        "00000000-0000-8000-8000-000000000401",
        "00000000000080008000000000000401",
      ],
      [
        "step",
        "text",
        "drain_and_cancel",
        "00000010647261696e5f616e645f63616e63656c",
      ],
      ["result", "text", "succeeded", "00000009737563636565646564"],
      ["released_claim_count", "i64", "2", "0000000000000002"],
      ["deleted_resource_count", "i64", "0", "0000000000000000"],
      ["deferred_claim_count", "i64", "0", "0000000000000000"],
      [
        "latest_unconsumed_drain_proof_sha256",
        "nullable-sha-byte-string",
        "9eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c87",
        "01000000209eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c87",
      ],
      [
        "target_organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "cleanup_lease_owner",
        "text",
        "retention-worker-01",
        "00000013726574656e74696f6e2d776f726b65722d3031",
      ],
      [
        "retention_principal_id",
        "uuid",
        "00000000-0000-8000-8000-000000000402",
        "00000000000080008000000000000402",
      ],
      ["retention_principal_revision", "i64", "3", "0000000000000003"],
    ],
    preimageHex:
      "6461736865722e64617368626f6172642d636c65616e75702d636f6d706c6574696f6e2e7631000000000000008000800000000000000200000000000000070000000000008000800000000000040100000010647261696e5f616e645f63616e63656c0000000973756363656564656400000000000000020000000000000000000000000000000001000000209eb8f292261818602b332dac48ef45e58818fb14e9a5fbafe156ff1a0f185c870000000000008000800000000000000100000013726574656e74696f6e2d776f726b65722d3031000000000000800080000000000004020000000000000003",
    sha256: "2a604664d53721783fa9ae78e42aab3ad5c8797787871dc51d06f827ed3ec10f",
    oneBitMutation: {
      byteOffset: 235,
      xorMask: 0x01,
      sha256:
        "9475cfa2180d0040badc9488867f469392b2e3b1831e584632e8b0c766dcba96",
    },
    crossDomain: {
      domain: phase7ProofDomains.ageOutSource,
      sha256:
        "114050a2a382de55d1b1d94f102168079894e330dccfa49d79af2e92f37b3d21",
    },
  },
  ageOutSource: {
    domain: phase7ProofDomains.ageOutSource,
    fields: [
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["expected_lifecycle_revision", "i64", "7", "0000000000000007"],
      [
        "tombstone_lineage_id",
        "uuid",
        "00000000-0000-8000-8000-000000000501",
        "00000000000080008000000000000501",
      ],
      [
        "purged_at",
        "timestamp",
        "2025-08-05T12:00:00.000000Z",
        "00063b9cf6b11000",
      ],
      ["backup_ledger_sequence", "i64", "9", "0000000000000009"],
      [
        "backup_ledger_event_kind",
        "text",
        "backup.deleted",
        "0000000e6261636b75702e64656c65746564",
      ],
      [
        "backup_ledger_proof_sha256",
        "sha-byte-string",
        "7777777777777777777777777777777777777777777777777777777777777777",
        "000000207777777777777777777777777777777777777777777777777777777777777777",
      ],
      [
        "operation_id",
        "uuid",
        "00000000-0000-8000-8000-000000000502",
        "00000000000080008000000000000502",
      ],
      ["deployment_revision", "text", "task9-r2", "000000087461736b392d7232"],
      [
        "target_organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d6167652d6f75742d736f757263652e7631000000000000008000800000000000000200000000000000070000000000008000800000000000050100063b9cf6b1100000000000000000090000000e6261636b75702e64656c6574656400000020777777777777777777777777777777777777777777777777777777777777777700000000000080008000000000000502000000087461736b392d723200000000000080008000000000000001",
    sha256: "f383432549694bd101c72f974db65cef7abe42a8baf179a8411c85dfc10a47cf",
    oneBitMutation: {
      byteOffset: 188,
      xorMask: 0x01,
      sha256:
        "284940a72a86cccfeff7da4793758d16a4a545fe86f5a0da7424268fb45269ce",
    },
    crossDomain: {
      domain: phase7ProofDomains.ageOutProof,
      sha256:
        "7f6a31dc163ea57cb4887767f01d1dd4c775e60dfe75454eeabd1efd3b1199e7",
    },
  },
  ageOutProof: {
    domain: phase7ProofDomains.ageOutProof,
    fields: [
      [
        "source_purge_proof_sha256",
        "sha-byte-string",
        "f383432549694bd101c72f974db65cef7abe42a8baf179a8411c85dfc10a47cf",
        "00000020f383432549694bd101c72f974db65cef7abe42a8baf179a8411c85dfc10a47cf",
      ],
      ["eligible_run_count", "i64", "0", "0000000000000000"],
      ["deleted_run_count", "i64", "0", "0000000000000000"],
      ["deleted_event_count", "i64", "0", "0000000000000000"],
      ["deleted_checkpoint_count", "i64", "0", "0000000000000000"],
      ["deleted_attempt_count", "i64", "0", "0000000000000000"],
      ["deleted_counter_count", "i64", "0", "0000000000000000"],
      ["deleted_drain_proof_consumption_count", "i64", "0", "0000000000000000"],
      ["deleted_drain_proof_count", "i64", "0", "0000000000000000"],
      [
        "retained_chain_head_sha256",
        "sha-byte-string",
        "a8b3b09eb0dff776b9d1f8f7597ac89d5dc58f08af12d7b1a98dabf4bb4867d2",
        "00000020a8b3b09eb0dff776b9d1f8f7597ac89d5dc58f08af12d7b1a98dabf4bb4867d2",
      ],
      ["retained_event_count", "i64", "0", "0000000000000000"],
      [
        "deleted_at",
        "timestamp",
        "2026-08-05T12:00:00.000000Z",
        "0006584b82c4f000",
      ],
      [
        "retention_principal_id",
        "uuid",
        "00000000-0000-8000-8000-000000000402",
        "00000000000080008000000000000402",
      ],
      ["retention_principal_revision", "i64", "3", "0000000000000003"],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d6167652d6f75742d70726f6f662e76310000000020f383432549694bd101c72f974db65cef7abe42a8baf179a8411c85dfc10a47cf0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020a8b3b09eb0dff776b9d1f8f7597ac89d5dc58f08af12d7b1a98dabf4bb4867d200000000000000000006584b82c4f000000000000000800080000000000004020000000000000003",
    sha256: "4e49c48f45d8ee01214442040de60ef96600bc81ff63d1729fbea059986c98e9",
    oneBitMutation: {
      byteOffset: 209,
      xorMask: 0x01,
      sha256:
        "fdf793e59551fbbcb3aaa69918989af08bf96a3c38c22e81d3eaf5c86541516a",
    },
    crossDomain: {
      domain: phase7ProofDomains.eventRange,
      sha256:
        "5c045e63c13dbdc8355001c3c9462103a4995a404bccec6755935e8acca31560",
    },
  },
} as const satisfies Record<
  keyof typeof phase7ProofDomains,
  Phase7ProofByteVector
>;

const phase7RetentionProofBoundaryVectors = {
  zeroEventRange: {
    domain: phase7ProofDomains.eventRange,
    fields: [["event_count", "i64", "0", "0000000000000000"]],
    preimageHex:
      "6461736865722e6167656e742d72756e2d647261696e2d6576656e742d72616e67652e7631000000000000000000",
    sha256: "fd2e25fd34095de30fddd1db8e871ae765e91f19c5e5eca69370c342bd043c6c",
    boundary: {
      eventCount: 0,
      firstEvent: null,
      lastEvent: null,
    },
  },
  zeroDrainProof: {
    domain: phase7ProofDomains.drainProof,
    fields: [
      ...phase7RetentionProofByteVectors.drainProof.fields.slice(0, 11),
      ["pre_drain_run_count", "i64", "0", "0000000000000000"],
      ["cancelled_run_count", "i64", "0", "0000000000000000"],
      ["released_attempt_count", "i64", "0", "0000000000000000"],
      ["charged_attempt_count", "i64", "0", "0000000000000000"],
      ["remaining_nonterminal_run_count", "i64", "0", "0000000000000000"],
      ["remaining_claimed_run_count", "i64", "0", "0000000000000000"],
      ["first_event_run_id", "nullable-uuid", null, "00"],
      ["first_event_sequence", "nullable-i64", null, "00"],
      ["first_event_sha256", "nullable-sha-byte-string", null, "00"],
      ["last_event_run_id", "nullable-uuid", null, "00"],
      ["last_event_sequence", "nullable-i64", null, "00"],
      ["last_event_sha256", "nullable-sha-byte-string", null, "00"],
      ["event_count", "i64", "0", "0000000000000000"],
      [
        "event_range_sha256",
        "sha-byte-string",
        "fd2e25fd34095de30fddd1db8e871ae765e91f19c5e5eca69370c342bd043c6c",
        "00000020fd2e25fd34095de30fddd1db8e871ae765e91f19c5e5eca69370c342bd043c6c",
      ],
      [
        "generated_at",
        "timestamp",
        "2026-08-05T12:10:00.000000Z",
        "0006584ba6883600",
      ],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d647261696e2d70726f6f662e76310000000020411a12a68b486c408286ff0e7b42d0e90e121a5df5ce115ff732f5fa8c06acfa00000000000080008000000000000002000000000000000700000000000080008000000000000401000000087461736b392d72320000000000008000800000000000000100000010647261696e5f616e645f63616e63656c00000013726574656e74696f6e2d776f726b65722d30310006584bee0ec200000000000000800080000000000004020000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020fd2e25fd34095de30fddd1db8e871ae765e91f19c5e5eca69370c342bd043c6c0006584ba6883600",
    sha256: "7d496c70e8a28409fbee31bc61234b8254d9cb0b5cb24b1f7c6a616b57d8f70d",
  },
  cleanupWithoutDrain: {
    domain: phase7ProofDomains.cleanupCompletion,
    fields: [
      ...phase7RetentionProofByteVectors.cleanupCompletion.fields.slice(0, 8),
      [
        "latest_unconsumed_drain_proof_sha256",
        "nullable-sha-byte-string",
        null,
        "00",
      ],
      ...phase7RetentionProofByteVectors.cleanupCompletion.fields.slice(9),
    ],
    preimageHex:
      "6461736865722e64617368626f6172642d636c65616e75702d636f6d706c6574696f6e2e7631000000000000008000800000000000000200000000000000070000000000008000800000000000040100000010647261696e5f616e645f63616e63656c00000009737563636565646564000000000000000200000000000000000000000000000000000000000000008000800000000000000100000013726574656e74696f6e2d776f726b65722d3031000000000000800080000000000004020000000000000003",
    sha256: "e572098e1b0681dc12fdaf2cf239e9ece1d78b6816acc29a4845f06e646bcccd",
  },
  nonzeroAgeOutProof: {
    domain: phase7ProofDomains.ageOutProof,
    fields: [
      phase7RetentionProofByteVectors.ageOutProof.fields[0],
      ["eligible_run_count", "i64", "2", "0000000000000002"],
      ["deleted_run_count", "i64", "2", "0000000000000002"],
      ["deleted_event_count", "i64", "3", "0000000000000003"],
      ["deleted_checkpoint_count", "i64", "2", "0000000000000002"],
      ["deleted_attempt_count", "i64", "2", "0000000000000002"],
      ["deleted_counter_count", "i64", "4", "0000000000000004"],
      ["deleted_drain_proof_consumption_count", "i64", "1", "0000000000000001"],
      ["deleted_drain_proof_count", "i64", "2", "0000000000000002"],
      [
        "retained_chain_head_sha256",
        "sha-byte-string",
        "4edf1f9997fce3147da9bebe95b57d68606e5c2636721ed44b0247476ebb8a8e",
        "000000204edf1f9997fce3147da9bebe95b57d68606e5c2636721ed44b0247476ebb8a8e",
      ],
      ["retained_event_count", "i64", "3", "0000000000000003"],
      ...phase7RetentionProofByteVectors.ageOutProof.fields.slice(11),
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d6167652d6f75742d70726f6f662e76310000000020f383432549694bd101c72f974db65cef7abe42a8baf179a8411c85dfc10a47cf00000000000000020000000000000002000000000000000300000000000000020000000000000002000000000000000400000000000000010000000000000002000000204edf1f9997fce3147da9bebe95b57d68606e5c2636721ed44b0247476ebb8a8e00000000000000030006584b82c4f000000000000000800080000000000004020000000000000003",
    sha256: "e0efbd7598e745c421271551afe85b257a9a4fac4b914cb298c0eac37d1c93a7",
  },
} as const;

const phase7RetainedChainSetByteVectors = {
  zeroRuns: {
    physicalInsertionOrder: [],
    canonicalRunOrder: [],
    fields: [
      [
        "organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["lifecycle_revision", "i64", "7", "0000000000000007"],
      ["eligible_run_count", "i64", "0", "0000000000000000"],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000000",
    sha256: "a8b3b09eb0dff776b9d1f8f7597ac89d5dc58f08af12d7b1a98dabf4bb4867d2",
    retainedEventCount: "0",
  },
  oneRun: {
    physicalInsertionOrder: ["00000000-0000-8000-8000-0000000000ff"],
    canonicalRunOrder: ["00000000-0000-8000-8000-0000000000ff"],
    fields: [
      [
        "organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["lifecycle_revision", "i64", "7", "0000000000000007"],
      ["eligible_run_count", "i64", "1", "0000000000000001"],
      [
        "run_1_id",
        "uuid",
        "00000000-0000-8000-8000-0000000000ff",
        "000000000000800080000000000000ff",
      ],
      ["run_1_current_event_sequence", "i64", "1", "0000000000000001"],
      [
        "run_1_current_event_sha256",
        "sha-byte-string",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "000000201111111111111111111111111111111111111111111111111111111111111111",
      ],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000001000000000000800080000000000000ff0000000000000001000000201111111111111111111111111111111111111111111111111111111111111111",
    sha256: "179b076af2264ec54e377e718ea6e36121594f5569ae58fc9e1e5165ba9814d8",
    retainedEventCount: "1",
  },
  multipleRuns: {
    physicalInsertionOrder: [
      "00000000-0000-8000-8000-000000000100",
      "00000000-0000-8000-8000-0000000000ff",
    ],
    canonicalRunOrder: [
      "00000000-0000-8000-8000-0000000000ff",
      "00000000-0000-8000-8000-000000000100",
    ],
    fields: [
      [
        "organization_id",
        "uuid",
        "00000000-0000-8000-8000-000000000001",
        "00000000000080008000000000000001",
      ],
      [
        "dashboard_id",
        "uuid",
        "00000000-0000-8000-8000-000000000002",
        "00000000000080008000000000000002",
      ],
      ["lifecycle_revision", "i64", "7", "0000000000000007"],
      ["eligible_run_count", "i64", "2", "0000000000000002"],
      [
        "run_1_id",
        "uuid",
        "00000000-0000-8000-8000-0000000000ff",
        "000000000000800080000000000000ff",
      ],
      ["run_1_current_event_sequence", "i64", "1", "0000000000000001"],
      [
        "run_1_current_event_sha256",
        "sha-byte-string",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "000000201111111111111111111111111111111111111111111111111111111111111111",
      ],
      [
        "run_2_id",
        "uuid",
        "00000000-0000-8000-8000-000000000100",
        "00000000000080008000000000000100",
      ],
      ["run_2_current_event_sequence", "i64", "2", "0000000000000002"],
      [
        "run_2_current_event_sha256",
        "sha-byte-string",
        "2222222222222222222222222222222222222222222222222222222222222222",
        "000000202222222222222222222222222222222222222222222222222222222222222222",
      ],
    ],
    preimageHex:
      "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000002000000000000800080000000000000ff0000000000000001000000201111111111111111111111111111111111111111111111111111111111111111000000000000800080000000000001000000000000000002000000202222222222222222222222222222222222222222222222222222222222222222",
    sha256: "4edf1f9997fce3147da9bebe95b57d68606e5c2636721ed44b0247476ebb8a8e",
    retainedEventCount: "3",
  },
} as const;

type Phase7RetainedChainDenial = {
  id: string;
  baseline: keyof typeof phase7RetainedChainSetByteVectors;
  mutation:
    | {
        kind: "replace_field";
        field: string;
        fromInput: string;
        toInput: string;
        fromEncodedHex: string;
        toEncodedHex: string;
      }
    | {
        kind: "reverse_run_tuples";
        fields: readonly [
          "run_1_id",
          "run_1_current_event_sequence",
          "run_1_current_event_sha256",
          "run_2_id",
          "run_2_current_event_sequence",
          "run_2_current_event_sha256",
        ];
      }
    | {
        kind: "proof_count_drift";
        field: "retained_event_count";
        fromInput: string;
        toInput: string;
        fromEncodedHex: string;
        toEncodedHex: string;
      }
    | {
        kind: "event_snapshot_drift";
        path: string;
        from: string;
        to: string;
      }
    | {
        kind: "checked_add_overflow";
        field: "retained_event_count";
        addends: readonly string[];
        runSequenceMutations: readonly {
          field: string;
          fromInput: string;
          toInput: string;
          fromEncodedHex: string;
          toEncodedHex: string;
        }[];
        signed64Maximum: "9223372036854775807";
      };
  expected: {
    outcome: "reject";
    reason: string;
    hashBehavior:
      | {
          kind: "digest_mismatch";
          canonicalSha256: string;
          mutatedPreimageHex: string;
          mutatedSha256: string;
        }
      | {
          kind: "digest_unchanged_count_mismatch";
          canonicalSha256: string;
        }
      | { kind: "validation_before_hash"; hashAttempted: false }
      | { kind: "overflow_before_hash"; hashAttempted: false };
  };
};

const phase7RetainedChainEventSnapshots = {
  zeroRuns: [],
  oneRun: [
    {
      runId: "00000000-0000-8000-8000-0000000000ff",
      currentEventSequence: "1",
      currentEventSha256: "11".repeat(32),
      eventHeaders: [
        {
          eventSequence: "1",
          priorEventSequence: null,
          priorEventSha256: null,
          eventSha256: "11".repeat(32),
        },
      ],
    },
  ],
  multipleRuns: [
    {
      runId: "00000000-0000-8000-8000-0000000000ff",
      currentEventSequence: "1",
      currentEventSha256: "11".repeat(32),
      eventHeaders: [
        {
          eventSequence: "1",
          priorEventSequence: null,
          priorEventSha256: null,
          eventSha256: "11".repeat(32),
        },
      ],
    },
    {
      runId: "00000000-0000-8000-8000-000000000100",
      currentEventSequence: "2",
      currentEventSha256: "22".repeat(32),
      eventHeaders: [
        {
          eventSequence: "1",
          priorEventSequence: null,
          priorEventSha256: null,
          eventSha256: "33".repeat(32),
        },
        {
          eventSequence: "2",
          priorEventSequence: "1",
          priorEventSha256: "33".repeat(32),
          eventSha256: "22".repeat(32),
        },
      ],
    },
  ],
} as const;

const phase7RetainedChainSetDenials = [
  {
    id: "one-bit-run-uuid-drift",
    baseline: "oneRun",
    mutation: {
      kind: "replace_field",
      field: "run_1_id",
      fromInput: "00000000-0000-8000-8000-0000000000ff",
      toInput: "00000000-0000-8000-8000-0000000000fe",
      fromEncodedHex: "000000000000800080000000000000ff",
      toEncodedHex: "000000000000800080000000000000fe",
    },
    expected: {
      outcome: "reject",
      reason: "retained_chain_run_uuid_drift",
      hashBehavior: {
        kind: "digest_mismatch",
        canonicalSha256: phase7RetainedChainSetByteVectors.oneRun.sha256,
        mutatedPreimageHex:
          "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000001000000000000800080000000000000fe0000000000000001000000201111111111111111111111111111111111111111111111111111111111111111",
        mutatedSha256:
          "a73216dec020e8a6d2d0ded8dbe4bf88768fa1fc7af58daf4809f9935690f3ed",
      },
    },
  },
  {
    id: "one-bit-current-event-sequence-drift",
    baseline: "oneRun",
    mutation: {
      kind: "replace_field",
      field: "run_1_current_event_sequence",
      fromInput: "1",
      toInput: "3",
      fromEncodedHex: "0000000000000001",
      toEncodedHex: "0000000000000003",
    },
    expected: {
      outcome: "reject",
      reason: "retained_chain_current_event_sequence_drift",
      hashBehavior: {
        kind: "digest_mismatch",
        canonicalSha256: phase7RetainedChainSetByteVectors.oneRun.sha256,
        mutatedPreimageHex:
          "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000001000000000000800080000000000000ff0000000000000003000000201111111111111111111111111111111111111111111111111111111111111111",
        mutatedSha256:
          "d3e8a5710e9cfe425f573585114ce1364264404c031179ba5e0ddb8a7d311c95",
      },
    },
  },
  {
    id: "one-bit-current-event-sha256-drift",
    baseline: "oneRun",
    mutation: {
      kind: "replace_field",
      field: "run_1_current_event_sha256",
      fromInput: "11".repeat(32),
      toInput: `${"11".repeat(31)}10`,
      fromEncodedHex: `00000020${"11".repeat(32)}`,
      toEncodedHex: `00000020${"11".repeat(31)}10`,
    },
    expected: {
      outcome: "reject",
      reason: "retained_chain_current_event_sha256_drift",
      hashBehavior: {
        kind: "digest_mismatch",
        canonicalSha256: phase7RetainedChainSetByteVectors.oneRun.sha256,
        mutatedPreimageHex:
          "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000001000000000000800080000000000000ff0000000000000001000000201111111111111111111111111111111111111111111111111111111111111110",
        mutatedSha256:
          "5950e2167b7a8d0ebf45495abad18c76eb3ea245b2eff22e8dacfa0224436907",
      },
    },
  },
  {
    id: "tuple-order-drift",
    baseline: "multipleRuns",
    mutation: {
      kind: "reverse_run_tuples",
      fields: [
        "run_1_id",
        "run_1_current_event_sequence",
        "run_1_current_event_sha256",
        "run_2_id",
        "run_2_current_event_sequence",
        "run_2_current_event_sha256",
      ],
    },
    expected: {
      outcome: "reject",
      reason: "retained_chain_unsigned_uuid_order_drift",
      hashBehavior: {
        kind: "digest_mismatch",
        canonicalSha256: phase7RetainedChainSetByteVectors.multipleRuns.sha256,
        mutatedPreimageHex:
          "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000002000000000000800080000000000001000000000000000002000000202222222222222222222222222222222222222222222222222222222222222222000000000000800080000000000000ff0000000000000001000000201111111111111111111111111111111111111111111111111111111111111111",
        mutatedSha256:
          "aa1a25f6a95c0b530d67c213f332e2ac7f05ae7a8cbdf6398fd5ed584f6006c0",
      },
    },
  },
  {
    id: "eligible-run-count-drift",
    baseline: "zeroRuns",
    mutation: {
      kind: "replace_field",
      field: "eligible_run_count",
      fromInput: "0",
      toInput: "1",
      fromEncodedHex: "0000000000000000",
      toEncodedHex: "0000000000000001",
    },
    expected: {
      outcome: "reject",
      reason: "eligible_run_count_mismatch",
      hashBehavior: {
        kind: "digest_mismatch",
        canonicalSha256: phase7RetainedChainSetByteVectors.zeroRuns.sha256,
        mutatedPreimageHex:
          "6461736865722e6167656e742d72756e2d72657461696e65642d636861696e2d7365742e763100000000000000800080000000000000010000000000008000800000000000000200000000000000070000000000000001",
        mutatedSha256:
          "96811d6f010b6f88d29dd1bf7a1b2f6216e56fa7e21a9605716935a9db4781e5",
      },
    },
  },
  {
    id: "retained-event-count-drift",
    baseline: "multipleRuns",
    mutation: {
      kind: "proof_count_drift",
      field: "retained_event_count",
      fromInput: "3",
      toInput: "2",
      fromEncodedHex: "0000000000000003",
      toEncodedHex: "0000000000000002",
    },
    expected: {
      outcome: "reject",
      reason: "retained_event_count_mismatch",
      hashBehavior: {
        kind: "digest_unchanged_count_mismatch",
        canonicalSha256: phase7RetainedChainSetByteVectors.multipleRuns.sha256,
      },
    },
  },
  {
    id: "event-sequence-gap",
    baseline: "multipleRuns",
    mutation: {
      kind: "event_snapshot_drift",
      path: "multipleRuns[1].eventHeaders[0].eventSequence",
      from: "1",
      to: "0",
    },
    expected: {
      outcome: "reject",
      reason: "event_sequence_not_contiguous",
      hashBehavior: { kind: "validation_before_hash", hashAttempted: false },
    },
  },
  {
    id: "event-head-mismatch",
    baseline: "multipleRuns",
    mutation: {
      kind: "event_snapshot_drift",
      path: "multipleRuns[1].eventHeaders[1].eventSha256",
      from: "22".repeat(32),
      to: `${"22".repeat(31)}23`,
    },
    expected: {
      outcome: "reject",
      reason: "event_head_sha256_mismatch",
      hashBehavior: { kind: "validation_before_hash", hashAttempted: false },
    },
  },
  {
    id: "retained-event-count-signed64-overflow",
    baseline: "multipleRuns",
    mutation: {
      kind: "checked_add_overflow",
      field: "retained_event_count",
      addends: ["9223372036854775807", "1"],
      runSequenceMutations: [
        {
          field: "run_1_current_event_sequence",
          fromInput: "1",
          toInput: "9223372036854775807",
          fromEncodedHex: "0000000000000001",
          toEncodedHex: "7fffffffffffffff",
        },
        {
          field: "run_2_current_event_sequence",
          fromInput: "2",
          toInput: "1",
          fromEncodedHex: "0000000000000002",
          toEncodedHex: "0000000000000001",
        },
      ],
      signed64Maximum: "9223372036854775807",
    },
    expected: {
      outcome: "reject",
      reason: "retained_event_count_signed64_overflow",
      hashBehavior: { kind: "overflow_before_hash", hashAttempted: false },
    },
  },
] as const satisfies readonly Phase7RetainedChainDenial[];

const phase7AuditActions = [
  "membership.role_changed",
  "membership.revoked",
  "invitation.issued",
  "invitation.revoked",
  "invitation.accepted",
  "invitation.accepted_existing_membership",
  "session.issued",
  "session.rotated",
  "session.revoked",
  "source_snapshot.created",
  "evidence_record.created",
  "dashboard.created",
  "dashboard_version.created",
  "dashboard_head.promoted",
  "dashboard.promotion_requested",
  "dashboard.promotion_approved",
  "dashboard.promotion_denied",
  "dashboard.expired",
  "dashboard.archived",
  "dashboard.unarchived",
  "dashboard.deleted",
  "dashboard.restored_as_new",
  "dashboard.cleanup_started",
  "dashboard.purge_eligible",
  "dashboard.legal_hold_placed",
  "dashboard.legal_hold_released",
  "dashboard.purged",
  "dashboard.artifact_created",
  "dashboard.agent_run_requested",
  "dashboard.agent_run_cancelled",
  "dashboard.agent_runs_drained",
  "dashboard.agent_run_metadata_aged_out",
] as const;

const phase7CalculationLimits = {
  inputBytes: 1_048_576,
  rawGraphBytes: 131_072,
  astBytes: 65_536,
  nodes: 128,
  depth: 32,
  oneLiteralBytes: 4_096,
  allLiteralBytes: 32_768,
  literalList: 256,
  topK: 1_000,
  windowFrame: 10_000,
  coefficientDigits: 38,
  scale: 18,
  scannedRows: 10_000,
  groups: 1_000,
  groupRows: 10_000,
  intermediateRows: 50_000,
  outputRows: 2_000,
  intermediateBytes: 8_388_608,
  outputBytes: 1_048_576,
  primitiveSteps: 1_000_000,
  logicalAllocationBytes: 33_554_432,
} as const;

const phase7CalculationMeterFields = [
  "input_bytes",
  "ast_bytes",
  "node_count",
  "max_depth",
  "max_literal_bytes",
  "total_literal_bytes",
  "max_literal_list_length",
  "scanned_rows",
  "group_count",
  "max_group_rows",
  "cumulative_intermediate_rows",
  "final_output_rows",
  "cumulative_intermediate_bytes",
  "output_bytes",
  "primitive_steps",
  "logical_allocation_bytes",
  "max_top_k",
  "max_window_frame",
  "max_coefficient_digits",
  "max_scale",
] as const;

const phase7UcumRegistry = [
  ["dimensionless", "1", "1", "1/1", "0/1", false],
  ["dimensionless", "%", "1", "1/100", "0/1", false],
  ["length", "m", "m", "1/1", "0/1", false],
  ["length", "cm", "m", "1/100", "0/1", false],
  ["length", "mm", "m", "1/1000", "0/1", false],
  ["length", "km", "m", "1000/1", "0/1", false],
  ["length", "[in_i]", "m", "127/5000", "0/1", false],
  ["length", "[ft_i]", "m", "381/1250", "0/1", false],
  ["duration", "s", "s", "1/1", "0/1", false],
  ["duration", "min", "s", "60/1", "0/1", false],
  ["duration", "h", "s", "3600/1", "0/1", false],
  ["duration", "d", "s", "86400/1", "0/1", false],
  ["volume", "m3", "m3", "1/1", "0/1", false],
  ["volume", "L", "m3", "1/1000", "0/1", false],
  ["volume", "[ft_i]3", "m3", "55306341/1953125000", "0/1", false],
  ["volume", "[gal_us]", "m3", "473176473/125000000000", "0/1", false],
  ["volumetric_flow", "m3/s", "m3/s", "1/1", "0/1", false],
  ["volumetric_flow", "m3/h", "m3/s", "1/3600", "0/1", false],
  ["volumetric_flow", "L/s", "m3/s", "1/1000", "0/1", false],
  ["volumetric_flow", "L/min", "m3/s", "1/60000", "0/1", false],
  ["volumetric_flow", "[ft_i]3/s", "m3/s", "55306341/1953125000", "0/1", false],
  [
    "volumetric_flow",
    "[gal_us]/min",
    "m3/s",
    "157725491/2500000000000",
    "0/1",
    false,
  ],
  ["temperature", "K", "K", "1/1", "0/1", false],
  ["temperature", "Cel", "K", "1/1", "5463/20", true],
  ["temperature", "[degF]", "K", "5/9", "45967/180", true],
  ["temperature", "[degR]", "K", "5/9", "0/1", false],
] as const;

const phase7FxRegistry = [
  ["USD", 2],
  ["EUR", 2],
  ["GBP", 2],
  ["JPY", 0],
] as const;

const phase7CalculationOperationRegistry = {
  source: "field_ids; 1..64 sorted unique catalog UUIDs; output rowset",
  field:
    "input,field_id; input is rowset, evaluation domain equals it, field is in output",
  literal: "value; exact tagged scalar; broadcast over evaluation_rows_from",
  select:
    "input,projections; 1..64 {field_id,name,value_node_id} sorted by field UUID; derived field IDs",
  filter: "input,predicate; predicate scalar boolean",
  group:
    "input,key_node_ids; 0..16 sorted unique scalar keys whose evaluation domain is input",
  sort: "input,keys; 1..16 {value_node_id,direction,nulls,tie}; direction asc|desc; nulls first|last; exactly one final tie=true stable unique key",
  top_k: "input,k; tagged i64:1..i64:1000; input has total-sort certificate",
  rank: "input,partition_node_ids,keys; scalar integer; 0..16 partitions; same total-sort key schema",
  count_rows: "group_node_id; scalar integer over group stable row IDs",
  count_present:
    "input,group_node_id; input scalar over group input rows; output over group row IDs",
  sum: "input,group_node_id; input scalar over group input rows; output over group row IDs",
  min: "input,group_node_id; input scalar over group input rows; output over group row IDs",
  max: "input,group_node_id; input scalar over group input rows; output over group row IDs",
  mean: "input,group_node_id,scale,rounding; scale i64:0..i64:18; rounding none|half_even",
  add: "left,right,scale,rounding; scale i64:0..i64:18; closed arithmetic registry",
  subtract:
    "left,right,scale,rounding; scale i64:0..i64:18; closed arithmetic registry",
  multiply:
    "left,right,scale,rounding; scale i64:0..i64:18; closed arithmetic registry",
  divide:
    "left,right,scale,rounding; scale i64:0..i64:18; closed arithmetic registry",
  absolute: "input",
  clamp: "input,minimum,maximum; present numeric literals; minimum <= maximum",
  round: "input,scale,rounding; scale i64:0..i64:18; rounding none|half_even",
  equal: "left,right; identical comparable type/unit/currency/grain/domain",
  not_equal: "left,right; identical comparable type/unit/currency/grain/domain",
  less: "left,right; identical comparable type/unit/currency/grain/domain",
  less_equal:
    "left,right; identical comparable type/unit/currency/grain/domain",
  greater: "left,right; identical comparable type/unit/currency/grain/domain",
  greater_equal:
    "left,right; identical comparable type/unit/currency/grain/domain",
  and: "left,right; boolean scalars",
  or: "left,right; boolean scalars",
  not: "input; boolean scalar",
  if_then_else:
    "condition,when_true,when_false; condition boolean; branches identical typed shape",
  coalesce: "inputs; 1..16 identical typed scalar inputs",
  lag: "input,partition_node_ids,keys,offset; total order; offset i64:1..i64:10000",
  delta:
    "lag fields plus scale,rounding; scale i64:0..i64:18; rounding none|half_even",
  percentage_change:
    "lag fields plus scale,rounding; scale i64:0..i64:18; rounding none|half_even",
  window_sum:
    "input,partition_node_ids,keys,preceding,following; row-count frame only; each i64:0..i64:10000; 1+preceding+following <= 10000",
  window_mean:
    "window_sum fields plus scale,rounding none|half_even; no temporal frame discriminator",
  unit_convert:
    "input,from_unit,to_unit,registry_version,scale,rounding; ucum-subset-v1; compatible dimensions",
  currency_convert:
    "input,from_currency,to_currency,fx_evidence_id,rate,scale,rounding; iso4217-task9-v1 exact evidence",
  classify_state:
    "input,stale_after_millis,evaluation_time; timestamp input; nonnegative tagged i64 threshold; exact top-level time",
} as const;

const phase7ArithmeticRegistry = {
  operations: ["add", "subtract", "multiply", "divide"],
  inputs: ["integer", "decimal"],
  output: {
    scalar: "decimal",
    fields: null,
    maxValueBytes: "i64:74",
    nullable: "left.nullable OR right.nullable",
    evaluationRowsFrom: "byte-identical for both operands",
    grain: "byte-identical operands, preserved",
  },
  metadataMatrix: [
    [
      "add|subtract",
      "unit=null,currency=null on both",
      "unit=null,currency=null",
    ],
    [
      "add|subtract",
      "same exact non-affine unit,currency=null",
      "preserve unit,currency=null",
    ],
    [
      "add|subtract",
      "unit=null,same exact currency",
      "unit=null,preserve currency",
    ],
    ["multiply", "unit=null,currency=null on both", "unit=null,currency=null"],
    ["divide", "unit=null,currency=null on both", "unit=1,currency=null"],
    [
      "divide",
      "same exact non-affine unit,currency=null",
      "unit=1,currency=null",
    ],
    ["divide", "unit=null,same exact currency", "unit=1,currency=null"],
  ],
  forbidden: [
    "operand carrying both unit and currency",
    "affine Cel|[degF] arithmetic",
    "unequal units",
    "unitful multiplication",
    "unlike currency arithmetic",
    "currency multiplication",
    "unlisted unit/currency cancellation",
    "dimensional algebra or invented compound unit",
  ],
  evaluation:
    "reduce operands to exact rationals, perform one operation, normalize sign and gcd once, quantize exactly once at node scale, none requires exact coefficient and half_even uses symmetric ties-to-even, then strip trailing zeroes",
  validationOrder: [
    "invalid_graph",
    "type_mismatch",
    "grain_mismatch",
    "currency_mismatch",
    "unit_mismatch",
    "static limit checks",
    "strict state propagation",
    "divide_by_zero",
    "inexact_arithmetic",
    "overflow",
    "limit_exceeded",
  ],
} as const;

const phase7NonConversionOperationRegistry = {
  valueWidths: {
    boolean: 5,
    integer: 26,
    decimal: 74,
    date: 12,
    timestamp: 29,
    duration: 26,
    text: "exact source/catalog/literal max_value_bytes",
    classifyState: 9,
  },
  rowsets: {
    source:
      "exact catalog field subset; copy field metadata in field-UUID order and canonical input values/row order",
    field:
      "one named rowset field; exact scalar metadata/domain; named cell for every input row",
    literal:
      "derive from value type/state; null unit/currency/grain; broadcast; only contextual threshold/target literal inherits contract output metadata",
    select:
      "derived UUIDv8 field IDs, submitted NFC names, remaining metadata from value node; fields by UUID, rows preserve IDs/order",
    filter:
      "boolean predicate; byte-identical field schema; retain present/stale true rows in input order",
    sort: "scalar keys and final unique tie; preserve schema/row IDs; closed comparison order",
    top_k:
      "total-sorted input; preserve schema and first min(n,q) rows; q distinct from inherited key count s",
    group:
      "direct field keys only; first unavailable/missing/null key is invalid_group_key; derived key fields; zero keys permits one empty field array; closed group IDs/order",
  },
  scalars: {
    rank: "nonnull integer, null unit/currency, partition group grain, i64:26; one-based total-order position",
    count_rows:
      "nonnull integer, null unit/currency, group grain, i64:26; membership count",
    count_present:
      "nonnull integer, null unit/currency, group grain, i64:26; present/stale count",
    sum: "nonnull decimal, preserve unit/currency, group grain, i64:74; exact sum; typed zero for no contributor",
    min_max:
      "same integer|decimal|date|timestamp|duration scalar/unit/currency/width, group grain; exact order extremum",
    mean: "nonnull decimal, preserve unit/currency, group grain, i64:74; exact sum/count then one quantization",
    absolute:
      "decimal, preserve nullable/unit/currency/grain/domain, i64:74; exact absolute rational",
    clamp:
      "decimal, preserve nullable/unit/currency/grain/domain, i64:74; inclusive exact rational bounds",
    round:
      "decimal, preserve nullable/unit/currency/grain/domain, i64:74; one quantization",
    equality:
      "boolean, nullable OR, null unit/currency, preserve grain/domain, i64:5",
    orderingComparison:
      "boolean as equality; integer|decimal|text|date|timestamp|duration canonical order",
    and_or:
      "boolean, nullable OR, null unit/currency, preserve grain/domain, i64:5",
    not: "boolean; preserve nullable/grain/domain; null unit/currency; i64:5",
    if_then_else:
      "branch scalar/unit/currency/grain/domain/width; nullable is OR of condition and both branches",
    coalesce:
      "preserve scalar metadata/domain/width; nullable is AND of input nullable flags",
    lag: "preserve all input metadata/domain; missing without offset row",
    delta:
      "decimal, preserve nullable/unit/currency/grain/domain, i64:74; exact current-lag then one quantization",
    percentage_change:
      "decimal, preserve nullable/grain/domain, unit %, null currency, i64:74; exact ((current-lag)/lag)*100 then one quantization",
    window_sum:
      "nonnull decimal, preserve input unit/currency/grain/domain, i64:74; exact sum; typed zero for no contributor",
    window_mean:
      "nonnull decimal, preserve input unit/currency/grain/domain, i64:74; exact sum/count then one quantization",
    classify_state:
      "text, preserve nullable/grain/domain, null unit/currency, i64:9; exact current|stale formula",
  },
  statePrecedence: [
    "unavailable",
    "missing",
    "null",
    "compute",
    "stale propagation",
  ],
  runtimeFailureOrder: [
    "canonical topological node order",
    "row ordinal",
    "propagated state (not error)",
    "invalid_group_key",
    "divide_by_zero",
    "empty_input",
    "inexact_arithmetic",
    "overflow",
    "limit_exceeded",
  ],
} as const;

const phase7PrimitiveStepRegistry = {
  source: "n",
  field: "n",
  literal: "n",
  select: "n*p",
  filter: "n",
  group: "n*gk+g",
  sort: "L(n)+n*sk",
  top_k: "L(n)+n*s",
  rank: "L(n)+n*(pk+sk)+n",
  count_rows: "n",
  count_present: "n",
  sum: "n",
  min: "n",
  max: "n",
  mean: "n",
  add: "n",
  subtract: "n",
  multiply: "n",
  divide: "n",
  absolute: "n",
  clamp: "n",
  round: "n",
  equal: "n",
  not_equal: "n",
  less: "n",
  less_equal: "n",
  greater: "n",
  greater_equal: "n",
  and: "n",
  or: "n",
  not: "n",
  classify_state: "n",
  unit_convert: "2n",
  currency_convert: "2n",
  coalesce: "n*a",
  if_then_else: "2n",
  lag: "n",
  delta: "n",
  percentage_change: "n",
  window_sum: "n*w",
  window_mean: "n*w",
  mergeSort: "L(n)=n*ceil(log2(max(1,n)))",
} as const;

const phase7MetricContractConformanceMatrix = {
  aggregationGraphMapping: {
    count: "count_present over contract measure",
    count_distinct:
      "unsupported_capability; next_safe_step=none before dispatch",
    sum: "sum over contract measure and exact group",
    min: "min over decimal contract measure and exact group",
    max: "max over decimal contract measure and exact group",
    mean: "mean scale i64:18 half_even over contract measure and exact group",
    median: "unsupported_capability; next_safe_step=none before dispatch",
    ratio:
      "numerator sum and exact denominator-contract sum over same group, divide scale i64:18 half_even",
  },
  aggregationValueType: [
    ["count|count_distinct", "integer", null, null],
    ["sum|mean|min|max|median", "currency", null, "listed currency"],
    ["sum|mean|min|max|median", "duration", "non-affine duration unit", null],
    ["sum|mean|min|max|median", "decimal", "null or listed non-% unit", null],
    ["ratio", "decimal", "1", null],
    ["ratio", "percentage", "%", null],
  ],
  denominator: {
    requiredFor: "ratio only",
    rules: [
      "both ID/version nonnull",
      "different reviewed sum contract in same set/catalog",
      "same calendar/timezone/dimensions/group grain/event-time field",
      "denominator cannot be ratio",
    ],
  },
  direction: {
    neutral: "threshold=null,target=null",
    higher_is_better:
      "both nonnull,target>=threshold; diagnostics greater_equal",
    lower_is_better: "both nonnull,target<=threshold; diagnostics less_equal",
    target_band:
      "both nonnull,threshold<=target; threshold greater_equal and target less_equal",
  },
  freshness: {
    lagMillis: [0, 31_536_000_000],
    freshnessSloMillis: [1, 31_536_000_000],
    currentBoundary:
      "evaluation_us - observed_us <= (lag_millis + freshness_slo_millis) * 1000",
    staleBoundary: "one microsecond greater",
    classifier:
      "dedicated event-time field -> zero-key group -> max -> classify_state; exact top-level time and checked lag+SLO",
    sourceRow:
      "first input ordinal whose present/stale event time equals maximum",
  },
  graphPath: [
    "one source with stable keys + measure + event-time + exact dimensions (+ denominator fields for ratio)",
    "direct field nodes",
    "one exact-dimension group",
    "exact aggregation mapping",
    "at most one required unit or currency conversion",
    "exact contract_output_node_id in output_node_ids",
  ],
  forbiddenContractPathOps: [
    "filter",
    "sort",
    "top_k",
    "lag",
    "window",
    "conditional",
    "uncontracted selection",
  ],
  validationOrder: [
    "canonical contract/set/entry hashes",
    "owner/review/catalog/FK equality",
    "denominator and value-type cross-fields",
    "direction/threshold/target",
    "dimension/grain/calendar/timezone",
    "lineage/bundle and freshness",
    "graph identity/node structure",
    "selected/diagnostic output metadata and bytes",
    "static/runtime meter and result hashes",
  ],
} as const;

const phase7ValidMetricContractContext = {
  contract: {
    organizationId: "00000000-0000-8000-8000-000000000001",
    dashboardId: "00000000-0000-8000-8000-000000000002",
    contractSetId: "00000000-0000-8000-8000-000000000103",
    contractSetSha256: "10".repeat(32),
    contractId: "00000000-0000-8000-8000-000000000104",
    contractVersion: "1",
    catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
    businessOwner: {
      membershipId: "00000000-0000-8000-8000-000000000109",
      organizationId: "00000000-0000-8000-8000-000000000001",
      state: "active",
      authorityRevision: "7",
      currentAuthorityRevision: "7",
      revokedAt: null as string | null,
    },
    dataOwner: {
      membershipId: "00000000-0000-8000-8000-000000000110",
      organizationId: "00000000-0000-8000-8000-000000000001",
      state: "active",
      authorityRevision: "4",
      currentAuthorityRevision: "4",
      revokedAt: null as string | null,
    },
    name: "EUR total",
    definition:
      "Sum the frozen USD measure and convert once with the bound USD/EUR rate.",
    measureFieldId: "00000000-0000-8000-8000-000000000202",
    aggregation: "sum",
    denominatorContractId: null as string | null,
    denominatorContractVersion: null as string | null,
    valueType: "currency",
    unit: null as string | null,
    currency: "EUR" as string | null,
    direction: "neutral",
    threshold: null as string | null,
    target: null as string | null,
    grain:
      "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
    lagMillis: "0",
    freshnessSloMillis: "86400000",
    allowedDimensionFieldIds: ["00000000-0000-8000-8000-000000000204"],
    calendar: "gregorian",
    timezone: "UTC",
    tzdbVersion: "2025b",
    lineageEvidenceIds: [
      "00000000-0000-8000-8000-000000000106",
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
    ],
    reviewState: "reviewed",
    contractSha256: "20".repeat(32),
  },
  denominatorContract: {
    organizationId: "00000000-0000-8000-8000-000000000001",
    contractSetId: "00000000-0000-8000-8000-000000000103",
    contractId: "00000000-0000-8000-8000-000000000114",
    contractVersion: "1",
    catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
    aggregation: "sum",
    reviewState: "reviewed",
    calendar: "gregorian",
    timezone: "UTC",
    grain:
      "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
    allowedDimensionFieldIds: ["00000000-0000-8000-8000-000000000204"],
    measureFieldId: "00000000-0000-8000-8000-000000000212",
    eventTimeFieldId: "00000000-0000-8000-8000-000000000203",
    measureScalarType: "decimal",
    measureUnit: null as string | null,
    measureCurrency: null as string | null,
    lineageEvidenceIds: [
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
      "00000000-0000-8000-8000-000000000116",
    ],
  },
  catalog: {
    catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
    catalogSha256: "30".repeat(32),
    evaluatedAt: "2026-08-04T12:00:00.000000Z",
    inputSnapshotId: "00000000-0000-8000-8000-000000000101",
    stableKeyFieldIds: ["00000000-0000-8000-8000-000000000201"],
    measure: {
      fieldId: "00000000-0000-8000-8000-000000000202",
      semanticType: "measure",
      scalarType: "decimal",
      unit: null as string | null,
      currency: "USD" as string | null,
      eventTimeFieldId: "00000000-0000-8000-8000-000000000203" as string | null,
      allowedAggregations: ["max", "mean", "min", "sum"],
      allowedDimensions: ["00000000-0000-8000-8000-000000000204"],
      lineageEvidenceIds: ["00000000-0000-8000-8000-000000000106"],
      entrySha256: "31".repeat(32),
    },
    eventTime: {
      fieldId: "00000000-0000-8000-8000-000000000203",
      semanticType: "event_time",
      scalarType: "timestamp",
      lineageEvidenceIds: ["00000000-0000-8000-8000-000000000107"],
      entrySha256: "32".repeat(32),
    },
    dimensions: [
      {
        fieldId: "00000000-0000-8000-8000-000000000204",
        semanticType: "dimension",
        lineageEvidenceIds: ["00000000-0000-8000-8000-000000000108"],
        entrySha256: "33".repeat(32),
      },
    ],
    denominatorMeasure: {
      fieldId: "00000000-0000-8000-8000-000000000212",
      semanticType: "measure",
      scalarType: "decimal",
      unit: null as string | null,
      currency: null as string | null,
      eventTimeFieldId: "00000000-0000-8000-8000-000000000203",
      allowedAggregations: ["sum"],
      allowedDimensions: ["00000000-0000-8000-8000-000000000204"],
      lineageEvidenceIds: ["00000000-0000-8000-8000-000000000116"],
      entrySha256: "34".repeat(32),
    },
  },
  governance: {
    contractSetHashRecomputed: true,
    derivedGrain:
      "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
    exactLineageUnion: [
      "00000000-0000-8000-8000-000000000106",
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
    ],
    commonBundle: {
      bundleId: "00000000-0000-8000-8000-000000000105",
      bundleSha256: "40".repeat(32),
      sourceSnapshotId: "00000000-0000-8000-8000-000000000101",
      evidenceRows: [
        {
          evidenceId: "00000000-0000-8000-8000-000000000106",
          sourceSnapshotId: "00000000-0000-8000-8000-000000000101",
          sourceSha256: "50".repeat(32),
          evidenceSha256: "51".repeat(32),
          observedAt: "2026-08-04T12:00:00.000000Z",
          freshness: "current",
        },
        {
          evidenceId: "00000000-0000-8000-8000-000000000107",
          sourceSnapshotId: "00000000-0000-8000-8000-000000000101",
          sourceSha256: "50".repeat(32),
          evidenceSha256: "52".repeat(32),
          observedAt: "2026-08-04T12:00:00.000000Z",
          freshness: "current",
        },
        {
          evidenceId: "00000000-0000-8000-8000-000000000108",
          sourceSnapshotId: "00000000-0000-8000-8000-000000000101",
          sourceSha256: "50".repeat(32),
          evidenceSha256: "53".repeat(32),
          observedAt: "2026-08-04T12:00:00.000000Z",
          freshness: "current",
        },
      ],
    },
    sourceSnapshot: {
      snapshotId: "00000000-0000-8000-8000-000000000101",
      contentSha256: "50".repeat(32),
      observedAt: "2026-08-04T12:00:00.000000Z",
      canonicalBytes: "canonical-input-table-v1:fixture",
    },
  },
  graph: {
    schema: "calculation-graph-v1",
    registry: "calculation-registry-v1",
    limits: "calculation-limits-v1",
    graphId: "00000000-0000-8000-8000-000000000301",
    contractSetId: "00000000-0000-8000-8000-000000000103",
    contractId: "00000000-0000-8000-8000-000000000104",
    contractVersion: "1",
    catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
    catalogSha256: "30".repeat(32),
    commonBundleId: "00000000-0000-8000-8000-000000000105",
    commonBundleSha256: "40".repeat(32),
    inputSnapshotId: "00000000-0000-8000-8000-000000000101",
    inputSha256: "50".repeat(32),
    evaluationTime: "2026-08-05T12:00:00.000000Z",
    timezone: "UTC",
    tzdbVersion: "2025b",
    unitRegistryVersion: "ucum-subset-v1",
    fxEvidenceId: "00000000-0000-8000-8000-000000000106" as string | null,
    fxEvidenceSha256: "51".repeat(32) as string | null,
    source: {
      nodeId: "00000000-0000-8000-8000-000000000601",
      sourceIdentity: "contract-source",
      fieldIds: [
        "00000000-0000-8000-8000-000000000201",
        "00000000-0000-8000-8000-000000000202",
        "00000000-0000-8000-8000-000000000203",
        "00000000-0000-8000-8000-000000000204",
      ],
      requiredFieldIds: [
        "00000000-0000-8000-8000-000000000201",
        "00000000-0000-8000-8000-000000000202",
        "00000000-0000-8000-8000-000000000203",
        "00000000-0000-8000-8000-000000000204",
      ],
    },
    directFields: {
      measure: {
        nodeId: "00000000-0000-8000-8000-000000000602",
        fieldId: "00000000-0000-8000-8000-000000000202",
        input: "00000000-0000-8000-8000-000000000601",
      },
      eventTime: {
        nodeId: "00000000-0000-8000-8000-000000000604",
        fieldId: "00000000-0000-8000-8000-000000000203",
        input: "00000000-0000-8000-8000-000000000601",
      },
      dimensions: [
        {
          nodeId: "00000000-0000-8000-8000-000000000605",
          fieldId: "00000000-0000-8000-8000-000000000204",
          input: "00000000-0000-8000-8000-000000000601",
        },
      ],
      denominatorMeasure: null as null | {
        nodeId: string;
        fieldId: string;
        input: string;
      },
    },
    group: {
      nodeId: "00000000-0000-8000-8000-000000000606",
      input: "00000000-0000-8000-8000-000000000601",
      keyNodeIds: ["00000000-0000-8000-8000-000000000605"],
    },
    aggregation: {
      nodeId: "00000000-0000-8000-8000-000000000607",
      op: "sum",
      input: "00000000-0000-8000-8000-000000000602",
      groupNodeId: "00000000-0000-8000-8000-000000000606",
      denominatorInput: null as string | null,
      denominatorGroupNodeId: null as string | null,
      scale: null as string | null,
      rounding: null as string | null,
      numeratorOp: null as string | null,
      denominatorOp: null as string | null,
      divideOp: null as string | null,
    },
    pathOps: ["source", "field", "group", "sum", "currency_convert"],
    conversionCount: 1,
    conversionKinds: ["currency_convert"],
    conversion: {
      nodeId: "00000000-0000-8000-8000-000000000608",
      op: "currency_convert",
      input: "00000000-0000-8000-8000-000000000607",
      fromUnit: null as string | null,
      toUnit: null as string | null,
      unitRegistryVersion: null as string | null,
      fromCurrency: "USD" as string | null,
      toCurrency: "EUR" as string | null,
      scale: "2",
      rounding: "half_even",
      fxEvidenceId: "00000000-0000-8000-8000-000000000106" as string | null,
      fxEvidenceSha256: "51".repeat(32) as string | null,
      fxBodyFromCurrency: "USD" as string | null,
      fxBodyToCurrency: "EUR" as string | null,
      fxObservedAt: "2026-08-04T12:00:00.000000Z" as string | null,
    } as {
      nodeId: string;
      op: string;
      input: string;
      fromUnit: string | null;
      toUnit: string | null;
      unitRegistryVersion: string | null;
      fromCurrency: string | null;
      toCurrency: string | null;
      scale: string;
      rounding: string;
      fxEvidenceId: string | null;
      fxEvidenceSha256: string | null;
      fxBodyFromCurrency: string | null;
      fxBodyToCurrency: string | null;
      fxObservedAt: string | null;
    } | null,
    contractOutputNodeId: "00000000-0000-8000-8000-000000000608",
    outputNodeIds: [
      "00000000-0000-8000-8000-000000000608",
      "00000000-0000-8000-8000-000000000612",
    ],
    topologicalNodeIds: [
      "00000000-0000-8000-8000-000000000601",
      "00000000-0000-8000-8000-000000000602",
      "00000000-0000-8000-8000-000000000604",
      "00000000-0000-8000-8000-000000000605",
      "00000000-0000-8000-8000-000000000606",
      "00000000-0000-8000-8000-000000000607",
      "00000000-0000-8000-8000-000000000608",
      "00000000-0000-8000-8000-000000000609",
      "00000000-0000-8000-8000-000000000610",
      "00000000-0000-8000-8000-000000000611",
      "00000000-0000-8000-8000-000000000612",
    ],
    output: {
      nodeId: "00000000-0000-8000-8000-000000000608",
      shape: "scalar",
      scalar: "decimal",
      nullable: false,
      valueType: "currency",
      unit: null as string | null,
      currency: "EUR" as string | null,
      grain:
        "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
      maxValueBytes: "74",
      evaluationRowsFrom: "00000000-0000-8000-8000-000000000606",
    },
    thresholdDiagnostics: {
      thresholdNodeId: null as string | null,
      targetNodeId: null as string | null,
      thresholdLiteralNodeId: null as string | null,
      targetLiteralNodeId: null as string | null,
      thresholdLiteralValue: null as string | null,
      targetLiteralValue: null as string | null,
      thresholdComparison: null as null | {
        op: string;
        left: string;
        right: string;
      },
      targetComparison: null as null | {
        op: string;
        left: string;
        right: string;
      },
      thresholdLiteralConsumers: [] as string[],
      targetLiteralConsumers: [] as string[],
    },
    freshnessDiagnostic: {
      field: {
        nodeId: "00000000-0000-8000-8000-000000000609",
        op: "field",
        fieldId: "00000000-0000-8000-8000-000000000203",
        input: "00000000-0000-8000-8000-000000000601",
      },
      group: {
        nodeId: "00000000-0000-8000-8000-000000000610",
        op: "group",
        input: "00000000-0000-8000-8000-000000000601",
        keyNodeIds: [] as string[],
      },
      maximum: {
        nodeId: "00000000-0000-8000-8000-000000000611",
        op: "max",
        input: "00000000-0000-8000-8000-000000000609",
        groupNodeId: "00000000-0000-8000-8000-000000000610",
      },
      classifier: {
        nodeId: "00000000-0000-8000-8000-000000000612",
        op: "classify_state",
        input: "00000000-0000-8000-8000-000000000611",
        evaluationTime: "2026-08-05T12:00:00.000000Z",
        staleAfterMillis: "86400000",
      },
    } as {
      field: { nodeId: string; op: string; fieldId: string; input: string };
      group: {
        nodeId: string;
        op: string;
        input: string;
        keyNodeIds: string[];
      };
      maximum: {
        nodeId: string;
        op: string;
        input: string;
        groupNodeId: string;
      };
      classifier: {
        nodeId: string;
        op: string;
        input: string;
        evaluationTime: string;
        staleAfterMillis: string;
      };
    } | null,
    derivedFreshnessProjection: {
      classifierNodeId: "00000000-0000-8000-8000-000000000612" as string | null,
      inputNodeId: "00000000-0000-8000-8000-000000000611" as string | null,
      sourceRowId: "00000000-0000-8000-8000-000000000501" as string | null,
    },
    matchingFreshnessStructureCount: 1,
    matchingFreshnessComponents: ["field", "group", "max", "classifier"],
    callerFreshnessProjectionKeys: [] as string[],
    otherOutputs: [
      {
        nodeId: "00000000-0000-8000-8000-000000000612",
        sourceIdentity: "contract-source",
        catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
        commonBundleId: "00000000-0000-8000-8000-000000000105",
      },
    ],
  },
  result: {
    schema: "calculation-result-v1",
    resultId: "00000000-0000-8000-8000-000000000401",
    graphId: "00000000-0000-8000-8000-000000000301",
    graphSha256: "60".repeat(32),
    state: "succeeded",
    errorCode: null as string | null,
    meterSha256: "61".repeat(32),
    inputSha256: "50".repeat(32),
    catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
    catalogSha256: "30".repeat(32),
    commonBundleId: "00000000-0000-8000-8000-000000000105",
    commonBundleSha256: "40".repeat(32),
    outputs: [
      {
        nodeId: "00000000-0000-8000-8000-000000000608",
        outputSha256: "62".repeat(32),
        canonicalOutputSha256: "62".repeat(32),
        shape: "scalar",
        scalar: "decimal",
        valueType: "currency",
        unit: null as string | null,
        currency: "EUR" as string | null,
        grain:
          "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
        maxValueBytes: "74",
        evaluationRowsFrom: "00000000-0000-8000-8000-000000000606",
      },
      {
        nodeId: "00000000-0000-8000-8000-000000000612",
        outputSha256: "63".repeat(32),
        canonicalOutputSha256: "63".repeat(32),
        shape: "scalar",
        scalar: "text",
        valueType: "diagnostic",
        unit: null as string | null,
        currency: null as string | null,
        grain:
          "group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1",
        maxValueBytes: "9",
        evaluationRowsFrom: "00000000-0000-8000-8000-000000000610",
      },
    ],
  },
  freshness: {
    evaluationUs: "1785931200000000",
    catalogObservedUs: "1785844800000000",
    sourceObservedUs: "1785844800000000",
    lineageObservedUs: "1785844800000000",
    maximumEventTimeUs: "1785844800000000",
    checkedLagAndSloMillis: "86400000",
    classifierState: "current",
    sourceRows: [
      {
        ordinal: "0",
        rowId: "00000000-0000-8000-8000-000000000501",
        state: "present",
        eventTimeUs: "1785844800000000" as string | null,
      },
      {
        ordinal: "1",
        rowId: "00000000-0000-8000-8000-000000000502",
        state: "stale",
        eventTimeUs: "1785844800000000" as string | null,
      },
    ],
    firstMaximumSourceRowId: "00000000-0000-8000-8000-000000000501",
    fxMaximumAgeMillis: "86400000",
  },
} as const;

type Phase7MetricContractContext = typeof phase7ValidMetricContractContext;
type Phase7MetricConformancePath = `${
  | "contract"
  | "denominatorContract"
  | "catalog"
  | "governance"
  | "graph"
  | "result"
  | "freshness"}.${string}`;
type Phase7MetricConformancePatch = Readonly<{
  path: Phase7MetricConformancePath;
  value: unknown;
}>;
type Phase7MetricConformanceFixture = {
  id: string;
  phase: "contract_validity" | "graph_conformance" | "freshness_conformance";
  baseline: "sum_currency" | "ratio_percentage" | "higher_direction";
  patches: readonly Phase7MetricConformancePatch[];
  expectedChangedPaths: readonly Phase7MetricConformancePath[];
  context: Phase7MetricContractContext;
  expected: {
    outcome: "accept" | "reject" | "unsupported_capability";
    reason: string;
  };
};

function phase7UnsignedUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function phase7IsUnsignedUtf8SortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) =>
      index === 0 || phase7UnsignedUtf8Compare(values[index - 1]!, value) < 0,
  );
}

function phase7MetricGroupGrain(
  calendar: string,
  timezone: string,
  dimensionFieldIds: readonly string[],
): string {
  const encodeText = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const count = Buffer.alloc(8);
  count.writeBigInt64BE(BigInt(dimensionFieldIds.length));
  return `group:${createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("dasher.metric-group-grain.v1\0", "ascii"),
        encodeText(calendar),
        encodeText(timezone),
        count,
        ...dimensionFieldIds.map((fieldId) =>
          Buffer.from(fieldId.replaceAll("-", ""), "hex"),
        ),
      ]),
    )
    .digest("hex")}`;
}

function phase7MetricInstantMicroseconds(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u.exec(
    value,
  );
  if (match === null) return null;
  const wholeSecondMillis = Date.parse(`${match[1]}.000Z`);
  return Number.isSafeInteger(wholeSecondMillis)
    ? BigInt(wholeSecondMillis) * 1_000n + BigInt(match[2]!)
    : null;
}

function phase7MetricBaselineViolations(
  context: Phase7MetricContractContext,
): string[] {
  const violations: string[] = [];
  const requireInvariant = (condition: boolean, invariant: string): void => {
    if (!condition) violations.push(invariant);
  };
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const uuidV8Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const sha256Pattern = /^[0-9a-f]{64}$/u;
  const aggregation = context.contract.aggregation as string;
  const direction = context.contract.direction as string;
  const inspectIdentities = (value: unknown, path: string, key = ""): void => {
    if (Array.isArray(value)) {
      if (/Ids$/u.test(key)) {
        value.forEach((item, index) =>
          requireInvariant(
            typeof item === "string" && uuidPattern.test(item),
            `${path}.${index}:uuid`,
          ),
        );
      } else {
        value.forEach((item, index) =>
          inspectIdentities(item, `${path}.${index}`),
        );
      }
    } else if (value !== null && typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) =>
        inspectIdentities(
          childValue,
          path.length === 0 ? childKey : `${path}.${childKey}`,
          childKey,
        ),
      );
    } else if (value !== null && /(?:Id|RowId)$/u.test(key)) {
      requireInvariant(
        typeof value === "string" && uuidPattern.test(value),
        `${path}:uuid`,
      );
    } else if (value !== null && /Sha256$/u.test(key)) {
      requireInvariant(
        typeof value === "string" && sha256Pattern.test(value),
        `${path}:sha256`,
      );
    }
  };
  inspectIdentities(context, "");
  requireInvariant(uuidV8Pattern.test(context.result.resultId), "result:id-v8");
  context.freshness.sourceRows.forEach(({ rowId }, index) =>
    requireInvariant(uuidV8Pattern.test(rowId), `freshness.row.${index}:id-v8`),
  );

  requireInvariant(
    context.contract.organizationId ===
      context.contract.businessOwner.organizationId &&
      context.contract.organizationId ===
        context.contract.dataOwner.organizationId,
    "owners:organization",
  );
  requireInvariant(
    String(context.contract.businessOwner.membershipId) !==
      String(context.contract.dataOwner.membershipId),
    "owners:distinct",
  );
  for (const [name, owner] of [
    ["business", context.contract.businessOwner],
    ["data", context.contract.dataOwner],
  ] as const) {
    requireInvariant(
      owner.state === "active" &&
        owner.revokedAt === null &&
        owner.authorityRevision === owner.currentAuthorityRevision,
      `owner:${name}:current-active`,
    );
  }
  requireInvariant(
    context.contract.reviewState === "reviewed" &&
      context.contract.name.length > 0 &&
      Buffer.byteLength(context.contract.name) <= 256 &&
      context.contract.definition.length > 0 &&
      Buffer.byteLength(context.contract.definition) <= 4_096,
    "contract:review-and-text",
  );
  requireInvariant(
    [
      "count",
      "count_distinct",
      "sum",
      "min",
      "max",
      "mean",
      "median",
      "ratio",
    ].includes(aggregation) &&
      ["integer", "decimal", "currency", "percentage", "duration"].includes(
        context.contract.valueType,
      ) &&
      [
        "higher_is_better",
        "lower_is_better",
        "target_band",
        "neutral",
      ].includes(direction) &&
      ["gregorian", "iso_week", "fiscal_445"].includes(
        context.contract.calendar,
      ),
    "contract:closed-enums",
  );
  requireInvariant(
    context.contract.tzdbVersion === "2025b" &&
      context.graph.tzdbVersion === "2025b" &&
      context.contract.timezone === context.graph.timezone,
    "contract:timezone-binding",
  );
  requireInvariant(
    phase7IsUnsignedUtf8SortedUnique(
      context.contract.allowedDimensionFieldIds,
    ) && phase7IsUnsignedUtf8SortedUnique(context.contract.lineageEvidenceIds),
    "contract:ordered-id-arrays",
  );
  const decimalPattern = /^(?:0|-?[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
  requireInvariant(
    [context.contract.threshold, context.contract.target].every(
      (value) => value === null || decimalPattern.test(value),
    ) &&
      (direction === "neutral"
        ? context.contract.threshold === null &&
          context.contract.target === null
        : context.contract.threshold !== null &&
          context.contract.target !== null),
    "contract:direction-values",
  );
  const lagMillis = BigInt(context.contract.lagMillis);
  const freshnessSloMillis = BigInt(context.contract.freshnessSloMillis);
  requireInvariant(
    lagMillis >= 0n &&
      lagMillis <= 31_536_000_000n &&
      freshnessSloMillis > 0n &&
      freshnessSloMillis <= 31_536_000_000n &&
      BigInt(context.freshness.checkedLagAndSloMillis) ===
        lagMillis + freshnessSloMillis,
    "contract:freshness-bounds",
  );

  const catalog = context.catalog;
  requireInvariant(
    catalog.catalogSnapshotId === context.contract.catalogSnapshotId &&
      catalog.catalogSnapshotId === context.graph.catalogSnapshotId &&
      catalog.catalogSha256 === context.graph.catalogSha256 &&
      catalog.catalogSha256 === context.result.catalogSha256,
    "catalog:binding",
  );
  requireInvariant(
    catalog.inputSnapshotId === context.graph.inputSnapshotId &&
      catalog.inputSnapshotId ===
        context.governance.sourceSnapshot.snapshotId &&
      context.governance.sourceSnapshot.contentSha256 ===
        context.graph.inputSha256 &&
      context.graph.inputSha256 === context.result.inputSha256,
    "input:binding",
  );
  requireInvariant(
    catalog.measure.fieldId === context.contract.measureFieldId &&
      catalog.measure.semanticType === "measure" &&
      catalog.measure.eventTimeFieldId === catalog.eventTime.fieldId &&
      catalog.eventTime.semanticType === "event_time" &&
      catalog.eventTime.scalarType === "timestamp" &&
      (catalog.measure.unit === null || catalog.measure.currency === null),
    "catalog:measure-event-time-eligibility",
  );
  const aggregationEnum = [
    "count",
    "count_distinct",
    "sum",
    "min",
    "max",
    "mean",
    "median",
    "ratio",
  ];
  requireInvariant(
    phase7IsUnsignedUtf8SortedUnique(catalog.measure.allowedAggregations) &&
      catalog.measure.allowedAggregations.every((value) =>
        aggregationEnum.includes(value),
      ) &&
      (catalog.measure.allowedAggregations as readonly string[]).includes(
        aggregation,
      ),
    "catalog:allowed-aggregations-canonical",
  );
  requireInvariant(
    phase7IsUnsignedUtf8SortedUnique(catalog.stableKeyFieldIds) &&
      phase7IsUnsignedUtf8SortedUnique(catalog.measure.allowedDimensions) &&
      JSON.stringify(catalog.measure.allowedDimensions) ===
        JSON.stringify(context.contract.allowedDimensionFieldIds) &&
      JSON.stringify(catalog.dimensions.map(({ fieldId }) => fieldId)) ===
        JSON.stringify(context.contract.allowedDimensionFieldIds) &&
      catalog.dimensions.every(({ semanticType }) =>
        ["dimension", "identifier"].includes(semanticType),
      ),
    "catalog:dimension-closure",
  );
  const catalogLineageArrays = [
    catalog.measure.lineageEvidenceIds,
    catalog.eventTime.lineageEvidenceIds,
    ...catalog.dimensions.map(({ lineageEvidenceIds }) => lineageEvidenceIds),
    catalog.denominatorMeasure.lineageEvidenceIds,
    context.denominatorContract.lineageEvidenceIds,
  ];
  requireInvariant(
    catalogLineageArrays.every(phase7IsUnsignedUtf8SortedUnique) &&
      phase7IsUnsignedUtf8SortedUnique(
        catalog.denominatorMeasure.allowedAggregations,
      ) &&
      catalog.denominatorMeasure.allowedAggregations.every((value) =>
        aggregationEnum.includes(value),
      ),
    "catalog:all-entry-arrays-canonical",
  );
  const exactLineage = [
    ...catalog.measure.lineageEvidenceIds,
    ...catalog.eventTime.lineageEvidenceIds,
    ...catalog.dimensions.flatMap(
      ({ lineageEvidenceIds }) => lineageEvidenceIds,
    ),
    ...(aggregation === "ratio"
      ? context.denominatorContract.lineageEvidenceIds
      : []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  exactLineage.sort(phase7UnsignedUtf8Compare);
  const evidenceRows = context.governance.commonBundle.evidenceRows;
  requireInvariant(
    JSON.stringify(context.contract.lineageEvidenceIds) ===
      JSON.stringify(exactLineage) &&
      JSON.stringify(context.governance.exactLineageUnion) ===
        JSON.stringify(exactLineage) &&
      JSON.stringify(evidenceRows.map(({ evidenceId }) => evidenceId)) ===
        JSON.stringify(exactLineage) &&
      evidenceRows.every(
        (row) =>
          row.sourceSnapshotId === catalog.inputSnapshotId &&
          row.sourceSha256 === context.graph.inputSha256 &&
          row.freshness === "current",
      ),
    "lineage:exact-current-bundle-union",
  );
  requireInvariant(
    context.governance.commonBundle.bundleId === context.graph.commonBundleId &&
      context.graph.commonBundleId === context.result.commonBundleId &&
      context.governance.commonBundle.bundleSha256 ===
        context.graph.commonBundleSha256 &&
      context.graph.commonBundleSha256 === context.result.commonBundleSha256 &&
      context.governance.commonBundle.sourceSnapshotId ===
        catalog.inputSnapshotId,
    "bundle:binding",
  );
  requireInvariant(
    context.governance.contractSetHashRecomputed &&
      context.contract.contractSetId === context.graph.contractSetId &&
      context.contract.contractId === context.graph.contractId &&
      context.contract.contractVersion === context.graph.contractVersion,
    "contract:graph-binding",
  );
  const derivedGrain = phase7MetricGroupGrain(
    context.contract.calendar,
    context.contract.timezone,
    context.contract.allowedDimensionFieldIds,
  );
  requireInvariant(
    context.contract.grain === derivedGrain &&
      context.governance.derivedGrain === derivedGrain &&
      context.graph.output.grain === derivedGrain,
    "contract:derived-grain",
  );
  if (aggregation === "ratio") {
    requireInvariant(
      context.contract.denominatorContractId ===
        context.denominatorContract.contractId &&
        context.contract.denominatorContractVersion ===
          context.denominatorContract.contractVersion &&
        String(context.denominatorContract.contractId) !==
          String(context.contract.contractId) &&
        context.denominatorContract.aggregation === "sum" &&
        context.denominatorContract.reviewState === "reviewed" &&
        context.denominatorContract.contractSetId ===
          context.contract.contractSetId &&
        context.denominatorContract.catalogSnapshotId ===
          context.contract.catalogSnapshotId &&
        context.denominatorContract.calendar === context.contract.calendar &&
        context.denominatorContract.timezone === context.contract.timezone &&
        context.denominatorContract.grain === derivedGrain &&
        JSON.stringify(context.denominatorContract.allowedDimensionFieldIds) ===
          JSON.stringify(context.contract.allowedDimensionFieldIds) &&
        context.denominatorContract.eventTimeFieldId ===
          catalog.measure.eventTimeFieldId &&
        catalog.denominatorMeasure.fieldId ===
          context.denominatorContract.measureFieldId &&
        catalog.denominatorMeasure.semanticType === "measure" &&
        catalog.denominatorMeasure.eventTimeFieldId ===
          catalog.measure.eventTimeFieldId &&
        catalog.denominatorMeasure.allowedAggregations.includes("sum") &&
        catalog.denominatorMeasure.unit === catalog.measure.unit &&
        catalog.denominatorMeasure.currency === catalog.measure.currency,
      "contract:ratio-denominator",
    );
  } else {
    requireInvariant(
      context.contract.denominatorContractId === null &&
        context.contract.denominatorContractVersion === null,
      "contract:nonratio-denominator-null",
    );
  }

  const expectedSourceFieldIds = [
    ...catalog.stableKeyFieldIds,
    catalog.measure.fieldId,
    catalog.eventTime.fieldId,
    ...context.contract.allowedDimensionFieldIds,
    ...(aggregation === "ratio" ? [catalog.denominatorMeasure.fieldId] : []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  expectedSourceFieldIds.sort(phase7UnsignedUtf8Compare);
  requireInvariant(
    phase7IsUnsignedUtf8SortedUnique(context.graph.source.fieldIds) &&
      JSON.stringify(context.graph.source.fieldIds) ===
        JSON.stringify(expectedSourceFieldIds) &&
      JSON.stringify(context.graph.source.requiredFieldIds) ===
        JSON.stringify(expectedSourceFieldIds),
    "graph:source-field-closure",
  );
  requireInvariant(
    context.graph.schema === "calculation-graph-v1" &&
      context.graph.registry === "calculation-registry-v1" &&
      context.graph.limits === "calculation-limits-v1" &&
      context.graph.unitRegistryVersion === "ucum-subset-v1" &&
      context.graph.directFields.measure.fieldId === catalog.measure.fieldId &&
      context.graph.directFields.measure.input ===
        context.graph.source.nodeId &&
      context.graph.directFields.eventTime.fieldId ===
        catalog.eventTime.fieldId &&
      context.graph.directFields.eventTime.input ===
        context.graph.source.nodeId &&
      context.graph.directFields.dimensions.every(
        (field, index) =>
          field.fieldId === context.contract.allowedDimensionFieldIds[index] &&
          field.input === context.graph.source.nodeId,
      ) &&
      context.graph.group.input === context.graph.source.nodeId,
    "graph:closed-schema-and-direct-path",
  );
  requireInvariant(
    context.graph.aggregation.op === aggregation,
    "graph:aggregation-mapping",
  );
  const expectedPathOps =
    aggregation === "ratio"
      ? ["source", "field", "group", "sum", "divide", "unit_convert"]
      : context.graph.conversion === null
        ? ["source", "field", "group", aggregation]
        : ["source", "field", "group", aggregation, "currency_convert"];
  requireInvariant(
    JSON.stringify(context.graph.pathOps) === JSON.stringify(expectedPathOps) &&
      !context.graph.pathOps.some((operation) =>
        [
          "filter",
          "sort",
          "top_k",
          "lag",
          "window_sum",
          "window_mean",
          "if_then_else",
        ].includes(operation),
      ),
    "graph:exact-contracted-path",
  );
  if (aggregation === "ratio") {
    requireInvariant(
      context.graph.directFields.denominatorMeasure?.fieldId ===
        catalog.denominatorMeasure.fieldId &&
        context.graph.directFields.denominatorMeasure.input ===
          context.graph.source.nodeId &&
        context.graph.aggregation.denominatorInput ===
          context.graph.directFields.denominatorMeasure.nodeId &&
        context.graph.aggregation.denominatorGroupNodeId ===
          context.graph.group.nodeId &&
        context.graph.aggregation.scale === "18" &&
        context.graph.aggregation.rounding === "half_even" &&
        context.graph.aggregation.numeratorOp === "sum" &&
        context.graph.aggregation.denominatorOp === "sum" &&
        context.graph.aggregation.divideOp === "divide",
      "graph:ratio-mapping",
    );
  } else {
    requireInvariant(
      context.graph.directFields.denominatorMeasure === null &&
        context.graph.aggregation.denominatorInput === null &&
        context.graph.aggregation.denominatorGroupNodeId === null,
      "graph:nonratio-denominator-null",
    );
  }
  const conversion = context.graph.conversion;
  const expectedOutputNodeId =
    conversion?.nodeId ?? context.graph.aggregation.nodeId;
  requireInvariant(
    context.graph.conversionCount === (conversion === null ? 0 : 1) &&
      JSON.stringify(context.graph.conversionKinds) ===
        JSON.stringify(conversion === null ? [] : [conversion.op]) &&
      context.graph.contractOutputNodeId === expectedOutputNodeId &&
      context.graph.output.nodeId === expectedOutputNodeId &&
      context.graph.output.valueType === context.contract.valueType &&
      context.graph.output.unit === context.contract.unit &&
      context.graph.output.currency === context.contract.currency &&
      context.graph.output.shape === "scalar" &&
      context.graph.output.scalar === "decimal" &&
      context.graph.output.nullable === false &&
      context.graph.output.maxValueBytes === "74" &&
      context.graph.output.evaluationRowsFrom === context.graph.group.nodeId,
    "graph:conversion-output-shape",
  );
  if (conversion?.op === "currency_convert") {
    const evidence = evidenceRows.find(
      ({ evidenceId }) => evidenceId === conversion.fxEvidenceId,
    );
    requireInvariant(
      conversion.input === context.graph.aggregation.nodeId &&
        conversion.fromCurrency === catalog.measure.currency &&
        conversion.toCurrency === context.contract.currency &&
        conversion.scale === "2" &&
        conversion.rounding === "half_even" &&
        conversion.fromUnit === null &&
        conversion.toUnit === null &&
        conversion.unitRegistryVersion === null &&
        conversion.fxEvidenceId === context.graph.fxEvidenceId &&
        conversion.fxEvidenceSha256 === context.graph.fxEvidenceSha256 &&
        evidence?.evidenceSha256 === conversion.fxEvidenceSha256 &&
        conversion.fxBodyFromCurrency === conversion.fromCurrency &&
        conversion.fxBodyToCurrency === conversion.toCurrency &&
        conversion.fxObservedAt === evidence?.observedAt,
      "graph:currency-conversion",
    );
  } else if (conversion?.op === "unit_convert") {
    requireInvariant(
      conversion.input === context.graph.aggregation.nodeId &&
        conversion.fromUnit === "1" &&
        conversion.toUnit === "%" &&
        conversion.unitRegistryVersion === "ucum-subset-v1" &&
        conversion.scale === "18" &&
        conversion.rounding === "half_even" &&
        conversion.fromCurrency === null &&
        conversion.toCurrency === null &&
        conversion.fxEvidenceId === null &&
        conversion.fxEvidenceSha256 === null &&
        context.graph.fxEvidenceId === null &&
        context.graph.fxEvidenceSha256 === null,
      "graph:unit-conversion",
    );
  } else {
    requireInvariant(
      conversion === null &&
        context.graph.fxEvidenceId === null &&
        context.graph.fxEvidenceSha256 === null &&
        context.contract.currency === catalog.measure.currency,
      "graph:no-conversion",
    );
  }

  type GraphNodeKind =
    | "source"
    | "field"
    | "group"
    | "aggregation"
    | "conversion"
    | "literal"
    | "comparison"
    | "classifier";
  const nodes = new Map<
    string,
    Readonly<{ kind: GraphNodeKind; dependencies: readonly string[] }>
  >();
  const addNode = (
    nodeId: string,
    kind: GraphNodeKind,
    dependencies: readonly string[],
  ): void => {
    const duplicate = nodes.has(nodeId);
    requireInvariant(!duplicate, `graph:duplicate-node:${nodeId}`);
    if (!duplicate) nodes.set(nodeId, { kind, dependencies });
  };
  addNode(context.graph.source.nodeId, "source", []);
  addNode(context.graph.directFields.measure.nodeId, "field", [
    context.graph.directFields.measure.input,
  ]);
  if (context.graph.directFields.denominatorMeasure !== null) {
    addNode(context.graph.directFields.denominatorMeasure.nodeId, "field", [
      context.graph.directFields.denominatorMeasure.input,
    ]);
  }
  addNode(context.graph.directFields.eventTime.nodeId, "field", [
    context.graph.directFields.eventTime.input,
  ]);
  context.graph.directFields.dimensions.forEach(({ nodeId, input }) =>
    addNode(nodeId, "field", [input]),
  );
  addNode(context.graph.group.nodeId, "group", [
    context.graph.group.input,
    ...context.graph.group.keyNodeIds,
  ]);
  addNode(context.graph.aggregation.nodeId, "aggregation", [
    context.graph.aggregation.input,
    context.graph.aggregation.groupNodeId,
    ...(context.graph.aggregation.denominatorInput === null
      ? []
      : [context.graph.aggregation.denominatorInput]),
    ...(context.graph.aggregation.denominatorGroupNodeId === null
      ? []
      : [context.graph.aggregation.denominatorGroupNodeId]),
  ]);
  if (conversion !== null)
    addNode(conversion.nodeId, "conversion", [conversion.input]);
  const freshnessDiagnostic = context.graph.freshnessDiagnostic;
  if (freshnessDiagnostic !== null) {
    addNode(freshnessDiagnostic.field.nodeId, "field", [
      freshnessDiagnostic.field.input,
    ]);
    addNode(freshnessDiagnostic.group.nodeId, "group", [
      freshnessDiagnostic.group.input,
      ...freshnessDiagnostic.group.keyNodeIds,
    ]);
    addNode(freshnessDiagnostic.maximum.nodeId, "aggregation", [
      freshnessDiagnostic.maximum.input,
      freshnessDiagnostic.maximum.groupNodeId,
    ]);
    addNode(freshnessDiagnostic.classifier.nodeId, "classifier", [
      freshnessDiagnostic.classifier.input,
    ]);
  }
  const diagnostics = context.graph.thresholdDiagnostics;
  if (
    diagnostics.thresholdNodeId !== null &&
    diagnostics.targetNodeId !== null &&
    diagnostics.thresholdLiteralNodeId !== null &&
    diagnostics.targetLiteralNodeId !== null
  ) {
    addNode(diagnostics.thresholdLiteralNodeId, "literal", [
      context.graph.group.nodeId,
    ]);
    addNode(diagnostics.targetLiteralNodeId, "literal", [
      context.graph.group.nodeId,
    ]);
    addNode(diagnostics.thresholdNodeId, "comparison", [
      diagnostics.thresholdComparison?.left ?? "",
      diagnostics.thresholdComparison?.right ?? "",
    ]);
    addNode(diagnostics.targetNodeId, "comparison", [
      diagnostics.targetComparison?.left ?? "",
      diagnostics.targetComparison?.right ?? "",
    ]);
  }
  const topologicalNodeIdCounts = context.graph.topologicalNodeIds.reduce(
    (counts, nodeId) => counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1),
    new Map<string, number>(),
  );
  const isNodeReference = (
    nodeId: string | null,
    requiredKinds?: readonly GraphNodeKind[],
  ): boolean => {
    if (nodeId === null) return false;
    const node = nodes.get(nodeId);
    return (
      node !== undefined &&
      topologicalNodeIdCounts.get(nodeId) === 1 &&
      (requiredKinds === undefined || requiredKinds.includes(node.kind))
    );
  };
  requireInvariant(
    [...nodes.keys()].every(
      (nodeId) => topologicalNodeIdCounts.get(nodeId) === 1,
    ) &&
      [...topologicalNodeIdCounts.keys()].every((nodeId) => nodes.has(nodeId)),
    "graph:node-topology-cardinality",
  );
  requireInvariant(
    isNodeReference(context.graph.source.nodeId, ["source"]) &&
      [
        context.graph.directFields.measure,
        context.graph.directFields.eventTime,
        ...context.graph.directFields.dimensions,
        ...(context.graph.directFields.denominatorMeasure === null
          ? []
          : [context.graph.directFields.denominatorMeasure]),
      ].every(
        (field) =>
          isNodeReference(field.nodeId, ["field"]) &&
          isNodeReference(field.input, ["source"]),
      ),
    "graph:source-and-direct-field-node-edges",
  );
  requireInvariant(
    isNodeReference(context.graph.group.nodeId, ["group"]) &&
      isNodeReference(context.graph.group.input, ["source"]) &&
      JSON.stringify(context.graph.group.keyNodeIds) ===
        JSON.stringify(
          context.graph.directFields.dimensions.map(({ nodeId }) => nodeId),
        ) &&
      context.graph.group.keyNodeIds.every((nodeId) =>
        isNodeReference(nodeId, ["field"]),
      ),
    "graph:group-key-node-edge",
  );
  requireInvariant(
    isNodeReference(context.graph.aggregation.nodeId, ["aggregation"]) &&
      context.graph.aggregation.input ===
        context.graph.directFields.measure.nodeId &&
      isNodeReference(context.graph.aggregation.input, ["field"]),
    "graph:aggregation-input-node-edge",
  );
  requireInvariant(
    context.graph.aggregation.groupNodeId === context.graph.group.nodeId &&
      isNodeReference(context.graph.aggregation.groupNodeId, ["group"]),
    "graph:aggregation-group-node-edge",
  );
  requireInvariant(
    conversion === null ||
      (isNodeReference(conversion.nodeId, ["conversion"]) &&
        conversion.input === context.graph.aggregation.nodeId &&
        isNodeReference(conversion.input, ["aggregation"])),
    "graph:conversion-node-edge",
  );
  requireInvariant(
    aggregation !== "ratio" ||
      (context.graph.directFields.denominatorMeasure !== null &&
        context.graph.aggregation.denominatorInput ===
          context.graph.directFields.denominatorMeasure.nodeId &&
        isNodeReference(context.graph.aggregation.denominatorInput, [
          "field",
        ]) &&
        context.graph.aggregation.denominatorGroupNodeId ===
          context.graph.group.nodeId &&
        isNodeReference(context.graph.aggregation.denominatorGroupNodeId, [
          "group",
        ])),
    "graph:ratio-node-edges",
  );
  const emitted = new Set<string>();
  const topologicalNodeIds: string[] = [];
  while (topologicalNodeIds.length < nodes.size) {
    const ready = [...nodes]
      .filter(
        ([nodeId, { dependencies }]) =>
          !emitted.has(nodeId) &&
          dependencies.every((dependency) => emitted.has(dependency)),
      )
      .map(([nodeId]) => nodeId)
      .sort(phase7UnsignedUtf8Compare);
    if (ready.length === 0) break;
    emitted.add(ready[0]!);
    topologicalNodeIds.push(ready[0]!);
  }
  requireInvariant(
    topologicalNodeIds.length === nodes.size &&
      JSON.stringify(context.graph.topologicalNodeIds) ===
        JSON.stringify(topologicalNodeIds),
    "graph:canonical-topological-order",
  );
  requireInvariant(
    phase7IsUnsignedUtf8SortedUnique(context.graph.outputNodeIds) &&
      context.graph.outputNodeIds.every((nodeId) => isNodeReference(nodeId)) &&
      context.graph.outputNodeIds.includes(
        context.graph.contractOutputNodeId,
      ) &&
      isNodeReference(context.graph.contractOutputNodeId, [
        conversion === null ? "aggregation" : "conversion",
      ]) &&
      context.graph.output.nodeId === context.graph.contractOutputNodeId &&
      isNodeReference(context.graph.output.nodeId, [
        conversion === null ? "aggregation" : "conversion",
      ]) &&
      context.graph.output.evaluationRowsFrom === context.graph.group.nodeId &&
      isNodeReference(context.graph.output.evaluationRowsFrom, ["group"]),
    "graph:output-node-order",
  );
  requireInvariant(
    context.graph.otherOutputs.every(({ nodeId }) => isNodeReference(nodeId)),
    "graph:other-output-node-references",
  );
  if (direction === "neutral") {
    requireInvariant(
      Object.values(diagnostics).every((value) =>
        Array.isArray(value) ? value.length === 0 : value === null,
      ),
      "graph:neutral-diagnostics",
    );
  } else {
    const expectedComparison =
      direction === "lower_is_better" ? "less_equal" : "greater_equal";
    requireInvariant(
      diagnostics.thresholdComparison?.left ===
        context.graph.contractOutputNodeId &&
        diagnostics.thresholdComparison.right ===
          diagnostics.thresholdLiteralNodeId &&
        diagnostics.targetComparison?.left ===
          context.graph.contractOutputNodeId &&
        diagnostics.targetComparison.right ===
          diagnostics.targetLiteralNodeId &&
        diagnostics.thresholdLiteralValue === context.contract.threshold &&
        diagnostics.targetLiteralValue === context.contract.target &&
        diagnostics.thresholdComparison.op === expectedComparison &&
        diagnostics.targetComparison.op ===
          (direction === "target_band" ? "less_equal" : expectedComparison) &&
        JSON.stringify(diagnostics.thresholdLiteralConsumers) ===
          JSON.stringify([diagnostics.thresholdNodeId]) &&
        JSON.stringify(diagnostics.targetLiteralConsumers) ===
          JSON.stringify([diagnostics.targetNodeId]) &&
        isNodeReference(diagnostics.thresholdNodeId, ["comparison"]) &&
        isNodeReference(diagnostics.targetNodeId, ["comparison"]) &&
        isNodeReference(diagnostics.thresholdLiteralNodeId, ["literal"]) &&
        isNodeReference(diagnostics.targetLiteralNodeId, ["literal"]) &&
        isNodeReference(diagnostics.thresholdComparison.left) &&
        isNodeReference(diagnostics.thresholdComparison.right, ["literal"]) &&
        isNodeReference(diagnostics.targetComparison.left) &&
        isNodeReference(diagnostics.targetComparison.right, ["literal"]) &&
        diagnostics.thresholdLiteralConsumers.every((nodeId) =>
          isNodeReference(nodeId, ["comparison"]),
        ) &&
        diagnostics.targetLiteralConsumers.every((nodeId) =>
          isNodeReference(nodeId, ["comparison"]),
        ) &&
        new Set([
          context.graph.contractOutputNodeId,
          diagnostics.thresholdNodeId,
          diagnostics.targetNodeId,
          diagnostics.thresholdLiteralNodeId,
          diagnostics.targetLiteralNodeId,
        ]).size === 5,
      "graph:direction-diagnostics",
    );
  }

  requireInvariant(
    context.result.schema === "calculation-result-v1" &&
      context.result.state === "succeeded" &&
      context.result.errorCode === null &&
      context.result.graphId === context.graph.graphId &&
      JSON.stringify(context.result.outputs.map(({ nodeId }) => nodeId)) ===
        JSON.stringify(context.graph.outputNodeIds) &&
      context.result.outputs.every(
        (output) =>
          output.outputSha256 === output.canonicalOutputSha256 &&
          isNodeReference(output.nodeId) &&
          isNodeReference(output.evaluationRowsFrom, ["group"]),
      ),
    "result:success-shape-order-hashes",
  );
  const contractOutput = context.result.outputs.find(
    ({ nodeId }) => nodeId === context.graph.contractOutputNodeId,
  );
  requireInvariant(
    contractOutput?.shape === context.graph.output.shape &&
      contractOutput.scalar === context.graph.output.scalar &&
      contractOutput.valueType === context.graph.output.valueType &&
      contractOutput.unit === context.graph.output.unit &&
      contractOutput.currency === context.graph.output.currency &&
      contractOutput.grain === context.graph.output.grain &&
      contractOutput.maxValueBytes === context.graph.output.maxValueBytes &&
      contractOutput.evaluationRowsFrom ===
        context.graph.output.evaluationRowsFrom,
    "result:contract-output-metadata",
  );
  requireInvariant(
    context.graph.otherOutputs.every(
      ({ nodeId, sourceIdentity, catalogSnapshotId, commonBundleId }) =>
        context.graph.outputNodeIds.includes(nodeId as never) &&
        sourceIdentity === context.graph.source.sourceIdentity &&
        catalogSnapshotId === context.graph.catalogSnapshotId &&
        commonBundleId === context.graph.commonBundleId,
    ),
    "graph:other-output-bindings",
  );

  const evaluationUs = phase7MetricInstantMicroseconds(
    context.graph.evaluationTime,
  );
  requireInvariant(
    evaluationUs !== null &&
      evaluationUs === BigInt(context.freshness.evaluationUs),
    "freshness:evaluation-time",
  );
  if (freshnessDiagnostic === null) {
    requireInvariant(
      context.graph.derivedFreshnessProjection.classifierNodeId === null &&
        context.graph.derivedFreshnessProjection.inputNodeId === null &&
        context.graph.derivedFreshnessProjection.sourceRowId === null &&
        Number(context.graph.matchingFreshnessStructureCount) === 0 &&
        Number(context.graph.matchingFreshnessComponents.length) === 0 &&
        Number(context.graph.otherOutputs.length) === 0,
      "freshness:absent-shape",
    );
  } else {
    requireInvariant(
      freshnessDiagnostic.field.op === "field" &&
        freshnessDiagnostic.field.fieldId === catalog.eventTime.fieldId &&
        freshnessDiagnostic.field.input === context.graph.source.nodeId &&
        isNodeReference(freshnessDiagnostic.field.nodeId, ["field"]) &&
        isNodeReference(freshnessDiagnostic.field.input, ["source"]) &&
        freshnessDiagnostic.group.op === "group" &&
        freshnessDiagnostic.group.input === context.graph.source.nodeId &&
        freshnessDiagnostic.group.keyNodeIds.length === 0 &&
        isNodeReference(freshnessDiagnostic.group.nodeId, ["group"]) &&
        isNodeReference(freshnessDiagnostic.group.input, ["source"]) &&
        freshnessDiagnostic.maximum.op === "max" &&
        freshnessDiagnostic.maximum.input ===
          freshnessDiagnostic.field.nodeId &&
        freshnessDiagnostic.maximum.groupNodeId ===
          freshnessDiagnostic.group.nodeId &&
        isNodeReference(freshnessDiagnostic.maximum.nodeId, ["aggregation"]) &&
        isNodeReference(freshnessDiagnostic.maximum.input, ["field"]) &&
        isNodeReference(freshnessDiagnostic.maximum.groupNodeId, ["group"]) &&
        freshnessDiagnostic.classifier.op === "classify_state" &&
        freshnessDiagnostic.classifier.input ===
          freshnessDiagnostic.maximum.nodeId &&
        isNodeReference(freshnessDiagnostic.classifier.nodeId, [
          "classifier",
        ]) &&
        isNodeReference(freshnessDiagnostic.classifier.input, [
          "aggregation",
        ]) &&
        freshnessDiagnostic.classifier.evaluationTime ===
          context.graph.evaluationTime &&
        freshnessDiagnostic.classifier.staleAfterMillis ===
          context.freshness.checkedLagAndSloMillis &&
        context.graph.derivedFreshnessProjection.classifierNodeId ===
          freshnessDiagnostic.classifier.nodeId &&
        context.graph.derivedFreshnessProjection.inputNodeId ===
          freshnessDiagnostic.maximum.nodeId &&
        isNodeReference(
          context.graph.derivedFreshnessProjection.classifierNodeId,
          ["classifier"],
        ) &&
        isNodeReference(context.graph.derivedFreshnessProjection.inputNodeId, [
          "aggregation",
        ]) &&
        context.graph.matchingFreshnessStructureCount === 1 &&
        JSON.stringify(context.graph.matchingFreshnessComponents) ===
          JSON.stringify(["field", "group", "max", "classifier"]) &&
        context.graph.callerFreshnessProjectionKeys.length === 0,
      "freshness:diagnostic-shape",
    );
    const classifierOutput = context.result.outputs.find(
      ({ nodeId }) => nodeId === freshnessDiagnostic.classifier.nodeId,
    );
    requireInvariant(
      (context.graph.outputNodeIds as readonly string[]).includes(
        freshnessDiagnostic.classifier.nodeId,
      ) &&
        classifierOutput?.scalar === "text" &&
        classifierOutput.grain ===
          phase7MetricGroupGrain(
            context.contract.calendar,
            context.contract.timezone,
            [],
          ) &&
        classifierOutput.maxValueBytes === "9" &&
        classifierOutput.evaluationRowsFrom ===
          freshnessDiagnostic.group.nodeId,
      "freshness:result-output",
    );
    const admittedRows = context.freshness.sourceRows.filter(
      (row) => row.state === "present" || row.state === "stale",
    );
    requireInvariant(
      context.freshness.sourceRows.every(
        ({ ordinal, state, eventTimeUs }, index) =>
          ordinal === String(index) &&
          ["present", "stale", "null", "missing", "unavailable"].includes(
            state,
          ) &&
          (["present", "stale"].includes(state)
            ? eventTimeUs !== null
            : eventTimeUs === null),
      ) &&
        admittedRows.length > 0 &&
        admittedRows.every(({ eventTimeUs }) => eventTimeUs !== null),
      "freshness:source-row-shape",
    );
    const maximumEventTimeUs = admittedRows.reduce(
      (maximum, row) =>
        BigInt(row.eventTimeUs!) > maximum ? BigInt(row.eventTimeUs!) : maximum,
      BigInt(admittedRows[0]!.eventTimeUs!),
    );
    const firstMaximum = admittedRows.find(
      ({ eventTimeUs }) => BigInt(eventTimeUs!) === maximumEventTimeUs,
    );
    requireInvariant(
      maximumEventTimeUs === BigInt(context.freshness.maximumEventTimeUs) &&
        maximumEventTimeUs <= BigInt(context.freshness.evaluationUs) &&
        firstMaximum?.rowId === context.freshness.firstMaximumSourceRowId &&
        context.graph.derivedFreshnessProjection.sourceRowId ===
          context.freshness.firstMaximumSourceRowId,
      "freshness:maximum-and-tie-row",
    );
    const cutoffUs = BigInt(context.freshness.checkedLagAndSloMillis) * 1_000n;
    requireInvariant(
      context.freshness.classifierState ===
        (BigInt(context.freshness.evaluationUs) - maximumEventTimeUs <= cutoffUs
          ? "current"
          : "stale"),
      "freshness:classifier-boundary",
    );
    for (const [name, observedUs] of [
      ["catalog", context.freshness.catalogObservedUs],
      ["source", context.freshness.sourceObservedUs],
      ["lineage", context.freshness.lineageObservedUs],
    ] as const) {
      requireInvariant(
        BigInt(context.freshness.evaluationUs) - BigInt(observedUs) <= cutoffUs,
        `freshness:${name}-boundary`,
      );
    }
    requireInvariant(
      phase7MetricInstantMicroseconds(catalog.evaluatedAt) ===
        BigInt(context.freshness.catalogObservedUs) &&
        phase7MetricInstantMicroseconds(
          context.governance.sourceSnapshot.observedAt,
        ) === BigInt(context.freshness.sourceObservedUs) &&
        evidenceRows.every(
          ({ observedAt }) =>
            phase7MetricInstantMicroseconds(observedAt) ===
            BigInt(context.freshness.lineageObservedUs),
        ),
      "freshness:source-catalog-lineage-time-bindings",
    );
    if (conversion?.op === "currency_convert") {
      const fxObservedUs = phase7MetricInstantMicroseconds(
        conversion.fxObservedAt!,
      );
      requireInvariant(
        fxObservedUs !== null &&
          BigInt(context.freshness.evaluationUs) - fxObservedUs <=
            BigInt(context.freshness.fxMaximumAgeMillis) * 1_000n,
        "freshness:fx-boundary",
      );
    }
  }
  return violations;
}

function phase7ApplyMetricPatches(
  baseline: Phase7MetricContractContext,
  patches: readonly Phase7MetricConformancePatch[],
): Phase7MetricContractContext {
  const materialized = structuredClone(baseline);
  const seen = new Set<string>();
  for (const patch of patches) {
    if (seen.has(patch.path)) {
      throw new TypeError(
        `duplicate MetricContractVersion patch: ${patch.path}`,
      );
    }
    seen.add(patch.path);
    const path = patch.path.split(".");
    const leaf = path.pop()!;
    let target = materialized as unknown as Record<string, unknown>;
    for (const segment of path) {
      const next = target[segment];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new TypeError(
          `unknown MetricContractVersion patch parent: ${patch.path}`,
        );
      }
      target = next as Record<string, unknown>;
    }
    if (!(leaf in target)) {
      throw new TypeError(`unknown MetricContractVersion patch: ${patch.path}`);
    }
    target[leaf] = structuredClone(patch.value);
  }
  return materialized;
}

function phase7MetricChangedPaths(
  baseline: unknown,
  materialized: unknown,
  prefix = "",
): string[] {
  if (Array.isArray(baseline) || Array.isArray(materialized)) {
    return JSON.stringify(baseline) === JSON.stringify(materialized)
      ? []
      : [prefix];
  }
  if (
    baseline !== null &&
    materialized !== null &&
    typeof baseline === "object" &&
    typeof materialized === "object"
  ) {
    const before = baseline as Record<string, unknown>;
    const after = materialized as Record<string, unknown>;
    if (Object.keys(before).join("\0") !== Object.keys(after).join("\0")) {
      throw new TypeError(`MetricContractVersion shape drift at ${prefix}`);
    }
    return Object.keys(before).flatMap((key) =>
      phase7MetricChangedPaths(
        before[key],
        after[key],
        prefix.length === 0 ? key : `${prefix}.${key}`,
      ),
    );
  }
  return Object.is(baseline, materialized) ? [] : [prefix];
}

const phase7RatioBaselinePatches = [
  { path: "contract.aggregation", value: "ratio" },
  {
    path: "contract.denominatorContractId",
    value: "00000000-0000-8000-8000-000000000114",
  },
  { path: "contract.denominatorContractVersion", value: "1" },
  { path: "contract.valueType", value: "percentage" },
  { path: "contract.unit", value: "%" },
  { path: "contract.currency", value: null },
  { path: "catalog.measure.currency", value: null },
  {
    path: "catalog.measure.allowedAggregations",
    value: ["ratio", "sum"],
  },
  {
    path: "contract.lineageEvidenceIds",
    value: [
      "00000000-0000-8000-8000-000000000106",
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
      "00000000-0000-8000-8000-000000000116",
    ],
  },
  {
    path: "governance.exactLineageUnion",
    value: [
      "00000000-0000-8000-8000-000000000106",
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
      "00000000-0000-8000-8000-000000000116",
    ],
  },
  {
    path: "governance.commonBundle.evidenceRows",
    value: [
      ...phase7ValidMetricContractContext.governance.commonBundle.evidenceRows,
      {
        evidenceId: "00000000-0000-8000-8000-000000000116",
        sourceSnapshotId: "00000000-0000-8000-8000-000000000101",
        sourceSha256: "50".repeat(32),
        evidenceSha256: "54".repeat(32),
        observedAt: "2026-08-04T12:00:00.000000Z",
        freshness: "current",
      },
    ],
  },
  {
    path: "graph.source.fieldIds",
    value: [
      "00000000-0000-8000-8000-000000000201",
      "00000000-0000-8000-8000-000000000202",
      "00000000-0000-8000-8000-000000000203",
      "00000000-0000-8000-8000-000000000204",
      "00000000-0000-8000-8000-000000000212",
    ],
  },
  {
    path: "graph.source.requiredFieldIds",
    value: [
      "00000000-0000-8000-8000-000000000201",
      "00000000-0000-8000-8000-000000000202",
      "00000000-0000-8000-8000-000000000203",
      "00000000-0000-8000-8000-000000000204",
      "00000000-0000-8000-8000-000000000212",
    ],
  },
  { path: "graph.aggregation.op", value: "ratio" },
  {
    path: "graph.directFields.denominatorMeasure",
    value: {
      nodeId: "00000000-0000-8000-8000-000000000603",
      fieldId: "00000000-0000-8000-8000-000000000212",
      input: "00000000-0000-8000-8000-000000000601",
    },
  },
  {
    path: "graph.aggregation.denominatorInput",
    value: "00000000-0000-8000-8000-000000000603",
  },
  {
    path: "graph.aggregation.denominatorGroupNodeId",
    value: "00000000-0000-8000-8000-000000000606",
  },
  { path: "graph.aggregation.scale", value: "18" },
  { path: "graph.aggregation.rounding", value: "half_even" },
  { path: "graph.aggregation.numeratorOp", value: "sum" },
  { path: "graph.aggregation.denominatorOp", value: "sum" },
  { path: "graph.aggregation.divideOp", value: "divide" },
  {
    path: "graph.pathOps",
    value: ["source", "field", "group", "sum", "divide", "unit_convert"],
  },
  { path: "graph.conversion.op", value: "unit_convert" },
  { path: "graph.conversionKinds", value: ["unit_convert"] },
  { path: "graph.conversion.fromUnit", value: "1" },
  { path: "graph.conversion.toUnit", value: "%" },
  {
    path: "graph.conversion.unitRegistryVersion",
    value: "ucum-subset-v1",
  },
  { path: "graph.conversion.fromCurrency", value: null },
  { path: "graph.conversion.toCurrency", value: null },
  { path: "graph.conversion.scale", value: "18" },
  { path: "graph.conversion.fxEvidenceId", value: null },
  { path: "graph.conversion.fxEvidenceSha256", value: null },
  { path: "graph.conversion.fxBodyFromCurrency", value: null },
  { path: "graph.conversion.fxBodyToCurrency", value: null },
  { path: "graph.conversion.fxObservedAt", value: null },
  { path: "graph.fxEvidenceId", value: null },
  { path: "graph.fxEvidenceSha256", value: null },
  {
    path: "graph.topologicalNodeIds",
    value: [
      "00000000-0000-8000-8000-000000000601",
      "00000000-0000-8000-8000-000000000602",
      "00000000-0000-8000-8000-000000000603",
      "00000000-0000-8000-8000-000000000604",
      "00000000-0000-8000-8000-000000000605",
      "00000000-0000-8000-8000-000000000606",
      "00000000-0000-8000-8000-000000000607",
      "00000000-0000-8000-8000-000000000608",
      "00000000-0000-8000-8000-000000000609",
      "00000000-0000-8000-8000-000000000610",
      "00000000-0000-8000-8000-000000000611",
      "00000000-0000-8000-8000-000000000612",
    ],
  },
  { path: "graph.output.valueType", value: "percentage" },
  { path: "graph.output.unit", value: "%" },
  { path: "graph.output.currency", value: null },
  {
    path: "result.outputs",
    value: [
      {
        ...phase7ValidMetricContractContext.result.outputs[0],
        valueType: "percentage",
        unit: "%",
        currency: null,
      },
      phase7ValidMetricContractContext.result.outputs[1],
    ],
  },
] as const satisfies readonly Phase7MetricConformancePatch[];

const phase7HigherDirectionBaselinePatches = [
  { path: "contract.direction", value: "higher_is_better" },
  { path: "contract.threshold", value: "10" },
  { path: "contract.target", value: "20" },
  {
    path: "graph.thresholdDiagnostics.thresholdNodeId",
    value: "00000000-0000-8000-8000-000000000615",
  },
  {
    path: "graph.thresholdDiagnostics.targetNodeId",
    value: "00000000-0000-8000-8000-000000000616",
  },
  {
    path: "graph.thresholdDiagnostics.thresholdLiteralNodeId",
    value: "00000000-0000-8000-8000-000000000613",
  },
  {
    path: "graph.thresholdDiagnostics.targetLiteralNodeId",
    value: "00000000-0000-8000-8000-000000000614",
  },
  {
    path: "graph.thresholdDiagnostics.thresholdLiteralValue",
    value: "10",
  },
  {
    path: "graph.thresholdDiagnostics.targetLiteralValue",
    value: "20",
  },
  {
    path: "graph.thresholdDiagnostics.thresholdComparison",
    value: {
      op: "greater_equal",
      left: "00000000-0000-8000-8000-000000000608",
      right: "00000000-0000-8000-8000-000000000613",
    },
  },
  {
    path: "graph.thresholdDiagnostics.targetComparison",
    value: {
      op: "greater_equal",
      left: "00000000-0000-8000-8000-000000000608",
      right: "00000000-0000-8000-8000-000000000614",
    },
  },
  {
    path: "graph.thresholdDiagnostics.thresholdLiteralConsumers",
    value: ["00000000-0000-8000-8000-000000000615"],
  },
  {
    path: "graph.thresholdDiagnostics.targetLiteralConsumers",
    value: ["00000000-0000-8000-8000-000000000616"],
  },
  {
    path: "graph.outputNodeIds",
    value: [
      "00000000-0000-8000-8000-000000000608",
      "00000000-0000-8000-8000-000000000612",
      "00000000-0000-8000-8000-000000000615",
      "00000000-0000-8000-8000-000000000616",
    ],
  },
  {
    path: "graph.topologicalNodeIds",
    value: [
      ...phase7ValidMetricContractContext.graph.topologicalNodeIds,
      "00000000-0000-8000-8000-000000000613",
      "00000000-0000-8000-8000-000000000614",
      "00000000-0000-8000-8000-000000000615",
      "00000000-0000-8000-8000-000000000616",
    ],
  },
  {
    path: "result.outputs",
    value: [
      ...phase7ValidMetricContractContext.result.outputs,
      {
        nodeId: "00000000-0000-8000-8000-000000000615",
        outputSha256: "64".repeat(32),
        canonicalOutputSha256: "64".repeat(32),
        shape: "scalar",
        scalar: "boolean",
        valueType: "diagnostic",
        unit: null,
        currency: null,
        grain:
          "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
        maxValueBytes: "5",
        evaluationRowsFrom: "00000000-0000-8000-8000-000000000606",
      },
      {
        nodeId: "00000000-0000-8000-8000-000000000616",
        outputSha256: "65".repeat(32),
        canonicalOutputSha256: "65".repeat(32),
        shape: "scalar",
        scalar: "boolean",
        valueType: "diagnostic",
        unit: null,
        currency: null,
        grain:
          "group:0ebd91ddeecbe7e28a557212b1cdd422bd3eb3b6f838ffe86228fdd361e9d1d5",
        maxValueBytes: "5",
        evaluationRowsFrom: "00000000-0000-8000-8000-000000000606",
      },
    ],
  },
] as const satisfies readonly Phase7MetricConformancePatch[];

const phase7MetricContractBaselines = {
  sum_currency: phase7ValidMetricContractContext,
  ratio_percentage: phase7ApplyMetricPatches(
    phase7ValidMetricContractContext,
    phase7RatioBaselinePatches,
  ),
  higher_direction: phase7ApplyMetricPatches(
    phase7ValidMetricContractContext,
    phase7HigherDirectionBaselinePatches,
  ),
} as const;

function phase7MetricConformanceFixture(
  id: string,
  phase: Phase7MetricConformanceFixture["phase"],
  baseline: keyof typeof phase7MetricContractBaselines,
  patches: readonly Phase7MetricConformancePatch[],
  outcome: Phase7MetricConformanceFixture["expected"]["outcome"],
  reason: string,
): Phase7MetricConformanceFixture {
  const context = phase7ApplyMetricPatches(
    phase7MetricContractBaselines[baseline],
    patches,
  );
  const expectedChangedPaths = patches.map(({ path }) => path);
  const changedPaths = phase7MetricChangedPaths(
    phase7MetricContractBaselines[baseline],
    context,
  );
  if (
    JSON.stringify([...changedPaths].sort()) !==
    JSON.stringify([...expectedChangedPaths].sort())
  ) {
    throw new TypeError(
      `MetricContractVersion mutation drift for ${id}: ${changedPaths.join(",")}`,
    );
  }
  return {
    id,
    phase,
    baseline,
    patches,
    expectedChangedPaths,
    context,
    expected: { outcome, reason },
  };
}

function phase7MetricMutation(
  id: string,
  phase: Phase7MetricConformanceFixture["phase"],
  baseline: keyof typeof phase7MetricContractBaselines,
  path: Phase7MetricConformancePath,
  value: unknown,
  outcome: Phase7MetricConformanceFixture["expected"]["outcome"],
  reason: string,
): Phase7MetricConformanceFixture {
  return phase7MetricConformanceFixture(
    id,
    phase,
    baseline,
    [{ path, value }],
    outcome,
    reason,
  );
}

const phase7MetricContractConformanceCases = [
  phase7MetricConformanceFixture(
    "canonical-sum-currency-contract-graph-result",
    "contract_validity",
    "sum_currency",
    [],
    "accept",
    "complete_contract_catalog_graph_result_context_valid",
  ),
  phase7MetricConformanceFixture(
    "ratio-percentage-contract-graph-result",
    "contract_validity",
    "ratio_percentage",
    [],
    "accept",
    "ratio_denominator_and_percentage_conversion_exact",
  ),
  phase7MetricConformanceFixture(
    "higher-direction-two-diagnostics",
    "graph_conformance",
    "higher_direction",
    [],
    "accept",
    "direction_graph_diagnostics_exact",
  ),

  phase7MetricMutation(
    "owners-same-identity",
    "contract_validity",
    "sum_currency",
    "contract.dataOwner.membershipId",
    "00000000-0000-8000-8000-000000000109",
    "reject",
    "owners_not_distinct",
  ),
  phase7MetricMutation(
    "business-owner-revoked",
    "contract_validity",
    "sum_currency",
    "contract.businessOwner.state",
    "revoked",
    "reject",
    "business_owner_not_current_active",
  ),
  phase7MetricMutation(
    "data-owner-revoked-at",
    "contract_validity",
    "sum_currency",
    "contract.dataOwner.revokedAt",
    "2026-08-05T11:00:00.000000Z",
    "reject",
    "data_owner_not_current_active",
  ),
  phase7MetricMutation(
    "business-owner-stale-revision",
    "contract_validity",
    "sum_currency",
    "contract.businessOwner.authorityRevision",
    "6",
    "reject",
    "business_owner_not_current_active",
  ),
  phase7MetricMutation(
    "owner-cross-organization",
    "contract_validity",
    "sum_currency",
    "contract.dataOwner.organizationId",
    "00000000-0000-8000-8000-000000000099",
    "reject",
    "owner_organization_mismatch",
  ),
  phase7MetricMutation(
    "reviewed-only",
    "contract_validity",
    "sum_currency",
    "contract.reviewState",
    "draft",
    "reject",
    "review_state_not_reviewed",
  ),

  phase7MetricMutation(
    "measure-semantic-type",
    "contract_validity",
    "sum_currency",
    "catalog.measure.semanticType",
    "dimension",
    "reject",
    "measure_not_measure",
  ),
  phase7MetricMutation(
    "aggregation-not-in-measure-closure",
    "contract_validity",
    "sum_currency",
    "catalog.measure.allowedAggregations",
    ["count", "max"],
    "reject",
    "aggregation_not_allowed_by_measure",
  ),
  phase7MetricMutation(
    "event-time-null",
    "contract_validity",
    "sum_currency",
    "catalog.measure.eventTimeFieldId",
    null,
    "reject",
    "measure_event_time_required",
  ),
  phase7MetricMutation(
    "measure-not-in-bound-catalog",
    "contract_validity",
    "sum_currency",
    "contract.measureFieldId",
    "00000000-0000-8000-8000-000000000299",
    "reject",
    "measure_catalog_membership_mismatch",
  ),
  phase7MetricMutation(
    "event-time-semantic-type",
    "contract_validity",
    "sum_currency",
    "catalog.eventTime.semanticType",
    "dimension",
    "reject",
    "event_time_catalog_ineligible",
  ),
  phase7MetricMutation(
    "event-time-scalar-type",
    "contract_validity",
    "sum_currency",
    "catalog.eventTime.scalarType",
    "date",
    "reject",
    "event_time_catalog_ineligible",
  ),
  phase7MetricMutation(
    "measure-unit-and-currency",
    "contract_validity",
    "sum_currency",
    "catalog.measure.unit",
    "m",
    "reject",
    "measure_unit_currency_exclusive",
  ),
  phase7MetricMutation(
    "dimension-semantic-type",
    "contract_validity",
    "sum_currency",
    "catalog.dimensions",
    [
      {
        fieldId: "00000000-0000-8000-8000-000000000204",
        semanticType: "measure",
        lineageEvidenceIds: ["00000000-0000-8000-8000-000000000108"],
        entrySha256: "33".repeat(32),
      },
    ],
    "reject",
    "dimension_catalog_ineligible",
  ),
  phase7MetricMutation(
    "dimension-not-in-measure-allowed-set",
    "contract_validity",
    "sum_currency",
    "catalog.measure.allowedDimensions",
    [],
    "reject",
    "dimension_not_allowed_by_measure",
  ),
  phase7MetricMutation(
    "dimension-subset-forbidden",
    "contract_validity",
    "sum_currency",
    "catalog.measure.allowedDimensions",
    [
      "00000000-0000-8000-8000-000000000204",
      "00000000-0000-8000-8000-000000000205",
    ],
    "reject",
    "allowed_dimensions_not_exact",
  ),
  phase7MetricMutation(
    "dimension-unsorted",
    "contract_validity",
    "sum_currency",
    "contract.allowedDimensionFieldIds",
    [
      "00000000-0000-8000-8000-000000000205",
      "00000000-0000-8000-8000-000000000204",
    ],
    "reject",
    "allowed_dimensions_not_sorted_unique",
  ),
  phase7MetricMutation(
    "dimension-duplicate",
    "contract_validity",
    "sum_currency",
    "contract.allowedDimensionFieldIds",
    [
      "00000000-0000-8000-8000-000000000204",
      "00000000-0000-8000-8000-000000000204",
    ],
    "reject",
    "allowed_dimensions_not_sorted_unique",
  ),
  phase7MetricMutation(
    "allowed-aggregation-unsorted",
    "contract_validity",
    "sum_currency",
    "catalog.measure.allowedAggregations",
    ["sum", "count"],
    "reject",
    "allowed_aggregations_not_sorted_unique",
  ),
  phase7MetricMutation(
    "allowed-aggregation-duplicate",
    "contract_validity",
    "sum_currency",
    "catalog.measure.allowedAggregations",
    ["sum", "sum"],
    "reject",
    "allowed_aggregations_not_sorted_unique",
  ),
  phase7MetricMutation(
    "allowed-aggregation-unlisted",
    "contract_validity",
    "sum_currency",
    "catalog.measure.allowedAggregations",
    ["sum", "weighted_mean"],
    "reject",
    "allowed_aggregation_outside_closed_enum",
  ),

  phase7MetricMutation(
    "count-distinct-unsupported",
    "contract_validity",
    "sum_currency",
    "contract.aggregation",
    "count_distinct",
    "unsupported_capability",
    "unsupported_capability:none_before_dispatch",
  ),
  phase7MetricMutation(
    "median-unsupported",
    "contract_validity",
    "sum_currency",
    "contract.aggregation",
    "median",
    "unsupported_capability",
    "unsupported_capability:none_before_dispatch",
  ),
  phase7MetricMutation(
    "seventeen-dimensions-unsupported",
    "contract_validity",
    "sum_currency",
    "contract.allowedDimensionFieldIds",
    Array.from(
      { length: 17 },
      (_, index) =>
        `00000000-0000-8000-8000-${String(index + 1).padStart(12, "0")}`,
    ),
    "unsupported_capability",
    "unsupported_capability:none_before_dispatch",
  ),
  phase7MetricMutation(
    "count-noninteger",
    "contract_validity",
    "sum_currency",
    "contract.aggregation",
    "count",
    "reject",
    "count_requires_integer",
  ),
  phase7MetricMutation(
    "decimal-with-currency",
    "contract_validity",
    "sum_currency",
    "contract.valueType",
    "decimal",
    "reject",
    "decimal_metadata_invalid",
  ),
  phase7MetricMutation(
    "currency-with-unit",
    "contract_validity",
    "sum_currency",
    "contract.unit",
    "m",
    "reject",
    "currency_metadata_invalid",
  ),
  phase7MetricConformanceFixture(
    "percentage-without-percent",
    "contract_validity",
    "sum_currency",
    [
      { path: "contract.valueType", value: "percentage" },
      { path: "contract.currency", value: null },
      { path: "contract.unit", value: "1" },
    ],
    "reject",
    "percentage_metadata_invalid",
  ),
  phase7MetricConformanceFixture(
    "duration-affine-unit",
    "contract_validity",
    "sum_currency",
    [
      { path: "contract.valueType", value: "duration" },
      { path: "contract.currency", value: null },
      { path: "contract.unit", value: "Cel" },
    ],
    "reject",
    "duration_metadata_invalid",
  ),
  phase7MetricMutation(
    "sum-nonnumeric-measure",
    "contract_validity",
    "sum_currency",
    "catalog.measure.scalarType",
    "text",
    "reject",
    "aggregation_requires_numeric_measure",
  ),
  phase7MetricConformanceFixture(
    "min-nondecimal-measure",
    "contract_validity",
    "sum_currency",
    [
      { path: "contract.aggregation", value: "min" },
      { path: "catalog.measure.scalarType", value: "integer" },
    ],
    "reject",
    "contract_min_max_require_decimal_measure",
  ),

  phase7MetricMutation(
    "ratio-denominator-id-null",
    "contract_validity",
    "ratio_percentage",
    "contract.denominatorContractId",
    null,
    "reject",
    "denominator_pair_required_for_ratio",
  ),
  phase7MetricMutation(
    "ratio-denominator-version-null",
    "contract_validity",
    "ratio_percentage",
    "contract.denominatorContractVersion",
    null,
    "reject",
    "denominator_pair_required_for_ratio",
  ),
  phase7MetricMutation(
    "ratio-self-denominator",
    "contract_validity",
    "ratio_percentage",
    "contract.denominatorContractId",
    "00000000-0000-8000-8000-000000000104",
    "reject",
    "denominator_must_differ",
  ),
  phase7MetricMutation(
    "ratio-denominator-unreviewed",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.reviewState",
    "draft",
    "reject",
    "denominator_not_reviewed_sum",
  ),
  phase7MetricMutation(
    "ratio-denominator-is-ratio",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.aggregation",
    "ratio",
    "reject",
    "denominator_not_reviewed_sum",
  ),
  phase7MetricMutation(
    "ratio-denominator-set-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.contractSetId",
    "00000000-0000-8000-8000-000000000199",
    "reject",
    "denominator_set_catalog_mismatch",
  ),
  phase7MetricMutation(
    "ratio-denominator-catalog-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.catalogSnapshotId",
    "00000000-0000-8000-8000-000000000199",
    "reject",
    "denominator_set_catalog_mismatch",
  ),
  phase7MetricMutation(
    "ratio-denominator-calendar-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.calendar",
    "iso_week",
    "reject",
    "denominator_group_contract_mismatch",
  ),
  phase7MetricMutation(
    "ratio-denominator-timezone-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.timezone",
    "America/New_York",
    "reject",
    "denominator_group_contract_mismatch",
  ),
  phase7MetricMutation(
    "ratio-denominator-dimension-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.allowedDimensionFieldIds",
    [],
    "reject",
    "denominator_group_contract_mismatch",
  ),
  phase7MetricMutation(
    "ratio-denominator-grain-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.grain",
    "group:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "reject",
    "denominator_group_contract_mismatch",
  ),
  phase7MetricMutation(
    "ratio-denominator-event-time-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.eventTimeFieldId",
    "00000000-0000-8000-8000-000000000213",
    "reject",
    "denominator_event_time_mismatch",
  ),
  phase7MetricMutation(
    "ratio-measure-metadata-drift",
    "contract_validity",
    "ratio_percentage",
    "denominatorContract.measureUnit",
    "cm",
    "reject",
    "ratio_measure_metadata_mismatch",
  ),
  phase7MetricMutation(
    "nonratio-denominator-present",
    "contract_validity",
    "sum_currency",
    "contract.denominatorContractId",
    "00000000-0000-8000-8000-000000000114",
    "reject",
    "denominator_forbidden_for_nonratio",
  ),

  phase7MetricMutation(
    "neutral-threshold-present",
    "contract_validity",
    "sum_currency",
    "contract.threshold",
    "10",
    "reject",
    "neutral_forbids_threshold_target",
  ),
  phase7MetricMutation(
    "higher-missing-target",
    "contract_validity",
    "higher_direction",
    "contract.target",
    null,
    "reject",
    "direction_requires_threshold_target",
  ),
  phase7MetricMutation(
    "higher-target-below-threshold",
    "contract_validity",
    "higher_direction",
    "contract.target",
    "5",
    "reject",
    "higher_target_order_invalid",
  ),
  phase7MetricConformanceFixture(
    "lower-target-above-threshold",
    "contract_validity",
    "higher_direction",
    [
      { path: "contract.direction", value: "lower_is_better" },
      { path: "contract.target", value: "30" },
    ],
    "reject",
    "lower_target_order_invalid",
  ),
  phase7MetricConformanceFixture(
    "target-band-reversed",
    "contract_validity",
    "higher_direction",
    [
      { path: "contract.direction", value: "target_band" },
      { path: "contract.threshold", value: "30" },
    ],
    "reject",
    "target_band_order_invalid",
  ),
  phase7MetricMutation(
    "threshold-negative-zero",
    "contract_validity",
    "higher_direction",
    "contract.threshold",
    "-0",
    "reject",
    "threshold_decimal_noncanonical",
  ),
  phase7MetricMutation(
    "threshold-trailing-zero",
    "contract_validity",
    "higher_direction",
    "contract.threshold",
    "1.0",
    "reject",
    "threshold_decimal_noncanonical",
  ),
  phase7MetricMutation(
    "threshold-39-digits",
    "contract_validity",
    "higher_direction",
    "contract.threshold",
    "999999999999999999999999999999999999999",
    "reject",
    "threshold_decimal_out_of_range",
  ),
  phase7MetricMutation(
    "threshold-19-fractional-digits",
    "contract_validity",
    "higher_direction",
    "contract.threshold",
    "0.1234567890123456789",
    "reject",
    "threshold_decimal_out_of_range",
  ),

  phase7MetricMutation(
    "lag-negative",
    "contract_validity",
    "sum_currency",
    "contract.lagMillis",
    "-1",
    "reject",
    "lag_out_of_range",
  ),
  phase7MetricMutation(
    "lag-over-year",
    "contract_validity",
    "sum_currency",
    "contract.lagMillis",
    "31536000001",
    "reject",
    "lag_out_of_range",
  ),
  phase7MetricMutation(
    "slo-zero",
    "contract_validity",
    "sum_currency",
    "contract.freshnessSloMillis",
    "0",
    "reject",
    "freshness_slo_out_of_range",
  ),
  phase7MetricConformanceFixture(
    "lag-slo-overflow",
    "contract_validity",
    "sum_currency",
    [
      { path: "contract.lagMillis", value: "9223372036854775800" },
      { path: "contract.freshnessSloMillis", value: "8" },
    ],
    "reject",
    "lag_slo_sum_overflow",
  ),
  phase7MetricMutation(
    "calendar-unknown",
    "contract_validity",
    "sum_currency",
    "contract.calendar",
    "julian",
    "reject",
    "calendar_invalid",
  ),
  phase7MetricMutation(
    "timezone-not-iana",
    "contract_validity",
    "sum_currency",
    "contract.timezone",
    "UTC+1",
    "reject",
    "timezone_invalid",
  ),
  phase7MetricMutation(
    "graph-timezone-drift",
    "contract_validity",
    "sum_currency",
    "graph.timezone",
    "America/New_York",
    "reject",
    "timezone_mismatch",
  ),
  phase7MetricMutation(
    "grain-arbitrary-label",
    "contract_validity",
    "sum_currency",
    "contract.grain",
    "daily",
    "reject",
    "grain_not_derived",
  ),
  phase7MetricMutation(
    "lineage-missing-measure",
    "contract_validity",
    "sum_currency",
    "contract.lineageEvidenceIds",
    [
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
    ],
    "reject",
    "lineage_union_not_exact",
  ),
  phase7MetricMutation(
    "lineage-hidden-extra",
    "contract_validity",
    "sum_currency",
    "contract.lineageEvidenceIds",
    [
      "00000000-0000-8000-8000-000000000106",
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
      "00000000-0000-8000-8000-000000000199",
    ],
    "reject",
    "lineage_union_not_exact",
  ),
  phase7MetricMutation(
    "ratio-lineage-omits-denominator",
    "contract_validity",
    "ratio_percentage",
    "contract.lineageEvidenceIds",
    [
      "00000000-0000-8000-8000-000000000106",
      "00000000-0000-8000-8000-000000000107",
      "00000000-0000-8000-8000-000000000108",
    ],
    "reject",
    "lineage_union_not_exact",
  ),
  phase7MetricMutation(
    "lineage-bundle-missing",
    "contract_validity",
    "sum_currency",
    "governance.commonBundle.evidenceRows",
    [],
    "reject",
    "lineage_bundle_mismatch",
  ),
  phase7MetricMutation(
    "lineage-bundle-row-drift",
    "contract_validity",
    "sum_currency",
    "governance.commonBundle.sourceSnapshotId",
    "00000000-0000-8000-8000-000000000199",
    "reject",
    "lineage_bundle_mismatch",
  ),
  phase7MetricMutation(
    "lineage-bundle-stale-label",
    "contract_validity",
    "sum_currency",
    "governance.commonBundle.evidenceRows",
    [
      {
        ...phase7ValidMetricContractContext.governance.commonBundle
          .evidenceRows[0],
        freshness: "stale",
      },
      ...phase7ValidMetricContractContext.governance.commonBundle.evidenceRows.slice(
        1,
      ),
    ],
    "reject",
    "lineage_bundle_mismatch",
  ),
  phase7MetricMutation(
    "contract-set-hash-drift",
    "contract_validity",
    "sum_currency",
    "governance.contractSetHashRecomputed",
    false,
    "reject",
    "contract_set_hash_mismatch",
  ),

  phase7MetricMutation(
    "graph-contract-identity-drift",
    "graph_conformance",
    "sum_currency",
    "graph.contractVersion",
    "2",
    "reject",
    "graph_contract_identity_mismatch",
  ),
  phase7MetricMutation(
    "source-missing-stable-key",
    "graph_conformance",
    "sum_currency",
    "graph.source.fieldIds",
    phase7ValidMetricContractContext.graph.source.fieldIds.slice(1),
    "reject",
    "contract_source_field_set_mismatch",
  ),
  phase7MetricMutation(
    "source-extra-field",
    "graph_conformance",
    "sum_currency",
    "graph.source.fieldIds",
    [
      ...phase7ValidMetricContractContext.graph.source.fieldIds,
      "00000000-0000-8000-8000-000000000299",
    ],
    "reject",
    "contract_source_field_set_mismatch",
  ),
  phase7MetricMutation(
    "non-direct-measure-field",
    "graph_conformance",
    "sum_currency",
    "graph.directFields.measure.input",
    "00000000-0000-8000-8000-000000000699",
    "reject",
    "contract_direct_field_required",
  ),
  phase7MetricMutation(
    "group-dimension-subset",
    "graph_conformance",
    "sum_currency",
    "graph.group.keyNodeIds",
    [],
    "reject",
    "contract_group_keys_mismatch",
  ),
  phase7MetricMutation(
    "group-dimension-extra",
    "graph_conformance",
    "sum_currency",
    "graph.group.keyNodeIds",
    [
      "00000000-0000-8000-8000-000000000605",
      "00000000-0000-8000-8000-000000000699",
    ],
    "reject",
    "contract_group_keys_mismatch",
  ),
  phase7MetricMutation(
    "group-key-catalog-field-substitution",
    "graph_conformance",
    "sum_currency",
    "graph.group.keyNodeIds",
    ["00000000-0000-8000-8000-000000000204"],
    "reject",
    "contract_group_key_node_required",
  ),
  phase7MetricMutation(
    "aggregation-op-drift",
    "graph_conformance",
    "sum_currency",
    "graph.aggregation.op",
    "mean",
    "reject",
    "contract_aggregation_mapping_mismatch",
  ),
  phase7MetricMutation(
    "aggregation-input-catalog-field-substitution",
    "graph_conformance",
    "sum_currency",
    "graph.aggregation.input",
    "00000000-0000-8000-8000-000000000202",
    "reject",
    "contract_aggregation_input_node_required",
  ),
  phase7MetricMutation(
    "mean-settings-drift",
    "graph_conformance",
    "ratio_percentage",
    "graph.aggregation.scale",
    "17",
    "reject",
    "contract_aggregation_settings_mismatch",
  ),
  phase7MetricMutation(
    "ratio-separate-groups",
    "graph_conformance",
    "ratio_percentage",
    "graph.aggregation.denominatorGroupNodeId",
    "00000000-0000-8000-8000-000000000698",
    "reject",
    "ratio_group_mismatch",
  ),
  phase7MetricMutation(
    "ratio-divide-settings-drift",
    "graph_conformance",
    "ratio_percentage",
    "graph.aggregation.rounding",
    "none",
    "reject",
    "ratio_divide_settings_mismatch",
  ),
  ...[
    ["forbidden-filter", "filter"],
    ["forbidden-sort", "sort"],
    ["forbidden-top-k", "top_k"],
    ["forbidden-lag", "lag"],
    ["forbidden-window", "window_sum"],
    ["forbidden-conditional", "if_then_else"],
  ].map(([id, operation]) =>
    phase7MetricMutation(
      id!,
      "graph_conformance",
      "sum_currency",
      "graph.pathOps",
      ["source", "field", operation, "group", "sum", "currency_convert"],
      "reject",
      "uncontracted_path_operation",
    ),
  ),
  phase7MetricMutation(
    "output-id-not-selected",
    "graph_conformance",
    "sum_currency",
    "graph.outputNodeIds",
    ["00000000-0000-8000-8000-000000000612"],
    "reject",
    "contract_output_not_selected",
  ),
  phase7MetricMutation(
    "output-metadata-drift",
    "graph_conformance",
    "sum_currency",
    "graph.output.currency",
    "GBP",
    "reject",
    "contract_output_metadata_mismatch",
  ),
  phase7MetricMutation(
    "output-evaluation-domain-drift",
    "graph_conformance",
    "sum_currency",
    "graph.output.evaluationRowsFrom",
    "00000000-0000-8000-8000-000000000601",
    "reject",
    "contract_output_domain_mismatch",
  ),
  phase7MetricMutation(
    "result-entry-missing",
    "graph_conformance",
    "sum_currency",
    "result.outputs",
    phase7ValidMetricContractContext.result.outputs.slice(1),
    "reject",
    "contract_result_output_missing",
  ),
  phase7MetricMutation(
    "result-output-hash-drift",
    "graph_conformance",
    "sum_currency",
    "result.outputs",
    [
      {
        ...phase7ValidMetricContractContext.result.outputs[0],
        outputSha256: "99".repeat(32),
      },
      phase7ValidMetricContractContext.result.outputs[1],
    ],
    "reject",
    "contract_result_output_hash_mismatch",
  ),
  phase7MetricMutation(
    "other-output-cross-source",
    "graph_conformance",
    "sum_currency",
    "graph.otherOutputs",
    [
      {
        ...phase7ValidMetricContractContext.graph.otherOutputs[0],
        sourceIdentity: "other-source",
      },
    ],
    "reject",
    "other_output_source_mismatch",
  ),

  phase7MetricMutation(
    "neutral-has-threshold-node",
    "graph_conformance",
    "sum_currency",
    "graph.thresholdDiagnostics.thresholdNodeId",
    "00000000-0000-8000-8000-000000000615",
    "reject",
    "neutral_graph_diagnostics_forbidden",
  ),
  phase7MetricMutation(
    "direction-one-diagnostic-missing",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.targetNodeId",
    null,
    "reject",
    "direction_graph_diagnostics_incomplete",
  ),
  phase7MetricMutation(
    "diagnostic-ids-equal",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.targetNodeId",
    "00000000-0000-8000-8000-000000000615",
    "reject",
    "diagnostic_node_ids_not_distinct",
  ),
  phase7MetricMutation(
    "diagnostic-equals-output",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.thresholdNodeId",
    "00000000-0000-8000-8000-000000000608",
    "reject",
    "diagnostic_node_ids_not_distinct",
  ),
  phase7MetricMutation(
    "diagnostic-not-output",
    "graph_conformance",
    "higher_direction",
    "graph.outputNodeIds",
    [
      "00000000-0000-8000-8000-000000000608",
      "00000000-0000-8000-8000-000000000612",
    ],
    "reject",
    "diagnostic_not_selected",
  ),
  phase7MetricMutation(
    "comparison-op-alias",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.thresholdComparison.op",
    "greater",
    "reject",
    "direction_comparison_mismatch",
  ),
  phase7MetricMutation(
    "comparison-operands-swapped",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.thresholdComparison.left",
    "00000000-0000-8000-8000-000000000613",
    "reject",
    "direction_comparison_operands_mismatch",
  ),
  phase7MetricMutation(
    "shared-threshold-target-literal",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.targetLiteralNodeId",
    "00000000-0000-8000-8000-000000000613",
    "reject",
    "direction_literals_not_distinct",
  ),
  phase7MetricMutation(
    "threshold-literal-rounded",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.thresholdLiteralValue",
    "10.1",
    "reject",
    "direction_literal_mismatch",
  ),
  phase7MetricMutation(
    "unused-threshold-literal",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.thresholdLiteralConsumers",
    [],
    "reject",
    "direction_literal_consumer_mismatch",
  ),
  phase7MetricMutation(
    "extra-threshold-consumer",
    "graph_conformance",
    "higher_direction",
    "graph.thresholdDiagnostics.thresholdLiteralConsumers",
    [
      "00000000-0000-8000-8000-000000000615",
      "00000000-0000-8000-8000-000000000697",
    ],
    "reject",
    "direction_literal_consumer_mismatch",
  ),

  phase7MetricConformanceFixture(
    "no-conversion-required",
    "graph_conformance",
    "sum_currency",
    [
      { path: "contract.currency", value: "USD" },
      { path: "graph.conversion", value: null },
      { path: "graph.conversionCount", value: 0 },
      { path: "graph.conversionKinds", value: [] },
      { path: "graph.fxEvidenceId", value: null },
      { path: "graph.fxEvidenceSha256", value: null },
      {
        path: "graph.contractOutputNodeId",
        value: "00000000-0000-8000-8000-000000000607",
      },
      {
        path: "graph.outputNodeIds",
        value: [
          "00000000-0000-8000-8000-000000000607",
          "00000000-0000-8000-8000-000000000612",
        ],
      },
      {
        path: "graph.topologicalNodeIds",
        value: phase7ValidMetricContractContext.graph.topologicalNodeIds.filter(
          (nodeId) => nodeId !== "00000000-0000-8000-8000-000000000608",
        ),
      },
      {
        path: "graph.output.nodeId",
        value: "00000000-0000-8000-8000-000000000607",
      },
      { path: "graph.output.currency", value: "USD" },
      { path: "graph.pathOps", value: ["source", "field", "group", "sum"] },
      {
        path: "result.outputs",
        value: [
          {
            ...phase7ValidMetricContractContext.result.outputs[0],
            nodeId: "00000000-0000-8000-8000-000000000607",
            currency: "USD",
          },
          phase7ValidMetricContractContext.result.outputs[1],
        ],
      },
    ],
    "accept",
    "conversion_path_exact",
  ),
  phase7MetricMutation(
    "unneeded-currency-conversion",
    "graph_conformance",
    "sum_currency",
    "contract.currency",
    "USD",
    "reject",
    "conversion_not_required",
  ),
  phase7MetricMutation(
    "missing-currency-conversion",
    "graph_conformance",
    "sum_currency",
    "graph.conversion",
    null,
    "reject",
    "required_currency_conversion_missing",
  ),
  phase7MetricMutation(
    "two-currency-conversions",
    "graph_conformance",
    "sum_currency",
    "graph.conversionCount",
    2,
    "reject",
    "multiple_contract_conversions",
  ),
  phase7MetricMutation(
    "two-unit-conversions",
    "graph_conformance",
    "ratio_percentage",
    "graph.conversionCount",
    2,
    "reject",
    "multiple_contract_conversions",
  ),
  phase7MetricMutation(
    "unit-conversion-incompatible",
    "graph_conformance",
    "ratio_percentage",
    "graph.conversion.toUnit",
    "s",
    "reject",
    "contract_unit_conversion_incompatible",
  ),
  phase7MetricMutation(
    "unit-conversion-registry-drift",
    "graph_conformance",
    "ratio_percentage",
    "graph.conversion.unitRegistryVersion",
    "ucum-latest",
    "reject",
    "contract_unit_conversion_settings_mismatch",
  ),
  phase7MetricMutation(
    "unit-conversion-scale-drift",
    "graph_conformance",
    "ratio_percentage",
    "graph.conversion.scale",
    "17",
    "reject",
    "contract_unit_conversion_settings_mismatch",
  ),
  phase7MetricMutation(
    "unit-conversion-rounding-drift",
    "graph_conformance",
    "ratio_percentage",
    "graph.conversion.rounding",
    "none",
    "reject",
    "contract_unit_conversion_settings_mismatch",
  ),
  phase7MetricMutation(
    "currency-direction-drift",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.fromCurrency",
    "EUR",
    "reject",
    "contract_currency_direction_mismatch",
  ),
  phase7MetricMutation(
    "currency-scale-drift",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.scale",
    "0",
    "reject",
    "contract_currency_conversion_settings_mismatch",
  ),
  phase7MetricMutation(
    "currency-rounding-drift",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.rounding",
    "none",
    "reject",
    "contract_currency_conversion_settings_mismatch",
  ),
  phase7MetricMutation(
    "currency-conversion-missing-fx-evidence",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.fxEvidenceId",
    null,
    "reject",
    "contract_fx_binding_missing",
  ),
  phase7MetricMutation(
    "currency-fx-identity-drift",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.fxEvidenceSha256",
    "99".repeat(32),
    "reject",
    "contract_fx_binding_mismatch",
  ),
  phase7MetricMutation(
    "currency-fx-body-direction-drift",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.fxBodyFromCurrency",
    "EUR",
    "reject",
    "contract_fx_binding_mismatch",
  ),
  phase7MetricMutation(
    "currency-conversion-stale-fx",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.fxObservedAt",
    "2026-08-04T11:59:59.999999Z",
    "reject",
    "contract_fx_stale",
  ),
  phase7MetricMutation(
    "unit-and-currency-conversion",
    "graph_conformance",
    "ratio_percentage",
    "graph.conversionKinds",
    ["unit_convert", "currency_convert"],
    "reject",
    "conversion_kinds_not_exclusive",
  ),
  phase7MetricMutation(
    "operation-between-aggregate-and-conversion",
    "graph_conformance",
    "sum_currency",
    "graph.conversion.input",
    "00000000-0000-8000-8000-000000000696",
    "reject",
    "conversion_not_final",
  ),

  phase7MetricMutation(
    "graph-schema-drift",
    "graph_conformance",
    "sum_currency",
    "graph.schema",
    "calculation-graph-v2",
    "reject",
    "graph_schema_mismatch",
  ),
  phase7MetricMutation(
    "result-schema-drift",
    "graph_conformance",
    "sum_currency",
    "result.schema",
    "calculation-result-v2",
    "reject",
    "result_schema_mismatch",
  ),
  phase7MetricMutation(
    "graph-input-hash-drift",
    "graph_conformance",
    "sum_currency",
    "graph.inputSha256",
    "99".repeat(32),
    "reject",
    "graph_input_binding_mismatch",
  ),
  phase7MetricMutation(
    "graph-catalog-binding-drift",
    "graph_conformance",
    "sum_currency",
    "graph.catalogSha256",
    "99".repeat(32),
    "reject",
    "graph_catalog_binding_mismatch",
  ),
  phase7MetricMutation(
    "graph-bundle-binding-drift",
    "graph_conformance",
    "sum_currency",
    "graph.commonBundleSha256",
    "99".repeat(32),
    "reject",
    "graph_bundle_binding_mismatch",
  ),
  phase7MetricMutation(
    "result-graph-identity-drift",
    "graph_conformance",
    "sum_currency",
    "result.graphId",
    "00000000-0000-8000-8000-000000000399",
    "reject",
    "result_graph_binding_mismatch",
  ),
  phase7MetricMutation(
    "result-catalog-binding-drift",
    "graph_conformance",
    "sum_currency",
    "result.catalogSha256",
    "99".repeat(32),
    "reject",
    "result_catalog_binding_mismatch",
  ),
  phase7MetricMutation(
    "result-bundle-binding-drift",
    "graph_conformance",
    "sum_currency",
    "result.commonBundleSha256",
    "99".repeat(32),
    "reject",
    "result_bundle_binding_mismatch",
  ),

  phase7MetricConformanceFixture(
    "freshness-absent-zero-policy",
    "freshness_conformance",
    "sum_currency",
    [
      { path: "graph.freshnessDiagnostic", value: null },
      {
        path: "graph.derivedFreshnessProjection.classifierNodeId",
        value: null,
      },
      {
        path: "graph.derivedFreshnessProjection.inputNodeId",
        value: null,
      },
      {
        path: "graph.derivedFreshnessProjection.sourceRowId",
        value: null,
      },
      { path: "graph.matchingFreshnessStructureCount", value: 0 },
      { path: "graph.matchingFreshnessComponents", value: [] },
      { path: "graph.otherOutputs", value: [] },
      {
        path: "graph.outputNodeIds",
        value: ["00000000-0000-8000-8000-000000000608"],
      },
      {
        path: "graph.topologicalNodeIds",
        value: phase7ValidMetricContractContext.graph.topologicalNodeIds.filter(
          (nodeId) =>
            ![
              "00000000-0000-8000-8000-000000000609",
              "00000000-0000-8000-8000-000000000610",
              "00000000-0000-8000-8000-000000000611",
              "00000000-0000-8000-8000-000000000612",
            ].includes(nodeId),
        ),
      },
      {
        path: "result.outputs",
        value: [phase7ValidMetricContractContext.result.outputs[0]],
      },
    ],
    "accept",
    "freshness_diagnostic_absent",
  ),
  phase7MetricMutation(
    "freshness-multiple-structures",
    "freshness_conformance",
    "sum_currency",
    "graph.matchingFreshnessStructureCount",
    2,
    "reject",
    "freshness_diagnostic_multiple",
  ),
  phase7MetricMutation(
    "freshness-partial-through-max",
    "freshness_conformance",
    "sum_currency",
    "graph.matchingFreshnessComponents",
    ["field", "group", "max"],
    "reject",
    "freshness_diagnostic_partial",
  ),
  phase7MetricMutation(
    "freshness-wrong-event-time-field",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.field.fieldId",
    "00000000-0000-8000-8000-000000000299",
    "reject",
    "freshness_event_time_field_mismatch",
  ),
  phase7MetricMutation(
    "freshness-field-not-direct",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.field.input",
    "00000000-0000-8000-8000-000000000699",
    "reject",
    "freshness_event_time_field_mismatch",
  ),
  phase7MetricMutation(
    "freshness-group-has-key",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.group.keyNodeIds",
    ["00000000-0000-8000-8000-000000000605"],
    "reject",
    "freshness_group_not_zero_key",
  ),
  phase7MetricMutation(
    "freshness-group-source-drift",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.group.input",
    "00000000-0000-8000-8000-000000000695",
    "reject",
    "freshness_group_source_mismatch",
  ),
  phase7MetricMutation(
    "freshness-aggregate-not-max",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.maximum.op",
    "min",
    "reject",
    "freshness_max_structure_mismatch",
  ),
  phase7MetricMutation(
    "freshness-classifier-input-drift",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.classifier.input",
    "00000000-0000-8000-8000-000000000694",
    "reject",
    "freshness_classifier_structure_mismatch",
  ),
  phase7MetricMutation(
    "freshness-classifier-time-drift",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.classifier.evaluationTime",
    "2026-08-05T11:59:59.999999Z",
    "reject",
    "freshness_classifier_time_mismatch",
  ),
  phase7MetricMutation(
    "freshness-classifier-threshold-drift",
    "freshness_conformance",
    "sum_currency",
    "graph.freshnessDiagnostic.classifier.staleAfterMillis",
    "86400001",
    "reject",
    "freshness_classifier_threshold_mismatch",
  ),
  phase7MetricMutation(
    "freshness-classifier-not-output",
    "freshness_conformance",
    "sum_currency",
    "graph.outputNodeIds",
    ["00000000-0000-8000-8000-000000000608"],
    "reject",
    "freshness_classifier_not_selected",
  ),
  phase7MetricMutation(
    "freshness-projection-partial",
    "freshness_conformance",
    "sum_currency",
    "graph.derivedFreshnessProjection.inputNodeId",
    null,
    "reject",
    "freshness_projection_partial",
  ),
  phase7MetricMutation(
    "freshness-projection-caller-field",
    "freshness_conformance",
    "sum_currency",
    "graph.callerFreshnessProjectionKeys",
    ["freshness_classifier_node_id"],
    "reject",
    "freshness_projection_not_server_derived",
  ),
  phase7MetricMutation(
    "freshness-projection-id-drift",
    "freshness_conformance",
    "sum_currency",
    "graph.derivedFreshnessProjection.sourceRowId",
    "00000000-0000-8000-8000-000000000502",
    "reject",
    "freshness_projection_mismatch",
  ),
  phase7MetricMutation(
    "freshness-no-present-stale-value",
    "freshness_conformance",
    "sum_currency",
    "freshness.sourceRows",
    [
      {
        ordinal: "0",
        rowId: "00000000-0000-8000-8000-000000000501",
        state: "null",
        eventTimeUs: null,
      },
      {
        ordinal: "1",
        rowId: "00000000-0000-8000-8000-000000000502",
        state: "missing",
        eventTimeUs: null,
      },
    ],
    "reject",
    "freshness_event_time_population_empty",
  ),
  phase7MetricMutation(
    "freshness-unavailable-value",
    "freshness_conformance",
    "sum_currency",
    "freshness.sourceRows",
    [
      {
        ordinal: "0",
        rowId: "00000000-0000-8000-8000-000000000501",
        state: "present",
        eventTimeUs: "1785844800000000",
      },
      {
        ordinal: "1",
        rowId: "00000000-0000-8000-8000-000000000502",
        state: "unavailable",
        eventTimeUs: null,
      },
    ],
    "reject",
    "freshness_max_unavailable",
  ),
  phase7MetricMutation(
    "freshness-tie-not-first-ordinal",
    "freshness_conformance",
    "sum_currency",
    "freshness.firstMaximumSourceRowId",
    "00000000-0000-8000-8000-000000000502",
    "reject",
    "freshness_source_row_tie_mismatch",
  ),
  phase7MetricMutation(
    "freshness-future-maximum",
    "freshness_conformance",
    "sum_currency",
    "freshness.maximumEventTimeUs",
    "1785931200000001",
    "reject",
    "freshness_event_time_in_future",
  ),
  phase7MetricMutation(
    "freshness-catalog-over-boundary",
    "freshness_conformance",
    "sum_currency",
    "freshness.catalogObservedUs",
    "1785844799999999",
    "reject",
    "catalog_freshness_cutoff_exceeded",
  ),
  phase7MetricMutation(
    "freshness-source-over-boundary",
    "freshness_conformance",
    "sum_currency",
    "freshness.sourceObservedUs",
    "1785844799999999",
    "reject",
    "source_freshness_cutoff_exceeded",
  ),
  phase7MetricMutation(
    "freshness-lineage-over-boundary",
    "freshness_conformance",
    "sum_currency",
    "freshness.lineageObservedUs",
    "1785844799999999",
    "reject",
    "lineage_freshness_cutoff_exceeded",
  ),
  phase7MetricConformanceFixture(
    "freshness-row-one-microsecond-stale",
    "freshness_conformance",
    "sum_currency",
    [
      { path: "freshness.maximumEventTimeUs", value: "1785844799999999" },
      { path: "freshness.classifierState", value: "stale" },
      {
        path: "freshness.sourceRows",
        value: [
          {
            ordinal: "0",
            rowId: "00000000-0000-8000-8000-000000000501",
            state: "stale",
            eventTimeUs: "1785844799999999",
          },
        ],
      },
    ],
    "accept",
    "freshness_boundary_exact",
  ),
] as const satisfies readonly Phase7MetricConformanceFixture[];

const phase7MetricRequiredContextPaths = [
  "contract.organizationId",
  "contract.contractSetId",
  "contract.contractId",
  "contract.contractVersion",
  "contract.catalogSnapshotId",
  "contract.businessOwner.membershipId",
  "contract.businessOwner.currentAuthorityRevision",
  "contract.dataOwner.membershipId",
  "contract.dataOwner.currentAuthorityRevision",
  "contract.measureFieldId",
  "contract.aggregation",
  "contract.valueType",
  "contract.direction",
  "contract.grain",
  "contract.allowedDimensionFieldIds",
  "contract.lineageEvidenceIds",
  "contract.reviewState",
  "denominatorContract.contractId",
  "denominatorContract.measureFieldId",
  "catalog.catalogSnapshotId",
  "catalog.measure.fieldId",
  "catalog.measure.allowedAggregations",
  "catalog.measure.allowedDimensions",
  "catalog.eventTime.fieldId",
  "catalog.dimensions",
  "catalog.denominatorMeasure.fieldId",
  "governance.exactLineageUnion",
  "governance.commonBundle.bundleId",
  "governance.commonBundle.evidenceRows",
  "governance.sourceSnapshot.canonicalBytes",
  "graph.schema",
  "graph.registry",
  "graph.limits",
  "graph.graphId",
  "graph.contractId",
  "graph.inputSnapshotId",
  "graph.source.fieldIds",
  "graph.source.requiredFieldIds",
  "graph.directFields.measure.fieldId",
  "graph.directFields.eventTime.fieldId",
  "graph.group.keyNodeIds",
  "graph.aggregation.op",
  "graph.aggregation.input",
  "graph.pathOps",
  "graph.conversionCount",
  "graph.conversionKinds",
  "graph.contractOutputNodeId",
  "graph.outputNodeIds",
  "graph.topologicalNodeIds",
  "graph.output.valueType",
  "graph.thresholdDiagnostics.thresholdNodeId",
  "graph.derivedFreshnessProjection.classifierNodeId",
  "graph.matchingFreshnessStructureCount",
  "result.schema",
  "result.resultId",
  "result.graphId",
  "result.state",
  "result.errorCode",
  "result.outputs",
  "freshness.evaluationUs",
  "freshness.checkedLagAndSloMillis",
  "freshness.maximumEventTimeUs",
  "freshness.sourceRows",
  "freshness.firstMaximumSourceRowId",
] as const;

const phase7MetricConformanceCoverage = {
  owners: [
    "owners-same-identity",
    "business-owner-revoked",
    "data-owner-revoked-at",
    "business-owner-stale-revision",
    "owner-cross-organization",
    "reviewed-only",
  ],
  catalogEligibility: [
    "measure-semantic-type",
    "aggregation-not-in-measure-closure",
    "event-time-null",
    "measure-not-in-bound-catalog",
    "event-time-semantic-type",
    "event-time-scalar-type",
    "dimension-semantic-type",
    "dimension-not-in-measure-allowed-set",
    "dimension-subset-forbidden",
    "dimension-unsorted",
    "dimension-duplicate",
  ],
  aggregationEquality: [
    "canonical-sum-currency-contract-graph-result",
    "ratio-percentage-contract-graph-result",
    "count-distinct-unsupported",
    "median-unsupported",
    "count-noninteger",
    "sum-nonnumeric-measure",
    "min-nondecimal-measure",
    "aggregation-op-drift",
    "mean-settings-drift",
    "ratio-divide-settings-drift",
  ],
  denominatorAndLineage: [
    "ratio-denominator-id-null",
    "ratio-denominator-version-null",
    "ratio-self-denominator",
    "ratio-denominator-unreviewed",
    "ratio-denominator-is-ratio",
    "ratio-denominator-set-drift",
    "ratio-denominator-catalog-drift",
    "ratio-denominator-calendar-drift",
    "ratio-denominator-timezone-drift",
    "ratio-denominator-dimension-drift",
    "ratio-denominator-grain-drift",
    "ratio-denominator-event-time-drift",
    "ratio-measure-metadata-drift",
    "lineage-missing-measure",
    "lineage-hidden-extra",
    "ratio-lineage-omits-denominator",
    "lineage-bundle-missing",
    "lineage-bundle-row-drift",
    "lineage-bundle-stale-label",
  ],
  conversion: [
    "no-conversion-required",
    "unneeded-currency-conversion",
    "missing-currency-conversion",
    "two-currency-conversions",
    "two-unit-conversions",
    "unit-conversion-incompatible",
    "unit-conversion-registry-drift",
    "unit-conversion-scale-drift",
    "unit-conversion-rounding-drift",
    "currency-direction-drift",
    "currency-scale-drift",
    "currency-rounding-drift",
    "currency-conversion-missing-fx-evidence",
    "currency-fx-identity-drift",
    "currency-fx-body-direction-drift",
    "currency-conversion-stale-fx",
    "unit-and-currency-conversion",
    "operation-between-aggregate-and-conversion",
  ],
  graphAndResultBinding: [
    "graph-contract-identity-drift",
    "source-missing-stable-key",
    "source-extra-field",
    "non-direct-measure-field",
    "group-dimension-subset",
    "group-dimension-extra",
    "forbidden-filter",
    "forbidden-sort",
    "forbidden-top-k",
    "forbidden-lag",
    "forbidden-window",
    "forbidden-conditional",
    "output-id-not-selected",
    "output-metadata-drift",
    "output-evaluation-domain-drift",
    "result-entry-missing",
    "result-output-hash-drift",
    "graph-schema-drift",
    "result-schema-drift",
    "graph-input-hash-drift",
    "graph-catalog-binding-drift",
    "graph-bundle-binding-drift",
    "result-graph-identity-drift",
    "result-catalog-binding-drift",
    "result-bundle-binding-drift",
  ],
  directionDiagnostics: [
    "higher-direction-two-diagnostics",
    "neutral-has-threshold-node",
    "direction-one-diagnostic-missing",
    "diagnostic-ids-equal",
    "diagnostic-equals-output",
    "diagnostic-not-output",
    "comparison-op-alias",
    "comparison-operands-swapped",
    "shared-threshold-target-literal",
    "threshold-literal-rounded",
    "unused-threshold-literal",
    "extra-threshold-consumer",
  ],
  freshnessDiagnostic: [
    "freshness-absent-zero-policy",
    "freshness-multiple-structures",
    "freshness-partial-through-max",
    "freshness-wrong-event-time-field",
    "freshness-field-not-direct",
    "freshness-group-has-key",
    "freshness-group-source-drift",
    "freshness-aggregate-not-max",
    "freshness-classifier-input-drift",
    "freshness-classifier-time-drift",
    "freshness-classifier-threshold-drift",
    "freshness-classifier-not-output",
    "freshness-projection-partial",
    "freshness-projection-caller-field",
    "freshness-projection-id-drift",
    "freshness-no-present-stale-value",
    "freshness-unavailable-value",
    "freshness-tie-not-first-ordinal",
    "freshness-future-maximum",
    "freshness-catalog-over-boundary",
    "freshness-source-over-boundary",
    "freshness-lineage-over-boundary",
    "freshness-row-one-microsecond-stale",
  ],
} as const;

const phase7RowCountOnlyWindowRejectionMatrix = [
  ["frame_kind", "any value", "invalid_graph"],
  ["event_time", "any value", "invalid_graph"],
  ["duration_millis", "any value", "invalid_graph"],
  ["period", "any value", "invalid_graph"],
  ["calendar", "any value", "invalid_graph"],
  [
    "fixed-duration interpretation",
    "even without an extra key",
    "invalid_graph",
  ],
  [
    "calendar-period interpretation",
    "even without an extra key",
    "invalid_graph",
  ],
  [
    "event-time membership interpretation",
    "even with event_time_field_id metadata",
    "invalid_graph",
  ],
] as const;

const phase7CalculationErrors = [
  "invalid_graph",
  "type_mismatch",
  "unit_mismatch",
  "currency_mismatch",
  "grain_mismatch",
  "missing_field",
  "cycle",
  "limit_exceeded",
  "overflow",
  "divide_by_zero",
  "empty_input",
  "invalid_timezone",
  "invalid_unit_conversion",
  "inexact_arithmetic",
  "missing_fx_evidence",
  "stale_fx",
  "invalid_group_key",
] as const;

const phase7R7Fixture = {
  evaluationTime: "2026-08-05T12:00:00.000000Z",
  observedAt: "2026-08-04T12:00:00.000000Z",
  rowId: "566c33d0-5293-8da4-bfd1-6bbaf864b153",
  groupRowId: "4c5b6acc-0c61-8c42-a6b6-35d927aed9fb",
  resultId: "782f2b22-b86a-8bda-8eae-451cc3f3a26e",
  hashes: {
    input: "99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8",
    evidence:
      "4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522",
    catalog: "df77652a8518e5ab39b0a42ab3093688e70ca755262affa9c450e41749dddea9",
    contractSet:
      "7dffbf5fa5e0a05f3e59d8e252994c89a1d6453de3eced139fa741877617c743",
    contract:
      "dd2df999d3ea9a08b7f8d0d53a84707cade54930fa66f8fd59991401c0a75eee",
    bundle: "e534de468f6daa31aa8f41876f595926a090e4951d576de65be5ea214b8508c7",
    graph: "2ccca8194640e0190f55f25c09be014b007a6e07b6cdcab907f1b6a5f92acc4f",
    meter: "3ff548a96c582a09a48260b8af8901dd16231a5b5511269c0186ff9ee725fc35",
    result: "35e905d4076c026705568b3a1287dacba3874aeaa48d8f7ce05b37551170e185",
    output: "f8134964526b30547b65693379806a3a1e86172702ea0d5fb76ff51c9691119d",
    outputValue:
      "5bb610a65947d0f71ae990c98baa443d12d3f31f2786e94740999ae192ad9cd8",
  },
  bytes: { input: 922, graph: 3788, output: 541, logicalAllocation: 8133 },
  intermediateBytes: [1238, 471, 315, 538],
} as const;

const phase7R7LiteralFixture = {
  bytes: {
    input:
      '{"fields":[{"field_id":"00000000-0000-8000-8000-000000000201","nullable":false,"scalar_type":"integer","stable_key_ordinal":"i64:0"},{"field_id":"00000000-0000-8000-8000-000000000202","nullable":false,"scalar_type":"decimal","stable_key_ordinal":null},{"field_id":"00000000-0000-8000-8000-000000000203","nullable":false,"scalar_type":"timestamp","stable_key_ordinal":null}],"input_snapshot_id":"00000000-0000-8000-8000-000000000101","row_count":"i64:1","rows":[{"row_id":"566c33d0-5293-8da4-bfd1-6bbaf864b153","values":[{"field_id":"00000000-0000-8000-8000-000000000201","state":"present","type":"integer","value":"i64:1"},{"field_id":"00000000-0000-8000-8000-000000000202","state":"present","type":"decimal","value":{"coefficient":"100","scale":"i64:0"}},{"field_id":"00000000-0000-8000-8000-000000000203","state":"present","type":"timestamp","value":"2026-08-04T12:00:00.000000Z"}]}],"schema":"canonical-input-table-v1"}',
    evidence:
      '{"from_currency":"USD","observed_at":"2026-08-04T12:00:00.000000Z","rate":{"coefficient":"925","scale":"i64:3"},"schema":"fx-rate-evidence-v1","to_currency":"EUR"}',
    catalog:
      '{"catalog_snapshot_id":"00000000-0000-8000-8000-000000000102","evaluated_at":"2026-08-05T12:00:00.000000Z","fields":[{"allowed_aggregations":["count"],"allowed_dimensions":[],"currency":null,"event_time_field_id":null,"field_id":"00000000-0000-8000-8000-000000000201","grain":"row","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"logical_name":"row_key","max_value_bytes":"i64:26","nullable":false,"scalar_type":"integer","semantic_type":"identifier","source_path":"/rows/*/key","stable_key_ordinal":"i64:0","unit":null},{"allowed_aggregations":["sum"],"allowed_dimensions":[],"currency":"USD","event_time_field_id":"00000000-0000-8000-8000-000000000203","field_id":"00000000-0000-8000-8000-000000000202","grain":"row","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"logical_name":"amount_usd","max_value_bytes":"i64:74","nullable":false,"scalar_type":"decimal","semantic_type":"measure","source_path":"/rows/*/amount","stable_key_ordinal":null,"unit":null},{"allowed_aggregations":["max"],"allowed_dimensions":[],"currency":null,"event_time_field_id":null,"field_id":"00000000-0000-8000-8000-000000000203","grain":"row","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"logical_name":"observed_at","max_value_bytes":"i64:29","nullable":false,"scalar_type":"timestamp","semantic_type":"event_time","source_path":"/rows/*/observed_at","stable_key_ordinal":null,"unit":null}],"input_row_count":"i64:1","input_sha256":"99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8","input_snapshot_id":"00000000-0000-8000-8000-000000000101","schema":"field-catalog-snapshot-v1"}',
    contractSet:
      '{"catalog_snapshot_id":"00000000-0000-8000-8000-000000000102","contract_set_id":"00000000-0000-8000-8000-000000000103","contracts":[{"aggregation":"sum","allowed_dimension_field_ids":[],"business_owner_membership_id":"00000000-0000-8000-8000-000000000109","calendar":"gregorian","contract_id":"00000000-0000-8000-8000-000000000104","currency":"EUR","data_owner_membership_id":"00000000-0000-8000-8000-000000000110","definition":"Sum the frozen USD measure and convert once with the bound synthetic USD/EUR rate.","denominator_contract_id":null,"denominator_contract_version":null,"direction":"neutral","freshness_slo_millis":"i64:86400000","grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","lag_millis":"i64:0","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"measure_field_id":"00000000-0000-8000-8000-000000000202","name":"EUR total","review_state":"reviewed","target":null,"threshold":null,"timezone":"UTC","unit":null,"value_type":"currency","version":"i64:1"}],"schema":"metric-contract-set-v1"}',
    contract:
      '{"aggregation":"sum","allowed_dimension_field_ids":[],"business_owner_membership_id":"00000000-0000-8000-8000-000000000109","calendar":"gregorian","contract_id":"00000000-0000-8000-8000-000000000104","currency":"EUR","data_owner_membership_id":"00000000-0000-8000-8000-000000000110","definition":"Sum the frozen USD measure and convert once with the bound synthetic USD/EUR rate.","denominator_contract_id":null,"denominator_contract_version":null,"direction":"neutral","freshness_slo_millis":"i64:86400000","grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","lag_millis":"i64:0","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"measure_field_id":"00000000-0000-8000-8000-000000000202","name":"EUR total","review_state":"reviewed","target":null,"threshold":null,"timezone":"UTC","unit":null,"value_type":"currency","version":"i64:1"}',
    bundle:
      '{"bundle_id":"00000000-0000-8000-8000-000000000105","entries":[{"evidence_id":"00000000-0000-8000-8000-000000000106","evidence_sha256":"4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522","freshness":"current","observed_at":"2026-08-04T12:00:00.000000Z","source_sha256":"99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8","source_snapshot_id":"00000000-0000-8000-8000-000000000101"}],"schema":"common-evidence-bundle-v1","source_snapshot_id":"00000000-0000-8000-8000-000000000101"}',
    graph:
      '{"common_bundle_id":"00000000-0000-8000-8000-000000000105","common_bundle_sha256":"e534de468f6daa31aa8f41876f595926a090e4951d576de65be5ea214b8508c7","contract_id":"00000000-0000-8000-8000-000000000104","contract_output_node_id":"00000000-0000-8000-8000-000000000305","contract_set_id":"00000000-0000-8000-8000-000000000103","contract_version":"i64:1","evaluation_time":"2026-08-05T12:00:00.000000Z","field_catalog_sha256":"df77652a8518e5ab39b0a42ab3093688e70ca755262affa9c450e41749dddea9","field_catalog_snapshot_id":"00000000-0000-8000-8000-000000000102","fx_evidence_id":"00000000-0000-8000-8000-000000000106","fx_evidence_sha256":"4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522","graph_id":"00000000-0000-8000-8000-000000000107","input_sha256":"99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8","input_snapshot_id":"00000000-0000-8000-8000-000000000101","limits":"calculation-limits-v1","nodes":[{"evaluation_rows_from":null,"field_ids":["00000000-0000-8000-8000-000000000201","00000000-0000-8000-8000-000000000202","00000000-0000-8000-8000-000000000203"],"node_id":"00000000-0000-8000-8000-000000000301","op":"source","output_type":{"currency":null,"fields":[{"currency":null,"field_id":"00000000-0000-8000-8000-000000000201","grain":"row","max_value_bytes":"i64:26","name":"row_key","nullable":false,"scalar":"integer","unit":null},{"currency":"USD","field_id":"00000000-0000-8000-8000-000000000202","grain":"row","max_value_bytes":"i64:74","name":"amount_usd","nullable":false,"scalar":"decimal","unit":null},{"currency":null,"field_id":"00000000-0000-8000-8000-000000000203","grain":"row","max_value_bytes":"i64:29","name":"observed_at","nullable":false,"scalar":"timestamp","unit":null}],"grain":null,"max_value_bytes":null,"nullable":null,"scalar":null,"shape":"rowset","unit":null}},{"evaluation_rows_from":"00000000-0000-8000-8000-000000000301","field_id":"00000000-0000-8000-8000-000000000202","input":"00000000-0000-8000-8000-000000000301","node_id":"00000000-0000-8000-8000-000000000302","op":"field","output_type":{"currency":"USD","fields":null,"grain":"row","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null}},{"evaluation_rows_from":null,"input":"00000000-0000-8000-8000-000000000301","key_node_ids":[],"node_id":"00000000-0000-8000-8000-000000000303","op":"group","output_type":{"currency":null,"fields":[],"grain":null,"max_value_bytes":null,"nullable":null,"scalar":null,"shape":"rowset","unit":null}},{"evaluation_rows_from":"00000000-0000-8000-8000-000000000303","group_node_id":"00000000-0000-8000-8000-000000000303","input":"00000000-0000-8000-8000-000000000302","node_id":"00000000-0000-8000-8000-000000000304","op":"sum","output_type":{"currency":"USD","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null}},{"evaluation_rows_from":"00000000-0000-8000-8000-000000000303","from_currency":"USD","fx_evidence_id":"00000000-0000-8000-8000-000000000106","input":"00000000-0000-8000-8000-000000000304","node_id":"00000000-0000-8000-8000-000000000305","op":"currency_convert","output_type":{"currency":"EUR","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null},"rate":{"coefficient":"925","scale":"i64:3"},"rounding":"half_even","scale":"i64:2","to_currency":"EUR"}],"output_node_ids":["00000000-0000-8000-8000-000000000305"],"registry":"calculation-registry-v1","schema":"calculation-graph-v1","target_node_id":null,"threshold_node_id":null,"timezone":"UTC","tzdb_version":"2025b","unit_registry_version":"ucum-subset-v1"}',
    meter:
      '{"ast_bytes":"i64:3788","cumulative_intermediate_bytes":"i64:2562","cumulative_intermediate_rows":"i64:4","final_output_rows":"i64:1","graph_id":"00000000-0000-8000-8000-000000000107","group_count":"i64:1","input_bytes":"i64:922","logical_allocation_bytes":"i64:8133","max_coefficient_digits":"i64:3","max_depth":"i64:4","max_group_rows":"i64:1","max_literal_bytes":"i64:0","max_literal_list_length":"i64:0","max_scale":"i64:3","max_top_k":"i64:0","max_window_frame":"i64:0","node_count":"i64:5","output_bytes":"i64:541","primitive_steps":"i64:6","result_id":"782f2b22-b86a-8bda-8eae-451cc3f3a26e","scanned_rows":"i64:1","schema":"calculation-meter-v1","total_literal_bytes":"i64:0"}',
    result:
      '{"error_code":null,"graph_id":"00000000-0000-8000-8000-000000000107","graph_sha256":"2ccca8194640e0190f55f25c09be014b007a6e07b6cdcab907f1b6a5f92acc4f","meter_sha256":"3ff548a96c582a09a48260b8af8901dd16231a5b5511269c0186ff9ee725fc35","outputs":[{"cardinality":"i64:1","evaluation_rows_from":"00000000-0000-8000-8000-000000000303","node_id":"00000000-0000-8000-8000-000000000305","output_type":{"currency":"EUR","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null},"rows":[{"ordinal":"i64:0","row_id":"4c5b6acc-0c61-8c42-a6b6-35d927aed9fb","value":{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}}],"shape":"scalar"}],"result_id":"782f2b22-b86a-8bda-8eae-451cc3f3a26e","schema":"calculation-result-v1","state":"succeeded"}',
    output:
      '{"cardinality":"i64:1","evaluation_rows_from":"00000000-0000-8000-8000-000000000303","node_id":"00000000-0000-8000-8000-000000000305","output_type":{"currency":"EUR","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null},"rows":[{"ordinal":"i64:0","row_id":"4c5b6acc-0c61-8c42-a6b6-35d927aed9fb","value":{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}}],"shape":"scalar"}',
    outputsArray:
      '[{"cardinality":"i64:1","evaluation_rows_from":"00000000-0000-8000-8000-000000000303","node_id":"00000000-0000-8000-8000-000000000305","output_type":{"currency":"EUR","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null},"rows":[{"ordinal":"i64:0","row_id":"4c5b6acc-0c61-8c42-a6b6-35d927aed9fb","value":{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}}],"shape":"scalar"}]',
    outputValue:
      '{"field_id":null,"node_id":"00000000-0000-8000-8000-000000000305","result_id":"782f2b22-b86a-8bda-8eae-451cc3f3a26e","row_id":"4c5b6acc-0c61-8c42-a6b6-35d927aed9fb","schema":"calculation-output-value-v1","value":{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}}',
  },
  sourceRows: {
    organizationId: "00000000-0000-8000-8000-000000000001",
    dashboardId: "00000000-0000-8000-8000-000000000002",
    runId: "00000000-0000-8000-8000-000000000003",
    sourceSnapshotId: "00000000-0000-8000-8000-000000000101",
    catalogSnapshotId: "00000000-0000-8000-8000-000000000102",
    contractSetId: "00000000-0000-8000-8000-000000000103",
    contractId: "00000000-0000-8000-8000-000000000104",
    bundleId: "00000000-0000-8000-8000-000000000105",
    evidenceId: "00000000-0000-8000-8000-000000000106",
    graphId: "00000000-0000-8000-8000-000000000107",
    meterId: "00000000-0000-8000-8000-000000000108",
    businessOwnerMembershipId: "00000000-0000-8000-8000-000000000109",
    dataOwnerMembershipId: "00000000-0000-8000-8000-000000000110",
    keyFieldId: "00000000-0000-8000-8000-000000000201",
    amountFieldId: "00000000-0000-8000-8000-000000000202",
    eventTimeFieldId: "00000000-0000-8000-8000-000000000203",
    sourceNodeId: "00000000-0000-8000-8000-000000000301",
    fieldNodeId: "00000000-0000-8000-8000-000000000302",
    groupNodeId: "00000000-0000-8000-8000-000000000303",
    sumNodeId: "00000000-0000-8000-8000-000000000304",
    fxNodeId: "00000000-0000-8000-8000-000000000305",
    sourceKind: "synthetic_fixture",
    evidenceKind: "typed_value",
    coordinates: "task9-fx:USD/EUR",
    observedAt: "2026-08-04T12:00:00.000000Z",
    retrievedAt: "2026-08-04T12:00:00.000000Z",
    createdAt: "2026-08-04T12:00:00.000000Z",
    transformation:
      '{"from_currency":"USD","observed_at":"2026-08-04T12:00:00.000000Z","rate":{"coefficient":"925","scale":"i64:3"},"schema":"fx-rate-evidence-v1","to_currency":"EUR"}',
    fieldEntrySha256: [
      "fcc70d5724088cca1303a01f04e79a146de5ce47fde3d4ecfe8ca3586f866651",
      "fdbc43baeb43ec44ba2c540da6ea01aa7663a33c0cdabe6df5f1c34aa6718790",
      "dac812f871f145f78fcd3c7229e9959e1fc745a787a20e2ed3201d16e0e4c678",
    ],
  },
  boundaryMutations: {
    "fx-jpy-positive-tie": {
      transformation:
        'replace the input amount coefficient `100` by `1`; replace evidence ID `0106` by `0111` in all three catalog lineages, contract lineage, bundle, and graph; use evidence bytes `{"from_currency":"USD","observed_at":"2026-08-04T12:00:00.000000Z","rate":{"coefficient":"15","scale":"i64:1"},"schema":"fx-rate-evidence-v1","to_currency":"JPY"}`, kind `typed_value`, coordinates `task9-fx:USD/JPY`, and identical transformation; retain catalog input currency USD; change only contract name/definition/output currency to `JPY total`/`Sum the frozen USD measure and convert once with the bound synthetic USD/JPY rate.`/JPY and graph FX to-currency/output currency/rate/scale to JPY/JPY/`15,i64:1`/`i64:0`; replace every stated downstream SHA with the literals at right; no other byte changes',
      expected:
        "present decimal `2/i64:0`, result ID `406b3f62-6bf1-8b66-8012-55f960d4a667`, `primitive_steps=i64:6`; input `cbf973a5ced4b32f584a8e50e4415a89dfdaf375fa20567ce9c226f916f64b53`/`920`; evidence `e544f32397622b59e433bba55eba7c7526591b97f441b0e21283f4be1c053e0f`; entry hashes `186e2fdd2d2c732f5cc195ce51790751abfb54f4e4af667b4752597cd208007d,5746b7ebb36a79359e76d07f640c65edd0f1be50d754bc0a5ff0da3b559713aa,f7a05e2240c82a67222f4fb022e72458c7fa16f14c78d5b168b5142b5a217097`; catalog `9bd7af6cdb668a3496986952b29f08d6531cfacb4807749f8c8cf3b81c07e2dd`; contract set/member `605753e9681d75cd063869b9fc704ee654f1f214f0d0ba270402b65b9b03c835`/`77db8c613986e7c4dc02d3bab5c5c7c65b8bba108f886cfa7d7ff2564ed2084c`; bundle `a553b776c664592feefff6ba169f788b4983afcd76c03120094f636195fe09c4`; graph `06d6eaeb1d41804c32eb6af430fa04ccbd43557a7e3efd8197b566b30231c832`/`3787`; intermediate lengths `1236,469,315,536`; output/logical bytes `539`/`8122`; meter `64baa053d04ec55cce74294d40cadf2194b9718c371a9c200abaadf7e8b19470`; result `770bb4b97494de8dac4a48adafb3c8c25f5a1e4a8e9564ecb81805253aaaee8b`; output/value `7490c738b15a35510d3c724217e7a10bd5be8cef18a27e57fbc7b86f6ebf07e1`/`ec2c0c4b8310b5d001024d73aa36930f42a6775be5e78d92f95212b2fab9efe9`",
    },
    "fx-jpy-negative-tie": {
      transformation:
        "apply the positive transformation but replace input amount by `-1`; only input/source-dependent catalog, bundle, graph, result, output, value, and meter identities change as listed at right",
      expected:
        "present decimal `-2/i64:0`, result ID `8f4298c6-0eb4-8591-8d4d-985836129104`, `primitive_steps=i64:6`; input `f046b400986e98f0b11eb825e60442ea2fe9b5654eaeae931e611ea06126d628`/`921`; evidence/entry/contract hashes equal the positive vector; catalog `1fb1b99e5d26a464a6bdbcc3cce98e82e6998d6ce5d1ecc73f0b8e9af1f1e4d0`; bundle `2dd0edf39de73cc8c723b0b35bde307477f159be4071afadccf25e17d0902b35`; graph `1943fe0f549f608689f06cd698794c5dde3f605e015bf8fd446a77433235952c`/`3787`; intermediate lengths `1237,470,315,537`; output/logical bytes `540`/`8127`; meter `f1c03a17e6929ae0387f02ad21a73f5cd4927b5272dbbfbd34b47f459176a0c4`; result `9a9b763058ccc21bbd236e156d3d6f126a895fb39a50a2283becc559796be519`; output/value `567acc019a1092eba15b941acb9ecf1af446aa316dec83c4cb68bd76818e8563`/`080026c9f34c0a0bc71306bf318bf13f77c8c4af073e330ac1f5b50f80ed41e2`",
    },
    "fx-fresh-inclusive": {
      transformation: "unmodified fixture",
      expected: "succeeds at exactly `86,400,000` ms",
    },
    "fx-stale-one-microsecond": {
      transformation:
        "set body observed time, evidence-row `observed_at`/`retrieved_at`, and bundle-entry `observed_at` to `2026-08-04T11:59:59.999999Z`; retain row `created_at`; use evidence SHA `25fb9decefb6592fb868513db105082c3f95e5c0d83374f19ed55c724354e583` and recompute all downstream identities",
      expected: "`stale_fx`; no committed graph/result/meter/event",
    },
    "fx-future-one-microsecond": {
      transformation:
        "set body observed time, evidence-row `observed_at`/`retrieved_at`, and bundle-entry `observed_at` to `2026-08-05T12:00:00.000001Z`; retain row `created_at`; use evidence SHA `acbe71d60ef0be625a676c53a508dba14a713bd3dc70df8180351fb4e8b36a04` and recompute downstream identities",
      expected: "`stale_fx`; no DML",
    },
    "fx-kind-predecessor-compatible": {
      transformation: "unmodified exact `typed_value` row",
      expected: "accepted; catalog proves immutable 0003 CHECK unchanged",
    },
    "fx-kind-forbidden-spelling": {
      transformation: "change only evidence kind to `synthetic_fx_rate`",
      expected:
        "immutable predecessor CHECK rejects owner-fixture INSERT; no 0007 constraint replacement exists",
    },
    "fx-missing-before-stale": {
      transformation: "use the stale vector and omit its bundle member",
      expected: "`missing_fx_evidence`, never `stale_fx`",
    },
    "fx-direction-drift": {
      transformation:
        "swap only the evidence body's from/to codes to EUR/USD, update its coordinates to `task9-fx:EUR/USD`, and recompute that row hash plus every evidence-SHA reference; leave the well-typed node/input/output USD/EUR direction unchanged",
      expected:
        "`missing_fx_evidence` after currency shape checks because body and node direction differ; no reciprocal",
    },
    "fx-meter-byte-drift": {
      transformation: "increment only supplied `output_bytes` to `i64:542`",
      expected: "fixed commit denial `P1002`; no DML",
    },
    "fx-38/39-digit": {
      transformation:
        "retain USD/EUR and target exponent 2; use input decimal coefficient `99999999999999999999999999999999999999`, scale `i64:0`; the success evidence rate is coefficient `1`, scale `i64:0`, while the overflow evidence rate is coefficient `10`, scale `i64:0`; recompute each exact evidence/downstream chain",
      expected:
        "rate 1 succeeds with that same 38-digit coefficient and canonical scale `i64:0`; rate 10 produces a 39-digit final coefficient and is `overflow` before meter limit",
    },
  },
} as const;

const phase7AuthorityContract = {
  runSchema: {
    owner: "migration_owner",
    usage: ["dasher_run_definer", "dasher_run_operator"],
    create: [],
  },
  runCapabilities: [
    "checkpoint",
    "claim",
    "clone_replay",
    "close_candidate_set",
    "commit_abstention",
    "commit_brief",
    "commit_bundle",
    "commit_candidate",
    "commit_claims",
    "commit_graph",
    "commit_manifest",
    "commit_validation",
    "consume_replay",
    "dispatch",
    "finalize_ranking",
    "finish",
    "read_input",
    "read_replay",
    "reconcile",
    "release",
    "reserve",
  ],
  lockOnlyPolicies: [
    "run_service_principal_allowlist_run_lock_update",
    "agent_run_policy_revisions_run_lock_update",
    "memberships_run_reauthorization_lock",
  ],
  specialSelectPolicies: [
    "run_service_principal_allowlist_bootstrap_select",
    "memberships_run_reauthorization_select",
    "agent_run_events_run_claim_retry_select",
    "agent_run_event_payloads_run_definer_select",
    "agent_runs_security_definer_select:cancel_operation_probe",
    "audit_events_security_definer_cancel_operation_select",
  ],
  lockOnlyWithCheck: "false",
  triggers: [
    "agent_run_immutable_guard",
    "agent_run_transition_guard",
    "agent_run_retention_guard",
  ],
  checkpointEventPayloadColumns: [
    "organization_id",
    "dashboard_id",
    "run_id",
    "event_payload_id",
    "event_id",
    "event_sequence",
    "content_nonce",
    "canonical_bytes",
    "payload_sha256",
  ],
  sequences: [],
} as const;

const phase7FunctionReturns = {
  request_agent_run: "dasher_api.agent_run_request_result",
  cancel_agent_run: "dasher_api.agent_run_mutation_result",
  get_agent_run: "dasher_api.agent_run_summary",
  list_agent_run_events: "SETOF dasher_api.agent_run_event_summary",
  get_agent_run_checkpoint: "dasher_api.agent_run_checkpoint_result",
  get_agent_candidate: "dasher_api.agent_candidate_result",
  claim_agent_run: "dasher_run_api.agent_run_claim_result",
  get_claimed_agent_run_input: "dasher_run_api.claimed_run_input_result",
  clone_claimed_replay_prerequisites:
    "dasher_run_api.replay_prerequisite_result",
  list_claimed_replay_results: "SETOF dasher_run_api.replay_source_result",
  consume_agent_replay_result: "dasher_run_api.replay_consume_result",
  write_agent_run_checkpoint: "dasher_run_api.checkpoint_commit_result",
  commit_agent_brief: "dasher_run_api.content_commit_result",
  commit_common_evidence_bundle: "dasher_run_api.content_commit_result",
  reserve_agent_run_attempt: "dasher_run_api.attempt_reservation_result",
  start_agent_run_attempt: "dasher_run_api.attempt_start_result",
  authorize_agent_run_attempt_invocation:
    "dasher_run_api.attempt_invocation_result",
  reconcile_agent_run_attempt: "dasher_run_api.attempt_accounting_result",
  release_agent_run_attempt: "dasher_run_api.attempt_accounting_result",
  commit_calculation_graph: "dasher_run_api.calculation_commit_result",
  commit_agent_validation_findings: "dasher_run_api.validation_findings_result",
  commit_agent_candidate: "dasher_run_api.content_commit_result",
  close_agent_candidate_set: "dasher_run_api.candidate_set_result",
  commit_candidate_claims: "dasher_run_api.claim_set_result",
  commit_candidate_manifest: "dasher_run_api.content_commit_result",
  commit_run_abstention: "dasher_run_api.content_commit_result",
  finalize_agent_run_ranking: "dasher_run_api.ranking_result",
  finish_agent_run: "dasher_run_api.run_mutation_result",
  claim_dashboard_cleanup: "void",
  record_dashboard_cleanup_attempt: "void",
  drain_dashboard_agent_runs: "void",
  purge_dashboard: "void",
  age_out_dashboard_agent_run_metadata: "void",
} as const;

const phase7RetentionArguments = {
  claim_dashboard_cleanup: [
    "dashboard_id",
    "expected_lifecycle_revision",
    "expected_transition_proof_sha256",
    "lease_duration",
    "lifecycle_event_and_audit_id",
    "deployment_revision",
    "target_organization_id",
  ],
  record_dashboard_cleanup_attempt: [
    "dashboard_id",
    "cleanup_attempt_id",
    "step",
    "result",
    "released_claim_count",
    "deleted_resource_count",
    "deferred_claim_count",
    "completion_proof_sha256",
    "target_organization_id",
  ],
  drain_dashboard_agent_runs: [
    "dashboard_id",
    "expected_lifecycle_revision",
    "drain_request_proof_sha256",
    "operation_and_audit_id",
    "deployment_revision",
    "target_organization_id",
  ],
  purge_dashboard: [
    "dashboard_id",
    "expected_lifecycle_revision",
    "cleanup_completion_proof_sha256",
    "operation_and_audit_id",
    "deployment_revision",
    "target_organization_id",
  ],
  age_out_dashboard_agent_run_metadata: [
    "dashboard_id",
    "expected_lifecycle_revision",
    "tombstone_backup_source_proof_sha256",
    "operation_and_audit_id",
    "deployment_revision",
    "target_organization_id",
  ],
} as const;

const phase7FunctionArguments = {
  request_agent_run: [
    ["dashboard_id", "uuid"],
    ["input_snapshot_id", "uuid"],
    ["run_request_id", "uuid"],
    ["purpose", "text"],
    ["expected_lifecycle_revision", "bigint"],
    ["expected_input_sha256", "bytea"],
    ["idempotency_sha256", "bytea"],
    ["audit_event_id", "uuid"],
    ["current_csrf_key_version", "smallint"],
    ["current_csrf_digest", "bytea"],
    ["deployment_revision", "text"],
    ["replay_source_run_id", "uuid"],
  ],
  cancel_agent_run: [
    ["run_id", "uuid"],
    ["expected_run_revision", "bigint"],
    ["canonical_cancel_reason_bytes", "bytea"],
    ["cancel_operation_and_audit_id", "uuid"],
    ["current_csrf_key_version", "smallint"],
    ["current_csrf_digest", "bytea"],
    ["deployment_revision", "text"],
  ],
  get_agent_run: [["run_id", "uuid"]],
  list_agent_run_events: [
    ["run_id", "uuid"],
    ["after_sequence", "bigint"],
    ["limit", "integer"],
  ],
  get_agent_run_checkpoint: [["run_id", "uuid"]],
  get_agent_candidate: [
    ["run_id", "uuid"],
    ["candidate_id", "uuid"],
  ],
  claim_agent_run: [
    ["claim_request_id", "uuid"],
    ["lease_seconds", "integer"],
  ],
  get_claimed_agent_run_input: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
  ],
  clone_claimed_replay_prerequisites: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
  ],
  list_claimed_replay_results: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["after_source_sequence", "bigint"],
    ["limit", "integer"],
  ],
  consume_agent_replay_result: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["source_result_sequence", "bigint"],
    ["source_result_sha256", "bytea"],
  ],
  write_agent_run_checkpoint: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["source_event_sequence", "bigint"],
    ["source_event_sha256", "bytea"],
    ["canonical_checkpoint_bytes", "bytea"],
  ],
  commit_agent_brief: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["brief_id", "uuid"],
    ["canonical_brief_bytes", "bytea"],
  ],
  commit_common_evidence_bundle: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["bundle_id", "uuid"],
    ["canonical_bundle_bytes", "bytea"],
  ],
  reserve_agent_run_attempt: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["attempt_id", "uuid"],
    ["partition", "text"],
    ["attempt_kind", "text"],
    ["reserved_vector", "dasher_run_api.attempt_resource_vector"],
    ["canonical_request_bytes", "bytea"],
  ],
  start_agent_run_attempt: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["attempt_id", "uuid"],
    ["dispatch_request_sha256", "bytea"],
  ],
  authorize_agent_run_attempt_invocation: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["attempt_id", "uuid"],
    ["dispatch_request_sha256", "bytea"],
  ],
  reconcile_agent_run_attempt: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["attempt_id", "uuid"],
    ["outcome", "text"],
    ["actual_accounting_bytes", "bytea"],
    ["result_sha256", "bytea"],
    ["canonical_recorded_result_bytes", "bytea"],
  ],
  release_agent_run_attempt: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["attempt_id", "uuid"],
    ["reason", "text"],
    ["release_proof_sha256", "bytea"],
  ],
  commit_calculation_graph: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["graph_id", "uuid"],
    ["canonical_graph_bytes", "bytea"],
    ["canonical_result_bytes", "bytea"],
    ["meter_vector", "dasher_run_api.calculation_meter_vector_v1"],
    ["expected_input_sha256", "bytea"],
  ],
  commit_agent_validation_findings: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["candidate_id", "uuid"],
    ["canonical_findings_bytes", "bytea"],
  ],
  commit_agent_candidate: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["candidate_id", "uuid"],
    ["canonical_dashboard_spec_bytes", "bytea"],
    ["common_bundle_sha256", "bytea"],
    ["source_result_id", "uuid"],
    ["source_result_sha256", "bytea"],
    ["precommit_validation_sha256", "bytea"],
  ],
  close_agent_candidate_set: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["ordered_candidate_set_sha256", "bytea"],
  ],
  commit_candidate_claims: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["candidate_id", "uuid"],
    ["canonical_claim_edge_set_bytes", "bytea"],
  ],
  commit_candidate_manifest: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["candidate_id", "uuid"],
    ["canonical_manifest_bytes", "bytea"],
    ["reviewer_result_sha256", "bytea"],
  ],
  commit_run_abstention: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["terminal_operation_id", "uuid"],
    ["canonical_abstention_bytes", "bytea"],
  ],
  finalize_agent_run_ranking: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["terminal_operation_id", "uuid"],
    ["selected_candidate_id", "uuid"],
    ["ranking_proof_sha256", "bytea"],
  ],
  finish_agent_run: [
    ["run_id", "uuid"],
    ["lease_epoch", "bigint"],
    ["attempt_token", "bytea"],
    ["terminal_operation_id", "uuid"],
    ["terminal_outcome", "text"],
    ["canonical_reason_bytes", "bytea"],
  ],
  claim_dashboard_cleanup: [
    ["dashboard_id", "uuid"],
    ["expected_lifecycle_revision", "bigint"],
    ["expected_transition_proof_sha256", "bytea"],
    ["lease_duration", "interval"],
    ["lifecycle_event_and_audit_id", "uuid"],
    ["deployment_revision", "text"],
    ["target_organization_id", "uuid"],
  ],
  record_dashboard_cleanup_attempt: [
    ["dashboard_id", "uuid"],
    ["cleanup_attempt_id", "uuid"],
    ["step", "text"],
    ["result", "text"],
    ["released_claim_count", "integer"],
    ["deleted_resource_count", "integer"],
    ["deferred_claim_count", "integer"],
    ["completion_proof_sha256", "bytea"],
    ["target_organization_id", "uuid"],
  ],
  drain_dashboard_agent_runs: [
    ["dashboard_id", "uuid"],
    ["expected_lifecycle_revision", "bigint"],
    ["drain_request_proof_sha256", "bytea"],
    ["operation_and_audit_id", "uuid"],
    ["deployment_revision", "text"],
    ["target_organization_id", "uuid"],
  ],
  purge_dashboard: [
    ["dashboard_id", "uuid"],
    ["expected_lifecycle_revision", "bigint"],
    ["cleanup_completion_proof_sha256", "bytea"],
    ["operation_and_audit_id", "uuid"],
    ["deployment_revision", "text"],
    ["target_organization_id", "uuid"],
  ],
  age_out_dashboard_agent_run_metadata: [
    ["dashboard_id", "uuid"],
    ["expected_lifecycle_revision", "bigint"],
    ["tombstone_backup_source_proof_sha256", "bytea"],
    ["operation_and_audit_id", "uuid"],
    ["deployment_revision", "text"],
    ["target_organization_id", "uuid"],
  ],
} as const;

const phase7OperatorCapabilities = {
  claim_agent_run: "claim",
  get_claimed_agent_run_input: "read_input",
  clone_claimed_replay_prerequisites: "clone_replay",
  list_claimed_replay_results: "read_replay",
  consume_agent_replay_result: "consume_replay",
  write_agent_run_checkpoint: "checkpoint",
  commit_agent_brief: "commit_brief",
  commit_common_evidence_bundle: "commit_bundle",
  reserve_agent_run_attempt: "reserve",
  start_agent_run_attempt: "dispatch",
  authorize_agent_run_attempt_invocation: "dispatch",
  reconcile_agent_run_attempt: "reconcile",
  release_agent_run_attempt: "release",
  commit_calculation_graph: "commit_graph",
  commit_agent_validation_findings: "commit_validation",
  commit_agent_candidate: "commit_candidate",
  close_agent_candidate_set: "close_candidate_set",
  commit_candidate_claims: "commit_claims",
  commit_candidate_manifest: "commit_manifest",
  commit_run_abstention: "commit_abstention",
  finalize_agent_run_ranking: "finalize_ranking",
  finish_agent_run: "finish",
} as const;

const phase7OperatorCommonProjectionEqualityProof = {
  claim_agent_run: "promoted run-definer authority fence",
  get_claimed_agent_run_input: "promoted run-definer authority fence",
  clone_claimed_replay_prerequisites: "promoted run-definer authority fence",
  list_claimed_replay_results: "promoted run-definer authority fence",
  consume_agent_replay_result: "promoted run-definer authority fence",
  write_agent_run_checkpoint: "promoted run-definer authority fence",
  commit_agent_brief: "promoted run-definer authority fence",
  commit_common_evidence_bundle: "promoted run-definer authority fence",
  reserve_agent_run_attempt: "promoted run-definer authority fence",
  start_agent_run_attempt: "promoted run-definer authority fence",
  authorize_agent_run_attempt_invocation:
    "promoted run-definer authority fence",
  reconcile_agent_run_attempt: "promoted run-definer authority fence",
  release_agent_run_attempt: "promoted run-definer authority fence",
  commit_calculation_graph: "promoted run-definer authority fence",
  commit_agent_validation_findings: "promoted run-definer authority fence",
  commit_agent_candidate: "promoted run-definer authority fence",
  close_agent_candidate_set: "promoted run-definer authority fence",
  commit_candidate_claims: "promoted run-definer authority fence",
  commit_candidate_manifest: "promoted run-definer authority fence",
  commit_run_abstention: "promoted run-definer authority fence",
  finalize_agent_run_ranking: "promoted run-definer authority fence",
  finish_agent_run: "promoted run-definer authority fence",
} as const satisfies Record<
  keyof typeof phase7OperatorCapabilities,
  "promoted run-definer authority fence"
>;

const phase7FunctionPolicyAndTriggerDependencies = {
  tenant: {
    owner: "dasher_security_definer",
    executeRole: "dasher_app",
    policies:
      "<relation>_security_definer_{select|insert|update} only when present in the relation/function matrices",
    predicates: phase7PolicyExpressionTemplates.securityDefiner,
    triggers: [
      "agent_run_immutable_guard",
      "agent_run_transition_guard",
      "agent_run_retention_guard",
    ],
  },
  operator: {
    owner: "dasher_run_definer",
    executeRole: "dasher_run_operator",
    capabilities: phase7OperatorCapabilities,
    policies:
      "<relation>_run_definer_{select|insert|update}, predecessor <relation>_run_select/<relation>_run_lock_update, and only the explicitly named bootstrap/discovery/retry/checkpoint exceptions",
    predicates: phase7PolicyExpressionTemplates.runDefiner,
    triggers: [
      "agent_run_immutable_guard",
      "agent_run_transition_guard",
      "agent_run_retention_guard",
    ],
  },
  retention: {
    owner: "dasher_retention_definer",
    executeRole: "dasher_retention_operator",
    policies:
      "<relation>_retention_definer_{select|insert|update|delete} only when present in the relation/function matrices",
    predicates: phase7PolicyExpressionTemplates.retentionDefiner,
    triggers: [
      "agent_run_immutable_guard",
      "agent_run_transition_guard",
      "agent_run_retention_guard",
    ],
  },
  privateHelpers: {
    executeRoles: [],
    publicExecute: false,
    appendEvent:
      "reachable only from fixed SECURITY DEFINER bodies; INSERT event/payload only; no historical event-body read",
    replaySourceFence:
      "no runtime EXECUTE grant; exact conditional read union only",
  },
} as const;

const phase7Task9ProjectionColumns = Object.fromEntries(
  Object.entries(phase7RelationColumns).map(([relation, definition]) => [
    relation,
    definition.split(", ").map((column) => column.split(" ")[0]!),
  ]),
) as unknown as Record<keyof typeof phase7RelationColumns, readonly string[]>;

const phase7PredecessorProjectionColumns = {
  memberships: [
    "organization_id",
    "membership_id",
    "user_id",
    "role",
    "state",
    "authority_revision",
    "revoked_at",
  ],
  dashboard_lifecycle_policies: ["organization_id", "policy_revision"],
  dashboards: [
    "organization_id",
    "dashboard_id",
    "current_kind",
    "lifecycle_state",
    "lifecycle_revision",
    "effective_expires_at",
    "access_revoked_at",
    "purged_at",
    "head_version_id",
  ],
  dashboard_lifecycle_events: [
    "lifecycle_event_id",
    "organization_id",
    "dashboard_id",
    "lifecycle_revision",
    "event_kind",
    "from_kind",
    "to_kind",
    "from_state",
    "to_state",
    "occurred_at",
    "actor_user_id",
    "actor_service",
    "authority_revision",
    "retention_policy_revision",
    "request_id",
    "job_id",
    "reason_sha256",
  ],
  source_snapshots: [
    "organization_id",
    "snapshot_id",
    "source_kind",
    "canonical_bytes",
    "content_sha256",
    "observed_at",
    "retrieved_at",
    "created_at",
  ],
  evidence_records: [
    "organization_id",
    "evidence_id",
    "snapshot_id",
    "evidence_kind",
    "coordinates",
    "transformation",
    "content_sha256",
    "observed_at",
    "retrieved_at",
    "created_at",
  ],
  audit_events: [
    "audit_event_id",
    "organization_id",
    "occurred_at",
    "actor_kind",
    "actor_user_id",
    "actor_service",
    "authority_revision",
    "request_id",
    "job_id",
    "action",
    "target_type",
    "target_id",
    "outcome",
    "content_sha256",
    "source_ref",
    "provider",
    "credential_version",
    "usage_units",
    "cost_minor_units",
    "deployment_revision",
  ],
  dashboard_cleanup_coordination: [
    "organization_id",
    "dashboard_id",
    "current_step",
    "lease_owner",
    "lease_expires_at",
    "expected_lifecycle_revision",
    "next_attempt_at",
    "completion_proof_sha256",
  ],
  dashboard_cleanup_attempts: [
    "organization_id",
    "dashboard_id",
    "cleanup_attempt_id",
    "step",
    "started_at",
    "finished_at",
    "result",
    "released_claim_count",
    "deleted_resource_count",
    "deferred_claim_count",
    "failure_code",
    "proof_sha256",
  ],
  dashboard_legal_holds: [
    "organization_id",
    "dashboard_id",
    "hold_id",
    "released_at",
  ],
  dashboard_tombstones: [
    "organization_id",
    "tombstone_lineage_id",
    "purged_at",
    "purged_lifecycle_revision",
    "purged_proof_sha256",
  ],
  backup_deletion_ledger: [
    "organization_id",
    "ledger_sequence",
    "tombstone_lineage_id",
    "event_kind",
    "proof_sha256",
  ],
  run_service_principal_allowlist:
    phase7Task9ProjectionColumns.run_service_principal_allowlist,
  retention_service_principal_allowlist: [
    "retention_service_principal_id",
    "principal_revision",
    "binding_kind",
    "binding_subject",
    "authority_scope",
    "scope_organization_id",
    "enabled",
    "can_initialize",
    "can_materialize_expiry",
    "can_place_hold",
    "can_release_hold",
    "can_claim_cleanup",
    "can_record_attempt",
    "can_purge",
    "created_at",
    "predecessor_revision",
    "predecessor_sha256",
    "revision_sha256",
    "migration_provenance",
  ],
  pg_constraint: [
    "oid",
    "conname",
    "contype",
    "conrelid",
    "confrelid",
    "conkey",
    "confkey",
    "confupdtype",
    "confdeltype",
    "confmatchtype",
    "condeferrable",
    "condeferred",
  ],
} as const;

type Phase7ProjectionRelation =
  | keyof typeof phase7Task9ProjectionColumns
  | keyof typeof phase7PredecessorProjectionColumns;
type Phase7RelationProjection = {
  relation: Phase7ProjectionRelation;
  columns: readonly string[];
};

const phase7ExistingRelationLeastPrivilege = {
  reads: {
    memberships: phase7PredecessorProjectionColumns.memberships,
    dashboard_lifecycle_policies:
      phase7PredecessorProjectionColumns.dashboard_lifecycle_policies,
    dashboards: phase7PredecessorProjectionColumns.dashboards,
    source_snapshots: phase7PredecessorProjectionColumns.source_snapshots,
    evidence_records: phase7PredecessorProjectionColumns.evidence_records,
  },
  lockKeys: {
    memberships: ["organization_id", "membership_id"],
    dashboard_lifecycle_policies: ["organization_id", "policy_revision"],
    dashboards: ["organization_id", "dashboard_id"],
    source_snapshots: ["organization_id", "snapshot_id"],
    evidence_records: ["organization_id", "evidence_id"],
  },
  dashboardsOnlyForAgeOut: ["tombstone_lineage_id"],
  forbiddenReadColumns: {
    memberships: ["created_at", "updated_at"],
    dashboard_lifecycle_policies: [
      "default_disposable_ttl_seconds",
      "retention_policy_revision",
      "created_at",
      "created_by_user_id",
      "provenance",
    ],
    dashboards: [
      "title",
      "created_by_user_id",
      "created_at",
      "created_kind",
      "original_expires_at",
      "capability_epoch",
      "cache_epoch",
      "revocation_reason",
      "purge_after",
      "purge_started_at",
      "retention_policy_revision",
      "promoted_at",
      "archived_at",
      "tombstone_lineage_id",
      "restored_from_tombstone_lineage_id",
    ],
  },
} as const;

function phase7CatalogProjectionColumns(
  relation: Phase7ProjectionRelation,
): readonly string[] {
  if (relation in phase7Task9ProjectionColumns) {
    return phase7Task9ProjectionColumns[
      relation as keyof typeof phase7Task9ProjectionColumns
    ];
  }
  if (
    relation === "memberships" ||
    relation === "dashboard_lifecycle_policies" ||
    relation === "dashboards"
  ) {
    return [
      ...phase7ExistingRelationLeastPrivilege.reads[relation],
      ...phase7ExistingRelationLeastPrivilege.forbiddenReadColumns[relation],
    ];
  }
  return phase7PredecessorProjectionColumns[
    relation as keyof typeof phase7PredecessorProjectionColumns
  ];
}

function phase7Projection(
  relation: Phase7ProjectionRelation,
  columns?: readonly string[],
): Phase7RelationProjection {
  return {
    relation,
    columns:
      columns ??
      (relation in phase7Task9ProjectionColumns
        ? phase7Task9ProjectionColumns[
            relation as keyof typeof phase7Task9ProjectionColumns
          ]
        : phase7PredecessorProjectionColumns[
            relation as keyof typeof phase7PredecessorProjectionColumns
          ]),
  };
}

function phase7MergeExactProjections(
  projections: readonly Phase7RelationProjection[],
): Phase7RelationProjection[] {
  const merged = new Map<Phase7ProjectionRelation, string[]>();
  for (const projection of projections) {
    const columns = merged.get(projection.relation) ?? [];
    for (const column of projection.columns) {
      if (!columns.includes(column)) columns.push(column);
    }
    merged.set(projection.relation, columns);
  }
  return [...merged].map(([relation, columns]) => ({ relation, columns }));
}

const phase7OperatorCommonExactProjection = {
  locks: [
    phase7Projection("run_service_principal_allowlist", [
      "run_service_principal_id",
      "principal_revision",
    ]),
    phase7Projection("agent_run_policy_revisions", ["policy_revision"]),
    phase7Projection(
      "memberships",
      phase7ExistingRelationLeastPrivilege.lockKeys.memberships,
    ),
    phase7Projection(
      "dashboards",
      phase7ExistingRelationLeastPrivilege.lockKeys.dashboards,
    ),
    phase7Projection("agent_runs", ["organization_id", "run_id"]),
  ],
  reads: [
    phase7Projection("run_service_principal_allowlist"),
    phase7Projection("agent_run_policy_revisions"),
    phase7Projection(
      "memberships",
      phase7ExistingRelationLeastPrivilege.reads.memberships,
    ),
    phase7Projection(
      "dashboards",
      phase7ExistingRelationLeastPrivilege.reads.dashboards,
    ),
    phase7Projection("agent_runs"),
  ],
  policies: [
    "run_service_principal_allowlist_bootstrap_select",
    "run_service_principal_allowlist_run_lock_update",
    "agent_run_policy_revisions_run_definer_select",
    "agent_run_policy_revisions_run_lock_update",
    phase7PolicyExpressionTemplates.membershipReauthorizationSelect.name,
    phase7PolicyExpressionTemplates.membershipReauthorizationLock.name,
    "dashboards_run_select",
    "agent_runs_run_definer_select",
  ],
  routines: [
    "dasher_private.initialize_run_operator_context_v1(uuid,text)",
    "dasher_private.reauthorize_agent_run_v1(uuid,bigint,bytea)",
  ],
} as const;

type Phase7ExistingProjectionProof = {
  reads: readonly (
    "memberships" | "dashboard_lifecycle_policies" | "dashboards"
  )[];
  locks: readonly (
    | "memberships_semantic"
    | "memberships_key"
    | "dashboard_lifecycle_policies_semantic"
    | "dashboards_semantic"
    | "dashboards_key"
    | "dashboards_age_out"
  )[];
  dashboardRead: "authority" | "age_out" | null;
};

const phase7PerFunctionExistingProjectionProof = {
  request_agent_run: {
    reads: ["memberships", "dashboard_lifecycle_policies", "dashboards"],
    locks: [
      "memberships_semantic",
      "dashboard_lifecycle_policies_semantic",
      "dashboards_semantic",
    ],
    dashboardRead: "authority",
  },
  cancel_agent_run: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_semantic", "dashboards_semantic"],
    dashboardRead: "authority",
  },
  get_agent_run: {
    reads: ["memberships", "dashboards"],
    locks: [],
    dashboardRead: "authority",
  },
  list_agent_run_events: {
    reads: ["memberships", "dashboards"],
    locks: [],
    dashboardRead: "authority",
  },
  get_agent_run_checkpoint: {
    reads: ["memberships", "dashboards"],
    locks: [],
    dashboardRead: "authority",
  },
  get_agent_candidate: {
    reads: ["memberships", "dashboards"],
    locks: [],
    dashboardRead: "authority",
  },
  claim_agent_run: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  get_claimed_agent_run_input: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  clone_claimed_replay_prerequisites: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  list_claimed_replay_results: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  consume_agent_replay_result: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  write_agent_run_checkpoint: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_agent_brief: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_common_evidence_bundle: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  reserve_agent_run_attempt: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  start_agent_run_attempt: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  authorize_agent_run_attempt_invocation: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  reconcile_agent_run_attempt: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  release_agent_run_attempt: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_calculation_graph: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_agent_validation_findings: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_agent_candidate: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  close_agent_candidate_set: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_candidate_claims: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_candidate_manifest: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  commit_run_abstention: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  finalize_agent_run_ranking: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  finish_agent_run: {
    reads: ["memberships", "dashboards"],
    locks: ["memberships_key", "dashboards_key"],
    dashboardRead: "authority",
  },
  claim_dashboard_cleanup: {
    reads: ["dashboard_lifecycle_policies", "dashboards"],
    locks: ["dashboard_lifecycle_policies_semantic", "dashboards_semantic"],
    dashboardRead: "authority",
  },
  record_dashboard_cleanup_attempt: {
    reads: ["dashboards"],
    locks: ["dashboards_semantic"],
    dashboardRead: "authority",
  },
  drain_dashboard_agent_runs: {
    reads: ["dashboard_lifecycle_policies", "dashboards"],
    locks: ["dashboard_lifecycle_policies_semantic", "dashboards_semantic"],
    dashboardRead: "authority",
  },
  purge_dashboard: {
    reads: ["dashboard_lifecycle_policies", "dashboards"],
    locks: ["dashboard_lifecycle_policies_semantic", "dashboards_semantic"],
    dashboardRead: "authority",
  },
  age_out_dashboard_agent_run_metadata: {
    reads: ["dashboard_lifecycle_policies", "dashboards"],
    locks: ["dashboard_lifecycle_policies_semantic", "dashboards_age_out"],
    dashboardRead: "age_out",
  },
} as const satisfies Record<
  keyof typeof phase7FunctionReturns,
  Phase7ExistingProjectionProof
>;

const phase7FunctionMutationColumns = {
  runEvent: ["run_revision", "current_event_sequence", "current_event_sha256"],
  runLease: [
    "state",
    "run_revision",
    "current_event_sequence",
    "current_event_sha256",
    "lease_epoch",
    "lease_token_sha256",
    "lease_owner_principal_id",
    "lease_owner_principal_revision",
    "lease_expires_at",
  ],
  runTerminal: [
    "state",
    "run_revision",
    "current_event_sequence",
    "current_event_sha256",
    "lease_epoch",
    "lease_token_sha256",
    "lease_owner_principal_id",
    "lease_owner_principal_revision",
    "lease_expires_at",
    "terminal_at",
    "terminal_reason_sha256",
    "terminal_operation_kind",
    "terminal_operation_id",
  ],
  counterAccounting: [
    "reserved_units",
    "used_units",
    "released_units",
    "updated_at",
  ],
  attemptAccounting: [
    "state",
    "result_payload_id",
    "actual_vector",
    "used_vector",
    "released_vector",
    "outstanding_vector",
    "reconciled_at",
    "terminal_reason_sha256",
  ],
} as const;

type Phase7FunctionTier = "tenant" | "operator" | "retention";
type Phase7ExactFunctionProfile = {
  tier: Phase7FunctionTier;
  locks: readonly (Phase7RelationProjection & {
    mode: "FOR UPDATE";
    relationOrder: number;
  })[];
  reads: readonly Phase7RelationProjection[];
  inserts: readonly Phase7RelationProjection[];
  updates: readonly Phase7RelationProjection[];
  deletes: readonly Phase7RelationProjection[];
  dependencies: {
    policies: readonly string[];
    triggers: readonly string[];
    routines: readonly string[];
    types: readonly string[];
  };
  capability: string | null;
  owner: string;
  executeRole: string;
  settings: typeof phase7FunctionSettings;
  returnIdentity: string;
};

function phase7ExactFunctionProfile(
  name: keyof typeof phase7FunctionReturns,
  tier: Phase7FunctionTier,
  configuration: {
    locks: readonly Phase7RelationProjection[];
    reads: readonly Phase7RelationProjection[];
    inserts?: readonly Phase7RelationProjection[];
    updates?: readonly Phase7RelationProjection[];
    deletes?: readonly Phase7RelationProjection[];
    policies: readonly string[];
    triggers?: readonly string[];
    routines: readonly string[];
    types?: readonly string[];
  },
): Phase7ExactFunctionProfile {
  const lockOrder = [
    "dashboard_cleanup_coordination",
    ...phase7GlobalLockOrder
      .filter((relation) => !relation.endsWith(" advisory gate"))
      .map((relation) => relation.replace(/ \(nonlocking\)$/u, "")),
  ];
  return {
    tier,
    locks: configuration.locks
      .map((projection) => ({
        ...projection,
        mode: "FOR UPDATE" as const,
        relationOrder: lockOrder.indexOf(projection.relation),
      }))
      .sort((left, right) => left.relationOrder - right.relationOrder),
    reads: phase7MergeExactProjections(configuration.reads),
    inserts: phase7MergeExactProjections(configuration.inserts ?? []),
    updates: phase7MergeExactProjections(configuration.updates ?? []),
    deletes: phase7MergeExactProjections(configuration.deletes ?? []),
    dependencies: {
      policies: configuration.policies,
      triggers: configuration.triggers ?? [],
      routines: configuration.routines,
      types:
        configuration.types ??
        [
          ...phase7FunctionArguments[name]
            .map(([, type]) => type)
            .filter((type) => type.includes(".")),
          phase7FunctionReturns[name].replace(/^SETOF /u, ""),
        ].filter(
          (type, index, types) =>
            type.includes(".") && types.indexOf(type) === index,
        ),
    },
    capability:
      tier === "operator"
        ? phase7OperatorCapabilities[
            name as keyof typeof phase7OperatorCapabilities
          ]
        : tier === "retention"
          ? name === "claim_dashboard_cleanup" ||
            name === "drain_dashboard_agent_runs"
            ? "claim_cleanup"
            : name === "record_dashboard_cleanup_attempt"
              ? "record_attempt"
              : name === "purge_dashboard" ||
                  name === "age_out_dashboard_agent_run_metadata"
                ? "purge"
                : null
          : null,
    owner: phase7FunctionOwners[tier],
    executeRole:
      tier === "tenant"
        ? "dasher_app"
        : tier === "operator"
          ? "dasher_run_operator"
          : "dasher_retention_operator",
    settings: phase7FunctionSettings,
    returnIdentity: phase7FunctionReturns[name],
  };
}

function phase7OperatorFunctionProfile(
  name: keyof typeof phase7OperatorCapabilities,
  configuration: {
    reads: readonly Phase7RelationProjection[];
    locks?: readonly Phase7RelationProjection[];
    inserts?: readonly Phase7RelationProjection[];
    updates?: readonly Phase7RelationProjection[];
    policies: readonly string[];
    triggers?: readonly string[];
    routines?: readonly string[];
  },
): Phase7ExactFunctionProfile {
  const equalityProof = phase7OperatorCommonProjectionEqualityProof[name];
  if (equalityProof !== "promoted run-definer authority fence") {
    throw new TypeError(`missing exact operator projection proof for ${name}`);
  }
  return phase7ExactFunctionProfile(name, "operator", {
    locks: [
      ...phase7OperatorCommonExactProjection.locks.map((projection) => ({
        relation: projection.relation,
        columns: [...projection.columns],
      })),
      ...(configuration.locks ?? []),
    ],
    reads: [
      ...phase7OperatorCommonExactProjection.reads.map((projection) => ({
        relation: projection.relation,
        columns: [...projection.columns],
      })),
      ...configuration.reads,
    ],
    inserts: configuration.inserts,
    updates: configuration.updates,
    policies: [
      ...phase7OperatorCommonExactProjection.policies,
      ...configuration.policies,
    ],
    triggers: configuration.triggers,
    routines: [
      ...phase7OperatorCommonExactProjection.routines,
      ...(configuration.routines ?? []),
    ],
  });
}

function buildPhase7ExactPerFunctionRegistry() {
  return {
    request_agent_run: phase7ExactFunctionProfile(
      "request_agent_run",
      "tenant",
      {
        locks: [
          phase7Projection("memberships"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("agent_run_policy_revisions"),
          phase7Projection("dashboards"),
          phase7Projection("source_snapshots"),
          phase7Projection("agent_runs"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("briefs"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        reads: [
          phase7Projection("memberships"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("source_snapshots"),
          phase7Projection("agent_run_policy_revisions"),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("briefs"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        inserts: [
          phase7Projection("agent_run_policy_revisions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
          phase7Projection("audit_events"),
        ],
        policies: [
          "memberships_security_definer_select",
          "dashboards_security_definer_select",
          "source_snapshots_security_definer_select",
          "agent_run_policy_revisions_security_definer_select",
          "agent_run_policy_revisions_security_definer_insert",
          "agent_runs_security_definer_select",
          "agent_runs_security_definer_insert",
          "agent_run_request_payloads_security_definer_select",
          "agent_run_request_payloads_security_definer_insert",
          "agent_run_budget_counters_security_definer_insert",
          "agent_run_events_security_definer_insert",
          "agent_run_event_payloads_security_definer_insert",
        ],
        triggers: ["agent_run_immutable_guard", "agent_run_transition_guard"],
        routines: [
          "dasher_private.context_allows(uuid,text)",
          "dasher_private.context_csrf_allows(smallint,bytea)",
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    cancel_agent_run: phase7ExactFunctionProfile("cancel_agent_run", "tenant", {
      locks: [
        phase7Projection("memberships"),
        phase7Projection("dashboards"),
        phase7Projection("agent_runs"),
        phase7Projection("agent_run_budget_counters"),
        phase7Projection("agent_run_attempts"),
      ],
      reads: [
        phase7Projection("memberships"),
        phase7Projection("dashboards"),
        phase7Projection("agent_runs"),
        phase7Projection("agent_runs", [
          "organization_id",
          "dashboard_id",
          "run_id",
          "tenant_cancel_operation_id",
          "tenant_cancel_operation_sha256",
          "tenant_cancel_result_sha256",
          "tenant_cancel_result_run_revision",
          "tenant_cancel_result_event_sequence",
          "tenant_cancel_result_event_sha256",
        ]),
        phase7Projection("agent_run_events", [
          "organization_id",
          "dashboard_id",
          "run_id",
          "event_sequence",
          "event_id",
          "event_kind",
          "occurred_at",
          "prior_event_sequence",
          "prior_event_sha256",
          "event_sha256",
          "claim_operation_kind",
          "claim_request_id",
        ]),
        phase7Projection("agent_run_attempts"),
        phase7Projection("agent_run_budget_counters"),
        phase7Projection("audit_events"),
      ],
      inserts: [
        phase7Projection("agent_run_events"),
        phase7Projection("agent_run_event_payloads"),
        phase7Projection("audit_events"),
      ],
      updates: [
        phase7Projection("agent_runs", [
          ...phase7FunctionMutationColumns.runTerminal,
          "tenant_cancel_operation_id",
          "tenant_cancel_operation_sha256",
          "tenant_cancel_result_sha256",
          "tenant_cancel_result_run_revision",
          "tenant_cancel_result_event_sequence",
          "tenant_cancel_result_event_sha256",
        ]),
        phase7Projection(
          "agent_run_budget_counters",
          phase7FunctionMutationColumns.counterAccounting,
        ),
        phase7Projection(
          "agent_run_attempts",
          phase7FunctionMutationColumns.attemptAccounting,
        ),
      ],
      policies: [
        "agent_runs_security_definer_select:cancel_operation_probe",
        "audit_events_security_definer_cancel_operation_select",
        "agent_runs_security_definer_select",
        "agent_runs_security_definer_update",
        "agent_run_attempts_security_definer_select",
        "agent_run_attempts_security_definer_update",
        "agent_run_budget_counters_security_definer_select",
        "agent_run_budget_counters_security_definer_update",
        "agent_run_events_security_definer_select",
        "agent_run_events_security_definer_insert",
        "agent_run_event_payloads_security_definer_insert",
      ],
      triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
      routines: [
        "dasher_private.context_allows(uuid,text)",
        "dasher_private.context_csrf_allows(smallint,bytea)",
        "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
      ],
    }),
    get_agent_run: phase7ExactFunctionProfile("get_agent_run", "tenant", {
      locks: [],
      reads: [
        phase7Projection("memberships"),
        phase7Projection("dashboards"),
        phase7Projection("agent_runs", [
          "run_id",
          "dashboard_id",
          "state",
          "run_revision",
          "policy_revision",
          "requested_at",
          "terminal_at",
          "current_event_sequence",
          "latest_checkpoint_revision",
          "selected_candidate_id",
        ]),
      ],
      policies: [
        "dashboards_security_definer_select",
        "agent_runs_security_definer_select",
      ],
      routines: ["dasher_private.context_allows(uuid,text)"],
    }),
    list_agent_run_events: phase7ExactFunctionProfile(
      "list_agent_run_events",
      "tenant",
      {
        locks: [],
        reads: [
          phase7Projection("memberships"),
          phase7Projection("dashboards"),
          phase7Projection("agent_runs", [
            "organization_id",
            "dashboard_id",
            "run_id",
            "state",
            "current_event_sequence",
          ]),
          phase7Projection("agent_run_events", [
            "run_id",
            "event_sequence",
            "event_kind",
            "occurred_at",
            "event_sha256",
            "event_payload_id",
          ]),
        ],
        policies: [
          "agent_runs_security_definer_select",
          "agent_run_events_security_definer_select",
        ],
        routines: ["dasher_private.context_allows(uuid,text)"],
      },
    ),
    get_agent_run_checkpoint: phase7ExactFunctionProfile(
      "get_agent_run_checkpoint",
      "tenant",
      {
        locks: [],
        reads: [
          phase7Projection("memberships"),
          phase7Projection("dashboards"),
          phase7Projection("agent_runs", [
            "organization_id",
            "dashboard_id",
            "run_id",
            "state",
            "latest_checkpoint_revision",
          ]),
          phase7Projection("agent_run_checkpoints", [
            "run_id",
            "checkpoint_revision",
            "source_event_sequence",
            "source_event_sha256",
            "state_sha256",
            "checkpoint_sha256",
            "checkpoint_payload_id",
          ]),
          phase7Projection("agent_run_checkpoint_payloads", [
            "checkpoint_payload_id",
            "checkpoint_revision",
            "canonical_bytes",
            "state_sha256",
            "checkpoint_sha256",
          ]),
        ],
        policies: [
          "agent_runs_security_definer_select",
          "agent_run_checkpoints_security_definer_select",
          "agent_run_checkpoint_payloads_security_definer_select",
        ],
        routines: ["dasher_private.context_allows(uuid,text)"],
      },
    ),
    get_agent_candidate: phase7ExactFunctionProfile(
      "get_agent_candidate",
      "tenant",
      {
        locks: [],
        reads: [
          phase7Projection("memberships"),
          phase7Projection("dashboards"),
          phase7Projection("agent_runs", [
            "organization_id",
            "dashboard_id",
            "run_id",
            "state",
          ]),
          phase7Projection("agent_candidates", [
            "candidate_id",
            "candidate_spec_sha256",
            "common_bundle_id",
            "manifest_sha256",
            "rank",
            "selected",
          ]),
          phase7Projection("agent_candidate_payloads", [
            "candidate_id",
            "canonical_bytes",
            "candidate_spec_sha256",
          ]),
          phase7Projection("candidate_evidence_manifests", [
            "candidate_id",
            "manifest_sha256",
            "canonical_bytes",
          ]),
          phase7Projection("candidate_comparison_bundles", [
            "bundle_id",
            "bundle_sha256",
          ]),
        ],
        policies: [
          "agent_runs_security_definer_select",
          "agent_candidates_security_definer_select",
          "agent_candidate_payloads_security_definer_select",
          "candidate_evidence_manifests_security_definer_select",
          "candidate_comparison_bundles_security_definer_select",
        ],
        routines: ["dasher_private.context_allows(uuid,text)"],
      },
    ),
    claim_agent_run: phase7OperatorFunctionProfile("claim_agent_run", {
      locks: [
        phase7Projection("agent_run_attempts"),
        phase7Projection("agent_run_budget_counters"),
      ],
      reads: [
        phase7Projection("agent_runs", [
          "organization_id",
          "dashboard_id",
          "run_id",
          "requesting_user_id",
          "requesting_membership_id",
          "requesting_authority_revision",
          "policy_revision",
          "state",
          "run_revision",
          "current_event_sequence",
          "current_event_sha256",
          "lease_epoch",
          "lease_token_sha256",
          "lease_owner_principal_id",
          "lease_owner_principal_revision",
          "lease_expires_at",
          "terminal_at",
          "terminal_operation_kind",
          "terminal_operation_id",
          "terminal_claim_input_sha256",
          "terminal_operation_sha256",
        ]),
        phase7Projection("agent_run_attempts", [
          "attempt_id",
          "lease_epoch",
          "partition",
          "state",
          "reserved_vector",
          "used_vector",
          "released_vector",
          "outstanding_vector",
          "reconciled_at",
        ]),
        phase7Projection("agent_run_budget_counters", [
          "partition",
          "vector_field",
          "limit_units",
          "reserved_units",
          "used_units",
          "released_units",
          "updated_at",
        ]),
        phase7Projection("agent_run_events", [
          "organization_id",
          "dashboard_id",
          "run_id",
          "event_sequence",
          "event_kind",
          "occurred_at",
          "prior_event_sequence",
          "prior_event_sha256",
          "event_payload_id",
          "event_sha256",
          "claim_operation_kind",
          "claim_request_id",
          "claim_input_sha256",
          "claim_result_sha256",
          "claim_result_run_revision",
          "claim_result_state",
          "claim_result_lease_epoch",
          "claim_result_attempt_token",
          "claim_result_lease_expires_at",
          "claim_result_policy_revision",
          "claim_result_input_sha256",
        ]),
      ],
      inserts: [
        phase7Projection("agent_run_events"),
        phase7Projection("agent_run_event_payloads"),
      ],
      updates: [
        phase7Projection("agent_runs", [
          ...phase7FunctionMutationColumns.runLease,
          "terminal_at",
          "terminal_operation_kind",
          "terminal_operation_id",
          "terminal_claim_input_sha256",
          "terminal_operation_sha256",
        ]),
        phase7Projection(
          "agent_run_attempts",
          phase7FunctionMutationColumns.attemptAccounting,
        ),
        phase7Projection(
          "agent_run_budget_counters",
          phase7FunctionMutationColumns.counterAccounting,
        ),
      ],
      policies: [
        "agent_run_events_run_claim_retry_select",
        "agent_runs_run_discovery_select",
        "agent_run_attempts_run_definer_select",
        "agent_run_attempts_run_definer_update",
        "agent_run_budget_counters_run_definer_select",
        "agent_run_budget_counters_run_definer_update",
        "agent_run_events_run_definer_insert",
        "agent_run_event_payloads_run_definer_insert",
      ],
      triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
      routines: [
        "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
      ],
    }),
    get_claimed_agent_run_input: phase7OperatorFunctionProfile(
      "get_claimed_agent_run_input",
      {
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("source_snapshots"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
        ],
        policies: [
          "agent_run_request_payloads_run_definer_select",
          "source_snapshots_run_select",
          "field_catalog_snapshots_run_definer_select",
          "field_catalog_entries_run_definer_select",
          "metric_contract_versions_run_definer_select",
        ],
        routines: ["dasher_private.replay_source_fence_v1(uuid,uuid)"],
      },
    ),
    clone_claimed_replay_prerequisites: phase7OperatorFunctionProfile(
      "clone_claimed_replay_prerequisites",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("briefs"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("source_snapshots"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("briefs"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        inserts: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("briefs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection("agent_runs", [
            ...phase7FunctionMutationColumns.runEvent,
            "state",
          ]),
        ],
        policies: [
          "agent_run_request_payloads_run_definer_select",
          "candidate_comparison_bundles_run_definer_select",
          "candidate_comparison_bundles_run_definer_insert",
          "candidate_comparison_bundle_evidence_run_definer_select",
          "candidate_comparison_bundle_evidence_run_definer_insert",
          "briefs_run_definer_select",
          "briefs_run_definer_insert",
          "agent_recorded_results_run_definer_select",
          "agent_candidates_run_definer_select",
          "agent_candidate_payloads_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    list_claimed_replay_results: phase7OperatorFunctionProfile(
      "list_claimed_replay_results",
      {
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("briefs"),
          phase7Projection("agent_recorded_results"),
        ],
        policies: [
          "agent_run_request_payloads_run_definer_select",
          "candidate_comparison_bundles_run_definer_select",
          "candidate_comparison_bundle_evidence_run_definer_select",
          "briefs_run_definer_select",
          "agent_recorded_results_run_definer_select",
        ],
        routines: ["dasher_private.replay_source_fence_v1(uuid,uuid)"],
      },
    ),
    consume_agent_replay_result: phase7OperatorFunctionProfile(
      "consume_agent_replay_result",
      {
        locks: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("briefs"),
          phase7Projection("agent_recorded_results"),
        ],
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("briefs"),
          phase7Projection("agent_recorded_results"),
        ],
        inserts: [
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection("agent_runs", [
            ...phase7FunctionMutationColumns.runEvent,
            "state",
            "consumed_replay_sequence",
            "consumed_replay_sha256",
          ]),
        ],
        policies: [
          "agent_recorded_results_run_definer_select",
          "agent_recorded_results_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    write_agent_run_checkpoint: phase7OperatorFunctionProfile(
      "write_agent_run_checkpoint",
      {
        locks: [
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_checkpoints"),
        ],
        reads: [
          phase7Projection("agent_run_events"),
          phase7Projection(
            "agent_run_event_payloads",
            phase7AuthorityContract.checkpointEventPayloadColumns,
          ),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_budget_counters"),
        ],
        inserts: [
          phase7Projection("agent_run_checkpoints"),
          phase7Projection("agent_run_checkpoint_payloads"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection("agent_runs", [
            ...phase7FunctionMutationColumns.runEvent,
            "latest_checkpoint_revision",
          ]),
        ],
        policies: [
          "agent_run_events_run_definer_select",
          "agent_run_event_payloads_run_definer_select",
          "agent_run_checkpoints_run_definer_insert",
          "agent_run_checkpoint_payloads_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_agent_brief: phase7OperatorFunctionProfile("commit_agent_brief", {
      locks: [
        phase7Projection("candidate_comparison_bundles"),
        phase7Projection("agent_run_attempts"),
      ],
      reads: [
        phase7Projection("candidate_comparison_bundles", [
          "organization_id",
          "dashboard_id",
          "run_id",
          "bundle_id",
          "bundle_sha256",
        ]),
        phase7Projection(
          "agent_run_attempts",
          phase7ExactBodyProjections.commit_agent_brief.agent_run_attempts,
        ),
        phase7Projection(
          "agent_run_attempt_payloads",
          phase7ExactBodyProjections.commit_agent_brief
            .agent_run_attempt_payloads,
        ),
        phase7Projection(
          "agent_recorded_results",
          phase7ExactBodyProjections.commit_agent_brief.agent_recorded_results,
        ),
      ],
      inserts: [
        phase7Projection("briefs"),
        phase7Projection("agent_run_events"),
        phase7Projection("agent_run_event_payloads"),
      ],
      updates: [
        phase7Projection("agent_runs", phase7FunctionMutationColumns.runEvent),
      ],
      policies: [
        "candidate_comparison_bundles_run_definer_select",
        "agent_run_attempts_run_definer_select",
        "agent_run_attempt_payloads_run_definer_select",
        "agent_recorded_results_run_definer_select",
        "briefs_run_definer_insert",
        "agent_run_events_run_definer_insert",
        "agent_run_event_payloads_run_definer_insert",
      ],
      triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
      routines: [
        "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
      ],
    }),
    commit_common_evidence_bundle: phase7OperatorFunctionProfile(
      "commit_common_evidence_bundle",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("evidence_records"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
        ],
        reads: [
          phase7Projection(
            "agent_run_request_payloads",
            phase7RequiredProjectionFixtures.commonBundle
              .agent_run_request_payloads,
          ),
          phase7Projection(
            "field_catalog_snapshots",
            phase7RequiredProjectionFixtures.commonBundle
              .field_catalog_snapshots,
          ),
          phase7Projection("field_catalog_entries", [
            ...phase7RequiredProjectionFixtures.commonBundle
              .field_catalog_entriesBeforeHash,
            ...phase7RequiredProjectionFixtures.commonBundle
              .fieldCatalogEntryHash,
          ]),
          phase7Projection("metric_contract_versions", [
            ...phase7RequiredProjectionFixtures.commonBundle
              .metric_contract_versionsBeforeHashes,
            ...phase7RequiredProjectionFixtures.commonBundle
              .metricContractHashesAndAudit,
          ]),
          phase7Projection(
            "source_snapshots",
            phase7RequiredProjectionFixtures.commonBundle.source_snapshots,
          ),
          phase7Projection(
            "evidence_records",
            phase7RequiredProjectionFixtures.commonBundle.evidence_records,
          ),
        ],
        inserts: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
        ],
        policies: [
          "source_snapshots_run_select",
          "evidence_records_run_select",
          "field_catalog_snapshots_run_definer_select",
          "field_catalog_entries_run_definer_select",
          "metric_contract_versions_run_definer_select",
          "agent_run_request_payloads_run_definer_select",
          "candidate_comparison_bundles_run_definer_insert",
          "candidate_comparison_bundle_evidence_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    reserve_agent_run_attempt: phase7OperatorFunctionProfile(
      "reserve_agent_run_attempt",
      {
        locks: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("briefs"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_validation_findings"),
          phase7Projection("claims"),
          phase7Projection("candidate_evidence_manifests"),
        ],
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("briefs"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection(
            "agent_run_attempts",
            phase7RequiredProjectionFixtures.reservation.common
              .agent_run_attempts,
          ),
          phase7Projection(
            "agent_run_attempt_payloads",
            phase7RequiredProjectionFixtures.reservation.common
              .agent_run_attempt_payloads,
          ),
          phase7Projection("agent_recorded_results"),
          phase7Projection(
            "agent_candidates",
            phase7RequiredProjectionFixtures.reservation.reviewer
              .agent_candidates,
          ),
          phase7Projection(
            "agent_candidate_payloads",
            phase7RequiredProjectionFixtures.reservation.reviewer
              .agent_candidate_payloads,
          ),
          phase7Projection(
            "agent_validation_findings",
            phase7RequiredProjectionFixtures.reservation.reviewer
              .agent_validation_findings,
          ),
          phase7Projection(
            "claims",
            phase7RequiredProjectionFixtures.reservation.reviewer.claims,
          ),
          phase7Projection(
            "claim_evidence",
            phase7RequiredProjectionFixtures.reservation.reviewer
              .claim_evidence,
          ),
          phase7Projection("candidate_evidence_manifests"),
        ],
        inserts: [
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_attempt_payloads"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection("agent_runs", [
            ...phase7FunctionMutationColumns.runEvent,
            "state",
          ]),
          phase7Projection("agent_run_budget_counters", [
            "reserved_units",
            "updated_at",
          ]),
        ],
        policies: [
          "agent_run_attempts_run_definer_select",
          "agent_run_attempts_run_definer_insert",
          "agent_run_attempt_payloads_run_definer_select",
          "agent_run_attempt_payloads_run_definer_insert",
          "agent_run_budget_counters_run_definer_select",
          "agent_run_budget_counters_run_definer_update",
          "agent_recorded_results_run_definer_select",
          "agent_candidates_run_definer_select",
          "agent_validation_findings_run_definer_select",
          "claims_run_definer_select",
          "claim_evidence_run_definer_select",
          "candidate_evidence_manifests_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    start_agent_run_attempt: phase7OperatorFunctionProfile(
      "start_agent_run_attempt",
      {
        locks: [phase7Projection("agent_run_attempts")],
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_attempt_payloads"),
        ],
        inserts: [
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
          phase7Projection("agent_run_attempts", [
            "state",
            "dispatch_ready_at",
          ]),
        ],
        policies: [
          "agent_run_attempts_run_definer_select",
          "agent_run_attempts_run_definer_update",
          "agent_run_attempt_payloads_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    authorize_agent_run_attempt_invocation: phase7OperatorFunctionProfile(
      "authorize_agent_run_attempt_invocation",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
        ],
        reads: [
          phase7Projection("source_snapshots"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_attempt_payloads"),
          phase7Projection("agent_recorded_results"),
        ],
        inserts: [
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
          phase7Projection("agent_run_attempts", [
            "state",
            "dispatch_started_at",
          ]),
        ],
        policies: [
          "source_snapshots_run_select",
          "agent_run_attempts_run_definer_select",
          "agent_run_attempts_run_definer_update",
          "agent_run_attempt_payloads_run_definer_select",
          "agent_run_budget_counters_run_definer_select",
          "agent_recorded_results_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    reconcile_agent_run_attempt: phase7OperatorFunctionProfile(
      "reconcile_agent_run_attempt",
      {
        locks: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_candidates"),
        ],
        reads: [
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_attempt_payloads"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
          phase7Projection("agent_validation_findings"),
          phase7Projection("claims"),
        ],
        inserts: [
          phase7Projection("agent_run_attempt_payloads"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
          phase7Projection(
            "agent_run_budget_counters",
            phase7FunctionMutationColumns.counterAccounting,
          ),
          phase7Projection(
            "agent_run_attempts",
            phase7FunctionMutationColumns.attemptAccounting,
          ),
        ],
        policies: [
          "agent_run_attempts_run_definer_select",
          "agent_run_attempts_run_definer_update",
          "agent_run_attempt_payloads_run_definer_select",
          "agent_run_attempt_payloads_run_definer_insert",
          "agent_recorded_results_run_definer_select",
          "agent_recorded_results_run_definer_insert",
          "agent_run_budget_counters_run_definer_select",
          "agent_run_budget_counters_run_definer_update",
          "agent_candidates_run_definer_select",
          "agent_validation_findings_run_definer_select",
          "claims_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    release_agent_run_attempt: phase7OperatorFunctionProfile(
      "release_agent_run_attempt",
      {
        locks: [
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
        ],
        reads: [
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
        ],
        inserts: [
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
          phase7Projection(
            "agent_run_budget_counters",
            phase7FunctionMutationColumns.counterAccounting,
          ),
          phase7Projection(
            "agent_run_attempts",
            phase7FunctionMutationColumns.attemptAccounting,
          ),
        ],
        policies: [
          "agent_run_budget_counters_run_definer_select",
          "agent_run_budget_counters_run_definer_update",
          "agent_run_attempts_run_definer_select",
          "agent_run_attempts_run_definer_update",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_calculation_graph: phase7OperatorFunctionProfile(
      "commit_calculation_graph",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("evidence_records"),
          phase7Projection("field_catalog_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
        ],
        reads: [
          phase7Projection(
            "agent_run_request_payloads",
            phase7RequiredProjectionFixtures.contractValidation.request,
          ),
          phase7Projection(
            "source_snapshots",
            phase7RequiredProjectionFixtures.contractValidation.sourceSnapshot,
          ),
          phase7Projection("evidence_records"),
          phase7Projection(
            "field_catalog_snapshots",
            phase7RequiredProjectionFixtures.contractValidation
              .fieldCatalogSnapshots,
          ),
          phase7Projection("field_catalog_entries"),
          phase7Projection(
            "metric_contract_versions",
            phase7RequiredProjectionFixtures.calculatedClaims
              .metric_contract_versions,
          ),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection(
            "candidate_comparison_bundle_evidence",
            phase7RequiredProjectionFixtures.calculatedClaims.bundleMembership,
          ),
        ],
        inserts: [
          phase7Projection("calculation_graphs"),
          phase7Projection("calculation_results"),
          phase7Projection("agent_run_calculation_meters"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
        ],
        policies: [
          "source_snapshots_run_select",
          "evidence_records_run_select",
          "field_catalog_snapshots_run_definer_select",
          "field_catalog_entries_run_definer_select",
          "metric_contract_versions_run_definer_select",
          "candidate_comparison_bundles_run_definer_select",
          "candidate_comparison_bundle_evidence_run_definer_select",
          "calculation_graphs_run_definer_insert",
          "calculation_results_run_definer_insert",
          "agent_run_calculation_meters_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.validate_metric_contract_graph_v1(bytea,bytea)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_agent_validation_findings: phase7OperatorFunctionProfile(
      "commit_agent_validation_findings",
      {
        locks: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("calculation_results"),
          phase7Projection("agent_candidates"),
        ],
        reads: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("candidate_comparison_bundle_evidence"),
          phase7Projection("calculation_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        inserts: [
          phase7Projection("agent_validation_findings"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
          phase7Projection("agent_candidates", ["validation_state"]),
        ],
        policies: [
          "candidate_comparison_bundles_run_definer_select",
          "candidate_comparison_bundle_evidence_run_definer_select",
          "calculation_results_run_definer_select",
          "agent_candidates_run_definer_select",
          "agent_candidates_run_definer_update",
          "agent_candidate_payloads_run_definer_select",
          "agent_validation_findings_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_agent_candidate: phase7OperatorFunctionProfile(
      "commit_agent_candidate",
      {
        locks: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("briefs"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("calculation_graphs"),
          phase7Projection("calculation_results"),
        ],
        reads: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("briefs"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_attempt_payloads"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("calculation_graphs"),
          phase7Projection("calculation_results"),
        ],
        inserts: [
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
        ],
        policies: [
          "candidate_comparison_bundles_run_definer_select",
          "briefs_run_definer_select",
          "agent_run_attempts_run_definer_select",
          "agent_run_attempt_payloads_run_definer_select",
          "agent_recorded_results_run_definer_select",
          "calculation_graphs_run_definer_select",
          "calculation_results_run_definer_select",
          "agent_candidates_run_definer_insert",
          "agent_candidate_payloads_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    close_agent_candidate_set: phase7OperatorFunctionProfile(
      "close_agent_candidate_set",
      {
        locks: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        reads: [
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        inserts: [
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection("agent_runs", [
            ...phase7FunctionMutationColumns.runEvent,
            "state",
            "candidate_set_sha256",
            "candidate_set_closed_at",
          ]),
        ],
        policies: [
          "candidate_comparison_bundles_run_definer_select",
          "agent_candidates_run_definer_select",
          "agent_candidate_payloads_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_candidate_claims: phase7OperatorFunctionProfile(
      "commit_candidate_claims",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("calculation_graphs"),
          phase7Projection("calculation_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        reads: [
          phase7Projection(
            "agent_run_request_payloads",
            phase7RequiredProjectionFixtures.calculatedClaims.request,
          ),
          phase7Projection(
            "source_snapshots",
            phase7RequiredProjectionFixtures.calculatedClaims.source,
          ),
          phase7Projection(
            "field_catalog_entries",
            phase7RequiredProjectionFixtures.calculatedClaims.catalog,
          ),
          phase7Projection(
            "metric_contract_versions",
            phase7RequiredProjectionFixtures.calculatedClaims
              .metric_contract_versions,
          ),
          phase7Projection(
            "candidate_comparison_bundles",
            phase7RequiredProjectionFixtures.calculatedClaims.bundle,
          ),
          phase7Projection(
            "candidate_comparison_bundle_evidence",
            phase7RequiredProjectionFixtures.calculatedClaims.bundleMembership,
          ),
          phase7Projection("evidence_records"),
          phase7Projection(
            "calculation_graphs",
            phase7RequiredProjectionFixtures.calculatedClaims.graphs,
          ),
          phase7Projection(
            "calculation_results",
            phase7RequiredProjectionFixtures.calculatedClaims.results,
          ),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
        ],
        inserts: [
          phase7Projection("claims"),
          phase7Projection("claim_evidence"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
        ],
        policies: [
          "field_catalog_entries_run_definer_select",
          "metric_contract_versions_run_definer_select",
          "candidate_comparison_bundles_run_definer_select",
          "candidate_comparison_bundle_evidence_run_definer_select",
          "calculation_graphs_run_definer_select",
          "calculation_results_run_definer_select",
          "agent_candidates_run_definer_select",
          "agent_candidate_payloads_run_definer_select",
          "claims_run_definer_insert",
          "claim_evidence_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.validate_calculated_claim_v1(bytea,bytea)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_candidate_manifest: phase7OperatorFunctionProfile(
      "commit_candidate_manifest",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("agent_recorded_results"),
          phase7Projection("calculation_graphs"),
          phase7Projection("calculation_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_validation_findings"),
          phase7Projection("claims"),
          phase7Projection("claim_evidence"),
        ],
        reads: [
          phase7Projection(
            "agent_run_request_payloads",
            phase7RequiredProjectionFixtures.calculatedClaims.request,
          ),
          phase7Projection(
            "source_snapshots",
            phase7RequiredProjectionFixtures.calculatedClaims.source,
          ),
          phase7Projection(
            "field_catalog_entries",
            phase7RequiredProjectionFixtures.calculatedClaims.catalog,
          ),
          phase7Projection(
            "metric_contract_versions",
            phase7RequiredProjectionFixtures.calculatedClaims
              .metric_contract_versions,
          ),
          phase7Projection(
            "candidate_comparison_bundles",
            phase7RequiredProjectionFixtures.calculatedClaims.bundle,
          ),
          phase7Projection(
            "candidate_comparison_bundle_evidence",
            phase7RequiredProjectionFixtures.calculatedClaims.bundleMembership,
          ),
          phase7Projection("evidence_records"),
          phase7Projection("agent_recorded_results"),
          phase7Projection(
            "calculation_graphs",
            phase7RequiredProjectionFixtures.calculatedClaims.graphs,
          ),
          phase7Projection(
            "calculation_results",
            phase7RequiredProjectionFixtures.calculatedClaims.results,
          ),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
          phase7Projection("agent_validation_findings"),
          phase7Projection("claims"),
          phase7Projection("claim_evidence"),
        ],
        inserts: [
          phase7Projection("candidate_evidence_manifests"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runEvent,
          ),
          phase7Projection("agent_candidates", [
            "review_state",
            "manifest_sha256",
          ]),
        ],
        policies: [
          "agent_recorded_results_run_definer_select",
          "calculation_graphs_run_definer_select",
          "calculation_results_run_definer_select",
          "agent_candidates_run_definer_select",
          "agent_candidates_run_definer_update",
          "agent_validation_findings_run_definer_select",
          "claims_run_definer_select",
          "claim_evidence_run_definer_select",
          "candidate_evidence_manifests_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.validate_calculated_claim_v1(bytea,bytea)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    commit_run_abstention: phase7OperatorFunctionProfile(
      "commit_run_abstention",
      {
        locks: [phase7Projection("agent_run_attempts")],
        reads: [
          phase7Projection("agent_run_attempts"),
          phase7Projection("agent_run_attempt_payloads"),
          phase7Projection("agent_recorded_results"),
        ],
        inserts: [
          phase7Projection("run_abstentions"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runTerminal,
          ),
        ],
        policies: [
          "agent_run_attempts_run_definer_select",
          "agent_run_attempt_payloads_run_definer_select",
          "agent_recorded_results_run_definer_select",
          "run_abstentions_run_definer_insert",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    finalize_agent_run_ranking: phase7OperatorFunctionProfile(
      "finalize_agent_run_ranking",
      {
        locks: [
          phase7Projection("source_snapshots"),
          phase7Projection("field_catalog_entries"),
          phase7Projection("metric_contract_versions"),
          phase7Projection("agent_run_request_payloads"),
          phase7Projection("candidate_comparison_bundles"),
          phase7Projection("calculation_graphs"),
          phase7Projection("calculation_results"),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_validation_findings"),
          phase7Projection("claims"),
          phase7Projection("claim_evidence"),
          phase7Projection("candidate_evidence_manifests"),
        ],
        reads: [
          phase7Projection(
            "agent_run_request_payloads",
            phase7RequiredProjectionFixtures.calculatedClaims.request,
          ),
          phase7Projection(
            "source_snapshots",
            phase7RequiredProjectionFixtures.calculatedClaims.source,
          ),
          phase7Projection(
            "field_catalog_entries",
            phase7RequiredProjectionFixtures.calculatedClaims.catalog,
          ),
          phase7Projection(
            "metric_contract_versions",
            phase7RequiredProjectionFixtures.calculatedClaims
              .metric_contract_versions,
          ),
          phase7Projection(
            "candidate_comparison_bundles",
            phase7RequiredProjectionFixtures.calculatedClaims.bundle,
          ),
          phase7Projection(
            "candidate_comparison_bundle_evidence",
            phase7RequiredProjectionFixtures.calculatedClaims.bundleMembership,
          ),
          phase7Projection(
            "calculation_graphs",
            phase7RequiredProjectionFixtures.calculatedClaims.graphs,
          ),
          phase7Projection(
            "calculation_results",
            phase7RequiredProjectionFixtures.calculatedClaims.results,
          ),
          phase7Projection("agent_candidates"),
          phase7Projection("agent_candidate_payloads"),
          phase7Projection("agent_validation_findings"),
          phase7Projection("claims"),
          phase7Projection("claim_evidence"),
          phase7Projection("candidate_evidence_manifests"),
          phase7Projection("agent_recorded_results"),
        ],
        inserts: [
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
        ],
        updates: [
          phase7Projection("agent_runs", [
            ...phase7FunctionMutationColumns.runTerminal,
            "candidate_set_sha256",
            "selected_candidate_id",
          ]),
          phase7Projection("agent_candidates", ["rank", "selected"]),
        ],
        policies: [
          "agent_candidates_run_definer_select",
          "agent_candidates_run_definer_update",
          "agent_validation_findings_run_definer_select",
          "claims_run_definer_select",
          "claim_evidence_run_definer_select",
          "candidate_evidence_manifests_run_definer_select",
          "agent_recorded_results_run_definer_select",
          "agent_run_events_run_definer_insert",
          "agent_run_event_payloads_run_definer_insert",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_private.replay_source_fence_v1(uuid,uuid)",
          "dasher_private.validate_calculated_claim_v1(bytea,bytea)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
        ],
      },
    ),
    finish_agent_run: phase7OperatorFunctionProfile("finish_agent_run", {
      locks: [phase7Projection("agent_run_attempts")],
      reads: [
        phase7Projection("agent_run_attempts"),
        phase7Projection("agent_run_attempt_payloads"),
        phase7Projection("agent_recorded_results"),
      ],
      inserts: [
        phase7Projection("agent_run_events"),
        phase7Projection("agent_run_event_payloads"),
      ],
      updates: [
        phase7Projection(
          "agent_runs",
          phase7FunctionMutationColumns.runTerminal,
        ),
      ],
      policies: [
        "agent_run_attempts_run_definer_select",
        "agent_run_attempt_payloads_run_definer_select",
        "agent_recorded_results_run_definer_select",
        "agent_run_events_run_definer_insert",
        "agent_run_event_payloads_run_definer_insert",
      ],
      triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
      routines: [
        "dasher_private.replay_source_fence_v1(uuid,uuid)",
        "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
      ],
    }),
    claim_dashboard_cleanup: phase7ExactFunctionProfile(
      "claim_dashboard_cleanup",
      "retention",
      {
        locks: [
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("dashboard_legal_holds"),
          phase7Projection(
            "agent_runs",
            phase7RequiredProjectionFixtures.cleanupCompletion.claimVerification
              .agent_runs,
          ),
          phase7Projection(
            "agent_run_events",
            phase7RequiredProjectionFixtures.cleanupCompletion.claimVerification
              .agent_run_events,
          ),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection(
            "dashboard_agent_drain_proofs",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proofs,
          ),
          phase7Projection(
            "dashboard_agent_drain_proof_consumptions",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proof_consumptions,
          ),
        ],
        reads: [
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("dashboard_legal_holds"),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection(
            "dashboard_agent_drain_proofs",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proofs,
          ),
          phase7Projection(
            "dashboard_agent_drain_proof_consumptions",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proof_consumptions,
          ),
          phase7Projection(
            "agent_runs",
            phase7RequiredProjectionFixtures.cleanupCompletion.claimVerification
              .agent_runs,
          ),
          phase7Projection(
            "agent_run_events",
            phase7RequiredProjectionFixtures.cleanupCompletion.claimVerification
              .agent_run_events,
          ),
        ],
        inserts: [
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
          phase7Projection("dashboard_lifecycle_events"),
          phase7Projection("audit_events"),
        ],
        updates: [
          phase7Projection("dashboard_cleanup_coordination", [
            "lease_owner",
            "lease_expires_at",
            "completion_proof_sha256",
          ]),
          phase7Projection("dashboards", [
            "lifecycle_state",
            "lifecycle_revision",
            "capability_epoch",
            "cache_epoch",
          ]),
        ],
        policies: [
          "dashboard_cleanup_coordination_retention_update",
          "dashboard_agent_drain_proofs_retention_definer_select",
          "dashboard_agent_drain_proof_consumptions_retention_definer_select",
          "dashboard_agent_drain_proof_consumptions_retention_definer_insert",
          "agent_runs_retention_definer_select",
          "agent_run_events_retention_definer_select",
        ],
        triggers: ["agent_run_immutable_guard", "agent_run_transition_guard"],
        routines: [
          "dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)",
          "dasher_private.recompute_drain_proof_v1(uuid,uuid)",
          "dasher_private.recompute_drain_consumption_v1(uuid,uuid)",
        ],
      },
    ),
    record_dashboard_cleanup_attempt: phase7ExactFunctionProfile(
      "record_dashboard_cleanup_attempt",
      "retention",
      {
        locks: [
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboards"),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection(
            "dashboard_agent_drain_proofs",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proofs,
          ),
          phase7Projection(
            "dashboard_agent_drain_proof_consumptions",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proof_consumptions,
          ),
        ],
        reads: [
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("dashboards"),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection(
            "dashboard_agent_drain_proofs",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proofs,
          ),
          phase7Projection(
            "dashboard_agent_drain_proof_consumptions",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_agent_drain_proof_consumptions,
          ),
        ],
        inserts: [
          phase7Projection("dashboard_cleanup_attempts"),
          phase7Projection("audit_events"),
        ],
        updates: [
          phase7Projection("dashboard_cleanup_coordination", [
            "lease_owner",
            "lease_expires_at",
            "next_attempt_at",
            "completion_proof_sha256",
          ]),
        ],
        policies: [
          "dashboard_cleanup_coordination_retention_update",
          "dashboard_agent_drain_proofs_retention_definer_select",
          "dashboard_agent_drain_proof_consumptions_retention_definer_select",
        ],
        routines: [
          "dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)",
          "dasher_private.recompute_cleanup_completion_proof_v1(uuid,uuid)",
        ],
      },
    ),
    drain_dashboard_agent_runs: phase7ExactFunctionProfile(
      "drain_dashboard_agent_runs",
      "retention",
      {
        locks: [
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("dashboard_legal_holds"),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("dashboard_cleanup_attempts", [
            "organization_id",
            "dashboard_id",
            "cleanup_attempt_id",
            "step",
            "started_at",
            "finished_at",
            "result",
            "proof_sha256",
          ]),
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
        ],
        reads: [
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("dashboard_legal_holds"),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("dashboard_cleanup_attempts", [
            "organization_id",
            "dashboard_id",
            "cleanup_attempt_id",
            "step",
            "started_at",
            "finished_at",
            "result",
            "proof_sha256",
          ]),
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
        ],
        inserts: [
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_event_payloads"),
          phase7Projection("audit_events"),
        ],
        updates: [
          phase7Projection(
            "agent_runs",
            phase7FunctionMutationColumns.runTerminal,
          ),
          phase7Projection(
            "agent_run_budget_counters",
            phase7FunctionMutationColumns.counterAccounting,
          ),
          phase7Projection(
            "agent_run_attempts",
            phase7FunctionMutationColumns.attemptAccounting,
          ),
        ],
        policies: [
          "agent_runs_retention_definer_select",
          "agent_runs_retention_definer_update",
          "agent_run_events_retention_definer_select",
          "agent_run_events_retention_definer_insert",
          "agent_run_event_payloads_retention_definer_insert",
          "agent_run_budget_counters_retention_definer_select",
          "agent_run_budget_counters_retention_definer_update",
          "agent_run_attempts_retention_definer_select",
          "agent_run_attempts_retention_definer_update",
          "dashboard_agent_drain_proofs_retention_definer_select",
          "dashboard_agent_drain_proofs_retention_definer_insert",
          "dashboard_agent_drain_proof_consumptions_retention_definer_select",
        ],
        triggers: ["agent_run_transition_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)",
          "dasher_private.append_agent_run_event_v1(uuid,uuid,text,bytea)",
          "dasher_private.recompute_drain_event_range_v1(uuid,uuid)",
          "dasher_private.recompute_drain_proof_v1(uuid,uuid)",
        ],
      },
    ),
    purge_dashboard: phase7ExactFunctionProfile(
      "purge_dashboard",
      "retention",
      {
        locks: [
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("dashboard_legal_holds"),
          ...phase7RetentionContract.contentDelete.map((relation) =>
            phase7Projection(relation),
          ),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_checkpoints"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("dashboard_cleanup_attempts"),
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
        ],
        reads: [
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection("dashboards"),
          phase7Projection("dashboard_legal_holds"),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
          ...phase7RetentionContract.contentDelete.map((relation) =>
            phase7Projection(relation),
          ),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_checkpoints"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("pg_constraint"),
        ],
        updates: Object.entries(phase7RetentionContract.clearColumns).map(
          ([relation, columns]) =>
            phase7Projection(
              relation as keyof typeof phase7RetentionContract.clearColumns,
              columns,
            ),
        ),
        deletes: phase7RetentionContract.contentDelete.map((relation) =>
          phase7Projection(relation),
        ),
        policies: [
          ...phase7RetentionContract.contentDelete.map(
            (relation) => `${relation}_retention_definer_delete`,
          ),
          "agent_runs_retention_definer_update",
          "agent_run_events_retention_definer_update",
          "agent_run_checkpoints_retention_definer_update",
          "agent_run_attempts_retention_definer_update",
        ],
        triggers: ["agent_run_retention_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)",
          "dasher_private.recompute_cleanup_completion_proof_v1(uuid,uuid)",
          "dasher_private.verify_phase7_content_purge_fk_dag_v1(uuid,uuid)",
        ],
      },
    ),
    age_out_dashboard_agent_run_metadata: phase7ExactFunctionProfile(
      "age_out_dashboard_agent_run_metadata",
      "retention",
      {
        locks: [
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection(
            "dashboards",
            phase7ExactBodyProjections.age_out_tombstone_lineage.dashboards,
          ),
          phase7Projection("dashboard_legal_holds", [
            "organization_id",
            "dashboard_id",
            "released_at",
          ]),
          phase7Projection(
            "dashboard_tombstones",
            phase7ExactBodyProjections.age_out_tombstone_lineage
              .dashboard_tombstones,
          ),
          phase7Projection(
            "backup_deletion_ledger",
            phase7ExactBodyProjections.age_out_tombstone_lineage
              .backup_deletion_ledger,
          ),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_checkpoints"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
          phase7Projection("dashboard_agent_run_age_out_proofs"),
        ],
        reads: [
          phase7Projection("retention_service_principal_allowlist"),
          phase7Projection("dashboard_cleanup_coordination"),
          phase7Projection("dashboard_lifecycle_policies"),
          phase7Projection(
            "dashboards",
            phase7ExactBodyProjections.age_out_tombstone_lineage.dashboards,
          ),
          phase7Projection("dashboard_legal_holds", [
            "organization_id",
            "dashboard_id",
            "released_at",
          ]),
          phase7Projection(
            "dashboard_tombstones",
            phase7ExactBodyProjections.age_out_tombstone_lineage
              .dashboard_tombstones,
          ),
          phase7Projection(
            "backup_deletion_ledger",
            phase7ExactBodyProjections.age_out_tombstone_lineage
              .backup_deletion_ledger,
          ),
          phase7Projection(
            "dashboard_cleanup_attempts",
            phase7RequiredProjectionFixtures.cleanupCompletion
              .dashboard_cleanup_attempts,
          ),
          phase7Projection("agent_runs"),
          phase7Projection("agent_run_events"),
          phase7Projection("agent_run_checkpoints"),
          phase7Projection("agent_run_budget_counters"),
          phase7Projection("agent_run_attempts"),
          phase7Projection("dashboard_agent_drain_proofs"),
          phase7Projection("dashboard_agent_drain_proof_consumptions"),
          phase7Projection("dashboard_agent_run_age_out_proofs"),
          phase7Projection("pg_constraint"),
        ],
        inserts: [
          phase7Projection("dashboard_agent_run_age_out_proofs"),
          phase7Projection("audit_events"),
        ],
        deletes: phase7RetentionContract.ageOutDelete.map((relation) =>
          phase7Projection(relation),
        ),
        policies: [
          ...phase7RetentionContract.ageOutDelete.map(
            (relation) => `${relation}_retention_definer_delete`,
          ),
          "dashboard_agent_run_age_out_proofs_retention_definer_select",
          "dashboard_agent_run_age_out_proofs_retention_definer_insert",
        ],
        triggers: ["agent_run_retention_guard", "agent_run_immutable_guard"],
        routines: [
          "dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)",
          "dasher_private.recompute_retained_chain_set_v1(uuid,uuid)",
          "dasher_private.recompute_age_out_source_proof_v1(uuid,uuid)",
          "dasher_private.recompute_age_out_proof_v1(uuid,uuid)",
        ],
      },
    ),
  } as const satisfies Record<
    keyof typeof phase7FunctionReturns,
    Phase7ExactFunctionProfile
  >;
}

const phase7ExactBodyProjections = {
  commit_agent_brief: {
    agent_run_attempts: [
      "attempt_id",
      "attempt_kind",
      "state",
      "request_payload_id",
      "result_payload_id",
      "candidate_slot",
      "retry_of_attempt_id",
      "lease_epoch",
      "reconciled_at",
    ],
    agent_run_attempt_payloads: [
      "attempt_id",
      "payload_kind",
      "payload_id",
      "canonical_bytes",
      "payload_sha256",
    ],
    agent_recorded_results: [
      "result_sequence",
      "result_id",
      "attempt_id",
      "result_payload_id",
      "result_kind",
      "canonical_bytes",
      "result_sha256",
      "prior_result_head_sha256",
      "result_head_sha256",
    ],
  },
  commit_common_evidence_bundle: {
    agent_run_request_payloads: [
      "request_payload_id",
      "run_request_id",
      "request_idempotency_sha256",
      "canonical_bytes",
      "request_sha256",
    ],
    source_snapshots: [
      "organization_id",
      "snapshot_id",
      "source_kind",
      "canonical_bytes",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
    evidence_records: [
      "organization_id",
      "evidence_id",
      "snapshot_id",
      "evidence_kind",
      "coordinates",
      "transformation",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
  },
  calculated_freshness: {
    agent_run_request_payloads: ["canonical_bytes", "request_sha256"],
    source_snapshots: ["snapshot_id", "canonical_bytes", "content_sha256"],
    field_catalog_entries: ["field_id", "event_time_field_id", "entry_sha256"],
    calculation_graphs: [
      "graph_id",
      "contract_set_id",
      "contract_id",
      "contract_version",
      "catalog_snapshot_id",
      "freshness_classifier_node_id",
      "freshness_input_node_id",
      "freshness_source_row_id",
      "graph_sha256",
      "canonical_bytes",
    ],
    calculation_results: [
      "result_id",
      "graph_id",
      "result_sha256",
      "meter_sha256",
      "canonical_bytes",
    ],
    candidate_comparison_bundles: [
      "bundle_id",
      "evidence_count",
      "bundle_sha256",
      "canonical_bytes",
    ],
    consumers: [
      "commit_candidate_claims",
      "commit_candidate_manifest",
      "finalize_agent_run_ranking",
    ],
  },
  age_out_tombstone_lineage: {
    dashboards: [
      "organization_id",
      "dashboard_id",
      "lifecycle_revision",
      "tombstone_lineage_id",
      "purged_at",
    ],
    dashboard_tombstones: [
      "organization_id",
      "tombstone_lineage_id",
      "purged_at",
      "purged_lifecycle_revision",
      "purged_proof_sha256",
    ],
    backup_deletion_ledger: [
      "organization_id",
      "ledger_sequence",
      "tombstone_lineage_id",
      "event_kind",
      "proof_sha256",
    ],
  },
} as const;

const phase7RequiredProjectionFixtures = {
  plannerBrief: phase7ExactBodyProjections.commit_agent_brief,
  commonBundle: {
    agent_run_request_payloads: [
      "request_payload_id",
      "run_request_id",
      "request_idempotency_sha256",
      "canonical_bytes",
      "request_sha256",
    ],
    field_catalog_snapshots: [
      "organization_id",
      "dashboard_id",
      "catalog_snapshot_id",
      "input_snapshot_id",
      "input_sha256",
      "input_row_count",
      "evaluated_at",
      "catalog_sha256",
      "canonical_bytes",
    ],
    field_catalog_entriesBeforeHash: [
      "organization_id",
      "dashboard_id",
      "catalog_snapshot_id",
      "field_id",
      "source_path",
      "logical_name",
      "scalar_type",
      "nullable",
      "semantic_type",
      "unit",
      "currency",
      "grain",
      "event_time_field_id",
      "stable_key_ordinal",
      "max_value_bytes",
      "allowed_aggregations",
      "allowed_dimensions",
      "lineage_evidence_ids",
    ],
    fieldCatalogEntryHash: ["entry_sha256"],
    metric_contract_versionsBeforeHashes: [
      "organization_id",
      "dashboard_id",
      "contract_set_id",
      "contract_id",
      "contract_version",
      "catalog_snapshot_id",
      "business_owner_membership_id",
      "data_owner_membership_id",
      "name",
      "definition",
      "measure_field_id",
      "aggregation",
      "denominator_contract_id",
      "denominator_contract_version",
      "value_type",
      "unit",
      "currency",
      "direction",
      "threshold",
      "target",
      "grain",
      "lag_millis",
      "freshness_slo_millis",
      "allowed_dimension_field_ids",
      "calendar",
      "timezone",
      "lineage_evidence_ids",
      "review_state",
    ],
    metricContractHashesAndAudit: [
      "contract_set_sha256",
      "contract_sha256",
      "created_at",
    ],
    source_snapshots:
      phase7ExactBodyProjections.commit_common_evidence_bundle.source_snapshots,
    evidence_records:
      phase7ExactBodyProjections.commit_common_evidence_bundle.evidence_records,
    joinAndLock:
      "only request-named IDs; global lock order; evidence rows are exact lineage union; no organization-wide scan",
  },
  reservation: {
    common: {
      agent_run_attempts: [
        "organization_id",
        "dashboard_id",
        "run_id",
        "attempt_id",
        "lease_epoch",
        "partition",
        "attempt_kind",
        "candidate_slot",
        "retry_of_attempt_id",
        "state",
        "request_payload_id",
        "result_payload_id",
        "reserved_vector",
        "actual_vector",
        "used_vector",
        "released_vector",
        "outstanding_vector",
        "reserved_at",
        "dispatch_ready_at",
        "dispatch_started_at",
        "reconciled_at",
        "terminal_reason_sha256",
      ],
      agent_run_attempt_payloads: [
        "organization_id",
        "dashboard_id",
        "run_id",
        "attempt_id",
        "payload_kind",
        "payload_id",
        "content_nonce",
        "canonical_bytes",
        "payload_sha256",
        "created_at",
      ],
    },
    repair: {
      agent_run_attempts: [
        "invalid generator attempt",
        "optional specialist attempt",
        "every higher-slot release row",
      ],
      agent_run_attempt_payloads: [
        "invalid generator request payload",
        "invalid generator result payload",
        "optional specialist result payload",
      ],
      agent_recorded_results: [
        "invalid result ID/SHA/kind/canonical bytes/head",
        "optional specialist result ID/SHA/kind/canonical bytes/head",
      ],
      semanticBindings: [
        "parsed invalid precommit validation digest",
        "common bundle header and fresh membership",
        "Brief",
        "zero candidate rows and zero candidate-set hash",
        "one deterministic invalid slot-1 generator result",
        "later queued slots already released",
      ],
    },
    reviewer: {
      agent_candidates: [
        "candidate_id",
        "candidate_spec_sha256",
        "material_claim_count",
        "material_claim_set_sha256",
        "validation_state",
        "review_state",
        "manifest_sha256",
      ],
      agent_candidate_payloads: [
        "candidate_id",
        "canonical_bytes",
        "candidate_spec_sha256",
      ],
      agent_validation_findings: [
        "candidate_id",
        "finding_count",
        "validation_state",
        "findings_sha256",
        "canonical_bytes",
      ],
      claims: [
        "candidate_id",
        "claim_id",
        "json_pointer",
        "assertion_sha256",
        "label",
        "evidence_state",
        "calculation_result_id",
        "calculation_output_identity_kind",
        "calculation_output_node_id",
        "calculation_output_sha256",
        "calculation_output_row_id",
        "calculation_output_field_id",
        "calculation_output_value_sha256",
        "claim_set_sha256",
        "claim_sha256",
      ],
      claim_evidence: [
        "candidate_id",
        "claim_id",
        "bundle_id",
        "evidence_id",
        "relation",
      ],
      manifestRows: "requires zero candidate_evidence_manifests rows",
      aggregateHashes: [
        "dasher.candidate-validation-set.v1",
        "dasher.candidate-claim-sets.v1",
      ],
    },
  },
  calculatedClaims: {
    request: ["canonical_bytes", "request_sha256"],
    source: ["snapshot_id", "canonical_bytes", "content_sha256"],
    catalog: ["field_id", "event_time_field_id", "entry_sha256"],
    metric_contract_versions: [
      "organization_id",
      "dashboard_id",
      "contract_set_id",
      "contract_set_sha256",
      "contract_id",
      "contract_version",
      "catalog_snapshot_id",
      "business_owner_membership_id",
      "data_owner_membership_id",
      "name",
      "definition",
      "measure_field_id",
      "aggregation",
      "denominator_contract_id",
      "denominator_contract_version",
      "value_type",
      "unit",
      "currency",
      "direction",
      "threshold",
      "target",
      "grain",
      "lag_millis",
      "freshness_slo_millis",
      "allowed_dimension_field_ids",
      "calendar",
      "timezone",
      "lineage_evidence_ids",
      "review_state",
      "contract_sha256",
      "created_at",
    ],
    graphs: phase7ExactBodyProjections.calculated_freshness.calculation_graphs,
    results:
      phase7ExactBodyProjections.calculated_freshness.calculation_results,
    bundle:
      phase7ExactBodyProjections.calculated_freshness
        .candidate_comparison_bundles,
    bundleMembership: [
      "bundle_id",
      "evidence_id",
      "source_snapshot_id",
      "evidence_sha256",
      "source_sha256",
      "freshness",
      "observed_at",
    ],
    consumers: [
      "commit_candidate_claims",
      "commit_candidate_manifest",
      "finalize_agent_run_ranking",
    ],
    derivation:
      "reparse canonical input/result; same bound contract; exact output/node/row/cell/value hash; recompute event-time maximum and first-ordinal tie row, checked lag+SLO, classifier output, DashboardSpec subtree, lineage support set",
  },
  contractValidation: {
    consumer: "commit_calculation_graph",
    request: ["canonical_bytes", "request_sha256"],
    fieldCatalogSnapshots: [
      "catalog_snapshot_id",
      "input_snapshot_id",
      "input_sha256",
      "input_row_count",
      "catalog_sha256",
      "evaluated_at",
      "canonical_bytes",
    ],
    fieldCatalogEntries: "complete named catalog entry rows",
    metricContractVersions:
      "complete bound contract and denominator member rows",
    sourceSnapshot: [
      "snapshot_id",
      "source_kind",
      "canonical_bytes",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
    bundleAndMembership:
      "locked bundle header plus nonlocking twice-fresh member projection and row-locked source/evidence predecessors",
    graphAndResult:
      "complete canonical graph/result output bytes, FX typed-value body, derived freshness classifier/input/source row, and supplied meter",
    order: phase7MetricContractConformanceMatrix.validationOrder,
  },
  cleanupCompletion: {
    dashboard_cleanup_attempts: [
      "organization_id",
      "dashboard_id",
      "cleanup_attempt_id",
      "step",
      "started_at",
      "finished_at",
      "result",
      "released_claim_count",
      "deleted_resource_count",
      "deferred_claim_count",
      "failure_code",
      "proof_sha256",
    ],
    dashboard_agent_drain_proofs: [
      "organization_id",
      "dashboard_id",
      "proof_id",
      "lifecycle_revision",
      "cleanup_attempt_id",
      "cleanup_lease_owner",
      "cleanup_lease_expires_at",
      "retention_principal_id",
      "retention_principal_revision",
      "pre_drain_run_count",
      "cancelled_run_count",
      "released_attempt_count",
      "charged_attempt_count",
      "remaining_nonterminal_run_count",
      "remaining_claimed_run_count",
      "first_event_run_id",
      "first_event_sequence",
      "first_event_sha256",
      "last_event_run_id",
      "last_event_sequence",
      "last_event_sha256",
      "event_count",
      "event_range_sha256",
      "generated_at",
      "drain_request_proof_sha256",
      "drain_proof_sha256",
    ],
    dashboard_agent_drain_proof_consumptions: [
      "organization_id",
      "dashboard_id",
      "proof_id",
      "lifecycle_revision",
      "drain_proof_sha256",
      "preceding_cleanup_attempt_id",
      "preceding_cleanup_lease_owner",
      "preceding_cleanup_lease_expires_at",
      "new_cleanup_lease_owner",
      "new_cleanup_lease_expires_at",
      "claim_event_and_audit_id",
      "consumed_at",
      "retention_principal_id",
      "retention_principal_revision",
      "consumption_sha256",
    ],
    claimVerification: {
      agent_runs: [
        "organization_id",
        "dashboard_id",
        "run_id",
        "state",
        "lease_owner_principal_id",
        "lease_expires_at",
        "current_event_sequence",
        "current_event_sha256",
      ],
      agent_run_events: [
        "organization_id",
        "dashboard_id",
        "run_id",
        "event_sequence",
        "event_kind",
        "event_sha256",
      ],
    },
    rule: "latest generated but unconsumed drain proof; matching successful/already_complete attempt; proof-bound old lease released; physical zero nonterminal/claimed counts; exact event range; new lease and immutable consumption inserted atomically",
  },
} as const;

const phase7ExactPerFunctionRegistry = buildPhase7ExactPerFunctionRegistry();

describe("Task 9A phase-7 static contract", () => {
  it("freezes every reviewed product/schema/function/retention/calculation plan byte", async () => {
    const plan = await readFile(task9PlanSource, "utf8");
    const lines = plan.split("\n");
    const hashLines = (first: number, last: number): string =>
      createHash("sha256")
        .update(`${lines.slice(first - 1, last).join("\n")}\n`, "utf8")
        .digest("hex");

    expect(hashLines(122, 5295)).toBe(
      phase7NormativePlanSliceHashes.productThroughCalculations,
    );
    expect(hashLines(1501, 2408)).toBe(
      phase7NormativePlanSliceHashes.semanticAndProofEncoding,
    );
    expect(hashLines(2409, 3241)).toBe(
      phase7NormativePlanSliceHashes.fixedFunctionIdentities,
    );
    expect(hashLines(3242, 4079)).toBe(
      phase7NormativePlanSliceHashes.retentionRlsAclAndDml,
    );
    expect(hashLines(4080, 5295)).toBe(
      phase7NormativePlanSliceHashes.deterministicCalculations,
    );
  });

  it("freezes the exact phase-7 migration, role pair, 31 relations, and no-sequence inventory", async () => {
    expect(phase7Migration).toEqual({
      sequence: 7,
      filename: "0007_agent_run_ledger_and_calculations.sql",
      checksum:
        "dfe0ca8eef30b9b5a599657eaf0da6c93a330a90d3fa9b01c75a2f730d8db3d5",
    });
    const phase7Bytes = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(phase7Bytes).digest("hex")).toBe(
      phase7Migration.checksum,
    );
    expect(phase7ManagedRoles).toEqual([
      {
        name: "dasher_run_definer",
        owner: "run-operator functions only",
        comment: "dasher:managed-role:v1:run-definer",
      },
      {
        name: "dasher_run_operator",
        owner: "nothing",
        comment: "dasher:managed-role:v1:run-operator",
      },
    ]);
    expect(phase7ManagedRoleFlags).toEqual({
      login: false,
      inherit: false,
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      connectionLimit: -1,
      password: null,
      validUntil: "infinity",
      settings: [],
      memberships: [],
      defaultPrivileges: [],
    });
    expect(Object.keys(phase7RelationColumns)).toHaveLength(31);
    expect(new Set(Object.keys(phase7RelationColumns)).size).toBe(31);
    expect(Object.values(phase7RelationColumns).join("|")).not.toMatch(
      /\bDEFAULT\b|\bGENERATED\b|\bIDENTITY\b/u,
    );
    expect(phase7AuthorityContract.sequences).toEqual([]);
  });

  it("transcribes every relation matrix cell, key, index, authority, writer, and retention disposition", () => {
    const relationNames = Object.keys(
      phase7RelationColumns,
    ) as (keyof typeof phase7RelationColumns)[];

    expect(phase7RelationMatrixCells.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 31 }, (_, index) => index + 1),
    );
    expect(phase7RelationMatrixCells.map(({ relation }) => relation)).toEqual(
      relationNames,
    );
    expect(Object.keys(phase7RelationKeyCatalog)).toEqual(relationNames);
    expect(Object.keys(phase7RelationExtraIndexNames)).toEqual(relationNames);
    expect(Object.keys(phase7RelationRetentionDisposition)).toEqual(
      relationNames,
    );

    for (const [index, relation] of relationNames.entries()) {
      const matrix = phase7RelationMatrixCells[index]!;
      const keys = phase7RelationKeyCatalog[relation];
      const extraIndexNames = phase7RelationExtraIndexNames[relation];

      expect(matrix.columns).toBe(`\`${phase7RelationColumns[relation]}\``);
      expect(matrix.keysForeignKeysChecks.length).toBeGreaterThan(0);
      expect(matrix.rlsGrants.length).toBeGreaterThan(0);
      expect(matrix.soleWriters.length).toBeGreaterThan(0);
      const authorityCells = [
        ...matrix.rlsGrants.matchAll(/`([ABRT]):([^`]+)`/gu),
      ];
      expect(authorityCells.length).toBeGreaterThan(0);
      for (const [, code, suffixes] of authorityCells) {
        expect(code).toMatch(/^[ABRT]$/u);
        expect(suffixes).toMatch(/(?:^|,)(?:S|I|D|U(?:\([^)]*\))?)(?:,|$)/u);
      }
      expect(keys.primaryKey).toEqual({
        name: `${relation}_pkey`,
        method: "btree",
        columns: keys.primaryKey.columns,
      });
      expect(keys.uniques.map(({ name }) => name)).toEqual(
        keys.uniques.map(
          (_, uniqueIndex) =>
            `${relation}_uq_${String(uniqueIndex + 1).padStart(2, "0")}`,
        ),
      );
      for (const unique of keys.uniques) {
        expect(unique).toMatchObject({
          method: "btree",
          nullTreatment: "NULLS DISTINCT",
        });
      }
      expect(keys.foreignKeys.map(({ name }) => name)).toEqual(
        keys.foreignKeys.map(
          (_, foreignKeyIndex) =>
            `${relation}_fk_${String(foreignKeyIndex + 1).padStart(2, "0")}`,
        ),
      );
      for (const foreignKey of keys.foreignKeys) {
        expect(foreignKey).toMatchObject({
          match: "SIMPLE",
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
          initially: foreignKey.deferrable ? "DEFERRED" : "IMMEDIATE",
        });
      }
      expect(extraIndexNames.length === 0).toBe(matrix.extraIndexes === "none");
      expect(
        extraIndexNames.every((name, extraIndex) =>
          name.endsWith(`_ix_${String(extraIndex + 1).padStart(2, "0")}`),
        ),
      ).toBe(true);
    }

    expect(phase7RelationCatalogRules).toEqual({
      owner: "migration_owner",
      columns: {
        nullableMarker: "N",
        unmarkedNullable: false,
        defaults: null,
        identity: false,
        generated: false,
      },
      foreignKeyDefaults: {
        match: "SIMPLE",
        onUpdate: "RESTRICT",
        onDelete: "RESTRICT",
        deferrable: false,
        initially: "IMMEDIATE",
      },
      uniqueNullTreatment: "NULLS DISTINCT",
      indexes: {
        method: "btree",
        unannotatedDirection: "ASC",
        unannotatedNulls: "LAST",
      },
      names: {
        primaryKey: "<relation>_pkey",
        unique: "<relation>_uq_<two-digit appearance order>",
        foreignKey: "<relation>_fk_<two-digit appearance order>",
        check: "<relation>_check_<two-digit appearance order>",
        extraIndex: "<relation>_ix_<two-digit appearance order>",
      },
      rowLevelSecurity: { enabled: true, forced: true },
      sequences: [],
    });
    expect(
      Object.values(phase7RelationRetentionDisposition).filter(
        (value) => value === "immediate_dashboard_content_purge",
      ),
    ).toHaveLength(21);
    expect(
      Object.values(phase7RelationRetentionDisposition).filter(
        (value) => value === "held_aware_365_day_metadata_age_out",
      ),
    ).toHaveLength(7);
    expect(phase7PolicyExpressionTemplates.checkpointReplay.columns).toEqual(
      phase7AuthorityContract.checkpointEventPayloadColumns,
    );
    expect(phase7PolicyExpressionTemplates.lockOnly.withCheck).toEqual([
      "false",
    ]);
    expect(phase7PolicyExpressionTemplates.tenantCancelRunProbe.lockMode).toBe(
      "nonlocking",
    );
    expect(
      phase7PolicyExpressionTemplates.tenantCancelAuditProbe.columns,
    ).toHaveLength(20);
    expect(
      Object.values(phase7AclAndMutableColumnContract.authorityCodes).map(
        ({ role }) => role,
      ),
    ).toEqual([
      "dasher_security_definer",
      "dasher_run_definer",
      "dasher_retention_definer",
      "dasher_run_definer",
    ]);
    expect(phase7AclAndMutableColumnContract.narrowedSelect).toEqual({
      relation: "agent_run_event_payloads",
      role: "dasher_run_definer",
      policy: "agent_run_event_payloads_run_definer_select",
      columns: phase7AuthorityContract.checkpointEventPayloadColumns,
      expression: phase7PolicyExpressionTemplates.checkpointReplay.using,
    });
    expect(
      phase7AclAndMutableColumnContract.existingRelationSelectColumns
        .source_snapshots,
    ).toEqual(
      phase7ExactBodyProjections.commit_common_evidence_bundle.source_snapshots,
    );
    expect(
      phase7AclAndMutableColumnContract.existingRelationSelectColumns
        .evidence_records,
    ).toEqual(
      phase7ExactBodyProjections.commit_common_evidence_bundle.evidence_records,
    );
    expect(
      phase7AclAndMutableColumnContract.mutableColumns
        .agent_run_eventsRetentionClear,
    ).toEqual(phase7RetentionContract.clearColumns.agent_run_events);
    expect(
      phase7AclAndMutableColumnContract.mutableColumns
        .agent_run_checkpointsRetentionClear,
    ).toEqual(phase7RetentionContract.clearColumns.agent_run_checkpoints);
    expect(
      phase7AclAndMutableColumnContract.mutableColumns.tenantCancelWriteOnce,
    ).toEqual(
      phase7AclAndMutableColumnContract.mutableColumns.agent_runs.slice(-6),
    );
    expect(phase7AclAndMutableColumnContract.forbiddenPrivileges).toEqual([
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "ownership",
      "grant option",
      "role membership",
      "sequence authority",
    ]);
  });

  it("freezes every exact function signature, return identity, owner, and setting", () => {
    const signatures = [
      ...phase7TenantFunctionSignatures,
      ...phase7OperatorFunctionSignatures,
      ...phase7RetentionFunctionSignatures,
    ];
    expect(phase7TenantFunctionSignatures).toHaveLength(6);
    expect(phase7OperatorFunctionSignatures).toHaveLength(22);
    expect(phase7RetentionFunctionSignatures).toHaveLength(5);
    expect(signatures).toHaveLength(33);
    expect(new Set(signatures).size).toBe(33);
    expect(Object.keys(phase7FunctionReturns)).toHaveLength(33);
    expect(
      phase7OperatorFunctionSignatures.find((signature) =>
        signature.startsWith("dasher_run_api.reconcile_agent_run_attempt"),
      ),
    ).toBe(
      "dasher_run_api.reconcile_agent_run_attempt(uuid, bigint, bytea, uuid, text, bytea, bytea, bytea)",
    );
    expect(phase7FunctionOwners).toEqual({
      tenant: "dasher_security_definer",
      operator: "dasher_run_definer",
      retention: "dasher_retention_definer",
      triggerHelpers: "migration_owner",
    });
    expect(phase7FunctionSettings).toEqual({
      securityDefiner: true,
      volatility: "VOLATILE",
      proconfig: ["search_path=pg_catalog"],
      publicExecute: false,
    });
    expect(Object.keys(phase7CompositeTypes)).toHaveLength(23);
  });

  it("freezes semantic arguments and command/projection authority for all 33 functions", () => {
    const signatures = [
      ...phase7TenantFunctionSignatures,
      ...phase7OperatorFunctionSignatures,
      ...phase7RetentionFunctionSignatures,
    ];
    const functionNames = Object.keys(
      phase7FunctionArguments,
    ) as (keyof typeof phase7FunctionArguments)[];

    expect(functionNames).toEqual(Object.keys(phase7FunctionReturns));
    expect([...functionNames].sort()).toEqual(
      Object.keys(phase7ExactPerFunctionRegistry).sort(),
    );
    for (const name of functionNames) {
      const signature = signatures.find((candidate) =>
        candidate.includes(`.${name}(`),
      );
      expect(signature).toBeDefined();
      expect(signature!.slice(signature!.indexOf("(") + 1, -1)).toBe(
        phase7FunctionArguments[name].map(([, type]) => type).join(", "),
      );
      expect(
        phase7FunctionArguments[name].map(([semanticName]) => semanticName),
      ).toEqual(
        name in phase7RetentionArguments
          ? phase7RetentionArguments[
              name as keyof typeof phase7RetentionArguments
            ]
          : phase7FunctionArguments[name].map(([semanticName]) => semanticName),
      );
      const profile = phase7ExactPerFunctionRegistry[name];
      const existingProjectionProof =
        phase7PerFunctionExistingProjectionProof[name];
      expect(profile.returnIdentity).toBe(phase7FunctionReturns[name]);
      expect(profile.settings).toBe(phase7FunctionSettings);
      expect(profile.dependencies.policies.length).toBeGreaterThan(0);
      expect(profile.dependencies.routines.length).toBeGreaterThan(0);
      for (const dependencies of Object.values(profile.dependencies)) {
        expect(new Set(dependencies).size).toBe(dependencies.length);
        expect(
          dependencies.every(
            (dependency) =>
              dependency.length > 0 &&
              !/\b(existing|governed set|run set only|full set|full relation arrays|shared superset|existing authority columns|grouped role tier)\b/iu.test(
                dependency,
              ),
          ),
        ).toBe(true);
      }
      for (const command of [
        profile.locks,
        profile.reads,
        profile.inserts,
        profile.updates,
        profile.deletes,
      ]) {
        expect(new Set(command.map(({ relation }) => relation)).size).toBe(
          command.length,
        );
        for (const projection of command) {
          expect(projection.relation).toMatch(/^[a-z_]+$/u);
          expect(projection.columns.length).toBeGreaterThan(0);
          expect(new Set(projection.columns).size).toBe(
            projection.columns.length,
          );
          expect(
            projection.columns.filter(
              (column) =>
                !phase7CatalogProjectionColumns(projection.relation).includes(
                  column,
                ),
            ),
          ).toEqual([]);
        }
      }

      for (const projection of profile.reads) {
        if (projection.relation === "memberships") {
          expect(projection.columns).toEqual(
            phase7ExistingRelationLeastPrivilege.reads.memberships,
          );
        } else if (projection.relation === "dashboard_lifecycle_policies") {
          expect(projection.columns).toEqual(
            phase7ExistingRelationLeastPrivilege.reads
              .dashboard_lifecycle_policies,
          );
        } else if (projection.relation === "dashboards") {
          expect(existingProjectionProof.dashboardRead).not.toBeNull();
          expect(projection.columns).toEqual(
            existingProjectionProof.dashboardRead === "age_out"
              ? phase7ExactBodyProjections.age_out_tombstone_lineage.dashboards
              : phase7ExistingRelationLeastPrivilege.reads.dashboards,
          );
        }
      }
      expect(
        profile.reads
          .filter(({ relation }) =>
            (
              [
                "memberships",
                "dashboard_lifecycle_policies",
                "dashboards",
              ] as const
            ).includes(relation as never),
          )
          .map(({ relation }) => relation)
          .sort(),
      ).toEqual([...existingProjectionProof.reads].sort());
      const expectedExistingLocks = existingProjectionProof.locks
        .map((lock) => {
          if (lock === "memberships_semantic") {
            return {
              relation: "memberships",
              columns: phase7ExistingRelationLeastPrivilege.reads.memberships,
            };
          }
          if (lock === "memberships_key") {
            return {
              relation: "memberships",
              columns:
                phase7ExistingRelationLeastPrivilege.lockKeys.memberships,
            };
          }
          if (lock === "dashboard_lifecycle_policies_semantic") {
            return {
              relation: "dashboard_lifecycle_policies",
              columns:
                phase7ExistingRelationLeastPrivilege.reads
                  .dashboard_lifecycle_policies,
            };
          }
          if (lock === "dashboards_key") {
            return {
              relation: "dashboards",
              columns: phase7ExistingRelationLeastPrivilege.lockKeys.dashboards,
            };
          }
          return {
            relation: "dashboards",
            columns:
              lock === "dashboards_age_out"
                ? phase7ExactBodyProjections.age_out_tombstone_lineage
                    .dashboards
                : phase7ExistingRelationLeastPrivilege.reads.dashboards,
          };
        })
        .sort((left, right) => left.relation.localeCompare(right.relation));
      expect(
        profile.locks
          .filter(({ relation }) =>
            (
              [
                "memberships",
                "dashboard_lifecycle_policies",
                "dashboards",
              ] as const
            ).includes(relation as never),
          )
          .map(({ relation, columns }) => ({ relation, columns }))
          .sort((left, right) => left.relation.localeCompare(right.relation)),
      ).toEqual(expectedExistingLocks);
      for (const projection of [...profile.locks, ...profile.reads]) {
        if (
          projection.relation === "memberships" ||
          projection.relation === "dashboard_lifecycle_policies" ||
          projection.relation === "dashboards"
        ) {
          const forbidden =
            phase7ExistingRelationLeastPrivilege.forbiddenReadColumns[
              projection.relation
            ];
          expect(
            projection.columns.filter(
              (column) =>
                forbidden.includes(column as never) &&
                !(
                  name === "age_out_dashboard_agent_run_metadata" &&
                  column === "tombstone_lineage_id"
                ),
            ),
          ).toEqual([]);
        }
      }
    }

    expect(phase7PredecessorProjectionColumns.memberships).toEqual([
      "organization_id",
      "membership_id",
      "user_id",
      "role",
      "state",
      "authority_revision",
      "revoked_at",
    ]);
    expect(
      phase7ExactPerFunctionRegistry.age_out_dashboard_agent_run_metadata.reads
        .filter(({ relation }) => relation === "dashboards")
        .flatMap(({ columns }) => columns)
        .filter((column) => column === "tombstone_lineage_id"),
    ).toEqual(["tombstone_lineage_id"]);
    expect(
      Object.entries(phase7ExactPerFunctionRegistry)
        .filter(([name]) => name !== "age_out_dashboard_agent_run_metadata")
        .flatMap(([, profile]) => [...profile.locks, ...profile.reads])
        .filter(({ relation }) => relation === "dashboards")
        .flatMap(({ columns }) => columns)
        .filter((column) => column === "tombstone_lineage_id"),
    ).toEqual([]);
    const readOrLockConsumers = (
      relation: Phase7ProjectionRelation,
    ): string[] =>
      Object.entries(phase7ExactPerFunctionRegistry)
        .filter(([, profile]) =>
          [...profile.locks, ...profile.reads].some(
            (projection) => projection.relation === relation,
          ),
        )
        .map(([name]) => name);
    expect(readOrLockConsumers("dashboard_tombstones")).toEqual([
      "age_out_dashboard_agent_run_metadata",
    ]);
    expect(readOrLockConsumers("backup_deletion_ledger")).toEqual([
      "age_out_dashboard_agent_run_metadata",
    ]);
    expect(readOrLockConsumers("pg_constraint")).toEqual([
      "purge_dashboard",
      "age_out_dashboard_agent_run_metadata",
    ]);
    expect(
      Object.entries(phase7ExactPerFunctionRegistry)
        .filter(([, profile]) => profile.tier === "operator")
        .map(([name, profile]) => ({
          name,
          proof:
            phase7OperatorCommonProjectionEqualityProof[
              name as keyof typeof phase7OperatorCapabilities
            ],
          reads: phase7OperatorCommonExactProjection.reads.map(
            ({ relation, columns }) => ({
              relation,
              columns: profile.reads.find(
                (projection) => projection.relation === relation,
              )?.columns,
              exactColumns: columns,
            }),
          ),
          locks: phase7OperatorCommonExactProjection.locks.map(
            ({ relation, columns }) => ({
              relation,
              columns: profile.locks.find(
                (projection) => projection.relation === relation,
              )?.columns,
              exactColumns: columns,
            }),
          ),
        }))
        .every(
          ({ proof, reads, locks }) =>
            proof === "promoted run-definer authority fence" &&
            [...reads, ...locks].every(
              ({ columns, exactColumns }) =>
                JSON.stringify(columns) === JSON.stringify(exactColumns),
            ),
        ),
    ).toBe(true);
    const exactMembershipPolicies = [
      phase7PolicyExpressionTemplates.membershipReauthorizationSelect,
      phase7PolicyExpressionTemplates.membershipReauthorizationLock,
    ] as const;
    expect(exactMembershipPolicies).toEqual([
      {
        name: "memberships_run_reauthorization_select",
        relation: "memberships",
        command: "SELECT",
        roles: ["dasher_run_definer"],
        using: [
          "current_user = 'dasher_run_definer'",
          "phase IN ('locking','authorized','checkpoint_replay')",
          "exact proven transaction-local principal revision",
          "exact transaction-local organization, dashboard, run, requesting membership, requesting user, and requesting authority revision",
        ],
        withCheck: null,
      },
      {
        name: "memberships_run_reauthorization_lock",
        relation: "memberships",
        command: "UPDATE",
        roles: ["dasher_run_definer"],
        using: [
          "current_user = 'dasher_run_definer'",
          "phase = 'locking'",
          "exact proven transaction-local principal revision",
          "exact transaction-local organization, dashboard, run, requesting membership, requesting user, and requesting authority revision",
        ],
        withCheck: ["false"],
      },
    ]);
    const exactMembershipPolicyNames = exactMembershipPolicies.map(
      ({ name }) => name,
    );
    const commonPolicyNames = new Set(
      phase7OperatorCommonExactProjection.policies,
    );
    const commonRoutineNames = new Set(
      phase7OperatorCommonExactProjection.routines,
    );
    const operatorProfiles = Object.entries(
      phase7ExactPerFunctionRegistry,
    ).filter(([, profile]) => profile.tier === "operator");
    expect(operatorProfiles).toHaveLength(22);
    for (const [name, profile] of operatorProfiles) {
      expect(
        profile.dependencies.policies.filter((policy) =>
          policy.startsWith("memberships_"),
        ),
        `${name} membership policy dependencies`,
      ).toEqual(exactMembershipPolicyNames);
      expect(
        profile.dependencies.routines.filter((routine) =>
          routine.includes("reauthorize_agent_run_v1"),
        ),
        `${name} membership routine dependencies`,
      ).toEqual(["dasher_private.reauthorize_agent_run_v1(uuid,bigint,bytea)"]);
      expect(
        profile.dependencies.policies.filter((policy) =>
          commonPolicyNames.has(policy as never),
        ),
        `${name} exact common policies`,
      ).toEqual(phase7OperatorCommonExactProjection.policies);
      expect(
        profile.dependencies.routines.filter((routine) =>
          commonRoutineNames.has(routine as never),
        ),
        `${name} exact common routines`,
      ).toEqual(phase7OperatorCommonExactProjection.routines);
      expect(
        profile.reads.filter(({ relation }) => relation === "memberships"),
        `${name} membership semantic projection`,
      ).toEqual([
        {
          relation: "memberships",
          columns: phase7ExistingRelationLeastPrivilege.reads.memberships,
        },
      ]);
      expect(
        profile.locks
          .filter(({ relation }) => relation === "memberships")
          .map(({ relation, columns }) => ({ relation, columns })),
        `${name} membership lock projection`,
      ).toEqual([
        {
          relation: "memberships",
          columns: phase7ExistingRelationLeastPrivilege.lockKeys.memberships,
        },
      ]);
    }

    expect(phase7FunctionArguments.reconcile_agent_run_attempt).toEqual([
      ["run_id", "uuid"],
      ["lease_epoch", "bigint"],
      ["attempt_token", "bytea"],
      ["attempt_id", "uuid"],
      ["outcome", "text"],
      ["actual_accounting_bytes", "bytea"],
      ["result_sha256", "bytea"],
      ["canonical_recorded_result_bytes", "bytea"],
    ]);
    expect(Object.keys(phase7OperatorCapabilities)).toEqual(
      functionNames.slice(6, 28),
    );
    expect(
      Object.values(phase7ExactPerFunctionRegistry).filter(
        (profile) => profile.tier === "tenant",
      ),
    ).toHaveLength(6);
    expect(
      Object.values(phase7ExactPerFunctionRegistry).filter(
        (profile) => profile.tier === "operator",
      ),
    ).toHaveLength(22);
    expect(
      Object.values(phase7ExactPerFunctionRegistry).filter(
        (profile) => profile.tier === "retention",
      ),
    ).toHaveLength(5);
    expect(
      phase7ExactPerFunctionRegistry.commit_agent_brief.reads.find(
        ({ relation }) => relation === "agent_run_attempts",
      )?.columns,
    ).toEqual(phase7ExactBodyProjections.commit_agent_brief.agent_run_attempts);
    expect(
      phase7ExactPerFunctionRegistry.commit_candidate_claims.reads.find(
        ({ relation }) => relation === "calculation_graphs",
      )?.columns,
    ).toEqual(phase7RequiredProjectionFixtures.calculatedClaims.graphs);
    expect(
      phase7ExactPerFunctionRegistry.age_out_dashboard_agent_run_metadata.reads.find(
        ({ relation }) => relation === "dashboards",
      )?.columns,
    ).toEqual(phase7ExactBodyProjections.age_out_tombstone_lineage.dashboards);
    expect(
      phase7ExactPerFunctionRegistry.purge_dashboard.updates.flatMap(
        ({ columns }) => columns,
      ),
    ).toHaveLength(18);
    expect(
      phase7ExactPerFunctionRegistry.age_out_dashboard_agent_run_metadata
        .deletes,
    ).toHaveLength(7);
    expect(phase7AuthorityContract.runCapabilities).toEqual(
      [...new Set(Object.values(phase7OperatorCapabilities))].sort(),
    );
    expect(phase7FunctionPolicyAndTriggerDependencies.operator).toMatchObject({
      owner: "dasher_run_definer",
      executeRole: "dasher_run_operator",
      triggers: phase7AuthorityContract.triggers,
    });
    expect(phase7FunctionPolicyAndTriggerDependencies.tenant).toMatchObject({
      owner: "dasher_security_definer",
      executeRole: "dasher_app",
    });
    expect(phase7FunctionPolicyAndTriggerDependencies.retention).toMatchObject({
      owner: "dasher_retention_definer",
      executeRole: "dasher_retention_operator",
    });
    expect(phase7RequiredProjectionFixtures.plannerBrief).toEqual(
      phase7ExactBodyProjections.commit_agent_brief,
    );
    expect(
      phase7RequiredProjectionFixtures.commonBundle
        .metric_contract_versionsBeforeHashes,
    ).toHaveLength(28);
    expect(
      phase7RequiredProjectionFixtures.reservation.common.agent_run_attempts,
    ).toEqual(
      phase7RelationColumns.agent_run_attempts
        .split(", ")
        .map((column) => column.split(" ")[0]),
    );
    expect(
      phase7RequiredProjectionFixtures.reservation.repair.semanticBindings,
    ).toHaveLength(6);
    expect(
      phase7RequiredProjectionFixtures.reservation.reviewer.claims,
    ).toHaveLength(15);
    expect(
      phase7RequiredProjectionFixtures.calculatedClaims
        .metric_contract_versions,
    ).toHaveLength(31);
    expect(phase7RequiredProjectionFixtures.contractValidation.order).toEqual(
      phase7MetricContractConformanceMatrix.validationOrder,
    );
    expect(
      phase7RequiredProjectionFixtures.cleanupCompletion
        .dashboard_agent_drain_proofs,
    ).toHaveLength(26);
  });

  it("freezes the lifecycle grammar, transition/event registry, and exhaustive lock order", () => {
    expect(phase7RunLifecycle.terminal).toEqual([
      "rejected",
      "cancelled",
      "expired",
      "failed",
    ]);
    expect(phase7RunLifecycle.reservedNoEntry).toBe("accepted");
    expect(phase7RunLifecycle.resultCount).toEqual([3, 5]);
    expect(phase7TransitionEventMatrix).toHaveLength(26);
    expect(phase7GlobalLockOrder[0]).toBe("principal-binding advisory gate");
    expect(phase7GlobalLockOrder.at(-1)).toBe(
      "dashboard_agent_run_age_out_proofs",
    );
    expect(phase7GlobalLockOrder.indexOf("dashboards")).toBeLessThan(
      phase7GlobalLockOrder.indexOf("agent_runs"),
    );
    expect(
      phase7GlobalLockOrder.indexOf("candidate_comparison_bundles"),
    ).toBeLessThan(
      phase7GlobalLockOrder.indexOf(
        "candidate_comparison_bundle_evidence (nonlocking)",
      ),
    );
    for (const [name, profile] of Object.entries(
      phase7ExactPerFunctionRegistry,
    )) {
      expect(
        profile.locks.every((lock) => lock.relationOrder >= 0),
        `${name}: ${profile.locks
          .filter((lock) => lock.relationOrder < 0)
          .map((lock) => lock.relation)
          .join(", ")}`,
      ).toBe(true);
      expect(profile.locks.map((lock) => lock.relationOrder)).toEqual(
        [...profile.locks.map((lock) => lock.relationOrder)].sort(
          (left, right) => left - right,
        ),
      );
      expect(new Set(profile.locks.map((lock) => lock.relation)).size).toBe(
        profile.locks.length,
      );
    }
  });

  it("freezes the accounting grammar, byte vectors, cap, parser allowlist, and precedence", () => {
    const digest = (bytes: string): string =>
      createHash("sha256").update(bytes, "utf8").digest("hex");
    for (const endpoint of [
      phase7AccountingByteVectors.signedMinimum,
      phase7AccountingByteVectors.signedMaximum,
    ]) {
      const bytes = phase7ActualAccountingTemplate.replaceAll(
        "<i64:D>",
        endpoint.replacement,
      );
      expect(Buffer.byteLength(bytes)).toBe(endpoint.bytes);
      expect(digest(bytes)).toBe(endpoint.sha256);
    }
    const plannerBytes = phase7AccountingByteVectors.planner.values.reduce(
      (bytes, value) => bytes.replace("<i64:D>", `i64:${value}`),
      phase7ActualAccountingTemplate,
    );
    expect(Buffer.byteLength(plannerBytes)).toBe(
      phase7AccountingByteVectors.planner.bytes,
    );
    expect(digest(plannerBytes)).toBe(
      phase7AccountingByteVectors.planner.sha256,
    );
    expect(phase7AccountingByteVectors.transportCapInclusive).toBe(1024);
    expect(phase7AccountingByteVectors.parserSqlstates).toEqual([
      "22021",
      "22P02",
      "22003",
    ]);
    expect(phase7AttemptContract.indeterminateReasons).toEqual([
      "caller_indeterminate",
      "malformed_accounting",
      "actual_over_reservation",
      "takeover_after_dispatch",
    ]);
    expect(phase7AttemptContract.precedence).toEqual([
      "caller_indeterminate",
      "malformed_accounting",
      "actual_over_reservation",
      "normal_determinate",
      "takeover_after_dispatch",
    ]);
    expect(phase7AttemptContract.reasonlessCancellationEvent).toBe(
      "attempt_cancelled_charged",
    );
  });

  it("freezes immutable budget vectors, partitions, attempts, and signed-64 conservation", () => {
    expect(phase7AttemptResourceVectorFields).toHaveLength(14);
    expect(phase7BudgetContract.generation).toHaveLength(14);
    expect(phase7BudgetContract.review).toHaveLength(14);
    expect(
      phase7BudgetContract.generation.map(
        (value, index) => value + phase7BudgetContract.review[index]!,
      ),
    ).toEqual([
      5, 2, 1, 1, 1, 25_000, 10_000, 10_000, 25_000, 10_000, 30_000, 45_000,
      40_000, 150_000,
    ]);
    expect(phase7AttemptContract.kinds).toEqual([
      "planner",
      "generator",
      "specialist",
      "repair",
      "reviewer",
    ]);
    expect(phase7AttemptContract.states).toHaveLength(11);
    expect(phase7AttemptContract.conservation).toContain(
      "reserved = used + released + outstanding",
    );
    expect(phase7AttemptContract.indeterminateCandidateException).toContain(
      "candidates: used=0",
    );
  });

  it("freezes every reservation, settlement, retry, slot, invocation, takeover, cancellation, drain, and replay vector", () => {
    expect(Object.keys(phase7AttemptReservationVectors)).toEqual(
      phase7AttemptContract.kinds,
    );
    expect(phase7AttemptReservationVectors.planner.values).toEqual([
      1, 0, 0, 0, 0, 4_000, 2_000, 2_000, 4_000, 2_000, 6_000, 9_000, 8_000,
      16_000,
    ]);
    expect(phase7AttemptReservationVectors.generator.values).toEqual([
      1, 1, 0, 0, 0, 6_000, 3_000, 3_000, 6_000, 3_000, 9_000, 9_000, 8_000,
      24_000,
    ]);
    expect(phase7AttemptReservationVectors.specialist.values).toEqual([
      1, 0, 1, 0, 0, 4_000, 1_000, 1_000, 4_000, 1_000, 5_000, 9_000, 8_000,
      12_000,
    ]);
    expect(phase7AttemptReservationVectors.repair.values).toEqual([
      1, 1, 0, 0, 1, 6_000, 2_000, 2_000, 6_000, 2_000, 8_000, 9_000, 8_000,
      20_000,
    ]);
    expect(phase7AttemptReservationVectors.reviewer.values).toEqual([
      1, 0, 0, 1, 0, 4_000, 2_000, 2_000, 4_000, 2_000, 6_000, 9_000, 8_000,
      16_000,
    ]);
    for (const kind of phase7AttemptContract.kinds) {
      const reservation = phase7AttemptReservationVectors[kind];
      const partitionLimit = phase7BudgetContract[reservation.partition];
      expect(reservation.partition).toBe(
        phase7AttemptContract.partitions[kind],
      );
      expect(reservation.values).toHaveLength(
        phase7AttemptResourceVectorFields.length,
      );
      expect(
        reservation.values.every(
          (value, index) => value <= partitionLimit[index]!,
        ),
      ).toBe(true);
    }
    expect(phase7DeterminateAccountingEqualities.common).toHaveLength(9);
    expect(phase7DeterminateAccountingEqualities.candidateMatrix).toHaveLength(
      16,
    );
    expect(
      Object.keys(phase7DeterminateAccountingEqualities.categoricalByKind),
    ).toEqual(phase7AttemptContract.kinds);
    expect(phase7IndeterminateSettlementVector).toEqual({
      actualVector: null,
      resultPayload: null,
      recordedResult: null,
      outstanding: "zero for every field",
      candidates: "used=0; released=reserved",
      everyOtherField: "used=reserved; released=0",
      conservation: "reserved=used+released+outstanding",
    });
    expect(phase7RetryMatrix).toHaveLength(9);
    expect(
      phase7RetryMatrix
        .slice(0, 5)
        .map((row) => ("kind" in row ? row.kind : null)),
    ).toEqual(phase7AttemptContract.kinds);
    expect(phase7GeneratorSlotMatrix).toHaveLength(10);
    expect(phase7InvocationVectors).toHaveLength(6);
    expect(phase7InvocationVectors.at(-1)).toEqual([
      "replay purpose",
      "reserve/start/authorize/reconcile/release",
      "deny",
      "no event",
      "zero attempts/calls/tokens/time/cost",
    ]);
    expect(
      phase7TakeoverCancellationDrainVectors.map(({ operation }) => operation),
    ).toEqual([
      "takeover-all-pre-invocation",
      "takeover-mixed",
      "tenant-cancel",
      "retention-drain",
      "same-operation-retry",
    ]);
    expect(phase7ReplayGrammarVectors.baseSequences).toHaveLength(6);
    expect(phase7ReplayGrammarVectors.retryInsertion).toEqual({
      kinds: ["planner", "generator"],
      insertedKind: "failure",
      adjacency: "immediately before the same kind's ordinary grammar result",
      maximum: 1,
      totalResultCount: [3, 5],
    });
    expect(phase7ReplayGrammarVectors.rejects).toHaveLength(11);
  });

  it("freezes retention proof domains, arguments, clears, ACL lists, purge DAG, and audit vocabulary", () => {
    expect(
      Object.values(phase7RetentionContract.clearColumns).flat(),
    ).toHaveLength(18);
    expect(phase7RetentionContract.contentDelete).toHaveLength(21);
    expect(phase7RetentionContract.ageOutDelete).toHaveLength(7);
    expect(phase7RetentionContract.purgeDag).toHaveLength(9);
    expect(phase7RetentionContract.ageOutDag).toEqual([
      "agent_run_attempts",
      "agent_run_checkpoints",
      "agent_run_budget_counters",
      "agent_run_events",
      "dashboard_agent_drain_proof_consumptions",
      "dashboard_agent_drain_proofs",
      "agent_runs",
    ]);
    expect(Object.values(phase7ProofDomains)).toEqual([
      "dasher.agent-run-drain-event-range.v1\0",
      "dasher.agent-run-drain-request.v1\0",
      "dasher.agent-run-drain-proof.v1\0",
      "dasher.agent-run-drain-consumption.v1\0",
      "dasher.dashboard-cleanup-completion.v1\0",
      "dasher.agent-run-age-out-source.v1\0",
      "dasher.agent-run-age-out-proof.v1\0",
    ]);
    expect(
      Object.values(phase7RetentionArguments).map((args) => args.length),
    ).toEqual([7, 9, 6, 6, 6]);
    expect(phase7AuditActions).toHaveLength(32);
    expect(phase7AuditActions.slice(-4)).toEqual([
      "dashboard.agent_run_requested",
      "dashboard.agent_run_cancelled",
      "dashboard.agent_runs_drained",
      "dashboard.agent_run_metadata_aged_out",
    ]);
    expect(phase7RetentionContract.retainedChainDomain).toBe(
      "dasher.agent-run-retained-chain-set.v1\0",
    );
  });

  it("freezes every canonical-binary-v1 retention proof and retained-chain byte vector", () => {
    const hash = (bytes: Buffer): string =>
      createHash("sha256").update(bytes).digest("hex");
    const materialize = (fixture: {
      domain: string;
      fields: readonly Phase7ProofFieldFixture[];
    }): Buffer =>
      Buffer.concat([
        Buffer.from(fixture.domain, "ascii"),
        ...fixture.fields.map((field) => Buffer.from(field[3], "hex")),
      ]);

    expect(Object.keys(phase7RetentionProofByteVectors)).toEqual([
      "eventRange",
      "drainRequest",
      "drainProof",
      "drainConsumption",
      "cleanupCompletion",
      "ageOutSource",
      "ageOutProof",
    ]);
    for (const fixture of Object.values(phase7RetentionProofByteVectors)) {
      const preimage = materialize(fixture);
      expect(preimage.toString("hex")).toBe(fixture.preimageHex);
      expect(hash(preimage)).toBe(fixture.sha256);

      const oneBitMutation = Buffer.from(preimage);
      oneBitMutation[fixture.oneBitMutation.byteOffset] =
        oneBitMutation[fixture.oneBitMutation.byteOffset]! ^
        fixture.oneBitMutation.xorMask;
      expect(hash(oneBitMutation)).toBe(fixture.oneBitMutation.sha256);
      expect(hash(oneBitMutation)).not.toBe(fixture.sha256);

      const crossDomain = Buffer.concat([
        Buffer.from(fixture.crossDomain.domain, "ascii"),
        ...fixture.fields.map((field) => Buffer.from(field[3], "hex")),
      ]);
      expect(hash(crossDomain)).toBe(fixture.crossDomain.sha256);
      expect(hash(crossDomain)).not.toBe(fixture.sha256);
    }

    for (const fixture of Object.values(phase7RetentionProofBoundaryVectors)) {
      const preimage = materialize(fixture);
      expect(preimage.toString("hex")).toBe(fixture.preimageHex);
      expect(hash(preimage)).toBe(fixture.sha256);
    }
    expect(
      phase7RetentionProofBoundaryVectors.zeroDrainProof.fields.slice(17, 23),
    ).toEqual([
      ["first_event_run_id", "nullable-uuid", null, "00"],
      ["first_event_sequence", "nullable-i64", null, "00"],
      ["first_event_sha256", "nullable-sha-byte-string", null, "00"],
      ["last_event_run_id", "nullable-uuid", null, "00"],
      ["last_event_sequence", "nullable-i64", null, "00"],
      ["last_event_sha256", "nullable-sha-byte-string", null, "00"],
    ]);
    expect(
      phase7RetentionProofBoundaryVectors.cleanupWithoutDrain.fields[8],
    ).toEqual([
      "latest_unconsumed_drain_proof_sha256",
      "nullable-sha-byte-string",
      null,
      "00",
    ]);

    for (const fixture of Object.values(phase7RetainedChainSetByteVectors)) {
      const preimage = Buffer.concat([
        Buffer.from(phase7RetentionContract.retainedChainDomain, "ascii"),
        ...fixture.fields.map((field) => Buffer.from(field[3], "hex")),
      ]);
      expect(preimage.toString("hex")).toBe(fixture.preimageHex);
      expect(hash(preimage)).toBe(fixture.sha256);
    }
    const multiple = phase7RetainedChainSetByteVectors.multipleRuns;
    expect(multiple.physicalInsertionOrder).toEqual([
      "00000000-0000-8000-8000-000000000100",
      "00000000-0000-8000-8000-0000000000ff",
    ]);
    expect(
      [...multiple.physicalInsertionOrder].sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.replaceAll("-", ""), "hex"),
          Buffer.from(right.replaceAll("-", ""), "hex"),
        ),
      ),
    ).toEqual(multiple.canonicalRunOrder);
    expect(hash(Buffer.from(multiple.preimageHex, "hex"))).toBe(
      multiple.sha256,
    );
    expect(
      phase7RetentionProofBoundaryVectors.nonzeroAgeOutProof.fields[9]?.[2],
    ).toBe(multiple.sha256);
    expect(phase7RetentionProofByteVectors.ageOutProof.fields[9]?.[2]).toBe(
      phase7RetainedChainSetByteVectors.zeroRuns.sha256,
    );

    type EventSnapshot = {
      runId: string;
      currentEventSequence: string;
      currentEventSha256: string;
      eventHeaders: readonly {
        eventSequence: string;
        priorEventSequence: string | null;
        priorEventSha256: string | null;
        eventSha256: string;
      }[];
    };
    const validateEventSnapshot = (
      runs: readonly EventSnapshot[],
    ): string | null => {
      for (const run of runs) {
        for (const [index, event] of run.eventHeaders.entries()) {
          const expectedSequence = String(index + 1);
          if (event.eventSequence !== expectedSequence) {
            return "event_sequence_not_contiguous";
          }
          const prior = run.eventHeaders[index - 1];
          if (
            index === 0
              ? event.priorEventSequence !== null ||
                event.priorEventSha256 !== null
              : event.priorEventSequence !== prior!.eventSequence ||
                event.priorEventSha256 !== prior!.eventSha256
          ) {
            return "event_prior_link_mismatch";
          }
        }
        if (
          run.eventHeaders.length !== Number(run.currentEventSequence) ||
          run.eventHeaders.at(-1)?.eventSha256 !== run.currentEventSha256
        ) {
          return "event_head_sha256_mismatch";
        }
      }
      return null;
    };

    for (const [name, snapshot] of Object.entries(
      phase7RetainedChainEventSnapshots,
    )) {
      expect(validateEventSnapshot(snapshot)).toBeNull();
      const retainedEventCount = snapshot.reduce(
        (sum, run) => sum + BigInt(run.currentEventSequence),
        0n,
      );
      expect(retainedEventCount.toString()).toBe(
        phase7RetainedChainSetByteVectors[
          name as keyof typeof phase7RetainedChainSetByteVectors
        ].retainedEventCount,
      );
    }

    expect(phase7RetainedChainSetDenials.map(({ id }) => id)).toEqual([
      "one-bit-run-uuid-drift",
      "one-bit-current-event-sequence-drift",
      "one-bit-current-event-sha256-drift",
      "tuple-order-drift",
      "eligible-run-count-drift",
      "retained-event-count-drift",
      "event-sequence-gap",
      "event-head-mismatch",
      "retained-event-count-signed64-overflow",
    ]);
    for (const denial of phase7RetainedChainSetDenials) {
      const baseline = phase7RetainedChainSetByteVectors[denial.baseline];
      expect(denial.expected.outcome).toBe("reject");

      if (denial.mutation.kind === "replace_field") {
        const mutation = denial.mutation;
        let replacementCount = 0;
        const fields = baseline.fields.map((field) => {
          if (field[0] !== mutation.field) return field;
          replacementCount += 1;
          expect(field[2]).toBe(mutation.fromInput);
          expect(field[3]).toBe(mutation.fromEncodedHex);
          const changedBitCount = Buffer.from(field[3], "hex").reduce(
            (count, byte, index) =>
              count +
              (byte ^ Buffer.from(mutation.toEncodedHex, "hex")[index]!)
                .toString(2)
                .replaceAll("0", "").length,
            0,
          );
          expect(changedBitCount).toBe(1);
          return [
            field[0],
            field[1],
            mutation.toInput,
            mutation.toEncodedHex,
          ] as const;
        });
        expect(replacementCount).toBe(1);
        const mutatedPreimage = Buffer.concat([
          Buffer.from(phase7RetentionContract.retainedChainDomain, "ascii"),
          ...fields.map((field) => Buffer.from(field[3], "hex")),
        ]);
        expect(denial.expected.hashBehavior.kind).toBe("digest_mismatch");
        if (denial.expected.hashBehavior.kind === "digest_mismatch") {
          expect(mutatedPreimage.toString("hex")).toBe(
            denial.expected.hashBehavior.mutatedPreimageHex,
          );
          expect(hash(mutatedPreimage)).toBe(
            denial.expected.hashBehavior.mutatedSha256,
          );
          expect(hash(mutatedPreimage)).not.toBe(
            denial.expected.hashBehavior.canonicalSha256,
          );
        }
      } else if (denial.mutation.kind === "reverse_run_tuples") {
        expect(denial.mutation.fields).toEqual(
          baseline.fields.slice(4).map((field) => field[0]),
        );
        const fields = [
          ...baseline.fields.slice(0, 4),
          ...baseline.fields.slice(7, 10),
          ...baseline.fields.slice(4, 7),
        ];
        const mutatedPreimage = Buffer.concat([
          Buffer.from(phase7RetentionContract.retainedChainDomain, "ascii"),
          ...fields.map((field) => Buffer.from(field[3], "hex")),
        ]);
        expect(denial.expected.hashBehavior.kind).toBe("digest_mismatch");
        if (denial.expected.hashBehavior.kind === "digest_mismatch") {
          expect(mutatedPreimage.toString("hex")).toBe(
            denial.expected.hashBehavior.mutatedPreimageHex,
          );
          expect(hash(mutatedPreimage)).toBe(
            denial.expected.hashBehavior.mutatedSha256,
          );
          expect(hash(mutatedPreimage)).not.toBe(
            denial.expected.hashBehavior.canonicalSha256,
          );
        }
      } else if (denial.mutation.kind === "proof_count_drift") {
        expect(baseline.retainedEventCount).toBe(denial.mutation.fromInput);
        expect(denial.mutation.fromEncodedHex).not.toBe(
          denial.mutation.toEncodedHex,
        );
        expect(denial.expected.hashBehavior).toEqual({
          kind: "digest_unchanged_count_mismatch",
          canonicalSha256: baseline.sha256,
        });
        expect(hash(Buffer.from(baseline.preimageHex, "hex"))).toBe(
          baseline.sha256,
        );
      } else if (denial.mutation.kind === "event_snapshot_drift") {
        const snapshot = structuredClone(
          phase7RetainedChainEventSnapshots[denial.baseline],
        ) as unknown as (EventSnapshot & {
          eventHeaders: {
            eventSequence: string;
            priorEventSequence: string | null;
            priorEventSha256: string | null;
            eventSha256: string;
          }[];
        })[];
        expect(denial.expected.hashBehavior).toEqual({
          kind: "validation_before_hash",
          hashAttempted: false,
        });
        if (denial.id === "event-sequence-gap") {
          expect(denial.mutation.path).toBe(
            "multipleRuns[1].eventHeaders[0].eventSequence",
          );
          expect(snapshot[1]!.eventHeaders[0]!.eventSequence).toBe(
            denial.mutation.from,
          );
          snapshot[1]!.eventHeaders[0]!.eventSequence = denial.mutation.to;
        } else {
          expect(denial.mutation.path).toBe(
            "multipleRuns[1].eventHeaders[1].eventSha256",
          );
          expect(snapshot[1]!.eventHeaders[1]!.eventSha256).toBe(
            denial.mutation.from,
          );
          snapshot[1]!.eventHeaders[1]!.eventSha256 = denial.mutation.to;
        }
        expect(validateEventSnapshot(snapshot)).toBe(denial.expected.reason);
      } else {
        expect(
          denial.mutation.runSequenceMutations.map((mutation) => {
            const field = baseline.fields.find(
              (candidate) => candidate[0] === mutation.field,
            );
            expect(field?.[2]).toBe(mutation.fromInput);
            expect(field?.[3]).toBe(mutation.fromEncodedHex);
            expect(mutation.toEncodedHex).toHaveLength(16);
            return mutation.toInput;
          }),
        ).toEqual(denial.mutation.addends);
        const sum = denial.mutation.addends.reduce(
          (total, addend) => total + BigInt(addend),
          0n,
        );
        expect(sum).toBeGreaterThan(BigInt(denial.mutation.signed64Maximum));
        expect(denial.expected.hashBehavior).toEqual({
          kind: "overflow_before_hash",
          hashAttempted: false,
        });
      }
    }
  });

  it("freezes RLS/ACL lock-only authority, checkpoint projection, and tombstone lineage", () => {
    expect(phase7AuthorityContract.runSchema).toEqual({
      owner: "migration_owner",
      usage: ["dasher_run_definer", "dasher_run_operator"],
      create: [],
    });
    expect(phase7AuthorityContract.runCapabilities).toHaveLength(21);
    expect(phase7AuthorityContract.lockOnlyWithCheck).toBe("false");
    expect(phase7AuthorityContract.triggers).toEqual([
      "agent_run_immutable_guard",
      "agent_run_transition_guard",
      "agent_run_retention_guard",
    ]);
    expect(phase7AuthorityContract.checkpointEventPayloadColumns).toHaveLength(
      9,
    );
    expect(
      phase7ExactBodyProjections.age_out_tombstone_lineage.dashboards,
    ).toContain("tombstone_lineage_id");
    expect(phase7ExactBodyProjections.calculated_freshness.consumers).toEqual([
      "commit_candidate_claims",
      "commit_candidate_manifest",
      "finalize_agent_run_ranking",
    ]);
  });

  it("freezes all semantic schema bounds and calculation registries/limits", () => {
    const canonicalContractNames = [
      "canonical-input-table-v1",
      "common-evidence-bundle-v1",
      "agent-brief-v1",
      "agent-validation-findings-v1",
      "candidate-claims-v1",
      "reviewer-verdict-set-v1",
      "candidate-evidence-manifest-v1",
      "run-abstention-v1",
      "dashboard-spec-v1",
      "precommit-dashboard-validation-v1",
      "field-catalog-snapshot-v1",
      "metric-contract-set-v1",
      "agent-run-request-v1",
      "attempt-request-v1",
      "recorded-result-v1",
      "agent-run-checkpoint-v1",
      "agent-run-event-payload-v1",
      "calculation-graph-v1",
      "calculation-result-v1",
    ];
    expect(Object.keys(phase7CanonicalSemanticContracts)).toEqual(
      canonicalContractNames,
    );
    expect(Object.keys(phase7SemanticSchemas)).toEqual([
      ...canonicalContractNames.slice(0, 8),
      ...canonicalContractNames.slice(-2),
    ]);
    for (const [name, abbreviated] of Object.entries(phase7SemanticSchemas)) {
      const canonical = phase7CanonicalSemanticContracts[
        name as keyof typeof phase7CanonicalSemanticContracts
      ] as { domain: string; fields?: readonly string[] };
      expect(canonical.domain).toBe(abbreviated.domain);
      if ("fields" in abbreviated) {
        expect(canonical.fields).toEqual(abbreviated.fields);
      }
    }
    expect(phase7CanonicalJsonContract.signed64).toEqual({
      json: "i64:<decimal>",
      decimal: "0|-?[1-9][0-9]*",
      minimum: "-9223372036854775808",
      maximum: "9223372036854775807",
      typescript: "bigint",
      postgresql: "numeric range-check before bigint cast",
      jsonNumberAllowed: false,
    });
    expect(
      phase7CanonicalSemanticContracts["dashboard-spec-v1"].versions,
    ).toEqual(["1.0", "1.1"]);
    expect(
      phase7CanonicalSemanticContracts["precommit-dashboard-validation-v1"]
        .errorCodes,
    ).toHaveLength(10);
    expect(
      phase7CanonicalSemanticContracts["field-catalog-snapshot-v1"].field
        .fields,
    ).toHaveLength(15);
    expect(
      phase7CanonicalSemanticContracts["metric-contract-set-v1"].contract
        .fields,
    ).toHaveLength(24);
    expect(
      phase7CanonicalSemanticContracts["agent-run-request-v1"].fields,
    ).toHaveLength(27);
    expect(
      phase7CanonicalSemanticContracts["attempt-request-v1"].fields,
    ).toHaveLength(21);
    expect(
      phase7CanonicalSemanticContracts["agent-run-checkpoint-v1"].fields,
    ).toHaveLength(32);
    const eventContract =
      phase7CanonicalSemanticContracts["agent-run-event-payload-v1"];
    expect(
      eventContract.bodyEnumRegistry.attempt_released.release_mode,
    ).toEqual(["worker", "takeover"]);
    expect(
      eventContract.bodyEnumRegistry.attempt_released.release_mode.includes(
        "worker",
      ),
    ).toBe(true);
    expect(
      eventContract.bodyEnumRegistry.attempt_released.release_mode.includes(
        "takeover",
      ),
    ).toBe(true);
    expect(
      (
        eventContract.bodyEnumRegistry.attempt_released
          .release_mode as readonly string[]
      ).includes("operator"),
    ).toBe(false);
    expect(Object.keys(eventContract.bodyEnumRegistry)).toEqual([
      "run_requested",
      "lease_acquired",
      "attempt_reserved",
      "attempt_reconciled",
      "attempt_indeterminate",
      "attempt_released",
      "candidate_validation_findings_committed",
      "run_finished",
    ]);
    expect(
      Object.keys(
        phase7CanonicalSemanticContracts["agent-run-event-payload-v1"]
          .bodyRegistry,
      ),
    ).toHaveLength(27);
    expect(
      phase7CanonicalSemanticContracts["agent-run-event-payload-v1"]
        .rawAccountingBytesForbidden,
    ).toBe(true);
    expect(Object.keys(phase7AuxiliarySemanticContracts)).toEqual([
      "attempt-actual-accounting-v1",
      "fake-provider-input-v1",
      "calculation-meter-v1",
      "calculation-output-value-v1",
      "run-finish-reason-v1",
      "run-cancel-reason-v1",
      "material-assertions-v1",
      "calculated-assertion-mapping-v1",
    ]);
    expect(
      phase7AuxiliarySemanticContracts["calculation-meter-v1"].fields,
    ).toEqual([
      "schema",
      "graph_id",
      "result_id",
      ...phase7CalculationMeterFields,
    ]);
    expect(phase7CalculationMeterFields).toHaveLength(20);
    expect(phase7CalculationLimits).toEqual({
      inputBytes: 1_048_576,
      rawGraphBytes: 131_072,
      astBytes: 65_536,
      nodes: 128,
      depth: 32,
      oneLiteralBytes: 4_096,
      allLiteralBytes: 32_768,
      literalList: 256,
      topK: 1_000,
      windowFrame: 10_000,
      coefficientDigits: 38,
      scale: 18,
      scannedRows: 10_000,
      groups: 1_000,
      groupRows: 10_000,
      intermediateRows: 50_000,
      outputRows: 2_000,
      intermediateBytes: 8_388_608,
      outputBytes: 1_048_576,
      primitiveSteps: 1_000_000,
      logicalAllocationBytes: 33_554_432,
    });
    expect(phase7UcumRegistry).toHaveLength(26);
    expect(phase7UcumRegistry.map((row) => row[1])).toEqual([
      "1",
      "%",
      "m",
      "cm",
      "mm",
      "km",
      "[in_i]",
      "[ft_i]",
      "s",
      "min",
      "h",
      "d",
      "m3",
      "L",
      "[ft_i]3",
      "[gal_us]",
      "m3/s",
      "m3/h",
      "L/s",
      "L/min",
      "[ft_i]3/s",
      "[gal_us]/min",
      "K",
      "Cel",
      "[degF]",
      "[degR]",
    ]);
    expect(phase7UcumRegistry.filter((row) => row[5])).toEqual([
      ["temperature", "Cel", "K", "1/1", "5463/20", true],
      ["temperature", "[degF]", "K", "5/9", "45967/180", true],
    ]);
    expect(phase7FxRegistry).toEqual([
      ["USD", 2],
      ["EUR", 2],
      ["GBP", 2],
      ["JPY", 0],
    ]);
    expect(phase7CalculationErrors).toHaveLength(17);
  });

  it("freezes every arithmetic/non-conversion operation, primitive meter rule, contract conformance row, and temporal rejection", () => {
    const operationNames = Object.keys(phase7CalculationOperationRegistry);
    expect([...operationNames].sort()).toEqual(
      Object.keys(phase7PrimitiveStepRegistry)
        .filter((operation) => operation !== "mergeSort")
        .sort(),
    );
    expect(operationNames).toHaveLength(41);
    expect(phase7ArithmeticRegistry.operations).toEqual([
      "add",
      "subtract",
      "multiply",
      "divide",
    ]);
    expect(phase7ArithmeticRegistry.metadataMatrix).toHaveLength(7);
    expect(phase7ArithmeticRegistry.forbidden).toHaveLength(8);
    expect(phase7NonConversionOperationRegistry.statePrecedence).toEqual([
      "unavailable",
      "missing",
      "null",
      "compute",
      "stale propagation",
    ]);
    expect(
      Object.keys(
        phase7MetricContractConformanceMatrix.aggregationGraphMapping,
      ),
    ).toEqual([
      "count",
      "count_distinct",
      "sum",
      "min",
      "max",
      "mean",
      "median",
      "ratio",
    ]);
    expect(
      phase7MetricContractConformanceMatrix.aggregationValueType,
    ).toHaveLength(6);
    expect(
      phase7MetricContractConformanceMatrix.forbiddenContractPathOps,
    ).toEqual([
      "filter",
      "sort",
      "top_k",
      "lag",
      "window",
      "conditional",
      "uncontracted selection",
    ]);
    const conformanceIds = phase7MetricContractConformanceCases.map(
      (fixture) => fixture.id,
    );
    expect(new Set(conformanceIds).size).toBe(conformanceIds.length);
    for (const [baselineName, baseline] of Object.entries(
      phase7MetricContractBaselines,
    )) {
      expect(
        phase7MetricBaselineViolations(baseline),
        `${baselineName} must be a valid complete section 4.3/5.1 baseline`,
      ).toEqual([]);
    }
    const readCompletePath = (
      context: Phase7MetricContractContext,
      path: string,
    ): { exists: boolean; value: unknown } => {
      let value: unknown = context;
      for (const segment of path.split(".")) {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !(segment in value)
        ) {
          return { exists: false, value: undefined };
        }
        value = (value as Record<string, unknown>)[segment];
      }
      return { exists: true, value };
    };
    for (const requiredIds of Object.values(phase7MetricConformanceCoverage)) {
      expect(requiredIds.every((id) => conformanceIds.includes(id))).toBe(true);
    }
    for (const fixture of phase7MetricContractConformanceCases) {
      const baseline = phase7MetricContractBaselines[fixture.baseline];
      expect(
        phase7MetricBaselineViolations(baseline),
        `${fixture.id} inherited an invalid ${fixture.baseline} baseline`,
      ).toEqual([]);
      if (fixture.expected.outcome === "accept") {
        expect(
          phase7MetricBaselineViolations(fixture.context),
          `${fixture.id} is labeled accepted but violates section 4.3/5.1`,
        ).toEqual([]);
      }
      expect(Object.keys(fixture.context)).toEqual(Object.keys(baseline));
      expect(Object.keys(fixture.context.contract)).toEqual(
        Object.keys(baseline.contract),
      );
      expect(Object.keys(fixture.context.catalog)).toEqual(
        Object.keys(baseline.catalog),
      );
      expect(Object.keys(fixture.context.governance)).toEqual(
        Object.keys(baseline.governance),
      );
      expect(Object.keys(fixture.context.graph)).toEqual(
        Object.keys(baseline.graph),
      );
      expect(Object.keys(fixture.context.result)).toEqual(
        Object.keys(baseline.result),
      );
      expect(Object.keys(fixture.context.freshness)).toEqual(
        Object.keys(baseline.freshness),
      );
      expect(fixture.context).not.toBe(baseline);
      expect(
        phase7MetricChangedPaths(baseline, fixture.context).sort(),
      ).toEqual([...fixture.expectedChangedPaths].sort());
      expect(fixture.patches.map(({ path }) => path)).toEqual(
        fixture.expectedChangedPaths,
      );
      expect(new Set(fixture.expectedChangedPaths).size).toBe(
        fixture.expectedChangedPaths.length,
      );
      expect(JSON.stringify(fixture.context).includes("undefined")).toBe(false);
      for (const path of phase7MetricRequiredContextPaths) {
        expect(readCompletePath(fixture.context, path).exists, path).toBe(true);
      }
      expect(fixture.expected.reason).toMatch(/^[a-z0-9_:]+$/u);
    }
    expect(Object.keys(phase7MetricContractBaselines)).toEqual([
      "sum_currency",
      "ratio_percentage",
      "higher_direction",
    ]);
    expect(
      phase7MetricContractConformanceCases.find(
        (fixture) => fixture.id === "owners-same-identity",
      ),
    ).toMatchObject({
      patches: [
        {
          path: "contract.dataOwner.membershipId",
          value: "00000000-0000-8000-8000-000000000109",
        },
      ],
      expected: { outcome: "reject", reason: "owners_not_distinct" },
    });
    expect(
      phase7MetricContractConformanceCases.find(
        (fixture) => fixture.id === "lineage-hidden-extra",
      )?.expected,
    ).toEqual({ outcome: "reject", reason: "lineage_union_not_exact" });
    expect(
      phase7MetricContractConformanceCases.find(
        (fixture) => fixture.id === "unit-and-currency-conversion",
      )?.expected,
    ).toEqual({
      outcome: "reject",
      reason: "conversion_kinds_not_exclusive",
    });
    const groupKeyNodeSubstitution = phase7MetricContractConformanceCases.find(
      (fixture) => fixture.id === "group-key-catalog-field-substitution",
    );
    expect(groupKeyNodeSubstitution).toMatchObject({
      patches: [
        {
          path: "graph.group.keyNodeIds",
          value: ["00000000-0000-8000-8000-000000000204"],
        },
      ],
      expectedChangedPaths: ["graph.group.keyNodeIds"],
      expected: {
        outcome: "reject",
        reason: "contract_group_key_node_required",
      },
    });
    expect(
      phase7MetricBaselineViolations(groupKeyNodeSubstitution!.context),
    ).toEqual([
      "graph:group-key-node-edge",
      "graph:canonical-topological-order",
    ]);
    const aggregationInputNodeSubstitution =
      phase7MetricContractConformanceCases.find(
        (fixture) =>
          fixture.id === "aggregation-input-catalog-field-substitution",
      );
    expect(aggregationInputNodeSubstitution).toMatchObject({
      patches: [
        {
          path: "graph.aggregation.input",
          value: "00000000-0000-8000-8000-000000000202",
        },
      ],
      expectedChangedPaths: ["graph.aggregation.input"],
      expected: {
        outcome: "reject",
        reason: "contract_aggregation_input_node_required",
      },
    });
    expect(
      phase7MetricBaselineViolations(aggregationInputNodeSubstitution!.context),
    ).toEqual([
      "graph:aggregation-input-node-edge",
      "graph:canonical-topological-order",
    ]);
    expect(
      phase7MetricContractConformanceCases.find(
        (fixture) => fixture.id === "freshness-absent-zero-policy",
      )?.expected,
    ).toEqual({ outcome: "accept", reason: "freshness_diagnostic_absent" });
    expect(
      phase7MetricContractConformanceCases.find(
        (fixture) => fixture.id === "freshness-multiple-structures",
      )?.expected,
    ).toEqual({
      outcome: "reject",
      reason: "freshness_diagnostic_multiple",
    });
    expect(phase7RowCountOnlyWindowRejectionMatrix).toEqual([
      ["frame_kind", "any value", "invalid_graph"],
      ["event_time", "any value", "invalid_graph"],
      ["duration_millis", "any value", "invalid_graph"],
      ["period", "any value", "invalid_graph"],
      ["calendar", "any value", "invalid_graph"],
      [
        "fixed-duration interpretation",
        "even without an extra key",
        "invalid_graph",
      ],
      [
        "calendar-period interpretation",
        "even without an extra key",
        "invalid_graph",
      ],
      [
        "event-time membership interpretation",
        "even with event_time_field_id metadata",
        "invalid_graph",
      ],
    ]);
  });

  it("freezes the literal R7 identity/hash/byte chain and disjoint intermediate accounting", () => {
    const semanticRowHash = (domain: string, bytes: string): string => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(Buffer.byteLength(bytes));
      return createHash("sha256")
        .update(domain, "ascii")
        .update("\0", "ascii")
        .update(length)
        .update(bytes, "utf8")
        .digest("hex");
    };
    const hashInputs = {
      input: ["dasher.canonical-input-table.v1", "input"],
      evidence: ["dasher.fx-rate-evidence.v1", "evidence"],
      catalog: ["dasher.field-catalog-snapshot.v1", "catalog"],
      contractSet: ["dasher.metric-contract-set.v1", "contractSet"],
      contract: ["dasher.metric-contract-version.v1", "contract"],
      bundle: ["dasher.common-evidence-bundle.v1", "bundle"],
      graph: ["dasher.calculation-graph.v1", "graph"],
      meter: ["dasher.calculation-meter.v1", "meter"],
      result: ["dasher.calculation-result.v1", "result"],
      output: ["dasher.calculation-output.v1", "output"],
      outputValue: ["dasher.calculation-output-value.v1", "outputValue"],
    } as const;

    expect(phase7R7Fixture.evaluationTime).toBe("2026-08-05T12:00:00.000000Z");
    expect(phase7R7Fixture.bytes).toEqual({
      input: 922,
      graph: 3788,
      output: 541,
      logicalAllocation: 8133,
    });
    expect(phase7R7Fixture.intermediateBytes).toEqual([1238, 471, 315, 538]);
    expect(
      phase7R7Fixture.intermediateBytes.reduce(
        (total, value) => total + value,
        0,
      ),
    ).toBe(2562);
    expect(Object.values(phase7R7Fixture.hashes)).toHaveLength(11);
    for (const hash of Object.values(phase7R7Fixture.hashes)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    }
    for (const [hashName, [domain, byteName]] of Object.entries(hashInputs)) {
      const bytes = phase7R7LiteralFixture.bytes[byteName];
      expect(JSON.stringify(JSON.parse(bytes))).toBe(bytes);
      expect(semanticRowHash(domain, bytes)).toBe(
        phase7R7Fixture.hashes[hashName as keyof typeof phase7R7Fixture.hashes],
      );
    }
    expect(Buffer.byteLength(phase7R7LiteralFixture.bytes.input)).toBe(
      phase7R7Fixture.bytes.input,
    );
    expect(Buffer.byteLength(phase7R7LiteralFixture.bytes.graph)).toBe(
      phase7R7Fixture.bytes.graph,
    );
    expect(Buffer.byteLength(phase7R7LiteralFixture.bytes.outputsArray)).toBe(
      phase7R7Fixture.bytes.output,
    );
    expect(phase7R7LiteralFixture.bytes.outputsArray).toBe(
      `[${phase7R7LiteralFixture.bytes.output}]`,
    );
    expect(phase7R7LiteralFixture.sourceRows.transformation).toBe(
      phase7R7LiteralFixture.bytes.evidence,
    );
    expect(phase7R7LiteralFixture.sourceRows.fieldEntrySha256).toEqual([
      "fcc70d5724088cca1303a01f04e79a146de5ce47fde3d4ecfe8ca3586f866651",
      "fdbc43baeb43ec44ba2c540da6ea01aa7663a33c0cdabe6df5f1c34aa6718790",
      "dac812f871f145f78fcd3c7229e9959e1fc745a787a20e2ed3201d16e0e4c678",
    ]);
    expect(Object.keys(phase7R7LiteralFixture.boundaryMutations)).toEqual([
      "fx-jpy-positive-tie",
      "fx-jpy-negative-tie",
      "fx-fresh-inclusive",
      "fx-stale-one-microsecond",
      "fx-future-one-microsecond",
      "fx-kind-predecessor-compatible",
      "fx-kind-forbidden-spelling",
      "fx-missing-before-stale",
      "fx-direction-drift",
      "fx-meter-byte-drift",
      "fx-38/39-digit",
    ]);
    for (const boundary of Object.values(
      phase7R7LiteralFixture.boundaryMutations,
    )) {
      expect(boundary.transformation.trim().length).toBeGreaterThan(0);
      expect(boundary.expected.trim().length).toBeGreaterThan(0);
    }
  });

  it("binds the immutable phase-6 baseline tuple before any phase-7 replacement", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const phase6Sql = migrations[5]?.sql ?? "";
    const baseline = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as Record<string, readonly string[]>;

    expect(migrations).toHaveLength(7);
    expect(baseline.functions).toContainEqual(
      expect.stringMatching(
        /^dasher_retention_api[.]claim_dashboard_cleanup\(uuid, bigint, bytea, interval, uuid, text, uuid\)\|/u,
      ),
    );
    expect(baseline.functions).toContainEqual(
      expect.stringMatching(
        /^dasher_retention_api[.]record_dashboard_cleanup_attempt\(uuid, uuid, text, text, integer, integer, integer, bytea, uuid\)\|/u,
      ),
    );
    expect(baseline.functions).toContainEqual(
      expect.stringMatching(
        /^dasher_retention_api[.]purge_dashboard\(uuid, bigint, bytea, uuid, text, uuid\)\|/u,
      ),
    );
  });
});

describe("Task 9B canonical 0007 SQL gate", () => {
  it("requires the exact canonical phase-7 file and checksum", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    expect(
      migrations.map((migration) => ({
        sequence: migration.sequence,
        filename: migration.filename,
        checksum: Buffer.from(migration.checksumSha256).toString("hex"),
      })),
    ).toContainEqual(phase7Migration);
  });

  it("binds raw accounting to the frozen reconciliation-only grammar", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const start = sql.indexOf(
      "CREATE FUNCTION dasher_run_api.reconcile_agent_run_attempt(",
    );
    const end = sql.indexOf(
      "CREATE FUNCTION dasher_run_api.release_agent_run_attempt(",
      start,
    );
    const reconcile = sql.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(reconcile).toContain(
      "pg_catalog.octet_length(p_actual_accounting_bytes) NOT BETWEEN 1 AND 1024",
    );
    expect(reconcile).toContain("'attempt-actual-accounting-v1'");
    expect(reconcile).toContain("'caller_indeterminate'");
    expect(reconcile).toContain("'malformed_accounting'");
    expect(reconcile).toContain("'actual_over_reservation'");
    expect(reconcile).toContain(
      "WHEN SQLSTATE '22021' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN",
    );
    expect(reconcile).not.toMatch(
      /undefined_function|data_exception|WHEN OTHERS|sha256\(p_actual_accounting_bytes\)|RAISE (?:LOG|NOTICE|WARNING)/u,
    );
    expect(sql.slice(0, start) + sql.slice(end)).not.toContain(
      "p_actual_accounting_bytes",
    );
  });

  it("allows discovery for exactly the 21 run capabilities without weakening principal binding", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const start = sql.indexOf("CREATE POLICY agent_runs_run_discovery_select");
    const end = sql.indexOf(
      "CREATE POLICY agent_runs_run_definer_update",
      start,
    );
    const discoveryPolicy = sql.slice(start, end);
    const expectedCapabilities = [
      "checkpoint",
      "claim",
      "clone_replay",
      "close_candidate_set",
      "commit_abstention",
      "commit_brief",
      "commit_bundle",
      "commit_candidate",
      "commit_claims",
      "commit_graph",
      "commit_manifest",
      "commit_validation",
      "consume_replay",
      "dispatch",
      "finalize_ranking",
      "finish",
      "read_input",
      "read_replay",
      "reconcile",
      "release",
      "reserve",
    ] as const;
    const capabilityArray =
      /run_capability'[\s\S]*?= ANY\(ARRAY\[([\s\S]*?)\]::text\[\]\)/u.exec(
        discoveryPolicy,
      )?.[1] ?? "";
    const discoveredCapabilities = Array.from(
      capabilityArray.matchAll(/'([a-z_]+)'/gu),
      (match) => match[1],
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(discoveredCapabilities).toEqual(expectedCapabilities);
    expect(new Set(discoveredCapabilities).size).toBe(21);
    expect(discoveryPolicy).toContain(
      "current_setting('dasher.run_phase', true) = 'discovering'",
    );
    expect(discoveryPolicy).toContain(
      "principal.run_service_principal_id = NULLIF(current_setting(",
    );
    expect(discoveryPolicy).toContain(
      "principal.principal_revision = NULLIF(current_setting(",
    );
    expect(discoveryPolicy).toContain("principal.session_login = session_user");
    expect(discoveryPolicy).toContain(
      "principal.database_name = pg_catalog.current_database()",
    );
    expect(discoveryPolicy).toContain("principal.enabled");
    expect(discoveryPolicy).toContain(
      "later.principal_revision > principal.principal_revision",
    );
    expect(discoveryPolicy).toMatch(
      /NULLIF\(current_setting\(\s*'dasher[.]run_capability', true\s*\), ''\) = ANY\(principal[.]capabilities\)/u,
    );
    expect(discoveryPolicy).not.toContain(
      "current_setting('dasher.run_capability', true) = 'claim'",
    );
    expect(discoveryPolicy).not.toContain(
      "'claim' = ANY(principal.capabilities)",
    );
  });

  it("surfaces terminal failed runs to discovery only under the reconcile capability", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const section = (start: string, end: string): string => {
      const startIndex = sql.indexOf(start);
      const endIndex = sql.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return sql.slice(startIndex, endIndex);
    };
    const discoveryPolicy = section(
      "CREATE POLICY agent_runs_run_discovery_select",
      "CREATE POLICY agent_runs_run_definer_update",
    );
    const expectedStatePredicate = [
      "  AND (",
      "    state IN (",
      "      'requested','authorized','planning','generating','validating','revising'",
      "    )",
      "    OR (",
      "      state = 'failed'",
      "      AND NULLIF(current_setting(",
      "        'dasher.run_capability', true",
      "      ), '') = 'reconcile'",
      "    )",
      "  )",
    ].join("\n");

    expect(discoveryPolicy).toContain(expectedStatePredicate);
    expect(
      discoveryPolicy.split("state IN (").length - 1,
      "exactly one nonterminal state list",
    ).toBe(1);
    expect(
      discoveryPolicy.split("'failed'").length - 1,
      "failed appears only in the reconcile-guarded branch",
    ).toBe(1);
    expect(discoveryPolicy).not.toMatch(
      /'(?:succeeded|refused|cancelled|canceled|approval_required|indeterminate_quarantined|running)'/u,
    );

    expect(discoveryPolicy).toContain(
      "AS PERMISSIVE FOR SELECT TO dasher_run_definer",
    );
    expect(discoveryPolicy).not.toContain("WITH CHECK");
    expect(discoveryPolicy).not.toMatch(
      /\bFOR (?:UPDATE|INSERT|DELETE|ALL)\b/u,
    );

    const agentRunsPolicies = section(
      "CREATE POLICY agent_runs_security_definer_select",
      "CREATE POLICY agent_run_request_payloads_security_definer_select",
    );
    const failedOutsideDiscovery =
      agentRunsPolicies.split("'failed'").length - 1;
    expect(
      failedOutsideDiscovery,
      "no other agent_runs policy surfaces state='failed'",
    ).toBe(1);

    const reauthorize = section(
      "CREATE FUNCTION dasher_private.reauthorize_agent_run_v1(",
      "CREATE FUNCTION dasher_private.replay_source_fence_v1(",
    );
    for (const guard of [
      "v_terminal_reconcile_replay :=\n" +
        "    current_setting('dasher.run_capability', true) = 'reconcile'\n" +
        "    AND v_run.state = 'failed'\n" +
        "    AND v_run.lease_epoch = p_lease_epoch + 1\n" +
        "    AND v_run.lease_token_sha256 IS NULL\n" +
        "    AND v_run.lease_owner_principal_id IS NULL\n" +
        "    AND v_run.lease_owner_principal_revision IS NULL\n" +
        "    AND v_run.lease_expires_at IS NULL",
      "claim_event.event_kind = 'lease_acquired'",
      "claim_event.claim_operation_kind = 'ordinary_claim'",
      "claim_event.claim_result_lease_epoch = p_lease_epoch",
      "claim_event.claim_result_attempt_token = p_attempt_token",
      "'dasher.agent-run-ordinary-claim-input.v1', 'UTF8'",
      "pg_catalog.convert_to('dasher.agent-run-claim-result.v1', 'UTF8')",
    ]) {
      expect(reauthorize, guard).toContain(guard);
    }
  });

  it("surfaces locking-phase run events only under the reconcile capability", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const section = (start: string, end: string): string => {
      const startIndex = sql.indexOf(start);
      const endIndex = sql.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return sql.slice(startIndex, endIndex);
    };
    const definerSelect = section(
      "CREATE POLICY agent_run_events_run_definer_select",
      "CREATE POLICY agent_run_events_run_definer_insert",
    );

    const expectedDefinerSelect = [
      "CREATE POLICY agent_run_events_run_definer_select",
      "ON dasher.agent_run_events",
      "AS PERMISSIVE FOR SELECT TO dasher_run_definer",
      "USING (",
      "  dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id)",
      "  OR (",
      "    current_user = 'dasher_run_definer'::name",
      "    AND current_setting('dasher.run_phase', true) = 'locking'",
      "    AND NULLIF(current_setting('dasher.run_capability', true), '')",
      "      = 'reconcile'",
      "    AND organization_id = NULLIF(current_setting(",
      "      'dasher.run_organization_id', true",
      "    ), '')::uuid",
      "    AND dashboard_id = NULLIF(current_setting(",
      "      'dasher.run_dashboard_id', true",
      "    ), '')::uuid",
      "    AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid",
      "  )",
      "  OR (",
      "    current_user = 'dasher_run_definer'::name",
      "    AND current_setting('dasher.run_phase', true) = 'replay_source_read'",
      "    AND organization_id = NULLIF(current_setting(",
      "      'dasher.run_organization_id', true",
      "    ), '')::uuid",
      "    AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid",
      "    AND run_id = NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid",
      "  )",
      ");",
      "",
    ].join("\n");

    // 1. Exact three-branch union, byte-for-byte with the migration text.
    expect(definerSelect).toBe(expectedDefinerSelect);

    // 2. The single locking branch is reconcile-conditioned and run-scoped;
    //    a 'claim' capability under phase='locking' cannot satisfy it.
    const branches = definerSelect
      .split("\n  OR (\n")
      .slice(1)
      .map((branch) => branch.split("\n  )")[0] ?? "");
    const lockingBranches = branches.filter((branch) =>
      branch.includes("'locking'"),
    );
    expect(branches).toHaveLength(2);
    expect(lockingBranches).toHaveLength(1);
    for (const conjunct of [
      "current_user = 'dasher_run_definer'::name",
      "AND current_setting('dasher.run_phase', true) = 'locking'",
      "AND NULLIF(current_setting('dasher.run_capability', true), '')\n      = 'reconcile'",
      "AND organization_id = NULLIF(current_setting(\n      'dasher.run_organization_id', true\n    ), '')::uuid",
      "AND dashboard_id = NULLIF(current_setting(\n      'dasher.run_dashboard_id', true\n    ), '')::uuid",
      "AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid",
    ]) {
      expect(lockingBranches[0], conjunct).toContain(conjunct);
    }
    expect(
      definerSelect.split("'locking'").length - 1,
      "exactly one locking branch",
    ).toBe(1);
    expect(
      definerSelect.split("'reconcile'").length - 1,
      "the locking branch is the only capability-gated branch",
    ).toBe(1);
    expect(
      definerSelect,
      "no unconditioned locking branch may be copied from agent_runs",
    ).not.toContain(
      "AND current_setting('dasher.run_phase', true) = 'locking'\n    AND organization_id",
    );
    expect(definerSelect).not.toMatch(/'claim'|'claim_retry_discovering'/u);

    // 5. Still SELECT-only for dasher_run_definer with no WITH CHECK.
    expect(definerSelect).toContain(
      "AS PERMISSIVE FOR SELECT TO dasher_run_definer",
    );
    expect(definerSelect).not.toContain("WITH CHECK");
    expect(definerSelect).not.toMatch(/\bFOR (?:UPDATE|INSERT|DELETE|ALL)\b/u);
    expect(definerSelect).not.toMatch(
      /dasher_security_definer|dasher_retention_definer/u,
    );

    // 3. The other eight agent_run_events policies stay byte-identical.
    expect(
      section(
        "CREATE POLICY agent_run_events_security_definer_select",
        "CREATE POLICY agent_run_events_run_definer_select",
      ),
    ).toBe(
      [
        "CREATE POLICY agent_run_events_security_definer_select",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR SELECT TO dasher_security_definer",
        "USING (dasher_private.security_policy_allows_v1(organization_id, dashboard_id));",
        "CREATE POLICY agent_run_events_security_definer_insert",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR INSERT TO dasher_security_definer",
        "WITH CHECK (dasher_private.security_policy_allows_v1(organization_id, dashboard_id));",
        "",
      ].join("\n"),
    );
    expect(
      section(
        "CREATE POLICY agent_run_events_run_definer_insert",
        "CREATE POLICY agent_run_event_payloads_security_definer_insert",
      ),
    ).toBe(
      [
        "CREATE POLICY agent_run_events_run_definer_insert",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR INSERT TO dasher_run_definer",
        "WITH CHECK (dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id));",
        "CREATE POLICY agent_run_events_retention_definer_select",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR SELECT TO dasher_retention_definer",
        "USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id));",
        "CREATE POLICY agent_run_events_retention_definer_insert",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR INSERT TO dasher_retention_definer",
        "WITH CHECK (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id));",
        "CREATE POLICY agent_run_events_retention_definer_update",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR UPDATE TO dasher_retention_definer",
        "USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))",
        "WITH CHECK (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id));",
        "CREATE POLICY agent_run_events_retention_definer_delete",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR DELETE TO dasher_retention_definer",
        "USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id));",
        "",
      ].join("\n"),
    );
    expect(
      section(
        "CREATE POLICY agent_run_events_run_claim_retry_select",
        "CREATE POLICY candidate_comparison_bundles_run_lock_update",
      ),
    ).toBe(
      [
        "CREATE POLICY agent_run_events_run_claim_retry_select",
        "ON dasher.agent_run_events",
        "AS PERMISSIVE FOR SELECT TO dasher_run_definer",
        "USING (",
        "  current_user = 'dasher_run_definer'::name",
        "  AND current_setting('dasher.run_phase', true) = 'claim_retry_discovering'",
        "  AND claim_request_id = NULLIF(current_setting('dasher.run_claim_request_id', true), '')::uuid",
        ");",
        "",
        "",
      ].join("\n"),
    );

    // Exactly nine policies target dasher.agent_run_events.
    const eventPolicyNames = Array.from(
      sql.matchAll(
        /^CREATE POLICY ([a-z0-9_]+)\nON dasher[.]agent_run_events\n/gmu,
      ),
      (match) => match[1],
    );
    expect(eventPolicyNames).toEqual([
      "agent_run_events_security_definer_select",
      "agent_run_events_security_definer_insert",
      "agent_run_events_run_definer_select",
      "agent_run_events_run_definer_insert",
      "agent_run_events_retention_definer_select",
      "agent_run_events_retention_definer_insert",
      "agent_run_events_retention_definer_update",
      "agent_run_events_retention_definer_delete",
      "agent_run_events_run_claim_retry_select",
    ]);

    // No new authority: table grants and RLS forcing are unchanged.
    expect(
      Array.from(
        sql.matchAll(
          /GRANT[^;]+ON TABLE dasher[.]agent_run_events TO [^;]+;/gu,
        ),
        (match) => match[0].replace(/\s+/gu, " ").trim(),
      ).sort(),
    ).toEqual(
      [
        "GRANT SELECT ON TABLE dasher.agent_run_events TO dasher_security_definer;",
        "GRANT INSERT ON TABLE dasher.agent_run_events TO dasher_security_definer;",
        "GRANT SELECT ON TABLE dasher.agent_run_events TO dasher_run_definer;",
        "GRANT INSERT ON TABLE dasher.agent_run_events TO dasher_run_definer;",
        "GRANT SELECT ON TABLE dasher.agent_run_events TO dasher_retention_definer;",
        "GRANT INSERT ON TABLE dasher.agent_run_events TO dasher_retention_definer;",
        "GRANT DELETE ON TABLE dasher.agent_run_events TO dasher_retention_definer;",
        "GRANT UPDATE (event_payload_id, claim_input_sha256, claim_result_sha256, claim_result_attempt_token, claim_result_input_sha256) ON TABLE dasher.agent_run_events TO dasher_retention_definer;",
      ].sort(),
    );
    expect(sql).toContain(
      "ALTER TABLE dasher.agent_run_events ENABLE ROW LEVEL SECURITY;\n" +
        "ALTER TABLE dasher.agent_run_events FORCE ROW LEVEL SECURITY;",
    );

    // 4. The reauthorize terminal-reconcile-replay guard is unweakened, and
    //    'locking' remains the phase in force when the guard EXISTS runs.
    const reauthorize = section(
      "CREATE FUNCTION dasher_private.reauthorize_agent_run_v1(",
      "CREATE FUNCTION dasher_private.replay_source_fence_v1(",
    );
    const lockingSet = reauthorize.indexOf(
      "PERFORM pg_catalog.set_config('dasher.run_phase', 'locking', true);",
    );
    const guardRead = reauthorize.indexOf("v_terminal_reconcile_replay :=");
    const authorizedSet = reauthorize.indexOf(
      "PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);",
    );
    expect(lockingSet).toBeGreaterThanOrEqual(0);
    expect(guardRead).toBeGreaterThan(lockingSet);
    expect(authorizedSet).toBeGreaterThan(guardRead);
    for (const guard of [
      "v_terminal_reconcile_replay :=\n" +
        "    current_setting('dasher.run_capability', true) = 'reconcile'\n" +
        "    AND v_run.state = 'failed'\n" +
        "    AND v_run.lease_epoch = p_lease_epoch + 1\n" +
        "    AND v_run.lease_token_sha256 IS NULL\n" +
        "    AND v_run.lease_owner_principal_id IS NULL\n" +
        "    AND v_run.lease_owner_principal_revision IS NULL\n" +
        "    AND v_run.lease_expires_at IS NULL",
      "FROM dasher.agent_run_events AS claim_event",
      "claim_event.event_kind = 'lease_acquired'",
      "claim_event.claim_operation_kind = 'ordinary_claim'",
      "claim_event.claim_result_state = 'running'",
      "claim_event.claim_result_lease_epoch = p_lease_epoch",
      "claim_event.claim_result_attempt_token = p_attempt_token",
      "'dasher.agent-run-ordinary-claim-input.v1', 'UTF8'",
      "pg_catalog.convert_to('dasher.agent-run-claim-result.v1', 'UTF8')",
    ]) {
      expect(reauthorize, guard).toContain(guard);
    }

    // The two claim_agent_run locking sites keep capability 'claim', so the
    // new branch is unreachable for them.
    const claim = section(
      "CREATE FUNCTION dasher_run_api.claim_agent_run(",
      "CREATE FUNCTION dasher_run_api.get_claimed_agent_run_input(",
    );
    expect(claim).toContain(
      "PERFORM dasher_private.initialize_run_operator_context_v1(\n" +
        "    p_claim_request_id, 'claim'\n" +
        "  );",
    );
    expect(
      claim.split(
        "PERFORM pg_catalog.set_config('dasher.run_phase', 'locking', true);",
      ).length - 1,
    ).toBe(2);
    expect(claim).not.toContain("'reconcile'");
    expect(
      Array.from(
        sql.matchAll(
          /initialize_run_operator_context_v1\([\s\S]{0,80}?'([a-z_]+)'\s*\)/gu,
        ),
        (match) => match[1],
      ).filter((capability) => capability === "reconcile"),
      "reconcile capability has exactly one setter",
    ).toHaveLength(1);
  });

  it("pins the agent_runs run-definer write gate to the authorized write path", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const section = (start: string, end: string): string => {
      const startIndex = sql.indexOf(start);
      const endIndex = sql.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return sql.slice(startIndex, endIndex);
    };
    const definerUpdate = section(
      "CREATE POLICY agent_runs_run_definer_update",
      "CREATE POLICY agent_runs_retention_definer_select",
    );

    const expectedDefinerUpdate = [
      "CREATE POLICY agent_runs_run_definer_update",
      "ON dasher.agent_runs",
      "AS PERMISSIVE FOR UPDATE TO dasher_run_definer",
      "USING (",
      "  dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id)",
      "  OR (",
      "    current_user = 'dasher_run_definer'::name",
      "    AND current_setting('dasher.run_phase', true) = 'locking'",
      "    AND organization_id = NULLIF(current_setting(",
      "      'dasher.run_organization_id', true",
      "    ), '')::uuid",
      "    AND dashboard_id = NULLIF(current_setting(",
      "      'dasher.run_dashboard_id', true",
      "    ), '')::uuid",
      "    AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid",
      "  )",
      "  OR (",
      "    current_user = 'dasher_run_definer'::name",
      "    AND current_setting('dasher.run_phase', true) = 'replay_source_read'",
      "    AND organization_id = NULLIF(current_setting(",
      "      'dasher.run_organization_id', true",
      "    ), '')::uuid",
      "    AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid",
      "    AND run_id = NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid",
      "  )",
      ")",
      "WITH CHECK (dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id));",
      "",
    ].join("\n");

    // 1. Byte-for-byte with the migration text.
    expect(definerUpdate).toBe(expectedDefinerUpdate);

    // 2. WITH CHECK is exactly the authorized write gate — nothing else.
    const withCheckIndex = definerUpdate.indexOf("\nWITH CHECK (");
    expect(withCheckIndex).toBeGreaterThan(0);
    const usingClause = definerUpdate.slice(0, withCheckIndex);
    const withCheckClause = definerUpdate.slice(withCheckIndex + 1);
    expect(withCheckClause).toBe(
      "WITH CHECK (dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id));\n",
    );

    // 3. The replay fence widens reads only; it may never widen writes.
    expect(
      usingClause.split("'replay_source_read'").length - 1,
      "exactly one replay_source_read branch in USING",
    ).toBe(1);
    expect(withCheckClause).not.toContain("replay_source_read");
    expect(withCheckClause).not.toContain("'locking'");
    expect(withCheckClause).not.toContain("current_setting");

    // 4. dasher_run_definer gets UPDATE on agent_runs and nothing wider.
    const runDefinerCommands = Array.from(
      sql.matchAll(
        /^CREATE POLICY [a-z0-9_]+\nON dasher[.]agent_runs\nAS PERMISSIVE FOR ([A-Z]+) TO ([^\n]+)\n/gmu,
      ),
    )
      .filter(([, , roles]) => (roles ?? "").includes("dasher_run_definer"))
      .map(([, command]) => command);
    expect(new Set(runDefinerCommands)).toEqual(new Set(["SELECT", "UPDATE"]));
    expect(runDefinerCommands).not.toContain("INSERT");
    expect(runDefinerCommands).not.toContain("DELETE");
    expect(runDefinerCommands).not.toContain("ALL");
  });

  it("keeps the post-reauthorization policy-row lock exact and lock-only", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const section = (start: string, end: string): string => {
      const startIndex = sql.indexOf(start);
      const endIndex = sql.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return sql.slice(startIndex, endIndex);
    };
    const policyRevisionVisibility = section(
      "CREATE POLICY agent_run_policy_revisions_run_definer_select",
      "CREATE POLICY agent_run_policy_revisions_run_lock_update",
    );
    const policyRevisionLock = section(
      "CREATE POLICY agent_run_policy_revisions_run_lock_update",
      "CREATE POLICY memberships_run_reauthorization_select",
    );
    const reauthorize = section(
      "CREATE FUNCTION dasher_private.reauthorize_agent_run_v1(",
      "CREATE FUNCTION dasher_private.replay_source_fence_v1(",
    );
    const reserve = section(
      "CREATE FUNCTION dasher_run_api.reserve_agent_run_attempt(",
      "CREATE FUNCTION dasher_run_api.start_agent_run_attempt(",
    );
    const reauthorizeCall = reserve.indexOf(
      "PERFORM dasher_private.reauthorize_agent_run_v1(",
    );
    const runRelock = reserve.indexOf(
      "SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run",
      reauthorizeCall,
    );
    const policyRelock = reserve.indexOf(
      "SELECT policy.* INTO STRICT v_policy",
      runRelock,
    );

    expect(reauthorize).toMatch(
      /set_config\('dasher[.]run_phase', 'authorized', true\);\s*END\s*\$function\$/u,
    );
    expect(reauthorizeCall).toBeGreaterThanOrEqual(0);
    expect(runRelock).toBeGreaterThan(reauthorizeCall);
    expect(policyRelock).toBeGreaterThan(runRelock);
    expect(reserve.slice(policyRelock)).toMatch(
      /WHERE policy[.]policy_revision = v_run[.]policy_revision\s+FOR UPDATE/u,
    );

    expect(policyRevisionVisibility).toContain(
      "current_setting('dasher.run_phase', true) IN ('locking','authorized','checkpoint_replay')",
    );
    expect(policyRevisionVisibility).toContain(
      "policy_revision >= NULLIF(current_setting(",
    );
    expect(policyRevisionVisibility).toContain(
      "COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''",
    );
    expect(policyRevisionVisibility).toContain(
      "'dasher.run_principal_revision', true",
    );
    expect(policyRevisionVisibility).toContain(
      "COALESCE(current_setting('dasher.run_capability', true), '') <> ''",
    );

    expect(policyRevisionLock).toContain(
      "current_user = 'dasher_run_definer'::name",
    );
    expect(policyRevisionLock).toContain(
      "current_setting('dasher.run_phase', true) IN ('locking','authorized')",
    );
    expect(policyRevisionLock).toContain(
      "policy_revision = NULLIF(current_setting(",
    );
    expect(policyRevisionLock).not.toContain(
      "policy_revision >= NULLIF(current_setting(",
    );
    expect(policyRevisionLock).toContain(
      "current_user = 'dasher_security_definer'::name",
    );
    expect(policyRevisionLock).toMatch(/WITH CHECK \(false\);\s*$/u);
  });

  it("mechanically binds retry, cancellation, checkpoint, and graph semantics", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const section = (start: string, end: string): string => {
      const startIndex = sql.indexOf(start);
      const endIndex = sql.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return sql.slice(startIndex, endIndex);
    };
    const reserve = section(
      "CREATE FUNCTION dasher_run_api.reserve_agent_run_attempt(",
      "CREATE FUNCTION dasher_run_api.start_agent_run_attempt(",
    );
    const cancel = section(
      "CREATE FUNCTION dasher_api.cancel_agent_run(",
      "CREATE FUNCTION dasher_api.get_agent_run(",
    );
    const checkpoint = section(
      "CREATE FUNCTION dasher_run_api.write_agent_run_checkpoint(",
      "CREATE FUNCTION dasher_run_api.commit_agent_brief(",
    );
    const graph = section(
      "CREATE FUNCTION dasher_private.validate_metric_contract_graph_v1(",
      "CREATE FUNCTION dasher_run_api.commit_calculation_graph(",
    );
    const commitGraph = section(
      "CREATE FUNCTION dasher_run_api.commit_calculation_graph(",
      "CREATE FUNCTION dasher_run_api.commit_agent_candidate(",
    );
    const closeCandidateSet = section(
      "CREATE FUNCTION dasher_run_api.close_agent_candidate_set(",
      "CREATE FUNCTION dasher_run_api.commit_candidate_claims(",
    );
    const runAuthorization = section(
      "CREATE FUNCTION dasher_private.run_policy_allows_v1(",
      "CREATE FUNCTION dasher_private.retention_policy_allows_v1(",
    );
    const policyRevisionVisibility = section(
      "CREATE POLICY agent_run_policy_revisions_run_definer_select",
      "CREATE POLICY agent_run_policy_revisions_run_lock_update",
    );

    expect(reserve).toContain("v_retry_of_attempt_id");
    expect(reserve).toContain(
      "v_retry_attempt.candidate_slot IS DISTINCT FROM v_candidate_slot",
    );
    expect(reserve).toContain(
      "v_request - 'attempt_id' - 'retry_of_attempt_id'",
    );
    expect(reserve).toContain("attempt.retry_of_attempt_id IS NOT NULL");
    expect(reserve).not.toMatch(/COALESCE\([^)]*candidate_slot[^)]*,\s*1\)/u);
    expect(cancel).toContain("'approval_required'");
    expect(cancel).toContain(
      "ORDER BY pg_catalog.uuid_send(attempt.attempt_id) FOR UPDATE",
    );
    expect(cancel).toContain("'attempt_cancelled_charged'");
    expect(cancel).toContain("'attempt_cancelled_released'");
    expect(cancel).toContain("COALESCE(component.outstanding_units, 0) <> 0");
    expect(cancel).toContain("audit.outcome <> 'succeeded'");
    expect(checkpoint).toContain("'dasher.agent-run-checkpoint.v1'");
    expect(checkpoint).toContain("'dasher.retained-payload-envelope.v1'");
    expect(checkpoint).toContain("v_expected_checkpoint_bytes");
    expect(checkpoint).toContain("v_state_sha");
    expect(checkpoint).not.toContain("p_checkpoint_sha256");
    expect(graph).toContain("v_allowed_keys");
    expect(graph).toContain("prior.ordinal >= v_node.ordinal");
    expect(graph).toContain("canonical_jsonb_bytes_v1");
    expect(graph).toContain("'unavailable','missing','null','present','stale'");
    expect(graph).toContain("'coefficient','scale'");
    expect(graph).not.toContain(phase7R7Fixture.hashes.result);
    expect(commitGraph).toContain("metric_contract_versions");
    expect(commitGraph).toContain("field_catalog_entries");
    expect(commitGraph).toContain("candidate_comparison_bundle_evidence");
    expect(commitGraph).toContain("member.freshness = 'current'");
    expect(commitGraph).toContain("v_freshness_classifier_node_id");
    expect(commitGraph).toContain("v_outputs_bytes");
    expect(commitGraph).toContain("pg_catalog.octet_length(v_outputs_bytes)");
    expect(commitGraph).toContain("v_expected_scanned_rows");
    expect(commitGraph).toContain("+ 64 * (p_meter_vector).node_count");
    expect(closeCandidateSet).toContain(
      "SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run",
    );
    expect(closeCandidateSet).toContain("AND run.run_id = p_run_id FOR UPDATE");
    expect(closeCandidateSet).toContain(
      "'dasher.run_next_state', 'validating', true",
    );
    expect(closeCandidateSet).not.toMatch(
      /FROM dasher[.](?:briefs|candidate_comparison_bundles)[\s\S]{0,320}FOR UPDATE/u,
    );
    expect(sql).toContain(
      "CREATE FUNCTION dasher_private.canonical_jsonb_bytes_v1(",
    );
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA dasher, dasher_private TO dasher_run_definer",
    );
    expect(sql).not.toContain("freshness IN ('fresh', 'stale')");
    expect(sql).toContain(
      "CREATE CONSTRAINT TRIGGER calculation_graph_contract_constraint",
    );
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(graph).toContain("|| pg_catalog.decode('00', 'hex')");
    expect(graph).toContain("v_meter.meter_sha256 <> v_result.meter_sha256");
    expect(sql).toContain(
      "CREATE FUNCTION dasher_private.evaluate_calculation_graph_v1(",
    );
    expect(commitGraph).toContain(
      "dasher_private.evaluate_calculation_graph_v1(",
    );
    expect(runAuthorization).toContain(
      "later.policy_revision > policy.policy_revision",
    );
    // The write gate admits exactly two phases; 'replay_source_read' must
    // never join this whitelist (the fence is a read-only widening).
    expect(runAuthorization).toContain(
      "    AND current_setting('dasher.run_phase', true) IN (\n" +
        "      'authorized', 'checkpoint_replay'\n" +
        "    )\n",
    );
    expect(
      runAuthorization.split("current_setting('dasher.run_phase'").length - 1,
      "run_policy_allows_v1 reads the run phase exactly once",
    ).toBe(1);
    expect(runAuthorization).not.toContain("replay_source_read");
    expect(runAuthorization).not.toContain("'locking'");
    expect(runAuthorization).not.toContain("'discovering'");
    expect(policyRevisionVisibility).toContain(
      "policy_revision >= NULLIF(current_setting(",
    );
    expect(policyRevisionVisibility).not.toMatch(
      /policy_revision\s*=\s*NULLIF\(current_setting/u,
    );
  });

  it("independently fixes the event preimage to signed epoch microseconds and raw hashes", () => {
    const uuidBytes = (value: string): Buffer =>
      Buffer.from(value.replaceAll("-", ""), "hex");
    const int32 = (value: number): Buffer => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      return bytes;
    };
    const int64 = (value: bigint): Buffer => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigInt64BE(value);
      return bytes;
    };
    const eventKind = Buffer.from("attempt_indeterminate", "utf8");
    const payloadEnvelopeSha = Buffer.alloc(32, 0x11);
    const epochMicros = 1_786_106_096_123_456n;
    const exactPreimage = Buffer.concat([
      Buffer.from("dasher.agent-run-event.v1\0", "utf8"),
      uuidBytes("00000000-0000-8000-8000-000000000001"),
      int64(7n),
      int32(eventKind.length),
      eventKind,
      int64(epochMicros),
      Buffer.from([0]),
      Buffer.from([0]),
      payloadEnvelopeSha,
    ]);
    const incompatiblePreimage = Buffer.concat([
      Buffer.from("dasher.agent-run-event.v1\0", "utf8"),
      uuidBytes("00000000-0000-8000-8000-000000000001"),
      int64(7n),
      int32(eventKind.length),
      eventKind,
      Buffer.from("2026-08-07T12:34:56.123456Z", "utf8"),
      Buffer.from([0]),
      Buffer.from([0]),
      int32(payloadEnvelopeSha.length),
      payloadEnvelopeSha,
    ]);

    expect(createHash("sha256").update(exactPreimage).digest("hex")).toBe(
      "07bd74401b794b254dfa8595b0e4074543df8654b62c66312336e3b16bd71f80",
    );
    expect(
      createHash("sha256").update(incompatiblePreimage).digest("hex"),
    ).toBe("79794785741a45ea5ee8696a5b31bc7a1390107170fe598eae39c5d4b4bc7434");
    expect(exactPreimage).not.toEqual(incompatiblePreimage);
  });

  it("keeps replay transitions, set rows, and claim statement operands executable", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const section = (start: string, end: string): string => {
      const startIndex = sql.indexOf(start);
      const endIndex = sql.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return sql.slice(startIndex, endIndex);
    };
    const transition = section(
      "CREATE FUNCTION dasher_private.agent_run_transition_guard_v1()",
      "CREATE FUNCTION dasher_private.agent_run_mutable_guard_v1()",
    );
    const listReplay = section(
      "CREATE FUNCTION dasher_run_api.list_claimed_replay_results(",
      "CREATE FUNCTION dasher_run_api.consume_agent_replay_result(",
    );
    const claims = section(
      "CREATE FUNCTION dasher_run_api.commit_candidate_claims(",
      "CREATE FUNCTION dasher_private.validate_candidate_claim_rows_v1(",
    );

    expect(transition).toContain(
      "v_event_kind = 'replay_prerequisites_cloned' AND NOT (",
    );
    expect(transition).toContain(
      "OLD.state = 'authorized' AND NEW.state = 'planning'",
    );
    expect(transition).toContain(
      "OLD.state IN ('generating','revising') AND NEW.state = 'validating'",
    );
    expect(listReplay).toMatch(
      /RETURN QUERY\s+SELECT\s+v_source[.]run_id, result[.]result_sequence,/u,
    );
    expect(listReplay).not.toMatch(
      /RETURN QUERY\s+SELECT ROW\([\s\S]*replay_source_result/u,
    );
    expect(claims).toContain("(claim.value->>'json_pointer') || ' sha256:'");
    expect(claims).toContain("|| (claim.value->>'assertion_sha256')");
    expect(claims).toContain("dasher_private.validate_calculated_claim_v1(");
  });

  it("reduces indeterminate attempts transactionally and rejects retry identity drift", () => {
    type AttemptProjection = {
      state: string;
      used: readonly bigint[];
      released: readonly bigint[];
    };
    const zero = Array<bigint>(14).fill(0n);
    const reserved = [
      1n,
      1n,
      0n,
      0n,
      0n,
      6_000n,
      3_000n,
      3_000n,
      6_000n,
      3_000n,
      9_000n,
      9_000n,
      8_000n,
      24_000n,
    ];
    const reduce = (
      events: readonly { kind: string; attemptId: string }[],
    ): { runState: string; attempt: AttemptProjection } => {
      let runState = "authorized";
      let attempt: AttemptProjection = {
        state: "absent",
        used: zero,
        released: zero,
      };
      for (const event of events) {
        if (event.kind === "attempt_reserved") {
          runState = "generating";
          attempt = {
            state: "reserved_pre_dispatch",
            used: zero,
            released: zero,
          };
        } else if (event.kind === "attempt_dispatch_started") {
          attempt = { ...attempt, state: "dispatch_started" };
        } else if (event.kind === "attempt_indeterminate") {
          runState = "failed";
          attempt = {
            state: "indeterminate_quarantined",
            used: reserved.map((value, index) => (index === 1 ? 0n : value)),
            released: reserved.map((value, index) =>
              index === 1 ? value : 0n,
            ),
          };
        }
        expect(event.attemptId).toBe("00000000-0000-8000-8000-000000000501");
      }
      return { runState, attempt };
    };
    const projection = reduce([
      {
        kind: "attempt_reserved",
        attemptId: "00000000-0000-8000-8000-000000000501",
      },
      {
        kind: "attempt_dispatch_started",
        attemptId: "00000000-0000-8000-8000-000000000501",
      },
      {
        kind: "attempt_indeterminate",
        attemptId: "00000000-0000-8000-8000-000000000501",
      },
    ]);
    expect(projection).toMatchObject({
      runState: "failed",
      attempt: { state: "indeterminate_quarantined" },
    });
    expect(projection.attempt.used[1]).toBe(0n);
    expect(projection.attempt.released[1]).toBe(1n);
    expect(
      projection.attempt.used.reduce((sum, value) => sum + value, 0n) +
        projection.attempt.released.reduce((sum, value) => sum + value, 0n),
    ).toBe(reserved.reduce((sum, value) => sum + value, 0n));

    const prior = {
      schema: "attempt-request-v1",
      attempt_id: "00000000-0000-8000-8000-000000000501",
      retry_of_attempt_id: null,
      attempt_kind: "generator",
      candidate_slot: "i64:1",
      adapter_id: "task9-fake-adapter-v1",
      model_id: "task9-fake-model-v1",
      policy_revision: "i64:1",
      price_book_revision: "task9-price-v1",
      input_sha256: "11".repeat(32),
      common_bundle_sha256: "22".repeat(32),
      brief_sha256: "33".repeat(32),
      instructions_sha256: "44".repeat(32),
    };
    const retryBindings = (request: Record<string, unknown>): string =>
      JSON.stringify({
        ...request,
        attempt_id: undefined,
        retry_of_attempt_id: undefined,
      });
    const exactRetry = {
      ...prior,
      attempt_id: "00000000-0000-8000-8000-000000000502",
      retry_of_attempt_id: prior.attempt_id,
    };
    const driftedRetry = {
      ...exactRetry,
      common_bundle_sha256: "23".repeat(32),
    };
    expect(retryBindings(exactRetry)).toBe(retryBindings(prior));
    expect(retryBindings(driftedRetry)).not.toBe(retryBindings(prior));
  });

  it("recomputes the frozen calculation output from graph and input semantics", () => {
    type Decimal = { coefficient: string; scale: string };
    const thousandths = (value: Decimal): bigint => {
      const scale = Number(value.scale.slice(4));
      expect(scale).toBeLessThanOrEqual(3);
      return BigInt(value.coefficient) * 10n ** BigInt(3 - scale);
    };
    const input = JSON.parse(phase7R7LiteralFixture.bytes.input) as {
      rows: { values: { field_id: string; value: Decimal }[] }[];
    };
    const graph = JSON.parse(phase7R7LiteralFixture.bytes.graph) as {
      nodes: { op: string; field_id?: string; rate?: Decimal }[];
    };
    const amountField = graph.nodes.find(
      (node) => node.op === "field",
    )?.field_id;
    const rate = graph.nodes.find(
      (node) => node.op === "currency_convert",
    )?.rate;
    expect(amountField).toBeDefined();
    expect(rate).toBeDefined();
    const sourceThousandths = input.rows.map((row) => {
      const cell = row.values.find((item) => item.field_id === amountField);
      expect(cell).toBeDefined();
      return thousandths(cell!.value);
    });
    const usdThousandths = sourceThousandths.reduce(
      (sum, value) => sum + value,
      0n,
    );
    const rateScale = BigInt(Number(rate!.scale.slice(4)));
    const divisor = 10n ** rateScale;
    const convertedNumerator = usdThousandths * BigInt(rate!.coefficient);
    const quotient = convertedNumerator / divisor;
    const remainder = convertedNumerator % divisor;
    const eurThousandths =
      remainder * 2n > divisor ||
      (remainder * 2n === divisor && quotient % 2n !== 0n)
        ? quotient + 1n
        : quotient;
    const output = JSON.parse(phase7R7LiteralFixture.bytes.output) as {
      rows: { value: { value: Decimal } }[];
    };
    expect(usdThousandths).toBe(100_000n);
    expect(eurThousandths).toBe(92_500n);
    expect(thousandths(output.rows[0]!.value.value)).toBe(eurThousandths);

    const mutatedRate = { ...rate!, coefficient: "924" };
    expect(
      (usdThousandths * BigInt(mutatedRate.coefficient)) / divisor,
    ).not.toBe(eurThousandths);
  });

  it("validates all fourteen calculated-claim fields against pointer and output bytes", () => {
    const semanticRowHash = (domain: string, bytes: string): string => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(Buffer.byteLength(bytes));
      return createHash("sha256")
        .update(domain, "utf8")
        .update("\0", "utf8")
        .update(length)
        .update(bytes, "utf8")
        .digest("hex");
    };
    const evidenceId = "00000000-0000-8000-8000-000000000106";
    const candidate = {
      pages: [
        {
          components: [
            {
              metrics: [
                {
                  label: "EUR total",
                  value: "92.5",
                  evidenceIds: [evidenceId],
                },
              ],
            },
          ],
        },
      ],
    };
    const pointer = "/pages/0/components/0/metrics/0";
    const subtree = pointer
      .slice(1)
      .split("/")
      .reduce<unknown>((value, segment) => {
        if (Array.isArray(value)) return value[Number(segment)];
        return (value as Record<string, unknown>)[segment];
      }, candidate) as Record<string, unknown>;
    const assertionBytes = JSON.stringify(subtree);
    const assertionSha = semanticRowHash(
      "dasher.material-assertion.v1",
      assertionBytes,
    );
    const claim = {
      claim_id: "00000000-0000-8000-8000-000000000701",
      json_pointer: pointer,
      assertion_sha256: assertionSha,
      label: "calculated",
      statement: `${pointer} sha256:${assertionSha}`,
      salience: "high",
      evidence_state: "complete",
      calculation_result_id: phase7R7Fixture.resultId,
      calculation_output_identity_kind: "scalar_row",
      calculation_output_node_id: phase7R7LiteralFixture.sourceRows.fxNodeId,
      calculation_output_sha256: phase7R7Fixture.hashes.output as string,
      calculation_output_row_id: "4c5b6acc-0c61-8c42-a6b6-35d927aed9fb",
      calculation_output_field_id: null,
      calculation_output_value_sha256: phase7R7Fixture.hashes.outputValue,
    };
    const validate = (
      candidateValue: typeof candidate,
      claimValue: typeof claim,
      edges: readonly string[],
    ): boolean => {
      if (Object.keys(claimValue).length !== 14) return false;
      if (
        claimValue.statement !==
        `${claimValue.json_pointer} sha256:${claimValue.assertion_sha256}`
      )
        return false;
      const selected = claimValue.json_pointer
        .slice(1)
        .split("/")
        .reduce<unknown>((value, segment) => {
          if (Array.isArray(value)) return value[Number(segment)];
          return (value as Record<string, unknown> | undefined)?.[segment];
        }, candidateValue) as Record<string, unknown> | undefined;
      return (
        selected?.label === "EUR total" &&
        selected.value === "92.5" &&
        JSON.stringify(selected.evidenceIds) === JSON.stringify([evidenceId]) &&
        claimValue.calculation_result_id === phase7R7Fixture.resultId &&
        claimValue.calculation_output_node_id ===
          phase7R7LiteralFixture.sourceRows.fxNodeId &&
        claimValue.calculation_output_sha256 ===
          semanticRowHash(
            "dasher.calculation-output.v1",
            phase7R7LiteralFixture.bytes.output,
          ) &&
        claimValue.calculation_output_value_sha256 ===
          semanticRowHash(
            "dasher.calculation-output-value.v1",
            phase7R7LiteralFixture.bytes.outputValue,
          ) &&
        edges.length === 1 &&
        edges[0] === evidenceId
      );
    };

    expect(validate(candidate, claim, [evidenceId])).toBe(true);
    expect(
      validate(
        {
          pages: [
            {
              components: [
                {
                  metrics: [
                    {
                      label: "EUR total",
                      value: "92.4",
                      evidenceIds: [evidenceId],
                    },
                  ],
                },
              ],
            },
          ],
        },
        claim,
        [evidenceId],
      ),
    ).toBe(false);
    expect(validate(candidate, claim, [])).toBe(false);
    expect(
      validate(
        candidate,
        { ...claim, calculation_output_sha256: "00".repeat(32) },
        [evidenceId],
      ),
    ).toBe(false);
  });

  it("keeps event bodies readable only by the fixed checkpoint path", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const functions = phase7FixedFunctionDefinitions(sql);
    const payloadRelation = "dasher.agent_run_event_payloads";
    const payloadMutations =
      /(?:INSERT\s+INTO|DELETE\s+FROM)\s+dasher[.]agent_run_event_payloads/gu;
    const checkpointName = "dasher_run_api.write_agent_run_checkpoint";
    const checkpoint = functions.get(checkpointName) ?? "";
    const functionDeclarationCount = (
      sql.match(/^CREATE (?:OR REPLACE )?FUNCTION /gmu) ?? []
    ).length;

    expect(functions.size).toBe(functionDeclarationCount);
    expect(functions.size).toBe(68);
    for (const [name, definition] of functions) {
      if (name === checkpointName) continue;
      expect(
        definition.replace(payloadMutations, ""),
        `${name} has a non-mutation event-payload dependency`,
      ).not.toContain(payloadRelation);
    }
    expect(checkpoint).toMatch(
      /JOIN\s+dasher[.]agent_run_event_payloads\s+AS\s+payload/gu,
    );
    expect(
      functions
        .get("dasher_private.append_agent_run_event_v1")
        ?.match(/INSERT\s+INTO\s+dasher[.]agent_run_event_payloads/gu),
    ).toHaveLength(1);
    expect(
      functions
        .get("dasher_retention_api.purge_dashboard")
        ?.match(/DELETE\s+FROM\s+dasher[.]agent_run_event_payloads/gu),
    ).toHaveLength(1);

    const policyStart = sql.indexOf(
      "CREATE POLICY agent_run_event_payloads_run_definer_select",
    );
    const policyEnd = sql.indexOf(
      "CREATE POLICY agent_run_events_run_claim_retry_select",
      policyStart,
    );
    const policy = sql.slice(policyStart, policyEnd);
    expect(policyStart).toBeGreaterThanOrEqual(0);
    expect(policyEnd).toBeGreaterThan(policyStart);
    expect(policy).toContain("AS PERMISSIVE FOR SELECT TO dasher_run_definer");
    expect(policy).toContain("current_user = 'dasher_run_definer'::name");
    expect(policy).toMatch(
      /dasher_private[.]run_policy_allows_v1\(\s*organization_id, dashboard_id, run_id\s*\)/u,
    );
    expect(policy).toContain(
      "current_setting('dasher.run_phase', true) = 'checkpoint_replay'",
    );
    expect(policy).toMatch(
      /event_sequence BETWEEN 1\s+AND NULLIF\(current_setting\('dasher[.]run_source_event_sequence', true\), ''\)::bigint/u,
    );
    expect(policy).not.toMatch(
      /dasher_security_definer|dasher_retention_definer|replay_source_read/u,
    );

    const payloadGrants = Array.from(
      sql.matchAll(
        /GRANT[^;]+ON TABLE dasher[.]agent_run_event_payloads TO [^;]+;/gu,
      ),
      (match) => match[0].replace(/\s+/gu, " ").trim(),
    ).sort();
    expect(payloadGrants).toEqual(
      [
        "GRANT DELETE ON TABLE dasher.agent_run_event_payloads TO dasher_retention_definer;",
        "GRANT INSERT ON TABLE dasher.agent_run_event_payloads TO dasher_retention_definer;",
        "GRANT INSERT ON TABLE dasher.agent_run_event_payloads TO dasher_run_definer;",
        "GRANT INSERT ON TABLE dasher.agent_run_event_payloads TO dasher_security_definer;",
        "GRANT SELECT ( organization_id, dashboard_id, run_id, event_payload_id, event_id, event_sequence, content_nonce, canonical_bytes, payload_sha256 ) ON TABLE dasher.agent_run_event_payloads TO dasher_run_definer;",
      ].sort(),
    );
    expect(checkpoint).toContain(
      "PERFORM pg_catalog.set_config('dasher.run_phase', 'checkpoint_replay', true)",
    );
    expect(sql).toContain(
      "ALTER FUNCTION dasher_run_api.write_agent_run_checkpoint(uuid, bigint, bytea, bigint, bytea, bytea) OWNER TO dasher_run_definer;",
    );
  });

  it("binds body-free retries to semantic rows and immutable transition headers", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const functions = phase7FixedFunctionDefinitions(sql);
    const functionBody = (name: string): string => {
      const definition = functions.get(name);
      expect(definition, name).toBeDefined();
      return definition ?? "";
    };
    const retryProfiles = [
      {
        name: "dasher_run_api.reserve_agent_run_attempt",
        tokens: [
          "v_existing_request_payload.canonical_bytes",
          "v_existing_request_payload.payload_sha256",
          "event.event_kind = 'attempt_reserved'",
          "event.occurred_at = v_existing.reserved_at",
        ],
      },
      {
        name: "dasher_run_api.start_agent_run_attempt",
        tokens: [
          "v_expected_dispatch_sha <> p_dispatch_request_sha256",
          "v_attempt.dispatch_ready_at IS NULL",
          "event.event_kind = 'attempt_dispatch_prepared'",
          "event.occurred_at = v_attempt.dispatch_ready_at",
        ],
      },
      {
        name: "dasher_run_api.authorize_agent_run_attempt_invocation",
        tokens: [
          "v_expected_dispatch_sha <> p_dispatch_request_sha256",
          "v_attempt.dispatch_started_at IS NULL",
          "event.event_kind = 'attempt_dispatch_started'",
          "event.occurred_at = v_attempt.dispatch_started_at",
        ],
      },
      {
        name: "dasher_run_api.reconcile_agent_run_attempt",
        tokens: [
          "v_expected_dispatch_sha := pg_catalog.sha256(",
          "'dasher.attempt-dispatch-request.v1'",
          "v_attempt.dispatch_started_at IS NULL",
          "event.occurred_at = v_attempt.dispatch_started_at",
          "v_stored_result.result_sha256 IS DISTINCT FROM v_result_semantic_sha",
          "v_attempt.actual_vector IS DISTINCT FROM v_actual",
        ],
      },
      {
        name: "dasher_run_api.clone_claimed_replay_prerequisites",
        tokens: [
          "v_local_bundle.canonical_bytes <> v_bundle.canonical_bytes",
          "v_local_members IS DISTINCT FROM v_source_members",
          "event.event_kind = 'replay_prerequisites_cloned'",
          "event.occurred_at = v_local_bundle.created_at",
        ],
      },
      {
        name: "dasher_run_api.commit_agent_candidate",
        tokens: [
          "v_existing_payload.canonical_bytes <>",
          "v_existing.material_claim_set_sha256 <> v_claim_set_sha",
          "event.event_kind = 'candidate_committed'",
          "event.occurred_at = v_existing.created_at",
        ],
      },
      {
        name: "dasher_run_api.commit_candidate_claims",
        tokens: [
          "v_existing_claims <> v_body->'claims'",
          "claim.claim_set_sha256 <> v_sha",
          "event.event_kind = 'candidate_claims_committed'",
          "event.occurred_at = claim.created_at",
        ],
      },
      {
        name: "dasher_api.cancel_agent_run",
        tokens: [
          "v_run.tenant_cancel_operation_sha256 <> v_operation_sha",
          "v_run.tenant_cancel_result_sha256 <> v_expected_result_sha",
          "v_cancel_event.event_id <> p_cancel_operation_and_audit_id",
          "v_operation_audit.content_sha256 <> v_operation_sha",
        ],
      },
    ] as const;

    for (const profile of retryProfiles) {
      const definition = functionBody(profile.name);
      for (const token of profile.tokens) {
        expect(definition, `${profile.name}: ${token}`).toContain(token);
      }
    }
    expect(
      functionBody("dasher_run_api.clone_claimed_replay_prerequisites"),
    ).not.toContain("'checkpoint_replay'");

    const reauthorize = functionBody("dasher_private.reauthorize_agent_run_v1");
    expect(reauthorize).toContain("'dasher.agent-run-ordinary-claim-input.v1'");
    expect(reauthorize).toContain("claim_event.claim_input_sha256");
    expect(reauthorize).toContain("claim_event.claim_result_sha256");
    expect(reauthorize).toContain("claim_event.claim_result_state = 'running'");
    expect(reauthorize).toContain(
      "claim_event.claim_result_input_sha256 =\n          claim_event.claim_input_sha256",
    );
    expect(reauthorize).toContain("claim_event.claim_result_lease_expires_at");
    expect(functionBody("dasher_private.replay_source_fence_v1")).toContain(
      "pg_catalog.count(event.event_payload_id) =\n          v_source.current_event_sequence",
    );
  });

  it("derives payload purge accounting from headers under exact-dashboard RLS", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const functions = phase7FixedFunctionDefinitions(sql);
    const purge = functions.get("dasher_retention_api.purge_dashboard") ?? "";
    const ageOut =
      functions.get(
        "dasher_retention_api.age_out_dashboard_agent_run_metadata",
      ) ?? "";
    const retentionPolicy = sql.slice(
      sql.indexOf(
        "CREATE POLICY agent_run_event_payloads_retention_definer_delete",
      ),
      sql.indexOf(
        "CREATE POLICY agent_run_checkpoints_security_definer_select",
      ),
    );
    const retentionFence =
      functions.get("dasher_private.retention_policy_allows_v1") ?? "";

    expect(purge).toMatch(
      /'agent_run_event_payloads',\s*\(SELECT pg_catalog[.]count\(\*\)\s+FROM dasher[.]agent_run_events AS event\s+WHERE event[.]organization_id = v_organization_id\s+AND event[.]dashboard_id = \$1\s+AND event[.]event_payload_id IS NOT NULL\)/u,
    );
    expect(
      purge.replace(/DELETE\s+FROM\s+dasher[.]agent_run_event_payloads/gu, ""),
    ).not.toContain("dasher.agent_run_event_payloads");
    expect(purge).toMatch(
      /DELETE FROM dasher[.]agent_run_event_payloads;\s*GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;/u,
    );
    expect(ageOut).not.toContain("dasher.agent_run_event_payloads");
    expect(retentionPolicy).toContain(
      "USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))",
    );
    expect(retentionFence).toContain(
      "p_organization_id = NULLIF(current_setting(\n      'dasher.retention_target_organization_id', true",
    );
    expect(retentionFence).toContain(
      "p_dashboard_id = NULLIF(current_setting(\n      'dasher.retention_target_dashboard_id', true",
    );
    expect(sql).toContain(
      "ALTER TABLE dasher.agent_run_event_payloads FORCE ROW LEVEL SECURITY;",
    );
  });

  it("mechanically enforces pointer-first purge and proof-before-age-out deletion", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0007_agent_run_ledger_and_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const purgeStart = sql.indexOf(
      "CREATE OR REPLACE FUNCTION dasher_retention_api.purge_dashboard(",
    );
    const ageOutStart = sql.indexOf(
      "CREATE FUNCTION dasher_retention_api.age_out_dashboard_agent_run_metadata(",
      purgeStart,
    );
    expect(purgeStart).toBeGreaterThanOrEqual(0);
    expect(ageOutStart).toBeGreaterThan(purgeStart);
    const purge = sql.slice(purgeStart, ageOutStart);
    const ageOut = sql.slice(ageOutStart);
    const expectOrdered = (source: string, tokens: readonly string[]): void => {
      let cursor = -1;
      for (const token of tokens) {
        const next = source.indexOf(token, cursor + 1);
        expect(next, token).toBeGreaterThan(cursor);
        cursor = next;
      }
    };

    expectOrdered(purge, [
      "UPDATE dasher.agent_runs AS run",
      "UPDATE dasher.agent_run_events AS event",
      "UPDATE dasher.agent_run_checkpoints AS checkpoint",
      "UPDATE dasher.agent_run_attempts AS attempt",
      "DELETE FROM dasher.candidate_evidence_manifests",
      "DELETE FROM dasher.claim_evidence",
      "DELETE FROM dasher.claims",
      "DELETE FROM dasher.agent_validation_findings",
      "DELETE FROM dasher.agent_candidate_payloads",
      "DELETE FROM dasher.agent_candidates",
      "DELETE FROM dasher.agent_run_calculation_meters",
      "DELETE FROM dasher.calculation_results",
      "DELETE FROM dasher.calculation_graphs",
      "DELETE FROM dasher.briefs",
      "DELETE FROM dasher.run_abstentions",
      "DELETE FROM dasher.candidate_comparison_bundle_evidence",
      "DELETE FROM dasher.candidate_comparison_bundles",
      "DELETE FROM dasher.agent_recorded_results",
      "DELETE FROM dasher.agent_run_request_payloads",
      "DELETE FROM dasher.agent_run_attempt_payloads",
      "DELETE FROM dasher.agent_run_checkpoint_payloads",
      "DELETE FROM dasher.agent_run_event_payloads",
      "DELETE FROM dasher.metric_contract_versions",
      "DELETE FROM dasher.field_catalog_entries",
      "DELETE FROM dasher.field_catalog_snapshots",
      "DELETE FROM dasher.snapshot_reference_claims AS claim",
    ]);
    expect(
      purge.match(/GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT/gu),
    ).toHaveLength(21);
    expect(purge).toContain("v_bundle_membership_recheck_sha256");
    expect(purge).toContain("INSERT INTO dasher.backup_deletion_ledger");
    expect(purge).toContain("UPDATE dasher.dashboard_tombstones SET purged_at");
    expectOrdered(ageOut, [
      "INSERT INTO dasher.dashboard_agent_run_age_out_proofs",
      "INSERT INTO dasher.audit_events",
      "SELECT proof.* INTO STRICT v_existing",
      "DELETE FROM dasher.agent_run_attempts",
      "DELETE FROM dasher.agent_run_checkpoints",
      "DELETE FROM dasher.agent_run_budget_counters",
      "DELETE FROM dasher.agent_run_events",
      "DELETE FROM dasher.dashboard_agent_drain_proof_consumptions",
      "DELETE FROM dasher.dashboard_agent_drain_proofs",
      "DELETE FROM dasher.agent_runs",
    ]);
    expect(ageOut).toContain("'dasher.agent-run-retained-chain-set.v1'");
    expect(ageOut).toContain("ledger.event_kind = 'backup.deleted'");
    expect(ageOut).not.toContain("ledger.event_kind = 'backup_deleted'");
  });
});
