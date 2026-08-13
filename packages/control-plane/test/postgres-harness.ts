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

export const canonicalMigrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export const checksumDriftMigrationDirectory = fileURLToPath(
  new URL("./fixtures/migrations-checksum-drift", import.meta.url),
);

export const renamedMigrationDirectory = fileURLToPath(
  new URL("./fixtures/migrations-renamed", import.meta.url),
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
            'CREATE ROLE %s WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %s'::text,
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
        "GRANT dasher_app TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE",
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

export async function dropTemporaryAppLogin(
  ownerPool: Pool,
  databaseName: string,
  appUsername: string,
): Promise<void> {
  const client = await ownerPool.connect();

  try {
    await client.query(
      `
        SELECT pg_catalog.pg_terminate_backend(activity.pid)
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.usename = $1
          AND activity.pid <> pg_catalog.pg_backend_pid()
      `,
      [appUsername],
    );
    await executeServerFormattedSql(client, "REVOKE dasher_app FROM %I", [
      appUsername,
    ]);
    await executeServerFormattedSql(
      client,
      "REVOKE CONNECT ON DATABASE %I FROM %I",
      [databaseName, appUsername],
    );
    await executeServerFormattedSql(client, "DROP ROLE %I", [appUsername]);
  } finally {
    client.release();
  }
}

export async function createTemporaryRetentionLogin(
  ownerPool: Pool,
  retentionDsn: string,
  retentionUsername: string,
): Promise<void> {
  if (!/^dasher_test_task8d_[a-z0-9_]+$/u.test(retentionUsername)) {
    throw new Error("temporary retention login identifier was not preflighted");
  }

  const parsedDsn = new URL(retentionDsn);
  const password = decodeURIComponent(parsedDsn.password);
  const databaseName = parsedDsn.pathname.slice(1);
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    try {
      const statement = await client.query<{ readonly sql: string }>(
        `
          SELECT pg_catalog.format(
            'CREATE ROLE %s WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %s'::text,
            pg_catalog.format('%I'::text, $1::text),
            pg_catalog.format('%L'::text, $2::text)
          ) AS sql
        `,
        [retentionUsername, password],
      );
      const sql = statement.rows[0]?.sql;
      if (typeof sql !== "string" || sql.length === 0) {
        throw new Error("PostgreSQL did not quote the retention login SQL");
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
        databaseRow.database_name !== databaseName
      ) {
        throw new Error(
          "temporary retention login database identity did not match preflight",
        );
      }
      await executeServerFormattedSql(client, "COMMENT ON ROLE %I IS %L", [
        retentionUsername,
        `dasher:retention-login:v1:database-oid:${databaseRow.database_oid}`,
      ]);
      await executeServerFormattedSql(
        client,
        "GRANT dasher_retention_operator TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE",
        [retentionUsername],
      );
      await executeServerFormattedSql(
        client,
        "GRANT CONNECT ON DATABASE %I TO %I",
        [databaseName, retentionUsername],
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

export async function dropTemporaryRetentionLogin(
  ownerPool: Pool,
  databaseName: string,
  retentionUsername: string,
): Promise<void> {
  if (!/^dasher_test_task8d_[a-z0-9_]+$/u.test(retentionUsername)) {
    throw new Error("temporary retention login identifier was not preflighted");
  }

  const client = await ownerPool.connect();
  try {
    await client.query(
      `
        SELECT pg_catalog.pg_terminate_backend(activity.pid)
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.usename = $1
          AND activity.pid <> pg_catalog.pg_backend_pid()
      `,
      [retentionUsername],
    );
    await executeServerFormattedSql(
      client,
      "REVOKE dasher_retention_operator FROM %I",
      [retentionUsername],
    );
    await executeServerFormattedSql(
      client,
      "REVOKE CONNECT ON DATABASE %I FROM %I",
      [databaseName, retentionUsername],
    );
    await executeServerFormattedSql(client, "DROP ROLE %I", [
      retentionUsername,
    ]);
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
export async function createTemporaryRunLogin(
  ownerPool: Pool,
  databaseName: string,
  runUsername: string,
  password: string,
): Promise<void> {
  if (!/^dasher_test_task9d_[a-z0-9_]+$/u.test(runUsername)) {
    throw new Error("temporary run login identifier was not preflighted");
  }

  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    try {
      const statement = await client.query<{ readonly sql: string }>(
        `
          SELECT pg_catalog.format(
            'CREATE ROLE %s WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %s'::text,
            pg_catalog.format('%I'::text, $1::text),
            pg_catalog.format('%L'::text, $2::text)
          ) AS sql
        `,
        [runUsername, password],
      );
      const sql = statement.rows[0]?.sql;
      if (typeof sql !== "string" || sql.length === 0) {
        throw new Error("PostgreSQL did not quote the run login SQL");
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
        databaseRow.database_name !== databaseName
      ) {
        throw new Error(
          "temporary run login database identity did not match preflight",
        );
      }
      await executeServerFormattedSql(client, "COMMENT ON ROLE %I IS %L", [
        runUsername,
        `dasher:run-login:v1:database-oid:${databaseRow.database_oid}`,
      ]);
      await executeServerFormattedSql(
        client,
        "GRANT dasher_run_operator TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE",
        [runUsername],
      );
      await executeServerFormattedSql(
        client,
        "GRANT CONNECT ON DATABASE %I TO %I",
        [databaseName, runUsername],
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

/**
 * Drops the temporary run login and every trace of it the migrator's
 * managed-role drift check would otherwise see.
 */
export async function dropTemporaryRunLogin(
  ownerPool: Pool,
  databaseName: string,
  runUsername: string,
): Promise<void> {
  if (!/^dasher_test_task9d_[a-z0-9_]+$/u.test(runUsername)) {
    throw new Error("temporary run login identifier was not preflighted");
  }

  const client = await ownerPool.connect();
  try {
    const present = await client.query<{ readonly exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists",
      [runUsername],
    );
    if (present.rows[0]?.exists !== true) {
      return;
    }
    await client.query(
      `
        SELECT pg_catalog.pg_terminate_backend(activity.pid)
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.usename = $1
          AND activity.pid <> pg_catalog.pg_backend_pid()
      `,
      [runUsername],
    );
    await executeServerFormattedSql(
      client,
      "REVOKE CONNECT ON DATABASE %I FROM %I",
      [databaseName, runUsername],
    );
    await client.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dasher_run_operator'
         ) THEN
           EXECUTE pg_catalog.format(
             'REVOKE dasher_run_operator FROM %I', $1
           );
         END IF;
       END
       $$`.replace("$1", `'${runUsername}'`),
    );
    await executeServerFormattedSql(client, "DROP ROLE %I", [runUsername]);
  } finally {
    client.release();
  }
}
