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
      await executeServerFormattedSql(client, "COMMENT ON ROLE %I IS %L", [
        appUsername,
        "dasher:synthetic-task2-login",
      ]);
      await executeServerFormattedSql(client, "GRANT dasher_app TO %I", [
        appUsername,
      ]);
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
