import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { discoverMigrations } from "./migrator.js";
import {
  modeled0003CatalogMatrix,
  modeled0003FixtureIds,
  modeled0003Functions,
  modeled0003InitializerBodyContract,
  modeled0003ManagedRoles,
  modeled0003Policies,
  modeled0003SafetyMatrix,
} from "../test/fixtures/migrations-0003-allowlist/modeled-0003-inventory.js";

const canonicalMigrationDirectory = new URL("../migrations", import.meta.url)
  .pathname;

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
    expect(modeled0003CatalogMatrix.dependencyInventory.preparedPrefix).toEqual(
      [],
    );
  });

  it("freezes every modeled catalog category and the closed function owners", () => {
    expect(Object.keys(modeled0003CatalogMatrix.relations)).toHaveLength(24);
    expect(modeled0003CatalogMatrix.schemas).toEqual([
      expect.objectContaining({ name: "dasher_retention_api" }),
    ]);
    expect(modeled0003CatalogMatrix.indexes).toHaveLength(64);
    expect(modeled0003CatalogMatrix.constraints).toHaveLength(63);
    expect(modeled0003CatalogMatrix.types).toHaveLength(29);
    expect(modeled0003CatalogMatrix.sequences).toEqual([]);
    expect(modeled0003CatalogMatrix.columns.length).toBeGreaterThan(200);
    expect(
      modeled0003CatalogMatrix.columns.every(
        (column) =>
          column.type.length > 0 &&
          column.defaultExpression === null &&
          !column.generated &&
          !column.identity,
      ),
    ).toBe(true);
    expect(
      modeled0003CatalogMatrix.columns.find(
        (column) =>
          column.relationName === "source_snapshots" &&
          column.columnName === "canonical_bytes",
      ),
    ).toMatchObject({ nullable: false, type: "bytea" });
    expect(modeled0003CatalogMatrix.triggers).toHaveLength(19);
    for (const trigger of modeled0003CatalogMatrix.triggers) {
      expect(trigger).toMatchObject({
        callStackInspection: false,
        dynamicSql: false,
        level: "ROW",
        timing: "BEFORE",
      });
      expect(trigger.requiredProofs).not.toEqual([]);
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
      modeled0003CatalogMatrix.aclClosure.dasher_retention_operator,
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
    expect(modeled0003InitializerBodyContract.requiredOrder).toEqual([
      "exact-read-committed-check",
      "all-reserved-context-keys-empty-check",
      "derive-gate-from-postgres-session-user-binding",
      "pg_advisory_xact_lock-binding-gate",
      "distinct-ordinary-post-gate-allowlist-select",
      "select-highest-revision-regardless-enabled",
      "validate-predecessor-and-hash-chain",
      "deny-latest-disabled-or-missing-capability-without-fallback",
      "set-target-discovery-context",
      "single-dashboard-organization-projection-without-tuple-lock",
      "pg_advisory_xact_lock-derived-organization-gate",
      "replace-context-with-full-authorized-context",
      "ordinary-policy-dashboard-lock-and-revalidation",
    ]);
    expect(modeled0003InitializerBodyContract.forbiddenSql).toEqual(
      expect.arrayContaining([
        "pre-gate allowlist read or cache",
        "latest-enabled fallback",
        "dynamic SQL",
        "STABLE wrapper",
        "IMMUTABLE wrapper",
      ]),
    );
    expect(modeled0003InitializerBodyContract.writerGateUsers).toHaveLength(3);
    expect(modeled0003InitializerBodyContract.bindingGateIdentity).toContain(
      "postgres_session_user|session_user",
    );
    expect(modeled0003InitializerBodyContract.writerOperationOrder).toEqual([
      "derive identical immutable binding gate",
      "pg_advisory_xact_lock identical binding gate",
      "append synthetic revision or remove synthetic fixture",
      "commit before gate release",
    ]);
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
