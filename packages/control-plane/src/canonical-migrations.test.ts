import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { discoverMigrations } from "./migrator.js";
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

describe("Task 3 and Task 4 canonical migration golden guard", () => {
  it("pins exactly immutable 0001 and 0002 filenames and source-byte checksums", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    expect(
      migrations.map((migration) => ({
        sequence: migration.sequence,
        filename: migration.filename,
        checksum: Buffer.from(migration.checksumSha256).toString("hex"),
      })),
    ).toEqual([identityAuditMigration, securityBoundaryMigration]);
  });

  it("contains no extension, credential, or UUID-generation source", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    for (const migration of migrations) {
      expect(migration.sql).not.toMatch(
        /CREATE\s+EXTENSION|gen_random_uuid|uuid_generate|PASSWORD\s+'|sk-proj|BEGIN\s+(?:RSA|OPENSSH)\s+PRIVATE|postgres(?:ql)?:\/\/|DASHER_TEST_(?:OWNER|APP)_DSN/iu,
      );
    }
  });

  it("pins the exact Task 4 function set and closes every persistent function search path", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const functionDefinitions = migrations.flatMap((migration) =>
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
  it("keeps the real canonical directory exactly at immutable 0001 and 0002", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      identityAuditMigration.filename,
      securityBoundaryMigration.filename,
    ]);
    expect(migrations.some((migration) => migration.sequence === 3)).toBe(
      false,
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
    const productionBase = production.slice(
      production.indexOf("const modeled0003StaticCatalogContractBase ="),
      production.indexOf("function catalogCollationIdentity"),
    );
    const productionColumns = productionBase.slice(
      productionBase.indexOf("  columns: ["),
      productionBase.indexOf("\n  types: ["),
    );
    const productionIndexes = productionBase.slice(
      productionBase.indexOf("  indexes: ["),
      productionBase.indexOf("\n  constraints: ["),
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

  it("freezes every modeled catalog category and the closed function owners", () => {
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
          !/closed|exact|context|allowlist|proof/iu.test(constraint.definition),
      ),
    ).toBe(true);
    expect(modeled0003CatalogMatrix.triggers).toHaveLength(19);
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
      execute: ["dasher_retention_operator"],
      identityArguments: "uuid, text, uuid, text",
      owner: "dasher_retention_definer",
      returns: "void",
      schema: "dasher_retention_api",
    });
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
      "NEW.lifecycle_revision <> OLD.lifecycle_revision + 1",
    );
    expect(transitionTrigger).toContain(
      "NEW.cache_epoch = OLD.cache_epoch + 1",
    );
    expect(transitionTrigger).toContain(
      "NEW.capability_epoch = OLD.capability_epoch + 1",
    );
    expect(transitionTrigger).toContain("ROW(\n            NEW.current_kind");

    const retentionTrigger = modeled0003Functions.find(
      (routine) => routine.name === "enforce_retention_mutation",
    )?.source;
    expect(retentionTrigger).toContain(
      "current_user <> 'dasher_retention_definer'::name",
    );
    for (const identity of [
      "OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id",
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
      "OLD.purged_at IS NOT NULL",
      "OLD.purged_lifecycle_revision IS NOT NULL",
      "OLD.purged_proof_sha256 IS NOT NULL",
      "NEW.purged_at IS NULL",
      "NEW.purged_lifecycle_revision IS NULL",
      "NEW.purged_proof_sha256 IS NULL",
      "OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision",
      "OLD.access_revoked_at IS DISTINCT FROM NEW.access_revoked_at",
      "OLD.access_revoked_lifecycle_revision IS DISTINCT FROM NEW.access_revoked_lifecycle_revision",
      "OLD.access_revoked_proof_sha256 IS DISTINCT FROM NEW.access_revoked_proof_sha256",
    ]) {
      expect(retentionTrigger).toContain(exactPurgeTransition);
    }
    const recordedPurgeRewriteMutant = retentionTrigger?.replace(
      "      OR OLD.purged_at IS NOT NULL\n      OR OLD.purged_lifecycle_revision IS NOT NULL\n      OR OLD.purged_proof_sha256 IS NOT NULL\n",
      "",
    );
    const immutableTombstoneMutant = retentionTrigger?.replace(
      "      OR OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision\n",
      "",
    );
    expect(recordedPurgeRewriteMutant).not.toBe(retentionTrigger);
    expect(recordedPurgeRewriteMutant).not.toContain(
      "OLD.purged_proof_sha256 IS NOT NULL",
    );
    expect(immutableTombstoneMutant).not.toBe(retentionTrigger);
    expect(immutableTombstoneMutant).not.toContain(
      "OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision",
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
      columns: ["organization_id"],
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
          (acl.privilege === "UPDATE" || acl.privilege === "DELETE"),
      ),
    ).toBe(false);
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
      "set_config('dasher.retention_phase', 'binding_lookup'",
      "FROM dasher.retention_service_principal_allowlist",
      "ORDER BY principal_revision DESC",
      "WITH RECURSIVE authority_chain",
      "NOT v_enabled",
      "set_config('dasher.retention_phase', 'target_discovery'",
      "FROM dasher.dashboards",
      "pg_advisory_xact_lock(v_organization_gate)",
      "set_config('dasher.retention_phase', 'authorized'",
      "PERFORM 1 FROM dasher.dashboards",
    ].map((fragment) => exactSource.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(exactSource).not.toMatch(
      /FOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)|\bEXECUTE\b|pg_backend_pid|pg_stat_activity/iu,
    );
    expect(
      exactSource.match(/ORDER BY principal_revision DESC/gu),
    ).toHaveLength(1);
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
    ]) {
      expect(exactSource).toContain(
        `current_setting('dasher.${contextKey}', true)`,
      );
    }
    const latestLookup = exactSource.slice(
      exactSource.indexOf(
        "FROM dasher.retention_service_principal_allowlist\n  WHERE binding_kind",
      ),
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
    expect(modeled0003Policies[0]?.using).toContain(
      "dasher.retention_phase'::text, true) = 'binding_lookup'::text",
    );
    const targetDiscoveryPolicy = modeled0003Policies.find(
      (policy) =>
        policy.name === "dashboards_retention_target_discovery_select",
    );
    expect(targetDiscoveryPolicy?.using).toContain(
      "current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])",
    );
    expect(targetDiscoveryPolicy?.using).not.toContain("'initialize'::text");

    const initializerMutants = [
      exactSource.replace(
        "OR NOT v_can_initialize OR NOT v_capability_allowed",
        "OR NOT v_capability_allowed",
      ),
      exactSource.replace(
        "set_config('dasher.retention_capability', $2, true)",
        "set_config('dasher.retention_capability', 'initialize', true)",
      ),
    ];
    expect(initializerMutants[0]).not.toContain("OR NOT v_can_initialize");
    expect(initializerMutants[1]).toContain(
      "set_config('dasher.retention_capability', 'initialize', true)",
    );
    for (const mutant of initializerMutants) {
      expect(mutant).not.toBe(exactSource);
    }

    const mismatchedCapabilityPolicy = targetDiscoveryPolicy?.using.replace(
      "'purge'::text]",
      "'initialize'::text]",
    );
    expect(mismatchedCapabilityPolicy).not.toBe(targetDiscoveryPolicy?.using);
    expect(mismatchedCapabilityPolicy).not.toContain(
      "'record_attempt'::text, 'purge'::text]",
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
      "FROM task8a_retention_barrier.authority_revisions",
      "ORDER BY authority.principal_revision DESC",
      "NOT v_enabled",
      "set_config",
    ].map((fragment) => initializer.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(initializer).not.toMatch(/FOR\s+(?:UPDATE|SHARE)|\bEXECUTE\b/iu);
    expect(
      sql.match(/task8a_retention_barrier[.]binding_gate\(/gu),
    ).toHaveLength(5);
    expect(sql).toContain(
      "CREATE FUNCTION task8a_retention_barrier.append_revision",
    );
    expect(sql).toContain(
      "CREATE FUNCTION task8a_retention_barrier.cleanup_subject",
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
      /postgres(?:ql)?:\/\/|password|credential|provider[_-]?key|sk-proj/iu,
    );
    expect(Object.values(modeled0003FixtureIds)).toHaveLength(9);
    expect(new Set(Object.values(modeled0003FixtureIds)).size).toBe(9);
    for (const fixtureId of Object.values(modeled0003FixtureIds)) {
      expect(fixtureId).toMatch(/^[1-9]0000000-0000-4000-8000-000000000001$/u);
    }
  });
});
