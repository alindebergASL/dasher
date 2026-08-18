import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import {
  assertDatabaseOwner,
  bootstrapManagedRoles,
  runMigrations,
} from "./migrator";

/**
 * Apply the baseline schema to a database.
 *
 * WHY THIS EXISTS NOW. Until the web app could persist, migrations only ever
 * ran from tests, each against a database it created and dropped. The moment a
 * developer wants to run the product against a real database, there has to be
 * one command that puts the schema there — and its absence would mean the first
 * such command was whatever each person improvised.
 *
 * It is deliberately thin. Everything interesting — advisory locking, checksum
 * drift, the role preflight — lives in `runMigrations`, which the migration
 * tests already cover. This is an entry point, not a second implementation.
 *
 * Usage:
 *   DASHER_MIGRATE_DSN=postgresql://owner:...@host/db \
 *     pnpm --filter @dasher/control-plane migrate
 *
 * The DSN must be the schema OWNER, not the application login. That is checked
 * here, before anything is created, using the migrator's own exported
 * assertion — so the refusal carries `MigrationContractError` with
 * `executor_not_database_owner` exactly as it would if `runMigrations` had
 * raised it. Checking it here rather than leaving it to `runMigrations` is not
 * this file deciding who may change a schema; it is refusing early enough that
 * a rejected run leaves no cluster-wide roles behind.
 */

const migrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/**
 * Login roles that should inherit `dasher_app`, comma separated.
 *
 * The migrator grants the group to each and verifies none of them can bypass
 * row security. Naming them here rather than granting by hand is what keeps a
 * new environment from quietly ending up with an application login that has
 * more authority than the one CI tests.
 */
function loginRoleNames(): readonly string[] {
  const raw = process.env["DASHER_APP_LOGIN_ROLES"] ?? "";
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

export async function migrate(dsn: string): Promise<void> {
  const pool = new Pool({ connectionString: dsn, max: 2 });
  try {
    const client = await pool.connect();
    try {
      // Ownership BEFORE roles. `runMigrations` refuses a connection that does
      // not own the database, but it refuses too late to help: roles are
      // cluster-wide, so bootstrapping first left `dasher_app` behind on a
      // rejected run — a failed migration that still changed the cluster.
      //
      // Running migrations first as a "proof" is not the fix either. Tried, and
      // it applied the whole schema before the roles existed; it only appeared
      // to work because a previous run had already created them.
      //
      // `assertDatabaseOwner` is the migrator's own check, exported rather than
      // reimplemented: a local copy threw a generic `Error` where the migrator
      // raises `MigrationContractError` with `executor_not_database_owner`, so
      // the same condition had two contracts depending on which door you came
      // through.
      await assertDatabaseOwner(client);
      await bootstrapManagedRoles(client, loginRoleNames());
    } finally {
      client.release();
    }
    const result = await runMigrations(
      pool,
      migrationDirectory,
      loginRoleNames(),
    );
    process.stdout.write(
      `discovered ${String(result.discoveredCount)}, ` +
        `already applied ${String(result.previouslyAppliedCount)}, ` +
        `applied ${String(result.appliedCount)}\n`,
    );
  } finally {
    await pool.end();
  }
}

const dsn = process.env["DASHER_MIGRATE_DSN"];
if (dsn !== undefined && dsn.trim() !== "") {
  await migrate(dsn);
} else {
  process.stdout.write(
    "\nDASHER_MIGRATE_DSN is not set.\n" +
      "  Set it to the schema owner's connection string and re-run.\n\n",
  );
  process.exitCode = 2;
}
