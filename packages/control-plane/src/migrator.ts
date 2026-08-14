import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

/**
 * Applies the SQL migration series and records what it applied.
 *
 * Migrations are mutable until the first production deployment: a schema change
 * is made by editing the baseline and recreating the development database. The
 * migrator therefore does not carry a hand-authored manifest of expected
 * checksums or catalog contents. It computes checksums from file bytes and
 * compares them against the journal, so editing an already-applied migration is
 * reported rather than silently ignored — the fix in development is to recreate
 * the database.
 *
 * Schema equality between a reviewed migration and a real database is proven by
 * `test/schema-snapshot.integration.test.ts`, which diffs the committed
 * `schema.snapshot.sql` against a `pg_dump` of a freshly migrated database.
 * That check is generated, so it cannot drift from the migration the way a
 * typed manifest can.
 */

const migrationFilenamePattern =
  /^(?<sequence>[0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$/;
const journalFilenamePattern = "^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$";
const advisorySessionLockSql =
  "SELECT pg_catalog.pg_advisory_lock(724372, 20260730)";
const advisorySessionUnlockSql =
  "SELECT pg_catalog.pg_advisory_unlock(724372, 20260730) AS unlocked";
const migrationFileByteLimit = 16 * 1024 * 1024;
const migrationSeriesByteLimit = 64 * 1024 * 1024;
const roleNamePattern = /^[a-z][a-z0-9_]{0,62}$/;
const managedGroupRoleName = "dasher_app";

export type MigrationClient = Pick<PoolClient, "query" | "release">;

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface DiscoveredMigration {
  readonly sequence: number;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly checksumSha256: Uint8Array;
  readonly sql: string;
}

export interface MigrationRunResult {
  readonly discoveredCount: number;
  readonly previouslyAppliedCount: number;
  readonly appliedCount: number;
}

export type MigrationContractErrorCode =
  | "empty_series"
  | "executor_not_database_owner"
  | "file_too_large"
  | "forced_row_security"
  | "managed_role_overprivileged"
  | "invalid_utf8"
  | "journal_identity_mismatch"
  | "malformed_filename"
  | "migration_file_mismatch"
  | "non_contiguous_sequence"
  | "non_regular_file"
  | "role_name_invalid";

const contractErrorMessages: Readonly<
  Record<MigrationContractErrorCode, string>
> = {
  empty_series: "the migrations directory contains no migration files",
  executor_not_database_owner:
    "migrations must be applied by the database owner",
  file_too_large: "a migration file exceeds the size limit",
  forced_row_security:
    "a table forces row-level security, which disables the SECURITY DEFINER " +
    "write seam unless the schema owner is superuser or BYPASSRLS; drop FORCE " +
    "or grant the owner BYPASSRLS deliberately",
  invalid_utf8: "a migration file is not valid UTF-8",
  managed_role_overprivileged:
    "a managed role holds SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, or " +
    "REPLICATION; " +
    "row-level security confines the application role only while it holds " +
    "none of them, and correcting it needs the elevated credentials that " +
    "granted it",
  journal_identity_mismatch:
    "the journal records more migrations than the directory contains",
  malformed_filename:
    "a file in the migrations directory is not named NNNN_lower_snake.sql",
  migration_file_mismatch:
    "an already-applied migration file has changed since it was applied; " +
    "in development, recreate the database to pick up the edit",
  non_contiguous_sequence: "migration sequence numbers are not contiguous",
  non_regular_file: "the migrations directory contains a non-regular file",
  role_name_invalid: "an expected login role name is not a valid identifier",
};

export class MigrationContractError extends Error {
  readonly code: MigrationContractErrorCode;

  constructor(code: MigrationContractErrorCode) {
    super(
      `PostgreSQL migration contract rejected the operation: ${code} — ${contractErrorMessages[code]}`,
    );
    this.name = "MigrationContractError";
    this.code = code;
  }
}

function reject(code: MigrationContractErrorCode): never {
  throw new MigrationContractError(code);
}

interface JournalRow {
  readonly sequence: number;
  readonly filename: string;
  readonly checksum_sha256: Uint8Array;
}

/**
 * Reads and validates the migration series on disk. Checksums are computed from
 * file bytes; nothing is compared against a stored expectation here.
 */
export async function discoverMigrations(
  directory: string,
): Promise<readonly DiscoveredMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: DiscoveredMigration[] = [];
  let seriesByteLength = 0;

  for (const entry of [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const match = migrationFilenamePattern.exec(entry.name);
    if (match?.groups === undefined) {
      return reject("malformed_filename");
    }
    if (!entry.isFile()) {
      return reject("non_regular_file");
    }

    const sequenceText = match.groups.sequence;
    if (sequenceText === undefined) {
      return reject("malformed_filename");
    }

    const path = resolve(directory, entry.name);
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      return reject("non_regular_file");
    }

    let bytes: Uint8Array;
    try {
      const file = await handle.stat();
      if (!file.isFile()) {
        return reject("non_regular_file");
      }
      if (
        file.size > migrationFileByteLimit ||
        seriesByteLength + file.size > migrationSeriesByteLimit
      ) {
        return reject("file_too_large");
      }
      bytes = await handle.readFile();
      if (bytes.byteLength !== file.size) {
        return reject("migration_file_mismatch");
      }
      seriesByteLength += bytes.byteLength;
    } finally {
      await handle.close();
    }

    let sql: string;
    try {
      sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return reject("invalid_utf8");
    }

    migrations.push({
      sequence: Number.parseInt(sequenceText, 10),
      filename: entry.name,
      bytes,
      checksumSha256: createHash("sha256").update(bytes).digest(),
      sql,
    });
  }

  if (migrations.length === 0) {
    return reject("empty_series");
  }

  for (const [index, migration] of migrations.entries()) {
    if (migration.sequence !== index + 1) {
      return reject("non_contiguous_sequence");
    }
  }

  return migrations;
}

function validateLoginRoleNames(names: readonly string[]): readonly string[] {
  for (const name of names) {
    if (!roleNamePattern.test(name) || name === managedGroupRoleName) {
      return reject("role_name_invalid");
    }
  }
  return [...new Set(names)];
}

/**
 * Creates the restricted application role and any login roles that inherit it.
 *
 * `dasher_app` is NOBYPASSRLS, which is what makes row-level security mean
 * anything: a connection with a missing or wrong request context reads zero
 * rows rather than another organization's rows. It is confined because it is
 * not the table owner, so the policies apply to it in full — which is why
 * dropping FORCE costs it nothing. FORCE only ever bound the owner, and
 * binding the owner is what broke the SECURITY DEFINER seam.
 *
 * This runs as an ordinary role. Creating a role with these attributes,
 * granting membership, and reading `pg_roles` all need nothing beyond
 * CREATEROLE; only *changing* SUPERUSER or BYPASSRLS on an existing role
 * requires holding it, and that is verified rather than enforced below.
 */
export async function bootstrapManagedRoles(
  client: MigrationClient,
  expectedAppLoginRoleNames: readonly string[],
): Promise<void> {
  const loginRoleNames = validateLoginRoleNames(expectedAppLoginRoleNames);

  // Before anything is created or granted. Checking afterwards still refused,
  // but the login roles it had already made and the memberships it had already
  // granted survived the rejection, so a refusal left the cluster changed.
  await assertManagedRolesUnprivileged(client, [
    managedGroupRoleName,
    ...loginRoleNames,
  ]);

  await client.query(`
    DO $bootstrap$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dasher_app'
      ) THEN
        CREATE ROLE dasher_app NOLOGIN NOBYPASSRLS NOINHERIT;
      END IF;
    END
    $bootstrap$;
  `);

  for (const name of loginRoleNames) {
    await client.query(
      `
        DO $bootstrap$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $role$${name}$role$
          ) THEN
            EXECUTE pg_catalog.format(
              'CREATE ROLE %I LOGIN NOBYPASSRLS INHERIT IN ROLE dasher_app',
              $role$${name}$role$
            );
          END IF;
        END
        $bootstrap$;
      `,
    );
    await client.query(`GRANT dasher_app TO "${name}"`);
  }

  // And again afterwards, so a role created by this call is held to the same
  // standard as one that already existed.
  await assertManagedRolesUnprivileged(client, [
    managedGroupRoleName,
    ...loginRoleNames,
  ]);
}

/**
 * Verifies the managed roles hold none of the attributes that would let them
 * ignore row-level security.
 *
 * This used to be `ALTER ROLE ... NOBYPASSRLS NOSUPERUSER`, which corrected a
 * wrong role in place. PostgreSQL only lets a superuser clear SUPERUSER and
 * only a BYPASSRLS role clear BYPASSRLS, so that one statement required the
 * whole deployment to run with privileges it otherwise never needed.
 *
 * Verifying instead is both sufficient and better. The roles are created here
 * with the right attributes, so the only way to reach a wrong one is for
 * somebody to have granted it deliberately with elevated credentials -- and
 * silently reverting that hides a misconfigured environment rather than
 * reporting it. An ordinary deploy role has no business editing role
 * attributes anyway.
 */
async function assertManagedRolesUnprivileged(
  client: MigrationClient,
  roleNames: readonly string[],
): Promise<void> {
  const result = await client.query<{ readonly rolname: string }>(
    `
      SELECT role_row.rolname::text AS rolname
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = ANY ($1::text[])
        AND (
          role_row.rolsuper
          OR role_row.rolbypassrls
          OR role_row.rolcreaterole
          OR role_row.rolcreatedb
          OR role_row.rolreplication
        )
    `,
    [[...roleNames]],
  );
  if (result.rows.length > 0) {
    return reject("managed_role_overprivileged");
  }
}

async function assertDatabaseOwner(client: MigrationClient): Promise<void> {
  const result = await client.query<{ readonly is_owner: boolean }>(`
    SELECT owner.rolname = CURRENT_USER AS is_owner
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
    WHERE database.datname = pg_catalog.current_database()
  `);
  if (result.rows[0]?.is_owner !== true) {
    return reject("executor_not_database_owner");
  }
}

/**
 * Refuses a schema whose tables force row-level security.
 *
 * FORCE subjects the table owner to the policies, and every `dasher_api`
 * function is SECURITY DEFINER, so it subjects the write seam to the policies
 * the seam exists to establish: `begin_request` cannot update the session row
 * it is authenticating, because the policy demands a request context that does
 * not exist until `begin_request` has produced it. The result is that every
 * request is denied, with the same error a wrong token produces.
 *
 * The integration suites now migrate as an ordinary role, so they do observe
 * this: reintroducing FORCE breaks them without any help from this check. The
 * preflight stays because a test only covers the schema in this repository,
 * and this runs against whatever schema a deployment actually has.
 *
 * An owner that is superuser or BYPASSRLS does bypass the policies and could
 * carry FORCE safely. That is not accepted silently: the schema should not
 * require a privileged owner in order to function, so reintroducing FORCE
 * means changing this check on purpose.
 */
async function assertNoForcedRowSecurity(
  client: MigrationClient,
): Promise<void> {
  const result = await client.query<{ readonly relname: string }>(`
    SELECT relation.relname::text AS relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'dasher'
      AND relation.relkind IN ('r', 'p')
      AND relation.relforcerowsecurity
    ORDER BY relation.relname
  `);
  if (result.rows.length > 0) {
    return reject("forced_row_security");
  }
}

async function journalExists(client: MigrationClient): Promise<boolean> {
  const result = await client.query<{ readonly present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'dasher_meta'
        AND relation.relname = 'schema_migrations'
        AND relation.relkind = 'r'
    ) AS present
  `);
  return result.rows[0]?.present === true;
}

async function createJournal(client: MigrationClient): Promise<void> {
  await client.query("CREATE SCHEMA dasher_meta AUTHORIZATION CURRENT_USER");
  await client.query(
    "REVOKE ALL ON SCHEMA dasher_meta FROM PUBLIC, dasher_app",
  );
  await client.query(`
    CREATE TABLE dasher_meta.schema_migrations (
      sequence integer PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9999),
      filename text NOT NULL UNIQUE
        CHECK (filename ~ '${journalFilenamePattern}'),
      checksum_sha256 bytea NOT NULL
        CHECK (octet_length(checksum_sha256) = 32),
      applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
      applied_by name NOT NULL
    )
  `);
  await client.query(
    "REVOKE ALL ON TABLE dasher_meta.schema_migrations FROM PUBLIC, dasher_app",
  );
}

async function readJournal(
  client: MigrationClient,
): Promise<readonly JournalRow[]> {
  const result = await client.query<JournalRow>(`
    SELECT sequence, filename, checksum_sha256
    FROM dasher_meta.schema_migrations
    ORDER BY sequence
  `);
  return result.rows;
}

function digestsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (const [index, byte] of left.entries()) {
    if (byte !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Every already-applied migration must still be byte-identical to the file that
 * produced it. Editing an applied migration is legal in development, but the
 * database must be recreated rather than silently diverging from the file.
 */
function assertJournalMatchesFiles(
  journalRows: readonly JournalRow[],
  migrations: readonly DiscoveredMigration[],
): void {
  if (journalRows.length > migrations.length) {
    return reject("journal_identity_mismatch");
  }
  for (const [index, row] of journalRows.entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      row.sequence !== migration.sequence ||
      row.filename !== migration.filename ||
      !digestsEqual(row.checksum_sha256, migration.checksumSha256)
    ) {
      return reject("migration_file_mismatch");
    }
  }
}

/**
 * Applies every migration the journal has not yet recorded, each in its own
 * transaction, under a session-level advisory lock so two deployers cannot
 * apply concurrently.
 */
export async function runMigrations(
  pool: MigrationPool,
  directory: string,
  expectedAppLoginRoleNames: readonly string[] = [],
): Promise<MigrationRunResult> {
  validateLoginRoleNames(expectedAppLoginRoleNames);
  const migrations = await discoverMigrations(directory);
  const client = await pool.connect();
  let lockHeld = false;

  try {
    await client.query(advisorySessionLockSql);
    lockHeld = true;
    await assertDatabaseOwner(client);

    if (!(await journalExists(client))) {
      await client.query("BEGIN");
      try {
        await createJournal(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const journalRows = await readJournal(client);
    assertJournalMatchesFiles(journalRows, migrations);

    const previouslyAppliedCount = journalRows.length;
    let appliedCount = 0;

    for (const migration of migrations.slice(previouslyAppliedCount)) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        // Inside the transaction, before the journal row. Checking afterwards
        // reported the refusal but left the forced table and its journal entry
        // committed, and a journaled migration is not retried -- so the
        // database was stuck refusing every later run with no way forward.
        await assertNoForcedRowSecurity(client);
        await client.query(
          `
            INSERT INTO dasher_meta.schema_migrations (
              sequence, filename, checksum_sha256, applied_by
            ) VALUES ($1, $2, $3, session_user)
          `,
          [
            migration.sequence,
            migration.filename,
            Buffer.from(migration.checksumSha256),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      appliedCount += 1;
    }

    // Also once for a database that arrived already forced, where there is no
    // migration of ours to roll back and the only correct answer is to refuse.
    await assertNoForcedRowSecurity(client);

    return {
      discoveredCount: migrations.length,
      previouslyAppliedCount,
      appliedCount,
    };
  } finally {
    if (lockHeld) {
      try {
        await client.query(advisorySessionUnlockSql);
      } catch {
        // The connection is being released regardless; a failed unlock here
        // would mask the original error.
      }
    }
    client.release();
  }
}
