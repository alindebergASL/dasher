import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

import {
  type MigrationClient,
  type MigrationContractError,
  type MigrationPool,
} from "../src/index.js";

export const fixtureMigrationDirectory = fileURLToPath(
  new URL("./fixtures/migrations", import.meta.url),
);

export const baselineMigrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export const checksumDriftMigrationDirectory = fileURLToPath(
  new URL("./fixtures/migrations-checksum-drift", import.meta.url),
);

export async function executeServerFormattedSql(
  client: PoolClient,
  formatTemplate: string,
  parameters: readonly string[],
): Promise<void> {
  const placeholders = parameters
    .map((_, index) => `$${index + 2}::text`)
    .join(", ");
  const result = await client.query<{ readonly sql: string }>(
    `SELECT pg_catalog.format($1::text, ${placeholders}) AS sql`,
    [formatTemplate, ...parameters],
  );
  const sql = result.rows[0]?.sql;

  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error("PostgreSQL did not produce the required quoted SQL");
  }

  await client.query(sql);
}

export async function createTemporaryAppLogin(
  ownerPool: Pool,
  appDsn: string,
  appUsername: string,
): Promise<void> {
  if (!/^dasher_test_[0-9a-f]{32}$/u.test(appUsername)) {
    throw new Error(
      "temporary PostgreSQL login identifier was not preflighted",
    );
  }

  const password = decodeURIComponent(new URL(appDsn).password);
  const client = await ownerPool.connect();

  try {
    await client.query("BEGIN");
    try {
      const credentialStatement = await client.query<{ readonly sql: string }>(
        `
          SELECT pg_catalog.format(
            'CREATE ROLE %s WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %s'::text,
            pg_catalog.format('%I'::text, $1::text),
            pg_catalog.format('%L'::text, $2::text)
          ) AS sql
        `,
        [appUsername, password],
      );
      const sql = credentialStatement.rows[0]?.sql;
      if (typeof sql !== "string" || sql.length === 0) {
        throw new Error(
          "PostgreSQL did not produce the quoted temporary login SQL",
        );
      }
      await client.query(sql);
      const databaseIdentity = await client.query<{
        readonly database_name: string;
        readonly database_oid: string;
      }>(`
        SELECT
          database_row.datname::text AS database_name,
          database_row.oid::text AS database_oid
        FROM pg_catalog.pg_database AS database_row
        WHERE database_row.datname = pg_catalog.current_database()
      `);
      const databaseRow = databaseIdentity.rows[0];
      if (
        databaseIdentity.rows.length !== 1 ||
        databaseRow === undefined ||
        databaseRow.database_name !== new URL(appDsn).pathname.slice(1)
      ) {
        throw new Error(
          "temporary PostgreSQL login database identity did not match preflight",
        );
      }
      await executeServerFormattedSql(client, "COMMENT ON ROLE %I IS %L", [
        appUsername,
        `dasher:app-login:v1:database-oid:${databaseRow.database_oid}`,
      ]);
      await executeServerFormattedSql(
        client,
        "GRANT dasher_app TO %I WITH INHERIT TRUE, SET TRUE, ADMIN FALSE",
        [appUsername],
      );
      await executeServerFormattedSql(
        client,
        "GRANT CONNECT ON DATABASE %I TO %I",
        [new URL(appDsn).pathname.slice(1), appUsername],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

export function borrowedClientPool(
  client: PoolClient,
  rejectJournalInsert = false,
): MigrationPool {
  const query = (async (text: string, values?: unknown[]) => {
    if (
      rejectJournalInsert &&
      text.includes("INSERT INTO dasher_meta.schema_migrations")
    ) {
      throw new Error("synthetic fixed journal insert failure");
    }

    return client.query(text, values);
  }) as MigrationClient["query"];

  return {
    async connect() {
      return {
        query,
        release() {
          // The caller owns the borrowed client and releases it in finally.
        },
      };
    },
  };
}

export async function expectMigrationRejection(
  operation: Promise<unknown>,
  expectedCode: MigrationContractError["code"],
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === expectedCode
    ) {
      return;
    }
    throw error;
  }

  throw new Error(`expected migration rejection: ${expectedCode}`);
}

/**
 * Creates the temporary run-operator login the Task 9D takeover suite drives
 * `dasher_run_api.claim_agent_run` through.
 *
 * `dasher_private.initialize_run_operator_context_v1` refuses any session whose
 * login is a superuser, inherits, or lacks the
 * `dasher:run-login:v1:database-oid:<oid>` marker, so the suite cannot reach
 * the run API over the owner connection at all. The shape below is the same one
 * `createTemporaryRetentionLogin` uses, with the run marker and the
 * `dasher_run_operator` membership the migrator's expected-login allowlist
 * already models.
 */

/**
 * Provisions the deployment this repository actually targets: a schema owner
 * that is an ordinary role.
 *
 * The integration suites connect as the superuser the test database was
 * created with, and a superuser bypasses row-level security whatever the
 * catalog says. That made a whole class of deployment failure invisible —
 * forcing row security disabled the entire SECURITY DEFINER seam against an
 * ordinary owner while every test stayed green.
 *
 * The split mirrors the real thing. The credential in
 * `DASHER_TEST_OWNER_DSN` is the *operator*: it creates roles and databases
 * once, with privileges an application deploy has no business holding.
 * Everything after that — migrating, seeding, and every query the suite makes
 * as the owner — runs as the ordinary role this returns.
 */
export async function createUnprivilegedSchemaOwner(
  operatorPool: Pool,
  operatorDsn: string,
  roleName: string,
  databaseName: string,
): Promise<string> {
  if (!/^dasher_test_owner_[0-9a-f]{32}$/u.test(roleName)) {
    throw new Error("schema owner identifier was not preflighted");
  }
  if (!/^dasher_test_db_[0-9a-f]{32}$/u.test(databaseName)) {
    throw new Error("schema owner database identifier was not preflighted");
  }

  const password = decodeURIComponent(new URL(operatorDsn).password);
  const client = await operatorPool.connect();
  try {
    // CREATEROLE so it can create the application roles; CREATEDB so nothing
    // needs the operator again. Deliberately NOSUPERUSER and NOBYPASSRLS:
    // those two are the point of the exercise.
    await executeServerFormattedSql(
      client,
      "CREATE ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOREPLICATION CREATEDB CREATEROLE PASSWORD %L",
      [roleName, password],
    );
    await executeServerFormattedSql(client, "CREATE DATABASE %I OWNER %I", [
      databaseName,
      roleName,
    ]);

    // `dasher_app` is cluster-wide, so in a shared cluster it usually already
    // exists and was created by somebody else. PostgreSQL 16 lets a CREATEROLE
    // role grant only memberships it administers, and creating a role is what
    // confers that — so an owner handed a pre-existing `dasher_app` cannot
    // grant it to the login roles it creates. Passing admin across is part of
    // provisioning, not something the deploy can do for itself. On a fresh
    // cluster the owner creates `dasher_app` itself and this is unnecessary.
    const existing = await client.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dasher_app') AS present",
    );
    if (existing.rows[0]?.present === true) {
      await executeServerFormattedSql(
        client,
        "GRANT dasher_app TO %I WITH ADMIN OPTION",
        [roleName],
      );
    }
  } finally {
    client.release();
  }

  const url = new URL(operatorDsn);
  url.username = roleName;
  url.password = encodeURIComponent(password);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function dropUnprivilegedSchemaOwner(
  operatorPool: Pool,
  roleName: string,
  databaseName: string,
  dependentRoleNames: readonly string[] = [],
): Promise<void> {
  const client = await operatorPool.connect();
  try {
    await executeServerFormattedSql(
      client,
      "DROP DATABASE IF EXISTS %I WITH (FORCE)",
      [databaseName],
    );
    // Roles the owner created hold grants recorded against it as grantor, and
    // PostgreSQL refuses to drop a role anything still depends on. They go
    // first, then whatever else the owner granted.
    for (const dependent of dependentRoleNames) {
      await executeServerFormattedSql(client, "DROP ROLE IF EXISTS %I", [
        dependent,
      ]);
    }
    await executeServerFormattedSql(client, "DROP OWNED BY %I CASCADE", [
      roleName,
    ]);
    await executeServerFormattedSql(client, "DROP ROLE IF EXISTS %I", [
      roleName,
    ]);
  } finally {
    client.release();
  }
}
