import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { types as nodeTypes } from "node:util";

import type { PoolClient } from "pg";

const migrationFilenamePattern =
  /^(?<sequence>[0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$/;
const journalFilenamePattern = "^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$";
const advisoryTransactionLockSql =
  "SELECT pg_catalog.pg_advisory_xact_lock(724372, 20260730)";
const advisorySessionLockSql =
  "SELECT pg_catalog.pg_advisory_lock(724372, 20260730)";
const advisorySessionUnlockSql =
  "SELECT pg_catalog.pg_advisory_unlock(724372, 20260730) AS unlocked";
const migrationFileByteLimit = 16 * 1024 * 1024;
const migrationSeriesByteLimit = 64 * 1024 * 1024;
const modeledSuccessorFiles = [
  {
    checksum:
      "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
    filename: "0001_identity_audit.sql",
  },
  {
    checksum:
      "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
    filename: "0002_security_boundary.sql",
  },
  {
    checksum:
      "2feea09a7459e86bc64a34d728b191437b06439be4092daf0ac4ead586f43524",
    filename: "0003_immutable_content.sql",
  },
] as const;
const managedRoleCreateSavepointSql = "SAVEPOINT dasher_managed_role_create";
const managedRoleCreateRollbackSql =
  "ROLLBACK TO SAVEPOINT dasher_managed_role_create";
const managedRoleCreateReleaseSql =
  "RELEASE SAVEPOINT dasher_managed_role_create";
const rollbackFailureMessage =
  "PostgreSQL transaction rollback failed; pooled client destroyed";
const gateAcquisitionFailureMessage =
  "PostgreSQL migrator advisory gate acquisition was ambiguous; pooled client destroyed";
const gateReleaseFailureMessage =
  "PostgreSQL migrator advisory gate release failed; pooled client destroyed";
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
      AND dependency.deptype IN ('a', 'o', 'r')
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
      grantor.rolname::text AS grantor_name,
      privilege.is_grantable,
      NULL::text AS policy_name,
      NULL::text AS policy_command,
      NULL::boolean AS policy_permissive,
      NULL::text[] AS policy_roles,
      NULL::text AS policy_using_expression,
      NULL::text AS policy_with_check_expression
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
      'pg_class'::text,
      'relation'::text,
      namespace.nspname::text,
      relation.relname::text,
      NULL::text,
      NULL::text,
      privilege.privilege_type::text,
      grantor.rolname::text,
      privilege.is_grantable,
      NULL::text,
      NULL::text,
      NULL::boolean,
      NULL::text[],
      NULL::text,
      NULL::text
    FROM dependencies AS dependency
    CROSS JOIN current_database_row
    JOIN pg_catalog.pg_class AS relation
      ON dependency.dbid = current_database_row.oid
     AND dependency.classid = 'pg_catalog.pg_class'::regclass
     AND dependency.objid = relation.oid
     AND dependency.objsubid = 0
     AND dependency.dependency_type = 'a'
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
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
      grantor.rolname::text,
      privilege.is_grantable,
      NULL::text,
      NULL::text,
      NULL::boolean,
      NULL::text[],
      NULL::text,
      NULL::text
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
      NULL::text,
      NULL::boolean,
      NULL::text,
      NULL::text,
      NULL::boolean,
      NULL::text[],
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
      grantor.rolname::text,
      privilege.is_grantable,
      NULL::text,
      NULL::text,
      NULL::boolean,
      NULL::text[],
      NULL::text,
      NULL::text
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
      grantor.rolname::text,
      privilege.is_grantable,
      NULL::text,
      NULL::text,
      NULL::boolean,
      NULL::text[],
      NULL::text,
      NULL::text
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

    UNION ALL

    SELECT
      dependency.*,
      'pg_policy'::text,
      'policy'::text,
      namespace.nspname::text,
      relation.relname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::boolean,
      policy.polname::text,
      policy.polcmd::text,
      policy.polpermissive,
      ARRAY(
        SELECT role_row.rolname::text
        FROM pg_catalog.unnest(policy.polroles) AS role_oid
        JOIN pg_catalog.pg_roles AS role_row
          ON role_row.oid = role_oid
        ORDER BY role_row.rolname
      )::text[],
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
    FROM dependencies AS dependency
    CROSS JOIN current_database_row
    JOIN pg_catalog.pg_policy AS policy
      ON dependency.dbid = current_database_row.oid
     AND dependency.classid = 'pg_catalog.pg_policy'::regclass
     AND dependency.objid = policy.oid
     AND dependency.objsubid = 0
     AND dependency.dependency_type = 'r'
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
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
      NULL::text AS grantor_name,
      NULL::boolean AS is_grantable,
      NULL::text AS policy_name,
      NULL::text AS policy_command,
      NULL::boolean AS policy_permissive,
      NULL::text[] AS policy_roles,
      NULL::text AS policy_using_expression,
      NULL::text AS policy_with_check_expression
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
      grantor_name,
      is_grantable,
      policy_name,
      policy_command,
      policy_permissive,
      policy_roles,
      policy_using_expression,
      policy_with_check_expression
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
      grantor_name,
      is_grantable,
      policy_name,
      policy_command,
      policy_permissive,
      policy_roles,
      policy_using_expression,
      policy_with_check_expression
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
      grantor_name text,
      is_grantable boolean,
      policy_name text,
      policy_command text,
      policy_permissive boolean,
      policy_roles text[],
      policy_using_expression text,
      policy_with_check_expression text
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

interface ManagedRoleExpectation {
  readonly bypassRls: boolean;
  readonly comment: string;
  readonly commentSql: string;
  readonly createSql: string;
  readonly name: string;
  readonly validUntil: "infinity" | "null";
}

const managedRoles = [
  {
    name: "dasher_app",
    comment: "dasher:managed-role:v1:app",
    bypassRls: false,
    createSql:
      "CREATE ROLE dasher_app WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL",
    commentSql: "COMMENT ON ROLE dasher_app IS 'dasher:managed-role:v1:app'",
    validUntil: "null",
  },
  {
    name: "dasher_security_definer",
    comment: "dasher:managed-role:v1:security-definer",
    bypassRls: true,
    createSql:
      "CREATE ROLE dasher_security_definer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD NULL",
    commentSql:
      "COMMENT ON ROLE dasher_security_definer IS 'dasher:managed-role:v1:security-definer'",
    validUntil: "null",
  },
] as const satisfies readonly ManagedRoleExpectation[];

const preparedRetentionRoles = [
  {
    name: "dasher_retention_definer",
    comment: "dasher:managed-role:v1:retention-definer",
    bypassRls: false,
    createSql:
      "CREATE ROLE dasher_retention_definer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL VALID UNTIL 'infinity'",
    commentSql:
      "COMMENT ON ROLE dasher_retention_definer IS 'dasher:managed-role:v1:retention-definer'",
    validUntil: "infinity",
  },
  {
    name: "dasher_retention_operator",
    comment: "dasher:managed-role:v1:retention-operator",
    bypassRls: false,
    createSql:
      "CREATE ROLE dasher_retention_operator WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL VALID UNTIL 'infinity'",
    commentSql:
      "COMMENT ON ROLE dasher_retention_operator IS 'dasher:managed-role:v1:retention-operator'",
    validUntil: "infinity",
  },
] as const satisfies readonly ManagedRoleExpectation[];

const managedRoleNames = ["dasher_app", "dasher_security_definer"] as const;
const preparedRetentionRoleNames = [
  "dasher_retention_definer",
  "dasher_retention_operator",
] as const;
const allManagedRoleNames = [
  ...managedRoleNames,
  ...preparedRetentionRoleNames,
] as const;

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

const modeled0003FunctionSources: Readonly<Record<string, string>> = {
  "dasher_api.list_dashboards": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
BEGIN
  IF $1 IS NULL OR $1 NOT BETWEEN 1 AND 100 OR v_organization_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT ROW(dashboard_id, title, current_kind, lifecycle_state,
      lifecycle_revision, effective_expires_at, head_version_id
    )::dasher.dashboard_summary
    FROM dasher.dashboards
    WHERE organization_id = v_organization_id AND purged_at IS NULL
    ORDER BY created_at DESC, dashboard_id
    LIMIT $1;
END
`,
  "dasher_api.get_dashboard_summary": `
DECLARE
  v_result dasher.dashboard_summary;
BEGIN
  SELECT ROW(dashboard_id, title, current_kind, lifecycle_state,
      lifecycle_revision, effective_expires_at, head_version_id
    )::dasher.dashboard_summary
    INTO v_result
  FROM dasher.dashboards
  WHERE organization_id = dasher_private.context_organization_id()
    AND dashboard_id = $1 AND purged_at IS NULL;
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
`,
  "dasher_api.get_dashboard_head": `
DECLARE
  v_head_version_id uuid;
BEGIN
  SELECT head_version_id INTO v_head_version_id
  FROM dasher.dashboards
  WHERE organization_id = dasher_private.context_organization_id()
    AND dashboard_id = $1 AND access_revoked_at IS NULL AND purged_at IS NULL;
  IF NOT FOUND OR v_head_version_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_head_version_id;
END
`,
  "dasher_api.get_dashboard_version": `
DECLARE
  v_result dasher.dashboard_version_projection;
BEGIN
  SELECT ROW(version.dashboard_id, version.version_id, version.parent_version_id,
      version.canonical_spec_sha256, version.validation_state,
      version.validation_sha256, version.planner_provenance_sha256,
      version.policy_revision, version.registry_revision,
      version.calculation_graph_sha256, version.created_at
    )::dasher.dashboard_version_projection
    INTO v_result
  FROM dasher.dashboard_versions AS version
  JOIN dasher.dashboards AS dashboard
    ON dashboard.organization_id = version.organization_id
   AND dashboard.dashboard_id = version.dashboard_id
  WHERE version.organization_id = dasher_private.context_organization_id()
    AND version.dashboard_id = $1 AND version.version_id = $2
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL;
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
`,
  "dasher_api.get_dashboard_evidence": `
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM dasher.dashboards
    WHERE organization_id = dasher_private.context_organization_id()
      AND dashboard_id = $1 AND access_revoked_at IS NULL AND purged_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT ROW(link.dashboard_id, link.version_id, evidence.evidence_id,
      evidence.evidence_kind, evidence.content_sha256, evidence.observed_at,
      evidence.retrieved_at)::dasher.dashboard_evidence_projection
    FROM dasher.dashboard_version_evidence AS link
    JOIN dasher.evidence_records AS evidence
      ON evidence.organization_id = link.organization_id
     AND evidence.evidence_id = link.evidence_id
    WHERE link.organization_id = dasher_private.context_organization_id()
      AND link.dashboard_id = $1 AND link.version_id = $2
    ORDER BY evidence.evidence_id;
END
`,
  "dasher_api.get_dashboard_lineage": `
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM dasher.dashboard_versions
    WHERE organization_id = dasher_private.context_organization_id()
      AND dashboard_id = $1 AND version_id = $2
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT ROW(version.dashboard_id, version.version_id, version.parent_version_id,
      snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id
    )::dasher.dashboard_lineage_projection
    FROM dasher.dashboard_versions AS version
    LEFT JOIN dasher.dashboard_version_snapshots AS snapshot
      ON snapshot.organization_id = version.organization_id
     AND snapshot.dashboard_id = version.dashboard_id
     AND snapshot.version_id = version.version_id
    LEFT JOIN dasher.dashboard_version_evidence AS evidence
      ON evidence.organization_id = version.organization_id
     AND evidence.dashboard_id = version.dashboard_id
     AND evidence.version_id = version.version_id
    LEFT JOIN dasher.dashboard_artifacts AS artifact
      ON artifact.organization_id = version.organization_id
     AND artifact.dashboard_id = version.dashboard_id
     AND artifact.version_id = version.version_id
    WHERE version.organization_id = dasher_private.context_organization_id()
      AND version.dashboard_id = $1 AND version.version_id = $2
    ORDER BY snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id;
END
`,
  "dasher_api.get_dashboard_admin_status": `
DECLARE
  v_result dasher.dashboard_admin_projection;
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT ROW(dashboard.dashboard_id, dashboard.lifecycle_state,
      dashboard.lifecycle_revision, dashboard.capability_epoch,
      dashboard.cache_epoch, dashboard.access_revoked_at, dashboard.purge_after,
      dashboard.purge_started_at, dashboard.purged_at,
      (SELECT count(*) FROM dasher.dashboard_legal_holds AS hold
       WHERE hold.organization_id = dashboard.organization_id
         AND hold.dashboard_id = dashboard.dashboard_id
         AND hold.released_at IS NULL),
      coordination.current_step)::dasher.dashboard_admin_projection
    INTO v_result
  FROM dasher.dashboards AS dashboard
  LEFT JOIN dasher.dashboard_cleanup_coordination AS coordination
    ON coordination.organization_id = dashboard.organization_id
   AND coordination.dashboard_id = dashboard.dashboard_id
  WHERE dashboard.organization_id = dasher_private.context_organization_id()
    AND dashboard.dashboard_id = $1;
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
`,
  "dasher_api.create_dashboard": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_now timestamptz := statement_timestamp();
  v_policy_revision bigint;
BEGIN
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR btrim($2) <> $2 OR char_length($2) NOT BETWEEN 1 AND 200
    OR $3 NOT IN ('disposable', 'durable')
    OR ($3 = 'disposable' AND ($4 IS NULL OR $4 NOT BETWEEN 3600 AND 604800))
    OR ($3 = 'durable' AND $4 IS NOT NULL) OR $6 IS NULL OR $7 IS NULL
    OR $8 IS NULL OR char_length($8) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT retention_policy_revision INTO v_policy_revision
  FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboards (
    organization_id, dashboard_id, title, created_by_user_id, created_at,
    created_kind, current_kind, original_expires_at, effective_expires_at,
    lifecycle_state, lifecycle_revision, capability_epoch, cache_epoch,
    retention_policy_revision, tombstone_lineage_id
  ) VALUES (
    v_organization_id, $1, $2, v_actor_user_id, v_now, $3, $3,
    CASE WHEN $3 = 'disposable' THEN v_now + make_interval(secs => $4) END,
    CASE WHEN $3 = 'disposable' THEN v_now + make_interval(secs => $4) END,
    CASE WHEN $5 THEN 'active' ELSE 'draft' END, 0, 0, 0,
    v_policy_revision, $6
  );
  RETURN $1;
END
`,
  "dasher_api.create_evidence_record": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
BEGIN
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL
    OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR $7 IS NULL
    OR octet_length($7) <> 32 OR $8 IS NULL OR $9 IS NULL OR $8 > $9
    OR $10 IS NULL OR $11 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboards
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND access_revoked_at IS NULL AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.evidence_records (
    organization_id, evidence_id, snapshot_id, evidence_kind, coordinates,
    transformation, content_sha256, observed_at, retrieved_at, created_at
  ) VALUES (v_organization_id, $2, $3, $5, $6, 'identity', $7, $8, $9,
    statement_timestamp());
END
`,
  "dasher_api.create_dashboard_version": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_snapshot_id uuid;
  v_evidence_id uuid;
BEGIN
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $4 IS NULL OR $5 IS NULL OR octet_length($5) <> 32
    OR $7 IS NULL OR octet_length($7) <> 32 OR $8 IS NULL
    OR octet_length($8) <> 32 OR $9 < 1 OR $10 < 1 OR $12 IS NULL OR $13 IS NULL
    OR $14 IS NULL OR $15 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_versions (
    organization_id, dashboard_id, version_id, parent_version_id,
    canonical_spec_bytes, canonical_spec_sha256, validation_state,
    validation_sha256, planner_provenance_sha256, policy_revision,
    registry_revision, calculation_graph_sha256, created_by_user_id, created_at
  ) VALUES (v_organization_id, $1, $2, $3, $4, $5, 'validated', $7, $8,
    $9, $10, $11, v_actor_user_id, statement_timestamp());
  FOREACH v_snapshot_id IN ARRAY $12 LOOP
    INSERT INTO dasher.dashboard_version_snapshots
      (organization_id, dashboard_id, version_id, snapshot_id)
    VALUES (v_organization_id, $1, $2, v_snapshot_id);
  END LOOP;
  FOREACH v_evidence_id IN ARRAY $13 LOOP
    INSERT INTO dasher.dashboard_version_evidence
      (organization_id, dashboard_id, version_id, evidence_id)
    VALUES (v_organization_id, $1, $2, v_evidence_id);
  END LOOP;
  RETURN $2;
END
`,
  "dasher_api.compare_and_swap_dashboard_head": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
BEGIN
  IF v_organization_id IS NULL OR $1 IS NULL OR $3 IS NULL OR $4 IS NULL
    OR $4 < 0 OR $5 IS NULL OR $6 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'dasher:dashboard:v1|' || v_organization_id::text || '|' || $1::text, 0
  ));
  UPDATE dasher.dashboards
  SET head_version_id = $3, lifecycle_revision = lifecycle_revision + 1,
      cache_epoch = cache_epoch + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND head_version_id IS NOT DISTINCT FROM $2 AND lifecycle_revision = $4
    AND access_revoked_at IS NULL AND purged_at IS NULL
    AND EXISTS (SELECT 1 FROM dasher.dashboard_versions
      WHERE organization_id = v_organization_id AND dashboard_id = $1
        AND version_id = $3 AND validation_state = 'validated');
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_api.request_dashboard_promotion": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
BEGIN
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $3 < 0 OR $4 IS NULL OR octet_length($4) <> 32
    OR $5 IS NULL OR $6 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_promotion_requests (
    organization_id, promotion_request_id, dashboard_id,
    requested_lifecycle_revision, requested_at, requested_by_user_id,
    rationale_sha256
  ) SELECT v_organization_id, $2, $1, $3, statement_timestamp(),
      v_actor_user_id, $4
    FROM dasher.dashboards
    WHERE organization_id = v_organization_id AND dashboard_id = $1
      AND current_kind = 'disposable' AND lifecycle_revision = $3
      AND access_revoked_at IS NULL AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  RETURN $2;
END
`,
  "dasher_api.decide_dashboard_promotion": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_requested_by_user_id uuid;
  v_dashboard_id uuid;
  v_policy_revision bigint;
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'admin')
    OR v_actor_user_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL
    OR $4 < 0 OR $5 NOT IN ('approved', 'denied') OR $6 IS NULL OR $7 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT dashboard_id, requested_by_user_id
    INTO v_dashboard_id, v_requested_by_user_id
  FROM dasher.dashboard_promotion_requests
  WHERE organization_id = v_organization_id AND promotion_request_id = $1
    AND requested_lifecycle_revision = $4;
  IF NOT FOUND OR v_requested_by_user_id = v_actor_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT retention_policy_revision INTO v_policy_revision
  FROM dasher.dashboards
  WHERE organization_id = v_organization_id AND dashboard_id = v_dashboard_id
    AND lifecycle_revision = $4 AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  INSERT INTO dasher.dashboard_promotion_decisions (
    organization_id, promotion_request_id, decision,
    dashboard_lifecycle_revision, decided_at, requested_by_user_id,
    decided_by_user_id, retention_policy_revision
  ) VALUES (v_organization_id, $1, $5, $4, statement_timestamp(),
    v_requested_by_user_id, v_actor_user_id, v_policy_revision);
  IF $5 = 'approved' THEN
    UPDATE dasher.dashboards SET current_kind = 'durable',
      effective_expires_at = NULL, promoted_at = statement_timestamp(),
      lifecycle_revision = lifecycle_revision + 1,
      capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
    WHERE organization_id = v_organization_id AND dashboard_id = v_dashboard_id
      AND lifecycle_revision = $4;
  END IF;
END
`,
  "dasher_api.set_dashboard_archive": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
BEGIN
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 < 0
    OR $4 IS NULL OR $5 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  UPDATE dasher.dashboards
  SET lifecycle_state = CASE WHEN $2 THEN 'archived' ELSE 'active' END,
      archived_at = CASE WHEN $2 THEN statement_timestamp() ELSE NULL END,
      lifecycle_revision = lifecycle_revision + 1,
      capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $3 AND current_kind = 'durable'
    AND access_revoked_at IS NULL AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_api.delete_dashboard": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
BEGIN
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 < 0 OR $3 IS NULL
    OR $4 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  UPDATE dasher.dashboards SET lifecycle_state = 'access_revoked',
    access_revoked_at = statement_timestamp(), revocation_reason = 'explicit_delete',
    purge_after = statement_timestamp(), lifecycle_revision = lifecycle_revision + 1,
    capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $2 AND access_revoked_at IS NULL AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_api.restore_dashboard_as_new": `
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_policy_revision bigint;
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'admin')
    OR v_actor_user_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL
    OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR $7 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT retention_policy_revision INTO v_policy_revision
  FROM dasher.dashboard_tombstones
  WHERE organization_id = v_organization_id AND tombstone_lineage_id = $3
    AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboards (
    organization_id, dashboard_id, title, created_by_user_id, created_at,
    created_kind, current_kind, lifecycle_state, lifecycle_revision,
    capability_epoch, cache_epoch, retention_policy_revision,
    tombstone_lineage_id, restored_from_tombstone_lineage_id
  ) VALUES (v_organization_id, $1, $5, v_actor_user_id, statement_timestamp(),
    'durable', 'durable', 'draft', 0, 0, 0, v_policy_revision, $2, $3);
  INSERT INTO dasher.dashboard_restore_lineage (
    organization_id, dashboard_id, version_id, source_tombstone_lineage_id,
    source_version_id, retention_policy_revision, actor_user_id,
    authority_revision, occurred_at, provenance_sha256
  ) VALUES (v_organization_id, $1, $4, $3, $4, v_policy_revision,
    v_actor_user_id, dasher_private.context_authority_revision(),
    statement_timestamp(), decode(md5($5 || $7), 'hex'));
END
`,
  "dasher_retention_api.initialize_operator_context": `
DECLARE
  v_binding_gate bigint;
  v_organization_gate bigint;
  v_principal_id uuid;
  v_principal_revision bigint;
  v_authority_scope text;
  v_scope_organization_id uuid;
  v_enabled boolean;
  v_capability_allowed boolean;
  v_target_organization_id uuid;
  v_chain_count bigint;
  v_chain_min_revision bigint;
  v_chain_valid boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF COALESCE(current_setting('dasher.retention_phase', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_principal_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_principal_revision', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_authority_scope', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_capability', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_target_dashboard_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_target_organization_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_request_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_case_matter_reference', true), '') <> ''
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF $1 IS NULL OR $2 NOT IN (
      'materialize_expiry', 'place_hold', 'release_hold', 'claim_cleanup',
      'record_attempt', 'purge'
    ) OR $3 IS NULL OR $4 IS NULL OR btrim($4) <> $4
    OR char_length($4) NOT BETWEEN 1 AND 200 OR $4 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_binding_gate := hashtextextended(
    'dasher:retention-principal-binding:v1|postgres_session_user|' ||
      session_user::text,
    0
  );
  PERFORM pg_advisory_xact_lock(v_binding_gate);
  PERFORM set_config('dasher.retention_phase', 'binding_lookup', true);
  SELECT retention_service_principal_id, principal_revision, authority_scope,
      scope_organization_id, enabled,
      CASE $2
        WHEN 'materialize_expiry' THEN can_materialize_expiry
        WHEN 'place_hold' THEN can_place_hold
        WHEN 'release_hold' THEN can_release_hold
        WHEN 'claim_cleanup' THEN can_claim_cleanup
        WHEN 'record_attempt' THEN can_record_attempt
        WHEN 'purge' THEN can_purge
        ELSE false
      END
    INTO v_principal_id, v_principal_revision, v_authority_scope,
      v_scope_organization_id, v_enabled, v_capability_allowed
  FROM dasher.retention_service_principal_allowlist
  WHERE binding_kind = 'postgres_session_user'
    AND binding_subject = session_user
  ORDER BY principal_revision DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  WITH RECURSIVE authority_chain AS (
    SELECT principal_revision, predecessor_revision, predecessor_sha256,
      revision_sha256
    FROM dasher.retention_service_principal_allowlist
    WHERE retention_service_principal_id = v_principal_id
      AND principal_revision = v_principal_revision
    UNION ALL
    SELECT predecessor.principal_revision, predecessor.predecessor_revision,
      predecessor.predecessor_sha256, predecessor.revision_sha256
    FROM dasher.retention_service_principal_allowlist AS predecessor
    JOIN authority_chain AS successor
      ON predecessor.retention_service_principal_id = v_principal_id
     AND predecessor.principal_revision = successor.predecessor_revision
     AND predecessor.revision_sha256 = successor.predecessor_sha256
  )
  SELECT count(*), min(principal_revision),
      bool_and(
        (principal_revision = 1 AND predecessor_revision IS NULL
          AND predecessor_sha256 IS NULL)
        OR
        (principal_revision > 1 AND predecessor_revision = principal_revision - 1
          AND predecessor_sha256 IS NOT NULL)
      )
    INTO v_chain_count, v_chain_min_revision, v_chain_valid
  FROM authority_chain;
  IF v_chain_count <> v_principal_revision OR v_chain_min_revision <> 1
    OR v_chain_valid IS DISTINCT FROM true OR NOT v_enabled
    OR NOT v_capability_allowed
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM set_config('dasher.retention_principal_id', v_principal_id::text, true);
  PERFORM set_config('dasher.retention_principal_revision', v_principal_revision::text, true);
  PERFORM set_config('dasher.retention_authority_scope', v_authority_scope, true);
  PERFORM set_config('dasher.retention_capability', 'initialize', true);
  PERFORM set_config('dasher.retention_target_dashboard_id', $1::text, true);
  PERFORM set_config('dasher.retention_request_id', $3::text, true);
  PERFORM set_config('dasher.retention_case_matter_reference', $4, true);
  PERFORM set_config('dasher.retention_phase', 'target_discovery', true);
  SELECT organization_id INTO v_target_organization_id
  FROM dasher.dashboards
  WHERE dashboard_id = $1;
  IF NOT FOUND OR (
    v_authority_scope = 'tenant_legal_admin'
    AND v_scope_organization_id IS DISTINCT FROM v_target_organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_organization_gate := hashtextextended(
    'dasher:organization:v1|' || v_target_organization_id::text,
    0
  );
  PERFORM pg_advisory_xact_lock(v_organization_gate);
  PERFORM set_config(
    'dasher.retention_target_organization_id',
    v_target_organization_id::text,
    true
  );
  PERFORM set_config('dasher.retention_capability', $2, true);
  PERFORM set_config('dasher.retention_phase', 'authorized', true);
  PERFORM 1 FROM dasher.dashboards
  WHERE organization_id = v_target_organization_id AND dashboard_id = $1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
END
`,
  "dasher_retention_api.materialize_dashboard_expiry": `
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR current_setting('dasher.retention_capability', true) <> 'materialize_expiry'
    OR current_setting('dasher.retention_target_dashboard_id', true)::uuid <> $1
    OR $2 < 0 OR $3 IS NULL OR $4 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.can_materialize_expiry
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  UPDATE dasher.dashboards SET lifecycle_state = 'access_revoked',
    access_revoked_at = statement_timestamp(), revocation_reason = 'expired',
    purge_after = statement_timestamp(), lifecycle_revision = lifecycle_revision + 1,
    capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
  WHERE organization_id = current_setting(
      'dasher.retention_target_organization_id', true
    )::uuid
    AND dashboard_id = $1 AND lifecycle_revision = $2
    AND current_kind = 'disposable' AND effective_expires_at <= statement_timestamp()
    AND access_revoked_at IS NULL AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_retention_api.place_dashboard_legal_hold": `
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR current_setting('dasher.retention_capability', true) <> 'place_hold'
    OR current_setting('dasher.retention_target_dashboard_id', true)::uuid <> $1
    OR $2 IS NULL OR $3 IS NULL OR btrim($3) <> $3
    OR char_length($3) NOT BETWEEN 1 AND 200 OR $4 IS NULL
    OR octet_length($4) <> 32 OR $5 < 0 OR $6 IS NULL OR $7 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.can_place_hold
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_legal_holds (
    organization_id, dashboard_id, hold_id, case_matter_reference,
    placed_by_principal_id, placed_authority_revision, placed_actor,
    placed_reason_sha256, placed_at, retention_policy_revision
  ) SELECT organization_id, dashboard_id, $2, $3,
      current_setting('dasher.retention_principal_id', true)::uuid,
      current_setting('dasher.retention_principal_revision', true)::bigint,
      session_user::text, $4, statement_timestamp(), retention_policy_revision
    FROM dasher.dashboards
    WHERE organization_id = current_setting(
        'dasher.retention_target_organization_id', true
      )::uuid
      AND dashboard_id = $1 AND lifecycle_revision = $5 AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_retention_api.release_dashboard_legal_hold": `
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR current_setting('dasher.retention_capability', true) <> 'release_hold'
    OR current_setting('dasher.retention_target_dashboard_id', true)::uuid <> $1
    OR $2 IS NULL OR $3 IS NULL OR octet_length($3) <> 32 OR $4 < 0
    OR $5 IS NULL OR $6 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.can_release_hold
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  UPDATE dasher.dashboard_legal_holds SET released_at = statement_timestamp(),
    released_by_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid,
    released_authority_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint,
    released_actor = session_user::text, released_reason_sha256 = $3
  WHERE organization_id = current_setting(
      'dasher.retention_target_organization_id', true
    )::uuid
    AND dashboard_id = $1 AND hold_id = $2 AND released_at IS NULL
    AND EXISTS (SELECT 1 FROM dasher.dashboards
      WHERE organization_id = current_setting(
          'dasher.retention_target_organization_id', true
        )::uuid
        AND dashboard_id = $1 AND lifecycle_revision = $4);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_retention_api.claim_dashboard_cleanup": `
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR current_setting('dasher.retention_capability', true) <> 'claim_cleanup'
    OR current_setting('dasher.retention_target_dashboard_id', true)::uuid <> $1
    OR $2 IS NULL OR btrim($2) <> $2 OR char_length($2) NOT BETWEEN 1 AND 64
    OR $3 < 0 OR $4 IS NULL OR btrim($4) <> $4
    OR char_length($4) NOT BETWEEN 1 AND 64 OR $5 <= interval '0 seconds'
    OR $6 IS NULL OR $7 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.can_claim_cleanup
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_cleanup_coordination (
    organization_id, dashboard_id, current_step, lease_owner,
    lease_expires_at, expected_lifecycle_revision, next_attempt_at
  ) VALUES (
    current_setting('dasher.retention_target_organization_id', true)::uuid,
    $1, $2, session_user, statement_timestamp() + $5, $3,
    statement_timestamp()
  ) ON CONFLICT (organization_id, dashboard_id) DO UPDATE
    SET current_step = EXCLUDED.current_step, lease_owner = EXCLUDED.lease_owner,
        lease_expires_at = EXCLUDED.lease_expires_at,
        expected_lifecycle_revision = EXCLUDED.expected_lifecycle_revision
    WHERE dasher.dashboard_cleanup_coordination.lease_expires_at IS NULL
       OR dasher.dashboard_cleanup_coordination.lease_expires_at <= statement_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_retention_api.record_dashboard_cleanup_attempt": `
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR current_setting('dasher.retention_capability', true) <> 'record_attempt'
    OR current_setting('dasher.retention_target_dashboard_id', true)::uuid <> $1
    OR $2 IS NULL OR $3 IS NULL OR $4 NOT IN ('succeeded', 'failed', 'deferred')
    OR $5 < 0 OR $6 < 0 OR $7 < 0 OR ($8 IS NOT NULL AND octet_length($8) <> 32)
    OR $9 IS NULL OR $10 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.can_record_attempt
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_cleanup_attempts (
    organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
    finished_at, result, released_claim_count, deleted_resource_count,
    deferred_claim_count, failure_code, proof_sha256
  ) VALUES (
    current_setting('dasher.retention_target_organization_id', true)::uuid,
    $1, $2, $3, statement_timestamp(), statement_timestamp(), $4,
    $5, $6, $7, CASE WHEN $4 = 'failed' THEN 'cleanup_failed' END, $8
  );
  UPDATE dasher.dashboard_cleanup_coordination
  SET lease_owner = NULL, lease_expires_at = NULL,
      next_attempt_at = CASE WHEN $4 = 'succeeded' THEN NULL
        ELSE statement_timestamp() + interval '5 minutes' END,
      completion_proof_sha256 = CASE WHEN $4 = 'succeeded' THEN $8 END
  WHERE organization_id = current_setting(
      'dasher.retention_target_organization_id', true
    )::uuid AND dashboard_id = $1 AND lease_owner = session_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
`,
  "dasher_retention_api.purge_dashboard": `
DECLARE
  v_organization_id uuid := current_setting(
    'dasher.retention_target_organization_id', true
  )::uuid;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR current_setting('dasher.retention_capability', true) <> 'purge'
    OR current_setting('dasher.retention_target_dashboard_id', true)::uuid <> $1
    OR $2 < 0 OR $3 IS NULL OR $4 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.can_purge
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboards
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $2 AND lifecycle_state = 'purge_eligible'
    AND purge_after <= statement_timestamp() AND purged_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM dasher.dashboard_legal_holds
      WHERE organization_id = v_organization_id AND dashboard_id = $1
        AND released_at IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  DELETE FROM dasher.snapshot_reference_claims
    WHERE organization_id = v_organization_id AND dashboard_id = $1;
  DELETE FROM dasher.evidence_reference_claims
    WHERE organization_id = v_organization_id AND dashboard_id = $1;
  DELETE FROM dasher.artifact_reference_claims
    WHERE organization_id = v_organization_id AND dashboard_id = $1;
  UPDATE dasher.dashboards SET lifecycle_state = 'cleaned',
    purged_at = statement_timestamp(), lifecycle_revision = lifecycle_revision + 1,
    capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $2;
END
`,
  "dasher_private.reject_dashboard_append_mutation": `
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE'
    OR TG_OP NOT IN ('UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid append-only trigger invocation';
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'append-only relation rejects update and delete';
END
`,
  "dasher_private.enforce_dashboard_transition": `
DECLARE
  v_phase text := current_setting('dasher.retention_phase', true);
  v_capability text := current_setting('dasher.retention_capability', true);
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE' OR TG_OP <> 'UPDATE'
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.dashboard_id IS DISTINCT FROM NEW.dashboard_id
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_kind IS DISTINCT FROM NEW.created_kind
    OR OLD.original_expires_at IS DISTINCT FROM NEW.original_expires_at
    OR OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision
    OR OLD.tombstone_lineage_id IS DISTINCT FROM NEW.tombstone_lineage_id
    OR OLD.restored_from_tombstone_lineage_id IS DISTINCT FROM NEW.restored_from_tombstone_lineage_id
    OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    OR NEW.cache_epoch < OLD.cache_epoch
    OR NEW.capability_epoch < OLD.capability_epoch
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF current_user = 'dasher_security_definer'::name THEN
    IF dasher_private.context_organization_id() IS DISTINCT FROM OLD.organization_id
      OR dasher_private.context_user_id() IS NULL
      OR OLD.purged_at IS NOT NULL OR NOT (
        (
          NEW.head_version_id IS DISTINCT FROM OLD.head_version_id
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.lifecycle_state,
            NEW.access_revoked_at, NEW.revocation_reason, NEW.purge_after,
            NEW.purge_started_at, NEW.purged_at, NEW.promoted_at,
            NEW.archived_at
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.lifecycle_state,
            OLD.access_revoked_at, OLD.revocation_reason, OLD.purge_after,
            OLD.purge_started_at, OLD.purged_at, OLD.promoted_at,
            OLD.archived_at
          )
          AND NEW.capability_epoch = OLD.capability_epoch
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        ) OR (
          OLD.current_kind = 'disposable' AND NEW.current_kind = 'durable'
          AND NEW.effective_expires_at IS NULL
          AND OLD.promoted_at IS NULL AND NEW.promoted_at IS NOT NULL
          AND ROW(
            NEW.lifecycle_state, NEW.access_revoked_at, NEW.revocation_reason,
            NEW.purge_after, NEW.purge_started_at, NEW.purged_at,
            NEW.archived_at, NEW.head_version_id
          ) IS NOT DISTINCT FROM ROW(
            OLD.lifecycle_state, OLD.access_revoked_at, OLD.revocation_reason,
            OLD.purge_after, OLD.purge_started_at, OLD.purged_at,
            OLD.archived_at, OLD.head_version_id
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        ) OR (
          OLD.current_kind = 'durable'
          AND NEW.current_kind IS NOT DISTINCT FROM OLD.current_kind
          AND (
            (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'archived'
              AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
            OR
            (OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state = 'active'
              AND OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)
          )
          AND ROW(
            NEW.effective_expires_at, NEW.access_revoked_at,
            NEW.revocation_reason, NEW.purge_after, NEW.purge_started_at,
            NEW.purged_at, NEW.promoted_at, NEW.head_version_id
          ) IS NOT DISTINCT FROM ROW(
            OLD.effective_expires_at, OLD.access_revoked_at,
            OLD.revocation_reason, OLD.purge_after, OLD.purge_started_at,
            OLD.purged_at, OLD.promoted_at, OLD.head_version_id
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        ) OR (
          OLD.access_revoked_at IS NULL AND NEW.access_revoked_at IS NOT NULL
          AND NEW.lifecycle_state = 'access_revoked'
          AND NEW.revocation_reason = 'explicit_delete'
          AND NEW.purge_after IS NOT NULL
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at,
            NEW.purge_started_at, NEW.purged_at, NEW.promoted_at,
            NEW.archived_at, NEW.head_version_id
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at,
            OLD.purge_started_at, OLD.purged_at, OLD.promoted_at,
            OLD.archived_at, OLD.head_version_id
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        )
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  ELSIF current_user = 'dasher_retention_definer'::name THEN
    IF v_phase <> 'authorized'
      OR current_setting('dasher.retention_target_organization_id', true)::uuid
        IS DISTINCT FROM OLD.organization_id
      OR current_setting('dasher.retention_target_dashboard_id', true)::uuid
        IS DISTINCT FROM OLD.dashboard_id
      OR v_capability NOT IN ('materialize_expiry', 'purge')
      OR (v_capability = 'materialize_expiry' AND (
        OLD.access_revoked_at IS NOT NULL
        OR NEW.lifecycle_state <> 'access_revoked'
        OR NEW.access_revoked_at IS NULL OR NEW.revocation_reason <> 'expired'
        OR NEW.purge_after IS NULL
        OR ROW(
          NEW.current_kind, NEW.effective_expires_at, NEW.purge_started_at,
          NEW.purged_at, NEW.promoted_at, NEW.archived_at, NEW.head_version_id
        ) IS DISTINCT FROM ROW(
          OLD.current_kind, OLD.effective_expires_at, OLD.purge_started_at,
          OLD.purged_at, OLD.promoted_at, OLD.archived_at, OLD.head_version_id
        )
        OR NEW.capability_epoch <> OLD.capability_epoch + 1
        OR NEW.cache_epoch <> OLD.cache_epoch + 1
      ))
      OR (v_capability = 'purge' AND (
        NEW.lifecycle_state <> 'cleaned' OR NEW.purged_at IS NULL
        OR OLD.lifecycle_state <> 'purge_eligible'
        OR ROW(
          NEW.current_kind, NEW.effective_expires_at, NEW.access_revoked_at,
          NEW.revocation_reason, NEW.purge_after, NEW.purge_started_at,
          NEW.promoted_at, NEW.archived_at, NEW.head_version_id
        ) IS DISTINCT FROM ROW(
          OLD.current_kind, OLD.effective_expires_at, OLD.access_revoked_at,
          OLD.revocation_reason, OLD.purge_after, OLD.purge_started_at,
          OLD.promoted_at, OLD.archived_at, OLD.head_version_id
        )
        OR NEW.capability_epoch <> OLD.capability_epoch + 1
        OR NEW.cache_epoch <> OLD.cache_epoch + 1
      ))
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN NEW;
END
`,
  "dasher_private.enforce_retention_mutation": `
DECLARE
  v_organization_id uuid := current_setting(
    'dasher.retention_target_organization_id', true
  )::uuid;
  v_dashboard_id uuid := current_setting(
    'dasher.retention_target_dashboard_id', true
  )::uuid;
  v_capability text := current_setting('dasher.retention_capability', true);
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE'
    OR TG_OP NOT IN ('UPDATE', 'DELETE')
    OR current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR OLD.organization_id IS DISTINCT FROM v_organization_id
    OR NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS authority
      WHERE authority.retention_service_principal_id = current_setting(
          'dasher.retention_principal_id', true
        )::uuid
        AND authority.principal_revision = current_setting(
          'dasher.retention_principal_revision', true
        )::bigint
        AND authority.binding_kind = 'postgres_session_user'
        AND authority.binding_subject = session_user AND authority.enabled
        AND NOT EXISTS (
          SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
          WHERE later.retention_service_principal_id = authority.retention_service_principal_id
            AND later.principal_revision > authority.principal_revision
        )
        AND CASE v_capability
          WHEN 'purge' THEN authority.can_purge
          ELSE false
        END
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME <> 'dashboard_tombstones'
      OR v_capability <> 'purge'
      OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
      OR OLD.tombstone_lineage_id IS DISTINCT FROM NEW.tombstone_lineage_id
      OR OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision
      OR OLD.access_revoked_at IS DISTINCT FROM NEW.access_revoked_at
      OR OLD.access_revoked_lifecycle_revision IS DISTINCT FROM NEW.access_revoked_lifecycle_revision
      OR OLD.access_revoked_proof_sha256 IS DISTINCT FROM NEW.access_revoked_proof_sha256
      OR NEW.purged_at IS NULL OR NEW.purged_lifecycle_revision IS NULL
      OR NEW.purged_proof_sha256 IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    RETURN NEW;
  END IF;
  IF v_capability <> 'purge' OR NOT (
    (TG_TABLE_NAME IN (
      'dashboard_versions', 'dashboard_version_snapshots',
      'dashboard_version_evidence',
      'snapshot_reference_claims', 'evidence_reference_claims',
      'artifact_reference_claims'
    ) AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id)
    OR
    (TG_TABLE_NAME = 'dashboard_tombstones' AND EXISTS (
      SELECT 1 FROM dasher.dashboards AS target
      WHERE target.organization_id = v_organization_id
        AND target.dashboard_id = v_dashboard_id
        AND target.tombstone_lineage_id = OLD.tombstone_lineage_id
    ))
    OR
    (TG_TABLE_NAME = 'source_snapshots'
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS claim
        WHERE claim.organization_id = OLD.organization_id
          AND claim.snapshot_id = OLD.snapshot_id
      )
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = OLD.organization_id
          AND finalizer.snapshot_id = OLD.snapshot_id
          AND finalizer.state = 'deleted'
          AND finalizer.proof_sha256 IS NOT NULL
          AND finalizer.bytes_deleted_at IS NOT NULL
      ))
    OR
    (TG_TABLE_NAME = 'evidence_records'
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS claim
        WHERE claim.organization_id = OLD.organization_id
          AND claim.evidence_id = OLD.evidence_id
      )
      AND EXISTS (
        SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = OLD.organization_id
          AND finalizer.evidence_id = OLD.evidence_id
          AND finalizer.state = 'deleted'
          AND finalizer.proof_sha256 IS NOT NULL
          AND finalizer.bytes_deleted_at IS NOT NULL
      ))
    OR
    (TG_TABLE_NAME = 'dashboard_artifacts'
      AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS claim
        WHERE claim.organization_id = OLD.organization_id
          AND claim.artifact_id = OLD.artifact_id
      )
      AND EXISTS (
        SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = OLD.organization_id
          AND finalizer.artifact_id = OLD.artifact_id
          AND finalizer.state = 'deleted'
          AND finalizer.proof_sha256 IS NOT NULL
          AND finalizer.bytes_deleted_at IS NOT NULL
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN OLD;
END
`,
};

const task3RelationNames = [
  "audit_events",
  "external_identities",
  "invitations",
  "memberships",
  "organizations",
  "sessions",
  "users",
] as const;

const task4Policies = [
  {
    relation: "audit_events",
    name: "audit_events_select",
    command: "r",
    permissive: true,
    roles: ["dasher_app"],
    usingExpression:
      "dasher_private.context_allows(organization_id, 'admin'::text)",
    withCheckExpression: null,
  },
  {
    relation: "invitations",
    name: "invitations_select",
    command: "r",
    permissive: true,
    roles: ["dasher_app"],
    usingExpression:
      "dasher_private.context_allows(organization_id, 'admin'::text)",
    withCheckExpression: null,
  },
  {
    relation: "memberships",
    name: "memberships_select",
    command: "r",
    permissive: true,
    roles: ["dasher_app"],
    usingExpression:
      "dasher_private.context_allows(organization_id, 'viewer'::text)",
    withCheckExpression: null,
  },
  {
    relation: "organizations",
    name: "organizations_select",
    command: "r",
    permissive: true,
    roles: ["dasher_app"],
    usingExpression:
      "dasher_private.context_allows(organization_id, 'viewer'::text)",
    withCheckExpression: null,
  },
  {
    relation: "sessions",
    name: "sessions_select",
    command: "r",
    permissive: true,
    roles: ["dasher_app"],
    usingExpression:
      "(dasher_private.context_allows(organization_id, 'viewer'::text) AND (dasher_private.context_user_id() = user_id))",
    withCheckExpression: null,
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
  | "file_too_large"
  | "invalid_utf8"
  | "journal_identity_mismatch"
  | "journal_shape_invalid"
  | "malformed_filename"
  | "managed_role_drift"
  | "migration_file_mismatch"
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
  readonly valid_until_is_infinity: boolean;
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
  readonly dependency_type: "a" | "o" | "r";
  readonly function_arguments: string | null;
  readonly grantor_name: string | null;
  readonly is_grantable: boolean | null;
  readonly object_kind:
    "column" | "database" | "function" | "policy" | "relation" | "schema";
  readonly object_name: string;
  readonly policy_command: string | null;
  readonly policy_name: string | null;
  readonly policy_permissive: boolean | null;
  readonly policy_roles: readonly string[] | null;
  readonly policy_using_expression: string | null;
  readonly policy_with_check_expression: string | null;
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

interface AdvisoryUnlockRow {
  readonly unlocked: boolean;
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

function ownErrorDataProperty(error: Error, property: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isConcurrentManagedRoleCreateError(error: unknown): boolean {
  if (nodeTypes.isProxy(error) || !nodeTypes.isNativeError(error)) {
    return false;
  }

  const code = ownErrorDataProperty(error, "code");
  return (
    code === "42710" ||
    (code === "23505" &&
      ownErrorDataProperty(error, "constraint") === "pg_authid_rolname_index" &&
      ownErrorDataProperty(error, "schema") === "pg_catalog" &&
      ownErrorDataProperty(error, "table") === "pg_authid")
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

function destroyClientAfterGateReleaseFailure(
  client: MigrationClient,
  state: MigrationClientState,
  operationError: unknown,
): Error {
  const diagnostic = new Error(gateReleaseFailureMessage);
  diagnostic.name = "MigrationGateReleaseError";
  state.normalReleaseAllowed = false;
  state.released = true;
  retainSanitizedRollbackDiagnostic(operationError, diagnostic);

  try {
    client.release(diagnostic);
  } catch {
    // The destructive release was attempted. Preserve the primary failure.
  }
  return diagnostic;
}

function destroyClientAfterAmbiguousGateAcquisition(
  client: MigrationClient,
  state: MigrationClientState,
  operationError: unknown,
): void {
  const diagnostic = new Error(gateAcquisitionFailureMessage);
  diagnostic.name = "MigrationGateAcquisitionError";
  state.normalReleaseAllowed = false;
  state.released = true;
  retainSanitizedRollbackDiagnostic(operationError, diagnostic);

  try {
    client.release(diagnostic);
  } catch {
    // The backend may hold the session lock, so normal pool reuse is forbidden.
  }
}

async function runMigrationTransaction<T>(
  client: MigrationClient,
  state: MigrationClientState,
  operation: () => Promise<T>,
  acquireTransactionGate = true,
): Promise<T> {
  state.normalReleaseAllowed = false;

  try {
    await client.query("BEGIN");
    await client.query(setLocalSearchPathSql);
    if (acquireTransactionGate) {
      await client.query(advisoryTransactionLockSql);
    }
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
      executor.rolname IN (
        'dasher_app',
        'dasher_security_definer',
        'dasher_retention_definer',
        'dasher_retention_operator'
      )
        AS is_managed_role,
      EXISTS (
        SELECT 1
        FROM inherited_roles
        JOIN pg_catalog.pg_roles AS inherited
          ON inherited.oid = inherited_roles.role_oid
        WHERE inherited.rolname IN (
          'dasher_app',
          'dasher_security_definer',
          'dasher_retention_definer',
          'dasher_retention_operator'
        )
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
    allManagedRoleNames.includes(
      row.session_name as (typeof allManagedRoleNames)[number],
    )
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
        role.rolvaliduntil = 'infinity'::timestamptz
          AS valid_until_is_infinity,
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
  expected: ManagedRoleExpectation,
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
    (expected.validUntil === "null"
      ? row.valid_until_is_null
      : row.valid_until_is_infinity) &&
    row.comment === expected.comment &&
    !row.has_settings
  );
}

async function createOrVerifyManagedRole(
  client: MigrationClient,
  expected: ManagedRoleExpectation,
): Promise<void> {
  const before = await readManagedRole(client, expected.name);

  if (before === undefined) {
    await client.query(managedRoleCreateSavepointSql);
    try {
      await client.query(expected.createSql);
    } catch (error) {
      if (!isConcurrentManagedRoleCreateError(error)) {
        throw error;
      }

      await client.query(managedRoleCreateRollbackSql);
      await client.query(managedRoleCreateReleaseSql);
      const winner = await readManagedRole(client, expected.name);
      if (winner === undefined || !roleMatches(winner, expected)) {
        return reject("managed_role_drift");
      }
      return;
    }

    await client.query(managedRoleCreateReleaseSql);
    await client.query(expected.commentSql);
  } else if (!roleMatches(before, expected)) {
    return reject("managed_role_drift");
  }

  const after = await readManagedRole(client, expected.name);
  if (after === undefined || !roleMatches(after, expected)) {
    return reject("managed_role_drift");
  }
}

async function readRetentionRoleNames(
  client: MigrationClient,
): Promise<readonly string[]> {
  const result = await client.query<{ readonly role_name: string }>(`
    SELECT role.rolname::text AS role_name
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname LIKE 'dasher\\_retention\\_%' ESCAPE '\\'
    ORDER BY role.rolname
  `);
  return result.rows.map((row) => row.role_name);
}

async function preparedRetentionRolesAreExact(
  client: MigrationClient,
  allowAbsent: boolean,
): Promise<boolean> {
  const roleNames = await readRetentionRoleNames(client);
  if (roleNames.length === 0 && allowAbsent) {
    return false;
  }
  if (!arraysEqual(roleNames, [...preparedRetentionRoleNames].sort())) {
    return reject("managed_role_drift");
  }

  for (const expected of preparedRetentionRoles) {
    const row = await readManagedRole(client, expected.name);
    if (row === undefined || !roleMatches(row, expected)) {
      return reject("managed_role_drift");
    }
  }
  return true;
}

async function assertPreparedRetentionRolesAbsent(
  client: MigrationClient,
): Promise<void> {
  if ((await readRetentionRoleNames(client)).length !== 0) {
    return reject("managed_role_drift");
  }
}

async function createPreparedRetentionRoles(
  client: MigrationClient,
): Promise<void> {
  for (const expected of preparedRetentionRoles) {
    if ((await readManagedRole(client, expected.name)) !== undefined) {
      return reject("managed_role_drift");
    }
    await client.query(expected.createSql);
    await client.query(expected.commentSql);
    const row = await readManagedRole(client, expected.name);
    if (row === undefined || !roleMatches(row, expected)) {
      return reject("managed_role_drift");
    }
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
  const targetRoleNames = [
    ...allManagedRoleNames,
    ...expectedAppLoginRoleNames,
  ];
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

async function baseManagedRolesAreMissing(
  client: MigrationClient,
): Promise<boolean> {
  const rows = await Promise.all(
    managedRoles.map((role) => readManagedRole(client, role.name)),
  );
  if (rows.every((row) => row === undefined)) {
    return true;
  }
  if (
    rows.some(
      (row, index) =>
        row === undefined || !roleMatches(row, managedRoles[index]!),
    )
  ) {
    return reject("managed_role_drift");
  }
  return false;
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
  let seriesByteLength = 0;

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

function checksumHex(migration: DiscoveredMigration): string {
  return createHash("sha256").update(migration.bytes).digest("hex");
}

function hasExactCanonical0002Files(
  migrations: readonly DiscoveredMigration[],
): boolean {
  return modeledSuccessorFiles.slice(0, 2).every((expected, index) => {
    const migration = migrations[index];
    return (
      migration !== undefined &&
      migration.sequence === index + 1 &&
      migration.filename === expected.filename &&
      checksumHex(migration) === expected.checksum
    );
  });
}

function assertKnownCanonicalFileIdentity(
  migrations: readonly DiscoveredMigration[],
): void {
  const firstTwo = migrations.slice(0, 2);
  const canonicalNames = new Set<string>(
    modeledSuccessorFiles.slice(0, 2).map((entry) => entry.filename),
  );
  const canonicalChecksums = new Set<string>(
    modeledSuccessorFiles.slice(0, 2).map((entry) => entry.checksum),
  );
  const usesCanonicalIdentity = firstTwo.some(
    (migration) =>
      canonicalNames.has(
        migration.filename as (typeof modeledSuccessorFiles)[0]["filename"],
      ) || canonicalChecksums.has(checksumHex(migration)),
  );
  if (!usesCanonicalIdentity) {
    return;
  }

  for (const [index, expected] of modeledSuccessorFiles.slice(0, 2).entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      migration.filename !== expected.filename ||
      checksumHex(migration) !== expected.checksum
    ) {
      return reject("migration_file_mismatch");
    }
  }
}

function hasModeledSuccessor(
  migrations: readonly DiscoveredMigration[],
): boolean {
  if (migrations.length < 3) {
    return false;
  }
  if (migrations.length !== modeledSuccessorFiles.length) {
    return reject("migration_file_mismatch");
  }
  for (const [index, expected] of modeledSuccessorFiles.entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      migration.sequence !== index + 1 ||
      migration.filename !== expected.filename ||
      checksumHex(migration) !== expected.checksum
    ) {
      return reject("migration_file_mismatch");
    }
  }
  return true;
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
        WHERE nspname IN (
          'dasher',
          'dasher_api',
          'dasher_meta',
          'dasher_private',
          'dasher_retention_api'
        )
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

const task4FunctionCatalogRows = [
  {
    identity:
      "dasher_api.accept_invitation(smallint, bytea, text, text, text, boolean, uuid, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text)",
    result:
      "TABLE(user_id uuid, organization_id uuid, membership_id uuid, granted_role text, authority_revision bigint, session_id uuid, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.change_membership_role(uuid, text, uuid, smallint, bytea, text)",
    result: "TABLE(membership_id uuid, authority_revision bigint)",
    volatility: "v",
  },
  {
    identity: "dasher_api.initialize_context(smallint, bytea, uuid)",
    result:
      "TABLE(session_id uuid, user_id uuid, organization_id uuid, membership_id uuid, authority_revision bigint, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.issue_invitation(uuid, text, text, smallint, bytea, uuid, smallint, bytea, smallint, bytea, uuid, text)",
    result: "TABLE(invitation_id uuid, expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.issue_session(text, text, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text)",
    result:
      "TABLE(user_id uuid, organization_id uuid, membership_id uuid, granted_role text, authority_revision bigint, session_id uuid, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.revoke_invitation(uuid, uuid, smallint, bytea, smallint, bytea, uuid, text)",
    result: "TABLE(invitation_id uuid, revoked_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity: "dasher_api.revoke_membership(uuid, uuid, smallint, bytea, text)",
    result:
      "TABLE(membership_id uuid, authority_revision bigint, revoked_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity: "dasher_api.revoke_session(uuid, uuid, smallint, bytea, text)",
    result: "TABLE(session_id uuid, revoked_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity:
      "dasher_api.rotate_session(uuid, smallint, bytea, smallint, bytea, uuid, smallint, bytea, text)",
    result:
      "TABLE(session_id uuid, idle_expires_at timestamp with time zone, absolute_expires_at timestamp with time zone)",
    volatility: "v",
  },
  {
    identity: "dasher_private.context_allows(uuid, text)",
    result: "boolean",
    volatility: "v",
  },
  {
    identity: "dasher_private.context_authority_revision()",
    result: "bigint",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_membership_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_organization_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_request_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_session_id()",
    result: "uuid",
    volatility: "s",
  },
  {
    identity: "dasher_private.context_user_id()",
    result: "uuid",
    volatility: "s",
  },
] as const;

const canonicalFunctionBodyMd5 = {
  "dasher_private.reject_immutable_mutation":
    "40e81df18fc499c660d020c178954bf8",
  "dasher_private.context_user_id": "e34f8c4b7804f11eb80c971f7591f9a4",
  "dasher_api.rotate_session": "5ac9f6b419ea1528168faa7dbfdff6d6",
  "dasher_api.revoke_session": "e84a368f6fb7a601e6beb0952a01a641",
  "dasher_api.change_membership_role": "88045ab7701082e7a29d6516da39ddd7",
  "dasher_api.revoke_membership": "22e53d6610c6c5c85c3cfd7a7400cc24",
  "dasher_api.issue_invitation": "ceb4038d33a971508d4dc45063c843c7",
  "dasher_api.accept_invitation": "e73059f200272395fa7763489ab2b543",
  "dasher_api.revoke_invitation": "2531f503920264bdaafbf84c8f6f1ce6",
  "dasher_private.context_organization_id": "af355814b4b68be7ca4df4c2d50e4686",
  "dasher_private.context_membership_id": "a2ee6c09bec333e9bd61ac5a1e982ac2",
  "dasher_private.context_session_id": "7a083a1a92537a070ded8b1d0a56aed7",
  "dasher_private.context_request_id": "03f00f181a351dfa41a982176c3db0ac",
  "dasher_private.context_authority_revision":
    "dd9a9e5757a34195eca4140982a73ec0",
  "dasher_private.context_allows": "2524cac52ea26ee40eabe81e394560b0",
  "dasher_api.initialize_context": "47b6069e7d2f976ed2be93a310e65303",
  "dasher_api.issue_session": "3ac5e71b88a4e2a911ebafb3cd97abc3",
} as const;

const modeled0003StaticCatalogContractBase = {
  schemas: [
    {
      name: "dasher_retention_api",
      owner: "migration_owner",
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "CREATE",
          isGrantable: false,
        },
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
        {
          grantor: "migration_owner",
          grantee: "dasher_retention_operator",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
  ],
  relations: [
    {
      schema: "dasher",
      name: "dashboard_lifecycle_policies",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboards",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_lifecycle_events",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_promotion_requests",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_promotion_decisions",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_cleanup_coordination",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_cleanup_attempts",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_legal_holds",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_tombstones",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_restore_lineage",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "backup_deletion_ledger",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "retention_service_principal_allowlist",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "source_snapshots",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "evidence_records",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_versions",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_version_snapshots",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_version_evidence",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "dashboard_artifacts",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "snapshot_reference_claims",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "evidence_reference_claims",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "artifact_reference_claims",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "snapshot_deletion_finalizers",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "evidence_deletion_finalizers",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
    {
      schema: "dasher",
      name: "artifact_deletion_finalizers",
      kind: "r",
      owner: "migration_owner",
      persistence: "p",
      rowSecurity: true,
      forceRowSecurity: true,
      replicaIdentity: "d",
      options: [],
    },
  ],
  columns: [
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "policy_revision",
      ordinal: 2,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "default_disposable_ttl_seconds",
      ordinal: 3,
      type: "integer",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "retention_policy_revision",
      ordinal: 4,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "created_at",
      ordinal: 5,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "created_by_user_id",
      ordinal: 6,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_policies",
      columnName: "provenance",
      ordinal: 7,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "title",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "created_by_user_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "created_at",
      ordinal: 5,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "created_kind",
      ordinal: 6,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "current_kind",
      ordinal: 7,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "original_expires_at",
      ordinal: 8,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "effective_expires_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "lifecycle_state",
      ordinal: 10,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "lifecycle_revision",
      ordinal: 11,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "capability_epoch",
      ordinal: 12,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "cache_epoch",
      ordinal: 13,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "access_revoked_at",
      ordinal: 14,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "revocation_reason",
      ordinal: 15,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "purge_after",
      ordinal: 16,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "purge_started_at",
      ordinal: 17,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "purged_at",
      ordinal: 18,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "retention_policy_revision",
      ordinal: 19,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "promoted_at",
      ordinal: 20,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "archived_at",
      ordinal: 21,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "head_version_id",
      ordinal: 22,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "tombstone_lineage_id",
      ordinal: 23,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboards",
      columnName: "restored_from_tombstone_lineage_id",
      ordinal: 24,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "lifecycle_event_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "organization_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "dashboard_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "lifecycle_revision",
      ordinal: 4,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "event_kind",
      ordinal: 5,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "from_kind",
      ordinal: 6,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "to_kind",
      ordinal: 7,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "from_state",
      ordinal: 8,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "to_state",
      ordinal: 9,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "occurred_at",
      ordinal: 10,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "actor_user_id",
      ordinal: 11,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "actor_service",
      ordinal: 12,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "authority_revision",
      ordinal: 13,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "retention_policy_revision",
      ordinal: 14,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "request_id",
      ordinal: 15,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "job_id",
      ordinal: 16,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_lifecycle_events",
      columnName: "reason_sha256",
      ordinal: 17,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "promotion_request_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "dashboard_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "requested_lifecycle_revision",
      ordinal: 4,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "requested_at",
      ordinal: 5,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "requested_by_user_id",
      ordinal: 6,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_requests",
      columnName: "rationale_sha256",
      ordinal: 7,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "promotion_request_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "decision",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "dashboard_lifecycle_revision",
      ordinal: 4,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "decided_at",
      ordinal: 5,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "requested_by_user_id",
      ordinal: 6,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "decided_by_user_id",
      ordinal: 7,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_promotion_decisions",
      columnName: "retention_policy_revision",
      ordinal: 8,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "current_step",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "lease_owner",
      ordinal: 4,
      type: "name",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "lease_expires_at",
      ordinal: 5,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "expected_lifecycle_revision",
      ordinal: 6,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "next_attempt_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_coordination",
      columnName: "completion_proof_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "cleanup_attempt_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "step",
      ordinal: 4,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "started_at",
      ordinal: 5,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "finished_at",
      ordinal: 6,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "result",
      ordinal: 7,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "released_claim_count",
      ordinal: 8,
      type: "integer",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "deleted_resource_count",
      ordinal: 9,
      type: "integer",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "deferred_claim_count",
      ordinal: 10,
      type: "integer",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "failure_code",
      ordinal: 11,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_cleanup_attempts",
      columnName: "proof_sha256",
      ordinal: 12,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "hold_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "case_matter_reference",
      ordinal: 4,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "placed_by_principal_id",
      ordinal: 5,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "placed_authority_revision",
      ordinal: 6,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "placed_actor",
      ordinal: 7,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "placed_reason_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "placed_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "retention_policy_revision",
      ordinal: 10,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "released_at",
      ordinal: 11,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "released_by_principal_id",
      ordinal: 12,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "released_authority_revision",
      ordinal: 13,
      type: "bigint",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "released_actor",
      ordinal: 14,
      type: "text",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_legal_holds",
      columnName: "released_reason_sha256",
      ordinal: 15,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "tombstone_lineage_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "retention_policy_revision",
      ordinal: 3,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "access_revoked_at",
      ordinal: 4,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "access_revoked_lifecycle_revision",
      ordinal: 5,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "access_revoked_proof_sha256",
      ordinal: 6,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "purged_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "purged_lifecycle_revision",
      ordinal: 8,
      type: "bigint",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_tombstones",
      columnName: "purged_proof_sha256",
      ordinal: 9,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "version_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "source_tombstone_lineage_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "source_version_id",
      ordinal: 5,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "retention_policy_revision",
      ordinal: 6,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "actor_user_id",
      ordinal: 7,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "authority_revision",
      ordinal: 8,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "occurred_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_restore_lineage",
      columnName: "provenance_sha256",
      ordinal: 10,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "ledger_sequence",
      ordinal: 2,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "tombstone_lineage_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "lifecycle_revision",
      ordinal: 4,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "event_kind",
      ordinal: 5,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "event_occurred_at",
      ordinal: 6,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "inserted_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "retention_policy_revision",
      ordinal: 8,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "backup_deletion_ledger",
      columnName: "proof_sha256",
      ordinal: 9,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "retention_service_principal_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "principal_revision",
      ordinal: 2,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "binding_kind",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "binding_subject",
      ordinal: 4,
      type: "name",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "authority_scope",
      ordinal: 5,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "scope_organization_id",
      ordinal: 6,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_initialize",
      ordinal: 7,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_materialize_expiry",
      ordinal: 8,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_place_hold",
      ordinal: 9,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_release_hold",
      ordinal: 10,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_claim_cleanup",
      ordinal: 11,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_record_attempt",
      ordinal: 12,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "can_purge",
      ordinal: 13,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "enabled",
      ordinal: 14,
      type: "boolean",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "created_at",
      ordinal: 15,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "predecessor_revision",
      ordinal: 16,
      type: "bigint",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "predecessor_sha256",
      ordinal: 17,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "revision_sha256",
      ordinal: 18,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "retention_service_principal_allowlist",
      columnName: "migration_provenance",
      ordinal: 19,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "snapshot_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "source_kind",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "canonical_bytes",
      ordinal: 4,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "content_sha256",
      ordinal: 5,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "observed_at",
      ordinal: 6,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "retrieved_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "source_snapshots",
      columnName: "created_at",
      ordinal: 8,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "evidence_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "snapshot_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "evidence_kind",
      ordinal: 4,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "coordinates",
      ordinal: 5,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "transformation",
      ordinal: 6,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "content_sha256",
      ordinal: 7,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "observed_at",
      ordinal: 8,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "retrieved_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_records",
      columnName: "created_at",
      ordinal: 10,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "version_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "parent_version_id",
      ordinal: 4,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "canonical_spec_bytes",
      ordinal: 5,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "canonical_spec_sha256",
      ordinal: 6,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "validation_state",
      ordinal: 7,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "validation_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "planner_provenance_sha256",
      ordinal: 9,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "policy_revision",
      ordinal: 10,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "registry_revision",
      ordinal: 11,
      type: "bigint",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "calculation_graph_sha256",
      ordinal: 12,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "created_by_user_id",
      ordinal: 13,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_versions",
      columnName: "created_at",
      ordinal: 14,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_snapshots",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_snapshots",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_snapshots",
      columnName: "version_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_snapshots",
      columnName: "snapshot_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_evidence",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_evidence",
      columnName: "dashboard_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_evidence",
      columnName: "version_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_version_evidence",
      columnName: "evidence_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "artifact_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "dashboard_id",
      ordinal: 3,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "version_id",
      ordinal: 4,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "ownership_class",
      ordinal: 5,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "artifact_kind",
      ordinal: 6,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "metadata_sha256",
      ordinal: 7,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "content_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "dashboard_artifacts",
      columnName: "created_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "snapshot_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "reference_claim_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "dashboard_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "version_id",
      ordinal: 5,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "claim_kind",
      ordinal: 6,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "hold_id",
      ordinal: 7,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_reference_claims",
      columnName: "created_at",
      ordinal: 8,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "evidence_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "reference_claim_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "dashboard_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "version_id",
      ordinal: 5,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "claim_kind",
      ordinal: 6,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "hold_id",
      ordinal: 7,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_reference_claims",
      columnName: "created_at",
      ordinal: 8,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "artifact_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "reference_claim_id",
      ordinal: 3,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "dashboard_id",
      ordinal: 4,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "version_id",
      ordinal: 5,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "claim_kind",
      ordinal: 6,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "hold_id",
      ordinal: 7,
      type: "uuid",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_reference_claims",
      columnName: "created_at",
      ordinal: 8,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "snapshot_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "state",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "intent_at",
      ordinal: 4,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "expected_claim_set_sha256",
      ordinal: 5,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "lease_owner",
      ordinal: 6,
      type: "name",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "lease_expires_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "proof_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "snapshot_deletion_finalizers",
      columnName: "bytes_deleted_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "evidence_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "state",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "intent_at",
      ordinal: 4,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "expected_claim_set_sha256",
      ordinal: 5,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "lease_owner",
      ordinal: 6,
      type: "name",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "lease_expires_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "proof_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "evidence_deletion_finalizers",
      columnName: "bytes_deleted_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "organization_id",
      ordinal: 1,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "artifact_id",
      ordinal: 2,
      type: "uuid",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "state",
      ordinal: 3,
      type: "text",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "intent_at",
      ordinal: 4,
      type: "timestamp with time zone",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "expected_claim_set_sha256",
      ordinal: 5,
      type: "bytea",
      nullable: false,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "lease_owner",
      ordinal: 6,
      type: "name",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "lease_expires_at",
      ordinal: 7,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "proof_sha256",
      ordinal: 8,
      type: "bytea",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
    {
      relationName: "artifact_deletion_finalizers",
      columnName: "bytes_deleted_at",
      ordinal: 9,
      type: "timestamp with time zone",
      nullable: true,
      defaultExpression: null,
      generated: "",
      identity: "",
    },
  ],
  types: [
    {
      schema: "dasher",
      name: "dashboard_summary",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_summary",
      definition: [
        "dashboard_id uuid",
        "title text",
        "current_kind text",
        "lifecycle_state text",
        "lifecycle_revision bigint",
        "effective_expires_at timestamptz",
        "head_version_id uuid",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_version_projection",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_version_projection",
      definition: [
        "dashboard_id uuid",
        "version_id uuid",
        "parent_version_id uuid",
        "canonical_spec_sha256 bytea",
        "validation_state text",
        "validation_sha256 bytea",
        "planner_provenance_sha256 bytea",
        "policy_revision bigint",
        "registry_revision bigint",
        "calculation_graph_sha256 bytea",
        "created_at timestamptz",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_evidence_projection",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_evidence_projection",
      definition: [
        "dashboard_id uuid",
        "version_id uuid",
        "evidence_id uuid",
        "evidence_kind text",
        "content_sha256 bytea",
        "observed_at timestamptz",
        "retrieved_at timestamptz",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_lineage_projection",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_lineage_projection",
      definition: [
        "dashboard_id uuid",
        "version_id uuid",
        "parent_version_id uuid",
        "snapshot_id uuid",
        "evidence_id uuid",
        "artifact_id uuid",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_admin_projection",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_admin_projection",
      definition: [
        "dashboard_id uuid",
        "lifecycle_state text",
        "lifecycle_revision bigint",
        "capability_epoch bigint",
        "cache_epoch bigint",
        "access_revoked_at timestamptz",
        "purge_after timestamptz",
        "purge_started_at timestamptz",
        "purged_at timestamptz",
        "active_hold_count bigint",
        "cleanup_step text",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_lifecycle_policies",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_lifecycle_policies",
      definition: [
        "organization_id uuid",
        "policy_revision bigint",
        "default_disposable_ttl_seconds integer",
        "retention_policy_revision bigint",
        "created_at timestamp with time zone",
        "created_by_user_id uuid",
        "provenance text",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboards",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboards",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "title text",
        "created_by_user_id uuid",
        "created_at timestamp with time zone",
        "created_kind text",
        "current_kind text",
        "original_expires_at timestamp with time zone",
        "effective_expires_at timestamp with time zone",
        "lifecycle_state text",
        "lifecycle_revision bigint",
        "capability_epoch bigint",
        "cache_epoch bigint",
        "access_revoked_at timestamp with time zone",
        "revocation_reason text",
        "purge_after timestamp with time zone",
        "purge_started_at timestamp with time zone",
        "purged_at timestamp with time zone",
        "retention_policy_revision bigint",
        "promoted_at timestamp with time zone",
        "archived_at timestamp with time zone",
        "head_version_id uuid",
        "tombstone_lineage_id uuid",
        "restored_from_tombstone_lineage_id uuid",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_lifecycle_events",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_lifecycle_events",
      definition: [
        "lifecycle_event_id uuid",
        "organization_id uuid",
        "dashboard_id uuid",
        "lifecycle_revision bigint",
        "event_kind text",
        "from_kind text",
        "to_kind text",
        "from_state text",
        "to_state text",
        "occurred_at timestamp with time zone",
        "actor_user_id uuid",
        "actor_service text",
        "authority_revision bigint",
        "retention_policy_revision bigint",
        "request_id uuid",
        "job_id uuid",
        "reason_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_promotion_requests",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_promotion_requests",
      definition: [
        "organization_id uuid",
        "promotion_request_id uuid",
        "dashboard_id uuid",
        "requested_lifecycle_revision bigint",
        "requested_at timestamp with time zone",
        "requested_by_user_id uuid",
        "rationale_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_promotion_decisions",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_promotion_decisions",
      definition: [
        "organization_id uuid",
        "promotion_request_id uuid",
        "decision text",
        "dashboard_lifecycle_revision bigint",
        "decided_at timestamp with time zone",
        "requested_by_user_id uuid",
        "decided_by_user_id uuid",
        "retention_policy_revision bigint",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_cleanup_coordination",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_cleanup_coordination",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "current_step text",
        "lease_owner name",
        "lease_expires_at timestamp with time zone",
        "expected_lifecycle_revision bigint",
        "next_attempt_at timestamp with time zone",
        "completion_proof_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_cleanup_attempts",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_cleanup_attempts",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "cleanup_attempt_id uuid",
        "step text",
        "started_at timestamp with time zone",
        "finished_at timestamp with time zone",
        "result text",
        "released_claim_count integer",
        "deleted_resource_count integer",
        "deferred_claim_count integer",
        "failure_code text",
        "proof_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_legal_holds",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_legal_holds",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "hold_id uuid",
        "case_matter_reference text",
        "placed_by_principal_id uuid",
        "placed_authority_revision bigint",
        "placed_actor text",
        "placed_reason_sha256 bytea",
        "placed_at timestamp with time zone",
        "retention_policy_revision bigint",
        "released_at timestamp with time zone",
        "released_by_principal_id uuid",
        "released_authority_revision bigint",
        "released_actor text",
        "released_reason_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_tombstones",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_tombstones",
      definition: [
        "organization_id uuid",
        "tombstone_lineage_id uuid",
        "retention_policy_revision bigint",
        "access_revoked_at timestamp with time zone",
        "access_revoked_lifecycle_revision bigint",
        "access_revoked_proof_sha256 bytea",
        "purged_at timestamp with time zone",
        "purged_lifecycle_revision bigint",
        "purged_proof_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_restore_lineage",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_restore_lineage",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "source_tombstone_lineage_id uuid",
        "source_version_id uuid",
        "retention_policy_revision bigint",
        "actor_user_id uuid",
        "authority_revision bigint",
        "occurred_at timestamp with time zone",
        "provenance_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "backup_deletion_ledger",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "backup_deletion_ledger",
      definition: [
        "organization_id uuid",
        "ledger_sequence bigint",
        "tombstone_lineage_id uuid",
        "lifecycle_revision bigint",
        "event_kind text",
        "event_occurred_at timestamp with time zone",
        "inserted_at timestamp with time zone",
        "retention_policy_revision bigint",
        "proof_sha256 bytea",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "retention_service_principal_allowlist",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "retention_service_principal_allowlist",
      definition: [
        "retention_service_principal_id uuid",
        "principal_revision bigint",
        "binding_kind text",
        "binding_subject name",
        "authority_scope text",
        "scope_organization_id uuid",
        "can_initialize boolean",
        "can_materialize_expiry boolean",
        "can_place_hold boolean",
        "can_release_hold boolean",
        "can_claim_cleanup boolean",
        "can_record_attempt boolean",
        "can_purge boolean",
        "enabled boolean",
        "created_at timestamp with time zone",
        "predecessor_revision bigint",
        "predecessor_sha256 bytea",
        "revision_sha256 bytea",
        "migration_provenance text",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "source_snapshots",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "source_snapshots",
      definition: [
        "organization_id uuid",
        "snapshot_id uuid",
        "source_kind text",
        "canonical_bytes bytea",
        "content_sha256 bytea",
        "observed_at timestamp with time zone",
        "retrieved_at timestamp with time zone",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "evidence_records",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "evidence_records",
      definition: [
        "organization_id uuid",
        "evidence_id uuid",
        "snapshot_id uuid",
        "evidence_kind text",
        "coordinates text",
        "transformation text",
        "content_sha256 bytea",
        "observed_at timestamp with time zone",
        "retrieved_at timestamp with time zone",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_versions",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_versions",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "parent_version_id uuid",
        "canonical_spec_bytes bytea",
        "canonical_spec_sha256 bytea",
        "validation_state text",
        "validation_sha256 bytea",
        "planner_provenance_sha256 bytea",
        "policy_revision bigint",
        "registry_revision bigint",
        "calculation_graph_sha256 bytea",
        "created_by_user_id uuid",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_version_snapshots",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_version_snapshots",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "snapshot_id uuid",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_version_evidence",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_version_evidence",
      definition: [
        "organization_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "evidence_id uuid",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "dashboard_artifacts",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "dashboard_artifacts",
      definition: [
        "organization_id uuid",
        "artifact_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "ownership_class text",
        "artifact_kind text",
        "metadata_sha256 bytea",
        "content_sha256 bytea",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "snapshot_reference_claims",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "snapshot_reference_claims",
      definition: [
        "organization_id uuid",
        "snapshot_id uuid",
        "reference_claim_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "claim_kind text",
        "hold_id uuid",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "evidence_reference_claims",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "evidence_reference_claims",
      definition: [
        "organization_id uuid",
        "evidence_id uuid",
        "reference_claim_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "claim_kind text",
        "hold_id uuid",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "artifact_reference_claims",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "artifact_reference_claims",
      definition: [
        "organization_id uuid",
        "artifact_id uuid",
        "reference_claim_id uuid",
        "dashboard_id uuid",
        "version_id uuid",
        "claim_kind text",
        "hold_id uuid",
        "created_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "snapshot_deletion_finalizers",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "snapshot_deletion_finalizers",
      definition: [
        "organization_id uuid",
        "snapshot_id uuid",
        "state text",
        "intent_at timestamp with time zone",
        "expected_claim_set_sha256 bytea",
        "lease_owner name",
        "lease_expires_at timestamp with time zone",
        "proof_sha256 bytea",
        "bytes_deleted_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "evidence_deletion_finalizers",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "evidence_deletion_finalizers",
      definition: [
        "organization_id uuid",
        "evidence_id uuid",
        "state text",
        "intent_at timestamp with time zone",
        "expected_claim_set_sha256 bytea",
        "lease_owner name",
        "lease_expires_at timestamp with time zone",
        "proof_sha256 bytea",
        "bytes_deleted_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
    {
      schema: "dasher",
      name: "artifact_deletion_finalizers",
      kind: "c",
      category: "C",
      owner: "migration_owner",
      relation: "artifact_deletion_finalizers",
      definition: [
        "organization_id uuid",
        "artifact_id uuid",
        "state text",
        "intent_at timestamp with time zone",
        "expected_claim_set_sha256 bytea",
        "lease_owner name",
        "lease_expires_at timestamp with time zone",
        "proof_sha256 bytea",
        "bytes_deleted_at timestamp with time zone",
      ],
      acl: [
        {
          grantor: "migration_owner",
          grantee: "migration_owner",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
  ],
  sequences: [],
  indexes: [
    {
      name: "dashboard_lifecycle_policies_pkey",
      relation: "dashboard_lifecycle_policies",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "policy_revision"],
      opclasses: ["uuid_ops", "int8_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboards_pkey",
      relation: "dashboards",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_lifecycle_events_pkey",
      relation: "dashboard_lifecycle_events",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id", "lifecycle_revision"],
      opclasses: ["uuid_ops", "uuid_ops", "int8_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_promotion_requests_pkey",
      relation: "dashboard_promotion_requests",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "promotion_request_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_promotion_decisions_pkey",
      relation: "dashboard_promotion_decisions",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "promotion_request_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_cleanup_coordination_pkey",
      relation: "dashboard_cleanup_coordination",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_cleanup_attempts_pkey",
      relation: "dashboard_cleanup_attempts",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id", "cleanup_attempt_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_legal_holds_pkey",
      relation: "dashboard_legal_holds",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id", "hold_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_tombstones_pkey",
      relation: "dashboard_tombstones",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "tombstone_lineage_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_restore_lineage_pkey",
      relation: "dashboard_restore_lineage",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "backup_deletion_ledger_pkey",
      relation: "backup_deletion_ledger",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "ledger_sequence"],
      opclasses: ["uuid_ops", "int8_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "retention_service_principal_allowlist_pkey",
      relation: "retention_service_principal_allowlist",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["retention_service_principal_id", "principal_revision"],
      opclasses: ["uuid_ops", "int8_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "source_snapshots_pkey",
      relation: "source_snapshots",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "snapshot_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "evidence_records_pkey",
      relation: "evidence_records",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "evidence_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_versions_pkey",
      relation: "dashboard_versions",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_version_snapshots_pkey",
      relation: "dashboard_version_snapshots",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: [
        "organization_id",
        "dashboard_id",
        "version_id",
        "snapshot_id",
      ],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0, 0],
    },
    {
      name: "dashboard_version_evidence_pkey",
      relation: "dashboard_version_evidence",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: [
        "organization_id",
        "dashboard_id",
        "version_id",
        "evidence_id",
      ],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0, 0],
    },
    {
      name: "dashboard_artifacts_pkey",
      relation: "dashboard_artifacts",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "artifact_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "snapshot_reference_claims_pkey",
      relation: "snapshot_reference_claims",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "snapshot_id", "reference_claim_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "evidence_reference_claims_pkey",
      relation: "evidence_reference_claims",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "evidence_id", "reference_claim_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "artifact_reference_claims_pkey",
      relation: "artifact_reference_claims",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "artifact_id", "reference_claim_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "snapshot_deletion_finalizers_pkey",
      relation: "snapshot_deletion_finalizers",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "snapshot_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "evidence_deletion_finalizers_pkey",
      relation: "evidence_deletion_finalizers",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "evidence_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "artifact_deletion_finalizers_pkey",
      relation: "artifact_deletion_finalizers",
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: ["organization_id", "artifact_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_lifecycle_policies_organization_fk_idx",
      relation: "dashboard_lifecycle_policies",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id"],
      opclasses: ["uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0],
    },
    {
      name: "dashboards_organization_fk_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id"],
      opclasses: ["uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0],
    },
    {
      name: "dashboards_creator_fk_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["created_by_user_id"],
      opclasses: ["uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0],
    },
    {
      name: "dashboards_head_version_fk_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "head_version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboards_restore_tombstone_fk_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "restored_from_tombstone_lineage_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_lifecycle_events_dashboard_fk_idx",
      relation: "dashboard_lifecycle_events",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_promotion_requests_dashboard_fk_idx",
      relation: "dashboard_promotion_requests",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_promotion_decisions_request_fk_idx",
      relation: "dashboard_promotion_decisions",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "promotion_request_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_cleanup_coordination_dashboard_fk_idx",
      relation: "dashboard_cleanup_coordination",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_cleanup_attempts_dashboard_fk_idx",
      relation: "dashboard_cleanup_attempts",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_legal_holds_dashboard_fk_idx",
      relation: "dashboard_legal_holds",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_restore_lineage_dashboard_version_fk_idx",
      relation: "dashboard_restore_lineage",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_restore_lineage_tombstone_fk_idx",
      relation: "dashboard_restore_lineage",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "source_tombstone_lineage_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "backup_deletion_ledger_tombstone_fk_idx",
      relation: "backup_deletion_ledger",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "tombstone_lineage_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "retention_allowlist_scope_organization_fk_idx",
      relation: "retention_service_principal_allowlist",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["scope_organization_id"],
      opclasses: ["uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0],
    },
    {
      name: "source_snapshots_organization_fk_idx",
      relation: "source_snapshots",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id"],
      opclasses: ["uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0],
    },
    {
      name: "evidence_records_snapshot_fk_idx",
      relation: "evidence_records",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "snapshot_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_versions_dashboard_fk_idx",
      relation: "dashboard_versions",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_versions_parent_fk_idx",
      relation: "dashboard_versions",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "parent_version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_version_snapshots_version_fk_idx",
      relation: "dashboard_version_snapshots",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_version_snapshots_snapshot_fk_idx",
      relation: "dashboard_version_snapshots",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "snapshot_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_version_evidence_version_fk_idx",
      relation: "dashboard_version_evidence",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_version_evidence_evidence_fk_idx",
      relation: "dashboard_version_evidence",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "evidence_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboard_artifacts_version_fk_idx",
      relation: "dashboard_artifacts",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "snapshot_reference_claims_snapshot_fk_idx",
      relation: "snapshot_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "snapshot_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "snapshot_reference_claims_version_fk_idx",
      relation: "snapshot_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "snapshot_reference_claims_hold_fk_idx",
      relation: "snapshot_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "hold_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "evidence_reference_claims_evidence_fk_idx",
      relation: "evidence_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "evidence_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "evidence_reference_claims_version_fk_idx",
      relation: "evidence_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "evidence_reference_claims_hold_fk_idx",
      relation: "evidence_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "hold_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "artifact_reference_claims_artifact_fk_idx",
      relation: "artifact_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "artifact_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "artifact_reference_claims_version_fk_idx",
      relation: "artifact_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "version_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "artifact_reference_claims_hold_fk_idx",
      relation: "artifact_reference_claims",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "hold_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "snapshot_deletion_finalizers_snapshot_fk_idx",
      relation: "snapshot_deletion_finalizers",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "snapshot_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "evidence_deletion_finalizers_evidence_fk_idx",
      relation: "evidence_deletion_finalizers",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "evidence_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "artifact_deletion_finalizers_artifact_fk_idx",
      relation: "artifact_deletion_finalizers",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "artifact_id"],
      opclasses: ["uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0],
    },
    {
      name: "dashboards_effective_expiry_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: [
        "effective_expires_at",
        "organization_id",
        "dashboard_id",
      ],
      opclasses: ["timestamptz_ops", "uuid_ops", "uuid_ops"],
      predicate:
        "((current_kind = 'disposable'::text) AND (access_revoked_at IS NULL) AND (purged_at IS NULL))",
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboards_purge_after_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["purge_after", "organization_id", "dashboard_id"],
      opclasses: ["timestamptz_ops", "uuid_ops", "uuid_ops"],
      predicate: "((purged_at IS NULL) AND (purge_after IS NOT NULL))",
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_cleanup_coordination_next_attempt_idx",
      relation: "dashboard_cleanup_coordination",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["next_attempt_at", "organization_id", "dashboard_id"],
      opclasses: ["timestamptz_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_legal_holds_active_idx",
      relation: "dashboard_legal_holds",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "hold_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: "released_at IS NULL",
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
  ],
  constraints: [
    {
      name: "dashboard_lifecycle_policies_pkey",
      relation: "dashboard_lifecycle_policies",
      type: "PRIMARY KEY",
      columns: ["organization_id", "policy_revision"],
      definition: "PRIMARY KEY (organization_id, policy_revision)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboards_pkey",
      relation: "dashboards",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id"],
      definition: "PRIMARY KEY (organization_id, dashboard_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_lifecycle_events_pkey",
      relation: "dashboard_lifecycle_events",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "lifecycle_revision"],
      definition:
        "PRIMARY KEY (organization_id, dashboard_id, lifecycle_revision)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_promotion_requests_pkey",
      relation: "dashboard_promotion_requests",
      type: "PRIMARY KEY",
      columns: ["organization_id", "promotion_request_id"],
      definition: "PRIMARY KEY (organization_id, promotion_request_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_promotion_decisions_pkey",
      relation: "dashboard_promotion_decisions",
      type: "PRIMARY KEY",
      columns: ["organization_id", "promotion_request_id"],
      definition: "PRIMARY KEY (organization_id, promotion_request_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_cleanup_coordination_pkey",
      relation: "dashboard_cleanup_coordination",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id"],
      definition: "PRIMARY KEY (organization_id, dashboard_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_cleanup_attempts_pkey",
      relation: "dashboard_cleanup_attempts",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "cleanup_attempt_id"],
      definition:
        "PRIMARY KEY (organization_id, dashboard_id, cleanup_attempt_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_legal_holds_pkey",
      relation: "dashboard_legal_holds",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "hold_id"],
      definition: "PRIMARY KEY (organization_id, dashboard_id, hold_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_tombstones_pkey",
      relation: "dashboard_tombstones",
      type: "PRIMARY KEY",
      columns: ["organization_id", "tombstone_lineage_id"],
      definition: "PRIMARY KEY (organization_id, tombstone_lineage_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_restore_lineage_pkey",
      relation: "dashboard_restore_lineage",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      definition: "PRIMARY KEY (organization_id, dashboard_id, version_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "backup_deletion_ledger_pkey",
      relation: "backup_deletion_ledger",
      type: "PRIMARY KEY",
      columns: ["organization_id", "ledger_sequence"],
      definition: "PRIMARY KEY (organization_id, ledger_sequence)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "retention_service_principal_allowlist_pkey",
      relation: "retention_service_principal_allowlist",
      type: "PRIMARY KEY",
      columns: ["retention_service_principal_id", "principal_revision"],
      definition:
        "PRIMARY KEY (retention_service_principal_id, principal_revision)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "source_snapshots_pkey",
      relation: "source_snapshots",
      type: "PRIMARY KEY",
      columns: ["organization_id", "snapshot_id"],
      definition: "PRIMARY KEY (organization_id, snapshot_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_records_pkey",
      relation: "evidence_records",
      type: "PRIMARY KEY",
      columns: ["organization_id", "evidence_id"],
      definition: "PRIMARY KEY (organization_id, evidence_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_versions_pkey",
      relation: "dashboard_versions",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      definition: "PRIMARY KEY (organization_id, dashboard_id, version_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_version_snapshots_pkey",
      relation: "dashboard_version_snapshots",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "version_id", "snapshot_id"],
      definition:
        "PRIMARY KEY (organization_id, dashboard_id, version_id, snapshot_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_version_evidence_pkey",
      relation: "dashboard_version_evidence",
      type: "PRIMARY KEY",
      columns: ["organization_id", "dashboard_id", "version_id", "evidence_id"],
      definition:
        "PRIMARY KEY (organization_id, dashboard_id, version_id, evidence_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_artifacts_pkey",
      relation: "dashboard_artifacts",
      type: "PRIMARY KEY",
      columns: ["organization_id", "artifact_id"],
      definition: "PRIMARY KEY (organization_id, artifact_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "snapshot_reference_claims_pkey",
      relation: "snapshot_reference_claims",
      type: "PRIMARY KEY",
      columns: ["organization_id", "snapshot_id", "reference_claim_id"],
      definition:
        "PRIMARY KEY (organization_id, snapshot_id, reference_claim_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_reference_claims_pkey",
      relation: "evidence_reference_claims",
      type: "PRIMARY KEY",
      columns: ["organization_id", "evidence_id", "reference_claim_id"],
      definition:
        "PRIMARY KEY (organization_id, evidence_id, reference_claim_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "artifact_reference_claims_pkey",
      relation: "artifact_reference_claims",
      type: "PRIMARY KEY",
      columns: ["organization_id", "artifact_id", "reference_claim_id"],
      definition:
        "PRIMARY KEY (organization_id, artifact_id, reference_claim_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "snapshot_deletion_finalizers_pkey",
      relation: "snapshot_deletion_finalizers",
      type: "PRIMARY KEY",
      columns: ["organization_id", "snapshot_id"],
      definition: "PRIMARY KEY (organization_id, snapshot_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_deletion_finalizers_pkey",
      relation: "evidence_deletion_finalizers",
      type: "PRIMARY KEY",
      columns: ["organization_id", "evidence_id"],
      definition: "PRIMARY KEY (organization_id, evidence_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "artifact_deletion_finalizers_pkey",
      relation: "artifact_deletion_finalizers",
      type: "PRIMARY KEY",
      columns: ["organization_id", "artifact_id"],
      definition: "PRIMARY KEY (organization_id, artifact_id)",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_lifecycle_policies_organization_fk",
      relation: "dashboard_lifecycle_policies",
      type: "FOREIGN KEY",
      columns: ["organization_id"],
      targetRelation: "organizations",
      targetColumns: ["organization_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id) REFERENCES dasher.organizations(organization_id)",
    },
    {
      name: "dashboards_organization_fk",
      relation: "dashboards",
      type: "FOREIGN KEY",
      columns: ["organization_id"],
      targetRelation: "organizations",
      targetColumns: ["organization_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id) REFERENCES dasher.organizations(organization_id)",
    },
    {
      name: "dashboards_creator_fk",
      relation: "dashboards",
      type: "FOREIGN KEY",
      columns: ["created_by_user_id"],
      targetRelation: "users",
      targetColumns: ["user_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (created_by_user_id) REFERENCES dasher.users(user_id)",
    },
    {
      name: "dashboards_head_version_fk",
      relation: "dashboards",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "head_version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: true,
      deferrable: true,
      initiallyDeferred: true,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, head_version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id) DEFERRABLE INITIALLY DEFERRED",
    },
    {
      name: "dashboards_restore_tombstone_fk",
      relation: "dashboards",
      type: "FOREIGN KEY",
      columns: ["organization_id", "restored_from_tombstone_lineage_id"],
      targetRelation: "dashboard_tombstones",
      targetColumns: ["organization_id", "tombstone_lineage_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, restored_from_tombstone_lineage_id) REFERENCES dasher.dashboard_tombstones(organization_id, tombstone_lineage_id)",
    },
    {
      name: "dashboard_lifecycle_events_dashboard_fk",
      relation: "dashboard_lifecycle_events",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id"],
      targetRelation: "dashboards",
      targetColumns: ["organization_id", "dashboard_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id)",
    },
    {
      name: "dashboard_promotion_requests_dashboard_fk",
      relation: "dashboard_promotion_requests",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id"],
      targetRelation: "dashboards",
      targetColumns: ["organization_id", "dashboard_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id)",
    },
    {
      name: "dashboard_promotion_decisions_request_fk",
      relation: "dashboard_promotion_decisions",
      type: "FOREIGN KEY",
      columns: ["organization_id", "promotion_request_id"],
      targetRelation: "dashboard_promotion_requests",
      targetColumns: ["organization_id", "promotion_request_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, promotion_request_id) REFERENCES dasher.dashboard_promotion_requests(organization_id, promotion_request_id)",
    },
    {
      name: "dashboard_cleanup_coordination_dashboard_fk",
      relation: "dashboard_cleanup_coordination",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id"],
      targetRelation: "dashboards",
      targetColumns: ["organization_id", "dashboard_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id)",
    },
    {
      name: "dashboard_cleanup_attempts_dashboard_fk",
      relation: "dashboard_cleanup_attempts",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id"],
      targetRelation: "dashboards",
      targetColumns: ["organization_id", "dashboard_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id)",
    },
    {
      name: "dashboard_legal_holds_dashboard_fk",
      relation: "dashboard_legal_holds",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id"],
      targetRelation: "dashboards",
      targetColumns: ["organization_id", "dashboard_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id)",
    },
    {
      name: "dashboard_restore_lineage_dashboard_version_fk",
      relation: "dashboard_restore_lineage",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "dashboard_restore_lineage_tombstone_fk",
      relation: "dashboard_restore_lineage",
      type: "FOREIGN KEY",
      columns: ["organization_id", "source_tombstone_lineage_id"],
      targetRelation: "dashboard_tombstones",
      targetColumns: ["organization_id", "tombstone_lineage_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, source_tombstone_lineage_id) REFERENCES dasher.dashboard_tombstones(organization_id, tombstone_lineage_id)",
    },
    {
      name: "backup_deletion_ledger_tombstone_fk",
      relation: "backup_deletion_ledger",
      type: "FOREIGN KEY",
      columns: ["organization_id", "tombstone_lineage_id"],
      targetRelation: "dashboard_tombstones",
      targetColumns: ["organization_id", "tombstone_lineage_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, tombstone_lineage_id) REFERENCES dasher.dashboard_tombstones(organization_id, tombstone_lineage_id)",
    },
    {
      name: "retention_allowlist_scope_organization_fk",
      relation: "retention_service_principal_allowlist",
      type: "FOREIGN KEY",
      columns: ["scope_organization_id"],
      targetRelation: "organizations",
      targetColumns: ["organization_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (scope_organization_id) REFERENCES dasher.organizations(organization_id)",
    },
    {
      name: "source_snapshots_organization_fk",
      relation: "source_snapshots",
      type: "FOREIGN KEY",
      columns: ["organization_id"],
      targetRelation: "organizations",
      targetColumns: ["organization_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id) REFERENCES dasher.organizations(organization_id)",
    },
    {
      name: "evidence_records_snapshot_fk",
      relation: "evidence_records",
      type: "FOREIGN KEY",
      columns: ["organization_id", "snapshot_id"],
      targetRelation: "source_snapshots",
      targetColumns: ["organization_id", "snapshot_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id)",
    },
    {
      name: "dashboard_versions_dashboard_fk",
      relation: "dashboard_versions",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id"],
      targetRelation: "dashboards",
      targetColumns: ["organization_id", "dashboard_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id)",
    },
    {
      name: "dashboard_versions_parent_fk",
      relation: "dashboard_versions",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "parent_version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, parent_version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "dashboard_version_snapshots_version_fk",
      relation: "dashboard_version_snapshots",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "dashboard_version_snapshots_snapshot_fk",
      relation: "dashboard_version_snapshots",
      type: "FOREIGN KEY",
      columns: ["organization_id", "snapshot_id"],
      targetRelation: "source_snapshots",
      targetColumns: ["organization_id", "snapshot_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id)",
    },
    {
      name: "dashboard_version_evidence_version_fk",
      relation: "dashboard_version_evidence",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "dashboard_version_evidence_evidence_fk",
      relation: "dashboard_version_evidence",
      type: "FOREIGN KEY",
      columns: ["organization_id", "evidence_id"],
      targetRelation: "evidence_records",
      targetColumns: ["organization_id", "evidence_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, evidence_id) REFERENCES dasher.evidence_records(organization_id, evidence_id)",
    },
    {
      name: "dashboard_artifacts_version_fk",
      relation: "dashboard_artifacts",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "snapshot_reference_claims_snapshot_fk",
      relation: "snapshot_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "snapshot_id"],
      targetRelation: "source_snapshots",
      targetColumns: ["organization_id", "snapshot_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id)",
    },
    {
      name: "snapshot_reference_claims_version_fk",
      relation: "snapshot_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "snapshot_reference_claims_hold_fk",
      relation: "snapshot_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "hold_id"],
      targetRelation: "dashboard_legal_holds",
      targetColumns: ["organization_id", "dashboard_id", "hold_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, hold_id) REFERENCES dasher.dashboard_legal_holds(organization_id, dashboard_id, hold_id)",
    },
    {
      name: "evidence_reference_claims_evidence_fk",
      relation: "evidence_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "evidence_id"],
      targetRelation: "evidence_records",
      targetColumns: ["organization_id", "evidence_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, evidence_id) REFERENCES dasher.evidence_records(organization_id, evidence_id)",
    },
    {
      name: "evidence_reference_claims_version_fk",
      relation: "evidence_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "evidence_reference_claims_hold_fk",
      relation: "evidence_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "hold_id"],
      targetRelation: "dashboard_legal_holds",
      targetColumns: ["organization_id", "dashboard_id", "hold_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, hold_id) REFERENCES dasher.dashboard_legal_holds(organization_id, dashboard_id, hold_id)",
    },
    {
      name: "artifact_reference_claims_artifact_fk",
      relation: "artifact_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "artifact_id"],
      targetRelation: "dashboard_artifacts",
      targetColumns: ["organization_id", "artifact_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, artifact_id) REFERENCES dasher.dashboard_artifacts(organization_id, artifact_id)",
    },
    {
      name: "artifact_reference_claims_version_fk",
      relation: "artifact_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "version_id"],
      targetRelation: "dashboard_versions",
      targetColumns: ["organization_id", "dashboard_id", "version_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id)",
    },
    {
      name: "artifact_reference_claims_hold_fk",
      relation: "artifact_reference_claims",
      type: "FOREIGN KEY",
      columns: ["organization_id", "dashboard_id", "hold_id"],
      targetRelation: "dashboard_legal_holds",
      targetColumns: ["organization_id", "dashboard_id", "hold_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, dashboard_id, hold_id) REFERENCES dasher.dashboard_legal_holds(organization_id, dashboard_id, hold_id)",
    },
    {
      name: "snapshot_deletion_finalizers_snapshot_fk",
      relation: "snapshot_deletion_finalizers",
      type: "FOREIGN KEY",
      columns: ["organization_id", "snapshot_id"],
      targetRelation: "source_snapshots",
      targetColumns: ["organization_id", "snapshot_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id)",
    },
    {
      name: "evidence_deletion_finalizers_evidence_fk",
      relation: "evidence_deletion_finalizers",
      type: "FOREIGN KEY",
      columns: ["organization_id", "evidence_id"],
      targetRelation: "evidence_records",
      targetColumns: ["organization_id", "evidence_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, evidence_id) REFERENCES dasher.evidence_records(organization_id, evidence_id)",
    },
    {
      name: "artifact_deletion_finalizers_artifact_fk",
      relation: "artifact_deletion_finalizers",
      type: "FOREIGN KEY",
      columns: ["organization_id", "artifact_id"],
      targetRelation: "dashboard_artifacts",
      targetColumns: ["organization_id", "artifact_id"],
      deferred: false,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      matchType: "s",
      updateAction: "a",
      deleteAction: "a",
      definition:
        "FOREIGN KEY (organization_id, artifact_id) REFERENCES dasher.dashboard_artifacts(organization_id, artifact_id)",
    },
    {
      name: "audit_events_action_check",
      relation: "audit_events",
      type: "CHECK",
      columns: ["action"],
      definition:
        "CHECK (((action)::text = ANY ((ARRAY['membership.role_changed'::character varying, 'membership.revoked'::character varying, 'invitation.issued'::character varying, 'invitation.revoked'::character varying, 'invitation.accepted'::character varying, 'invitation.accepted_existing_membership'::character varying, 'session.issued'::character varying, 'session.rotated'::character varying, 'session.revoked'::character varying, 'source_snapshot.created'::character varying, 'evidence_record.created'::character varying, 'dashboard.created'::character varying, 'dashboard_version.created'::character varying, 'dashboard_head.promoted'::character varying, 'dashboard.promotion_requested'::character varying, 'dashboard.promotion_approved'::character varying, 'dashboard.promotion_denied'::character varying, 'dashboard.expired'::character varying, 'dashboard.archived'::character varying, 'dashboard.unarchived'::character varying, 'dashboard.deleted'::character varying, 'dashboard.restored_as_new'::character varying, 'dashboard.cleanup_started'::character varying, 'dashboard.purge_eligible'::character varying, 'dashboard.legal_hold_placed'::character varying, 'dashboard.legal_hold_released'::character varying, 'dashboard.purged'::character varying, 'dashboard.artifact_created'::character varying])::text[])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_lifecycle_policies_default_ttl_check",
      relation: "dashboard_lifecycle_policies",
      type: "CHECK",
      columns: ["default_disposable_ttl_seconds"],
      definition:
        "CHECK (((default_disposable_ttl_seconds >= 3600) AND (default_disposable_ttl_seconds <= 604800)))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboards_kind_check",
      relation: "dashboards",
      type: "CHECK",
      columns: ["created_kind", "current_kind"],
      definition:
        "CHECK (((created_kind = ANY (ARRAY['disposable'::text, 'durable'::text])) AND (current_kind = ANY (ARRAY['disposable'::text, 'durable'::text]))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboards_lifecycle_state_check",
      relation: "dashboards",
      type: "CHECK",
      columns: ["lifecycle_state"],
      definition:
        "CHECK ((lifecycle_state = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text, 'access_revoked'::text, 'quarantined'::text, 'purge_eligible'::text, 'cleaned'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboards_lifecycle_fences_check",
      relation: "dashboards",
      type: "CHECK",
      columns: [
        "lifecycle_revision",
        "capability_epoch",
        "cache_epoch",
        "retention_policy_revision",
      ],
      definition:
        "CHECK (((lifecycle_revision >= 0) AND (capability_epoch >= 0) AND (cache_epoch >= 0) AND (retention_policy_revision >= 1)))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboards_expiry_kind_check",
      relation: "dashboards",
      type: "CHECK",
      columns: [
        "created_kind",
        "current_kind",
        "original_expires_at",
        "effective_expires_at",
      ],
      definition:
        "CHECK (((created_kind = 'durable'::text) AND (current_kind = 'durable'::text) AND (original_expires_at IS NULL) AND (effective_expires_at IS NULL) OR ((created_kind = 'disposable'::text) AND (original_expires_at IS NOT NULL) AND (((current_kind = 'disposable'::text) AND (effective_expires_at = original_expires_at)) OR ((current_kind = 'durable'::text) AND (effective_expires_at IS NULL))))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboards_revocation_fields_check",
      relation: "dashboards",
      type: "CHECK",
      columns: ["access_revoked_at", "revocation_reason"],
      definition:
        "CHECK (((access_revoked_at IS NULL) = (revocation_reason IS NULL)))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_lifecycle_events_kind_check",
      relation: "dashboard_lifecycle_events",
      type: "CHECK",
      columns: ["event_kind"],
      definition:
        "CHECK ((event_kind = ANY (ARRAY['head_activated'::text, 'head_advanced'::text, 'promotion_approved'::text, 'archived'::text, 'unarchived'::text, 'expired'::text, 'deleted'::text, 'cleanup_started'::text, 'purge_eligible'::text, 'legal_hold_placed'::text, 'legal_hold_released'::text, 'purged'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_promotion_decisions_decision_check",
      relation: "dashboard_promotion_decisions",
      type: "CHECK",
      columns: ["decision"],
      definition:
        "CHECK ((decision = ANY (ARRAY['approved'::text, 'denied'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_promotion_decisions_requester_approver_check",
      relation: "dashboard_promotion_decisions",
      type: "CHECK",
      columns: ["requested_by_user_id", "decided_by_user_id"],
      definition: "CHECK ((requested_by_user_id <> decided_by_user_id))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "retention_allowlist_binding_kind_check",
      relation: "retention_service_principal_allowlist",
      type: "CHECK",
      columns: ["binding_kind"],
      definition: "CHECK ((binding_kind = 'postgres_session_user'::text))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "retention_allowlist_authority_scope_check",
      relation: "retention_service_principal_allowlist",
      type: "CHECK",
      columns: ["authority_scope"],
      definition:
        "CHECK ((authority_scope = ANY (ARRAY['platform_operator'::text, 'tenant_legal_admin'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "retention_allowlist_scope_check",
      relation: "retention_service_principal_allowlist",
      type: "CHECK",
      columns: ["authority_scope", "scope_organization_id"],
      definition:
        "CHECK ((((authority_scope = 'platform_operator'::text) AND (scope_organization_id IS NULL)) OR ((authority_scope = 'tenant_legal_admin'::text) AND (scope_organization_id IS NOT NULL))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "retention_allowlist_predecessor_check",
      relation: "retention_service_principal_allowlist",
      type: "CHECK",
      columns: [
        "principal_revision",
        "predecessor_revision",
        "predecessor_sha256",
      ],
      definition:
        "CHECK (((principal_revision = 1) = ((predecessor_revision IS NULL) AND (predecessor_sha256 IS NULL))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "source_snapshots_source_kind_check",
      relation: "source_snapshots",
      type: "CHECK",
      columns: ["source_kind"],
      definition:
        "CHECK ((source_kind = ANY (ARRAY['synthetic_fixture'::text, 'public_usgs_fixture'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "source_snapshots_canonical_bytes_length_check",
      relation: "source_snapshots",
      type: "CHECK",
      columns: ["canonical_bytes"],
      definition:
        "CHECK (((octet_length(canonical_bytes) >= 1) AND (octet_length(canonical_bytes) <= 1048576)))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_records_evidence_kind_check",
      relation: "evidence_records",
      type: "CHECK",
      columns: ["evidence_kind"],
      definition:
        "CHECK ((evidence_kind = ANY (ARRAY['source_record'::text, 'typed_value'::text, 'calculation_result'::text, 'event_record'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_versions_validation_state_check",
      relation: "dashboard_versions",
      type: "CHECK",
      columns: ["validation_state"],
      definition: "CHECK ((validation_state = 'validated'::text))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "dashboard_artifacts_ownership_class_check",
      relation: "dashboard_artifacts",
      type: "CHECK",
      columns: ["ownership_class"],
      definition:
        "CHECK ((ownership_class = ANY (ARRAY['dashboard_owned'::text, 'shared'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "snapshot_reference_claims_claim_kind_check",
      relation: "snapshot_reference_claims",
      type: "CHECK",
      columns: ["claim_kind"],
      definition:
        "CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "snapshot_reference_claims_hold_check",
      relation: "snapshot_reference_claims",
      type: "CHECK",
      columns: ["claim_kind", "hold_id"],
      definition:
        "CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_reference_claims_claim_kind_check",
      relation: "evidence_reference_claims",
      type: "CHECK",
      columns: ["claim_kind"],
      definition:
        "CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_reference_claims_hold_check",
      relation: "evidence_reference_claims",
      type: "CHECK",
      columns: ["claim_kind", "hold_id"],
      definition:
        "CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "artifact_reference_claims_claim_kind_check",
      relation: "artifact_reference_claims",
      type: "CHECK",
      columns: ["claim_kind"],
      definition:
        "CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "artifact_reference_claims_hold_check",
      relation: "artifact_reference_claims",
      type: "CHECK",
      columns: ["claim_kind", "hold_id"],
      definition:
        "CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "snapshot_deletion_finalizers_state_check",
      relation: "snapshot_deletion_finalizers",
      type: "CHECK",
      columns: ["state"],
      definition:
        "CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "evidence_deletion_finalizers_state_check",
      relation: "evidence_deletion_finalizers",
      type: "CHECK",
      columns: ["state"],
      definition:
        "CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
    {
      name: "artifact_deletion_finalizers_state_check",
      relation: "artifact_deletion_finalizers",
      type: "CHECK",
      columns: ["state"],
      definition:
        "CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])))",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    },
  ],
  triggers: [
    {
      name: "dashboard_lifecycle_policies_immutable",
      relationName: "dashboard_lifecycle_policies",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_lifecycle_policies_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_lifecycle_policies FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "dashboard_lifecycle_events_immutable",
      relationName: "dashboard_lifecycle_events",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_lifecycle_events_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_lifecycle_events FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "dashboard_promotion_requests_immutable",
      relationName: "dashboard_promotion_requests",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_promotion_requests_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_promotion_requests FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "dashboard_promotion_decisions_immutable",
      relationName: "dashboard_promotion_decisions",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_promotion_decisions_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_promotion_decisions FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "dashboard_cleanup_attempts_immutable",
      relationName: "dashboard_cleanup_attempts",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_cleanup_attempts_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_cleanup_attempts FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "dashboard_restore_lineage_immutable",
      relationName: "dashboard_restore_lineage",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_restore_lineage_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_restore_lineage FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "backup_deletion_ledger_immutable",
      relationName: "backup_deletion_ledger",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER backup_deletion_ledger_immutable BEFORE UPDATE OR DELETE ON dasher.backup_deletion_ledger FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "retention_service_principal_allowlist_immutable",
      relationName: "retention_service_principal_allowlist",
      functionIdentity: "dasher_private.reject_dashboard_append_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER retention_service_principal_allowlist_immutable BEFORE UPDATE OR DELETE ON dasher.retention_service_principal_allowlist FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation()",
    },
    {
      name: "dashboards_transition_guard",
      relationName: "dashboards",
      functionIdentity: "dasher_private.enforce_dashboard_transition()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboards_transition_guard BEFORE UPDATE ON dasher.dashboards FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_dashboard_transition()",
    },
    {
      name: "dashboard_tombstones_retention_guard",
      relationName: "dashboard_tombstones",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_tombstones_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_tombstones FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "source_snapshots_retention_guard",
      relationName: "source_snapshots",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER source_snapshots_retention_guard BEFORE UPDATE OR DELETE ON dasher.source_snapshots FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "evidence_records_retention_guard",
      relationName: "evidence_records",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER evidence_records_retention_guard BEFORE UPDATE OR DELETE ON dasher.evidence_records FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "dashboard_versions_retention_guard",
      relationName: "dashboard_versions",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_versions_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_versions FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "dashboard_version_snapshots_retention_guard",
      relationName: "dashboard_version_snapshots",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_version_snapshots_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_version_snapshots FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "dashboard_version_evidence_retention_guard",
      relationName: "dashboard_version_evidence",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_version_evidence_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_version_evidence FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "dashboard_artifacts_retention_guard",
      relationName: "dashboard_artifacts",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER dashboard_artifacts_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_artifacts FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "snapshot_reference_claims_retention_guard",
      relationName: "snapshot_reference_claims",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER snapshot_reference_claims_retention_guard BEFORE UPDATE OR DELETE ON dasher.snapshot_reference_claims FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "evidence_reference_claims_retention_guard",
      relationName: "evidence_reference_claims",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER evidence_reference_claims_retention_guard BEFORE UPDATE OR DELETE ON dasher.evidence_reference_claims FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
    {
      name: "artifact_reference_claims_retention_guard",
      relationName: "artifact_reference_claims",
      functionIdentity: "dasher_private.enforce_retention_mutation()",
      timing: "BEFORE",
      level: "ROW",
      events: ["UPDATE", "DELETE"],
      enabled: "O",
      definition:
        "CREATE TRIGGER artifact_reference_claims_retention_guard BEFORE UPDATE OR DELETE ON dasher.artifact_reference_claims FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation()",
    },
  ],
  policies: [
    {
      name: "retention_service_principal_self_binding_select",
      relation: "retention_service_principal_allowlist",
      command: "SELECT",
      catalogCommand: "r",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: true,
      columns: [
        "retention_service_principal_id",
        "principal_revision",
        "binding_kind",
        "binding_subject",
        "authority_scope",
        "scope_organization_id",
        "can_initialize",
        "can_materialize_expiry",
        "can_place_hold",
        "can_release_hold",
        "can_claim_cleanup",
        "can_record_attempt",
        "can_purge",
        "enabled",
        "created_at",
        "predecessor_revision",
        "predecessor_sha256",
        "revision_sha256",
        "migration_provenance",
      ],
      shutsOffWhenPhase: "target_discovery",
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'binding_lookup'::text) AND (binding_kind = 'postgres_session_user'::text) AND (binding_subject = SESSION_USER))",
      withCheck: null,
    },
    {
      name: "dashboards_retention_target_discovery_select",
      relation: "dashboards",
      command: "SELECT",
      catalogCommand: "r",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: true,
      columns: ["organization_id"],
      shutsOffWhenPhase: "authorized",
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'target_discovery'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = 'initialize'::text) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck: null,
    },
    {
      name: "dashboard_lifecycle_policies_authorized_context",
      relation: "dashboard_lifecycle_policies",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "policy_revision",
        "default_disposable_ttl_seconds",
        "retention_policy_revision",
        "created_at",
        "created_by_user_id",
        "provenance",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "dashboards_authorized_context",
      relation: "dashboards",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "dashboard_id",
        "title",
        "created_by_user_id",
        "created_at",
        "created_kind",
        "current_kind",
        "original_expires_at",
        "effective_expires_at",
        "lifecycle_state",
        "lifecycle_revision",
        "capability_epoch",
        "cache_epoch",
        "access_revoked_at",
        "revocation_reason",
        "purge_after",
        "purge_started_at",
        "purged_at",
        "retention_policy_revision",
        "promoted_at",
        "archived_at",
        "head_version_id",
        "tombstone_lineage_id",
        "restored_from_tombstone_lineage_id",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_lifecycle_events_authorized_context",
      relation: "dashboard_lifecycle_events",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "lifecycle_event_id",
        "organization_id",
        "dashboard_id",
        "lifecycle_revision",
        "event_kind",
        "from_kind",
        "to_kind",
        "from_state",
        "to_state",
        "occurred_at",
        "actor_user_id",
        "actor_service",
        "authority_revision",
        "retention_policy_revision",
        "request_id",
        "job_id",
        "reason_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_promotion_requests_authorized_context",
      relation: "dashboard_promotion_requests",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "promotion_request_id",
        "dashboard_id",
        "requested_lifecycle_revision",
        "requested_at",
        "requested_by_user_id",
        "rationale_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_promotion_decisions_authorized_context",
      relation: "dashboard_promotion_decisions",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "promotion_request_id",
        "decision",
        "dashboard_lifecycle_revision",
        "decided_at",
        "requested_by_user_id",
        "decided_by_user_id",
        "retention_policy_revision",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_cleanup_coordination_authorized_context",
      relation: "dashboard_cleanup_coordination",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "dashboard_id",
        "current_step",
        "lease_owner",
        "lease_expires_at",
        "expected_lifecycle_revision",
        "next_attempt_at",
        "completion_proof_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_cleanup_attempts_authorized_context",
      relation: "dashboard_cleanup_attempts",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "dashboard_id",
        "cleanup_attempt_id",
        "step",
        "started_at",
        "finished_at",
        "result",
        "released_claim_count",
        "deleted_resource_count",
        "deferred_claim_count",
        "failure_code",
        "proof_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_legal_holds_authorized_context",
      relation: "dashboard_legal_holds",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "dashboard_id",
        "hold_id",
        "case_matter_reference",
        "placed_by_principal_id",
        "placed_authority_revision",
        "placed_actor",
        "placed_reason_sha256",
        "placed_at",
        "retention_policy_revision",
        "released_at",
        "released_by_principal_id",
        "released_authority_revision",
        "released_actor",
        "released_reason_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_tombstones_authorized_context",
      relation: "dashboard_tombstones",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "tombstone_lineage_id",
        "retention_policy_revision",
        "access_revoked_at",
        "access_revoked_lifecycle_revision",
        "access_revoked_proof_sha256",
        "purged_at",
        "purged_lifecycle_revision",
        "purged_proof_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_restore_lineage_authorized_context",
      relation: "dashboard_restore_lineage",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "dashboard_id",
        "version_id",
        "source_tombstone_lineage_id",
        "source_version_id",
        "retention_policy_revision",
        "actor_user_id",
        "authority_revision",
        "occurred_at",
        "provenance_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "backup_deletion_ledger_authorized_context",
      relation: "backup_deletion_ledger",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "ledger_sequence",
        "tombstone_lineage_id",
        "lifecycle_revision",
        "event_kind",
        "event_occurred_at",
        "inserted_at",
        "retention_policy_revision",
        "proof_sha256",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "source_snapshots_authorized_context",
      relation: "source_snapshots",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "snapshot_id",
        "source_kind",
        "canonical_bytes",
        "content_sha256",
        "observed_at",
        "retrieved_at",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "evidence_records_authorized_context",
      relation: "evidence_records",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "evidence_id",
        "snapshot_id",
        "evidence_kind",
        "coordinates",
        "transformation",
        "content_sha256",
        "observed_at",
        "retrieved_at",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_versions_authorized_context",
      relation: "dashboard_versions",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "dashboard_id",
        "version_id",
        "parent_version_id",
        "canonical_spec_bytes",
        "canonical_spec_sha256",
        "validation_state",
        "validation_sha256",
        "planner_provenance_sha256",
        "policy_revision",
        "registry_revision",
        "calculation_graph_sha256",
        "created_by_user_id",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_version_snapshots_authorized_context",
      relation: "dashboard_version_snapshots",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: ["organization_id", "dashboard_id", "version_id", "snapshot_id"],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_version_evidence_authorized_context",
      relation: "dashboard_version_evidence",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: ["organization_id", "dashboard_id", "version_id", "evidence_id"],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "dashboard_artifacts_authorized_context",
      relation: "dashboard_artifacts",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "artifact_id",
        "dashboard_id",
        "version_id",
        "ownership_class",
        "artifact_kind",
        "metadata_sha256",
        "content_sha256",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "snapshot_reference_claims_authorized_context",
      relation: "snapshot_reference_claims",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "snapshot_id",
        "reference_claim_id",
        "dashboard_id",
        "version_id",
        "claim_kind",
        "hold_id",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "evidence_reference_claims_authorized_context",
      relation: "evidence_reference_claims",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "evidence_id",
        "reference_claim_id",
        "dashboard_id",
        "version_id",
        "claim_kind",
        "hold_id",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "artifact_reference_claims_authorized_context",
      relation: "artifact_reference_claims",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "artifact_id",
        "reference_claim_id",
        "dashboard_id",
        "version_id",
        "claim_kind",
        "hold_id",
        "created_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    },
    {
      name: "snapshot_deletion_finalizers_authorized_context",
      relation: "snapshot_deletion_finalizers",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "snapshot_id",
        "state",
        "intent_at",
        "expected_claim_set_sha256",
        "lease_owner",
        "lease_expires_at",
        "proof_sha256",
        "bytes_deleted_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "evidence_deletion_finalizers_authorized_context",
      relation: "evidence_deletion_finalizers",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "evidence_id",
        "state",
        "intent_at",
        "expected_claim_set_sha256",
        "lease_owner",
        "lease_expires_at",
        "proof_sha256",
        "bytes_deleted_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
    {
      name: "artifact_deletion_finalizers_authorized_context",
      relation: "artifact_deletion_finalizers",
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns: [
        "organization_id",
        "artifact_id",
        "state",
        "intent_at",
        "expected_claim_set_sha256",
        "lease_owner",
        "lease_expires_at",
        "proof_sha256",
        "bytes_deleted_at",
      ],
      shutsOffWhenPhase: null,
      using:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
      withCheck:
        "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid))",
    },
  ],
  functions: [
    {
      schema: "dasher_api",
      name: "list_dashboards",
      identityArguments: "integer",
      returns: "SETOF dasher.dashboard_summary",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "get_dashboard_summary",
      identityArguments: "uuid",
      returns: "dasher.dashboard_summary",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "get_dashboard_head",
      identityArguments: "uuid",
      returns: "uuid",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "get_dashboard_version",
      identityArguments: "uuid, uuid",
      returns: "dasher.dashboard_version_projection",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "get_dashboard_evidence",
      identityArguments: "uuid, uuid",
      returns: "SETOF dasher.dashboard_evidence_projection",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "get_dashboard_lineage",
      identityArguments: "uuid, uuid",
      returns: "SETOF dasher.dashboard_lineage_projection",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "get_dashboard_admin_status",
      identityArguments: "uuid",
      returns: "dasher.dashboard_admin_projection",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "create_dashboard",
      identityArguments: "uuid, text, text, integer, boolean, uuid, uuid, text",
      returns: "uuid",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "create_evidence_record",
      identityArguments:
        "uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "create_dashboard_version",
      identityArguments:
        "uuid, uuid, uuid, bytea, bytea, uuid, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid, text",
      returns: "uuid",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "compare_and_swap_dashboard_head",
      identityArguments: "uuid, uuid, uuid, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "request_dashboard_promotion",
      identityArguments: "uuid, uuid, bigint, bytea, uuid, text",
      returns: "uuid",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "decide_dashboard_promotion",
      identityArguments: "uuid, uuid, uuid, bigint, text, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "set_dashboard_archive",
      identityArguments: "uuid, boolean, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "delete_dashboard",
      identityArguments: "uuid, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_api",
      name: "restore_dashboard_as_new",
      identityArguments: "uuid, uuid, uuid, uuid, text, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_security_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_app"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "initialize_operator_context",
      identityArguments: "uuid, text, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "materialize_dashboard_expiry",
      identityArguments: "uuid, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "place_dashboard_legal_hold",
      identityArguments: "uuid, uuid, text, bytea, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "release_dashboard_legal_hold",
      identityArguments: "uuid, uuid, bytea, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "claim_dashboard_cleanup",
      identityArguments: "uuid, text, bigint, text, interval, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "record_dashboard_cleanup_attempt",
      identityArguments:
        "uuid, uuid, text, text, integer, integer, integer, bytea, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_retention_api",
      name: "purge_dashboard",
      identityArguments: "uuid, bigint, uuid, text",
      returns: "void",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: true,
      owner: "dasher_retention_definer",
      proconfig: ["search_path=pg_catalog"],
      execute: ["dasher_retention_operator"],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_private",
      name: "reject_dashboard_append_mutation",
      identityArguments: "",
      returns: "trigger",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: false,
      owner: "migration_owner",
      proconfig: ["search_path=pg_catalog"],
      execute: [],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_private",
      name: "enforce_dashboard_transition",
      identityArguments: "",
      returns: "trigger",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: false,
      owner: "migration_owner",
      proconfig: ["search_path=pg_catalog"],
      execute: [],
      defaults: [],
      variadic: false,
    },
    {
      schema: "dasher_private",
      name: "enforce_retention_mutation",
      identityArguments: "",
      returns: "trigger",
      language: "plpgsql",
      volatility: "VOLATILE",
      securityDefiner: false,
      owner: "migration_owner",
      proconfig: ["search_path=pg_catalog"],
      execute: [],
      defaults: [],
      variadic: false,
    },
  ],
  relationAcls: [
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_policies",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_events",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_promotion_requests",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_promotion_decisions",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_restore_lineage",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "backup_deletion_ledger",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "source_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_records",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_versions",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_evidence",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_artifacts",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_policies",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_events",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_promotion_requests",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_promotion_decisions",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_restore_lineage",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "backup_deletion_ledger",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_records",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_versions",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_evidence",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_artifacts",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_policies",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_events",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_attempts",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_restore_lineage",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "backup_deletion_ledger",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "retention_service_principal_allowlist",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "source_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_records",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_versions",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_evidence",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_artifacts",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "SELECT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_lifecycle_events",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_attempts",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "backup_deletion_ledger",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "INSERT",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "source_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_records",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_versions",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_snapshots",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_version_evidence",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_artifacts",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_reference_claims",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "DELETE",
      isGrantable: false,
    },
  ],
  columnAcls: [
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "head_version_id",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "lifecycle_state",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "lifecycle_revision",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "capability_epoch",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "cache_epoch",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "current_kind",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "effective_expires_at",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "promoted_at",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "archived_at",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "access_revoked_at",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "revocation_reason",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "purge_after",
      grantor: "migration_owner",
      grantee: "dasher_security_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "lifecycle_state",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "lifecycle_revision",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "capability_epoch",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "cache_epoch",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "access_revoked_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "revocation_reason",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "purge_after",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "purge_started_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboards",
      columnName: "purged_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      columnName: "current_step",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      columnName: "lease_owner",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      columnName: "lease_expires_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      columnName: "expected_lifecycle_revision",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      columnName: "next_attempt_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_cleanup_coordination",
      columnName: "completion_proof_sha256",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      columnName: "released_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      columnName: "released_by_principal_id",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      columnName: "released_authority_revision",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      columnName: "released_actor",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_legal_holds",
      columnName: "released_reason_sha256",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      columnName: "purged_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      columnName: "purged_lifecycle_revision",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "dashboard_tombstones",
      columnName: "purged_proof_sha256",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      columnName: "state",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      columnName: "lease_owner",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      columnName: "lease_expires_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      columnName: "proof_sha256",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "snapshot_deletion_finalizers",
      columnName: "bytes_deleted_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      columnName: "state",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      columnName: "lease_owner",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      columnName: "lease_expires_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      columnName: "proof_sha256",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "evidence_deletion_finalizers",
      columnName: "bytes_deleted_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      columnName: "state",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      columnName: "lease_owner",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      columnName: "lease_expires_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      columnName: "proof_sha256",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
    {
      schema: "dasher",
      relationName: "artifact_deletion_finalizers",
      columnName: "bytes_deleted_at",
      grantor: "migration_owner",
      grantee: "dasher_retention_definer",
      privilege: "UPDATE",
      isGrantable: false,
    },
  ],
  functionExecuteGrants: [
    {
      identity: "dasher_api.list_dashboards(integer)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.get_dashboard_summary(uuid)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.get_dashboard_head(uuid)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.get_dashboard_version(uuid, uuid)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.get_dashboard_evidence(uuid, uuid)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.get_dashboard_lineage(uuid, uuid)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.get_dashboard_admin_status(uuid)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.create_evidence_record(uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.create_dashboard_version(uuid, uuid, uuid, bytea, bytea, uuid, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.compare_and_swap_dashboard_head(uuid, uuid, uuid, bigint, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.request_dashboard_promotion(uuid, uuid, bigint, bytea, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.decide_dashboard_promotion(uuid, uuid, uuid, bigint, text, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.set_dashboard_archive(uuid, boolean, bigint, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity: "dasher_api.delete_dashboard(uuid, bigint, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_api.restore_dashboard_as_new(uuid, uuid, uuid, uuid, text, uuid, text)",
      grantor: "dasher_security_definer",
      grantees: ["dasher_app"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.initialize_operator_context(uuid, text, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.materialize_dashboard_expiry(uuid, bigint, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.place_dashboard_legal_hold(uuid, uuid, text, bytea, bigint, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.release_dashboard_legal_hold(uuid, uuid, bytea, bigint, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.claim_dashboard_cleanup(uuid, text, bigint, text, interval, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity:
        "dasher_retention_api.purge_dashboard(uuid, bigint, uuid, text)",
      grantor: "dasher_retention_definer",
      grantees: ["dasher_retention_operator"],
      isGrantable: false,
    },
    {
      identity: "dasher_private.reject_dashboard_append_mutation()",
      grantor: "migration_owner",
      grantees: [],
      isGrantable: false,
    },
    {
      identity: "dasher_private.enforce_dashboard_transition()",
      grantor: "migration_owner",
      grantees: [],
      isGrantable: false,
    },
    {
      identity: "dasher_private.enforce_retention_mutation()",
      grantor: "migration_owner",
      grantees: [],
      isGrantable: false,
    },
  ],
} as const;

function catalogCollationIdentity(typeName: string): string {
  if (typeName === "name") {
    return "pg_catalog.C";
  }
  if (
    typeName === "text" ||
    typeName.startsWith("character varying(") ||
    typeName.startsWith("character(")
  ) {
    return "pg_catalog.default";
  }
  return "<none>";
}

function modeledIndexCollations(
  relationName: string,
  keyExpressions: readonly string[],
): readonly string[] {
  return keyExpressions.map((columnName) => {
    const column = modeled0003StaticCatalogContractBase.columns.find(
      (candidate) =>
        candidate.relationName === relationName &&
        candidate.columnName === columnName,
    );
    if (column === undefined) {
      throw new Error(
        `missing modeled index collation column: ${relationName}.${columnName}`,
      );
    }
    return catalogCollationIdentity(column.type);
  });
}

function modeledFunctionSource(
  schemaName: string,
  functionName: string,
): string {
  const source = modeled0003FunctionSources[`${schemaName}.${functionName}`];
  if (source === undefined) {
    throw new Error(
      `missing concrete modeled function source: ${schemaName}.${functionName}`,
    );
  }
  return source;
}

const modeled0003StaticCatalogContract = {
  ...modeled0003StaticCatalogContractBase,
  columns: modeled0003StaticCatalogContractBase.columns.map((column) => ({
    ...column,
    collation: catalogCollationIdentity(column.type),
  })),
  indexes: modeled0003StaticCatalogContractBase.indexes.map((index) => ({
    ...index,
    includedColumns: [] as readonly string[],
    collations: modeledIndexCollations(index.relation, index.keyExpressions),
  })),
  functions: modeled0003StaticCatalogContractBase.functions.map((routine) => ({
    ...routine,
    source: modeledFunctionSource(routine.schema, routine.name),
  })),
  comments: [] as readonly string[],
  defaultAcls: [] as readonly string[],
  ownershipDependencyRows: modeled0003StaticCatalogContractBase.functions
    .filter((routine) => routine.owner !== "migration_owner")
    .map(
      (routine) =>
        ({
          dependencyType: "o",
          catalog: "pg_proc",
          objectKind: "function",
          identity: `${routine.schema}.${routine.name}(${routine.identityArguments})`,
          roleName: routine.owner,
        }) as const,
    ),
  aclDependencyRows: [
    ...(
      [
        ["dasher", "dasher_retention_definer"],
        ["dasher_private", "dasher_retention_definer"],
        ["dasher_retention_api", "dasher_retention_definer"],
        ["dasher_retention_api", "dasher_retention_operator"],
      ] as const
    ).map(
      ([identity, grantee]) =>
        ({
          dependencyType: "a",
          catalog: "pg_namespace",
          objectKind: "schema",
          identity,
          grantor: "migration_owner",
          grantee,
          privilege: "USAGE",
          isGrantable: false,
        }) as const,
    ),
    ...modeled0003StaticCatalogContractBase.functions.flatMap((routine) =>
      routine.execute.map(
        (grantee) =>
          ({
            dependencyType: "a",
            catalog: "pg_proc",
            objectKind: "function",
            identity: `${routine.schema}.${routine.name}(${routine.identityArguments})`,
            grantor: routine.owner,
            grantee,
            privilege: "EXECUTE",
            isGrantable: false,
          }) as const,
      ),
    ),
    ...modeled0003StaticCatalogContractBase.relationAcls.map(
      (acl) =>
        ({
          dependencyType: "a",
          catalog: "pg_class",
          objectKind: "relation",
          identity: `${acl.schema}.${acl.relationName}`,
          grantor: acl.grantor,
          grantee: acl.grantee,
          privilege: acl.privilege,
          isGrantable: acl.isGrantable,
        }) as const,
    ),
    ...modeled0003StaticCatalogContractBase.columnAcls.map(
      (acl) =>
        ({
          dependencyType: "a",
          catalog: "pg_class",
          objectKind: "column",
          identity: `${acl.schema}.${acl.relationName}.${acl.columnName}`,
          grantor: acl.grantor,
          grantee: acl.grantee,
          privilege: acl.privilege,
          isGrantable: acl.isGrantable,
        }) as const,
    ),
  ],
  policyDependencyRows: modeled0003StaticCatalogContractBase.policies.flatMap(
    (policy) =>
      policy.roles.map(
        (roleName) =>
          ({
            dependencyType: "r",
            catalog: "pg_policy",
            objectKind: "policy",
            identity: `dasher.${policy.relation}.${policy.name}`,
            roleName,
            roles: policy.roles,
            command: policy.catalogCommand,
            permissive: policy.permissive,
            using: policy.using,
            withCheck: policy.withCheck,
          }) as const,
      ),
  ),
} as const;

export function getModeled0003StaticCatalogContractForTests(): unknown {
  return JSON.parse(
    JSON.stringify(modeled0003StaticCatalogContract),
  ) as unknown;
}

const canonicalColumnSignatures = [
  "audit_events|1|audit_event_id|uuid|true|<none>",
  "audit_events|2|organization_id|uuid|true|<none>",
  "audit_events|3|occurred_at|timestamp with time zone|true|clock_timestamp()",
  "audit_events|4|actor_kind|character varying(16)|true|<none>",
  "audit_events|5|actor_user_id|uuid|false|<none>",
  "audit_events|6|actor_service|character varying(64)|false|<none>",
  "audit_events|7|authority_revision|bigint|true|<none>",
  "audit_events|8|request_id|uuid|true|<none>",
  "audit_events|9|job_id|uuid|false|<none>",
  "audit_events|10|action|character varying(64)|true|<none>",
  "audit_events|11|target_type|character varying(32)|true|<none>",
  "audit_events|12|target_id|uuid|true|<none>",
  "audit_events|13|outcome|character varying(16)|true|<none>",
  "audit_events|14|content_sha256|bytea|false|<none>",
  "audit_events|15|source_ref|character varying(200)|false|<none>",
  "audit_events|16|provider|character varying(64)|false|<none>",
  "audit_events|17|credential_version|character varying(64)|false|<none>",
  "audit_events|18|usage_units|numeric(20,6)|false|<none>",
  "audit_events|19|cost_minor_units|bigint|false|<none>",
  "audit_events|20|deployment_revision|character varying(64)|true|<none>",
  "external_identities|1|issuer|character varying(512)|true|<none>",
  "external_identities|2|subject|character varying(512)|true|<none>",
  "external_identities|3|user_id|uuid|true|<none>",
  "external_identities|4|created_at|timestamp with time zone|true|transaction_timestamp()",
  "invitations|1|invitation_id|uuid|true|<none>",
  "invitations|2|organization_id|uuid|true|<none>",
  "invitations|3|normalized_email|character varying(320)|true|<none>",
  "invitations|4|granted_role|character varying(16)|true|<none>",
  "invitations|5|role_ceiling|character varying(16)|true|<none>",
  "invitations|6|token_key_version|smallint|true|<none>",
  "invitations|7|token_digest|bytea|true|<none>",
  "invitations|8|created_by_user_id|uuid|true|<none>",
  "invitations|9|created_at|timestamp with time zone|true|transaction_timestamp()",
  "invitations|10|expires_at|timestamp with time zone|true|<none>",
  "invitations|11|accepted_at|timestamp with time zone|false|<none>",
  "invitations|12|accepted_user_id|uuid|false|<none>",
  "invitations|13|revoked_at|timestamp with time zone|false|<none>",
  "invitations|14|revoked_by_user_id|uuid|false|<none>",
  "memberships|1|membership_id|uuid|true|<none>",
  "memberships|2|organization_id|uuid|true|<none>",
  "memberships|3|user_id|uuid|true|<none>",
  "memberships|4|role|character varying(16)|true|<none>",
  "memberships|5|state|character varying(16)|true|<none>",
  "memberships|6|authority_revision|bigint|true|<none>",
  "memberships|7|created_at|timestamp with time zone|true|transaction_timestamp()",
  "memberships|8|updated_at|timestamp with time zone|true|transaction_timestamp()",
  "memberships|9|revoked_at|timestamp with time zone|false|<none>",
  "organizations|1|organization_id|uuid|true|<none>",
  "organizations|2|display_name|character varying(200)|true|<none>",
  "organizations|3|created_at|timestamp with time zone|true|transaction_timestamp()",
  "sessions|1|session_id|uuid|true|<none>",
  "sessions|2|organization_id|uuid|true|<none>",
  "sessions|3|user_id|uuid|true|<none>",
  "sessions|4|authority_revision|bigint|true|<none>",
  "sessions|5|token_key_version|smallint|true|<none>",
  "sessions|6|token_digest|bytea|true|<none>",
  "sessions|7|csrf_key_version|smallint|true|<none>",
  "sessions|8|csrf_digest|bytea|true|<none>",
  "sessions|9|issued_at|timestamp with time zone|true|<none>",
  "sessions|10|last_seen_at|timestamp with time zone|true|<none>",
  "sessions|11|idle_expires_at|timestamp with time zone|true|<none>",
  "sessions|12|absolute_expires_at|timestamp with time zone|true|<none>",
  "sessions|13|rotated_from_session_id|uuid|false|<none>",
  "sessions|14|replaced_by_session_id|uuid|false|<none>",
  "sessions|15|revoked_at|timestamp with time zone|false|<none>",
  "sessions|16|revocation_reason|character varying(32)|false|<none>",
  "users|1|user_id|uuid|true|<none>",
  "users|2|created_at|timestamp with time zone|true|transaction_timestamp()",
] as const;

const canonicalRelationConstraintSignatures = [
  "audit_events|audit_events_action_check|c|CHECK (((action)::text = ANY ((ARRAY['membership.role_changed'::character varying, 'membership.revoked'::character varying, 'invitation.issued'::character varying, 'invitation.revoked'::character varying, 'invitation.accepted'::character varying, 'invitation.accepted_existing_membership'::character varying, 'session.issued'::character varying, 'session.rotated'::character varying, 'session.revoked'::character varying, 'source_snapshot.created'::character varying, 'evidence_record.created'::character varying, 'dashboard.created'::character varying, 'dashboard_version.created'::character varying, 'dashboard_head.promoted'::character varying])::text[])))|true",
  "audit_events|audit_events_actor_check|c|CHECK (((((actor_kind)::text = 'user'::text) AND (actor_user_id IS NOT NULL) AND (actor_service IS NULL)) OR (((actor_kind)::text = 'service'::text) AND (actor_user_id IS NULL) AND (actor_service IS NOT NULL))))|true",
  "audit_events|audit_events_actor_kind_check|c|CHECK (((actor_kind)::text = ANY ((ARRAY['user'::character varying, 'service'::character varying])::text[])))|true",
  "audit_events|audit_events_actor_service_check|c|CHECK (((actor_service IS NULL) OR (((actor_service)::text = btrim((actor_service)::text)) AND ((char_length((actor_service)::text) >= 1) AND (char_length((actor_service)::text) <= 64)) AND ((actor_service)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_authority_revision_check|c|CHECK ((authority_revision >= 1))|true",
  "audit_events|audit_events_content_sha256_check|c|CHECK (((content_sha256 IS NULL) OR (octet_length(content_sha256) = 32)))|true",
  "audit_events|audit_events_cost_minor_units_check|c|CHECK (((cost_minor_units IS NULL) OR (cost_minor_units >= 0)))|true",
  "audit_events|audit_events_credential_version_check|c|CHECK (((credential_version IS NULL) OR (((credential_version)::text = btrim((credential_version)::text)) AND ((char_length((credential_version)::text) >= 1) AND (char_length((credential_version)::text) <= 64)) AND ((credential_version)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_deployment_revision_check|c|CHECK ((((deployment_revision)::text = btrim((deployment_revision)::text)) AND ((char_length((deployment_revision)::text) >= 1) AND (char_length((deployment_revision)::text) <= 64)) AND ((deployment_revision)::text !~ '[[:cntrl:]]'::text)))|true",
  "audit_events|audit_events_outcome_check|c|CHECK (((outcome)::text = 'succeeded'::text))|true",
  "audit_events|audit_events_provider_check|c|CHECK (((provider IS NULL) OR (((provider)::text = btrim((provider)::text)) AND ((char_length((provider)::text) >= 1) AND (char_length((provider)::text) <= 64)) AND ((provider)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_source_ref_check|c|CHECK (((source_ref IS NULL) OR (((source_ref)::text = btrim((source_ref)::text)) AND ((char_length((source_ref)::text) >= 1) AND (char_length((source_ref)::text) <= 200)) AND ((source_ref)::text !~ '[[:cntrl:]]'::text))))|true",
  "audit_events|audit_events_target_type_check|c|CHECK ((((target_type)::text = btrim((target_type)::text)) AND ((char_length((target_type)::text) >= 1) AND (char_length((target_type)::text) <= 32)) AND ((target_type)::text !~ '[[:cntrl:]]'::text)))|true",
  "audit_events|audit_events_usage_units_check|c|CHECK (((usage_units IS NULL) OR ((usage_units <> 'NaN'::numeric) AND (usage_units >= (0)::numeric))))|true",
  "audit_events|audit_events_pkey|p|PRIMARY KEY (audit_event_id)|true",
  "audit_events|audit_events_org_id_key|u|UNIQUE (organization_id, audit_event_id)|true",
  "external_identities|external_identities_issuer_check|c|CHECK ((((issuer)::text = btrim((issuer)::text)) AND ((char_length((issuer)::text) >= 1) AND (char_length((issuer)::text) <= 512)) AND ((issuer)::text !~ '[[:cntrl:]]'::text)))|true",
  "external_identities|external_identities_subject_check|c|CHECK ((((subject)::text = btrim((subject)::text)) AND ((char_length((subject)::text) >= 1) AND (char_length((subject)::text) <= 512)) AND ((subject)::text !~ '[[:cntrl:]]'::text)))|true",
  "external_identities|external_identities_pkey|p|PRIMARY KEY (issuer, subject)|true",
  "external_identities|external_identities_user_key|u|UNIQUE (user_id)|true",
  "invitations|invitations_accepted_fields_check|c|CHECK (((accepted_at IS NULL) = (accepted_user_id IS NULL)))|true",
  "invitations|invitations_expiry_check|c|CHECK ((expires_at > created_at))|true",
  "invitations|invitations_granted_role_check|c|CHECK (((granted_role)::text = ANY ((ARRAY['admin'::character varying, 'editor'::character varying, 'viewer'::character varying])::text[])))|true",
  "invitations|invitations_normalized_email_check|c|CHECK ((((normalized_email)::text = btrim((normalized_email)::text)) AND ((normalized_email)::text = lower((normalized_email)::text)) AND ((char_length((normalized_email)::text) >= 1) AND (char_length((normalized_email)::text) <= 320)) AND ((normalized_email)::text !~ '[[:cntrl:]]'::text)))|true",
  "invitations|invitations_revoked_fields_check|c|CHECK (((revoked_at IS NULL) = (revoked_by_user_id IS NULL)))|true",
  "invitations|invitations_role_ceiling_check|c|CHECK (((role_ceiling)::text = ANY ((ARRAY['admin'::character varying, 'editor'::character varying, 'viewer'::character varying])::text[])))|true",
  "invitations|invitations_role_order_check|c|CHECK (( CASE granted_role WHEN 'viewer'::text THEN 1 WHEN 'editor'::text THEN 2 WHEN 'admin'::text THEN 3 ELSE NULL::integer END <= CASE role_ceiling WHEN 'viewer'::text THEN 1 WHEN 'editor'::text THEN 2 WHEN 'admin'::text THEN 3 ELSE NULL::integer END))|true",
  "invitations|invitations_terminal_state_check|c|CHECK (((accepted_at IS NULL) OR (revoked_at IS NULL)))|true",
  "invitations|invitations_token_digest_check|c|CHECK ((octet_length(token_digest) = 32))|true",
  "invitations|invitations_token_key_version_check|c|CHECK (((token_key_version >= 1) AND (token_key_version <= 32767)))|true",
  "invitations|invitations_pkey|p|PRIMARY KEY (invitation_id)|true",
  "invitations|invitations_org_id_key|u|UNIQUE (organization_id, invitation_id)|true",
  "invitations|invitations_token_key|u|UNIQUE (token_key_version, token_digest)|true",
  "memberships|memberships_authority_revision_check|c|CHECK ((authority_revision >= 1))|true",
  "memberships|memberships_role_check|c|CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'editor'::character varying, 'viewer'::character varying])::text[])))|true",
  "memberships|memberships_state_check|c|CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying])::text[])))|true",
  "memberships|memberships_state_revoked_at_check|c|CHECK (((((state)::text = 'active'::text) AND (revoked_at IS NULL)) OR (((state)::text = 'revoked'::text) AND (revoked_at IS NOT NULL))))|true",
  "memberships|memberships_updated_at_check|c|CHECK ((updated_at >= created_at))|true",
  "memberships|memberships_pkey|p|PRIMARY KEY (membership_id)|true",
  "memberships|memberships_org_membership_key|u|UNIQUE (organization_id, membership_id)|true",
  "memberships|memberships_org_user_key|u|UNIQUE (organization_id, user_id)|true",
  "organizations|organizations_display_name_check|c|CHECK ((((display_name)::text = btrim((display_name)::text)) AND ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 200)) AND ((display_name)::text !~ '[[:cntrl:]]'::text)))|true",
  "organizations|organizations_pkey|p|PRIMARY KEY (organization_id)|true",
  "sessions|sessions_authority_revision_check|c|CHECK ((authority_revision >= 1))|true",
  "sessions|sessions_csrf_digest_check|c|CHECK ((octet_length(csrf_digest) = 32))|true",
  "sessions|sessions_csrf_key_version_check|c|CHECK (((csrf_key_version >= 1) AND (csrf_key_version <= 32767)))|true",
  "sessions|sessions_idle_expiry_check|c|CHECK (((issued_at < idle_expires_at) AND (idle_expires_at <= absolute_expires_at)))|true",
  "sessions|sessions_last_seen_check|c|CHECK (((issued_at <= last_seen_at) AND (last_seen_at < absolute_expires_at)))|true",
  "sessions|sessions_lineage_check|c|CHECK ((((rotated_from_session_id IS NULL) OR (rotated_from_session_id <> session_id)) AND ((replaced_by_session_id IS NULL) OR (replaced_by_session_id <> session_id)) AND ((rotated_from_session_id IS NULL) OR (replaced_by_session_id IS NULL) OR (rotated_from_session_id <> replaced_by_session_id))))|true",
  "sessions|sessions_revocation_fields_check|c|CHECK (((revoked_at IS NULL) = (revocation_reason IS NULL)))|true",
  "sessions|sessions_revocation_reason_check|c|CHECK (((revocation_reason IS NULL) OR (((revocation_reason)::text = btrim((revocation_reason)::text)) AND ((char_length((revocation_reason)::text) >= 1) AND (char_length((revocation_reason)::text) <= 32)) AND ((revocation_reason)::text !~ '[[:cntrl:]]'::text))))|true",
  "sessions|sessions_token_digest_check|c|CHECK ((octet_length(token_digest) = 32))|true",
  "sessions|sessions_token_key_version_check|c|CHECK (((token_key_version >= 1) AND (token_key_version <= 32767)))|true",
  "sessions|sessions_pkey|p|PRIMARY KEY (session_id)|true",
  "sessions|sessions_csrf_key|u|UNIQUE (csrf_key_version, csrf_digest)|true",
  "sessions|sessions_org_id_key|u|UNIQUE (organization_id, session_id)|true",
  "sessions|sessions_token_key|u|UNIQUE (token_key_version, token_digest)|true",
  "users|users_pkey|p|PRIMARY KEY (user_id)|true",
] as const;

const canonicalForeignKeySignatures = [
  "dasher.audit_events|audit_events_actor_fkey|dasher.memberships|{organization_id,actor_user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.audit_events|audit_events_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.external_identities|external_identities_user_fkey|dasher.users|{user_id}|{user_id}|1|saa|true|false|false",
  "dasher.invitations|invitations_accepted_user_fkey|dasher.users|{accepted_user_id}|{user_id}|1|saa|true|false|false",
  "dasher.invitations|invitations_creator_fkey|dasher.memberships|{organization_id,created_by_user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.invitations|invitations_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.invitations|invitations_revoker_fkey|dasher.memberships|{organization_id,revoked_by_user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.memberships|memberships_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.memberships|memberships_user_fkey|dasher.users|{user_id}|{user_id}|1|saa|true|false|false",
  "dasher.sessions|sessions_membership_fkey|dasher.memberships|{organization_id,user_id}|{organization_id,user_id}|2|saa|true|false|false",
  "dasher.sessions|sessions_organization_fkey|dasher.organizations|{organization_id}|{organization_id}|1|saa|true|false|false",
  "dasher.sessions|sessions_replaced_by_fkey|dasher.sessions|{organization_id,replaced_by_session_id}|{organization_id,session_id}|2|saa|true|false|false",
  "dasher.sessions|sessions_rotated_from_fkey|dasher.sessions|{organization_id,rotated_from_session_id}|{organization_id,session_id}|2|saa|true|false|false",
] as const;

const canonicalIndexSignatures = [
  "audit_events|audit_events_actor_idx|btree|false|false|true|true|true|false|<none>|{organization_id,actor_user_id}|{uuid_ops,uuid_ops}|0 0",
  "audit_events|audit_events_occurred_idx|btree|false|false|true|true|true|false|<none>|{organization_id,occurred_at,audit_event_id}|{uuid_ops,timestamptz_ops,uuid_ops}|0 0 0",
  "audit_events|audit_events_org_id_key|btree|true|false|true|true|true|false|<none>|{organization_id,audit_event_id}|{uuid_ops,uuid_ops}|0 0",
  "audit_events|audit_events_pkey|btree|true|true|true|true|true|false|<none>|{audit_event_id}|{uuid_ops}|0",
  "external_identities|external_identities_pkey|btree|true|true|true|true|true|false|<none>|{issuer,subject}|{text_ops,text_ops}|0 0",
  "external_identities|external_identities_user_key|btree|true|false|true|true|true|false|<none>|{user_id}|{uuid_ops}|0",
  "invitations|invitations_accepted_user_idx|btree|false|false|true|true|true|false|<none>|{accepted_user_id}|{uuid_ops}|0",
  "invitations|invitations_creator_idx|btree|false|false|true|true|true|false|<none>|{organization_id,created_by_user_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_email_created_idx|btree|false|false|true|true|true|false|<none>|{organization_id,normalized_email,created_at}|{uuid_ops,text_ops,timestamptz_ops}|0 0 3",
  "invitations|invitations_org_id_key|btree|true|false|true|true|true|false|<none>|{organization_id,invitation_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_pkey|btree|true|true|true|true|true|false|<none>|{invitation_id}|{uuid_ops}|0",
  "invitations|invitations_revoker_idx|btree|false|false|true|true|true|false|<none>|{organization_id,revoked_by_user_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_token_key|btree|true|false|true|true|true|false|<none>|{token_key_version,token_digest}|{int2_ops,bytea_ops}|0 0",
  "memberships|memberships_active_authority_idx|btree|false|false|true|true|true|false|((state)::text = 'active'::text)|{organization_id,user_id,authority_revision}|{uuid_ops,uuid_ops,int8_ops}|0 0 0",
  "memberships|memberships_org_membership_key|btree|true|false|true|true|true|false|<none>|{organization_id,membership_id}|{uuid_ops,uuid_ops}|0 0",
  "memberships|memberships_org_user_key|btree|true|false|true|true|true|false|<none>|{organization_id,user_id}|{uuid_ops,uuid_ops}|0 0",
  "memberships|memberships_pkey|btree|true|true|true|true|true|false|<none>|{membership_id}|{uuid_ops}|0",
  "memberships|memberships_user_idx|btree|false|false|true|true|true|false|<none>|{user_id}|{uuid_ops}|0",
  "organizations|organizations_pkey|btree|true|true|true|true|true|false|<none>|{organization_id}|{uuid_ops}|0",
  "sessions|sessions_csrf_key|btree|true|false|true|true|true|false|<none>|{csrf_key_version,csrf_digest}|{int2_ops,bytea_ops}|0 0",
  "sessions|sessions_live_user_idx|btree|false|false|true|true|true|false|<none>|{organization_id,user_id,revoked_at}|{uuid_ops,uuid_ops,timestamptz_ops}|0 0 0",
  "sessions|sessions_org_id_key|btree|true|false|true|true|true|false|<none>|{organization_id,session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_pkey|btree|true|true|true|true|true|false|<none>|{session_id}|{uuid_ops}|0",
  "sessions|sessions_replaced_by_idx|btree|false|false|true|true|true|false|<none>|{organization_id,replaced_by_session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_rotated_from_idx|btree|false|false|true|true|true|false|<none>|{organization_id,rotated_from_session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_token_key|btree|true|false|true|true|true|false|<none>|{token_key_version,token_digest}|{int2_ops,bytea_ops}|0 0",
  "users|users_pkey|btree|true|true|true|true|true|false|<none>|{user_id}|{uuid_ops}|0",
] as const;

const exactManagedCatalogInventorySql = `
  WITH
  managed_namespaces AS (
    SELECT namespace.oid, namespace.nspname, namespace.nspowner
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname LIKE 'dasher%'
  ),
  signature_catalog AS (
    SELECT pg_catalog.jsonb_build_object(
      'schemas', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT namespace.nspname || '|' || owner.rolname AS signature
          FROM pg_catalog.pg_namespace AS namespace
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
          WHERE namespace.nspname LIKE 'dasher%'
        ) AS rows
      ), '[]'::jsonb),
      'relations', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            relation.relkind::text || '|' || owner.rolname || '|' ||
            relation.relpersistence::text || '|' ||
            relation.relrowsecurity::text || '|' ||
            relation.relforcerowsecurity::text || '|' ||
            relation.relreplident::text || '|' ||
            COALESCE(relation.reloptions::text, '<none>') AS signature
          FROM pg_catalog.pg_class AS relation
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
          WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        ) AS rows
      ), '[]'::jsonb),
      'columns', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            attribute.attnum::text || '|' || attribute.attname || '|' ||
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) ||
            '|' || COALESCE(
              collation_namespace.nspname || '.' || collation_row.collname,
              '<none>'
            ) || '|' || attribute.attnotnull::text || '|' ||
            COALESCE(
              pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid),
              '<none>'
            ) || '|' || attribute.attidentity::text || '|' ||
            attribute.attgenerated::text AS signature
          FROM pg_catalog.pg_class AS relation
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
          LEFT JOIN pg_catalog.pg_attrdef AS default_value
            ON default_value.adrelid = attribute.attrelid
           AND default_value.adnum = attribute.attnum
          LEFT JOIN pg_catalog.pg_collation AS collation_row
            ON collation_row.oid = NULLIF(attribute.attcollation, 0)
          LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
            ON collation_namespace.oid = collation_row.collnamespace
          WHERE relation.relkind IN ('r', 'p')
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) AS rows
      ), '[]'::jsonb),
      'sequences', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            pg_catalog.format_type(sequence.seqtypid, NULL) || '|' ||
            sequence.seqstart::text || '|' || sequence.seqincrement::text ||
            '|' || sequence.seqmax::text || '|' || sequence.seqmin::text ||
            '|' || sequence.seqcache::text || '|' || sequence.seqcycle::text
            AS signature
          FROM pg_catalog.pg_sequence AS sequence
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = sequence.seqrelid
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
        ) AS rows
      ), '[]'::jsonb),
      'types', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || type_row.typname || '|' ||
            type_row.typtype::text || '|' || type_row.typcategory::text ||
            '|' || owner.rolname || '|' ||
            COALESCE(relation.relname, '<none>') || '|' ||
            COALESCE(pg_catalog.format_type(NULLIF(type_row.typbasetype, 0), type_row.typtypmod), '<none>') ||
            '|' || type_row.typnotnull::text || '|' ||
            COALESCE(type_row.typdefault, '<none>') || '|' ||
            COALESCE(
              ARRAY(
                SELECT enum.enumlabel
                FROM pg_catalog.pg_enum AS enum
                WHERE enum.enumtypid = type_row.oid
                ORDER BY enum.enumsortorder
              )::text,
              '{}'
            ) || '|' ||
            COALESCE(
              ARRAY(
                SELECT attribute.attname || ' ' ||
                  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                FROM pg_catalog.pg_attribute AS attribute
                WHERE attribute.attrelid = type_row.typrelid
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                ORDER BY attribute.attnum
              )::text,
              '{}'
            ) AS signature
          FROM pg_catalog.pg_type AS type_row
          JOIN managed_namespaces AS namespace
            ON namespace.oid = type_row.typnamespace
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = type_row.typowner
          LEFT JOIN pg_catalog.pg_class AS relation
            ON relation.oid = type_row.typrelid
          WHERE type_row.typelem = 0
            AND type_row.typname NOT LIKE '\\_%' ESCAPE '\\'
        ) AS rows
      ), '[]'::jsonb),
      'indexes', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            index_relation.relname || '|' || access_method.amname || '|' ||
            index_row.indisunique::text || '|' ||
            index_row.indisprimary::text || '|' ||
            index_row.indisvalid::text || '|' ||
            index_row.indisready::text || '|' ||
            index_row.indislive::text || '|' ||
            index_row.indnullsnotdistinct::text || '|' ||
            COALESCE(
              pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid),
              '<none>'
            ) || '|' || index_row.indnatts::text || '|' ||
            index_row.indnkeyatts::text || '|' ||
            ARRAY(
              SELECT pg_catalog.pg_get_indexdef(
                index_row.indexrelid,
                ordinal.position,
                false
              )
              FROM pg_catalog.generate_series(1, index_row.indnkeyatts)
                AS ordinal(position)
            )::text || '|' ||
            ARRAY(
              SELECT pg_catalog.pg_get_indexdef(
                index_row.indexrelid,
                ordinal.position,
                false
              )
              FROM pg_catalog.generate_series(
                index_row.indnkeyatts + 1,
                index_row.indnatts
              ) AS ordinal(position)
            )::text || '|' ||
            ARRAY(
              SELECT operator_class.opcname
              FROM pg_catalog.unnest(index_row.indclass::oid[]) WITH ORDINALITY
                AS class(oid, ordinal)
              JOIN pg_catalog.pg_opclass AS operator_class
                ON operator_class.oid = class.oid
              ORDER BY class.ordinal
            )::text || '|' ||
            ARRAY(
              SELECT CASE
                WHEN ordinal.position > index_row.indnkeyatts THEN '<none>'
                ELSE COALESCE(
                  collation_namespace.nspname || '.' || collation_row.collname,
                  '<none>'
                )
              END
              FROM pg_catalog.generate_series(1, index_row.indnatts)
                AS ordinal(position)
              LEFT JOIN LATERAL (
                SELECT vector_entry.collation_oid
                FROM pg_catalog.unnest(index_row.indcollation::oid[])
                  WITH ORDINALITY AS vector_entry(collation_oid, position)
                WHERE vector_entry.position = ordinal.position
              ) AS index_collation ON true
              LEFT JOIN pg_catalog.pg_collation AS collation_row
                ON collation_row.oid = NULLIF(
                  index_collation.collation_oid,
                  0
                )
              LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
                ON collation_namespace.oid = collation_row.collnamespace
              ORDER BY ordinal.position
            )::text || '|' || index_row.indoption::text AS signature
          FROM pg_catalog.pg_index AS index_row
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = index_row.indrelid
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_class AS index_relation
            ON index_relation.oid = index_row.indexrelid
          JOIN pg_catalog.pg_am AS access_method
            ON access_method.oid = index_relation.relam
        ) AS rows
      ), '[]'::jsonb),
      'constraints', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            constraint_row.conname || '|' || constraint_row.contype::text ||
            '|' || pg_catalog.regexp_replace(
              pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
              '[[:space:]]+', ' ', 'g'
            ) || '|' || constraint_row.condeferrable::text || '|' ||
            constraint_row.condeferred::text || '|' ||
            constraint_row.convalidated::text || '|' ||
            constraint_row.connoinherit::text AS signature
          FROM pg_catalog.pg_constraint AS constraint_row
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = constraint_row.conrelid
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE constraint_row.contype IN ('p', 'u', 'c')
        ) AS rows
      ), '[]'::jsonb),
      'foreignKeys', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            source_namespace.nspname || '.' || source_relation.relname || '|' ||
            constraint_row.conname || '|' || target_namespace.nspname || '.' ||
            target_relation.relname || '|' ||
            ARRAY(
              SELECT attribute.attname
              FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY
                AS key(attnum, ordinal)
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = constraint_row.conrelid
               AND attribute.attnum = key.attnum
              ORDER BY key.ordinal
            )::text || '|' ||
            ARRAY(
              SELECT attribute.attname
              FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY
                AS key(attnum, ordinal)
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = constraint_row.confrelid
               AND attribute.attnum = key.attnum
              ORDER BY key.ordinal
            )::text || '|' || pg_catalog.cardinality(constraint_row.conkey)::text ||
            '|' || constraint_row.confmatchtype::text ||
            constraint_row.confupdtype::text || constraint_row.confdeltype::text ||
            '|' || constraint_row.convalidated::text || '|' ||
            constraint_row.condeferrable::text || '|' ||
            constraint_row.condeferred::text AS signature
          FROM pg_catalog.pg_constraint AS constraint_row
          JOIN pg_catalog.pg_class AS source_relation
            ON source_relation.oid = constraint_row.conrelid
          JOIN managed_namespaces AS source_namespace
            ON source_namespace.oid = source_relation.relnamespace
          JOIN pg_catalog.pg_class AS target_relation
            ON target_relation.oid = constraint_row.confrelid
          JOIN pg_catalog.pg_namespace AS target_namespace
            ON target_namespace.oid = target_relation.relnamespace
          WHERE constraint_row.contype = 'f'
        ) AS rows
      ), '[]'::jsonb),
      'triggers', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            trigger_row.tgname || '|' || trigger_row.tgenabled::text || '|' ||
            ((trigger_row.tgtype & 1) = 1)::text || '|' ||
            ((trigger_row.tgtype & 2) = 2)::text || '|' ||
            ((trigger_row.tgtype & 4) = 4)::text || '|' ||
            ((trigger_row.tgtype & 8) = 8)::text || '|' ||
            ((trigger_row.tgtype & 16) = 16)::text || '|' ||
            ((trigger_row.tgtype & 32) = 32)::text || '|' ||
            function_namespace.nspname || '.' || routine.proname || '(' ||
            pg_catalog.oidvectortypes(routine.proargtypes) || ')|' ||
            routine.prosrc || '|' ||
            pg_catalog.pg_get_triggerdef(trigger_row.oid, false) AS signature
          FROM pg_catalog.pg_trigger AS trigger_row
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = trigger_row.tgrelid
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc AS routine ON routine.oid = trigger_row.tgfoid
          JOIN pg_catalog.pg_namespace AS function_namespace
            ON function_namespace.oid = routine.pronamespace
          WHERE NOT trigger_row.tgisinternal
        ) AS rows
      ), '[]'::jsonb),
      'policies', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '|' || relation.relname || '|' ||
            policy.polname || '|' || policy.polpermissive::text || '|' ||
            policy.polcmd::text || '|' || ARRAY(
              SELECT role_row.rolname::text
              FROM pg_catalog.unnest(policy.polroles) AS role_oid
              JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = role_oid
              ORDER BY role_row.rolname
            )::text || '|' ||
            COALESCE(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '<none>') ||
            '|' || COALESCE(
              pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
              '<none>'
            ) AS signature
          FROM pg_catalog.pg_policy AS policy
          JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
          JOIN managed_namespaces AS namespace
            ON namespace.oid = relation.relnamespace
        ) AS rows
      ), '[]'::jsonb),
      'functions', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            namespace.nspname || '.' || routine.proname || '(' ||
            pg_catalog.oidvectortypes(routine.proargtypes) || ')|' ||
            routine.prokind::text || '|' ||
            pg_catalog.pg_get_function_result(routine.oid) || '|' ||
            language.lanname || '|' || routine.provolatile::text || '|' ||
            routine.prosecdef::text || '|' || routine.proleakproof::text ||
            '|' || routine.proisstrict::text || '|' ||
            routine.proretset::text || '|' || routine.proparallel::text || '|' ||
            COALESCE(
              pg_catalog.format_type(NULLIF(routine.provariadic, 0), NULL),
              '<none>'
            ) || '|' || routine.pronargdefaults::text || '|' ||
            COALESCE(
              pg_catalog.pg_get_expr(routine.proargdefaults, 0, false),
              '<none>'
            ) || '|' ||
            owner.rolname || '|' || COALESCE(routine.proconfig::text, '<none>') ||
            '|' || pg_catalog.md5(routine.prosrc) AS signature
          FROM pg_catalog.pg_proc AS routine
          JOIN managed_namespaces AS namespace
            ON namespace.oid = routine.pronamespace
          JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
        ) AS rows
      ), '[]'::jsonb),
      'acls', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            'database|current_database|' || grantor.rolname || '|' ||
            COALESCE(grantee.rolname, 'PUBLIC') || '|' ||
            privilege.privilege_type || '|' || privilege.is_grantable::text
            AS signature
          FROM pg_catalog.pg_database AS database_row
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            database_row.datacl,
            pg_catalog.acldefault('d', database_row.datdba)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE database_row.datname = pg_catalog.current_database()
          UNION ALL
          SELECT
            'schema|' || namespace.nspname || '|' || grantor.rolname || '|' ||
            COALESCE(grantee.rolname, 'PUBLIC') || '|' ||
            privilege.privilege_type || '|' || privilege.is_grantable::text
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE namespace.nspname = 'public' OR namespace.nspname LIKE 'dasher%'
          UNION ALL
          SELECT
            'relation|' || namespace.nspname || '.' || relation.relname || '|' ||
            grantor.rolname || '|' || COALESCE(grantee.rolname, 'PUBLIC') ||
            '|' || privilege.privilege_type || '|' || privilege.is_grantable::text
          FROM pg_catalog.pg_class AS relation
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            relation.relacl,
            pg_catalog.acldefault(
              CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
              relation.relowner
            )
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
          UNION ALL
          SELECT
            'column|' || namespace.nspname || '.' || relation.relname || '.' ||
            attribute.attname || '|' || grantor.rolname || '|' ||
            COALESCE(grantee.rolname, 'PUBLIC') || '|' ||
            privilege.privilege_type || '|' || privilege.is_grantable::text
          FROM pg_catalog.pg_attribute AS attribute
          JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
          UNION ALL
          SELECT
            'function|' || namespace.nspname || '.' || routine.proname || '(' ||
            pg_catalog.oidvectortypes(routine.proargtypes) || ')|' ||
            grantor.rolname || '|' || COALESCE(grantee.rolname, 'PUBLIC') ||
            '|' || privilege.privilege_type || '|' || privilege.is_grantable::text
          FROM pg_catalog.pg_proc AS routine
          JOIN managed_namespaces AS namespace ON namespace.oid = routine.pronamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          UNION ALL
          SELECT
            'type|' || namespace.nspname || '.' || type_row.typname || '|' ||
            grantor.rolname || '|' || COALESCE(grantee.rolname, 'PUBLIC') ||
            '|' || privilege.privilege_type || '|' || privilege.is_grantable::text
          FROM pg_catalog.pg_type AS type_row
          JOIN managed_namespaces AS namespace ON namespace.oid = type_row.typnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            type_row.typacl,
            pg_catalog.acldefault('T', type_row.typowner)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE type_row.typelem = 0 AND type_row.typname NOT LIKE '\\_%' ESCAPE '\\'
        ) AS rows
      ), '[]'::jsonb),
      'defaultAcls', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT
            owner.rolname || '|' || COALESCE(namespace.nspname, '<global>') ||
            '|' || default_acl.defaclobjtype::text || '|' || grantor.rolname ||
            '|' || COALESCE(grantee.rolname, 'PUBLIC') || '|' ||
            privilege.privilege_type || '|' || privilege.is_grantable::text
            AS signature
          FROM pg_catalog.pg_default_acl AS default_acl
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = default_acl.defaclrole
          LEFT JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = default_acl.defaclnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl)
            AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE owner.rolname = $2
             OR namespace.nspname LIKE 'dasher%'
        ) AS rows
      ), '[]'::jsonb),
      'comments', COALESCE((
        SELECT pg_catalog.jsonb_agg(signature ORDER BY signature)
        FROM (
          SELECT 'database|' || database_row.datname || '|' ||
            pg_catalog.shobj_description(database_row.oid, 'pg_database') AS signature
          FROM pg_catalog.pg_database AS database_row
          WHERE database_row.datname = pg_catalog.current_database()
            AND pg_catalog.shobj_description(
              database_row.oid,
              'pg_database'
            ) IS NOT NULL
          UNION ALL
          SELECT 'schema|' || namespace.nspname || '|' ||
            pg_catalog.obj_description(namespace.oid, 'pg_namespace') AS signature
          FROM managed_namespaces AS namespace
          WHERE pg_catalog.obj_description(namespace.oid, 'pg_namespace') IS NOT NULL
          UNION ALL
          SELECT CASE relation.relkind
              WHEN 'i' THEN 'index'
              WHEN 'I' THEN 'index'
              WHEN 'S' THEN 'sequence'
              ELSE 'relation'
            END || '|' || namespace.nspname || '.' || relation.relname ||
            '|' || pg_catalog.obj_description(relation.oid, 'pg_class')
          FROM pg_catalog.pg_class AS relation
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          WHERE pg_catalog.obj_description(relation.oid, 'pg_class') IS NOT NULL
          UNION ALL
          SELECT 'column|' || namespace.nspname || '.' || relation.relname ||
            '.' || attribute.attname || '|' ||
            pg_catalog.col_description(relation.oid, attribute.attnum)
          FROM pg_catalog.pg_class AS relation
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
          WHERE attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND pg_catalog.col_description(
              relation.oid,
              attribute.attnum
            ) IS NOT NULL
          UNION ALL
          SELECT 'constraint|' || namespace.nspname || '.' || relation.relname ||
            '.' || constraint_row.conname || '|' ||
            pg_catalog.obj_description(constraint_row.oid, 'pg_constraint')
          FROM pg_catalog.pg_constraint AS constraint_row
          JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          WHERE pg_catalog.obj_description(
            constraint_row.oid,
            'pg_constraint'
          ) IS NOT NULL
          UNION ALL
          SELECT 'trigger|' || namespace.nspname || '.' || relation.relname ||
            '.' || trigger_row.tgname || '|' ||
            pg_catalog.obj_description(trigger_row.oid, 'pg_trigger')
          FROM pg_catalog.pg_trigger AS trigger_row
          JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          WHERE NOT trigger_row.tgisinternal
            AND pg_catalog.obj_description(
              trigger_row.oid,
              'pg_trigger'
            ) IS NOT NULL
          UNION ALL
          SELECT 'policy|' || namespace.nspname || '.' || relation.relname ||
            '.' || policy.polname || '|' ||
            pg_catalog.obj_description(policy.oid, 'pg_policy')
          FROM pg_catalog.pg_policy AS policy
          JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
          JOIN managed_namespaces AS namespace ON namespace.oid = relation.relnamespace
          WHERE pg_catalog.obj_description(policy.oid, 'pg_policy') IS NOT NULL
          UNION ALL
          SELECT 'function|' || namespace.nspname || '.' || routine.proname ||
            '(' || pg_catalog.oidvectortypes(routine.proargtypes) || ')|' ||
            pg_catalog.obj_description(routine.oid, 'pg_proc')
          FROM pg_catalog.pg_proc AS routine
          JOIN managed_namespaces AS namespace ON namespace.oid = routine.pronamespace
          WHERE pg_catalog.obj_description(routine.oid, 'pg_proc') IS NOT NULL
          UNION ALL
          SELECT 'type|' || namespace.nspname || '.' || type_row.typname || '|' ||
            pg_catalog.obj_description(type_row.oid, 'pg_type')
          FROM pg_catalog.pg_type AS type_row
          JOIN managed_namespaces AS namespace ON namespace.oid = type_row.typnamespace
          WHERE pg_catalog.obj_description(type_row.oid, 'pg_type') IS NOT NULL
        ) AS rows
      ), '[]'::jsonb)
    ) AS inventory
  )
  SELECT
    inventory = $1::jsonb AS matches
  FROM signature_catalog
`;

interface CatalogSignatureContract {
  readonly acls: readonly string[];
  readonly columns: readonly string[];
  readonly comments: readonly string[];
  readonly constraints: readonly string[];
  readonly defaultAcls: readonly string[];
  readonly foreignKeys: readonly string[];
  readonly functions: readonly string[];
  readonly indexes: readonly string[];
  readonly policies: readonly string[];
  readonly relations: readonly string[];
  readonly schemas: readonly string[];
  readonly sequences: readonly string[];
  readonly triggers: readonly string[];
  readonly types: readonly string[];
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function pgTextArray(values: readonly string[]): string {
  return `{${values
    .map((value) =>
      value.length > 0 && !/^null$/iu.test(value) && !/[{},"\\\s]/u.test(value)
        ? value
        : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",")}}`;
}

function canonicalColumnParts(signature: string): readonly string[] {
  return signature.split("|");
}

function columnSignatureWithCollation(signature: string): string {
  const parts = canonicalColumnParts(signature);
  const typeName = parts[3];
  if (typeName === undefined) {
    throw new Error(`invalid canonical column signature: ${signature}`);
  }
  return [
    ...parts.slice(0, 4),
    catalogCollationIdentity(typeName),
    ...parts.slice(4),
  ].join("|");
}

function pgArrayMembers(value: string): readonly string[] {
  if (value === "{}") return [];
  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw new Error(`invalid expected PostgreSQL array: ${value}`);
  }
  return value.slice(1, -1).split(",");
}

function canonicalIndexSignatureWithClosure(signature: string): string {
  const parts = signature.split("|");
  const relationName = parts[0];
  const keyExpressionArray = parts[10];
  if (relationName === undefined || keyExpressionArray === undefined) {
    throw new Error(`invalid canonical index signature: ${signature}`);
  }
  const keyExpressions = pgArrayMembers(keyExpressionArray);
  const collations = keyExpressions.map((columnName) => {
    const column = canonicalColumnSignatures.find((candidate) => {
      const columnParts = candidate.split("|");
      return columnParts[0] === relationName && columnParts[2] === columnName;
    });
    if (column === undefined) {
      throw new Error(
        `missing canonical index collation column: ${relationName}.${columnName}`,
      );
    }
    const typeName = column.split("|")[3];
    if (typeName === undefined) {
      throw new Error(`invalid canonical column signature: ${column}`);
    }
    return catalogCollationIdentity(typeName);
  });
  return [
    ...parts.slice(0, 10),
    String(keyExpressions.length),
    String(keyExpressions.length),
    keyExpressionArray,
    "{}",
    parts[11],
    pgTextArray(collations),
    parts[12],
  ].join("|");
}

function tableCompositeTypeSignature(
  schemaName: string,
  relationName: string,
  ownerName: string,
  columnSignatures: readonly string[],
): string {
  const definition = columnSignatures
    .filter((signature) => {
      const parts = canonicalColumnParts(signature);
      return parts[0] === schemaName && parts[1] === relationName;
    })
    .map((signature) => {
      const parts = canonicalColumnParts(signature);
      return `${parts[3]} ${parts[4]}`;
    });
  return `${schemaName}|${relationName}|c|C|${ownerName}|${relationName}|<none>|false|<none>|{}|${pgTextArray(definition)}`;
}

function constraintSignatureWithState(
  schemaName: string,
  signature: string,
): string {
  const validationSeparator = signature.lastIndexOf("|");
  const constraintType = signature.split("|", 3)[2];
  const noInherit = constraintType === "p" || constraintType === "u";
  return `${schemaName}|${signature.slice(0, validationSeparator)}|false|false|${signature.slice(validationSeparator + 1)}|${String(noInherit)}`;
}

function aclSignature(
  kind: string,
  identity: string,
  grantor: string,
  grantee: string,
  privilege: string,
  isGrantable = false,
): string {
  return `${kind}|${identity}|${grantor}|${grantee}|${privilege}|${String(isGrantable)}`;
}

function modeledVariadicType(routine: {
  readonly identityArguments: string;
  readonly variadic: boolean;
}): string {
  if (!routine.variadic) return "<none>";
  const lastArgument = routine.identityArguments.split(", ").at(-1);
  if (lastArgument === undefined || !lastArgument.endsWith("[]")) {
    throw new Error("modeled variadic routine must end with an array argument");
  }
  return lastArgument.slice(0, -2);
}

function modeledDefaults(routine: {
  readonly defaults: readonly string[];
}): string {
  return routine.defaults.length === 0 ? "<none>" : routine.defaults.join(", ");
}

function exactCatalogContract(
  journalRows: readonly JournalRow[],
  expectedAppLoginRoleNames: readonly string[],
  databaseIdentity: DatabaseIdentityRow,
  ownerName: string,
): CatalogSignatureContract {
  const hasSecurityBoundary = journalRows.length >= 2;
  const hasSuccessor = journalRows.length >= 3;
  const schemas = ["dasher", "dasher_meta", "dasher_private"];
  if (hasSecurityBoundary) schemas.push("dasher_api");
  if (hasSuccessor) schemas.push("dasher_retention_api");

  const relations = [
    `dasher_meta|schema_migrations|r|${ownerName}|p|false|false|d|<none>`,
    ...task3RelationNames.map(
      (relationName) =>
        `dasher|${relationName}|r|${ownerName}|p|true|true|d|<none>`,
    ),
  ];
  if (hasSuccessor) {
    relations.push(
      ...modeled0003StaticCatalogContract.relations.map(
        (relation) =>
          `${relation.schema}|${relation.name}|${relation.kind}|${ownerName}|${relation.persistence}|${String(relation.rowSecurity)}|${String(relation.forceRowSecurity)}|${relation.replicaIdentity}|${relation.options.length === 0 ? "<none>" : pgTextArray(relation.options)}`,
      ),
    );
  }

  const columns = [
    `dasher_meta|schema_migrations|1|sequence|integer|<none>|true|<none>||`,
    `dasher_meta|schema_migrations|2|filename|text|pg_catalog.default|true|<none>||`,
    `dasher_meta|schema_migrations|3|checksum_sha256|bytea|<none>|true|<none>||`,
    `dasher_meta|schema_migrations|4|applied_at|timestamp with time zone|<none>|true|statement_timestamp()||`,
    `dasher_meta|schema_migrations|5|applied_by|name|pg_catalog.C|true|<none>||`,
    ...canonicalColumnSignatures.map(
      (signature) => `dasher|${columnSignatureWithCollation(signature)}||`,
    ),
  ];
  if (hasSuccessor) {
    columns.push(
      ...modeled0003StaticCatalogContract.columns.map(
        (column) =>
          `dasher|${column.relationName}|${String(column.ordinal)}|${column.columnName}|${column.type}|${column.collation}|${String(!column.nullable)}|${column.defaultExpression ?? "<none>"}|${column.identity}|${column.generated}`,
      ),
    );
  }

  const indexes = [
    `dasher_meta|schema_migrations|schema_migrations_filename_key|btree|true|false|true|true|true|false|<none>|1|1|{filename}|{}|{text_ops}|{pg_catalog.default}|0`,
    `dasher_meta|schema_migrations|schema_migrations_pkey|btree|true|true|true|true|true|false|<none>|1|1|{sequence}|{}|{int4_ops}|{<none>}|0`,
    ...canonicalIndexSignatures.map(
      (signature) => `dasher|${canonicalIndexSignatureWithClosure(signature)}`,
    ),
  ];
  if (hasSuccessor) {
    indexes.push(
      ...modeled0003StaticCatalogContract.indexes.map(
        (index) =>
          `dasher|${index.relation}|${index.name}|${index.method}|${String(index.unique)}|${String(index.primary)}|${String(index.valid)}|${String(index.ready)}|${String(index.live)}|${String(index.nullsNotDistinct)}|${index.predicate ?? "<none>"}|${String(index.keyExpressions.length + index.includedColumns.length)}|${String(index.keyExpressions.length)}|${pgTextArray(index.keyExpressions)}|${pgTextArray(index.includedColumns)}|${pgTextArray(index.opclasses)}|${pgTextArray(index.collations)}|${index.options.join(" ")}`,
      ),
    );
  }

  const journalConstraints = [
    "schema_migrations|schema_migrations_checksum_sha256_check|c|CHECK ((octet_length(checksum_sha256) = 32))|false|false|true|false",
    `schema_migrations|schema_migrations_filename_check|c|CHECK ((filename ~ '${journalFilenamePattern}'::text))|false|false|true|false`,
    "schema_migrations|schema_migrations_filename_key|u|UNIQUE (filename)|false|false|true|true",
    "schema_migrations|schema_migrations_pkey|p|PRIMARY KEY (sequence)|false|false|true|true",
    "schema_migrations|schema_migrations_sequence_check|c|CHECK (((sequence >= 1) AND (sequence <= 9999)))|false|false|true|false",
  ].map((signature) => `dasher_meta|${signature}`);
  const constraints = [
    ...journalConstraints,
    ...canonicalRelationConstraintSignatures
      .filter(
        (signature) =>
          !hasSuccessor ||
          !signature.startsWith("audit_events|audit_events_action_check|"),
      )
      .map((signature) => constraintSignatureWithState("dasher", signature)),
  ];
  if (hasSuccessor) {
    constraints.push(
      ...modeled0003StaticCatalogContract.constraints
        .filter((constraint) => constraint.type !== "FOREIGN KEY")
        .map(
          (constraint) =>
            `dasher|${constraint.relation}|${constraint.name}|${constraint.type === "PRIMARY KEY" ? "p" : "c"}|${constraint.definition}|${String(constraint.deferrable)}|${String(constraint.initiallyDeferred)}|${String(constraint.validated)}|${String(constraint.type === "PRIMARY KEY")}`,
        ),
    );
  }

  const foreignKeys: string[] = [...canonicalForeignKeySignatures];
  if (hasSuccessor) {
    foreignKeys.push(
      ...modeled0003StaticCatalogContract.constraints
        .filter((constraint) => constraint.type === "FOREIGN KEY")
        .map(
          (constraint) =>
            `dasher.${constraint.relation}|${constraint.name}|dasher.${constraint.targetRelation}|${pgTextArray(constraint.columns)}|${pgTextArray(constraint.targetColumns)}|${String(constraint.columns.length)}|${constraint.matchType}${constraint.updateAction}${constraint.deleteAction}|${String(constraint.validated)}|${String(constraint.deferrable)}|${String(constraint.initiallyDeferred)}`,
        ),
    );
  }

  const triggerBody =
    "\nBEGIN\n  RAISE EXCEPTION USING\n    ERRCODE = '55000',\n    MESSAGE = 'immutable relation rejects update and delete';\nEND\n";
  const triggers = [
    `dasher|audit_events|audit_events_immutable|O|true|true|false|true|true|false|dasher_private.reject_immutable_mutation()|${triggerBody}|CREATE TRIGGER audit_events_immutable BEFORE DELETE OR UPDATE ON dasher.audit_events FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_immutable_mutation()`,
  ];
  if (hasSuccessor) {
    triggers.push(
      ...modeled0003StaticCatalogContract.triggers.map((trigger) => {
        const functionName = trigger.functionIdentity.slice(
          "dasher_private.".length,
          -2,
        );
        return `dasher|${trigger.relationName}|${trigger.name}|${trigger.enabled}|true|true|${String((trigger.events as readonly string[]).includes("INSERT"))}|${String((trigger.events as readonly string[]).includes("DELETE"))}|${String((trigger.events as readonly string[]).includes("UPDATE"))}|false|${trigger.functionIdentity}|${modeledFunctionSource("dasher_private", functionName)}|${trigger.definition}`;
      }),
    );
  }

  const policies = hasSecurityBoundary
    ? task4Policies.map(
        (policy) =>
          `dasher|${policy.relation}|${policy.name}|${String(policy.permissive)}|${policy.command}|${pgTextArray(policy.roles)}|${policy.usingExpression}|${policy.withCheckExpression ?? "<none>"}`,
      )
    : [];
  if (hasSuccessor) {
    policies.push(
      ...modeled0003StaticCatalogContract.policies.map(
        (policy) =>
          `dasher|${policy.relation}|${policy.name}|${String(policy.permissive)}|${policy.catalogCommand}|${pgTextArray(policy.roles)}|${policy.using}|${policy.withCheck ?? "<none>"}`,
      ),
    );
  }

  const functions = [
    `dasher_private.reject_immutable_mutation()|f|trigger|plpgsql|v|false|false|false|false|u|<none>|0|<none>|${ownerName}|{search_path=pg_catalog}|${canonicalFunctionBodyMd5["dasher_private.reject_immutable_mutation"]}`,
  ];
  if (hasSecurityBoundary) {
    functions.push(
      ...task4FunctionCatalogRows.map((functionRow) => {
        const functionName = functionRow.identity.slice(
          0,
          functionRow.identity.indexOf("("),
        ) as keyof typeof canonicalFunctionBodyMd5;
        return `${functionRow.identity}|f|${functionRow.result}|plpgsql|${functionRow.volatility}|true|false|false|${String(functionRow.result.startsWith("TABLE("))}|u|<none>|0|<none>|dasher_security_definer|{search_path=pg_catalog}|${canonicalFunctionBodyMd5[functionName]}`;
      }),
    );
  }
  if (hasSuccessor) {
    functions.push(
      ...modeled0003StaticCatalogContract.functions.map((routine) => {
        const identity = `${routine.schema}.${routine.name}(${routine.identityArguments})`;
        return `${identity}|f|${routine.returns}|${routine.language}|v|${String(routine.securityDefiner)}|false|false|${String(routine.returns.startsWith("SETOF "))}|u|${modeledVariadicType(routine)}|${String(routine.defaults.length)}|${modeledDefaults(routine)}|${routine.owner === "migration_owner" ? ownerName : routine.owner}|${pgTextArray(routine.proconfig)}|${createHash("md5").update(routine.source).digest("hex")}`;
      }),
    );
  }

  const typeRelationNames = ["schema_migrations", ...task3RelationNames];
  const types = typeRelationNames.map((relationName) =>
    tableCompositeTypeSignature(
      relationName === "schema_migrations" ? "dasher_meta" : "dasher",
      relationName,
      ownerName,
      columns,
    ),
  );
  if (hasSuccessor) {
    types.push(
      ...modeled0003StaticCatalogContract.types.map(
        (typeRow) =>
          `dasher|${typeRow.name}|${typeRow.kind}|${typeRow.category}|${ownerName}|${typeRow.relation}|<none>|false|<none>|{}|${pgTextArray(typeRow.definition)}`,
      ),
    );
  }

  const acls: string[] = [];
  for (const privilege of ["CONNECT", "CREATE", "TEMPORARY"]) {
    acls.push(
      aclSignature(
        "database",
        "current_database",
        ownerName,
        ownerName,
        privilege,
      ),
    );
  }
  acls.push(
    aclSignature(
      "database",
      "current_database",
      ownerName,
      "PUBLIC",
      "CONNECT",
    ),
  );
  acls.push(
    aclSignature("schema", "public", "pg_database_owner", "PUBLIC", "USAGE"),
    aclSignature(
      "schema",
      "public",
      "pg_database_owner",
      "pg_database_owner",
      "CREATE",
    ),
    aclSignature(
      "schema",
      "public",
      "pg_database_owner",
      "pg_database_owner",
      "USAGE",
    ),
  );
  for (const schemaName of schemas) {
    for (const privilege of ["CREATE", "USAGE"]) {
      acls.push(
        aclSignature("schema", schemaName, ownerName, ownerName, privilege),
      );
    }
  }
  for (const relation of relations) {
    const [schemaName, relationName] = relation.split("|");
    for (const privilege of [
      "DELETE",
      "INSERT",
      "REFERENCES",
      "SELECT",
      "TRIGGER",
      "TRUNCATE",
      "UPDATE",
    ]) {
      acls.push(
        aclSignature(
          "relation",
          `${schemaName}.${relationName}`,
          ownerName,
          ownerName,
          privilege,
        ),
      );
    }
  }
  for (const typeSignature of types) {
    const [schemaName, typeName] = typeSignature.split("|");
    acls.push(
      aclSignature(
        "type",
        `${schemaName}.${typeName}`,
        ownerName,
        ownerName,
        "USAGE",
      ),
    );
    if (
      (schemaName === "dasher_meta" && typeName === "schema_migrations") ||
      (schemaName === "dasher" &&
        typeName !== undefined &&
        (task3RelationNames as readonly string[]).includes(typeName))
    ) {
      acls.push(
        aclSignature(
          "type",
          `${schemaName}.${typeName}`,
          ownerName,
          "PUBLIC",
          "USAGE",
        ),
      );
    }
  }
  acls.push(
    aclSignature(
      "function",
      "dasher_private.reject_immutable_mutation()",
      ownerName,
      ownerName,
      "EXECUTE",
    ),
  );
  if (hasSecurityBoundary) {
    for (const functionRow of task4FunctionCatalogRows) {
      acls.push(
        aclSignature(
          "function",
          functionRow.identity,
          "dasher_security_definer",
          "dasher_security_definer",
          "EXECUTE",
        ),
      );
    }
  }

  const dependencyEntries = expectedDependencyInventory(
    journalRows,
    expectedAppLoginRoleNames,
    databaseIdentity,
    ownerName,
  );
  for (const dependency of dependencyEntries) {
    if (dependency.dependency_type !== "a") continue;
    const identity =
      dependency.object_kind === "database"
        ? "current_database"
        : dependency.object_kind === "schema"
          ? dependency.object_name
          : dependency.object_kind === "function"
            ? `${dependency.schema_name}.${dependency.object_name}(${dependency.function_arguments})`
            : dependency.object_kind === "column"
              ? `${dependency.schema_name}.${dependency.object_name}.${dependency.subobject_name}`
              : `${dependency.schema_name}.${dependency.object_name}`;
    acls.push(
      aclSignature(
        dependency.object_kind,
        identity,
        dependency.grantor_name ?? ownerName,
        dependency.role_name,
        dependency.privilege_type ?? "",
        dependency.is_grantable ?? false,
      ),
    );
  }
  if (hasSuccessor) {
    for (const routine of modeled0003StaticCatalogContract.functions) {
      const identity = `${routine.schema}.${routine.name}(${routine.identityArguments})`;
      const actualOwner =
        routine.owner === "migration_owner" ? ownerName : routine.owner;
      acls.push(
        aclSignature("function", identity, actualOwner, actualOwner, "EXECUTE"),
      );
    }
  }

  return {
    schemas: sortedStrings(schemas.map((name) => `${name}|${ownerName}`)),
    relations: sortedStrings(relations),
    columns: sortedStrings(columns),
    sequences: [],
    types: sortedStrings(types),
    indexes: sortedStrings(indexes),
    constraints: sortedStrings(constraints),
    foreignKeys: sortedStrings(foreignKeys),
    triggers: sortedStrings(triggers),
    policies: sortedStrings(policies),
    functions: sortedStrings(functions),
    acls: sortedStrings(acls),
    defaultAcls: sortedStrings([
      `${ownerName}|<global>|T|${ownerName}|${ownerName}|USAGE|false`,
      `${ownerName}|<global>|f|${ownerName}|${ownerName}|EXECUTE|false`,
    ]),
    comments: sortedStrings(
      hasSuccessor ? modeled0003StaticCatalogContract.comments : [],
    ),
  };
}

async function assertCanonicalPrefixObjects(
  client: MigrationClient,
  journalRows: readonly JournalRow[],
  exactCanonicalFiles: boolean,
  expectedAppLoginRoleNames: readonly string[],
  databaseIdentity: DatabaseIdentityRow,
  ownerName: string,
): Promise<void> {
  if (!exactCanonicalFiles || journalRows.length === 0) {
    return;
  }

  const expected = exactCatalogContract(
    journalRows,
    expectedAppLoginRoleNames,
    databaseIdentity,
    ownerName,
  );
  const result = await client.query<DependencyComparisonRow>(
    exactManagedCatalogInventorySql,
    [JSON.stringify(expected), ownerName],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true) {
    return reject("managed_role_drift");
  }
}

function dependencyEntry(
  values: Omit<
    ManagedDependencyInventoryEntry,
    | "is_grantable"
    | "policy_command"
    | "policy_name"
    | "policy_permissive"
    | "policy_roles"
    | "policy_using_expression"
    | "policy_with_check_expression"
  > &
    Partial<
      Pick<
        ManagedDependencyInventoryEntry,
        | "is_grantable"
        | "policy_command"
        | "policy_name"
        | "policy_permissive"
        | "policy_roles"
        | "policy_using_expression"
        | "policy_with_check_expression"
      >
    >,
): ManagedDependencyInventoryEntry {
  return {
    is_grantable: values.dependency_type === "a" ? false : null,
    policy_command: null,
    policy_name: null,
    policy_permissive: null,
    policy_roles: null,
    policy_using_expression: null,
    policy_with_check_expression: null,
    ...values,
  };
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

  for (const policy of task4Policies) {
    entries.push(
      dependencyEntry({
        catalog_name: "pg_policy",
        database_oid: databaseIdentity.database_oid,
        dependency_type: "r",
        function_arguments: null,
        grantor_name: null,
        object_kind: "policy",
        object_name: policy.relation,
        policy_command: policy.command,
        policy_name: policy.name,
        policy_permissive: policy.permissive,
        policy_roles: policy.roles,
        policy_using_expression: policy.usingExpression,
        policy_with_check_expression: policy.withCheckExpression,
        privilege_type: null,
        role_name: "dasher_app",
        schema_name: "dasher",
        subobject_name: null,
      }),
    );
  }

  const hasModeledSuccessor = journalRows.some(
    (row) =>
      row.sequence === 3 && row.filename === "0003_immutable_content.sql",
  );
  if (hasModeledSuccessor) {
    const functionIdentityParts = (
      identity: string,
    ): {
      readonly arguments: string;
      readonly name: string;
      readonly schema: string;
    } => {
      const openParenthesis = identity.indexOf("(");
      const schemaSeparator = identity.indexOf(".");
      if (
        openParenthesis < 0 ||
        !identity.endsWith(")") ||
        schemaSeparator < 1 ||
        schemaSeparator > openParenthesis
      ) {
        throw new Error(`invalid modeled function dependency: ${identity}`);
      }
      return {
        arguments: identity.slice(openParenthesis + 1, -1),
        name: identity.slice(schemaSeparator + 1, openParenthesis),
        schema: identity.slice(0, schemaSeparator),
      };
    };

    for (const row of modeled0003StaticCatalogContract.ownershipDependencyRows) {
      const identity = functionIdentityParts(row.identity);
      entries.push(
        dependencyEntry({
          catalog_name: row.catalog,
          database_oid: databaseIdentity.database_oid,
          dependency_type: row.dependencyType,
          function_arguments: identity.arguments,
          grantor_name: null,
          object_kind: row.objectKind,
          object_name: identity.name,
          privilege_type: null,
          role_name: row.roleName,
          schema_name: identity.schema,
          subobject_name: null,
        }),
      );
    }

    for (const row of modeled0003StaticCatalogContract.aclDependencyRows) {
      let functionArguments: string | null = null;
      let objectName: string;
      let schemaName: string;
      let subobjectName: string | null = null;
      if (row.objectKind === "schema") {
        objectName = row.identity;
        schemaName = row.identity;
      } else if (row.objectKind === "function") {
        const identity = functionIdentityParts(row.identity);
        functionArguments = identity.arguments;
        objectName = identity.name;
        schemaName = identity.schema;
      } else {
        const [schema, relation, column] = row.identity.split(".");
        if (schema === undefined || relation === undefined) {
          throw new Error(`invalid modeled ACL dependency: ${row.identity}`);
        }
        objectName = relation;
        schemaName = schema;
        subobjectName = row.objectKind === "column" ? (column ?? null) : null;
      }
      entries.push(
        dependencyEntry({
          catalog_name: row.catalog,
          database_oid: databaseIdentity.database_oid,
          dependency_type: row.dependencyType,
          function_arguments: functionArguments,
          grantor_name:
            row.grantor === "migration_owner" ? ownerName : row.grantor,
          is_grantable: row.isGrantable,
          object_kind: row.objectKind,
          object_name: objectName,
          privilege_type: row.privilege,
          role_name: row.grantee,
          schema_name: schemaName,
          subobject_name: subobjectName,
        }),
      );
    }

    for (const row of modeled0003StaticCatalogContract.policyDependencyRows) {
      const [schemaName, relationName, policyName] = row.identity.split(".");
      if (
        schemaName === undefined ||
        relationName === undefined ||
        policyName === undefined
      ) {
        throw new Error(`invalid modeled policy dependency: ${row.identity}`);
      }
      entries.push(
        dependencyEntry({
          catalog_name: row.catalog,
          database_oid: databaseIdentity.database_oid,
          dependency_type: row.dependencyType,
          function_arguments: null,
          grantor_name: null,
          object_kind: row.objectKind,
          object_name: relationName,
          policy_command: row.command,
          policy_name: policyName,
          policy_permissive: row.permissive,
          policy_roles: row.roles,
          policy_using_expression: row.using,
          policy_with_check_expression: row.withCheck,
          privilege_type: null,
          role_name: row.roleName,
          schema_name: schemaName,
          subobject_name: null,
        }),
      );
    }
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
  const targetRoleNames = [
    ...allManagedRoleNames,
    ...expectedAppLoginRoleNames,
  ];
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

interface ValidatedMigrationPrefix {
  readonly baseRolesMissing: boolean;
  readonly journalExists: boolean;
  readonly journalRows: readonly JournalRow[];
  readonly ownerName: string;
  readonly preparedRolesPresent: boolean;
}

async function validateMigrationPrefix(
  client: MigrationClient,
  migrations: readonly DiscoveredMigration[],
  expectedAppLoginRoleNames: readonly string[],
  exactCanonicalFiles: boolean,
  modeledSuccessorPresent: boolean,
): Promise<ValidatedMigrationPrefix> {
  const ownerName = await assertExecutor(client);
  const exists = await journalExists(client);
  const baseRolesMissing = await baseManagedRolesAreMissing(client);

  if (!exists) {
    await assertNoAdoptionConflict(client);
    await assertPreparedRetentionRolesAbsent(client);
    if (baseRolesMissing) {
      if (expectedAppLoginRoleNames.length !== 0) {
        return reject("managed_role_drift");
      }
      return {
        baseRolesMissing: true,
        journalExists: false,
        journalRows: [],
        ownerName,
        preparedRolesPresent: false,
      };
    }

    const databaseIdentity = await assertRoleAndLoginState(
      client,
      expectedAppLoginRoleNames,
      false,
    );
    await assertDependencyInventory(
      client,
      [],
      expectedAppLoginRoleNames,
      databaseIdentity,
      ownerName,
    );
    return {
      baseRolesMissing: false,
      journalExists: false,
      journalRows: [],
      ownerName,
      preparedRolesPresent: false,
    };
  }

  if (baseRolesMissing) {
    return reject("managed_role_drift");
  }
  await assertJournalShape(client, ownerName);
  const journalRows = await readJournal(client);
  assertJournalPrefix(journalRows, migrations, ownerName);
  let preparedRolesPresent = false;
  if (journalRows.length < 2 || !modeledSuccessorPresent) {
    await assertPreparedRetentionRolesAbsent(client);
  } else if (journalRows.length === 2) {
    preparedRolesPresent = await preparedRetentionRolesAreExact(client, true);
  } else {
    preparedRolesPresent = await preparedRetentionRolesAreExact(client, false);
  }

  const databaseIdentity = await assertRoleAndLoginState(
    client,
    expectedAppLoginRoleNames,
    false,
  );
  await assertCanonicalPrefixObjects(
    client,
    journalRows,
    exactCanonicalFiles,
    expectedAppLoginRoleNames,
    databaseIdentity,
    ownerName,
  );
  await assertDependencyInventory(
    client,
    journalRows,
    expectedAppLoginRoleNames,
    databaseIdentity,
    ownerName,
  );
  return {
    baseRolesMissing: false,
    journalExists: true,
    journalRows,
    ownerName,
    preparedRolesPresent,
  };
}

async function releaseAdvisorySessionGate(
  client: MigrationClient,
): Promise<void> {
  const result = await client.query<AdvisoryUnlockRow>(
    advisorySessionUnlockSql,
  );
  if (result.rows.length !== 1 || result.rows[0]?.unlocked !== true) {
    throw new Error(gateReleaseFailureMessage);
  }
}

/**
 * Explicit recovery for the sole accepted 0002 + prepared-retention-pair
 * residue. It validates the exact owner, files, journal, schema, roles, and
 * dependency-free pair before dropping only operator then definer. The runner
 * never calls this operation automatically.
 */
export async function resetPreparedRetentionRoles(
  pool: MigrationPool,
  directory: string,
  expectedAppLoginRoleNames: readonly string[],
): Promise<void> {
  const validatedRoleNames = validateExpectedAppLoginRoleNames(
    expectedAppLoginRoleNames,
  );
  const client = await pool.connect();
  const state: MigrationClientState = {
    normalReleaseAllowed: true,
    released: false,
  };
  let operationError: unknown;
  let operationSucceeded = false;
  let sessionGateHeld = false;

  try {
    try {
      await client.query(advisorySessionLockSql);
    } catch (error) {
      destroyClientAfterAmbiguousGateAcquisition(client, state, error);
      throw error;
    }
    sessionGateHeld = true;
    const migrations = await discoverMigrations(directory);
    assertKnownCanonicalFileIdentity(migrations);
    const modeledSuccessorPresent = hasModeledSuccessor(migrations);
    if (
      !hasExactCanonical0002Files(migrations) ||
      (migrations.length !== 2 && !modeledSuccessorPresent)
    ) {
      return reject("migration_file_mismatch");
    }

    await runMigrationTransaction(
      client,
      state,
      async () => {
        const prefix = await validateMigrationPrefix(
          client,
          migrations,
          validatedRoleNames,
          true,
          true,
        );
        if (prefix.journalRows.length !== 2 || !prefix.preparedRolesPresent) {
          return reject("managed_role_drift");
        }
        await client.query("DROP ROLE dasher_retention_operator");
        await client.query("DROP ROLE dasher_retention_definer");
        await assertPreparedRetentionRolesAbsent(client);
      },
      false,
    );
    operationSucceeded = true;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (sessionGateHeld && !state.released) {
      try {
        await releaseAdvisorySessionGate(client);
        sessionGateHeld = false;
      } catch {
        const diagnostic = destroyClientAfterGateReleaseFailure(
          client,
          state,
          operationError,
        );
        if (operationError === undefined) {
          throw diagnostic;
        }
      }
    }
    if (!state.released && state.normalReleaseAllowed) {
      state.released = true;
      try {
        client.release();
      } catch (releaseError) {
        if (operationSucceeded) {
          throw releaseError;
        }
      }
    }
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
  const client = await pool.connect();
  const state: MigrationClientState = {
    normalReleaseAllowed: true,
    released: false,
  };
  let operationSucceeded = false;
  let operationError: unknown;
  let sessionGateHeld = false;

  try {
    try {
      await client.query(advisorySessionLockSql);
    } catch (error) {
      destroyClientAfterAmbiguousGateAcquisition(client, state, error);
      throw error;
    }
    sessionGateHeld = true;
    const migrations = await discoverMigrations(directory);
    assertKnownCanonicalFileIdentity(migrations);
    const modeledSuccessorPresent = hasModeledSuccessor(migrations);
    const exactCanonicalFiles = hasExactCanonical0002Files(migrations);

    let prefix = await runMigrationTransaction(
      client,
      state,
      () =>
        validateMigrationPrefix(
          client,
          migrations,
          validatedRoleNames,
          exactCanonicalFiles,
          modeledSuccessorPresent,
        ),
      false,
    );
    const previouslyAppliedCount = prefix.journalRows.length;

    if (prefix.baseRolesMissing) {
      await runMigrationTransaction(
        client,
        state,
        async () => {
          await assertExecutor(client);
          await assertNoAdoptionConflict(client);
          await assertPreparedRetentionRolesAbsent(client);
          await assertRoleAndLoginState(client, validatedRoleNames, true);
        },
        false,
      );
    }

    const applyThrough = async (targetCount: number): Promise<void> => {
      prefix = await runMigrationTransaction(
        client,
        state,
        async () => {
          const before = await validateMigrationPrefix(
            client,
            migrations,
            validatedRoleNames,
            exactCanonicalFiles,
            modeledSuccessorPresent,
          );
          if (before.journalRows.length > targetCount) {
            return reject("journal_identity_mismatch");
          }
          if (!before.journalExists) {
            await createJournal(client);
          }

          for (const migration of migrations.slice(
            before.journalRows.length,
            targetCount,
          )) {
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
              [
                migration.sequence,
                migration.filename,
                migration.checksumSha256,
              ],
            );
          }

          const after = await validateMigrationPrefix(
            client,
            migrations,
            validatedRoleNames,
            exactCanonicalFiles,
            modeledSuccessorPresent,
          );
          if (after.journalRows.length !== targetCount) {
            return reject("journal_identity_mismatch");
          }
          return after;
        },
        false,
      );
    };

    const prefixTarget = modeledSuccessorPresent ? 2 : migrations.length;
    let appliedPrefix = false;
    if (prefix.journalRows.length < prefixTarget) {
      await applyThrough(prefixTarget);
      appliedPrefix = true;
    }

    if (modeledSuccessorPresent && prefix.journalRows.length === 2) {
      await runMigrationTransaction(
        client,
        state,
        async () => {
          const before = await validateMigrationPrefix(
            client,
            migrations,
            validatedRoleNames,
            exactCanonicalFiles,
            modeledSuccessorPresent,
          );
          if (before.journalRows.length !== 2) {
            return reject("journal_identity_mismatch");
          }
          if (!before.preparedRolesPresent) {
            await createPreparedRetentionRoles(client);
          }
          if (!(await preparedRetentionRolesAreExact(client, false))) {
            return reject("managed_role_drift");
          }
          const databaseIdentity = await assertRoleAndLoginState(
            client,
            validatedRoleNames,
            false,
          );
          await assertDependencyInventory(
            client,
            before.journalRows,
            validatedRoleNames,
            databaseIdentity,
            before.ownerName,
          );
        },
        false,
      );
      await applyThrough(3);
    } else if (
      !appliedPrefix &&
      prefix.journalRows.length === migrations.length
    ) {
      await applyThrough(migrations.length);
    }

    const result = {
      discoveredCount: migrations.length,
      previouslyAppliedCount,
      appliedCount: migrations.length - previouslyAppliedCount,
    };
    operationSucceeded = true;
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (sessionGateHeld && !state.released) {
      try {
        await releaseAdvisorySessionGate(client);
        sessionGateHeld = false;
      } catch {
        const diagnostic = destroyClientAfterGateReleaseFailure(
          client,
          state,
          operationError,
        );
        if (operationError === undefined) {
          throw diagnostic;
        }
      }
    }
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
