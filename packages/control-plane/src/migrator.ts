import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

const migrationFilenamePattern =
  /^(?<sequence>[0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$/;
const journalFilenamePattern = "^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$";
const advisoryLockSql =
  "SELECT pg_catalog.pg_advisory_xact_lock(724372, 20260730)";

const managedRoles = [
  {
    name: "dasher_app",
    comment: "dasher:managed-role:v1:app",
    bypassRls: false,
    createSql:
      "CREATE ROLE dasher_app WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL",
    commentSql: "COMMENT ON ROLE dasher_app IS 'dasher:managed-role:v1:app'",
  },
  {
    name: "dasher_security_definer",
    comment: "dasher:managed-role:v1:security-definer",
    bypassRls: true,
    createSql:
      "CREATE ROLE dasher_security_definer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD NULL",
    commentSql:
      "COMMENT ON ROLE dasher_security_definer IS 'dasher:managed-role:v1:security-definer'",
  },
] as const;

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
  | "adoption_conflict"
  | "empty_series"
  | "executor_not_database_owner"
  | "executor_role_invalid"
  | "executor_set_role"
  | "invalid_utf8"
  | "journal_identity_mismatch"
  | "journal_shape_invalid"
  | "malformed_filename"
  | "managed_role_drift"
  | "non_contiguous_sequence"
  | "non_regular_file";

export class MigrationContractError extends Error {
  readonly code: MigrationContractErrorCode;

  constructor(code: MigrationContractErrorCode) {
    super(`PostgreSQL migration contract rejected the operation: ${code}`);
    this.name = "MigrationContractError";
    this.code = code;
  }
}

interface ExecutorRow {
  readonly current_name: string;
  readonly database_owner_name: string;
  readonly is_database_owner: boolean;
  readonly is_managed_role: boolean;
  readonly is_member_of_app: boolean;
  readonly is_superuser: boolean;
  readonly session_name: string;
}

interface ManagedRoleRow {
  readonly bypass_rls: boolean;
  readonly can_login: boolean;
  readonly comment: string | null;
  readonly has_cluster_dependency: boolean;
  readonly has_membership: boolean;
  readonly has_settings: boolean;
  readonly inherit_privileges: boolean;
  readonly password_is_null: boolean;
  readonly connection_limit: number;
  readonly valid_until_is_null: boolean;
  readonly role_count: string;
  readonly superuser: boolean;
  readonly can_create_database: boolean;
  readonly can_create_role: boolean;
  readonly replication: boolean;
}

interface JournalRelationRow {
  readonly relforcerowsecurity: boolean;
  readonly relkind: string;
  readonly reloptions: string[] | null;
  readonly relpersistence: string;
  readonly relrowsecurity: boolean;
  readonly schema_owner: string;
  readonly table_owner: string;
}

interface JournalColumnRow {
  readonly attgenerated: string;
  readonly attidentity: string;
  readonly attname: string;
  readonly attnotnull: boolean;
  readonly default_expression: string | null;
  readonly formatted_type: string;
}

interface JournalConstraintRow {
  readonly column_numbers: number[];
  readonly constraint_definition: string;
  readonly constraint_name: string;
  readonly constraint_type: string;
}

interface AclRow {
  readonly grantee_name: string;
  readonly is_grantable: boolean;
  readonly privilege_type: string;
}

interface JournalRow {
  readonly applied_by: string;
  readonly checksum_sha256: Uint8Array;
  readonly filename: string;
  readonly sequence: number;
}

function reject(code: MigrationContractErrorCode): never {
  throw new MigrationContractError(code);
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

async function rollbackQuietly(client: MigrationClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure. Releasing the client lets pg discard a
    // connection that cannot be recovered.
  }
}

async function assertExecutor(client: MigrationClient): Promise<string> {
  const result = await client.query<ExecutorRow>(`
    WITH RECURSIVE inherited_roles(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS login_role
        ON login_role.oid = membership.member
      WHERE login_role.rolname = session_user
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN inherited_roles
        ON inherited_roles.role_oid = membership.member
    )
    SELECT
      session_user::text AS session_name,
      current_user::text AS current_name,
      database_owner.rolname::text AS database_owner_name,
      database_owner.oid = executor.oid AS is_database_owner,
      executor.rolsuper AS is_superuser,
      executor.rolname IN ('dasher_app', 'dasher_security_definer')
        AS is_managed_role,
      EXISTS (
        SELECT 1
        FROM inherited_roles
        JOIN pg_catalog.pg_roles AS inherited
          ON inherited.oid = inherited_roles.role_oid
        WHERE inherited.rolname = 'dasher_app'
      ) AS is_member_of_app
    FROM pg_catalog.pg_database AS target_database
    JOIN pg_catalog.pg_roles AS database_owner
      ON database_owner.oid = target_database.datdba
    JOIN pg_catalog.pg_roles AS executor
      ON executor.rolname = session_user
    WHERE target_database.datname = current_database()
  `);
  const row = result.rows[0];

  if (row === undefined) {
    return reject("executor_role_invalid");
  }
  if (row.session_name !== row.current_name) {
    return reject("executor_set_role");
  }
  if (
    row.is_managed_role ||
    row.is_member_of_app ||
    row.session_name === "dasher_app" ||
    row.session_name === "dasher_security_definer"
  ) {
    return reject("executor_role_invalid");
  }
  if (
    !row.is_database_owner ||
    row.database_owner_name !== row.session_name ||
    !row.is_superuser
  ) {
    return reject("executor_not_database_owner");
  }

  return row.session_name;
}

async function readManagedRole(
  client: MigrationClient,
  roleName: string,
): Promise<ManagedRoleRow | undefined> {
  const result = await client.query<ManagedRoleRow>(
    `
      SELECT
        '1'::text AS role_count,
        role.rolcanlogin AS can_login,
        role.rolinherit AS inherit_privileges,
        role.rolsuper AS superuser,
        role.rolcreatedb AS can_create_database,
        role.rolcreaterole AS can_create_role,
        role.rolreplication AS replication,
        role.rolbypassrls AS bypass_rls,
        role.rolpassword IS NULL AS password_is_null,
        role.rolconnlimit AS connection_limit,
        role.rolvaliduntil IS NULL AS valid_until_is_null,
        pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = role.oid
             OR membership.member = role.oid
        ) AS has_membership,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
            AND dependency.refobjid = role.oid
            AND dependency.deptype IN ('a', 'o')
        ) AS has_cluster_dependency,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_db_role_setting AS setting
          WHERE setting.setrole = role.oid
        ) AS has_settings
      FROM pg_catalog.pg_authid AS role
      WHERE role.rolname = $1
    `,
    [roleName],
  );
  return result.rows[0];
}

function roleMatches(
  row: ManagedRoleRow,
  expected: (typeof managedRoles)[number],
): boolean {
  return (
    row.role_count === "1" &&
    !row.can_login &&
    !row.inherit_privileges &&
    !row.superuser &&
    !row.can_create_database &&
    !row.can_create_role &&
    !row.replication &&
    row.bypass_rls === expected.bypassRls &&
    row.password_is_null &&
    row.connection_limit === -1 &&
    row.valid_until_is_null &&
    row.comment === expected.comment &&
    !row.has_membership &&
    !row.has_cluster_dependency &&
    !row.has_settings
  );
}

async function createOrVerifyManagedRole(
  client: MigrationClient,
  expected: (typeof managedRoles)[number],
): Promise<void> {
  const before = await readManagedRole(client, expected.name);

  if (before === undefined) {
    await client.query(expected.createSql);
    await client.query(expected.commentSql);
  } else if (!roleMatches(before, expected)) {
    return reject("managed_role_drift");
  }

  const after = await readManagedRole(client, expected.name);
  if (after === undefined || !roleMatches(after, expected)) {
    return reject("managed_role_drift");
  }
}

export async function bootstrapManagedRoles(
  client: MigrationClient,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await assertExecutor(client);
    await client.query(advisoryLockSql);

    for (const managedRole of managedRoles) {
      await createOrVerifyManagedRole(client, managedRole);
    }

    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

export async function discoverMigrations(
  directory: string,
): Promise<readonly DiscoveredMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: DiscoveredMigration[] = [];

  for (const entry of entries.sort((left, right) =>
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

    const bytes = await readFile(resolve(directory, entry.name));
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

async function journalExists(client: MigrationClient): Promise<boolean> {
  const result = await client.query<{ readonly journal_oid: string | null }>(
    `
      SELECT
        pg_catalog.to_regclass('dasher_meta.schema_migrations')::text
          AS journal_oid
    `,
  );

  return typeof result.rows[0]?.journal_oid === "string";
}

async function assertNoAdoptionConflict(
  client: MigrationClient,
): Promise<void> {
  const result = await client.query<{
    readonly has_managed_namespace: boolean;
  }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace
        WHERE nspname IN ('dasher', 'dasher_meta')
      ) AS has_managed_namespace
    `,
  );

  if (result.rows[0]?.has_managed_namespace !== false) {
    return reject("adoption_conflict");
  }
}

async function createJournal(client: MigrationClient): Promise<void> {
  await client.query("CREATE SCHEMA dasher_meta AUTHORIZATION CURRENT_USER");
  await client.query(
    "REVOKE ALL ON SCHEMA dasher_meta FROM PUBLIC, dasher_app, dasher_security_definer",
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
    "REVOKE ALL ON TABLE dasher_meta.schema_migrations FROM PUBLIC, dasher_app, dasher_security_definer",
  );
}

async function assertJournalRelation(
  client: MigrationClient,
  ownerName: string,
): Promise<void> {
  const result = await client.query<JournalRelationRow>(`
    SELECT
      schema_owner.rolname::text AS schema_owner,
      table_owner.rolname::text AS table_owner,
      relation.relkind,
      relation.relpersistence,
      relation.relrowsecurity,
      relation.relforcerowsecurity,
      relation.reloptions
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS schema_owner
      ON schema_owner.oid = namespace.nspowner
    JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = 'schema_migrations'
    JOIN pg_catalog.pg_roles AS table_owner
      ON table_owner.oid = relation.relowner
    WHERE namespace.nspname = 'dasher_meta'
  `);
  const row = result.rows[0];

  if (
    result.rows.length !== 1 ||
    row === undefined ||
    row.schema_owner !== ownerName ||
    row.table_owner !== ownerName ||
    row.relkind !== "r" ||
    row.relpersistence !== "p" ||
    row.relrowsecurity ||
    row.relforcerowsecurity ||
    (row.reloptions !== null && row.reloptions.length > 0)
  ) {
    return reject("journal_shape_invalid");
  }
}

async function assertJournalColumns(client: MigrationClient): Promise<void> {
  const result = await client.query<JournalColumnRow>(`
    SELECT
      attribute.attname,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
        AS formatted_type,
      attribute.attnotnull,
      attribute.attidentity,
      attribute.attgenerated,
      pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
        AS default_expression
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'dasher_meta.schema_migrations'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `);
  const actual = result.rows.map((row) => ({
    name: row.attname,
    type: row.formatted_type,
    notNull: row.attnotnull,
    identity: row.attidentity,
    generated: row.attgenerated,
    defaultExpression: row.default_expression,
  }));

  const expected = [
    {
      name: "sequence",
      type: "integer",
      notNull: true,
      identity: "",
      generated: "",
      defaultExpression: null,
    },
    {
      name: "filename",
      type: "text",
      notNull: true,
      identity: "",
      generated: "",
      defaultExpression: null,
    },
    {
      name: "checksum_sha256",
      type: "bytea",
      notNull: true,
      identity: "",
      generated: "",
      defaultExpression: null,
    },
    {
      name: "applied_at",
      type: "timestamp with time zone",
      notNull: true,
      identity: "",
      generated: "",
      defaultExpression: "statement_timestamp()",
    },
    {
      name: "applied_by",
      type: "name",
      notNull: true,
      identity: "",
      generated: "",
      defaultExpression: null,
    },
  ];

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return reject("journal_shape_invalid");
  }
}

async function assertJournalConstraints(
  client: MigrationClient,
): Promise<void> {
  const result = await client.query<JournalConstraintRow>(`
    SELECT
      journal_constraint.conname AS constraint_name,
      journal_constraint.contype AS constraint_type,
      journal_constraint.conkey::integer[] AS column_numbers,
      pg_catalog.pg_get_constraintdef(journal_constraint.oid, false)
        AS constraint_definition
    FROM pg_catalog.pg_constraint AS journal_constraint
    WHERE journal_constraint.conrelid =
      'dasher_meta.schema_migrations'::regclass
    ORDER BY journal_constraint.conname
  `);

  if (result.rows.length !== 5) {
    return reject("journal_shape_invalid");
  }

  const constraints = new Map(
    result.rows.map((row) => [row.constraint_name, row]),
  );
  const primary = constraints.get("schema_migrations_pkey");
  const filenameUnique = constraints.get("schema_migrations_filename_key");
  const sequenceCheck = constraints.get("schema_migrations_sequence_check");
  const filenameCheck = constraints.get("schema_migrations_filename_check");
  const checksumCheck = constraints.get(
    "schema_migrations_checksum_sha256_check",
  );

  if (
    primary?.constraint_type !== "p" ||
    !arraysEqual(primary.column_numbers, [1]) ||
    filenameUnique?.constraint_type !== "u" ||
    !arraysEqual(filenameUnique.column_numbers, [2]) ||
    sequenceCheck?.constraint_type !== "c" ||
    filenameCheck?.constraint_type !== "c" ||
    checksumCheck?.constraint_type !== "c"
  ) {
    return reject("journal_shape_invalid");
  }

  const sequenceDefinition = sequenceCheck.constraint_definition.replaceAll(
    /\s/gu,
    "",
  );
  const filenameDefinition = filenameCheck.constraint_definition.replaceAll(
    /\s/gu,
    "",
  );
  const checksumDefinition = checksumCheck.constraint_definition.replaceAll(
    /\s/gu,
    "",
  );

  if (
    sequenceDefinition !== "CHECK(((sequence>=1)AND(sequence<=9999)))" ||
    filenameDefinition !==
      `CHECK((filename~'${journalFilenamePattern}'::text))` ||
    checksumDefinition !== "CHECK((octet_length(checksum_sha256)=32))"
  ) {
    return reject("journal_shape_invalid");
  }
}

async function readAcl(
  client: MigrationClient,
  kind: "schema" | "table",
): Promise<readonly AclRow[]> {
  if (kind === "schema") {
    const result = await client.query<AclRow>(`
      SELECT
        coalesce(grantee.rolname::text, 'PUBLIC') AS grantee_name,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = 'dasher_meta'
      ORDER BY grantee_name, privilege_type
    `);
    return result.rows;
  }

  const result = await client.query<AclRow>(`
    SELECT
      coalesce(grantee.rolname::text, 'PUBLIC') AS grantee_name,
      privilege.privilege_type,
      privilege.is_grantable
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE relation.oid = 'dasher_meta.schema_migrations'::regclass
    ORDER BY grantee_name, privilege_type
  `);
  return result.rows;
}

async function assertJournalAclAndObjects(
  client: MigrationClient,
  ownerName: string,
): Promise<void> {
  // `pg` does not support concurrent queries on one client. Keep these catalog
  // reads serial so the verifier remains compatible with pg 9 and never races
  // transaction state on a pooled connection.
  const schemaAcl = await readAcl(client, "schema");
  const tableAcl = await readAcl(client, "table");
  const objects = await client.query<{
    readonly relkind: string;
    readonly relname: string;
  }>(`
    SELECT relname, relkind
    FROM pg_catalog.pg_class
    WHERE relnamespace = 'dasher_meta'::regnamespace
    ORDER BY relname
  `);
  const columnAcl = await client.query<{ readonly count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'dasher_meta.schema_migrations'::regclass
      AND attnum > 0
      AND NOT attisdropped
      AND attacl IS NOT NULL
  `);
  const indexes = await client.query<{ readonly count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_catalog.pg_index
    WHERE indrelid = 'dasher_meta.schema_migrations'::regclass
  `);
  const triggers = await client.query<{ readonly count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'dasher_meta.schema_migrations'::regclass
      AND NOT tgisinternal
  `);
  const policies = await client.query<{ readonly count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'dasher_meta.schema_migrations'::regclass
  `);

  const schemaPrivileges = schemaAcl.map(
    (row) =>
      `${row.grantee_name}:${row.privilege_type}:${String(row.is_grantable)}`,
  );
  const tablePrivileges = tableAcl.map(
    (row) =>
      `${row.grantee_name}:${row.privilege_type}:${String(row.is_grantable)}`,
  );

  if (
    !arraysEqual(schemaPrivileges, [
      `${ownerName}:CREATE:false`,
      `${ownerName}:USAGE:false`,
    ]) ||
    !arraysEqual(tablePrivileges, [
      `${ownerName}:DELETE:false`,
      `${ownerName}:INSERT:false`,
      `${ownerName}:REFERENCES:false`,
      `${ownerName}:SELECT:false`,
      `${ownerName}:TRIGGER:false`,
      `${ownerName}:TRUNCATE:false`,
      `${ownerName}:UPDATE:false`,
    ]) ||
    JSON.stringify(objects.rows) !==
      JSON.stringify([
        { relname: "schema_migrations", relkind: "r" },
        { relname: "schema_migrations_filename_key", relkind: "i" },
        { relname: "schema_migrations_pkey", relkind: "i" },
      ]) ||
    columnAcl.rows[0]?.count !== "0" ||
    indexes.rows[0]?.count !== "2" ||
    triggers.rows[0]?.count !== "0" ||
    policies.rows[0]?.count !== "0"
  ) {
    return reject("journal_shape_invalid");
  }
}

async function assertJournalShape(
  client: MigrationClient,
  ownerName: string,
): Promise<void> {
  await assertJournalRelation(client, ownerName);
  await assertJournalColumns(client);
  await assertJournalConstraints(client);
  await assertJournalAclAndObjects(client, ownerName);
}

async function readJournal(client: MigrationClient): Promise<JournalRow[]> {
  const result = await client.query<JournalRow>(`
    SELECT sequence, filename, checksum_sha256, applied_by::text AS applied_by
    FROM dasher_meta.schema_migrations
    ORDER BY sequence
  `);
  return result.rows;
}

function assertJournalPrefix(
  rows: readonly JournalRow[],
  migrations: readonly DiscoveredMigration[],
  ownerName: string,
): void {
  if (rows.length > migrations.length) {
    return reject("journal_identity_mismatch");
  }

  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      row.sequence !== index + 1 ||
      row.sequence !== migration.sequence ||
      row.filename !== migration.filename ||
      row.applied_by !== ownerName ||
      !(row.checksum_sha256 instanceof Uint8Array) ||
      !bytesEqual(row.checksum_sha256, migration.checksumSha256)
    ) {
      return reject("journal_identity_mismatch");
    }
  }
}

export async function runMigrations(
  pool: MigrationPool,
  directory: string,
): Promise<MigrationRunResult> {
  const migrations = await discoverMigrations(directory);
  const client = await pool.connect();

  try {
    await bootstrapManagedRoles(client);
    await client.query("BEGIN");

    try {
      await client.query(advisoryLockSql);
      const ownerName = await assertExecutor(client);
      const exists = await journalExists(client);

      if (!exists) {
        await assertNoAdoptionConflict(client);
        await createJournal(client);
      }

      await assertJournalShape(client, ownerName);
      const journalRows = await readJournal(client);
      assertJournalPrefix(journalRows, migrations, ownerName);

      const pending = migrations.slice(journalRows.length);
      for (const migration of pending) {
        await client.query(migration.sql);
        await client.query(
          `
            INSERT INTO dasher_meta.schema_migrations (
              sequence,
              filename,
              checksum_sha256,
              applied_by
            )
            VALUES ($1, $2, $3, session_user)
          `,
          [migration.sequence, migration.filename, migration.checksumSha256],
        );
      }

      await client.query("COMMIT");
      return {
        discoveredCount: migrations.length,
        previouslyAppliedCount: journalRows.length,
        appliedCount: pending.length,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}
