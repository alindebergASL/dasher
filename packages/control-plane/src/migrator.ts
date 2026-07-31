import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

const migrationFilenamePattern =
  /^(?<sequence>[0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$/;
const journalFilenamePattern = "^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$";
const advisoryLockSql =
  "SELECT pg_catalog.pg_advisory_xact_lock(724372, 20260730)";
const rollbackFailureMessage =
  "PostgreSQL transaction rollback failed; pooled client destroyed";
const setLocalSearchPathSql = "SET LOCAL search_path = pg_catalog";
const managedDependencyInventorySql = `
  WITH
  target_roles AS (
    SELECT role.oid, role.rolname::text AS role_name
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = ANY($1::text[])
  ),
  current_database_row AS (
    SELECT database_row.oid
    FROM pg_catalog.pg_database AS database_row
    WHERE database_row.datname = pg_catalog.current_database()
  ),
  dependencies AS (
    SELECT
      dependency.dbid,
      dependency.classid,
      dependency.objid,
      dependency.objsubid,
      dependency.deptype::text AS dependency_type,
      target_role.oid AS role_oid,
      target_role.role_name
    FROM pg_catalog.pg_shdepend AS dependency
    JOIN target_roles AS target_role
      ON target_role.oid = dependency.refobjid
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency.deptype IN ('a', 'o')
  ),
  resolved AS (
    SELECT
      dependency.*,
      'pg_database'::text AS catalog_name,
      'database'::text AS object_kind,
      NULL::text AS schema_name,
      database_row.datname::text AS object_name,
      NULL::text AS subobject_name,
      NULL::text AS function_arguments,
      privilege.privilege_type::text AS privilege_type,
      grantor.rolname::text AS grantor_name
    FROM dependencies AS dependency
    JOIN pg_catalog.pg_database AS database_row
      ON dependency.dbid = 0
     AND dependency.classid = 'pg_catalog.pg_database'::regclass
     AND dependency.objid = database_row.oid
     AND dependency.objsubid = 0
     AND dependency.dependency_type = 'a'
    CROSS JOIN LATERAL pg_catalog.aclexplode(database_row.datacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantor
      ON grantor.oid = privilege.grantor
    WHERE privilege.grantee = dependency.role_oid

    UNION ALL

    SELECT
      dependency.*,
      'pg_namespace'::text,
      'schema'::text,
      namespace.nspname::text,
      namespace.nspname::text,
      NULL::text,
      NULL::text,
      privilege.privilege_type::text,
      grantor.rolname::text
    FROM dependencies AS dependency
    CROSS JOIN current_database_row
    JOIN pg_catalog.pg_namespace AS namespace
      ON dependency.dbid = current_database_row.oid
     AND dependency.classid = 'pg_catalog.pg_namespace'::regclass
     AND dependency.objid = namespace.oid
     AND dependency.objsubid = 0
     AND dependency.dependency_type = 'a'
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantor
      ON grantor.oid = privilege.grantor
    WHERE privilege.grantee = dependency.role_oid

    UNION ALL

    SELECT
      dependency.*,
      'pg_proc'::text,
      'function'::text,
      namespace.nspname::text,
      routine.proname::text,
      NULL::text,
      pg_catalog.oidvectortypes(routine.proargtypes),
      NULL::text,
      NULL::text
    FROM dependencies AS dependency
    CROSS JOIN current_database_row
    JOIN pg_catalog.pg_proc AS routine
      ON dependency.dbid = current_database_row.oid
     AND dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = routine.oid
     AND dependency.objsubid = 0
     AND dependency.dependency_type = 'o'
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace

    UNION ALL

    SELECT
      dependency.*,
      'pg_proc'::text,
      'function'::text,
      namespace.nspname::text,
      routine.proname::text,
      NULL::text,
      pg_catalog.oidvectortypes(routine.proargtypes),
      privilege.privilege_type::text,
      grantor.rolname::text
    FROM dependencies AS dependency
    CROSS JOIN current_database_row
    JOIN pg_catalog.pg_proc AS routine
      ON dependency.dbid = current_database_row.oid
     AND dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = routine.oid
     AND dependency.objsubid = 0
     AND dependency.dependency_type = 'a'
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantor
      ON grantor.oid = privilege.grantor
    WHERE privilege.grantee = dependency.role_oid

    UNION ALL

    SELECT
      dependency.*,
      'pg_class'::text,
      'column'::text,
      namespace.nspname::text,
      relation.relname::text,
      attribute.attname::text,
      NULL::text,
      privilege.privilege_type::text,
      grantor.rolname::text
    FROM dependencies AS dependency
    CROSS JOIN current_database_row
    JOIN pg_catalog.pg_class AS relation
      ON dependency.dbid = current_database_row.oid
     AND dependency.classid = 'pg_catalog.pg_class'::regclass
     AND dependency.objid = relation.oid
     AND dependency.objsubid > 0
     AND dependency.dependency_type = 'a'
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum = dependency.objsubid
     AND NOT attribute.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantor
      ON grantor.oid = privilege.grantor
    WHERE privilege.grantee = dependency.role_oid
  ),
  unresolved AS (
    SELECT
      dependency.*,
      COALESCE(catalog.relname::text, dependency.classid::text)
        AS catalog_name,
      'unresolved'::text AS object_kind,
      NULL::text AS schema_name,
      dependency.objid::text AS object_name,
      dependency.objsubid::text AS subobject_name,
      NULL::text AS function_arguments,
      NULL::text AS privilege_type,
      NULL::text AS grantor_name
    FROM dependencies AS dependency
    LEFT JOIN pg_catalog.pg_class AS catalog
      ON catalog.oid = dependency.classid
    WHERE NOT EXISTS (
      SELECT 1
      FROM resolved
      WHERE resolved.dbid = dependency.dbid
        AND resolved.classid = dependency.classid
        AND resolved.objid = dependency.objid
        AND resolved.objsubid = dependency.objsubid
        AND resolved.dependency_type = dependency.dependency_type
        AND resolved.role_oid = dependency.role_oid
    )
  ),
  actual AS (
    SELECT
      role_name,
      dependency_type,
      dbid::text AS database_oid,
      catalog_name,
      object_kind,
      schema_name,
      object_name,
      subobject_name,
      function_arguments,
      privilege_type,
      grantor_name
    FROM resolved
    UNION ALL
    SELECT
      role_name,
      dependency_type,
      dbid::text,
      catalog_name,
      object_kind,
      schema_name,
      object_name,
      subobject_name,
      function_arguments,
      privilege_type,
      grantor_name
    FROM unresolved
  ),
  expected AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset($2::jsonb) AS entry(
      role_name text,
      dependency_type text,
      database_oid text,
      catalog_name text,
      object_kind text,
      schema_name text,
      object_name text,
      subobject_name text,
      function_arguments text,
      privilege_type text,
      grantor_name text
    )
  ),
  difference AS (
    (
      SELECT * FROM actual
      EXCEPT ALL
      SELECT * FROM expected
    )
    UNION ALL
    (
      SELECT * FROM expected
      EXCEPT ALL
      SELECT * FROM actual
    )
  )
  SELECT NOT EXISTS (SELECT 1 FROM difference) AS matches
`;

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

const managedRoleNames = ["dasher_app", "dasher_security_definer"] as const;

const task4FunctionSignatures = [
  {
    schema: "dasher_api",
    name: "accept_invitation",
    arguments:
      "smallint, bytea, text, text, text, boolean, uuid, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "issue_session",
    arguments:
      "text, text, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "initialize_context",
    arguments: "smallint, bytea, uuid",
  },
  {
    schema: "dasher_api",
    name: "issue_invitation",
    arguments:
      "uuid, text, text, smallint, bytea, uuid, smallint, bytea, smallint, bytea, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "revoke_invitation",
    arguments: "uuid, uuid, smallint, bytea, smallint, bytea, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "change_membership_role",
    arguments: "uuid, text, uuid, smallint, bytea, text",
  },
  {
    schema: "dasher_api",
    name: "revoke_membership",
    arguments: "uuid, uuid, smallint, bytea, text",
  },
  {
    schema: "dasher_api",
    name: "rotate_session",
    arguments:
      "uuid, smallint, bytea, smallint, bytea, uuid, smallint, bytea, text",
  },
  {
    schema: "dasher_api",
    name: "revoke_session",
    arguments: "uuid, uuid, smallint, bytea, text",
  },
  {
    schema: "dasher_private",
    name: "context_allows",
    arguments: "uuid, text",
  },
  {
    schema: "dasher_private",
    name: "context_user_id",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "context_organization_id",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "context_membership_id",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "context_session_id",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "context_request_id",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "context_authority_revision",
    arguments: "",
  },
] as const;

const task4TableColumns = {
  audit_events: [
    "audit_event_id",
    "organization_id",
    "occurred_at",
    "actor_kind",
    "actor_user_id",
    "actor_service",
    "authority_revision",
    "request_id",
    "job_id",
    "action",
    "target_type",
    "target_id",
    "outcome",
    "content_sha256",
    "source_ref",
    "provider",
    "credential_version",
    "usage_units",
    "cost_minor_units",
    "deployment_revision",
  ],
  external_identities: ["issuer", "subject", "user_id", "created_at"],
  invitations: [
    "invitation_id",
    "organization_id",
    "normalized_email",
    "granted_role",
    "role_ceiling",
    "token_key_version",
    "token_digest",
    "created_by_user_id",
    "created_at",
    "expires_at",
    "accepted_at",
    "accepted_user_id",
    "revoked_at",
    "revoked_by_user_id",
  ],
  memberships: [
    "membership_id",
    "organization_id",
    "user_id",
    "role",
    "state",
    "authority_revision",
    "created_at",
    "updated_at",
    "revoked_at",
  ],
  organizations: ["organization_id", "display_name", "created_at"],
  sessions: [
    "session_id",
    "organization_id",
    "user_id",
    "authority_revision",
    "token_key_version",
    "token_digest",
    "csrf_key_version",
    "csrf_digest",
    "issued_at",
    "last_seen_at",
    "idle_expires_at",
    "absolute_expires_at",
    "rotated_from_session_id",
    "replaced_by_session_id",
    "revoked_at",
    "revocation_reason",
  ],
  users: ["user_id", "created_at"],
} as const;

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

interface DatabaseIdentityRow {
  readonly database_name: string;
  readonly database_oid: string;
}

interface ExpectedAppLoginRow {
  readonly bypass_rls: boolean | null;
  readonly can_create_database: boolean | null;
  readonly can_create_role: boolean | null;
  readonly can_login: boolean | null;
  readonly comment: string | null;
  readonly connection_limit: number | null;
  readonly current_database_oid: string;
  readonly has_settings: boolean;
  readonly inherit_privileges: boolean | null;
  readonly password_is_scram: boolean;
  readonly replication: boolean | null;
  readonly role_name: string;
  readonly role_present: boolean;
  readonly superuser: boolean | null;
  readonly valid_until_is_null: boolean;
}

interface RoleMembershipRow {
  readonly admin_option: boolean;
  readonly granted_role_name: string;
  readonly inherit_option: boolean;
  readonly member_role_name: string;
  readonly set_option: boolean;
}

interface DependencyComparisonRow {
  readonly matches: boolean;
}

interface ManagedDependencyInventoryEntry {
  readonly catalog_name: string;
  readonly database_oid: string;
  readonly dependency_type: "a" | "o";
  readonly function_arguments: string | null;
  readonly grantor_name: string | null;
  readonly object_kind: "column" | "database" | "function" | "schema";
  readonly object_name: string;
  readonly privilege_type: string | null;
  readonly role_name: string;
  readonly schema_name: string | null;
  readonly subobject_name: string | null;
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

interface MigrationClientState {
  normalReleaseAllowed: boolean;
  released: boolean;
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

function validateExpectedAppLoginRoleNames(
  roleNames: readonly string[],
): readonly string[] {
  if (!Array.isArray(roleNames)) {
    return reject("managed_role_drift");
  }

  const validated = [...roleNames];
  if (
    validated.some(
      (roleName) =>
        typeof roleName !== "string" ||
        roleName.length === 0 ||
        new TextEncoder().encode(roleName).byteLength > 63 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(roleName) ||
        managedRoleNames.includes(
          roleName as (typeof managedRoleNames)[number],
        ),
    ) ||
    new Set(validated).size !== validated.length
  ) {
    return reject("managed_role_drift");
  }

  return validated.sort();
}

function retainSanitizedRollbackDiagnostic(
  operationError: unknown,
  diagnostic: Error,
): void {
  try {
    if (!(operationError instanceof Error)) {
      return;
    }

    if (operationError.cause === undefined) {
      operationError.cause = diagnostic;
      return;
    }

    Object.defineProperty(operationError, "rollbackDiagnostic", {
      configurable: true,
      enumerable: false,
      value: diagnostic,
      writable: false,
    });
  } catch {
    // A frozen or otherwise non-extensible original error remains authoritative.
  }
}

function destroyClientAfterRollbackFailure(
  client: MigrationClient,
  state: MigrationClientState,
  operationError: unknown,
): void {
  const diagnostic = new Error(rollbackFailureMessage);
  diagnostic.name = "MigrationRollbackError";
  state.normalReleaseAllowed = false;
  state.released = true;
  retainSanitizedRollbackDiagnostic(operationError, diagnostic);

  try {
    client.release(diagnostic);
  } catch {
    // The destructive release was attempted. Preserve the original failure.
  }
}

async function runMigrationTransaction<T>(
  client: MigrationClient,
  state: MigrationClientState,
  operation: () => Promise<T>,
): Promise<T> {
  state.normalReleaseAllowed = false;

  try {
    await client.query("BEGIN");
    await client.query(setLocalSearchPathSql);
    await client.query(advisoryLockSql);
    const result = await operation();
    await client.query("COMMIT");
    state.normalReleaseAllowed = true;
    return result;
  } catch (operationError) {
    try {
      await client.query("ROLLBACK");
      state.normalReleaseAllowed = true;
    } catch {
      destroyClientAfterRollbackFailure(client, state, operationError);
    }

    throw operationError;
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

async function readDatabaseIdentity(
  client: MigrationClient,
): Promise<DatabaseIdentityRow> {
  const result = await client.query<DatabaseIdentityRow>(`
    SELECT
      database_row.oid::text AS database_oid,
      database_row.datname::text AS database_name
    FROM pg_catalog.pg_database AS database_row
    WHERE database_row.datname = pg_catalog.current_database()
  `);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    return reject("managed_role_drift");
  }
  return row;
}

async function assertExpectedAppLogins(
  client: MigrationClient,
  expectedAppLoginRoleNames: readonly string[],
  databaseIdentity: DatabaseIdentityRow,
): Promise<void> {
  const result = await client.query<ExpectedAppLoginRow>(
    `
      WITH expected(role_name) AS (
        SELECT pg_catalog.unnest($1::text[])
      )
      SELECT
        expected.role_name,
        role.oid IS NOT NULL AS role_present,
        role.rolcanlogin AS can_login,
        role.rolinherit AS inherit_privileges,
        role.rolsuper AS superuser,
        role.rolcreatedb AS can_create_database,
        role.rolcreaterole AS can_create_role,
        role.rolreplication AS replication,
        role.rolbypassrls AS bypass_rls,
        COALESCE(
          role.rolpassword LIKE 'SCRAM-SHA-256$%',
          false
        ) AS password_is_scram,
        role.rolconnlimit AS connection_limit,
        role.oid IS NOT NULL
          AND role.rolvaliduntil IS NULL AS valid_until_is_null,
        pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_db_role_setting AS setting
          WHERE setting.setrole = role.oid
        ) AS has_settings,
        database_row.oid::text AS current_database_oid
      FROM expected
      LEFT JOIN pg_catalog.pg_authid AS role
        ON role.rolname = expected.role_name
      JOIN pg_catalog.pg_database AS database_row
        ON database_row.datname = pg_catalog.current_database()
    `,
    [expectedAppLoginRoleNames],
  );

  const expectedRoleNames = new Set(expectedAppLoginRoleNames);
  const rowsByRoleName = new Map<string, ExpectedAppLoginRow>();
  for (const row of result.rows) {
    if (
      !expectedRoleNames.has(row.role_name) ||
      rowsByRoleName.has(row.role_name)
    ) {
      return reject("managed_role_drift");
    }
    rowsByRoleName.set(row.role_name, row);
  }

  if (rowsByRoleName.size !== expectedRoleNames.size) {
    return reject("managed_role_drift");
  }

  for (const roleName of expectedRoleNames) {
    const row = rowsByRoleName.get(roleName);
    if (
      row === undefined ||
      !row.role_present ||
      row.can_login !== true ||
      row.inherit_privileges !== false ||
      row.superuser !== false ||
      row.can_create_database !== false ||
      row.can_create_role !== false ||
      row.replication !== false ||
      row.bypass_rls !== false ||
      !row.password_is_scram ||
      row.connection_limit !== -1 ||
      !row.valid_until_is_null ||
      row.has_settings ||
      row.current_database_oid !== databaseIdentity.database_oid ||
      row.comment !==
        `dasher:app-login:v1:database-oid:${databaseIdentity.database_oid}`
    ) {
      return reject("managed_role_drift");
    }
  }
}

async function assertRoleMemberships(
  client: MigrationClient,
  expectedAppLoginRoleNames: readonly string[],
): Promise<void> {
  const targetRoleNames = [...managedRoleNames, ...expectedAppLoginRoleNames];
  const result = await client.query<RoleMembershipRow>(
    `
      SELECT
        granted_role.rolname::text AS granted_role_name,
        member_role.rolname::text AS member_role_name,
        membership.inherit_option,
        membership.set_option,
        membership.admin_option
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
      WHERE granted_role.rolname = ANY($1::text[])
         OR member_role.rolname = ANY($1::text[])
    `,
    [targetRoleNames],
  );
  const actual = result.rows
    .map((row) =>
      JSON.stringify([
        row.granted_role_name,
        row.member_role_name,
        row.inherit_option,
        row.set_option,
        row.admin_option,
      ]),
    )
    .sort();
  const expected = expectedAppLoginRoleNames
    .map((roleName) =>
      JSON.stringify(["dasher_app", roleName, false, true, false]),
    )
    .sort();

  if (!arraysEqual(actual, expected)) {
    return reject("managed_role_drift");
  }
}

async function assertRoleAndLoginState(
  client: MigrationClient,
  expectedAppLoginRoleNames: readonly string[],
  createMissingManagedRoles: boolean,
): Promise<DatabaseIdentityRow> {
  for (const managedRole of managedRoles) {
    if (createMissingManagedRoles) {
      await createOrVerifyManagedRole(client, managedRole);
      continue;
    }

    const row = await readManagedRole(client, managedRole.name);
    if (row === undefined || !roleMatches(row, managedRole)) {
      return reject("managed_role_drift");
    }
  }

  const databaseIdentity = await readDatabaseIdentity(client);
  await assertExpectedAppLogins(
    client,
    expectedAppLoginRoleNames,
    databaseIdentity,
  );
  await assertRoleMemberships(client, expectedAppLoginRoleNames);
  return databaseIdentity;
}

async function bootstrapManagedRolesWithState(
  client: MigrationClient,
  state: MigrationClientState,
  expectedAppLoginRoleNames: readonly string[],
): Promise<void> {
  await runMigrationTransaction(client, state, async () => {
    await assertExecutor(client);
    await assertRoleAndLoginState(client, expectedAppLoginRoleNames, true);
  });
}

export async function bootstrapManagedRoles(
  client: MigrationClient,
  expectedAppLoginRoleNames: readonly string[],
): Promise<void> {
  const validatedRoleNames = validateExpectedAppLoginRoleNames(
    expectedAppLoginRoleNames,
  );
  await bootstrapManagedRolesWithState(
    client,
    {
      normalReleaseAllowed: true,
      released: false,
    },
    validatedRoleNames,
  );
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

function dependencyEntry(
  values: ManagedDependencyInventoryEntry,
): ManagedDependencyInventoryEntry {
  return values;
}

function expectedDependencyInventory(
  journalRows: readonly JournalRow[],
  expectedAppLoginRoleNames: readonly string[],
  databaseIdentity: DatabaseIdentityRow,
  ownerName: string,
): readonly ManagedDependencyInventoryEntry[] {
  const entries: ManagedDependencyInventoryEntry[] =
    expectedAppLoginRoleNames.map((roleName) =>
      dependencyEntry({
        catalog_name: "pg_database",
        database_oid: "0",
        dependency_type: "a",
        function_arguments: null,
        grantor_name: ownerName,
        object_kind: "database",
        object_name: databaseIdentity.database_name,
        privilege_type: "CONNECT",
        role_name: roleName,
        schema_name: null,
        subobject_name: null,
      }),
    );
  const hasSecurityBoundary = journalRows.some(
    (row) =>
      row.sequence === 2 && row.filename === "0002_security_boundary.sql",
  );

  if (!hasSecurityBoundary) {
    return entries;
  }

  entries.push(
    dependencyEntry({
      catalog_name: "pg_database",
      database_oid: "0",
      dependency_type: "a",
      function_arguments: null,
      grantor_name: ownerName,
      object_kind: "database",
      object_name: databaseIdentity.database_name,
      privilege_type: "CONNECT",
      role_name: "dasher_app",
      schema_name: null,
      subobject_name: null,
    }),
  );

  for (const [roleName, schemaNames] of [
    ["dasher_app", ["dasher", "dasher_api"]],
    ["dasher_security_definer", ["dasher", "dasher_private"]],
  ] as const) {
    for (const schemaName of schemaNames) {
      entries.push(
        dependencyEntry({
          catalog_name: "pg_namespace",
          database_oid: databaseIdentity.database_oid,
          dependency_type: "a",
          function_arguments: null,
          grantor_name: ownerName,
          object_kind: "schema",
          object_name: schemaName,
          privilege_type: "USAGE",
          role_name: roleName,
          schema_name: schemaName,
          subobject_name: null,
        }),
      );
    }
  }

  for (const signature of task4FunctionSignatures) {
    entries.push(
      dependencyEntry({
        catalog_name: "pg_proc",
        database_oid: databaseIdentity.database_oid,
        dependency_type: "o",
        function_arguments: signature.arguments,
        grantor_name: null,
        object_kind: "function",
        object_name: signature.name,
        privilege_type: null,
        role_name: "dasher_security_definer",
        schema_name: signature.schema,
        subobject_name: null,
      }),
      dependencyEntry({
        catalog_name: "pg_proc",
        database_oid: databaseIdentity.database_oid,
        dependency_type: "a",
        function_arguments: signature.arguments,
        grantor_name: "dasher_security_definer",
        object_kind: "function",
        object_name: signature.name,
        privilege_type: "EXECUTE",
        role_name: "dasher_app",
        schema_name: signature.schema,
        subobject_name: null,
      }),
    );
  }

  const addColumnPrivileges = (
    roleName: string,
    tableName: keyof typeof task4TableColumns,
    columns: readonly string[],
    privileges: readonly string[],
  ): void => {
    for (const columnName of columns) {
      for (const privilegeType of privileges) {
        entries.push(
          dependencyEntry({
            catalog_name: "pg_class",
            database_oid: databaseIdentity.database_oid,
            dependency_type: "a",
            function_arguments: null,
            grantor_name: ownerName,
            object_kind: "column",
            object_name: tableName,
            privilege_type: privilegeType,
            role_name: roleName,
            schema_name: "dasher",
            subobject_name: columnName,
          }),
        );
      }
    }
  };

  addColumnPrivileges(
    "dasher_app",
    "organizations",
    task4TableColumns.organizations,
    ["SELECT"],
  );
  addColumnPrivileges(
    "dasher_app",
    "memberships",
    task4TableColumns.memberships,
    ["SELECT"],
  );
  addColumnPrivileges(
    "dasher_app",
    "invitations",
    task4TableColumns.invitations.filter(
      (column) => column !== "token_key_version" && column !== "token_digest",
    ),
    ["SELECT"],
  );
  addColumnPrivileges(
    "dasher_app",
    "sessions",
    task4TableColumns.sessions.filter(
      (column) =>
        column !== "token_key_version" &&
        column !== "token_digest" &&
        column !== "csrf_key_version" &&
        column !== "csrf_digest",
    ),
    ["SELECT"],
  );
  addColumnPrivileges(
    "dasher_app",
    "audit_events",
    task4TableColumns.audit_events,
    ["SELECT"],
  );

  addColumnPrivileges(
    "dasher_security_definer",
    "users",
    task4TableColumns.users,
    ["INSERT", "SELECT"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "external_identities",
    task4TableColumns.external_identities,
    ["INSERT", "SELECT"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "memberships",
    task4TableColumns.memberships,
    ["INSERT", "SELECT"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "memberships",
    ["role", "state", "authority_revision", "updated_at", "revoked_at"],
    ["UPDATE"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "invitations",
    task4TableColumns.invitations,
    ["INSERT", "SELECT"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "invitations",
    ["accepted_at", "accepted_user_id", "revoked_at", "revoked_by_user_id"],
    ["UPDATE"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "sessions",
    task4TableColumns.sessions,
    ["INSERT", "SELECT"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "sessions",
    [
      "last_seen_at",
      "idle_expires_at",
      "replaced_by_session_id",
      "revoked_at",
      "revocation_reason",
    ],
    ["UPDATE"],
  );
  addColumnPrivileges(
    "dasher_security_definer",
    "audit_events",
    task4TableColumns.audit_events,
    ["INSERT"],
  );

  return entries;
}

function inventoryJson(
  entries: readonly ManagedDependencyInventoryEntry[],
): string {
  return JSON.stringify(
    [...entries].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  );
}

async function assertDependencyInventory(
  client: MigrationClient,
  journalRows: readonly JournalRow[],
  expectedAppLoginRoleNames: readonly string[],
  databaseIdentity: DatabaseIdentityRow,
  ownerName: string,
): Promise<void> {
  const targetRoleNames = [...managedRoleNames, ...expectedAppLoginRoleNames];
  const expected = expectedDependencyInventory(
    journalRows,
    expectedAppLoginRoleNames,
    databaseIdentity,
    ownerName,
  );
  const result = await client.query<DependencyComparisonRow>(
    managedDependencyInventorySql,
    [targetRoleNames, inventoryJson(expected)],
  );

  if (result.rows.length !== 1 || result.rows[0]?.matches !== true) {
    return reject("managed_role_drift");
  }
}

export async function runMigrations(
  pool: MigrationPool,
  directory: string,
  expectedAppLoginRoleNames: readonly string[],
): Promise<MigrationRunResult> {
  const validatedRoleNames = validateExpectedAppLoginRoleNames(
    expectedAppLoginRoleNames,
  );
  const migrations = await discoverMigrations(directory);
  const client = await pool.connect();
  const state: MigrationClientState = {
    normalReleaseAllowed: true,
    released: false,
  };
  let operationSucceeded = false;

  try {
    await bootstrapManagedRolesWithState(client, state, validatedRoleNames);
    const result = await runMigrationTransaction(client, state, async () => {
      const ownerName = await assertExecutor(client);
      let databaseIdentity = await assertRoleAndLoginState(
        client,
        validatedRoleNames,
        false,
      );
      const exists = await journalExists(client);

      if (!exists) {
        await assertNoAdoptionConflict(client);
        await createJournal(client);
      }

      await assertJournalShape(client, ownerName);
      const journalRows = await readJournal(client);
      assertJournalPrefix(journalRows, migrations, ownerName);
      await assertDependencyInventory(
        client,
        journalRows,
        validatedRoleNames,
        databaseIdentity,
        ownerName,
      );

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

      databaseIdentity = await assertRoleAndLoginState(
        client,
        validatedRoleNames,
        false,
      );
      await assertJournalShape(client, ownerName);
      const successorJournalRows = await readJournal(client);
      assertJournalPrefix(successorJournalRows, migrations, ownerName);
      if (successorJournalRows.length !== migrations.length) {
        return reject("journal_identity_mismatch");
      }
      await assertDependencyInventory(
        client,
        successorJournalRows,
        validatedRoleNames,
        databaseIdentity,
        ownerName,
      );

      return {
        discoveredCount: migrations.length,
        previouslyAppliedCount: journalRows.length,
        appliedCount: pending.length,
      };
    });
    operationSucceeded = true;
    return result;
  } finally {
    if (!state.released && state.normalReleaseAllowed) {
      state.released = true;
      try {
        client.release();
      } catch (releaseError) {
        if (operationSucceeded) {
          throw releaseError;
        }
        // A transaction failure remains authoritative after successful
        // rollback even if normal release itself throws synchronously.
      }
    }
  }
}
