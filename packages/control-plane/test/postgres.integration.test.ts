import { Buffer } from "node:buffer";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parsePostgresIntegrationEnv, runMigrations } from "../src/index.js";
import {
  borrowedClientPool,
  canonicalMigrationDirectory,
  checksumDriftMigrationDirectory,
  createTemporaryAppLogin,
  dropTemporaryAppLogin,
  executeServerFormattedSql,
  expectMigrationRejection,
  fixtureMigrationDirectory,
  renamedMigrationDirectory,
} from "./postgres-harness.js";

const config = parsePostgresIntegrationEnv(process.env);
const shapeOwnerRole = "dasher_task2_shape_owner";
const setRoleExecutor = "dasher_task2_set_role";

let ownerPool: Pool;
let appPool: Pool | undefined;
let disposableStateConfirmed = false;
let appLoginCreated = false;
let canonicalFirstRun:
  | {
      readonly appliedCount: number;
      readonly discoveredCount: number;
      readonly previouslyAppliedCount: number;
    }
  | undefined;
let canonicalSecondRun:
  | {
      readonly appliedCount: number;
      readonly discoveredCount: number;
      readonly previouslyAppliedCount: number;
    }
  | undefined;

async function resetManagedSchemas(): Promise<void> {
  await ownerPool.query(`
    DROP SCHEMA IF EXISTS fixture_role_owned CASCADE;
    DROP SCHEMA IF EXISTS dasher_private CASCADE;
    DROP SCHEMA IF EXISTS dasher CASCADE;
    DROP SCHEMA IF EXISTS dasher_meta CASCADE
  `);
}

async function prepareAppliedJournal(): Promise<void> {
  await resetManagedSchemas();
  const result = await runMigrations(ownerPool, fixtureMigrationDirectory);
  expect(result.appliedCount).toBe(2);
}

async function schemaPresence(): Promise<{
  readonly dasher: boolean;
  readonly dasherMeta: boolean;
}> {
  const result = await ownerPool.query<{
    readonly dasher: boolean;
    readonly dasher_meta: boolean;
  }>(`
    SELECT
      pg_catalog.to_regnamespace('dasher') IS NOT NULL AS dasher,
      pg_catalog.to_regnamespace('dasher_meta') IS NOT NULL AS dasher_meta
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("PostgreSQL did not return schema presence");
  }
  return { dasher: row.dasher, dasherMeta: row.dasher_meta };
}

async function createShapeOwner(): Promise<void> {
  await ownerPool.query(`
    CREATE ROLE dasher_task2_shape_owner WITH
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD NULL
  `);
}

async function dropShapeOwner(): Promise<void> {
  await resetManagedSchemas();
  await ownerPool.query("DROP ROLE IF EXISTS dasher_task2_shape_owner");
}

async function restoreTask3PublicPrivileges(): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await executeServerFormattedSql(
      client,
      "GRANT TEMPORARY ON DATABASE %I TO PUBLIC",
      [config.ownerDatabase],
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO PUBLIC",
    );
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  ownerPool = new Pool({
    connectionString: config.ownerDsn,
    max: 4,
  });

  const client = await ownerPool.connect();
  try {
    const result = await client.query<{
      readonly app_login_exists: boolean;
      readonly helper_role_exists: boolean;
      readonly managed_namespace_exists: boolean;
      readonly managed_role_exists: boolean;
      readonly postgres_16: boolean;
      readonly public_database_acl_baseline: boolean;
      readonly public_schema_acl_baseline: boolean;
      readonly owner_default_acl_baseline: boolean;
    }>(
      `
        SELECT
          current_setting('server_version_num')::integer
            BETWEEN 160000 AND 169999 AS postgres_16,
          (
            SELECT pg_catalog.count(*) = 2
            FROM pg_catalog.pg_database AS database_row
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                database_row.datacl,
                pg_catalog.acldefault('d', database_row.datdba)
              )
            ) AS privilege
            WHERE database_row.datname = pg_catalog.current_database()
              AND privilege.grantee = 0
              AND privilege.privilege_type IN ('CONNECT', 'TEMPORARY')
          ) AS public_database_acl_baseline,
          (
            SELECT pg_catalog.count(*) = 1
            FROM pg_catalog.pg_namespace AS namespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                namespace.nspacl,
                pg_catalog.acldefault('n', namespace.nspowner)
              )
            ) AS privilege
            WHERE namespace.nspname = 'public'
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'USAGE'
          ) AS public_schema_acl_baseline,
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_default_acl AS default_acl
            WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) =
              session_user
          ) AS owner_default_acl_baseline,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname IN ('dasher_app', 'dasher_security_definer')
          ) AS managed_role_exists,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname IN ($1, $2, $3)
          ) AS helper_role_exists,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname = $1
          ) AS app_login_exists,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_namespace
            WHERE nspname IN (
              'dasher',
              'dasher_private',
              'dasher_meta',
              'fixture_role_owned'
            )
          ) AS managed_namespace_exists
      `,
      [config.appUsername, shapeOwnerRole, setRoleExecutor],
    );
    const row = result.rows[0];

    expect(row?.postgres_16).toBe(true);
    expect(row?.public_database_acl_baseline).toBe(true);
    expect(row?.public_schema_acl_baseline).toBe(true);
    expect(row?.owner_default_acl_baseline).toBe(true);
    expect(row?.managed_role_exists).toBe(false);
    expect(row?.helper_role_exists).toBe(false);
    expect(row?.app_login_exists).toBe(false);
    expect(row?.managed_namespace_exists).toBe(false);
    disposableStateConfirmed = true;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (appPool !== undefined) {
    await appPool.end();
    appPool = undefined;
  }

  if (!disposableStateConfirmed) {
    await ownerPool?.end();
    return;
  }

  try {
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }

    await resetManagedSchemas();
    await restoreTask3PublicPrivileges();
    await ownerPool.query(`DROP ROLE IF EXISTS ${setRoleExecutor}`);
    await ownerPool.query(`DROP ROLE IF EXISTS ${shapeOwnerRole}`);
    await ownerPool.query(
      "DROP ROLE IF EXISTS dasher_security_definer, dasher_app",
    );

    const residue = await ownerPool.query<{ readonly count: string }>(
      `
        SELECT count(*)::text AS count
        FROM pg_catalog.pg_roles
        WHERE rolname IN (
          'dasher_app',
          'dasher_security_definer',
          $1,
          $2,
          $3
        )
      `,
      [config.appUsername, shapeOwnerRole, setRoleExecutor],
    );
    expect(residue.rows[0]?.count).toBe("0");
    expect(await schemaPresence()).toEqual({
      dasher: false,
      dasherMeta: false,
    });
    const restoredBaselines = await ownerPool.query<{
      readonly owner_default_acl_restored: boolean;
      readonly public_database_acl_restored: boolean;
      readonly public_schema_acl_restored: boolean;
    }>(`
      SELECT
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl AS default_acl
          WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) = session_user
        ) AS owner_default_acl_restored,
        (
          SELECT pg_catalog.array_agg(
            privilege.privilege_type ORDER BY privilege.privilege_type
          ) = ARRAY['CONNECT', 'TEMPORARY']::text[]
          FROM pg_catalog.pg_database AS database_row
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              database_row.datacl,
              pg_catalog.acldefault('d', database_row.datdba)
            )
          ) AS privilege
          WHERE database_row.datname = pg_catalog.current_database()
            AND privilege.grantee = 0
        ) AS public_database_acl_restored,
        (
          SELECT pg_catalog.array_agg(
            privilege.privilege_type ORDER BY privilege.privilege_type
          ) = ARRAY['USAGE']::text[]
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )
          ) AS privilege
          WHERE namespace.nspname = 'public'
            AND privilege.grantee = 0
        ) AS public_schema_acl_restored
    `);
    expect(restoredBaselines.rows[0]).toEqual({
      owner_default_acl_restored: true,
      public_database_acl_restored: true,
      public_schema_acl_restored: true,
    });
  } finally {
    await ownerPool.end();
  }
});

describe.sequential("Task 2 PostgreSQL migration contract", () => {
  it("applies a clean exact series and repeats as a database-clock no-op", async () => {
    try {
      const applied = await runMigrations(ownerPool, fixtureMigrationDirectory);
      expect(applied).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 0,
        appliedCount: 2,
      });

      const journal = await ownerPool.query<{
        readonly applied_before_observation: boolean;
        readonly applied_by_session_user: boolean;
        readonly count: string;
      }>(`
        SELECT
          count(*)::text AS count,
          bool_and(applied_by = session_user) AS applied_by_session_user,
          bool_and(applied_at <= statement_timestamp())
            AS applied_before_observation
        FROM dasher_meta.schema_migrations
      `);
      expect(journal.rows[0]).toEqual({
        count: "2",
        applied_by_session_user: true,
        applied_before_observation: true,
      });

      const repeated = await runMigrations(
        ownerPool,
        fixtureMigrationDirectory,
      );
      expect(repeated).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 2,
        appliedCount: 0,
      });

      const roles = await ownerPool.query<{
        readonly attributes_match: boolean;
        readonly comment: string | null;
        readonly password_is_null: boolean;
        readonly rolname: string;
      }>(`
        SELECT
          role.rolname::text AS rolname,
          NOT role.rolcanlogin
            AND NOT role.rolinherit
            AND NOT role.rolsuper
            AND NOT role.rolcreatedb
            AND NOT role.rolcreaterole
            AND NOT role.rolreplication
            AND role.rolbypassrls =
              (role.rolname = 'dasher_security_definer')
            AND role.rolconnlimit = -1
            AND role.rolvaliduntil IS NULL
            AS attributes_match,
          role.rolpassword IS NULL AS password_is_null,
          pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment
        FROM pg_catalog.pg_authid AS role
        WHERE role.rolname IN ('dasher_app', 'dasher_security_definer')
        ORDER BY role.rolname
      `);
      expect(roles.rows).toEqual([
        {
          rolname: "dasher_app",
          attributes_match: true,
          password_is_null: true,
          comment: "dasher:managed-role:v1:app",
        },
        {
          rolname: "dasher_security_definer",
          attributes_match: true,
          password_is_null: true,
          comment: "dasher:managed-role:v1:security-definer",
        },
      ]);
    } finally {
      await resetManagedSchemas();
    }
  });

  it("serializes concurrent runners into exactly one apply and one skip", async () => {
    try {
      const results = await Promise.all([
        runMigrations(ownerPool, fixtureMigrationDirectory),
        runMigrations(ownerPool, fixtureMigrationDirectory),
      ]);

      expect(results.map((result) => result.appliedCount).sort()).toEqual([
        0, 2,
      ]);
      expect(
        results.map((result) => result.previouslyAppliedCount).sort(),
      ).toEqual([0, 2]);

      const journal = await ownerPool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM dasher_meta.schema_migrations",
      );
      expect(journal.rows[0]?.count).toBe("2");
    } finally {
      await resetManagedSchemas();
    }
  });

  it("rejects either managed namespace as an adoption conflict", async () => {
    for (const schemaName of ["dasher", "dasher_meta"] as const) {
      try {
        await ownerPool.query(`CREATE SCHEMA ${schemaName}`);
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory),
          "adoption_conflict",
        );
      } finally {
        await resetManagedSchemas();
      }
    }
  });

  it("rejects checksum drift and a renamed migration identity", async () => {
    try {
      await prepareAppliedJournal();
      await expectMigrationRejection(
        runMigrations(ownerPool, checksumDriftMigrationDirectory),
        "journal_identity_mismatch",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, renamedMigrationDirectory),
        "journal_identity_mismatch",
      );
    } finally {
      await resetManagedSchemas();
    }
  });

  it("rejects extra, gap, rename, checksum, and applied-by journal drift", async () => {
    const cases: readonly {
      readonly mutate: () => Promise<unknown>;
      readonly name: string;
    }[] = [
      {
        name: "extra row",
        mutate: () =>
          ownerPool.query(
            `
              INSERT INTO dasher_meta.schema_migrations (
                sequence, filename, checksum_sha256, applied_by
              )
              VALUES (3, '0003_extra.sql', $1, session_user)
            `,
            [Buffer.alloc(32, 3)],
          ),
      },
      {
        name: "gap",
        mutate: () =>
          ownerPool.query(
            "DELETE FROM dasher_meta.schema_migrations WHERE sequence = 1",
          ),
      },
      {
        name: "renamed row",
        mutate: () =>
          ownerPool.query(
            `
              UPDATE dasher_meta.schema_migrations
              SET filename = '0001_fixture_renamed.sql'
              WHERE sequence = 1
            `,
          ),
      },
      {
        name: "checksum",
        mutate: () =>
          ownerPool.query(
            `
              UPDATE dasher_meta.schema_migrations
              SET checksum_sha256 = $1
              WHERE sequence = 1
            `,
            [Buffer.alloc(32, 7)],
          ),
      },
      {
        name: "applied-by",
        mutate: () =>
          ownerPool.query(
            `
              UPDATE dasher_meta.schema_migrations
              SET applied_by = 'synthetic_wrong_executor'
              WHERE sequence = 1
            `,
          ),
      },
    ];

    for (const journalCase of cases) {
      try {
        await prepareAppliedJournal();
        await journalCase.mutate();
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory),
          "journal_identity_mismatch",
        );
      } catch (error) {
        throw new Error(`journal identity case failed: ${journalCase.name}`, {
          cause: error,
        });
      } finally {
        await resetManagedSchemas();
      }
    }
  });

  it("rejects malformed journal DDL, ACLs, ownership, and extra objects", async () => {
    const shapeCases: readonly {
      readonly mutate: () => Promise<unknown>;
      readonly name: string;
    }[] = [
      {
        name: "missing check",
        mutate: () =>
          ownerPool.query(`
            ALTER TABLE dasher_meta.schema_migrations
            DROP CONSTRAINT schema_migrations_checksum_sha256_check
          `),
      },
      {
        name: "extra column",
        mutate: () =>
          ownerPool.query(`
            ALTER TABLE dasher_meta.schema_migrations
            ADD COLUMN unexpected boolean
          `),
      },
      {
        name: "public ACL",
        mutate: () =>
          ownerPool.query(
            "GRANT SELECT ON dasher_meta.schema_migrations TO PUBLIC",
          ),
      },
      {
        name: "extra object",
        mutate: () =>
          ownerPool.query("CREATE TABLE dasher_meta.unexpected (id integer)"),
      },
    ];

    for (const shapeCase of shapeCases) {
      try {
        await prepareAppliedJournal();
        await shapeCase.mutate();
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory),
          "journal_shape_invalid",
        );
      } catch (error) {
        throw new Error(`journal shape case failed: ${shapeCase.name}`, {
          cause: error,
        });
      } finally {
        await resetManagedSchemas();
      }
    }

    try {
      await createShapeOwner();
      await prepareAppliedJournal();
      await ownerPool.query(
        "ALTER TABLE dasher_meta.schema_migrations OWNER TO dasher_task2_shape_owner",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory),
        "journal_shape_invalid",
      );
    } finally {
      await dropShapeOwner();
    }
  });

  it("rolls back journal creation and migration effects when the fixed journal INSERT fails", async () => {
    const client = await ownerPool.connect();
    try {
      await expect(
        runMigrations(
          borrowedClientPool(client, true),
          fixtureMigrationDirectory,
        ),
      ).rejects.toThrow("synthetic fixed journal insert failure");
      expect(await schemaPresence()).toEqual({
        dasher: false,
        dasherMeta: false,
      });
    } finally {
      client.release();
      await resetManagedSchemas();
    }
  });

  it("aborts on managed-role marker, flag, ownership, and grant drift without altering it", async () => {
    try {
      await ownerPool.query(
        "COMMENT ON ROLE dasher_app IS 'synthetic:wrong-marker'",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory),
        "managed_role_drift",
      );
      const marker = await ownerPool.query<{ readonly comment: string | null }>(
        `
          SELECT pg_catalog.shobj_description(oid, 'pg_authid') AS comment
          FROM pg_catalog.pg_roles
          WHERE rolname = 'dasher_app'
        `,
      );
      expect(marker.rows[0]?.comment).toBe("synthetic:wrong-marker");
    } finally {
      await ownerPool.query(
        "COMMENT ON ROLE dasher_app IS 'dasher:managed-role:v1:app'",
      );
    }

    try {
      await ownerPool.query("ALTER ROLE dasher_security_definer LOGIN");
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory),
        "managed_role_drift",
      );
      const flags = await ownerPool.query<{ readonly rolcanlogin: boolean }>(
        "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'dasher_security_definer'",
      );
      expect(flags.rows[0]?.rolcanlogin).toBe(true);
    } finally {
      await ownerPool.query(
        "ALTER ROLE dasher_security_definer NOLOGIN PASSWORD NULL",
      );
    }

    try {
      await ownerPool.query(
        "CREATE SCHEMA fixture_role_owned AUTHORIZATION dasher_security_definer",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory),
        "managed_role_drift",
      );
      expect(
        (
          await ownerPool.query<{ readonly owner: string }>(
            `
              SELECT owner.rolname::text AS owner
              FROM pg_catalog.pg_namespace AS namespace
              JOIN pg_catalog.pg_roles AS owner
                ON owner.oid = namespace.nspowner
              WHERE namespace.nspname = 'fixture_role_owned'
            `,
          )
        ).rows[0]?.owner,
      ).toBe("dasher_security_definer");
    } finally {
      await ownerPool.query("DROP SCHEMA IF EXISTS fixture_role_owned CASCADE");
    }

    const grantClient = await ownerPool.connect();
    try {
      await executeServerFormattedSql(
        grantClient,
        "GRANT CONNECT ON DATABASE %I TO dasher_app",
        [config.ownerDatabase],
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory),
        "managed_role_drift",
      );
    } finally {
      await executeServerFormattedSql(
        grantClient,
        "REVOKE CONNECT ON DATABASE %I FROM dasher_app",
        [config.ownerDatabase],
      );
      grantClient.release();
      await resetManagedSchemas();
    }
  });

  it("rejects SET ROLE and application-login execution", async () => {
    const ownerClient = await ownerPool.connect();
    try {
      await ownerClient.query(`
        CREATE ROLE dasher_task2_set_role WITH
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD NULL
      `);
      const session = await ownerClient.query<{
        readonly session_name: string;
      }>("SELECT session_user::text AS session_name");
      const sessionName = session.rows[0]?.session_name;
      if (sessionName === undefined) {
        throw new Error("PostgreSQL did not return session_user");
      }
      await executeServerFormattedSql(
        ownerClient,
        "GRANT dasher_task2_set_role TO %I",
        [sessionName],
      );
      await ownerClient.query("SET ROLE dasher_task2_set_role");
      await expectMigrationRejection(
        runMigrations(
          borrowedClientPool(ownerClient),
          fixtureMigrationDirectory,
        ),
        "executor_set_role",
      );
    } finally {
      await ownerClient.query("RESET ROLE");
      await ownerClient.query(`DROP ROLE IF EXISTS ${setRoleExecutor}`);
      ownerClient.release();
    }

    await createTemporaryAppLogin(ownerPool, config.appDsn, config.appUsername);
    appLoginCreated = true;
    appPool = new Pool({ connectionString: config.appDsn, max: 2 });

    await expectMigrationRejection(
      runMigrations(appPool, fixtureMigrationDirectory),
      "executor_role_invalid",
    );

    const appClient: PoolClient = await appPool.connect();
    try {
      await appClient.query("SET ROLE dasher_app");
      await expectMigrationRejection(
        runMigrations(borrowedClientPool(appClient), fixtureMigrationDirectory),
        "executor_set_role",
      );
    } finally {
      await appClient.query("RESET ROLE");
      appClient.release();
    }
  });
});

const canonicalTables = [
  "audit_events",
  "external_identities",
  "invitations",
  "memberships",
  "organizations",
  "sessions",
  "users",
] as const;

const expectedColumns = [
  "audit_events|1|audit_event_id|uuid|true|<none>",
  "audit_events|2|organization_id|uuid|true|<none>",
  "audit_events|3|occurred_at|timestamp with time zone|true|clock_timestamp()",
  "audit_events|4|actor_kind|character varying(16)|true|<none>",
  "audit_events|5|actor_user_id|uuid|false|<none>",
  "audit_events|6|actor_service|character varying(64)|false|<none>",
  "audit_events|7|authority_revision|bigint|true|<none>",
  "audit_events|8|request_id|uuid|true|<none>",
  "audit_events|9|job_id|uuid|false|<none>",
  "audit_events|10|action|character varying(64)|true|<none>",
  "audit_events|11|target_type|character varying(32)|true|<none>",
  "audit_events|12|target_id|uuid|true|<none>",
  "audit_events|13|outcome|character varying(16)|true|<none>",
  "audit_events|14|content_sha256|bytea|false|<none>",
  "audit_events|15|source_ref|character varying(200)|false|<none>",
  "audit_events|16|provider|character varying(64)|false|<none>",
  "audit_events|17|credential_version|character varying(64)|false|<none>",
  "audit_events|18|usage_units|numeric(20,6)|false|<none>",
  "audit_events|19|cost_minor_units|bigint|false|<none>",
  "audit_events|20|deployment_revision|character varying(64)|true|<none>",
  "external_identities|1|issuer|character varying(512)|true|<none>",
  "external_identities|2|subject|character varying(512)|true|<none>",
  "external_identities|3|user_id|uuid|true|<none>",
  "external_identities|4|created_at|timestamp with time zone|true|transaction_timestamp()",
  "invitations|1|invitation_id|uuid|true|<none>",
  "invitations|2|organization_id|uuid|true|<none>",
  "invitations|3|normalized_email|character varying(320)|true|<none>",
  "invitations|4|granted_role|character varying(16)|true|<none>",
  "invitations|5|role_ceiling|character varying(16)|true|<none>",
  "invitations|6|token_key_version|smallint|true|<none>",
  "invitations|7|token_digest|bytea|true|<none>",
  "invitations|8|created_by_user_id|uuid|true|<none>",
  "invitations|9|created_at|timestamp with time zone|true|transaction_timestamp()",
  "invitations|10|expires_at|timestamp with time zone|true|<none>",
  "invitations|11|accepted_at|timestamp with time zone|false|<none>",
  "invitations|12|accepted_user_id|uuid|false|<none>",
  "invitations|13|revoked_at|timestamp with time zone|false|<none>",
  "invitations|14|revoked_by_user_id|uuid|false|<none>",
  "memberships|1|membership_id|uuid|true|<none>",
  "memberships|2|organization_id|uuid|true|<none>",
  "memberships|3|user_id|uuid|true|<none>",
  "memberships|4|role|character varying(16)|true|<none>",
  "memberships|5|state|character varying(16)|true|<none>",
  "memberships|6|authority_revision|bigint|true|<none>",
  "memberships|7|created_at|timestamp with time zone|true|transaction_timestamp()",
  "memberships|8|updated_at|timestamp with time zone|true|transaction_timestamp()",
  "memberships|9|revoked_at|timestamp with time zone|false|<none>",
  "organizations|1|organization_id|uuid|true|<none>",
  "organizations|2|display_name|character varying(200)|true|<none>",
  "organizations|3|created_at|timestamp with time zone|true|transaction_timestamp()",
  "sessions|1|session_id|uuid|true|<none>",
  "sessions|2|organization_id|uuid|true|<none>",
  "sessions|3|user_id|uuid|true|<none>",
  "sessions|4|authority_revision|bigint|true|<none>",
  "sessions|5|token_key_version|smallint|true|<none>",
  "sessions|6|token_digest|bytea|true|<none>",
  "sessions|7|csrf_key_version|smallint|true|<none>",
  "sessions|8|csrf_digest|bytea|true|<none>",
  "sessions|9|issued_at|timestamp with time zone|true|<none>",
  "sessions|10|last_seen_at|timestamp with time zone|true|<none>",
  "sessions|11|idle_expires_at|timestamp with time zone|true|<none>",
  "sessions|12|absolute_expires_at|timestamp with time zone|true|<none>",
  "sessions|13|rotated_from_session_id|uuid|false|<none>",
  "sessions|14|replaced_by_session_id|uuid|false|<none>",
  "sessions|15|revoked_at|timestamp with time zone|false|<none>",
  "sessions|16|revocation_reason|character varying(32)|false|<none>",
  "users|1|user_id|uuid|true|<none>",
  "users|2|created_at|timestamp with time zone|true|transaction_timestamp()",
] as const;

const expectedRelationConstraints = [
  "audit_events|audit_events_action_check|c|CHECK (((action)::text = ANY ((ARRAY['membership.role_changed'::character varying, 'membership.revoked'::character varying, 'invitation.issued'::character varying, 'invitation.revoked'::character varying, 'invitation.accepted'::character varying, 'invitation.accepted_existing_membership'::character varying, 'session.issued'::character varying, 'session.rotated'::character varying, 'session.revoked'::character varying, 'source_snapshot.created'::character varying, 'evidence_record.created'::character varying, 'dashboard.created'::character varying, 'dashboard_version.created'::character varying, 'dashboard_head.promoted'::character varying])::text[])))|true",
  "audit_events|audit_events_actor_check|c|CHECK (((((actor_kind)::text = 'user'::text) AND (actor_user_id IS NOT NULL) AND (actor_service IS NULL)) OR (((actor_kind)::text = 'service'::text) AND (actor_user_id IS NULL) AND (actor_service IS NOT NULL))))|true",
  "audit_events|audit_events_actor_kind_check|c|CHECK (((actor_kind)::text = ANY ((ARRAY['user'::character varying, 'service'::character varying])::text[])))|true",
  "audit_events|audit_events_actor_service_check|c|CHECK (((actor_service IS NULL) OR (((actor_service)::text = btrim((actor_service)::text)) AND ((char_length((actor_service)::text) >= 1) AND (char_length((actor_service)::text) <= 64)) AND ((actor_service)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_authority_revision_check|c|CHECK ((authority_revision >= 1))|true",
  "audit_events|audit_events_content_sha256_check|c|CHECK (((content_sha256 IS NULL) OR (octet_length(content_sha256) = 32)))|true",
  "audit_events|audit_events_cost_minor_units_check|c|CHECK (((cost_minor_units IS NULL) OR (cost_minor_units >= 0)))|true",
  "audit_events|audit_events_credential_version_check|c|CHECK (((credential_version IS NULL) OR (((credential_version)::text = btrim((credential_version)::text)) AND ((char_length((credential_version)::text) >= 1) AND (char_length((credential_version)::text) <= 64)) AND ((credential_version)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_deployment_revision_check|c|CHECK ((((deployment_revision)::text = btrim((deployment_revision)::text)) AND ((char_length((deployment_revision)::text) >= 1) AND (char_length((deployment_revision)::text) <= 64)) AND ((deployment_revision)::text !~ '[[:cntrl:]]'::text)))|true",
  "audit_events|audit_events_outcome_check|c|CHECK (((outcome)::text = 'succeeded'::text))|true",
  "audit_events|audit_events_provider_check|c|CHECK (((provider IS NULL) OR (((provider)::text = btrim((provider)::text)) AND ((char_length((provider)::text) >= 1) AND (char_length((provider)::text) <= 64)) AND ((provider)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_source_ref_check|c|CHECK (((source_ref IS NULL) OR (((source_ref)::text = btrim((source_ref)::text)) AND ((char_length((source_ref)::text) >= 1) AND (char_length((source_ref)::text) <= 200)) AND ((source_ref)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_target_type_check|c|CHECK ((((target_type)::text = btrim((target_type)::text)) AND ((char_length((target_type)::text) >= 1) AND (char_length((target_type)::text) <= 32)) AND ((target_type)::text !~ '[[:cntrl:]]'::text)))|true",
  "audit_events|audit_events_usage_units_check|c|CHECK (((usage_units IS NULL) OR ((usage_units <> 'NaN'::numeric) AND (usage_units >= (0)::numeric))))|true",
  "audit_events|audit_events_pkey|p|PRIMARY KEY (audit_event_id)|true",
  "audit_events|audit_events_org_id_key|u|UNIQUE (organization_id, audit_event_id)|true",
  "external_identities|external_identities_issuer_check|c|CHECK ((((issuer)::text = btrim((issuer)::text)) AND ((char_length((issuer)::text) >= 1) AND (char_length((issuer)::text) <= 512)) AND ((issuer)::text !~ '[[:cntrl:]]'::text)))|true",
  "external_identities|external_identities_subject_check|c|CHECK ((((subject)::text = btrim((subject)::text)) AND ((char_length((subject)::text) >= 1) AND (char_length((subject)::text) <= 512)) AND ((subject)::text !~ '[[:cntrl:]]'::text)))|true",
  "external_identities|external_identities_pkey|p|PRIMARY KEY (issuer, subject)|true",
  "external_identities|external_identities_user_key|u|UNIQUE (user_id)|true",
  "invitations|invitations_accepted_fields_check|c|CHECK (((accepted_at IS NULL) = (accepted_user_id IS NULL)))|true",
  "invitations|invitations_expiry_check|c|CHECK ((expires_at > created_at))|true",
  "invitations|invitations_granted_role_check|c|CHECK (((granted_role)::text = ANY ((ARRAY['admin'::character varying, 'editor'::character varying, 'viewer'::character varying])::text[])))|true",
  "invitations|invitations_normalized_email_check|c|CHECK ((((normalized_email)::text = btrim((normalized_email)::text)) AND ((normalized_email)::text = lower((normalized_email)::text)) AND ((char_length((normalized_email)::text) >= 1) AND (char_length((normalized_email)::text) <= 320)) AND ((normalized_email)::text !~ '[[:cntrl:]]'::text)))|true",
  "invitations|invitations_revoked_fields_check|c|CHECK (((revoked_at IS NULL) = (revoked_by_user_id IS NULL)))|true",
  "invitations|invitations_role_ceiling_check|c|CHECK (((role_ceiling)::text = ANY ((ARRAY['admin'::character varying, 'editor'::character varying, 'viewer'::character varying])::text[])))|true",
  "invitations|invitations_role_order_check|c|CHECK (( CASE granted_role WHEN 'viewer'::text THEN 1 WHEN 'editor'::text THEN 2 WHEN 'admin'::text THEN 3 ELSE NULL::integer END <= CASE role_ceiling WHEN 'viewer'::text THEN 1 WHEN 'editor'::text THEN 2 WHEN 'admin'::text THEN 3 ELSE NULL::integer END))|true",
  "invitations|invitations_terminal_state_check|c|CHECK (((accepted_at IS NULL) OR (revoked_at IS NULL)))|true",
  "invitations|invitations_token_digest_check|c|CHECK ((octet_length(token_digest) = 32))|true",
  "invitations|invitations_token_key_version_check|c|CHECK (((token_key_version >= 1) AND (token_key_version <= 32767)))|true",
  "invitations|invitations_pkey|p|PRIMARY KEY (invitation_id)|true",
  "invitations|invitations_org_id_key|u|UNIQUE (organization_id, invitation_id)|true",
  "invitations|invitations_token_key|u|UNIQUE (token_key_version, token_digest)|true",
  "memberships|memberships_authority_revision_check|c|CHECK ((authority_revision >= 1))|true",
  "memberships|memberships_role_check|c|CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'editor'::character varying, 'viewer'::character varying])::text[])))|true",
  "memberships|memberships_state_check|c|CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying])::text[])))|true",
  "memberships|memberships_state_revoked_at_check|c|CHECK (((((state)::text = 'active'::text) AND (revoked_at IS NULL)) OR (((state)::text = 'revoked'::text) AND (revoked_at IS NOT NULL))))|true",
  "memberships|memberships_updated_at_check|c|CHECK ((updated_at >= created_at))|true",
  "memberships|memberships_pkey|p|PRIMARY KEY (membership_id)|true",
  "memberships|memberships_org_membership_key|u|UNIQUE (organization_id, membership_id)|true",
  "memberships|memberships_org_user_key|u|UNIQUE (organization_id, user_id)|true",
  "organizations|organizations_display_name_check|c|CHECK ((((display_name)::text = btrim((display_name)::text)) AND ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 200)) AND ((display_name)::text !~ '[[:cntrl:]]'::text)))|true",
  "organizations|organizations_pkey|p|PRIMARY KEY (organization_id)|true",
  "sessions|sessions_authority_revision_check|c|CHECK ((authority_revision >= 1))|true",
  "sessions|sessions_csrf_digest_check|c|CHECK ((octet_length(csrf_digest) = 32))|true",
  "sessions|sessions_csrf_key_version_check|c|CHECK (((csrf_key_version >= 1) AND (csrf_key_version <= 32767)))|true",
  "sessions|sessions_idle_expiry_check|c|CHECK (((issued_at < idle_expires_at) AND (idle_expires_at <= absolute_expires_at)))|true",
  "sessions|sessions_last_seen_check|c|CHECK (((issued_at <= last_seen_at) AND (last_seen_at < absolute_expires_at)))|true",
  "sessions|sessions_lineage_check|c|CHECK ((((rotated_from_session_id IS NULL) OR (rotated_from_session_id <> session_id)) AND ((replaced_by_session_id IS NULL) OR (replaced_by_session_id <> session_id)) AND ((rotated_from_session_id IS NULL) OR (replaced_by_session_id IS NULL) OR (rotated_from_session_id <> replaced_by_session_id))))|true",
  "sessions|sessions_revocation_fields_check|c|CHECK (((revoked_at IS NULL) = (revocation_reason IS NULL)))|true",
  "sessions|sessions_revocation_reason_check|c|CHECK (((revocation_reason IS NULL) OR (((revocation_reason)::text = btrim((revocation_reason)::text)) AND ((char_length((revocation_reason)::text) >= 1) AND (char_length((revocation_reason)::text) <= 32)) AND ((revocation_reason)::text !~ '[[:cntrl:]]'::text))))|true",
  "sessions|sessions_token_digest_check|c|CHECK ((octet_length(token_digest) = 32))|true",
  "sessions|sessions_token_key_version_check|c|CHECK (((token_key_version >= 1) AND (token_key_version <= 32767)))|true",
  "sessions|sessions_pkey|p|PRIMARY KEY (session_id)|true",
  "sessions|sessions_csrf_key|u|UNIQUE (csrf_key_version, csrf_digest)|true",
  "sessions|sessions_org_id_key|u|UNIQUE (organization_id, session_id)|true",
  "sessions|sessions_token_key|u|UNIQUE (token_key_version, token_digest)|true",
  "users|users_pkey|p|PRIMARY KEY (user_id)|true",
] as const;

const expectedForeignKeys = [
  "dasher.audit_events|audit_events_actor_fkey|dasher.memberships|{organization_id,actor_user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.audit_events|audit_events_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.external_identities|external_identities_user_fkey|dasher.users|{user_id}|{user_id}|1|saa|true|false|false",
  "dasher.invitations|invitations_accepted_user_fkey|dasher.users|{accepted_user_id}|{user_id}|1|saa|true|false|false",
  "dasher.invitations|invitations_creator_fkey|dasher.memberships|{organization_id,created_by_user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.invitations|invitations_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.invitations|invitations_revoker_fkey|dasher.memberships|{organization_id,revoked_by_user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.memberships|memberships_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.memberships|memberships_user_fkey|dasher.users|{user_id}|{user_id}|1|saa|true|false|false",
  "dasher.sessions|sessions_membership_fkey|dasher.memberships|{organization_id,user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.sessions|sessions_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.sessions|sessions_replaced_by_fkey|dasher.sessions|{organization_id,replaced_by_session_id}|{organization_id,session_id}|2|saa|true|false|false",
  "dasher.sessions|sessions_rotated_from_fkey|dasher.sessions|{organization_id,rotated_from_session_id}|{organization_id,session_id}|2|saa|true|false|false",
] as const;

const expectedIndexes = [
  "audit_events|audit_events_actor_idx|btree|false|false|true|true|true|false|<none>|{organization_id,actor_user_id}|{uuid_ops,uuid_ops}|0 0",
  "audit_events|audit_events_occurred_idx|btree|false|false|true|true|true|false|<none>|{organization_id,occurred_at,audit_event_id}|{uuid_ops,timestamptz_ops,uuid_ops}|0 0 0",
  "audit_events|audit_events_org_id_key|btree|true|false|true|true|true|false|<none>|{organization_id,audit_event_id}|{uuid_ops,uuid_ops}|0 0",
  "audit_events|audit_events_pkey|btree|true|true|true|true|true|false|<none>|{audit_event_id}|{uuid_ops}|0",
  "external_identities|external_identities_pkey|btree|true|true|true|true|true|false|<none>|{issuer,subject}|{text_ops,text_ops}|0 0",
  "external_identities|external_identities_user_key|btree|true|false|true|true|true|false|<none>|{user_id}|{uuid_ops}|0",
  "invitations|invitations_accepted_user_idx|btree|false|false|true|true|true|false|<none>|{accepted_user_id}|{uuid_ops}|0",
  "invitations|invitations_creator_idx|btree|false|false|true|true|true|false|<none>|{organization_id,created_by_user_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_email_created_idx|btree|false|false|true|true|true|false|<none>|{organization_id,normalized_email,created_at}|{uuid_ops,text_ops,timestamptz_ops}|0 0 3",
  "invitations|invitations_org_id_key|btree|true|false|true|true|true|false|<none>|{organization_id,invitation_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_pkey|btree|true|true|true|true|true|false|<none>|{invitation_id}|{uuid_ops}|0",
  "invitations|invitations_revoker_idx|btree|false|false|true|true|true|false|<none>|{organization_id,revoked_by_user_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_token_key|btree|true|false|true|true|true|false|<none>|{token_key_version,token_digest}|{int2_ops,bytea_ops}|0 0",
  "memberships|memberships_active_authority_idx|btree|false|false|true|true|true|false|((state)::text = 'active'::text)|{organization_id,user_id,authority_revision}|{uuid_ops,uuid_ops,int8_ops}|0 0 0",
  "memberships|memberships_org_membership_key|btree|true|false|true|true|true|false|<none>|{organization_id,membership_id}|{uuid_ops,uuid_ops}|0 0",
  "memberships|memberships_org_user_key|btree|true|false|true|true|true|false|<none>|{organization_id,user_id}|{uuid_ops,uuid_ops}|0 0",
  "memberships|memberships_pkey|btree|true|true|true|true|true|false|<none>|{membership_id}|{uuid_ops}|0",
  "memberships|memberships_user_idx|btree|false|false|true|true|true|false|<none>|{user_id}|{uuid_ops}|0",
  "organizations|organizations_pkey|btree|true|true|true|true|true|false|<none>|{organization_id}|{uuid_ops}|0",
  "sessions|sessions_csrf_key|btree|true|false|true|true|true|false|<none>|{csrf_key_version,csrf_digest}|{int2_ops,bytea_ops}|0 0",
  "sessions|sessions_live_user_idx|btree|false|false|true|true|true|false|<none>|{organization_id,user_id,revoked_at}|{uuid_ops,uuid_ops,timestamptz_ops}|0 0 0",
  "sessions|sessions_org_id_key|btree|true|false|true|true|true|false|<none>|{organization_id,session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_pkey|btree|true|true|true|true|true|false|<none>|{session_id}|{uuid_ops}|0",
  "sessions|sessions_replaced_by_idx|btree|false|false|true|true|true|false|<none>|{organization_id,replaced_by_session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_rotated_from_idx|btree|false|false|true|true|true|false|<none>|{organization_id,rotated_from_session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_token_key|btree|true|false|true|true|true|false|<none>|{token_key_version,token_digest}|{int2_ops,bytea_ops}|0 0",
  "users|users_pkey|btree|true|true|true|true|true|false|<none>|{user_id}|{uuid_ops}|0",
] as const;

const ownerTableAcl =
  "OWNER:DELETE:false,OWNER:INSERT:false,OWNER:REFERENCES:false,OWNER:SELECT:false,OWNER:TRIGGER:false,OWNER:TRUNCATE:false,OWNER:UPDATE:false";

const expectedObjectAcls = [
  "database|current_database|OWNER:CONNECT:false,OWNER:CREATE:false,OWNER:TEMPORARY:false,PUBLIC:CONNECT:false",
  "function|dasher_private.reject_immutable_mutation()|OWNER:EXECUTE:false",
  "schema|dasher|OWNER:CREATE:false,OWNER:USAGE:false",
  "schema|dasher_meta|OWNER:CREATE:false,OWNER:USAGE:false",
  "schema|dasher_private|OWNER:CREATE:false,OWNER:USAGE:false",
  "schema|public|OWNER:CREATE:false,OWNER:USAGE:false,PUBLIC:USAGE:false",
  ...canonicalTables.map((table) => `table|dasher.${table}|${ownerTableAcl}`),
  `table|dasher_meta.schema_migrations|${ownerTableAcl}`,
].sort();

async function readForeignKeys(
  client: Pick<PoolClient, "query"> = ownerPool,
): Promise<readonly string[]> {
  const result = await client.query<{ readonly signature: string }>(`
    SELECT
      source_namespace.nspname || '.' || source_relation.relname || '|' ||
      constraint_row.conname || '|' ||
      target_namespace.nspname || '.' || target_relation.relname || '|' ||
      ARRAY(
        SELECT attribute.attname
        FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY
          AS key(attnum, ordinal)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key.attnum
        ORDER BY key.ordinal
      )::text || '|' ||
      ARRAY(
        SELECT attribute.attname
        FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY
          AS key(attnum, ordinal)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.confrelid
         AND attribute.attnum = key.attnum
        ORDER BY key.ordinal
      )::text || '|' ||
      pg_catalog.cardinality(constraint_row.conkey)::text || '|' ||
      constraint_row.confmatchtype::text ||
      constraint_row.confupdtype::text ||
      constraint_row.confdeltype::text || '|' ||
      constraint_row.convalidated::text || '|' ||
      constraint_row.condeferrable::text || '|' ||
      constraint_row.condeferred::text AS signature
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_class AS source_relation
      ON source_relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace AS source_namespace
      ON source_namespace.oid = source_relation.relnamespace
    JOIN pg_catalog.pg_class AS target_relation
      ON target_relation.oid = constraint_row.confrelid
    JOIN pg_catalog.pg_namespace AS target_namespace
      ON target_namespace.oid = target_relation.relnamespace
    WHERE source_namespace.nspname = 'dasher'
      AND constraint_row.contype = 'f'
    ORDER BY source_relation.relname, constraint_row.conname
  `);
  return result.rows.map((row) => row.signature);
}

async function expectPostgresDenial(
  client: PoolClient,
  sql: string,
): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    expect(error).toMatchObject({ code: "42501" });
    return;
  }
  throw new Error(`expected PostgreSQL privilege denial for: ${sql}`);
}

async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected PostgreSQL error ${code}`);
}

describe.sequential(
  "Task 3 immutable 0001 identity and audit foundation",
  () => {
    beforeAll(async () => {
      if (appPool !== undefined) {
        await appPool.end();
        appPool = undefined;
      }
      if (appLoginCreated) {
        await dropTemporaryAppLogin(
          ownerPool,
          config.appDatabase,
          config.appUsername,
        );
        appLoginCreated = false;
      }

      await resetManagedSchemas();
      canonicalFirstRun = await runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
      );
      canonicalSecondRun = await runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
      );
    });

    it("applies exactly 0001 and repeats as a no-op", async () => {
      expect(canonicalFirstRun).toEqual({
        discoveredCount: 1,
        previouslyAppliedCount: 0,
        appliedCount: 1,
      });
      expect(canonicalSecondRun).toEqual({
        discoveredCount: 1,
        previouslyAppliedCount: 1,
        appliedCount: 0,
      });

      const journal = await ownerPool.query<{
        readonly checksum: string;
        readonly filename: string;
        readonly sequence: number;
      }>(`
      SELECT
        sequence,
        filename,
        pg_catalog.encode(checksum_sha256, 'hex') AS checksum
      FROM dasher_meta.schema_migrations
      ORDER BY sequence
    `);
      expect(journal.rows).toEqual([
        {
          sequence: 1,
          filename: "0001_identity_audit.sql",
          checksum:
            "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
        },
      ]);
    });

    it("creates the exact owner-owned tables, columns, defaults, forced RLS, and zero policies", async () => {
      const schemas = await ownerPool.query<{
        readonly owner_matches: boolean;
        readonly schema_name: string;
      }>(`
      SELECT
        namespace.nspname AS schema_name,
        owner.rolname = session_user AS owner_matches
      FROM pg_catalog.pg_namespace AS namespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname LIKE 'dasher%'
      ORDER BY namespace.nspname
    `);
      expect(schemas.rows).toEqual([
        { schema_name: "dasher", owner_matches: true },
        { schema_name: "dasher_meta", owner_matches: true },
        { schema_name: "dasher_private", owner_matches: true },
      ]);

      const tables = await ownerPool.query<{
        readonly force_rls: boolean;
        readonly owner_matches: boolean;
        readonly policy_count: string;
        readonly rls: boolean;
        readonly table_name: string;
      }>(`
      SELECT
        relation.relname AS table_name,
        owner.rolname = session_user AS owner_matches,
        relation.relrowsecurity AS rls,
        relation.relforcerowsecurity AS force_rls,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = relation.oid
        ) AS policy_count
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
      WHERE namespace.nspname = 'dasher'
        AND relation.relkind = 'r'
      ORDER BY relation.relname
    `);
      expect(tables.rows).toEqual(
        canonicalTables.map((table_name) => ({
          table_name,
          owner_matches: true,
          rls: true,
          force_rls: true,
          policy_count: "0",
        })),
      );

      const columns = await ownerPool.query<{ readonly signature: string }>(`
      SELECT
        relation.relname || '|' ||
        attribute.attnum::text || '|' ||
        attribute.attname || '|' ||
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
        attribute.attnotnull::text || '|' ||
        COALESCE(
          pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid),
          '<none>'
        ) AS signature
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = 'dasher'
        AND relation.relkind = 'r'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attnum
    `);
      expect(columns.rows.map((row) => row.signature)).toEqual(expectedColumns);
    });

    it("pins relation-scoped primary, unique, and CHECK definitions", async () => {
      const constraints = await ownerPool.query<{
        readonly signature: string;
      }>(`
      SELECT
        relation.relname || '|' ||
        constraint_row.conname || '|' ||
        constraint_row.contype::text || '|' ||
        pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
          '[[:space:]]+',
          ' ',
          'g'
        ) || '|' ||
        constraint_row.convalidated::text AS signature
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'dasher'
        AND constraint_row.contype IN ('p', 'u', 'c')
      ORDER BY relation.relname, constraint_row.contype, constraint_row.conname
    `);
      expect(constraints.rows.map((row) => row.signature)).toEqual(
        expectedRelationConstraints,
      );
    });

    it("rejects NaN and negative audit usage while accepting finite nonnegative values", async () => {
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        try {
          const organizationId = "00000000-0000-4000-8000-000000004000";
          await client.query(
            `
              INSERT INTO dasher.organizations (organization_id, display_name)
              VALUES ($1, 'Synthetic Task 3 Usage Organization')
            `,
            [organizationId],
          );

          const insertAuditUsage = (suffix: string, usageUnits: string) =>
            client.query(
              `
                INSERT INTO dasher.audit_events (
                  audit_event_id,
                  organization_id,
                  actor_kind,
                  actor_service,
                  authority_revision,
                  request_id,
                  action,
                  target_type,
                  target_id,
                  outcome,
                  usage_units,
                  deployment_revision
                ) VALUES (
                  $1,
                  $2,
                  'service',
                  'task3-usage-test',
                  1,
                  $3,
                  'session.issued',
                  'session',
                  $4,
                  'succeeded',
                  $5::numeric,
                  'synthetic-task3'
                )
              `,
              [
                `00000000-0000-4000-8000-0000000041${suffix}`,
                organizationId,
                `00000000-0000-4000-8000-0000000042${suffix}`,
                `00000000-0000-4000-8000-0000000043${suffix}`,
                usageUnits,
              ],
            );

          await client.query("SAVEPOINT reject_nan_usage");
          await expect(insertAuditUsage("01", "NaN")).rejects.toMatchObject({
            code: "23514",
            constraint: "audit_events_usage_units_check",
          });
          await client.query("ROLLBACK TO SAVEPOINT reject_nan_usage");

          await client.query("SAVEPOINT reject_negative_usage");
          await expect(
            insertAuditUsage("02", "-0.000001"),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: "audit_events_usage_units_check",
          });
          await client.query("ROLLBACK TO SAVEPOINT reject_negative_usage");

          await insertAuditUsage("03", "0");
          await insertAuditUsage("04", "123.456789");
          const accepted = await client.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.audit_events
              WHERE organization_id = $1
            `,
            [organizationId],
          );
          expect(accepted.rows[0]?.count).toBe("2");
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    });

    it("pins exact relation-OID foreign keys and detects a reduced-arity wrong-relation replacement", async () => {
      expect(await readForeignKeys()).toEqual(expectedForeignKeys);

      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
        ALTER TABLE dasher.sessions
          DROP CONSTRAINT sessions_membership_fkey;
        ALTER TABLE dasher.sessions
          ADD CONSTRAINT sessions_membership_fkey
          FOREIGN KEY (user_id) REFERENCES dasher.users (user_id)
      `);
        const attacked = await readForeignKeys(client);
        expect(attacked).not.toEqual(expectedForeignKeys);
        expect(attacked).toContain(
          "dasher.sessions|sessions_membership_fkey|dasher.users|{user_id}|{user_id}|1|saa|true|false|false",
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }

      expect(await readForeignKeys()).toEqual(expectedForeignKeys);
    });

    it("pins every B-tree index column, order, uniqueness, predicate, opclass, and state", async () => {
      const indexes = await ownerPool.query<{ readonly signature: string }>(`
      SELECT
        relation.relname || '|' ||
        index_relation.relname || '|' ||
        access_method.amname || '|' ||
        index_row.indisunique::text || '|' ||
        index_row.indisprimary::text || '|' ||
        index_row.indisvalid::text || '|' ||
        index_row.indisready::text || '|' ||
        (index_row.indnatts = index_row.indnkeyatts)::text || '|' ||
        index_row.indnullsnotdistinct::text || '|' ||
        COALESCE(
          pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid),
          '<none>'
        ) || '|' ||
        ARRAY(
          SELECT pg_catalog.pg_get_indexdef(
            index_row.indexrelid,
            ordinal,
            false
          )
          FROM pg_catalog.generate_series(1, index_row.indnkeyatts)
            AS ordinal
        )::text || '|' ||
        ARRAY(
          SELECT operator_class.opcname
          FROM pg_catalog.unnest(index_row.indclass::oid[]) WITH ORDINALITY
            AS class(oid, ordinal)
          JOIN pg_catalog.pg_opclass AS operator_class
            ON operator_class.oid = class.oid
          ORDER BY class.ordinal
        )::text || '|' ||
        index_row.indoption::text AS signature
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = index_row.indrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = 'dasher'
      ORDER BY relation.relname, index_relation.relname
    `);
      expect(indexes.rows.map((row) => row.signature)).toEqual(expectedIndexes);
    });

    it("pins the audit trigger event mask and immutable function definition", async () => {
      const result = await ownerPool.query<{
        readonly acl: string[];
        readonly body: string;
        readonly delete_event: boolean;
        readonly enabled: string;
        readonly function_identity: string;
        readonly function_owner_matches: boolean;
        readonly insert_event: boolean;
        readonly language_name: string;
        readonly is_before: boolean;
        readonly is_row: boolean;
        readonly is_security_definer: boolean;
        readonly proconfig: string[];
        readonly table_name: string;
        readonly trigger_name: string;
        readonly truncate_event: boolean;
        readonly update_event: boolean;
        readonly volatility: string;
      }>(`
      SELECT
        relation.relname AS table_name,
        trigger_row.tgname AS trigger_name,
        trigger_row.tgenabled::text AS enabled,
        (trigger_row.tgtype & 1) = 1 AS is_row,
        (trigger_row.tgtype & 2) = 2 AS is_before,
        (trigger_row.tgtype & 4) = 4 AS insert_event,
        (trigger_row.tgtype & 8) = 8 AS delete_event,
        (trigger_row.tgtype & 16) = 16 AS update_event,
        (trigger_row.tgtype & 32) = 32 AS truncate_event,
        function_namespace.nspname || '.' || procedure.proname || '(' ||
          pg_catalog.oidvectortypes(procedure.proargtypes) || ')'
          AS function_identity,
        owner.rolname = session_user AS function_owner_matches,
        procedure.prosecdef AS is_security_definer,
        language.lanname AS language_name,
        procedure.provolatile::text AS volatility,
        procedure.proconfig,
        procedure.prosrc AS body,
        ARRAY(
          SELECT
            CASE
              WHEN privilege.grantee = procedure.proowner THEN 'OWNER'
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE grantee.rolname
            END || ':' || privilege.privilege_type || ':' ||
            privilege.is_grantable::text
          FROM pg_catalog.aclexplode(
            COALESCE(
              procedure.proacl,
              pg_catalog.acldefault('f', procedure.proowner)
            )
          ) AS privilege
          LEFT JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          ORDER BY 1
        ) AS acl
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc AS procedure
        ON procedure.oid = trigger_row.tgfoid
      JOIN pg_catalog.pg_namespace AS function_namespace
        ON function_namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
      WHERE namespace.nspname = 'dasher'
        AND NOT trigger_row.tgisinternal
    `);
      expect(result.rows).toEqual([
        {
          table_name: "audit_events",
          trigger_name: "audit_events_immutable",
          enabled: "O",
          is_row: true,
          is_before: true,
          insert_event: false,
          delete_event: true,
          update_event: true,
          truncate_event: false,
          function_identity: "dasher_private.reject_immutable_mutation()",
          function_owner_matches: true,
          is_security_definer: false,
          language_name: "plpgsql",
          volatility: "v",
          proconfig: ["search_path=pg_catalog"],
          body: "\nBEGIN\n  RAISE EXCEPTION USING\n    ERRCODE = '55000',\n    MESSAGE = 'immutable relation rejects update and delete';\nEND\n",
          acl: ["OWNER:EXECUTE:false"],
        },
      ]);
    });

    it("pins exact owner, PUBLIC, app, table, function, and default ACL closure", async () => {
      const acl = await ownerPool.query<{ readonly signature: string }>(`
      WITH objects AS (
        SELECT
          'database'::text AS kind,
          'current_database'::text AS identity,
          database_row.datacl AS acl,
          pg_catalog.acldefault('d', database_row.datdba) AS default_acl,
          database_row.datdba AS owner_oid
        FROM pg_catalog.pg_database AS database_row
        WHERE database_row.datname = pg_catalog.current_database()
        UNION ALL
        SELECT
          'schema',
          namespace.nspname,
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner),
          namespace.nspowner
        FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspname IN (
          'public', 'dasher', 'dasher_meta', 'dasher_private'
        )
        UNION ALL
        SELECT
          'table',
          namespace.nspname || '.' || relation.relname,
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner),
          relation.relowner
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('dasher', 'dasher_meta')
          AND relation.relkind = 'r'
        UNION ALL
        SELECT
          'function',
          namespace.nspname || '.' || procedure.proname || '(' ||
            pg_catalog.oidvectortypes(procedure.proargtypes) || ')',
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner),
          procedure.proowner
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname IN ('dasher', 'dasher_private')
      )
      SELECT
        objects.kind || '|' || objects.identity || '|' ||
        pg_catalog.array_to_string(
          ARRAY(
            SELECT
              CASE
                WHEN privilege.grantee = objects.owner_oid THEN 'OWNER'
                WHEN privilege.grantee = 0 THEN 'PUBLIC'
                ELSE grantee.rolname
              END || ':' || privilege.privilege_type || ':' ||
              privilege.is_grantable::text
            FROM pg_catalog.aclexplode(
              COALESCE(objects.acl, objects.default_acl)
            ) AS privilege
            LEFT JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = privilege.grantee
            ORDER BY
              CASE
                WHEN privilege.grantee = objects.owner_oid THEN 'OWNER'
                WHEN privilege.grantee = 0 THEN 'PUBLIC'
                ELSE grantee.rolname
              END,
              privilege.privilege_type
          ),
          ','
        ) AS signature
      FROM objects
      ORDER BY objects.kind, objects.identity
    `);
      expect(acl.rows.map((row) => row.signature).sort()).toEqual(
        expectedObjectAcls,
      );

      const closure = await ownerPool.query<{
        readonly column_acl_count: string;
        readonly default_acl_count: string;
        readonly managed_grant_count: string;
      }>(`
      SELECT
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_attribute AS attribute
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('dasher', 'dasher_meta')
            AND attribute.attacl IS NOT NULL
        ) AS column_acl_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_default_acl AS default_acl
          WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) = session_user
        ) AS default_acl_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM (
            SELECT privilege.grantee
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl)
              AS privilege
            WHERE namespace.nspname IN ('dasher', 'dasher_meta')
            UNION ALL
            SELECT privilege.grantee
            FROM pg_catalog.pg_proc AS procedure
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = procedure.pronamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl)
              AS privilege
            WHERE namespace.nspname IN ('dasher', 'dasher_private')
          ) AS grants
          JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = grants.grantee
          WHERE grantee.rolname IN (
            'dasher_app', 'dasher_security_definer'
          )
        ) AS managed_grant_count
    `);
      expect(closure.rows[0]).toEqual({
        column_acl_count: "0",
        default_acl_count: "2",
        managed_grant_count: "0",
      });

      const defaultAcls = await ownerPool.query<{
        readonly signature: string;
      }>(`
        SELECT
          default_acl.defaclobjtype::text || '|' ||
          (default_acl.defaclnamespace = 0)::text || '|' ||
          CASE
            WHEN privilege.grantee = default_acl.defaclrole THEN 'OWNER'
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(privilege.grantee)
          END || ':' || privilege.privilege_type || ':' ||
          privilege.is_grantable::text AS signature
        FROM pg_catalog.pg_default_acl AS default_acl
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl)
          AS privilege
        WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) = session_user
        ORDER BY signature
      `);
      expect(defaultAcls.rows.map((row) => row.signature)).toEqual([
        "T|true|OWNER:USAGE:false",
        "f|true|OWNER:EXECUTE:false",
      ]);

      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query(`
            CREATE FUNCTION dasher_private.task3_future_function()
            RETURNS boolean
            LANGUAGE sql
            SET search_path = pg_catalog
            AS 'SELECT true';
            CREATE TYPE dasher.task3_future_type AS (value integer)
          `);
          const futurePublicPrivileges = await client.query<{
            readonly public_execute_count: string;
            readonly public_usage_count: string;
          }>(`
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_proc AS procedure
                CROSS JOIN LATERAL pg_catalog.aclexplode(
                  COALESCE(
                    procedure.proacl,
                    pg_catalog.acldefault('f', procedure.proowner)
                  )
                ) AS privilege
                WHERE procedure.oid =
                  'dasher_private.task3_future_function()'::regprocedure
                  AND privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_type AS type_row
                CROSS JOIN LATERAL pg_catalog.aclexplode(
                  COALESCE(
                    type_row.typacl,
                    pg_catalog.acldefault('T', type_row.typowner)
                  )
                ) AS privilege
                WHERE type_row.oid = 'dasher.task3_future_type'::regtype
                  AND privilege.grantee = 0
                  AND privilege.privilege_type = 'USAGE'
              ) AS public_usage_count
          `);
          expect(futurePublicPrivileges.rows[0]).toEqual({
            public_execute_count: "0",
            public_usage_count: "0",
          });
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    });

    it("rejects owner update and delete on audit", async () => {
      await ownerPool.query(`
      INSERT INTO dasher.users (user_id)
      VALUES ('00000000-0000-4000-8000-000000003001');
      INSERT INTO dasher.organizations (organization_id, display_name)
      VALUES (
        '00000000-0000-4000-8000-000000003002',
        'Synthetic Task 3 Organization'
      );
      INSERT INTO dasher.memberships (
        membership_id,
        organization_id,
        user_id,
        role,
        state,
        authority_revision
      ) VALUES (
        '00000000-0000-4000-8000-000000003003',
        '00000000-0000-4000-8000-000000003002',
        '00000000-0000-4000-8000-000000003001',
        'admin',
        'active',
        1
      );
      INSERT INTO dasher.audit_events (
        audit_event_id,
        organization_id,
        actor_kind,
        actor_user_id,
        authority_revision,
        request_id,
        action,
        target_type,
        target_id,
        outcome,
        deployment_revision
      ) VALUES (
        '00000000-0000-4000-8000-000000003004',
        '00000000-0000-4000-8000-000000003002',
        'user',
        '00000000-0000-4000-8000-000000003001',
        1,
        '00000000-0000-4000-8000-000000003005',
        'membership.role_changed',
        'membership',
        '00000000-0000-4000-8000-000000003003',
        'succeeded',
        'synthetic-task3'
      )
    `);

      await expectPostgresError(
        ownerPool.query(`
        UPDATE dasher.audit_events
        SET target_id = target_id
        WHERE audit_event_id = '00000000-0000-4000-8000-000000003004'
      `),
        "55000",
      );
      await expectPostgresError(
        ownerPool.query(`
        DELETE FROM dasher.audit_events
        WHERE audit_event_id = '00000000-0000-4000-8000-000000003004'
      `),
        "55000",
      );
    });

    it("denies app enumeration of both identity tables outside and inside forged context", async () => {
      await createTemporaryAppLogin(
        ownerPool,
        config.appDsn,
        config.appUsername,
      );
      appLoginCreated = true;
      appPool = new Pool({ connectionString: config.appDsn, max: 2 });

      const client = await appPool.connect();
      try {
        await client.query("SET ROLE dasher_app");
        for (const table of ["users", "external_identities"] as const) {
          await expectPostgresDenial(
            client,
            `SELECT count(*) FROM dasher.${table}`,
          );

          await client.query("BEGIN");
          try {
            await client.query(
              "SELECT pg_catalog.set_config('dasher.organization_id', '00000000-0000-4000-8000-000000003002', true)",
            );
            await client.query(
              "SELECT pg_catalog.set_config('dasher.user_id', '00000000-0000-4000-8000-000000003001', true)",
            );
            await client.query(
              "SELECT pg_catalog.set_config('dasher.authority_revision', '1', true)",
            );
            await expectPostgresDenial(
              client,
              `SELECT count(*) FROM dasher.${table}`,
            );
          } finally {
            await client.query("ROLLBACK");
          }
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });
  },
);
