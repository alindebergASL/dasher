import { Pool } from "pg";

import { parseProvisionArgs, provisionPrincipal } from "./provision-cli";

/**
 * The executable wrapper. Importable behaviour lives in `provision-cli.ts`,
 * where importing it has no process-global or database effect — the same
 * separation `migrate-cli.ts` keeps.
 */
const dsn = process.env["DASHER_MIGRATE_DSN"];
if (dsn === undefined || dsn.trim() === "") {
  process.stdout.write(
    "\nDASHER_MIGRATE_DSN is not set.\n" +
      "  Provisioning writes organizations, users, memberships and identities,\n" +
      "  which the application role cannot. Set the SCHEMA OWNER's connection\n" +
      "  string and re-run.\n\n",
  );
  process.exitCode = 2;
} else {
  const options = parseProvisionArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: dsn, max: 1 });
  try {
    const provisioned = await provisionPrincipal(pool, options);
    process.stdout.write(
      `organization ${provisioned.organizationId}` +
        `${provisioned.createdOrganization ? "" : " (existing)"}\n` +
        `user ${provisioned.userId}` +
        `${provisioned.reusedExistingUser ? " (existing identity reused)" : ""}\n` +
        `${provisioned.normalizedEmail} can now request a sign-in link\n`,
    );
  } finally {
    await pool.end();
  }
}
