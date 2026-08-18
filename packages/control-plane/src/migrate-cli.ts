import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { bootstrapManagedRoles, runMigrations } from "./migrator";

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
 * The DSN must be the schema OWNER, not the application login. Running this as
 * the application role fails in the migrator's own preflight rather than here,
 * which is the right place for it: this file does not get to decide who may
 * change a schema.
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
      // to work because a previous run had already created them. This asks the
      // catalog the question directly, and creates nothing to ask it.
      await assertOwnsDatabase(client);
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

/**
 * Refuse a connection that does not own the database it is pointed at.
 *
 * Side-effect free on purpose: it runs before anything is created, so a
 * rejected run leaves the cluster exactly as it found it.
 */
async function assertOwnsDatabase(client: {
  query: (
    sql: string,
  ) => Promise<{ rows: Array<{ owns: boolean; owner: string }> }>;
}): Promise<void> {
  const result = await client.query(
    `SELECT pg_catalog.pg_get_userbyid(datdba) = current_user AS owns,
            pg_catalog.pg_get_userbyid(datdba) AS owner
       FROM pg_catalog.pg_database
      WHERE datname = current_database()`,
  );
  const row = result.rows[0];
  if (row === undefined || !row.owns) {
    process.stdout.write(
      "\nDASHER_MIGRATE_DSN does not own this database.\n" +
        `  It is owned by ${row?.owner ?? "an unknown role"}.\n` +
        "  Migrations must run as the schema owner; nothing was changed.\n\n",
    );
    process.exitCode = 2;
    throw new Error("migrate: connection does not own the database");
  }
}
