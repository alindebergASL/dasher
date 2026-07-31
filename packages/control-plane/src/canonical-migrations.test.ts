import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { discoverMigrations } from "./migrator.js";

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
