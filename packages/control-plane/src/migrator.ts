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
      "60e47f9723ce7fa03a14affbecc82d32e46ce9a60107100fc23caf05c549c96a",
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
      'pg_class'::text,
      'relation'::text,
      namespace.nspname::text,
      relation.relname::text,
      NULL::text,
      NULL::text,
      privilege.privilege_type::text,
      grantor.rolname::text
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

const task3RelationNames = [
  "audit_events",
  "external_identities",
  "invitations",
  "memberships",
  "organizations",
  "sessions",
  "users",
] as const;

const modeled0003RelationNames = [
  "artifact_deletion_finalizers",
  "artifact_reference_claims",
  "backup_deletion_ledger",
  "dashboard_artifacts",
  "dashboard_cleanup_attempts",
  "dashboard_cleanup_coordination",
  "dashboard_legal_holds",
  "dashboard_lifecycle_events",
  "dashboard_lifecycle_policies",
  "dashboard_promotion_decisions",
  "dashboard_promotion_requests",
  "dashboard_restore_lineage",
  "dashboard_tombstones",
  "dashboard_version_evidence",
  "dashboard_version_snapshots",
  "dashboard_versions",
  "dashboards",
  "evidence_deletion_finalizers",
  "evidence_records",
  "evidence_reference_claims",
  "retention_service_principal_allowlist",
  "snapshot_deletion_finalizers",
  "snapshot_reference_claims",
  "source_snapshots",
] as const;

const modeled0003RelationGrants = [
  {
    roleName: "dasher_security_definer",
    privilege: "SELECT",
    relations: [
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_promotion_requests",
      "dashboard_promotion_decisions",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ],
  },
  {
    roleName: "dasher_security_definer",
    privilege: "INSERT",
    relations: [
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_promotion_requests",
      "dashboard_promotion_decisions",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    privilege: "SELECT",
    relations: [
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_cleanup_coordination",
      "dashboard_cleanup_attempts",
      "dashboard_legal_holds",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "retention_service_principal_allowlist",
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    privilege: "INSERT",
    relations: [
      "dashboard_lifecycle_events",
      "dashboard_cleanup_coordination",
      "dashboard_cleanup_attempts",
      "dashboard_legal_holds",
      "dashboard_tombstones",
      "backup_deletion_ledger",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    privilege: "DELETE",
    relations: [
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ],
  },
] as const;

const modeled0003UpdateColumnGrants = [
  {
    roleName: "dasher_security_definer",
    relation: "dashboards",
    columns: [
      "head_version_id",
      "lifecycle_state",
      "lifecycle_revision",
      "capability_epoch",
      "cache_epoch",
      "current_kind",
      "effective_expires_at",
      "promoted_at",
      "archived_at",
      "access_revoked_at",
      "revocation_reason",
      "purge_after",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    relation: "dashboards",
    columns: [
      "lifecycle_state",
      "lifecycle_revision",
      "capability_epoch",
      "cache_epoch",
      "access_revoked_at",
      "revocation_reason",
      "purge_after",
      "purge_started_at",
      "purged_at",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    relation: "dashboard_cleanup_coordination",
    columns: [
      "current_step",
      "lease_owner",
      "lease_expires_at",
      "expected_lifecycle_revision",
      "next_attempt_at",
      "completion_proof_sha256",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    relation: "dashboard_legal_holds",
    columns: [
      "released_at",
      "released_by_principal_id",
      "released_authority_revision",
      "released_actor",
      "released_reason_sha256",
    ],
  },
  {
    roleName: "dasher_retention_definer",
    relation: "dashboard_tombstones",
    columns: ["purged_at", "purged_lifecycle_revision", "purged_proof_sha256"],
  },
  ...[
    "snapshot_deletion_finalizers",
    "evidence_deletion_finalizers",
    "artifact_deletion_finalizers",
  ].map((relation) => ({
    roleName: "dasher_retention_definer" as const,
    relation,
    columns: [
      "state",
      "lease_owner",
      "lease_expires_at",
      "proof_sha256",
      "bytes_deleted_at",
    ],
  })),
] as const;

const modeled0003FunctionSignatures = [
  { schema: "dasher_api", name: "list_dashboards", arguments: "integer" },
  {
    schema: "dasher_api",
    name: "get_dashboard_summary",
    arguments: "uuid",
  },
  { schema: "dasher_api", name: "get_dashboard_head", arguments: "uuid" },
  {
    schema: "dasher_api",
    name: "get_dashboard_version",
    arguments: "uuid, uuid",
  },
  {
    schema: "dasher_api",
    name: "get_dashboard_evidence",
    arguments: "uuid, uuid",
  },
  {
    schema: "dasher_api",
    name: "get_dashboard_lineage",
    arguments: "uuid, uuid",
  },
  {
    schema: "dasher_api",
    name: "get_dashboard_admin_status",
    arguments: "uuid",
  },
  {
    schema: "dasher_api",
    name: "create_dashboard",
    arguments: "uuid, text, text, integer, boolean, uuid, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "create_evidence_record",
    arguments:
      "uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "create_dashboard_version",
    arguments:
      "uuid, uuid, uuid, bytea, bytea, uuid, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid, text",
  },
  {
    schema: "dasher_api",
    name: "compare_and_swap_dashboard_head",
    arguments: "uuid, uuid, uuid, bigint, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "request_dashboard_promotion",
    arguments: "uuid, uuid, bigint, bytea, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "decide_dashboard_promotion",
    arguments: "uuid, uuid, uuid, bigint, text, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "set_dashboard_archive",
    arguments: "uuid, boolean, bigint, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "delete_dashboard",
    arguments: "uuid, bigint, uuid, text",
  },
  {
    schema: "dasher_api",
    name: "restore_dashboard_as_new",
    arguments: "uuid, uuid, uuid, uuid, text, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "initialize_operator_context",
    arguments: "uuid, text, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "materialize_dashboard_expiry",
    arguments: "uuid, bigint, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "place_dashboard_legal_hold",
    arguments: "uuid, uuid, text, bytea, bigint, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "release_dashboard_legal_hold",
    arguments: "uuid, uuid, bytea, bigint, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "claim_dashboard_cleanup",
    arguments: "uuid, text, bigint, text, interval, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "record_dashboard_cleanup_attempt",
    arguments:
      "uuid, uuid, text, text, integer, integer, integer, bytea, uuid, text",
  },
  {
    schema: "dasher_retention_api",
    name: "purge_dashboard",
    arguments: "uuid, bigint, uuid, text",
  },
  {
    schema: "dasher_private",
    name: "reject_dashboard_append_mutation",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "enforce_dashboard_transition",
    arguments: "",
  },
  {
    schema: "dasher_private",
    name: "enforce_retention_mutation",
    arguments: "",
  },
] as const;

const modeled0003FunctionReturns = [
  "SETOF dasher.dashboard_summary",
  "dasher.dashboard_summary",
  "uuid",
  "dasher.dashboard_version_projection",
  "SETOF dasher.dashboard_evidence_projection",
  "SETOF dasher.dashboard_lineage_projection",
  "dasher.dashboard_admin_projection",
  "uuid",
  "void",
  "uuid",
  "void",
  "uuid",
  "void",
  "void",
  "void",
  "void",
  "void",
  "void",
  "void",
  "void",
  "void",
  "void",
  "void",
  "trigger",
  "trigger",
  "trigger",
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
  readonly dependency_type: "a" | "o";
  readonly function_arguments: string | null;
  readonly grantor_name: string | null;
  readonly object_kind:
    "column" | "database" | "function" | "relation" | "schema";
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
  const usesCanonicalIdentity =
    migrations[0]?.filename === modeledSuccessorFiles[0].filename ||
    migrations[1]?.filename === modeledSuccessorFiles[1].filename;
  if (!usesCanonicalIdentity) {
    return;
  }

  for (const [index, migration] of migrations.slice(0, 2).entries()) {
    const expected = modeledSuccessorFiles[index];
    if (
      expected === undefined ||
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

const canonicalPrefixObjectInventorySql = `
  WITH
  expected_schemas AS (
    SELECT pg_catalog.unnest($1::text[]) AS schema_name
  ),
  actual_schemas AS (
    SELECT namespace.nspname::text AS schema_name
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname LIKE 'dasher%'
  ),
  expected_relations AS (
    SELECT pg_catalog.unnest($2::text[]) AS relation_name
  ),
  actual_relations AS (
    SELECT relation.relname::text AS relation_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'dasher'
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  ),
  expected_columns AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset($4::jsonb) AS expected(
      relation_name text,
      column_name text
    )
  ),
  actual_columns AS (
    SELECT
      relation.relname::text AS relation_name,
      attribute.attname::text AS column_name
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'dasher'
      AND relation.relname = ANY($5::text[])
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  expected_functions AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset($3::jsonb) AS expected(
      schema_name text,
      function_name text,
      identity_arguments text
    )
  ),
  actual_functions AS (
    SELECT
      namespace.nspname::text AS schema_name,
      routine.proname::text AS function_name,
      pg_catalog.oidvectortypes(routine.proargtypes) AS identity_arguments
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname IN (
      'dasher_api',
      'dasher_private',
      'dasher_retention_api'
    )
      AND routine.prokind = 'f'
  ),
  schema_difference AS (
    (SELECT * FROM actual_schemas EXCEPT ALL SELECT * FROM expected_schemas)
    UNION ALL
    (SELECT * FROM expected_schemas EXCEPT ALL SELECT * FROM actual_schemas)
  ),
  relation_difference AS (
    (SELECT * FROM actual_relations EXCEPT ALL SELECT * FROM expected_relations)
    UNION ALL
    (SELECT * FROM expected_relations EXCEPT ALL SELECT * FROM actual_relations)
  ),
  column_difference AS (
    (SELECT * FROM actual_columns EXCEPT ALL SELECT * FROM expected_columns)
    UNION ALL
    (SELECT * FROM expected_columns EXCEPT ALL SELECT * FROM actual_columns)
  ),
  function_difference AS (
    (SELECT * FROM actual_functions EXCEPT ALL SELECT * FROM expected_functions)
    UNION ALL
    (SELECT * FROM expected_functions EXCEPT ALL SELECT * FROM actual_functions)
  )
  SELECT
    NOT EXISTS (SELECT 1 FROM schema_difference)
    AND NOT EXISTS (SELECT 1 FROM relation_difference)
    AND NOT EXISTS (SELECT 1 FROM column_difference)
    AND NOT EXISTS (SELECT 1 FROM function_difference)
    AS matches
`;

const modeledSuccessorCatalogInventorySql = `
  WITH
  expected_functions AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS expected(
      schema_name text,
      function_name text,
      identity_arguments text,
      result_type text,
      language_name text,
      volatility "char",
      security_definer boolean,
      owner_name text,
      proconfig text[],
      execute_grantees text[]
    )
  ),
  actual_functions AS (
    SELECT
      namespace.nspname::text AS schema_name,
      routine.proname::text AS function_name,
      pg_catalog.oidvectortypes(routine.proargtypes) AS identity_arguments,
      pg_catalog.pg_get_function_result(routine.oid) AS result_type,
      language.lanname::text AS language_name,
      routine.provolatile AS volatility,
      routine.prosecdef AS security_definer,
      owner.rolname::text AS owner_name,
      routine.proconfig,
      COALESCE(
        (
          SELECT pg_catalog.array_agg(
            COALESCE(grantee.rolname::text, 'PUBLIC')
            ORDER BY COALESCE(grantee.rolname::text, 'PUBLIC')
          )
          FROM pg_catalog.aclexplode(
            COALESCE(
              routine.proacl,
              pg_catalog.acldefault('f', routine.proowner)
            )
          ) AS privilege
          LEFT JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          WHERE privilege.privilege_type = 'EXECUTE'
        ),
        ARRAY[]::text[]
      ) AS execute_grantees
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    JOIN pg_catalog.pg_language AS language
      ON language.oid = routine.prolang
    JOIN pg_catalog.pg_roles AS owner
      ON owner.oid = routine.proowner
    WHERE (
      namespace.nspname = 'dasher_api'
      AND routine.proname = ANY($2::text[])
    ) OR namespace.nspname = 'dasher_retention_api'
      OR (
        namespace.nspname = 'dasher_private'
        AND routine.proname = ANY($3::text[])
      )
  ),
  function_difference AS (
    (SELECT * FROM actual_functions EXCEPT ALL SELECT * FROM expected_functions)
    UNION ALL
    (SELECT * FROM expected_functions EXCEPT ALL SELECT * FROM actual_functions)
  ),
  modeled_initializer AS (
    SELECT routine.prosrc
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'dasher_retention_api'
      AND routine.proname = 'initialize_operator_context'
      AND pg_catalog.oidvectortypes(routine.proargtypes) =
        'uuid, text, uuid, text'
  ),
  bootstrap_policies AS (
    SELECT
      namespace.nspname::text AS schema_name,
      relation.relname::text AS relation_name,
      policy.polname::text AS policy_name,
      policy.polcmd::text AS command
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE policy.polname IN (
      'retention_service_principal_self_binding_select',
      'dashboards_retention_target_discovery_select'
    )
  ),
  allowlist_mutation_authority AS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE namespace.nspname = 'dasher'
      AND relation.relname = 'retention_service_principal_allowlist'
      AND grantee.rolname = 'dasher_retention_definer'
      AND privilege.privilege_type IN ('UPDATE', 'DELETE')
    UNION ALL
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'dasher'
      AND relation.relname = 'retention_service_principal_allowlist'
      AND policy.polcmd IN ('a', 'w', 'd')
  )
  SELECT
    NOT EXISTS (SELECT 1 FROM function_difference)
    AND (SELECT pg_catalog.count(*) = 1 FROM modeled_initializer)
    AND (
      SELECT
        pg_catalog.position('transaction_isolation' IN prosrc) > 0
        AND pg_catalog.position('read committed' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_phase' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_principal_id' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_principal_revision' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_authority_scope' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_capability' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_target_dashboard_id' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_target_organization_id' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_request_id' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('retention_case_matter_reference' IN prosrc) >
          pg_catalog.position('transaction_isolation' IN prosrc)
        AND pg_catalog.position('postgres_session_user' IN prosrc) >
          pg_catalog.position('retention_case_matter_reference' IN prosrc)
        AND pg_catalog.position('session_user' IN prosrc) >
          pg_catalog.position('postgres_session_user' IN prosrc)
        AND pg_catalog.position('pg_advisory_xact_lock' IN prosrc) >
          pg_catalog.position('session_user' IN prosrc)
        AND pg_catalog.position(
          'retention_service_principal_allowlist' IN prosrc
        ) > pg_catalog.position('pg_advisory_xact_lock' IN prosrc)
        AND pg_catalog.position('principal_revision' IN prosrc) >
          pg_catalog.position(
            'retention_service_principal_allowlist' IN prosrc
          )
        AND pg_catalog.position('predecessor_revision' IN prosrc) >
          pg_catalog.position('principal_revision' IN prosrc)
        AND pg_catalog.position('predecessor_sha256' IN prosrc) >
          pg_catalog.position('predecessor_revision' IN prosrc)
        AND pg_catalog.position('enabled' IN prosrc) >
          pg_catalog.position('predecessor_sha256' IN prosrc)
        AND prosrc !~* 'FOR[[:space:]]+(UPDATE|SHARE)'
        AND prosrc !~* '[[:<:]]EXECUTE[[:>:]]'
      FROM modeled_initializer
    )
    AND (
      SELECT pg_catalog.array_agg(
        policy_name || '|' || relation_name || '|' || command
        ORDER BY policy_name
      ) = ARRAY[
        'dashboards_retention_target_discovery_select|dashboards|r',
        'retention_service_principal_self_binding_select|retention_service_principal_allowlist|r'
      ]::text[]
      FROM bootstrap_policies
    )
    AND NOT EXISTS (SELECT 1 FROM allowlist_mutation_authority)
    AS matches
`;

function modeledSuccessorFunctionCatalogJson(ownerName: string): string {
  return JSON.stringify(
    modeled0003FunctionSignatures.map((signature, index) => {
      const retentionFunction = signature.schema === "dasher_retention_api";
      const triggerFunction = signature.schema === "dasher_private";
      return {
        schema_name: signature.schema,
        function_name: signature.name,
        identity_arguments: signature.arguments,
        result_type: modeled0003FunctionReturns[index],
        language_name: "plpgsql",
        volatility: "v",
        security_definer: !triggerFunction,
        owner_name: triggerFunction
          ? ownerName
          : retentionFunction
            ? "dasher_retention_definer"
            : "dasher_security_definer",
        proconfig: ["search_path=pg_catalog"],
        execute_grantees: triggerFunction
          ? []
          : [retentionFunction ? "dasher_retention_operator" : "dasher_app"],
      };
    }),
  );
}

async function assertModeledSuccessorCatalog(
  client: MigrationClient,
  ownerName: string,
): Promise<void> {
  const result = await client.query<DependencyComparisonRow>(
    modeledSuccessorCatalogInventorySql,
    [
      modeledSuccessorFunctionCatalogJson(ownerName),
      modeled0003FunctionSignatures
        .filter((signature) => signature.schema === "dasher_api")
        .map((signature) => signature.name),
      modeled0003FunctionSignatures
        .filter((signature) => signature.schema === "dasher_private")
        .map((signature) => signature.name),
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true) {
    return reject("managed_role_drift");
  }
}

async function assertCanonicalPrefixObjects(
  client: MigrationClient,
  journalRows: readonly JournalRow[],
  exactCanonicalFiles: boolean,
  ownerName: string,
): Promise<void> {
  if (!exactCanonicalFiles || journalRows.length === 0) {
    return;
  }

  const schemas = ["dasher", "dasher_meta", "dasher_private"];
  const relations: readonly string[] = task3RelationNames;
  const functions: Array<{
    readonly function_name: string;
    readonly identity_arguments: string;
    readonly schema_name: string;
  }> = [
    {
      schema_name: "dasher_private",
      function_name: "reject_immutable_mutation",
      identity_arguments: "",
    },
  ];

  if (journalRows.length >= 2) {
    schemas.push("dasher_api");
    functions.push(
      ...task4FunctionSignatures.map((signature) => ({
        schema_name: signature.schema,
        function_name: signature.name,
        identity_arguments: signature.arguments,
      })),
    );
  }
  if (journalRows.length >= 3) {
    schemas.push("dasher_retention_api");
    functions.push(
      ...modeled0003FunctionSignatures.map((signature) => ({
        schema_name: signature.schema,
        function_name: signature.name,
        identity_arguments: signature.arguments,
      })),
    );
  }

  const result = await client.query<DependencyComparisonRow>(
    canonicalPrefixObjectInventorySql,
    [
      schemas.sort(),
      journalRows.length >= 3
        ? [...relations, ...modeled0003RelationNames].sort()
        : [...relations].sort(),
      JSON.stringify(
        functions.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      ),
      JSON.stringify(
        Object.entries(task4TableColumns).flatMap(
          ([relation_name, columnNames]) =>
            columnNames.map((column_name) => ({
              relation_name,
              column_name,
            })),
        ),
      ),
      [...relations].sort(),
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true) {
    return reject("managed_role_drift");
  }
  if (journalRows.length >= 3) {
    await assertModeledSuccessorCatalog(client, ownerName);
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

  const hasModeledSuccessor = journalRows.some(
    (row) =>
      row.sequence === 3 && row.filename === "0003_immutable_content.sql",
  );
  if (hasModeledSuccessor) {
    for (const [roleName, schemaNames] of [
      [
        "dasher_retention_definer",
        ["dasher", "dasher_private", "dasher_retention_api"],
      ],
      ["dasher_retention_operator", ["dasher_retention_api"]],
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

    for (const grant of modeled0003RelationGrants) {
      for (const relationName of grant.relations) {
        entries.push(
          dependencyEntry({
            catalog_name: "pg_class",
            database_oid: databaseIdentity.database_oid,
            dependency_type: "a",
            function_arguments: null,
            grantor_name: ownerName,
            object_kind: "relation",
            object_name: relationName,
            privilege_type: grant.privilege,
            role_name: grant.roleName,
            schema_name: "dasher",
            subobject_name: null,
          }),
        );
      }
    }

    for (const signature of modeled0003FunctionSignatures) {
      if (signature.schema === "dasher_private") {
        continue;
      }
      const retentionFunction = signature.schema === "dasher_retention_api";
      const ownerRole = retentionFunction
        ? "dasher_retention_definer"
        : "dasher_security_definer";
      const executeRole = retentionFunction
        ? "dasher_retention_operator"
        : "dasher_app";
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
          role_name: ownerRole,
          schema_name: signature.schema,
          subobject_name: null,
        }),
        dependencyEntry({
          catalog_name: "pg_proc",
          database_oid: databaseIdentity.database_oid,
          dependency_type: "a",
          function_arguments: signature.arguments,
          grantor_name: ownerRole,
          object_kind: "function",
          object_name: signature.name,
          privilege_type: "EXECUTE",
          role_name: executeRole,
          schema_name: signature.schema,
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

  if (hasModeledSuccessor) {
    for (const grant of modeled0003UpdateColumnGrants) {
      for (const columnName of grant.columns) {
        entries.push(
          dependencyEntry({
            catalog_name: "pg_class",
            database_oid: databaseIdentity.database_oid,
            dependency_type: "a",
            function_arguments: null,
            grantor_name: ownerName,
            object_kind: "column",
            object_name: grant.relation,
            privilege_type: "UPDATE",
            role_name: grant.roleName,
            schema_name: "dasher",
            subobject_name: columnName,
          }),
        );
      }
    }
  }

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
  await assertCanonicalPrefixObjects(
    client,
    journalRows,
    exactCanonicalFiles,
    ownerName,
  );

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
    await client.query(advisorySessionLockSql);
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
    await client.query(advisorySessionLockSql);
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
