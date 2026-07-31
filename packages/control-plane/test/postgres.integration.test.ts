import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InvitationRepository,
  OperationDeniedError,
  OperationInternalError,
  SecretKeyRing,
  bootstrapManagedRoles,
  createVerifiedPrincipalFromServerVerification,
  discoverMigrations,
  parsePostgresIntegrationEnv,
  runMigrations,
  type MigrationClient,
  type PgCompatiblePool,
} from "../src/index.js";
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
const siblingDatabaseNonce = randomUUID().replaceAll("-", "");

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
    DROP SCHEMA IF EXISTS dasher_api CASCADE;
    DROP SCHEMA IF EXISTS dasher_private CASCADE;
    DROP SCHEMA IF EXISTS dasher CASCADE;
    DROP SCHEMA IF EXISTS dasher_meta CASCADE
  `);
}

async function prepareAppliedJournal(): Promise<void> {
  await resetManagedSchemas();
  const result = await runMigrations(ownerPool, fixtureMigrationDirectory, []);
  expect(result.appliedCount).toBe(2);
}

async function expectOwnerNoOpWithAppLogin(): Promise<void> {
  await expect(
    runMigrations(ownerPool, fixtureMigrationDirectory, [config.appUsername]),
  ).resolves.toEqual({
    discoveredCount: 2,
    previouslyAppliedCount: 2,
    appliedCount: 0,
  });
}

function ownerDsnForDatabase(databaseName: string): string {
  const url = new URL(config.ownerDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function databaseOidByName(
  databaseName: string,
): Promise<string | undefined> {
  const identity = await ownerPool.query<{ readonly database_oid: string }>(
    `
      SELECT database_row.oid::text AS database_oid
      FROM pg_catalog.pg_database AS database_row
      WHERE database_row.datname = $1
    `,
    [databaseName],
  );
  return identity.rows[0]?.database_oid;
}

async function createSiblingDatabase(
  databaseName: string,
): Promise<{ readonly databaseOid: string; readonly pool: Pool }> {
  const client = await ownerPool.connect();
  try {
    await executeServerFormattedSql(client, "CREATE DATABASE %I", [
      databaseName,
    ]);
  } finally {
    client.release();
  }

  const databaseOid = await databaseOidByName(databaseName);
  if (databaseOid === undefined) {
    throw new Error("PostgreSQL did not return the sibling database OID");
  }

  return {
    databaseOid,
    pool: new Pool({
      connectionString: ownerDsnForDatabase(databaseName),
      max: 1,
    }),
  };
}

async function managedDependencyCount(databaseOid: string): Promise<string> {
  const result = await ownerPool.query<{ readonly count: string }>(
    `
      SELECT pg_catalog.count(*)::text AS count
      FROM pg_catalog.pg_shdepend AS dependency
      JOIN pg_catalog.pg_roles AS referenced_role
        ON referenced_role.oid = dependency.refobjid
      WHERE dependency.dbid = $1::oid
        AND dependency.refclassid = 'pg_catalog.pg_authid'::regclass
        AND dependency.deptype IN ('a', 'o')
        AND referenced_role.rolname IN (
          'dasher_app',
          'dasher_security_definer'
        )
    `,
    [databaseOid],
  );
  return result.rows[0]?.count ?? "missing";
}

async function dropSiblingDatabase(
  databaseName: string,
  databaseOid: string,
): Promise<void> {
  await ownerPool.query(
    `
      SELECT pg_catalog.pg_terminate_backend(activity.pid)
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.datname = $1
        AND activity.pid <> pg_catalog.pg_backend_pid()
    `,
    [databaseName],
  );

  const client = await ownerPool.connect();
  try {
    await executeServerFormattedSql(client, "DROP DATABASE IF EXISTS %I", [
      databaseName,
    ]);
  } finally {
    client.release();
  }

  const residue = await ownerPool.query<{
    readonly database_exists: boolean;
    readonly dependency_count: string;
  }>(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database AS database_row
          WHERE database_row.datname = $1
        ) AS database_exists,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.dbid = $2::oid
        ) AS dependency_count
    `,
    [databaseName, databaseOid],
  );
  expect(residue.rows[0]).toEqual({
    database_exists: false,
    dependency_count: "0",
  });
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
    const databaseAclCleanupClient = await ownerPool.connect();
    try {
      const managedAppRole = await databaseAclCleanupClient.query<{
        readonly exists: boolean;
      }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dasher_app') AS exists",
      );
      if (managedAppRole.rows[0]?.exists === true) {
        await executeServerFormattedSql(
          databaseAclCleanupClient,
          "REVOKE CONNECT ON DATABASE %I FROM dasher_app",
          [config.ownerDatabase],
        );
      }
    } finally {
      databaseAclCleanupClient.release();
    }
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
  it("bootstraps the same cluster roles concurrently from two disposable databases", async () => {
    const databaseNames = [
      `dasher_t2_${siblingDatabaseNonce}_bootstrap_a`,
      `dasher_t2_${siblingDatabaseNonce}_bootstrap_b`,
    ] as const;
    const databases: {
      readonly databaseName: string;
      readonly databaseOid: string;
      readonly pool: Pool;
    }[] = [];
    const bootstrapConnections: {
      readonly client: PoolClient;
      released: boolean;
    }[] = [];
    const cleanupFailures: unknown[] = [];
    let createArrivals = 0;
    let releaseCreateBarrier: (() => void) | undefined;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreateBarrier = resolve;
    });
    const releaseBarrier = (): void => {
      releaseCreateBarrier?.();
      releaseCreateBarrier = undefined;
    };

    try {
      for (const databaseName of databaseNames) {
        const sibling = await createSiblingDatabase(databaseName);
        databases.push({ databaseName, ...sibling });
      }

      for (const database of databases) {
        const client = await database.pool.connect();
        const connection = { client, released: false };
        bootstrapConnections.push(connection);
        try {
          await client.query("SET statement_timeout = '30s'");
          await client.query("SET lock_timeout = '20s'");
        } catch (error) {
          client.release();
          connection.released = true;
          throw error;
        }
      }

      const operations = bootstrapConnections.map((connection) => {
        const query = (async (text: string, values?: readonly unknown[]) => {
          if (text.trim().startsWith("CREATE ROLE dasher_app WITH")) {
            createArrivals += 1;
            if (createArrivals === bootstrapConnections.length) {
              releaseBarrier();
            }
            await createBarrier;
          }
          return connection.client.query(text, values as unknown[] | undefined);
        }) as MigrationClient["query"];
        const operation = bootstrapManagedRoles(
          {
            query,
            release() {
              // The test releases the borrowed client after settlement.
            },
          },
          [],
        );
        return operation
          .catch((error) => {
            releaseBarrier();
            throw error;
          })
          .finally(() => {
            connection.client.release();
            connection.released = true;
          });
      });
      const settlements = await Promise.allSettled(operations);
      releaseBarrier();

      for (const settlement of settlements) {
        if (settlement.status === "rejected") {
          expect(settlement.reason).not.toMatchObject({ code: "42710" });
          expect(settlement.reason).not.toMatchObject({ code: "23505" });
          expect(settlement.reason).not.toMatchObject({ code: "40P01" });
          expect(String(settlement.reason)).not.toContain("deadlock detected");
        }
      }
      expect(createArrivals).toBe(2);
      expect(settlements).toHaveLength(2);
      expect(
        settlements.every((settlement) => settlement.status === "fulfilled"),
      ).toBe(true);
      expect(
        settlements
          .filter((settlement) => settlement.status === "fulfilled")
          .map((settlement) => settlement.value),
      ).toEqual([undefined, undefined]);

      const roles = await ownerPool.query<{
        readonly attributes_match: boolean;
        readonly comment: string | null;
        readonly has_settings: boolean;
        readonly password_is_null: boolean;
        readonly role_name: string;
      }>(`
        SELECT
          role.rolname::text AS role_name,
          NOT role.rolcanlogin
            AND NOT role.rolinherit
            AND NOT role.rolsuper
            AND NOT role.rolcreatedb
            AND NOT role.rolcreaterole
            AND NOT role.rolreplication
            AND role.rolbypassrls =
              (role.rolname = 'dasher_security_definer')
            AND role.rolconnlimit = -1
            AND role.rolvaliduntil IS NULL AS attributes_match,
          role.rolpassword IS NULL AS password_is_null,
          pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_db_role_setting AS setting
            WHERE setting.setrole = role.oid
          ) AS has_settings
        FROM pg_catalog.pg_authid AS role
        WHERE role.rolname IN ('dasher_app', 'dasher_security_definer')
        ORDER BY role.rolname
      `);
      expect(roles.rows).toEqual([
        {
          attributes_match: true,
          comment: "dasher:managed-role:v1:app",
          has_settings: false,
          password_is_null: true,
          role_name: "dasher_app",
        },
        {
          attributes_match: true,
          comment: "dasher:managed-role:v1:security-definer",
          has_settings: false,
          password_is_null: true,
          role_name: "dasher_security_definer",
        },
      ]);
      for (const database of databases) {
        expect(await managedDependencyCount(database.databaseOid)).toBe("0");
      }
    } finally {
      releaseBarrier();
      for (const connection of bootstrapConnections) {
        if (!connection.released) {
          try {
            connection.client.release();
            connection.released = true;
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      for (const database of [...databases].reverse()) {
        try {
          await database.pool.end();
        } catch (error) {
          cleanupFailures.push(error);
        }
        try {
          await dropSiblingDatabase(
            database.databaseName,
            database.databaseOid,
          );
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      for (const databaseName of databaseNames) {
        if (
          databases.some((database) => database.databaseName === databaseName)
        ) {
          continue;
        }
        try {
          const residualOid = await databaseOidByName(databaseName);
          if (residualOid !== undefined) {
            await dropSiblingDatabase(databaseName, residualOid);
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await ownerPool.query(
          "DROP ROLE IF EXISTS dasher_security_definer, dasher_app",
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        const residue = await ownerPool.query<{
          readonly database_count: string;
          readonly role_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_database AS database_row
                WHERE database_row.datname = ANY($1::text[])
              ) AS database_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_roles AS role
                WHERE role.rolname IN (
                  'dasher_app',
                  'dasher_security_definer'
                )
              ) AS role_count
          `,
          [databaseNames],
        );
        expect(residue.rows[0]).toEqual({
          database_count: "0",
          role_count: "0",
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
      expect(cleanupFailures).toEqual([]);
    }
  }, 120_000);

  it("applies a clean exact series and repeats as a database-clock no-op", async () => {
    try {
      const applied = await runMigrations(
        ownerPool,
        fixtureMigrationDirectory,
        [],
      );
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
        [],
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
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
          runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
        runMigrations(ownerPool, checksumDriftMigrationDirectory, []),
        "journal_identity_mismatch",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, renamedMigrationDirectory, []),
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
          runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
          runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
          [],
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
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
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
          [],
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
      runMigrations(appPool, fixtureMigrationDirectory, [config.appUsername]),
      "executor_role_invalid",
    );

    const appClient: PoolClient = await appPool.connect();
    try {
      await appClient.query("SET ROLE dasher_app");
      await expectMigrationRejection(
        runMigrations(
          borrowedClientPool(appClient),
          fixtureMigrationDirectory,
          [config.appUsername],
        ),
        "executor_set_role",
      );
    } finally {
      await appClient.query("RESET ROLE");
      appClient.release();
    }
  });

  it("runs an owner no-op with the exact provisioned app login", async () => {
    await expect(
      runMigrations(ownerPool, fixtureMigrationDirectory, [config.appUsername]),
    ).resolves.toEqual({
      discoveredCount: 2,
      previouslyAppliedCount: 0,
      appliedCount: 2,
    });
    await expectOwnerNoOpWithAppLogin();
  });

  it("rejects and recovers from expected-login marker, flag, membership-option, and grant drift", async () => {
    const databaseIdentity = await ownerPool.query<{
      readonly database_oid: string;
    }>(`
      SELECT database_row.oid::text AS database_oid
      FROM pg_catalog.pg_database AS database_row
      WHERE database_row.datname = pg_catalog.current_database()
    `);
    const databaseOid = databaseIdentity.rows[0]?.database_oid;
    if (databaseOid === undefined) {
      throw new Error("PostgreSQL did not return the current database OID");
    }
    const exactMarker = `dasher:app-login:v1:database-oid:${databaseOid}`;

    const driftCases: readonly {
      readonly mutate: () => Promise<void>;
      readonly name: string;
      readonly restore: () => Promise<void>;
    }[] = [
      {
        name: "database marker",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "COMMENT ON ROLE %I IS %L",
              [config.appUsername, "dasher:app-login:v1:database-oid:0"],
            );
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "COMMENT ON ROLE %I IS %L",
              [config.appUsername, exactMarker],
            );
          } finally {
            client.release();
          }
        },
      },
      {
        name: "safe role flag",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(client, "ALTER ROLE %I INHERIT", [
              config.appUsername,
            ]);
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(client, "ALTER ROLE %I NOINHERIT", [
              config.appUsername,
            ]);
          } finally {
            client.release();
          }
        },
      },
      {
        name: "membership option",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "REVOKE dasher_app FROM %I",
              [config.appUsername],
            );
            await executeServerFormattedSql(
              client,
              "GRANT dasher_app TO %I WITH INHERIT TRUE, SET TRUE, ADMIN FALSE",
              [config.appUsername],
            );
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "REVOKE dasher_app FROM %I",
              [config.appUsername],
            );
            await executeServerFormattedSql(
              client,
              "GRANT dasher_app TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE",
              [config.appUsername],
            );
          } finally {
            client.release();
          }
        },
      },
      {
        name: "extra database grant",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "GRANT TEMPORARY ON DATABASE %I TO %I",
              [config.ownerDatabase, config.appUsername],
            );
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "REVOKE TEMPORARY ON DATABASE %I FROM %I",
              [config.ownerDatabase, config.appUsername],
            );
          } finally {
            client.release();
          }
        },
      },
    ];

    for (const driftCase of driftCases) {
      try {
        await driftCase.mutate();
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory, [
            config.appUsername,
          ]),
          "managed_role_drift",
        );
      } catch (error) {
        throw new Error(`expected-login drift case failed: ${driftCase.name}`, {
          cause: error,
        });
      } finally {
        await driftCase.restore();
      }
      await expectOwnerNoOpWithAppLogin();
    }
  });

  it("rejects a managed-role-owned object in a sibling database and removes all residue", async () => {
    const databaseName = `dasher_t4_${siblingDatabaseNonce}_owned`;
    let sibling:
      | {
          readonly databaseOid: string;
          readonly pool: Pool;
        }
      | undefined;

    try {
      sibling = await createSiblingDatabase(databaseName);
      await sibling.pool.query(
        "CREATE SCHEMA sibling_owned AUTHORIZATION dasher_security_definer",
      );
      expect(Number(await managedDependencyCount(sibling.databaseOid))).toBe(1);
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, [
          config.appUsername,
        ]),
        "managed_role_drift",
      );
    } finally {
      if (sibling !== undefined) {
        try {
          await sibling.pool.query(
            "DROP SCHEMA IF EXISTS sibling_owned CASCADE",
          );
        } finally {
          try {
            await sibling.pool.end();
          } finally {
            try {
              expect(await managedDependencyCount(sibling.databaseOid)).toBe(
                "0",
              );
            } finally {
              await dropSiblingDatabase(databaseName, sibling.databaseOid);
            }
          }
        }
      } else {
        const residualOid = await databaseOidByName(databaseName);
        if (residualOid !== undefined) {
          await dropSiblingDatabase(databaseName, residualOid);
        }
      }
    }
    await expectOwnerNoOpWithAppLogin();
  });

  it("rejects a managed-role ACL in a sibling database and removes all residue", async () => {
    const databaseName = `dasher_t4_${siblingDatabaseNonce}_acl`;
    let sibling:
      | {
          readonly databaseOid: string;
          readonly pool: Pool;
        }
      | undefined;

    try {
      sibling = await createSiblingDatabase(databaseName);
      await sibling.pool.query(
        "CREATE TABLE public.sibling_probe (probe_id integer PRIMARY KEY)",
      );
      await sibling.pool.query(
        "GRANT SELECT ON TABLE public.sibling_probe TO dasher_app",
      );
      expect(Number(await managedDependencyCount(sibling.databaseOid))).toBe(1);
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, [
          config.appUsername,
        ]),
        "managed_role_drift",
      );
    } finally {
      if (sibling !== undefined) {
        try {
          await sibling.pool.query(
            "REVOKE SELECT ON TABLE public.sibling_probe FROM dasher_app",
          );
          await sibling.pool.query("DROP TABLE IF EXISTS public.sibling_probe");
        } finally {
          try {
            await sibling.pool.end();
          } finally {
            try {
              expect(await managedDependencyCount(sibling.databaseOid)).toBe(
                "0",
              );
            } finally {
              await dropSiblingDatabase(databaseName, sibling.databaseOid);
            }
          }
        }
      } else {
        const residualOid = await databaseOidByName(databaseName);
        if (residualOid !== undefined) {
          await dropSiblingDatabase(databaseName, residualOid);
        }
      }
    }
    await expectOwnerNoOpWithAppLogin();
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

const task4Functions = [
  {
    identity:
      "dasher_api.accept_invitation(smallint, bytea, text, text, text, boolean, uuid, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text)",
    result:
      "TABLE(user_id uuid, organization_id uuid, membership_id uuid, granted_role text, authority_revision bigint, session_id uuid, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.change_membership_role(uuid, text, uuid, smallint, bytea, text)",
    result: "TABLE(membership_id uuid, authority_revision bigint)",
    volatility: "v",
  },
  {
    identity: "dasher_api.initialize_context(smallint, bytea, uuid)",
    result:
      "TABLE(session_id uuid, user_id uuid, organization_id uuid, membership_id uuid, authority_revision bigint, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.issue_invitation(uuid, text, text, smallint, bytea, uuid, smallint, bytea, smallint, bytea, uuid, text)",
    result: "TABLE(invitation_id uuid, expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.issue_session(text, text, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text)",
    result:
      "TABLE(user_id uuid, organization_id uuid, membership_id uuid, granted_role text, authority_revision bigint, session_id uuid, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.revoke_invitation(uuid, uuid, smallint, bytea, smallint, bytea, uuid, text)",
    result: "TABLE(invitation_id uuid, revoked_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity: "dasher_api.revoke_membership(uuid, uuid, smallint, bytea, text)",
    result:
      "TABLE(membership_id uuid, authority_revision bigint, revoked_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity: "dasher_api.revoke_session(uuid, uuid, smallint, bytea, text)",
    result: "TABLE(session_id uuid, revoked_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.rotate_session(uuid, smallint, bytea, smallint, bytea, uuid, smallint, bytea, text)",
    result:
      "TABLE(session_id uuid, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity: "dasher_private.context_allows(uuid, text)",
    result: "boolean",
    volatility: "v",
  },
  {
    identity: "dasher_private.context_authority_revision()",
    result: "bigint",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_membership_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_organization_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_request_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_session_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_user_id()",
    result: "uuid",
    volatility: "s",
  },
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
  `database|current_database|OWNER:CONNECT:false,OWNER:CREATE:false,OWNER:TEMPORARY:false,PUBLIC:CONNECT:false,dasher_app:CONNECT:false,${config.appUsername}:CONNECT:false`,
  ...task4Functions.map(
    ({ identity }) =>
      `function|${identity}|OWNER:EXECUTE:false,dasher_app:EXECUTE:false`,
  ),
  "function|dasher_private.reject_immutable_mutation()|OWNER:EXECUTE:false",
  "schema|dasher|OWNER:CREATE:false,OWNER:USAGE:false,dasher_app:USAGE:false,dasher_security_definer:USAGE:false",
  "schema|dasher_api|OWNER:CREATE:false,OWNER:USAGE:false,dasher_app:USAGE:false",
  "schema|dasher_meta|OWNER:CREATE:false,OWNER:USAGE:false",
  "schema|dasher_private|OWNER:CREATE:false,OWNER:USAGE:false,dasher_security_definer:USAGE:false",
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

async function expectDasherBoundaryError(
  operation: Promise<unknown>,
  code: "P1001" | "P1002",
  message: "dasher_denied" | "dasher_conflict",
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code, message });
    const sensitiveDiagnosticFields = [
      "detail",
      "hint",
      "constraint",
      "schema",
      "table",
      "column",
      "dataType",
      "internalQuery",
    ] as const;
    for (const field of sensitiveDiagnosticFields) {
      expect(
        (error as Readonly<Record<string, unknown>>)[field],
      ).toBeUndefined();
    }
    return;
  }
  throw new Error(`expected Task 4 boundary error ${code}`);
}

async function runContextOperation<T>(
  client: PoolClient,
  sessionDigest: Buffer,
  requestId: string,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      `
        SELECT *
        FROM dasher_api.initialize_context(
          1::smallint,
          $1::bytea,
          $2::uuid
        )
      `,
      [sessionDigest, requestId],
    );
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function beginTask4Context(
  client: PoolClient,
  sessionDigest: Buffer,
  requestId = randomUUID(),
): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `
      SELECT *
      FROM dasher_api.initialize_context(
        1::smallint,
        $1::bytea,
        $2::uuid
      )
    `,
    [sessionDigest, requestId],
  );
}

interface Task4Actor {
  readonly csrfDigest: Buffer;
  readonly identityIssuer: string;
  readonly identitySubject: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly sessionDigest: Buffer;
  readonly sessionId: string;
  readonly userId: string;
}

async function createTask4Actor(
  appClient: PoolClient,
  role: "admin" | "editor" | "viewer",
  organizationId?: string,
  credentials?: Readonly<{
    csrfDigest: Buffer;
    sessionDigest: Buffer;
  }>,
): Promise<Task4Actor> {
  const actor = {
    csrfDigest: credentials?.csrfDigest ?? randomBytes(32),
    identityIssuer: "https://task4-fixture.test",
    identitySubject: randomUUID(),
    membershipId: randomUUID(),
    organizationId: organizationId ?? randomUUID(),
    sessionDigest: credentials?.sessionDigest ?? randomBytes(32),
    sessionId: randomUUID(),
    userId: randomUUID(),
  };

  await ownerPool.query(
    "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
    [actor.userId],
  );
  await ownerPool.query(
    `
      INSERT INTO dasher.external_identities (
        issuer,
        subject,
        user_id
      ) VALUES ($1, $2, $3::uuid)
    `,
    [actor.identityIssuer, actor.identitySubject, actor.userId],
  );
  if (organizationId === undefined) {
    await ownerPool.query(
      `
        INSERT INTO dasher.organizations (
          organization_id,
          display_name
        ) VALUES ($1::uuid, $2)
      `,
      [actor.organizationId, `Task 4 ${actor.organizationId}`],
    );
  }
  await ownerPool.query(
    `
      INSERT INTO dasher.memberships (
        membership_id,
        organization_id,
        user_id,
        role,
        state,
        authority_revision
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', 1)
    `,
    [actor.membershipId, actor.organizationId, actor.userId, role],
  );
  await appClient.query(
    `
      SELECT *
      FROM dasher_api.issue_session(
        $1,
        $2,
        $3::uuid,
        $4::uuid,
        1::smallint,
        $5::bytea,
        1::smallint,
        $6::bytea,
        $7::uuid,
        $8::uuid,
        'task4-test'
      )
    `,
    [
      actor.identityIssuer,
      actor.identitySubject,
      actor.membershipId,
      actor.sessionId,
      actor.sessionDigest,
      actor.csrfDigest,
      randomUUID(),
      randomUUID(),
    ],
  );
  return actor;
}

async function waitForDatabaseLock(
  observer: PoolClient,
  backendPid: number,
  waitEvent:
    | "advisory"
    | "relation"
    | "transactionid"
    | "tuple"
    | ReadonlyArray<"advisory" | "relation" | "transactionid" | "tuple">,
  settledOperation: SettledDatabasePromise<unknown>,
): Promise<void> {
  const waitEvents = typeof waitEvent === "string" ? [waitEvent] : waitEvent;
  const settledSignal = settledOperation.then((result) => ({
    kind: "settled" as const,
    result,
  }));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const observation = await Promise.race([
      observer
        .query<{
          readonly waiting: boolean;
        }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_stat_activity AS activity
              WHERE activity.pid = $1
                AND activity.wait_event_type = 'Lock'
                AND activity.wait_event = ANY($2::text[])
            ) AS waiting
          `,
          [backendPid, waitEvents],
        )
        .then((state) => ({
          kind: "lock" as const,
          waiting: state.rows[0]?.waiting === true,
        })),
      settledSignal,
    ]);
    if (observation.kind === "settled") {
      throw new Error(
        `database operation ${observation.result.status} before reaching ${waitEvents.join("/")} lock barrier`,
      );
    }
    if (observation.waiting) {
      return;
    }
    const pause = await Promise.race([
      new Promise<"poll">((resolve) => setTimeout(() => resolve("poll"), 5)),
      settledSignal,
    ]);
    if (pause !== "poll") {
      throw new Error(
        `database operation ${pause.result.status} before reaching ${waitEvents.join("/")} lock barrier`,
      );
    }
  }
  throw new Error(`backend did not reach ${waitEvents.join("/")} lock barrier`);
}

async function appBackendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ readonly pid: number }>(
    "SELECT pg_catalog.pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("PostgreSQL did not return backend PID");
  }
  return pid;
}

type SettledDatabasePromise<T> = Promise<PromiseSettledResult<T>>;

function settleDatabasePromise<T>(
  promise: Promise<T>,
): SettledDatabasePromise<T> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ reason, status: "rejected" }),
  );
}

function retainDatabasePromise<T>(
  retainedOperations: Array<SettledDatabasePromise<unknown>>,
  promise: Promise<T>,
): SettledDatabasePromise<T> {
  const settled = settleDatabasePromise(promise);
  retainedOperations.push(settled);
  return settled;
}

interface Task4Invitation {
  readonly auditEventId: string;
  readonly invitationId: string;
  readonly normalizedEmail: string;
  readonly requestId: string;
  readonly tokenDigest: Buffer;
}

async function issueTask4Invitation(
  client: PoolClient,
  actor: Task4Actor,
  normalizedEmail: string,
  overrides: Partial<Task4Invitation> = {},
): Promise<Task4Invitation> {
  const invitation = {
    auditEventId: overrides.auditEventId ?? randomUUID(),
    invitationId: overrides.invitationId ?? randomUUID(),
    normalizedEmail,
    requestId: overrides.requestId ?? randomUUID(),
    tokenDigest: overrides.tokenDigest ?? randomBytes(32),
  };
  await client.query(
    `
      SELECT *
      FROM dasher_api.issue_invitation(
        $1::uuid,
        $2,
        'viewer',
        1::smallint,
        $3::bytea,
        $4::uuid,
        1::smallint,
        $5::bytea,
        1::smallint,
        $6::bytea,
        $7::uuid,
        'task4-race'
      )
    `,
    [
      invitation.invitationId,
      invitation.normalizedEmail,
      invitation.tokenDigest,
      invitation.auditEventId,
      actor.sessionDigest,
      actor.csrfDigest,
      invitation.requestId,
    ],
  );
  return invitation;
}

interface Task4Acceptance {
  readonly auditEventId: string;
  readonly csrfDigest: Buffer;
  readonly membershipId: string;
  readonly requestId: string;
  readonly sessionDigest: Buffer;
  readonly sessionId: string;
  readonly userId: string;
}

async function acceptTask4Invitation(
  client: PoolClient,
  invitation: Task4Invitation,
  issuer: string,
  subject: string,
  overrides: Partial<Task4Acceptance> = {},
): Promise<Task4Acceptance> {
  const acceptance = {
    auditEventId: overrides.auditEventId ?? randomUUID(),
    csrfDigest: overrides.csrfDigest ?? randomBytes(32),
    membershipId: overrides.membershipId ?? randomUUID(),
    requestId: overrides.requestId ?? randomUUID(),
    sessionDigest: overrides.sessionDigest ?? randomBytes(32),
    sessionId: overrides.sessionId ?? randomUUID(),
    userId: overrides.userId ?? randomUUID(),
  };
  await client.query(
    `
      SELECT *
      FROM dasher_api.accept_invitation(
        1::smallint,
        $1::bytea,
        $2,
        $3,
        $4,
        true,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        1::smallint,
        $8::bytea,
        1::smallint,
        $9::bytea,
        $10::uuid,
        $11::uuid,
        'task4-race'
      )
    `,
    [
      invitation.tokenDigest,
      issuer,
      subject,
      invitation.normalizedEmail,
      acceptance.userId,
      acceptance.membershipId,
      acceptance.sessionId,
      acceptance.sessionDigest,
      acceptance.csrfDigest,
      acceptance.auditEventId,
      acceptance.requestId,
    ],
  );
  return acceptance;
}

function createTask6KeyRing(): SecretKeyRing {
  return new SecretKeyRing({
    currentVersion: 1,
    verificationKeys: [
      {
        version: 1,
        key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      },
      {
        version: 2,
        key: Uint8Array.from({ length: 32 }, (_, index) => index + 65),
      },
    ],
    retiredVersions: [3],
  });
}

function task6BorrowedPool(client: PoolClient): PgCompatiblePool {
  return {
    async connect() {
      return {
        async query(text: string, values?: readonly unknown[]) {
          return client.query(
            text,
            values === undefined ? undefined : [...values],
          );
        },
        release() {
          // The integration test owns the role-configured client.
        },
      };
    },
  };
}

function task6UuidSource(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("Task 6 integration UUID source exhausted");
    }
    return value;
  };
}

function createTask6Repository(
  client: PoolClient,
  keyRing: SecretKeyRing,
  uuidValues: readonly string[],
  events: Array<Readonly<{ requestId: string; reason: string }>> = [],
): InvitationRepository {
  return new InvitationRepository({
    pool: task6BorrowedPool(client),
    keyRing,
    deploymentRevision: "task6-repository-integration",
    securityEventSink: (event) => {
      events.push(event);
    },
    uuidSource: task6UuidSource(uuidValues),
  });
}

function task6Principal(
  email: string,
  issuer: string = "https://task6-provider.test/immutable",
  subject: string = randomUUID(),
) {
  return createVerifiedPrincipalFromServerVerification({
    issuer,
    subject,
    emailVerified: true,
    verifiedEmail: email,
  });
}

function invitationFamilyLockSql(): string {
  return `
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'dasher:invitation-family:v1:'::text
          || $1::uuid::text
          || ':'::text
          || $2,
        20260730::bigint
      )
    )
  `;
}

async function expectTask4OrganizationKeysDistinct(
  organizationA: string,
  organizationB: string,
): Promise<void> {
  const keys = await ownerPool.query<{
    readonly key_a: string;
    readonly key_b: string;
  }>(
    `
      SELECT
        pg_catalog.hashtextextended(
          'dasher:task4-organization:v1:' || $1::uuid::text,
          20260730::bigint
        )::text AS key_a,
        pg_catalog.hashtextextended(
          'dasher:task4-organization:v1:' || $2::uuid::text,
          20260730::bigint
        )::text AS key_b
    `,
    [organizationA, organizationB],
  );
  expect(keys.rows[0]?.key_a).not.toBe(keys.rows[0]?.key_b);
}

async function issueAdditionalTask4Session(
  client: PoolClient,
  actor: Task4Actor,
  sessionId: string,
): Promise<{ readonly csrfDigest: Buffer; readonly sessionDigest: Buffer }> {
  const proof = {
    csrfDigest: randomBytes(32),
    sessionDigest: randomBytes(32),
  };
  await client.query(
    `
      SELECT *
      FROM dasher_api.issue_session(
        $1,
        $2,
        $3::uuid,
        $4::uuid,
        1::smallint,
        $5::bytea,
        1::smallint,
        $6::bytea,
        $7::uuid,
        $8::uuid,
        'task4-race'
      )
    `,
    [
      actor.identityIssuer,
      actor.identitySubject,
      actor.membershipId,
      sessionId,
      proof.sessionDigest,
      proof.csrfDigest,
      randomUUID(),
      randomUUID(),
    ],
  );
  return proof;
}

async function setTask4ContextGucs(
  client: PoolClient,
  actor: Task4Actor,
  requestId: string,
): Promise<void> {
  for (const [name, value] of [
    ["dasher.context_session_id", actor.sessionId],
    ["dasher.context_user_id", actor.userId],
    ["dasher.context_organization_id", actor.organizationId],
    ["dasher.context_membership_id", actor.membershipId],
    ["dasher.context_authority_revision", "1"],
    ["dasher.context_session_key_version", "1"],
    ["dasher.context_session_digest_hex", actor.sessionDigest.toString("hex")],
    ["dasher.context_request_id", requestId],
  ] as const) {
    await client.query("SELECT pg_catalog.set_config($1, $2, true)", [
      name,
      value,
    ]);
  }
}

const task4AuditColumnsSql = `
  audit_event_id,
  organization_id,
  occurred_at,
  actor_kind,
  actor_user_id,
  actor_service,
  authority_revision,
  request_id,
  job_id,
  action,
  target_type,
  target_id,
  outcome,
  content_sha256,
  source_ref,
  provider,
  credential_version,
  usage_units,
  cost_minor_units,
  deployment_revision
`;

describe.sequential(
  "Task 3 and Task 4 canonical identity and security boundary",
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
      await createTemporaryAppLogin(
        ownerPool,
        config.appDsn,
        config.appUsername,
      );
      appLoginCreated = true;
      canonicalFirstRun = await runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
        [config.appUsername],
      );
      canonicalSecondRun = await runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
        [config.appUsername],
      );
      appPool = new Pool({ connectionString: config.appDsn, max: 4 });
    });

    it("applies exactly immutable 0001 and 0002 and repeats as a no-op", async () => {
      expect(canonicalFirstRun).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 0,
        appliedCount: 2,
      });
      expect(canonicalSecondRun).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 2,
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
        {
          sequence: 2,
          filename: "0002_security_boundary.sql",
          checksum:
            "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
        },
      ]);
    });

    it("pins the exact Task 4 functions, owners, execution properties, returns, ACLs, and source", async () => {
      const migrations = await discoverMigrations(canonicalMigrationDirectory);
      const source = migrations[1]?.sql ?? "";
      const sourceBodies = new Map<string, string>();
      const sourcePattern =
        /CREATE FUNCTION ([^(]+)\([\s\S]*?\)\nRETURNS[\s\S]*?\nAS \$function\$([\s\S]*?)\$function\$;/gu;
      for (const match of source.matchAll(sourcePattern)) {
        const identity = match[1]?.trim();
        const body = match[2];
        if (identity !== undefined && body !== undefined) {
          sourceBodies.set(identity, body);
        }
      }
      expect(sourceBodies.size).toBe(16);

      const functions = await ownerPool.query<{
        readonly acl: string[];
        readonly body: string;
        readonly identity: string;
        readonly language: string;
        readonly owner: string;
        readonly proconfig: string[];
        readonly result: string;
        readonly security_definer: boolean;
        readonly volatility: string;
      }>(`
        SELECT
          namespace.nspname || '.' || routine.proname || '(' ||
            pg_catalog.oidvectortypes(routine.proargtypes) || ')'
            AS identity,
          pg_catalog.pg_get_function_result(routine.oid) AS result,
          owner.rolname AS owner,
          routine.prosecdef AS security_definer,
          language.lanname AS language,
          routine.provolatile::text AS volatility,
          routine.proconfig,
          routine.prosrc AS body,
          ARRAY(
            SELECT
              CASE
                WHEN privilege.grantee = routine.proowner THEN 'OWNER'
                WHEN privilege.grantee = 0 THEN 'PUBLIC'
                ELSE grantee.rolname
              END || ':' || privilege.privilege_type || ':' ||
              privilege.is_grantable::text
            FROM pg_catalog.aclexplode(
              COALESCE(
                routine.proacl,
                pg_catalog.acldefault('f', routine.proowner)
              )
            ) AS privilege
            LEFT JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = privilege.grantee
            ORDER BY 1
          ) AS acl
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = routine.pronamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
        JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
        WHERE namespace.nspname IN ('dasher_api', 'dasher_private')
          AND owner.rolname = 'dasher_security_definer'
        ORDER BY identity
      `);

      expect(
        functions.rows.map((row) => ({
          identity: row.identity,
          result: row.result,
          volatility: row.volatility,
        })),
      ).toEqual(task4Functions);
      for (const row of functions.rows) {
        expect(row).toMatchObject({
          owner: "dasher_security_definer",
          security_definer: true,
          language: "plpgsql",
          proconfig: ["search_path=pg_catalog"],
          acl: ["OWNER:EXECUTE:false", "dasher_app:EXECUTE:false"],
        });
        const functionName = row.identity.slice(0, row.identity.indexOf("("));
        expect(row.body).toBe(sourceBodies.get(functionName));
        expect(row.body).not.toMatch(/\bEXECUTE\b/u);
      }

      expect(
        source.match(/'dasher:task4-organization:v1:'::text/gu),
      ).toHaveLength(9);
      expect(
        source.match(/'dasher:invitation-family:v1:'::text/gu),
      ).toHaveLength(3);
      expect(source.match(/FOR v_advisory_key IN/gu)).toHaveLength(3);
      for (const [identity, proposedParameter] of [
        ["dasher_api.accept_invitation", "p_new_session_id"],
        ["dasher_api.issue_session", "p_session_id"],
        ["dasher_api.rotate_session", "p_successor_session_id"],
      ] as const) {
        const body = sourceBodies.get(identity) ?? "";
        const lockStatements = body
          .split(";")
          .filter(
            (statement) =>
              statement.includes("FOR UPDATE") ||
              statement.includes("pg_advisory_xact_lock"),
          );
        expect(body).toContain("AS session_collision");
        expect(body).toContain("v_constraint_name = CONSTRAINT_NAME");
        expect(body).toContain("'sessions_pkey'");
        expect(body).toContain("'sessions_token_key'");
        expect(body).toContain("'sessions_csrf_key'");
        for (const statement of lockStatements) {
          expect(statement).not.toContain(proposedParameter);
        }
      }
    });

    it("pins the exact five permissive app SELECT policies and no write policy", async () => {
      const policies = await ownerPool.query<{
        readonly command: string;
        readonly permissive: boolean;
        readonly policy_name: string;
        readonly roles: string[];
        readonly table_name: string;
        readonly using_expression: string;
        readonly with_check: string | null;
      }>(`
        SELECT
          relation.relname AS table_name,
          policy.polname AS policy_name,
          policy.polpermissive AS permissive,
          policy.polcmd::text AS command,
          ARRAY(
            SELECT role_row.rolname::text
            FROM pg_catalog.unnest(policy.polroles) AS role_oid
            JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = role_oid
            ORDER BY role_row.rolname
          )::text[] AS roles,
          pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
            AS using_expression,
          pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
            AS with_check
        FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'dasher'
        ORDER BY relation.relname
      `);
      expect(policies.rows).toEqual([
        {
          table_name: "audit_events",
          policy_name: "audit_events_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'admin'::text)",
          with_check: null,
        },
        {
          table_name: "invitations",
          policy_name: "invitations_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'admin'::text)",
          with_check: null,
        },
        {
          table_name: "memberships",
          policy_name: "memberships_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'viewer'::text)",
          with_check: null,
        },
        {
          table_name: "organizations",
          policy_name: "organizations_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'viewer'::text)",
          with_check: null,
        },
        {
          table_name: "sessions",
          policy_name: "sessions_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "(dasher_private.context_allows(organization_id, 'viewer'::text) AND (dasher_private.context_user_id() = user_id))",
          with_check: null,
        },
      ]);
    });

    it("pins the exact 180 operation-specific column grants and no managed table grant", async () => {
      const grants = await ownerPool.query<{
        readonly grant_count: string;
        readonly grantee: string;
        readonly privilege_type: string;
      }>(`
        SELECT
          grantee.rolname AS grantee,
          privilege.privilege_type,
          pg_catalog.count(*)::text AS grant_count
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE namespace.nspname = 'dasher'
          AND grantee.rolname IN (
            'dasher_app',
            'dasher_security_definer'
          )
        GROUP BY grantee.rolname, privilege.privilege_type
        ORDER BY grantee.rolname, privilege.privilege_type
      `);
      expect(grants.rows).toEqual([
        {
          grantee: "dasher_app",
          privilege_type: "SELECT",
          grant_count: "56",
        },
        {
          grantee: "dasher_security_definer",
          privilege_type: "INSERT",
          grant_count: "65",
        },
        {
          grantee: "dasher_security_definer",
          privilege_type: "SELECT",
          grant_count: "45",
        },
        {
          grantee: "dasher_security_definer",
          privilege_type: "UPDATE",
          grant_count: "14",
        },
      ]);

      const tableGrants = await ownerPool.query<{ readonly count: string }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE namespace.nspname = 'dasher'
          AND grantee.rolname IN (
            'dasher_app',
            'dasher_security_definer'
          )
      `);
      expect(tableGrants.rows[0]?.count).toBe("0");
    });

    it("preserves the exact owner-owned tables, columns, defaults, and forced RLS", async () => {
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
        { schema_name: "dasher_api", owner_matches: true },
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
          policy_count: ["users", "external_identities"].includes(table_name)
            ? "0"
            : "1",
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
          'public', 'dasher', 'dasher_api', 'dasher_meta', 'dasher_private'
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
        WHERE namespace.nspname IN (
          'dasher', 'dasher_api', 'dasher_private'
        )
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
        readonly app_function_acl_entry_count: string;
        readonly column_acl_count: string;
        readonly default_acl_count: string;
        readonly definer_function_acl_entry_count: string;
        readonly managed_function_acl_entry_count: string;
        readonly managed_table_acl_entry_count: string;
      }>(`
      WITH function_acl AS (
        SELECT grantee.rolname AS grantee_name
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
        WHERE namespace.nspname IN (
          'dasher', 'dasher_api', 'dasher_private'
        )
          AND grantee.rolname IN (
            'dasher_app', 'dasher_security_definer'
          )
      ),
      table_acl AS (
        SELECT grantee.rolname AS grantee_name
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
        WHERE namespace.nspname IN ('dasher', 'dasher_meta')
          AND grantee.rolname IN (
            'dasher_app', 'dasher_security_definer'
          )
      )
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
          FROM function_acl
          WHERE grantee_name = 'dasher_app'
        ) AS app_function_acl_entry_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM function_acl
          WHERE grantee_name = 'dasher_security_definer'
        ) AS definer_function_acl_entry_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM function_acl
        ) AS managed_function_acl_entry_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM table_acl
        ) AS managed_table_acl_entry_count
    `);
      expect(closure.rows[0]).toEqual({
        app_function_acl_entry_count: "16",
        column_acl_count: "68",
        default_acl_count: "2",
        definer_function_acl_entry_count: "16",
        managed_function_acl_entry_count: "32",
        managed_table_acl_entry_count: "0",
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

    it("keeps an unidentified session uniqueness violation internal and rolls rotation back", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");
        const successorId = randomUUID();
        const auditEventId = randomUUID();
        await ownerPool.query(`
          ALTER TABLE dasher.sessions
          ADD CONSTRAINT task4_unexpected_sessions_unique
          UNIQUE (organization_id, user_id, authority_revision)
        `);
        try {
          let internalError: unknown;
          try {
            await runContextOperation(
              client,
              actor.sessionDigest,
              randomUUID(),
              () =>
                client.query(
                  `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-unexpected-unique'
                    )
                  `,
                  [
                    successorId,
                    randomBytes(32),
                    randomBytes(32),
                    auditEventId,
                    actor.csrfDigest,
                  ],
                ),
            );
          } catch (error) {
            internalError = error;
          }
          expect(internalError).toMatchObject({
            code: "23505",
            constraint: "task4_unexpected_sessions_unique",
          });
          expect(internalError).not.toMatchObject({
            code: "P1001",
            message: "dasher_denied",
          });
          expect(internalError).not.toMatchObject({
            code: "P1002",
            message: "dasher_conflict",
          });

          const state = await ownerPool.query<{
            readonly audit_count: string;
            readonly predecessor_link: string | null;
            readonly successor_count: string;
          }>(
            `
              SELECT
                (
                  SELECT replaced_by_session_id::text
                  FROM dasher.sessions
                  WHERE session_id = $1::uuid
                ) AS predecessor_link,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.sessions
                  WHERE session_id = $2::uuid
                ) AS successor_count,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.audit_events
                  WHERE audit_event_id = $3::uuid
                ) AS audit_count
            `,
            [actor.sessionId, successorId, auditEventId],
          );
          expect(state.rows[0]).toEqual({
            audit_count: "0",
            predecessor_link: null,
            successor_count: "0",
          });
        } finally {
          await ownerPool.query(`
            ALTER TABLE dasher.sessions
            DROP CONSTRAINT IF EXISTS task4_unexpected_sessions_unique
          `);
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("executes all eight audited Task 4 operations through pinned app transactions with exact boundary behavior", async () => {
      const organizationId = "10000000-0000-4000-8000-000000000001";
      const adminUserId = "10000000-0000-4000-8000-000000000002";
      const adminMembershipId = "10000000-0000-4000-8000-000000000003";
      const adminSessionId = "10000000-0000-4000-8000-000000000004";
      const acceptedUserId = "10000000-0000-4000-8000-000000000005";
      const acceptedMembershipId = "10000000-0000-4000-8000-000000000006";
      const acceptedSessionId = "10000000-0000-4000-8000-000000000007";
      const successorSessionId = "10000000-0000-4000-8000-000000000008";
      const acceptedInvitationId = "10000000-0000-4000-8000-000000000009";
      const revokedInvitationId = "10000000-0000-4000-8000-00000000000a";
      const adminSessionDigest = Buffer.alloc(32, 0x11);
      const adminCsrfDigest = Buffer.alloc(32, 0x12);
      const successorSessionDigest = Buffer.alloc(32, 0x13);
      const successorCsrfDigest = Buffer.alloc(32, 0x14);
      const acceptedSessionDigest = Buffer.alloc(32, 0x15);
      const acceptedCsrfDigest = Buffer.alloc(32, 0x16);
      const acceptedInviteDigest = Buffer.alloc(32, 0x17);
      const revokedInviteDigest = Buffer.alloc(32, 0x18);
      const auditIds = Array.from(
        { length: 9 },
        (_, index) =>
          `20000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      );
      const requestIds = Array.from(
        { length: 9 },
        (_, index) =>
          `30000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      );

      await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
        adminUserId,
      ]);
      await ownerPool.query(
        `
          INSERT INTO dasher.external_identities (
            issuer,
            subject,
            user_id
          ) VALUES ('https://issuer.task4.test', 'admin-subject', $1)
        `,
        [adminUserId],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.organizations (
            organization_id,
            display_name
          ) VALUES ($1, 'Task 4 Boundary Organization')
        `,
        [organizationId],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.memberships (
            membership_id,
            organization_id,
            user_id,
            role,
            state,
            authority_revision
          ) VALUES ($1, $2, $3, 'admin', 'active', 1)
        `,
        [adminMembershipId, organizationId, adminUserId],
      );

      const client = await appPool!.connect();
      try {
        await expectPostgresDenial(
          client,
          `
            SELECT *
            FROM dasher_api.issue_session(
              'https://issuer.task4.test',
              'admin-subject',
              '${adminMembershipId}'::uuid,
              '${adminSessionId}'::uuid,
              1::smallint,
              decode('${adminSessionDigest.toString("hex")}', 'hex'),
              1::smallint,
              decode('${adminCsrfDigest.toString("hex")}', 'hex'),
              '${auditIds[0]}'::uuid,
              '${requestIds[0]}'::uuid,
              'task4-test'
            )
          `,
        );
        await client.query("SET ROLE dasher_app");
        await client.query("SET search_path = pg_temp, public");

        const issued = await client.query(
          `
            SELECT *
            FROM dasher_api.issue_session(
              $1,
              $2,
              $3::uuid,
              $4::uuid,
              1::smallint,
              $5::bytea,
              1::smallint,
              $6::bytea,
              $7::uuid,
              $8::uuid,
              $9
            )
          `,
          [
            "https://issuer.task4.test",
            "admin-subject",
            adminMembershipId,
            adminSessionId,
            adminSessionDigest,
            adminCsrfDigest,
            auditIds[0],
            requestIds[0],
            "task4-test",
          ],
        );
        expect(Object.keys(issued.rows[0] ?? {})).toEqual([
          "user_id",
          "organization_id",
          "membership_id",
          "granted_role",
          "authority_revision",
          "session_id",
          "idle_expires_at",
          "absolute_expires_at",
        ]);

        expect(
          (
            await client.query(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");
        await client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [adminSessionDigest, requestIds[1]],
        );
        expect(
          (
            await client.query(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");

        await client.query("BEGIN");
        try {
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_session_id', $1, true)",
            [adminSessionId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_user_id', $1, true)",
            [adminUserId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_organization_id', $1, true)",
            [organizationId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_membership_id', $1, true)",
            [adminMembershipId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_authority_revision', '1', true)",
          );
          expect(
            (
              await client.query(
                "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
              )
            ).rows[0]?.count,
          ).toBe("0");
        } finally {
          await client.query("ROLLBACK");
        }

        const acceptedInvite = await client.query(
          `
            SELECT *
            FROM dasher_api.issue_invitation(
              $1::uuid,
              'accepted@example.test',
              'viewer',
              1::smallint,
              $2::bytea,
              $3::uuid,
              1::smallint,
              $4::bytea,
              1::smallint,
              $5::bytea,
              $6::uuid,
              'task4-test'
            )
          `,
          [
            acceptedInvitationId,
            acceptedInviteDigest,
            auditIds[1],
            adminSessionDigest,
            adminCsrfDigest,
            requestIds[1],
          ],
        );
        expect(Object.keys(acceptedInvite.rows[0] ?? {})).toEqual([
          "invitation_id",
          "expires_at",
        ]);

        const accepted = await client.query(
          `
            SELECT *
            FROM dasher_api.accept_invitation(
              1::smallint,
              $1::bytea,
              'https://issuer.task4.test',
              'accepted-subject',
              'accepted@example.test',
              true,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              1::smallint,
              $5::bytea,
              1::smallint,
              $6::bytea,
              $7::uuid,
              $8::uuid,
              'task4-test'
            )
          `,
          [
            acceptedInviteDigest,
            acceptedUserId,
            acceptedMembershipId,
            acceptedSessionId,
            acceptedSessionDigest,
            acceptedCsrfDigest,
            auditIds[2],
            requestIds[2],
          ],
        );
        expect(Object.keys(accepted.rows[0] ?? {})).toEqual([
          "user_id",
          "organization_id",
          "membership_id",
          "granted_role",
          "authority_revision",
          "session_id",
          "idle_expires_at",
          "absolute_expires_at",
        ]);
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.accept_invitation(
                1::smallint, $1::bytea, 'https://issuer.task4.test',
                'accepted-subject', 'accepted@example.test', true,
                $2::uuid, $3::uuid, $4::uuid, 1::smallint, $5::bytea,
                1::smallint, $6::bytea, $7::uuid, $8::uuid, 'task4-test'
              )
            `,
            [
              acceptedInviteDigest,
              randomUUID(),
              randomUUID(),
              randomUUID(),
              Buffer.alloc(32, 0x19),
              Buffer.alloc(32, 0x1a),
              randomUUID(),
              randomUUID(),
            ],
          ),
          "P1001",
          "dasher_denied",
        );

        const rotated = await runContextOperation(
          client,
          adminSessionDigest,
          requestIds[3]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid,
                  1::smallint,
                  $2::bytea,
                  1::smallint,
                  $3::bytea,
                  $4::uuid,
                  1::smallint,
                  $5::bytea,
                  'task4-test'
                )
              `,
              [
                successorSessionId,
                successorSessionDigest,
                successorCsrfDigest,
                auditIds[3],
                adminCsrfDigest,
              ],
            ),
        );
        expect(Object.keys(rotated.rows[0] ?? {})).toEqual([
          "session_id",
          "idle_expires_at",
          "absolute_expires_at",
        ]);
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.initialize_context(
                1::smallint,
                $1::bytea,
                $2::uuid
              )
            `,
            [adminSessionDigest, requestIds[4]],
          ),
          "P1001",
          "dasher_denied",
        );

        await client.query(
          `
            SELECT *
            FROM dasher_api.issue_invitation(
              $1::uuid, 'revoked@example.test', 'editor', 1::smallint,
              $2::bytea, $3::uuid, 1::smallint, $4::bytea, 1::smallint,
              $5::bytea, $6::uuid, 'task4-test'
            )
          `,
          [
            revokedInvitationId,
            revokedInviteDigest,
            auditIds[4],
            successorSessionDigest,
            successorCsrfDigest,
            requestIds[4],
          ],
        );
        await client.query(
          `
            SELECT *
            FROM dasher_api.revoke_invitation(
              $1::uuid, $2::uuid, 1::smallint, $3::bytea, 1::smallint,
              $4::bytea, $5::uuid, 'task4-test'
            )
          `,
          [
            revokedInvitationId,
            auditIds[5],
            successorSessionDigest,
            successorCsrfDigest,
            requestIds[5],
          ],
        );

        await runContextOperation(
          client,
          successorSessionDigest,
          requestIds[6]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.change_membership_role(
                  $1::uuid,
                  'editor',
                  $2::uuid,
                  1::smallint,
                  $3::bytea,
                  'task4-test'
                )
              `,
              [acceptedMembershipId, auditIds[6], successorCsrfDigest],
            ),
        );
        await runContextOperation(
          client,
          successorSessionDigest,
          requestIds[7]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.revoke_membership(
                  $1::uuid,
                  $2::uuid,
                  1::smallint,
                  $3::bytea,
                  'task4-test'
                )
              `,
              [acceptedMembershipId, auditIds[7], successorCsrfDigest],
            ),
        );
        await runContextOperation(
          client,
          successorSessionDigest,
          requestIds[8]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid,
                  $2::uuid,
                  1::smallint,
                  $3::bytea,
                  'task4-test'
                )
              `,
              [successorSessionId, auditIds[8], successorCsrfDigest],
            ),
        );
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.initialize_context(
                1::smallint,
                $1::bytea,
                $2::uuid
              )
            `,
            [successorSessionDigest, randomUUID()],
          ),
          "P1001",
          "dasher_denied",
        );
        await expectPostgresDenial(
          client,
          "SELECT dasher_private.context_user_id()",
        );
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }

      const state = await ownerPool.query<{
        readonly action: string;
        readonly actor_user_id: string;
        readonly authority_revision: string;
        readonly deployment_revision: string;
        readonly null_optional_fields: boolean;
        readonly organization_id: string;
        readonly outcome: string;
        readonly target_type: string;
      }>(
        `
          SELECT
            action,
            actor_user_id,
            authority_revision::text,
            deployment_revision,
            organization_id,
            outcome,
            target_type,
            job_id IS NULL
              AND content_sha256 IS NULL
              AND source_ref IS NULL
              AND provider IS NULL
              AND credential_version IS NULL
              AND usage_units IS NULL
              AND cost_minor_units IS NULL AS null_optional_fields
          FROM dasher.audit_events
          WHERE audit_event_id = ANY($1::uuid[])
          ORDER BY occurred_at, audit_event_id
        `,
        [auditIds],
      );
      expect(state.rows).toHaveLength(9);
      expect(state.rows.map((row) => row.action).sort()).toEqual(
        [
          "invitation.accepted",
          "invitation.issued",
          "invitation.issued",
          "invitation.revoked",
          "membership.revoked",
          "membership.role_changed",
          "session.issued",
          "session.revoked",
          "session.rotated",
        ].sort(),
      );
      for (const row of state.rows) {
        expect(row.organization_id).toBe(organizationId);
        expect(row.outcome).toBe("succeeded");
        expect(row.deployment_revision).toBe("task4-test");
        expect(row.null_optional_fields).toBe(true);
      }

      const timestamps = await ownerPool.query<{
        readonly acceptance_clock_matches: boolean;
        readonly initial_clock_matches: boolean;
        readonly invitation_lifetime_matches: boolean;
        readonly rotation_clock_matches: boolean;
      }>(
        `
          SELECT
            initial_session.issued_at = initial_session.last_seen_at
              AND initial_session.issued_at = initial_audit.occurred_at
              AS initial_clock_matches,
            accepted_invitation.accepted_at = accepted_session.issued_at
              AND accepted_session.issued_at = accepted_session.last_seen_at
              AND accepted_session.issued_at = accepted_audit.occurred_at
              AS acceptance_clock_matches,
            accepted_invitation.expires_at
              = accepted_invitation.created_at + interval '7 days'
              AS invitation_lifetime_matches,
            successor.issued_at = successor.last_seen_at
              AND successor.absolute_expires_at
                = initial_session.absolute_expires_at
              AND predecessor.replaced_by_session_id = successor.session_id
              AND successor.rotated_from_session_id = predecessor.session_id
              AND successor.issued_at = rotation_audit.occurred_at
              AS rotation_clock_matches
          FROM dasher.sessions AS initial_session
          JOIN dasher.audit_events AS initial_audit
            ON initial_audit.audit_event_id = $1::uuid
          JOIN dasher.invitations AS accepted_invitation
            ON accepted_invitation.invitation_id = $2::uuid
          JOIN dasher.sessions AS accepted_session
            ON accepted_session.session_id = $3::uuid
          JOIN dasher.audit_events AS accepted_audit
            ON accepted_audit.audit_event_id = $4::uuid
          JOIN dasher.sessions AS predecessor
            ON predecessor.session_id = $5::uuid
          JOIN dasher.sessions AS successor
            ON successor.session_id = $6::uuid
          JOIN dasher.audit_events AS rotation_audit
            ON rotation_audit.audit_event_id = $7::uuid
          WHERE initial_session.session_id = $5::uuid
        `,
        [
          auditIds[0],
          acceptedInvitationId,
          acceptedSessionId,
          auditIds[2],
          adminSessionId,
          successorSessionId,
          auditIds[3],
        ],
      );
      expect(timestamps.rows[0]).toEqual({
        initial_clock_matches: true,
        acceptance_clock_matches: true,
        invitation_lifetime_matches: true,
        rotation_clock_matches: true,
      });
    });

    it("covers missing, malformed, stale, overwritten, expired, standalone, and pooled context plus exact SQL boundary metadata", async () => {
      const client = await appPool!.connect();
      await client.query("SET ROLE dasher_app");
      const actor = await createTask4Actor(client, "admin");
      const target = await createTask4Actor(
        client,
        "viewer",
        actor.organizationId,
      );

      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");

      await client.query("BEGIN");
      await client.query(
        "SELECT pg_catalog.set_config('dasher.context_session_id', 'malformed', true)",
      );
      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");
      await client.query("ROLLBACK");

      await client.query(
        `
          SELECT *
          FROM dasher_api.initialize_context(
            1::smallint,
            $1::bytea,
            $2::uuid
          )
        `,
        [actor.sessionDigest, randomUUID()],
      );
      expect(
        (
          await client.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM pg_catalog.pg_locks
              WHERE pid = pg_catalog.pg_backend_pid()
                AND locktype = 'advisory'
            `,
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");

      for (const [keyVersion, digest] of [
        [2, actor.sessionDigest],
        [1, randomBytes(32)],
      ] as const) {
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.initialize_context(
                $1::smallint, $2::bytea, $3::uuid
              )
            `,
            [keyVersion, digest, randomUUID()],
          ),
          "P1001",
          "dasher_denied",
        );
      }

      const overwrittenRequestId = randomUUID();
      await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        async () => {
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_request_id', $1, true)",
            [overwrittenRequestId],
          );
          expect(
            (
              await client.query<{ readonly count: string }>(
                "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
              )
            ).rows[0]?.count,
          ).toBe("1");
          await client.query(
            `
              SELECT *
              FROM dasher_api.change_membership_role(
                $1::uuid,
                'editor',
                $2::uuid,
                1::smallint,
                $3::bytea,
                'task4-context-matrix'
              )
            `,
            [target.membershipId, randomUUID(), actor.csrfDigest],
          );
        },
      );
      const overwriteAudit = await ownerPool.query<{
        readonly request_id: string;
      }>(
        `
          SELECT request_id
          FROM dasher.audit_events
          WHERE target_id = $1::uuid
            AND action = 'membership.role_changed'
        `,
        [target.membershipId],
      );
      expect(overwriteAudit.rows[0]?.request_id).toBe(overwrittenRequestId);

      await client.query("BEGIN");
      await client.query(
        `
          SELECT *
          FROM dasher_api.initialize_context(
            1::smallint,
            $1::bytea,
            $2::uuid
          )
        `,
        [actor.sessionDigest, randomUUID()],
      );
      await client.query(
        "SELECT pg_catalog.set_config('dasher.context_authority_revision', '2', true)",
      );
      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.revoke_session(
              $1::uuid,
              $2::uuid,
              1::smallint,
              $3::bytea,
              'task4-context-matrix'
            )
          `,
          [actor.sessionId, randomUUID(), actor.csrfDigest],
        ),
        "P1001",
        "dasher_denied",
      );
      await client.query("ROLLBACK");

      const foreign = await createTask4Actor(client, "admin");
      for (const [guc, value] of [
        ["dasher.context_user_id", foreign.userId],
        ["dasher.context_organization_id", foreign.organizationId],
        ["dasher.context_membership_id", foreign.membershipId],
        ["dasher.context_session_id", foreign.sessionId],
      ] as const) {
        await client.query("BEGIN");
        await client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [actor.sessionDigest, randomUUID()],
        );
        await client.query("SELECT pg_catalog.set_config($1, $2, true)", [
          guc,
          value,
        ]);
        expect(
          (
            await client.query<{ readonly count: string }>(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.revoke_session(
                $1::uuid, $2::uuid, 1::smallint,
                $3::bytea, 'task4-context-matrix'
              )
            `,
            [actor.sessionId, randomUUID(), actor.csrfDigest],
          ),
          "P1001",
          "dasher_denied",
        );
        await client.query("ROLLBACK");
      }

      await runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
        expectDasherBoundaryError(
          client.query(
            `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid,
                  1::smallint,
                  $2::bytea,
                  1::smallint,
                  $3::bytea,
                  $4::uuid,
                  1::smallint,
                  $5::bytea,
                  'task4-context-matrix'
                )
              `,
            [
              actor.sessionId,
              randomBytes(32),
              randomBytes(32),
              randomUUID(),
              actor.csrfDigest,
            ],
          ),
          "P1002",
          "dasher_conflict",
        ),
      );

      await ownerPool.query(
        `
          UPDATE dasher.sessions
          SET idle_expires_at = pg_catalog.clock_timestamp()
          WHERE session_id = $1::uuid
        `,
        [actor.sessionId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [actor.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const absoluteExpired = await createTask4Actor(client, "viewer");
      await ownerPool.query(
        `
          UPDATE dasher.sessions
          SET
            idle_expires_at = pg_catalog.clock_timestamp(),
            absolute_expires_at = pg_catalog.clock_timestamp()
          WHERE session_id = $1::uuid
        `,
        [absoluteExpired.sessionId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint, $1::bytea, $2::uuid
            )
          `,
          [absoluteExpired.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const revokedSession = await createTask4Actor(client, "viewer");
      await ownerPool.query(
        `
          UPDATE dasher.sessions
          SET
            revoked_at = pg_catalog.clock_timestamp(),
            revocation_reason = 'user_revoked'
          WHERE session_id = $1::uuid
        `,
        [revokedSession.sessionId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint, $1::bytea, $2::uuid
            )
          `,
          [revokedSession.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const revokedMembership = await createTask4Actor(client, "viewer");
      await ownerPool.query(
        `
          UPDATE dasher.memberships
          SET
            state = 'revoked',
            authority_revision = authority_revision + 1,
            revoked_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
          WHERE membership_id = $1::uuid
        `,
        [revokedMembership.membershipId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint, $1::bytea, $2::uuid
            )
          `,
          [revokedMembership.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const repeatedRequestId = randomUUID();
      await issueTask4Invitation(
        client,
        foreign,
        `repeat-a-${randomUUID()}@example.test`,
        { requestId: repeatedRequestId },
      );
      await issueTask4Invitation(
        client,
        foreign,
        `repeat-b-${randomUUID()}@example.test`,
        { requestId: repeatedRequestId },
      );
      expect(
        (
          await ownerPool.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.audit_events
              WHERE request_id = $1::uuid
            `,
            [repeatedRequestId],
          )
        ).rows[0]?.count,
      ).toBe("2");

      await client.query("RESET ROLE");
      client.release();
      const reused = await appPool!.connect();
      try {
        await reused.query("SET ROLE dasher_app");
        expect(
          (
            await reused.query<{ readonly count: string }>(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");
      } finally {
        await reused.query("RESET ROLE");
        reused.release();
      }
    });

    it("exhaustively enforces the Task 5 SQL ASCII email subset for bytes 0x01..0x7f, exact lengths, and pre-database NUL rejection", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");
        const applicationOnlyRejectedBytes = [0x00];
        expect(applicationOnlyRejectedBytes).toEqual([0x00]);

        for (const position of ["local", "domain"] as const) {
          for (let code = 0x01; code <= 0x7f; code += 1) {
            const character = String.fromCharCode(code);
            const email =
              position === "local"
                ? `a${character}b@example.test`
                : `ab@exa${character}mple.test`;
            const accepted =
              code >= 0x21 &&
              code <= 0x7e &&
              !(code >= 0x41 && code <= 0x5a) &&
              code !== 0x40;
            const operation = client.query(
              `
                SELECT *
                FROM dasher_api.issue_invitation(
                  $1::uuid,
                  $2,
                  'viewer',
                  1::smallint,
                  $3::bytea,
                  $4::uuid,
                  1::smallint,
                  $5::bytea,
                  1::smallint,
                  $6::bytea,
                  $7::uuid,
                  'task4-email-matrix'
                )
              `,
              [
                randomUUID(),
                email,
                randomBytes(32),
                randomUUID(),
                actor.sessionDigest,
                actor.csrfDigest,
                randomUUID(),
              ],
            );
            if (accepted) {
              await expect(operation).resolves.toMatchObject({ rowCount: 1 });
            } else {
              await expectDasherBoundaryError(
                operation,
                "P1001",
                "dasher_denied",
              );
            }
          }
        }

        const emailLengthCases = [
          { accepted: false, email: "", length: 0 },
          { accepted: false, email: "a", length: 1 },
          { accepted: false, email: "ab", length: 2 },
          { accepted: true, email: "a@b", length: 3 },
          { accepted: true, email: "aa@b", length: 4 },
          { accepted: true, email: `${"a".repeat(317)}@b`, length: 319 },
          { accepted: true, email: `${"a".repeat(318)}@b`, length: 320 },
          { accepted: false, email: `${"a".repeat(319)}@b`, length: 321 },
        ] as const;
        for (const lengthCase of emailLengthCases) {
          expect(lengthCase.email).toHaveLength(lengthCase.length);
          const operation = issueTask4Invitation(
            client,
            actor,
            lengthCase.email,
          );
          if (lengthCase.accepted) {
            await expect(operation).resolves.toBeDefined();
          } else {
            await expectDasherBoundaryError(
              operation,
              "P1001",
              "dasher_denied",
            );
          }
        }

        for (const rejectedEmail of [
          "é@example.test",
          "local@例.example",
          "@example.test",
          "local@",
          "local@@example.test",
        ]) {
          await expectDasherBoundaryError(
            issueTask4Invitation(client, actor, rejectedEmail),
            "P1001",
            "dasher_denied",
          );
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });

    it("normalizes expected denial and conflict classes to code-only metadata", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");
        const target = await createTask4Actor(
          client,
          "viewer",
          actor.organizationId,
        );
        const sharedId = randomUUID();
        const sharedDigest = randomBytes(32);
        const sharedEmail = `boundary-${randomUUID()}@example.test`;
        await issueTask4Invitation(client, actor, sharedEmail, {
          invitationId: sharedId,
          tokenDigest: sharedDigest,
        });

        const deniedCases: ReadonlyArray<{
          readonly name: string;
          readonly operation: () => Promise<unknown>;
        }> = [
          {
            name: "closed role enum",
            operation: () =>
              client.query(
                `
                  SELECT *
                  FROM dasher_api.issue_invitation(
                    $1::uuid, $2, 'owner', 1::smallint, $3::bytea,
                    $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                    $6::bytea, $7::uuid, 'task4-boundary'
                  )
                `,
                [
                  randomUUID(),
                  `role-${randomUUID()}@example.test`,
                  randomBytes(32),
                  randomUUID(),
                  actor.sessionDigest,
                  actor.csrfDigest,
                  randomUUID(),
                ],
              ),
          },
          {
            name: "wrong csrf",
            operation: () =>
              client.query(
                `
                  SELECT *
                  FROM dasher_api.issue_invitation(
                    $1::uuid, $2, 'viewer', 1::smallint, $3::bytea,
                    $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                    $6::bytea, $7::uuid, 'task4-boundary'
                  )
                `,
                [
                  randomUUID(),
                  `csrf-${randomUUID()}@example.test`,
                  randomBytes(32),
                  randomUUID(),
                  actor.sessionDigest,
                  randomBytes(32),
                  randomUUID(),
                ],
              ),
          },
          {
            name: "audit equals request",
            operation: () => {
              const repeated = randomUUID();
              return client.query(
                `
                  SELECT *
                  FROM dasher_api.issue_invitation(
                    $1::uuid, $2, 'viewer', 1::smallint, $3::bytea,
                    $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                    $6::bytea, $4::uuid, 'task4-boundary'
                  )
                `,
                [
                  randomUUID(),
                  `equal-${randomUUID()}@example.test`,
                  randomBytes(32),
                  repeated,
                  actor.sessionDigest,
                  actor.csrfDigest,
                ],
              );
            },
          },
          {
            name: "cross tenant conditional target",
            operation: () =>
              runContextOperation(
                client,
                actor.sessionDigest,
                randomUUID(),
                () =>
                  client.query(
                    `
                      SELECT *
                      FROM dasher_api.revoke_membership(
                        $1::uuid, $2::uuid, 1::smallint,
                        $3::bytea, 'task4-boundary'
                      )
                    `,
                    [randomUUID(), randomUUID(), actor.csrfDigest],
                  ),
              ),
          },
        ];
        for (const boundaryCase of deniedCases) {
          await expectDasherBoundaryError(
            boundaryCase.operation(),
            "P1001",
            "dasher_denied",
          );
          expect(boundaryCase.name).not.toBe("");
        }

        const conflictCases: ReadonlyArray<{
          readonly name: string;
          readonly operation: () => Promise<unknown>;
        }> = [
          {
            name: "duplicate invitation id",
            operation: () =>
              issueTask4Invitation(
                client,
                actor,
                `duplicate-${randomUUID()}@example.test`,
                { invitationId: sharedId },
              ),
          },
          {
            name: "successor id collision",
            operation: () =>
              runContextOperation(
                client,
                actor.sessionDigest,
                randomUUID(),
                () =>
                  client.query(
                    `
                      SELECT *
                      FROM dasher_api.rotate_session(
                        $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                        $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                        'task4-boundary'
                      )
                    `,
                    [
                      target.sessionId,
                      randomBytes(32),
                      randomBytes(32),
                      randomUUID(),
                      actor.csrfDigest,
                    ],
                  ),
              ),
          },
        ];
        for (const boundaryCase of conflictCases) {
          await expectDasherBoundaryError(
            boundaryCase.operation(),
            "P1002",
            "dasher_conflict",
          );
          expect(boundaryCase.name).not.toBe("");
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });

    it("maps only exact session token and CSRF uniqueness constraints to conflict for every session creator", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");

        for (const collision of ["token", "csrf"] as const) {
          const sessionDigest =
            collision === "token" ? actor.sessionDigest : randomBytes(32);
          const csrfDigest =
            collision === "csrf" ? actor.csrfDigest : randomBytes(32);

          await expectDasherBoundaryError(
            client.query(
              `
                SELECT *
                FROM dasher_api.issue_session(
                  $1, $2, $3::uuid, $4::uuid, 1::smallint,
                  $5::bytea, 1::smallint, $6::bytea, $7::uuid,
                  $8::uuid, 'task4-named-unique'
                )
              `,
              [
                actor.identityIssuer,
                actor.identitySubject,
                actor.membershipId,
                randomUUID(),
                sessionDigest,
                csrfDigest,
                randomUUID(),
                randomUUID(),
              ],
            ),
            "P1002",
            "dasher_conflict",
          );

          await expectDasherBoundaryError(
            runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
              client.query(
                `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-named-unique'
                    )
                  `,
                [
                  randomUUID(),
                  sessionDigest,
                  csrfDigest,
                  randomUUID(),
                  actor.csrfDigest,
                ],
              ),
            ),
            "P1002",
            "dasher_conflict",
          );

          const invitation = await issueTask4Invitation(
            client,
            actor,
            `named-${collision}-${randomUUID()}@example.test`,
          );
          await expectDasherBoundaryError(
            acceptTask4Invitation(
              client,
              invitation,
              `https://named-${collision}-${randomUUID()}.test`,
              randomUUID(),
              {
                csrfDigest,
                sessionDigest,
              },
            ),
            "P1002",
            "dasher_conflict",
          );
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("normalizes the exact sessions_pkey loser for all three cross-organization absent-probe races", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        const issueA = await createTask4Actor(first, "admin");
        const issueB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          issueA.organizationId,
          issueB.organizationId,
        );
        const issueSessionId = randomUUID();
        const issueWinnerAudit = randomUUID();
        const issueLoserAudit = randomUUID();
        await first.query("BEGIN");
        await first.query(
          `
            SELECT *
            FROM dasher_api.issue_session(
              $1, $2, $3::uuid, $4::uuid, 1::smallint,
              $5::bytea, 1::smallint, $6::bytea, $7::uuid,
              $8::uuid, 'task4-pkey-race'
            )
          `,
          [
            issueA.identityIssuer,
            issueA.identitySubject,
            issueA.membershipId,
            issueSessionId,
            randomBytes(32),
            randomBytes(32),
            issueWinnerAudit,
            randomUUID(),
          ],
        );
        await second.query("BEGIN");
        const issueLoser = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.issue_session(
                $1, $2, $3::uuid, $4::uuid, 1::smallint,
                $5::bytea, 1::smallint, $6::bytea, $7::uuid,
                $8::uuid, 'task4-pkey-race'
              )
            `,
            [
              issueB.identityIssuer,
              issueB.identitySubject,
              issueB.membershipId,
              issueSessionId,
              randomBytes(32),
              randomBytes(32),
              issueLoserAudit,
              randomUUID(),
            ],
          ),
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "transactionid",
          issueLoser,
        );
        await first.query("COMMIT");
        const issueLoserResult = await issueLoser;
        expect(issueLoserResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            issueLoserResult.status === "rejected"
              ? issueLoserResult.reason
              : new Error("missing issue_session PK loser"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");

        const rotateA = await createTask4Actor(first, "admin");
        const rotateB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          rotateA.organizationId,
          rotateB.organizationId,
        );
        const rotateSessionId = randomUUID();
        const rotateWinnerAudit = randomUUID();
        const rotateLoserAudit = randomUUID();
        await beginTask4Context(first, rotateA.sessionDigest, randomUUID());
        await first.query(
          `
            SELECT *
            FROM dasher_api.rotate_session(
              $1::uuid, 1::smallint, $2::bytea, 1::smallint,
              $3::bytea, $4::uuid, 1::smallint, $5::bytea,
              'task4-pkey-race'
            )
          `,
          [
            rotateSessionId,
            randomBytes(32),
            randomBytes(32),
            rotateWinnerAudit,
            rotateA.csrfDigest,
          ],
        );
        await beginTask4Context(second, rotateB.sessionDigest, randomUUID());
        const rotateLoser = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-pkey-race'
              )
            `,
            [
              rotateSessionId,
              randomBytes(32),
              randomBytes(32),
              rotateLoserAudit,
              rotateB.csrfDigest,
            ],
          ),
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "transactionid",
          rotateLoser,
        );
        await first.query("COMMIT");
        const rotateLoserResult = await rotateLoser;
        expect(rotateLoserResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            rotateLoserResult.status === "rejected"
              ? rotateLoserResult.reason
              : new Error("missing rotate_session PK loser"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");

        const acceptAdminA = await createTask4Actor(first, "admin");
        const acceptAdminB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          acceptAdminA.organizationId,
          acceptAdminB.organizationId,
        );
        const invitationA = await issueTask4Invitation(
          first,
          acceptAdminA,
          `pkey-a-${randomUUID()}@example.test`,
        );
        const invitationB = await issueTask4Invitation(
          first,
          acceptAdminB,
          `pkey-b-${randomUUID()}@example.test`,
        );
        expect(
          (
            await ownerPool.query<{ readonly key_count: string }>(
              `
                SELECT pg_catalog.count(DISTINCT advisory_key)::text
                  AS key_count
                FROM pg_catalog.unnest(
                  ARRAY[
                    pg_catalog.hashtextextended(
                      'dasher:task4-organization:v1:' ||
                        $1::uuid::text,
                      20260730::bigint
                    ),
                    pg_catalog.hashtextextended(
                      'dasher:invitation-family:v1:' ||
                        $1::uuid::text || ':' || $2,
                      20260730::bigint
                    ),
                    pg_catalog.hashtextextended(
                      'dasher:task4-organization:v1:' ||
                        $3::uuid::text,
                      20260730::bigint
                    ),
                    pg_catalog.hashtextextended(
                      'dasher:invitation-family:v1:' ||
                        $3::uuid::text || ':' || $4,
                      20260730::bigint
                    )
                  ]::bigint[]
                ) AS key_set(advisory_key)
              `,
              [
                acceptAdminA.organizationId,
                invitationA.normalizedEmail,
                acceptAdminB.organizationId,
                invitationB.normalizedEmail,
              ],
            )
          ).rows[0]?.key_count,
        ).toBe("4");
        const acceptSessionId = randomUUID();
        const acceptWinnerAudit = randomUUID();
        const acceptLoserAudit = randomUUID();
        await first.query("BEGIN");
        await acceptTask4Invitation(
          first,
          invitationA,
          `https://pkey-a-${randomUUID()}.test`,
          randomUUID(),
          {
            auditEventId: acceptWinnerAudit,
            sessionId: acceptSessionId,
          },
        );
        await second.query("BEGIN");
        const acceptLoser = retainDatabasePromise(
          retainedOperations,
          acceptTask4Invitation(
            second,
            invitationB,
            `https://pkey-b-${randomUUID()}.test`,
            randomUUID(),
            {
              auditEventId: acceptLoserAudit,
              sessionId: acceptSessionId,
            },
          ),
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "transactionid",
          acceptLoser,
        );
        await first.query("COMMIT");
        const acceptLoserResult = await acceptLoser;
        expect(acceptLoserResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            acceptLoserResult.status === "rejected"
              ? acceptLoserResult.reason
              : new Error("missing accept_invitation PK loser"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");

        const state = await ownerPool.query<{
          readonly audit_count: string;
          readonly session_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($1::uuid[])
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($2::uuid[])
              ) AS audit_count
          `,
          [
            [issueSessionId, rotateSessionId, acceptSessionId],
            [
              issueWinnerAudit,
              issueLoserAudit,
              rotateWinnerAudit,
              rotateLoserAudit,
              acceptWinnerAudit,
              acceptLoserAudit,
            ],
          ],
        );
        expect(state.rows[0]).toEqual({
          audit_count: "3",
          session_count: "3",
        });
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        expect(firstPid).not.toBe(secondPid);
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await second.query("ROLLBACK").catch(() => undefined);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
      }
    });

    it("rolls back on audit grant failure, restores exact grants, permits rollback reuse, and rejects global cross-tenant audit collisions", async () => {
      const appClient = await appPool!.connect();
      await appClient.query("SET ROLE dasher_app");
      const actorA = await createTask4Actor(appClient, "admin");
      const actorB = await createTask4Actor(appClient, "admin");
      const failed = {
        auditEventId: randomUUID(),
        invitationId: randomUUID(),
        normalizedEmail: `audit-failure-${randomUUID()}@example.test`,
        requestId: randomUUID(),
        tokenDigest: randomBytes(32),
      };
      try {
        const revoker = await ownerPool.connect();
        try {
          await revoker.query("BEGIN");
          await revoker.query(`
            REVOKE INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            FROM dasher_security_definer
          `);
          await revoker.query("COMMIT");
        } finally {
          revoker.release();
        }

        await expectPostgresError(
          appClient.query(
            `
              SELECT *
              FROM dasher_api.issue_invitation(
                $1::uuid, $2, 'viewer', 1::smallint, $3::bytea,
                $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                $6::bytea, $7::uuid, 'task4-audit-failure'
              )
            `,
            [
              failed.invitationId,
              failed.normalizedEmail,
              failed.tokenDigest,
              failed.auditEventId,
              actorA.sessionDigest,
              actorA.csrfDigest,
              failed.requestId,
            ],
          ),
          "42501",
        );
        const rolledBack = await ownerPool.query<{
          readonly audit_count: string;
          readonly invitation_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = $1::uuid
              ) AS audit_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.invitations
                WHERE invitation_id = $2::uuid
              ) AS invitation_count
          `,
          [failed.auditEventId, failed.invitationId],
        );
        expect(rolledBack.rows[0]).toEqual({
          audit_count: "0",
          invitation_count: "0",
        });
      } finally {
        const restorer = await ownerPool.connect();
        try {
          await restorer.query("BEGIN");
          await restorer.query(`
            GRANT INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            TO dasher_security_definer
          `);
          await restorer.query("COMMIT");
        } finally {
          restorer.release();
        }
      }

      await issueTask4Invitation(
        appClient,
        actorA,
        failed.normalizedEmail,
        failed,
      );

      const rolledBackId = randomUUID();
      const rolledBackAuditId = randomUUID();
      const rolledBackEmail = `rollback-${randomUUID()}@example.test`;
      const rolledBackDigest = randomBytes(32);
      const rolledBackRequestId = randomUUID();
      await appClient.query("BEGIN");
      await issueTask4Invitation(appClient, actorA, rolledBackEmail, {
        auditEventId: rolledBackAuditId,
        invitationId: rolledBackId,
        requestId: rolledBackRequestId,
        tokenDigest: rolledBackDigest,
      });
      await appClient.query("ROLLBACK");
      await issueTask4Invitation(appClient, actorA, rolledBackEmail, {
        auditEventId: rolledBackAuditId,
        invitationId: rolledBackId,
        requestId: rolledBackRequestId,
        tokenDigest: rolledBackDigest,
      });

      const globalAuditId = randomUUID();
      await issueTask4Invitation(
        appClient,
        actorA,
        `tenant-a-${randomUUID()}@example.test`,
        { auditEventId: globalAuditId },
      );
      const tenantBInvitationId = randomUUID();
      await expectDasherBoundaryError(
        issueTask4Invitation(
          appClient,
          actorB,
          `tenant-b-${randomUUID()}@example.test`,
          {
            auditEventId: globalAuditId,
            invitationId: tenantBInvitationId,
          },
        ),
        "P1002",
        "dasher_conflict",
      );
      expect(
        (
          await ownerPool.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.invitations
              WHERE invitation_id = $1::uuid
            `,
            [tenantBInvitationId],
          )
        ).rows[0]?.count,
      ).toBe("0");

      const restoredAuditAcl = await ownerPool.query<{
        readonly columns: string[];
        readonly table_insert: boolean;
      }>(
        `
          SELECT
            pg_catalog.array_agg(
              privilege.column_name
              ORDER BY privilege.column_name
            )::text[] AS columns,
            pg_catalog.has_table_privilege(
              'dasher_security_definer',
              'dasher.audit_events',
              'INSERT'
            ) AS table_insert
          FROM information_schema.column_privileges AS privilege
          WHERE privilege.table_schema = 'dasher'
            AND privilege.table_name = 'audit_events'
            AND privilege.grantee = 'dasher_security_definer'
            AND privilege.privilege_type = 'INSERT'
            AND privilege.is_grantable = 'NO'
        `,
      );
      expect(restoredAuditAcl.rows[0]).toEqual({
        columns: [
          "action",
          "actor_kind",
          "actor_service",
          "actor_user_id",
          "audit_event_id",
          "authority_revision",
          "content_sha256",
          "cost_minor_units",
          "credential_version",
          "deployment_revision",
          "job_id",
          "occurred_at",
          "organization_id",
          "outcome",
          "provider",
          "request_id",
          "source_ref",
          "target_id",
          "target_type",
          "usage_units",
        ],
        table_insert: false,
      });

      await appClient.query("RESET ROLE");
      appClient.release();
    });

    it("serializes invitation empty sets, issue/revoke winner orders and replay, while foreign UUID denial avoids the foreign family lock", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const actorA = await createTask4Actor(first, "admin");
        const actorB = await createTask4Actor(first, "admin");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        const emptyEmail = `empty-${randomUUID()}@example.test`;
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          emptyEmail,
        ]);
        const emptyFirst = issueTask4Invitation(first, actorA, emptyEmail);
        const emptyFirstSettled = retainDatabasePromise(
          retainedOperations,
          emptyFirst,
        );
        const emptySecond = issueTask4Invitation(second, actorA, emptyEmail);
        const emptySecondSettled = retainDatabasePromise(
          retainedOperations,
          emptySecond,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          emptyFirstSettled,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          emptySecondSettled,
        );
        const barrierClock = (
          await observer.query<{ readonly captured_at: Date }>(
            "SELECT pg_catalog.clock_timestamp() AS captured_at",
          )
        ).rows[0]!.captured_at;
        await blocker.query("COMMIT");
        const emptyResults = await Promise.allSettled([
          emptyFirst,
          emptySecond,
        ]);
        expect(emptyResults.map((result) => result.status)).toEqual([
          "fulfilled",
          "fulfilled",
        ]);
        const emptyState = await ownerPool.query<{
          readonly all_after_barrier: boolean;
          readonly pending_count: string;
          readonly revoked_count: string;
        }>(
          `
            SELECT
              pg_catalog.bool_and(created_at > $3::timestamptz)
                AS all_after_barrier,
              pg_catalog.count(*) FILTER (
                WHERE revoked_at IS NULL AND accepted_at IS NULL
              )::text AS pending_count,
              pg_catalog.count(*) FILTER (
                WHERE revoked_at IS NOT NULL
              )::text AS revoked_count
            FROM dasher.invitations
            WHERE organization_id = $1::uuid
              AND normalized_email = $2
          `,
          [actorA.organizationId, emptyEmail, barrierClock],
        );
        expect(emptyState.rows[0]).toEqual({
          all_after_barrier: true,
          pending_count: "1",
          revoked_count: "1",
        });

        const orderedEmail = `ordered-${randomUUID()}@example.test`;
        const original = await issueTask4Invitation(
          first,
          actorA,
          orderedEmail,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          orderedEmail,
        ]);
        const issueWins = issueTask4Invitation(first, actorA, orderedEmail);
        const issueWinsSettled = retainDatabasePromise(
          retainedOperations,
          issueWins,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          issueWinsSettled,
        );
        const revokeLoses = second.query(
          `
            SELECT *
            FROM dasher_api.revoke_invitation(
              $1::uuid, $2::uuid, 1::smallint, $3::bytea,
              1::smallint, $4::bytea, $5::uuid, 'task4-race'
            )
          `,
          [
            original.invitationId,
            randomUUID(),
            actorA.sessionDigest,
            actorA.csrfDigest,
            randomUUID(),
          ],
        );
        const revokeLosesSettled = retainDatabasePromise(
          retainedOperations,
          revokeLoses,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          revokeLosesSettled,
        );
        await blocker.query("COMMIT");
        await expect(issueWins).resolves.toBeDefined();
        await expectDasherBoundaryError(revokeLoses, "P1001", "dasher_denied");

        const revokeFirstTarget = await issueTask4Invitation(
          first,
          actorA,
          `revoke-first-${randomUUID()}@example.test`,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          revokeFirstTarget.normalizedEmail,
        ]);
        const revokeWins = first.query(
          `
            SELECT *
            FROM dasher_api.revoke_invitation(
              $1::uuid, $2::uuid, 1::smallint, $3::bytea,
              1::smallint, $4::bytea, $5::uuid, 'task4-race'
            )
          `,
          [
            revokeFirstTarget.invitationId,
            randomUUID(),
            actorA.sessionDigest,
            actorA.csrfDigest,
            randomUUID(),
          ],
        );
        const revokeWinsSettled = retainDatabasePromise(
          retainedOperations,
          revokeWins,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          revokeWinsSettled,
        );
        const issueAfterRevoke = issueTask4Invitation(
          second,
          actorA,
          revokeFirstTarget.normalizedEmail,
        );
        const issueAfterRevokeSettled = retainDatabasePromise(
          retainedOperations,
          issueAfterRevoke,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          issueAfterRevokeSettled,
        );
        await blocker.query("COMMIT");
        await expect(revokeWins).resolves.toMatchObject({ rowCount: 1 });
        await expect(issueAfterRevoke).resolves.toBeDefined();

        for (const firstOperation of ["accept", "issue"] as const) {
          const issueAcceptTarget = await issueTask4Invitation(
            first,
            actorA,
            `issue-accept-${firstOperation}-${randomUUID()}@example.test`,
          );
          await blocker.query("BEGIN");
          await blocker.query(invitationFamilyLockSql(), [
            actorA.organizationId,
            issueAcceptTarget.normalizedEmail,
          ]);
          const acceptanceOperation = () =>
            acceptTask4Invitation(
              firstOperation === "accept" ? first : second,
              issueAcceptTarget,
              `https://issue-accept-${randomUUID()}.test`,
              randomUUID(),
            );
          const issueOperation = () =>
            issueTask4Invitation(
              firstOperation === "issue" ? first : second,
              actorA,
              issueAcceptTarget.normalizedEmail,
            );
          const queuedFirst =
            firstOperation === "accept"
              ? acceptanceOperation()
              : issueOperation();
          const queuedFirstSettled = retainDatabasePromise<unknown>(
            retainedOperations,
            queuedFirst,
          );
          await waitForDatabaseLock(
            observer,
            firstPid,
            "advisory",
            queuedFirstSettled,
          );
          const queuedSecond =
            firstOperation === "accept"
              ? issueOperation()
              : acceptanceOperation();
          const queuedSecondSettled = retainDatabasePromise<unknown>(
            retainedOperations,
            queuedSecond,
          );
          await waitForDatabaseLock(
            observer,
            secondPid,
            "advisory",
            queuedSecondSettled,
          );
          await blocker.query("COMMIT");
          await expect(queuedFirst).resolves.toBeDefined();
          if (firstOperation === "accept") {
            await expect(queuedSecond).resolves.toBeDefined();
          } else {
            await expectDasherBoundaryError(
              queuedSecond,
              "P1001",
              "dasher_denied",
            );
          }
          const terminal = await ownerPool.query<{
            readonly accepted: boolean;
            readonly pending_count: string;
            readonly revoked: boolean;
          }>(
            `
              SELECT
                target.accepted_at IS NOT NULL AS accepted,
                target.revoked_at IS NOT NULL AS revoked,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.invitations
                  WHERE organization_id = target.organization_id
                    AND normalized_email = target.normalized_email
                    AND accepted_at IS NULL
                    AND revoked_at IS NULL
                ) AS pending_count
              FROM dasher.invitations AS target
              WHERE target.invitation_id = $1::uuid
            `,
            [issueAcceptTarget.invitationId],
          );
          expect(terminal.rows[0]).toEqual(
            firstOperation === "accept"
              ? { accepted: true, pending_count: "1", revoked: false }
              : { accepted: false, pending_count: "1", revoked: true },
          );
        }

        const replayInvitation = await issueTask4Invitation(
          first,
          actorA,
          `replay-${randomUUID()}@example.test`,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          replayInvitation.normalizedEmail,
        ]);
        const issuer = `https://race-${randomUUID()}.test`;
        const subject = randomUUID();
        const acceptanceOne = acceptTask4Invitation(
          first,
          replayInvitation,
          issuer,
          subject,
        );
        const acceptanceOneSettled = retainDatabasePromise(
          retainedOperations,
          acceptanceOne,
        );
        const acceptanceTwo = acceptTask4Invitation(
          second,
          replayInvitation,
          issuer,
          subject,
        );
        const acceptanceTwoSettled = retainDatabasePromise(
          retainedOperations,
          acceptanceTwo,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          acceptanceOneSettled,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          acceptanceTwoSettled,
        );
        await blocker.query("COMMIT");
        const acceptanceResults = await Promise.allSettled([
          acceptanceOne,
          acceptanceTwo,
        ]);
        expect(
          acceptanceResults.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const rejectedAcceptance = acceptanceResults.find(
          (result) => result.status === "rejected",
        );
        expect(rejectedAcceptance).toBeDefined();
        await expectDasherBoundaryError(
          Promise.reject(
            rejectedAcceptance && "reason" in rejectedAcceptance
              ? rejectedAcceptance.reason
              : new Error("missing replay rejection"),
          ),
          "P1001",
          "dasher_denied",
        );

        const foreignTarget = await issueTask4Invitation(
          first,
          actorB,
          `foreign-${randomUUID()}@example.test`,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorB.organizationId,
          foreignTarget.normalizedEmail,
        ]);
        const legitimateB = issueTask4Invitation(
          second,
          actorB,
          foreignTarget.normalizedEmail,
        );
        const legitimateBSettled = retainDatabasePromise(
          retainedOperations,
          legitimateB,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          legitimateBSettled,
        );
        await expectDasherBoundaryError(
          first.query(
            `
              SELECT *
              FROM dasher_api.revoke_invitation(
                $1::uuid, $2::uuid, 1::smallint, $3::bytea,
                1::smallint, $4::bytea, $5::uuid, 'task4-race'
              )
            `,
            [
              foreignTarget.invitationId,
              randomUUID(),
              actorA.sessionDigest,
              actorA.csrfDigest,
              randomUUID(),
            ],
          ),
          "P1001",
          "dasher_denied",
        );
        await blocker.query("COMMIT");
        await expect(legitimateB).resolves.toBeDefined();
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("resolves external-identity and membership insertion races without orphan users or duplicate memberships", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const pendingAcceptances: Array<
        Promise<PromiseSettledResult<Task4Acceptance>>
      > = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const adminA = await createTask4Actor(first, "admin");
        const adminB = await createTask4Actor(first, "admin");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        const identityIssuer = `https://identity-race-${randomUUID()}.test`;
        const identitySubject = randomUUID();
        const identityInviteA = await issueTask4Invitation(
          first,
          adminA,
          `identity-a-${randomUUID()}@example.test`,
        );
        const identityInviteB = await issueTask4Invitation(
          second,
          adminB,
          `identity-b-${randomUUID()}@example.test`,
        );
        const proposedUserA = randomUUID();
        const proposedUserB = randomUUID();
        await blocker.query("BEGIN");
        await blocker.query(
          "LOCK TABLE dasher.external_identities IN ACCESS EXCLUSIVE MODE",
        );
        const identityAcceptanceA = settleDatabasePromise(
          acceptTask4Invitation(
            first,
            identityInviteA,
            identityIssuer,
            identitySubject,
            { userId: proposedUserA },
          ),
        );
        const identityAcceptanceB = settleDatabasePromise(
          acceptTask4Invitation(
            second,
            identityInviteB,
            identityIssuer,
            identitySubject,
            { userId: proposedUserB },
          ),
        );
        pendingAcceptances.push(identityAcceptanceA, identityAcceptanceB);
        await waitForDatabaseLock(
          observer,
          firstPid,
          "relation",
          identityAcceptanceA,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "relation",
          identityAcceptanceB,
        );
        await blocker.query("COMMIT");
        const identityAcceptanceResults = await Promise.all([
          identityAcceptanceA,
          identityAcceptanceB,
        ]);
        for (const result of identityAcceptanceResults) {
          expect(result.status).toBe("fulfilled");
          if (result.status !== "fulfilled") {
            throw result.reason;
          }
        }

        const identityState = await ownerPool.query<{
          readonly identity_count: string;
          readonly membership_count: string;
          readonly proposed_user_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.external_identities
                WHERE issuer = $1 AND subject = $2
              ) AS identity_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships AS membership
                JOIN dasher.external_identities AS identity_row
                  ON identity_row.user_id = membership.user_id
                WHERE identity_row.issuer = $1
                  AND identity_row.subject = $2
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.users
                WHERE user_id = ANY($3::uuid[])
              ) AS proposed_user_count
          `,
          [identityIssuer, identitySubject, [proposedUserA, proposedUserB]],
        );
        expect(identityState.rows[0]).toEqual({
          identity_count: "1",
          membership_count: "2",
          proposed_user_count: "1",
        });

        const membershipIssuer = `https://membership-race-${randomUUID()}.test`;
        const membershipSubject = randomUUID();
        const existingUserId = randomUUID();
        await ownerPool.query(
          "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
          [existingUserId],
        );
        await ownerPool.query(
          `
            INSERT INTO dasher.external_identities (
              issuer, subject, user_id
            ) VALUES ($1, $2, $3::uuid)
          `,
          [membershipIssuer, membershipSubject, existingUserId],
        );
        const membershipInvite = await issueTask4Invitation(
          first,
          adminA,
          `membership-a-${randomUUID()}@example.test`,
        );
        const winningMembershipId = randomUUID();
        const proposedMembershipId = randomUUID();
        const ignoredUserId = randomUUID();
        const acceptanceAuditEventId = randomUUID();
        await blocker.query("BEGIN");
        await blocker.query(
          `
            WITH captured_clock AS (
              SELECT pg_catalog.transaction_timestamp() AS now
            )
            INSERT INTO dasher.memberships (
              membership_id,
              organization_id,
              user_id,
              role,
              state,
              authority_revision,
              created_at,
              updated_at,
              revoked_at
            )
            SELECT
              $1::uuid,
              $2::uuid,
              $3::uuid,
              'editor',
              'active',
              7,
              captured_clock.now,
              captured_clock.now,
              NULL
            FROM captured_clock
          `,
          [winningMembershipId, adminA.organizationId, existingUserId],
        );
        const membershipAcceptance = settleDatabasePromise(
          acceptTask4Invitation(
            first,
            membershipInvite,
            membershipIssuer,
            membershipSubject,
            {
              auditEventId: acceptanceAuditEventId,
              membershipId: proposedMembershipId,
              userId: ignoredUserId,
            },
          ),
        );
        pendingAcceptances.push(membershipAcceptance);
        await waitForDatabaseLock(
          observer,
          firstPid,
          "transactionid",
          membershipAcceptance,
        );
        await blocker.query("COMMIT");
        const membershipAcceptanceResult = await membershipAcceptance;
        expect(membershipAcceptanceResult.status).toBe("fulfilled");
        if (membershipAcceptanceResult.status !== "fulfilled") {
          throw membershipAcceptanceResult.reason;
        }
        const acceptedSessionId = membershipAcceptanceResult.value.sessionId;

        const membershipState = await ownerPool.query<{
          readonly accepted_session_revision: string;
          readonly audit_action: string;
          readonly audit_authority_revision: string;
          readonly audit_organization_id: string;
          readonly audit_target_id: string;
          readonly audit_user_id: string;
          readonly ignored_user_count: string;
          readonly membership_count: string;
          readonly membership_id: string;
          readonly membership_revision: string;
          readonly membership_role: string;
          readonly proposed_membership_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE organization_id = $1::uuid
                  AND user_id = $2::uuid
              ) AS membership_count,
              membership.membership_id::text AS membership_id,
              membership.role AS membership_role,
              membership.authority_revision::text AS membership_revision,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE membership_id = $3::uuid
              ) AS proposed_membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.users
                WHERE user_id = $4::uuid
              ) AS ignored_user_count,
              session_row.authority_revision::text
                AS accepted_session_revision,
              audit.action AS audit_action,
              audit.authority_revision::text
                AS audit_authority_revision,
              audit.organization_id::text AS audit_organization_id,
              audit.actor_user_id::text AS audit_user_id,
              audit.target_id::text AS audit_target_id
            FROM dasher.memberships AS membership
            JOIN dasher.sessions AS session_row
              ON session_row.session_id = $5::uuid
             AND session_row.organization_id = membership.organization_id
             AND session_row.user_id = membership.user_id
            JOIN dasher.audit_events AS audit
              ON audit.audit_event_id = $6::uuid
            WHERE membership.membership_id = $7::uuid
          `,
          [
            adminA.organizationId,
            existingUserId,
            proposedMembershipId,
            ignoredUserId,
            acceptedSessionId,
            acceptanceAuditEventId,
            winningMembershipId,
          ],
        );
        expect(membershipState.rows[0]).toEqual({
          accepted_session_revision: "7",
          audit_action: "invitation.accepted_existing_membership",
          audit_authority_revision: "7",
          audit_organization_id: adminA.organizationId,
          audit_target_id: membershipInvite.invitationId,
          audit_user_id: existingUserId,
          ignored_user_count: "0",
          membership_count: "1",
          membership_id: winningMembershipId,
          membership_revision: "7",
          membership_role: "editor",
          proposed_membership_count: "0",
        });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(pendingAcceptances);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("uses a committed membership insertion winner before later role change or revocation in both operation orders", async () => {
      const authority = await appPool!.connect();
      const winner = await appPool!.connect();
      const loser = await appPool!.connect();
      const observer = await ownerPool.connect();
      try {
        await authority.query("SET ROLE dasher_app");
        await winner.query("SET ROLE dasher_app");
        await loser.query("SET ROLE dasher_app");
        const admin = await createTask4Actor(authority, "admin");
        for (const operation of ["role", "revoke"] as const) {
          for (const firstWaiter of ["loser", "authority"] as const) {
            const issuer = `https://three-way-${randomUUID()}.test`;
            const subject = randomUUID();
            const userId = randomUUID();
            await ownerPool.query(
              "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
              [userId],
            );
            await ownerPool.query(
              `
                INSERT INTO dasher.external_identities (
                  issuer, subject, user_id
                ) VALUES ($1, $2, $3::uuid)
              `,
              [issuer, subject, userId],
            );
            const winnerInvitation = await issueTask4Invitation(
              authority,
              admin,
              `winner-${randomUUID()}@example.test`,
            );
            const loserInvitation = await issueTask4Invitation(
              authority,
              admin,
              `loser-${randomUUID()}@example.test`,
            );
            const membershipId = randomUUID();
            await winner.query("BEGIN");
            await acceptTask4Invitation(
              winner,
              winnerInvitation,
              issuer,
              subject,
              {
                membershipId,
                userId: randomUUID(),
              },
            );
            await winner.query("COMMIT");

            const invokeLoser = () =>
              acceptTask4Invitation(loser, loserInvitation, issuer, subject, {
                membershipId: randomUUID(),
                userId: randomUUID(),
              });
            const invokeAuthority = () =>
              runContextOperation(
                authority,
                admin.sessionDigest,
                randomUUID(),
                () =>
                  operation === "role"
                    ? authority.query(
                        `
                          SELECT *
                          FROM dasher_api.change_membership_role(
                            $1::uuid, 'editor', $2::uuid, 1::smallint,
                            $3::bytea, 'task4-three-way'
                          )
                        `,
                        [membershipId, randomUUID(), admin.csrfDigest],
                      )
                    : authority.query(
                        `
                          SELECT *
                          FROM dasher_api.revoke_membership(
                            $1::uuid, $2::uuid, 1::smallint,
                            $3::bytea, 'task4-three-way'
                          )
                        `,
                        [membershipId, randomUUID(), admin.csrfDigest],
                      ),
              );

            let loserResult: Promise<unknown>;
            let authorityResult: Promise<unknown>;
            if (firstWaiter === "loser") {
              loserResult = invokeLoser();
              await expect(loserResult).resolves.toBeDefined();
              authorityResult = invokeAuthority();
            } else {
              authorityResult = invokeAuthority();
              await expect(authorityResult).resolves.toMatchObject({
                rowCount: 1,
              });
              loserResult = invokeLoser();
            }

            if (firstWaiter === "authority" && operation === "revoke") {
              await expectDasherBoundaryError(
                loserResult,
                "P1001",
                "dasher_denied",
              );
            } else {
              if (firstWaiter === "authority") {
                await expect(loserResult).resolves.toBeDefined();
              } else {
                await expect(authorityResult).resolves.toMatchObject({
                  rowCount: 1,
                });
              }
            }

            const state = await ownerPool.query<{
              readonly membership_count: string;
              readonly membership_revision: string;
              readonly membership_role: string;
              readonly membership_state: string;
              readonly loser_audit_count: string;
            }>(
              `
                SELECT
                  (
                    SELECT pg_catalog.count(*)::text
                    FROM dasher.memberships
                    WHERE organization_id = $1::uuid
                      AND user_id = $2::uuid
                  ) AS membership_count,
                  membership.role AS membership_role,
                  membership.state AS membership_state,
                  membership.authority_revision::text AS membership_revision,
                  (
                    SELECT pg_catalog.count(*)::text
                    FROM dasher.audit_events
                    WHERE target_id = $3::uuid
                      AND action =
                        'invitation.accepted_existing_membership'
                  ) AS loser_audit_count
                FROM dasher.memberships AS membership
                WHERE membership.membership_id = $4::uuid
              `,
              [
                admin.organizationId,
                userId,
                loserInvitation.invitationId,
                membershipId,
              ],
            );
            expect(state.rows[0]).toMatchObject({
              membership_count: "1",
              membership_revision: "2",
              membership_role: operation === "role" ? "editor" : "viewer",
              membership_state: operation === "revoke" ? "revoked" : "active",
              loser_audit_count:
                firstWaiter === "authority" && operation === "revoke"
                  ? "0"
                  : "1",
            });
          }
        }
      } finally {
        await winner.query("ROLLBACK").catch(() => undefined);
        await authority.query("ROLLBACK").catch(() => undefined);
        await loser.query("ROLLBACK").catch(() => undefined);
        await authority.query("RESET ROLE").catch(() => undefined);
        await winner.query("RESET ROLE").catch(() => undefined);
        await loser.query("RESET ROLE").catch(() => undefined);
        authority.release();
        winner.release();
        loser.release();
        observer.release();
      }
    });

    it("serializes acceptance against role change and membership revocation in both lock-winner orders", async () => {
      const authority = await appPool!.connect();
      const acceptance = await appPool!.connect();
      const observer = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await authority.query("SET ROLE dasher_app");
        await acceptance.query("SET ROLE dasher_app");
        const admin = await createTask4Actor(authority, "admin");
        const authorityPid = await appBackendPid(authority);
        const acceptancePid = await appBackendPid(acceptance);

        for (const operation of ["role", "revoke"] as const) {
          for (const winner of ["authority", "acceptance"] as const) {
            const target = await createTask4Actor(
              authority,
              "viewer",
              admin.organizationId,
            );
            const invitation = await issueTask4Invitation(
              authority,
              admin,
              `${operation}-${winner}-${randomUUID()}@example.test`,
            );
            const acceptedSessionId = randomUUID();
            const invokeAuthority = () =>
              operation === "role"
                ? authority.query(
                    `
                      SELECT *
                      FROM dasher_api.change_membership_role(
                        $1::uuid, 'editor', $2::uuid, 1::smallint,
                        $3::bytea, 'task4-acceptance-authority-race'
                      )
                    `,
                    [target.membershipId, randomUUID(), admin.csrfDigest],
                  )
                : authority.query(
                    `
                      SELECT *
                      FROM dasher_api.revoke_membership(
                        $1::uuid, $2::uuid, 1::smallint,
                        $3::bytea, 'task4-acceptance-authority-race'
                      )
                    `,
                    [target.membershipId, randomUUID(), admin.csrfDigest],
                  );
            const invokeAcceptance = () =>
              acceptTask4Invitation(
                acceptance,
                invitation,
                target.identityIssuer,
                target.identitySubject,
                {
                  membershipId: randomUUID(),
                  sessionId: acceptedSessionId,
                  userId: randomUUID(),
                },
              );

            if (winner === "authority") {
              await beginTask4Context(authority, admin.sessionDigest);
              await invokeAuthority();
              const waitingAcceptance = retainDatabasePromise(
                retainedOperations,
                invokeAcceptance(),
              );
              await waitForDatabaseLock(
                observer,
                acceptancePid,
                "advisory",
                waitingAcceptance,
              );
              await authority.query("COMMIT");
              const acceptanceResult = await waitingAcceptance;
              if (operation === "role") {
                expect(acceptanceResult.status).toBe("fulfilled");
              } else {
                expect(acceptanceResult.status).toBe("rejected");
                await expectDasherBoundaryError(
                  Promise.reject(
                    acceptanceResult.status === "rejected"
                      ? acceptanceResult.reason
                      : new Error("missing acceptance denial"),
                  ),
                  "P1001",
                  "dasher_denied",
                );
              }
            } else {
              await acceptance.query("BEGIN");
              await invokeAcceptance();
              const waitingAuthority = retainDatabasePromise(
                retainedOperations,
                (async () => {
                  await beginTask4Context(authority, admin.sessionDigest);
                  return invokeAuthority();
                })(),
              );
              await waitForDatabaseLock(
                observer,
                authorityPid,
                "advisory",
                waitingAuthority,
              );
              await acceptance.query("COMMIT");
              const authorityResult = await waitingAuthority;
              expect(authorityResult.status).toBe("fulfilled");
              await authority.query("COMMIT");
            }

            const finalState = await ownerPool.query<{
              readonly accepted: boolean;
              readonly membership_revision: string;
              readonly membership_state: string;
              readonly session_reason: string | null;
            }>(
              `
                SELECT
                  invitation.accepted_at IS NOT NULL AS accepted,
                  membership.authority_revision::text AS membership_revision,
                  membership.state AS membership_state,
                  session_row.revocation_reason AS session_reason
                FROM dasher.invitations AS invitation
                JOIN dasher.memberships AS membership
                  ON membership.membership_id = $2::uuid
                LEFT JOIN dasher.sessions AS session_row
                  ON session_row.session_id = $3::uuid
                WHERE invitation.invitation_id = $1::uuid
              `,
              [invitation.invitationId, target.membershipId, acceptedSessionId],
            );
            if (winner === "authority" && operation === "revoke") {
              expect(finalState.rows[0]).toMatchObject({
                accepted: false,
                membership_revision: "2",
                membership_state: "revoked",
                session_reason: null,
              });
            } else {
              expect(finalState.rows[0]).toMatchObject({
                accepted: true,
                membership_revision: "2",
                membership_state: operation === "revoke" ? "revoked" : "active",
                session_reason:
                  winner === "acceptance" ? "authority_changed" : null,
              });
            }
          }
        }
      } finally {
        await authority.query("ROLLBACK").catch(() => undefined);
        await acceptance.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await authority.query("RESET ROLE").catch(() => undefined);
        await acceptance.query("RESET ROLE").catch(() => undefined);
        authority.release();
        acceptance.release();
        observer.release();
      }
    });

    it("preserves a last admin in both lock-winner orders and denies foreign membership UUIDs before their row lock", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");

        for (const advisoryWinner of ["first", "second"] as const) {
          const adminA = await createTask4Actor(first, "admin");
          const adminB = await createTask4Actor(
            first,
            "admin",
            adminA.organizationId,
          );
          const secondPid = await appBackendPid(second);
          const winnerClient = advisoryWinner === "first" ? first : second;
          const winnerActor = advisoryWinner === "first" ? adminA : adminB;
          const loserClient = advisoryWinner === "first" ? second : first;
          const loserActor = advisoryWinner === "first" ? adminB : adminA;
          const loserPid =
            advisoryWinner === "first" ? secondPid : await appBackendPid(first);

          await beginTask4Context(
            winnerClient,
            winnerActor.sessionDigest,
            randomUUID(),
          );
          const loserContext = retainDatabasePromise(
            retainedOperations,
            beginTask4Context(
              loserClient,
              loserActor.sessionDigest,
              randomUUID(),
            ),
          );
          await waitForDatabaseLock(
            observer,
            loserPid,
            "advisory",
            loserContext,
          );

          if (advisoryWinner === "first") {
            await first.query(
              `
                SELECT *
                FROM dasher_api.change_membership_role(
                  $1::uuid, 'viewer', $2::uuid, 1::smallint,
                  $3::bytea, 'task4-last-admin'
                )
              `,
              [adminB.membershipId, randomUUID(), adminA.csrfDigest],
            );
          } else {
            await second.query(
              `
                SELECT *
                FROM dasher_api.revoke_membership(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-last-admin'
                )
              `,
              [adminA.membershipId, randomUUID(), adminB.csrfDigest],
            );
          }
          await winnerClient.query("COMMIT");

          const loserContextResult = await loserContext;
          if (loserContextResult.status === "fulfilled") {
            const loserOperation =
              advisoryWinner === "first"
                ? loserClient.query(
                    `
                      SELECT *
                      FROM dasher_api.revoke_membership(
                        $1::uuid, $2::uuid, 1::smallint,
                        $3::bytea, 'task4-last-admin'
                      )
                    `,
                    [adminA.membershipId, randomUUID(), adminB.csrfDigest],
                  )
                : loserClient.query(
                    `
                      SELECT *
                      FROM dasher_api.change_membership_role(
                        $1::uuid, 'viewer', $2::uuid, 1::smallint,
                        $3::bytea, 'task4-last-admin'
                      )
                    `,
                    [adminB.membershipId, randomUUID(), adminA.csrfDigest],
                  );
            await expectDasherBoundaryError(
              loserOperation,
              "P1001",
              "dasher_denied",
            );
          } else {
            await expectDasherBoundaryError(
              Promise.reject(loserContextResult.reason),
              "P1001",
              "dasher_denied",
            );
          }
          await loserClient.query("ROLLBACK");

          const activeAdmins = await ownerPool.query<{
            readonly count: string;
          }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.memberships
              WHERE organization_id = $1::uuid
                AND role = 'admin'
                AND state = 'active'
            `,
            [adminA.organizationId],
          );
          expect(activeAdmins.rows[0]?.count).toBe("1");
        }

        const adminA = await createTask4Actor(first, "admin");
        const adminB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          adminA.organizationId,
          adminB.organizationId,
        );
        const targetB = await createTask4Actor(
          first,
          "viewer",
          adminB.organizationId,
        );
        const secondPid = await appBackendPid(second);
        await blocker.query("BEGIN");
        await blocker.query(
          `
            SELECT 1
            FROM dasher.memberships
            WHERE membership_id = $1::uuid
            FOR UPDATE
          `,
          [targetB.membershipId],
        );
        const legitimateB = runContextOperation(
          second,
          adminB.sessionDigest,
          randomUUID(),
          () =>
            second.query(
              `
                SELECT *
                FROM dasher_api.change_membership_role(
                  $1::uuid, 'editor', $2::uuid, 1::smallint,
                  $3::bytea, 'task4-foreign-membership'
                )
              `,
              [targetB.membershipId, randomUUID(), adminB.csrfDigest],
            ),
        );
        const legitimateBSettled = retainDatabasePromise(
          retainedOperations,
          legitimateB,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          ["transactionid", "tuple"],
          legitimateBSettled,
        );
        for (const operation of ["change", "revoke"] as const) {
          await expectDasherBoundaryError(
            runContextOperation(
              first,
              adminA.sessionDigest,
              randomUUID(),
              () =>
                operation === "change"
                  ? first.query(
                      `
                        SELECT *
                        FROM dasher_api.change_membership_role(
                          $1::uuid, 'editor', $2::uuid, 1::smallint,
                          $3::bytea, 'task4-foreign-membership'
                        )
                      `,
                      [targetB.membershipId, randomUUID(), adminA.csrfDigest],
                    )
                  : first.query(
                      `
                        SELECT *
                        FROM dasher_api.revoke_membership(
                          $1::uuid, $2::uuid, 1::smallint,
                          $3::bytea, 'task4-foreign-membership'
                        )
                      `,
                      [targetB.membershipId, randomUUID(), adminA.csrfDigest],
                    ),
            ),
            "P1001",
            "dasher_denied",
          );
        }
        await blocker.query("COMMIT");
        await expect(legitimateB).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("serializes context membership changes against acceptance and issue collisions in both organization-key orders", async () => {
      const contextClient = await appPool!.connect();
      const entryClient = await appPool!.connect();
      const observer = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await contextClient.query("SET ROLE dasher_app");
        await entryClient.query("SET ROLE dasher_app");
        const entryPid = await appBackendPid(entryClient);

        for (const entry of ["accept", "issue"] as const) {
          for (const mutation of ["role", "revoke"] as const) {
            for (const winner of ["entry", "context"] as const) {
              const admin = await createTask4Actor(contextClient, "admin");
              const target = await createTask4Actor(
                contextClient,
                "viewer",
                admin.organizationId,
              );
              const entryAuditId = randomUUID();
              const mutationAuditId = randomUUID();
              const invitation =
                entry === "accept"
                  ? await issueTask4Invitation(
                      contextClient,
                      admin,
                      `context-entry-${randomUUID()}@example.test`,
                    )
                  : undefined;

              const invokeEntry = (): Promise<unknown> =>
                entry === "accept"
                  ? acceptTask4Invitation(
                      entryClient,
                      invitation!,
                      target.identityIssuer,
                      target.identitySubject,
                      {
                        auditEventId: entryAuditId,
                        sessionId: admin.sessionId,
                      },
                    )
                  : entryClient.query(
                      `
                        SELECT *
                        FROM dasher_api.issue_session(
                          $1, $2, $3::uuid, $4::uuid, 1::smallint,
                          $5::bytea, 1::smallint, $6::bytea, $7::uuid,
                          $8::uuid, 'task4-context-entry'
                        )
                      `,
                      [
                        target.identityIssuer,
                        target.identitySubject,
                        target.membershipId,
                        admin.sessionId,
                        randomBytes(32),
                        randomBytes(32),
                        entryAuditId,
                        randomUUID(),
                      ],
                    );
              const invokeMutation = () =>
                mutation === "role"
                  ? contextClient.query(
                      `
                        SELECT *
                        FROM dasher_api.change_membership_role(
                          $1::uuid, 'editor', $2::uuid, 1::smallint,
                          $3::bytea, 'task4-context-entry'
                        )
                      `,
                      [target.membershipId, mutationAuditId, admin.csrfDigest],
                    )
                  : contextClient.query(
                      `
                        SELECT *
                        FROM dasher_api.revoke_membership(
                          $1::uuid, $2::uuid, 1::smallint,
                          $3::bytea, 'task4-context-entry'
                        )
                      `,
                      [target.membershipId, mutationAuditId, admin.csrfDigest],
                    );

              if (winner === "entry") {
                await expectDasherBoundaryError(
                  invokeEntry(),
                  "P1002",
                  "dasher_conflict",
                );
                await runContextOperation(
                  contextClient,
                  admin.sessionDigest,
                  randomUUID(),
                  invokeMutation,
                );
              } else {
                await beginTask4Context(
                  contextClient,
                  admin.sessionDigest,
                  randomUUID(),
                );
                await invokeMutation();
                const entryResult = retainDatabasePromise(
                  retainedOperations,
                  invokeEntry(),
                );
                await waitForDatabaseLock(
                  observer,
                  entryPid,
                  "advisory",
                  entryResult,
                );
                await contextClient.query("COMMIT");
                const settledEntry = await entryResult;
                expect(settledEntry.status).toBe("rejected");
                await expectDasherBoundaryError(
                  Promise.reject(
                    settledEntry.status === "rejected"
                      ? settledEntry.reason
                      : new Error("missing context-entry loser"),
                  ),
                  mutation === "revoke" ? "P1001" : "P1002",
                  mutation === "revoke" ? "dasher_denied" : "dasher_conflict",
                );
              }

              const state = await ownerPool.query<{
                readonly entry_audit_count: string;
                readonly mutation_audit_count: string;
                readonly session_count: string;
              }>(
                `
                  SELECT
                    (
                      SELECT pg_catalog.count(*)::text
                      FROM dasher.sessions
                      WHERE session_id = $1::uuid
                    ) AS session_count,
                    (
                      SELECT pg_catalog.count(*)::text
                      FROM dasher.audit_events
                      WHERE audit_event_id = $2::uuid
                    ) AS entry_audit_count,
                    (
                      SELECT pg_catalog.count(*)::text
                      FROM dasher.audit_events
                      WHERE audit_event_id = $3::uuid
                    ) AS mutation_audit_count
                `,
                [admin.sessionId, entryAuditId, mutationAuditId],
              );
              expect(state.rows[0]).toEqual({
                entry_audit_count: "0",
                mutation_audit_count: "1",
                session_count: "1",
              });
            }
          }
        }
      } finally {
        await contextClient.query("ROLLBACK").catch(() => undefined);
        await entryClient.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await contextClient.query("RESET ROLE").catch(() => undefined);
        await entryClient.query("RESET ROLE").catch(() => undefined);
        contextClient.release();
        entryClient.release();
        observer.release();
      }
    });

    it("canonically locks reverse session IDs, returns one concurrent rotation conflict, and rolls lineage back on audit failure", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(first, "admin");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        await blocker.query("BEGIN");
        await blocker.query(
          `
            SELECT 1
            FROM dasher.memberships
            WHERE membership_id = $1::uuid
            FOR UPDATE
          `,
          [actor.membershipId],
        );
        await first.query("BEGIN");
        await second.query("BEGIN");
        await setTask4ContextGucs(first, actor, randomUUID());
        await setTask4ContextGucs(second, actor, randomUUID());
        const successorOne = randomUUID();
        const successorTwo = randomUUID();
        const rotateOne = retainDatabasePromise(
          retainedOperations,
          first.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-concurrent-rotation'
              )
            `,
            [
              successorOne,
              randomBytes(32),
              randomBytes(32),
              randomUUID(),
              actor.csrfDigest,
            ],
          ),
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "transactionid",
          rotateOne,
        );
        const rotateTwo = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-concurrent-rotation'
              )
            `,
            [
              successorTwo,
              randomBytes(32),
              randomBytes(32),
              randomUUID(),
              actor.csrfDigest,
            ],
          ),
        );
        await waitForDatabaseLock(observer, secondPid, "advisory", rotateTwo);
        await blocker.query("COMMIT");
        const rotateOneResult = await rotateOne;
        expect(rotateOneResult.status).toBe("fulfilled");
        await first.query("COMMIT");
        const rotateTwoResult = await rotateTwo;
        expect(rotateTwoResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            rotateTwoResult.status === "rejected"
              ? rotateTwoResult.reason
              : new Error("missing rotation conflict"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");
        const rotationState = await ownerPool.query<{
          readonly predecessor_link: string | null;
          readonly successor_count: string;
        }>(
          `
            SELECT
              (
                SELECT replaced_by_session_id::text
                FROM dasher.sessions
                WHERE session_id = $1::uuid
              ) AS predecessor_link,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($2::uuid[])
              ) AS successor_count
          `,
          [actor.sessionId, [successorOne, successorTwo]],
        );
        expect(rotationState.rows[0]).toEqual({
          predecessor_link: successorOne,
          successor_count: "1",
        });

        for (const firstOperation of ["rotate", "revoke"] as const) {
          const lineageActor = await createTask4Actor(first, "admin");
          const predecessorId =
            firstOperation === "rotate"
              ? "ffffffff-ffff-4fff-8fff-ffffffffffe1"
              : "00000000-0000-4000-8000-0000000000e1";
          const revokerId =
            firstOperation === "rotate"
              ? "00000000-0000-4000-8000-0000000000e2"
              : "ffffffff-ffff-4fff-8fff-ffffffffffe2";
          const predecessorProof = await issueAdditionalTask4Session(
            first,
            lineageActor,
            predecessorId,
          );
          const revokerProof = await issueAdditionalTask4Session(
            first,
            lineageActor,
            revokerId,
          );
          const predecessor = {
            ...lineageActor,
            ...predecessorProof,
            sessionId: predecessorId,
          };
          const revoker = {
            ...lineageActor,
            ...revokerProof,
            sessionId: revokerId,
          };
          const lineageSuccessorId = randomUUID();
          await blocker.query("BEGIN");
          await blocker.query(
            `
              SELECT 1
              FROM dasher.memberships
              WHERE membership_id = $1::uuid
              FOR UPDATE
            `,
            [lineageActor.membershipId],
          );
          await first.query("BEGIN");
          await second.query("BEGIN");
          await setTask4ContextGucs(first, predecessor, randomUUID());
          await setTask4ContextGucs(second, revoker, randomUUID());
          const invokeRotate = () =>
            first.query(
              `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                  $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                  'task4-rotate-revoke'
                )
              `,
              [
                lineageSuccessorId,
                randomBytes(32),
                randomBytes(32),
                randomUUID(),
                predecessor.csrfDigest,
              ],
            );
          const invokeRevoke = () =>
            second.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-rotate-revoke'
                )
              `,
              [predecessor.sessionId, randomUUID(), revoker.csrfDigest],
            );
          const firstResult = retainDatabasePromise(
            retainedOperations,
            firstOperation === "rotate" ? invokeRotate() : invokeRevoke(),
          );
          await waitForDatabaseLock(
            observer,
            firstOperation === "rotate" ? firstPid : secondPid,
            "transactionid",
            firstResult,
          );
          const secondResult = retainDatabasePromise(
            retainedOperations,
            firstOperation === "rotate" ? invokeRevoke() : invokeRotate(),
          );
          await waitForDatabaseLock(
            observer,
            firstOperation === "rotate" ? secondPid : firstPid,
            "advisory",
            secondResult,
          );
          await blocker.query("COMMIT");
          const settledFirst = await firstResult;
          expect(settledFirst.status).toBe("fulfilled");
          await (firstOperation === "rotate" ? first : second).query("COMMIT");
          const settledSecond = await secondResult;
          if (firstOperation === "rotate") {
            expect(settledSecond.status).toBe("fulfilled");
            await second.query("COMMIT");
          } else {
            expect(settledSecond.status).toBe("rejected");
            await expectDasherBoundaryError(
              Promise.reject(
                settledSecond.status === "rejected"
                  ? settledSecond.reason
                  : new Error("missing rotate/revoke denial"),
              ),
              "P1001",
              "dasher_denied",
            );
            await first.query("ROLLBACK");
          }
          const lineageState = await ownerPool.query<{
            readonly predecessor_revoked: boolean;
            readonly successor_count: string;
          }>(
            `
              SELECT
                revoked_at IS NOT NULL AS predecessor_revoked,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.sessions
                  WHERE session_id = $2::uuid
                ) AS successor_count
              FROM dasher.sessions
              WHERE session_id = $1::uuid
            `,
            [predecessorId, lineageSuccessorId],
          );
          expect(lineageState.rows[0]).toEqual({
            predecessor_revoked: true,
            successor_count: firstOperation === "rotate" ? "1" : "0",
          });
        }

        for (const [currentId, targetId] of [
          [
            "ffffffff-ffff-4fff-8fff-fffffffffff1",
            "00000000-0000-4000-8000-000000000001",
          ],
          [
            "00000000-0000-4000-8000-000000000002",
            "ffffffff-ffff-4fff-8fff-fffffffffff2",
          ],
        ] as const) {
          const raceActor = await createTask4Actor(first, "admin");
          const currentProof = await issueAdditionalTask4Session(
            first,
            raceActor,
            currentId,
          );
          const targetProof = await issueAdditionalTask4Session(
            first,
            raceActor,
            targetId,
          );
          const current = {
            ...raceActor,
            ...currentProof,
            sessionId: currentId,
          };
          const target = {
            ...raceActor,
            ...targetProof,
            sessionId: targetId,
          };
          await blocker.query("BEGIN");
          await blocker.query(
            `
              SELECT 1
              FROM dasher.memberships
              WHERE membership_id = $1::uuid
              FOR UPDATE
            `,
            [raceActor.membershipId],
          );
          await first.query("BEGIN");
          await second.query("BEGIN");
          await setTask4ContextGucs(first, current, randomUUID());
          await setTask4ContextGucs(second, target, randomUUID());
          const revokeTarget = retainDatabasePromise(
            retainedOperations,
            first.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-reverse-session'
                )
              `,
              [target.sessionId, randomUUID(), current.csrfDigest],
            ),
          );
          await waitForDatabaseLock(
            observer,
            firstPid,
            "transactionid",
            revokeTarget,
          );
          const revokeCurrent = retainDatabasePromise(
            retainedOperations,
            second.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-reverse-session'
                )
              `,
              [current.sessionId, randomUUID(), target.csrfDigest],
            ),
          );
          await waitForDatabaseLock(
            observer,
            secondPid,
            "advisory",
            revokeCurrent,
          );
          await blocker.query("COMMIT");
          const revokeTargetResult = await revokeTarget;
          expect(revokeTargetResult.status).toBe("fulfilled");
          await first.query("COMMIT");
          const revokeCurrentResult = await revokeCurrent;
          expect(revokeCurrentResult.status).toBe("rejected");
          await expectDasherBoundaryError(
            Promise.reject(
              revokeCurrentResult.status === "rejected"
                ? revokeCurrentResult.reason
                : new Error("missing reverse session denial"),
            ),
            "P1001",
            "dasher_denied",
          );
          await second.query("ROLLBACK");
        }

        const failureActor = await createTask4Actor(first, "admin");
        const failedSuccessor = randomUUID();
        const failedAuditId = randomUUID();
        const revoker = await ownerPool.connect();
        try {
          await revoker.query("BEGIN");
          await revoker.query(`
            REVOKE INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            FROM dasher_security_definer
          `);
          await revoker.query("COMMIT");
        } finally {
          revoker.release();
        }
        try {
          await expectPostgresError(
            runContextOperation(
              first,
              failureActor.sessionDigest,
              randomUUID(),
              () =>
                first.query(
                  `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-rotation-audit-failure'
                    )
                  `,
                  [
                    failedSuccessor,
                    randomBytes(32),
                    randomBytes(32),
                    failedAuditId,
                    failureActor.csrfDigest,
                  ],
                ),
            ),
            "42501",
          );
        } finally {
          const restorer = await ownerPool.connect();
          try {
            await restorer.query("BEGIN");
            await restorer.query(`
              GRANT INSERT (${task4AuditColumnsSql})
              ON dasher.audit_events
              TO dasher_security_definer
            `);
            await restorer.query("COMMIT");
          } finally {
            restorer.release();
          }
        }
        const failureState = await ownerPool.query<{
          readonly audit_count: string;
          readonly predecessor_link: string | null;
          readonly successor_count: string;
        }>(
          `
            SELECT
              (
                SELECT replaced_by_session_id::text
                FROM dasher.sessions
                WHERE session_id = $1::uuid
              ) AS predecessor_link,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = $2::uuid
              ) AS successor_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = $3::uuid
              ) AS audit_count
          `,
          [failureActor.sessionId, failedSuccessor, failedAuditId],
        );
        expect(failureState.rows[0]).toEqual({
          audit_count: "0",
          predecessor_link: null,
          successor_count: "0",
        });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("keeps rotation aliases source-locked and rejects cross-organization reverse collisions without deadlock", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");

        const lineageActor = await createTask4Actor(first, "admin");
        const lineageSessionId = randomUUID();
        const lineageSessionDigest = randomBytes(32);
        const lineageCsrfDigest = randomBytes(32);
        await runContextOperation(
          first,
          lineageActor.sessionDigest,
          randomUUID(),
          () =>
            first.query(
              `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                  $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                  'task4-lineage-alias'
                )
              `,
              [
                lineageSessionId,
                lineageSessionDigest,
                lineageCsrfDigest,
                randomUUID(),
                lineageActor.csrfDigest,
              ],
            ),
        );
        const lineageCurrent = {
          ...lineageActor,
          csrfDigest: lineageCsrfDigest,
          sessionDigest: lineageSessionDigest,
          sessionId: lineageSessionId,
        };

        for (const proposedId of [
          lineageCurrent.sessionId,
          lineageActor.sessionId,
        ]) {
          const auditEventId = randomUUID();
          await expectDasherBoundaryError(
            runContextOperation(
              first,
              lineageCurrent.sessionDigest,
              randomUUID(),
              () =>
                first.query(
                  `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-lineage-alias'
                    )
                  `,
                  [
                    proposedId,
                    randomBytes(32),
                    randomBytes(32),
                    auditEventId,
                    lineageCurrent.csrfDigest,
                  ],
                ),
            ),
            "P1002",
            "dasher_conflict",
          );
          expect(
            (
              await ownerPool.query<{ readonly count: string }>(
                `
                  SELECT pg_catalog.count(*)::text AS count
                  FROM dasher.audit_events
                  WHERE audit_event_id = $1::uuid
                `,
                [auditEventId],
              )
            ).rows[0]?.count,
          ).toBe("0");
        }
        expect(
          (
            await ownerPool.query<{
              readonly replaced_by_session_id: string | null;
              readonly rotated_from_session_id: string | null;
            }>(
              `
                SELECT
                  rotated_from_session_id::text,
                  replaced_by_session_id::text
                FROM dasher.sessions
                WHERE session_id = $1::uuid
              `,
              [lineageSessionId],
            )
          ).rows[0],
        ).toEqual({
          replaced_by_session_id: null,
          rotated_from_session_id: lineageActor.sessionId,
        });

        const actorA = await createTask4Actor(first, "admin");
        const actorB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          actorA.organizationId,
          actorB.organizationId,
        );

        await beginTask4Context(first, actorA.sessionDigest, randomUUID());
        await beginTask4Context(second, actorB.sessionDigest, randomUUID());
        const auditA = randomUUID();
        const auditB = randomUUID();
        const rotationA = retainDatabasePromise(
          retainedOperations,
          first.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-cross-org-reverse'
              )
            `,
            [
              actorB.sessionId,
              randomBytes(32),
              randomBytes(32),
              auditA,
              actorA.csrfDigest,
            ],
          ),
        );
        const rotationB = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-cross-org-reverse'
              )
            `,
            [
              actorA.sessionId,
              randomBytes(32),
              randomBytes(32),
              auditB,
              actorB.csrfDigest,
            ],
          ),
        );
        const [resultA, resultB] = await Promise.all([rotationA, rotationB]);
        for (const result of [resultA, resultB]) {
          expect(result.status).toBe("rejected");
          await expectDasherBoundaryError(
            Promise.reject(
              result.status === "rejected"
                ? result.reason
                : new Error("missing reverse collision"),
            ),
            "P1002",
            "dasher_conflict",
          );
        }
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");

        const reverseState = await ownerPool.query<{
          readonly audit_count: string;
          readonly changed_count: string;
        }>(
          `
            SELECT
              pg_catalog.count(*) FILTER (
                WHERE session_id = ANY($1::uuid[])
                  AND replaced_by_session_id IS NOT NULL
              )::text AS changed_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($2::uuid[])
              ) AS audit_count
            FROM dasher.sessions
          `,
          [
            [actorA.sessionId, actorB.sessionId],
            [auditA, auditB],
          ],
        );
        expect(reverseState.rows[0]).toEqual({
          audit_count: "0",
          changed_count: "0",
        });
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
      }
    });

    it("runs Task 6 repository issue and accept with exact DB winners, session, cookie, identity, and audit", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const actor = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const invitationId = randomUUID();
        const issueAuditId = randomUUID();
        const proposedUserId = randomUUID();
        const proposedMembershipId = randomUUID();
        const proposedSessionId = randomUUID();
        const acceptAuditId = randomUUID();
        const repository = createTask6Repository(client, keyRing, [
          invitationId,
          issueAuditId,
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ]);
        const email = `task6-${randomUUID()}@example.test`;
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email: email.toUpperCase(),
          role: "editor",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        const issuer = "https://task6-provider.test/exact";
        const subject = randomUUID();
        const accepted = await repository.acceptInvitation({
          requestId: randomUUID(),
          inviteToken: issued.inviteToken,
          principal: task6Principal(email, issuer, subject),
        });

        expect(issued.invitationId).toBe(invitationId);
        expect(issued.expiresAt).toBeInstanceOf(Date);
        expect(accepted).toMatchObject({
          userId: proposedUserId,
          organizationId: actor.organizationId,
          membershipId: proposedMembershipId,
          sessionId: proposedSessionId,
          role: "editor",
          authorityRevision: 1,
        });
        expect(accepted.sessionCookie).toMatchObject({
          name: "__Host-dasher_session",
          secure: true,
          httpOnly: true,
          path: "/",
          sameSite: "lax",
        });
        expect([604_799, 604_800]).toContain(accepted.sessionCookie.maxAge);
        expect(accepted.idleExpiresAt.getTime()).toBeLessThan(
          accepted.absoluteExpiresAt.getTime(),
        );

        const sessionPersistence = keyRing.verify(
          "session",
          accepted.sessionToken,
        );
        const csrfPersistence = keyRing.verify("csrf", accepted.csrfValue);
        const persisted = await ownerPool.query<{
          readonly accepted_user_id: string;
          readonly action: string[];
          readonly csrf_digest: string;
          readonly identity_user_id: string;
          readonly invitation_expires_at: Date;
          readonly session_digest: string;
          readonly session_idle_expires_at: Date;
          readonly session_absolute_expires_at: Date;
        }>(
          `
            SELECT
              invitation.accepted_user_id::text,
              invitation.expires_at AS invitation_expires_at,
              identity_row.user_id::text AS identity_user_id,
              pg_catalog.encode(session_row.token_digest, 'hex') AS session_digest,
              pg_catalog.encode(session_row.csrf_digest, 'hex') AS csrf_digest,
              session_row.idle_expires_at AS session_idle_expires_at,
              session_row.absolute_expires_at AS session_absolute_expires_at,
              ARRAY(
                SELECT audit.action
                FROM dasher.audit_events AS audit
                WHERE audit.audit_event_id = ANY($7::uuid[])
                ORDER BY audit.action
              ) AS action
            FROM dasher.invitations AS invitation
            JOIN dasher.external_identities AS identity_row
              ON identity_row.issuer = $2
             AND identity_row.subject = $3
            JOIN dasher.sessions AS session_row
              ON session_row.session_id = $4::uuid
            WHERE invitation.invitation_id = $1::uuid
              AND session_row.user_id = $5::uuid
              AND session_row.organization_id = $6::uuid
          `,
          [
            invitationId,
            issuer,
            subject,
            proposedSessionId,
            proposedUserId,
            actor.organizationId,
            [issueAuditId, acceptAuditId],
          ],
        );
        expect(persisted.rows[0]).toMatchObject({
          accepted_user_id: proposedUserId,
          identity_user_id: proposedUserId,
          invitation_expires_at: issued.expiresAt,
          session_idle_expires_at: accepted.idleExpiresAt,
          session_absolute_expires_at: accepted.absoluteExpiresAt,
          session_digest: Buffer.from(sessionPersistence.digest).toString(
            "hex",
          ),
          csrf_digest: Buffer.from(csrfPersistence.digest).toString("hex"),
          action: ["invitation.accepted", "invitation.issued"],
        });
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("keeps an exact immutable identity and existing active membership unchanged through Task 6 wrappers", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const admin = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const existing = await createTask4Actor(
          client,
          "viewer",
          admin.organizationId,
        );
        const proposedUserId = randomUUID();
        const proposedMembershipId = randomUUID();
        const proposedSessionId = randomUUID();
        const repository = createTask6Repository(client, keyRing, [
          randomUUID(),
          randomUUID(),
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          randomUUID(),
        ]);
        const email = `existing-${randomUUID()}@example.test`;
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "admin",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        const accepted = await repository.acceptInvitation({
          requestId: randomUUID(),
          inviteToken: issued.inviteToken,
          principal: task6Principal(
            email,
            existing.identityIssuer,
            existing.identitySubject,
          ),
        });

        expect(accepted).toMatchObject({
          userId: existing.userId,
          membershipId: existing.membershipId,
          organizationId: admin.organizationId,
          role: "viewer",
          authorityRevision: 1,
          sessionId: proposedSessionId,
        });
        expect(accepted.userId).not.toBe(proposedUserId);
        expect(accepted.membershipId).not.toBe(proposedMembershipId);
        const state = await ownerPool.query<{
          readonly action: string;
          readonly membership_count: string;
          readonly role: string;
          readonly authority_revision: string;
        }>(
          `
            SELECT
              membership.role,
              membership.authority_revision::text,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE organization_id = $1::uuid
                  AND user_id = $2::uuid
              ) AS membership_count,
              (
                SELECT action
                FROM dasher.audit_events
                WHERE target_id = $3::uuid
                  AND action = 'invitation.accepted_existing_membership'
              ) AS action
            FROM dasher.memberships AS membership
            WHERE membership.membership_id = $4::uuid
          `,
          [
            admin.organizationId,
            existing.userId,
            issued.invitationId,
            existing.membershipId,
          ],
        );
        expect(state.rows[0]).toEqual({
          action: "invitation.accepted_existing_membership",
          authority_revision: "1",
          membership_count: "1",
          role: "viewer",
        });
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("normalizes Task 6 replay, wrong email, expiry, revoked membership, and retired key to denials", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const admin = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const events: Array<Readonly<{ requestId: string; reason: string }>> =
          [];
        const uuidValues = Array.from({ length: 30 }, () => randomUUID());
        const repository = createTask6Repository(
          client,
          keyRing,
          uuidValues,
          events,
        );
        const baseEmail = `denial-${randomUUID()}@example.test`;
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email: baseEmail,
          role: "viewer",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: task6Principal(`wrong-${baseEmail}`),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        const exactPrincipal = task6Principal(baseEmail);
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: exactPrincipal,
          }),
        ).resolves.toMatchObject({ organizationId: admin.organizationId });
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: exactPrincipal,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const expiredEmail = `expired-${randomUUID()}@example.test`;
        const expired = await repository.issueInvitation({
          requestId: randomUUID(),
          email: expiredEmail,
          role: "viewer",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        await ownerPool.query(
          "UPDATE dasher.invitations SET expires_at = pg_catalog.clock_timestamp() WHERE invitation_id = $1::uuid",
          [expired.invitationId],
        );
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: expired.inviteToken,
            principal: task6Principal(expiredEmail),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const revoked = await createTask4Actor(
          client,
          "viewer",
          admin.organizationId,
        );
        await ownerPool.query(
          "UPDATE dasher.memberships SET state = 'revoked', authority_revision = authority_revision + 1, revoked_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp() WHERE membership_id = $1::uuid",
          [revoked.membershipId],
        );
        const revokedEmail = `revoked-${randomUUID()}@example.test`;
        const revokedInvitation = await repository.issueInvitation({
          requestId: randomUUID(),
          email: revokedEmail,
          role: "admin",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: revokedInvitation.inviteToken,
            principal: task6Principal(
              revokedEmail,
              revoked.identityIssuer,
              revoked.identitySubject,
            ),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const retiredSecret = Buffer.alloc(32, 7).toString("base64url");
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: `i1.3.${retiredSecret}`,
            principal: task6Principal(baseEmail),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        expect(
          events.filter((event) => event.reason === "state_invalid"),
        ).toHaveLength(4);
        expect(
          events.filter((event) => event.reason === "input_invalid"),
        ).toHaveLength(1);
        for (const event of events) {
          expect(Object.keys(event).sort()).toEqual(["reason", "requestId"]);
          expect(Object.isFrozen(event)).toBe(true);
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("allows exactly one concurrent Task 6 acceptance with no duplicate membership, session, or audit", async () => {
      const issuerClient = await appPool!.connect();
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await issuerClient.query("SET ROLE dasher_app");
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const admin = await createTask4Actor(issuerClient, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const issueRepository = createTask6Repository(issuerClient, keyRing, [
          randomUUID(),
          randomUUID(),
        ]);
        const email = `race-${randomUUID()}@example.test`;
        const issued = await issueRepository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "editor",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        const firstIds = [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ];
        const secondIds = [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ];
        const firstRepository = createTask6Repository(first, keyRing, firstIds);
        const secondRepository = createTask6Repository(
          second,
          keyRing,
          secondIds,
        );
        const principal = task6Principal(email);

        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT invitation_id FROM dasher.invitations WHERE invitation_id = $1::uuid FOR UPDATE",
          [issued.invitationId],
        );
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);
        const firstAcceptance = retainDatabasePromise(
          retainedOperations,
          firstRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          firstPid,
          ["transactionid", "tuple"],
          firstAcceptance,
        );
        const secondAcceptance = retainDatabasePromise(
          retainedOperations,
          secondRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          secondPid,
          ["advisory", "transactionid", "tuple"],
          secondAcceptance,
        );
        await blocker.query("ROLLBACK");
        const results = await Promise.all([firstAcceptance, secondAcceptance]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(
          rejected?.status === "rejected" ? rejected.reason : undefined,
        ).toBeInstanceOf(OperationDeniedError);

        const state = await ownerPool.query<{
          readonly acceptance_audit_count: string;
          readonly membership_count: string;
          readonly session_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE organization_id = $1::uuid
                  AND user_id = (
                    SELECT accepted_user_id
                    FROM dasher.invitations
                    WHERE invitation_id = $2::uuid
                  )
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($3::uuid[])
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($4::uuid[])
              ) AS acceptance_audit_count
          `,
          [
            admin.organizationId,
            issued.invitationId,
            [firstIds[2], secondIds[2]],
            [firstIds[3], secondIds[3]],
          ],
        );
        expect(state.rows[0]).toEqual({
          acceptance_audit_count: "1",
          membership_count: "1",
          session_count: "1",
        });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await issuerClient.query("RESET ROLE").catch(() => undefined);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        blocker.release();
        issuerClient.release();
        first.release();
        second.release();
      }
    });

    it("converges concurrent Task 6 wrapper acceptances on one external-identity winner across organizations", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      let blockerOpen = false;
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const firstCurrentSession = keyRing.issue("session");
        const firstCurrentCsrf = keyRing.issue("csrf");
        const secondCurrentSession = keyRing.issue("session");
        const secondCurrentCsrf = keyRing.issue("csrf");
        const firstAdmin = await createTask4Actor(first, "admin", undefined, {
          sessionDigest: Buffer.from(firstCurrentSession.persistence.digest),
          csrfDigest: Buffer.from(firstCurrentCsrf.persistence.digest),
        });
        const secondAdmin = await createTask4Actor(second, "admin", undefined, {
          sessionDigest: Buffer.from(secondCurrentSession.persistence.digest),
          csrfDigest: Buffer.from(secondCurrentCsrf.persistence.digest),
        });
        expect(firstAdmin.organizationId).not.toBe(secondAdmin.organizationId);

        const firstIds = Array.from({ length: 6 }, () => randomUUID());
        const secondIds = Array.from({ length: 6 }, () => randomUUID());
        const firstEvents: Array<
          Readonly<{ requestId: string; reason: string }>
        > = [];
        const secondEvents: Array<
          Readonly<{ requestId: string; reason: string }>
        > = [];
        const firstRepository = createTask6Repository(
          first,
          keyRing,
          firstIds,
          firstEvents,
        );
        const secondRepository = createTask6Repository(
          second,
          keyRing,
          secondIds,
          secondEvents,
        );
        const marker = randomUUID();
        const email = `identity-race-${marker}@example.test`;
        const issuer = `https://task6-provider.test/identity-race/${marker}`;
        const subject = `subject-${marker}`;
        const firstIssued = await firstRepository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "editor",
          currentSessionToken: firstCurrentSession.wireValue,
          currentCsrfValue: firstCurrentCsrf.wireValue,
        });
        const secondIssued = await secondRepository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "viewer",
          currentSessionToken: secondCurrentSession.wireValue,
          currentCsrfValue: secondCurrentCsrf.wireValue,
        });
        const principal = task6Principal(email, issuer, subject);

        await blocker.query("BEGIN");
        blockerOpen = true;
        await blocker.query(
          "LOCK TABLE dasher.external_identities IN ACCESS EXCLUSIVE MODE",
        );
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);
        const firstAcceptance = retainDatabasePromise(
          retainedOperations,
          firstRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: firstIssued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          firstPid,
          "relation",
          firstAcceptance,
        );
        const secondAcceptance = retainDatabasePromise(
          retainedOperations,
          secondRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: secondIssued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          secondPid,
          "relation",
          secondAcceptance,
        );
        await blocker.query("ROLLBACK");
        blockerOpen = false;

        const [firstSettled, secondSettled] = await Promise.all([
          firstAcceptance,
          secondAcceptance,
        ]);
        expect(firstSettled.status).toBe("fulfilled");
        expect(secondSettled.status).toBe("fulfilled");
        if (
          firstSettled.status !== "fulfilled" ||
          secondSettled.status !== "fulfilled"
        ) {
          throw new Error("Task 6 identity race did not settle successfully");
        }
        const firstResult = firstSettled.value;
        const secondResult = secondSettled.value;
        const winningUserId = firstResult.userId;
        const proposedUsers = [firstIds[2]!, secondIds[2]!];
        const losingUserId = proposedUsers.find(
          (candidate) => candidate !== winningUserId,
        )!;
        expect(proposedUsers).toContain(winningUserId);
        expect(secondResult.userId).toBe(winningUserId);
        expect(firstResult).toMatchObject({
          organizationId: firstAdmin.organizationId,
          membershipId: firstIds[3],
          sessionId: firstIds[4],
          role: "editor",
          authorityRevision: 1,
        });
        expect(secondResult).toMatchObject({
          organizationId: secondAdmin.organizationId,
          membershipId: secondIds[3],
          sessionId: secondIds[4],
          role: "viewer",
          authorityRevision: 1,
        });

        const state = await ownerPool.query<{
          readonly acceptance_audit_count: string;
          readonly accepted_invitation_count: string;
          readonly identity_count: string;
          readonly loser_membership_count: string;
          readonly loser_session_count: string;
          readonly membership_count: string;
          readonly proposed_user_count: string;
          readonly session_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.external_identities
                WHERE issuer = $1 AND subject = $2 AND user_id = $3::uuid
              ) AS identity_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.users
                WHERE user_id = ANY($4::uuid[])
              ) AS proposed_user_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.invitations
                WHERE invitation_id = ANY($5::uuid[])
                  AND accepted_user_id = $3::uuid
              ) AS accepted_invitation_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE membership_id = ANY($6::uuid[])
                  AND user_id = $3::uuid
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($7::uuid[])
                  AND user_id = $3::uuid
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($8::uuid[])
                  AND action = 'invitation.accepted'
              ) AS acceptance_audit_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE user_id = $9::uuid
                  AND membership_id = ANY($6::uuid[])
              ) AS loser_membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE user_id = $9::uuid
                  AND session_id = ANY($7::uuid[])
              ) AS loser_session_count
          `,
          [
            issuer,
            subject,
            winningUserId,
            proposedUsers,
            [firstIds[0], secondIds[0]],
            [firstIds[3], secondIds[3]],
            [firstIds[4], secondIds[4]],
            [firstIds[5], secondIds[5]],
            losingUserId,
          ],
        );
        expect(state.rows[0]).toEqual({
          acceptance_audit_count: "2",
          accepted_invitation_count: "2",
          identity_count: "1",
          loser_membership_count: "0",
          loser_session_count: "0",
          membership_count: "2",
          proposed_user_count: "1",
          session_count: "2",
        });
        expect(firstEvents).toEqual([]);
        expect(secondEvents).toEqual([]);
        expect(JSON.stringify([firstEvents, secondEvents])).not.toContain(
          marker,
        );
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        if (blockerOpen) {
          await blocker.query("ROLLBACK").catch(() => undefined);
        }
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        blocker.release();
        first.release();
        second.release();
      }
    });

    it("rolls back every Task 6 acceptance mutation when the audit insert privilege is revoked", async () => {
      const client = await appPool!.connect();
      const revoker = await ownerPool.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const invitationId = randomUUID();
        const proposedUserId = randomUUID();
        const proposedMembershipId = randomUUID();
        const proposedSessionId = randomUUID();
        const acceptAuditId = randomUUID();
        const repository = createTask6Repository(client, keyRing, [
          invitationId,
          randomUUID(),
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ]);
        const email = `audit-failure-${randomUUID()}@example.test`;
        const issuer = "https://task6-provider.test/audit-failure";
        const subject = randomUUID();
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "viewer",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });

        await revoker.query("BEGIN");
        await revoker.query(`
          REVOKE INSERT (${task4AuditColumnsSql})
          ON dasher.audit_events
          FROM dasher_security_definer
        `);
        await revoker.query("COMMIT");
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: task6Principal(email, issuer, subject),
          }),
        ).rejects.toBeInstanceOf(OperationInternalError);

        const residue = await ownerPool.query<{
          readonly accepted_user_id: string | null;
          readonly audit_count: string;
          readonly identity_count: string;
          readonly membership_count: string;
          readonly session_count: string;
          readonly user_count: string;
        }>(
          `
            SELECT
              invitation.accepted_user_id::text,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.users
                WHERE user_id = $2::uuid
              ) AS user_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.external_identities
                WHERE issuer = $3 AND subject = $4
              ) AS identity_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.memberships
                WHERE membership_id = $5::uuid
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.sessions
                WHERE session_id = $6::uuid
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.audit_events
                WHERE audit_event_id = $7::uuid
              ) AS audit_count
            FROM dasher.invitations AS invitation
            WHERE invitation.invitation_id = $1::uuid
          `,
          [
            invitationId,
            proposedUserId,
            issuer,
            subject,
            proposedMembershipId,
            proposedSessionId,
            acceptAuditId,
          ],
        );
        expect(residue.rows[0]).toEqual({
          accepted_user_id: null,
          audit_count: "0",
          identity_count: "0",
          membership_count: "0",
          session_count: "0",
          user_count: "0",
        });
      } finally {
        await revoker.query("ROLLBACK").catch(() => undefined);
        await revoker.query(`
          GRANT INSERT (${task4AuditColumnsSql})
          ON dasher.audit_events
          TO dasher_security_definer
        `);
        await client.query("RESET ROLE").catch(() => undefined);
        revoker.release();
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
      const client = await appPool!.connect();
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
