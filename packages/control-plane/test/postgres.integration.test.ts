import { Buffer } from "node:buffer";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parsePostgresIntegrationEnv, runMigrations } from "../src/index.js";
import {
  borrowedClientPool,
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

async function resetManagedSchemas(): Promise<void> {
  await ownerPool.query(`
    DROP SCHEMA IF EXISTS fixture_role_owned CASCADE;
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
    }>(
      `
        SELECT
          current_setting('server_version_num')::integer
            BETWEEN 160000 AND 169999 AS postgres_16,
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
            WHERE nspname IN ('dasher', 'dasher_meta', 'fixture_role_owned')
          ) AS managed_namespace_exists
      `,
      [config.appUsername, shapeOwnerRole, setRoleExecutor],
    );
    const row = result.rows[0];

    expect(row?.postgres_16).toBe(true);
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
