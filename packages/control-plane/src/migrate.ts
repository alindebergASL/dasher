import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import {
  assertDatabaseOwner,
  bootstrapManagedRoles,
  runMigrations,
  type MigrationClient,
  type MigrationRunResult,
} from "./migrator";

const migrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/**
 * Prove database ownership before any cluster-wide role work begins.
 *
 * Kept as a named seam so its ordering can be mutation-tested without relying
 * on whether the shared test cluster happened to contain `dasher_app` already.
 */
export async function prepareMigration(
  client: MigrationClient,
  loginRoleNames: readonly string[],
): Promise<void> {
  await assertDatabaseOwner(client);
  await bootstrapManagedRoles(client, loginRoleNames);
}

/**
 * Apply the baseline schema using an explicit owner DSN and explicit login
 * roles. Environment parsing belongs to the CLI wrapper, not this importable
 * function: importing test code must never migrate an ambient database or
 * grant an ambient role.
 */
export async function migrate(
  dsn: string,
  loginRoleNames: readonly string[] = [],
): Promise<MigrationRunResult> {
  const pool = new Pool({ connectionString: dsn, max: 2 });
  try {
    const client = await pool.connect();
    try {
      await prepareMigration(client, loginRoleNames);
    } finally {
      client.release();
    }
    return await runMigrations(pool, migrationDirectory, loginRoleNames);
  } finally {
    await pool.end();
  }
}
