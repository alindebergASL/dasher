import { migrate } from "./migrate";

/**
 * Apply the baseline schema to a database.
 *
 * Usage:
 *   DASHER_MIGRATE_DSN=postgresql://owner:***@host/db \
 *     pnpm --filter @dasher/control-plane migrate
 *
 * The DSN must be the schema owner. `migrate()` checks ownership before any
 * role or schema mutation and preserves the migrator's typed refusal contract.
 * This file is only the executable wrapper; importable behavior lives in
 * `migrate.ts`, where importing it has no process-global or database effect.
 */

function loginRoleNames(): readonly string[] {
  const raw = process.env["DASHER_APP_LOGIN_ROLES"] ?? "";
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

const dsn = process.env["DASHER_MIGRATE_DSN"];
if (dsn !== undefined && dsn.trim() !== "") {
  const result = await migrate(dsn, loginRoleNames());
  process.stdout.write(
    `discovered ${String(result.discoveredCount)}, ` +
      `already applied ${String(result.previouslyAppliedCount)}, ` +
      `applied ${String(result.appliedCount)}\n`,
  );
} else {
  process.stdout.write(
    "\nDASHER_MIGRATE_DSN is not set.\n" +
      "  Set it to the schema owner's connection string and re-run.\n\n",
  );
  process.exitCode = 2;
}
