import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import {
  discoverMigrations,
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

describe("Task 3, Task 4, and Task 8B canonical migration golden guard", () => {
  it("pins exactly immutable 0001, 0002, and 0003 filenames and source-byte checksums", async () => {
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
    ]);
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
