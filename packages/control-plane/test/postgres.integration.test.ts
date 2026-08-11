import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DashboardLifecycleRepository,
  InvitationRepository,
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  SecretKeyRing,
  SessionRepository,
  bootstrapManagedRoles,
  createVerifiedPrincipalFromServerVerification,
  discoverMigrations,
  parsePostgresIntegrationEnv,
  runMigrations,
  type MigrationClient,
  type PgCompatiblePool,
} from "../src/index.js";
import {
  canonical0003DependencyInventoryMatchesForTests,
  canonical0004DependencyInventoryMatchesForTests,
  canonical0005DependencyInventoryMatchesForTests,
  canonical0006DependencyInventoryMatchesForTests,
  canonical0007CatalogMatchesForTests,
  canonical0008CatalogMatchesForTests,
  canonicalPhaseNameSensitiveInventoryForTests,
  exactCatalogMatchesForTests,
  getCanonical0002ExactCatalogContractForTests,
  getCanonical0003ExactCatalogContractForTests,
  getCanonical0004ExactCatalogContractForTests,
  getCanonical0005ExactCatalogContractForTests,
  getCanonical0006ExactCatalogContractForTests,
  getModeled0003StaticCatalogContractForTests,
  resetPreparedRetentionRoles,
} from "../src/migrator.js";
import {
  borrowedClientPool,
  canonicalMigrationDirectory,
  checksumDriftMigrationDirectory,
  createTemporaryAppLogin,
  createTemporaryRetentionLogin,
  dropTemporaryAppLogin,
  dropTemporaryRetentionLogin,
  executeServerFormattedSql,
  expectMigrationRejection,
  fixtureMigrationDirectory,
  renamedMigrationDirectory,
} from "./postgres-harness.js";

const config = parsePostgresIntegrationEnv(process.env);
const shapeOwnerRole = "dasher_task2_shape_owner";
const setRoleExecutor = "dasher_task2_set_role";
const siblingDatabaseNonce = randomUUID().replaceAll("-", "");
const task8aHarnessDefinerRole = "task8a_retention_harness_definer";
const task8aSecurityHarnessDefinerRole = "task8a_security_harness_definer";
const task8aHarnessSubjectA = "task8a_synthetic_operator_a";
const task8aHarnessSubjectB = "task8a_synthetic_operator_b";
const task8aHarnessLifecycleLock = 2_026_080_208;
const task8aHarnessTargetOrganizationA = "83000000-0000-4000-8000-000000000001";
const task8aHarnessTargetOrganizationB = "83000000-0000-4000-8000-000000000002";
const task8aHarnessTargetDashboard = "83000000-0000-4000-8000-000000000010";
const task8dOrganizationId = "8d000000-0000-4000-8000-000000000001";
const task8dRetentionUsername = "dasher_test_task8d_retention";

let ownerPool: Pool;
let appPool: Pool | undefined;
let canonical0002MigrationDirectory = canonicalMigrationDirectory;
let disposableStateConfirmed = false;
let appLoginCreated = false;
let canonicalFirstRun:
  | {
      readonly appliedCount: number;
      readonly discoveredCount: number;
      readonly previouslyAppliedCount: number;
    }
  | undefined;
let canonicalSecondRun:
  | {
      readonly appliedCount: number;
      readonly discoveredCount: number;
      readonly previouslyAppliedCount: number;
    }
  | undefined;

async function closeAppPoolBeforeLoginTeardown(): Promise<void> {
  if (appPool === undefined) {
    return;
  }

  const pool = appPool;
  appPool = undefined;
  const expectedRemovals = pool.totalCount;
  let observedRemovals = 0;
  let resolveAllRemoved!: () => void;
  const allRemoved = new Promise<void>((resolve) => {
    resolveAllRemoved = resolve;
  });
  const observeRemoval = () => {
    observedRemovals += 1;
    if (observedRemovals === expectedRemovals) {
      resolveAllRemoved();
    }
  };

  if (expectedRemovals > 0) {
    pool.on("remove", observeRemoval);
  }
  try {
    await pool.end();
    if (expectedRemovals > 0) {
      await allRemoved;
    }
  } finally {
    pool.off("remove", observeRemoval);
  }

  const remaining = await ownerPool.query<{ readonly count: string }>(
    `
      SELECT pg_catalog.count(*)::text AS count
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.usename = $1
        AND activity.pid <> pg_catalog.pg_backend_pid()
    `,
    [config.appUsername],
  );
  expect(remaining.rows[0]?.count).toBe("0");
}

async function resetManagedSchemas(): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query(`
      DROP SCHEMA IF EXISTS fixture_role_owned CASCADE;
      DROP SCHEMA IF EXISTS dasher_retention_api CASCADE;
      DROP SCHEMA IF EXISTS dasher_run_api CASCADE;
      DROP SCHEMA IF EXISTS dasher_api CASCADE;
      DROP SCHEMA IF EXISTS dasher_private CASCADE;
      DROP SCHEMA IF EXISTS dasher CASCADE;
      DROP SCHEMA IF EXISTS dasher_meta CASCADE;
      DROP ROLE IF EXISTS dasher_run_operator;
      DROP ROLE IF EXISTS dasher_run_definer;
      DROP ROLE IF EXISTS dasher_retention_operator;
      DROP ROLE IF EXISTS dasher_retention_definer
    `);
    const managedAppRole = await client.query<{ readonly exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dasher_app') AS exists",
    );
    if (managedAppRole.rows[0]?.exists === true) {
      await executeServerFormattedSql(
        client,
        "REVOKE CONNECT ON DATABASE %I FROM dasher_app",
        [config.ownerDatabase],
      );
    }
  } finally {
    client.release();
  }
}

interface Task8aSelfBindingHarness {
  readonly initializer: PoolClient;
  readonly owner: PoolClient;
  readonly secondIdentity: PoolClient;
  readonly writer: PoolClient;
  readonly close: () => Promise<void>;
}

type Task8aHarnessFunctionAcl = Readonly<{
  executeAcl: readonly Readonly<{
    grantee: string;
    grantor: string;
    isGrantable: boolean;
  }>[];
  identityArguments: string;
  name: string;
  owner: string;
  schema: string;
  securityDefiner: boolean;
}>;

function task8aHarnessFunctionAclContract(
  databaseOwnerRole: string,
): readonly Task8aHarnessFunctionAcl[] {
  return [
    {
      schema: "task8a_retention_barrier",
      name: "exercise_security_lock_modes",
      identityArguments: "",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "exercise_retention_lock_modes",
      identityArguments: "",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "binding_gate",
      identityArguments: "p_subject name",
      owner: databaseOwnerRole,
      securityDefiner: false,
      executeAcl: [
        {
          grantee: task8aHarnessDefinerRole,
          grantor: databaseOwnerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "initialize",
      identityArguments: "p_organization_id uuid, p_dashboard_id uuid",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "revalidate",
      identityArguments: "",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "append_revision",
      identityArguments: "p_subject name, p_revision bigint, p_enabled boolean",
      owner: databaseOwnerRole,
      securityDefiner: false,
      executeAcl: [],
    },
    {
      schema: "task8a_retention_barrier",
      name: "insert_adversarial_revision",
      identityArguments:
        "p_subject name, p_principal_id uuid, p_revision bigint, p_enabled boolean",
      owner: databaseOwnerRole,
      securityDefiner: false,
      executeAcl: [],
    },
    {
      schema: "task8a_retention_barrier",
      name: "cleanup_subject",
      identityArguments: "p_subject name",
      owner: databaseOwnerRole,
      securityDefiner: false,
      executeAcl: [],
    },
    {
      schema: "task8a_retention_barrier",
      name: "admit_version_reference",
      identityArguments:
        "p_organization_id uuid, p_snapshot_id uuid, p_dashboard_id uuid",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "admit_evidence_reference",
      identityArguments:
        "p_organization_id uuid, p_snapshot_id uuid, p_evidence_id uuid, p_dashboard_id uuid",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "admit_restore_reference",
      identityArguments:
        "p_organization_id uuid, p_snapshot_id uuid, p_dashboard_id uuid",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "create_snapshot_intent",
      identityArguments:
        "p_organization_id uuid, p_snapshot_id uuid, p_source_dashboard_id uuid",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "finalize_evidence",
      identityArguments: "p_organization_id uuid, p_evidence_id uuid",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "finalize_snapshot",
      identityArguments: "p_organization_id uuid, p_snapshot_id uuid",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "request_promotion",
      identityArguments:
        "p_organization_id uuid, p_dashboard_id uuid, p_promotion_request_id uuid, p_audit_event_id uuid, p_lock_barrier bigint",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "execute_modeled_mutation",
      identityArguments: "p_operation text",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "read_evidence_projection",
      identityArguments:
        "p_organization_id uuid, p_dashboard_id uuid, p_barrier bigint",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "read_lineage_projection",
      identityArguments:
        "p_organization_id uuid, p_dashboard_id uuid, p_barrier bigint",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "artifact_expected_claim_hash",
      identityArguments:
        "p_organization_id uuid, p_dashboard_id uuid, p_artifact_id uuid",
      owner: databaseOwnerRole,
      securityDefiner: false,
      executeAcl: [
        {
          grantee: task8aSecurityHarnessDefinerRole,
          grantor: databaseOwnerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "artifact_is_governable",
      identityArguments:
        "p_organization_id uuid, p_dashboard_id uuid, p_artifact_id uuid",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "guard_artifact_delete",
      identityArguments: "",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [],
    },
    {
      schema: "task8a_retention_barrier",
      name: "purge_artifact_step",
      identityArguments: "p_organization_id uuid, p_dashboard_id uuid",
      owner: task8aSecurityHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aSecurityHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
    {
      schema: "task8a_retention_barrier",
      name: "purge_snapshot_batch",
      identityArguments:
        "p_organization_id uuid, p_dashboard_id uuid, p_lock_barrier bigint",
      owner: task8aHarnessDefinerRole,
      securityDefiner: true,
      executeAcl: [
        {
          grantee: task8aHarnessSubjectA,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
        {
          grantee: task8aHarnessSubjectB,
          grantor: task8aHarnessDefinerRole,
          isGrantable: false,
        },
      ],
    },
  ];
}

async function assertExactTask8aHarnessFunctionAclClosure(
  owner: PoolClient,
): Promise<void> {
  const expected = [
    ...task8aHarnessFunctionAclContract(config.ownerUsername),
  ].sort((left, right) =>
    `${left.schema}.${left.name}(${left.identityArguments})`.localeCompare(
      `${right.schema}.${right.name}(${right.identityArguments})`,
    ),
  );
  expect(expected).toHaveLength(23);

  const catalog = await owner.query<Task8aHarnessFunctionAcl>(`
    SELECT
      namespace.nspname AS schema,
      routine.proname AS name,
      pg_catalog.pg_get_function_identity_arguments(routine.oid)
        AS "identityArguments",
      owner_role.rolname AS owner,
      routine.prosecdef AS "securityDefiner",
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantee', CASE
              WHEN execute_privilege.grantee = 0 THEN 'PUBLIC'
              ELSE grantee_role.rolname
            END,
            'grantor', grantor_role.rolname,
            'isGrantable', execute_privilege.is_grantable
          )
          ORDER BY
            CASE
              WHEN execute_privilege.grantee = 0 THEN 'PUBLIC'
              ELSE grantee_role.rolname
            END,
            grantor_role.rolname,
            execute_privilege.is_grantable
        ) FILTER (WHERE execute_privilege.grantee IS NOT NULL),
        '[]'::jsonb
      ) AS "executeAcl"
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = routine.proowner
    LEFT JOIN LATERAL (
      -- Expand a null ACL to its effective default so a missing PUBLIC revoke
      -- remains observable. Owner execution is inherent, so it is excluded
      -- from the explicit non-owner grantee closure asserted below.
      SELECT privilege.grantee, privilege.grantor, privilege.is_grantable
      FROM pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS privilege
      WHERE privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee <> routine.proowner
    ) AS execute_privilege ON true
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = execute_privilege.grantee
    LEFT JOIN pg_catalog.pg_roles AS grantor_role
      ON grantor_role.oid = execute_privilege.grantor
    WHERE namespace.nspname = 'task8a_retention_barrier'
    GROUP BY
      namespace.nspname,
      routine.oid,
      routine.proname,
      owner_role.rolname,
      routine.prosecdef
    ORDER BY
      namespace.nspname,
      routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid)
  `);

  expect(catalog.rows).toHaveLength(23);
  expect(
    catalog.rows.flatMap((routine) =>
      routine.executeAcl.map((privilege) => privilege.grantee),
    ),
  ).not.toContain("PUBLIC");
  expect(catalog.rows).toEqual(expected);
}

async function createTask8aSelfBindingHarness(
  harnessSql: string,
): Promise<Task8aSelfBindingHarness> {
  const owner = await ownerPool.connect();
  const initializerPool = new Pool({
    connectionString: config.ownerDsn,
    application_name: "dasher_task8a_initializer",
    max: 1,
  });
  const secondIdentityPool = new Pool({
    connectionString: config.ownerDsn,
    application_name: "dasher_task8a_second_identity",
    max: 1,
  });
  const writerPool = new Pool({
    connectionString: config.ownerDsn,
    application_name: "dasher_task8a_writer",
    max: 1,
  });
  let initializer: PoolClient | undefined;
  let secondIdentity: PoolClient | undefined;
  let writer: PoolClient | undefined;
  let lifecycleLockHeld = false;

  const close = async (): Promise<void> => {
    let cleanupError: unknown;
    let residueCount: string | undefined;
    let unlocked: boolean | undefined;
    try {
      for (const client of [initializer, secondIdentity]) {
        if (client !== undefined) {
          await client.query("ROLLBACK").catch(() => undefined);
          await client
            .query("RESET SESSION AUTHORIZATION")
            .catch(() => undefined);
          client.release();
        }
      }
      if (writer !== undefined) {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }
      await Promise.allSettled([
        initializerPool.end(),
        secondIdentityPool.end(),
        writerPool.end(),
      ]);
      await owner.query(
        "DROP SCHEMA IF EXISTS task8a_retention_barrier CASCADE",
      );
      await owner.query(
        `
          DROP ROLE IF EXISTS ${task8aHarnessSubjectA};
          DROP ROLE IF EXISTS ${task8aHarnessSubjectB};
          DROP ROLE IF EXISTS ${task8aSecurityHarnessDefinerRole};
          DROP ROLE IF EXISTS ${task8aHarnessDefinerRole}
        `,
      );
      const residue = await owner.query<{ readonly count: string }>(
        `
          SELECT pg_catalog.count(*)::text AS count
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = ANY($1::text[])
        `,
        [
          [
            task8aHarnessDefinerRole,
            task8aSecurityHarnessDefinerRole,
            task8aHarnessSubjectA,
            task8aHarnessSubjectB,
          ],
        ],
      );
      residueCount = residue.rows[0]?.count;
    } catch (error) {
      cleanupError = error;
    } finally {
      if (lifecycleLockHeld) {
        try {
          const unlockResult = await owner.query<{
            readonly unlocked: boolean;
          }>("SELECT pg_catalog.pg_advisory_unlock($1) AS unlocked", [
            task8aHarnessLifecycleLock,
          ]);
          unlocked = unlockResult.rows[0]?.unlocked;
        } catch (error) {
          cleanupError ??= error;
        }
      }
      owner.release(cleanupError instanceof Error ? cleanupError : undefined);
    }
    if (cleanupError !== undefined) throw cleanupError;
    expect(residueCount).toBe("0");
    if (lifecycleLockHeld) expect(unlocked).toBe(true);
  };

  try {
    await owner.query("SELECT pg_catalog.pg_advisory_lock($1)", [
      task8aHarnessLifecycleLock,
    ]);
    lifecycleLockHeld = true;
    await owner.query("DROP SCHEMA IF EXISTS task8a_retention_barrier CASCADE");
    await owner.query(`
      DROP ROLE IF EXISTS ${task8aHarnessSubjectA};
      DROP ROLE IF EXISTS ${task8aHarnessSubjectB};
      DROP ROLE IF EXISTS ${task8aSecurityHarnessDefinerRole};
      DROP ROLE IF EXISTS ${task8aHarnessDefinerRole}
    `);
    const authority = await owner.query<{ readonly is_superuser: boolean }>(`
      SELECT role.rolsuper AS is_superuser
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = session_user
    `);
    expect(authority.rows[0]?.is_superuser).toBe(true);
    await owner.query(`
      CREATE ROLE ${task8aHarnessDefinerRole} WITH NOLOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD NULL;
      CREATE ROLE ${task8aSecurityHarnessDefinerRole} WITH NOLOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
        PASSWORD NULL;
      CREATE ROLE ${task8aHarnessSubjectA} WITH NOLOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD NULL;
      CREATE ROLE ${task8aHarnessSubjectB} WITH NOLOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD NULL
    `);
    await owner.query(harnessSql);
    await owner.query(`
      GRANT USAGE ON SCHEMA task8a_retention_barrier
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.initialize(uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.revalidate()
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.exercise_security_lock_modes()
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.exercise_retention_lock_modes()
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.admit_version_reference(uuid, uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.admit_evidence_reference(uuid, uuid, uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.admit_restore_reference(uuid, uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.create_snapshot_intent(uuid, uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.finalize_evidence(uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.finalize_snapshot(uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.request_promotion(uuid, uuid, uuid, uuid, bigint)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.execute_modeled_mutation(text)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.read_evidence_projection(uuid, uuid, bigint)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.read_lineage_projection(uuid, uuid, bigint)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.purge_snapshot_batch(uuid, uuid, bigint)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.purge_artifact_step(uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB};
      GRANT EXECUTE ON FUNCTION task8a_retention_barrier.artifact_is_governable(uuid, uuid, uuid)
        TO ${task8aHarnessSubjectA}, ${task8aHarnessSubjectB}
    `);
    await assertExactTask8aHarnessFunctionAclClosure(owner);
    initializer = await initializerPool.connect();
    secondIdentity = await secondIdentityPool.connect();
    writer = await writerPool.connect();
    await initializer.query(
      `SET SESSION AUTHORIZATION ${task8aHarnessSubjectA}`,
    );
    await secondIdentity.query(
      `SET SESSION AUTHORIZATION ${task8aHarnessSubjectB}`,
    );
    return { initializer, owner, secondIdentity, writer, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function observeTask8aBarrierWaiter(
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const state = await ownerPool.query<{ readonly waiting: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_stat_activity AS activity
          JOIN pg_catalog.pg_locks AS lock_row ON lock_row.pid = activity.pid
          WHERE activity.application_name = $1
            AND lock_row.locktype = 'advisory'
            AND NOT lock_row.granted
            AND activity.wait_event_type = 'Lock'
        ) AS waiting
      `,
      [applicationName],
    );
    if (state.rows[0]?.waiting === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Task 8A self-binding barrier waiter was not observed");
}

async function observeTask8aRowLockWaiter(
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const state = await ownerPool.query<{ readonly waiting: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_stat_activity AS activity
          JOIN pg_catalog.pg_locks AS lock_row ON lock_row.pid = activity.pid
          WHERE activity.application_name = $1
            AND lock_row.locktype IN ('tuple', 'transactionid')
            AND NOT lock_row.granted
            AND activity.wait_event_type = 'Lock'
        ) AS waiting
      `,
      [applicationName],
    );
    if (state.rows[0]?.waiting === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Task 8A resource row-lock waiter was not observed");
}

async function prepareAppliedJournal(): Promise<void> {
  await resetManagedSchemas();
  const result = await runMigrations(ownerPool, fixtureMigrationDirectory, []);
  expect(result.appliedCount).toBe(2);
}

async function expectOwnerNoOpWithAppLogin(): Promise<void> {
  await expect(
    runMigrations(ownerPool, fixtureMigrationDirectory, [config.appUsername]),
  ).resolves.toEqual({
    discoveredCount: 2,
    previouslyAppliedCount: 2,
    appliedCount: 0,
  });
}

function ownerDsnForDatabase(databaseName: string): string {
  const url = new URL(config.ownerDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function databaseOidByName(
  databaseName: string,
): Promise<string | undefined> {
  const identity = await ownerPool.query<{ readonly database_oid: string }>(
    `
      SELECT database_row.oid::text AS database_oid
      FROM pg_catalog.pg_database AS database_row
      WHERE database_row.datname = $1
    `,
    [databaseName],
  );
  return identity.rows[0]?.database_oid;
}

async function createSiblingDatabase(
  databaseName: string,
): Promise<{ readonly databaseOid: string; readonly pool: Pool }> {
  const client = await ownerPool.connect();
  try {
    await executeServerFormattedSql(client, "CREATE DATABASE %I", [
      databaseName,
    ]);
  } finally {
    client.release();
  }

  const databaseOid = await databaseOidByName(databaseName);
  if (databaseOid === undefined) {
    throw new Error("PostgreSQL did not return the sibling database OID");
  }

  return {
    databaseOid,
    pool: new Pool({
      connectionString: ownerDsnForDatabase(databaseName),
      max: 1,
    }),
  };
}

async function managedDependencyCount(databaseOid: string): Promise<string> {
  const result = await ownerPool.query<{ readonly count: string }>(
    `
      SELECT pg_catalog.count(*)::text AS count
      FROM pg_catalog.pg_shdepend AS dependency
      JOIN pg_catalog.pg_roles AS referenced_role
        ON referenced_role.oid = dependency.refobjid
      WHERE dependency.dbid = $1::oid
        AND dependency.refclassid = 'pg_catalog.pg_authid'::regclass
        AND dependency.deptype IN ('a', 'o', 'r')
        AND referenced_role.rolname IN (
          'dasher_app',
          'dasher_security_definer'
        )
    `,
    [databaseOid],
  );
  return result.rows[0]?.count ?? "missing";
}

async function withTask8dDefinerContext<T>(
  connect: () => Promise<PoolClient>,
  prepare: (client: PoolClient) => Promise<void>,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connect();
  let operationFailed = false;
  let operationError: unknown;
  let operationResult!: T;
  let cleanupFailed = false;
  let cleanupError: unknown;
  let releaseFailed = false;
  let releaseError: unknown;

  try {
    await prepare(client);
    operationResult = await operation(client);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await client.query("ROLLBACK");
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  try {
    await client.query("RESET ROLE");
  } catch (error) {
    if (!cleanupFailed) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  const releaseDisposition = operationFailed
    ? operationError instanceof Error
      ? operationError
      : true
    : cleanupFailed
      ? cleanupError instanceof Error
        ? cleanupError
        : true
      : undefined;
  try {
    client.release(releaseDisposition);
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (operationFailed) {
    throw operationError;
  }
  if (cleanupFailed && releaseFailed) {
    throw new AggregateError(
      [cleanupError, releaseError],
      "Task 8D definer-context cleanup and client release both failed",
    );
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  if (releaseFailed) {
    throw releaseError;
  }
  return operationResult;
}

async function dropSiblingDatabase(
  databaseName: string,
  databaseOid: string,
): Promise<{ readonly forcedTerminationCount: number }> {
  const identity = await ownerPool.query<{ readonly database_oid: string }>(
    `
      SELECT database_row.oid::text AS database_oid
      FROM pg_catalog.pg_database AS database_row
      WHERE database_row.datname = $1
    `,
    [databaseName],
  );
  if (
    identity.rows.length !== 1 ||
    identity.rows[0]?.database_oid !== databaseOid
  ) {
    throw new Error("sibling database name/OID identity changed before drop");
  }

  // pg-pool removes idle clients from its internal list before their asynchronous
  // client.end() callbacks fire, so Pool.end() can resolve while PostgreSQL still
  // reports the closing backend. Give graceful shutdown a bounded opportunity
  // before retaining the forced-termination fallback for genuinely stuck clients.
  let backendsAbsent = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activeBackends = await ownerPool.query<{
      readonly count: string;
    }>(
      `
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.datname = $1
          AND activity.pid <> pg_catalog.pg_backend_pid()
      `,
      [databaseName],
    );
    if (activeBackends.rows[0]?.count === "0") {
      backendsAbsent = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  let forcedTerminationCount = 0;
  if (!backendsAbsent) {
    const terminated = await ownerPool.query<{
      readonly pid: string;
      readonly terminated: boolean;
    }>(
      `
        SELECT
          activity.pid::text AS pid,
          pg_catalog.pg_terminate_backend(activity.pid, $2::bigint)
            AS terminated
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.datname = $1
          AND activity.pid <> pg_catalog.pg_backend_pid()
      `,
      [databaseName, 5_000],
    );
    forcedTerminationCount = terminated.rows.length;
    if (
      terminated.rows.some(
        (row) => row.pid.length === 0 || row.terminated !== true,
      )
    ) {
      throw new Error("PostgreSQL did not confirm sibling backend termination");
    }
  }

  const remainingBackends = await ownerPool.query<{ readonly count: string }>(
    `
      SELECT pg_catalog.count(*)::text AS count
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.datname = $1
        AND activity.pid <> pg_catalog.pg_backend_pid()
    `,
    [databaseName],
  );
  if (remainingBackends.rows[0]?.count !== "0") {
    throw new Error("sibling database still had backends before drop");
  }

  const client = await ownerPool.connect();
  try {
    await executeServerFormattedSql(client, "DROP DATABASE IF EXISTS %I", [
      databaseName,
    ]);
  } finally {
    client.release();
  }

  const residue = await ownerPool.query<{
    readonly database_exists: boolean;
    readonly dependency_count: string;
  }>(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database AS database_row
          WHERE database_row.datname = $1
        ) AS database_exists,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.dbid = $2::oid
        ) AS dependency_count
    `,
    [databaseName, databaseOid],
  );
  expect(residue.rows[0]).toEqual({
    database_exists: false,
    dependency_count: "0",
  });
  return { forcedTerminationCount };
}

async function schemaPresence(): Promise<{
  readonly dasher: boolean;
  readonly dasherMeta: boolean;
}> {
  const result = await ownerPool.query<{
    readonly dasher: boolean;
    readonly dasher_meta: boolean;
  }>(`
    SELECT
      pg_catalog.to_regnamespace('dasher') IS NOT NULL AS dasher,
      pg_catalog.to_regnamespace('dasher_meta') IS NOT NULL AS dasher_meta
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("PostgreSQL did not return schema presence");
  }
  return { dasher: row.dasher, dasherMeta: row.dasher_meta };
}

async function createShapeOwner(): Promise<void> {
  await ownerPool.query(`
    CREATE ROLE dasher_task2_shape_owner WITH
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD NULL
  `);
}

async function dropShapeOwner(): Promise<void> {
  await resetManagedSchemas();
  await ownerPool.query("DROP ROLE IF EXISTS dasher_task2_shape_owner");
}

async function restoreTask3PublicPrivileges(): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await executeServerFormattedSql(
      client,
      "GRANT TEMPORARY ON DATABASE %I TO PUBLIC",
      [config.ownerDatabase],
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO PUBLIC",
    );
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  ownerPool = new Pool({
    connectionString: config.ownerDsn,
    max: 4,
  });

  const client = await ownerPool.connect();
  try {
    const result = await client.query<{
      readonly app_login_exists: boolean;
      readonly helper_role_exists: boolean;
      readonly managed_namespace_exists: boolean;
      readonly managed_role_exists: boolean;
      readonly postgres_16: boolean;
      readonly public_database_acl_baseline: boolean;
      readonly public_schema_acl_baseline: boolean;
      readonly owner_default_acl_baseline: boolean;
    }>(
      `
        SELECT
          current_setting('server_version_num')::integer
            BETWEEN 160000 AND 169999 AS postgres_16,
          (
            SELECT pg_catalog.count(*) = 2
            FROM pg_catalog.pg_database AS database_row
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                database_row.datacl,
                pg_catalog.acldefault('d', database_row.datdba)
              )
            ) AS privilege
            WHERE database_row.datname = pg_catalog.current_database()
              AND privilege.grantee = 0
              AND privilege.privilege_type IN ('CONNECT', 'TEMPORARY')
          ) AS public_database_acl_baseline,
          (
            SELECT pg_catalog.count(*) = 1
            FROM pg_catalog.pg_namespace AS namespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                namespace.nspacl,
                pg_catalog.acldefault('n', namespace.nspowner)
              )
            ) AS privilege
            WHERE namespace.nspname = 'public'
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'USAGE'
          ) AS public_schema_acl_baseline,
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_default_acl AS default_acl
            WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) =
              session_user
          ) AS owner_default_acl_baseline,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname IN (
              'dasher_app',
              'dasher_security_definer',
              'dasher_retention_definer',
              'dasher_retention_operator'
            )
          ) AS managed_role_exists,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname IN ($1, $2, $3)
          ) AS helper_role_exists,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname = $1
          ) AS app_login_exists,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_namespace
            WHERE nspname IN (
              'dasher',
              'dasher_private',
              'dasher_meta',
              'fixture_role_owned'
            )
          ) AS managed_namespace_exists
      `,
      [config.appUsername, shapeOwnerRole, setRoleExecutor],
    );
    const row = result.rows[0];

    expect(row?.postgres_16).toBe(true);
    expect(row?.public_database_acl_baseline).toBe(true);
    expect(row?.public_schema_acl_baseline).toBe(true);
    expect(row?.owner_default_acl_baseline).toBe(true);
    expect(row?.managed_role_exists).toBe(false);
    expect(row?.helper_role_exists).toBe(false);
    expect(row?.app_login_exists).toBe(false);
    expect(row?.managed_namespace_exists).toBe(false);
    disposableStateConfirmed = true;

    canonical0002MigrationDirectory = await mkdtemp(
      join(tmpdir(), "dasher-canonical-0002-pg-"),
    );
    for (const filename of [
      "0001_identity_audit.sql",
      "0002_security_boundary.sql",
    ] as const) {
      await writeFile(
        join(canonical0002MigrationDirectory, filename),
        await readFile(join(canonicalMigrationDirectory, filename)),
      );
    }
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await closeAppPoolBeforeLoginTeardown();

  if (!disposableStateConfirmed) {
    await ownerPool?.end();
    return;
  }

  try {
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }

    await resetManagedSchemas();
    const databaseAclCleanupClient = await ownerPool.connect();
    try {
      const managedAppRole = await databaseAclCleanupClient.query<{
        readonly exists: boolean;
      }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dasher_app') AS exists",
      );
      if (managedAppRole.rows[0]?.exists === true) {
        await executeServerFormattedSql(
          databaseAclCleanupClient,
          "REVOKE CONNECT ON DATABASE %I FROM dasher_app",
          [config.ownerDatabase],
        );
      }
    } finally {
      databaseAclCleanupClient.release();
    }
    await restoreTask3PublicPrivileges();
    await ownerPool.query(`DROP ROLE IF EXISTS ${setRoleExecutor}`);
    await ownerPool.query(`DROP ROLE IF EXISTS ${shapeOwnerRole}`);
    await ownerPool.query(
      "DROP ROLE IF EXISTS dasher_security_definer, dasher_app",
    );

    const residue = await ownerPool.query<{ readonly count: string }>(
      `
        SELECT count(*)::text AS count
        FROM pg_catalog.pg_roles
        WHERE rolname IN (
          'dasher_app',
          'dasher_security_definer',
          'dasher_retention_definer',
          'dasher_retention_operator',
          $1,
          $2,
          $3
        )
      `,
      [config.appUsername, shapeOwnerRole, setRoleExecutor],
    );
    expect(residue.rows[0]?.count).toBe("0");
    expect(await schemaPresence()).toEqual({
      dasher: false,
      dasherMeta: false,
    });
    const restoredBaselines = await ownerPool.query<{
      readonly owner_default_acl_restored: boolean;
      readonly public_database_acl_restored: boolean;
      readonly public_schema_acl_restored: boolean;
    }>(`
      SELECT
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl AS default_acl
          WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) = session_user
        ) AS owner_default_acl_restored,
        (
          SELECT pg_catalog.array_agg(
            privilege.privilege_type ORDER BY privilege.privilege_type
          ) = ARRAY['CONNECT', 'TEMPORARY']::text[]
          FROM pg_catalog.pg_database AS database_row
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              database_row.datacl,
              pg_catalog.acldefault('d', database_row.datdba)
            )
          ) AS privilege
          WHERE database_row.datname = pg_catalog.current_database()
            AND privilege.grantee = 0
        ) AS public_database_acl_restored,
        (
          SELECT pg_catalog.array_agg(
            privilege.privilege_type ORDER BY privilege.privilege_type
          ) = ARRAY['USAGE']::text[]
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )
          ) AS privilege
          WHERE namespace.nspname = 'public'
            AND privilege.grantee = 0
        ) AS public_schema_acl_restored
    `);
    expect(restoredBaselines.rows[0]).toEqual({
      owner_default_acl_restored: true,
      public_database_acl_restored: true,
      public_schema_acl_restored: true,
    });
  } finally {
    if (canonical0002MigrationDirectory !== canonicalMigrationDirectory) {
      await rm(canonical0002MigrationDirectory, {
        force: true,
        recursive: true,
      });
      canonical0002MigrationDirectory = canonicalMigrationDirectory;
    }
    await ownerPool.end();
  }
});

describe.sequential("Task 2 PostgreSQL migration contract", () => {
  it("has PostgreSQL 16 accept all 12 production finalizer clauses and reject their surplus-parenthesis mutants", async () => {
    type ProductionModeledPolicy = Readonly<{
      catalogCommand: string;
      command: string;
      name: string;
      relation: string;
      roles: readonly string[];
      using: string | null;
      withCheck: string | null;
    }>;
    const production = getModeled0003StaticCatalogContractForTests() as {
      readonly policies: readonly ProductionModeledPolicy[];
    };
    const clauses = [
      {
        name: "snapshot_deletion_finalizers_retention_select",
        relation: "snapshot_deletion_finalizers",
        command: "SELECT",
        catalogCommand: "r",
        clause: "using",
      },
      {
        name: "snapshot_deletion_finalizers_retention_insert",
        relation: "snapshot_deletion_finalizers",
        command: "INSERT",
        catalogCommand: "a",
        clause: "withCheck",
      },
      {
        name: "snapshot_deletion_finalizers_retention_update",
        relation: "snapshot_deletion_finalizers",
        command: "UPDATE",
        catalogCommand: "w",
        clause: "using",
      },
      {
        name: "snapshot_deletion_finalizers_retention_update",
        relation: "snapshot_deletion_finalizers",
        command: "UPDATE",
        catalogCommand: "w",
        clause: "withCheck",
      },
      {
        name: "evidence_deletion_finalizers_retention_select",
        relation: "evidence_deletion_finalizers",
        command: "SELECT",
        catalogCommand: "r",
        clause: "using",
      },
      {
        name: "evidence_deletion_finalizers_retention_insert",
        relation: "evidence_deletion_finalizers",
        command: "INSERT",
        catalogCommand: "a",
        clause: "withCheck",
      },
      {
        name: "evidence_deletion_finalizers_retention_update",
        relation: "evidence_deletion_finalizers",
        command: "UPDATE",
        catalogCommand: "w",
        clause: "using",
      },
      {
        name: "evidence_deletion_finalizers_retention_update",
        relation: "evidence_deletion_finalizers",
        command: "UPDATE",
        catalogCommand: "w",
        clause: "withCheck",
      },
      {
        name: "artifact_deletion_finalizers_retention_select",
        relation: "artifact_deletion_finalizers",
        command: "SELECT",
        catalogCommand: "r",
        clause: "using",
      },
      {
        name: "artifact_deletion_finalizers_retention_insert",
        relation: "artifact_deletion_finalizers",
        command: "INSERT",
        catalogCommand: "a",
        clause: "withCheck",
      },
      {
        name: "artifact_deletion_finalizers_retention_update",
        relation: "artifact_deletion_finalizers",
        command: "UPDATE",
        catalogCommand: "w",
        clause: "using",
      },
      {
        name: "artifact_deletion_finalizers_retention_update",
        relation: "artifact_deletion_finalizers",
        command: "UPDATE",
        catalogCommand: "w",
        clause: "withCheck",
      },
    ] as const satisfies readonly Readonly<{
      catalogCommand: string;
      clause: "using" | "withCheck";
      command: string;
      name: string;
      relation: string;
    }>[];
    const client = await ownerPool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`
        CREATE ROLE dasher_retention_definer WITH
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD NULL;
        CREATE SCHEMA dasher;
        CREATE TABLE dasher.retention_service_principal_allowlist (
          retention_service_principal_id uuid NOT NULL,
          principal_revision bigint NOT NULL,
          binding_kind text NOT NULL,
          binding_subject text NOT NULL,
          authority_scope text NOT NULL,
          scope_organization_id uuid,
          enabled boolean NOT NULL,
          can_initialize boolean NOT NULL,
          can_materialize_expiry boolean NOT NULL,
          can_place_hold boolean NOT NULL,
          can_release_hold boolean NOT NULL,
          can_claim_cleanup boolean NOT NULL,
          can_record_attempt boolean NOT NULL,
          can_purge boolean NOT NULL
        );
        CREATE TABLE dasher.snapshot_deletion_finalizers (
          organization_id uuid NOT NULL,
          snapshot_id uuid NOT NULL,
          expected_claim_set_sha256 bytea NOT NULL
        );
        CREATE TABLE dasher.evidence_deletion_finalizers (
          organization_id uuid NOT NULL,
          evidence_id uuid NOT NULL,
          expected_claim_set_sha256 bytea NOT NULL
        );
        CREATE TABLE dasher.artifact_deletion_finalizers (
          organization_id uuid NOT NULL,
          artifact_id uuid NOT NULL,
          expected_claim_set_sha256 bytea NOT NULL
        )
      `);

      for (const [index, clause] of clauses.entries()) {
        const matches = production.policies.filter(
          (policy) =>
            policy.name === clause.name && policy.relation === clause.relation,
        );
        expect(matches, `${clause.name}.${clause.clause}`).toHaveLength(1);
        const policy = matches[0]!;
        expect(policy, `${clause.name}.${clause.clause}`).toMatchObject({
          catalogCommand: clause.catalogCommand,
          command: clause.command,
          roles: ["dasher_retention_definer"],
        });
        const expression = policy[clause.clause];
        expect(expression, `${clause.name}.${clause.clause}`).not.toBeNull();
        const clauseDdl =
          clause.clause === "using"
            ? `USING ${expression}`
            : `WITH CHECK ${expression}`;
        await client.query(
          `CREATE POLICY task8a2_corrected_${index}
             ON dasher.${clause.relation}
             AS PERMISSIVE
             FOR ${clause.command}
             TO dasher_retention_definer
             ${clauseDdl}`,
        );

        const savepoint = `task8a2_mutant_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        let mutantError: unknown;
        try {
          const mutantExpression = `${expression})`;
          const mutantClauseDdl =
            clause.clause === "using"
              ? `USING ${mutantExpression}`
              : `WITH CHECK ${mutantExpression}`;
          await client.query(
            `CREATE POLICY task8a2_mutant_${index}
               ON dasher.${clause.relation}
               AS PERMISSIVE
               FOR ${clause.command}
               TO dasher_retention_definer
               ${mutantClauseDdl}`,
          );
        } catch (error) {
          mutantError = error;
        } finally {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
        expect(mutantError, `${clause.name}.${clause.clause}`).toMatchObject({
          code: "42601",
        });
      }

      const accepted = await client.query<{ readonly count: string }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polname LIKE 'task8a2_corrected_%'
      `);
      expect(accepted.rows[0]?.count).toBe("12");
      await client.query("ROLLBACK");
      transactionOpen = false;
    } finally {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      client.release();
    }

    const residue = await ownerPool.query<{
      readonly role_absent: boolean;
      readonly schema_absent: boolean;
    }>(`
      SELECT
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = 'dasher_retention_definer'
        ) AS role_absent,
        pg_catalog.to_regnamespace('dasher') IS NULL AS schema_absent
    `);
    expect(residue.rows[0]).toEqual({
      role_absent: true,
      schema_absent: true,
    });
  });

  it("bootstraps the same cluster roles concurrently from two disposable databases", async () => {
    const databaseNames = [
      `dasher_t2_${siblingDatabaseNonce}_bootstrap_a`,
      `dasher_t2_${siblingDatabaseNonce}_bootstrap_b`,
    ] as const;
    const databases: {
      readonly databaseName: string;
      readonly databaseOid: string;
      readonly pool: Pool;
    }[] = [];
    const bootstrapConnections: {
      readonly client: PoolClient;
      released: boolean;
    }[] = [];
    const cleanupFailures: unknown[] = [];
    let createArrivals = 0;
    let releaseCreateBarrier: (() => void) | undefined;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreateBarrier = resolve;
    });
    const releaseBarrier = (): void => {
      releaseCreateBarrier?.();
      releaseCreateBarrier = undefined;
    };

    try {
      for (const databaseName of databaseNames) {
        const sibling = await createSiblingDatabase(databaseName);
        databases.push({ databaseName, ...sibling });
      }

      for (const database of databases) {
        const client = await database.pool.connect();
        const connection = { client, released: false };
        bootstrapConnections.push(connection);
        try {
          await client.query("SET statement_timeout = '30s'");
          await client.query("SET lock_timeout = '20s'");
        } catch (error) {
          client.release();
          connection.released = true;
          throw error;
        }
      }

      const operations = bootstrapConnections.map((connection) => {
        const query = (async (text: string, values?: readonly unknown[]) => {
          if (text.trim().startsWith("CREATE ROLE dasher_app WITH")) {
            createArrivals += 1;
            if (createArrivals === bootstrapConnections.length) {
              releaseBarrier();
            }
            await createBarrier;
          }
          return connection.client.query(text, values as unknown[] | undefined);
        }) as MigrationClient["query"];
        const operation = bootstrapManagedRoles(
          {
            query,
            release() {
              // The test releases the borrowed client after settlement.
            },
          },
          [],
        );
        return operation
          .catch((error) => {
            releaseBarrier();
            throw error;
          })
          .finally(() => {
            connection.client.release();
            connection.released = true;
          });
      });
      const settlements = await Promise.allSettled(operations);
      releaseBarrier();

      for (const settlement of settlements) {
        if (settlement.status === "rejected") {
          expect(settlement.reason).not.toMatchObject({ code: "42710" });
          expect(settlement.reason).not.toMatchObject({ code: "23505" });
          expect(settlement.reason).not.toMatchObject({ code: "40P01" });
          expect(String(settlement.reason)).not.toContain("deadlock detected");
        }
      }
      expect(createArrivals).toBe(2);
      expect(settlements).toHaveLength(2);
      expect(
        settlements.every((settlement) => settlement.status === "fulfilled"),
      ).toBe(true);
      expect(
        settlements
          .filter((settlement) => settlement.status === "fulfilled")
          .map((settlement) => settlement.value),
      ).toEqual([undefined, undefined]);

      const roles = await ownerPool.query<{
        readonly attributes_match: boolean;
        readonly comment: string | null;
        readonly has_settings: boolean;
        readonly password_is_null: boolean;
        readonly role_name: string;
      }>(`
        SELECT
          role.rolname::text AS role_name,
          NOT role.rolcanlogin
            AND NOT role.rolinherit
            AND NOT role.rolsuper
            AND NOT role.rolcreatedb
            AND NOT role.rolcreaterole
            AND NOT role.rolreplication
            AND role.rolbypassrls =
              (role.rolname = 'dasher_security_definer')
            AND role.rolconnlimit = -1
            AND role.rolvaliduntil IS NULL AS attributes_match,
          role.rolpassword IS NULL AS password_is_null,
          pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_db_role_setting AS setting
            WHERE setting.setrole = role.oid
          ) AS has_settings
        FROM pg_catalog.pg_authid AS role
        WHERE role.rolname IN ('dasher_app', 'dasher_security_definer')
        ORDER BY role.rolname
      `);
      expect(roles.rows).toEqual([
        {
          attributes_match: true,
          comment: "dasher:managed-role:v1:app",
          has_settings: false,
          password_is_null: true,
          role_name: "dasher_app",
        },
        {
          attributes_match: true,
          comment: "dasher:managed-role:v1:security-definer",
          has_settings: false,
          password_is_null: true,
          role_name: "dasher_security_definer",
        },
      ]);
      for (const database of databases) {
        expect(await managedDependencyCount(database.databaseOid)).toBe("0");
      }
    } finally {
      releaseBarrier();
      for (const connection of bootstrapConnections) {
        if (!connection.released) {
          try {
            connection.client.release();
            connection.released = true;
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      for (const database of [...databases].reverse()) {
        try {
          await database.pool.end();
        } catch (error) {
          cleanupFailures.push(error);
        }
        try {
          await dropSiblingDatabase(
            database.databaseName,
            database.databaseOid,
          );
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      for (const databaseName of databaseNames) {
        if (
          databases.some((database) => database.databaseName === databaseName)
        ) {
          continue;
        }
        try {
          const residualOid = await databaseOidByName(databaseName);
          if (residualOid !== undefined) {
            await dropSiblingDatabase(databaseName, residualOid);
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await ownerPool.query(
          "DROP ROLE IF EXISTS dasher_security_definer, dasher_app",
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        const residue = await ownerPool.query<{
          readonly database_count: string;
          readonly role_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_database AS database_row
                WHERE database_row.datname = ANY($1::text[])
              ) AS database_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_roles AS role
                WHERE role.rolname IN (
                  'dasher_app',
                  'dasher_security_definer'
                )
              ) AS role_count
          `,
          [databaseNames],
        );
        expect(residue.rows[0]).toEqual({
          database_count: "0",
          role_count: "0",
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
      expect(cleanupFailures).toEqual([]);
    }
  }, 120_000);

  it("applies a clean exact series and repeats as a database-clock no-op", async () => {
    try {
      const applied = await runMigrations(
        ownerPool,
        fixtureMigrationDirectory,
        [],
      );
      expect(applied).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 0,
        appliedCount: 2,
      });

      const journal = await ownerPool.query<{
        readonly applied_before_observation: boolean;
        readonly applied_by_session_user: boolean;
        readonly count: string;
      }>(`
        SELECT
          count(*)::text AS count,
          bool_and(applied_by = session_user) AS applied_by_session_user,
          bool_and(applied_at <= statement_timestamp())
            AS applied_before_observation
        FROM dasher_meta.schema_migrations
      `);
      expect(journal.rows[0]).toEqual({
        count: "2",
        applied_by_session_user: true,
        applied_before_observation: true,
      });

      const repeated = await runMigrations(
        ownerPool,
        fixtureMigrationDirectory,
        [],
      );
      expect(repeated).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 2,
        appliedCount: 0,
      });

      const roles = await ownerPool.query<{
        readonly attributes_match: boolean;
        readonly comment: string | null;
        readonly password_is_null: boolean;
        readonly rolname: string;
      }>(`
        SELECT
          role.rolname::text AS rolname,
          NOT role.rolcanlogin
            AND NOT role.rolinherit
            AND NOT role.rolsuper
            AND NOT role.rolcreatedb
            AND NOT role.rolcreaterole
            AND NOT role.rolreplication
            AND role.rolbypassrls =
              (role.rolname = 'dasher_security_definer')
            AND role.rolconnlimit = -1
            AND role.rolvaliduntil IS NULL
            AS attributes_match,
          role.rolpassword IS NULL AS password_is_null,
          pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment
        FROM pg_catalog.pg_authid AS role
        WHERE role.rolname IN ('dasher_app', 'dasher_security_definer')
        ORDER BY role.rolname
      `);
      expect(roles.rows).toEqual([
        {
          rolname: "dasher_app",
          attributes_match: true,
          password_is_null: true,
          comment: "dasher:managed-role:v1:app",
        },
        {
          rolname: "dasher_security_definer",
          attributes_match: true,
          password_is_null: true,
          comment: "dasher:managed-role:v1:security-definer",
        },
      ]);
    } finally {
      await resetManagedSchemas();
    }
  });

  it("installs fresh canonical 0001 through 0008, reruns idempotently, and proves exact phase upgrades", async () => {
    try {
      await resetManagedSchemas();
      const first = await runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
        [],
      );
      expect(first).toEqual({
        appliedCount: 8,
        discoveredCount: 8,
        previouslyAppliedCount: 0,
      });
      const second = await runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
        [],
      );
      expect(second).toEqual({
        appliedCount: 0,
        discoveredCount: 8,
        previouslyAppliedCount: 8,
      });

      const client = await ownerPool.connect();
      try {
        const owner = await client.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        );
        const ownerName = owner.rows[0]?.owner_name;
        if (ownerName === undefined) {
          throw new Error("PostgreSQL did not return the session owner");
        }
        expect(
          await canonical0008CatalogMatchesForTests(client, ownerName),
        ).toBe(true);
        // The phase-7 catalog is no longer the installed catalog: 0008 added
        // the retention allowlist lock authority on top of it.
        expect(
          await canonical0007CatalogMatchesForTests(client, ownerName),
        ).toBe(false);
      } finally {
        client.release();
      }

      const journal = await ownerPool.query<{
        readonly checksum: string;
        readonly filename: string;
        readonly sequence: number;
      }>(`
        SELECT
          sequence,
          filename,
          pg_catalog.encode(checksum_sha256, 'hex') AS checksum
        FROM dasher_meta.schema_migrations
        ORDER BY sequence
      `);
      expect(journal.rows).toEqual([
        {
          checksum:
            "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
          filename: "0001_identity_audit.sql",
          sequence: 1,
        },
        {
          checksum:
            "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
          filename: "0002_security_boundary.sql",
          sequence: 2,
        },
        {
          checksum:
            "270ba6f5b8756425835ebb0df0ea8f8c4739b81202d2b4f2b48172a016db9c40",
          filename: "0003_immutable_content.sql",
          sequence: 3,
        },
        {
          checksum:
            "353021e04bd32183cba82e0069948d43fecf27f4b5ec9995bfb143419279e5d9",
          filename: "0004_lifecycle_api_correction.sql",
          sequence: 4,
        },
        {
          checksum:
            "f9e33e7a4033d77c1e56f098de68a519f2cfe434119c3bf5ffe13b8a3f9713e7",
          filename: "0005_security_definer_cleanup_coordination.sql",
          sequence: 5,
        },
        {
          checksum:
            "26a6075696c5aba6562a87f63564860e49b22cdbc1c8015335e19006044bd499",
          filename: "0006_lifecycle_access_retention_guard_correction.sql",
          sequence: 6,
        },
        {
          checksum:
            "dfe0ca8eef30b9b5a599657eaf0da6c93a330a90d3fa9b01c75a2f730d8db3d5",
          filename: "0007_agent_run_ledger_and_calculations.sql",
          sequence: 7,
        },
        {
          checksum:
            "9c3e2776e6cb92e1ef37b7f1cf66a76e8fbabe161af0d4bd4cbdc07bca61de9c",
          filename: "0008_retention_lock_authority_correction.sql",
          sequence: 8,
        },
      ]);

      await resetManagedSchemas();
      const canonical0003Directory = await mkdtemp(
        join(tmpdir(), "dasher-canonical-0003-pg-"),
      );
      try {
        for (const filename of [
          "0001_identity_audit.sql",
          "0002_security_boundary.sql",
          "0003_immutable_content.sql",
        ] as const) {
          await writeFile(
            join(canonical0003Directory, filename),
            await readFile(join(canonicalMigrationDirectory, filename)),
          );
        }
        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 3,
          discoveredCount: 3,
          previouslyAppliedCount: 0,
        });
        const prefixClient = await ownerPool.connect();
        try {
          const ownerName = (
            await prefixClient.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await exactCatalogMatchesForTests(
              prefixClient,
              getCanonical0003ExactCatalogContractForTests(ownerName),
              ownerName,
            ),
          ).toBe(true);
          expect(
            await canonical0003DependencyInventoryMatchesForTests(
              prefixClient,
              ownerName,
            ),
          ).toBe(true);
        } finally {
          prefixClient.release();
        }
        await writeFile(
          join(canonical0003Directory, "0004_lifecycle_api_correction.sql"),
          await readFile(
            join(
              canonicalMigrationDirectory,
              "0004_lifecycle_api_correction.sql",
            ),
          ),
        );
        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 4,
          previouslyAppliedCount: 3,
        });
        const correctionClient = await ownerPool.connect();
        try {
          const ownerName = (
            await correctionClient.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await exactCatalogMatchesForTests(
              correctionClient,
              getCanonical0004ExactCatalogContractForTests(ownerName),
              ownerName,
            ),
          ).toBe(true);
          expect(
            await canonical0004DependencyInventoryMatchesForTests(
              correctionClient,
              ownerName,
            ),
          ).toBe(true);
        } finally {
          correctionClient.release();
        }
        await writeFile(
          join(
            canonical0003Directory,
            "0005_security_definer_cleanup_coordination.sql",
          ),
          await readFile(
            join(
              canonicalMigrationDirectory,
              "0005_security_definer_cleanup_coordination.sql",
            ),
          ),
        );
        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 5,
          previouslyAppliedCount: 4,
        });
        const phase5Client = await ownerPool.connect();
        try {
          const ownerName = (
            await phase5Client.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await exactCatalogMatchesForTests(
              phase5Client,
              getCanonical0005ExactCatalogContractForTests(ownerName),
              ownerName,
            ),
          ).toBe(true);
          expect(
            await canonical0005DependencyInventoryMatchesForTests(
              phase5Client,
              ownerName,
            ),
          ).toBe(true);
        } finally {
          phase5Client.release();
        }
        await writeFile(
          join(
            canonical0003Directory,
            "0006_lifecycle_access_retention_guard_correction.sql",
          ),
          await readFile(
            join(
              canonicalMigrationDirectory,
              "0006_lifecycle_access_retention_guard_correction.sql",
            ),
          ),
        );
        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 6,
          previouslyAppliedCount: 5,
        });
        const phase6Client = await ownerPool.connect();
        try {
          const ownerName = (
            await phase6Client.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          const exact0006Sql = await readFile(
            join(
              canonicalMigrationDirectory,
              "0006_lifecycle_access_retention_guard_correction.sql",
            ),
            "utf8",
          );
          expect(
            await exactCatalogMatchesForTests(
              phase6Client,
              getCanonical0006ExactCatalogContractForTests(
                ownerName,
                exact0006Sql,
              ),
              ownerName,
            ),
          ).toBe(true);
          expect(
            await canonical0006DependencyInventoryMatchesForTests(
              phase6Client,
              ownerName,
              exact0006Sql,
            ),
          ).toBe(true);
        } finally {
          phase6Client.release();
        }
        await writeFile(
          join(
            canonical0003Directory,
            "0007_agent_run_ledger_and_calculations.sql",
          ),
          await readFile(
            join(
              canonicalMigrationDirectory,
              "0007_agent_run_ledger_and_calculations.sql",
            ),
          ),
        );
        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 7,
          previouslyAppliedCount: 6,
        });
        const phase7Client = await ownerPool.connect();
        try {
          const ownerName = (
            await phase7Client.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await canonical0007CatalogMatchesForTests(phase7Client, ownerName),
          ).toBe(true);
          expect(
            await canonical0008CatalogMatchesForTests(phase7Client, ownerName),
          ).toBe(false);
        } finally {
          phase7Client.release();
        }
        await expect(
          runMigrations(ownerPool, canonicalMigrationDirectory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 8,
          previouslyAppliedCount: 7,
        });
        const phase8Client = await ownerPool.connect();
        try {
          const ownerName = (
            await phase8Client.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await canonical0008CatalogMatchesForTests(phase8Client, ownerName),
          ).toBe(true);
          expect(
            await canonical0007CatalogMatchesForTests(phase8Client, ownerName),
          ).toBe(false);
        } finally {
          phase8Client.release();
        }
      } finally {
        await rm(canonical0003Directory, { recursive: true, force: true });
      }
    } finally {
      await resetManagedSchemas();
    }
  }, 120_000);

  // The phase-7 and phase-8 fingerprints are frozen constants, and the queries
  // that produce them read pg_database. If any identity they hash carried the
  // database's own name, the constants would reproduce on a database called
  // dasher_ci and fail closed on every other one - the gate would pass here and
  // reject the same schema in production under a different database name. This
  // applies the whole series to a database whose name is deliberately not the
  // one the rest of this suite uses, and requires both frozen constants to
  // reproduce there unchanged.
  //
  // Both databases satisfying the same frozen constant is the identity claim:
  // the phase-7 fingerprint computed here equals the phase-7 fingerprint the
  // test above computed on the primary database, because each is asserted equal
  // to canonicalPhase7CatalogFingerprintSha256. The mutual-exclusion checks
  // come along too, so neither phase can be satisfied by the other's catalog on
  // this name any more than on the primary's.
  //
  // The canonical series is a cluster-wide singleton - a second database cannot
  // hold it while the primary does, because the prepared retention roles are
  // cluster objects and the migrator refuses to install over them - so the
  // primary is reset first and the sibling is torn down completely afterwards.
  it("reproduces both frozen phase catalogs on a differently named database", async () => {
    const databaseName = `dasher_t9_${siblingDatabaseNonce}_altname`;
    // A name-independence proof is vacuous unless the names actually differ.
    expect(databaseName).not.toBe(config.ownerDatabase);

    let sibling:
      | {
          readonly databaseOid: string;
          readonly pool: Pool;
        }
      | undefined;
    const phase7Directory = await mkdtemp(
      join(tmpdir(), "dasher-altname-phase7-pg-"),
    );

    try {
      await resetManagedSchemas();
      sibling = await createSiblingDatabase(databaseName);
      const siblingPool = sibling.pool;

      const bootstrap = await siblingPool.connect();
      try {
        await bootstrapManagedRoles(bootstrap, []);
      } finally {
        bootstrap.release();
      }

      // Phase 7 first, from a directory holding exactly 0001 through 0007.
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
        "0003_immutable_content.sql",
        "0004_lifecycle_api_correction.sql",
        "0005_security_definer_cleanup_coordination.sql",
        "0006_lifecycle_access_retention_guard_correction.sql",
        "0007_agent_run_ledger_and_calculations.sql",
      ] as const) {
        await writeFile(
          join(phase7Directory, filename),
          await readFile(join(canonicalMigrationDirectory, filename)),
        );
      }
      await expect(
        runMigrations(siblingPool, phase7Directory, []),
      ).resolves.toEqual({
        appliedCount: 7,
        discoveredCount: 7,
        previouslyAppliedCount: 0,
      });

      const phase7Client = await siblingPool.connect();
      try {
        const ownerName = (
          await phase7Client.query<{
            readonly database_name: string;
            readonly owner_name: string;
          }>(
            "SELECT session_user::text AS owner_name, pg_catalog.current_database()::text AS database_name",
          )
        ).rows[0];
        if (ownerName === undefined) {
          throw new Error("PostgreSQL did not return the session owner");
        }
        // The connection really is on the differently named database.
        expect(ownerName.database_name).toBe(databaseName);
        expect(ownerName.database_name).not.toBe(config.ownerDatabase);
        expect(
          await canonical0007CatalogMatchesForTests(
            phase7Client,
            ownerName.owner_name,
          ),
        ).toBe(true);
        expect(
          await canonical0008CatalogMatchesForTests(
            phase7Client,
            ownerName.owner_name,
          ),
        ).toBe(false);
      } finally {
        phase7Client.release();
      }

      // Then 0008 on top, from the canonical directory itself.
      await expect(
        runMigrations(siblingPool, canonicalMigrationDirectory, []),
      ).resolves.toEqual({
        appliedCount: 1,
        discoveredCount: 8,
        previouslyAppliedCount: 7,
      });

      const phase8Client = await siblingPool.connect();
      try {
        const ownerName = (
          await phase8Client.query<{ readonly owner_name: string }>(
            "SELECT session_user::text AS owner_name",
          )
        ).rows[0]?.owner_name;
        if (ownerName === undefined) {
          throw new Error("PostgreSQL did not return the session owner");
        }
        expect(
          await canonical0008CatalogMatchesForTests(phase8Client, ownerName),
        ).toBe(true);
        expect(
          await canonical0007CatalogMatchesForTests(phase8Client, ownerName),
        ).toBe(false);
      } finally {
        phase8Client.release();
      }
    } finally {
      await rm(phase7Directory, { recursive: true, force: true });
      if (sibling !== undefined) {
        const siblingPool = sibling.pool;
        const siblingOid = sibling.databaseOid;
        sibling = undefined;
        try {
          await siblingPool.end();
        } finally {
          await dropSiblingDatabase(databaseName, siblingOid);
        }
      } else {
        const residualOid = await databaseOidByName(databaseName);
        if (residualOid !== undefined) {
          await dropSiblingDatabase(databaseName, residualOid);
        }
      }
      // The sibling is gone, so the cluster roles it left behind have no
      // dependent objects and the next test starts from the same clean state
      // every other test in this block starts from.
      await resetManagedSchemas();
    }
  }, 180_000);

  // The same name-independence claim, taken against the three database names
  // that actually defeat the naive implementation, and against the two
  // inventory families that carry the risk.
  //
  // Only two of the four families the phase fingerprints hash can name the
  // database at all: the ACL entries, whose database-scoped identity has to be
  // the '<current_database>' placeholder rather than the database's own name,
  // and the shared dependencies, exactly one of whose rows describes an object
  // that IS the current database. The tempting implementation of the second one
  // is a substring rewrite of pg_describe_object's output, and these three
  // names are what it destroys: 'dasher' occurs inside every
  // 'table dasher.<relation>' identity, 'audit_events' inside every
  // 'column ... of table dasher.audit_events', and 'dasher_api' inside
  // 'schema dasher_api' and every routine in it. None of those descriptions
  // names the database, so a rewrite of them is never correct, and the phase
  // fingerprints they feed would drift with the deployment's database name -
  // the frozen constants would reproduce on dasher_ci and fail closed
  // everywhere else. The correct rewrite matches on catalog identity, and this
  // is the regression that keeps it that way.
  //
  // The proof is byte equality of the normalized inventory text across all four
  // names, not just equality of the digest over it: a digest tells you that
  // something moved, this tells you which entry did. The two frozen constants
  // are asserted on each name as well, so the whole-inventory claim rides
  // along.
  //
  // Both phases are walked on every name, because the name-dependence hole
  // lives in the shared WITH list that feeds BOTH phase fingerprints. Stopping
  // at phase 8 would leave the phase-7 constant proven only negatively - as the
  // digest that does NOT match a phase-8 catalog - which a name-dependent
  // normalization satisfies just as easily as a correct one. So each name gets
  // 0001 through 0007 installed first, the phase-7 catalog asserted positively
  // and its name-sensitive inventory captured, and only then 0008 on top for
  // the phase-8 half.
  it("reproduces the name-sensitive inventories on dasher, audit_events and dasher_api", async () => {
    const defeatNames = ["dasher", "audit_events", "dasher_api"] as const;
    for (const defeatName of defeatNames) {
      expect(defeatName).not.toBe(config.ownerDatabase);
    }

    type CapturedInventory = Readonly<{
      entryCount: string;
      fingerprintSha256: string;
      inventory: string;
    }>;
    const capturedByPhase = {
      7: new Map<string, CapturedInventory>(),
      8: new Map<string, CapturedInventory>(),
    } as const;

    const capture = async (
      pool: Pool,
      expectedName: string,
      phase: 7 | 8,
    ): Promise<void> => {
      const client = await pool.connect();
      try {
        const identity = (
          await client.query<{
            readonly database_name: string;
            readonly owner_name: string;
          }>(
            "SELECT session_user::text AS owner_name, pg_catalog.current_database()::text AS database_name",
          )
        ).rows[0];
        if (identity === undefined) {
          throw new Error("PostgreSQL did not return the session identity");
        }
        expect(identity.database_name).toBe(expectedName);
        // Both frozen constants are asserted on this name at this phase: the
        // one the database is actually at holds, and the other cannot be
        // satisfied by it any more than on dasher_ci.
        expect(
          await canonical0007CatalogMatchesForTests(
            client,
            identity.owner_name,
          ),
          `${expectedName} phase-7 constant at phase ${phase}`,
        ).toBe(phase === 7);
        expect(
          await canonical0008CatalogMatchesForTests(
            client,
            identity.owner_name,
          ),
          `${expectedName} phase-8 constant at phase ${phase}`,
        ).toBe(phase === 8);
        capturedByPhase[phase].set(
          expectedName,
          await canonicalPhaseNameSensitiveInventoryForTests(
            client,
            identity.owner_name,
          ),
        );
      } finally {
        client.release();
      }
    };

    // 0001 through 0007 from a directory holding exactly those seven files, so
    // the phase-7 catalog can be read on a database that has never seen 0008.
    const phase7Directory = await mkdtemp(
      join(tmpdir(), "dasher-defeatname-phase7-pg-"),
    );

    const installBothPhasesAndCapture = async (
      pool: Pool,
      name: string,
    ): Promise<void> => {
      await expect(runMigrations(pool, phase7Directory, [])).resolves.toEqual({
        appliedCount: 7,
        discoveredCount: 7,
        previouslyAppliedCount: 0,
      });
      await capture(pool, name, 7);
      await expect(
        runMigrations(pool, canonicalMigrationDirectory, []),
      ).resolves.toEqual({
        appliedCount: 1,
        discoveredCount: 8,
        previouslyAppliedCount: 7,
      });
      await capture(pool, name, 8);
    };

    try {
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
        "0003_immutable_content.sql",
        "0004_lifecycle_api_correction.sql",
        "0005_security_definer_cleanup_coordination.sql",
        "0006_lifecycle_access_retention_guard_correction.sql",
        "0007_agent_run_ledger_and_calculations.sql",
      ] as const) {
        await writeFile(
          join(phase7Directory, filename),
          await readFile(join(canonicalMigrationDirectory, filename)),
        );
      }

      // The primary database first. The canonical series is a cluster-wide
      // singleton, so each name holds it alone and is torn down before the
      // next.
      await resetManagedSchemas();
      try {
        await installBothPhasesAndCapture(ownerPool, config.ownerDatabase);
      } finally {
        await resetManagedSchemas();
      }

      for (const defeatName of defeatNames) {
        let sibling:
          { readonly databaseOid: string; readonly pool: Pool } | undefined;
        try {
          sibling = await createSiblingDatabase(defeatName);
          const bootstrap = await sibling.pool.connect();
          try {
            await bootstrapManagedRoles(bootstrap, []);
          } finally {
            bootstrap.release();
          }
          await installBothPhasesAndCapture(sibling.pool, defeatName);
        } finally {
          if (sibling !== undefined) {
            const siblingPool = sibling.pool;
            const siblingOid = sibling.databaseOid;
            sibling = undefined;
            try {
              await siblingPool.end();
            } finally {
              await dropSiblingDatabase(defeatName, siblingOid);
            }
          } else {
            const residualOid = await databaseOidByName(defeatName);
            if (residualOid !== undefined) {
              await dropSiblingDatabase(defeatName, residualOid);
            }
          }
          await resetManagedSchemas();
        }
      }
    } finally {
      await rm(phase7Directory, { recursive: true, force: true });
    }

    const names = [config.ownerDatabase, ...defeatNames] as const;
    const baselines = new Map<7 | 8, CapturedInventory>();
    for (const phase of [7, 8] as const) {
      const captured = capturedByPhase[phase];
      expect([...captured.keys()].sort(), `phase ${phase}`).toEqual(
        [...names].sort(),
      );
      const baseline = captured.get(config.ownerDatabase);
      if (baseline === undefined) {
        throw new Error(
          `the primary database phase-${phase} inventory was not captured`,
        );
      }
      baselines.set(phase, baseline);
      // Not a vacuous comparison: these two families are populated, and they do
      // carry the placeholder both normalizations are supposed to emit.
      expect(Number(baseline.entryCount), `phase ${phase}`).toBeGreaterThan(0);
      expect(baseline.inventory, `phase ${phase}`).toContain(
        "database|<current_database>|",
      );
      expect(baseline.inventory, `phase ${phase}`).toContain(
        "database <current_database>",
      );
      // And the identities that merely contain a defeat name as a substring are
      // present, which is what makes a substring rewrite detectable here.
      expect(baseline.inventory, `phase ${phase}`).toContain(
        "table dasher.audit_events",
      );
      expect(baseline.inventory, `phase ${phase}`).toContain(
        "schema dasher_api",
      );
      for (const defeatName of defeatNames) {
        expect(baseline.inventory, `phase ${phase}`).toContain(defeatName);
      }

      for (const name of names) {
        expect(captured.get(name), `phase ${phase} on ${name}`).toEqual(
          baseline,
        );
      }
    }

    // The two captures per name really are two different catalogs, so the
    // phase-7 half is not the phase-8 half asserted twice: 0008 grants and
    // policies land in the privilege family this inventory reads.
    const phase7Baseline = baselines.get(7);
    const phase8Baseline = baselines.get(8);
    if (phase7Baseline === undefined || phase8Baseline === undefined) {
      throw new Error("both phase baselines must have been captured");
    }
    expect(phase7Baseline.fingerprintSha256).not.toBe(
      phase8Baseline.fingerprintSha256,
    );
    expect(phase7Baseline.inventory).not.toBe(phase8Baseline.inventory);
  }, 900_000);

  it("reproduces the exact 0004 delete authority failure and proves the bounded 0005 correction atomically", async () => {
    const canonical0004Directory = await mkdtemp(
      join(tmpdir(), "dasher-cleanup-coordination-0004-pg-"),
    );
    let deleteAppPool: Pool | undefined;
    let client: PoolClient | undefined;
    const dashboardId = randomUUID();
    const tombstoneLineageId = randomUUID();
    const createAuditId = randomUUID();
    const deleteEventId = randomUUID();
    const tenantBDashboardId = randomUUID();
    const tenantBTombstoneLineageId = randomUUID();
    const tenantBCreateAuditId = randomUUID();
    let actor: Task4Actor | undefined;

    const readDeleteResidue = async () => {
      const result = await ownerPool.query<{
        readonly access_revoked_at: Date | null;
        readonly audit_count: string;
        readonly coordination_count: string;
        readonly event_count: string;
        readonly ledger_count: string;
        readonly lifecycle_revision: string;
        readonly lifecycle_state: string;
        readonly tombstone_count: string;
      }>(
        `
          SELECT
            dashboard.lifecycle_state,
            dashboard.lifecycle_revision::text AS lifecycle_revision,
            dashboard.access_revoked_at,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.dashboard_tombstones AS tombstone
              WHERE tombstone.organization_id = dashboard.organization_id
                AND tombstone.tombstone_lineage_id = $2::uuid
            ) AS tombstone_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.dashboard_cleanup_coordination AS coordination
              WHERE coordination.organization_id = dashboard.organization_id
                AND coordination.dashboard_id = dashboard.dashboard_id
            ) AS coordination_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.backup_deletion_ledger AS ledger
              WHERE ledger.organization_id = dashboard.organization_id
                AND ledger.tombstone_lineage_id = $2::uuid
            ) AS ledger_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.dashboard_lifecycle_events AS event
              WHERE event.organization_id = dashboard.organization_id
                AND event.lifecycle_event_id = $3::uuid
            ) AS event_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.audit_events AS audit
              WHERE audit.organization_id = dashboard.organization_id
                AND audit.audit_event_id = $3::uuid
            ) AS audit_count
          FROM dasher.dashboards AS dashboard
          WHERE dashboard.dashboard_id = $1::uuid
        `,
        [dashboardId, tombstoneLineageId, deleteEventId],
      );
      return result.rows[0];
    };

    try {
      await closeAppPoolBeforeLoginTeardown();
      if (appLoginCreated) {
        await dropTemporaryAppLogin(
          ownerPool,
          config.appDatabase,
          config.appUsername,
        );
        appLoginCreated = false;
      }
      await resetManagedSchemas();
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
        "0003_immutable_content.sql",
        "0004_lifecycle_api_correction.sql",
      ] as const) {
        await writeFile(
          join(canonical0004Directory, filename),
          await readFile(join(canonicalMigrationDirectory, filename)),
        );
      }
      await createTemporaryAppLogin(
        ownerPool,
        config.appDsn,
        config.appUsername,
      );
      appLoginCreated = true;
      await expect(
        runMigrations(ownerPool, canonical0004Directory, [config.appUsername]),
      ).resolves.toEqual({
        appliedCount: 4,
        discoveredCount: 4,
        previouslyAppliedCount: 0,
      });

      deleteAppPool = new Pool({ connectionString: config.appDsn, max: 1 });
      client = await deleteAppPool.connect();
      await client.query("SET ROLE dasher_app");
      actor = await createTask4Actor(client, "admin");
      await runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
        client!.query(
          `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Cleanup authority proof', 'durable', NULL, false,
                $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b4-integration'
              )
            `,
          [dashboardId, tombstoneLineageId, createAuditId, actor!.csrfDigest],
        ),
      );

      const cleanDeleteBaseline = {
        access_revoked_at: null,
        audit_count: "0",
        coordination_count: "0",
        event_count: "0",
        ledger_count: "0",
        lifecycle_revision: "0",
        lifecycle_state: "draft",
        tombstone_count: "0",
      };
      expect(await readDeleteResidue()).toEqual(cleanDeleteBaseline);

      await expect(
        runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
          client!.query(
            `
              SELECT dasher_api.delete_dashboard(
                $1::uuid, 0::bigint, $2::uuid, 1::smallint, $3::bytea,
                'task8b4-integration'
              )
            `,
            [dashboardId, deleteEventId, actor!.csrfDigest],
          ),
        ),
      ).rejects.toMatchObject({
        code: "42501",
        message: "permission denied for table dashboard_cleanup_coordination",
      });
      expect(await readDeleteResidue()).toEqual(cleanDeleteBaseline);

      await writeFile(
        join(
          canonical0004Directory,
          "0005_security_definer_cleanup_coordination.sql",
        ),
        await readFile(
          join(
            canonicalMigrationDirectory,
            "0005_security_definer_cleanup_coordination.sql",
          ),
        ),
      );
      await expect(
        runMigrations(ownerPool, canonical0004Directory, [config.appUsername]),
      ).resolves.toEqual({
        appliedCount: 1,
        discoveredCount: 5,
        previouslyAppliedCount: 4,
      });

      const authority = await ownerPool.query<{
        readonly app_table_insert: boolean;
        readonly forced_rls: boolean;
        readonly public_table_insert_denied: boolean;
        readonly retention_table_insert: boolean;
        readonly security_definer_insert_columns: string[];
        readonly security_definer_table_insert: boolean;
      }>(`
        SELECT
          relation.relforcerowsecurity AS forced_rls,
          pg_catalog.has_table_privilege(
            'dasher_security_definer', relation.oid, 'INSERT'
          ) AS security_definer_table_insert,
          pg_catalog.has_table_privilege(
            'dasher_app', relation.oid, 'INSERT'
          ) AS app_table_insert,
          pg_catalog.has_table_privilege(
            'dasher_retention_definer', relation.oid, 'INSERT'
          ) AS retention_table_insert,
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.aclexplode(relation.relacl) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'INSERT'
          ) AS public_table_insert_denied,
          ARRAY(
            SELECT attribute.attname::text
            FROM pg_catalog.pg_attribute AS attribute
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
              AS privilege
            JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = privilege.grantee
            WHERE attribute.attrelid = relation.oid
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND grantee.rolname = 'dasher_security_definer'
              AND privilege.privilege_type = 'INSERT'
            ORDER BY attribute.attname
          ) AS security_definer_insert_columns
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'dasher'
          AND relation.relname = 'dashboard_cleanup_coordination'
      `);
      expect(authority.rows[0]).toEqual({
        app_table_insert: false,
        forced_rls: true,
        public_table_insert_denied: true,
        retention_table_insert: true,
        security_definer_insert_columns: [
          "current_step",
          "dashboard_id",
          "expected_lifecycle_revision",
          "next_attempt_at",
          "organization_id",
        ],
        security_definer_table_insert: false,
      });

      const insertPolicies = await ownerPool.query<{
        readonly command: string;
        readonly name: string;
        readonly permissive: boolean;
        readonly roles: string[];
        readonly using_expression: string | null;
        readonly with_check_expression: string | null;
      }>(`
        SELECT
          policy.polname::text AS name,
          policy.polpermissive AS permissive,
          policy.polcmd::text AS command,
          ARRAY(
            SELECT role.rolname::text
            FROM pg_catalog.unnest(policy.polroles) AS role_oid(oid)
            JOIN pg_catalog.pg_roles AS role ON role.oid = role_oid.oid
            ORDER BY role.rolname
          ) AS roles,
          pg_catalog.pg_get_expr(
            policy.polqual, policy.polrelid, false
          ) AS using_expression,
          pg_catalog.pg_get_expr(
            policy.polwithcheck, policy.polrelid, false
          ) AS with_check_expression
        FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'dasher'
          AND relation.relname = 'dashboard_cleanup_coordination'
          AND policy.polcmd = 'a'
        ORDER BY policy.polname
      `);
      expect(insertPolicies.rows).toHaveLength(2);
      expect(
        insertPolicies.rows.map(({ command, name, permissive, roles }) => ({
          command,
          name,
          permissive,
          roles,
        })),
      ).toEqual([
        {
          command: "a",
          name: "dashboard_cleanup_coordination_retention_insert",
          permissive: true,
          roles: ["dasher_retention_definer"],
        },
        {
          command: "a",
          name: "dashboard_cleanup_coordination_security_definer_insert",
          permissive: true,
          roles: ["dasher_security_definer"],
        },
      ]);
      expect(insertPolicies.rows[1]).toMatchObject({
        using_expression: null,
        with_check_expression:
          "((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id()))",
      });

      // This is an adjacent ACL-denial probe; the controlled transaction below
      // isolates the security-definer INSERT policy itself.
      await expect(
        runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
          client!.query(
            `
              INSERT INTO dasher.dashboard_cleanup_coordination (
                organization_id, dashboard_id, current_step,
                expected_lifecycle_revision, next_attempt_at
              ) VALUES (
                $1::uuid, $2::uuid, 'access_revoked', 1, clock_timestamp()
              )
            `,
            [randomUUID(), dashboardId],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      const tenantBActor = await createTask4Actor(client, "admin");
      await runContextOperation(
        client,
        tenantBActor.sessionDigest,
        randomUUID(),
        () =>
          client!.query(
            `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Foreign cleanup policy proof', 'durable', NULL,
                false, $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b4-integration'
              )
            `,
            [
              tenantBDashboardId,
              tenantBTombstoneLineageId,
              tenantBCreateAuditId,
              tenantBActor.csrfDigest,
            ],
          ),
      );

      const policyFixtureState = await ownerPool.query<{
        readonly coordination_count: string;
        readonly dashboard_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.dashboards AS dashboard
              WHERE (dashboard.organization_id, dashboard.dashboard_id) IN (
                ($1::uuid, $2::uuid),
                ($3::uuid, $4::uuid)
              )
            ) AS dashboard_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.dashboard_cleanup_coordination AS coordination
              WHERE (
                coordination.organization_id,
                coordination.dashboard_id
              ) IN (
                ($1::uuid, $2::uuid),
                ($3::uuid, $4::uuid)
              )
            ) AS coordination_count
        `,
        [
          actor.organizationId,
          dashboardId,
          tenantBActor.organizationId,
          tenantBDashboardId,
        ],
      );
      expect(policyFixtureState.rows[0]).toEqual({
        coordination_count: "0",
        dashboard_count: "2",
      });

      const policyClient = await ownerPool.connect();
      let policyIsolationError: unknown;
      let policyTransactionOpen = false;
      try {
        await policyClient.query("BEGIN");
        policyTransactionOpen = true;
        await policyClient.query("SET LOCAL ROLE dasher_app");
        await policyClient.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [actor.sessionDigest, randomUUID()],
        );
        await policyClient.query("RESET ROLE");
        await policyClient.query(
          "ALTER ROLE dasher_security_definer NOBYPASSRLS",
        );
        await policyClient.query("SET LOCAL ROLE dasher_security_definer");

        const policyIdentity = await policyClient.query<{
          readonly bypasses_rls: boolean;
          readonly context_organization_id: string;
          readonly current_user: string;
        }>(`
          SELECT
            CURRENT_USER::text AS current_user,
            dasher_private.context_organization_id()::text
              AS context_organization_id,
            role.rolbypassrls AS bypasses_rls
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = CURRENT_USER
        `);
        expect(policyIdentity.rows[0]).toEqual({
          bypasses_rls: false,
          context_organization_id: actor.organizationId,
          current_user: "dasher_security_definer",
        });

        const sameTenantInsert = await policyClient.query(
          `
            INSERT INTO dasher.dashboard_cleanup_coordination (
              organization_id, dashboard_id, current_step,
              expected_lifecycle_revision, next_attempt_at
            ) VALUES (
              $1::uuid, $2::uuid, 'access_revoked', 1, clock_timestamp()
            )
          `,
          [actor.organizationId, dashboardId],
        );
        expect(sameTenantInsert.rowCount).toBe(1);

        await policyClient.query("SAVEPOINT reject_foreign_tenant");
        let foreignTenantInsertError: unknown;
        try {
          await policyClient.query(
            `
              INSERT INTO dasher.dashboard_cleanup_coordination (
                organization_id, dashboard_id, current_step,
                expected_lifecycle_revision, next_attempt_at
              ) VALUES (
                $1::uuid, $2::uuid, 'access_revoked', 1, clock_timestamp()
              )
            `,
            [tenantBActor.organizationId, tenantBDashboardId],
          );
        } catch (error) {
          foreignTenantInsertError = error;
        }
        await policyClient.query("ROLLBACK TO SAVEPOINT reject_foreign_tenant");
        await policyClient.query("RELEASE SAVEPOINT reject_foreign_tenant");
        expect(foreignTenantInsertError).toMatchObject({ code: "42501" });
      } catch (error) {
        policyIsolationError = error;
      } finally {
        if (policyTransactionOpen) {
          try {
            await policyClient.query("ROLLBACK");
            policyTransactionOpen = false;
          } catch (error) {
            policyIsolationError ??= error;
          }
        }
        policyClient.release(policyTransactionOpen);
      }

      const policyResidue = await ownerPool.query<{
        readonly tenant_a_count: string;
        readonly tenant_b_count: string;
      }>(
        `
          SELECT
            pg_catalog.count(*) FILTER (
              WHERE coordination.organization_id = $1::uuid
                AND coordination.dashboard_id = $2::uuid
            )::text AS tenant_a_count,
            pg_catalog.count(*) FILTER (
              WHERE coordination.organization_id = $3::uuid
                AND coordination.dashboard_id = $4::uuid
            )::text AS tenant_b_count
          FROM dasher.dashboard_cleanup_coordination AS coordination
          WHERE (coordination.organization_id, coordination.dashboard_id) IN (
            ($1::uuid, $2::uuid),
            ($3::uuid, $4::uuid)
          )
        `,
        [
          actor.organizationId,
          dashboardId,
          tenantBActor.organizationId,
          tenantBDashboardId,
        ],
      );
      expect(policyResidue.rows[0]).toEqual({
        tenant_a_count: "0",
        tenant_b_count: "0",
      });
      const restoredPolicyRole = await ownerPool.query<{
        readonly bypasses_rls: boolean;
      }>(`
        SELECT role.rolbypassrls AS bypasses_rls
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = 'dasher_security_definer'
      `);
      expect(restoredPolicyRole.rows[0]).toEqual({ bypasses_rls: true });
      if (policyIsolationError !== undefined) {
        throw policyIsolationError;
      }

      await runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
        client!.query(
          `
              SELECT dasher_api.delete_dashboard(
                $1::uuid, 0::bigint, $2::uuid, 1::smallint, $3::bytea,
                'task8b4-integration'
              )
            `,
          [dashboardId, deleteEventId, actor!.csrfDigest],
        ),
      );

      const deleted = await ownerPool.query<{
        readonly audit_action: string;
        readonly audit_outcome: string;
        readonly coordination_step: string;
        readonly event_kind: string;
        readonly expected_lifecycle_revision: string;
        readonly ledger_kind: string;
        readonly lifecycle_revision: string;
        readonly lifecycle_state: string;
        readonly next_attempt_bound: boolean;
        readonly proofs_match: boolean;
        readonly tenant_bound: boolean;
        readonly tombstone_lifecycle_revision: string;
      }>(
        `
          SELECT
            dashboard.lifecycle_state,
            dashboard.lifecycle_revision::text AS lifecycle_revision,
            coordination.current_step AS coordination_step,
            coordination.expected_lifecycle_revision::text
              AS expected_lifecycle_revision,
            tombstone.access_revoked_lifecycle_revision::text
              AS tombstone_lifecycle_revision,
            ledger.event_kind AS ledger_kind,
            event.event_kind,
            audit.action AS audit_action,
            audit.outcome AS audit_outcome,
            coordination.next_attempt_at = dashboard.access_revoked_at
              AS next_attempt_bound,
            tombstone.access_revoked_proof_sha256 = ledger.proof_sha256
              AND ledger.proof_sha256 = event.reason_sha256
              AND event.reason_sha256 = audit.content_sha256 AS proofs_match,
            dashboard.organization_id = $4::uuid
              AND coordination.organization_id = $4::uuid
              AND tombstone.organization_id = $4::uuid
              AND ledger.organization_id = $4::uuid
              AND event.organization_id = $4::uuid
              AND audit.organization_id = $4::uuid AS tenant_bound
          FROM dasher.dashboards AS dashboard
          JOIN dasher.dashboard_cleanup_coordination AS coordination
            ON coordination.organization_id = dashboard.organization_id
           AND coordination.dashboard_id = dashboard.dashboard_id
          JOIN dasher.dashboard_tombstones AS tombstone
            ON tombstone.organization_id = dashboard.organization_id
           AND tombstone.tombstone_lineage_id = $2::uuid
          JOIN dasher.backup_deletion_ledger AS ledger
            ON ledger.organization_id = dashboard.organization_id
           AND ledger.tombstone_lineage_id = $2::uuid
           AND ledger.event_kind = 'access_revoked'
          JOIN dasher.dashboard_lifecycle_events AS event
            ON event.organization_id = dashboard.organization_id
           AND event.lifecycle_event_id = $3::uuid
          JOIN dasher.audit_events AS audit
            ON audit.organization_id = dashboard.organization_id
           AND audit.audit_event_id = $3::uuid
          WHERE dashboard.dashboard_id = $1::uuid
        `,
        [dashboardId, tombstoneLineageId, deleteEventId, actor.organizationId],
      );
      expect(deleted.rows).toEqual([
        {
          audit_action: "dashboard.deleted",
          audit_outcome: "succeeded",
          coordination_step: "access_revoked",
          event_kind: "deleted",
          expected_lifecycle_revision: "1",
          ledger_kind: "access_revoked",
          lifecycle_revision: "1",
          lifecycle_state: "access_revoked",
          next_attempt_bound: true,
          proofs_match: true,
          tenant_bound: true,
          tombstone_lifecycle_revision: "1",
        },
      ]);
    } finally {
      if (client !== undefined) {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
      await deleteAppPool?.end().catch(() => undefined);
      if (appLoginCreated) {
        await dropTemporaryAppLogin(
          ownerPool,
          config.appDatabase,
          config.appUsername,
        );
        appLoginCreated = false;
      }
      await resetManagedSchemas();
      await rm(canonical0004Directory, { recursive: true, force: true });
      expect(await schemaPresence()).toEqual({
        dasher: false,
        dasherMeta: false,
      });
    }
  }, 120_000);

  it.each(["catalog", "journal"] as const)(
    "rolls back exact 0004 after an injected post-DDL %s failure and retries from exact journal 3",
    async (failureStage) => {
      const canonical0003Directory = await mkdtemp(
        join(tmpdir(), "dasher-rollback-0004-pg-"),
      );
      const expectedJournal = [
        {
          checksum:
            "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
          filename: "0001_identity_audit.sql",
          sequence: 1,
        },
        {
          checksum:
            "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
          filename: "0002_security_boundary.sql",
          sequence: 2,
        },
        {
          checksum:
            "270ba6f5b8756425835ebb0df0ea8f8c4739b81202d2b4f2b48172a016db9c40",
          filename: "0003_immutable_content.sql",
          sequence: 3,
        },
        {
          checksum:
            "353021e04bd32183cba82e0069948d43fecf27f4b5ec9995bfb143419279e5d9",
          filename: "0004_lifecycle_api_correction.sql",
          sequence: 4,
        },
      ] as const;
      let exact0004SqlExecutions = 0;
      let sequence4JournalAttempts = 0;
      let injected = false;

      const expectExactClosure = async (sequence: 3 | 4): Promise<void> => {
        const client = await ownerPool.connect();
        try {
          const ownerName = (
            await client.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await exactCatalogMatchesForTests(
              client,
              sequence === 3
                ? getCanonical0003ExactCatalogContractForTests(ownerName)
                : getCanonical0004ExactCatalogContractForTests(ownerName),
              ownerName,
            ),
          ).toBe(true);
          expect(
            sequence === 3
              ? await canonical0003DependencyInventoryMatchesForTests(
                  client,
                  ownerName,
                )
              : await canonical0004DependencyInventoryMatchesForTests(
                  client,
                  ownerName,
                ),
          ).toBe(true);
        } finally {
          client.release();
        }
      };

      const expectExactJournal = async (count: 3 | 4): Promise<void> => {
        const journal = await ownerPool.query<{
          readonly checksum: string;
          readonly filename: string;
          readonly sequence: number;
        }>(`
          SELECT
            sequence,
            filename,
            pg_catalog.encode(checksum_sha256, 'hex') AS checksum
          FROM dasher_meta.schema_migrations
          ORDER BY sequence
        `);
        expect(journal.rows).toEqual(expectedJournal.slice(0, count));
      };

      const instrumentedPool = {
        async connect(): Promise<MigrationClient> {
          const client = await ownerPool.connect();
          const query = (async (text: string, values?: readonly unknown[]) => {
            if (
              text.includes("-- Dasher lifecycle API correction successor.")
            ) {
              const result = await client.query(
                text,
                values as unknown[] | undefined,
              );
              exact0004SqlExecutions += 1;
              return result;
            }
            if (
              text.includes("INSERT INTO dasher_meta.schema_migrations") &&
              values?.[0] === 4
            ) {
              sequence4JournalAttempts += 1;
              if (failureStage === "journal") {
                injected = true;
                throw new Error("injected exact 0004 journal failure");
              }
            }
            if (
              failureStage === "catalog" &&
              exact0004SqlExecutions === 1 &&
              text.includes("signature_catalog AS (") &&
              typeof values?.[0] === "string"
            ) {
              const expected = JSON.parse(values[0]) as {
                readonly types?: readonly string[];
              };
              if (
                expected.types?.some((signature) =>
                  signature.includes("|dashboard_creation_result|"),
                ) === true
              ) {
                injected = true;
                return { rows: [{ matches: false }] };
              }
            }
            return client.query(text, values as unknown[] | undefined);
          }) as MigrationClient["query"];
          return {
            query,
            release(error) {
              client.release(error);
            },
          };
        },
      };

      try {
        for (const filename of [
          "0001_identity_audit.sql",
          "0002_security_boundary.sql",
          "0003_immutable_content.sql",
        ] as const) {
          await writeFile(
            join(canonical0003Directory, filename),
            await readFile(join(canonicalMigrationDirectory, filename)),
          );
        }
        await resetManagedSchemas();
        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 3,
          discoveredCount: 3,
          previouslyAppliedCount: 0,
        });
        await expectExactClosure(3);
        await expectExactJournal(3);

        await writeFile(
          join(canonical0003Directory, "0004_lifecycle_api_correction.sql"),
          await readFile(
            join(
              canonicalMigrationDirectory,
              "0004_lifecycle_api_correction.sql",
            ),
          ),
        );

        await expect(
          runMigrations(instrumentedPool, canonical0003Directory, []),
        ).rejects.toBeDefined();
        expect(injected).toBe(true);
        expect(exact0004SqlExecutions).toBe(1);
        expect(sequence4JournalAttempts).toBe(1);

        await expectExactClosure(3);
        await expectExactJournal(3);
        const rolledBackDeltas = await ownerPool.query<{
          readonly correction_attribute_count: string;
          readonly correction_select_grant_count: string;
          readonly csrf_helper: string | null;
          readonly new_create_dashboard: string | null;
          readonly old_create_dashboard: string | null;
        }>(`
          SELECT
            pg_catalog.to_regprocedure(
              'dasher_private.context_csrf_allows(smallint,bytea)'
            )::text AS csrf_helper,
            pg_catalog.to_regprocedure(
              'dasher_api.create_dashboard(uuid,text,text,integer,boolean,uuid,uuid,text)'
            )::text AS old_create_dashboard,
            pg_catalog.to_regprocedure(
              'dasher_api.create_dashboard(uuid,text,text,integer,boolean,uuid,uuid,smallint,bytea,text)'
            )::text AS new_create_dashboard,
            (
              SELECT pg_catalog.count(*)::text
              FROM pg_catalog.pg_type AS type_row
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = type_row.typnamespace
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = type_row.typrelid
              WHERE namespace.nspname = 'dasher'
                AND type_row.typname = 'dashboard_creation_result'
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
                AND attribute.attname IN (
                  'lifecycle_policy_seeded',
                  'effective_expires_at'
                )
            ) AS correction_attribute_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(
                COALESCE(
                  relation.relacl,
                  pg_catalog.acldefault('r', relation.relowner)
                )
              ) AS privilege
              JOIN pg_catalog.pg_roles AS grantee
                ON grantee.oid = privilege.grantee
              WHERE namespace.nspname = 'dasher'
                AND relation.relname IN (
                  'dashboard_cleanup_coordination',
                  'dashboard_legal_holds'
                )
                AND grantee.rolname = 'dasher_security_definer'
                AND privilege.privilege_type = 'SELECT'
            ) AS correction_select_grant_count
        `);
        expect(rolledBackDeltas.rows[0]).toEqual({
          correction_attribute_count: "0",
          correction_select_grant_count: "0",
          csrf_helper: null,
          new_create_dashboard: null,
          old_create_dashboard:
            "dasher_api.create_dashboard(uuid,text,text,integer,boolean,uuid,uuid,text)",
        });

        await expect(
          runMigrations(ownerPool, canonical0003Directory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 4,
          previouslyAppliedCount: 3,
        });
        await expectExactClosure(4);
        await expectExactJournal(4);
      } finally {
        await rm(canonical0003Directory, { recursive: true, force: true });
        await resetManagedSchemas();
      }
    },
    120_000,
  );

  it.each(["catalog", "journal"] as const)(
    "rolls back actual 0006 PostgreSQL DDL after an injected post-DDL %s failure and retries exact 0005-to-0006 authority atomically",
    async (failureStage) => {
      const canonical0005Directory = await mkdtemp(
        join(tmpdir(), "dasher-rollback-0006-pg-"),
      );
      const exact0006Sql = await readFile(
        join(
          canonicalMigrationDirectory,
          "0006_lifecycle_access_retention_guard_correction.sql",
        ),
        "utf8",
      );
      const expectedJournal = [
        {
          checksum:
            "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
          filename: "0001_identity_audit.sql",
          sequence: 1,
        },
        {
          checksum:
            "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
          filename: "0002_security_boundary.sql",
          sequence: 2,
        },
        {
          checksum:
            "270ba6f5b8756425835ebb0df0ea8f8c4739b81202d2b4f2b48172a016db9c40",
          filename: "0003_immutable_content.sql",
          sequence: 3,
        },
        {
          checksum:
            "353021e04bd32183cba82e0069948d43fecf27f4b5ec9995bfb143419279e5d9",
          filename: "0004_lifecycle_api_correction.sql",
          sequence: 4,
        },
        {
          checksum:
            "f9e33e7a4033d77c1e56f098de68a519f2cfe434119c3bf5ffe13b8a3f9713e7",
          filename: "0005_security_definer_cleanup_coordination.sql",
          sequence: 5,
        },
        {
          checksum:
            "26a6075696c5aba6562a87f63564860e49b22cdbc1c8015335e19006044bd499",
          filename: "0006_lifecycle_access_retention_guard_correction.sql",
          sequence: 6,
        },
      ] as const;
      let exact0006SqlExecutions = 0;
      let sequence6JournalAttempts = 0;
      let injected = false;

      const expectExactClosure = async (sequence: 5 | 6): Promise<void> => {
        const client = await ownerPool.connect();
        try {
          const ownerName = (
            await client.query<{ readonly owner_name: string }>(
              "SELECT session_user::text AS owner_name",
            )
          ).rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await exactCatalogMatchesForTests(
              client,
              sequence === 5
                ? getCanonical0005ExactCatalogContractForTests(ownerName)
                : getCanonical0006ExactCatalogContractForTests(
                    ownerName,
                    exact0006Sql,
                  ),
              ownerName,
            ),
          ).toBe(true);
          expect(
            sequence === 5
              ? await canonical0005DependencyInventoryMatchesForTests(
                  client,
                  ownerName,
                )
              : await canonical0006DependencyInventoryMatchesForTests(
                  client,
                  ownerName,
                  exact0006Sql,
                ),
          ).toBe(true);
        } finally {
          client.release();
        }
      };

      const expectExactJournal = async (count: 5 | 6): Promise<void> => {
        const journal = await ownerPool.query<{
          readonly checksum: string;
          readonly filename: string;
          readonly sequence: number;
        }>(`
          SELECT
            sequence,
            filename,
            pg_catalog.encode(checksum_sha256, 'hex') AS checksum
          FROM dasher_meta.schema_migrations
          ORDER BY sequence
        `);
        expect(journal.rows).toEqual(expectedJournal.slice(0, count));
      };

      const readPhase6AuthorityState = async () => {
        const columnAcl = await ownerPool.query<{
          readonly count: string;
        }>(`
          SELECT pg_catalog.count(*)::text AS count
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
            AS privilege
          JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          WHERE attribute.attrelid = 'dasher.dashboards'::regclass
            AND attribute.attname = 'head_version_id'
            AND grantee.rolname = 'dasher_retention_definer'
            AND privilege.privilege_type = 'UPDATE'
        `);
        const policies = await ownerPool.query<{
          readonly command: string;
          readonly name: string;
          readonly permissive: boolean;
          readonly relation: string;
          readonly roles: string[];
          readonly usingExpression: string;
          readonly withCheckExpression: string | null;
        }>(`
          SELECT
            relation.relname::text AS relation,
            policy.polname::text AS name,
            policy.polpermissive AS permissive,
            policy.polcmd::text AS command,
            ARRAY(
              SELECT COALESCE(role.rolname::text, 'PUBLIC')
              FROM pg_catalog.unnest(policy.polroles) AS role_oid(oid)
              LEFT JOIN pg_catalog.pg_roles AS role ON role.oid = role_oid.oid
              ORDER BY COALESCE(role.rolname::text, 'PUBLIC')
            ) AS roles,
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
              AS "usingExpression",
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
              AS "withCheckExpression"
          FROM pg_catalog.pg_policy AS policy
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = policy.polrelid
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'dasher'
            AND (
              (relation.relname = 'source_snapshots'
                AND policy.polname IN (
                  'source_snapshots_retention_select',
                  'source_snapshots_retention_delete'
                ))
              OR
              (relation.relname = 'evidence_records'
                AND policy.polname IN (
                  'evidence_records_retention_select',
                  'evidence_records_retention_delete'
                ))
            )
          ORDER BY relation.relname, policy.polname
        `);
        const functions = await ownerPool.query<{
          readonly identityArguments: string;
          readonly name: string;
          readonly schema: string;
          readonly source: string;
        }>(`
          SELECT
            namespace.nspname::text AS schema,
            routine.proname::text AS name,
            pg_catalog.pg_get_function_identity_arguments(routine.oid)
              AS "identityArguments",
            routine.prosrc AS source
          FROM pg_catalog.pg_proc AS routine
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = routine.pronamespace
          WHERE routine.oid IN (
            'dasher_api.get_dashboard_admin_status(uuid)'::regprocedure,
            'dasher_private.enforce_retention_mutation()'::regprocedure
          )
          ORDER BY namespace.nspname, routine.proname
        `);
        return {
          columnAclCount: columnAcl.rows[0]?.count,
          functions: functions.rows,
          policies: policies.rows,
        };
      };

      const instrumentedPool = {
        async connect(): Promise<MigrationClient> {
          const client = await ownerPool.connect();
          const query = (async (text: string, values?: readonly unknown[]) => {
            if (
              text.includes(
                "GRANT UPDATE (head_version_id) ON TABLE dasher.dashboards",
              )
            ) {
              const result = await client.query(
                text,
                values as unknown[] | undefined,
              );
              exact0006SqlExecutions += 1;
              return result;
            }
            if (
              text.includes("INSERT INTO dasher_meta.schema_migrations") &&
              values?.[0] === 6
            ) {
              sequence6JournalAttempts += 1;
              if (failureStage === "journal") {
                injected = true;
                throw new Error("injected exact 0006 journal failure");
              }
            }
            if (
              failureStage === "catalog" &&
              exact0006SqlExecutions === 1 &&
              text.includes("signature_catalog AS (") &&
              typeof values?.[0] === "string" &&
              values[0].includes("snapshot|expected_claim_set=empty")
            ) {
              injected = true;
              return { rows: [{ matches: false }] };
            }
            return client.query(text, values as unknown[] | undefined);
          }) as MigrationClient["query"];
          return {
            query,
            release(error) {
              client.release(error);
            },
          };
        },
      };

      try {
        for (const filename of [
          "0001_identity_audit.sql",
          "0002_security_boundary.sql",
          "0003_immutable_content.sql",
          "0004_lifecycle_api_correction.sql",
          "0005_security_definer_cleanup_coordination.sql",
        ] as const) {
          await writeFile(
            join(canonical0005Directory, filename),
            await readFile(join(canonicalMigrationDirectory, filename)),
          );
        }
        await resetManagedSchemas();
        await expect(
          runMigrations(ownerPool, canonical0005Directory, []),
        ).resolves.toEqual({
          appliedCount: 5,
          discoveredCount: 5,
          previouslyAppliedCount: 0,
        });
        await expectExactClosure(5);
        await expectExactJournal(5);
        const phase5AuthorityState = await readPhase6AuthorityState();
        expect(phase5AuthorityState.columnAclCount).toBe("0");
        expect(
          phase5AuthorityState.policies.map(
            (policy) => `${policy.relation}.${policy.name}`,
          ),
        ).toEqual([
          "evidence_records.evidence_records_retention_delete",
          "evidence_records.evidence_records_retention_select",
          "source_snapshots.source_snapshots_retention_delete",
          "source_snapshots.source_snapshots_retention_select",
        ]);
        expect(
          phase5AuthorityState.functions.map(
            (routine) =>
              `${routine.schema}.${routine.name}(${routine.identityArguments})`,
          ),
        ).toEqual([
          "dasher_api.get_dashboard_admin_status(uuid)",
          "dasher_private.enforce_retention_mutation()",
        ]);

        await writeFile(
          join(
            canonical0005Directory,
            "0006_lifecycle_access_retention_guard_correction.sql",
          ),
          exact0006Sql,
        );

        await expect(
          runMigrations(instrumentedPool, canonical0005Directory, []),
        ).rejects.toBeDefined();
        expect(injected).toBe(true);
        expect(exact0006SqlExecutions).toBe(1);
        expect(sequence6JournalAttempts).toBe(1);

        await expectExactClosure(5);
        await expectExactJournal(5);
        expect(await readPhase6AuthorityState()).toEqual(phase5AuthorityState);

        await expect(
          runMigrations(ownerPool, canonical0005Directory, []),
        ).resolves.toEqual({
          appliedCount: 1,
          discoveredCount: 6,
          previouslyAppliedCount: 5,
        });
        await expectExactClosure(6);
        await expectExactJournal(6);
        const phase6AuthorityState = await readPhase6AuthorityState();
        expect(phase6AuthorityState.columnAclCount).toBe("1");
        expect(phase6AuthorityState.policies).toHaveLength(4);
        expect(phase6AuthorityState.functions).toHaveLength(2);
        for (const [index, policy] of phase6AuthorityState.policies.entries()) {
          expect(policy.usingExpression).not.toBe(
            phase5AuthorityState.policies[index]?.usingExpression,
          );
        }
        for (const [
          index,
          routine,
        ] of phase6AuthorityState.functions.entries()) {
          expect(routine.source).not.toBe(
            phase5AuthorityState.functions[index]?.source,
          );
        }
      } finally {
        await rm(canonical0005Directory, { recursive: true, force: true });
        await resetManagedSchemas();
      }
    },
    120_000,
  );

  it("serializes concurrent fresh-8 and exact 4-to-8 runners through the session gate", async () => {
    const canonical0004Directory = await mkdtemp(
      join(tmpdir(), "dasher-concurrent-0004-pg-"),
    );
    try {
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
        "0003_immutable_content.sql",
        "0004_lifecycle_api_correction.sql",
      ] as const) {
        await writeFile(
          join(canonical0004Directory, filename),
          await readFile(join(canonicalMigrationDirectory, filename)),
        );
      }

      await resetManagedSchemas();
      const fresh = await Promise.all([
        runMigrations(ownerPool, canonicalMigrationDirectory, []),
        runMigrations(ownerPool, canonicalMigrationDirectory, []),
      ]);
      expect(
        fresh
          .map((result) => [result.previouslyAppliedCount, result.appliedCount])
          .sort((left, right) => left[0]! - right[0]!),
      ).toEqual([
        [0, 8],
        [8, 0],
      ]);

      await resetManagedSchemas();
      await runMigrations(ownerPool, canonical0004Directory, []);
      const upgrades = await Promise.all([
        runMigrations(ownerPool, canonicalMigrationDirectory, []),
        runMigrations(ownerPool, canonicalMigrationDirectory, []),
      ]);
      expect(
        upgrades
          .map((result) => [result.previouslyAppliedCount, result.appliedCount])
          .sort((left, right) => left[0]! - right[0]!),
      ).toEqual([
        [4, 4],
        [8, 0],
      ]);
    } finally {
      await rm(canonical0004Directory, { recursive: true, force: true });
      await resetManagedSchemas();
    }
  }, 120_000);

  it.each(["SQL", "catalog", "ACL", "journal"] as const)(
    "rolls back injected canonical %s failure to exact 0002 plus the dependency-free prepared pair",
    async (failureStage) => {
      let injected = false;
      const instrumentedPool = {
        async connect(): Promise<MigrationClient> {
          const client = await ownerPool.connect();
          const query = (async (text: string, values?: readonly unknown[]) => {
            if (
              !injected &&
              failureStage === "SQL" &&
              text.includes(
                "-- Dasher immutable-content and lifecycle successor.",
              )
            ) {
              injected = true;
              throw new Error("injected canonical SQL failure");
            }
            if (
              !injected &&
              failureStage === "journal" &&
              text.includes("INSERT INTO dasher_meta.schema_migrations") &&
              values?.[0] === 3
            ) {
              injected = true;
              throw new Error("injected canonical journal failure");
            }
            if (
              !injected &&
              failureStage === "catalog" &&
              text.includes("signature_catalog AS (") &&
              typeof values?.[0] === "string"
            ) {
              const expected = JSON.parse(values[0]) as {
                readonly relations?: readonly string[];
              };
              if (expected.relations?.length === 32) {
                injected = true;
                return { rows: [{ matches: false }] };
              }
            }
            if (
              !injected &&
              failureStage === "ACL" &&
              text.includes("target_roles AS (") &&
              typeof values?.[1] === "string"
            ) {
              const expected = JSON.parse(values[1]) as readonly {
                readonly object_name?: string;
                readonly role_name?: string;
              }[];
              if (
                expected.some(
                  (entry) =>
                    entry.role_name === "dasher_retention_definer" &&
                    entry.object_name === "dasher_retention_api",
                )
              ) {
                injected = true;
                return { rows: [{ matches: false }] };
              }
            }
            return client.query(text, values as unknown[] | undefined);
          }) as MigrationClient["query"];
          return {
            query,
            release(error) {
              client.release(error);
            },
          };
        },
      };

      try {
        await resetManagedSchemas();
        await expect(
          runMigrations(ownerPool, canonical0002MigrationDirectory, []),
        ).resolves.toEqual({
          appliedCount: 2,
          discoveredCount: 2,
          previouslyAppliedCount: 0,
        });
        await expect(
          runMigrations(instrumentedPool, canonicalMigrationDirectory, []),
        ).rejects.toBeDefined();
        expect(injected).toBe(true);

        const residue = await ownerPool.query<{
          readonly dependency_count: string;
          readonly journal_count: string;
          readonly successor_relation: string | null;
        }>(`
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher_meta.schema_migrations
            ) AS journal_count,
            pg_catalog.to_regclass('dasher.dashboards')::text
              AS successor_relation,
            (
              SELECT pg_catalog.count(*)::text
              FROM pg_catalog.pg_shdepend AS dependency
              JOIN pg_catalog.pg_roles AS role
                ON role.oid = dependency.refobjid
              WHERE role.rolname IN (
                'dasher_retention_definer',
                'dasher_retention_operator'
              )
                AND dependency.refclassid =
                  'pg_catalog.pg_authid'::regclass
                AND dependency.deptype IN ('a', 'o', 'r')
            ) AS dependency_count
        `);
        expect(residue.rows[0]).toEqual({
          dependency_count: "0",
          journal_count: "2",
          successor_relation: null,
        });

        const client = await ownerPool.connect();
        try {
          const owner = await client.query<{ readonly owner_name: string }>(
            "SELECT session_user::text AS owner_name",
          );
          const ownerName = owner.rows[0]?.owner_name;
          if (ownerName === undefined) {
            throw new Error("PostgreSQL did not return the session owner");
          }
          expect(
            await exactCatalogMatchesForTests(
              client,
              getCanonical0002ExactCatalogContractForTests(ownerName),
              ownerName,
            ),
          ).toBe(true);
        } finally {
          client.release();
        }

        await expect(
          runMigrations(ownerPool, canonicalMigrationDirectory, []),
        ).resolves.toEqual({
          appliedCount: 6,
          discoveredCount: 8,
          previouslyAppliedCount: 2,
        });
      } finally {
        await resetManagedSchemas();
      }
    },
    120_000,
  );

  it("rejects modeled 0003 before bootstrap, retry SQL, or reset DDL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dasher-task-8a-pg-"));
    const modeledFixture = new URL(
      "./fixtures/migrations-0003-allowlist/modeled-successor/0003_immutable_content.sql",
      import.meta.url,
    );
    let injectCanonicalSqlFailure = false;
    let modeledSqlExecutions = 0;
    let preparedRoleDdlCount = 0;
    let sequence3JournalInsertions = 0;
    let dropRoleStatements = 0;
    const instrumentedPool = {
      async connect(): Promise<MigrationClient> {
        const client = await ownerPool.connect();
        const query = (async (text: string, values?: readonly unknown[]) => {
          if (text.trim().startsWith("CREATE ROLE dasher_retention_")) {
            preparedRoleDdlCount += 1;
          }
          if (text.includes("modeled_successor_inventory_version")) {
            modeledSqlExecutions += 1;
          }
          if (
            text.includes("INSERT INTO dasher_meta.schema_migrations") &&
            values?.[0] === 3
          ) {
            sequence3JournalInsertions += 1;
          }
          if (text.trim().startsWith("DROP ROLE dasher_retention_")) {
            dropRoleStatements += 1;
          }
          if (
            injectCanonicalSqlFailure &&
            text.includes(
              "-- Dasher immutable-content and lifecycle successor.",
            )
          ) {
            injectCanonicalSqlFailure = false;
            throw new Error("injected canonical SQL failure");
          }
          return client.query(text, values as unknown[] | undefined);
        }) as MigrationClient["query"];
        return {
          query,
          release(error) {
            client.release(error);
          },
        };
      },
    };

    try {
      await resetManagedSchemas();
      await runMigrations(ownerPool, canonical0002MigrationDirectory, []);
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
      ] as const) {
        await writeFile(
          join(directory, filename),
          await readFile(join(canonical0002MigrationDirectory, filename)),
        );
      }
      await writeFile(
        join(directory, "0003_immutable_content.sql"),
        await readFile(modeledFixture),
      );

      await expectMigrationRejection(
        runMigrations(instrumentedPool, directory, []),
        "migration_file_mismatch",
      );
      expect(preparedRoleDdlCount).toBe(0);
      expect(modeledSqlExecutions).toBe(0);
      expect(sequence3JournalInsertions).toBe(0);

      const rolledBackModeledState = await ownerPool.query<{
        readonly journal_count: string;
        readonly probe_relation: string | null;
      }>(`
        SELECT
          pg_catalog.to_regclass(
            'dasher.modeled_successor_inventory_probe'
          )::text AS probe_relation,
          (
            SELECT pg_catalog.count(*)::text
            FROM dasher_meta.schema_migrations
          ) AS journal_count
      `);
      expect(rolledBackModeledState.rows[0]).toEqual({
        journal_count: "2",
        probe_relation: null,
      });

      const pure0002Roles = await ownerPool.query<{
        readonly count: string;
      }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname IN (
          'dasher_retention_definer',
          'dasher_retention_operator'
        )
      `);
      expect(pure0002Roles.rows[0]?.count).toBe("0");

      injectCanonicalSqlFailure = true;
      await expect(
        runMigrations(instrumentedPool, canonicalMigrationDirectory, []),
      ).rejects.toThrow("injected canonical SQL failure");
      expect(injectCanonicalSqlFailure).toBe(false);
      expect(preparedRoleDdlCount).toBe(2);
      expect(sequence3JournalInsertions).toBe(0);

      await expectMigrationRejection(
        runMigrations(instrumentedPool, directory, []),
        "migration_file_mismatch",
      );
      expect(preparedRoleDdlCount).toBe(2);
      expect(modeledSqlExecutions).toBe(0);
      expect(sequence3JournalInsertions).toBe(0);

      await expectMigrationRejection(
        resetPreparedRetentionRoles(instrumentedPool, directory, []),
        "migration_file_mismatch",
      );
      expect(dropRoleStatements).toBe(0);

      const prepared = await ownerPool.query<{
        readonly attributes_match: boolean;
        readonly comment: string | null;
        readonly dependency_count: string;
        readonly membership_count: string;
        readonly role_name: string;
      }>(`
        SELECT
          role.rolname::text AS role_name,
          NOT role.rolcanlogin
            AND NOT role.rolinherit
            AND NOT role.rolsuper
            AND NOT role.rolcreatedb
            AND NOT role.rolcreaterole
            AND NOT role.rolreplication
            AND NOT role.rolbypassrls
            AND role.rolpassword IS NULL
            AND role.rolconnlimit = -1
            AND role.rolvaliduntil = 'infinity'::timestamptz
            AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_db_role_setting AS setting
              WHERE setting.setrole = role.oid
            ) AS attributes_match,
          pg_catalog.shobj_description(role.oid, 'pg_authid') AS comment,
          (
            SELECT pg_catalog.count(*)::text
            FROM pg_catalog.pg_auth_members AS membership
            WHERE membership.roleid = role.oid
               OR membership.member = role.oid
          ) AS membership_count,
          (
            SELECT pg_catalog.count(*)::text
            FROM pg_catalog.pg_shdepend AS dependency
            WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
              AND dependency.refobjid = role.oid
              AND dependency.deptype IN ('a', 'o', 'r')
          ) AS dependency_count
        FROM pg_catalog.pg_authid AS role
        WHERE role.rolname IN (
          'dasher_retention_definer',
          'dasher_retention_operator'
        )
        ORDER BY role.rolname
      `);
      expect(prepared.rows).toEqual([
        {
          attributes_match: true,
          comment: "dasher:managed-role:v1:retention-definer",
          dependency_count: "0",
          membership_count: "0",
          role_name: "dasher_retention_definer",
        },
        {
          attributes_match: true,
          comment: "dasher:managed-role:v1:retention-operator",
          dependency_count: "0",
          membership_count: "0",
          role_name: "dasher_retention_operator",
        },
      ]);

      const contaminationCases = [
        {
          name: "membership",
          contaminate: () =>
            ownerPool.query(
              "GRANT dasher_retention_definer TO dasher_retention_operator",
            ),
          cleanup: () =>
            ownerPool.query(
              "REVOKE dasher_retention_definer FROM dasher_retention_operator",
            ),
        },
        {
          name: "ownership",
          contaminate: () =>
            ownerPool.query(
              "CREATE SCHEMA fixture_role_owned AUTHORIZATION dasher_retention_definer",
            ),
          cleanup: () => ownerPool.query("DROP SCHEMA fixture_role_owned"),
        },
        {
          name: "ACL",
          contaminate: () =>
            ownerPool.query(
              "GRANT SELECT ON dasher.organizations TO dasher_retention_definer",
            ),
          cleanup: () =>
            ownerPool.query(
              "REVOKE SELECT ON dasher.organizations FROM dasher_retention_definer",
            ),
        },
        {
          name: "policy",
          contaminate: () =>
            ownerPool.query(`
              CREATE POLICY task8a_prepared_dependency_policy
              ON dasher.organizations
              FOR SELECT
              TO dasher_retention_definer
              USING (false)
            `),
          cleanup: () =>
            ownerPool.query(
              "DROP POLICY task8a_prepared_dependency_policy ON dasher.organizations",
            ),
        },
      ] as const;

      for (const contamination of contaminationCases) {
        await contamination.contaminate();
        let dropRoleStatements = 0;
        const resetProbePool = {
          async connect(): Promise<MigrationClient> {
            const client = await ownerPool.connect();
            const query = (async (
              text: string,
              values?: readonly unknown[],
            ) => {
              if (text.trim().startsWith("DROP ROLE ")) {
                dropRoleStatements += 1;
              }
              return client.query(text, values as unknown[] | undefined);
            }) as MigrationClient["query"];
            return {
              query,
              release(error) {
                client.release(error);
              },
            };
          },
        };
        try {
          await expectMigrationRejection(
            resetPreparedRetentionRoles(
              resetProbePool,
              canonical0002MigrationDirectory,
              [],
            ),
            "managed_role_drift",
          );
          expect(dropRoleStatements, contamination.name).toBe(0);
        } finally {
          await contamination.cleanup();
        }
      }

      await resetPreparedRetentionRoles(
        ownerPool,
        canonical0002MigrationDirectory,
        [],
      );
      const residue = await ownerPool.query<{ readonly count: string }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname IN (
          'dasher_retention_definer',
          'dasher_retention_operator'
        )
      `);
      expect(residue.rows[0]?.count).toBe("0");
    } finally {
      const preparedCount = await ownerPool.query<{ readonly count: string }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname IN (
          'dasher_retention_definer',
          'dasher_retention_operator'
        )
      `);
      if (preparedCount.rows[0]?.count === "2") {
        await resetPreparedRetentionRoles(
          ownerPool,
          canonical0002MigrationDirectory,
          [],
        );
      }
      await rm(directory, { recursive: true, force: true });
      await resetManagedSchemas();
    }
  }, 120_000);

  async function proveSoleVariadicCatalogDelta(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "dasher-task-8a-variadic-"));
    const probeIdentity = "dasher_private.task8a_variadic_probe(text[])";
    const probeSource = "SELECT pg_catalog.cardinality($1)";
    let probeCreated = false;

    try {
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
      ] as const) {
        await writeFile(
          join(directory, filename),
          await readFile(join(canonical0002MigrationDirectory, filename)),
        );
      }
      await writeFile(
        join(directory, "0003_immutable_content.sql"),
        await readFile(
          join(canonicalMigrationDirectory, "0003_immutable_content.sql"),
        ),
      );

      await resetManagedSchemas();
      await runMigrations(ownerPool, canonical0002MigrationDirectory, []);
      const owner = await ownerPool.query<{ readonly owner_name: string }>(
        "SELECT session_user::text AS owner_name",
      );
      const ownerName = owner.rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("PostgreSQL did not return the session owner");
      }

      await ownerPool.query(`
        CREATE FUNCTION dasher_private.task8a_variadic_probe(text[])
        RETURNS integer
        LANGUAGE sql
        STABLE
        SET search_path = pg_catalog
        AS 'SELECT pg_catalog.cardinality($1)';
        REVOKE ALL ON FUNCTION
          dasher_private.task8a_variadic_probe(text[]) FROM PUBLIC
      `);
      probeCreated = true;

      type ExactCatalog = Record<string, readonly string[]> & {
        readonly acls: readonly string[];
        readonly functions: readonly string[];
      };
      const canonicalExpected = getCanonical0002ExactCatalogContractForTests(
        ownerName,
      ) as ExactCatalog;
      const baselineFunctionSignature =
        `${probeIdentity}|f|integer|sql|s|false|false|false|false|u|<none>|0|<none>|${ownerName}|{search_path=pg_catalog}|` +
        createHash("md5").update(probeSource).digest("hex");
      const baselineAclSignature = `function|${probeIdentity}|${ownerName}|${ownerName}|EXECUTE|false`;
      const withProbeBaseline: ExactCatalog = {
        ...canonicalExpected,
        functions: [
          ...canonicalExpected.functions,
          baselineFunctionSignature,
        ].sort(),
        acls: [...canonicalExpected.acls, baselineAclSignature].sort(),
      };

      const comparisonClient = await ownerPool.connect();
      try {
        expect(
          await exactCatalogMatchesForTests(
            comparisonClient,
            withProbeBaseline,
            ownerName,
          ),
        ).toBe(true);
      } finally {
        comparisonClient.release();
      }

      const before = await ownerPool.query<{
        readonly compared_identity: string;
        readonly function_oid: string;
        readonly source_md5: string;
        readonly variadic_type: string | null;
      }>(
        `
        SELECT routine.oid::text AS function_oid,
          pg_catalog.oidvectortypes(routine.proargtypes) AS compared_identity,
          pg_catalog.md5(routine.prosrc) AS source_md5,
          pg_catalog.format_type(NULLIF(routine.provariadic, 0), NULL)
            AS variadic_type
        FROM pg_catalog.pg_proc AS routine
        WHERE routine.oid = $1::regprocedure
      `,
        [probeIdentity],
      );
      expect(before.rows[0]).toEqual({
        compared_identity: "text[]",
        function_oid: expect.any(String),
        source_md5: createHash("md5").update(probeSource).digest("hex"),
        variadic_type: null,
      });

      await ownerPool.query(`
        CREATE OR REPLACE FUNCTION
          dasher_private.task8a_variadic_probe(VARIADIC text[])
        RETURNS integer
        LANGUAGE sql
        STABLE
        SET search_path = pg_catalog
        AS 'SELECT pg_catalog.cardinality($1)'
      `);
      const after = await ownerPool.query<{
        readonly compared_identity: string;
        readonly function_oid: string;
        readonly source_md5: string;
        readonly variadic_type: string | null;
      }>(
        `
        SELECT routine.oid::text AS function_oid,
          pg_catalog.oidvectortypes(routine.proargtypes) AS compared_identity,
          pg_catalog.md5(routine.prosrc) AS source_md5,
          pg_catalog.format_type(NULLIF(routine.provariadic, 0), NULL)
            AS variadic_type
        FROM pg_catalog.pg_proc AS routine
        WHERE routine.oid = $1::regprocedure
      `,
        [probeIdentity],
      );
      expect(after.rows[0]).toEqual({
        ...before.rows[0],
        variadic_type: "text",
      });

      const afterClient = await ownerPool.connect();
      try {
        expect(
          await exactCatalogMatchesForTests(
            afterClient,
            withProbeBaseline,
            ownerName,
          ),
        ).toBe(false);
        const provariadicBlindMutant: ExactCatalog = {
          ...withProbeBaseline,
          functions: withProbeBaseline.functions.map((signature) =>
            signature === baselineFunctionSignature
              ? signature.replace("|u|<none>|0|", "|u|text|0|")
              : signature,
          ),
        };
        expect(provariadicBlindMutant.functions).not.toEqual(
          withProbeBaseline.functions,
        );
        expect(
          await exactCatalogMatchesForTests(
            afterClient,
            provariadicBlindMutant,
            ownerName,
          ),
        ).toBe(true);
      } finally {
        afterClient.release();
      }

      let exactComparisonCount = 0;
      let preparedRoleDdlCount = 0;
      let successorSqlCount = 0;
      const instrumentedPool = {
        async connect(): Promise<MigrationClient> {
          const client = await ownerPool.connect();
          const query = (async (text: string, values?: readonly unknown[]) => {
            if (text.includes("signature_catalog AS")) {
              exactComparisonCount += 1;
              const runnerExpected = JSON.parse(
                String(values?.[0]),
              ) as ExactCatalog;
              expect(runnerExpected.functions).not.toContain(
                baselineFunctionSignature,
              );
              return client.query(text, [
                JSON.stringify(withProbeBaseline),
                values?.[1],
              ]);
            }
            if (text.trim().startsWith("CREATE ROLE dasher_retention_")) {
              preparedRoleDdlCount += 1;
            }
            if (
              text.includes(
                "-- Dasher immutable-content and lifecycle successor.",
              )
            ) {
              successorSqlCount += 1;
            }
            return client.query(text, values as unknown[] | undefined);
          }) as MigrationClient["query"];
          return {
            query,
            release(error) {
              client.release(error);
            },
          };
        },
      };
      await expectMigrationRejection(
        runMigrations(instrumentedPool, directory, []),
        "managed_role_drift",
      );
      expect(exactComparisonCount).toBe(1);
      expect(preparedRoleDdlCount).toBe(0);
      expect(successorSqlCount).toBe(0);
      const preparedRoleResidue = await ownerPool.query<{
        readonly count: string;
      }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname IN (
          'dasher_retention_definer',
          'dasher_retention_operator'
        )
      `);
      expect(preparedRoleResidue.rows[0]?.count).toBe("0");
    } finally {
      if (probeCreated) {
        await ownerPool.query(
          "DROP FUNCTION IF EXISTS dasher_private.task8a_variadic_probe(text[])",
        );
        const residue = await ownerPool.query<{
          readonly identity: string | null;
        }>(
          "SELECT pg_catalog.to_regprocedure('dasher_private.task8a_variadic_probe(text[])')::text AS identity",
        );
        expect(residue.rows[0]?.identity).toBeNull();
      }
      await rm(directory, { recursive: true, force: true });
      await resetManagedSchemas();
    }
  }

  it("rejects representative catalog and grantability drift before prepared-role or successor SQL side effects", async () => {
    await proveSoleVariadicCatalogDelta();
    const directory = await mkdtemp(join(tmpdir(), "dasher-task-8a-drift-"));
    let originalDatabaseComment: string | null | undefined;
    const driftCases: readonly {
      readonly apply?: () => Promise<void>;
      readonly cleanup?: () => Promise<void>;
      readonly name: string;
      readonly sql?: string;
    }[] = [
      {
        name: "extra index",
        sql: "CREATE INDEX task8a_extra_index ON dasher.users (created_at)",
      },
      {
        name: "same-name INCLUDE shape",
        sql: `
          DROP INDEX dasher.invitations_creator_idx;
          CREATE INDEX invitations_creator_idx
            ON dasher.invitations (organization_id, created_by_user_id)
            INCLUDE (created_at)
        `,
      },
      {
        name: "column collation",
        sql: `
          ALTER TABLE dasher.organizations
          ALTER COLUMN display_name
          TYPE varchar(200) COLLATE "C"
        `,
      },
      {
        name: "index collation",
        sql: `
          DROP INDEX dasher.invitations_email_created_idx;
          CREATE INDEX invitations_email_created_idx
            ON dasher.invitations (
              organization_id,
              normalized_email COLLATE "C",
              created_at DESC
            )
        `,
      },
      {
        name: "same-index clustered state",
        apply: async () => {
          const before = await ownerPool.query<{
            readonly identity: string;
          }>(`
            SELECT namespace.nspname || '.' || index_relation.relname AS identity
            FROM pg_catalog.pg_index AS index_row
            JOIN pg_catalog.pg_class AS index_relation
              ON index_relation.oid = index_row.indexrelid
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = index_relation.relnamespace
            WHERE namespace.nspname LIKE 'dasher%'
              AND index_row.indisclustered
            ORDER BY identity
          `);
          expect(before.rows).toEqual([]);
          await ownerPool.query(
            "ALTER TABLE dasher.invitations CLUSTER ON invitations_creator_idx",
          );
          const after = await ownerPool.query<{
            readonly identity: string;
          }>(`
            SELECT namespace.nspname || '.' || index_relation.relname AS identity
            FROM pg_catalog.pg_index AS index_row
            JOIN pg_catalog.pg_class AS index_relation
              ON index_relation.oid = index_row.indexrelid
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = index_relation.relnamespace
            WHERE namespace.nspname LIKE 'dasher%'
              AND index_row.indisclustered
            ORDER BY identity
          `);
          expect(after.rows).toEqual([
            { identity: "dasher.invitations_creator_idx" },
          ]);
        },
        cleanup: async () => {
          await ownerPool.query(
            "ALTER TABLE dasher.invitations SET WITHOUT CLUSTER",
          );
          const reset = await ownerPool.query<{ readonly count: string }>(`
            SELECT pg_catalog.count(*)::text AS count
            FROM pg_catalog.pg_index AS index_row
            JOIN pg_catalog.pg_class AS index_relation
              ON index_relation.oid = index_row.indexrelid
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = index_relation.relnamespace
            WHERE namespace.nspname LIKE 'dasher%'
              AND index_row.indisclustered
          `);
          expect(reset.rows[0]?.count).toBe("0");
        },
      },
      {
        name: "trailing function default",
        apply: async () => {
          const before = await ownerPool.query<{
            readonly default_count: number;
            readonly definition: string;
            readonly function_oid: string;
          }>(`
            SELECT routine.oid::text AS function_oid,
              routine.pronargdefaults AS default_count,
              pg_catalog.pg_get_functiondef(routine.oid) AS definition
            FROM pg_catalog.pg_proc AS routine
            WHERE routine.oid = 'dasher_private.context_allows(uuid, text)'::regprocedure
          `);
          const original = before.rows[0];
          expect(original?.default_count).toBe(0);
          const changedDefinition = original?.definition.replace(
            /p_required_role text(?=\s*\))/u,
            "p_required_role text DEFAULT 'viewer'::text",
          );
          expect(changedDefinition).toBeDefined();
          expect(changedDefinition).not.toBe(original?.definition);
          await ownerPool.query(changedDefinition ?? "");
          const after = await ownerPool.query<{
            readonly default_count: number;
            readonly default_expression: string;
            readonly function_oid: string;
          }>(`
            SELECT routine.oid::text AS function_oid,
              routine.pronargdefaults AS default_count,
              pg_catalog.pg_get_expr(
                routine.proargdefaults,
                0,
                false
              ) AS default_expression
            FROM pg_catalog.pg_proc AS routine
            WHERE routine.oid = 'dasher_private.context_allows(uuid, text)'::regprocedure
          `);
          expect(after.rows[0]).toEqual({
            default_count: 1,
            default_expression: "'viewer'::text",
            function_oid: original?.function_oid,
          });
        },
      },
      {
        name: "column comment",
        sql: "COMMENT ON COLUMN dasher.users.user_id IS 'task8a-column-drift'",
        cleanup: () =>
          ownerPool
            .query("COMMENT ON COLUMN dasher.users.user_id IS NULL")
            .then(() => undefined),
      },
      {
        name: "constraint comment",
        sql: "COMMENT ON CONSTRAINT users_pkey ON dasher.users IS 'task8a-constraint-drift'",
        cleanup: () =>
          ownerPool
            .query("COMMENT ON CONSTRAINT users_pkey ON dasher.users IS NULL")
            .then(() => undefined),
      },
      {
        name: "trigger comment",
        sql: "COMMENT ON TRIGGER audit_events_immutable ON dasher.audit_events IS 'task8a-trigger-drift'",
        cleanup: () =>
          ownerPool
            .query(
              "COMMENT ON TRIGGER audit_events_immutable ON dasher.audit_events IS NULL",
            )
            .then(() => undefined),
      },
      {
        name: "policy comment",
        sql: "COMMENT ON POLICY organizations_select ON dasher.organizations IS 'task8a-policy-drift'",
        cleanup: () =>
          ownerPool
            .query(
              "COMMENT ON POLICY organizations_select ON dasher.organizations IS NULL",
            )
            .then(() => undefined),
      },
      {
        name: "database comment",
        apply: async () => {
          const client = await ownerPool.connect();
          try {
            const original = await client.query<{
              readonly comment: string | null;
            }>(`
              SELECT pg_catalog.shobj_description(
                database_row.oid,
                'pg_database'
              ) AS comment
              FROM pg_catalog.pg_database AS database_row
              WHERE database_row.datname = pg_catalog.current_database()
            `);
            originalDatabaseComment = original.rows[0]?.comment ?? null;
            await executeServerFormattedSql(
              client,
              "COMMENT ON DATABASE %I IS 'task8a-database-drift'",
              [config.ownerDatabase],
            );
          } finally {
            client.release();
          }
        },
        cleanup: async () => {
          const client = await ownerPool.connect();
          try {
            if (originalDatabaseComment === null) {
              await executeServerFormattedSql(
                client,
                "COMMENT ON DATABASE %I IS NULL",
                [config.ownerDatabase],
              );
            } else if (originalDatabaseComment !== undefined) {
              await executeServerFormattedSql(
                client,
                "COMMENT ON DATABASE %I IS %L",
                [config.ownerDatabase, originalDatabaseComment],
              );
            } else {
              throw new Error("database comment cleanup lacks original value");
            }
            originalDatabaseComment = undefined;
          } finally {
            client.release();
          }
        },
      },
      {
        name: "extra constraint",
        sql: "ALTER TABLE dasher.users ADD CONSTRAINT task8a_extra_check CHECK (user_id IS NOT NULL)",
      },
      {
        name: "extra trigger",
        sql: "CREATE TRIGGER task8a_extra_trigger BEFORE UPDATE ON dasher.users FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_immutable_mutation()",
      },
      {
        name: "third policy",
        sql: "CREATE POLICY task8a_extra_policy ON dasher.organizations FOR SELECT TO dasher_app USING (true)",
      },
      {
        name: "extra type",
        sql: "CREATE TYPE dasher.task8a_extra_type AS ENUM ('extra')",
      },
      {
        name: "extra procedure",
        sql: "CREATE PROCEDURE dasher_private.task8a_extra_procedure() LANGUAGE plpgsql SET search_path = pg_catalog AS 'BEGIN NULL; END'",
      },
      {
        name: "security invoker",
        sql: "ALTER FUNCTION dasher_private.context_user_id() SECURITY INVOKER",
      },
      {
        name: "immutable volatility",
        sql: "ALTER FUNCTION dasher_private.context_user_id() IMMUTABLE",
      },
      {
        name: "missing proconfig",
        sql: "ALTER FUNCTION dasher_private.context_user_id() RESET ALL",
      },
      {
        name: "altered body",
        sql: `
          CREATE OR REPLACE FUNCTION dasher_private.context_user_id()
          RETURNS uuid
          LANGUAGE plpgsql
          STABLE
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS 'BEGIN RETURN NULL; END'
        `,
      },
      {
        name: "grant option",
        sql: "GRANT EXECUTE ON FUNCTION dasher_private.context_user_id() TO dasher_app WITH GRANT OPTION",
      },
      {
        name: "altered result",
        sql: `
          DROP FUNCTION dasher_private.context_user_id() CASCADE;
          CREATE FUNCTION dasher_private.context_user_id()
          RETURNS text
          LANGUAGE plpgsql
          STABLE
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS 'BEGIN RETURN NULL; END';
          ALTER FUNCTION dasher_private.context_user_id()
            OWNER TO dasher_security_definer;
          REVOKE ALL ON FUNCTION dasher_private.context_user_id()
            FROM PUBLIC, dasher_app;
          GRANT EXECUTE ON FUNCTION dasher_private.context_user_id()
            TO dasher_app
        `,
      },
    ] as const;

    try {
      for (const filename of [
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
      ] as const) {
        await writeFile(
          join(directory, filename),
          await readFile(join(canonical0002MigrationDirectory, filename)),
        );
      }
      await writeFile(
        join(directory, "0003_immutable_content.sql"),
        await readFile(
          join(canonicalMigrationDirectory, "0003_immutable_content.sql"),
        ),
      );

      for (const drift of driftCases) {
        await resetManagedSchemas();
        await runMigrations(ownerPool, canonical0002MigrationDirectory, []);
        if (drift.apply !== undefined) {
          await drift.apply();
        } else if (drift.sql !== undefined) {
          await ownerPool.query(drift.sql);
        } else {
          throw new Error(`missing PostgreSQL drift mutation: ${drift.name}`);
        }
        let preparedRoleDdlCount = 0;
        let successorSqlCount = 0;
        const instrumentedPool = {
          async connect(): Promise<MigrationClient> {
            const client = await ownerPool.connect();
            const query = (async (
              text: string,
              values?: readonly unknown[],
            ) => {
              if (text.trim().startsWith("CREATE ROLE dasher_retention_")) {
                preparedRoleDdlCount += 1;
              }
              if (
                text.includes(
                  "-- Dasher immutable-content and lifecycle successor.",
                )
              ) {
                successorSqlCount += 1;
              }
              return client.query(text, values as unknown[] | undefined);
            }) as MigrationClient["query"];
            return {
              query,
              release(error) {
                client.release(error);
              },
            };
          },
        };

        try {
          await expectMigrationRejection(
            runMigrations(instrumentedPool, directory, []),
            "managed_role_drift",
          );
          expect(preparedRoleDdlCount, drift.name).toBe(0);
          expect(successorSqlCount, drift.name).toBe(0);
        } finally {
          await drift.cleanup?.();
        }
      }
    } finally {
      if (originalDatabaseComment !== undefined) {
        const client = await ownerPool.connect();
        try {
          if (originalDatabaseComment === null) {
            await executeServerFormattedSql(
              client,
              "COMMENT ON DATABASE %I IS NULL",
              [config.ownerDatabase],
            );
          } else {
            await executeServerFormattedSql(
              client,
              "COMMENT ON DATABASE %I IS %L",
              [config.ownerDatabase, originalDatabaseComment],
            );
          }
        } finally {
          client.release();
        }
      }
      await rm(directory, { recursive: true, force: true });
      await resetManagedSchemas();
    }
  }, 120_000);

  it("serializes concurrent runners into exactly one apply and one skip", async () => {
    const runnerAPool = new Pool({
      connectionString: config.ownerDsn,
      application_name: "dasher_task8a_runner_a",
      max: 1,
    });
    const runnerBPool = new Pool({
      connectionString: config.ownerDsn,
      application_name: "dasher_task8a_runner_b",
      max: 1,
    });
    let markRunnerAAcquired!: () => void;
    let releaseRunnerA!: () => void;
    const runnerAAcquired = new Promise<void>((resolve) => {
      markRunnerAAcquired = resolve;
    });
    const runnerARelease = new Promise<void>((resolve) => {
      releaseRunnerA = resolve;
    });
    const gatedRunnerAPool = {
      async connect(): Promise<MigrationClient> {
        const client = await runnerAPool.connect();
        const query = (async (text: string, values?: readonly unknown[]) => {
          const result = await client.query(
            text,
            values as unknown[] | undefined,
          );
          if (text.includes("pg_catalog.pg_advisory_lock(")) {
            markRunnerAAcquired();
            await runnerARelease;
          }
          return result;
        }) as MigrationClient["query"];
        return {
          query,
          release(error) {
            client.release(error);
          },
        };
      },
    };

    try {
      const runnerA = runMigrations(
        gatedRunnerAPool,
        fixtureMigrationDirectory,
        [],
      );
      const runnerASettled = runnerA.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await runnerAAcquired;

      const runnerB = runMigrations(runnerBPool, fixtureMigrationDirectory, []);
      const runnerBSettled = runnerB.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );

      let observedWaiter = false;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const state = await ownerPool.query<{ readonly waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_stat_activity AS activity
            JOIN pg_catalog.pg_locks AS lock_row ON lock_row.pid = activity.pid
            WHERE activity.application_name = 'dasher_task8a_runner_b'
              AND lock_row.locktype = 'advisory'
              AND NOT lock_row.granted
              AND activity.wait_event_type = 'Lock'
          ) AS waiting
        `);
        if (state.rows[0]?.waiting === true) {
          observedWaiter = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(observedWaiter).toBe(true);
      releaseRunnerA();

      const settled = await Promise.all([runnerASettled, runnerBSettled]);
      expect(settled.map((entry) => entry.error)).toEqual([
        undefined,
        undefined,
      ]);
      const results = settled.map((entry) => entry.value!);

      expect(results.map((result) => result.appliedCount).sort()).toEqual([
        0, 2,
      ]);
      expect(
        results.map((result) => result.previouslyAppliedCount).sort(),
      ).toEqual([0, 2]);

      const journal = await ownerPool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM dasher_meta.schema_migrations",
      );
      expect(journal.rows[0]?.count).toBe("2");
    } finally {
      releaseRunnerA();
      await Promise.allSettled([runnerAPool.end(), runnerBPool.end()]);
      await resetManagedSchemas();
    }
  });

  it("executes self-bound initialization and both initializer/writer gate winner orders", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const normalPrincipalId = "80000000-0000-4000-8000-000000000001";

    try {
      const relation = await harness.owner.query<{
        readonly force_row_security: boolean;
        readonly row_security: boolean;
      }>(
        `
          SELECT relation.relrowsecurity AS row_security,
            relation.relforcerowsecurity AS force_row_security
          FROM pg_catalog.pg_class AS relation
          WHERE relation.oid =
            'task8a_retention_barrier.authority_revisions'::regclass
        `,
      );
      expect(relation.rows[0]).toEqual({
        force_row_security: true,
        row_security: true,
      });

      const policy = await harness.owner.query<{
        readonly command: string;
        readonly name: string;
        readonly permissive: boolean;
        readonly roles: string[];
        readonly using_expression: string;
        readonly with_check_expression: string | null;
      }>(`
        SELECT policy.polname AS name,
          policy.polcmd AS command,
          policy.polpermissive AS permissive,
          ARRAY(
            SELECT role.rolname
            FROM pg_catalog.unnest(policy.polroles) AS policy_role(role_oid)
            JOIN pg_catalog.pg_roles AS role
              ON role.oid = policy_role.role_oid
            ORDER BY role.rolname
          )::text[] AS roles,
          pg_catalog.pg_get_expr(
            policy.polqual,
            policy.polrelid,
            true
          ) AS using_expression,
          pg_catalog.pg_get_expr(
            policy.polwithcheck,
            policy.polrelid,
            true
          ) AS with_check_expression
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'task8a_retention_barrier.authority_revisions'::regclass
      `);
      expect(policy.rows).toHaveLength(1);
      expect(policy.rows[0]).toMatchObject({
        command: "r",
        name: "authority_revisions_self_binding_select",
        permissive: true,
        roles: [task8aHarnessDefinerRole],
        with_check_expression: null,
      });
      const normalizedPolicy = policy.rows[0]?.using_expression.replace(
        /\s+/gu,
        " ",
      );
      expect(normalizedPolicy).toContain(
        "CURRENT_USER = 'task8a_retention_harness_definer'::name",
      );
      expect(normalizedPolicy).toContain("binding_subject = SESSION_USER");

      const roles = await harness.owner.query<{
        readonly bypass_rls: boolean;
        readonly inherit: boolean;
        readonly login: boolean;
        readonly name: string;
        readonly superuser: boolean;
      }>(
        `
          SELECT role.rolname AS name,
            role.rolcanlogin AS login,
            role.rolinherit AS inherit,
            role.rolsuper AS superuser,
            role.rolbypassrls AS bypass_rls
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = ANY($1::text[])
          ORDER BY role.rolname
        `,
        [
          [
            task8aHarnessDefinerRole,
            task8aSecurityHarnessDefinerRole,
            task8aHarnessSubjectA,
            task8aHarnessSubjectB,
          ],
        ],
      );
      expect(roles.rows).toEqual(
        [
          task8aHarnessDefinerRole,
          task8aSecurityHarnessDefinerRole,
          task8aHarnessSubjectA,
          task8aHarnessSubjectB,
        ]
          .sort()
          .map((name) => ({
            bypass_rls: name === task8aSecurityHarnessDefinerRole,
            inherit: false,
            login: false,
            name,
            superuser: false,
          })),
      );

      const lockPrivileges = await harness.owner.query<{
        readonly column_update: boolean;
        readonly relation_update: boolean;
        readonly role_name: string;
      }>(
        `
          SELECT expected.role_name,
            pg_catalog.has_column_privilege(
              expected.role_name,
              expected.relation_name,
              'organization_id',
              'UPDATE'
            ) AS column_update,
            pg_catalog.has_table_privilege(
              expected.role_name,
              expected.relation_name,
              'UPDATE'
            ) AS relation_update
          FROM (VALUES
            ($1::name, 'task8a_retention_barrier.security_lock_target'::text),
            ($2::name, 'task8a_retention_barrier.retention_lock_target'::text)
          ) AS expected(role_name, relation_name)
          ORDER BY expected.role_name
        `,
        [task8aSecurityHarnessDefinerRole, task8aHarnessDefinerRole],
      );
      expect(lockPrivileges.rows).toEqual(
        [task8aSecurityHarnessDefinerRole, task8aHarnessDefinerRole]
          .sort()
          .map((roleName) => ({
            column_update: true,
            relation_update: false,
            role_name: roleName,
          })),
      );
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_security_lock_modes()",
        ),
      ).resolves.toBeDefined();
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_retention_lock_modes()",
        ),
      ).resolves.toBeDefined();

      await harness.owner.query(`
        REVOKE UPDATE (organization_id)
          ON task8a_retention_barrier.security_lock_target
          FROM ${task8aSecurityHarnessDefinerRole}
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_security_lock_modes()",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await harness.owner.query(`
        GRANT UPDATE (organization_id)
          ON task8a_retention_barrier.security_lock_target
          TO ${task8aSecurityHarnessDefinerRole}
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_security_lock_modes()",
        ),
      ).resolves.toBeDefined();

      await harness.owner.query(`
        REVOKE UPDATE (organization_id)
          ON task8a_retention_barrier.retention_lock_target
          FROM ${task8aHarnessDefinerRole};
        GRANT UPDATE (organization_id)
          ON task8a_retention_barrier.retention_lock_target
          TO ${task8aHarnessSubjectA}
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_retention_lock_modes()",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await harness.owner.query(`
        REVOKE UPDATE (organization_id)
          ON task8a_retention_barrier.retention_lock_target
          FROM ${task8aHarnessSubjectA};
        GRANT UPDATE (organization_id)
          ON task8a_retention_barrier.retention_lock_target
          TO ${task8aHarnessDefinerRole}
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_retention_lock_modes()",
        ),
      ).resolves.toBeDefined();

      await harness.owner.query(`
        DROP POLICY security_lock_target_security_update
          ON task8a_retention_barrier.security_lock_target
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_security_lock_modes()",
        ),
      ).resolves.toBeDefined();
      await harness.owner.query(`
        CREATE POLICY security_lock_target_security_update
        ON task8a_retention_barrier.security_lock_target
        FOR UPDATE TO ${task8aSecurityHarnessDefinerRole}
        USING (
          CURRENT_USER = '${task8aSecurityHarnessDefinerRole}'::name
          AND organization_id =
            '81000000-0000-4000-8000-000000000001'::uuid
        )
        WITH CHECK (
          CURRENT_USER = '${task8aSecurityHarnessDefinerRole}'::name
          AND organization_id =
            '81000000-0000-4000-8000-000000000001'::uuid
        )
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_security_lock_modes()",
        ),
      ).resolves.toBeDefined();

      await harness.owner.query(`
        DROP POLICY retention_lock_target_retention_update
          ON task8a_retention_barrier.retention_lock_target
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_retention_lock_modes()",
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
      await harness.owner.query(`
        CREATE POLICY retention_lock_target_retention_update
        ON task8a_retention_barrier.retention_lock_target
        FOR UPDATE TO ${task8aHarnessDefinerRole}
        USING (
          CURRENT_USER = '${task8aHarnessDefinerRole}'::name
          AND organization_id =
            '82000000-0000-4000-8000-000000000001'::uuid
        )
        WITH CHECK (
          CURRENT_USER = '${task8aHarnessDefinerRole}'::name
          AND organization_id =
            '82000000-0000-4000-8000-000000000001'::uuid
        )
      `);
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.exercise_retention_lock_modes()",
        ),
      ).resolves.toBeDefined();

      const entrypoints = await harness.owner.query<{
        readonly argument_count: number;
        readonly name: string;
        readonly owner: string;
        readonly security_definer: boolean;
      }>(`
        SELECT routine.proname AS name,
          routine.pronargs AS argument_count,
          routine.prosecdef AS security_definer,
          pg_catalog.pg_get_userbyid(routine.proowner) AS owner
        FROM pg_catalog.pg_proc AS routine
        WHERE routine.pronamespace =
          'task8a_retention_barrier'::regnamespace
          AND routine.proname IN ('initialize', 'revalidate')
        ORDER BY routine.proname
      `);
      expect(entrypoints.rows).toEqual([
        {
          argument_count: 2,
          name: "initialize",
          owner: task8aHarnessDefinerRole,
          security_definer: true,
        },
        {
          argument_count: 0,
          name: "revalidate",
          owner: task8aHarnessDefinerRole,
          security_definer: true,
        },
      ]);

      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 1, true)",
        [task8aHarnessSubjectA],
      );
      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 9, true)",
        [task8aHarnessSubjectB],
      );

      await expect(
        harness.initializer.query(
          "SELECT * FROM task8a_retention_barrier.authority_revisions",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        harness.secondIdentity.query(
          "SELECT * FROM task8a_retention_barrier.authority_revisions",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.append_revision($1, 2, true)",
          [task8aHarnessSubjectA],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.initialize($1::name)",
          [task8aHarnessSubjectB],
        ),
      ).rejects.toMatchObject({ code: "42883" });

      await harness.initializer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await harness.initializer.query(
        "SELECT task8a_retention_barrier.initialize($1, $2)",
        [task8aHarnessTargetOrganizationA, task8aHarnessTargetDashboard],
      );
      const initializedContext = await harness.initializer.query<{
        readonly binding_phase: string;
        readonly bound_principal_id: string;
        readonly bound_revision: string;
        readonly bound_subject: string;
        readonly session_identity: string;
        readonly target_organization_id: string;
      }>(`
          SELECT
            session_user::text AS session_identity,
            COALESCE(
              pg_catalog.current_setting('task8a.binding_phase', true),
              ''
            ) AS binding_phase,
            COALESCE(
              pg_catalog.current_setting('task8a.bound_subject', true),
              ''
            ) AS bound_subject,
            COALESCE(
              pg_catalog.current_setting('task8a.bound_principal_id', true),
              ''
            ) AS bound_principal_id,
            COALESCE(
              pg_catalog.current_setting('task8a.bound_revision', true),
              ''
            ) AS bound_revision,
            COALESCE(
              pg_catalog.current_setting('task8a.target_organization_id', true),
              ''
            ) AS target_organization_id
        `);
      expect(initializedContext.rows[0]).toEqual({
        binding_phase: "authorized",
        bound_principal_id: normalPrincipalId,
        bound_revision: "1",
        bound_subject: task8aHarnessSubjectA,
        session_identity: task8aHarnessSubjectA,
        target_organization_id: task8aHarnessTargetOrganizationA,
      });

      await harness.writer.query("BEGIN");
      const disableAfterInitializer = harness.writer
        .query(
          "SELECT task8a_retention_barrier.append_revision($1, 2, false)",
          [task8aHarnessSubjectA],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await observeTask8aBarrierWaiter("dasher_task8a_writer");
      await harness.initializer.query(
        "SELECT task8a_retention_barrier.revalidate()",
      );
      await harness.initializer.query("COMMIT");
      expect((await disableAfterInitializer).error).toBeUndefined();
      await harness.writer.query("COMMIT");

      await harness.initializer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.initialize($1, $2)",
          [task8aHarnessTargetOrganizationA, task8aHarnessTargetDashboard],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
      await harness.initializer.query("ROLLBACK");

      await harness.writer.query(
        "SELECT task8a_retention_barrier.cleanup_subject($1)",
        [task8aHarnessSubjectA],
      );
      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 1, true)",
        [task8aHarnessSubjectA],
      );

      await harness.writer.query("BEGIN");
      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 2, false)",
        [task8aHarnessSubjectA],
      );
      await harness.initializer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await harness.initializer.query("SELECT 1");
      const initializeAfterWriter = harness.initializer
        .query("SELECT task8a_retention_barrier.initialize($1, $2)", [
          task8aHarnessTargetOrganizationA,
          task8aHarnessTargetDashboard,
        ])
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await observeTask8aBarrierWaiter("dasher_task8a_initializer");
      await harness.writer.query("COMMIT");
      expect((await initializeAfterWriter).error).toMatchObject({
        code: "55000",
        message: "task8a_denied",
      });
      await harness.initializer.query("ROLLBACK");

      await harness.secondIdentity.query(
        "BEGIN ISOLATION LEVEL READ COMMITTED",
      );
      await harness.secondIdentity.query(
        "SELECT task8a_retention_barrier.initialize($1, $2)",
        [task8aHarnessTargetOrganizationB, task8aHarnessTargetDashboard],
      );
      const secondContext = await harness.secondIdentity.query<{
        readonly bound_revision: string;
        readonly bound_subject: string;
        readonly session_identity: string;
      }>(`
        SELECT session_user::text AS session_identity,
          pg_catalog.current_setting(
            'task8a.bound_subject'
          ) AS bound_subject,
          pg_catalog.current_setting(
            'task8a.bound_revision'
          ) AS bound_revision
      `);
      expect(secondContext.rows[0]).toEqual({
        bound_revision: "9",
        bound_subject: task8aHarnessSubjectB,
        session_identity: task8aHarnessSubjectB,
      });
      await harness.secondIdentity.query(
        "SELECT task8a_retention_barrier.revalidate()",
      );
      await harness.secondIdentity.query("COMMIT");

      await harness.writer.query(
        "SELECT task8a_retention_barrier.cleanup_subject($1)",
        [task8aHarnessSubjectA],
      );
      await harness.writer.query(
        "SELECT task8a_retention_barrier.cleanup_subject($1)",
        [task8aHarnessSubjectB],
      );
      const residue = await harness.owner.query<{ readonly count: string }>(
        "SELECT pg_catalog.count(*)::text AS count FROM task8a_retention_barrier.authority_revisions",
      );
      expect(residue.rows[0]?.count).toBe("0");
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("binds duplicate dashboard UUIDs to the explicit organization under forced RLS", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const wrongOrganization = "83000000-0000-4000-8000-000000000003";
    const wrongDashboard = "83000000-0000-4000-8000-000000000099";

    try {
      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 1, true)",
        [task8aHarnessSubjectA],
      );
      const targetRelation = await harness.owner.query<{
        readonly force_row_security: boolean;
        readonly row_security: boolean;
      }>(`
        SELECT relation.relrowsecurity AS row_security,
          relation.relforcerowsecurity AS force_row_security
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid =
          'task8a_retention_barrier.target_dashboards'::regclass
      `);
      expect(targetRelation.rows[0]).toEqual({
        force_row_security: true,
        row_security: true,
      });
      const discoveryPolicy = await harness.owner.query<{
        readonly using_expression: string;
      }>(`
        SELECT pg_catalog.pg_get_expr(
          policy.polqual, policy.polrelid, true
        ) AS using_expression
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'task8a_retention_barrier.target_dashboards'::regclass
          AND policy.polname =
            'target_dashboards_retention_discovery_select'
      `);
      const normalizedPolicy =
        discoveryPolicy.rows[0]?.using_expression.replace(/\s+/gu, " ");
      expect(normalizedPolicy).toContain(
        "organization_id = current_setting('task8a.target_organization_id'::text, true)::uuid",
      );
      expect(normalizedPolicy).toContain(
        "dashboard_id = current_setting('task8a.target_dashboard_id'::text, true)::uuid",
      );

      const exactAction = await harness.initializer.query<{
        readonly stage: string;
      }>(
        "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3) AS stage",
        [task8aHarnessTargetOrganizationA, task8aHarnessTargetDashboard, 0],
      );
      expect(exactAction.rows[0]?.stage).toBe("retention_action");

      const exactState = async () =>
        harness.owner.query<{
          readonly audit_count: string;
          readonly event_count: string;
          readonly organization_id: string;
          readonly retention_action_count: string;
        }>(
          `
          SELECT dashboard.organization_id::text AS organization_id,
            dashboard.retention_action_count::text AS retention_action_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.target_events AS event
              WHERE event.organization_id = dashboard.organization_id
                AND event.dashboard_id = dashboard.dashboard_id
            ) AS event_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.target_audits AS audit
              WHERE audit.organization_id = dashboard.organization_id
                AND audit.dashboard_id = dashboard.dashboard_id
            ) AS audit_count
          FROM task8a_retention_barrier.target_dashboards AS dashboard
          WHERE dashboard.dashboard_id = $1
          ORDER BY dashboard.organization_id
        `,
          [task8aHarnessTargetDashboard],
        );

      expect((await exactState()).rows).toEqual([
        {
          audit_count: "1",
          event_count: "1",
          organization_id: task8aHarnessTargetOrganizationA,
          retention_action_count: "1",
        },
        {
          audit_count: "0",
          event_count: "0",
          organization_id: task8aHarnessTargetOrganizationB,
          retention_action_count: "0",
        },
      ]);

      for (const [organizationId, dashboardId] of [
        [wrongOrganization, task8aHarnessTargetDashboard],
        [task8aHarnessTargetOrganizationA, wrongDashboard],
      ] as const) {
        await expect(
          harness.initializer.query(
            "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3)",
            [organizationId, dashboardId, 0],
          ),
        ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
        expect((await exactState()).rows).toEqual([
          {
            audit_count: "1",
            event_count: "1",
            organization_id: task8aHarnessTargetOrganizationA,
            retention_action_count: "1",
          },
          {
            audit_count: "0",
            event_count: "0",
            organization_id: task8aHarnessTargetOrganizationB,
            retention_action_count: "0",
          },
        ]);
      }
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("serializes admission and retention on policy then dashboard in both winner orders", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const lockBarrier = 2_026_080_209;
    let barrierHeld = false;

    try {
      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 1, true)",
        [task8aHarnessSubjectA],
      );
      await harness.writer.query(
        "SELECT task8a_retention_barrier.append_revision($1, 1, true)",
        [task8aHarnessSubjectB],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.promotion_dashboards (
            organization_id, dashboard_id, lifecycle_state,
            effective_expires_at
          ) VALUES ($1, $2, 'active', statement_timestamp() + interval '1 day')
        `,
        [task8aHarnessTargetOrganizationA, task8aHarnessTargetDashboard],
      );
      await harness.initializer.query("SET statement_timeout = '10s'");
      await harness.secondIdentity.query("SET statement_timeout = '10s'");
      const applicationPid = await appBackendPid(harness.initializer);
      const retentionPid = await appBackendPid(harness.secondIdentity);

      const runWinnerOrder = async (
        winner: "application" | "retention",
        nonce: string,
      ): Promise<void> => {
        await harness.owner.query("SELECT pg_catalog.pg_advisory_lock($1)", [
          lockBarrier,
        ]);
        barrierHeld = true;
        const application = () =>
          settleDatabasePromise(
            harness.initializer.query(
              "SELECT task8a_retention_barrier.request_promotion($1, $2, $3, $4, $5)",
              [
                task8aHarnessTargetOrganizationA,
                task8aHarnessTargetDashboard,
                `85000000-0000-4000-8000-0000000000${nonce}`,
                `86000000-0000-4000-8000-0000000000${nonce}`,
                lockBarrier,
              ],
            ),
          );
        const retention = () =>
          settleDatabasePromise(
            harness.secondIdentity.query(
              "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3)",
              [
                task8aHarnessTargetOrganizationA,
                task8aHarnessTargetDashboard,
                lockBarrier,
              ],
            ),
          );
        const first = winner === "application" ? application() : retention();
        await waitForDatabaseLock(
          harness.owner,
          winner === "application" ? applicationPid : retentionPid,
          "advisory",
          first,
        );
        const second = winner === "application" ? retention() : application();
        await waitForDatabaseLock(
          harness.owner,
          winner === "application" ? retentionPid : applicationPid,
          ["transactionid", "tuple"],
          second,
        );
        const unlock = await harness.owner.query<{
          readonly unlocked: boolean;
        }>("SELECT pg_catalog.pg_advisory_unlock($1) AS unlocked", [
          lockBarrier,
        ]);
        barrierHeld = false;
        expect(unlock.rows[0]?.unlocked).toBe(true);
        const settlements = await Promise.all([first, second]);
        for (const settlement of settlements) {
          if (settlement.status === "rejected") {
            expect(settlement.reason).not.toMatchObject({ code: "40P01" });
            expect(String(settlement.reason)).not.toContain(
              "deadlock detected",
            );
          }
          expect(settlement.status).toBe("fulfilled");
        }

        const state = await harness.owner.query<{
          readonly promotion_audit_count: string;
          readonly promotion_request_count: string;
          readonly retention_action_count: string;
          readonly target_audit_count: string;
          readonly target_event_count: string;
        }>(`
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.promotion_requests
            ) AS promotion_request_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.promotion_audits
            ) AS promotion_audit_count,
            (
              SELECT retention_action_count::text
              FROM task8a_retention_barrier.target_dashboards
              WHERE organization_id = '${task8aHarnessTargetOrganizationA}'::uuid
                AND dashboard_id = '${task8aHarnessTargetDashboard}'::uuid
            ) AS retention_action_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.target_events
            ) AS target_event_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.target_audits
            ) AS target_audit_count
        `);
        expect(state.rows[0]).toEqual({
          promotion_audit_count: "1",
          promotion_request_count: "1",
          retention_action_count: "1",
          target_audit_count: "1",
          target_event_count: "1",
        });
        const sessions = await harness.owner.query<{
          readonly waiting: boolean;
        }>(
          `
            SELECT EXISTS (
              SELECT 1 FROM pg_catalog.pg_stat_activity AS activity
              WHERE activity.pid = ANY($1::integer[])
                AND activity.wait_event_type = 'Lock'
            ) AS waiting
          `,
          [[applicationPid, retentionPid]],
        );
        expect(sessions.rows[0]?.waiting).toBe(false);
      };

      await runWinnerOrder("application", "11");
      await harness.owner.query(`
        DELETE FROM task8a_retention_barrier.promotion_requests;
        DELETE FROM task8a_retention_barrier.promotion_audits;
        DELETE FROM task8a_retention_barrier.target_events;
        DELETE FROM task8a_retention_barrier.target_audits;
        UPDATE task8a_retention_barrier.target_dashboards
        SET retention_action_count = 0
      `);
      await runWinnerOrder("retention", "22");
    } finally {
      if (barrierHeld) {
        await harness.owner.query("SELECT pg_catalog.pg_advisory_unlock($1)", [
          lockBarrier,
        ]);
      }
      await harness.close();
    }
  }, 120_000);

  it("serializes snapshot admissions against durable finalizers in both winner orders", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const organizationId = "83000000-0000-4000-8000-000000000001";
    const snapshotId = "83000000-0000-4000-8000-000000000002";
    const sourceDashboardId = "83000000-0000-4000-8000-000000000003";
    const sharedDashboardId = "83000000-0000-4000-8000-000000000004";
    const deniedDashboardId = "83000000-0000-4000-8000-000000000005";
    const deniedEvidenceId = "83000000-0000-4000-8000-000000000006";
    const attachedSnapshotId = "83000000-0000-4000-8000-000000000007";
    const attachedEvidenceId = "83000000-0000-4000-8000-000000000008";
    const attachedDashboardId = "83000000-0000-4000-8000-000000000009";

    try {
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_resources (
            organization_id, snapshot_id, snapshot_bytes
          ) VALUES ($1, $2, 'bounded synthetic snapshot')
        `,
        [organizationId, snapshotId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_claims (
            organization_id, snapshot_id, dashboard_id
          ) VALUES ($1, $2, $3)
        `,
        [organizationId, snapshotId, sourceDashboardId],
      );

      await harness.initializer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await harness.initializer.query(
        "SELECT task8a_retention_barrier.admit_version_reference($1, $2, $3)",
        [organizationId, snapshotId, sharedDashboardId],
      );
      await harness.writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const intentAfterAdmission = harness.writer.query<{
        readonly created: boolean;
      }>(
        "SELECT task8a_retention_barrier.create_snapshot_intent($1, $2, $3) AS created",
        [organizationId, snapshotId, sourceDashboardId],
      );
      await observeTask8aRowLockWaiter("dasher_task8a_writer");
      await harness.initializer.query("COMMIT");
      expect((await intentAfterAdmission).rows[0]?.created).toBe(false);
      await harness.writer.query("COMMIT");

      const admissionWinner = await harness.owner.query<{
        readonly claim_count: string;
        readonly finalizer_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_claims AS claim
              WHERE claim.organization_id = $1 AND claim.snapshot_id = $2
            ) AS claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
                AND finalizer.snapshot_id = $2
            ) AS finalizer_count
        `,
        [organizationId, snapshotId],
      );
      expect(admissionWinner.rows[0]).toEqual({
        claim_count: "2",
        finalizer_count: "0",
      });

      await harness.owner.query(
        `
          DELETE FROM task8a_retention_barrier.snapshot_claims
          WHERE organization_id = $1 AND snapshot_id = $2
            AND dashboard_id = $3
        `,
        [organizationId, snapshotId, sharedDashboardId],
      );
      const intentWinner = await harness.writer.query<{
        readonly created: boolean;
      }>(
        "SELECT task8a_retention_barrier.create_snapshot_intent($1, $2, $3) AS created",
        [organizationId, snapshotId, sourceDashboardId],
      );
      expect(intentWinner.rows[0]?.created).toBe(true);

      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.admit_version_reference($1, $2, $3)",
          [organizationId, snapshotId, deniedDashboardId],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });

      await harness.owner.query(
        `
          UPDATE task8a_retention_barrier.snapshot_finalizers
          SET state = 'eligible'
          WHERE organization_id = $1 AND snapshot_id = $2
        `,
        [organizationId, snapshotId],
      );
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.admit_evidence_reference($1, $2, $3, $4)",
          [organizationId, snapshotId, deniedEvidenceId, deniedDashboardId],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
      await expect(
        harness.secondIdentity.query(
          "SELECT task8a_retention_barrier.admit_restore_reference($1, $2, $3)",
          [organizationId, snapshotId, deniedDashboardId],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });

      const deniedRows = await harness.owner.query<{
        readonly claim_count: string;
        readonly evidence_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_claims AS claim
              WHERE claim.organization_id = $1
                AND claim.snapshot_id = $2
                AND claim.dashboard_id = $3
            ) AS claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.evidence_attachments AS evidence
              WHERE evidence.organization_id = $1
                AND evidence.evidence_id = $4
            ) AS evidence_count
        `,
        [organizationId, snapshotId, deniedDashboardId, deniedEvidenceId],
      );
      expect(deniedRows.rows[0]).toEqual({
        claim_count: "0",
        evidence_count: "0",
      });

      await harness.owner.query(
        `
          DELETE FROM task8a_retention_barrier.snapshot_claims
          WHERE organization_id = $1 AND snapshot_id = $2
            AND dashboard_id = $3
        `,
        [organizationId, snapshotId, sourceDashboardId],
      );
      const finalized = await harness.writer.query<{
        readonly finalized: boolean;
      }>(
        "SELECT task8a_retention_barrier.finalize_snapshot($1, $2) AS finalized",
        [organizationId, snapshotId],
      );
      expect(finalized.rows[0]?.finalized).toBe(true);
      const deletedState = await harness.owner.query<{
        readonly finalizer_state: string;
        readonly resource_count: string;
      }>(
        `
          SELECT finalizer.state AS finalizer_state,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_resources AS snapshot
              WHERE snapshot.organization_id = finalizer.organization_id
                AND snapshot.snapshot_id = finalizer.snapshot_id
            ) AS resource_count
          FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
          WHERE finalizer.organization_id = $1
            AND finalizer.snapshot_id = $2
        `,
        [organizationId, snapshotId],
      );
      expect(deletedState.rows[0]).toEqual({
        finalizer_state: "deleted",
        resource_count: "0",
      });
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.admit_version_reference($1, $2, $3)",
          [organizationId, snapshotId, deniedDashboardId],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });

      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_resources (
            organization_id, snapshot_id, snapshot_bytes
          ) VALUES ($1, $2, 'bounded attached-evidence snapshot')
        `,
        [organizationId, attachedSnapshotId],
      );
      await harness.initializer.query(
        "SELECT task8a_retention_barrier.admit_evidence_reference($1, $2, $3, $4)",
        [
          organizationId,
          attachedSnapshotId,
          attachedEvidenceId,
          attachedDashboardId,
        ],
      );
      const attachedIntent = await harness.writer.query<{
        readonly created: boolean;
      }>(
        "SELECT task8a_retention_barrier.create_snapshot_intent($1, $2, $3) AS created",
        [organizationId, attachedSnapshotId, attachedDashboardId],
      );
      expect(attachedIntent.rows[0]?.created).toBe(true);
      const attachedIntentState = await harness.owner.query<{
        readonly evidence_state: string;
        readonly snapshot_state: string;
      }>(
        `
          SELECT evidence_finalizer.state AS evidence_state,
            snapshot_finalizer.state AS snapshot_state
          FROM task8a_retention_barrier.evidence_finalizers AS evidence_finalizer
          JOIN task8a_retention_barrier.snapshot_finalizers AS snapshot_finalizer
            ON snapshot_finalizer.organization_id = evidence_finalizer.organization_id
          WHERE evidence_finalizer.organization_id = $1
            AND evidence_finalizer.evidence_id = $2
            AND snapshot_finalizer.snapshot_id = $3
        `,
        [organizationId, attachedEvidenceId, attachedSnapshotId],
      );
      expect(attachedIntentState.rows[0]).toEqual({
        evidence_state: "intent",
        snapshot_state: "intent",
      });
      await harness.owner.query(
        `
          DELETE FROM task8a_retention_barrier.snapshot_claims
          WHERE organization_id = $1 AND snapshot_id = $2
            AND dashboard_id = $3
        `,
        [organizationId, attachedSnapshotId, attachedDashboardId],
      );
      await harness.owner.query(
        `
          UPDATE task8a_retention_barrier.evidence_finalizers
          SET state = 'eligible'
          WHERE organization_id = $1 AND evidence_id = $2
        `,
        [organizationId, attachedEvidenceId],
      );
      await harness.owner.query(
        `
          UPDATE task8a_retention_barrier.snapshot_finalizers
          SET state = 'eligible'
          WHERE organization_id = $1 AND snapshot_id = $2
        `,
        [organizationId, attachedSnapshotId],
      );
      const blockedSnapshotFinalizer = await harness.writer.query<{
        readonly finalized: boolean;
      }>(
        "SELECT task8a_retention_barrier.finalize_snapshot($1, $2) AS finalized",
        [organizationId, attachedSnapshotId],
      );
      expect(blockedSnapshotFinalizer.rows[0]?.finalized).toBe(false);
      const finalizedEvidence = await harness.writer.query<{
        readonly finalized: boolean;
      }>(
        "SELECT task8a_retention_barrier.finalize_evidence($1, $2) AS finalized",
        [organizationId, attachedEvidenceId],
      );
      expect(finalizedEvidence.rows[0]?.finalized).toBe(true);
      const finalizedAttachedSnapshot = await harness.writer.query<{
        readonly finalized: boolean;
      }>(
        "SELECT task8a_retention_barrier.finalize_snapshot($1, $2) AS finalized",
        [organizationId, attachedSnapshotId],
      );
      expect(finalizedAttachedSnapshot.rows[0]?.finalized).toBe(true);
      const attachedFinalState = await harness.owner.query<{
        readonly attachment_count: string;
        readonly evidence_state: string;
        readonly snapshot_count: string;
        readonly snapshot_state: string;
      }>(
        `
          SELECT evidence_finalizer.state AS evidence_state,
            snapshot_finalizer.state AS snapshot_state,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.evidence_attachments AS evidence
              WHERE evidence.organization_id = $1
                AND evidence.evidence_id = $2
            ) AS attachment_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_resources AS snapshot
              WHERE snapshot.organization_id = $1
                AND snapshot.snapshot_id = $3
            ) AS snapshot_count
          FROM task8a_retention_barrier.evidence_finalizers AS evidence_finalizer
          JOIN task8a_retention_barrier.snapshot_finalizers AS snapshot_finalizer
            ON snapshot_finalizer.organization_id = evidence_finalizer.organization_id
          WHERE evidence_finalizer.organization_id = $1
            AND evidence_finalizer.evidence_id = $2
            AND snapshot_finalizer.snapshot_id = $3
        `,
        [organizationId, attachedEvidenceId, attachedSnapshotId],
      );
      expect(attachedFinalState.rows[0]).toEqual({
        attachment_count: "0",
        evidence_state: "deleted",
        snapshot_count: "0",
        snapshot_state: "deleted",
      });
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("enforces editor-only promotion requests before forced-RLS tenant side effects", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const organizationId = "86000000-0000-4000-8000-000000000001";
    const dashboardId = "86000000-0000-4000-8000-000000000002";
    const editorRequestId = "86000000-0000-4000-8000-000000000003";
    const editorAuditId = "86000000-0000-4000-8000-000000000004";
    const viewerRequestId = "86000000-0000-4000-8000-000000000005";
    const viewerAuditId = "86000000-0000-4000-8000-000000000006";

    try {
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.promotion_dashboards (
            organization_id, dashboard_id, lifecycle_state,
            effective_expires_at
          ) VALUES ($1, $2, 'active', statement_timestamp() + interval '1 hour')
        `,
        [organizationId, dashboardId],
      );
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.request_promotion($1, $2, $3, $4, $5)",
          [organizationId, dashboardId, editorRequestId, editorAuditId, null],
        ),
      ).resolves.toBeDefined();
      await expect(
        harness.secondIdentity.query(
          "SELECT task8a_retention_barrier.request_promotion($1, $2, $3, $4, $5)",
          [organizationId, dashboardId, viewerRequestId, viewerAuditId, null],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });

      const state = await harness.owner.query<{
        readonly audit_count: string;
        readonly forced_rls_count: string;
        readonly request_count: string;
        readonly viewer_audit_count: string;
        readonly viewer_request_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.promotion_requests
              WHERE organization_id = $1
            ) AS request_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.promotion_audits
              WHERE organization_id = $1
            ) AS audit_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.promotion_requests
              WHERE organization_id = $1 AND promotion_request_id = $2
            ) AS viewer_request_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.promotion_audits
              WHERE organization_id = $1 AND audit_event_id = $3
            ) AS viewer_audit_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'task8a_retention_barrier'
                AND relation.relname IN (
                  'promotion_dashboards', 'promotion_requests',
                  'promotion_audits'
                )
                AND relation.relrowsecurity AND relation.relforcerowsecurity
            ) AS forced_rls_count
        `,
        [organizationId, viewerRequestId, viewerAuditId],
      );
      expect(state.rows[0]).toEqual({
        audit_count: "1",
        forced_rls_count: "3",
        request_count: "1",
        viewer_audit_count: "0",
        viewer_request_count: "0",
      });
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("enforces all nine mutation role gates inside the BYPASSRLS definer", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const editorOperations = [
      "create_dashboard",
      "create_evidence_record",
      "create_dashboard_version",
      "compare_and_swap_dashboard_head",
      "request_dashboard_promotion",
    ] as const;
    const adminOperations = [
      "decide_dashboard_promotion",
      "set_dashboard_archive",
      "delete_dashboard",
      "restore_dashboard_as_new",
    ] as const;
    const allOperations = [...editorOperations, ...adminOperations];

    try {
      const definer = await harness.owner.query<{
        readonly bypasses_rls: boolean;
      }>(
        `
          SELECT role.rolbypassrls AS bypasses_rls
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = $1
        `,
        [task8aSecurityHarnessDefinerRole],
      );
      expect(definer.rows[0]?.bypasses_rls).toBe(true);

      for (const operation of allOperations) {
        await expect(
          harness.secondIdentity.query(
            "SELECT task8a_retention_barrier.execute_modeled_mutation($1)",
            [operation],
          ),
        ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
      }
      for (const operation of editorOperations) {
        await expect(
          harness.initializer.query(
            "SELECT task8a_retention_barrier.execute_modeled_mutation($1)",
            [operation],
          ),
        ).resolves.toBeDefined();
      }
      for (const operation of adminOperations) {
        await expect(
          harness.initializer.query(
            "SELECT task8a_retention_barrier.execute_modeled_mutation($1)",
            [operation],
          ),
        ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
      }
      for (const operation of allOperations) {
        await expect(
          harness.writer.query(
            "SELECT task8a_retention_barrier.execute_modeled_mutation($1)",
            [operation],
          ),
        ).resolves.toBeDefined();
      }

      const state = await harness.owner.query<{
        readonly admin_audits: string;
        readonly admin_writes: string;
        readonly editor_audits: string;
        readonly editor_writes: string;
        readonly forced_rls_count: string;
        readonly viewer_audits: string;
        readonly viewer_writes: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.modeled_mutations
              WHERE actor = $1::name
            ) AS viewer_writes,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.modeled_mutation_audits
              WHERE actor = $1::name
            ) AS viewer_audits,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.modeled_mutations
              WHERE actor = $2::name
            ) AS editor_writes,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.modeled_mutation_audits
              WHERE actor = $2::name
            ) AS editor_audits,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.modeled_mutations
              WHERE actor = session_user
            ) AS admin_writes,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.modeled_mutation_audits
              WHERE actor = session_user
            ) AS admin_audits,
            (
              SELECT pg_catalog.count(*)::text
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'task8a_retention_barrier'
                AND relation.relname IN (
                  'modeled_mutations', 'modeled_mutation_audits'
                )
                AND relation.relrowsecurity AND relation.relforcerowsecurity
            ) AS forced_rls_count
        `,
        [task8aHarnessSubjectB, task8aHarnessSubjectA],
      );
      expect(state.rows[0]).toEqual({
        admin_audits: "9",
        admin_writes: "9",
        editor_audits: "5",
        editor_writes: "5",
        forced_rls_count: "2",
        viewer_audits: "0",
        viewer_writes: "0",
      });
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("denies read projections when authority changes between preliminary and final statements", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const organizationId = "88000000-0000-4000-8000-000000000001";
    const dashboardId = "88000000-0000-4000-8000-000000000002";
    const versionId = "88000000-0000-4000-8000-000000000003";
    const snapshotId = "88000000-0000-4000-8000-000000000004";
    const evidenceId = "88000000-0000-4000-8000-000000000005";
    const evidenceBarrier = 2_026_080_301;
    const lineageBarrier = 2_026_080_302;

    try {
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_dashboards (
            organization_id, dashboard_id, current_kind, lifecycle_state,
            effective_expires_at, access_revoked_at, purged_at,
            current_head_version_id
          ) VALUES ($1, $2, 'durable', 'active', NULL, NULL, NULL, $3)
        `,
        [organizationId, dashboardId, versionId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_versions (
            organization_id, dashboard_id, version_id, parent_version_id,
            validation_state
          ) VALUES ($1, $2, $3, NULL, 'validated')
        `,
        [organizationId, dashboardId, versionId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_snapshot_links (
            organization_id, dashboard_id, version_id, snapshot_id
          ) VALUES ($1, $2, $3, $4)
        `,
        [organizationId, dashboardId, versionId, snapshotId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_snapshot_claims (
            organization_id, dashboard_id, snapshot_id, claim_kind
          ) VALUES ($1, $2, $3, 'version')
        `,
        [organizationId, dashboardId, snapshotId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_evidence_records (
            organization_id, evidence_id, source_snapshot_id
          ) VALUES ($1, $2, $3)
        `,
        [organizationId, evidenceId, snapshotId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_evidence_links (
            organization_id, dashboard_id, version_id, evidence_id
          ) VALUES ($1, $2, $3, $4)
        `,
        [organizationId, dashboardId, versionId, evidenceId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.projection_evidence_claims (
            organization_id, dashboard_id, evidence_id, claim_kind
          ) VALUES ($1, $2, $3, 'evidence')
        `,
        [organizationId, dashboardId, evidenceId],
      );

      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.read_evidence_projection($1, $2, $3)",
          [organizationId, dashboardId, evidenceBarrier],
        ),
      ).resolves.toBeDefined();
      await expect(
        harness.initializer.query(
          "SELECT task8a_retention_barrier.read_lineage_projection($1, $2, $3)",
          [organizationId, dashboardId, lineageBarrier],
        ),
      ).resolves.toBeDefined();

      let evidenceLockHeld = false;
      let evidenceRead: Promise<{ readonly error: unknown }> | undefined;
      try {
        await harness.owner.query("SELECT pg_catalog.pg_advisory_lock($1)", [
          evidenceBarrier,
        ]);
        evidenceLockHeld = true;
        evidenceRead = harness.initializer
          .query(
            "SELECT task8a_retention_barrier.read_evidence_projection($1, $2, $3)",
            [organizationId, dashboardId, evidenceBarrier],
          )
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );
        await observeTask8aBarrierWaiter("dasher_task8a_initializer");
        await harness.writer.query(
          `
            UPDATE task8a_retention_barrier.projection_dashboards
            SET access_revoked_at = statement_timestamp()
            WHERE organization_id = $1 AND dashboard_id = $2
          `,
          [organizationId, dashboardId],
        );
        const unlocked = await harness.owner.query<{
          readonly unlocked: boolean;
        }>("SELECT pg_catalog.pg_advisory_unlock($1) AS unlocked", [
          evidenceBarrier,
        ]);
        evidenceLockHeld = false;
        expect(unlocked.rows[0]?.unlocked).toBe(true);
        expect((await evidenceRead).error).toMatchObject({
          code: "55000",
          message: "task8a_denied",
        });
      } finally {
        if (evidenceLockHeld) {
          await harness.owner.query(
            "SELECT pg_catalog.pg_advisory_unlock($1)",
            [evidenceBarrier],
          );
        }
        await evidenceRead;
      }

      await harness.owner.query(
        `
          UPDATE task8a_retention_barrier.projection_dashboards
          SET access_revoked_at = NULL
          WHERE organization_id = $1 AND dashboard_id = $2
        `,
        [organizationId, dashboardId],
      );

      let lineageLockHeld = false;
      let lineageRead: Promise<{ readonly error: unknown }> | undefined;
      try {
        await harness.owner.query("SELECT pg_catalog.pg_advisory_lock($1)", [
          lineageBarrier,
        ]);
        lineageLockHeld = true;
        lineageRead = harness.initializer
          .query(
            "SELECT task8a_retention_barrier.read_lineage_projection($1, $2, $3)",
            [organizationId, dashboardId, lineageBarrier],
          )
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );
        await observeTask8aBarrierWaiter("dasher_task8a_initializer");
        await harness.writer.query(
          `
            DELETE FROM task8a_retention_barrier.projection_snapshot_claims
            WHERE organization_id = $1 AND dashboard_id = $2
              AND snapshot_id = $3
          `,
          [organizationId, dashboardId, snapshotId],
        );
        const unlocked = await harness.owner.query<{
          readonly unlocked: boolean;
        }>("SELECT pg_catalog.pg_advisory_unlock($1) AS unlocked", [
          lineageBarrier,
        ]);
        lineageLockHeld = false;
        expect(unlocked.rows[0]?.unlocked).toBe(true);
        expect((await lineageRead).error).toMatchObject({
          code: "55000",
          message: "task8a_denied",
        });
      } finally {
        if (lineageLockHeld) {
          await harness.owner.query(
            "SELECT pg_catalog.pg_advisory_unlock($1)",
            [lineageBarrier],
          );
        }
        await lineageRead;
      }
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("governs shared artifacts by an exact target claim and target-bound finalizer", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const organizationId = "89000000-0000-4000-8000-000000000001";
    const dashboard1Id = "89000000-0000-4000-8000-000000000002";
    const dashboard2Id = "89000000-0000-4000-8000-000000000003";
    const ownedArtifactId = "89000000-0000-4000-8000-000000000004";
    const sharedArtifactId = "89000000-0000-4000-8000-000000000005";

    try {
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.artifact_resources (
            organization_id, artifact_id, dashboard_id, ownership_class,
            artifact_bytes
          ) VALUES
            ($1, $3, $2, 'dashboard_owned', 'owned-bytes'),
            ($1, $4, $2, 'shared', 'shared-bytes')
        `,
        [organizationId, dashboard1Id, ownedArtifactId, sharedArtifactId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.artifact_claims (
            organization_id, artifact_id, reference_claim_id, dashboard_id,
            claim_kind
          ) VALUES
            ($1, $4, '89100000-0000-4000-8000-000000000001', $2, 'access'),
            ($1, $5, '89100000-0000-4000-8000-000000000002', $2, 'access'),
            ($1, $5, '89100000-0000-4000-8000-000000000003', $3, 'access')
        `,
        [
          organizationId,
          dashboard1Id,
          dashboard2Id,
          ownedArtifactId,
          sharedArtifactId,
        ],
      );

      const initialAuthority = await harness.writer.query<{
        readonly d2_can_govern_owned: boolean;
        readonly d2_can_govern_shared: boolean;
      }>(
        `
          SELECT
            task8a_retention_barrier.artifact_is_governable($1, $2, $3)
              AS d2_can_govern_owned,
            task8a_retention_barrier.artifact_is_governable($1, $2, $4)
              AS d2_can_govern_shared
        `,
        [organizationId, dashboard2Id, ownedArtifactId, sharedArtifactId],
      );
      expect(initialAuthority.rows[0]).toEqual({
        d2_can_govern_owned: false,
        d2_can_govern_shared: true,
      });

      const runPurge = async (dashboardId: string): Promise<string[]> => {
        const stages: string[] = [];
        for (let step = 0; step < 8; step += 1) {
          const result = await harness.writer.query<{
            readonly stage: string;
          }>(
            "SELECT task8a_retention_barrier.purge_artifact_step($1, $2) AS stage",
            [organizationId, dashboardId],
          );
          const stage = result.rows[0]?.stage;
          if (stage === undefined) throw new Error("artifact stage missing");
          stages.push(stage);
          if (stage === "cleaned") return stages;
        }
        throw new Error("artifact purge did not close within eight stages");
      };

      expect(await runPurge(dashboard1Id)).toEqual([
        "intent",
        "claims",
        "eligible",
        "bytes",
        "cleaned",
      ]);
      const afterDashboard1 = await harness.owner.query<{
        readonly original_dashboard_id: string;
        readonly shared_claim_count: string;
        readonly shared_finalizer_count: string;
        readonly shared_resource_count: string;
      }>(
        `
          SELECT artifact.dashboard_id::text AS original_dashboard_id,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_claims AS claim
              WHERE claim.organization_id = $1
                AND claim.artifact_id = $3
                AND claim.dashboard_id = $2
                AND claim.claim_kind = 'access'
            ) AS shared_claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
                AND finalizer.artifact_id = $3
            ) AS shared_finalizer_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_resources AS resource
              WHERE resource.organization_id = $1
                AND resource.artifact_id = $3
            ) AS shared_resource_count
          FROM task8a_retention_barrier.artifact_resources AS artifact
          WHERE artifact.organization_id = $1 AND artifact.artifact_id = $3
        `,
        [organizationId, dashboard2Id, sharedArtifactId],
      );
      expect(afterDashboard1.rows[0]).toEqual({
        original_dashboard_id: dashboard1Id,
        shared_claim_count: "1",
        shared_finalizer_count: "0",
        shared_resource_count: "1",
      });

      const d2Intent = await harness.writer.query<{ readonly stage: string }>(
        "SELECT task8a_retention_barrier.purge_artifact_step($1, $2) AS stage",
        [organizationId, dashboard2Id],
      );
      expect(d2Intent.rows[0]?.stage).toBe("intent");
      const boundIntent = await harness.owner.query<{
        readonly hash_matches_target: boolean;
        readonly original_dashboard_id: string;
        readonly state: string;
        readonly target_dashboard_id: string;
      }>(
        `
          SELECT artifact.dashboard_id::text AS original_dashboard_id,
            finalizer.target_dashboard_id::text AS target_dashboard_id,
            finalizer.state,
            finalizer.expected_claim_set_sha256 =
              task8a_retention_barrier.artifact_expected_claim_hash(
                artifact.organization_id, $2, artifact.artifact_id
              ) AS hash_matches_target
          FROM task8a_retention_barrier.artifact_resources AS artifact
          JOIN task8a_retention_barrier.artifact_finalizers AS finalizer
            ON finalizer.organization_id = artifact.organization_id
            AND finalizer.artifact_id = artifact.artifact_id
          WHERE artifact.organization_id = $1 AND artifact.artifact_id = $3
        `,
        [organizationId, dashboard2Id, sharedArtifactId],
      );
      expect(boundIntent.rows[0]).toEqual({
        hash_matches_target: true,
        original_dashboard_id: dashboard1Id,
        state: "intent",
        target_dashboard_id: dashboard2Id,
      });

      expect(await runPurge(dashboard2Id)).toEqual([
        "claims",
        "eligible",
        "bytes",
        "cleaned",
      ]);
      const finalState = await harness.owner.query<{
        readonly claim_count: string;
        readonly claimless_resource_count: string;
        readonly deleted_finalizer_count: string;
        readonly resource_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_resources
            ) AS resource_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_claims
            ) AS claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_resources AS artifact
              WHERE NOT EXISTS (
                SELECT 1
                FROM task8a_retention_barrier.artifact_claims AS claim
                WHERE claim.organization_id = artifact.organization_id
                  AND claim.artifact_id = artifact.artifact_id
              )
            ) AS claimless_resource_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.artifact_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
                AND finalizer.artifact_id = $2
                AND finalizer.target_dashboard_id = $3
                AND finalizer.state = 'deleted'
                AND finalizer.proof_sha256 =
                  finalizer.expected_claim_set_sha256
                AND finalizer.bytes_deleted_at IS NOT NULL
                AND finalizer.expected_claim_set_sha256 =
                  task8a_retention_barrier.artifact_expected_claim_hash(
                    finalizer.organization_id,
                    finalizer.target_dashboard_id,
                    finalizer.artifact_id
                  )
            ) AS deleted_finalizer_count
        `,
        [organizationId, sharedArtifactId, dashboard2Id],
      );
      expect(finalState.rows[0]).toEqual({
        claim_count: "0",
        claimless_resource_count: "0",
        deleted_finalizer_count: "1",
        resource_count: "0",
      });
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("closes noncanonical snapshot pagination above 100 with inverse link order and shared preservation", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const harness = await createTask8aSelfBindingHarness(harnessSql);
    const organizationId = "87000000-0000-4000-8000-000000000001";
    const dashboardId = "87000000-0000-4000-8000-000000000002";
    const sharedDashboardId = "87000000-0000-4000-8000-000000000003";

    try {
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_resources (
            organization_id, snapshot_id, snapshot_bytes
          )
          SELECT $1,
            (
              '87100000-0000-4000-8000-' ||
              pg_catalog.lpad(sequence::text, 12, '0')
            )::uuid,
            'exclusive-' || sequence::text
          FROM pg_catalog.generate_series(1, 125) AS sequence
        `,
        [organizationId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_claims (
            organization_id, snapshot_id, dashboard_id
          )
          SELECT $1,
            (
              '87100000-0000-4000-8000-' ||
              pg_catalog.lpad(sequence::text, 12, '0')
            )::uuid,
            $2
          FROM pg_catalog.generate_series(1, 125) AS sequence
        `,
        [organizationId, dashboardId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_links (
            organization_id, dashboard_id, version_id, snapshot_id
          )
          SELECT $1, $2,
            (
              '87200000-0000-4000-8000-' ||
              pg_catalog.lpad((126 - sequence)::text, 12, '0')
            )::uuid,
            (
              '87100000-0000-4000-8000-' ||
              pg_catalog.lpad(sequence::text, 12, '0')
            )::uuid
          FROM pg_catalog.generate_series(1, 125) AS sequence
        `,
        [organizationId, dashboardId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_resources (
            organization_id, snapshot_id, snapshot_bytes
          )
          SELECT $1,
            (
              '87100000-0000-4000-8000-' ||
              pg_catalog.lpad(sequence::text, 12, '0')
            )::uuid,
            'shared-' || sequence::text
          FROM pg_catalog.generate_series(201, 205) AS sequence
        `,
        [organizationId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_claims (
            organization_id, snapshot_id, dashboard_id
          )
          SELECT $1,
            (
              '87100000-0000-4000-8000-' ||
              pg_catalog.lpad(sequence::text, 12, '0')
            )::uuid,
            source_dashboard_id
          FROM pg_catalog.generate_series(201, 205) AS sequence
          CROSS JOIN (VALUES ($2::uuid), ($3::uuid)) AS dashboards(source_dashboard_id)
        `,
        [organizationId, dashboardId, sharedDashboardId],
      );
      await harness.owner.query(
        `
          INSERT INTO task8a_retention_barrier.snapshot_links (
            organization_id, dashboard_id, version_id, snapshot_id
          )
          SELECT $1, source_dashboard_id,
            (
              '87200000-0000-4000-8000-' ||
              pg_catalog.lpad((sequence - 200)::text, 12, '0')
            )::uuid,
            (
              '87100000-0000-4000-8000-' ||
              pg_catalog.lpad(sequence::text, 12, '0')
            )::uuid
          FROM pg_catalog.generate_series(201, 205) AS sequence
          CROSS JOIN (VALUES ($2::uuid), ($3::uuid)) AS dashboards(source_dashboard_id)
        `,
        [organizationId, dashboardId, sharedDashboardId],
      );

      const firstStep = await harness.writer.query<{
        readonly stage: string;
      }>(
        "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3) AS stage",
        [organizationId, dashboardId, null],
      );
      expect(firstStep.rows[0]?.stage).toBe("intent");
      const oldAlgorithmFailure = await harness.owner.query<{
        readonly finalized_count: string;
        readonly orphaned_exclusive_count: string;
      }>(
        `
          WITH old_link_batch AS MATERIALIZED (
            SELECT link.organization_id, link.snapshot_id
            FROM task8a_retention_barrier.snapshot_links AS link
            WHERE link.organization_id = $1 AND link.dashboard_id = $2
            ORDER BY link.version_id, link.snapshot_id
            LIMIT 100
          )
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
            ) AS finalized_count,
            pg_catalog.count(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1
                FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
                WHERE finalizer.organization_id = old_link.organization_id
                  AND finalizer.snapshot_id = old_link.snapshot_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM task8a_retention_barrier.snapshot_claims AS other_claim
                WHERE other_claim.organization_id = old_link.organization_id
                  AND other_claim.snapshot_id = old_link.snapshot_id
                  AND other_claim.dashboard_id <> $2
              )
            )::text AS orphaned_exclusive_count
          FROM old_link_batch AS old_link
        `,
        [organizationId, dashboardId],
      );
      expect(oldAlgorithmFailure.rows[0]).toEqual({
        finalized_count: "100",
        orphaned_exclusive_count: "25",
      });

      const stages = [firstStep.rows[0]!.stage];
      for (let invocation = 0; invocation < 20; invocation += 1) {
        const result = await harness.writer.query<{ readonly stage: string }>(
          "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3) AS stage",
          [organizationId, dashboardId, null],
        );
        stages.push(result.rows[0]!.stage);
        if (result.rows[0]!.stage === "cleaned") break;
      }
      expect(stages.at(-1)).toBe("cleaned");
      expect(stages.filter((stage) => stage === "intent")).toHaveLength(2);
      expect(stages).toContain("claims");
      expect(stages).toContain("eligible");
      expect(stages).toContain("links");
      expect(stages).toContain("bytes");

      const finalState = await harness.owner.query<{
        readonly exclusive_finalizer_count: string;
        readonly exclusive_resource_count: string;
        readonly source_claim_count: string;
        readonly source_link_count: string;
        readonly shared_finalizer_count: string;
        readonly shared_resource_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_resources AS snapshot
              WHERE snapshot.organization_id = $1
                AND snapshot.snapshot_id::text <
                  '87100000-0000-4000-8000-000000000200'
            ) AS exclusive_resource_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_resources AS snapshot
              WHERE snapshot.organization_id = $1
                AND snapshot.snapshot_id::text >=
                  '87100000-0000-4000-8000-000000000200'
            ) AS shared_resource_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
                AND finalizer.snapshot_id::text <
                  '87100000-0000-4000-8000-000000000200'
                AND finalizer.state = 'deleted'
            ) AS exclusive_finalizer_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
                AND finalizer.snapshot_id::text >=
                  '87100000-0000-4000-8000-000000000200'
            ) AS shared_finalizer_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_claims AS claim
              WHERE claim.organization_id = $1 AND claim.dashboard_id = $2
            ) AS source_claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_links AS link
              WHERE link.organization_id = $1 AND link.dashboard_id = $2
            ) AS source_link_count
        `,
        [organizationId, dashboardId],
      );
      expect(finalState.rows[0]).toEqual({
        exclusive_finalizer_count: "125",
        exclusive_resource_count: "0",
        shared_finalizer_count: "0",
        shared_resource_count: "5",
        source_claim_count: "0",
        source_link_count: "0",
      });

      const laterSharedPurge = await harness.writer.query<{
        readonly stage: string;
      }>(
        "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3) AS stage",
        [organizationId, sharedDashboardId, null],
      );
      expect(laterSharedPurge.rows[0]?.stage).toBe("intent");
      const governedExclusivity = await harness.owner.query<{
        readonly finalizer_count: string;
        readonly resource_count: string;
        readonly shared_claim_count: string;
        readonly shared_link_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
              WHERE finalizer.organization_id = $1
                AND finalizer.snapshot_id::text >=
                  '87100000-0000-4000-8000-000000000200'
                AND finalizer.state = 'intent'
            ) AS finalizer_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_resources AS snapshot
              WHERE snapshot.organization_id = $1
            ) AS resource_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_claims AS claim
              WHERE claim.organization_id = $1 AND claim.dashboard_id = $2
            ) AS shared_claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_links AS link
              WHERE link.organization_id = $1 AND link.dashboard_id = $2
            ) AS shared_link_count
        `,
        [organizationId, sharedDashboardId],
      );
      expect(governedExclusivity.rows[0]).toEqual({
        finalizer_count: "5",
        resource_count: "5",
        shared_claim_count: "5",
        shared_link_count: "5",
      });

      const laterStages = [laterSharedPurge.rows[0]!.stage];
      for (let invocation = 0; invocation < 10; invocation += 1) {
        const result = await harness.writer.query<{ readonly stage: string }>(
          "SELECT task8a_retention_barrier.purge_snapshot_batch($1, $2, $3) AS stage",
          [organizationId, sharedDashboardId, null],
        );
        laterStages.push(result.rows[0]!.stage);
        if (result.rows[0]!.stage === "cleaned") break;
      }
      expect(laterStages).toEqual([
        "intent",
        "claims",
        "eligible",
        "links",
        "bytes",
        "cleaned",
      ]);
      const laterFinalState = await harness.owner.query<{
        readonly claim_count: string;
        readonly link_count: string;
        readonly resource_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_resources
              WHERE organization_id = $1
            ) AS resource_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_claims
              WHERE organization_id = $1 AND dashboard_id = $2
            ) AS claim_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM task8a_retention_barrier.snapshot_links
              WHERE organization_id = $1 AND dashboard_id = $2
            ) AS link_count
        `,
        [organizationId, sharedDashboardId],
      );
      expect(laterFinalState.rows[0]).toEqual({
        claim_count: "0",
        link_count: "0",
        resource_count: "0",
      });
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("denies ambiguous self-bound initializer histories with normalized errors", async () => {
    const harnessSql = await readFile(
      new URL(
        "./fixtures/migrations-0003-allowlist/initializer-barrier/harness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const normalPrincipalId = "80000000-0000-4000-8000-000000000001";
    const conflictingPrincipalId = "80000000-0000-4000-8000-000000000002";
    const harness = await createTask8aSelfBindingHarness(harnessSql);

    const cases = [
      {
        name: "different principals tied at the maximum revision",
        principalId: conflictingPrincipalId,
        revision: 1,
      },
      {
        name: "different principals at different revisions",
        principalId: conflictingPrincipalId,
        revision: 2,
      },
      {
        name: "duplicate rows for one principal and revision",
        principalId: normalPrincipalId,
        revision: 1,
      },
    ] as const;

    try {
      for (const testCase of cases) {
        await harness.writer.query(
          "SELECT task8a_retention_barrier.cleanup_subject($1)",
          [task8aHarnessSubjectA],
        );
        await harness.writer.query(
          "SELECT task8a_retention_barrier.append_revision($1, 1, true)",
          [task8aHarnessSubjectA],
        );
        await harness.writer.query(
          "SELECT task8a_retention_barrier.insert_adversarial_revision($1, $2, $3, true)",
          [task8aHarnessSubjectA, testCase.principalId, testCase.revision],
        );

        await harness.initializer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await expect(
          harness.initializer.query(
            "SELECT task8a_retention_barrier.initialize($1, $2)",
            [task8aHarnessTargetOrganizationA, task8aHarnessTargetDashboard],
          ),
          testCase.name,
        ).rejects.toMatchObject({ code: "55000", message: "task8a_denied" });
        await harness.initializer.query("ROLLBACK");

        await harness.writer.query(
          "SELECT task8a_retention_barrier.cleanup_subject($1)",
          [task8aHarnessSubjectA],
        );
        const subjectResidue = await harness.owner.query<{
          readonly count: string;
        }>(
          `
            SELECT pg_catalog.count(*)::text AS count
            FROM task8a_retention_barrier.authority_revisions
            WHERE binding_subject = $1
          `,
          [task8aHarnessSubjectA],
        );
        expect(subjectResidue.rows[0]?.count, testCase.name).toBe("0");
      }

      const totalResidue = await harness.owner.query<{
        readonly count: string;
      }>(
        "SELECT pg_catalog.count(*)::text AS count FROM task8a_retention_barrier.authority_revisions",
      );
      expect(totalResidue.rows[0]?.count).toBe("0");
    } finally {
      await harness.close();
    }
  }, 120_000);

  it("rejects either managed namespace as an adoption conflict", async () => {
    for (const schemaName of ["dasher", "dasher_meta"] as const) {
      try {
        await ownerPool.query(`CREATE SCHEMA ${schemaName}`);
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory, []),
          "adoption_conflict",
        );
      } finally {
        await resetManagedSchemas();
      }
    }
  });

  it("rejects checksum drift and a renamed migration identity", async () => {
    try {
      await prepareAppliedJournal();
      await expectMigrationRejection(
        runMigrations(ownerPool, checksumDriftMigrationDirectory, []),
        "journal_identity_mismatch",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, renamedMigrationDirectory, []),
        "journal_identity_mismatch",
      );
    } finally {
      await resetManagedSchemas();
    }
  });

  it("rejects extra, gap, rename, checksum, and applied-by journal drift", async () => {
    const cases: readonly {
      readonly mutate: () => Promise<unknown>;
      readonly name: string;
    }[] = [
      {
        name: "extra row",
        mutate: () =>
          ownerPool.query(
            `
              INSERT INTO dasher_meta.schema_migrations (
                sequence, filename, checksum_sha256, applied_by
              )
              VALUES (3, '0003_extra.sql', $1, session_user)
            `,
            [Buffer.alloc(32, 3)],
          ),
      },
      {
        name: "gap",
        mutate: () =>
          ownerPool.query(
            "DELETE FROM dasher_meta.schema_migrations WHERE sequence = 1",
          ),
      },
      {
        name: "renamed row",
        mutate: () =>
          ownerPool.query(
            `
              UPDATE dasher_meta.schema_migrations
              SET filename = '0001_fixture_renamed.sql'
              WHERE sequence = 1
            `,
          ),
      },
      {
        name: "checksum",
        mutate: () =>
          ownerPool.query(
            `
              UPDATE dasher_meta.schema_migrations
              SET checksum_sha256 = $1
              WHERE sequence = 1
            `,
            [Buffer.alloc(32, 7)],
          ),
      },
      {
        name: "applied-by",
        mutate: () =>
          ownerPool.query(
            `
              UPDATE dasher_meta.schema_migrations
              SET applied_by = 'synthetic_wrong_executor'
              WHERE sequence = 1
            `,
          ),
      },
    ];

    for (const journalCase of cases) {
      try {
        await prepareAppliedJournal();
        await journalCase.mutate();
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory, []),
          "journal_identity_mismatch",
        );
      } catch (error) {
        throw new Error(`journal identity case failed: ${journalCase.name}`, {
          cause: error,
        });
      } finally {
        await resetManagedSchemas();
      }
    }
  });

  it("rejects malformed journal DDL, ACLs, ownership, and extra objects", async () => {
    const shapeCases: readonly {
      readonly mutate: () => Promise<unknown>;
      readonly name: string;
    }[] = [
      {
        name: "missing check",
        mutate: () =>
          ownerPool.query(`
            ALTER TABLE dasher_meta.schema_migrations
            DROP CONSTRAINT schema_migrations_checksum_sha256_check
          `),
      },
      {
        name: "extra column",
        mutate: () =>
          ownerPool.query(`
            ALTER TABLE dasher_meta.schema_migrations
            ADD COLUMN unexpected boolean
          `),
      },
      {
        name: "public ACL",
        mutate: () =>
          ownerPool.query(
            "GRANT SELECT ON dasher_meta.schema_migrations TO PUBLIC",
          ),
      },
      {
        name: "extra object",
        mutate: () =>
          ownerPool.query("CREATE TABLE dasher_meta.unexpected (id integer)"),
      },
    ];

    for (const shapeCase of shapeCases) {
      try {
        await prepareAppliedJournal();
        await shapeCase.mutate();
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory, []),
          "journal_shape_invalid",
        );
      } catch (error) {
        throw new Error(`journal shape case failed: ${shapeCase.name}`, {
          cause: error,
        });
      } finally {
        await resetManagedSchemas();
      }
    }

    try {
      await createShapeOwner();
      await prepareAppliedJournal();
      await ownerPool.query(
        "ALTER TABLE dasher_meta.schema_migrations OWNER TO dasher_task2_shape_owner",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
        "journal_shape_invalid",
      );
    } finally {
      await dropShapeOwner();
    }
  });

  it("rolls back journal creation and migration effects when the fixed journal INSERT fails", async () => {
    const client = await ownerPool.connect();
    try {
      await expect(
        runMigrations(
          borrowedClientPool(client, true),
          fixtureMigrationDirectory,
          [],
        ),
      ).rejects.toThrow("synthetic fixed journal insert failure");
      expect(await schemaPresence()).toEqual({
        dasher: false,
        dasherMeta: false,
      });
    } finally {
      client.release();
      await resetManagedSchemas();
    }
  });

  it("aborts on managed-role marker, flag, ownership, and grant drift without altering it", async () => {
    try {
      await ownerPool.query(
        "COMMENT ON ROLE dasher_app IS 'synthetic:wrong-marker'",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
        "managed_role_drift",
      );
      const marker = await ownerPool.query<{ readonly comment: string | null }>(
        `
          SELECT pg_catalog.shobj_description(oid, 'pg_authid') AS comment
          FROM pg_catalog.pg_roles
          WHERE rolname = 'dasher_app'
        `,
      );
      expect(marker.rows[0]?.comment).toBe("synthetic:wrong-marker");
    } finally {
      await ownerPool.query(
        "COMMENT ON ROLE dasher_app IS 'dasher:managed-role:v1:app'",
      );
    }

    try {
      await ownerPool.query("ALTER ROLE dasher_security_definer LOGIN");
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
        "managed_role_drift",
      );
      const flags = await ownerPool.query<{ readonly rolcanlogin: boolean }>(
        "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'dasher_security_definer'",
      );
      expect(flags.rows[0]?.rolcanlogin).toBe(true);
    } finally {
      await ownerPool.query(
        "ALTER ROLE dasher_security_definer NOLOGIN PASSWORD NULL",
      );
    }

    try {
      await ownerPool.query(
        "CREATE SCHEMA fixture_role_owned AUTHORIZATION dasher_security_definer",
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
        "managed_role_drift",
      );
      expect(
        (
          await ownerPool.query<{ readonly owner: string }>(
            `
              SELECT owner.rolname::text AS owner
              FROM pg_catalog.pg_namespace AS namespace
              JOIN pg_catalog.pg_roles AS owner
                ON owner.oid = namespace.nspowner
              WHERE namespace.nspname = 'fixture_role_owned'
            `,
          )
        ).rows[0]?.owner,
      ).toBe("dasher_security_definer");
    } finally {
      await ownerPool.query("DROP SCHEMA IF EXISTS fixture_role_owned CASCADE");
    }

    const grantClient = await ownerPool.connect();
    try {
      await executeServerFormattedSql(
        grantClient,
        "GRANT CONNECT ON DATABASE %I TO dasher_app",
        [config.ownerDatabase],
      );
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, []),
        "managed_role_drift",
      );
    } finally {
      await executeServerFormattedSql(
        grantClient,
        "REVOKE CONNECT ON DATABASE %I FROM dasher_app",
        [config.ownerDatabase],
      );
      grantClient.release();
      await resetManagedSchemas();
    }
  });

  it("rejects SET ROLE and application-login execution", async () => {
    const ownerClient = await ownerPool.connect();
    try {
      await ownerClient.query(`
        CREATE ROLE dasher_task2_set_role WITH
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD NULL
      `);
      const session = await ownerClient.query<{
        readonly session_name: string;
      }>("SELECT session_user::text AS session_name");
      const sessionName = session.rows[0]?.session_name;
      if (sessionName === undefined) {
        throw new Error("PostgreSQL did not return session_user");
      }
      await executeServerFormattedSql(
        ownerClient,
        "GRANT dasher_task2_set_role TO %I",
        [sessionName],
      );
      await ownerClient.query("SET ROLE dasher_task2_set_role");
      await expectMigrationRejection(
        runMigrations(
          borrowedClientPool(ownerClient),
          fixtureMigrationDirectory,
          [],
        ),
        "executor_set_role",
      );
    } finally {
      await ownerClient.query("RESET ROLE");
      await ownerClient.query(`DROP ROLE IF EXISTS ${setRoleExecutor}`);
      ownerClient.release();
    }

    await createTemporaryAppLogin(ownerPool, config.appDsn, config.appUsername);
    appLoginCreated = true;
    appPool = new Pool({ connectionString: config.appDsn, max: 2 });

    await expectMigrationRejection(
      runMigrations(appPool, fixtureMigrationDirectory, [config.appUsername]),
      "executor_role_invalid",
    );

    const appClient: PoolClient = await appPool.connect();
    try {
      await appClient.query("SET ROLE dasher_app");
      await expectMigrationRejection(
        runMigrations(
          borrowedClientPool(appClient),
          fixtureMigrationDirectory,
          [config.appUsername],
        ),
        "executor_set_role",
      );
    } finally {
      await appClient.query("RESET ROLE");
      appClient.release();
    }
  });

  it("runs an owner no-op with the exact provisioned app login", async () => {
    await expect(
      runMigrations(ownerPool, fixtureMigrationDirectory, [config.appUsername]),
    ).resolves.toEqual({
      discoveredCount: 2,
      previouslyAppliedCount: 0,
      appliedCount: 2,
    });
    await expectOwnerNoOpWithAppLogin();
  });

  it("rejects and recovers from expected-login marker, flag, membership-option, and grant drift", async () => {
    const databaseIdentity = await ownerPool.query<{
      readonly database_oid: string;
    }>(`
      SELECT database_row.oid::text AS database_oid
      FROM pg_catalog.pg_database AS database_row
      WHERE database_row.datname = pg_catalog.current_database()
    `);
    const databaseOid = databaseIdentity.rows[0]?.database_oid;
    if (databaseOid === undefined) {
      throw new Error("PostgreSQL did not return the current database OID");
    }
    const exactMarker = `dasher:app-login:v1:database-oid:${databaseOid}`;

    const driftCases: readonly {
      readonly mutate: () => Promise<void>;
      readonly name: string;
      readonly restore: () => Promise<void>;
    }[] = [
      {
        name: "database marker",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "COMMENT ON ROLE %I IS %L",
              [config.appUsername, "dasher:app-login:v1:database-oid:0"],
            );
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "COMMENT ON ROLE %I IS %L",
              [config.appUsername, exactMarker],
            );
          } finally {
            client.release();
          }
        },
      },
      {
        name: "safe role flag",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(client, "ALTER ROLE %I INHERIT", [
              config.appUsername,
            ]);
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(client, "ALTER ROLE %I NOINHERIT", [
              config.appUsername,
            ]);
          } finally {
            client.release();
          }
        },
      },
      {
        name: "membership option",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "REVOKE dasher_app FROM %I",
              [config.appUsername],
            );
            await executeServerFormattedSql(
              client,
              "GRANT dasher_app TO %I WITH INHERIT TRUE, SET TRUE, ADMIN FALSE",
              [config.appUsername],
            );
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "REVOKE dasher_app FROM %I",
              [config.appUsername],
            );
            await executeServerFormattedSql(
              client,
              "GRANT dasher_app TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE",
              [config.appUsername],
            );
          } finally {
            client.release();
          }
        },
      },
      {
        name: "extra database grant",
        mutate: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "GRANT TEMPORARY ON DATABASE %I TO %I",
              [config.ownerDatabase, config.appUsername],
            );
          } finally {
            client.release();
          }
        },
        restore: async () => {
          const client = await ownerPool.connect();
          try {
            await executeServerFormattedSql(
              client,
              "REVOKE TEMPORARY ON DATABASE %I FROM %I",
              [config.ownerDatabase, config.appUsername],
            );
          } finally {
            client.release();
          }
        },
      },
    ];

    for (const driftCase of driftCases) {
      try {
        await driftCase.mutate();
        await expectMigrationRejection(
          runMigrations(ownerPool, fixtureMigrationDirectory, [
            config.appUsername,
          ]),
          "managed_role_drift",
        );
      } catch (error) {
        throw new Error(`expected-login drift case failed: ${driftCase.name}`, {
          cause: error,
        });
      } finally {
        await driftCase.restore();
      }
      await expectOwnerNoOpWithAppLogin();
    }
  });

  it("confirms forced termination of a tracked sibling backend before dropping only that database", async () => {
    const databaseName = "dasher_t4_" + siblingDatabaseNonce + "_forced_drop";
    let sibling:
      | {
          readonly databaseOid: string;
          readonly pool: Pool;
        }
      | undefined;
    let siblingClient: PoolClient | undefined;
    let ownerGuard: PoolClient | undefined;
    let siblingTerminationError: Error | undefined;
    let operationError: unknown;
    const cleanupErrors: unknown[] = [];

    try {
      sibling = await createSiblingDatabase(databaseName);
      siblingClient = await sibling.pool.connect();
      ownerGuard = await ownerPool.connect();
      siblingClient.on("error", (error) => {
        siblingTerminationError ??= error;
      });
      const siblingBackend = await siblingClient.query<{
        readonly database_oid: string;
      }>(
        "SELECT (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS database_oid",
      );
      expect(siblingBackend.rows[0]?.database_oid).toBe(sibling.databaseOid);
      const ownerBackend = await ownerGuard.query<{
        readonly database_name: string;
        readonly pid: number;
      }>(
        "SELECT pg_catalog.current_database()::text AS database_name, pg_catalog.pg_backend_pid() AS pid",
      );

      const dropped = await dropSiblingDatabase(
        databaseName,
        sibling.databaseOid,
      );
      expect(dropped).toEqual({ forcedTerminationCount: 1 });
      expect(await databaseOidByName(databaseName)).toBeUndefined();
      const disconnectedQuery = await settleDatabasePromise(
        siblingClient.query("SELECT 1"),
      );
      expect(disconnectedQuery.status).toBe("rejected");
      if (
        disconnectedQuery.status === "rejected" &&
        disconnectedQuery.reason instanceof Error
      ) {
        siblingTerminationError ??= disconnectedQuery.reason;
      }
      expect(siblingTerminationError).toBeInstanceOf(Error);
      const terminationDiagnostic =
        (siblingTerminationError?.name ?? "") +
        ":" +
        (siblingTerminationError?.message ?? "");
      expect(terminationDiagnostic).not.toContain("postgres://");
      expect(terminationDiagnostic).not.toContain("password");
      expect(
        await ownerGuard.query(
          "SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.current_database()::text AS database_name",
        ),
      ).toMatchObject({
        rows: [ownerBackend.rows[0]],
      });
    } catch (error) {
      operationError = error;
    } finally {
      if (siblingClient !== undefined) {
        try {
          siblingClient.release(siblingTerminationError ?? true);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (sibling !== undefined) {
        try {
          await sibling.pool.end();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (ownerGuard !== undefined) {
        try {
          ownerGuard.release();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        const residualOid = await databaseOidByName(databaseName);
        if (residualOid !== undefined) {
          await dropSiblingDatabase(databaseName, residualOid);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (operationError !== undefined && cleanupErrors.length !== 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "forced sibling-database operation and cleanup failed",
      );
    }
    if (operationError !== undefined) throw operationError;
    if (cleanupErrors.length !== 0) {
      throw new AggregateError(
        cleanupErrors,
        "forced sibling-database cleanup failed",
      );
    }
  });

  it("rejects a managed-role-owned object in a sibling database and removes all residue", async () => {
    const databaseName = `dasher_t4_${siblingDatabaseNonce}_owned`;
    let sibling:
      | {
          readonly databaseOid: string;
          readonly pool: Pool;
        }
      | undefined;

    try {
      sibling = await createSiblingDatabase(databaseName);
      await sibling.pool.query(
        "CREATE SCHEMA sibling_owned AUTHORIZATION dasher_security_definer",
      );
      expect(Number(await managedDependencyCount(sibling.databaseOid))).toBe(1);
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, [
          config.appUsername,
        ]),
        "managed_role_drift",
      );
    } finally {
      if (sibling !== undefined) {
        try {
          await sibling.pool.query(
            "DROP SCHEMA IF EXISTS sibling_owned CASCADE",
          );
        } finally {
          try {
            await sibling.pool.end();
          } finally {
            try {
              expect(await managedDependencyCount(sibling.databaseOid)).toBe(
                "0",
              );
            } finally {
              await dropSiblingDatabase(databaseName, sibling.databaseOid);
            }
          }
        }
      } else {
        const residualOid = await databaseOidByName(databaseName);
        if (residualOid !== undefined) {
          await dropSiblingDatabase(databaseName, residualOid);
        }
      }
    }
    await expectOwnerNoOpWithAppLogin();
  });

  it("rejects a managed-role ACL in a sibling database and removes all residue", async () => {
    const databaseName = `dasher_t4_${siblingDatabaseNonce}_acl`;
    let sibling:
      | {
          readonly databaseOid: string;
          readonly pool: Pool;
        }
      | undefined;

    try {
      sibling = await createSiblingDatabase(databaseName);
      await sibling.pool.query(
        "CREATE TABLE public.sibling_probe (probe_id integer PRIMARY KEY)",
      );
      await sibling.pool.query(
        "GRANT SELECT ON TABLE public.sibling_probe TO dasher_app",
      );
      expect(Number(await managedDependencyCount(sibling.databaseOid))).toBe(1);
      await expectMigrationRejection(
        runMigrations(ownerPool, fixtureMigrationDirectory, [
          config.appUsername,
        ]),
        "managed_role_drift",
      );
    } finally {
      if (sibling !== undefined) {
        try {
          await sibling.pool.query(
            "REVOKE SELECT ON TABLE public.sibling_probe FROM dasher_app",
          );
          await sibling.pool.query("DROP TABLE IF EXISTS public.sibling_probe");
        } finally {
          try {
            await sibling.pool.end();
          } finally {
            try {
              expect(await managedDependencyCount(sibling.databaseOid)).toBe(
                "0",
              );
            } finally {
              await dropSiblingDatabase(databaseName, sibling.databaseOid);
            }
          }
        }
      } else {
        const residualOid = await databaseOidByName(databaseName);
        if (residualOid !== undefined) {
          await dropSiblingDatabase(databaseName, residualOid);
        }
      }
    }
    await expectOwnerNoOpWithAppLogin();
  });
});

const canonicalTables = [
  "audit_events",
  "external_identities",
  "invitations",
  "memberships",
  "organizations",
  "sessions",
  "users",
] as const;

const task4Functions = [
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

const expectedColumns = [
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

const expectedRelationConstraints = [
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

const expectedForeignKeys = [
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

const expectedIndexes = [
  "audit_events|audit_events_actor_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,actor_user_id}|{uuid_ops,uuid_ops}|0 0",
  "audit_events|audit_events_occurred_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,occurred_at,audit_event_id}|{uuid_ops,timestamptz_ops,uuid_ops}|0 0 0",
  "audit_events|audit_events_org_id_key|btree|true|false|true|true|true|false|false|<none>|{organization_id,audit_event_id}|{uuid_ops,uuid_ops}|0 0",
  "audit_events|audit_events_pkey|btree|true|true|true|true|true|false|false|<none>|{audit_event_id}|{uuid_ops}|0",
  "external_identities|external_identities_pkey|btree|true|true|true|true|true|false|false|<none>|{issuer,subject}|{text_ops,text_ops}|0 0",
  "external_identities|external_identities_user_key|btree|true|false|true|true|true|false|false|<none>|{user_id}|{uuid_ops}|0",
  "invitations|invitations_accepted_user_idx|btree|false|false|true|true|true|false|false|<none>|{accepted_user_id}|{uuid_ops}|0",
  "invitations|invitations_creator_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,created_by_user_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_email_created_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,normalized_email,created_at}|{uuid_ops,text_ops,timestamptz_ops}|0 0 3",
  "invitations|invitations_org_id_key|btree|true|false|true|true|true|false|false|<none>|{organization_id,invitation_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_pkey|btree|true|true|true|true|true|false|false|<none>|{invitation_id}|{uuid_ops}|0",
  "invitations|invitations_revoker_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,revoked_by_user_id}|{uuid_ops,uuid_ops}|0 0",
  "invitations|invitations_token_key|btree|true|false|true|true|true|false|false|<none>|{token_key_version,token_digest}|{int2_ops,bytea_ops}|0 0",
  "memberships|memberships_active_authority_idx|btree|false|false|true|true|true|false|false|((state)::text = 'active'::text)|{organization_id,user_id,authority_revision}|{uuid_ops,uuid_ops,int8_ops}|0 0 0",
  "memberships|memberships_org_membership_key|btree|true|false|true|true|true|false|false|<none>|{organization_id,membership_id}|{uuid_ops,uuid_ops}|0 0",
  "memberships|memberships_org_user_key|btree|true|false|true|true|true|false|false|<none>|{organization_id,user_id}|{uuid_ops,uuid_ops}|0 0",
  "memberships|memberships_pkey|btree|true|true|true|true|true|false|false|<none>|{membership_id}|{uuid_ops}|0",
  "memberships|memberships_user_idx|btree|false|false|true|true|true|false|false|<none>|{user_id}|{uuid_ops}|0",
  "organizations|organizations_pkey|btree|true|true|true|true|true|false|false|<none>|{organization_id}|{uuid_ops}|0",
  "sessions|sessions_csrf_key|btree|true|false|true|true|true|false|false|<none>|{csrf_key_version,csrf_digest}|{int2_ops,bytea_ops}|0 0",
  "sessions|sessions_live_user_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,user_id,revoked_at}|{uuid_ops,uuid_ops,timestamptz_ops}|0 0 0",
  "sessions|sessions_org_id_key|btree|true|false|true|true|true|false|false|<none>|{organization_id,session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_pkey|btree|true|true|true|true|true|false|false|<none>|{session_id}|{uuid_ops}|0",
  "sessions|sessions_replaced_by_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,replaced_by_session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_rotated_from_idx|btree|false|false|true|true|true|false|false|<none>|{organization_id,rotated_from_session_id}|{uuid_ops,uuid_ops}|0 0",
  "sessions|sessions_token_key|btree|true|false|true|true|true|false|false|<none>|{token_key_version,token_digest}|{int2_ops,bytea_ops}|0 0",
  "users|users_pkey|btree|true|true|true|true|true|false|false|<none>|{user_id}|{uuid_ops}|0",
] as const;

const ownerTableAcl =
  "OWNER:DELETE:false,OWNER:INSERT:false,OWNER:REFERENCES:false,OWNER:SELECT:false,OWNER:TRIGGER:false,OWNER:TRUNCATE:false,OWNER:UPDATE:false";

const expectedObjectAcls = [
  `database|current_database|OWNER:CONNECT:false,OWNER:CREATE:false,OWNER:TEMPORARY:false,PUBLIC:CONNECT:false,dasher_app:CONNECT:false,${config.appUsername}:CONNECT:false`,
  ...task4Functions.map(
    ({ identity }) =>
      `function|${identity}|OWNER:EXECUTE:false,dasher_app:EXECUTE:false`,
  ),
  "function|dasher_private.reject_immutable_mutation()|OWNER:EXECUTE:false",
  "schema|dasher|OWNER:CREATE:false,OWNER:USAGE:false,dasher_app:USAGE:false,dasher_security_definer:USAGE:false",
  "schema|dasher_api|OWNER:CREATE:false,OWNER:USAGE:false,dasher_app:USAGE:false",
  "schema|dasher_meta|OWNER:CREATE:false,OWNER:USAGE:false",
  "schema|dasher_private|OWNER:CREATE:false,OWNER:USAGE:false,dasher_security_definer:USAGE:false",
  "schema|public|OWNER:CREATE:false,OWNER:USAGE:false,PUBLIC:USAGE:false",
  ...canonicalTables.map((table) => `table|dasher.${table}|${ownerTableAcl}`),
  `table|dasher_meta.schema_migrations|${ownerTableAcl}`,
].sort();

async function readForeignKeys(
  client: Pick<PoolClient, "query"> = ownerPool,
): Promise<readonly string[]> {
  const result = await client.query<{ readonly signature: string }>(`
    SELECT
      source_namespace.nspname || '.' || source_relation.relname || '|' ||
      constraint_row.conname || '|' ||
      target_namespace.nspname || '.' || target_relation.relname || '|' ||
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
      )::text || '|' ||
      pg_catalog.cardinality(constraint_row.conkey)::text || '|' ||
      constraint_row.confmatchtype::text ||
      constraint_row.confupdtype::text ||
      constraint_row.confdeltype::text || '|' ||
      constraint_row.convalidated::text || '|' ||
      constraint_row.condeferrable::text || '|' ||
      constraint_row.condeferred::text AS signature
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_class AS source_relation
      ON source_relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace AS source_namespace
      ON source_namespace.oid = source_relation.relnamespace
    JOIN pg_catalog.pg_class AS target_relation
      ON target_relation.oid = constraint_row.confrelid
    JOIN pg_catalog.pg_namespace AS target_namespace
      ON target_namespace.oid = target_relation.relnamespace
    WHERE source_namespace.nspname = 'dasher'
      AND constraint_row.contype = 'f'
    ORDER BY source_relation.relname, constraint_row.conname
  `);
  return result.rows.map((row) => row.signature);
}

async function expectPostgresDenial(
  client: PoolClient,
  sql: string,
  parameters?: readonly unknown[],
): Promise<void> {
  try {
    await client.query(
      sql,
      parameters === undefined ? undefined : [...parameters],
    );
  } catch (error) {
    expect(error).toMatchObject({ code: "42501" });
    return;
  }
  throw new Error(`expected PostgreSQL privilege denial for: ${sql}`);
}

async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected PostgreSQL error ${code}`);
}

async function expectDasherBoundaryError(
  operation: Promise<unknown>,
  code: "P1001" | "P1002",
  message: "dasher_denied" | "dasher_conflict",
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code, message });
    const sensitiveDiagnosticFields = [
      "detail",
      "hint",
      "constraint",
      "schema",
      "table",
      "column",
      "dataType",
      "internalQuery",
    ] as const;
    for (const field of sensitiveDiagnosticFields) {
      expect(
        (error as Readonly<Record<string, unknown>>)[field],
      ).toBeUndefined();
    }
    return;
  }
  throw new Error(`expected Task 4 boundary error ${code}`);
}

async function runContextOperation<T>(
  client: PoolClient,
  sessionDigest: Buffer,
  requestId: string,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      `
        SELECT *
        FROM dasher_api.initialize_context(
          1::smallint,
          $1::bytea,
          $2::uuid
        )
      `,
      [sessionDigest, requestId],
    );
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function beginTask4Context(
  client: PoolClient,
  sessionDigest: Buffer,
  requestId = randomUUID(),
): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `
      SELECT *
      FROM dasher_api.initialize_context(
        1::smallint,
        $1::bytea,
        $2::uuid
      )
    `,
    [sessionDigest, requestId],
  );
}

interface Task4Actor {
  readonly csrfDigest: Buffer;
  readonly identityIssuer: string;
  readonly identitySubject: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly sessionDigest: Buffer;
  readonly sessionId: string;
  readonly userId: string;
}

async function createTask4Actor(
  appClient: PoolClient,
  role: "admin" | "editor" | "viewer",
  organizationId?: string,
  credentials?: Readonly<{
    csrfDigest: Buffer;
    sessionDigest: Buffer;
  }>,
): Promise<Task4Actor> {
  const actor = {
    csrfDigest: credentials?.csrfDigest ?? randomBytes(32),
    identityIssuer: "https://task4-fixture.test",
    identitySubject: randomUUID(),
    membershipId: randomUUID(),
    organizationId: organizationId ?? randomUUID(),
    sessionDigest: credentials?.sessionDigest ?? randomBytes(32),
    sessionId: randomUUID(),
    userId: randomUUID(),
  };

  await ownerPool.query(
    "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
    [actor.userId],
  );
  await ownerPool.query(
    `
      INSERT INTO dasher.external_identities (
        issuer,
        subject,
        user_id
      ) VALUES ($1, $2, $3::uuid)
    `,
    [actor.identityIssuer, actor.identitySubject, actor.userId],
  );
  if (organizationId === undefined) {
    await ownerPool.query(
      `
        INSERT INTO dasher.organizations (
          organization_id,
          display_name
        ) VALUES ($1::uuid, $2)
      `,
      [actor.organizationId, `Task 4 ${actor.organizationId}`],
    );
  }
  await ownerPool.query(
    `
      INSERT INTO dasher.memberships (
        membership_id,
        organization_id,
        user_id,
        role,
        state,
        authority_revision
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', 1)
    `,
    [actor.membershipId, actor.organizationId, actor.userId, role],
  );
  await appClient.query(
    `
      SELECT *
      FROM dasher_api.issue_session(
        $1,
        $2,
        $3::uuid,
        $4::uuid,
        1::smallint,
        $5::bytea,
        1::smallint,
        $6::bytea,
        $7::uuid,
        $8::uuid,
        'task4-test'
      )
    `,
    [
      actor.identityIssuer,
      actor.identitySubject,
      actor.membershipId,
      actor.sessionId,
      actor.sessionDigest,
      actor.csrfDigest,
      randomUUID(),
      randomUUID(),
    ],
  );
  return actor;
}

async function waitForDatabaseLock(
  observer: PoolClient,
  backendPid: number,
  waitEvent:
    | "advisory"
    | "relation"
    | "transactionid"
    | "tuple"
    | ReadonlyArray<"advisory" | "relation" | "transactionid" | "tuple">,
  settledOperation: SettledDatabasePromise<unknown>,
): Promise<void> {
  const waitEvents = typeof waitEvent === "string" ? [waitEvent] : waitEvent;
  const settledSignal = settledOperation.then((result) => ({
    kind: "settled" as const,
    result,
  }));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const observation = await Promise.race([
      observer
        .query<{
          readonly waiting: boolean;
        }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_stat_activity AS activity
              WHERE activity.pid = $1
                AND activity.wait_event_type = 'Lock'
                AND activity.wait_event = ANY($2::text[])
            ) AS waiting
          `,
          [backendPid, waitEvents],
        )
        .then((state) => ({
          kind: "lock" as const,
          waiting: state.rows[0]?.waiting === true,
        })),
      settledSignal,
    ]);
    if (observation.kind === "settled") {
      throw new Error(
        `database operation ${observation.result.status} before reaching ${waitEvents.join("/")} lock barrier`,
      );
    }
    if (observation.waiting) {
      return;
    }
    const pause = await Promise.race([
      new Promise<"poll">((resolve) => setTimeout(() => resolve("poll"), 5)),
      settledSignal,
    ]);
    if (pause !== "poll") {
      throw new Error(
        `database operation ${pause.result.status} before reaching ${waitEvents.join("/")} lock barrier`,
      );
    }
  }
  throw new Error(`backend did not reach ${waitEvents.join("/")} lock barrier`);
}

async function appBackendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ readonly pid: number }>(
    "SELECT pg_catalog.pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("PostgreSQL did not return backend PID");
  }
  return pid;
}

type SettledDatabasePromise<T> = Promise<PromiseSettledResult<T>>;

function settleDatabasePromise<T>(
  promise: Promise<T>,
): SettledDatabasePromise<T> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ reason, status: "rejected" }),
  );
}

function retainDatabasePromise<T>(
  retainedOperations: Array<SettledDatabasePromise<unknown>>,
  promise: Promise<T>,
): SettledDatabasePromise<T> {
  const settled = settleDatabasePromise(promise);
  retainedOperations.push(settled);
  return settled;
}

interface Task4Invitation {
  readonly auditEventId: string;
  readonly invitationId: string;
  readonly normalizedEmail: string;
  readonly requestId: string;
  readonly tokenDigest: Buffer;
}

async function issueTask4Invitation(
  client: PoolClient,
  actor: Task4Actor,
  normalizedEmail: string,
  overrides: Partial<Task4Invitation> = {},
): Promise<Task4Invitation> {
  const invitation = {
    auditEventId: overrides.auditEventId ?? randomUUID(),
    invitationId: overrides.invitationId ?? randomUUID(),
    normalizedEmail,
    requestId: overrides.requestId ?? randomUUID(),
    tokenDigest: overrides.tokenDigest ?? randomBytes(32),
  };
  await client.query(
    `
      SELECT *
      FROM dasher_api.issue_invitation(
        $1::uuid,
        $2,
        'viewer',
        1::smallint,
        $3::bytea,
        $4::uuid,
        1::smallint,
        $5::bytea,
        1::smallint,
        $6::bytea,
        $7::uuid,
        'task4-race'
      )
    `,
    [
      invitation.invitationId,
      invitation.normalizedEmail,
      invitation.tokenDigest,
      invitation.auditEventId,
      actor.sessionDigest,
      actor.csrfDigest,
      invitation.requestId,
    ],
  );
  return invitation;
}

interface Task4Acceptance {
  readonly auditEventId: string;
  readonly csrfDigest: Buffer;
  readonly membershipId: string;
  readonly requestId: string;
  readonly sessionDigest: Buffer;
  readonly sessionId: string;
  readonly userId: string;
}

async function acceptTask4Invitation(
  client: PoolClient,
  invitation: Task4Invitation,
  issuer: string,
  subject: string,
  overrides: Partial<Task4Acceptance> = {},
): Promise<Task4Acceptance> {
  const acceptance = {
    auditEventId: overrides.auditEventId ?? randomUUID(),
    csrfDigest: overrides.csrfDigest ?? randomBytes(32),
    membershipId: overrides.membershipId ?? randomUUID(),
    requestId: overrides.requestId ?? randomUUID(),
    sessionDigest: overrides.sessionDigest ?? randomBytes(32),
    sessionId: overrides.sessionId ?? randomUUID(),
    userId: overrides.userId ?? randomUUID(),
  };
  await client.query(
    `
      SELECT *
      FROM dasher_api.accept_invitation(
        1::smallint,
        $1::bytea,
        $2,
        $3,
        $4,
        true,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        1::smallint,
        $8::bytea,
        1::smallint,
        $9::bytea,
        $10::uuid,
        $11::uuid,
        'task4-race'
      )
    `,
    [
      invitation.tokenDigest,
      issuer,
      subject,
      invitation.normalizedEmail,
      acceptance.userId,
      acceptance.membershipId,
      acceptance.sessionId,
      acceptance.sessionDigest,
      acceptance.csrfDigest,
      acceptance.auditEventId,
      acceptance.requestId,
    ],
  );
  return acceptance;
}

function createTask6KeyRing(): SecretKeyRing {
  return new SecretKeyRing({
    currentVersion: 1,
    verificationKeys: [
      {
        version: 1,
        key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      },
      {
        version: 2,
        key: Uint8Array.from({ length: 32 }, (_, index) => index + 65),
      },
    ],
    retiredVersions: [3],
  });
}

function task6BorrowedPool(client: PoolClient): PgCompatiblePool {
  return {
    async connect() {
      return {
        async query(text: string, values?: readonly unknown[]) {
          return client.query(
            text,
            values === undefined ? undefined : [...values],
          );
        },
        release() {
          // The integration test owns the role-configured client.
        },
      };
    },
  };
}

function task6UuidSource(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("Task 6 integration UUID source exhausted");
    }
    return value;
  };
}

function createTask6Repository(
  client: PoolClient,
  keyRing: SecretKeyRing,
  uuidValues: readonly string[],
  events: Array<Readonly<{ requestId: string; reason: string }>> = [],
): InvitationRepository {
  return new InvitationRepository({
    pool: task6BorrowedPool(client),
    keyRing,
    deploymentRevision: "task6-repository-integration",
    securityEventSink: (event) => {
      events.push(event);
    },
    uuidSource: task6UuidSource(uuidValues),
  });
}

function createTask7Repository(
  client: PoolClient,
  keyRing: SecretKeyRing,
  uuidValues: readonly string[],
  events: Array<Readonly<{ requestId: string; reason: string }>> = [],
): SessionRepository {
  return new SessionRepository({
    pool: task6BorrowedPool(client),
    keyRing,
    deploymentRevision: "task7-repository-integration",
    securityEventSink: (event) => {
      events.push(event);
      return true;
    },
    uuidSource: task6UuidSource(uuidValues),
  });
}

function createTask8cRepository(
  client: PoolClient,
  keyRing: SecretKeyRing,
  uuidValues: readonly string[],
): DashboardLifecycleRepository {
  return new DashboardLifecycleRepository({
    pool: task6BorrowedPool(client),
    keyRing,
    deploymentRevision: "task8c-repository-integration",
    uuidSource: task6UuidSource(uuidValues),
  });
}

function task7Principal(actor: Task4Actor) {
  return task6Principal(
    `task7-${actor.userId}@example.test`,
    actor.identityIssuer,
    actor.identitySubject,
  );
}

function task6Principal(
  email: string,
  issuer: string = "https://task6-provider.test/immutable",
  subject: string = randomUUID(),
) {
  return createVerifiedPrincipalFromServerVerification({
    issuer,
    subject,
    emailVerified: true,
    verifiedEmail: email,
  });
}

function invitationFamilyLockSql(): string {
  return `
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'dasher:invitation-family:v1:'::text
          || $1::uuid::text
          || ':'::text
          || $2,
        20260730::bigint
      )
    )
  `;
}

async function expectTask4OrganizationKeysDistinct(
  organizationA: string,
  organizationB: string,
): Promise<void> {
  const keys = await ownerPool.query<{
    readonly key_a: string;
    readonly key_b: string;
  }>(
    `
      SELECT
        pg_catalog.hashtextextended(
          'dasher:task4-organization:v1:' || $1::uuid::text,
          20260730::bigint
        )::text AS key_a,
        pg_catalog.hashtextextended(
          'dasher:task4-organization:v1:' || $2::uuid::text,
          20260730::bigint
        )::text AS key_b
    `,
    [organizationA, organizationB],
  );
  expect(keys.rows[0]?.key_a).not.toBe(keys.rows[0]?.key_b);
}

async function issueAdditionalTask4Session(
  client: PoolClient,
  actor: Task4Actor,
  sessionId: string,
): Promise<{ readonly csrfDigest: Buffer; readonly sessionDigest: Buffer }> {
  const proof = {
    csrfDigest: randomBytes(32),
    sessionDigest: randomBytes(32),
  };
  await client.query(
    `
      SELECT *
      FROM dasher_api.issue_session(
        $1,
        $2,
        $3::uuid,
        $4::uuid,
        1::smallint,
        $5::bytea,
        1::smallint,
        $6::bytea,
        $7::uuid,
        $8::uuid,
        'task4-race'
      )
    `,
    [
      actor.identityIssuer,
      actor.identitySubject,
      actor.membershipId,
      sessionId,
      proof.sessionDigest,
      proof.csrfDigest,
      randomUUID(),
      randomUUID(),
    ],
  );
  return proof;
}

async function setTask4ContextGucs(
  client: PoolClient,
  actor: Task4Actor,
  requestId: string,
): Promise<void> {
  for (const [name, value] of [
    ["dasher.context_session_id", actor.sessionId],
    ["dasher.context_user_id", actor.userId],
    ["dasher.context_organization_id", actor.organizationId],
    ["dasher.context_membership_id", actor.membershipId],
    ["dasher.context_authority_revision", "1"],
    ["dasher.context_session_key_version", "1"],
    ["dasher.context_session_digest_hex", actor.sessionDigest.toString("hex")],
    ["dasher.context_request_id", requestId],
  ] as const) {
    await client.query("SELECT pg_catalog.set_config($1, $2, true)", [
      name,
      value,
    ]);
  }
}

const task4AuditColumnsSql = `
  audit_event_id,
  organization_id,
  occurred_at,
  actor_kind,
  actor_user_id,
  actor_service,
  authority_revision,
  request_id,
  job_id,
  action,
  target_type,
  target_id,
  outcome,
  content_sha256,
  source_ref,
  provider,
  credential_version,
  usage_units,
  cost_minor_units,
  deployment_revision
`;

describe.sequential(
  "Task 3 and Task 4 canonical identity and security boundary",
  () => {
    beforeAll(async () => {
      await closeAppPoolBeforeLoginTeardown();
      if (appLoginCreated) {
        await dropTemporaryAppLogin(
          ownerPool,
          config.appDatabase,
          config.appUsername,
        );
        appLoginCreated = false;
      }

      await resetManagedSchemas();
      await createTemporaryAppLogin(
        ownerPool,
        config.appDsn,
        config.appUsername,
      );
      appLoginCreated = true;
      canonicalFirstRun = await runMigrations(
        ownerPool,
        canonical0002MigrationDirectory,
        [config.appUsername],
      );
      canonicalSecondRun = await runMigrations(
        ownerPool,
        canonical0002MigrationDirectory,
        [config.appUsername],
      );
      appPool = new Pool({ connectionString: config.appDsn, max: 4 });
    });

    it("applies exactly immutable 0001 and 0002 and repeats as a no-op", async () => {
      expect(canonicalFirstRun).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 0,
        appliedCount: 2,
      });
      expect(canonicalSecondRun).toEqual({
        discoveredCount: 2,
        previouslyAppliedCount: 2,
        appliedCount: 0,
      });

      const journal = await ownerPool.query<{
        readonly checksum: string;
        readonly filename: string;
        readonly sequence: number;
      }>(`
      SELECT
        sequence,
        filename,
        pg_catalog.encode(checksum_sha256, 'hex') AS checksum
      FROM dasher_meta.schema_migrations
      ORDER BY sequence
    `);
      expect(journal.rows).toEqual([
        {
          sequence: 1,
          filename: "0001_identity_audit.sql",
          checksum:
            "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
        },
        {
          sequence: 2,
          filename: "0002_security_boundary.sql",
          checksum:
            "395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9",
        },
      ]);
    });

    it("pins the exact Task 4 functions, owners, execution properties, returns, ACLs, and source", async () => {
      const migrations = await discoverMigrations(
        canonical0002MigrationDirectory,
      );
      const source = migrations[1]?.sql ?? "";
      const sourceBodies = new Map<string, string>();
      const sourcePattern =
        /CREATE FUNCTION ([^(]+)\([\s\S]*?\)\nRETURNS[\s\S]*?\nAS \$function\$([\s\S]*?)\$function\$;/gu;
      for (const match of source.matchAll(sourcePattern)) {
        const identity = match[1]?.trim();
        const body = match[2];
        if (identity !== undefined && body !== undefined) {
          sourceBodies.set(identity, body);
        }
      }
      expect(sourceBodies.size).toBe(16);

      const functions = await ownerPool.query<{
        readonly acl: string[];
        readonly body: string;
        readonly identity: string;
        readonly language: string;
        readonly owner: string;
        readonly proconfig: string[];
        readonly result: string;
        readonly security_definer: boolean;
        readonly volatility: string;
      }>(`
        SELECT
          namespace.nspname || '.' || routine.proname || '(' ||
            pg_catalog.oidvectortypes(routine.proargtypes) || ')'
            AS identity,
          pg_catalog.pg_get_function_result(routine.oid) AS result,
          owner.rolname AS owner,
          routine.prosecdef AS security_definer,
          language.lanname AS language,
          routine.provolatile::text AS volatility,
          routine.proconfig,
          routine.prosrc AS body,
          ARRAY(
            SELECT
              CASE
                WHEN privilege.grantee = routine.proowner THEN 'OWNER'
                WHEN privilege.grantee = 0 THEN 'PUBLIC'
                ELSE grantee.rolname
              END || ':' || privilege.privilege_type || ':' ||
              privilege.is_grantable::text
            FROM pg_catalog.aclexplode(
              COALESCE(
                routine.proacl,
                pg_catalog.acldefault('f', routine.proowner)
              )
            ) AS privilege
            LEFT JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = privilege.grantee
            ORDER BY 1
          ) AS acl
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = routine.pronamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
        JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
        WHERE namespace.nspname IN ('dasher_api', 'dasher_private')
          AND owner.rolname = 'dasher_security_definer'
        ORDER BY identity
      `);

      expect(
        functions.rows.map((row) => ({
          identity: row.identity,
          result: row.result,
          volatility: row.volatility,
        })),
      ).toEqual(task4Functions);
      for (const row of functions.rows) {
        expect(row).toMatchObject({
          owner: "dasher_security_definer",
          security_definer: true,
          language: "plpgsql",
          proconfig: ["search_path=pg_catalog"],
          acl: ["OWNER:EXECUTE:false", "dasher_app:EXECUTE:false"],
        });
        const functionName = row.identity.slice(0, row.identity.indexOf("("));
        expect(row.body).toBe(sourceBodies.get(functionName));
        expect(row.body).not.toMatch(/\bEXECUTE\b/u);
      }

      expect(
        source.match(/'dasher:task4-organization:v1:'::text/gu),
      ).toHaveLength(9);
      expect(
        source.match(/'dasher:invitation-family:v1:'::text/gu),
      ).toHaveLength(3);
      expect(source.match(/FOR v_advisory_key IN/gu)).toHaveLength(3);
      for (const [identity, proposedParameter] of [
        ["dasher_api.accept_invitation", "p_new_session_id"],
        ["dasher_api.issue_session", "p_session_id"],
        ["dasher_api.rotate_session", "p_successor_session_id"],
      ] as const) {
        const body = sourceBodies.get(identity) ?? "";
        const lockStatements = body
          .split(";")
          .filter(
            (statement) =>
              statement.includes("FOR UPDATE") ||
              statement.includes("pg_advisory_xact_lock"),
          );
        expect(body).toContain("AS session_collision");
        expect(body).toContain("v_constraint_name = CONSTRAINT_NAME");
        expect(body).toContain("'sessions_pkey'");
        expect(body).toContain("'sessions_token_key'");
        expect(body).toContain("'sessions_csrf_key'");
        for (const statement of lockStatements) {
          expect(statement).not.toContain(proposedParameter);
        }
      }
    });

    it("pins the exact five permissive app SELECT policies and no write policy", async () => {
      const policies = await ownerPool.query<{
        readonly command: string;
        readonly permissive: boolean;
        readonly policy_name: string;
        readonly roles: string[];
        readonly table_name: string;
        readonly using_expression: string;
        readonly with_check: string | null;
      }>(`
        SELECT
          relation.relname AS table_name,
          policy.polname AS policy_name,
          policy.polpermissive AS permissive,
          policy.polcmd::text AS command,
          ARRAY(
            SELECT role_row.rolname::text
            FROM pg_catalog.unnest(policy.polroles) AS role_oid
            JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = role_oid
            ORDER BY role_row.rolname
          )::text[] AS roles,
          pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
            AS using_expression,
          pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
            AS with_check
        FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'dasher'
        ORDER BY relation.relname
      `);
      expect(policies.rows).toEqual([
        {
          table_name: "audit_events",
          policy_name: "audit_events_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'admin'::text)",
          with_check: null,
        },
        {
          table_name: "invitations",
          policy_name: "invitations_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'admin'::text)",
          with_check: null,
        },
        {
          table_name: "memberships",
          policy_name: "memberships_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'viewer'::text)",
          with_check: null,
        },
        {
          table_name: "organizations",
          policy_name: "organizations_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "dasher_private.context_allows(organization_id, 'viewer'::text)",
          with_check: null,
        },
        {
          table_name: "sessions",
          policy_name: "sessions_select",
          permissive: true,
          command: "r",
          roles: ["dasher_app"],
          using_expression:
            "(dasher_private.context_allows(organization_id, 'viewer'::text) AND (dasher_private.context_user_id() = user_id))",
          with_check: null,
        },
      ]);
    });

    it("pins the exact 180 operation-specific column grants and no managed table grant", async () => {
      const grants = await ownerPool.query<{
        readonly grant_count: string;
        readonly grantee: string;
        readonly privilege_type: string;
      }>(`
        SELECT
          grantee.rolname AS grantee,
          privilege.privilege_type,
          pg_catalog.count(*)::text AS grant_count
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE namespace.nspname = 'dasher'
          AND grantee.rolname IN (
            'dasher_app',
            'dasher_security_definer'
          )
        GROUP BY grantee.rolname, privilege.privilege_type
        ORDER BY grantee.rolname, privilege.privilege_type
      `);
      expect(grants.rows).toEqual([
        {
          grantee: "dasher_app",
          privilege_type: "SELECT",
          grant_count: "56",
        },
        {
          grantee: "dasher_security_definer",
          privilege_type: "INSERT",
          grant_count: "65",
        },
        {
          grantee: "dasher_security_definer",
          privilege_type: "SELECT",
          grant_count: "45",
        },
        {
          grantee: "dasher_security_definer",
          privilege_type: "UPDATE",
          grant_count: "14",
        },
      ]);

      const tableGrants = await ownerPool.query<{ readonly count: string }>(`
        SELECT pg_catalog.count(*)::text AS count
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE namespace.nspname = 'dasher'
          AND grantee.rolname IN (
            'dasher_app',
            'dasher_security_definer'
          )
      `);
      expect(tableGrants.rows[0]?.count).toBe("0");
    });

    it("preserves the exact owner-owned tables, columns, defaults, and forced RLS", async () => {
      const schemas = await ownerPool.query<{
        readonly owner_matches: boolean;
        readonly schema_name: string;
      }>(`
      SELECT
        namespace.nspname AS schema_name,
        owner.rolname = session_user AS owner_matches
      FROM pg_catalog.pg_namespace AS namespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname LIKE 'dasher%'
      ORDER BY namespace.nspname
    `);
      expect(schemas.rows).toEqual([
        { schema_name: "dasher", owner_matches: true },
        { schema_name: "dasher_api", owner_matches: true },
        { schema_name: "dasher_meta", owner_matches: true },
        { schema_name: "dasher_private", owner_matches: true },
      ]);

      const tables = await ownerPool.query<{
        readonly force_rls: boolean;
        readonly owner_matches: boolean;
        readonly policy_count: string;
        readonly rls: boolean;
        readonly table_name: string;
      }>(`
      SELECT
        relation.relname AS table_name,
        owner.rolname = session_user AS owner_matches,
        relation.relrowsecurity AS rls,
        relation.relforcerowsecurity AS force_rls,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = relation.oid
        ) AS policy_count
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
      WHERE namespace.nspname = 'dasher'
        AND relation.relkind = 'r'
      ORDER BY relation.relname
    `);
      expect(tables.rows).toEqual(
        canonicalTables.map((table_name) => ({
          table_name,
          owner_matches: true,
          rls: true,
          force_rls: true,
          policy_count: ["users", "external_identities"].includes(table_name)
            ? "0"
            : "1",
        })),
      );

      const columns = await ownerPool.query<{ readonly signature: string }>(`
      SELECT
        relation.relname || '|' ||
        attribute.attnum::text || '|' ||
        attribute.attname || '|' ||
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
        attribute.attnotnull::text || '|' ||
        COALESCE(
          pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid),
          '<none>'
        ) AS signature
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = 'dasher'
        AND relation.relkind = 'r'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attnum
    `);
      expect(columns.rows.map((row) => row.signature)).toEqual(expectedColumns);
    });

    it("pins relation-scoped primary, unique, and CHECK definitions", async () => {
      const constraints = await ownerPool.query<{
        readonly signature: string;
      }>(`
      SELECT
        relation.relname || '|' ||
        constraint_row.conname || '|' ||
        constraint_row.contype::text || '|' ||
        pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
          '[[:space:]]+',
          ' ',
          'g'
        ) || '|' ||
        constraint_row.convalidated::text AS signature
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'dasher'
        AND constraint_row.contype IN ('p', 'u', 'c')
      ORDER BY relation.relname, constraint_row.contype, constraint_row.conname
    `);
      expect(constraints.rows.map((row) => row.signature)).toEqual(
        expectedRelationConstraints,
      );
    });

    it("rejects NaN and negative audit usage while accepting finite nonnegative values", async () => {
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        try {
          const organizationId = "00000000-0000-4000-8000-000000004000";
          await client.query(
            `
              INSERT INTO dasher.organizations (organization_id, display_name)
              VALUES ($1, 'Synthetic Task 3 Usage Organization')
            `,
            [organizationId],
          );

          const insertAuditUsage = (suffix: string, usageUnits: string) =>
            client.query(
              `
                INSERT INTO dasher.audit_events (
                  audit_event_id,
                  organization_id,
                  actor_kind,
                  actor_service,
                  authority_revision,
                  request_id,
                  action,
                  target_type,
                  target_id,
                  outcome,
                  usage_units,
                  deployment_revision
                ) VALUES (
                  $1,
                  $2,
                  'service',
                  'task3-usage-test',
                  1,
                  $3,
                  'session.issued',
                  'session',
                  $4,
                  'succeeded',
                  $5::numeric,
                  'synthetic-task3'
                )
              `,
              [
                `00000000-0000-4000-8000-0000000041${suffix}`,
                organizationId,
                `00000000-0000-4000-8000-0000000042${suffix}`,
                `00000000-0000-4000-8000-0000000043${suffix}`,
                usageUnits,
              ],
            );

          await client.query("SAVEPOINT reject_nan_usage");
          await expect(insertAuditUsage("01", "NaN")).rejects.toMatchObject({
            code: "23514",
            constraint: "audit_events_usage_units_check",
          });
          await client.query("ROLLBACK TO SAVEPOINT reject_nan_usage");

          await client.query("SAVEPOINT reject_negative_usage");
          await expect(
            insertAuditUsage("02", "-0.000001"),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: "audit_events_usage_units_check",
          });
          await client.query("ROLLBACK TO SAVEPOINT reject_negative_usage");

          await insertAuditUsage("03", "0");
          await insertAuditUsage("04", "123.456789");
          const accepted = await client.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.audit_events
              WHERE organization_id = $1
            `,
            [organizationId],
          );
          expect(accepted.rows[0]?.count).toBe("2");
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    });

    it("pins exact relation-OID foreign keys and detects a reduced-arity wrong-relation replacement", async () => {
      expect(await readForeignKeys()).toEqual(expectedForeignKeys);

      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
        ALTER TABLE dasher.sessions
          DROP CONSTRAINT sessions_membership_fkey;
        ALTER TABLE dasher.sessions
          ADD CONSTRAINT sessions_membership_fkey
          FOREIGN KEY (user_id) REFERENCES dasher.users (user_id)
      `);
        const attacked = await readForeignKeys(client);
        expect(attacked).not.toEqual(expectedForeignKeys);
        expect(attacked).toContain(
          "dasher.sessions|sessions_membership_fkey|dasher.users|{user_id}|{user_id}|1|saa|true|false|false",
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }

      expect(await readForeignKeys()).toEqual(expectedForeignKeys);
    });

    it("pins every B-tree index column, order, uniqueness, predicate, opclass, and state", async () => {
      const indexes = await ownerPool.query<{ readonly signature: string }>(`
      SELECT
        relation.relname || '|' ||
        index_relation.relname || '|' ||
        access_method.amname || '|' ||
        index_row.indisunique::text || '|' ||
        index_row.indisprimary::text || '|' ||
        index_row.indisvalid::text || '|' ||
        index_row.indisready::text || '|' ||
        (index_row.indnatts = index_row.indnkeyatts)::text || '|' ||
        index_row.indnullsnotdistinct::text || '|' ||
        index_row.indisclustered::text || '|' ||
        COALESCE(
          pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid),
          '<none>'
        ) || '|' ||
        ARRAY(
          SELECT pg_catalog.pg_get_indexdef(
            index_row.indexrelid,
            ordinal,
            false
          )
          FROM pg_catalog.generate_series(1, index_row.indnkeyatts)
            AS ordinal
        )::text || '|' ||
        ARRAY(
          SELECT operator_class.opcname
          FROM pg_catalog.unnest(index_row.indclass::oid[]) WITH ORDINALITY
            AS class(oid, ordinal)
          JOIN pg_catalog.pg_opclass AS operator_class
            ON operator_class.oid = class.oid
          ORDER BY class.ordinal
        )::text || '|' ||
        index_row.indoption::text AS signature
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = index_row.indrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = 'dasher'
      ORDER BY relation.relname, index_relation.relname
    `);
      expect(indexes.rows.map((row) => row.signature)).toEqual(expectedIndexes);
    });

    it("pins the audit trigger event mask and immutable function definition", async () => {
      const result = await ownerPool.query<{
        readonly acl: string[];
        readonly body: string;
        readonly delete_event: boolean;
        readonly enabled: string;
        readonly function_identity: string;
        readonly function_owner_matches: boolean;
        readonly insert_event: boolean;
        readonly language_name: string;
        readonly is_before: boolean;
        readonly is_row: boolean;
        readonly is_security_definer: boolean;
        readonly proconfig: string[];
        readonly table_name: string;
        readonly trigger_name: string;
        readonly truncate_event: boolean;
        readonly update_event: boolean;
        readonly volatility: string;
      }>(`
      SELECT
        relation.relname AS table_name,
        trigger_row.tgname AS trigger_name,
        trigger_row.tgenabled::text AS enabled,
        (trigger_row.tgtype & 1) = 1 AS is_row,
        (trigger_row.tgtype & 2) = 2 AS is_before,
        (trigger_row.tgtype & 4) = 4 AS insert_event,
        (trigger_row.tgtype & 8) = 8 AS delete_event,
        (trigger_row.tgtype & 16) = 16 AS update_event,
        (trigger_row.tgtype & 32) = 32 AS truncate_event,
        function_namespace.nspname || '.' || procedure.proname || '(' ||
          pg_catalog.oidvectortypes(procedure.proargtypes) || ')'
          AS function_identity,
        owner.rolname = session_user AS function_owner_matches,
        procedure.prosecdef AS is_security_definer,
        language.lanname AS language_name,
        procedure.provolatile::text AS volatility,
        procedure.proconfig,
        procedure.prosrc AS body,
        ARRAY(
          SELECT
            CASE
              WHEN privilege.grantee = procedure.proowner THEN 'OWNER'
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE grantee.rolname
            END || ':' || privilege.privilege_type || ':' ||
            privilege.is_grantable::text
          FROM pg_catalog.aclexplode(
            COALESCE(
              procedure.proacl,
              pg_catalog.acldefault('f', procedure.proowner)
            )
          ) AS privilege
          LEFT JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          ORDER BY 1
        ) AS acl
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc AS procedure
        ON procedure.oid = trigger_row.tgfoid
      JOIN pg_catalog.pg_namespace AS function_namespace
        ON function_namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
      WHERE namespace.nspname = 'dasher'
        AND NOT trigger_row.tgisinternal
    `);
      expect(result.rows).toEqual([
        {
          table_name: "audit_events",
          trigger_name: "audit_events_immutable",
          enabled: "O",
          is_row: true,
          is_before: true,
          insert_event: false,
          delete_event: true,
          update_event: true,
          truncate_event: false,
          function_identity: "dasher_private.reject_immutable_mutation()",
          function_owner_matches: true,
          is_security_definer: false,
          language_name: "plpgsql",
          volatility: "v",
          proconfig: ["search_path=pg_catalog"],
          body: "\nBEGIN\n  RAISE EXCEPTION USING\n    ERRCODE = '55000',\n    MESSAGE = 'immutable relation rejects update and delete';\nEND\n",
          acl: ["OWNER:EXECUTE:false"],
        },
      ]);
    });

    it("pins exact owner, PUBLIC, app, table, function, and default ACL closure", async () => {
      const acl = await ownerPool.query<{ readonly signature: string }>(`
      WITH objects AS (
        SELECT
          'database'::text AS kind,
          'current_database'::text AS identity,
          database_row.datacl AS acl,
          pg_catalog.acldefault('d', database_row.datdba) AS default_acl,
          database_row.datdba AS owner_oid
        FROM pg_catalog.pg_database AS database_row
        WHERE database_row.datname = pg_catalog.current_database()
        UNION ALL
        SELECT
          'schema',
          namespace.nspname,
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner),
          namespace.nspowner
        FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspname IN (
          'public', 'dasher', 'dasher_api', 'dasher_meta', 'dasher_private'
        )
        UNION ALL
        SELECT
          'table',
          namespace.nspname || '.' || relation.relname,
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner),
          relation.relowner
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('dasher', 'dasher_meta')
          AND relation.relkind = 'r'
        UNION ALL
        SELECT
          'function',
          namespace.nspname || '.' || procedure.proname || '(' ||
            pg_catalog.oidvectortypes(procedure.proargtypes) || ')',
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner),
          procedure.proowner
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname IN (
          'dasher', 'dasher_api', 'dasher_private'
        )
      )
      SELECT
        objects.kind || '|' || objects.identity || '|' ||
        pg_catalog.array_to_string(
          ARRAY(
            SELECT
              CASE
                WHEN privilege.grantee = objects.owner_oid THEN 'OWNER'
                WHEN privilege.grantee = 0 THEN 'PUBLIC'
                ELSE grantee.rolname
              END || ':' || privilege.privilege_type || ':' ||
              privilege.is_grantable::text
            FROM pg_catalog.aclexplode(
              COALESCE(objects.acl, objects.default_acl)
            ) AS privilege
            LEFT JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = privilege.grantee
            ORDER BY
              CASE
                WHEN privilege.grantee = objects.owner_oid THEN 'OWNER'
                WHEN privilege.grantee = 0 THEN 'PUBLIC'
                ELSE grantee.rolname
              END,
              privilege.privilege_type
          ),
          ','
        ) AS signature
      FROM objects
      ORDER BY objects.kind, objects.identity
    `);
      expect(acl.rows.map((row) => row.signature).sort()).toEqual(
        expectedObjectAcls,
      );

      const closure = await ownerPool.query<{
        readonly app_function_acl_entry_count: string;
        readonly column_acl_count: string;
        readonly default_acl_count: string;
        readonly definer_function_acl_entry_count: string;
        readonly managed_function_acl_entry_count: string;
        readonly managed_table_acl_entry_count: string;
      }>(`
      WITH function_acl AS (
        SELECT grantee.rolname AS grantee_name
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
        WHERE namespace.nspname IN (
          'dasher', 'dasher_api', 'dasher_private'
        )
          AND grantee.rolname IN (
            'dasher_app', 'dasher_security_definer'
          )
      ),
      table_acl AS (
        SELECT grantee.rolname AS grantee_name
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
        WHERE namespace.nspname IN ('dasher', 'dasher_meta')
          AND grantee.rolname IN (
            'dasher_app', 'dasher_security_definer'
          )
      )
      SELECT
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_attribute AS attribute
          JOIN pg_catalog.pg_class AS relation
            ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('dasher', 'dasher_meta')
            AND attribute.attacl IS NOT NULL
        ) AS column_acl_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_default_acl AS default_acl
          WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) = session_user
        ) AS default_acl_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM function_acl
          WHERE grantee_name = 'dasher_app'
        ) AS app_function_acl_entry_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM function_acl
          WHERE grantee_name = 'dasher_security_definer'
        ) AS definer_function_acl_entry_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM function_acl
        ) AS managed_function_acl_entry_count,
        (
          SELECT pg_catalog.count(*)::text
          FROM table_acl
        ) AS managed_table_acl_entry_count
    `);
      expect(closure.rows[0]).toEqual({
        app_function_acl_entry_count: "16",
        column_acl_count: "68",
        default_acl_count: "2",
        definer_function_acl_entry_count: "16",
        managed_function_acl_entry_count: "32",
        managed_table_acl_entry_count: "0",
      });

      const defaultAcls = await ownerPool.query<{
        readonly signature: string;
      }>(`
        SELECT
          default_acl.defaclobjtype::text || '|' ||
          (default_acl.defaclnamespace = 0)::text || '|' ||
          CASE
            WHEN privilege.grantee = default_acl.defaclrole THEN 'OWNER'
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(privilege.grantee)
          END || ':' || privilege.privilege_type || ':' ||
          privilege.is_grantable::text AS signature
        FROM pg_catalog.pg_default_acl AS default_acl
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl)
          AS privilege
        WHERE pg_catalog.pg_get_userbyid(default_acl.defaclrole) = session_user
        ORDER BY signature
      `);
      expect(defaultAcls.rows.map((row) => row.signature)).toEqual([
        "T|true|OWNER:USAGE:false",
        "f|true|OWNER:EXECUTE:false",
      ]);

      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query(`
            CREATE FUNCTION dasher_private.task3_future_function()
            RETURNS boolean
            LANGUAGE sql
            SET search_path = pg_catalog
            AS 'SELECT true';
            CREATE TYPE dasher.task3_future_type AS (value integer)
          `);
          const futurePublicPrivileges = await client.query<{
            readonly public_execute_count: string;
            readonly public_usage_count: string;
          }>(`
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_proc AS procedure
                CROSS JOIN LATERAL pg_catalog.aclexplode(
                  COALESCE(
                    procedure.proacl,
                    pg_catalog.acldefault('f', procedure.proowner)
                  )
                ) AS privilege
                WHERE procedure.oid =
                  'dasher_private.task3_future_function()'::regprocedure
                  AND privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM pg_catalog.pg_type AS type_row
                CROSS JOIN LATERAL pg_catalog.aclexplode(
                  COALESCE(
                    type_row.typacl,
                    pg_catalog.acldefault('T', type_row.typowner)
                  )
                ) AS privilege
                WHERE type_row.oid = 'dasher.task3_future_type'::regtype
                  AND privilege.grantee = 0
                  AND privilege.privilege_type = 'USAGE'
              ) AS public_usage_count
          `);
          expect(futurePublicPrivileges.rows[0]).toEqual({
            public_execute_count: "0",
            public_usage_count: "0",
          });
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    });

    it("keeps an unidentified session uniqueness violation internal and rolls rotation back", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");
        const successorId = randomUUID();
        const auditEventId = randomUUID();
        await ownerPool.query(`
          ALTER TABLE dasher.sessions
          ADD CONSTRAINT task4_unexpected_sessions_unique
          UNIQUE (organization_id, user_id, authority_revision)
        `);
        try {
          let internalError: unknown;
          try {
            await runContextOperation(
              client,
              actor.sessionDigest,
              randomUUID(),
              () =>
                client.query(
                  `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-unexpected-unique'
                    )
                  `,
                  [
                    successorId,
                    randomBytes(32),
                    randomBytes(32),
                    auditEventId,
                    actor.csrfDigest,
                  ],
                ),
            );
          } catch (error) {
            internalError = error;
          }
          expect(internalError).toMatchObject({
            code: "23505",
            constraint: "task4_unexpected_sessions_unique",
          });
          expect(internalError).not.toMatchObject({
            code: "P1001",
            message: "dasher_denied",
          });
          expect(internalError).not.toMatchObject({
            code: "P1002",
            message: "dasher_conflict",
          });

          const state = await ownerPool.query<{
            readonly audit_count: string;
            readonly predecessor_link: string | null;
            readonly successor_count: string;
          }>(
            `
              SELECT
                (
                  SELECT replaced_by_session_id::text
                  FROM dasher.sessions
                  WHERE session_id = $1::uuid
                ) AS predecessor_link,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.sessions
                  WHERE session_id = $2::uuid
                ) AS successor_count,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.audit_events
                  WHERE audit_event_id = $3::uuid
                ) AS audit_count
            `,
            [actor.sessionId, successorId, auditEventId],
          );
          expect(state.rows[0]).toEqual({
            audit_count: "0",
            predecessor_link: null,
            successor_count: "0",
          });
        } finally {
          await ownerPool.query(`
            ALTER TABLE dasher.sessions
            DROP CONSTRAINT IF EXISTS task4_unexpected_sessions_unique
          `);
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("executes all eight audited Task 4 operations through pinned app transactions with exact boundary behavior", async () => {
      const organizationId = "10000000-0000-4000-8000-000000000001";
      const adminUserId = "10000000-0000-4000-8000-000000000002";
      const adminMembershipId = "10000000-0000-4000-8000-000000000003";
      const adminSessionId = "10000000-0000-4000-8000-000000000004";
      const acceptedUserId = "10000000-0000-4000-8000-000000000005";
      const acceptedMembershipId = "10000000-0000-4000-8000-000000000006";
      const acceptedSessionId = "10000000-0000-4000-8000-000000000007";
      const successorSessionId = "10000000-0000-4000-8000-000000000008";
      const acceptedInvitationId = "10000000-0000-4000-8000-000000000009";
      const revokedInvitationId = "10000000-0000-4000-8000-00000000000a";
      const adminSessionDigest = Buffer.alloc(32, 0x11);
      const adminCsrfDigest = Buffer.alloc(32, 0x12);
      const successorSessionDigest = Buffer.alloc(32, 0x13);
      const successorCsrfDigest = Buffer.alloc(32, 0x14);
      const acceptedSessionDigest = Buffer.alloc(32, 0x15);
      const acceptedCsrfDigest = Buffer.alloc(32, 0x16);
      const acceptedInviteDigest = Buffer.alloc(32, 0x17);
      const revokedInviteDigest = Buffer.alloc(32, 0x18);
      const auditIds = Array.from(
        { length: 9 },
        (_, index) =>
          `20000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      );
      const requestIds = Array.from(
        { length: 9 },
        (_, index) =>
          `30000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      );

      await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
        adminUserId,
      ]);
      await ownerPool.query(
        `
          INSERT INTO dasher.external_identities (
            issuer,
            subject,
            user_id
          ) VALUES ('https://issuer.task4.test', 'admin-subject', $1)
        `,
        [adminUserId],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.organizations (
            organization_id,
            display_name
          ) VALUES ($1, 'Task 4 Boundary Organization')
        `,
        [organizationId],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.memberships (
            membership_id,
            organization_id,
            user_id,
            role,
            state,
            authority_revision
          ) VALUES ($1, $2, $3, 'admin', 'active', 1)
        `,
        [adminMembershipId, organizationId, adminUserId],
      );

      const client = await appPool!.connect();
      try {
        await expectPostgresDenial(
          client,
          `
            SELECT *
            FROM dasher_api.issue_session(
              'https://issuer.task4.test',
              'admin-subject',
              '${adminMembershipId}'::uuid,
              '${adminSessionId}'::uuid,
              1::smallint,
              decode('${adminSessionDigest.toString("hex")}', 'hex'),
              1::smallint,
              decode('${adminCsrfDigest.toString("hex")}', 'hex'),
              '${auditIds[0]}'::uuid,
              '${requestIds[0]}'::uuid,
              'task4-test'
            )
          `,
        );
        await client.query("SET ROLE dasher_app");
        await client.query("SET search_path = pg_temp, public");

        const issued = await client.query(
          `
            SELECT *
            FROM dasher_api.issue_session(
              $1,
              $2,
              $3::uuid,
              $4::uuid,
              1::smallint,
              $5::bytea,
              1::smallint,
              $6::bytea,
              $7::uuid,
              $8::uuid,
              $9
            )
          `,
          [
            "https://issuer.task4.test",
            "admin-subject",
            adminMembershipId,
            adminSessionId,
            adminSessionDigest,
            adminCsrfDigest,
            auditIds[0],
            requestIds[0],
            "task4-test",
          ],
        );
        expect(Object.keys(issued.rows[0] ?? {})).toEqual([
          "user_id",
          "organization_id",
          "membership_id",
          "granted_role",
          "authority_revision",
          "session_id",
          "idle_expires_at",
          "absolute_expires_at",
        ]);

        expect(
          (
            await client.query(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");
        await client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [adminSessionDigest, requestIds[1]],
        );
        expect(
          (
            await client.query(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");

        await client.query("BEGIN");
        try {
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_session_id', $1, true)",
            [adminSessionId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_user_id', $1, true)",
            [adminUserId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_organization_id', $1, true)",
            [organizationId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_membership_id', $1, true)",
            [adminMembershipId],
          );
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_authority_revision', '1', true)",
          );
          expect(
            (
              await client.query(
                "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
              )
            ).rows[0]?.count,
          ).toBe("0");
        } finally {
          await client.query("ROLLBACK");
        }

        const acceptedInvite = await client.query(
          `
            SELECT *
            FROM dasher_api.issue_invitation(
              $1::uuid,
              'accepted@example.test',
              'viewer',
              1::smallint,
              $2::bytea,
              $3::uuid,
              1::smallint,
              $4::bytea,
              1::smallint,
              $5::bytea,
              $6::uuid,
              'task4-test'
            )
          `,
          [
            acceptedInvitationId,
            acceptedInviteDigest,
            auditIds[1],
            adminSessionDigest,
            adminCsrfDigest,
            requestIds[1],
          ],
        );
        expect(Object.keys(acceptedInvite.rows[0] ?? {})).toEqual([
          "invitation_id",
          "expires_at",
        ]);

        const accepted = await client.query(
          `
            SELECT *
            FROM dasher_api.accept_invitation(
              1::smallint,
              $1::bytea,
              'https://issuer.task4.test',
              'accepted-subject',
              'accepted@example.test',
              true,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              1::smallint,
              $5::bytea,
              1::smallint,
              $6::bytea,
              $7::uuid,
              $8::uuid,
              'task4-test'
            )
          `,
          [
            acceptedInviteDigest,
            acceptedUserId,
            acceptedMembershipId,
            acceptedSessionId,
            acceptedSessionDigest,
            acceptedCsrfDigest,
            auditIds[2],
            requestIds[2],
          ],
        );
        expect(Object.keys(accepted.rows[0] ?? {})).toEqual([
          "user_id",
          "organization_id",
          "membership_id",
          "granted_role",
          "authority_revision",
          "session_id",
          "idle_expires_at",
          "absolute_expires_at",
        ]);
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.accept_invitation(
                1::smallint, $1::bytea, 'https://issuer.task4.test',
                'accepted-subject', 'accepted@example.test', true,
                $2::uuid, $3::uuid, $4::uuid, 1::smallint, $5::bytea,
                1::smallint, $6::bytea, $7::uuid, $8::uuid, 'task4-test'
              )
            `,
            [
              acceptedInviteDigest,
              randomUUID(),
              randomUUID(),
              randomUUID(),
              Buffer.alloc(32, 0x19),
              Buffer.alloc(32, 0x1a),
              randomUUID(),
              randomUUID(),
            ],
          ),
          "P1001",
          "dasher_denied",
        );

        const rotated = await runContextOperation(
          client,
          adminSessionDigest,
          requestIds[3]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid,
                  1::smallint,
                  $2::bytea,
                  1::smallint,
                  $3::bytea,
                  $4::uuid,
                  1::smallint,
                  $5::bytea,
                  'task4-test'
                )
              `,
              [
                successorSessionId,
                successorSessionDigest,
                successorCsrfDigest,
                auditIds[3],
                adminCsrfDigest,
              ],
            ),
        );
        expect(Object.keys(rotated.rows[0] ?? {})).toEqual([
          "session_id",
          "idle_expires_at",
          "absolute_expires_at",
        ]);
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.initialize_context(
                1::smallint,
                $1::bytea,
                $2::uuid
              )
            `,
            [adminSessionDigest, requestIds[4]],
          ),
          "P1001",
          "dasher_denied",
        );

        await client.query(
          `
            SELECT *
            FROM dasher_api.issue_invitation(
              $1::uuid, 'revoked@example.test', 'editor', 1::smallint,
              $2::bytea, $3::uuid, 1::smallint, $4::bytea, 1::smallint,
              $5::bytea, $6::uuid, 'task4-test'
            )
          `,
          [
            revokedInvitationId,
            revokedInviteDigest,
            auditIds[4],
            successorSessionDigest,
            successorCsrfDigest,
            requestIds[4],
          ],
        );
        await client.query(
          `
            SELECT *
            FROM dasher_api.revoke_invitation(
              $1::uuid, $2::uuid, 1::smallint, $3::bytea, 1::smallint,
              $4::bytea, $5::uuid, 'task4-test'
            )
          `,
          [
            revokedInvitationId,
            auditIds[5],
            successorSessionDigest,
            successorCsrfDigest,
            requestIds[5],
          ],
        );

        await runContextOperation(
          client,
          successorSessionDigest,
          requestIds[6]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.change_membership_role(
                  $1::uuid,
                  'editor',
                  $2::uuid,
                  1::smallint,
                  $3::bytea,
                  'task4-test'
                )
              `,
              [acceptedMembershipId, auditIds[6], successorCsrfDigest],
            ),
        );
        await runContextOperation(
          client,
          successorSessionDigest,
          requestIds[7]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.revoke_membership(
                  $1::uuid,
                  $2::uuid,
                  1::smallint,
                  $3::bytea,
                  'task4-test'
                )
              `,
              [acceptedMembershipId, auditIds[7], successorCsrfDigest],
            ),
        );
        await runContextOperation(
          client,
          successorSessionDigest,
          requestIds[8]!,
          () =>
            client.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid,
                  $2::uuid,
                  1::smallint,
                  $3::bytea,
                  'task4-test'
                )
              `,
              [successorSessionId, auditIds[8], successorCsrfDigest],
            ),
        );
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.initialize_context(
                1::smallint,
                $1::bytea,
                $2::uuid
              )
            `,
            [successorSessionDigest, randomUUID()],
          ),
          "P1001",
          "dasher_denied",
        );
        await expectPostgresDenial(
          client,
          "SELECT dasher_private.context_user_id()",
        );
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }

      const state = await ownerPool.query<{
        readonly action: string;
        readonly actor_user_id: string;
        readonly authority_revision: string;
        readonly deployment_revision: string;
        readonly null_optional_fields: boolean;
        readonly organization_id: string;
        readonly outcome: string;
        readonly target_type: string;
      }>(
        `
          SELECT
            action,
            actor_user_id,
            authority_revision::text,
            deployment_revision,
            organization_id,
            outcome,
            target_type,
            job_id IS NULL
              AND content_sha256 IS NULL
              AND source_ref IS NULL
              AND provider IS NULL
              AND credential_version IS NULL
              AND usage_units IS NULL
              AND cost_minor_units IS NULL AS null_optional_fields
          FROM dasher.audit_events
          WHERE audit_event_id = ANY($1::uuid[])
          ORDER BY occurred_at, audit_event_id
        `,
        [auditIds],
      );
      expect(state.rows).toHaveLength(9);
      expect(state.rows.map((row) => row.action).sort()).toEqual(
        [
          "invitation.accepted",
          "invitation.issued",
          "invitation.issued",
          "invitation.revoked",
          "membership.revoked",
          "membership.role_changed",
          "session.issued",
          "session.revoked",
          "session.rotated",
        ].sort(),
      );
      for (const row of state.rows) {
        expect(row.organization_id).toBe(organizationId);
        expect(row.outcome).toBe("succeeded");
        expect(row.deployment_revision).toBe("task4-test");
        expect(row.null_optional_fields).toBe(true);
      }

      const timestamps = await ownerPool.query<{
        readonly acceptance_clock_matches: boolean;
        readonly initial_clock_matches: boolean;
        readonly invitation_lifetime_matches: boolean;
        readonly rotation_clock_matches: boolean;
      }>(
        `
          SELECT
            initial_session.issued_at = initial_session.last_seen_at
              AND initial_session.issued_at = initial_audit.occurred_at
              AS initial_clock_matches,
            accepted_invitation.accepted_at = accepted_session.issued_at
              AND accepted_session.issued_at = accepted_session.last_seen_at
              AND accepted_session.issued_at = accepted_audit.occurred_at
              AS acceptance_clock_matches,
            accepted_invitation.expires_at
              = accepted_invitation.created_at + interval '7 days'
              AS invitation_lifetime_matches,
            successor.issued_at = successor.last_seen_at
              AND successor.absolute_expires_at
                = initial_session.absolute_expires_at
              AND predecessor.replaced_by_session_id = successor.session_id
              AND successor.rotated_from_session_id = predecessor.session_id
              AND successor.issued_at = rotation_audit.occurred_at
              AS rotation_clock_matches
          FROM dasher.sessions AS initial_session
          JOIN dasher.audit_events AS initial_audit
            ON initial_audit.audit_event_id = $1::uuid
          JOIN dasher.invitations AS accepted_invitation
            ON accepted_invitation.invitation_id = $2::uuid
          JOIN dasher.sessions AS accepted_session
            ON accepted_session.session_id = $3::uuid
          JOIN dasher.audit_events AS accepted_audit
            ON accepted_audit.audit_event_id = $4::uuid
          JOIN dasher.sessions AS predecessor
            ON predecessor.session_id = $5::uuid
          JOIN dasher.sessions AS successor
            ON successor.session_id = $6::uuid
          JOIN dasher.audit_events AS rotation_audit
            ON rotation_audit.audit_event_id = $7::uuid
          WHERE initial_session.session_id = $5::uuid
        `,
        [
          auditIds[0],
          acceptedInvitationId,
          acceptedSessionId,
          auditIds[2],
          adminSessionId,
          successorSessionId,
          auditIds[3],
        ],
      );
      expect(timestamps.rows[0]).toEqual({
        initial_clock_matches: true,
        acceptance_clock_matches: true,
        invitation_lifetime_matches: true,
        rotation_clock_matches: true,
      });
    });

    it("covers missing, malformed, stale, overwritten, expired, standalone, and pooled context plus exact SQL boundary metadata", async () => {
      const client = await appPool!.connect();
      await client.query("SET ROLE dasher_app");
      const actor = await createTask4Actor(client, "admin");
      const target = await createTask4Actor(
        client,
        "viewer",
        actor.organizationId,
      );

      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");

      await client.query("BEGIN");
      await client.query(
        "SELECT pg_catalog.set_config('dasher.context_session_id', 'malformed', true)",
      );
      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");
      await client.query("ROLLBACK");

      await client.query(
        `
          SELECT *
          FROM dasher_api.initialize_context(
            1::smallint,
            $1::bytea,
            $2::uuid
          )
        `,
        [actor.sessionDigest, randomUUID()],
      );
      expect(
        (
          await client.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM pg_catalog.pg_locks
              WHERE pid = pg_catalog.pg_backend_pid()
                AND locktype = 'advisory'
            `,
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");

      for (const [keyVersion, digest] of [
        [2, actor.sessionDigest],
        [1, randomBytes(32)],
      ] as const) {
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.initialize_context(
                $1::smallint, $2::bytea, $3::uuid
              )
            `,
            [keyVersion, digest, randomUUID()],
          ),
          "P1001",
          "dasher_denied",
        );
      }

      const overwrittenRequestId = randomUUID();
      await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        async () => {
          await client.query(
            "SELECT pg_catalog.set_config('dasher.context_request_id', $1, true)",
            [overwrittenRequestId],
          );
          expect(
            (
              await client.query<{ readonly count: string }>(
                "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
              )
            ).rows[0]?.count,
          ).toBe("1");
          await client.query(
            `
              SELECT *
              FROM dasher_api.change_membership_role(
                $1::uuid,
                'editor',
                $2::uuid,
                1::smallint,
                $3::bytea,
                'task4-context-matrix'
              )
            `,
            [target.membershipId, randomUUID(), actor.csrfDigest],
          );
        },
      );
      const overwriteAudit = await ownerPool.query<{
        readonly request_id: string;
      }>(
        `
          SELECT request_id
          FROM dasher.audit_events
          WHERE target_id = $1::uuid
            AND action = 'membership.role_changed'
        `,
        [target.membershipId],
      );
      expect(overwriteAudit.rows[0]?.request_id).toBe(overwrittenRequestId);

      await client.query("BEGIN");
      await client.query(
        `
          SELECT *
          FROM dasher_api.initialize_context(
            1::smallint,
            $1::bytea,
            $2::uuid
          )
        `,
        [actor.sessionDigest, randomUUID()],
      );
      await client.query(
        "SELECT pg_catalog.set_config('dasher.context_authority_revision', '2', true)",
      );
      expect(
        (
          await client.query<{ readonly count: string }>(
            "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
          )
        ).rows[0]?.count,
      ).toBe("0");
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.revoke_session(
              $1::uuid,
              $2::uuid,
              1::smallint,
              $3::bytea,
              'task4-context-matrix'
            )
          `,
          [actor.sessionId, randomUUID(), actor.csrfDigest],
        ),
        "P1001",
        "dasher_denied",
      );
      await client.query("ROLLBACK");

      const foreign = await createTask4Actor(client, "admin");
      for (const [guc, value] of [
        ["dasher.context_user_id", foreign.userId],
        ["dasher.context_organization_id", foreign.organizationId],
        ["dasher.context_membership_id", foreign.membershipId],
        ["dasher.context_session_id", foreign.sessionId],
      ] as const) {
        await client.query("BEGIN");
        await client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [actor.sessionDigest, randomUUID()],
        );
        await client.query("SELECT pg_catalog.set_config($1, $2, true)", [
          guc,
          value,
        ]);
        expect(
          (
            await client.query<{ readonly count: string }>(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT *
              FROM dasher_api.revoke_session(
                $1::uuid, $2::uuid, 1::smallint,
                $3::bytea, 'task4-context-matrix'
              )
            `,
            [actor.sessionId, randomUUID(), actor.csrfDigest],
          ),
          "P1001",
          "dasher_denied",
        );
        await client.query("ROLLBACK");
      }

      await runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
        expectDasherBoundaryError(
          client.query(
            `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid,
                  1::smallint,
                  $2::bytea,
                  1::smallint,
                  $3::bytea,
                  $4::uuid,
                  1::smallint,
                  $5::bytea,
                  'task4-context-matrix'
                )
              `,
            [
              actor.sessionId,
              randomBytes(32),
              randomBytes(32),
              randomUUID(),
              actor.csrfDigest,
            ],
          ),
          "P1002",
          "dasher_conflict",
        ),
      );

      await ownerPool.query(
        `
          UPDATE dasher.sessions
          SET idle_expires_at = pg_catalog.clock_timestamp()
          WHERE session_id = $1::uuid
        `,
        [actor.sessionId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint,
              $1::bytea,
              $2::uuid
            )
          `,
          [actor.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const absoluteExpired = await createTask4Actor(client, "viewer");
      await ownerPool.query(
        `
          UPDATE dasher.sessions
          SET
            idle_expires_at = pg_catalog.clock_timestamp(),
            absolute_expires_at = pg_catalog.clock_timestamp()
          WHERE session_id = $1::uuid
        `,
        [absoluteExpired.sessionId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint, $1::bytea, $2::uuid
            )
          `,
          [absoluteExpired.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const revokedSession = await createTask4Actor(client, "viewer");
      await ownerPool.query(
        `
          UPDATE dasher.sessions
          SET
            revoked_at = pg_catalog.clock_timestamp(),
            revocation_reason = 'user_revoked'
          WHERE session_id = $1::uuid
        `,
        [revokedSession.sessionId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint, $1::bytea, $2::uuid
            )
          `,
          [revokedSession.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const revokedMembership = await createTask4Actor(client, "viewer");
      await ownerPool.query(
        `
          UPDATE dasher.memberships
          SET
            state = 'revoked',
            authority_revision = authority_revision + 1,
            revoked_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
          WHERE membership_id = $1::uuid
        `,
        [revokedMembership.membershipId],
      );
      await expectDasherBoundaryError(
        client.query(
          `
            SELECT *
            FROM dasher_api.initialize_context(
              1::smallint, $1::bytea, $2::uuid
            )
          `,
          [revokedMembership.sessionDigest, randomUUID()],
        ),
        "P1001",
        "dasher_denied",
      );

      const repeatedRequestId = randomUUID();
      await issueTask4Invitation(
        client,
        foreign,
        `repeat-a-${randomUUID()}@example.test`,
        { requestId: repeatedRequestId },
      );
      await issueTask4Invitation(
        client,
        foreign,
        `repeat-b-${randomUUID()}@example.test`,
        { requestId: repeatedRequestId },
      );
      expect(
        (
          await ownerPool.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.audit_events
              WHERE request_id = $1::uuid
            `,
            [repeatedRequestId],
          )
        ).rows[0]?.count,
      ).toBe("2");

      await client.query("RESET ROLE");
      client.release();
      const reused = await appPool!.connect();
      try {
        await reused.query("SET ROLE dasher_app");
        expect(
          (
            await reused.query<{ readonly count: string }>(
              "SELECT pg_catalog.count(*)::text AS count FROM dasher.organizations",
            )
          ).rows[0]?.count,
        ).toBe("0");
      } finally {
        await reused.query("RESET ROLE");
        reused.release();
      }
    });

    it("exhaustively enforces the Task 5 SQL ASCII email subset for bytes 0x01..0x7f, exact lengths, and pre-database NUL rejection", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");
        const applicationOnlyRejectedBytes = [0x00];
        expect(applicationOnlyRejectedBytes).toEqual([0x00]);

        for (const position of ["local", "domain"] as const) {
          for (let code = 0x01; code <= 0x7f; code += 1) {
            const character = String.fromCharCode(code);
            const email =
              position === "local"
                ? `a${character}b@example.test`
                : `ab@exa${character}mple.test`;
            const accepted =
              code >= 0x21 &&
              code <= 0x7e &&
              !(code >= 0x41 && code <= 0x5a) &&
              code !== 0x40;
            const operation = client.query(
              `
                SELECT *
                FROM dasher_api.issue_invitation(
                  $1::uuid,
                  $2,
                  'viewer',
                  1::smallint,
                  $3::bytea,
                  $4::uuid,
                  1::smallint,
                  $5::bytea,
                  1::smallint,
                  $6::bytea,
                  $7::uuid,
                  'task4-email-matrix'
                )
              `,
              [
                randomUUID(),
                email,
                randomBytes(32),
                randomUUID(),
                actor.sessionDigest,
                actor.csrfDigest,
                randomUUID(),
              ],
            );
            if (accepted) {
              await expect(operation).resolves.toMatchObject({ rowCount: 1 });
            } else {
              await expectDasherBoundaryError(
                operation,
                "P1001",
                "dasher_denied",
              );
            }
          }
        }

        const emailLengthCases = [
          { accepted: false, email: "", length: 0 },
          { accepted: false, email: "a", length: 1 },
          { accepted: false, email: "ab", length: 2 },
          { accepted: true, email: "a@b", length: 3 },
          { accepted: true, email: "aa@b", length: 4 },
          { accepted: true, email: `${"a".repeat(317)}@b`, length: 319 },
          { accepted: true, email: `${"a".repeat(318)}@b`, length: 320 },
          { accepted: false, email: `${"a".repeat(319)}@b`, length: 321 },
        ] as const;
        for (const lengthCase of emailLengthCases) {
          expect(lengthCase.email).toHaveLength(lengthCase.length);
          const operation = issueTask4Invitation(
            client,
            actor,
            lengthCase.email,
          );
          if (lengthCase.accepted) {
            await expect(operation).resolves.toBeDefined();
          } else {
            await expectDasherBoundaryError(
              operation,
              "P1001",
              "dasher_denied",
            );
          }
        }

        for (const rejectedEmail of [
          "é@example.test",
          "local@例.example",
          "@example.test",
          "local@",
          "local@@example.test",
        ]) {
          await expectDasherBoundaryError(
            issueTask4Invitation(client, actor, rejectedEmail),
            "P1001",
            "dasher_denied",
          );
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });

    it("normalizes expected denial and conflict classes to code-only metadata", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");
        const target = await createTask4Actor(
          client,
          "viewer",
          actor.organizationId,
        );
        const sharedId = randomUUID();
        const sharedDigest = randomBytes(32);
        const sharedEmail = `boundary-${randomUUID()}@example.test`;
        await issueTask4Invitation(client, actor, sharedEmail, {
          invitationId: sharedId,
          tokenDigest: sharedDigest,
        });

        const deniedCases: ReadonlyArray<{
          readonly name: string;
          readonly operation: () => Promise<unknown>;
        }> = [
          {
            name: "closed role enum",
            operation: () =>
              client.query(
                `
                  SELECT *
                  FROM dasher_api.issue_invitation(
                    $1::uuid, $2, 'owner', 1::smallint, $3::bytea,
                    $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                    $6::bytea, $7::uuid, 'task4-boundary'
                  )
                `,
                [
                  randomUUID(),
                  `role-${randomUUID()}@example.test`,
                  randomBytes(32),
                  randomUUID(),
                  actor.sessionDigest,
                  actor.csrfDigest,
                  randomUUID(),
                ],
              ),
          },
          {
            name: "wrong csrf",
            operation: () =>
              client.query(
                `
                  SELECT *
                  FROM dasher_api.issue_invitation(
                    $1::uuid, $2, 'viewer', 1::smallint, $3::bytea,
                    $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                    $6::bytea, $7::uuid, 'task4-boundary'
                  )
                `,
                [
                  randomUUID(),
                  `csrf-${randomUUID()}@example.test`,
                  randomBytes(32),
                  randomUUID(),
                  actor.sessionDigest,
                  randomBytes(32),
                  randomUUID(),
                ],
              ),
          },
          {
            name: "audit equals request",
            operation: () => {
              const repeated = randomUUID();
              return client.query(
                `
                  SELECT *
                  FROM dasher_api.issue_invitation(
                    $1::uuid, $2, 'viewer', 1::smallint, $3::bytea,
                    $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                    $6::bytea, $4::uuid, 'task4-boundary'
                  )
                `,
                [
                  randomUUID(),
                  `equal-${randomUUID()}@example.test`,
                  randomBytes(32),
                  repeated,
                  actor.sessionDigest,
                  actor.csrfDigest,
                ],
              );
            },
          },
          {
            name: "cross tenant conditional target",
            operation: () =>
              runContextOperation(
                client,
                actor.sessionDigest,
                randomUUID(),
                () =>
                  client.query(
                    `
                      SELECT *
                      FROM dasher_api.revoke_membership(
                        $1::uuid, $2::uuid, 1::smallint,
                        $3::bytea, 'task4-boundary'
                      )
                    `,
                    [randomUUID(), randomUUID(), actor.csrfDigest],
                  ),
              ),
          },
        ];
        for (const boundaryCase of deniedCases) {
          await expectDasherBoundaryError(
            boundaryCase.operation(),
            "P1001",
            "dasher_denied",
          );
          expect(boundaryCase.name).not.toBe("");
        }

        const conflictCases: ReadonlyArray<{
          readonly name: string;
          readonly operation: () => Promise<unknown>;
        }> = [
          {
            name: "duplicate invitation id",
            operation: () =>
              issueTask4Invitation(
                client,
                actor,
                `duplicate-${randomUUID()}@example.test`,
                { invitationId: sharedId },
              ),
          },
          {
            name: "successor id collision",
            operation: () =>
              runContextOperation(
                client,
                actor.sessionDigest,
                randomUUID(),
                () =>
                  client.query(
                    `
                      SELECT *
                      FROM dasher_api.rotate_session(
                        $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                        $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                        'task4-boundary'
                      )
                    `,
                    [
                      target.sessionId,
                      randomBytes(32),
                      randomBytes(32),
                      randomUUID(),
                      actor.csrfDigest,
                    ],
                  ),
              ),
          },
        ];
        for (const boundaryCase of conflictCases) {
          await expectDasherBoundaryError(
            boundaryCase.operation(),
            "P1002",
            "dasher_conflict",
          );
          expect(boundaryCase.name).not.toBe("");
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });

    it("maps only exact session token and CSRF uniqueness constraints to conflict for every session creator", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(client, "admin");

        for (const collision of ["token", "csrf"] as const) {
          const sessionDigest =
            collision === "token" ? actor.sessionDigest : randomBytes(32);
          const csrfDigest =
            collision === "csrf" ? actor.csrfDigest : randomBytes(32);

          await expectDasherBoundaryError(
            client.query(
              `
                SELECT *
                FROM dasher_api.issue_session(
                  $1, $2, $3::uuid, $4::uuid, 1::smallint,
                  $5::bytea, 1::smallint, $6::bytea, $7::uuid,
                  $8::uuid, 'task4-named-unique'
                )
              `,
              [
                actor.identityIssuer,
                actor.identitySubject,
                actor.membershipId,
                randomUUID(),
                sessionDigest,
                csrfDigest,
                randomUUID(),
                randomUUID(),
              ],
            ),
            "P1002",
            "dasher_conflict",
          );

          await expectDasherBoundaryError(
            runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
              client.query(
                `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-named-unique'
                    )
                  `,
                [
                  randomUUID(),
                  sessionDigest,
                  csrfDigest,
                  randomUUID(),
                  actor.csrfDigest,
                ],
              ),
            ),
            "P1002",
            "dasher_conflict",
          );

          const invitation = await issueTask4Invitation(
            client,
            actor,
            `named-${collision}-${randomUUID()}@example.test`,
          );
          await expectDasherBoundaryError(
            acceptTask4Invitation(
              client,
              invitation,
              `https://named-${collision}-${randomUUID()}.test`,
              randomUUID(),
              {
                csrfDigest,
                sessionDigest,
              },
            ),
            "P1002",
            "dasher_conflict",
          );
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("normalizes the exact sessions_pkey loser for all three cross-organization absent-probe races", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        const issueA = await createTask4Actor(first, "admin");
        const issueB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          issueA.organizationId,
          issueB.organizationId,
        );
        const issueSessionId = randomUUID();
        const issueWinnerAudit = randomUUID();
        const issueLoserAudit = randomUUID();
        await first.query("BEGIN");
        await first.query(
          `
            SELECT *
            FROM dasher_api.issue_session(
              $1, $2, $3::uuid, $4::uuid, 1::smallint,
              $5::bytea, 1::smallint, $6::bytea, $7::uuid,
              $8::uuid, 'task4-pkey-race'
            )
          `,
          [
            issueA.identityIssuer,
            issueA.identitySubject,
            issueA.membershipId,
            issueSessionId,
            randomBytes(32),
            randomBytes(32),
            issueWinnerAudit,
            randomUUID(),
          ],
        );
        await second.query("BEGIN");
        const issueLoser = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.issue_session(
                $1, $2, $3::uuid, $4::uuid, 1::smallint,
                $5::bytea, 1::smallint, $6::bytea, $7::uuid,
                $8::uuid, 'task4-pkey-race'
              )
            `,
            [
              issueB.identityIssuer,
              issueB.identitySubject,
              issueB.membershipId,
              issueSessionId,
              randomBytes(32),
              randomBytes(32),
              issueLoserAudit,
              randomUUID(),
            ],
          ),
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "transactionid",
          issueLoser,
        );
        await first.query("COMMIT");
        const issueLoserResult = await issueLoser;
        expect(issueLoserResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            issueLoserResult.status === "rejected"
              ? issueLoserResult.reason
              : new Error("missing issue_session PK loser"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");

        const rotateA = await createTask4Actor(first, "admin");
        const rotateB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          rotateA.organizationId,
          rotateB.organizationId,
        );
        const rotateSessionId = randomUUID();
        const rotateWinnerAudit = randomUUID();
        const rotateLoserAudit = randomUUID();
        await beginTask4Context(first, rotateA.sessionDigest, randomUUID());
        await first.query(
          `
            SELECT *
            FROM dasher_api.rotate_session(
              $1::uuid, 1::smallint, $2::bytea, 1::smallint,
              $3::bytea, $4::uuid, 1::smallint, $5::bytea,
              'task4-pkey-race'
            )
          `,
          [
            rotateSessionId,
            randomBytes(32),
            randomBytes(32),
            rotateWinnerAudit,
            rotateA.csrfDigest,
          ],
        );
        await beginTask4Context(second, rotateB.sessionDigest, randomUUID());
        const rotateLoser = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-pkey-race'
              )
            `,
            [
              rotateSessionId,
              randomBytes(32),
              randomBytes(32),
              rotateLoserAudit,
              rotateB.csrfDigest,
            ],
          ),
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "transactionid",
          rotateLoser,
        );
        await first.query("COMMIT");
        const rotateLoserResult = await rotateLoser;
        expect(rotateLoserResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            rotateLoserResult.status === "rejected"
              ? rotateLoserResult.reason
              : new Error("missing rotate_session PK loser"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");

        const acceptAdminA = await createTask4Actor(first, "admin");
        const acceptAdminB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          acceptAdminA.organizationId,
          acceptAdminB.organizationId,
        );
        const invitationA = await issueTask4Invitation(
          first,
          acceptAdminA,
          `pkey-a-${randomUUID()}@example.test`,
        );
        const invitationB = await issueTask4Invitation(
          first,
          acceptAdminB,
          `pkey-b-${randomUUID()}@example.test`,
        );
        expect(
          (
            await ownerPool.query<{ readonly key_count: string }>(
              `
                SELECT pg_catalog.count(DISTINCT advisory_key)::text
                  AS key_count
                FROM pg_catalog.unnest(
                  ARRAY[
                    pg_catalog.hashtextextended(
                      'dasher:task4-organization:v1:' ||
                        $1::uuid::text,
                      20260730::bigint
                    ),
                    pg_catalog.hashtextextended(
                      'dasher:invitation-family:v1:' ||
                        $1::uuid::text || ':' || $2,
                      20260730::bigint
                    ),
                    pg_catalog.hashtextextended(
                      'dasher:task4-organization:v1:' ||
                        $3::uuid::text,
                      20260730::bigint
                    ),
                    pg_catalog.hashtextextended(
                      'dasher:invitation-family:v1:' ||
                        $3::uuid::text || ':' || $4,
                      20260730::bigint
                    )
                  ]::bigint[]
                ) AS key_set(advisory_key)
              `,
              [
                acceptAdminA.organizationId,
                invitationA.normalizedEmail,
                acceptAdminB.organizationId,
                invitationB.normalizedEmail,
              ],
            )
          ).rows[0]?.key_count,
        ).toBe("4");
        const acceptSessionId = randomUUID();
        const acceptWinnerAudit = randomUUID();
        const acceptLoserAudit = randomUUID();
        await first.query("BEGIN");
        await acceptTask4Invitation(
          first,
          invitationA,
          `https://pkey-a-${randomUUID()}.test`,
          randomUUID(),
          {
            auditEventId: acceptWinnerAudit,
            sessionId: acceptSessionId,
          },
        );
        await second.query("BEGIN");
        const acceptLoser = retainDatabasePromise(
          retainedOperations,
          acceptTask4Invitation(
            second,
            invitationB,
            `https://pkey-b-${randomUUID()}.test`,
            randomUUID(),
            {
              auditEventId: acceptLoserAudit,
              sessionId: acceptSessionId,
            },
          ),
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "transactionid",
          acceptLoser,
        );
        await first.query("COMMIT");
        const acceptLoserResult = await acceptLoser;
        expect(acceptLoserResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            acceptLoserResult.status === "rejected"
              ? acceptLoserResult.reason
              : new Error("missing accept_invitation PK loser"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");

        const state = await ownerPool.query<{
          readonly audit_count: string;
          readonly session_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($1::uuid[])
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($2::uuid[])
              ) AS audit_count
          `,
          [
            [issueSessionId, rotateSessionId, acceptSessionId],
            [
              issueWinnerAudit,
              issueLoserAudit,
              rotateWinnerAudit,
              rotateLoserAudit,
              acceptWinnerAudit,
              acceptLoserAudit,
            ],
          ],
        );
        expect(state.rows[0]).toEqual({
          audit_count: "3",
          session_count: "3",
        });
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        expect(firstPid).not.toBe(secondPid);
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await second.query("ROLLBACK").catch(() => undefined);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
      }
    });

    it("rolls back on audit grant failure, restores exact grants, permits rollback reuse, and rejects global cross-tenant audit collisions", async () => {
      const appClient = await appPool!.connect();
      await appClient.query("SET ROLE dasher_app");
      const actorA = await createTask4Actor(appClient, "admin");
      const actorB = await createTask4Actor(appClient, "admin");
      const failed = {
        auditEventId: randomUUID(),
        invitationId: randomUUID(),
        normalizedEmail: `audit-failure-${randomUUID()}@example.test`,
        requestId: randomUUID(),
        tokenDigest: randomBytes(32),
      };
      try {
        const revoker = await ownerPool.connect();
        try {
          await revoker.query("BEGIN");
          await revoker.query(`
            REVOKE INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            FROM dasher_security_definer
          `);
          await revoker.query("COMMIT");
        } finally {
          revoker.release();
        }

        await expectPostgresError(
          appClient.query(
            `
              SELECT *
              FROM dasher_api.issue_invitation(
                $1::uuid, $2, 'viewer', 1::smallint, $3::bytea,
                $4::uuid, 1::smallint, $5::bytea, 1::smallint,
                $6::bytea, $7::uuid, 'task4-audit-failure'
              )
            `,
            [
              failed.invitationId,
              failed.normalizedEmail,
              failed.tokenDigest,
              failed.auditEventId,
              actorA.sessionDigest,
              actorA.csrfDigest,
              failed.requestId,
            ],
          ),
          "42501",
        );
        const rolledBack = await ownerPool.query<{
          readonly audit_count: string;
          readonly invitation_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = $1::uuid
              ) AS audit_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.invitations
                WHERE invitation_id = $2::uuid
              ) AS invitation_count
          `,
          [failed.auditEventId, failed.invitationId],
        );
        expect(rolledBack.rows[0]).toEqual({
          audit_count: "0",
          invitation_count: "0",
        });
      } finally {
        const restorer = await ownerPool.connect();
        try {
          await restorer.query("BEGIN");
          await restorer.query(`
            GRANT INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            TO dasher_security_definer
          `);
          await restorer.query("COMMIT");
        } finally {
          restorer.release();
        }
      }

      await issueTask4Invitation(
        appClient,
        actorA,
        failed.normalizedEmail,
        failed,
      );

      const rolledBackId = randomUUID();
      const rolledBackAuditId = randomUUID();
      const rolledBackEmail = `rollback-${randomUUID()}@example.test`;
      const rolledBackDigest = randomBytes(32);
      const rolledBackRequestId = randomUUID();
      await appClient.query("BEGIN");
      await issueTask4Invitation(appClient, actorA, rolledBackEmail, {
        auditEventId: rolledBackAuditId,
        invitationId: rolledBackId,
        requestId: rolledBackRequestId,
        tokenDigest: rolledBackDigest,
      });
      await appClient.query("ROLLBACK");
      await issueTask4Invitation(appClient, actorA, rolledBackEmail, {
        auditEventId: rolledBackAuditId,
        invitationId: rolledBackId,
        requestId: rolledBackRequestId,
        tokenDigest: rolledBackDigest,
      });

      const globalAuditId = randomUUID();
      await issueTask4Invitation(
        appClient,
        actorA,
        `tenant-a-${randomUUID()}@example.test`,
        { auditEventId: globalAuditId },
      );
      const tenantBInvitationId = randomUUID();
      await expectDasherBoundaryError(
        issueTask4Invitation(
          appClient,
          actorB,
          `tenant-b-${randomUUID()}@example.test`,
          {
            auditEventId: globalAuditId,
            invitationId: tenantBInvitationId,
          },
        ),
        "P1002",
        "dasher_conflict",
      );
      expect(
        (
          await ownerPool.query<{ readonly count: string }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.invitations
              WHERE invitation_id = $1::uuid
            `,
            [tenantBInvitationId],
          )
        ).rows[0]?.count,
      ).toBe("0");

      const restoredAuditAcl = await ownerPool.query<{
        readonly columns: string[];
        readonly table_insert: boolean;
      }>(
        `
          SELECT
            pg_catalog.array_agg(
              privilege.column_name
              ORDER BY privilege.column_name
            )::text[] AS columns,
            pg_catalog.has_table_privilege(
              'dasher_security_definer',
              'dasher.audit_events',
              'INSERT'
            ) AS table_insert
          FROM information_schema.column_privileges AS privilege
          WHERE privilege.table_schema = 'dasher'
            AND privilege.table_name = 'audit_events'
            AND privilege.grantee = 'dasher_security_definer'
            AND privilege.privilege_type = 'INSERT'
            AND privilege.is_grantable = 'NO'
        `,
      );
      expect(restoredAuditAcl.rows[0]).toEqual({
        columns: [
          "action",
          "actor_kind",
          "actor_service",
          "actor_user_id",
          "audit_event_id",
          "authority_revision",
          "content_sha256",
          "cost_minor_units",
          "credential_version",
          "deployment_revision",
          "job_id",
          "occurred_at",
          "organization_id",
          "outcome",
          "provider",
          "request_id",
          "source_ref",
          "target_id",
          "target_type",
          "usage_units",
        ],
        table_insert: false,
      });

      await appClient.query("RESET ROLE");
      appClient.release();
    });

    it("serializes invitation empty sets, issue/revoke winner orders and replay, while foreign UUID denial avoids the foreign family lock", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const actorA = await createTask4Actor(first, "admin");
        const actorB = await createTask4Actor(first, "admin");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        const emptyEmail = `empty-${randomUUID()}@example.test`;
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          emptyEmail,
        ]);
        const emptyFirst = issueTask4Invitation(first, actorA, emptyEmail);
        const emptyFirstSettled = retainDatabasePromise(
          retainedOperations,
          emptyFirst,
        );
        const emptySecond = issueTask4Invitation(second, actorA, emptyEmail);
        const emptySecondSettled = retainDatabasePromise(
          retainedOperations,
          emptySecond,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          emptyFirstSettled,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          emptySecondSettled,
        );
        const barrierClock = (
          await observer.query<{ readonly captured_at: Date }>(
            "SELECT pg_catalog.clock_timestamp() AS captured_at",
          )
        ).rows[0]!.captured_at;
        await blocker.query("COMMIT");
        const emptyResults = await Promise.allSettled([
          emptyFirst,
          emptySecond,
        ]);
        expect(emptyResults.map((result) => result.status)).toEqual([
          "fulfilled",
          "fulfilled",
        ]);
        const emptyState = await ownerPool.query<{
          readonly all_after_barrier: boolean;
          readonly pending_count: string;
          readonly revoked_count: string;
        }>(
          `
            SELECT
              pg_catalog.bool_and(created_at > $3::timestamptz)
                AS all_after_barrier,
              pg_catalog.count(*) FILTER (
                WHERE revoked_at IS NULL AND accepted_at IS NULL
              )::text AS pending_count,
              pg_catalog.count(*) FILTER (
                WHERE revoked_at IS NOT NULL
              )::text AS revoked_count
            FROM dasher.invitations
            WHERE organization_id = $1::uuid
              AND normalized_email = $2
          `,
          [actorA.organizationId, emptyEmail, barrierClock],
        );
        expect(emptyState.rows[0]).toEqual({
          all_after_barrier: true,
          pending_count: "1",
          revoked_count: "1",
        });

        const orderedEmail = `ordered-${randomUUID()}@example.test`;
        const original = await issueTask4Invitation(
          first,
          actorA,
          orderedEmail,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          orderedEmail,
        ]);
        const issueWins = issueTask4Invitation(first, actorA, orderedEmail);
        const issueWinsSettled = retainDatabasePromise(
          retainedOperations,
          issueWins,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          issueWinsSettled,
        );
        const revokeLoses = second.query(
          `
            SELECT *
            FROM dasher_api.revoke_invitation(
              $1::uuid, $2::uuid, 1::smallint, $3::bytea,
              1::smallint, $4::bytea, $5::uuid, 'task4-race'
            )
          `,
          [
            original.invitationId,
            randomUUID(),
            actorA.sessionDigest,
            actorA.csrfDigest,
            randomUUID(),
          ],
        );
        const revokeLosesSettled = retainDatabasePromise(
          retainedOperations,
          revokeLoses,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          revokeLosesSettled,
        );
        await blocker.query("COMMIT");
        await expect(issueWins).resolves.toBeDefined();
        await expectDasherBoundaryError(revokeLoses, "P1001", "dasher_denied");

        const revokeFirstTarget = await issueTask4Invitation(
          first,
          actorA,
          `revoke-first-${randomUUID()}@example.test`,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          revokeFirstTarget.normalizedEmail,
        ]);
        const revokeWins = first.query(
          `
            SELECT *
            FROM dasher_api.revoke_invitation(
              $1::uuid, $2::uuid, 1::smallint, $3::bytea,
              1::smallint, $4::bytea, $5::uuid, 'task4-race'
            )
          `,
          [
            revokeFirstTarget.invitationId,
            randomUUID(),
            actorA.sessionDigest,
            actorA.csrfDigest,
            randomUUID(),
          ],
        );
        const revokeWinsSettled = retainDatabasePromise(
          retainedOperations,
          revokeWins,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          revokeWinsSettled,
        );
        const issueAfterRevoke = issueTask4Invitation(
          second,
          actorA,
          revokeFirstTarget.normalizedEmail,
        );
        const issueAfterRevokeSettled = retainDatabasePromise(
          retainedOperations,
          issueAfterRevoke,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          issueAfterRevokeSettled,
        );
        await blocker.query("COMMIT");
        await expect(revokeWins).resolves.toMatchObject({ rowCount: 1 });
        await expect(issueAfterRevoke).resolves.toBeDefined();

        for (const firstOperation of ["accept", "issue"] as const) {
          const issueAcceptTarget = await issueTask4Invitation(
            first,
            actorA,
            `issue-accept-${firstOperation}-${randomUUID()}@example.test`,
          );
          await blocker.query("BEGIN");
          await blocker.query(invitationFamilyLockSql(), [
            actorA.organizationId,
            issueAcceptTarget.normalizedEmail,
          ]);
          const acceptanceOperation = () =>
            acceptTask4Invitation(
              firstOperation === "accept" ? first : second,
              issueAcceptTarget,
              `https://issue-accept-${randomUUID()}.test`,
              randomUUID(),
            );
          const issueOperation = () =>
            issueTask4Invitation(
              firstOperation === "issue" ? first : second,
              actorA,
              issueAcceptTarget.normalizedEmail,
            );
          const queuedFirst =
            firstOperation === "accept"
              ? acceptanceOperation()
              : issueOperation();
          const queuedFirstSettled = retainDatabasePromise<unknown>(
            retainedOperations,
            queuedFirst,
          );
          await waitForDatabaseLock(
            observer,
            firstPid,
            "advisory",
            queuedFirstSettled,
          );
          const queuedSecond =
            firstOperation === "accept"
              ? issueOperation()
              : acceptanceOperation();
          const queuedSecondSettled = retainDatabasePromise<unknown>(
            retainedOperations,
            queuedSecond,
          );
          await waitForDatabaseLock(
            observer,
            secondPid,
            "advisory",
            queuedSecondSettled,
          );
          await blocker.query("COMMIT");
          await expect(queuedFirst).resolves.toBeDefined();
          if (firstOperation === "accept") {
            await expect(queuedSecond).resolves.toBeDefined();
          } else {
            await expectDasherBoundaryError(
              queuedSecond,
              "P1001",
              "dasher_denied",
            );
          }
          const terminal = await ownerPool.query<{
            readonly accepted: boolean;
            readonly pending_count: string;
            readonly revoked: boolean;
          }>(
            `
              SELECT
                target.accepted_at IS NOT NULL AS accepted,
                target.revoked_at IS NOT NULL AS revoked,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.invitations
                  WHERE organization_id = target.organization_id
                    AND normalized_email = target.normalized_email
                    AND accepted_at IS NULL
                    AND revoked_at IS NULL
                ) AS pending_count
              FROM dasher.invitations AS target
              WHERE target.invitation_id = $1::uuid
            `,
            [issueAcceptTarget.invitationId],
          );
          expect(terminal.rows[0]).toEqual(
            firstOperation === "accept"
              ? { accepted: true, pending_count: "1", revoked: false }
              : { accepted: false, pending_count: "1", revoked: true },
          );
        }

        const replayInvitation = await issueTask4Invitation(
          first,
          actorA,
          `replay-${randomUUID()}@example.test`,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorA.organizationId,
          replayInvitation.normalizedEmail,
        ]);
        const issuer = `https://race-${randomUUID()}.test`;
        const subject = randomUUID();
        const acceptanceOne = acceptTask4Invitation(
          first,
          replayInvitation,
          issuer,
          subject,
        );
        const acceptanceOneSettled = retainDatabasePromise(
          retainedOperations,
          acceptanceOne,
        );
        const acceptanceTwo = acceptTask4Invitation(
          second,
          replayInvitation,
          issuer,
          subject,
        );
        const acceptanceTwoSettled = retainDatabasePromise(
          retainedOperations,
          acceptanceTwo,
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          acceptanceOneSettled,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          acceptanceTwoSettled,
        );
        await blocker.query("COMMIT");
        const acceptanceResults = await Promise.allSettled([
          acceptanceOne,
          acceptanceTwo,
        ]);
        expect(
          acceptanceResults.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const rejectedAcceptance = acceptanceResults.find(
          (result) => result.status === "rejected",
        );
        expect(rejectedAcceptance).toBeDefined();
        await expectDasherBoundaryError(
          Promise.reject(
            rejectedAcceptance && "reason" in rejectedAcceptance
              ? rejectedAcceptance.reason
              : new Error("missing replay rejection"),
          ),
          "P1001",
          "dasher_denied",
        );

        const foreignTarget = await issueTask4Invitation(
          first,
          actorB,
          `foreign-${randomUUID()}@example.test`,
        );
        await blocker.query("BEGIN");
        await blocker.query(invitationFamilyLockSql(), [
          actorB.organizationId,
          foreignTarget.normalizedEmail,
        ]);
        const legitimateB = issueTask4Invitation(
          second,
          actorB,
          foreignTarget.normalizedEmail,
        );
        const legitimateBSettled = retainDatabasePromise(
          retainedOperations,
          legitimateB,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          legitimateBSettled,
        );
        await expectDasherBoundaryError(
          first.query(
            `
              SELECT *
              FROM dasher_api.revoke_invitation(
                $1::uuid, $2::uuid, 1::smallint, $3::bytea,
                1::smallint, $4::bytea, $5::uuid, 'task4-race'
              )
            `,
            [
              foreignTarget.invitationId,
              randomUUID(),
              actorA.sessionDigest,
              actorA.csrfDigest,
              randomUUID(),
            ],
          ),
          "P1001",
          "dasher_denied",
        );
        await blocker.query("COMMIT");
        await expect(legitimateB).resolves.toBeDefined();
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("resolves external-identity and membership insertion races without orphan users or duplicate memberships", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const pendingAcceptances: Array<
        Promise<PromiseSettledResult<Task4Acceptance>>
      > = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const adminA = await createTask4Actor(first, "admin");
        const adminB = await createTask4Actor(first, "admin");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        const identityIssuer = `https://identity-race-${randomUUID()}.test`;
        const identitySubject = randomUUID();
        const identityInviteA = await issueTask4Invitation(
          first,
          adminA,
          `identity-a-${randomUUID()}@example.test`,
        );
        const identityInviteB = await issueTask4Invitation(
          second,
          adminB,
          `identity-b-${randomUUID()}@example.test`,
        );
        const proposedUserA = randomUUID();
        const proposedUserB = randomUUID();
        await blocker.query("BEGIN");
        await blocker.query(
          "LOCK TABLE dasher.external_identities IN ACCESS EXCLUSIVE MODE",
        );
        const identityAcceptanceA = settleDatabasePromise(
          acceptTask4Invitation(
            first,
            identityInviteA,
            identityIssuer,
            identitySubject,
            { userId: proposedUserA },
          ),
        );
        const identityAcceptanceB = settleDatabasePromise(
          acceptTask4Invitation(
            second,
            identityInviteB,
            identityIssuer,
            identitySubject,
            { userId: proposedUserB },
          ),
        );
        pendingAcceptances.push(identityAcceptanceA, identityAcceptanceB);
        await waitForDatabaseLock(
          observer,
          firstPid,
          "relation",
          identityAcceptanceA,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          "relation",
          identityAcceptanceB,
        );
        await blocker.query("COMMIT");
        const identityAcceptanceResults = await Promise.all([
          identityAcceptanceA,
          identityAcceptanceB,
        ]);
        for (const result of identityAcceptanceResults) {
          expect(result.status).toBe("fulfilled");
          if (result.status !== "fulfilled") {
            throw result.reason;
          }
        }

        const identityState = await ownerPool.query<{
          readonly identity_count: string;
          readonly membership_count: string;
          readonly proposed_user_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.external_identities
                WHERE issuer = $1 AND subject = $2
              ) AS identity_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships AS membership
                JOIN dasher.external_identities AS identity_row
                  ON identity_row.user_id = membership.user_id
                WHERE identity_row.issuer = $1
                  AND identity_row.subject = $2
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.users
                WHERE user_id = ANY($3::uuid[])
              ) AS proposed_user_count
          `,
          [identityIssuer, identitySubject, [proposedUserA, proposedUserB]],
        );
        expect(identityState.rows[0]).toEqual({
          identity_count: "1",
          membership_count: "2",
          proposed_user_count: "1",
        });

        const membershipIssuer = `https://membership-race-${randomUUID()}.test`;
        const membershipSubject = randomUUID();
        const existingUserId = randomUUID();
        await ownerPool.query(
          "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
          [existingUserId],
        );
        await ownerPool.query(
          `
            INSERT INTO dasher.external_identities (
              issuer, subject, user_id
            ) VALUES ($1, $2, $3::uuid)
          `,
          [membershipIssuer, membershipSubject, existingUserId],
        );
        const membershipInvite = await issueTask4Invitation(
          first,
          adminA,
          `membership-a-${randomUUID()}@example.test`,
        );
        const winningMembershipId = randomUUID();
        const proposedMembershipId = randomUUID();
        const ignoredUserId = randomUUID();
        const acceptanceAuditEventId = randomUUID();
        await blocker.query("BEGIN");
        await blocker.query(
          `
            WITH captured_clock AS (
              SELECT pg_catalog.transaction_timestamp() AS now
            )
            INSERT INTO dasher.memberships (
              membership_id,
              organization_id,
              user_id,
              role,
              state,
              authority_revision,
              created_at,
              updated_at,
              revoked_at
            )
            SELECT
              $1::uuid,
              $2::uuid,
              $3::uuid,
              'editor',
              'active',
              7,
              captured_clock.now,
              captured_clock.now,
              NULL
            FROM captured_clock
          `,
          [winningMembershipId, adminA.organizationId, existingUserId],
        );
        const membershipAcceptance = settleDatabasePromise(
          acceptTask4Invitation(
            first,
            membershipInvite,
            membershipIssuer,
            membershipSubject,
            {
              auditEventId: acceptanceAuditEventId,
              membershipId: proposedMembershipId,
              userId: ignoredUserId,
            },
          ),
        );
        pendingAcceptances.push(membershipAcceptance);
        await waitForDatabaseLock(
          observer,
          firstPid,
          "transactionid",
          membershipAcceptance,
        );
        await blocker.query("COMMIT");
        const membershipAcceptanceResult = await membershipAcceptance;
        expect(membershipAcceptanceResult.status).toBe("fulfilled");
        if (membershipAcceptanceResult.status !== "fulfilled") {
          throw membershipAcceptanceResult.reason;
        }
        const acceptedSessionId = membershipAcceptanceResult.value.sessionId;

        const membershipState = await ownerPool.query<{
          readonly accepted_session_revision: string;
          readonly audit_action: string;
          readonly audit_authority_revision: string;
          readonly audit_organization_id: string;
          readonly audit_target_id: string;
          readonly audit_user_id: string;
          readonly ignored_user_count: string;
          readonly membership_count: string;
          readonly membership_id: string;
          readonly membership_revision: string;
          readonly membership_role: string;
          readonly proposed_membership_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE organization_id = $1::uuid
                  AND user_id = $2::uuid
              ) AS membership_count,
              membership.membership_id::text AS membership_id,
              membership.role AS membership_role,
              membership.authority_revision::text AS membership_revision,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE membership_id = $3::uuid
              ) AS proposed_membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.users
                WHERE user_id = $4::uuid
              ) AS ignored_user_count,
              session_row.authority_revision::text
                AS accepted_session_revision,
              audit.action AS audit_action,
              audit.authority_revision::text
                AS audit_authority_revision,
              audit.organization_id::text AS audit_organization_id,
              audit.actor_user_id::text AS audit_user_id,
              audit.target_id::text AS audit_target_id
            FROM dasher.memberships AS membership
            JOIN dasher.sessions AS session_row
              ON session_row.session_id = $5::uuid
             AND session_row.organization_id = membership.organization_id
             AND session_row.user_id = membership.user_id
            JOIN dasher.audit_events AS audit
              ON audit.audit_event_id = $6::uuid
            WHERE membership.membership_id = $7::uuid
          `,
          [
            adminA.organizationId,
            existingUserId,
            proposedMembershipId,
            ignoredUserId,
            acceptedSessionId,
            acceptanceAuditEventId,
            winningMembershipId,
          ],
        );
        expect(membershipState.rows[0]).toEqual({
          accepted_session_revision: "7",
          audit_action: "invitation.accepted_existing_membership",
          audit_authority_revision: "7",
          audit_organization_id: adminA.organizationId,
          audit_target_id: membershipInvite.invitationId,
          audit_user_id: existingUserId,
          ignored_user_count: "0",
          membership_count: "1",
          membership_id: winningMembershipId,
          membership_revision: "7",
          membership_role: "editor",
          proposed_membership_count: "0",
        });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(pendingAcceptances);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("uses a committed membership insertion winner before later role change or revocation in both operation orders", async () => {
      const authority = await appPool!.connect();
      const winner = await appPool!.connect();
      const loser = await appPool!.connect();
      const observer = await ownerPool.connect();
      try {
        await authority.query("SET ROLE dasher_app");
        await winner.query("SET ROLE dasher_app");
        await loser.query("SET ROLE dasher_app");
        const admin = await createTask4Actor(authority, "admin");
        for (const operation of ["role", "revoke"] as const) {
          for (const firstWaiter of ["loser", "authority"] as const) {
            const issuer = `https://three-way-${randomUUID()}.test`;
            const subject = randomUUID();
            const userId = randomUUID();
            await ownerPool.query(
              "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
              [userId],
            );
            await ownerPool.query(
              `
                INSERT INTO dasher.external_identities (
                  issuer, subject, user_id
                ) VALUES ($1, $2, $3::uuid)
              `,
              [issuer, subject, userId],
            );
            const winnerInvitation = await issueTask4Invitation(
              authority,
              admin,
              `winner-${randomUUID()}@example.test`,
            );
            const loserInvitation = await issueTask4Invitation(
              authority,
              admin,
              `loser-${randomUUID()}@example.test`,
            );
            const membershipId = randomUUID();
            await winner.query("BEGIN");
            await acceptTask4Invitation(
              winner,
              winnerInvitation,
              issuer,
              subject,
              {
                membershipId,
                userId: randomUUID(),
              },
            );
            await winner.query("COMMIT");

            const invokeLoser = () =>
              acceptTask4Invitation(loser, loserInvitation, issuer, subject, {
                membershipId: randomUUID(),
                userId: randomUUID(),
              });
            const invokeAuthority = () =>
              runContextOperation(
                authority,
                admin.sessionDigest,
                randomUUID(),
                () =>
                  operation === "role"
                    ? authority.query(
                        `
                          SELECT *
                          FROM dasher_api.change_membership_role(
                            $1::uuid, 'editor', $2::uuid, 1::smallint,
                            $3::bytea, 'task4-three-way'
                          )
                        `,
                        [membershipId, randomUUID(), admin.csrfDigest],
                      )
                    : authority.query(
                        `
                          SELECT *
                          FROM dasher_api.revoke_membership(
                            $1::uuid, $2::uuid, 1::smallint,
                            $3::bytea, 'task4-three-way'
                          )
                        `,
                        [membershipId, randomUUID(), admin.csrfDigest],
                      ),
              );

            let loserResult: Promise<unknown>;
            let authorityResult: Promise<unknown>;
            if (firstWaiter === "loser") {
              loserResult = invokeLoser();
              await expect(loserResult).resolves.toBeDefined();
              authorityResult = invokeAuthority();
            } else {
              authorityResult = invokeAuthority();
              await expect(authorityResult).resolves.toMatchObject({
                rowCount: 1,
              });
              loserResult = invokeLoser();
            }

            if (firstWaiter === "authority" && operation === "revoke") {
              await expectDasherBoundaryError(
                loserResult,
                "P1001",
                "dasher_denied",
              );
            } else {
              if (firstWaiter === "authority") {
                await expect(loserResult).resolves.toBeDefined();
              } else {
                await expect(authorityResult).resolves.toMatchObject({
                  rowCount: 1,
                });
              }
            }

            const state = await ownerPool.query<{
              readonly membership_count: string;
              readonly membership_revision: string;
              readonly membership_role: string;
              readonly membership_state: string;
              readonly loser_audit_count: string;
            }>(
              `
                SELECT
                  (
                    SELECT pg_catalog.count(*)::text
                    FROM dasher.memberships
                    WHERE organization_id = $1::uuid
                      AND user_id = $2::uuid
                  ) AS membership_count,
                  membership.role AS membership_role,
                  membership.state AS membership_state,
                  membership.authority_revision::text AS membership_revision,
                  (
                    SELECT pg_catalog.count(*)::text
                    FROM dasher.audit_events
                    WHERE target_id = $3::uuid
                      AND action =
                        'invitation.accepted_existing_membership'
                  ) AS loser_audit_count
                FROM dasher.memberships AS membership
                WHERE membership.membership_id = $4::uuid
              `,
              [
                admin.organizationId,
                userId,
                loserInvitation.invitationId,
                membershipId,
              ],
            );
            expect(state.rows[0]).toMatchObject({
              membership_count: "1",
              membership_revision: "2",
              membership_role: operation === "role" ? "editor" : "viewer",
              membership_state: operation === "revoke" ? "revoked" : "active",
              loser_audit_count:
                firstWaiter === "authority" && operation === "revoke"
                  ? "0"
                  : "1",
            });
          }
        }
      } finally {
        await winner.query("ROLLBACK").catch(() => undefined);
        await authority.query("ROLLBACK").catch(() => undefined);
        await loser.query("ROLLBACK").catch(() => undefined);
        await authority.query("RESET ROLE").catch(() => undefined);
        await winner.query("RESET ROLE").catch(() => undefined);
        await loser.query("RESET ROLE").catch(() => undefined);
        authority.release();
        winner.release();
        loser.release();
        observer.release();
      }
    });

    it("serializes acceptance against role change and membership revocation in both lock-winner orders", async () => {
      const authority = await appPool!.connect();
      const acceptance = await appPool!.connect();
      const observer = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await authority.query("SET ROLE dasher_app");
        await acceptance.query("SET ROLE dasher_app");
        const admin = await createTask4Actor(authority, "admin");
        const authorityPid = await appBackendPid(authority);
        const acceptancePid = await appBackendPid(acceptance);

        for (const operation of ["role", "revoke"] as const) {
          for (const winner of ["authority", "acceptance"] as const) {
            const target = await createTask4Actor(
              authority,
              "viewer",
              admin.organizationId,
            );
            const invitation = await issueTask4Invitation(
              authority,
              admin,
              `${operation}-${winner}-${randomUUID()}@example.test`,
            );
            const acceptedSessionId = randomUUID();
            const invokeAuthority = () =>
              operation === "role"
                ? authority.query(
                    `
                      SELECT *
                      FROM dasher_api.change_membership_role(
                        $1::uuid, 'editor', $2::uuid, 1::smallint,
                        $3::bytea, 'task4-acceptance-authority-race'
                      )
                    `,
                    [target.membershipId, randomUUID(), admin.csrfDigest],
                  )
                : authority.query(
                    `
                      SELECT *
                      FROM dasher_api.revoke_membership(
                        $1::uuid, $2::uuid, 1::smallint,
                        $3::bytea, 'task4-acceptance-authority-race'
                      )
                    `,
                    [target.membershipId, randomUUID(), admin.csrfDigest],
                  );
            const invokeAcceptance = () =>
              acceptTask4Invitation(
                acceptance,
                invitation,
                target.identityIssuer,
                target.identitySubject,
                {
                  membershipId: randomUUID(),
                  sessionId: acceptedSessionId,
                  userId: randomUUID(),
                },
              );

            if (winner === "authority") {
              await beginTask4Context(authority, admin.sessionDigest);
              await invokeAuthority();
              const waitingAcceptance = retainDatabasePromise(
                retainedOperations,
                invokeAcceptance(),
              );
              await waitForDatabaseLock(
                observer,
                acceptancePid,
                "advisory",
                waitingAcceptance,
              );
              await authority.query("COMMIT");
              const acceptanceResult = await waitingAcceptance;
              if (operation === "role") {
                expect(acceptanceResult.status).toBe("fulfilled");
              } else {
                expect(acceptanceResult.status).toBe("rejected");
                await expectDasherBoundaryError(
                  Promise.reject(
                    acceptanceResult.status === "rejected"
                      ? acceptanceResult.reason
                      : new Error("missing acceptance denial"),
                  ),
                  "P1001",
                  "dasher_denied",
                );
              }
            } else {
              await acceptance.query("BEGIN");
              await invokeAcceptance();
              const waitingAuthority = retainDatabasePromise(
                retainedOperations,
                (async () => {
                  await beginTask4Context(authority, admin.sessionDigest);
                  return invokeAuthority();
                })(),
              );
              await waitForDatabaseLock(
                observer,
                authorityPid,
                "advisory",
                waitingAuthority,
              );
              await acceptance.query("COMMIT");
              const authorityResult = await waitingAuthority;
              expect(authorityResult.status).toBe("fulfilled");
              await authority.query("COMMIT");
            }

            const finalState = await ownerPool.query<{
              readonly accepted: boolean;
              readonly membership_revision: string;
              readonly membership_state: string;
              readonly session_reason: string | null;
            }>(
              `
                SELECT
                  invitation.accepted_at IS NOT NULL AS accepted,
                  membership.authority_revision::text AS membership_revision,
                  membership.state AS membership_state,
                  session_row.revocation_reason AS session_reason
                FROM dasher.invitations AS invitation
                JOIN dasher.memberships AS membership
                  ON membership.membership_id = $2::uuid
                LEFT JOIN dasher.sessions AS session_row
                  ON session_row.session_id = $3::uuid
                WHERE invitation.invitation_id = $1::uuid
              `,
              [invitation.invitationId, target.membershipId, acceptedSessionId],
            );
            if (winner === "authority" && operation === "revoke") {
              expect(finalState.rows[0]).toMatchObject({
                accepted: false,
                membership_revision: "2",
                membership_state: "revoked",
                session_reason: null,
              });
            } else {
              expect(finalState.rows[0]).toMatchObject({
                accepted: true,
                membership_revision: "2",
                membership_state: operation === "revoke" ? "revoked" : "active",
                session_reason:
                  winner === "acceptance" ? "authority_changed" : null,
              });
            }
          }
        }
      } finally {
        await authority.query("ROLLBACK").catch(() => undefined);
        await acceptance.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await authority.query("RESET ROLE").catch(() => undefined);
        await acceptance.query("RESET ROLE").catch(() => undefined);
        authority.release();
        acceptance.release();
        observer.release();
      }
    });

    it("preserves a last admin in both lock-winner orders and denies foreign membership UUIDs before their row lock", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");

        for (const advisoryWinner of ["first", "second"] as const) {
          const adminA = await createTask4Actor(first, "admin");
          const adminB = await createTask4Actor(
            first,
            "admin",
            adminA.organizationId,
          );
          const secondPid = await appBackendPid(second);
          const winnerClient = advisoryWinner === "first" ? first : second;
          const winnerActor = advisoryWinner === "first" ? adminA : adminB;
          const loserClient = advisoryWinner === "first" ? second : first;
          const loserActor = advisoryWinner === "first" ? adminB : adminA;
          const loserPid =
            advisoryWinner === "first" ? secondPid : await appBackendPid(first);

          await beginTask4Context(
            winnerClient,
            winnerActor.sessionDigest,
            randomUUID(),
          );
          const loserContext = retainDatabasePromise(
            retainedOperations,
            beginTask4Context(
              loserClient,
              loserActor.sessionDigest,
              randomUUID(),
            ),
          );
          await waitForDatabaseLock(
            observer,
            loserPid,
            "advisory",
            loserContext,
          );

          if (advisoryWinner === "first") {
            await first.query(
              `
                SELECT *
                FROM dasher_api.change_membership_role(
                  $1::uuid, 'viewer', $2::uuid, 1::smallint,
                  $3::bytea, 'task4-last-admin'
                )
              `,
              [adminB.membershipId, randomUUID(), adminA.csrfDigest],
            );
          } else {
            await second.query(
              `
                SELECT *
                FROM dasher_api.revoke_membership(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-last-admin'
                )
              `,
              [adminA.membershipId, randomUUID(), adminB.csrfDigest],
            );
          }
          await winnerClient.query("COMMIT");

          const loserContextResult = await loserContext;
          if (loserContextResult.status === "fulfilled") {
            const loserOperation =
              advisoryWinner === "first"
                ? loserClient.query(
                    `
                      SELECT *
                      FROM dasher_api.revoke_membership(
                        $1::uuid, $2::uuid, 1::smallint,
                        $3::bytea, 'task4-last-admin'
                      )
                    `,
                    [adminA.membershipId, randomUUID(), adminB.csrfDigest],
                  )
                : loserClient.query(
                    `
                      SELECT *
                      FROM dasher_api.change_membership_role(
                        $1::uuid, 'viewer', $2::uuid, 1::smallint,
                        $3::bytea, 'task4-last-admin'
                      )
                    `,
                    [adminB.membershipId, randomUUID(), adminA.csrfDigest],
                  );
            await expectDasherBoundaryError(
              loserOperation,
              "P1001",
              "dasher_denied",
            );
          } else {
            await expectDasherBoundaryError(
              Promise.reject(loserContextResult.reason),
              "P1001",
              "dasher_denied",
            );
          }
          await loserClient.query("ROLLBACK");

          const activeAdmins = await ownerPool.query<{
            readonly count: string;
          }>(
            `
              SELECT pg_catalog.count(*)::text AS count
              FROM dasher.memberships
              WHERE organization_id = $1::uuid
                AND role = 'admin'
                AND state = 'active'
            `,
            [adminA.organizationId],
          );
          expect(activeAdmins.rows[0]?.count).toBe("1");
        }

        const adminA = await createTask4Actor(first, "admin");
        const adminB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          adminA.organizationId,
          adminB.organizationId,
        );
        const targetB = await createTask4Actor(
          first,
          "viewer",
          adminB.organizationId,
        );
        const secondPid = await appBackendPid(second);
        await blocker.query("BEGIN");
        await blocker.query(
          `
            SELECT 1
            FROM dasher.memberships
            WHERE membership_id = $1::uuid
            FOR UPDATE
          `,
          [targetB.membershipId],
        );
        const legitimateB = runContextOperation(
          second,
          adminB.sessionDigest,
          randomUUID(),
          () =>
            second.query(
              `
                SELECT *
                FROM dasher_api.change_membership_role(
                  $1::uuid, 'editor', $2::uuid, 1::smallint,
                  $3::bytea, 'task4-foreign-membership'
                )
              `,
              [targetB.membershipId, randomUUID(), adminB.csrfDigest],
            ),
        );
        const legitimateBSettled = retainDatabasePromise(
          retainedOperations,
          legitimateB,
        );
        await waitForDatabaseLock(
          observer,
          secondPid,
          ["transactionid", "tuple"],
          legitimateBSettled,
        );
        for (const operation of ["change", "revoke"] as const) {
          await expectDasherBoundaryError(
            runContextOperation(
              first,
              adminA.sessionDigest,
              randomUUID(),
              () =>
                operation === "change"
                  ? first.query(
                      `
                        SELECT *
                        FROM dasher_api.change_membership_role(
                          $1::uuid, 'editor', $2::uuid, 1::smallint,
                          $3::bytea, 'task4-foreign-membership'
                        )
                      `,
                      [targetB.membershipId, randomUUID(), adminA.csrfDigest],
                    )
                  : first.query(
                      `
                        SELECT *
                        FROM dasher_api.revoke_membership(
                          $1::uuid, $2::uuid, 1::smallint,
                          $3::bytea, 'task4-foreign-membership'
                        )
                      `,
                      [targetB.membershipId, randomUUID(), adminA.csrfDigest],
                    ),
            ),
            "P1001",
            "dasher_denied",
          );
        }
        await blocker.query("COMMIT");
        await expect(legitimateB).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("serializes context membership changes against acceptance and issue collisions in both organization-key orders", async () => {
      const contextClient = await appPool!.connect();
      const entryClient = await appPool!.connect();
      const observer = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await contextClient.query("SET ROLE dasher_app");
        await entryClient.query("SET ROLE dasher_app");
        const entryPid = await appBackendPid(entryClient);

        for (const entry of ["accept", "issue"] as const) {
          for (const mutation of ["role", "revoke"] as const) {
            for (const winner of ["entry", "context"] as const) {
              const admin = await createTask4Actor(contextClient, "admin");
              const target = await createTask4Actor(
                contextClient,
                "viewer",
                admin.organizationId,
              );
              const entryAuditId = randomUUID();
              const mutationAuditId = randomUUID();
              const invitation =
                entry === "accept"
                  ? await issueTask4Invitation(
                      contextClient,
                      admin,
                      `context-entry-${randomUUID()}@example.test`,
                    )
                  : undefined;

              const invokeEntry = (): Promise<unknown> =>
                entry === "accept"
                  ? acceptTask4Invitation(
                      entryClient,
                      invitation!,
                      target.identityIssuer,
                      target.identitySubject,
                      {
                        auditEventId: entryAuditId,
                        sessionId: admin.sessionId,
                      },
                    )
                  : entryClient.query(
                      `
                        SELECT *
                        FROM dasher_api.issue_session(
                          $1, $2, $3::uuid, $4::uuid, 1::smallint,
                          $5::bytea, 1::smallint, $6::bytea, $7::uuid,
                          $8::uuid, 'task4-context-entry'
                        )
                      `,
                      [
                        target.identityIssuer,
                        target.identitySubject,
                        target.membershipId,
                        admin.sessionId,
                        randomBytes(32),
                        randomBytes(32),
                        entryAuditId,
                        randomUUID(),
                      ],
                    );
              const invokeMutation = () =>
                mutation === "role"
                  ? contextClient.query(
                      `
                        SELECT *
                        FROM dasher_api.change_membership_role(
                          $1::uuid, 'editor', $2::uuid, 1::smallint,
                          $3::bytea, 'task4-context-entry'
                        )
                      `,
                      [target.membershipId, mutationAuditId, admin.csrfDigest],
                    )
                  : contextClient.query(
                      `
                        SELECT *
                        FROM dasher_api.revoke_membership(
                          $1::uuid, $2::uuid, 1::smallint,
                          $3::bytea, 'task4-context-entry'
                        )
                      `,
                      [target.membershipId, mutationAuditId, admin.csrfDigest],
                    );

              if (winner === "entry") {
                await expectDasherBoundaryError(
                  invokeEntry(),
                  "P1002",
                  "dasher_conflict",
                );
                await runContextOperation(
                  contextClient,
                  admin.sessionDigest,
                  randomUUID(),
                  invokeMutation,
                );
              } else {
                await beginTask4Context(
                  contextClient,
                  admin.sessionDigest,
                  randomUUID(),
                );
                await invokeMutation();
                const entryResult = retainDatabasePromise(
                  retainedOperations,
                  invokeEntry(),
                );
                await waitForDatabaseLock(
                  observer,
                  entryPid,
                  "advisory",
                  entryResult,
                );
                await contextClient.query("COMMIT");
                const settledEntry = await entryResult;
                expect(settledEntry.status).toBe("rejected");
                await expectDasherBoundaryError(
                  Promise.reject(
                    settledEntry.status === "rejected"
                      ? settledEntry.reason
                      : new Error("missing context-entry loser"),
                  ),
                  mutation === "revoke" ? "P1001" : "P1002",
                  mutation === "revoke" ? "dasher_denied" : "dasher_conflict",
                );
              }

              const state = await ownerPool.query<{
                readonly entry_audit_count: string;
                readonly mutation_audit_count: string;
                readonly session_count: string;
              }>(
                `
                  SELECT
                    (
                      SELECT pg_catalog.count(*)::text
                      FROM dasher.sessions
                      WHERE session_id = $1::uuid
                    ) AS session_count,
                    (
                      SELECT pg_catalog.count(*)::text
                      FROM dasher.audit_events
                      WHERE audit_event_id = $2::uuid
                    ) AS entry_audit_count,
                    (
                      SELECT pg_catalog.count(*)::text
                      FROM dasher.audit_events
                      WHERE audit_event_id = $3::uuid
                    ) AS mutation_audit_count
                `,
                [admin.sessionId, entryAuditId, mutationAuditId],
              );
              expect(state.rows[0]).toEqual({
                entry_audit_count: "0",
                mutation_audit_count: "1",
                session_count: "1",
              });
            }
          }
        }
      } finally {
        await contextClient.query("ROLLBACK").catch(() => undefined);
        await entryClient.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await contextClient.query("RESET ROLE").catch(() => undefined);
        await entryClient.query("RESET ROLE").catch(() => undefined);
        contextClient.release();
        entryClient.release();
        observer.release();
      }
    });

    it("canonically locks reverse session IDs, returns one concurrent rotation conflict, and rolls lineage back on audit failure", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const observer = await ownerPool.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const actor = await createTask4Actor(first, "admin");
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        await blocker.query("BEGIN");
        await blocker.query(
          `
            SELECT 1
            FROM dasher.memberships
            WHERE membership_id = $1::uuid
            FOR UPDATE
          `,
          [actor.membershipId],
        );
        await first.query("BEGIN");
        await second.query("BEGIN");
        await setTask4ContextGucs(first, actor, randomUUID());
        await setTask4ContextGucs(second, actor, randomUUID());
        const successorOne = randomUUID();
        const successorTwo = randomUUID();
        const rotateOne = retainDatabasePromise(
          retainedOperations,
          first.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-concurrent-rotation'
              )
            `,
            [
              successorOne,
              randomBytes(32),
              randomBytes(32),
              randomUUID(),
              actor.csrfDigest,
            ],
          ),
        );
        await waitForDatabaseLock(
          observer,
          firstPid,
          "transactionid",
          rotateOne,
        );
        const rotateTwo = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-concurrent-rotation'
              )
            `,
            [
              successorTwo,
              randomBytes(32),
              randomBytes(32),
              randomUUID(),
              actor.csrfDigest,
            ],
          ),
        );
        await waitForDatabaseLock(observer, secondPid, "advisory", rotateTwo);
        await blocker.query("COMMIT");
        const rotateOneResult = await rotateOne;
        expect(rotateOneResult.status).toBe("fulfilled");
        await first.query("COMMIT");
        const rotateTwoResult = await rotateTwo;
        expect(rotateTwoResult.status).toBe("rejected");
        await expectDasherBoundaryError(
          Promise.reject(
            rotateTwoResult.status === "rejected"
              ? rotateTwoResult.reason
              : new Error("missing rotation conflict"),
          ),
          "P1002",
          "dasher_conflict",
        );
        await second.query("ROLLBACK");
        const rotationState = await ownerPool.query<{
          readonly predecessor_link: string | null;
          readonly successor_count: string;
        }>(
          `
            SELECT
              (
                SELECT replaced_by_session_id::text
                FROM dasher.sessions
                WHERE session_id = $1::uuid
              ) AS predecessor_link,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($2::uuid[])
              ) AS successor_count
          `,
          [actor.sessionId, [successorOne, successorTwo]],
        );
        expect(rotationState.rows[0]).toEqual({
          predecessor_link: successorOne,
          successor_count: "1",
        });

        for (const firstOperation of ["rotate", "revoke"] as const) {
          const lineageActor = await createTask4Actor(first, "admin");
          const predecessorId =
            firstOperation === "rotate"
              ? "ffffffff-ffff-4fff-8fff-ffffffffffe1"
              : "00000000-0000-4000-8000-0000000000e1";
          const revokerId =
            firstOperation === "rotate"
              ? "00000000-0000-4000-8000-0000000000e2"
              : "ffffffff-ffff-4fff-8fff-ffffffffffe2";
          const predecessorProof = await issueAdditionalTask4Session(
            first,
            lineageActor,
            predecessorId,
          );
          const revokerProof = await issueAdditionalTask4Session(
            first,
            lineageActor,
            revokerId,
          );
          const predecessor = {
            ...lineageActor,
            ...predecessorProof,
            sessionId: predecessorId,
          };
          const revoker = {
            ...lineageActor,
            ...revokerProof,
            sessionId: revokerId,
          };
          const lineageSuccessorId = randomUUID();
          await blocker.query("BEGIN");
          await blocker.query(
            `
              SELECT 1
              FROM dasher.memberships
              WHERE membership_id = $1::uuid
              FOR UPDATE
            `,
            [lineageActor.membershipId],
          );
          await first.query("BEGIN");
          await second.query("BEGIN");
          await setTask4ContextGucs(first, predecessor, randomUUID());
          await setTask4ContextGucs(second, revoker, randomUUID());
          const invokeRotate = () =>
            first.query(
              `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                  $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                  'task4-rotate-revoke'
                )
              `,
              [
                lineageSuccessorId,
                randomBytes(32),
                randomBytes(32),
                randomUUID(),
                predecessor.csrfDigest,
              ],
            );
          const invokeRevoke = () =>
            second.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-rotate-revoke'
                )
              `,
              [predecessor.sessionId, randomUUID(), revoker.csrfDigest],
            );
          const firstResult = retainDatabasePromise(
            retainedOperations,
            firstOperation === "rotate" ? invokeRotate() : invokeRevoke(),
          );
          await waitForDatabaseLock(
            observer,
            firstOperation === "rotate" ? firstPid : secondPid,
            "transactionid",
            firstResult,
          );
          const secondResult = retainDatabasePromise(
            retainedOperations,
            firstOperation === "rotate" ? invokeRevoke() : invokeRotate(),
          );
          await waitForDatabaseLock(
            observer,
            firstOperation === "rotate" ? secondPid : firstPid,
            "advisory",
            secondResult,
          );
          await blocker.query("COMMIT");
          const settledFirst = await firstResult;
          expect(settledFirst.status).toBe("fulfilled");
          await (firstOperation === "rotate" ? first : second).query("COMMIT");
          const settledSecond = await secondResult;
          if (firstOperation === "rotate") {
            expect(settledSecond.status).toBe("fulfilled");
            await second.query("COMMIT");
          } else {
            expect(settledSecond.status).toBe("rejected");
            await expectDasherBoundaryError(
              Promise.reject(
                settledSecond.status === "rejected"
                  ? settledSecond.reason
                  : new Error("missing rotate/revoke denial"),
              ),
              "P1001",
              "dasher_denied",
            );
            await first.query("ROLLBACK");
          }
          const lineageState = await ownerPool.query<{
            readonly predecessor_revoked: boolean;
            readonly successor_count: string;
          }>(
            `
              SELECT
                revoked_at IS NOT NULL AS predecessor_revoked,
                (
                  SELECT pg_catalog.count(*)::text
                  FROM dasher.sessions
                  WHERE session_id = $2::uuid
                ) AS successor_count
              FROM dasher.sessions
              WHERE session_id = $1::uuid
            `,
            [predecessorId, lineageSuccessorId],
          );
          expect(lineageState.rows[0]).toEqual({
            predecessor_revoked: true,
            successor_count: firstOperation === "rotate" ? "1" : "0",
          });
        }

        for (const [currentId, targetId] of [
          [
            "ffffffff-ffff-4fff-8fff-fffffffffff1",
            "00000000-0000-4000-8000-000000000001",
          ],
          [
            "00000000-0000-4000-8000-000000000002",
            "ffffffff-ffff-4fff-8fff-fffffffffff2",
          ],
        ] as const) {
          const raceActor = await createTask4Actor(first, "admin");
          const currentProof = await issueAdditionalTask4Session(
            first,
            raceActor,
            currentId,
          );
          const targetProof = await issueAdditionalTask4Session(
            first,
            raceActor,
            targetId,
          );
          const current = {
            ...raceActor,
            ...currentProof,
            sessionId: currentId,
          };
          const target = {
            ...raceActor,
            ...targetProof,
            sessionId: targetId,
          };
          await blocker.query("BEGIN");
          await blocker.query(
            `
              SELECT 1
              FROM dasher.memberships
              WHERE membership_id = $1::uuid
              FOR UPDATE
            `,
            [raceActor.membershipId],
          );
          await first.query("BEGIN");
          await second.query("BEGIN");
          await setTask4ContextGucs(first, current, randomUUID());
          await setTask4ContextGucs(second, target, randomUUID());
          const revokeTarget = retainDatabasePromise(
            retainedOperations,
            first.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-reverse-session'
                )
              `,
              [target.sessionId, randomUUID(), current.csrfDigest],
            ),
          );
          await waitForDatabaseLock(
            observer,
            firstPid,
            "transactionid",
            revokeTarget,
          );
          const revokeCurrent = retainDatabasePromise(
            retainedOperations,
            second.query(
              `
                SELECT *
                FROM dasher_api.revoke_session(
                  $1::uuid, $2::uuid, 1::smallint,
                  $3::bytea, 'task4-reverse-session'
                )
              `,
              [current.sessionId, randomUUID(), target.csrfDigest],
            ),
          );
          await waitForDatabaseLock(
            observer,
            secondPid,
            "advisory",
            revokeCurrent,
          );
          await blocker.query("COMMIT");
          const revokeTargetResult = await revokeTarget;
          expect(revokeTargetResult.status).toBe("fulfilled");
          await first.query("COMMIT");
          const revokeCurrentResult = await revokeCurrent;
          expect(revokeCurrentResult.status).toBe("rejected");
          await expectDasherBoundaryError(
            Promise.reject(
              revokeCurrentResult.status === "rejected"
                ? revokeCurrentResult.reason
                : new Error("missing reverse session denial"),
            ),
            "P1001",
            "dasher_denied",
          );
          await second.query("ROLLBACK");
        }

        const failureActor = await createTask4Actor(first, "admin");
        const failedSuccessor = randomUUID();
        const failedAuditId = randomUUID();
        const revoker = await ownerPool.connect();
        try {
          await revoker.query("BEGIN");
          await revoker.query(`
            REVOKE INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            FROM dasher_security_definer
          `);
          await revoker.query("COMMIT");
        } finally {
          revoker.release();
        }
        try {
          await expectPostgresError(
            runContextOperation(
              first,
              failureActor.sessionDigest,
              randomUUID(),
              () =>
                first.query(
                  `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-rotation-audit-failure'
                    )
                  `,
                  [
                    failedSuccessor,
                    randomBytes(32),
                    randomBytes(32),
                    failedAuditId,
                    failureActor.csrfDigest,
                  ],
                ),
            ),
            "42501",
          );
        } finally {
          const restorer = await ownerPool.connect();
          try {
            await restorer.query("BEGIN");
            await restorer.query(`
              GRANT INSERT (${task4AuditColumnsSql})
              ON dasher.audit_events
              TO dasher_security_definer
            `);
            await restorer.query("COMMIT");
          } finally {
            restorer.release();
          }
        }
        const failureState = await ownerPool.query<{
          readonly audit_count: string;
          readonly predecessor_link: string | null;
          readonly successor_count: string;
        }>(
          `
            SELECT
              (
                SELECT replaced_by_session_id::text
                FROM dasher.sessions
                WHERE session_id = $1::uuid
              ) AS predecessor_link,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = $2::uuid
              ) AS successor_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = $3::uuid
              ) AS audit_count
          `,
          [failureActor.sessionId, failedSuccessor, failedAuditId],
        );
        expect(failureState.rows[0]).toEqual({
          audit_count: "0",
          predecessor_link: null,
          successor_count: "0",
        });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
        observer.release();
        blocker.release();
      }
    });

    it("keeps rotation aliases source-locked and rejects cross-organization reverse collisions without deadlock", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");

        const lineageActor = await createTask4Actor(first, "admin");
        const lineageSessionId = randomUUID();
        const lineageSessionDigest = randomBytes(32);
        const lineageCsrfDigest = randomBytes(32);
        await runContextOperation(
          first,
          lineageActor.sessionDigest,
          randomUUID(),
          () =>
            first.query(
              `
                SELECT *
                FROM dasher_api.rotate_session(
                  $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                  $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                  'task4-lineage-alias'
                )
              `,
              [
                lineageSessionId,
                lineageSessionDigest,
                lineageCsrfDigest,
                randomUUID(),
                lineageActor.csrfDigest,
              ],
            ),
        );
        const lineageCurrent = {
          ...lineageActor,
          csrfDigest: lineageCsrfDigest,
          sessionDigest: lineageSessionDigest,
          sessionId: lineageSessionId,
        };

        for (const proposedId of [
          lineageCurrent.sessionId,
          lineageActor.sessionId,
        ]) {
          const auditEventId = randomUUID();
          await expectDasherBoundaryError(
            runContextOperation(
              first,
              lineageCurrent.sessionDigest,
              randomUUID(),
              () =>
                first.query(
                  `
                    SELECT *
                    FROM dasher_api.rotate_session(
                      $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                      $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                      'task4-lineage-alias'
                    )
                  `,
                  [
                    proposedId,
                    randomBytes(32),
                    randomBytes(32),
                    auditEventId,
                    lineageCurrent.csrfDigest,
                  ],
                ),
            ),
            "P1002",
            "dasher_conflict",
          );
          expect(
            (
              await ownerPool.query<{ readonly count: string }>(
                `
                  SELECT pg_catalog.count(*)::text AS count
                  FROM dasher.audit_events
                  WHERE audit_event_id = $1::uuid
                `,
                [auditEventId],
              )
            ).rows[0]?.count,
          ).toBe("0");
        }
        expect(
          (
            await ownerPool.query<{
              readonly replaced_by_session_id: string | null;
              readonly rotated_from_session_id: string | null;
            }>(
              `
                SELECT
                  rotated_from_session_id::text,
                  replaced_by_session_id::text
                FROM dasher.sessions
                WHERE session_id = $1::uuid
              `,
              [lineageSessionId],
            )
          ).rows[0],
        ).toEqual({
          replaced_by_session_id: null,
          rotated_from_session_id: lineageActor.sessionId,
        });

        const actorA = await createTask4Actor(first, "admin");
        const actorB = await createTask4Actor(first, "admin");
        await expectTask4OrganizationKeysDistinct(
          actorA.organizationId,
          actorB.organizationId,
        );

        await beginTask4Context(first, actorA.sessionDigest, randomUUID());
        await beginTask4Context(second, actorB.sessionDigest, randomUUID());
        const auditA = randomUUID();
        const auditB = randomUUID();
        const rotationA = retainDatabasePromise(
          retainedOperations,
          first.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-cross-org-reverse'
              )
            `,
            [
              actorB.sessionId,
              randomBytes(32),
              randomBytes(32),
              auditA,
              actorA.csrfDigest,
            ],
          ),
        );
        const rotationB = retainDatabasePromise(
          retainedOperations,
          second.query(
            `
              SELECT *
              FROM dasher_api.rotate_session(
                $1::uuid, 1::smallint, $2::bytea, 1::smallint,
                $3::bytea, $4::uuid, 1::smallint, $5::bytea,
                'task4-cross-org-reverse'
              )
            `,
            [
              actorA.sessionId,
              randomBytes(32),
              randomBytes(32),
              auditB,
              actorB.csrfDigest,
            ],
          ),
        );
        const [resultA, resultB] = await Promise.all([rotationA, rotationB]);
        for (const result of [resultA, resultB]) {
          expect(result.status).toBe("rejected");
          await expectDasherBoundaryError(
            Promise.reject(
              result.status === "rejected"
                ? result.reason
                : new Error("missing reverse collision"),
            ),
            "P1002",
            "dasher_conflict",
          );
        }
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");

        const reverseState = await ownerPool.query<{
          readonly audit_count: string;
          readonly changed_count: string;
        }>(
          `
            SELECT
              pg_catalog.count(*) FILTER (
                WHERE session_id = ANY($1::uuid[])
                  AND replaced_by_session_id IS NOT NULL
              )::text AS changed_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($2::uuid[])
              ) AS audit_count
            FROM dasher.sessions
          `,
          [
            [actorA.sessionId, actorB.sessionId],
            [auditA, auditB],
          ],
        );
        expect(reverseState.rows[0]).toEqual({
          audit_count: "0",
          changed_count: "0",
        });
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        first.release();
        second.release();
      }
    });

    it("runs Task 6 repository issue and accept with exact DB winners, session, cookie, identity, and audit", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const actor = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const invitationId = randomUUID();
        const issueAuditId = randomUUID();
        const proposedUserId = randomUUID();
        const proposedMembershipId = randomUUID();
        const proposedSessionId = randomUUID();
        const acceptAuditId = randomUUID();
        const repository = createTask6Repository(client, keyRing, [
          invitationId,
          issueAuditId,
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ]);
        const email = `task6-${randomUUID()}@example.test`;
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email: email.toUpperCase(),
          role: "editor",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        const issuer = "https://task6-provider.test/exact";
        const subject = randomUUID();
        const accepted = await repository.acceptInvitation({
          requestId: randomUUID(),
          inviteToken: issued.inviteToken,
          principal: task6Principal(email, issuer, subject),
        });

        expect(issued.invitationId).toBe(invitationId);
        expect(issued.expiresAt).toBeInstanceOf(Date);
        expect(accepted).toMatchObject({
          userId: proposedUserId,
          organizationId: actor.organizationId,
          membershipId: proposedMembershipId,
          sessionId: proposedSessionId,
          role: "editor",
          authorityRevision: 1,
        });
        expect(accepted.sessionCookie).toMatchObject({
          name: "__Host-dasher_session",
          secure: true,
          httpOnly: true,
          path: "/",
          sameSite: "lax",
        });
        expect([604_799, 604_800]).toContain(accepted.sessionCookie.maxAge);
        expect(accepted.idleExpiresAt.getTime()).toBeLessThan(
          accepted.absoluteExpiresAt.getTime(),
        );

        const sessionPersistence = keyRing.verify(
          "session",
          accepted.sessionToken,
        );
        const csrfPersistence = keyRing.verify("csrf", accepted.csrfValue);
        const persisted = await ownerPool.query<{
          readonly accepted_user_id: string;
          readonly action: string[];
          readonly csrf_digest: string;
          readonly identity_user_id: string;
          readonly invitation_expires_at: Date;
          readonly session_digest: string;
          readonly session_idle_expires_at: Date;
          readonly session_absolute_expires_at: Date;
        }>(
          `
            SELECT
              invitation.accepted_user_id::text,
              invitation.expires_at AS invitation_expires_at,
              identity_row.user_id::text AS identity_user_id,
              pg_catalog.encode(session_row.token_digest, 'hex') AS session_digest,
              pg_catalog.encode(session_row.csrf_digest, 'hex') AS csrf_digest,
              session_row.idle_expires_at AS session_idle_expires_at,
              session_row.absolute_expires_at AS session_absolute_expires_at,
              ARRAY(
                SELECT audit.action
                FROM dasher.audit_events AS audit
                WHERE audit.audit_event_id = ANY($7::uuid[])
                ORDER BY audit.action
              ) AS action
            FROM dasher.invitations AS invitation
            JOIN dasher.external_identities AS identity_row
              ON identity_row.issuer = $2
             AND identity_row.subject = $3
            JOIN dasher.sessions AS session_row
              ON session_row.session_id = $4::uuid
            WHERE invitation.invitation_id = $1::uuid
              AND session_row.user_id = $5::uuid
              AND session_row.organization_id = $6::uuid
          `,
          [
            invitationId,
            issuer,
            subject,
            proposedSessionId,
            proposedUserId,
            actor.organizationId,
            [issueAuditId, acceptAuditId],
          ],
        );
        expect(persisted.rows[0]).toMatchObject({
          accepted_user_id: proposedUserId,
          identity_user_id: proposedUserId,
          invitation_expires_at: issued.expiresAt,
          session_idle_expires_at: accepted.idleExpiresAt,
          session_absolute_expires_at: accepted.absoluteExpiresAt,
          session_digest: Buffer.from(sessionPersistence.digest).toString(
            "hex",
          ),
          csrf_digest: Buffer.from(csrfPersistence.digest).toString("hex"),
          action: ["invitation.accepted", "invitation.issued"],
        });
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("keeps an exact immutable identity and existing active membership unchanged through Task 6 wrappers", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const admin = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const existing = await createTask4Actor(
          client,
          "viewer",
          admin.organizationId,
        );
        const proposedUserId = randomUUID();
        const proposedMembershipId = randomUUID();
        const proposedSessionId = randomUUID();
        const repository = createTask6Repository(client, keyRing, [
          randomUUID(),
          randomUUID(),
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          randomUUID(),
        ]);
        const email = `existing-${randomUUID()}@example.test`;
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "admin",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        const accepted = await repository.acceptInvitation({
          requestId: randomUUID(),
          inviteToken: issued.inviteToken,
          principal: task6Principal(
            email,
            existing.identityIssuer,
            existing.identitySubject,
          ),
        });

        expect(accepted).toMatchObject({
          userId: existing.userId,
          membershipId: existing.membershipId,
          organizationId: admin.organizationId,
          role: "viewer",
          authorityRevision: 1,
          sessionId: proposedSessionId,
        });
        expect(accepted.userId).not.toBe(proposedUserId);
        expect(accepted.membershipId).not.toBe(proposedMembershipId);
        const state = await ownerPool.query<{
          readonly action: string;
          readonly membership_count: string;
          readonly role: string;
          readonly authority_revision: string;
        }>(
          `
            SELECT
              membership.role,
              membership.authority_revision::text,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE organization_id = $1::uuid
                  AND user_id = $2::uuid
              ) AS membership_count,
              (
                SELECT action
                FROM dasher.audit_events
                WHERE target_id = $3::uuid
                  AND action = 'invitation.accepted_existing_membership'
              ) AS action
            FROM dasher.memberships AS membership
            WHERE membership.membership_id = $4::uuid
          `,
          [
            admin.organizationId,
            existing.userId,
            issued.invitationId,
            existing.membershipId,
          ],
        );
        expect(state.rows[0]).toEqual({
          action: "invitation.accepted_existing_membership",
          authority_revision: "1",
          membership_count: "1",
          role: "viewer",
        });
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("normalizes Task 6 replay, wrong email, expiry, revoked membership, and retired key to denials", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const admin = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const events: Array<Readonly<{ requestId: string; reason: string }>> =
          [];
        const uuidValues = Array.from({ length: 30 }, () => randomUUID());
        const repository = createTask6Repository(
          client,
          keyRing,
          uuidValues,
          events,
        );
        const baseEmail = `denial-${randomUUID()}@example.test`;
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email: baseEmail,
          role: "viewer",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: task6Principal(`wrong-${baseEmail}`),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        const exactPrincipal = task6Principal(baseEmail);
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: exactPrincipal,
          }),
        ).resolves.toMatchObject({ organizationId: admin.organizationId });
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: exactPrincipal,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const expiredEmail = `expired-${randomUUID()}@example.test`;
        const expired = await repository.issueInvitation({
          requestId: randomUUID(),
          email: expiredEmail,
          role: "viewer",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        await ownerPool.query(
          "UPDATE dasher.invitations SET expires_at = pg_catalog.clock_timestamp() WHERE invitation_id = $1::uuid",
          [expired.invitationId],
        );
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: expired.inviteToken,
            principal: task6Principal(expiredEmail),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const revoked = await createTask4Actor(
          client,
          "viewer",
          admin.organizationId,
        );
        await ownerPool.query(
          "UPDATE dasher.memberships SET state = 'revoked', authority_revision = authority_revision + 1, revoked_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp() WHERE membership_id = $1::uuid",
          [revoked.membershipId],
        );
        const revokedEmail = `revoked-${randomUUID()}@example.test`;
        const revokedInvitation = await repository.issueInvitation({
          requestId: randomUUID(),
          email: revokedEmail,
          role: "admin",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: revokedInvitation.inviteToken,
            principal: task6Principal(
              revokedEmail,
              revoked.identityIssuer,
              revoked.identitySubject,
            ),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const retiredSecret = Buffer.alloc(32, 7).toString("base64url");
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: `i1.3.${retiredSecret}`,
            principal: task6Principal(baseEmail),
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        expect(
          events.filter((event) => event.reason === "state_invalid"),
        ).toHaveLength(4);
        expect(
          events.filter((event) => event.reason === "input_invalid"),
        ).toHaveLength(1);
        for (const event of events) {
          expect(Object.keys(event).sort()).toEqual(["reason", "requestId"]);
          expect(Object.isFrozen(event)).toBe(true);
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("allows exactly one concurrent Task 6 acceptance with no duplicate membership, session, or audit", async () => {
      const issuerClient = await appPool!.connect();
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      try {
        await issuerClient.query("SET ROLE dasher_app");
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const admin = await createTask4Actor(issuerClient, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const issueRepository = createTask6Repository(issuerClient, keyRing, [
          randomUUID(),
          randomUUID(),
        ]);
        const email = `race-${randomUUID()}@example.test`;
        const issued = await issueRepository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "editor",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });
        const firstIds = [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ];
        const secondIds = [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ];
        const firstRepository = createTask6Repository(first, keyRing, firstIds);
        const secondRepository = createTask6Repository(
          second,
          keyRing,
          secondIds,
        );
        const principal = task6Principal(email);

        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT invitation_id FROM dasher.invitations WHERE invitation_id = $1::uuid FOR UPDATE",
          [issued.invitationId],
        );
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);
        const firstAcceptance = retainDatabasePromise(
          retainedOperations,
          firstRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          firstPid,
          ["transactionid", "tuple"],
          firstAcceptance,
        );
        const secondAcceptance = retainDatabasePromise(
          retainedOperations,
          secondRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          secondPid,
          ["advisory", "transactionid", "tuple"],
          secondAcceptance,
        );
        await blocker.query("ROLLBACK");
        const results = await Promise.all([firstAcceptance, secondAcceptance]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(
          rejected?.status === "rejected" ? rejected.reason : undefined,
        ).toBeInstanceOf(OperationDeniedError);

        const state = await ownerPool.query<{
          readonly acceptance_audit_count: string;
          readonly membership_count: string;
          readonly session_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE organization_id = $1::uuid
                  AND user_id = (
                    SELECT accepted_user_id
                    FROM dasher.invitations
                    WHERE invitation_id = $2::uuid
                  )
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($3::uuid[])
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($4::uuid[])
              ) AS acceptance_audit_count
          `,
          [
            admin.organizationId,
            issued.invitationId,
            [firstIds[2], secondIds[2]],
            [firstIds[3], secondIds[3]],
          ],
        );
        expect(state.rows[0]).toEqual({
          acceptance_audit_count: "1",
          membership_count: "1",
          session_count: "1",
        });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await issuerClient.query("RESET ROLE").catch(() => undefined);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        blocker.release();
        issuerClient.release();
        first.release();
        second.release();
      }
    });

    it("converges concurrent Task 6 wrapper acceptances on one external-identity winner across organizations", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const blocker = await ownerPool.connect();
      const retainedOperations: Array<SettledDatabasePromise<unknown>> = [];
      let blockerOpen = false;
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const firstCurrentSession = keyRing.issue("session");
        const firstCurrentCsrf = keyRing.issue("csrf");
        const secondCurrentSession = keyRing.issue("session");
        const secondCurrentCsrf = keyRing.issue("csrf");
        const firstAdmin = await createTask4Actor(first, "admin", undefined, {
          sessionDigest: Buffer.from(firstCurrentSession.persistence.digest),
          csrfDigest: Buffer.from(firstCurrentCsrf.persistence.digest),
        });
        const secondAdmin = await createTask4Actor(second, "admin", undefined, {
          sessionDigest: Buffer.from(secondCurrentSession.persistence.digest),
          csrfDigest: Buffer.from(secondCurrentCsrf.persistence.digest),
        });
        expect(firstAdmin.organizationId).not.toBe(secondAdmin.organizationId);

        const firstIds = Array.from({ length: 6 }, () => randomUUID());
        const secondIds = Array.from({ length: 6 }, () => randomUUID());
        const firstEvents: Array<
          Readonly<{ requestId: string; reason: string }>
        > = [];
        const secondEvents: Array<
          Readonly<{ requestId: string; reason: string }>
        > = [];
        const firstRepository = createTask6Repository(
          first,
          keyRing,
          firstIds,
          firstEvents,
        );
        const secondRepository = createTask6Repository(
          second,
          keyRing,
          secondIds,
          secondEvents,
        );
        const marker = randomUUID();
        const email = `identity-race-${marker}@example.test`;
        const issuer = `https://task6-provider.test/identity-race/${marker}`;
        const subject = `subject-${marker}`;
        const firstIssued = await firstRepository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "editor",
          currentSessionToken: firstCurrentSession.wireValue,
          currentCsrfValue: firstCurrentCsrf.wireValue,
        });
        const secondIssued = await secondRepository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "viewer",
          currentSessionToken: secondCurrentSession.wireValue,
          currentCsrfValue: secondCurrentCsrf.wireValue,
        });
        const principal = task6Principal(email, issuer, subject);

        await blocker.query("BEGIN");
        blockerOpen = true;
        await blocker.query(
          "LOCK TABLE dasher.external_identities IN ACCESS EXCLUSIVE MODE",
        );
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);
        const firstAcceptance = retainDatabasePromise(
          retainedOperations,
          firstRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: firstIssued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          firstPid,
          "relation",
          firstAcceptance,
        );
        const secondAcceptance = retainDatabasePromise(
          retainedOperations,
          secondRepository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: secondIssued.inviteToken,
            principal,
          }),
        );
        await waitForDatabaseLock(
          ownerPool as unknown as PoolClient,
          secondPid,
          "relation",
          secondAcceptance,
        );
        await blocker.query("ROLLBACK");
        blockerOpen = false;

        const [firstSettled, secondSettled] = await Promise.all([
          firstAcceptance,
          secondAcceptance,
        ]);
        expect(firstSettled.status).toBe("fulfilled");
        expect(secondSettled.status).toBe("fulfilled");
        if (
          firstSettled.status !== "fulfilled" ||
          secondSettled.status !== "fulfilled"
        ) {
          throw new Error("Task 6 identity race did not settle successfully");
        }
        const firstResult = firstSettled.value;
        const secondResult = secondSettled.value;
        const winningUserId = firstResult.userId;
        const proposedUsers = [firstIds[2]!, secondIds[2]!];
        const losingUserId = proposedUsers.find(
          (candidate) => candidate !== winningUserId,
        )!;
        expect(proposedUsers).toContain(winningUserId);
        expect(secondResult.userId).toBe(winningUserId);
        expect(firstResult).toMatchObject({
          organizationId: firstAdmin.organizationId,
          membershipId: firstIds[3],
          sessionId: firstIds[4],
          role: "editor",
          authorityRevision: 1,
        });
        expect(secondResult).toMatchObject({
          organizationId: secondAdmin.organizationId,
          membershipId: secondIds[3],
          sessionId: secondIds[4],
          role: "viewer",
          authorityRevision: 1,
        });

        const state = await ownerPool.query<{
          readonly acceptance_audit_count: string;
          readonly accepted_invitation_count: string;
          readonly identity_count: string;
          readonly loser_membership_count: string;
          readonly loser_session_count: string;
          readonly membership_count: string;
          readonly proposed_user_count: string;
          readonly session_count: string;
        }>(
          `
            SELECT
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.external_identities
                WHERE issuer = $1 AND subject = $2 AND user_id = $3::uuid
              ) AS identity_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.users
                WHERE user_id = ANY($4::uuid[])
              ) AS proposed_user_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.invitations
                WHERE invitation_id = ANY($5::uuid[])
                  AND accepted_user_id = $3::uuid
              ) AS accepted_invitation_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE membership_id = ANY($6::uuid[])
                  AND user_id = $3::uuid
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($7::uuid[])
                  AND user_id = $3::uuid
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($8::uuid[])
                  AND action = 'invitation.accepted'
              ) AS acceptance_audit_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.memberships
                WHERE user_id = $9::uuid
                  AND membership_id = ANY($6::uuid[])
              ) AS loser_membership_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE user_id = $9::uuid
                  AND session_id = ANY($7::uuid[])
              ) AS loser_session_count
          `,
          [
            issuer,
            subject,
            winningUserId,
            proposedUsers,
            [firstIds[0], secondIds[0]],
            [firstIds[3], secondIds[3]],
            [firstIds[4], secondIds[4]],
            [firstIds[5], secondIds[5]],
            losingUserId,
          ],
        );
        expect(state.rows[0]).toEqual({
          acceptance_audit_count: "2",
          accepted_invitation_count: "2",
          identity_count: "1",
          loser_membership_count: "0",
          loser_session_count: "0",
          membership_count: "2",
          proposed_user_count: "1",
          session_count: "2",
        });
        expect(firstEvents).toEqual([]);
        expect(secondEvents).toEqual([]);
        expect(JSON.stringify([firstEvents, secondEvents])).not.toContain(
          marker,
        );
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        if (blockerOpen) {
          await blocker.query("ROLLBACK").catch(() => undefined);
        }
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        blocker.release();
        first.release();
        second.release();
      }
    });

    it("rolls back every Task 6 acceptance mutation when the audit insert privilege is revoked", async () => {
      const client = await appPool!.connect();
      const revoker = await ownerPool.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const invitationId = randomUUID();
        const proposedUserId = randomUUID();
        const proposedMembershipId = randomUUID();
        const proposedSessionId = randomUUID();
        const acceptAuditId = randomUUID();
        const repository = createTask6Repository(client, keyRing, [
          invitationId,
          randomUUID(),
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ]);
        const email = `audit-failure-${randomUUID()}@example.test`;
        const issuer = "https://task6-provider.test/audit-failure";
        const subject = randomUUID();
        const issued = await repository.issueInvitation({
          requestId: randomUUID(),
          email,
          role: "viewer",
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        });

        await revoker.query("BEGIN");
        await revoker.query(`
          REVOKE INSERT (${task4AuditColumnsSql})
          ON dasher.audit_events
          FROM dasher_security_definer
        `);
        await revoker.query("COMMIT");
        await expect(
          repository.acceptInvitation({
            requestId: randomUUID(),
            inviteToken: issued.inviteToken,
            principal: task6Principal(email, issuer, subject),
          }),
        ).rejects.toBeInstanceOf(OperationInternalError);

        const residue = await ownerPool.query<{
          readonly accepted_user_id: string | null;
          readonly audit_count: string;
          readonly identity_count: string;
          readonly membership_count: string;
          readonly session_count: string;
          readonly user_count: string;
        }>(
          `
            SELECT
              invitation.accepted_user_id::text,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.users
                WHERE user_id = $2::uuid
              ) AS user_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.external_identities
                WHERE issuer = $3 AND subject = $4
              ) AS identity_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.memberships
                WHERE membership_id = $5::uuid
              ) AS membership_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.sessions
                WHERE session_id = $6::uuid
              ) AS session_count,
              (
                SELECT pg_catalog.count(*)::text FROM dasher.audit_events
                WHERE audit_event_id = $7::uuid
              ) AS audit_count
            FROM dasher.invitations AS invitation
            WHERE invitation.invitation_id = $1::uuid
          `,
          [
            invitationId,
            proposedUserId,
            issuer,
            subject,
            proposedMembershipId,
            proposedSessionId,
            acceptAuditId,
          ],
        );
        expect(residue.rows[0]).toEqual({
          accepted_user_id: null,
          audit_count: "0",
          identity_count: "0",
          membership_count: "0",
          session_count: "0",
          user_count: "0",
        });
      } finally {
        await revoker.query("ROLLBACK").catch(() => undefined);
        await revoker.query(`
          GRANT INSERT (${task4AuditColumnsSql})
          ON dasher.audit_events
          TO dasher_security_definer
        `);
        await client.query("RESET ROLE").catch(() => undefined);
        revoker.release();
        client.release();
      }
    });

    it("runs Task 7 issue and resolve wrappers with DB winners, bounded refresh, and inclusive expiry denial", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const existingSession = keyRing.issue("session");
        const existingCsrf = keyRing.issue("csrf");
        const actor = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(existingSession.persistence.digest),
          csrfDigest: Buffer.from(existingCsrf.persistence.digest),
        });
        const issuedSessionId = randomUUID();
        const issueAuditId = randomUUID();
        const events: Array<Readonly<{ requestId: string; reason: string }>> =
          [];
        const repository = createTask7Repository(
          client,
          keyRing,
          [issuedSessionId, issueAuditId],
          events,
        );
        const issued = await repository.issueSession({
          requestId: randomUUID(),
          principal: task7Principal(actor),
          membershipId: actor.membershipId,
        });
        expect(issued).toMatchObject({
          userId: actor.userId,
          organizationId: actor.organizationId,
          membershipId: actor.membershipId,
          role: "admin",
          authorityRevision: 1,
          sessionId: issuedSessionId,
        });
        expect(issued.sessionCookie.maxAge).toBeGreaterThanOrEqual(604_799);
        expect(issued.sessionCookie.maxAge).toBeLessThanOrEqual(604_800);

        const persisted = await ownerPool.query<{
          readonly audit_count: string;
          readonly csrf_matches: boolean;
          readonly session_matches: boolean;
        }>(
          `
            SELECT
              session_row.token_key_version = $2::smallint
                AND session_row.token_digest = $3::bytea AS session_matches,
              session_row.csrf_key_version = $4::smallint
                AND session_row.csrf_digest = $5::bytea AS csrf_matches,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = $6::uuid
                  AND action = 'session.issued'
              ) AS audit_count
            FROM dasher.sessions AS session_row
            WHERE session_row.session_id = $1::uuid
          `,
          [
            issuedSessionId,
            keyRing.verify("session", issued.sessionToken).keyVersion,
            Buffer.from(keyRing.verify("session", issued.sessionToken).digest),
            keyRing.verify("csrf", issued.csrfValue).keyVersion,
            Buffer.from(keyRing.verify("csrf", issued.csrfValue).digest),
            issueAuditId,
          ],
        );
        expect(persisted.rows[0]).toEqual({
          audit_count: "1",
          csrf_matches: true,
          session_matches: true,
        });

        const resolved = await repository.resolveSession({
          requestId: randomUUID(),
          sessionToken: issued.sessionToken,
        });
        expect(resolved).toMatchObject({
          sessionId: issuedSessionId,
          userId: actor.userId,
          organizationId: actor.organizationId,
          membershipId: actor.membershipId,
          authorityRevision: 1,
        });

        const belowThreshold = await ownerPool.query<{
          readonly idle_expires_at: Date;
          readonly last_seen_at: Date;
        }>(
          `
            WITH database_time AS (
              SELECT pg_catalog.clock_timestamp() AS now
            )
            UPDATE dasher.sessions
            SET
              issued_at = database_time.now - interval '4 minutes',
              last_seen_at = database_time.now - interval '4 minutes',
              idle_expires_at = database_time.now + interval '10 minutes',
              absolute_expires_at = database_time.now + interval '1 day'
            FROM database_time
            WHERE session_id = $1::uuid
            RETURNING last_seen_at, idle_expires_at
          `,
          [issuedSessionId],
        );
        await repository.resolveSession({
          requestId: randomUUID(),
          sessionToken: issued.sessionToken,
        });
        const unrefreshed = await ownerPool.query<{
          readonly idle_expires_at: Date;
          readonly last_seen_at: Date;
        }>(
          `
            SELECT last_seen_at, idle_expires_at
            FROM dasher.sessions
            WHERE session_id = $1::uuid
          `,
          [issuedSessionId],
        );
        expect(unrefreshed.rows[0]).toEqual(belowThreshold.rows[0]);

        const refreshBaseline = await ownerPool.query<{
          readonly absolute_expires_at: Date;
          readonly last_seen_at: Date;
        }>(
          `
            WITH database_time AS (
              SELECT pg_catalog.clock_timestamp() AS now
            )
            UPDATE dasher.sessions
            SET
              issued_at = database_time.now - interval '6 minutes',
              last_seen_at = database_time.now - interval '6 minutes',
              idle_expires_at = database_time.now + interval '1 minute',
              absolute_expires_at = database_time.now + interval '10 minutes'
            FROM database_time
            WHERE session_id = $1::uuid
            RETURNING last_seen_at, absolute_expires_at
          `,
          [issuedSessionId],
        );
        const refreshed = await repository.resolveSession({
          requestId: randomUUID(),
          sessionToken: issued.sessionToken,
        });
        expect(refreshed.idleExpiresAt).toEqual(
          refreshBaseline.rows[0]?.absolute_expires_at,
        );
        const refreshedState = await ownerPool.query<{
          readonly idle_expires_at: Date;
          readonly last_seen_at: Date;
        }>(
          `
            SELECT last_seen_at, idle_expires_at
            FROM dasher.sessions
            WHERE session_id = $1::uuid
          `,
          [issuedSessionId],
        );
        expect(refreshedState.rows[0]?.last_seen_at.getTime()).toBeGreaterThan(
          refreshBaseline.rows[0]!.last_seen_at.getTime(),
        );
        expect(refreshedState.rows[0]?.idle_expires_at).toEqual(
          refreshBaseline.rows[0]?.absolute_expires_at,
        );

        await ownerPool.query(
          `
            UPDATE dasher.sessions
            SET
              idle_expires_at = pg_catalog.clock_timestamp(),
              absolute_expires_at = pg_catalog.clock_timestamp() + interval '1 day'
            WHERE session_id = $1::uuid
          `,
          [issuedSessionId],
        );
        await expect(
          repository.resolveSession({
            requestId: randomUUID(),
            sessionToken: issued.sessionToken,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        await ownerPool.query(
          `
            UPDATE dasher.sessions
            SET
              idle_expires_at = pg_catalog.clock_timestamp(),
              absolute_expires_at = pg_catalog.clock_timestamp()
            WHERE session_id = $1::uuid
          `,
          [issuedSessionId],
        );
        await expect(
          repository.resolveSession({
            requestId: randomUUID(),
            sessionToken: issued.sessionToken,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        expect(events).toEqual([
          expect.objectContaining({ reason: "authority_invalid" }),
          expect.objectContaining({ reason: "authority_invalid" }),
        ]);
        expect(JSON.stringify(events)).not.toContain(issued.sessionToken);
        await expect(client.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("atomically rotates through Task 7 wrappers behind a deterministic organization-lock barrier", async () => {
      const first = await appPool!.connect();
      const second = await appPool!.connect();
      const blocker = await ownerPool.connect();
      const observer = await ownerPool.connect();
      let blockerOpen = false;
      const retainedOperations: Array<Promise<unknown>> = [];
      try {
        await first.query("SET ROLE dasher_app");
        await second.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const actor = await createTask4Actor(first, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const firstSuccessor = randomUUID();
        const secondSuccessor = randomUUID();
        const firstAudit = randomUUID();
        const secondAudit = randomUUID();
        const firstRepository = createTask7Repository(first, keyRing, [
          firstSuccessor,
          firstAudit,
        ]);
        const secondRepository = createTask7Repository(second, keyRing, [
          secondSuccessor,
          secondAudit,
        ]);
        const firstPid = await appBackendPid(first);
        const secondPid = await appBackendPid(second);

        await blocker.query("BEGIN");
        blockerOpen = true;
        await blocker.query(
          `
            SELECT pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended(
                'dasher:task4-organization:v1:' || $1::uuid::text,
                20260730::bigint
              )
            )
          `,
          [actor.organizationId],
        );

        const rotateInput = {
          requestId: randomUUID(),
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
        };
        const firstRotation = settleDatabasePromise(
          firstRepository.rotateSession(rotateInput),
        );
        retainedOperations.push(firstRotation);
        await waitForDatabaseLock(
          observer,
          firstPid,
          "advisory",
          firstRotation,
        );
        const secondRotation = settleDatabasePromise(
          secondRepository.rotateSession({
            ...rotateInput,
            requestId: randomUUID(),
          }),
        );
        retainedOperations.push(secondRotation);
        await waitForDatabaseLock(
          observer,
          secondPid,
          "advisory",
          secondRotation,
        );

        await blocker.query("COMMIT");
        blockerOpen = false;
        const results = await Promise.all([firstRotation, secondRotation]);
        const fulfilled = results.filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<SessionRepository["rotateSession"]>>
          > => result.status === "fulfilled",
        );
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toBeInstanceOf(OperationDeniedError);
        const winner = fulfilled[0]!.value;
        expect([firstSuccessor, secondSuccessor]).toContain(winner.sessionId);

        await expect(
          firstRepository.resolveSession({
            requestId: randomUUID(),
            sessionToken: currentSession.wireValue,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        const lineage = await ownerPool.query<{
          readonly audit_count: string;
          readonly orphan_count: string;
          readonly replaced_by_session_id: string;
          readonly rotated_from_session_id: string;
          readonly successor_count: string;
        }>(
          `
            SELECT
              predecessor.replaced_by_session_id::text,
              successor.rotated_from_session_id::text,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($2::uuid[])
              ) AS successor_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.sessions
                WHERE session_id = ANY($2::uuid[])
                  AND rotated_from_session_id IS NULL
              ) AS orphan_count,
              (
                SELECT pg_catalog.count(*)::text
                FROM dasher.audit_events
                WHERE audit_event_id = ANY($3::uuid[])
                  AND action = 'session.rotated'
              ) AS audit_count
            FROM dasher.sessions AS predecessor
            JOIN dasher.sessions AS successor
              ON successor.session_id = predecessor.replaced_by_session_id
            WHERE predecessor.session_id = $1::uuid
          `,
          [
            actor.sessionId,
            [firstSuccessor, secondSuccessor],
            [firstAudit, secondAudit],
          ],
        );
        expect(lineage.rows[0]).toEqual({
          audit_count: "1",
          orphan_count: "0",
          replaced_by_session_id: winner.sessionId,
          rotated_from_session_id: actor.sessionId,
          successor_count: "1",
        });
        await expect(first.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
        await expect(second.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
        await Promise.all(retainedOperations);
        await first.query("RESET ROLE").catch(() => undefined);
        await second.query("RESET ROLE").catch(() => undefined);
        blocker.release();
        observer.release();
        first.release();
        second.release();
      }
    });

    it("enforces Task 7 CSRF, tenant authority, revision, dependent revocation, and admin invariants", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const currentSession = keyRing.issue("session");
        const currentCsrf = keyRing.issue("csrf");
        const actor = await createTask4Actor(client, "admin", undefined, {
          sessionDigest: Buffer.from(currentSession.persistence.digest),
          csrfDigest: Buffer.from(currentCsrf.persistence.digest),
        });
        const roleTarget = await createTask4Actor(
          client,
          "viewer",
          actor.organizationId,
        );
        const revokeTarget = await createTask4Actor(
          client,
          "editor",
          actor.organizationId,
        );
        const foreignTarget = await createTask4Actor(client, "viewer");
        const additionalSessionId = randomUUID();
        await issueAdditionalTask4Session(client, actor, additionalSessionId);
        const wrongCsrf = keyRing.issue("csrf");
        const repository = createTask7Repository(client, keyRing, [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ]);

        await expect(
          repository.revokeSession({
            requestId: randomUUID(),
            currentSessionToken: currentSession.wireValue,
            currentCsrfValue: wrongCsrf.wireValue,
            targetSessionId: actor.sessionId,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        await expect(
          repository.revokeSession({
            requestId: randomUUID(),
            currentSessionToken: currentSession.wireValue,
            currentCsrfValue: currentCsrf.wireValue,
            targetSessionId: foreignTarget.sessionId,
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        await client.query(
          "SELECT pg_catalog.set_config('dasher.context_organization_id', $1, false)",
          [foreignTarget.organizationId],
        );
        await expect(
          repository.changeMembershipRole({
            requestId: randomUUID(),
            currentSessionToken: currentSession.wireValue,
            currentCsrfValue: currentCsrf.wireValue,
            membershipId: foreignTarget.membershipId,
            newRole: "admin",
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);
        const sessionRevocation = await repository.revokeSession({
          requestId: randomUUID(),
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
          targetSessionId: additionalSessionId,
        });
        expect(sessionRevocation).toMatchObject({
          sessionId: additionalSessionId,
        });

        const changed = await repository.changeMembershipRole({
          requestId: randomUUID(),
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
          membershipId: roleTarget.membershipId,
          newRole: "editor",
        });
        expect(changed).toEqual({
          membershipId: roleTarget.membershipId,
          authorityRevision: 2,
        });
        const revoked = await repository.revokeMembership({
          requestId: randomUUID(),
          currentSessionToken: currentSession.wireValue,
          currentCsrfValue: currentCsrf.wireValue,
          membershipId: revokeTarget.membershipId,
        });
        expect(revoked).toMatchObject({
          membershipId: revokeTarget.membershipId,
          authorityRevision: 2,
        });
        await expect(
          repository.changeMembershipRole({
            requestId: randomUUID(),
            currentSessionToken: currentSession.wireValue,
            currentCsrfValue: currentCsrf.wireValue,
            membershipId: actor.membershipId,
            newRole: "viewer",
          }),
        ).rejects.toBeInstanceOf(OperationDeniedError);

        const state = await ownerPool.query<{
          readonly actor_revision: string;
          readonly actor_role: string;
          readonly revoke_revision: string;
          readonly revoke_session_reason: string;
          readonly revoke_state: string;
          readonly role_revision: string;
          readonly role_role: string;
          readonly role_session_reason: string;
          readonly session_revocation_reason: string;
        }>(
          `
            SELECT
              actor.role AS actor_role,
              actor.authority_revision::text AS actor_revision,
              role_target.role AS role_role,
              role_target.authority_revision::text AS role_revision,
              role_session.revocation_reason AS role_session_reason,
              revoke_target.state AS revoke_state,
              revoke_target.authority_revision::text AS revoke_revision,
              revoke_session.revocation_reason AS revoke_session_reason,
              explicitly_revoked.revocation_reason AS session_revocation_reason
            FROM dasher.memberships AS actor
            JOIN dasher.memberships AS role_target
              ON role_target.membership_id = $2::uuid
            JOIN dasher.sessions AS role_session
              ON role_session.session_id = $3::uuid
            JOIN dasher.memberships AS revoke_target
              ON revoke_target.membership_id = $4::uuid
            JOIN dasher.sessions AS revoke_session
              ON revoke_session.session_id = $5::uuid
            JOIN dasher.sessions AS explicitly_revoked
              ON explicitly_revoked.session_id = $6::uuid
            WHERE actor.membership_id = $1::uuid
          `,
          [
            actor.membershipId,
            roleTarget.membershipId,
            roleTarget.sessionId,
            revokeTarget.membershipId,
            revokeTarget.sessionId,
            additionalSessionId,
          ],
        );
        expect(state.rows[0]).toEqual({
          actor_revision: "1",
          actor_role: "admin",
          revoke_revision: "2",
          revoke_session_reason: "authority_changed",
          revoke_state: "revoked",
          role_revision: "2",
          role_role: "editor",
          role_session_reason: "authority_changed",
          session_revocation_reason: "user_revoked",
        });
        await client.query("RESET dasher.context_organization_id");
        await expect(client.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        await client
          .query("RESET dasher.context_organization_id")
          .catch(() => undefined);
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });

    it("rolls back every Task 7 audited mutation when audit INSERT is revoked and restores reusable clients", async () => {
      const client = await appPool!.connect();
      const revoker = await ownerPool.connect();
      let grantRevoked = false;
      try {
        await client.query("SET ROLE dasher_app");
        const keyRing = createTask6KeyRing();
        const createActor = async () => {
          const session = keyRing.issue("session");
          const csrf = keyRing.issue("csrf");
          const actor = await createTask4Actor(client, "admin", undefined, {
            sessionDigest: Buffer.from(session.persistence.digest),
            csrfDigest: Buffer.from(csrf.persistence.digest),
          });
          return { actor, session, csrf };
        };
        const issueActor = await createActor();
        const rotateActor = await createActor();
        const revokeActor = await createActor();
        const roleActor = await createActor();
        const membershipActor = await createActor();
        const revokeTargetSessionId = randomUUID();
        await issueAdditionalTask4Session(
          client,
          revokeActor.actor,
          revokeTargetSessionId,
        );
        const roleTarget = await createTask4Actor(
          client,
          "viewer",
          roleActor.actor.organizationId,
        );
        const membershipTarget = await createTask4Actor(
          client,
          "viewer",
          membershipActor.actor.organizationId,
        );
        const proposedIssueSession = randomUUID();
        const proposedSuccessor = randomUUID();
        const auditIds = Array.from({ length: 5 }, () => randomUUID());

        await revoker.query("BEGIN");
        await revoker.query(`
          REVOKE INSERT (${task4AuditColumnsSql})
          ON dasher.audit_events
          FROM dasher_security_definer
        `);
        await revoker.query("COMMIT");
        grantRevoked = true;

        const operations = [
          {
            label: "issueSession",
            run: () =>
              createTask7Repository(client, keyRing, [
                proposedIssueSession,
                auditIds[0]!,
              ]).issueSession({
                requestId: randomUUID(),
                principal: task7Principal(issueActor.actor),
                membershipId: issueActor.actor.membershipId,
              }),
          },
          {
            label: "rotateSession",
            run: () =>
              createTask7Repository(client, keyRing, [
                proposedSuccessor,
                auditIds[1]!,
              ]).rotateSession({
                requestId: randomUUID(),
                currentSessionToken: rotateActor.session.wireValue,
                currentCsrfValue: rotateActor.csrf.wireValue,
              }),
          },
          {
            label: "revokeSession",
            run: () =>
              createTask7Repository(client, keyRing, [
                auditIds[2]!,
              ]).revokeSession({
                requestId: randomUUID(),
                currentSessionToken: revokeActor.session.wireValue,
                currentCsrfValue: revokeActor.csrf.wireValue,
                targetSessionId: revokeTargetSessionId,
              }),
          },
          {
            label: "changeMembershipRole",
            run: () =>
              createTask7Repository(client, keyRing, [
                auditIds[3]!,
              ]).changeMembershipRole({
                requestId: randomUUID(),
                currentSessionToken: roleActor.session.wireValue,
                currentCsrfValue: roleActor.csrf.wireValue,
                membershipId: roleTarget.membershipId,
                newRole: "editor",
              }),
          },
          {
            label: "revokeMembership",
            run: () =>
              createTask7Repository(client, keyRing, [
                auditIds[4]!,
              ]).revokeMembership({
                requestId: randomUUID(),
                currentSessionToken: membershipActor.session.wireValue,
                currentCsrfValue: membershipActor.csrf.wireValue,
                membershipId: membershipTarget.membershipId,
              }),
          },
        ];
        for (const operation of operations) {
          await expect(operation.run(), operation.label).rejects.toBeInstanceOf(
            OperationInternalError,
          );
        }

        const residue = await ownerPool.query<{
          readonly audit_count: string;
          readonly issue_session_count: string;
          readonly membership_revision: string;
          readonly membership_session_revoked: boolean;
          readonly membership_state: string;
          readonly predecessor_link: string | null;
          readonly revoke_session_revoked: boolean;
          readonly role_revision: string;
          readonly role_role: string;
          readonly role_session_revoked: boolean;
          readonly successor_count: string;
        }>(
          `
            SELECT
              (SELECT pg_catalog.count(*)::text FROM dasher.sessions
                WHERE session_id = $1::uuid) AS issue_session_count,
              (SELECT replaced_by_session_id::text FROM dasher.sessions
                WHERE session_id = $2::uuid) AS predecessor_link,
              (SELECT pg_catalog.count(*)::text FROM dasher.sessions
                WHERE session_id = $3::uuid) AS successor_count,
              (SELECT revoked_at IS NOT NULL FROM dasher.sessions
                WHERE session_id = $4::uuid) AS revoke_session_revoked,
              role_target.role AS role_role,
              role_target.authority_revision::text AS role_revision,
              role_session.revoked_at IS NOT NULL AS role_session_revoked,
              membership_target.state AS membership_state,
              membership_target.authority_revision::text AS membership_revision,
              membership_session.revoked_at IS NOT NULL AS membership_session_revoked,
              (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
                WHERE audit_event_id = ANY($9::uuid[])) AS audit_count
            FROM dasher.memberships AS role_target
            JOIN dasher.sessions AS role_session ON role_session.session_id = $6::uuid
            JOIN dasher.memberships AS membership_target
              ON membership_target.membership_id = $7::uuid
            JOIN dasher.sessions AS membership_session
              ON membership_session.session_id = $8::uuid
            WHERE role_target.membership_id = $5::uuid
          `,
          [
            proposedIssueSession,
            rotateActor.actor.sessionId,
            proposedSuccessor,
            revokeTargetSessionId,
            roleTarget.membershipId,
            roleTarget.sessionId,
            membershipTarget.membershipId,
            membershipTarget.sessionId,
            auditIds,
          ],
        );
        expect(residue.rows[0]).toEqual({
          audit_count: "0",
          issue_session_count: "0",
          membership_revision: "1",
          membership_session_revoked: false,
          membership_state: "active",
          predecessor_link: null,
          revoke_session_revoked: false,
          role_revision: "1",
          role_role: "viewer",
          role_session_revoked: false,
          successor_count: "0",
        });
        await expect(client.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        await revoker.query("ROLLBACK").catch(() => undefined);
        await revoker.query("BEGIN");
        try {
          await revoker.query(`
            GRANT INSERT (${task4AuditColumnsSql})
            ON dasher.audit_events
            TO dasher_security_definer
          `);
          await revoker.query("COMMIT");
          grantRevoked = false;
        } catch (error) {
          await revoker.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
        expect(grantRevoked).toBe(false);
        await client.query("RESET ROLE").catch(() => undefined);
        revoker.release();
        client.release();
      }
    });

    it("rejects owner update and delete on audit", async () => {
      await ownerPool.query(`
      INSERT INTO dasher.users (user_id)
      VALUES ('00000000-0000-4000-8000-000000003001');
      INSERT INTO dasher.organizations (organization_id, display_name)
      VALUES (
        '00000000-0000-4000-8000-000000003002',
        'Synthetic Task 3 Organization'
      );
      INSERT INTO dasher.memberships (
        membership_id,
        organization_id,
        user_id,
        role,
        state,
        authority_revision
      ) VALUES (
        '00000000-0000-4000-8000-000000003003',
        '00000000-0000-4000-8000-000000003002',
        '00000000-0000-4000-8000-000000003001',
        'admin',
        'active',
        1
      );
      INSERT INTO dasher.audit_events (
        audit_event_id,
        organization_id,
        actor_kind,
        actor_user_id,
        authority_revision,
        request_id,
        action,
        target_type,
        target_id,
        outcome,
        deployment_revision
      ) VALUES (
        '00000000-0000-4000-8000-000000003004',
        '00000000-0000-4000-8000-000000003002',
        'user',
        '00000000-0000-4000-8000-000000003001',
        1,
        '00000000-0000-4000-8000-000000003005',
        'membership.role_changed',
        'membership',
        '00000000-0000-4000-8000-000000003003',
        'succeeded',
        'synthetic-task3'
      )
    `);

      await expectPostgresError(
        ownerPool.query(`
        UPDATE dasher.audit_events
        SET target_id = target_id
        WHERE audit_event_id = '00000000-0000-4000-8000-000000003004'
      `),
        "55000",
      );
      await expectPostgresError(
        ownerPool.query(`
        DELETE FROM dasher.audit_events
        WHERE audit_event_id = '00000000-0000-4000-8000-000000003004'
      `),
        "55000",
      );
    });

    it("denies app enumeration of both identity tables outside and inside forged context", async () => {
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        for (const table of ["users", "external_identities"] as const) {
          await expectPostgresDenial(
            client,
            `SELECT count(*) FROM dasher.${table}`,
          );

          await client.query("BEGIN");
          try {
            await client.query(
              "SELECT pg_catalog.set_config('dasher.organization_id', '00000000-0000-4000-8000-000000003002', true)",
            );
            await client.query(
              "SELECT pg_catalog.set_config('dasher.user_id', '00000000-0000-4000-8000-000000003001', true)",
            );
            await client.query(
              "SELECT pg_catalog.set_config('dasher.authority_revision', '1', true)",
            );
            await expectPostgresDenial(
              client,
              `SELECT count(*) FROM dasher.${table}`,
            );
          } finally {
            await client.query("ROLLBACK");
          }
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });
  },
);

describe.sequential("Task 8B.3 lifecycle API correction", () => {
  let actor: Task4Actor;
  let durableDashboardId: string;
  let durableDashboardAuditId: string;
  let versionId: string;
  let snapshotId: string;
  let evidenceId: string;

  beforeAll(async () => {
    await closeAppPoolBeforeLoginTeardown();
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }
    await resetManagedSchemas();
    await createTemporaryAppLogin(ownerPool, config.appDsn, config.appUsername);
    appLoginCreated = true;
    await runMigrations(ownerPool, canonicalMigrationDirectory, [
      config.appUsername,
    ]);
    appPool = new Pool({ connectionString: config.appDsn, max: 4 });
    const client = await appPool.connect();
    try {
      await client.query("SET ROLE dasher_app");
      actor = await createTask4Actor(client, "admin");
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
  }, 120_000);

  it("publishes only the hard-cut identities and exact ACL surface", async () => {
    const oldMutations = [
      "dasher_api.create_dashboard(uuid,text,text,integer,boolean,uuid,uuid,text)",
      "dasher_api.create_evidence_record(uuid,uuid,uuid,uuid,uuid,text,text,bytea,timestamp with time zone,timestamp with time zone,uuid,text)",
      "dasher_api.create_dashboard_version(uuid,uuid,uuid,bytea,bytea,bytea,bytea,bigint,bigint,bytea,uuid[],uuid[],uuid[],uuid[],uuid,text)",
      "dasher_api.compare_and_swap_dashboard_head(uuid,uuid,uuid,bigint,uuid,text)",
      "dasher_api.request_dashboard_promotion(uuid,uuid,bigint,bytea,uuid,text)",
      "dasher_api.decide_dashboard_promotion(uuid,bigint,text,uuid,uuid,text)",
      "dasher_api.set_dashboard_archive(uuid,boolean,bigint,uuid,text)",
      "dasher_api.delete_dashboard(uuid,bigint,uuid,text)",
      "dasher_api.restore_dashboard_as_new(uuid,uuid,bigint,uuid,uuid,uuid,text,bytea,uuid,text)",
    ] as const;
    const newMutations = [
      "dasher_api.create_dashboard(uuid,text,text,integer,boolean,uuid,uuid,smallint,bytea,text)",
      "dasher_api.create_evidence_record(uuid,uuid,uuid,uuid,uuid,text,text,bytea,timestamp with time zone,timestamp with time zone,uuid,smallint,bytea,text)",
      "dasher_api.create_dashboard_version(uuid,uuid,uuid,bytea,bytea,bytea,bytea,bigint,bigint,bytea,uuid[],uuid[],uuid[],uuid[],uuid,smallint,bytea,text)",
      "dasher_api.compare_and_swap_dashboard_head(uuid,uuid,uuid,bigint,uuid,smallint,bytea,text)",
      "dasher_api.request_dashboard_promotion(uuid,uuid,bigint,bytea,uuid,smallint,bytea,text)",
      "dasher_api.decide_dashboard_promotion(uuid,bigint,text,uuid,uuid,smallint,bytea,text)",
      "dasher_api.set_dashboard_archive(uuid,boolean,bigint,uuid,smallint,bytea,text)",
      "dasher_api.delete_dashboard(uuid,bigint,uuid,smallint,bytea,text)",
      "dasher_api.restore_dashboard_as_new(uuid,uuid,bigint,uuid,uuid,uuid,text,bytea,uuid,smallint,bytea,text)",
    ] as const;
    const identities = await ownerPool.query<{
      readonly identity: string;
      readonly resolved: string | null;
    }>(
      `
        SELECT identity, pg_catalog.to_regprocedure(identity)::text AS resolved
        FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY
          AS candidate(identity, ordinal)
        ORDER BY ordinal
      `,
      [[...oldMutations, ...newMutations]],
    );
    expect(
      identities.rows.slice(0, 9).every((row) => row.resolved === null),
    ).toBe(true);
    expect(identities.rows.slice(9).every((row) => row.resolved !== null)).toBe(
      true,
    );

    const correctedPublicFunctions = [
      "dasher_api.list_dashboards(integer)",
      "dasher_api.get_dashboard_summary(uuid)",
      "dasher_api.get_dashboard_head(uuid)",
      "dasher_api.get_dashboard_version(uuid,uuid)",
      "dasher_api.get_dashboard_admin_status(uuid)",
      "dasher_api.get_dashboard_evidence(uuid,uuid)",
      "dasher_api.get_dashboard_lineage(uuid,uuid)",
      ...newMutations,
    ];
    const routineAcls = await ownerPool.query<{
      readonly grantees: string[];
      readonly identity: string;
    }>(
      `
        SELECT
          candidate.identity,
          pg_catalog.array_agg(
            COALESCE(grantee.rolname::text, 'PUBLIC')
            ORDER BY COALESCE(grantee.rolname::text, 'PUBLIC')
          ) AS grantees
        FROM pg_catalog.unnest($1::text[]) AS candidate(identity)
        JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(candidate.identity)
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
        WHERE privilege.privilege_type = 'EXECUTE'
        GROUP BY candidate.identity
        ORDER BY candidate.identity
      `,
      [
        [
          ...correctedPublicFunctions,
          "dasher_private.context_csrf_allows(smallint,bytea)",
        ],
      ],
    );
    const helperAcl = routineAcls.rows.find((row) =>
      row.identity.includes("context_csrf_allows"),
    );
    expect(routineAcls.rows).toHaveLength(17);
    expect(helperAcl?.grantees).toEqual(["dasher_security_definer"]);
    for (const row of routineAcls.rows.filter(
      (candidate) => !candidate.identity.includes("context_csrf_allows"),
    )) {
      expect(row.grantees, row.identity).toEqual([
        "dasher_app",
        "dasher_security_definer",
      ]);
    }

    const grants = await ownerPool.query<{
      readonly app_relation_acl_count: string;
      readonly cleanup_select: boolean;
      readonly holds_select: boolean;
    }>(`
      SELECT
        pg_catalog.has_table_privilege(
          'dasher_security_definer',
          'dasher.dashboard_cleanup_coordination',
          'SELECT'
        ) AS cleanup_select,
        pg_catalog.has_table_privilege(
          'dasher_security_definer',
          'dasher.dashboard_legal_holds',
          'SELECT'
        ) AS holds_select,
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          WHERE namespace.nspname = 'dasher'
            AND relation.relkind IN ('r', 'p')
            AND grantee.rolname = 'dasher_app'
        ) AS app_relation_acl_count
    `);
    expect(grants.rows[0]).toEqual({
      app_relation_acl_count: "0",
      cleanup_select: true,
      holds_select: true,
    });

    const client = await ownerPool.connect();
    try {
      const ownerName = (
        await client.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        )
      ).rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("PostgreSQL did not return the session owner");
      }
      expect(
        await canonical0008CatalogMatchesForTests(client, ownerName, [
          config.appUsername,
        ]),
      ).toBe(true);
    } finally {
      client.release();
    }
  }, 120_000);

  it("returns exact creation facts and normalizes wrong-CSRF and audit collisions without residue", async () => {
    const client = await appPool!.connect();
    try {
      await client.query("SET ROLE dasher_app");
      const disposableDashboardId = randomUUID();
      const disposableAuditId = randomUUID();
      const disposable = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query<{
            readonly created_at: Date;
            readonly dashboard_id: string;
            readonly default_disposable_ttl_seconds: number;
            readonly effective_expires_at: Date;
            readonly effective_ttl_seconds: number;
            readonly lifecycle_policy_revision: string;
            readonly lifecycle_policy_seeded: boolean;
            readonly retention_policy_revision: string;
            readonly used_organization_default: boolean;
          }>(
            `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Disposable lifecycle result', 'disposable', NULL,
                true, $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b3-integration'
              )
            `,
            [
              disposableDashboardId,
              randomUUID(),
              disposableAuditId,
              actor.csrfDigest,
            ],
          ),
      );
      expect(disposable.rows[0]).toMatchObject({
        dashboard_id: disposableDashboardId,
        default_disposable_ttl_seconds: 86_400,
        effective_ttl_seconds: 86_400,
        lifecycle_policy_revision: "1",
        lifecycle_policy_seeded: true,
        retention_policy_revision: "1",
        used_organization_default: true,
      });
      expect(
        disposable.rows[0]!.effective_expires_at.getTime() -
          disposable.rows[0]!.created_at.getTime(),
      ).toBe(86_400_000);

      durableDashboardId = randomUUID();
      durableDashboardAuditId = randomUUID();
      const durable = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query<{
            readonly dashboard_id: string;
            readonly effective_expires_at: Date | null;
            readonly effective_ttl_seconds: number | null;
            readonly lifecycle_policy_seeded: boolean;
            readonly used_organization_default: boolean;
          }>(
            `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Durable lifecycle result', 'durable', NULL,
                false, $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b3-integration'
              )
            `,
            [
              durableDashboardId,
              randomUUID(),
              durableDashboardAuditId,
              actor.csrfDigest,
            ],
          ),
      );
      expect(durable.rows[0]).toMatchObject({
        dashboard_id: durableDashboardId,
        effective_expires_at: null,
        effective_ttl_seconds: null,
        lifecycle_policy_seeded: false,
        used_organization_default: false,
      });

      const wrongCsrfDashboard = randomUUID();
      const wrongCsrfAudit = randomUUID();
      await expectDasherBoundaryError(
        runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
          client.query(
            `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Wrong CSRF', 'durable', NULL, false,
                $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b3-integration'
              )
            `,
            [wrongCsrfDashboard, randomUUID(), wrongCsrfAudit, randomBytes(32)],
          ),
        ),
        "P1001",
        "dasher_denied",
      );

      const collisionDashboard = randomUUID();
      await expectDasherBoundaryError(
        runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
          client.query(
            `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Audit collision', 'durable', NULL, false,
                $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b3-integration'
              )
            `,
            [
              collisionDashboard,
              randomUUID(),
              durableDashboardAuditId,
              actor.csrfDigest,
            ],
          ),
        ),
        "P1002",
        "dasher_conflict",
      );
      const residue = await ownerPool.query<{
        readonly collision_dashboard_count: string;
        readonly wrong_audit_count: string;
        readonly wrong_dashboard_count: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text FROM dasher.dashboards
             WHERE dashboard_id = $1::uuid) AS wrong_dashboard_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
             WHERE audit_event_id = $2::uuid) AS wrong_audit_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.dashboards
             WHERE dashboard_id = $3::uuid) AS collision_dashboard_count
        `,
        [wrongCsrfDashboard, wrongCsrfAudit, collisionDashboard],
      );
      expect(residue.rows[0]).toEqual({
        collision_dashboard_count: "0",
        wrong_audit_count: "0",
        wrong_dashboard_count: "0",
      });

      const summary = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query(
            "SELECT * FROM dasher_api.get_dashboard_summary($1::uuid)",
            [durableDashboardId],
          ),
      );
      expect(Object.keys(summary.rows[0] ?? {})).toEqual([
        "dashboard_id",
        "title",
        "current_kind",
        "lifecycle_state",
        "lifecycle_revision",
        "effective_expires_at",
        "head_version_id",
      ]);
      const listed = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () => client.query("SELECT * FROM dasher_api.list_dashboards(100)"),
      );
      expect(Object.keys(listed.rows[0] ?? {})).toEqual([
        "dashboard_id",
        "title",
        "current_kind",
        "lifecycle_state",
        "lifecycle_revision",
        "effective_expires_at",
        "head_version_id",
      ]);
      const admin = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query(
            "SELECT * FROM dasher_api.get_dashboard_admin_status($1::uuid)",
            [durableDashboardId],
          ),
      );
      expect(admin.rows[0]).toMatchObject({
        active_hold_count: "0",
        cleanup_step: null,
        dashboard_id: durableDashboardId,
      });

      await client.query("BEGIN");
      try {
        await setTask4ContextGucs(
          client,
          { ...actor, organizationId: randomUUID() },
          randomUUID(),
        );
        await expectDasherBoundaryError(
          client.query(
            "SELECT * FROM dasher_api.get_dashboard_summary($1::uuid)",
            [durableDashboardId],
          ),
          "P1001",
          "dasher_denied",
        );
      } finally {
        await client.query("ROLLBACK");
      }

      const forgedMutationDashboardId = randomUUID();
      const forgedMutationRequestId = randomUUID();
      const forgedMutationAuditId = randomUUID();
      await client.query("BEGIN");
      try {
        await setTask4ContextGucs(
          client,
          { ...actor, organizationId: randomUUID() },
          randomUUID(),
        );
        await expectDasherBoundaryError(
          client.query(
            `
              SELECT * FROM dasher_api.create_dashboard(
                $1::uuid, 'Forged organization mutation', 'durable', NULL,
                false, $2::uuid, $3::uuid, 1::smallint, $4::bytea,
                'task8b3-integration'
              )
            `,
            [
              forgedMutationDashboardId,
              forgedMutationRequestId,
              forgedMutationAuditId,
              actor.csrfDigest,
            ],
          ),
          "P1001",
          "dasher_denied",
        );
      } finally {
        await client.query("ROLLBACK");
      }
      const forgedMutationResidue = await ownerPool.query<{
        readonly audit_count: string;
        readonly dashboard_count: string;
      }>(
        `
          SELECT
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.dashboards
              WHERE dashboard_id = $1::uuid
            ) AS dashboard_count,
            (
              SELECT pg_catalog.count(*)::text
              FROM dasher.audit_events
              WHERE audit_event_id = $2::uuid
            ) AS audit_count
        `,
        [forgedMutationDashboardId, forgedMutationAuditId],
      );
      expect(forgedMutationResidue.rows[0]).toEqual({
        audit_count: "0",
        dashboard_count: "0",
      });
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
  }, 120_000);

  it("returns flat scalar and SETOF projection shapes and exposes shared artifacts only through exact target access claims", async () => {
    snapshotId = randomUUID();
    versionId = randomUUID();
    evidenceId = randomUUID();
    const ownedArtifactId = randomUUID();
    const sharedArtifactId = randomUUID();
    const retentionOnlyArtifactId = randomUUID();
    const crossDashboardArtifactId = randomUUID();
    const crossDashboardId = randomUUID();
    const crossVersionId = randomUUID();
    const holdId = randomUUID();
    const canonicalSpec = Buffer.from("{}", "utf8");
    const snapshotBytes = Buffer.from("task8b3-snapshot", "utf8");
    const seedClient = await ownerPool.connect();
    try {
      await executeServerFormattedSql(
        seedClient,
        `
        INSERT INTO dasher.dashboards (
          organization_id, dashboard_id, title, created_by_user_id, created_at,
          created_kind, current_kind, lifecycle_state, lifecycle_revision,
          capability_epoch, cache_epoch, retention_policy_revision,
          tombstone_lineage_id
        ) VALUES (
          %1$L::uuid, %2$L::uuid, 'Cross-claim dashboard', %3$L::uuid,
          clock_timestamp(), 'durable', 'durable', 'draft', 0, 0, 0, 1,
          %4$L::uuid
        );
        INSERT INTO dasher.source_snapshots (
          organization_id, snapshot_id, source_kind, canonical_bytes,
          content_sha256, observed_at, retrieved_at, created_at
        ) VALUES (
          %1$L::uuid, %5$L::uuid, 'synthetic_fixture',
          pg_catalog.decode(%6$L, 'hex'),
          pg_catalog.sha256(pg_catalog.decode(%6$L, 'hex')),
          clock_timestamp(), clock_timestamp(),
          clock_timestamp()
        );
        INSERT INTO dasher.dashboard_versions (
          organization_id, dashboard_id, version_id, parent_version_id,
          canonical_spec_bytes, canonical_spec_sha256, validation_state,
          validation_sha256, planner_provenance_sha256, policy_revision,
          registry_revision, calculation_graph_sha256, created_by_user_id,
          created_at
        ) VALUES
          (%1$L::uuid, %7$L::uuid, %8$L::uuid, NULL,
           pg_catalog.decode(%9$L, 'hex'),
           pg_catalog.sha256(pg_catalog.decode(%9$L, 'hex')), 'validated',
           pg_catalog.decode(%10$L, 'hex'), pg_catalog.decode(%10$L, 'hex'),
           1, 1, pg_catalog.decode(%10$L, 'hex'), %3$L::uuid,
           clock_timestamp()),
          (%1$L::uuid, %2$L::uuid, %11$L::uuid, NULL,
           pg_catalog.decode(%9$L, 'hex'),
           pg_catalog.sha256(pg_catalog.decode(%9$L, 'hex')), 'validated',
           pg_catalog.decode(%10$L, 'hex'), pg_catalog.decode(%10$L, 'hex'),
           1, 1, pg_catalog.decode(%10$L, 'hex'), %3$L::uuid,
           clock_timestamp());
        INSERT INTO dasher.dashboard_version_snapshots (
          organization_id, dashboard_id, version_id, snapshot_id
        ) VALUES (%1$L::uuid, %7$L::uuid, %8$L::uuid, %5$L::uuid);
        INSERT INTO dasher.snapshot_reference_claims (
          organization_id, snapshot_id, reference_claim_id, dashboard_id,
          version_id, claim_kind, hold_id, created_at
        ) VALUES (
          %1$L::uuid, %5$L::uuid, %8$L::uuid, %7$L::uuid, %8$L::uuid,
          'access_bearing', NULL, clock_timestamp()
        );
        INSERT INTO dasher.evidence_records (
          organization_id, evidence_id, snapshot_id, evidence_kind,
          coordinates, transformation, content_sha256, observed_at,
          retrieved_at, created_at
        ) VALUES (
          %1$L::uuid, %12$L::uuid, %5$L::uuid, 'source_record', 'fixture:0',
          'identity', pg_catalog.decode(%10$L, 'hex'),
          clock_timestamp(), clock_timestamp(),
          clock_timestamp()
        );
        INSERT INTO dasher.dashboard_version_evidence (
          organization_id, dashboard_id, version_id, evidence_id
        ) VALUES (%1$L::uuid, %7$L::uuid, %8$L::uuid, %12$L::uuid);
        INSERT INTO dasher.evidence_reference_claims (
          organization_id, evidence_id, reference_claim_id, dashboard_id,
          version_id, claim_kind, hold_id, created_at
        ) VALUES (
          %1$L::uuid, %12$L::uuid, %12$L::uuid, %7$L::uuid, %8$L::uuid,
          'access_bearing', NULL, clock_timestamp()
        );
        INSERT INTO dasher.dashboard_legal_holds (
          organization_id, dashboard_id, hold_id, case_matter_reference,
          placed_by_principal_id, placed_authority_revision, placed_actor,
          placed_reason_sha256, placed_at, retention_policy_revision
        ) VALUES (
          %1$L::uuid, %7$L::uuid, %13$L::uuid, 'task8b3-retention-only',
          %3$L::uuid, 1, 'integration', pg_catalog.decode(%10$L, 'hex'),
          clock_timestamp(), 1
        );
        INSERT INTO dasher.dashboard_artifacts (
          organization_id, artifact_id, dashboard_id, version_id,
          ownership_class, artifact_kind, metadata_sha256, content_sha256,
          created_at
        ) VALUES
          (%1$L::uuid, %14$L::uuid, %7$L::uuid, %8$L::uuid,
           'dashboard_owned', 'projection', pg_catalog.decode(%10$L, 'hex'),
           pg_catalog.decode(%10$L, 'hex'), clock_timestamp()),
          (%1$L::uuid, %15$L::uuid, NULL, NULL, 'shared', 'projection',
           pg_catalog.decode(%10$L, 'hex'), pg_catalog.decode(%10$L, 'hex'),
           clock_timestamp()),
          (%1$L::uuid, %16$L::uuid, NULL, NULL, 'shared', 'projection',
           pg_catalog.decode(%10$L, 'hex'), pg_catalog.decode(%10$L, 'hex'),
           clock_timestamp()),
          (%1$L::uuid, %17$L::uuid, NULL, NULL, 'shared', 'projection',
           pg_catalog.decode(%10$L, 'hex'), pg_catalog.decode(%10$L, 'hex'),
           clock_timestamp());
        INSERT INTO dasher.artifact_reference_claims (
          organization_id, artifact_id, reference_claim_id, dashboard_id,
          version_id, claim_kind, hold_id, created_at
        ) VALUES
          (%1$L::uuid, %14$L::uuid, %14$L::uuid, %7$L::uuid, %8$L::uuid,
           'access_bearing', NULL, clock_timestamp()),
          (%1$L::uuid, %15$L::uuid, %15$L::uuid, %7$L::uuid, %8$L::uuid,
           'access_bearing', NULL, clock_timestamp()),
          (%1$L::uuid, %16$L::uuid, %16$L::uuid, %7$L::uuid, %8$L::uuid,
           'retention_only', %13$L::uuid, clock_timestamp()),
          (%1$L::uuid, %17$L::uuid, %17$L::uuid, %2$L::uuid, %11$L::uuid,
           'access_bearing', NULL, clock_timestamp())
      `,
        [
          actor.organizationId,
          crossDashboardId,
          actor.userId,
          randomUUID(),
          snapshotId,
          snapshotBytes.toString("hex"),
          durableDashboardId,
          versionId,
          canonicalSpec.toString("hex"),
          randomBytes(32).toString("hex"),
          crossVersionId,
          evidenceId,
          holdId,
          ownedArtifactId,
          sharedArtifactId,
          retentionOnlyArtifactId,
          crossDashboardArtifactId,
        ],
      );
    } finally {
      seedClient.release();
    }

    const client = await appPool!.connect();
    try {
      await client.query("SET ROLE dasher_app");
      await runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
        client.query(
          `
            SELECT dasher_api.compare_and_swap_dashboard_head(
              $1::uuid, NULL, $2::uuid, 0, $3::uuid, 1::smallint,
              $4::bytea, 'task8b3-integration'
            )
          `,
          [durableDashboardId, versionId, randomUUID(), actor.csrfDigest],
        ),
      );

      for (const [sql, parameters, expectedFields] of [
        [
          "SELECT * FROM dasher_api.get_dashboard_head($1::uuid)",
          [durableDashboardId],
          [
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
            "created_at",
          ],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_version($1::uuid, $2::uuid)",
          [durableDashboardId, versionId],
          [
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
            "created_at",
          ],
        ],
      ] as const) {
        const result = await runContextOperation(
          client,
          actor.sessionDigest,
          randomUUID(),
          () => client.query(sql, [...parameters]),
        );
        expect(Object.keys(result.rows[0] ?? {})).toEqual(expectedFields);
      }
      const evidence = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query(
            "SELECT * FROM dasher_api.get_dashboard_evidence($1::uuid, $2::uuid)",
            [durableDashboardId, versionId],
          ),
      );
      expect(Object.keys(evidence.rows[0] ?? {})).toEqual([
        "dashboard_id",
        "version_id",
        "evidence_id",
        "evidence_kind",
        "content_sha256",
        "observed_at",
        "retrieved_at",
      ]);
      const lineage = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query<{
            readonly artifact_id: string;
            readonly artifact_ownership_class: string;
          }>(
            "SELECT * FROM dasher_api.get_dashboard_lineage($1::uuid, $2::uuid)",
            [durableDashboardId, versionId],
          ),
      );
      expect(Object.keys(lineage.rows[0] ?? {})).toEqual([
        "dashboard_id",
        "version_id",
        "parent_version_id",
        "snapshot_id",
        "evidence_id",
        "artifact_id",
        "artifact_ownership_class",
      ]);
      expect(
        lineage.rows
          .map((row) => [row.artifact_id, row.artifact_ownership_class])
          .sort(),
      ).toEqual(
        [
          [ownedArtifactId, "dashboard_owned"],
          [sharedArtifactId, "shared"],
        ].sort(),
      );
      expect(lineage.rows.map((row) => row.artifact_id)).not.toContain(
        retentionOnlyArtifactId,
      );
      expect(lineage.rows.map((row) => row.artifact_id)).not.toContain(
        crossDashboardArtifactId,
      );
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
  }, 120_000);

  it("denies archived durable evidence append with no residue while preserving archived reads", async () => {
    const client = await appPool!.connect();
    try {
      await client.query("SET ROLE dasher_app");
      await runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
        client.query(
          `
            SELECT dasher_api.set_dashboard_archive(
              $1::uuid, true, 1, $2::uuid, 1::smallint, $3::bytea,
              'task8b3-integration'
            )
          `,
          [durableDashboardId, randomUUID(), actor.csrfDigest],
        ),
      );
      const rejectedEvidenceId = randomUUID();
      const rejectedAuditId = randomUUID();
      await expectDasherBoundaryError(
        runContextOperation(client, actor.sessionDigest, randomUUID(), () =>
          client.query(
            `
              SELECT dasher_api.create_evidence_record(
                $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                'source_record', 'fixture:archived', $6::bytea,
                clock_timestamp(), clock_timestamp(), $7::uuid,
                1::smallint, $8::bytea, 'task8b3-integration'
              )
            `,
            [
              durableDashboardId,
              versionId,
              rejectedEvidenceId,
              snapshotId,
              randomUUID(),
              randomBytes(32),
              rejectedAuditId,
              actor.csrfDigest,
            ],
          ),
        ),
        "P1001",
        "dasher_denied",
      );
      const residue = await ownerPool.query<{
        readonly audit_count: string;
        readonly evidence_count: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text FROM dasher.evidence_records
             WHERE evidence_id = $1::uuid) AS evidence_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
             WHERE audit_event_id = $2::uuid) AS audit_count
        `,
        [rejectedEvidenceId, rejectedAuditId],
      );
      expect(residue.rows[0]).toEqual({
        audit_count: "0",
        evidence_count: "0",
      });
      const archivedRead = await runContextOperation(
        client,
        actor.sessionDigest,
        randomUUID(),
        () =>
          client.query<{ readonly evidence_id: string }>(
            "SELECT * FROM dasher_api.get_dashboard_evidence($1::uuid, $2::uuid)",
            [durableDashboardId, versionId],
          ),
      );
      expect(archivedRead.rows.map((row) => row.evidence_id)).toEqual([
        evidenceId,
      ]);
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
  }, 120_000);
});

describe.sequential("Task 8C lifecycle repository", () => {
  let editor: Task4Actor;
  let editorSessionToken: string;
  let editorCsrfValue: string;
  let adminSessionToken: string;
  let adminCsrfValue: string;
  let keyRing: SecretKeyRing;

  beforeAll(async () => {
    await closeAppPoolBeforeLoginTeardown();
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }
    await resetManagedSchemas();
    await createTemporaryAppLogin(ownerPool, config.appDsn, config.appUsername);
    appLoginCreated = true;
    await runMigrations(ownerPool, canonicalMigrationDirectory, [
      config.appUsername,
    ]);
    appPool = new Pool({ connectionString: config.appDsn, max: 4 });
    const client = await appPool.connect();
    try {
      await client.query("SET ROLE dasher_app");
      keyRing = createTask6KeyRing();
      const editorSession = keyRing.issue("session");
      const editorCsrf = keyRing.issue("csrf");
      editorSessionToken = editorSession.wireValue;
      editorCsrfValue = editorCsrf.wireValue;
      editor = await createTask4Actor(client, "editor", undefined, {
        sessionDigest: Buffer.from(editorSession.persistence.digest),
        csrfDigest: Buffer.from(editorCsrf.persistence.digest),
      });
      const adminSession = keyRing.issue("session");
      const adminCsrf = keyRing.issue("csrf");
      adminSessionToken = adminSession.wireValue;
      adminCsrfValue = adminCsrf.wireValue;
      await createTask4Actor(client, "admin", editor.organizationId, {
        sessionDigest: Buffer.from(adminSession.persistence.digest),
        csrfDigest: Buffer.from(adminCsrf.persistence.digest),
      });
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
  }, 120_000);

  it("runs the corrected fixed repository lifecycle without widening authority", async () => {
    const client = await appPool!.connect();
    try {
      await client.query("SET ROLE dasher_app");
      const createIds = Array.from({ length: 4 }, () => randomUUID());
      const created = await createTask8cRepository(
        client,
        keyRing,
        createIds,
      ).createDashboard({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        title: "Repository lifecycle fixture",
        kind: "disposable",
        ttl: 3_600,
      });
      expect(created).toMatchObject({
        dashboardId: createIds[1],
        effectiveTtlSeconds: 3_600,
        usedOrganizationDefault: false,
        lifecyclePolicySeeded: true,
        lifecyclePolicyRevision: 1,
        defaultDisposableTtlSeconds: 86_400,
        retentionPolicyRevision: 1,
      });
      expect(
        created.effectiveExpiresAt!.getTime() - created.createdAt.getTime(),
      ).toBe(3_600_000);

      const draft = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardSummary({
        sessionToken: editorSessionToken,
        dashboardId: created.dashboardId,
      });
      expect(draft).toMatchObject({
        currentKind: "disposable",
        lifecycleState: "draft",
        lifecycleRevision: 0,
        headVersionId: null,
      });
      expect(draft.effectiveExpiresAt).not.toBeNull();

      const prematurePromotionIds = Array.from({ length: 3 }, () =>
        randomUUID(),
      );
      await expect(
        createTask8cRepository(
          client,
          keyRing,
          prematurePromotionIds,
        ).requestDashboardPromotion({
          sessionToken: editorSessionToken,
          currentCsrfValue: editorCsrfValue,
          dashboardId: created.dashboardId,
          expectedLifecycleRevision: 0,
          rationaleSha256: new Uint8Array(randomBytes(32)),
        }),
      ).rejects.toBeInstanceOf(OperationConflictError);
      const prematureResidue = await ownerPool.query<{
        readonly audit_count: string;
        readonly request_count: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text
             FROM dasher.dashboard_promotion_requests
             WHERE promotion_request_id = $1::uuid) AS request_count,
            (SELECT pg_catalog.count(*)::text
             FROM dasher.audit_events
             WHERE audit_event_id = $2::uuid) AS audit_count
        `,
        [prematurePromotionIds[1], prematurePromotionIds[2]],
      );
      expect(prematureResidue.rows[0]).toEqual({
        audit_count: "0",
        request_count: "0",
      });

      const snapshotId = randomUUID();
      const snapshotBytes = Buffer.from("task8c-repository-snapshot", "utf8");
      await ownerPool.query(
        `
          INSERT INTO dasher.source_snapshots (
            organization_id, snapshot_id, source_kind, canonical_bytes,
            content_sha256, observed_at, retrieved_at, created_at
          ) VALUES (
            $1::uuid, $2::uuid, 'synthetic_fixture', $3::bytea,
            pg_catalog.sha256($3::bytea), clock_timestamp(),
            clock_timestamp(), clock_timestamp()
          )
        `,
        [editor.organizationId, snapshotId, snapshotBytes],
      );
      const firstSpec = new TextEncoder().encode('{"revision":1}');
      const firstSpecSha256 = new Uint8Array(
        createHash("sha256").update(firstSpec).digest(),
      );
      const firstVersionIds = Array.from({ length: 4 }, () => randomUUID());
      const firstVersion = await createTask8cRepository(
        client,
        keyRing,
        firstVersionIds,
      ).createDashboardVersion({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        dashboardId: created.dashboardId,
        parentVersionId: null,
        canonicalSpecBytes: firstSpec,
        canonicalSpecSha256: firstSpecSha256,
        validationSha256: new Uint8Array(randomBytes(32)),
        plannerProvenanceSha256: new Uint8Array(randomBytes(32)),
        policyRevision: 1,
        registryRevision: 1,
        calculationGraphSha256: null,
        snapshotIds: [snapshotId],
        evidenceIds: [],
      });
      expect(firstVersion.versionId).toBe(firstVersionIds[1]);

      const evidenceIds = Array.from({ length: 4 }, () => randomUUID());
      const evidenceContentSha256 = new Uint8Array(randomBytes(32));
      const evidenceObservedAt = new Date("2026-08-03T10:00:00.000Z");
      const evidenceRetrievedAt = new Date("2026-08-03T10:01:00.000Z");
      const evidence = await createTask8cRepository(
        client,
        keyRing,
        evidenceIds,
      ).createEvidenceRecord({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        dashboardId: created.dashboardId,
        versionId: firstVersion.versionId,
        snapshotId,
        evidenceKind: "typed_value",
        coordinates: "metric=generic_value;grain=revision",
        contentSha256: evidenceContentSha256,
        observedAt: evidenceObservedAt,
        retrievedAt: evidenceRetrievedAt,
      });
      expect(evidence.evidenceId).toBe(evidenceIds[1]);

      const ownedArtifactId = randomUUID();
      const sharedArtifactId = randomUUID();
      await ownerPool.query(
        `
          WITH inserted_artifacts AS (
            INSERT INTO dasher.dashboard_artifacts (
              organization_id, artifact_id, dashboard_id, version_id,
              ownership_class, artifact_kind, metadata_sha256, content_sha256,
              created_at
            ) VALUES
              ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'dashboard_owned',
               'projection', $5::bytea, $5::bytea, clock_timestamp()),
              ($1::uuid, $6::uuid, NULL, NULL, 'shared', 'projection',
               $5::bytea, $5::bytea, clock_timestamp())
            RETURNING organization_id, artifact_id
          )
          INSERT INTO dasher.artifact_reference_claims (
            organization_id, artifact_id, reference_claim_id, dashboard_id,
            version_id, claim_kind, hold_id, created_at
          )
          SELECT organization_id, artifact_id, artifact_id, $3::uuid, $4::uuid,
                 'access_bearing', NULL, clock_timestamp()
          FROM inserted_artifacts
        `,
        [
          editor.organizationId,
          ownedArtifactId,
          created.dashboardId,
          firstVersion.versionId,
          randomBytes(32),
          sharedArtifactId,
        ],
      );

      await createTask8cRepository(client, keyRing, [
        randomUUID(),
        randomUUID(),
      ]).compareAndSwapDashboardHead({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        dashboardId: created.dashboardId,
        expectedHeadVersionId: null,
        newHeadVersionId: firstVersion.versionId,
        expectedLifecycleRevision: 0,
      });

      const secondSpec = new TextEncoder().encode('{"revision":2}');
      const secondVersionIds = Array.from({ length: 4 }, () => randomUUID());
      const secondVersion = await createTask8cRepository(
        client,
        keyRing,
        secondVersionIds,
      ).createDashboardVersion({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        dashboardId: created.dashboardId,
        parentVersionId: firstVersion.versionId,
        canonicalSpecBytes: secondSpec,
        canonicalSpecSha256: new Uint8Array(
          createHash("sha256").update(secondSpec).digest(),
        ),
        validationSha256: new Uint8Array(randomBytes(32)),
        plannerProvenanceSha256: new Uint8Array(randomBytes(32)),
        policyRevision: 1,
        registryRevision: 1,
        calculationGraphSha256: null,
        snapshotIds: [snapshotId],
        evidenceIds: [],
      });
      await createTask8cRepository(client, keyRing, [
        randomUUID(),
        randomUUID(),
      ]).compareAndSwapDashboardHead({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        dashboardId: created.dashboardId,
        expectedHeadVersionId: firstVersion.versionId,
        newHeadVersionId: secondVersion.versionId,
        expectedLifecycleRevision: 1,
      });

      const staleIds = [randomUUID(), randomUUID()];
      await expect(
        createTask8cRepository(
          client,
          keyRing,
          staleIds,
        ).compareAndSwapDashboardHead({
          sessionToken: editorSessionToken,
          currentCsrfValue: editorCsrfValue,
          dashboardId: created.dashboardId,
          expectedHeadVersionId: firstVersion.versionId,
          newHeadVersionId: firstVersion.versionId,
          expectedLifecycleRevision: 1,
        }),
      ).rejects.toBeInstanceOf(OperationConflictError);
      const staleResidue = await ownerPool.query<{
        readonly audit_count: string;
        readonly event_count: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
             WHERE audit_event_id = $1::uuid) AS audit_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.dashboard_lifecycle_events
             WHERE lifecycle_event_id = $1::uuid) AS event_count
        `,
        [staleIds[1]],
      );
      expect(staleResidue.rows[0]).toEqual({
        audit_count: "0",
        event_count: "0",
      });

      const promotionIds = Array.from({ length: 3 }, () => randomUUID());
      const promotion = await createTask8cRepository(
        client,
        keyRing,
        promotionIds,
      ).requestDashboardPromotion({
        sessionToken: editorSessionToken,
        currentCsrfValue: editorCsrfValue,
        dashboardId: created.dashboardId,
        expectedLifecycleRevision: 2,
        rationaleSha256: new Uint8Array(randomBytes(32)),
      });
      const decisionIds = Array.from({ length: 3 }, () => randomUUID());
      await expect(
        createTask8cRepository(
          client,
          keyRing,
          decisionIds,
        ).decideDashboardPromotion({
          sessionToken: adminSessionToken,
          currentCsrfValue: adminCsrfValue,
          promotionRequestId: promotion.promotionRequestId,
          expectedLifecycleRevision: 2,
          decision: "approved",
        }),
      ).resolves.toMatchObject({
        decision: "approved",
        lifecycleEventId: decisionIds[1],
      });

      await createTask8cRepository(client, keyRing, [
        randomUUID(),
        randomUUID(),
      ]).setDashboardArchive({
        sessionToken: adminSessionToken,
        currentCsrfValue: adminCsrfValue,
        dashboardId: created.dashboardId,
        archived: true,
        expectedLifecycleRevision: 3,
      });
      const archived = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardSummary({
        sessionToken: editorSessionToken,
        dashboardId: created.dashboardId,
      });
      expect(archived).toMatchObject({
        currentKind: "durable",
        lifecycleState: "archived",
        lifecycleRevision: 4,
        effectiveExpiresAt: null,
        headVersionId: secondVersion.versionId,
      });
      const archivedHead = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardHead({
        sessionToken: editorSessionToken,
        dashboardId: created.dashboardId,
      });
      expect(archivedHead.versionId).toBe(secondVersion.versionId);
      const archivedEvidence = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardEvidence({
        sessionToken: editorSessionToken,
        dashboardId: created.dashboardId,
        versionId: firstVersion.versionId,
      });
      expect(archivedEvidence).toEqual([
        expect.objectContaining({
          evidenceId: evidence.evidenceId,
          evidenceKind: "typed_value",
          observedAt: evidenceObservedAt,
          retrievedAt: evidenceRetrievedAt,
        }),
      ]);
      const archivedLineage = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardLineage({
        sessionToken: editorSessionToken,
        dashboardId: created.dashboardId,
        versionId: firstVersion.versionId,
      });
      expect(
        archivedLineage
          .map((row) => [row.artifactId, row.artifactOwnershipClass])
          .sort(),
      ).toEqual(
        [
          [ownedArtifactId, "dashboard_owned"],
          [sharedArtifactId, "shared"],
        ].sort(),
      );

      const rejectedVersionIds = Array.from({ length: 4 }, () => randomUUID());
      await expect(
        createTask8cRepository(
          client,
          keyRing,
          rejectedVersionIds,
        ).createDashboardVersion({
          sessionToken: editorSessionToken,
          currentCsrfValue: editorCsrfValue,
          dashboardId: created.dashboardId,
          parentVersionId: secondVersion.versionId,
          canonicalSpecBytes: secondSpec,
          canonicalSpecSha256: new Uint8Array(
            createHash("sha256").update(secondSpec).digest(),
          ),
          validationSha256: new Uint8Array(randomBytes(32)),
          plannerProvenanceSha256: new Uint8Array(randomBytes(32)),
          policyRevision: 1,
          registryRevision: 1,
          calculationGraphSha256: null,
          snapshotIds: [snapshotId],
          evidenceIds: [],
        }),
      ).rejects.toBeInstanceOf(OperationDeniedError);
      const archivedMutationResidue = await ownerPool.query<{
        readonly audit_count: string;
        readonly version_count: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text FROM dasher.dashboard_versions
             WHERE version_id = $1::uuid) AS version_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
             WHERE audit_event_id = $2::uuid) AS audit_count
        `,
        [rejectedVersionIds[1], rejectedVersionIds[3]],
      );
      expect(archivedMutationResidue.rows[0]).toEqual({
        audit_count: "0",
        version_count: "0",
      });

      await createTask8cRepository(client, keyRing, [
        randomUUID(),
        randomUUID(),
      ]).deleteDashboard({
        sessionToken: adminSessionToken,
        currentCsrfValue: adminCsrfValue,
        dashboardId: created.dashboardId,
        expectedLifecycleRevision: 4,
      });
      const cleanup = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardAdminStatus({
        sessionToken: adminSessionToken,
        dashboardId: created.dashboardId,
      });
      expect(cleanup).toMatchObject({
        lifecycleState: "access_revoked",
        lifecycleRevision: 5,
        capabilityEpoch: 3,
        cacheEpoch: 3,
        activeHoldCount: 0,
        cleanupStep: "access_revoked",
      });
      expect(cleanup.accessRevokedAt).not.toBeNull();
      expect(cleanup.purgeAfter).not.toBeNull();

      const restoreIds = Array.from({ length: 5 }, () => randomUUID());
      const restored = await createTask8cRepository(
        client,
        keyRing,
        restoreIds,
      ).restoreDashboardAsNew({
        sessionToken: adminSessionToken,
        currentCsrfValue: adminCsrfValue,
        sourceDashboardId: created.dashboardId,
        sourceVersionId: firstVersion.versionId,
        expectedSourceLifecycleRevision: 5,
        title: "Selected revision restored",
        provenanceSha256: new Uint8Array(randomBytes(32)),
      });
      expect(restored).toEqual({
        dashboardId: restoreIds[1],
        versionId: restoreIds[2],
      });
      const restoredDraft = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardSummary({
        sessionToken: adminSessionToken,
        dashboardId: restored.dashboardId,
      });
      expect(restoredDraft).toMatchObject({
        currentKind: "durable",
        lifecycleState: "draft",
        lifecycleRevision: 0,
        effectiveExpiresAt: null,
        headVersionId: null,
      });
      const restoredVersion = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardVersion({
        sessionToken: adminSessionToken,
        dashboardId: restored.dashboardId,
        versionId: restored.versionId,
      });
      expect(restoredVersion.parentVersionId).toBeNull();
      expect(restoredVersion.canonicalSpecBytes).toEqual(firstSpec);

      const preserved = await ownerPool.query<{
        readonly source_head_version_id: string;
      }>(
        `
          SELECT head_version_id::text AS source_head_version_id
          FROM dasher.dashboards
          WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid
        `,
        [editor.organizationId, created.dashboardId],
      );
      expect(preserved.rows[0]?.source_head_version_id).toBe(
        secondVersion.versionId,
      );
      await createTask8cRepository(client, keyRing, [
        randomUUID(),
        randomUUID(),
      ]).compareAndSwapDashboardHead({
        sessionToken: adminSessionToken,
        currentCsrfValue: adminCsrfValue,
        dashboardId: restored.dashboardId,
        expectedHeadVersionId: null,
        newHeadVersionId: restored.versionId,
        expectedLifecycleRevision: 0,
      });
      const restoredActive = await createTask8cRepository(client, keyRing, [
        randomUUID(),
      ]).getDashboardSummary({
        sessionToken: adminSessionToken,
        dashboardId: restored.dashboardId,
      });
      expect(restoredActive).toMatchObject({
        lifecycleState: "active",
        lifecycleRevision: 1,
        headVersionId: restored.versionId,
      });
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
  }, 120_000);
});

describe.sequential("Task 8D authoritative PostgreSQL lifecycle gate", () => {
  const admin: Task4Actor = {
    csrfDigest: Buffer.alloc(32, 0x8d),
    identityIssuer: "https://task8d-fixture.test",
    identitySubject: "task8d-admin",
    membershipId: "8d000000-0000-4000-8000-000000000011",
    organizationId: task8dOrganizationId,
    sessionDigest: Buffer.alloc(32, 0x8e),
    sessionId: "8d000000-0000-4000-8000-000000000012",
    userId: "8d000000-0000-4000-8000-000000000010",
  };
  const editor: Task4Actor = {
    csrfDigest: Buffer.alloc(32, 0x9d),
    identityIssuer: "https://task8d-fixture.test",
    identitySubject: "task8d-editor",
    membershipId: "8d000000-0000-4000-8000-000000000021",
    organizationId: task8dOrganizationId,
    sessionDigest: Buffer.alloc(32, 0x9e),
    sessionId: "8d000000-0000-4000-8000-000000000022",
    userId: "8d000000-0000-4000-8000-000000000020",
  };
  const expiryDashboardId = "8d000000-0000-4000-8000-00000000d101";
  const expiryVersionId = "8d000000-0000-4000-8000-00000000d102";
  const expirySnapshotId = "8d000000-0000-4000-8000-00000000d103";
  const expiryEvidenceId = "8d000000-0000-4000-8000-00000000d104";
  const expiryArtifactId = "8d000000-0000-4000-8000-00000000d105";
  let retentionPool: Pool | undefined;
  let retentionLoginCreated = false;

  async function issueFixedActor(
    client: PoolClient,
    actor: Task4Actor,
    role: "admin" | "editor",
    auditEventId: string,
    requestId: string,
  ): Promise<void> {
    await ownerPool.query(
      "INSERT INTO dasher.users (user_id) VALUES ($1::uuid)",
      [actor.userId],
    );
    await ownerPool.query(
      `INSERT INTO dasher.external_identities (issuer, subject, user_id)
       VALUES ($1, $2, $3::uuid)`,
      [actor.identityIssuer, actor.identitySubject, actor.userId],
    );
    await ownerPool.query(
      `INSERT INTO dasher.memberships (
         membership_id, organization_id, user_id, role, state,
         authority_revision
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', 1)`,
      [actor.membershipId, actor.organizationId, actor.userId, role],
    );
    await client.query(
      `
        SELECT * FROM dasher_api.issue_session(
          $1, $2, $3::uuid, $4::uuid, 1::smallint, $5::bytea,
          1::smallint, $6::bytea, $7::uuid, $8::uuid,
          'task8d-lifecycle-gate'
        )
      `,
      [
        actor.identityIssuer,
        actor.identitySubject,
        actor.membershipId,
        actor.sessionId,
        actor.sessionDigest,
        actor.csrfDigest,
        auditEventId,
        requestId,
      ],
    );
  }

  async function createFixedDashboard(
    client: PoolClient,
    actor: Task4Actor,
    fixture: Readonly<{
      auditEventId: string;
      dashboardId: string;
      requestId: string;
      tombstoneLineageId: string;
      ttlSeconds: number | null;
      useOrganizationDefault: boolean;
    }>,
  ) {
    return runContextOperation(
      client,
      actor.sessionDigest,
      fixture.requestId,
      () =>
        client.query<{
          readonly created_at: Date;
          readonly dashboard_id: string;
          readonly default_disposable_ttl_seconds: number;
          readonly effective_expires_at: Date;
          readonly effective_ttl_seconds: number;
          readonly lifecycle_policy_revision: string;
          readonly lifecycle_policy_seeded: boolean;
          readonly retention_policy_revision: string;
          readonly used_organization_default: boolean;
        }>(
          `
            SELECT * FROM dasher_api.create_dashboard(
              $1::uuid, $2, 'disposable', $3::integer, $4::boolean,
              $5::uuid, $6::uuid, 1::smallint, $7::bytea,
              'task8d-lifecycle-gate'
            )
          `,
          [
            fixture.dashboardId,
            `Task 8D ${fixture.dashboardId}`,
            fixture.ttlSeconds,
            fixture.useOrganizationDefault,
            fixture.tombstoneLineageId,
            fixture.auditEventId,
            actor.csrfDigest,
          ],
        ),
    );
  }

  async function callRetention(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<void> {
    const client = await retentionPool!.connect();
    let operationError: unknown;
    let roleSet = false;
    try {
      await client.query("SET ROLE dasher_retention_operator");
      roleSet = true;
      await client.query(sql, [...parameters]);
    } catch (error) {
      operationError = error;
    } finally {
      if (roleSet) {
        try {
          await client.query("RESET ROLE");
        } catch (error) {
          operationError ??= error;
        }
      }
      client.release(
        operationError instanceof Error ? operationError : undefined,
      );
    }
    if (operationError !== undefined) {
      throw operationError;
    }
  }

  // Frozen 0007 makes every retention proof a hash over live coordination and
  // dashboard state, so this test derives each one from the database the same
  // way the definer does rather than carrying a hand-written constant. Each
  // helper below mirrors exactly one frozen preimage.
  const task8dRetentionPrincipalId = "8d000000-0000-4000-8000-000000000030";
  const task8dRetentionPrincipalRevision = 1;

  async function task8dDrainRequestProof(
    expectedLifecycleRevision: number,
    operationAndAuditId: string,
    deploymentRevision: string,
  ): Promise<Buffer> {
    const derived = await ownerPool.query<{
      readonly request_sha256: Buffer;
    }>(
      `SELECT pg_catalog.sha256(
         pg_catalog.convert_to('dasher.agent-run-drain-request.v1', 'UTF8')
         || pg_catalog.decode('00', 'hex')
         || pg_catalog.uuid_send($2::uuid)
         || pg_catalog.int8send($3::bigint)
         || pg_catalog.uuid_send($4::uuid)
         || pg_catalog.int4send(pg_catalog.octet_length($5::text))
         || pg_catalog.convert_to($5::text, 'UTF8')
         || pg_catalog.uuid_send($1::uuid)
         || pg_catalog.int4send(
           pg_catalog.octet_length(coordination.current_step))
         || pg_catalog.convert_to(coordination.current_step, 'UTF8')
         || pg_catalog.int4send(
           pg_catalog.octet_length(coordination.lease_owner::text))
         || pg_catalog.convert_to(coordination.lease_owner::text, 'UTF8')
         || pg_catalog.int8send((extract(epoch FROM
           coordination.lease_expires_at) * 1000000)::bigint)
         || pg_catalog.uuid_send($6::uuid)
         || pg_catalog.int8send($7::bigint)
       ) AS request_sha256
       FROM dasher.dashboard_cleanup_coordination AS coordination
       WHERE coordination.organization_id = $1::uuid
         AND coordination.dashboard_id = $2::uuid`,
      [
        task8dOrganizationId,
        expiryDashboardId,
        expectedLifecycleRevision,
        operationAndAuditId,
        deploymentRevision,
        task8dRetentionPrincipalId,
        task8dRetentionPrincipalRevision,
      ],
    );
    const digest = derived.rows[0]?.request_sha256;
    if (digest === undefined) {
      throw new Error("Task 8D could not derive the drain request proof");
    }
    return digest;
  }

  async function task8dCleanupCompletionProof(
    cleanupAttemptId: string,
    step: string,
    result: string,
    releasedClaimCount: number,
    deletedResourceCount: number,
    deferredClaimCount: number,
  ): Promise<Buffer> {
    const derived = await ownerPool.query<{
      readonly completion_sha256: Buffer;
    }>(
      `SELECT pg_catalog.sha256(
         pg_catalog.convert_to(
           'dasher.dashboard-cleanup-completion.v1', 'UTF8')
         || pg_catalog.decode('00', 'hex')
         || pg_catalog.uuid_send($2::uuid)
         || pg_catalog.int8send(dashboard.lifecycle_revision)
         || pg_catalog.uuid_send($3::uuid)
         || pg_catalog.int4send(pg_catalog.octet_length($4::text))
         || pg_catalog.convert_to($4::text, 'UTF8')
         || pg_catalog.int4send(pg_catalog.octet_length($5::text))
         || pg_catalog.convert_to($5::text, 'UTF8')
         || pg_catalog.int8send($6::bigint)
         || pg_catalog.int8send($7::bigint)
         || pg_catalog.int8send($8::bigint)
         || CASE WHEN drain.drain_proof_sha256 IS NULL
           THEN pg_catalog.decode('00', 'hex')
           ELSE pg_catalog.decode('01', 'hex')
             || pg_catalog.int4send(
               pg_catalog.octet_length(drain.drain_proof_sha256))
             || drain.drain_proof_sha256 END
         || pg_catalog.uuid_send($1::uuid)
         || pg_catalog.int4send(
           pg_catalog.octet_length(coordination.lease_owner::text))
         || pg_catalog.convert_to(coordination.lease_owner::text, 'UTF8')
         || pg_catalog.uuid_send($9::uuid)
         || pg_catalog.int8send($10::bigint)
       ) AS completion_sha256
       FROM dasher.dashboards AS dashboard
       JOIN dasher.dashboard_cleanup_coordination AS coordination
         ON coordination.organization_id = dashboard.organization_id
         AND coordination.dashboard_id = dashboard.dashboard_id
       LEFT JOIN LATERAL (
         SELECT proof.drain_proof_sha256
         FROM dasher.dashboard_agent_drain_proofs AS proof
         WHERE proof.organization_id = dashboard.organization_id
           AND proof.dashboard_id = dashboard.dashboard_id
           AND NOT EXISTS (
             SELECT 1
             FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
             WHERE consumed.organization_id = proof.organization_id
               AND consumed.dashboard_id = proof.dashboard_id
               AND consumed.proof_id = proof.proof_id
           )
         ORDER BY proof.generated_at DESC,
           pg_catalog.uuid_send(proof.proof_id) DESC
         LIMIT 1
       ) AS drain ON true
       WHERE dashboard.organization_id = $1::uuid
         AND dashboard.dashboard_id = $2::uuid`,
      [
        task8dOrganizationId,
        expiryDashboardId,
        cleanupAttemptId,
        step,
        result,
        releasedClaimCount,
        deletedResourceCount,
        deferredClaimCount,
        task8dRetentionPrincipalId,
        task8dRetentionPrincipalRevision,
      ],
    );
    const digest = derived.rows[0]?.completion_sha256;
    if (digest === undefined) {
      throw new Error("Task 8D could not derive the cleanup completion proof");
    }
    return digest;
  }

  async function task8dUnconsumedDrainProof(): Promise<Buffer> {
    const derived = await ownerPool.query<{
      readonly drain_proof_sha256: Buffer;
    }>(
      `SELECT proof.drain_proof_sha256
       FROM dasher.dashboard_agent_drain_proofs AS proof
       WHERE proof.organization_id = $1::uuid
         AND proof.dashboard_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1
           FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
           WHERE consumed.organization_id = proof.organization_id
             AND consumed.dashboard_id = proof.dashboard_id
             AND consumed.proof_id = proof.proof_id
         )
       ORDER BY proof.generated_at DESC,
         pg_catalog.uuid_send(proof.proof_id) DESC
       LIMIT 1`,
      [task8dOrganizationId, expiryDashboardId],
    );
    const digest = derived.rows[0]?.drain_proof_sha256;
    if (digest === undefined) {
      throw new Error("Task 8D found no unconsumed drain proof");
    }
    return digest;
  }

  // The frozen claim upsert only re-leases a coordination row whose lease and
  // next-attempt boundaries have both passed. Releasing the lease from the
  // owner connection is how this test advances between cleanup steps without
  // sleeping out a real lease duration; it never touches lifecycle state.
  async function task8dReleaseCleanupLease(): Promise<void> {
    await ownerPool.query(
      `UPDATE dasher.dashboard_cleanup_coordination
       SET lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = statement_timestamp()
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
  }

  // One full frozen drain step: take the lease, produce the drain proof a
  // later claim will consume, and record the successful attempt that closes
  // the step.
  // Reads dasher.dashboard_cleanup_attempts through the real retention SELECT
  // policy under one chosen capability. The policy is only ever evaluated with
  // current_user = dasher_retention_definer and SESSION_USER bound in the
  // allowlist, and dasher_retention_definer is granted to no role in this
  // cluster, so no login can reach that pair except inside a SECURITY DEFINER
  // retention routine - and no frozen routine reads this relation under an
  // unrelated capability. The probe therefore binds the owner's own
  // SESSION_USER into the allowlist inside a transaction it always rolls back,
  // then evaluates the unmodified policy under SET LOCAL ROLE. It grants no
  // durable authority: the binding, and everything else the transaction
  // touched, is gone when it returns.
  const task8dProbePrincipalId = "8d000000-0000-4000-8000-000000000031";

  // Evaluates one statement under the real, unmodified retention policies as
  // dasher_retention_definer in one chosen operator context, and always rolls
  // back. Binding the owner's own SESSION_USER into the allowlist is what lets
  // the policies be evaluated at all, and it grants no durable authority: the
  // binding, and everything else the transaction touched, is gone on return.
  // Passing bindPrincipal: false evaluates the same statement with no principal
  // binding present, which is how the fail-closed direction is probed.
  async function task8dDefinerProbe<T extends object>(
    capability: string,
    sql: string,
    params: readonly unknown[] = [],
    options: { readonly bindPrincipal?: boolean } = {},
  ): Promise<readonly T[]> {
    const bindPrincipal = options.bindPrincipal ?? true;
    const client = await ownerPool.connect();
    let operationError: unknown;
    let rows: readonly T[] = [];
    try {
      await client.query("BEGIN");
      if (bindPrincipal) {
        await client.query(
          `INSERT INTO dasher.retention_service_principal_allowlist (
             retention_service_principal_id, principal_revision, binding_kind,
             binding_subject, authority_scope, scope_organization_id,
             can_initialize, can_materialize_expiry, can_place_hold,
             can_release_hold, can_claim_cleanup, can_record_attempt, can_purge,
             enabled, created_at, predecessor_revision, predecessor_sha256,
             revision_sha256, migration_provenance
           ) VALUES (
             $1::uuid, 1, 'postgres_session_user', SESSION_USER,
             'platform_operator', NULL,
             true, true, true, true, true, true, true, true,
             clock_timestamp(), NULL, NULL,
             pg_catalog.decode(pg_catalog.repeat('8e', 32), 'hex'),
             'task8d-select-policy-probe'
           )`,
          [task8dProbePrincipalId],
        );
      }
      await client.query("SET LOCAL ROLE dasher_retention_definer");
      await client.query(
        `SELECT
           pg_catalog.set_config('dasher.retention_phase', 'authorized', true),
           pg_catalog.set_config(
             'dasher.retention_principal_id', $1::text, true),
           pg_catalog.set_config(
             'dasher.retention_principal_revision', '1', true),
           pg_catalog.set_config(
             'dasher.retention_authority_scope', 'platform_operator', true),
           pg_catalog.set_config(
             'dasher.retention_capability', $2::text, true),
           pg_catalog.set_config(
             'dasher.retention_target_organization_id', $3::text, true),
           pg_catalog.set_config(
             'dasher.retention_target_dashboard_id', $4::text, true)`,
        [
          task8dProbePrincipalId,
          capability,
          task8dOrganizationId,
          expiryDashboardId,
        ],
      );
      const seen = await client.query<T>(sql, params as unknown[]);
      rows = seen.rows;
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        operationError ??= error;
      }
      client.release(
        operationError instanceof Error ? operationError : undefined,
      );
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    return rows;
  }

  async function task8dAttemptsVisibleUnderCapability(
    capability: string,
  ): Promise<string> {
    const seen = await task8dDefinerProbe<{ readonly visible: string }>(
      capability,
      `SELECT pg_catalog.count(*)::text AS visible
       FROM dasher.dashboard_cleanup_attempts`,
    );
    return seen[0]?.visible ?? "";
  }

  // Runs the frozen drain-proof recomputation as the role that owns it, under
  // one chosen capability, and reports both what it returned and what the two
  // relations its inner join spans made visible in that same context.
  interface Task8dRecomputedDrainProof {
    readonly audit_rows_visible: string;
    readonly matches_stored: boolean | null;
    readonly out_of_scope_rows_visible: string;
    readonly proof_rows_visible: string;
    readonly recomputed_is_null: boolean;
  }

  async function task8dRecomputedDrainProof(
    capability: string,
    options: { readonly bindPrincipal?: boolean } = {},
  ): Promise<Task8dRecomputedDrainProof> {
    const seen = await task8dDefinerProbe<Task8dRecomputedDrainProof>(
      capability,
      `WITH recomputed AS (
         SELECT dasher_private.recompute_drain_proof_v1($1::uuid, $2::uuid)
           AS digest
       )
       SELECT
         (SELECT digest IS NULL FROM recomputed) AS recomputed_is_null,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proofs) AS proof_rows_visible,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.audit_events) AS audit_rows_visible,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.audit_events AS audit
          WHERE audit.organization_id <> $1::uuid
            OR audit.target_type <> 'dashboard'
            OR audit.target_id <> $2::uuid) AS out_of_scope_rows_visible,
         (SELECT pg_catalog.bool_or(
            proof.drain_proof_sha256 = (SELECT digest FROM recomputed))
          FROM dasher.dashboard_agent_drain_proofs AS proof)
           AS matches_stored`,
      [task8dOrganizationId, expiryDashboardId],
      options,
    );
    const row = seen[0];
    if (row === undefined) {
      throw new Error(
        "Task 8D drain-proof recomputation probe returned no row",
      );
    }
    return row;
  }

  async function task8dDrainStep(
    expectedLifecycleRevision: number,
    step: "drain_and_cancel" | "prepare_finalizers" | "purge_finalizing",
    claimEventId: string,
    drainEventId: string,
    deploymentRevision: string,
  ): Promise<void> {
    await task8dReleaseCleanupLease();
    await callRetention(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
        $1::uuid, $2::bigint, NULL, interval '1 minute', $3::uuid,
        $4::text, $5::uuid)`,
      [
        expiryDashboardId,
        expectedLifecycleRevision,
        claimEventId,
        deploymentRevision,
        task8dOrganizationId,
      ],
    );
    const requestProof = await task8dDrainRequestProof(
      expectedLifecycleRevision,
      drainEventId,
      deploymentRevision,
    );
    await callRetention(
      `SELECT dasher_retention_api.drain_dashboard_agent_runs(
        $1::uuid, $2::bigint, $3::bytea, $4::uuid, $5::text, $6::uuid)`,
      [
        expiryDashboardId,
        expectedLifecycleRevision,
        requestProof,
        drainEventId,
        deploymentRevision,
        task8dOrganizationId,
      ],
    );
    const completionProof = await task8dCleanupCompletionProof(
      drainEventId,
      step,
      "succeeded",
      0,
      0,
      0,
    );
    await callRetention(
      `SELECT dasher_retention_api.record_dashboard_cleanup_attempt(
        $1::uuid, $2::uuid, $3::text, 'succeeded', 0, 0, 0,
        $4::bytea, $5::uuid)`,
      [
        expiryDashboardId,
        drainEventId,
        step,
        completionProof,
        task8dOrganizationId,
      ],
    );
  }

  async function setTask8dDashboardBoundary(
    column: "effective_expires_at" | "purge_after",
    boundary: "now" | "five_minutes_from_now",
  ): Promise<void> {
    const expression =
      boundary === "now"
        ? "statement_timestamp()"
        : "statement_timestamp() + interval '5 minutes'";
    const boundaryAssignment =
      column === "effective_expires_at"
        ? `created_at = ${expression} - interval '1 hour',
           original_expires_at = ${expression},
           effective_expires_at = ${expression}`
        : `access_revoked_at = ${expression} - interval '24 hours',
           purge_after = ${expression}`;
    const client = await ownerPool.connect();
    let operationError: unknown;
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE dasher.dashboards DISABLE TRIGGER dashboards_transition_guard",
      );
      await client.query(
        `UPDATE dasher.dashboards SET ${boundaryAssignment}
         WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
        [task8dOrganizationId, expiryDashboardId],
      );
      await client.query(
        "ALTER TABLE dasher.dashboards ENABLE TRIGGER dashboards_transition_guard",
      );
      await client.query("COMMIT");
    } catch (error) {
      operationError = error;
      await client.query("ROLLBACK");
    } finally {
      try {
        const trigger = await client.query<{ readonly enabled: string }>(`
          SELECT trigger.tgenabled AS enabled
          FROM pg_catalog.pg_trigger AS trigger
          WHERE trigger.tgrelid = 'dasher.dashboards'::regclass
            AND trigger.tgname = 'dashboards_transition_guard'
            AND NOT trigger.tgisinternal
        `);
        if (trigger.rows[0]?.enabled !== "O") {
          await client.query(
            "ALTER TABLE dasher.dashboards ENABLE TRIGGER dashboards_transition_guard",
          );
          throw new Error("Task 8D restored a disabled dashboard guard");
        }
      } catch (error) {
        operationError ??= error;
      }
      client.release(
        operationError instanceof Error ? operationError : undefined,
      );
    }
    if (operationError !== undefined) {
      throw operationError;
    }
  }

  beforeAll(async () => {
    await closeAppPoolBeforeLoginTeardown();
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }
    await resetManagedSchemas();
    await runMigrations(ownerPool, canonicalMigrationDirectory, []);
    await createTemporaryAppLogin(ownerPool, config.appDsn, config.appUsername);
    appLoginCreated = true;

    const retentionDsn = new URL(config.ownerDsn);
    retentionDsn.username = task8dRetentionUsername;
    await createTemporaryRetentionLogin(
      ownerPool,
      retentionDsn.toString(),
      task8dRetentionUsername,
    );
    retentionLoginCreated = true;
    await expect(
      runMigrations(
        ownerPool,
        canonicalMigrationDirectory,
        [config.appUsername],
        [task8dRetentionUsername],
      ),
    ).resolves.toEqual({
      appliedCount: 0,
      discoveredCount: 8,
      previouslyAppliedCount: 8,
    });
    appPool = new Pool({ connectionString: config.appDsn, max: 4 });
    retentionPool = new Pool({
      connectionString: retentionDsn.toString(),
      max: 2,
    });

    await ownerPool.query(
      `
        INSERT INTO dasher.organizations (organization_id, display_name)
        VALUES ($1::uuid, 'Task 8D authoritative lifecycle organization')
      `,
      [task8dOrganizationId],
    );
    const client = await appPool.connect();
    try {
      await client.query("SET ROLE dasher_app");
      await issueFixedActor(
        client,
        admin,
        "admin",
        "8d000000-0000-4000-8000-000000000013",
        "8d000000-0000-4000-8000-000000000014",
      );
      await issueFixedActor(
        client,
        editor,
        "editor",
        "8d000000-0000-4000-8000-000000000023",
        "8d000000-0000-4000-8000-000000000024",
      );
      await client.query("RESET ROLE");
    } finally {
      client.release();
    }
    await ownerPool.query(
      `
        INSERT INTO dasher.retention_service_principal_allowlist (
          retention_service_principal_id, principal_revision, binding_kind,
          binding_subject, authority_scope, scope_organization_id,
          can_initialize, can_materialize_expiry, can_place_hold,
          can_release_hold, can_claim_cleanup, can_record_attempt, can_purge,
          enabled, created_at, predecessor_revision, predecessor_sha256,
          revision_sha256, migration_provenance
        ) VALUES (
          '8d000000-0000-4000-8000-000000000030'::uuid, 1,
          'postgres_session_user', $1::name, 'platform_operator', NULL,
          true, true, true, true, true, true, true, true,
          clock_timestamp(), NULL, NULL,
          pg_catalog.decode(pg_catalog.repeat('8d', 32), 'hex'),
          'task8d-production-operator-fixture'
        )
      `,
      [task8dRetentionUsername],
    );
  }, 120_000);

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      const journal = await ownerPool.query<{
        readonly checksum: string;
        readonly filename: string;
      }>(`
        SELECT filename, pg_catalog.encode(checksum_sha256, 'hex') AS checksum
        FROM dasher_meta.schema_migrations
        ORDER BY filename
      `);
      expect(journal.rows.map((row) => row.filename)).toEqual([
        "0001_identity_audit.sql",
        "0002_security_boundary.sql",
        "0003_immutable_content.sql",
        "0004_lifecycle_api_correction.sql",
        "0005_security_definer_cleanup_coordination.sql",
        "0006_lifecycle_access_retention_guard_correction.sql",
        "0007_agent_run_ledger_and_calculations.sql",
        "0008_retention_lock_authority_correction.sql",
      ]);
      expect(journal.rows[4]?.checksum).toBe(
        "f9e33e7a4033d77c1e56f098de68a519f2cfe434119c3bf5ffe13b8a3f9713e7",
      );
      expect(journal.rows[5]?.checksum).toBe(
        "26a6075696c5aba6562a87f63564860e49b22cdbc1c8015335e19006044bd499",
      );
      expect(journal.rows[6]?.checksum).toBe(
        "dfe0ca8eef30b9b5a599657eaf0da6c93a330a90d3fa9b01c75a2f730d8db3d5",
      );
      expect(journal.rows[7]?.checksum).toBe(
        "9c3e2776e6cb92e1ef37b7f1cf66a76e8fbabe161af0d4bd4cbdc07bca61de9c",
      );
      const owner = await ownerPool.connect();
      try {
        const ownerName = (
          await owner.query<{ readonly owner_name: string }>(
            "SELECT session_user::text AS owner_name",
          )
        ).rows[0]?.owner_name;
        if (ownerName === undefined) {
          throw new Error("Task 8D could not resolve the database owner");
        }
        expect(
          await canonical0008CatalogMatchesForTests(
            owner,
            ownerName,
            [config.appUsername],
            [task8dRetentionUsername],
          ),
        ).toBe(true);
      } finally {
        owner.release();
      }
    } catch (error) {
      cleanupError = error;
    }

    try {
      if (retentionPool !== undefined) {
        const pool = retentionPool;
        retentionPool = undefined;
        await pool.end();
      }
      if (retentionLoginCreated) {
        await dropTemporaryRetentionLogin(
          ownerPool,
          config.ownerDatabase,
          task8dRetentionUsername,
        );
        retentionLoginCreated = false;
      }
      await closeAppPoolBeforeLoginTeardown();
      if (appLoginCreated) {
        await dropTemporaryAppLogin(
          ownerPool,
          config.appDatabase,
          config.appUsername,
        );
        appLoginCreated = false;
      }
      await resetManagedSchemas();
      const residue = await ownerPool.query<{
        readonly backend_count: string;
        readonly prepared_count: string;
        readonly role_count: string;
        readonly task8d_schema_count: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text
             FROM pg_catalog.pg_stat_activity
             WHERE usename = $1) AS backend_count,
            (SELECT pg_catalog.count(*)::text
             FROM pg_catalog.pg_prepared_xacts
             WHERE gid LIKE 'task8d%') AS prepared_count,
            (SELECT pg_catalog.count(*)::text
             FROM pg_catalog.pg_roles
             WHERE rolname = $1) AS role_count,
            (SELECT pg_catalog.count(*)::text
             FROM pg_catalog.pg_namespace
             WHERE nspname LIKE 'task8d%') AS task8d_schema_count
        `,
        [task8dRetentionUsername],
      );
      expect(residue.rows[0]).toEqual({
        backend_count: "0",
        prepared_count: "0",
        role_count: "0",
        task8d_schema_count: "0",
      });
      expect(await schemaPresence()).toEqual({
        dasher: false,
        dasherMeta: false,
      });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, 120_000);

  it.each(["ROLLBACK", "RESET ROLE"] as const)(
    "rejects a successful definer operation when %s cleanup fails and destroys all client state",
    async (failedCleanupCommand) => {
      const cleanupError = new Error(
        `synthetic ${failedCleanupCommand.toLowerCase()} cleanup failure`,
      );
      const queryTexts: string[] = [];
      const releaseArguments: (Error | boolean | undefined)[] = [];
      let transactionOpen = false;
      let roleActive = false;
      let released = false;
      const client = {
        async query(text: string) {
          queryTexts.push(text);
          if (text === "BEGIN") transactionOpen = true;
          if (text === "SET ROLE dasher_retention_definer") roleActive = true;
          if (text === failedCleanupCommand) throw cleanupError;
          if (text === "ROLLBACK") transactionOpen = false;
          if (text === "RESET ROLE") roleActive = false;
          return { rows: [] };
        },
        release(error?: Error | boolean) {
          releaseArguments.push(error);
          released = true;
          if (error !== undefined) {
            transactionOpen = false;
            roleActive = false;
          }
        },
      } as unknown as PoolClient;

      let failure: unknown;
      try {
        await withTask8dDefinerContext(
          async () => client,
          async (connected) => {
            await connected.query("BEGIN");
            await connected.query("SET ROLE dasher_retention_definer");
          },
          async () => "successful operation",
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBe(cleanupError);
      expect(queryTexts.slice(-2)).toEqual(["ROLLBACK", "RESET ROLE"]);
      expect(releaseArguments).toEqual([cleanupError]);
      expect(released).toBe(true);
      expect(transactionOpen).toBe(false);
      expect(roleActive).toBe(false);
      const diagnostic = `${String(failure)}\n${
        failure instanceof Error ? (failure.stack ?? "") : ""
      }`;
      expect(diagnostic).not.toContain("postgres://");
      expect(diagnostic).not.toContain("password");
    },
  );

  it("surfaces both cleanup and release failures after a successful definer operation", async () => {
    const cleanupError = new Error("synthetic rollback cleanup failure");
    const releaseError = new Error("synthetic client release failure");
    const client = {
      async query(text: string) {
        if (text === "ROLLBACK") throw cleanupError;
        return { rows: [] };
      },
      release(error?: Error | boolean) {
        expect(error).toBe(cleanupError);
        throw releaseError;
      },
    } as unknown as PoolClient;

    let failure: unknown;
    try {
      await withTask8dDefinerContext(
        async () => client,
        async (connected) => {
          await connected.query("BEGIN");
          await connected.query("SET ROLE dasher_retention_definer");
        },
        async () => "successful operation",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      cleanupError,
      releaseError,
    ]);
    const diagnostic = `${String(failure)}\n${
      failure instanceof Error ? (failure.stack ?? "") : ""
    }`;
    expect(diagnostic).not.toContain("postgres://");
    expect(diagnostic).not.toContain("password");
  });

  it("serializes the first policy seed exactly once and enforces only the four TTL presets", async () => {
    const first = await appPool!.connect();
    const second = await appPool!.connect();
    try {
      await first.query("SET ROLE dasher_app");
      await second.query("SET ROLE dasher_app");
      const firstCreation = settleDatabasePromise(
        createFixedDashboard(first, admin, {
          auditEventId: "8d000000-0000-4000-8000-00000000a101",
          dashboardId: expiryDashboardId,
          requestId: "8d000000-0000-4000-8000-00000000a102",
          tombstoneLineageId: "8d000000-0000-4000-8000-00000000a103",
          ttlSeconds: 3_600,
          useOrganizationDefault: false,
        }),
      );
      const secondCreation = settleDatabasePromise(
        createFixedDashboard(second, editor, {
          auditEventId: "8d000000-0000-4000-8000-00000000a111",
          dashboardId: "8d000000-0000-4000-8000-00000000d111",
          requestId: "8d000000-0000-4000-8000-00000000a112",
          tombstoneLineageId: "8d000000-0000-4000-8000-00000000a113",
          ttlSeconds: 86_400,
          useOrganizationDefault: false,
        }),
      );
      const creations = await Promise.all([firstCreation, secondCreation]);
      expect(creations.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      const creationRows = creations.map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value.rows[0]!;
      });
      expect(
        creationRows.filter((row) => row.lifecycle_policy_seeded),
      ).toHaveLength(1);
      expect(creationRows.map((row) => row.lifecycle_policy_revision)).toEqual([
        "1",
        "1",
      ]);

      for (const [ordinal, ttlSeconds] of [604_800, 2_592_000].entries()) {
        const suffix = ordinal === 0 ? "121" : "131";
        const created = await createFixedDashboard(first, admin, {
          auditEventId: `8d000000-0000-4000-8000-00000000a${suffix}`,
          dashboardId: `8d000000-0000-4000-8000-00000000d${suffix}`,
          requestId: `8d000000-0000-4000-8000-00000000b${suffix}`,
          tombstoneLineageId: `8d000000-0000-4000-8000-00000000c${suffix}`,
          ttlSeconds,
          useOrganizationDefault: false,
        });
        expect(created.rows[0]?.effective_ttl_seconds).toBe(ttlSeconds);
        expect(created.rows[0]?.used_organization_default).toBe(false);
      }

      for (const [ordinal, ttlSeconds] of [3_599, 7_200, 2_592_001].entries()) {
        const suffix = 140 + ordinal;
        await expectDasherBoundaryError(
          createFixedDashboard(first, admin, {
            auditEventId: `8d000000-0000-4000-8000-00000000a${suffix}`,
            dashboardId: `8d000000-0000-4000-8000-00000000d${suffix}`,
            requestId: `8d000000-0000-4000-8000-00000000b${suffix}`,
            tombstoneLineageId: `8d000000-0000-4000-8000-00000000c${suffix}`,
            ttlSeconds,
            useOrganizationDefault: false,
          }),
          "P1001",
          "dasher_denied",
        );
      }

      await ownerPool.query(
        `
          INSERT INTO dasher.dashboard_lifecycle_policies (
            organization_id, policy_revision,
            default_disposable_ttl_seconds, retention_policy_revision,
            created_at, created_by_user_id, provenance
          ) VALUES ($1::uuid, 2, 604800, 2, clock_timestamp(), $2::uuid,
            'task8d-latest-policy')
        `,
        [task8dOrganizationId, admin.userId],
      );
      const defaulted = await createFixedDashboard(second, editor, {
        auditEventId: "8d000000-0000-4000-8000-00000000a151",
        dashboardId: "8d000000-0000-4000-8000-00000000d151",
        requestId: "8d000000-0000-4000-8000-00000000b151",
        tombstoneLineageId: "8d000000-0000-4000-8000-00000000c151",
        ttlSeconds: null,
        useOrganizationDefault: true,
      });
      expect(defaulted.rows[0]).toMatchObject({
        default_disposable_ttl_seconds: 604_800,
        effective_ttl_seconds: 604_800,
        lifecycle_policy_revision: "2",
        lifecycle_policy_seeded: false,
        retention_policy_revision: "2",
        used_organization_default: true,
      });
      await expectPostgresDenial(
        first,
        "UPDATE dasher.dashboard_lifecycle_policies SET policy_revision = policy_revision",
      );

      const facts = await ownerPool.query<{
        readonly audit_count: string;
        readonly canonical_claims_present: boolean;
        readonly dashboard_count: string;
        readonly event_count: string;
        readonly policy_count: string;
        readonly publication_exports: string;
      }>(
        `
          SELECT
            (SELECT pg_catalog.count(*)::text
             FROM dasher.dashboard_lifecycle_policies
             WHERE organization_id = $1::uuid) AS policy_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.dashboards
             WHERE organization_id = $1::uuid) AS dashboard_count,
            (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
             WHERE organization_id = $1::uuid
               AND action = 'dashboard.created') AS audit_count,
            (SELECT pg_catalog.count(*)::text
             FROM dasher.dashboard_lifecycle_events
             WHERE organization_id = $1::uuid) AS event_count,
            (SELECT pg_catalog.count(*)::text
             FROM pg_catalog.unnest(ARRAY[
               'dasher.publications',
               'dasher.decision_snapshots', 'dasher.recipes',
               'dasher.alerts', 'dasher.schedules'
             ]) AS absent(identity)
             WHERE pg_catalog.to_regclass(absent.identity) IS NOT NULL
            ) AS publication_exports,
            -- dasher.claims stopped being a speculative export surface once the
            -- frozen 0007 ledger introduced it, so assert it positively instead
            -- of counting it as unexpected drift.
            pg_catalog.to_regclass('dasher.claims') IS NOT NULL
              AS canonical_claims_present
        `,
        [task8dOrganizationId],
      );
      expect(facts.rows[0]).toEqual({
        audit_count: "5",
        canonical_claims_present: true,
        dashboard_count: "5",
        event_count: "0",
        policy_count: "2",
        publication_exports: "0",
      });
    } finally {
      await first.query("RESET ROLE");
      await second.query("RESET ROLE");
      first.release();
      second.release();
    }
  }, 120_000);

  it("keeps pre-expiry projections visible, then denies five user projections and admin status, omits lists, and blocks raw tables at inclusive expiry", async () => {
    const client = await appPool!.connect();
    try {
      await ownerPool.query(
        `
          INSERT INTO dasher.source_snapshots (
            organization_id, snapshot_id, source_kind, canonical_bytes,
            content_sha256, observed_at, retrieved_at, created_at
          ) VALUES ($1::uuid, $2::uuid, 'synthetic_fixture',
            pg_catalog.convert_to('task8d-expiry', 'UTF8'),
            pg_catalog.sha256(pg_catalog.convert_to('task8d-expiry', 'UTF8')),
            clock_timestamp(), clock_timestamp(), clock_timestamp())
        `,
        [task8dOrganizationId, expirySnapshotId],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.dashboard_versions (
            organization_id, dashboard_id, version_id, parent_version_id,
            canonical_spec_bytes, canonical_spec_sha256, validation_state,
            validation_sha256, planner_provenance_sha256, policy_revision,
            registry_revision, calculation_graph_sha256, created_by_user_id,
            created_at
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, NULL,
            pg_catalog.convert_to('{}', 'UTF8'),
            pg_catalog.sha256(pg_catalog.convert_to('{}', 'UTF8')),
            'validated', pg_catalog.decode(pg_catalog.repeat('11', 32), 'hex'),
            pg_catalog.decode(pg_catalog.repeat('12', 32), 'hex'), 2, 1, NULL,
            $4::uuid, clock_timestamp())
        `,
        [
          task8dOrganizationId,
          expiryDashboardId,
          expiryVersionId,
          admin.userId,
        ],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.dashboard_version_snapshots
            (organization_id, dashboard_id, version_id, snapshot_id)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        `,
        [
          task8dOrganizationId,
          expiryDashboardId,
          expiryVersionId,
          expirySnapshotId,
        ],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.snapshot_reference_claims (
            organization_id, snapshot_id, reference_claim_id, dashboard_id,
            version_id, claim_kind, hold_id, created_at
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $3::uuid,
            'access_bearing', NULL, clock_timestamp())
        `,
        [
          task8dOrganizationId,
          expirySnapshotId,
          expiryVersionId,
          expiryDashboardId,
        ],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.evidence_records (
            organization_id, evidence_id, snapshot_id, evidence_kind,
            coordinates, transformation, content_sha256, observed_at,
            retrieved_at, created_at
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'typed_value',
            'task8d:expiry', 'identity',
            pg_catalog.decode(pg_catalog.repeat('13', 32), 'hex'),
            clock_timestamp(), clock_timestamp(), clock_timestamp())
        `,
        [task8dOrganizationId, expiryEvidenceId, expirySnapshotId],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.dashboard_version_evidence
            (organization_id, dashboard_id, version_id, evidence_id)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        `,
        [
          task8dOrganizationId,
          expiryDashboardId,
          expiryVersionId,
          expiryEvidenceId,
        ],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.evidence_reference_claims (
            organization_id, evidence_id, reference_claim_id, dashboard_id,
            version_id, claim_kind, hold_id, created_at
          ) VALUES ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4::uuid,
            'access_bearing', NULL, clock_timestamp())
        `,
        [
          task8dOrganizationId,
          expiryEvidenceId,
          expiryDashboardId,
          expiryVersionId,
        ],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.dashboard_artifacts (
            organization_id, artifact_id, dashboard_id, version_id,
            ownership_class, artifact_kind, metadata_sha256,
            content_sha256, created_at
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
            'dashboard_owned', 'task8d_fixture',
            pg_catalog.decode(pg_catalog.repeat('14', 32), 'hex'),
            pg_catalog.decode(pg_catalog.repeat('15', 32), 'hex'),
            clock_timestamp())
        `,
        [
          task8dOrganizationId,
          expiryArtifactId,
          expiryDashboardId,
          expiryVersionId,
        ],
      );
      await ownerPool.query(
        `
          INSERT INTO dasher.artifact_reference_claims (
            organization_id, artifact_id, reference_claim_id, dashboard_id,
            version_id, claim_kind, hold_id, created_at
          ) VALUES ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4::uuid,
            'access_bearing', NULL, clock_timestamp())
        `,
        [
          task8dOrganizationId,
          expiryArtifactId,
          expiryDashboardId,
          expiryVersionId,
        ],
      );
      await setTask8dDashboardBoundary(
        "effective_expires_at",
        "five_minutes_from_now",
      );
      await client.query("SET ROLE dasher_app");
      await runContextOperation(
        client,
        admin.sessionDigest,
        "8d000000-0000-4000-8000-00000000e100",
        () =>
          client.query(
            `SELECT dasher_api.compare_and_swap_dashboard_head(
              $1::uuid, NULL, $2::uuid, 0, $3::uuid, 1::smallint,
              $4::bytea, 'task8d-lifecycle-gate')`,
            [
              expiryDashboardId,
              expiryVersionId,
              "8d000000-0000-4000-8000-00000000e101",
              admin.csrfDigest,
            ],
          ),
      );
      for (const [sql, parameters] of [
        [
          "SELECT * FROM dasher_api.get_dashboard_summary($1::uuid)",
          [expiryDashboardId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_head($1::uuid)",
          [expiryDashboardId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_version($1::uuid, $2::uuid)",
          [expiryDashboardId, expiryVersionId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_evidence($1::uuid, $2::uuid)",
          [expiryDashboardId, expiryVersionId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_lineage($1::uuid, $2::uuid)",
          [expiryDashboardId, expiryVersionId],
        ],
      ] as const) {
        const visible = await runContextOperation(
          client,
          admin.sessionDigest,
          "8d000000-0000-4000-8000-00000000e102",
          () => client.query(sql, [...parameters]),
        );
        expect(visible.rows.length).toBeGreaterThan(0);
      }

      await setTask8dDashboardBoundary("effective_expires_at", "now");
      for (const [sql, parameters] of [
        [
          "SELECT * FROM dasher_api.get_dashboard_summary($1::uuid)",
          [expiryDashboardId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_head($1::uuid)",
          [expiryDashboardId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_version($1::uuid, $2::uuid)",
          [expiryDashboardId, expiryVersionId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_evidence($1::uuid, $2::uuid)",
          [expiryDashboardId, expiryVersionId],
        ],
        [
          "SELECT * FROM dasher_api.get_dashboard_lineage($1::uuid, $2::uuid)",
          [expiryDashboardId, expiryVersionId],
        ],
      ] as const) {
        await expectDasherBoundaryError(
          runContextOperation(
            client,
            admin.sessionDigest,
            "8d000000-0000-4000-8000-00000000e103",
            () => client.query(sql, [...parameters]),
          ),
          "P1001",
          "dasher_denied",
        );
      }
      const listed = await runContextOperation(
        client,
        admin.sessionDigest,
        "8d000000-0000-4000-8000-00000000e104",
        () => client.query("SELECT * FROM dasher_api.list_dashboards(100)"),
      );
      expect(
        listed.rows.some((row) => row.dashboard_id === expiryDashboardId),
      ).toBe(false);
      for (const table of [
        "dashboard_versions",
        "dashboard_version_snapshots",
        "dashboard_version_evidence",
        "evidence_records",
        "source_snapshots",
      ] as const) {
        await expectPostgresDenial(
          client,
          `SELECT count(*) FROM dasher.${table}`,
        );
      }
      const expiredDashboardAdminStatus = runContextOperation(
        client,
        admin.sessionDigest,
        "8d000000-0000-4000-8000-00000000e105",
        () =>
          client.query(
            "SELECT * FROM dasher_api.get_dashboard_admin_status($1::uuid)",
            [expiryDashboardId],
          ),
      );
      await expectDasherBoundaryError(
        expiredDashboardAdminStatus,
        "P1001",
        "dasher_denied",
      );
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  }, 120_000);

  it("adds only non-grantable retention-definer head update authority and keeps direct mutation closed", async () => {
    const privilege = await ownerPool.query<{
      readonly app_head_update: boolean;
      readonly grantable: boolean;
      readonly public_head_update: boolean;
      readonly retention_dashboard_columns: string[];
      readonly retention_head_update: boolean;
      readonly retention_table_update: boolean;
      readonly operator_head_update: boolean;
    }>(`
      SELECT
        pg_catalog.has_column_privilege(
          'dasher_retention_definer', 'dasher.dashboards',
          'head_version_id', 'UPDATE'
        ) AS retention_head_update,
        pg_catalog.has_table_privilege(
          'dasher_retention_definer', 'dasher.dashboards', 'UPDATE'
        ) AS retention_table_update,
        pg_catalog.has_column_privilege(
          'dasher_retention_operator', 'dasher.dashboards',
          'head_version_id', 'UPDATE'
        ) AS operator_head_update,
        pg_catalog.has_column_privilege(
          'dasher_app', 'dasher.dashboards', 'head_version_id', 'UPDATE'
        ) AS app_head_update,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
          WHERE relation.oid = 'dasher.dashboards'::regclass
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'UPDATE'
          UNION ALL
          SELECT 1
          FROM pg_catalog.pg_attribute AS public_attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(public_attribute.attacl)
            AS privilege
          WHERE public_attribute.attrelid = 'dasher.dashboards'::regclass
            AND public_attribute.attname = 'head_version_id'
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'UPDATE'
        ) AS public_head_update,
        (
          SELECT privilege.is_grantable
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          WHERE attribute.attrelid = 'dasher.dashboards'::regclass
            AND attribute.attname = 'head_version_id'
            AND grantee.rolname = 'dasher_retention_definer'
            AND privilege.privilege_type = 'UPDATE'
        ) AS grantable,
        ARRAY(
          SELECT attribute.attname::text
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          WHERE attribute.attrelid = 'dasher.dashboards'::regclass
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
            AND grantee.rolname = 'dasher_retention_definer'
            AND privilege.privilege_type = 'UPDATE'
          ORDER BY attribute.attname
        ) AS retention_dashboard_columns
    `);
    expect(privilege.rows[0]).toEqual({
      app_head_update: false,
      grantable: false,
      operator_head_update: false,
      public_head_update: false,
      retention_dashboard_columns: [
        "access_revoked_at",
        "cache_epoch",
        "capability_epoch",
        "head_version_id",
        "lifecycle_revision",
        "lifecycle_state",
        "purge_after",
        "purge_started_at",
        "purged_at",
        "revocation_reason",
      ],
      retention_head_update: true,
      retention_table_update: false,
    });

    const membership = await ownerPool.query<{ readonly path_count: string }>(
      `
        WITH RECURSIVE membership_path(role_id) AS (
          SELECT role.oid
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = ANY($1::text[])
          UNION
          SELECT membership.roleid
          FROM membership_path AS path
          JOIN pg_catalog.pg_auth_members AS membership
            ON membership.member = path.role_id
        )
        SELECT pg_catalog.count(*)::text AS path_count
        FROM membership_path AS path
        JOIN pg_catalog.pg_roles AS role ON role.oid = path.role_id
        WHERE role.rolname = 'dasher_retention_definer'
      `,
      [["dasher_retention_operator", task8dRetentionUsername]],
    );
    expect(membership.rows[0]?.path_count).toBe("0");

    const restricted = await retentionPool!.connect();
    try {
      await expectPostgresDenial(
        restricted,
        "SET ROLE dasher_retention_definer",
      );
      await restricted.query("SET ROLE dasher_retention_operator");
      await restricted.query("BEGIN");
      await restricted.query(
        "SELECT pg_catalog.set_config('dasher.retention_phase', 'authorized', true)",
      );
      await restricted.query(
        "SELECT pg_catalog.set_config('dasher.retention_capability', 'purge', true)",
      );
      await restricted.query(
        "SELECT pg_catalog.set_config('dasher.retention_target_organization_id', $1, true)",
        [task8dOrganizationId],
      );
      await restricted.query(
        "SELECT pg_catalog.set_config('dasher.retention_target_dashboard_id', $1, true)",
        [expiryDashboardId],
      );
      await expectPostgresDenial(
        restricted,
        `UPDATE dasher.dashboards SET head_version_id = NULL
         WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
        [task8dOrganizationId, expiryDashboardId],
      );
      await restricted.query("ROLLBACK");
    } finally {
      await restricted.query("ROLLBACK");
      await restricted.query("RESET ROLE");
      restricted.release();
    }

    const app = await appPool!.connect();
    try {
      await app.query("SET ROLE dasher_app");
      await expectPostgresDenial(
        app,
        `UPDATE dasher.dashboards SET head_version_id = NULL
         WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
        [task8dOrganizationId, expiryDashboardId],
      );
    } finally {
      await app.query("RESET ROLE");
      app.release();
    }

    const managedDefiner = await ownerPool.connect();
    try {
      await managedDefiner.query("SET ROLE dasher_retention_definer");
      const direct = await managedDefiner.query(
        `UPDATE dasher.dashboards SET head_version_id = NULL
         WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid
         RETURNING dashboard_id`,
        [task8dOrganizationId, expiryDashboardId],
      );
      expect(direct.rowCount).toBe(0);
    } finally {
      await managedDefiner.query("RESET ROLE");
      managedDefiner.release();
    }
    const preserved = await ownerPool.query<{
      readonly head_version_id: string;
      readonly purge_started_at: null;
    }>(
      `SELECT head_version_id::text AS head_version_id, purge_started_at
       FROM dasher.dashboards
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(preserved.rows[0]).toEqual({
      head_version_id: expiryVersionId,
      purge_started_at: null,
    });
  }, 120_000);

  it("materializes one exact expiry revocation idempotently and rejects invalid operator context", async () => {
    await callRetention(
      `SELECT dasher_retention_api.materialize_dashboard_expiry(
        $1::uuid, 1, $2::uuid, 'task8d-expiry', $3::uuid)`,
      [
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000e110",
        task8dOrganizationId,
      ],
    );
    await callRetention(
      `SELECT dasher_retention_api.materialize_dashboard_expiry(
        $1::uuid, 1, $2::uuid, 'task8d-expiry-retry', $3::uuid)`,
      [
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000e111",
        task8dOrganizationId,
      ],
    );
    const materialized = await ownerPool.query(
      `
        SELECT
          dashboard.lifecycle_state, dashboard.lifecycle_revision::text,
          dashboard.capability_epoch::text, dashboard.cache_epoch::text,
          dashboard.revocation_reason,
          dashboard.access_revoked_at IS NOT NULL AS access_revoked,
          dashboard.purge_after = dashboard.access_revoked_at + interval '24 hours'
            AS exact_purge_after,
          (SELECT pg_catalog.count(*)::text FROM dasher.dashboard_tombstones
           WHERE organization_id = dashboard.organization_id
             AND tombstone_lineage_id = dashboard.tombstone_lineage_id)
            AS tombstone_count,
          (SELECT pg_catalog.count(*)::text
           FROM dasher.dashboard_cleanup_coordination
           WHERE organization_id = dashboard.organization_id
             AND dashboard_id = dashboard.dashboard_id
             AND current_step = 'access_revoked'
             AND expected_lifecycle_revision = 2) AS cleanup_count,
          (SELECT pg_catalog.count(*)::text
           FROM dasher.dashboard_lifecycle_events
           WHERE lifecycle_event_id IN ($3::uuid, $4::uuid)) AS event_count,
          (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
           WHERE audit_event_id IN ($3::uuid, $4::uuid)) AS audit_count,
          (SELECT pg_catalog.array_agg(event_kind ORDER BY ledger_sequence)
           FROM dasher.backup_deletion_ledger
           WHERE organization_id = dashboard.organization_id
             AND tombstone_lineage_id = dashboard.tombstone_lineage_id)
            AS ledger_events
        FROM dasher.dashboards AS dashboard
        WHERE dashboard.organization_id = $1::uuid
          AND dashboard.dashboard_id = $2::uuid
      `,
      [
        task8dOrganizationId,
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000e110",
        "8d000000-0000-4000-8000-00000000e111",
      ],
    );
    expect(materialized.rows[0]).toMatchObject({
      access_revoked: true,
      audit_count: "1",
      cache_epoch: "1",
      capability_epoch: "1",
      cleanup_count: "1",
      event_count: "1",
      exact_purge_after: true,
      ledger_events: ["access_revoked"],
      lifecycle_revision: "2",
      lifecycle_state: "access_revoked",
      revocation_reason: "expired",
      tombstone_count: "1",
    });

    await ownerPool.query(
      `
        INSERT INTO dasher.dashboard_restore_lineage (
          organization_id, dashboard_id, version_id,
          source_tombstone_lineage_id, source_version_id,
          retention_policy_revision, actor_user_id, authority_revision,
          occurred_at, provenance_sha256
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $3::uuid,
          2, $5::uuid, 1, clock_timestamp(),
          pg_catalog.decode(pg_catalog.repeat('16', 32), 'hex'))
      `,
      [
        task8dOrganizationId,
        expiryDashboardId,
        expiryVersionId,
        "8d000000-0000-4000-8000-00000000a103",
        admin.userId,
      ],
    );

    const restricted = await retentionPool!.connect();
    try {
      await restricted.query("SET ROLE dasher_retention_operator");
      await restricted.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expectDasherBoundaryError(
        restricted.query(
          `SELECT dasher_retention_api.materialize_dashboard_expiry(
            $1::uuid, 2, $2::uuid, 'task8d-isolation', $3::uuid)`,
          [
            expiryDashboardId,
            "8d000000-0000-4000-8000-00000000e120",
            task8dOrganizationId,
          ],
        ),
        "P1001",
        "dasher_denied",
      );
      await restricted.query("ROLLBACK");
      await restricted.query("BEGIN");
      await restricted.query(
        "SELECT pg_catalog.set_config('dasher.retention_phase', 'forged', true)",
      );
      await expectDasherBoundaryError(
        restricted.query(
          `SELECT dasher_retention_api.materialize_dashboard_expiry(
            $1::uuid, 2, $2::uuid, 'task8d-reserved', $3::uuid)`,
          [
            expiryDashboardId,
            "8d000000-0000-4000-8000-00000000e121",
            task8dOrganizationId,
          ],
        ),
        "P1001",
        "dasher_denied",
      );
      await restricted.query("ROLLBACK");
    } finally {
      await restricted.query("ROLLBACK");
      await restricted.query("RESET ROLE");
      restricted.release();
    }
  }, 120_000);

  it("keeps corrected forced-RLS source and evidence finalizer visibility resource-exact and fail-closed", async () => {
    const organizationB = "8d000000-0000-4000-8000-000000000002";
    const targetDashboard = "8d000000-0000-4000-8000-00000000d201";
    const otherDashboard = "8d000000-0000-4000-8000-00000000d202";
    const organizationBDashboard = "8d000000-0000-4000-8000-00000000d203";
    const targetVersion = "8d000000-0000-4000-8000-00000000d211";
    const otherVersion = "8d000000-0000-4000-8000-00000000d212";
    const snapshots = Array.from(
      { length: 9 },
      (_, index) =>
        `8d000000-0000-4000-8000-${(0xd221 + index)
          .toString(16)
          .padStart(12, "0")}`,
    );
    const evidence = Array.from(
      { length: 9 },
      (_, index) =>
        `8d000000-0000-4000-8000-${(0xd231 + index)
          .toString(16)
          .padStart(12, "0")}`,
    );
    const validPrincipal = "8d000000-0000-4000-8000-00000000da01";
    const stalePrincipal = "8d000000-0000-4000-8000-00000000da02";
    const ownerIdentity = await ownerPool.query<{
      readonly owner_name: string;
    }>("SELECT session_user::text AS owner_name");
    const ownerName = ownerIdentity.rows[0]?.owner_name;
    if (ownerName === undefined) {
      throw new Error("Task 8D adversarial probe could not resolve its owner");
    }

    await ownerPool.query(
      `INSERT INTO dasher.organizations (organization_id, display_name)
       VALUES ($1::uuid, 'Task 8D adversarial sibling organization')`,
      [organizationB],
    );
    await ownerPool.query(
      `INSERT INTO dasher.dashboards (
         organization_id, dashboard_id, title, created_by_user_id, created_at,
         created_kind, current_kind, original_expires_at,
         effective_expires_at, lifecycle_state, lifecycle_revision,
         capability_epoch, cache_epoch, access_revoked_at, revocation_reason,
         purge_after, purge_started_at, purged_at, retention_policy_revision,
         promoted_at, archived_at, head_version_id, tombstone_lineage_id,
         restored_from_tombstone_lineage_id
       )
       SELECT fixture.organization_id, fixture.dashboard_id,
         'Task 8D forced-RLS adversarial dashboard', $4::uuid,
         statement_timestamp() - interval '2 days',
         'disposable', 'disposable',
         statement_timestamp() - interval '47 hours',
         statement_timestamp() - interval '47 hours',
         'purge_eligible', 40, 2, 2,
         statement_timestamp() - interval '30 hours', 'expired',
         statement_timestamp() - interval '6 hours',
         statement_timestamp() - interval '1 hour', NULL, 2,
         NULL, NULL, NULL, fixture.tombstone_lineage_id, NULL
       FROM (VALUES
         ($1::uuid, $2::uuid,
          '8d000000-0000-4000-8000-00000000db01'::uuid),
         ($1::uuid, $3::uuid,
          '8d000000-0000-4000-8000-00000000db02'::uuid),
         ($5::uuid, $6::uuid,
          '8d000000-0000-4000-8000-00000000db03'::uuid)
       ) AS fixture(organization_id, dashboard_id, tombstone_lineage_id)`,
      [
        task8dOrganizationId,
        targetDashboard,
        otherDashboard,
        admin.userId,
        organizationB,
        organizationBDashboard,
      ],
    );
    await ownerPool.query(
      `INSERT INTO dasher.dashboard_cleanup_coordination (
         organization_id, dashboard_id, current_step, lease_owner,
         lease_expires_at, expected_lifecycle_revision, next_attempt_at,
         completion_proof_sha256
       ) VALUES
         ($1::uuid, $2::uuid, 'purge_finalizing', NULL, NULL, 40,
          statement_timestamp(),
          pg_catalog.sha256(pg_catalog.convert_to('task8d-target-proof', 'UTF8'))),
         ($1::uuid, $3::uuid, 'purge_finalizing', NULL, NULL, 40,
          statement_timestamp(),
          pg_catalog.sha256(pg_catalog.convert_to('task8d-other-proof', 'UTF8'))),
         ($4::uuid, $5::uuid, 'purge_finalizing', NULL, NULL, 40,
          statement_timestamp(),
          pg_catalog.sha256(pg_catalog.convert_to('task8d-org-b-proof', 'UTF8')))`,
      [
        task8dOrganizationId,
        targetDashboard,
        otherDashboard,
        organizationB,
        organizationBDashboard,
      ],
    );
    await ownerPool.query(
      `INSERT INTO dasher.dashboard_versions (
         organization_id, dashboard_id, version_id, parent_version_id,
         canonical_spec_bytes, canonical_spec_sha256, validation_state,
         validation_sha256, planner_provenance_sha256, policy_revision,
         registry_revision, calculation_graph_sha256, created_by_user_id,
         created_at
       ) SELECT $1::uuid, fixture.dashboard_id, fixture.version_id, NULL,
           pg_catalog.convert_to('{}', 'UTF8'),
           pg_catalog.sha256(pg_catalog.convert_to('{}', 'UTF8')),
           'validated', pg_catalog.decode(pg_catalog.repeat('21', 32), 'hex'),
           pg_catalog.decode(pg_catalog.repeat('22', 32), 'hex'), 1, 1,
           NULL, $4::uuid, statement_timestamp()
         FROM (VALUES ($2::uuid, $3::uuid), ($5::uuid, $6::uuid))
           AS fixture(dashboard_id, version_id)`,
      [
        task8dOrganizationId,
        targetDashboard,
        targetVersion,
        admin.userId,
        otherDashboard,
        otherVersion,
      ],
    );
    await ownerPool.query(
      `INSERT INTO dasher.source_snapshots (
         organization_id, snapshot_id, source_kind, canonical_bytes,
         content_sha256, observed_at, retrieved_at, created_at
       ) SELECT $1::uuid, candidate.snapshot_id, 'synthetic_fixture',
           pg_catalog.convert_to(candidate.snapshot_id::text, 'UTF8'),
           pg_catalog.sha256(
             pg_catalog.convert_to(candidate.snapshot_id::text, 'UTF8')),
           statement_timestamp(), statement_timestamp(), statement_timestamp()
         FROM pg_catalog.unnest($2::uuid[]) AS candidate(snapshot_id)`,
      [task8dOrganizationId, snapshots],
    );
    await ownerPool.query(
      `INSERT INTO dasher.source_snapshots (
         organization_id, snapshot_id, source_kind, canonical_bytes,
         content_sha256, observed_at, retrieved_at, created_at
       ) VALUES ($1::uuid, $2::uuid, 'synthetic_fixture',
         pg_catalog.convert_to('cross-org-reused-snapshot', 'UTF8'),
         pg_catalog.sha256(
           pg_catalog.convert_to('cross-org-reused-snapshot', 'UTF8')),
         statement_timestamp(), statement_timestamp(), statement_timestamp())`,
      [organizationB, snapshots[0]],
    );
    await ownerPool.query(
      `INSERT INTO dasher.evidence_records (
         organization_id, evidence_id, snapshot_id, evidence_kind,
         coordinates, transformation, content_sha256, observed_at,
         retrieved_at, created_at
       ) SELECT $1::uuid, evidence_candidate.evidence_id,
           snapshot_candidate.snapshot_id,
           'source_record', 'task8d', 'identity',
           pg_catalog.sha256(
             pg_catalog.convert_to(evidence_candidate.evidence_id::text, 'UTF8')),
           statement_timestamp(), statement_timestamp(), statement_timestamp()
         FROM pg_catalog.unnest($2::uuid[]) WITH ORDINALITY
           AS evidence_candidate(evidence_id, position)
         JOIN pg_catalog.unnest($3::uuid[]) WITH ORDINALITY
           AS snapshot_candidate(snapshot_id, position)
           USING (position)`,
      [task8dOrganizationId, evidence, snapshots],
    );
    await ownerPool.query(
      `INSERT INTO dasher.evidence_records (
         organization_id, evidence_id, snapshot_id, evidence_kind,
         coordinates, transformation, content_sha256, observed_at,
         retrieved_at, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'source_record',
         'task8d-cross-org', 'identity',
         pg_catalog.sha256(
           pg_catalog.convert_to('cross-org-reused-evidence', 'UTF8')),
         statement_timestamp(), statement_timestamp(), statement_timestamp())`,
      [organizationB, evidence[0], snapshots[0]],
    );
    await ownerPool.query(
      `INSERT INTO dasher.snapshot_reference_claims (
         organization_id, snapshot_id, reference_claim_id, dashboard_id,
         version_id, claim_kind, hold_id, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'access_bearing', NULL, statement_timestamp())`,
      [
        task8dOrganizationId,
        snapshots[1],
        "8d000000-0000-4000-8000-00000000dc01",
        targetDashboard,
        targetVersion,
      ],
    );
    await ownerPool.query(
      `INSERT INTO dasher.evidence_reference_claims (
         organization_id, evidence_id, reference_claim_id, dashboard_id,
         version_id, claim_kind, hold_id, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'access_bearing', NULL, statement_timestamp())`,
      [
        task8dOrganizationId,
        evidence[1],
        "8d000000-0000-4000-8000-00000000dc02",
        targetDashboard,
        targetVersion,
      ],
    );
    await ownerPool.query(
      `WITH candidates(resource_id, dashboard_id, state, domain_tag) AS (
         VALUES
           ($2::uuid, $3::uuid, 'deleted'::text,
            'snapshot|expected_claim_set=empty'::text),
           ($4::uuid, $5::uuid, 'deleted'::text,
            'snapshot|expected_claim_set=empty'::text),
           ($6::uuid, $3::uuid, 'deleted'::text,
            'evidence|expected_claim_set=empty'::text),
           ($7::uuid, $3::uuid, 'eligible'::text,
            'snapshot|expected_claim_set=empty'::text)
       ), hashed AS (
         SELECT resource_id, state,
           pg_catalog.sha256(pg_catalog.uuid_send($1::uuid)
             || pg_catalog.uuid_send(dashboard_id)
             || pg_catalog.uuid_send(resource_id)
             || pg_catalog.convert_to(domain_tag, 'UTF8')) AS expected_hash
         FROM candidates
       )
       INSERT INTO dasher.snapshot_deletion_finalizers (
         organization_id, snapshot_id, state, intent_at,
         expected_claim_set_sha256, lease_owner, lease_expires_at,
         proof_sha256, bytes_deleted_at
       ) SELECT $1::uuid, resource_id, state,
           statement_timestamp() - interval '1 hour', expected_hash,
           NULL, NULL, expected_hash,
           CASE WHEN state = 'deleted' THEN statement_timestamp() ELSE NULL END
         FROM hashed`,
      [
        task8dOrganizationId,
        snapshots[0],
        targetDashboard,
        snapshots[2],
        otherDashboard,
        snapshots[4],
        snapshots[5],
      ],
    );
    await ownerPool.query(
      `WITH candidates(resource_id, dashboard_id, state, domain_tag) AS (
         VALUES
           ($2::uuid, $3::uuid, 'deleted'::text,
            'evidence|expected_claim_set=empty'::text),
           ($4::uuid, $5::uuid, 'deleted'::text,
            'evidence|expected_claim_set=empty'::text),
           ($6::uuid, $3::uuid, 'deleted'::text,
            'snapshot|expected_claim_set=empty'::text),
           ($7::uuid, $3::uuid, 'eligible'::text,
            'evidence|expected_claim_set=empty'::text)
       ), hashed AS (
         SELECT resource_id, state,
           pg_catalog.sha256(pg_catalog.uuid_send($1::uuid)
             || pg_catalog.uuid_send(dashboard_id)
             || pg_catalog.uuid_send(resource_id)
             || pg_catalog.convert_to(domain_tag, 'UTF8')) AS expected_hash
         FROM candidates
       )
       INSERT INTO dasher.evidence_deletion_finalizers (
         organization_id, evidence_id, state, intent_at,
         expected_claim_set_sha256, lease_owner, lease_expires_at,
         proof_sha256, bytes_deleted_at
       ) SELECT $1::uuid, resource_id, state,
           statement_timestamp() - interval '1 hour', expected_hash,
           NULL, NULL, expected_hash,
           CASE WHEN state = 'deleted' THEN statement_timestamp() ELSE NULL END
         FROM hashed`,
      [
        task8dOrganizationId,
        evidence[0],
        targetDashboard,
        evidence[2],
        otherDashboard,
        evidence[4],
        evidence[5],
      ],
    );
    for (const [organizationId, dashboardId] of [
      [organizationB, organizationBDashboard],
    ] as const) {
      await ownerPool.query(
        `WITH snapshot_hash AS (
           SELECT pg_catalog.sha256(pg_catalog.uuid_send($1::uuid)
             || pg_catalog.uuid_send($2::uuid)
             || pg_catalog.uuid_send($3::uuid)
             || pg_catalog.convert_to(
               'snapshot|expected_claim_set=empty', 'UTF8')) AS value
         ), evidence_hash AS (
           SELECT pg_catalog.sha256(pg_catalog.uuid_send($1::uuid)
             || pg_catalog.uuid_send($2::uuid)
             || pg_catalog.uuid_send($4::uuid)
             || pg_catalog.convert_to(
               'evidence|expected_claim_set=empty', 'UTF8')) AS value
         ), inserted_snapshot AS (
           INSERT INTO dasher.snapshot_deletion_finalizers (
             organization_id, snapshot_id, state, intent_at,
             expected_claim_set_sha256, proof_sha256, bytes_deleted_at
           ) SELECT $1::uuid, $3::uuid, 'deleted',
               statement_timestamp() - interval '1 hour', value, value,
               statement_timestamp()
             FROM snapshot_hash
         )
         INSERT INTO dasher.evidence_deletion_finalizers (
           organization_id, evidence_id, state, intent_at,
           expected_claim_set_sha256, proof_sha256, bytes_deleted_at
         ) SELECT $1::uuid, $4::uuid, 'deleted',
             statement_timestamp() - interval '1 hour', value, value,
             statement_timestamp()
           FROM evidence_hash`,
        [organizationId, dashboardId, snapshots[0], evidence[0]],
      );
    }
    await ownerPool.query(
      `INSERT INTO dasher.retention_service_principal_allowlist (
         retention_service_principal_id, principal_revision, binding_kind,
         binding_subject, authority_scope, scope_organization_id,
         can_initialize, can_materialize_expiry, can_place_hold,
         can_release_hold, can_claim_cleanup, can_record_attempt, can_purge,
         enabled, created_at, predecessor_revision, predecessor_sha256,
         revision_sha256, migration_provenance
       ) VALUES
         ($1::uuid, 1, 'postgres_session_user', $3::name,
          'platform_operator', NULL, true, true, true, true, true, true, true,
          true, statement_timestamp(), NULL, NULL,
          pg_catalog.decode(pg_catalog.repeat('31', 32), 'hex'),
          'task8d-forced-rls-valid'),
         ($2::uuid, 1, 'postgres_session_user', $3::name,
          'platform_operator', NULL, true, true, true, true, true, true, true,
          true, statement_timestamp(), NULL, NULL,
          pg_catalog.decode(pg_catalog.repeat('32', 32), 'hex'),
          'task8d-forced-rls-stale'),
         ($2::uuid, 2, 'postgres_session_user', $3::name,
          'platform_operator', NULL, true, true, true, true, true, true, true,
          false, statement_timestamp(), 1,
          pg_catalog.decode(pg_catalog.repeat('32', 32), 'hex'),
          pg_catalog.decode(pg_catalog.repeat('33', 32), 'hex'),
          'task8d-forced-rls-disabled-later')`,
      [validPrincipal, stalePrincipal, ownerName],
    );

    type ContextOverrides = Readonly<{
      authorityScope?: string;
      capability?: string;
      dashboardId?: string;
      expectedRevision?: string;
      organizationId?: string;
      phase?: string;
      principalId?: string;
      principalRevision?: string;
    }>;
    const withDefinerContext = async <T>(
      operation: (client: PoolClient) => Promise<T>,
      overrides: ContextOverrides = {},
    ): Promise<T> =>
      withTask8dDefinerContext(
        () => ownerPool.connect(),
        async (client) => {
          await client.query("BEGIN");
          await client.query("SET ROLE dasher_retention_definer");
          await client.query(
            `SELECT
             pg_catalog.set_config('dasher.retention_phase', $1, true),
             pg_catalog.set_config('dasher.retention_principal_id', $2, true),
             pg_catalog.set_config('dasher.retention_principal_revision', $3, true),
             pg_catalog.set_config('dasher.retention_authority_scope', $4, true),
             pg_catalog.set_config('dasher.retention_capability', $5, true),
             pg_catalog.set_config('dasher.retention_target_organization_id', $6, true),
             pg_catalog.set_config('dasher.retention_target_dashboard_id', $7, true),
             pg_catalog.set_config('dasher.retention_expected_lifecycle_revision', $8, true)`,
            [
              overrides.phase ?? "authorized",
              overrides.principalId ?? validPrincipal,
              overrides.principalRevision ?? "1",
              overrides.authorityScope ?? "platform_operator",
              overrides.capability ?? "purge",
              overrides.organizationId ?? task8dOrganizationId,
              overrides.dashboardId ?? targetDashboard,
              overrides.expectedRevision ?? "40",
            ],
          );
        },
        operation,
      );
    const finalizedVisibility = (overrides: ContextOverrides = {}) =>
      withDefinerContext(async (client) => {
        const visible = await client.query<{
          readonly evidence_count: string;
          readonly snapshot_count: string;
        }>(
          `SELECT
               (SELECT pg_catalog.count(*)::text
                FROM dasher.source_snapshots
                WHERE organization_id = $1::uuid
                  AND snapshot_id = $2::uuid) AS snapshot_count,
               (SELECT pg_catalog.count(*)::text
                FROM dasher.evidence_records
                WHERE organization_id = $1::uuid
                  AND evidence_id = $3::uuid) AS evidence_count`,
          [task8dOrganizationId, snapshots[0], evidence[0]],
        );
        return visible.rows[0]!;
      }, overrides);

    const exactVisible = await withDefinerContext(async (client) => {
      const rows = await client.query<{
        readonly evidence_ids: string[];
        readonly snapshot_ids: string[];
      }>(
        `SELECT
           ARRAY(SELECT snapshot_id::text FROM dasher.source_snapshots
             WHERE organization_id = $1::uuid
               AND snapshot_id = ANY($2::uuid[])
             ORDER BY snapshot_id) AS snapshot_ids,
           ARRAY(SELECT evidence_id::text FROM dasher.evidence_records
             WHERE organization_id = $1::uuid
               AND evidence_id = ANY($3::uuid[])
             ORDER BY evidence_id) AS evidence_ids`,
        [task8dOrganizationId, snapshots, evidence],
      );
      return rows.rows[0]!;
    });
    expect(exactVisible).toEqual({
      evidence_ids: [evidence[0], evidence[1]],
      snapshot_ids: [snapshots[0], snapshots[1]],
    });

    const invalidDeletes = await withDefinerContext(async (client) => {
      const evidenceDelete = await client.query(
        `DELETE FROM dasher.evidence_records
         WHERE organization_id = $1::uuid
           AND evidence_id = ANY($2::uuid[])
         RETURNING evidence_id`,
        [task8dOrganizationId, evidence.slice(2, 6)],
      );
      const snapshotDelete = await client.query(
        `DELETE FROM dasher.source_snapshots
         WHERE organization_id = $1::uuid
           AND snapshot_id = ANY($2::uuid[])
         RETURNING snapshot_id`,
        [task8dOrganizationId, snapshots.slice(2, 6)],
      );
      const crossOrganizationEvidenceDelete = await client.query(
        `DELETE FROM dasher.evidence_records
         WHERE organization_id = $1::uuid AND evidence_id = $2::uuid
         RETURNING evidence_id`,
        [organizationB, evidence[0]],
      );
      const crossOrganizationSnapshotDelete = await client.query(
        `DELETE FROM dasher.source_snapshots
         WHERE organization_id = $1::uuid AND snapshot_id = $2::uuid
         RETURNING snapshot_id`,
        [organizationB, snapshots[0]],
      );
      return {
        crossOrganizationEvidence: crossOrganizationEvidenceDelete.rowCount,
        crossOrganizationSnapshot: crossOrganizationSnapshotDelete.rowCount,
        evidence: evidenceDelete.rowCount,
        snapshots: snapshotDelete.rowCount,
      };
    });
    expect(invalidDeletes).toEqual({
      crossOrganizationEvidence: 0,
      crossOrganizationSnapshot: 0,
      evidence: 0,
      snapshots: 0,
    });

    const validDeletes = await withDefinerContext(async (client) => {
      const evidenceDelete = await client.query(
        `DELETE FROM dasher.evidence_records
         WHERE organization_id = $1::uuid AND evidence_id = $2::uuid
         RETURNING evidence_id`,
        [task8dOrganizationId, evidence[0]],
      );
      const snapshotDelete = await client.query(
        `DELETE FROM dasher.source_snapshots
         WHERE organization_id = $1::uuid AND snapshot_id = $2::uuid
         RETURNING snapshot_id`,
        [task8dOrganizationId, snapshots[0]],
      );
      const finalizers = await client.query<{
        readonly evidence_states: string[];
        readonly snapshot_states: string[];
      }>(
        `SELECT
           ARRAY(SELECT state FROM dasher.evidence_deletion_finalizers
             WHERE organization_id = $1::uuid AND evidence_id = $2::uuid)
             AS evidence_states,
           ARRAY(SELECT state FROM dasher.snapshot_deletion_finalizers
             WHERE organization_id = $1::uuid AND snapshot_id = $3::uuid)
             AS snapshot_states`,
        [task8dOrganizationId, evidence[0], snapshots[0]],
      );
      return {
        evidence: evidenceDelete.rowCount,
        finalizers: finalizers.rows[0],
        snapshot: snapshotDelete.rowCount,
      };
    });
    expect(validDeletes).toEqual({
      evidence: 1,
      finalizers: {
        evidence_states: ["deleted"],
        snapshot_states: ["deleted"],
      },
      snapshot: 1,
    });

    for (const [table, id] of [
      ["source_snapshots", snapshots[1]],
      ["evidence_records", evidence[1]],
    ] as const) {
      await expectDasherBoundaryError(
        withDefinerContext(async (client) => {
          const idColumn =
            table === "source_snapshots" ? "snapshot_id" : "evidence_id";
          await client.query(
            `DELETE FROM dasher.${table}
             WHERE organization_id = $1::uuid AND ${idColumn} = $2::uuid`,
            [task8dOrganizationId, id],
          );
        }),
        "P1001",
        "dasher_denied",
      );
    }

    for (const overrides of [
      { dashboardId: otherDashboard },
      { organizationId: organizationB, dashboardId: organizationBDashboard },
      { phase: "forged" },
      { capability: "release_hold" },
      { authorityScope: "tenant_legal_admin" },
      { principalId: stalePrincipal, principalRevision: "1" },
      { principalId: stalePrincipal, principalRevision: "2" },
      { principalRevision: "99" },
    ] satisfies readonly ContextOverrides[]) {
      expect(await finalizedVisibility(overrides)).toEqual({
        evidence_count: "0",
        snapshot_count: "0",
      });
    }

    const setCleanup = async (assignment: string): Promise<void> => {
      await ownerPool.query(
        `UPDATE dasher.dashboard_cleanup_coordination
         SET ${assignment}
         WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
        [task8dOrganizationId, targetDashboard],
      );
    };
    const restoreCleanup = () =>
      setCleanup(
        `current_step = 'purge_finalizing', lease_owner = NULL,
         lease_expires_at = NULL, expected_lifecycle_revision = 40,
         completion_proof_sha256 = pg_catalog.sha256(
           pg_catalog.convert_to('task8d-target-proof', 'UTF8'))`,
      );
    for (const assignment of [
      "current_step = 'final_proof_ready'",
      "expected_lifecycle_revision = 41",
      "completion_proof_sha256 = NULL",
      "completion_proof_sha256 = pg_catalog.decode(pg_catalog.repeat('41', 31), 'hex')",
      "lease_owner = 'task8d_adversary', lease_expires_at = statement_timestamp() + interval '1 hour'",
    ]) {
      await setCleanup(assignment);
      expect(await finalizedVisibility()).toEqual({
        evidence_count: "0",
        snapshot_count: "0",
      });
      await restoreCleanup();
    }
    await ownerPool.query(
      `DELETE FROM dasher.dashboard_cleanup_coordination
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
      [task8dOrganizationId, targetDashboard],
    );
    expect(await finalizedVisibility()).toEqual({
      evidence_count: "0",
      snapshot_count: "0",
    });
    await ownerPool.query(
      `INSERT INTO dasher.dashboard_cleanup_coordination (
         organization_id, dashboard_id, current_step, lease_owner,
         lease_expires_at, expected_lifecycle_revision, next_attempt_at,
         completion_proof_sha256
       ) VALUES ($1::uuid, $2::uuid, 'purge_finalizing', NULL, NULL, 40,
         statement_timestamp(),
         pg_catalog.sha256(pg_catalog.convert_to('task8d-target-proof', 'UTF8')))`,
      [task8dOrganizationId, targetDashboard],
    );

    await expectPostgresError(
      ownerPool.query(
        `WITH expected AS (
           SELECT pg_catalog.sha256(pg_catalog.uuid_send($1::uuid)
             || pg_catalog.uuid_send($2::uuid)
             || pg_catalog.uuid_send($3::uuid)
             || pg_catalog.convert_to(
               'snapshot|expected_claim_set=empty', 'UTF8')) AS value
         )
         INSERT INTO dasher.snapshot_deletion_finalizers (
           organization_id, snapshot_id, state, intent_at,
           expected_claim_set_sha256, proof_sha256, bytes_deleted_at
         ) SELECT $1::uuid, $3::uuid, 'deleted', statement_timestamp(),
             value, pg_catalog.decode(pg_catalog.repeat('ff', 32), 'hex'),
             statement_timestamp()
           FROM expected`,
        [task8dOrganizationId, targetDashboard, snapshots[7]],
      ),
      "23514",
    );
    await expectPostgresError(
      ownerPool.query(
        `WITH expected AS (
           SELECT pg_catalog.sha256(pg_catalog.uuid_send($1::uuid)
             || pg_catalog.uuid_send($2::uuid)
             || pg_catalog.uuid_send($3::uuid)
             || pg_catalog.convert_to(
               'evidence|expected_claim_set=empty', 'UTF8')) AS value
         )
         INSERT INTO dasher.evidence_deletion_finalizers (
           organization_id, evidence_id, state, intent_at,
           expected_claim_set_sha256, proof_sha256, bytes_deleted_at
         ) SELECT $1::uuid, $3::uuid, 'deleted', statement_timestamp(),
             value, value, statement_timestamp() - interval '1 second'
           FROM expected`,
        [task8dOrganizationId, targetDashboard, evidence[8]],
      ),
      "23514",
    );

    const lockVisibility = await withDefinerContext(async (client) => {
      const lockedSnapshots = await client.query<{ readonly id: string }>(
        `SELECT snapshot_id::text AS id FROM dasher.source_snapshots
         WHERE organization_id = $1::uuid
           AND snapshot_id = ANY($2::uuid[])
         ORDER BY snapshot_id FOR UPDATE`,
        [task8dOrganizationId, snapshots.slice(0, 2)],
      );
      const lockedEvidence = await client.query<{ readonly id: string }>(
        `SELECT evidence_id::text AS id FROM dasher.evidence_records
         WHERE organization_id = $1::uuid
           AND evidence_id = ANY($2::uuid[])
         ORDER BY evidence_id FOR UPDATE`,
        [task8dOrganizationId, evidence.slice(0, 2)],
      );
      return {
        evidence: lockedEvidence.rows.map((row) => row.id),
        snapshots: lockedSnapshots.rows.map((row) => row.id),
      };
    });
    expect(lockVisibility).toEqual({
      evidence: [evidence[1]],
      snapshots: [snapshots[1]],
    });
    await expectDasherBoundaryError(
      withDefinerContext(async (client) => {
        await client.query(
          `UPDATE dasher.source_snapshots SET organization_id = organization_id
           WHERE organization_id = $1::uuid AND snapshot_id = $2::uuid`,
          [task8dOrganizationId, snapshots[1]],
        );
      }),
      "P1001",
      "dasher_denied",
    );
    await expectDasherBoundaryError(
      withDefinerContext(async (client) => {
        await client.query(
          `UPDATE dasher.evidence_records SET organization_id = organization_id
           WHERE organization_id = $1::uuid AND evidence_id = $2::uuid`,
          [task8dOrganizationId, evidence[1]],
        );
      }),
      "P1001",
      "dasher_denied",
    );

    const physical = await ownerPool.query<{
      readonly evidence_count: string;
      readonly snapshot_count: string;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text FROM dasher.source_snapshots
          WHERE organization_id = $1::uuid
            AND snapshot_id = ANY($2::uuid[])) AS snapshot_count,
         (SELECT pg_catalog.count(*)::text FROM dasher.evidence_records
          WHERE organization_id = $1::uuid
            AND evidence_id = ANY($3::uuid[])) AS evidence_count`,
      [task8dOrganizationId, snapshots, evidence],
    );
    expect(physical.rows[0]).toEqual({
      evidence_count: "9",
      snapshot_count: "9",
    });
  }, 120_000);

  it("keeps independent legal holds exact, drains agent runs only once every hold is released, and carries the frozen cleanup lifecycle through to a purged dashboard", async () => {
    const holdA = "8d000000-0000-4000-8000-00000000f101";
    const holdB = "8d000000-0000-4000-8000-00000000f102";
    const reasonA = Buffer.alloc(32, 0xa1);
    const reasonB = Buffer.alloc(32, 0xb1);
    await callRetention(
      `SELECT dasher_retention_api.place_dashboard_legal_hold(
        $1::uuid, $2::uuid, 'task8d-matter-a', $3::bytea, 2,
        $4::uuid, 'task8d-hold-a', $5::uuid)`,
      [
        expiryDashboardId,
        holdA,
        reasonA,
        "8d000000-0000-4000-8000-00000000f111",
        task8dOrganizationId,
      ],
    );
    await callRetention(
      `SELECT dasher_retention_api.place_dashboard_legal_hold(
        $1::uuid, $2::uuid, 'task8d-matter-b', $3::bytea, 3,
        $4::uuid, 'task8d-hold-b', $5::uuid)`,
      [
        expiryDashboardId,
        holdB,
        reasonB,
        "8d000000-0000-4000-8000-00000000f112",
        task8dOrganizationId,
      ],
    );
    await callRetention(
      `SELECT dasher_retention_api.release_dashboard_legal_hold(
        $1::uuid, $2::uuid, $3::bytea, 4, $4::uuid,
        'task8d-release-a', $5::uuid)`,
      [
        expiryDashboardId,
        holdA,
        reasonA,
        "8d000000-0000-4000-8000-00000000f113",
        task8dOrganizationId,
      ],
    );
    const independent = await ownerPool.query<{
      readonly active_holds: string;
      readonly hold_a_claims: string;
      readonly hold_a_released: boolean;
      readonly hold_b_claims: string;
      readonly hold_b_released: boolean;
    }>(
      `
        SELECT
          (SELECT pg_catalog.count(*)::text
           FROM dasher.dashboard_legal_holds
           WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid
             AND released_at IS NULL) AS active_holds,
          (SELECT released_at IS NOT NULL FROM dasher.dashboard_legal_holds
           WHERE organization_id = $1::uuid AND hold_id = $3::uuid)
            AS hold_a_released,
          (SELECT released_at IS NOT NULL FROM dasher.dashboard_legal_holds
           WHERE organization_id = $1::uuid AND hold_id = $4::uuid)
            AS hold_b_released,
          (SELECT pg_catalog.count(*)::text FROM (
             SELECT hold_id FROM dasher.snapshot_reference_claims
             WHERE organization_id = $1::uuid AND hold_id = $3::uuid
             UNION ALL SELECT hold_id FROM dasher.evidence_reference_claims
             WHERE organization_id = $1::uuid AND hold_id = $3::uuid
             UNION ALL SELECT hold_id FROM dasher.artifact_reference_claims
             WHERE organization_id = $1::uuid AND hold_id = $3::uuid
           ) AS claims) AS hold_a_claims,
          (SELECT pg_catalog.count(*)::text FROM (
             SELECT hold_id FROM dasher.snapshot_reference_claims
             WHERE organization_id = $1::uuid AND hold_id = $4::uuid
             UNION ALL SELECT hold_id FROM dasher.evidence_reference_claims
             WHERE organization_id = $1::uuid AND hold_id = $4::uuid
             UNION ALL SELECT hold_id FROM dasher.artifact_reference_claims
             WHERE organization_id = $1::uuid AND hold_id = $4::uuid
           ) AS claims) AS hold_b_claims
      `,
      [task8dOrganizationId, expiryDashboardId, holdA, holdB],
    );
    expect(independent.rows[0]).toEqual({
      active_holds: "1",
      hold_a_claims: "0",
      hold_a_released: true,
      hold_b_claims: "3",
      hold_b_released: false,
    });

    // Frozen 0007 redefined the third claim argument from "transition proof to
    // record" into "expected drain proof to verify", so a claim that supplies
    // one has to match a real, unconsumed dasher.dashboard_agent_drain_proofs
    // row and the successful cleanup attempt that closed it. Every lifecycle
    // transition below therefore runs the full frozen sequence - claim the
    // lease, drain the agent runs, record the attempt, then re-claim with the
    // drain proof - which 0008 Part 3 is what makes reachable at all.
    await callRetention(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
        $1::uuid, 5, NULL, interval '1 minute', $2::uuid,
        'task8d-quarantine', $3::uuid)`,
      [
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000f114",
        task8dOrganizationId,
      ],
    );
    // The claim above actually lands now that 0008 names the coordination
    // upsert's conflict target by constraint: the coordination row carries this
    // caller's lease and the step frozen 0007 derives for an untransitioned
    // access_revoked dashboard. Before that correction the same call could only
    // raise 42P10, so nothing below this line had ever been reached.
    const claimed = await ownerPool.query<{
      readonly current_step: string;
      readonly expected_lifecycle_revision: string;
      readonly lease_held_by_retention_login: boolean;
      readonly lease_live: boolean;
    }>(
      `SELECT current_step,
         expected_lifecycle_revision::text AS expected_lifecycle_revision,
         lease_owner = $3::name AS lease_held_by_retention_login,
         lease_expires_at > statement_timestamp() AS lease_live
       FROM dasher.dashboard_cleanup_coordination
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId, task8dRetentionUsername],
    );
    expect(claimed.rows[0]).toEqual({
      current_step: "drain_and_cancel",
      expected_lifecycle_revision: "5",
      lease_held_by_retention_login: true,
      lease_live: true,
    });
    // Serialization: while that lease is live the frozen DO UPDATE ... WHERE
    // clause matches no row, so a second claim - necessarily by the same
    // definer session_user, the only caller the function admits - is denied
    // with dasher_conflict instead of stealing the lease, and leaves the
    // coordination row exactly as the first claim wrote it.
    await expectDasherBoundaryError(
      (async () => {
        await callRetention(
          `SELECT dasher_retention_api.claim_dashboard_cleanup(
            $1::uuid, 5, NULL, interval '1 minute', $2::uuid,
            'task8d-quarantine-reclaim', $3::uuid)`,
          [
            expiryDashboardId,
            "8d000000-0000-4000-8000-00000000f123",
            task8dOrganizationId,
          ],
        );
      })(),
      "P1002",
      "dasher_conflict",
    );
    const afterDeniedReclaim = await ownerPool.query(
      `SELECT current_step,
         expected_lifecycle_revision::text AS expected_lifecycle_revision
       FROM dasher.dashboard_cleanup_coordination
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(afterDeniedReclaim.rows[0]).toEqual({
      current_step: "drain_and_cancel",
      expected_lifecycle_revision: "5",
    });
    // hold B is still unreleased here, so 0008's corrected drain gate denies
    // exactly as the frozen gate did. The correction only stops released holds
    // from blocking; a live hold still closes the drain, and with it the only
    // route to a transition proof.
    const heldDrainProof = await task8dDrainRequestProof(
      5,
      "8d000000-0000-4000-8000-00000000f130",
      "task8d-held-drain",
    );
    await expectDasherBoundaryError(
      (async () => {
        await callRetention(
          `SELECT dasher_retention_api.drain_dashboard_agent_runs(
            $1::uuid, 5, $2::bytea, $3::uuid, 'task8d-held-drain', $4::uuid)`,
          [
            expiryDashboardId,
            heldDrainProof,
            "8d000000-0000-4000-8000-00000000f130",
            task8dOrganizationId,
          ],
        );
      })(),
      "P1001",
      "dasher_denied",
    );
    const deniedDrain = await ownerPool.query<{
      readonly proof_count: string;
      readonly audit_count: string;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proofs
          WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid)
           AS proof_count,
         (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
          WHERE organization_id = $1::uuid
            AND action = 'dashboard.agent_runs_drained') AS audit_count`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(deniedDrain.rows[0]).toEqual({ audit_count: "0", proof_count: "0" });
    // Releasing hold B leaves two holds on the dashboard, both released. Under
    // frozen 0007's gate that history alone would still deny the drain; under
    // the corrected gate - the same predicate purge_dashboard already used -
    // only unreleased holds count, so the drain now proceeds. Each release
    // advances the lifecycle revision by one.
    await callRetention(
      `SELECT dasher_retention_api.release_dashboard_legal_hold(
        $1::uuid, $2::uuid, $3::bytea, 5, $4::uuid,
        'task8d-release-b', $5::uuid)`,
      [
        expiryDashboardId,
        holdB,
        reasonB,
        "8d000000-0000-4000-8000-00000000f117",
        task8dOrganizationId,
      ],
    );
    const releasedHistory = await ownerPool.query<{
      readonly active_holds: string;
      readonly lifecycle_revision: string;
      readonly released_holds: string;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_legal_holds
          WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid
            AND released_at IS NULL) AS active_holds,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_legal_holds
          WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid
            AND released_at IS NOT NULL) AS released_holds,
         (SELECT lifecycle_revision::text FROM dasher.dashboards
          WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid)
           AS lifecycle_revision`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(releasedHistory.rows[0]).toEqual({
      active_holds: "0",
      lifecycle_revision: "6",
      released_holds: "2",
    });
    await task8dDrainStep(
      6,
      "drain_and_cancel",
      "8d000000-0000-4000-8000-00000000f124",
      "8d000000-0000-4000-8000-00000000f131",
      "task8d-drain",
    );
    const drained = await ownerPool.query<{
      readonly audit_outcome: string;
      readonly cancelled_run_count: string;
      readonly event_count: string;
      readonly lifecycle_revision: string;
      readonly pre_drain_run_count: string;
      readonly remaining_claimed_run_count: string;
      readonly remaining_nonterminal_run_count: string;
    }>(
      `SELECT proof.lifecycle_revision::text AS lifecycle_revision,
         proof.pre_drain_run_count::text AS pre_drain_run_count,
         proof.cancelled_run_count::text AS cancelled_run_count,
         proof.remaining_nonterminal_run_count::text
           AS remaining_nonterminal_run_count,
         proof.remaining_claimed_run_count::text
           AS remaining_claimed_run_count,
         proof.event_count::text AS event_count,
         (SELECT audit.outcome FROM dasher.audit_events AS audit
          WHERE audit.organization_id = proof.organization_id
            AND audit.audit_event_id = proof.proof_id
            AND audit.action = 'dashboard.agent_runs_drained'
            AND audit.content_sha256 = proof.drain_proof_sha256)
           AS audit_outcome
       FROM dasher.dashboard_agent_drain_proofs AS proof
       WHERE proof.organization_id = $1::uuid
         AND proof.dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(drained.rows[0]).toEqual({
      audit_outcome: "succeeded",
      cancelled_run_count: "0",
      event_count: "0",
      lifecycle_revision: "6",
      pre_drain_run_count: "0",
      remaining_claimed_run_count: "0",
      remaining_nonterminal_run_count: "0",
    });
    // The drain closes with a recorded, successful cleanup attempt whose
    // completion proof the coordination row carries forward.
    const attemptRecorded = await ownerPool.query<{
      readonly coordination_proof_matches: boolean;
      readonly lease_released: boolean;
      readonly result: string;
      readonly step: string;
    }>(
      `SELECT attempt.step, attempt.result,
         coordination.completion_proof_sha256 = attempt.proof_sha256
           AS coordination_proof_matches,
         coordination.lease_owner IS NULL AS lease_released
       FROM dasher.dashboard_cleanup_attempts AS attempt
       JOIN dasher.dashboard_cleanup_coordination AS coordination
         ON coordination.organization_id = attempt.organization_id
         AND coordination.dashboard_id = attempt.dashboard_id
       WHERE attempt.organization_id = $1::uuid
         AND attempt.dashboard_id = $2::uuid
         AND attempt.cleanup_attempt_id = $3::uuid`,
      [
        task8dOrganizationId,
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000f131",
      ],
    );
    expect(attemptRecorded.rows[0]).toEqual({
      coordination_proof_matches: true,
      lease_released: true,
      result: "succeeded",
      step: "drain_and_cancel",
    });

    // With Part 4 in place the frozen-0003 visibility gap is closed, and the
    // rest of the frozen lifecycle is reachable for the first time.
    // dasher_retention_api.claim_dashboard_cleanup opens its operator context
    // with capability 'claim_cleanup' and then, only on its proof-carrying
    // branch, runs "SELECT attempt.* INTO STRICT v_attempt" over
    // dasher.dashboard_cleanup_attempts with FOR UPDATE. The frozen 0003
    // SELECT policy admitted 'record_attempt' and 'purge' only, so that STRICT
    // select found nothing and raised P0002 for every proof-carrying claim.
    // Part 4 inserts 'claim_cleanup' into that one array, and carries the same
    // insertion into the Part 1 lock policy because a locking SELECT also has
    // to pass the UPDATE policies' USING quals.
    const attemptPolicies = await ownerPool.query<{
      readonly attempt_exists: boolean;
      readonly lock_capabilities: string;
      readonly lock_policy_count: string;
      readonly select_capabilities: string;
      readonly select_policy_count: string;
    }>(
      `WITH retention_policies AS (
         SELECT policy.polcmd,
           pg_catalog.substring(
             pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
             'retention_capability''::text, true\\) = ANY \\(ARRAY\\[([^\\]]*)\\]'
           ) AS capabilities
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = 'dasher.dashboard_cleanup_attempts'::regclass
           AND 'dasher_retention_definer'::regrole = ANY (policy.polroles)
       )
       SELECT
         (SELECT pg_catalog.count(*)::text FROM retention_policies
          WHERE polcmd = 'r') AS select_policy_count,
         (SELECT pg_catalog.count(*)::text FROM retention_policies
          WHERE polcmd = 'w') AS lock_policy_count,
         (SELECT capabilities FROM retention_policies WHERE polcmd = 'r')
           AS select_capabilities,
         (SELECT capabilities FROM retention_policies WHERE polcmd = 'w')
           AS lock_capabilities,
         EXISTS (
           SELECT 1 FROM dasher.dashboard_cleanup_attempts AS attempt
           WHERE attempt.organization_id = $1::uuid
             AND attempt.dashboard_id = $2::uuid
             AND attempt.cleanup_attempt_id = $3::uuid
             AND attempt.result = 'succeeded'
         ) AS attempt_exists`,
      [
        task8dOrganizationId,
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000f131",
      ],
    );
    expect(attemptPolicies.rows[0]).toEqual({
      attempt_exists: true,
      lock_capabilities:
        "'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text",
      lock_policy_count: "1",
      select_capabilities:
        "'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text",
      select_policy_count: "1",
    });
    // Live, per-capability evaluation of that same policy. The widening is
    // exactly one capability wide: the three the array names see the recorded
    // attempt, and every capability outside it still sees nothing at all.
    for (const capability of ["claim_cleanup", "record_attempt", "purge"]) {
      expect(
        await task8dAttemptsVisibleUnderCapability(capability),
        capability,
      ).toBe("1");
    }
    for (const capability of [
      "materialize_expiry",
      "place_hold",
      "release_hold",
      "",
    ]) {
      expect(
        await task8dAttemptsVisibleUnderCapability(capability),
        capability,
      ).toBe("0");
    }

    // Part 5 lands. dasher_private.recompute_drain_proof_v1 (frozen 0007,
    // SECURITY DEFINER, OWNER dasher_retention_definer) inner-joins
    // dasher.audit_events to bind a drain proof to the audit row that recorded
    // the drain, and reads audit.deployment_revision straight into the proof
    // preimage. Frozen 0003 gave dasher_retention_definer INSERT on that
    // relation and nothing else, under forced row-level security with no SELECT
    // policy for the role, so the join raised 42501 - on the cleanup claim's
    // proof-carrying branch one statement past the attempt read Part 4
    // unblocked, and again inside dasher_retention_api.purge_dashboard.
    //
    // Part 5 adds the column-scoped read privilege and the one SELECT policy
    // that join needs, naming the eight columns the retention definer's four
    // reader statements touch and none of the other twelve.
    // Both halves are load-bearing: under forced row-level security the
    // grant on its own would have made the relation read as empty rather than
    // raise, the inner join would have matched nothing, and both callers would
    // have compared a stored digest against NULL - the vacuous proof
    // verification this helper exists to prevent.
    const auditReadAuthority = await ownerPool.query<{
      readonly column_scoped_privileges: string[];
      readonly definer_privileges: string[];
      readonly definer_select_capabilities: string;
      readonly definer_select_policies: string;
      readonly forces_row_security: boolean;
      readonly other_role_select_policies: string;
      readonly table_scoped_privileges: string[];
    }>(
      `SELECT
         ARRAY(SELECT privilege.privilege_type::text
           FROM information_schema.table_privileges AS privilege
           WHERE privilege.table_schema = 'dasher'
             AND privilege.table_name = 'audit_events'
             AND privilege.grantee = 'dasher_retention_definer'
           ORDER BY privilege.privilege_type) AS definer_privileges,
         ARRAY(SELECT privilege.grantee::text || ':'
             || privilege.privilege_type::text
           FROM information_schema.table_privileges AS privilege
           WHERE privilege.table_schema = 'dasher'
             AND privilege.table_name = 'audit_events'
             AND privilege.grantee <> $1::text
           ORDER BY privilege.grantee, privilege.privilege_type)
           AS table_scoped_privileges,
         ARRAY(SELECT privilege.grantee::text || ':'
             || privilege.privilege_type::text || ':'
             || pg_catalog.count(*)::text
           FROM information_schema.column_privileges AS privilege
           WHERE privilege.table_schema = 'dasher'
             AND privilege.table_name = 'audit_events'
             AND privilege.grantee <> $1::text
           GROUP BY privilege.grantee, privilege.privilege_type
           ORDER BY privilege.grantee, privilege.privilege_type)
           AS column_scoped_privileges,
         (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'dasher.audit_events'::regclass
            AND policy.polcmd = 'r'
            AND 'dasher_retention_definer'::regrole = ANY (policy.polroles))
           AS definer_select_policies,
         (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'dasher.audit_events'::regclass
            AND policy.polcmd = 'r'
            AND NOT ('dasher_retention_definer'::regrole
              = ANY (policy.polroles))) AS other_role_select_policies,
         (SELECT pg_catalog.substring(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
            'retention_capability''::text, true\\) = ANY \\(ARRAY\\[([^\\]]*)\\]')
          FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'dasher.audit_events'::regclass
            AND policy.polcmd = 'r'
            AND 'dasher_retention_definer'::regrole = ANY (policy.polroles))
           AS definer_select_capabilities,
         (SELECT relation.relforcerowsecurity FROM pg_catalog.pg_class
            AS relation WHERE relation.oid = 'dasher.audit_events'::regclass)
           AS forces_row_security`,
      [config.ownerUsername],
    );
    // The read surface widens by exactly one privilege on exactly one role,
    // over eight of that relation's twenty columns. Outside the migration owner
    // the audit log carries no privilege at all beyond INSERT and SELECT, so
    // nothing anywhere holds UPDATE, DELETE or TRUNCATE on it and the relation
    // stays append-only. dasher_app and dasher_security_definer keep the
    // column-scoped SELECT the frozen series already gave them - their counts
    // below are every column, unchanged - and the two run roles hold nothing.
    // Only dasher_retention_definer's row moves, and its table-scoped
    // privileges do not move at all: the new SELECT is column-scoped, so it
    // appears in column_privileges with a count of 8 and nowhere in
    // table_privileges, which still shows INSERT alone. The 8 is the assertion
    // that matters most here - a table-level grant, or a column list that grew
    // by even one unread column, would read as 20 or 9 instead. Forced
    // row-level security is untouched, and each of the three reading roles
    // still reaches rows through its own policy and no other.
    expect(auditReadAuthority.rows[0]).toEqual({
      column_scoped_privileges: [
        "dasher_app:SELECT:20",
        "dasher_retention_definer:INSERT:20",
        "dasher_retention_definer:SELECT:8",
        "dasher_security_definer:INSERT:20",
        "dasher_security_definer:SELECT:20",
      ],
      definer_privileges: ["INSERT"],
      definer_select_capabilities: "'claim_cleanup'::text, 'purge'::text",
      definer_select_policies: "1",
      forces_row_security: true,
      other_role_select_policies: "2",
      table_scoped_privileges: ["dasher_retention_definer:INSERT"],
    });

    // The column scoping is live, not merely recorded in the catalog. In the
    // same authorized context that lets the drain-proof join succeed, a
    // granted column reads normally over this dashboard's eight visible audit
    // rows, and every one of the twelve ungranted columns is refused outright
    // with 42501 before row-level security is ever consulted. Under the
    // table-level grant this replaced, all twelve would have read cleanly.
    expect(
      await task8dDefinerProbe<{ readonly granted: string }>(
        "purge",
        `SELECT pg_catalog.count(audit.deployment_revision)::text AS granted
         FROM dasher.audit_events AS audit`,
      ),
    ).toEqual([{ granted: "8" }]);
    for (const ungranted of [
      "occurred_at",
      "actor_kind",
      "actor_user_id",
      "actor_service",
      "authority_revision",
      "request_id",
      "job_id",
      "source_ref",
      "provider",
      "credential_version",
      "usage_units",
      "cost_minor_units",
    ]) {
      await expectPostgresError(
        task8dDefinerProbe<{ readonly blocked: string }>(
          "purge",
          `SELECT audit.${ungranted} AS blocked
           FROM dasher.audit_events AS audit`,
        ),
        "42501",
      );
    }
    // The audit log is still immutable in both directions, for the owner and
    // for the role that just gained the read.
    await expectPostgresError(
      ownerPool.query(
        `UPDATE dasher.audit_events SET outcome = outcome
         WHERE organization_id = $1::uuid`,
        [task8dOrganizationId],
      ),
      "55000",
    );
    await expectPostgresError(
      ownerPool.query(
        `DELETE FROM dasher.audit_events WHERE organization_id = $1::uuid`,
        [task8dOrganizationId],
      ),
      "55000",
    );
    for (const mutation of [
      `UPDATE dasher.audit_events SET outcome = outcome`,
      `DELETE FROM dasher.audit_events`,
    ]) {
      await expect(
        task8dDefinerProbe("purge", mutation),
        mutation,
      ).rejects.toMatchObject({ code: "42501" });
    }

    // What the organization's audit log actually holds at this point, read from
    // the owner connection: rows about this dashboard, and rows about
    // everything else in the same organization. The second number is the one
    // the new policy has to keep out of reach.
    const auditScope = await ownerPool.query<{
      readonly organization_rows: string;
      readonly other_target_rows: string;
      readonly this_dashboard_rows: string;
    }>(
      `SELECT
         pg_catalog.count(*)::text AS organization_rows,
         pg_catalog.count(*) FILTER (
           WHERE audit.target_type = 'dashboard'
             AND audit.target_id = $2::uuid)::text AS this_dashboard_rows,
         pg_catalog.count(*) FILTER (
           WHERE audit.target_type <> 'dashboard'
             OR audit.target_id <> $2::uuid)::text AS other_target_rows
       FROM dasher.audit_events AS audit
       WHERE audit.organization_id = $1::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(auditScope.rows[0]).toEqual({
      organization_rows: "14",
      other_target_rows: "6",
      this_dashboard_rows: "8",
    });

    // Live evaluation of the new policy, through the helper that needs it.
    //
    //   * Under the two capabilities the call graph reaches
    //     recompute_drain_proof_v1 with, the helper completes and reproduces
    //     the digest stored on the drain proof row exactly. What it can see
    //     while doing so is this dashboard's own audit trail and nothing else:
    //     the six rows the same organization holds about other targets stay
    //     out of reach, because the policy pins target_type and target_id to
    //     the operator context's own dashboard.
    //   * Under 'record_attempt' the proof rows are still visible - frozen
    //     dasher_private.retention_policy_allows_v1 admits that capability on
    //     dasher.dashboard_agent_drain_proofs - but no audit row is, so the
    //     inner join matches nothing and the helper returns NULL. That is the
    //     frozen contract for an absent proof: NULL, not an error and not a
    //     wrong digest. It is also what proves the capability array is doing
    //     the narrowing, and not some other conjunct that happens to fail.
    //   * With no principal binding present at all, both relations close and
    //     the helper returns NULL again.
    for (const capability of ["claim_cleanup", "purge"]) {
      expect(await task8dRecomputedDrainProof(capability), capability).toEqual({
        audit_rows_visible: "8",
        matches_stored: true,
        out_of_scope_rows_visible: "0",
        proof_rows_visible: "1",
        recomputed_is_null: false,
      });
    }
    expect(await task8dRecomputedDrainProof("record_attempt")).toEqual({
      audit_rows_visible: "0",
      matches_stored: null,
      out_of_scope_rows_visible: "0",
      proof_rows_visible: "1",
      recomputed_is_null: true,
    });
    for (const capability of [
      "materialize_expiry",
      "place_hold",
      "release_hold",
      "",
    ]) {
      expect(await task8dRecomputedDrainProof(capability), capability).toEqual({
        audit_rows_visible: "0",
        matches_stored: null,
        out_of_scope_rows_visible: "0",
        proof_rows_visible: "0",
        recomputed_is_null: true,
      });
    }
    expect(
      await task8dRecomputedDrainProof("purge", { bindPrincipal: false }),
    ).toEqual({
      audit_rows_visible: "0",
      matches_stored: null,
      out_of_scope_rows_visible: "0",
      proof_rows_visible: "0",
      recomputed_is_null: true,
    });

    // The proof-carrying claim runs end to end for the first time:
    // access_revoked -> quarantined, one drain proof consumed, one lifecycle
    // revision spent.
    await setTask8dDashboardBoundary("purge_after", "five_minutes_from_now");
    const quarantineProof = await task8dUnconsumedDrainProof();
    await task8dReleaseCleanupLease();
    await callRetention(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
        $1::uuid, 6, $2::bytea, interval '1 minute', $3::uuid,
        'task8d-quarantine', $4::uuid)`,
      [
        expiryDashboardId,
        quarantineProof,
        "8d000000-0000-4000-8000-00000000f120",
        task8dOrganizationId,
      ],
    );
    const afterQuarantineTransition = await ownerPool.query<{
      readonly consumed_proofs: string;
      readonly lifecycle_revision: string;
      readonly lifecycle_state: string;
      readonly unconsumed_proofs: string;
    }>(
      `SELECT dashboard.lifecycle_state,
         dashboard.lifecycle_revision::text AS lifecycle_revision,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proof_consumptions
          WHERE organization_id = dashboard.organization_id
            AND dashboard_id = dashboard.dashboard_id) AS consumed_proofs,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proofs AS proof
          WHERE proof.organization_id = dashboard.organization_id
            AND proof.dashboard_id = dashboard.dashboard_id
            AND NOT EXISTS (
              SELECT 1
              FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
              WHERE consumed.organization_id = proof.organization_id
                AND consumed.dashboard_id = proof.dashboard_id
                AND consumed.proof_id = proof.proof_id
            )) AS unconsumed_proofs
       FROM dasher.dashboards AS dashboard
       WHERE dashboard.organization_id = $1::uuid
         AND dashboard.dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(afterQuarantineTransition.rows[0]).toEqual({
      consumed_proofs: "1",
      lifecycle_revision: "7",
      lifecycle_state: "quarantined",
      unconsumed_proofs: "0",
    });

    // A fresh unreleased hold closes the drain again, exactly as hold B did
    // above: the corrected gate only stops released holds from blocking.
    const holdC = "8d000000-0000-4000-8000-00000000f103";
    const reasonC = Buffer.alloc(32, 0xc1);
    await callRetention(
      `SELECT dasher_retention_api.place_dashboard_legal_hold(
        $1::uuid, $2::uuid, 'task8d-matter-c', $3::bytea, 7,
        $4::uuid, 'task8d-hold-c', $5::uuid)`,
      [
        expiryDashboardId,
        holdC,
        reasonC,
        "8d000000-0000-4000-8000-00000000f141",
        task8dOrganizationId,
      ],
    );
    await task8dReleaseCleanupLease();
    await callRetention(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
        $1::uuid, 8, NULL, interval '1 minute', $2::uuid,
        'task8d-held-claim', $3::uuid)`,
      [
        expiryDashboardId,
        "8d000000-0000-4000-8000-00000000f142",
        task8dOrganizationId,
      ],
    );
    const heldDrainRequest = await task8dDrainRequestProof(
      8,
      "8d000000-0000-4000-8000-00000000f143",
      "task8d-held-drain-c",
    );
    await expectDasherBoundaryError(
      (async () => {
        await callRetention(
          `SELECT dasher_retention_api.drain_dashboard_agent_runs(
            $1::uuid, 8, $2::bytea, $3::uuid, 'task8d-held-drain-c', $4::uuid)`,
          [
            expiryDashboardId,
            heldDrainRequest,
            "8d000000-0000-4000-8000-00000000f143",
            task8dOrganizationId,
          ],
        );
      })(),
      "P1001",
      "dasher_denied",
    );
    // purge_dashboard denies here too, and would deny on the unreleased hold
    // even if the lifecycle had reached 'purge_eligible': its hold gate sits
    // ahead of every proof check it makes.
    await setTask8dDashboardBoundary("purge_after", "now");
    await expectDasherBoundaryError(
      (async () => {
        await callRetention(
          `SELECT dasher_retention_api.purge_dashboard(
            $1::uuid, 8, NULL, $2::uuid, 'task8d-held-purge', $3::uuid)`,
          [
            expiryDashboardId,
            "8d000000-0000-4000-8000-00000000f116",
            task8dOrganizationId,
          ],
        );
      })(),
      "P1001",
      "dasher_denied",
    );
    await callRetention(
      `SELECT dasher_retention_api.release_dashboard_legal_hold(
        $1::uuid, $2::uuid, $3::bytea, 8, $4::uuid,
        'task8d-release-c', $5::uuid)`,
      [
        expiryDashboardId,
        holdC,
        reasonC,
        "8d000000-0000-4000-8000-00000000f144",
        task8dOrganizationId,
      ],
    );
    // Still 'quarantined': purge_dashboard only ever acts on a 'purge_eligible'
    // dashboard, and reaching that state is the claim's job, not its own.
    await expectDasherBoundaryError(
      (async () => {
        await callRetention(
          `SELECT dasher_retention_api.purge_dashboard(
            $1::uuid, 9, NULL, $2::uuid, 'task8d-purge', $3::uuid)`,
          [
            expiryDashboardId,
            "8d000000-0000-4000-8000-00000000f145",
            task8dOrganizationId,
          ],
        );
      })(),
      "P1001",
      "dasher_denied",
    );

    // quarantined -> purge_eligible. Every proof-carrying claim consumes a
    // drain proof taken at the revision it is claiming, so the traversal drains
    // once more at revision 9 before it can spend that proof on the transition.
    await task8dDrainStep(
      9,
      "prepare_finalizers",
      "8d000000-0000-4000-8000-00000000fa01",
      "8d000000-0000-4000-8000-00000000fa02",
      "task8d-prepare",
    );
    const purgeEligibleProof = await task8dUnconsumedDrainProof();
    await task8dReleaseCleanupLease();
    await callRetention(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
        $1::uuid, 9, $2::bytea, interval '1 minute', $3::uuid,
        'task8d-purge-eligible', $4::uuid)`,
      [
        expiryDashboardId,
        purgeEligibleProof,
        "8d000000-0000-4000-8000-00000000fa03",
        task8dOrganizationId,
      ],
    );
    // purge_dashboard's own drain-proof gate wants a consumed proof taken at
    // the revision it is purging, so the traversal drains and consumes once
    // more at revision 10. This claim transitions nothing - the dashboard is
    // already 'purge_eligible' - it exists to spend the proof.
    await task8dDrainStep(
      10,
      "purge_finalizing",
      "8d000000-0000-4000-8000-00000000fa04",
      "8d000000-0000-4000-8000-00000000fa05",
      "task8d-final-drain",
    );
    const finalDrainProof = await task8dUnconsumedDrainProof();
    await task8dReleaseCleanupLease();
    await callRetention(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
        $1::uuid, 10, $2::bytea, interval '1 minute', $3::uuid,
        'task8d-final-consume', $4::uuid)`,
      [
        expiryDashboardId,
        finalDrainProof,
        "8d000000-0000-4000-8000-00000000fa06",
        task8dOrganizationId,
      ],
    );
    const readyForPurge = await ownerPool.query<{
      readonly consumed_proofs: string;
      readonly current_step: string;
      readonly lifecycle_revision: string;
      readonly lifecycle_state: string;
      readonly unconsumed_proofs: string;
    }>(
      `SELECT dashboard.lifecycle_state,
         dashboard.lifecycle_revision::text AS lifecycle_revision,
         coordination.current_step,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proof_consumptions
          WHERE organization_id = dashboard.organization_id
            AND dashboard_id = dashboard.dashboard_id) AS consumed_proofs,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proofs AS proof
          WHERE proof.organization_id = dashboard.organization_id
            AND proof.dashboard_id = dashboard.dashboard_id
            AND NOT EXISTS (
              SELECT 1
              FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
              WHERE consumed.organization_id = proof.organization_id
                AND consumed.dashboard_id = proof.dashboard_id
                AND consumed.proof_id = proof.proof_id
            )) AS unconsumed_proofs
       FROM dasher.dashboards AS dashboard
       JOIN dasher.dashboard_cleanup_coordination AS coordination
         ON coordination.organization_id = dashboard.organization_id
         AND coordination.dashboard_id = dashboard.dashboard_id
       WHERE dashboard.organization_id = $1::uuid
         AND dashboard.dashboard_id = $2::uuid`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(readyForPurge.rows[0]).toEqual({
      consumed_proofs: "3",
      current_step: "purge_finalizing",
      lifecycle_revision: "10",
      lifecycle_state: "purge_eligible",
      unconsumed_proofs: "0",
    });

    // Frozen purge is a multi-pass state machine, and three of its frozen
    // semantics decide how the passes chain:
    //
    //   * dasher_private.recompute_cleanup_completion_proof_v1 (0007:20685)
    //     re-derives the completion digest from the latest succeeded attempt
    //     and returns NULL when the stored digest disagrees, so the coordination
    //     row's proof has to be re-established from a real recorded attempt
    //     before each pass that consumes it.
    //   * the coordination-proof clearing at 0007:22444 - the first pass sets
    //     completion_proof_sha256 = NULL, and the claim upsert's DO UPDATE does
    //     the same - so every pass after one that clears it needs a fresh
    //     claim and a fresh recorded attempt.
    //   * the final_proof_ready handshake at 0007:23733 - the pass that finds
    //     the coordination row on any other step records 'finalize_resources',
    //     moves it to 'final_proof_ready' and returns, and only the next pass
    //     tears the dashboard down.
    //
    // The driver below encodes exactly that and nothing else: read the
    // coordination row, re-establish the proof when it is missing, otherwise
    // take one purge pass with a fresh operation id. The observed sequence is
    // asserted verbatim afterwards, so the number of passes and the step the
    // dashboard sat on at each one are both pinned.
    const purgeTrace: string[] = [];
    let purgeOperation = 0;
    const nextPurgeOperationId = (): string => {
      purgeOperation += 1;
      return `8d000000-0000-4000-8000-00000000fb${purgeOperation
        .toString(16)
        .padStart(2, "0")}`;
    };
    for (let pass = 0; pass < 32; pass += 1) {
      const observed = await ownerPool.query<{
        readonly completion_proof: Buffer | null;
        readonly current_step: string;
        readonly lifecycle_revision: string;
        readonly lifecycle_state: string;
      }>(
        `SELECT dashboard.lifecycle_state,
           dashboard.lifecycle_revision::text AS lifecycle_revision,
           coordination.current_step,
           coordination.completion_proof_sha256 AS completion_proof
         FROM dasher.dashboards AS dashboard
         JOIN dasher.dashboard_cleanup_coordination AS coordination
           ON coordination.organization_id = dashboard.organization_id
           AND coordination.dashboard_id = dashboard.dashboard_id
         WHERE dashboard.organization_id = $1::uuid
           AND dashboard.dashboard_id = $2::uuid`,
        [task8dOrganizationId, expiryDashboardId],
      );
      const state = observed.rows[0];
      if (state === undefined) {
        throw new Error("Task 8D lost the dashboard mid-purge");
      }
      purgeTrace.push(
        `${state.lifecycle_state}@${state.lifecycle_revision}/${
          state.current_step
        }/${state.completion_proof === null ? "no-proof" : "proof"}`,
      );
      if (state.lifecycle_state === "cleaned") {
        break;
      }
      const revision = Number(state.lifecycle_revision);
      if (state.completion_proof === null) {
        const attemptId = nextPurgeOperationId();
        await task8dReleaseCleanupLease();
        await callRetention(
          `SELECT dasher_retention_api.claim_dashboard_cleanup(
            $1::uuid, $2::bigint, NULL, interval '1 minute', $3::uuid,
            'task8d-purge-release', $4::uuid)`,
          [expiryDashboardId, revision, attemptId, task8dOrganizationId],
        );
        const completionProof = await task8dCleanupCompletionProof(
          attemptId,
          "purge_finalizing",
          "succeeded",
          0,
          0,
          0,
        );
        await callRetention(
          `SELECT dasher_retention_api.record_dashboard_cleanup_attempt(
            $1::uuid, $2::uuid, 'purge_finalizing', 'succeeded', 0, 0, 0,
            $3::bytea, $4::uuid)`,
          [expiryDashboardId, attemptId, completionProof, task8dOrganizationId],
        );
        continue;
      }
      await callRetention(
        `SELECT dasher_retention_api.purge_dashboard(
          $1::uuid, $2::bigint, $3::bytea, $4::uuid, 'task8d-purge-pass',
          $5::uuid)`,
        [
          expiryDashboardId,
          revision,
          state.completion_proof,
          nextPurgeOperationId(),
          task8dOrganizationId,
        ],
      );
    }
    // Twenty-three passes, and every one of them accounted for: the first
    // re-establishes the coordination proof the consuming claim cleared, the
    // second is the pass that sets purge_started_at and clears it again
    // (0007:22444), the third re-establishes it once more, then eighteen passes
    // walk the frozen deletion-finalizer batches - each one creates or advances
    // a batch and returns without touching the coordination row - then the
    // final_proof_ready handshake (0007:23733) records 'finalize_resources' and
    // hands over, and the last pass tears the dashboard down. The lifecycle
    // revision moves exactly once, on that last pass.
    expect(purgeTrace).toEqual([
      "purge_eligible@10/purge_finalizing/no-proof",
      "purge_eligible@10/purge_finalizing/proof",
      "purge_eligible@10/purge_started/no-proof",
      ...Array.from(
        { length: 18 },
        () => "purge_eligible@10/purge_finalizing/proof",
      ),
      "purge_eligible@10/final_proof_ready/proof",
      "cleaned@11/cleaned/proof",
    ]);

    // The full traversal has landed. This is the original purge-side
    // projection: the backup-deletion ledger carries 'purged', every deletion
    // finalizer reached 'deleted', every governed resource is torn down, every
    // reference claim is released and the dashboard itself is 'cleaned'.
    //
    // Reaching 'deleted' is asserted together with the proof that entitled the
    // finalizer to get there, for both the evidence and the snapshot side: the
    // recorded proof_sha256 equals the expected_claim_set_sha256 it was checked
    // against, bytes_deleted_at is set, and it is not earlier than intent_at.
    // Those are the three columns the frozen 0003 completion checks constrain,
    // so a finalizer that reached the terminal state without a valid proof, or
    // with a deletion stamped before the intent that authorized it, fails here
    // rather than passing on the state name alone.
    const purged = await ownerPool.query<{
      readonly artifact_count: string;
      readonly evidence_claim_dashboards: string[];
      readonly evidence_count: string;
      readonly evidence_finalizer_proof_valid: boolean;
      readonly evidence_finalizer_states: string[];
      readonly head_version_id: string | null;
      readonly ledger_events: string[];
      readonly lifecycle_revision: string;
      readonly lifecycle_state: string;
      readonly lineage_count: string;
      readonly purge_started: boolean;
      readonly purged: boolean;
      readonly resource_count: string;
      readonly snapshot_claim_dashboards: string[];
      readonly snapshot_count: string;
      readonly snapshot_finalizer_proof_valid: boolean;
      readonly snapshot_finalizer_states: string[];
      readonly version_count: string;
    }>(
      `
        SELECT dashboard.lifecycle_state,
          dashboard.lifecycle_revision::text,
          dashboard.head_version_id::text AS head_version_id,
          dashboard.purge_started_at IS NOT NULL AS purge_started,
          dashboard.purged_at IS NOT NULL AS purged,
          (SELECT pg_catalog.array_agg(event_kind ORDER BY ledger_sequence)
           FROM dasher.backup_deletion_ledger
           WHERE organization_id = dashboard.organization_id
             AND tombstone_lineage_id = dashboard.tombstone_lineage_id)
            AS ledger_events,
          (SELECT pg_catalog.count(*)::text FROM dasher.dashboard_versions
           WHERE organization_id = dashboard.organization_id
             AND dashboard_id = dashboard.dashboard_id) AS version_count,
          (SELECT pg_catalog.count(*)::text FROM dasher.evidence_records
           WHERE organization_id = dashboard.organization_id
             AND evidence_id = $3::uuid) AS evidence_count,
          ARRAY(SELECT claim.dashboard_id::text
            FROM dasher.evidence_reference_claims AS claim
            WHERE claim.organization_id = dashboard.organization_id
              AND claim.evidence_id = $3::uuid
            ORDER BY claim.dashboard_id) AS evidence_claim_dashboards,
          ARRAY(SELECT finalizer.state
            FROM dasher.evidence_deletion_finalizers AS finalizer
            WHERE finalizer.organization_id = dashboard.organization_id
              AND finalizer.evidence_id = $3::uuid
            ORDER BY finalizer.state) AS evidence_finalizer_states,
          (SELECT pg_catalog.bool_and(
              finalizer.proof_sha256 = finalizer.expected_claim_set_sha256
              AND finalizer.bytes_deleted_at IS NOT NULL
              AND finalizer.bytes_deleted_at >= finalizer.intent_at)
            FROM dasher.evidence_deletion_finalizers AS finalizer
            WHERE finalizer.organization_id = dashboard.organization_id
              AND finalizer.evidence_id = $3::uuid)
            AS evidence_finalizer_proof_valid,
          (SELECT pg_catalog.count(*)::text FROM dasher.source_snapshots
           WHERE organization_id = dashboard.organization_id
             AND snapshot_id = $4::uuid) AS snapshot_count,
          ARRAY(SELECT claim.dashboard_id::text
            FROM dasher.snapshot_reference_claims AS claim
            WHERE claim.organization_id = dashboard.organization_id
              AND claim.snapshot_id = $4::uuid
            ORDER BY claim.dashboard_id) AS snapshot_claim_dashboards,
          ARRAY(SELECT finalizer.state
            FROM dasher.snapshot_deletion_finalizers AS finalizer
            WHERE finalizer.organization_id = dashboard.organization_id
              AND finalizer.snapshot_id = $4::uuid
            ORDER BY finalizer.state) AS snapshot_finalizer_states,
          (SELECT pg_catalog.bool_and(
              finalizer.proof_sha256 = finalizer.expected_claim_set_sha256
              AND finalizer.bytes_deleted_at IS NOT NULL
              AND finalizer.bytes_deleted_at >= finalizer.intent_at)
            FROM dasher.snapshot_deletion_finalizers AS finalizer
            WHERE finalizer.organization_id = dashboard.organization_id
              AND finalizer.snapshot_id = $4::uuid)
            AS snapshot_finalizer_proof_valid,
          (SELECT pg_catalog.count(*)::text FROM dasher.dashboard_artifacts
           WHERE organization_id = dashboard.organization_id
             AND artifact_id = $5::uuid) AS artifact_count,
          (SELECT pg_catalog.count(*)::text FROM dasher.dashboard_restore_lineage
           WHERE organization_id = dashboard.organization_id
             AND dashboard_id = dashboard.dashboard_id) AS lineage_count,
          ((SELECT pg_catalog.count(*) FROM dasher.dashboard_versions
            WHERE organization_id = dashboard.organization_id
              AND dashboard_id = dashboard.dashboard_id)
           + (SELECT pg_catalog.count(*) FROM dasher.evidence_records
              WHERE organization_id = dashboard.organization_id
                AND evidence_id = $3::uuid)
           + (SELECT pg_catalog.count(*) FROM dasher.source_snapshots
              WHERE organization_id = dashboard.organization_id
                AND snapshot_id = $4::uuid)
           + (SELECT pg_catalog.count(*) FROM dasher.dashboard_artifacts
              WHERE organization_id = dashboard.organization_id
                AND artifact_id = $5::uuid)
           + (SELECT pg_catalog.count(*) FROM dasher.dashboard_restore_lineage
              WHERE organization_id = dashboard.organization_id
                AND dashboard_id = dashboard.dashboard_id))::text AS resource_count
        FROM dasher.dashboards AS dashboard
        WHERE dashboard.organization_id = $1::uuid
          AND dashboard.dashboard_id = $2::uuid
      `,
      [
        task8dOrganizationId,
        expiryDashboardId,
        expiryEvidenceId,
        expirySnapshotId,
        expiryArtifactId,
      ],
    );
    expect(purged.rows[0]).toEqual({
      artifact_count: "0",
      evidence_claim_dashboards: [],
      evidence_count: "0",
      evidence_finalizer_proof_valid: true,
      evidence_finalizer_states: ["deleted"],
      head_version_id: null,
      ledger_events: ["access_revoked", "purged"],
      lifecycle_revision: "11",
      lifecycle_state: "cleaned",
      lineage_count: "0",
      purge_started: true,
      purged: true,
      resource_count: "0",
      snapshot_claim_dashboards: [],
      snapshot_count: "0",
      snapshot_finalizer_proof_valid: true,
      snapshot_finalizer_states: ["deleted"],
      version_count: "0",
    });
    // The purge wrote its own audit row. The drain-proof ledger is deliberately
    // not part of what a purge tears down - the three proofs and their
    // consumptions survive as the record of how the dashboard was drained - so
    // the helper that verified them still reproduces the latest digest exactly,
    // now against a dashboard audit trail seven rows longer than it was before
    // the traversal, and still with nothing outside that dashboard in reach.
    const purgeAudit = await ownerPool.query<{
      readonly purged_audit_rows: string;
    }>(
      `SELECT pg_catalog.count(*)::text AS purged_audit_rows
       FROM dasher.audit_events AS audit
       WHERE audit.organization_id = $1::uuid
         AND audit.action = 'dashboard.purged'
         AND audit.target_type = 'dashboard'
         AND audit.target_id = $2::uuid
         AND audit.outcome = 'succeeded'`,
      [task8dOrganizationId, expiryDashboardId],
    );
    expect(purgeAudit.rows[0]).toEqual({ purged_audit_rows: "1" });
    expect(await task8dRecomputedDrainProof("purge")).toEqual({
      audit_rows_visible: "15",
      matches_stored: true,
      out_of_scope_rows_visible: "0",
      proof_rows_visible: "3",
      recomputed_is_null: false,
    });
    // And the absent-proof contract, on a dashboard that never had one: the
    // helper returns NULL rather than raising or inventing a digest.
    expect(
      await task8dDefinerProbe<{ readonly digest: string | null }>(
        "purge",
        `SELECT pg_catalog.encode(
           dasher_private.recompute_drain_proof_v1($1::uuid, $2::uuid), 'hex')
           AS digest`,
        [task8dOrganizationId, "8d000000-0000-4000-8000-0000000000ff"],
      ),
    ).toEqual([{ digest: null }]);
    await expectPostgresError(
      ownerPool.query(
        `UPDATE dasher.backup_deletion_ledger SET proof_sha256 = proof_sha256
         WHERE organization_id = $1::uuid`,
        [task8dOrganizationId],
      ),
      "55000",
    );
    await expectPostgresError(
      ownerPool.query(
        `DELETE FROM dasher.backup_deletion_ledger
         WHERE organization_id = $1::uuid`,
        [task8dOrganizationId],
      ),
      "55000",
    );
  }, 120_000);

  it("rejects latest-disabled operator authority without fallback and keeps retention execution closed", async () => {
    const privileges = await ownerPool.query<{
      readonly app_can_initialize: boolean;
      readonly operator_can_initialize: boolean;
      readonly security_can_initialize: boolean;
    }>(`
      SELECT
        pg_catalog.has_function_privilege(
          'dasher_app',
          'dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)',
          'EXECUTE'
        ) AS app_can_initialize,
        pg_catalog.has_function_privilege(
          'dasher_retention_operator',
          'dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)',
          'EXECUTE'
        ) AS operator_can_initialize,
        pg_catalog.has_function_privilege(
          'dasher_security_definer',
          'dasher_retention_api.initialize_operator_context(uuid,text,uuid,text,uuid)',
          'EXECUTE'
        ) AS security_can_initialize
    `);
    expect(privileges.rows[0]).toEqual({
      app_can_initialize: false,
      operator_can_initialize: false,
      security_can_initialize: false,
    });

    await ownerPool.query(
      `
        INSERT INTO dasher.retention_service_principal_allowlist (
          retention_service_principal_id, principal_revision, binding_kind,
          binding_subject, authority_scope, scope_organization_id,
          can_initialize, can_materialize_expiry, can_place_hold,
          can_release_hold, can_claim_cleanup, can_record_attempt, can_purge,
          enabled, created_at, predecessor_revision, predecessor_sha256,
          revision_sha256, migration_provenance
        ) VALUES (
          '8d000000-0000-4000-8000-000000000030'::uuid, 2,
          'postgres_session_user', $1::name, 'platform_operator', NULL,
          true, true, true, true, true, true, true, false,
          clock_timestamp(), 1,
          pg_catalog.decode(pg_catalog.repeat('8d', 32), 'hex'),
          pg_catalog.decode(pg_catalog.repeat('8e', 32), 'hex'),
          'task8d-production-operator-disabled-successor'
        )
      `,
      [task8dRetentionUsername],
    );
    await expectDasherBoundaryError(
      callRetention(
        `SELECT dasher_retention_api.purge_dashboard(
          $1::uuid, 9, NULL, $2::uuid, 'task8d-disabled-latest', $3::uuid)`,
        [
          expiryDashboardId,
          "8d000000-0000-4000-8000-00000000f301",
          task8dOrganizationId,
        ],
      ),
      "P1001",
      "dasher_denied",
    );

    const app = await appPool!.connect();
    try {
      await app.query("SET ROLE dasher_app");
      await expectPostgresDenial(
        app,
        `SELECT dasher_retention_api.initialize_operator_context(
          $1::uuid, 'purge', $2::uuid, 'task8d-app-denied', $3::uuid)`,
        [
          expiryDashboardId,
          "8d000000-0000-4000-8000-00000000f302",
          task8dOrganizationId,
        ],
      );
    } finally {
      await app.query("RESET ROLE");
      app.release();
    }
  }, 120_000);
});

// Part 6 of 0008 normalizes the age-out's audit INSERT: a unique_violation on
// the global dasher.audit_events primary key becomes P1002 / dasher_conflict
// instead of a bare 23505 carrying the constraint name.
//
// The collision this closes is the one Part 5's row scoping opened. Frozen
// 0007 probes audit_events by audit_event_id alone, deliberately globally, but
// audit_events_retention_select confines the retention definer to the operator
// context's own organization, target_type 'dashboard' and target dashboard, so
// an operation id already spent by another dashboard's or another
// organization's audit row is invisible to that probe. The function proceeds,
// does the whole age-out, and only the primary key stops it.
//
// The age-out is reached here through its real precondition and nothing else.
// dasher_retention_api.age_out_dashboard_agent_run_metadata requires a
// dasher.backup_deletion_ledger row for the dashboard's tombstone lineage whose
// event_kind is 'backup.deleted', and 0008 Part 9 is what makes such a row
// writable at all: the frozen 0003 CHECK admitted only 'access_revoked' and
// 'purged', so the entry point could never run and every call died at the
// ledger lookup's SELECT ... INTO STRICT with an unnormalized P0002. The
// fixture below seeds a genuine 'backup.deleted' row through the installed
// vocabulary, exactly as the backup-deletion process would record one after a
// purge. No test in this block alters the schema the migration installs -
// there is no CHECK-drop scaffolding anywhere here - so the reachability of
// this routine is a property of the series and not of the harness.
describe.sequential("Task 9 age-out audit collision normalization", () => {
  const task9OrganizationA = "9a000000-0000-4000-8000-000000000001";
  const task9OrganizationB = "9a000000-0000-4000-8000-000000000002";
  const task9DashboardA = "9a000000-0000-4000-8000-000000000010";
  const task9DashboardB = "9a000000-0000-4000-8000-000000000011";
  const task9DashboardC = "9a000000-0000-4000-8000-000000000012";
  // Identical to the target in every respect except that its lineage never
  // receives a 'backup.deleted' ledger event, so it isolates that one row as
  // the age-out's precondition.
  const task9DashboardD = "9a000000-0000-4000-8000-000000000013";
  const task9LineageA = "9a000000-0000-4000-8000-000000000020";
  const task9LineageB = "9a000000-0000-4000-8000-000000000021";
  const task9LineageC = "9a000000-0000-4000-8000-000000000022";
  const task9LineageD = "9a000000-0000-4000-8000-000000000023";
  const task9UserId = "9a000000-0000-4000-8000-000000000030";
  const task9PrincipalId = "9a000000-0000-4000-8000-000000000040";
  const task9Deployment = "task9-ageout-probe";

  // The age-out re-derives this digest inside its own operator context and
  // refuses any caller that cannot present it. This is frozen 0007's preimage
  // for dasher_private.recompute_age_out_source_proof_v1, with the two GUCs
  // the context sets spelled as the values the call will carry: the request id
  // is the operation id, and the deployment revision is the one passed in.
  const task9SourceProofSql = `
    SELECT pg_catalog.sha256(
      pg_catalog.convert_to('dasher.agent-run-age-out-source.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.uuid_send($2::uuid)
      || pg_catalog.int8send(dashboard.lifecycle_revision)
      || pg_catalog.uuid_send(tombstone.tombstone_lineage_id)
      || pg_catalog.int8send((extract(epoch FROM
        tombstone.purged_at) * 1000000)::bigint)
      || pg_catalog.int8send(ledger.ledger_sequence)
      || pg_catalog.int4send(pg_catalog.octet_length(ledger.event_kind))
      || pg_catalog.convert_to(ledger.event_kind, 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length(ledger.proof_sha256))
      || ledger.proof_sha256
      || pg_catalog.uuid_send($3::uuid)
      || pg_catalog.int4send(pg_catalog.octet_length($4::text))
      || pg_catalog.convert_to($4::text, 'UTF8')
      || pg_catalog.uuid_send($1::uuid)
    ) AS source_proof
    FROM dasher.dashboards AS dashboard
    JOIN dasher.dashboard_tombstones AS tombstone
      ON tombstone.organization_id = dashboard.organization_id
     AND tombstone.tombstone_lineage_id = dashboard.tombstone_lineage_id
    JOIN dasher.backup_deletion_ledger AS ledger
      ON ledger.organization_id = tombstone.organization_id
     AND ledger.tombstone_lineage_id = tombstone.tombstone_lineage_id
     AND ledger.event_kind = 'backup.deleted'
    WHERE dashboard.organization_id = $1::uuid
      AND dashboard.dashboard_id = $2::uuid
      AND tombstone.purged_at = dashboard.purged_at
      AND tombstone.purged_lifecycle_revision = dashboard.lifecycle_revision
    ORDER BY ledger.ledger_sequence DESC LIMIT 1
  `;

  async function task9CallAgeOut(
    client: PoolClient,
    operationId: string,
    presuppliedSourceProof?: Buffer,
  ): Promise<void> {
    let sourceProof = presuppliedSourceProof;
    if (sourceProof === undefined) {
      const proof = await client.query<{ readonly source_proof: Buffer }>(
        task9SourceProofSql,
        [task9OrganizationA, task9DashboardA, operationId, task9Deployment],
      );
      sourceProof = proof.rows[0]?.source_proof;
      if (sourceProof === undefined) {
        throw new Error("Task 9 could not derive the age-out source proof");
      }
    }
    await client.query("SET ROLE dasher_retention_operator");
    try {
      await client.query(
        `SELECT dasher_retention_api.age_out_dashboard_agent_run_metadata(
           $1::uuid, $2::bigint, $3::bytea, $4::uuid, $5::text, $6::uuid
         )`,
        [
          task9DashboardA,
          2,
          sourceProof,
          operationId,
          task9Deployment,
          task9OrganizationA,
        ],
      );
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
    }
  }

  // Seed one audit row that already spends `operationId`, against whichever
  // organization and dashboard the probe wants it to belong to. It is committed
  // rather than written inside the probe transaction, so the residue checks
  // afterwards can tell the seeded row apart from one the age-out wrote.
  async function task9SpendOperationId(
    operationId: string,
    organizationId: string,
    dashboardId: string,
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO dasher.audit_events (
         audit_event_id, organization_id, occurred_at, actor_kind,
         actor_service, authority_revision, request_id, action, target_type,
         target_id, outcome, content_sha256, deployment_revision
       ) VALUES (
         $1::uuid, $2::uuid, transaction_timestamp(), 'service', 'task9-probe',
         1, pg_catalog.gen_random_uuid(),
         'dashboard.agent_run_metadata_aged_out', 'dashboard', $3::uuid,
         'succeeded', pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8')),
         'task9-probe'
       )`,
      [operationId, organizationId, dashboardId],
    );
  }

  async function task9Residue(operationId: string): Promise<{
    readonly age_out_proof_rows: string;
    readonly audit_rows_for_operation: string;
    readonly backup_deleted_ledger_rows: string;
    readonly ledger_constraint: string | null;
    readonly seeded_audit_row_survives: boolean;
  }> {
    const residue = await ownerPool.query<{
      readonly age_out_proof_rows: string;
      readonly audit_rows_for_operation: string;
      readonly backup_deleted_ledger_rows: string;
      readonly ledger_constraint: string | null;
      readonly seeded_audit_row_survives: boolean;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_run_age_out_proofs) AS age_out_proof_rows,
         (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
          WHERE audit_event_id = $1::uuid) AS audit_rows_for_operation,
         (SELECT pg_catalog.count(*)::text FROM dasher.backup_deletion_ledger
          WHERE event_kind = 'backup.deleted') AS backup_deleted_ledger_rows,
         (SELECT pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
          WHERE conname = 'backup_deletion_ledger_event_kind_check')
           AS ledger_constraint,
         EXISTS (SELECT 1 FROM dasher.audit_events
           WHERE audit_event_id = $1::uuid
             AND actor_service = 'task9-probe') AS seeded_audit_row_survives`,
      [operationId],
    );
    const row = residue.rows[0];
    if (row === undefined) {
      throw new Error("Task 9 residue projection returned no row");
    }
    return row;
  }

  beforeAll(async () => {
    await closeAppPoolBeforeLoginTeardown();
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }
    await resetManagedSchemas();
    await runMigrations(ownerPool, canonicalMigrationDirectory, []);

    // Every row below is written in one transaction: the fixture dates the
    // dashboard and its tombstone off transaction_timestamp(), and the age-out
    // joins them on purged_at, so the two have to be stamped from the same
    // clock reading.
    const fixture = await ownerPool.connect();
    try {
      await fixture.query("BEGIN");
      // A dashboard is age-out eligible when it is 'cleaned', purged more than a
      // year ago, and its cleanup coordination agrees on the revision. Three of
      // them: the target, a sibling in the same organization, and one in a second
      // organization, so a spent operation id can be placed out of the target's
      // policy scope in each of the two ways that matters.
      await fixture.query(
        `INSERT INTO dasher.users (user_id, created_at)
         VALUES ($1::uuid, transaction_timestamp())`,
        [task9UserId],
      );
      await fixture.query(
        `INSERT INTO dasher.organizations (organization_id, display_name)
         VALUES ($1::uuid, 'Task 9 age-out organization A'),
                ($2::uuid, 'Task 9 age-out organization B')`,
        [task9OrganizationA, task9OrganizationB],
      );
      await fixture.query(
        `INSERT INTO dasher.dashboard_tombstones (
           organization_id, tombstone_lineage_id, retention_policy_revision,
           access_revoked_at, access_revoked_lifecycle_revision,
           access_revoked_proof_sha256, purged_at, purged_lifecycle_revision,
           purged_proof_sha256
         )
         SELECT org, lineage, 1,
           transaction_timestamp() - interval '400 days', 1,
           pg_catalog.sha256(pg_catalog.convert_to('revoked', 'UTF8')),
           transaction_timestamp() - interval '400 days', 2,
           pg_catalog.sha256(pg_catalog.convert_to('purged', 'UTF8'))
         FROM (VALUES ($1::uuid, $3::uuid), ($1::uuid, $4::uuid),
                      ($2::uuid, $5::uuid), ($1::uuid, $6::uuid))
              AS t(org, lineage)`,
        [
          task9OrganizationA,
          task9OrganizationB,
          task9LineageA,
          task9LineageB,
          task9LineageC,
          task9LineageD,
        ],
      );
      await fixture.query(
        `INSERT INTO dasher.dashboards (
           organization_id, dashboard_id, title, created_by_user_id, created_at,
           created_kind, current_kind, lifecycle_state, lifecycle_revision,
           capability_epoch, cache_epoch, access_revoked_at, revocation_reason,
           purge_after, purge_started_at, purged_at, retention_policy_revision,
           tombstone_lineage_id
         )
         SELECT org, dash, 'Task 9 age-out probe', $6::uuid,
           transaction_timestamp() - interval '800 days',
           'durable', 'durable', 'cleaned', 2, 1, 1,
           transaction_timestamp() - interval '401 days', 'explicit_delete',
           transaction_timestamp() - interval '400 days',
           transaction_timestamp() - interval '400 days',
           transaction_timestamp() - interval '400 days', 1, lineage
         FROM (VALUES ($1::uuid, $3::uuid, $7::uuid),
                      ($1::uuid, $4::uuid, $8::uuid),
                      ($2::uuid, $5::uuid, $9::uuid),
                      ($1::uuid, $10::uuid, $11::uuid))
              AS t(org, dash, lineage)`,
        [
          task9OrganizationA,
          task9OrganizationB,
          task9DashboardA,
          task9DashboardB,
          task9DashboardC,
          task9UserId,
          task9LineageA,
          task9LineageB,
          task9LineageC,
          task9DashboardD,
          task9LineageD,
        ],
      );
      // The ledger as the series actually writes it: the purge records
      // 'purged', and the backup-deletion process that follows it records
      // 'backup.deleted' against the same tombstone lineage at a later
      // sequence. The second kind is the age-out's precondition, and 0008
      // Part 9 is what admits it - this INSERT is refused with 23514 against
      // the frozen 0003 vocabulary, so it doubles as the reachability proof.
      await fixture.query(
        `INSERT INTO dasher.backup_deletion_ledger (
           organization_id, ledger_sequence, tombstone_lineage_id,
           lifecycle_revision, event_kind, event_occurred_at, inserted_at,
           retention_policy_revision, proof_sha256
         )
         SELECT org, seq, lineage, 2, kind,
           transaction_timestamp() - interval '390 days',
           transaction_timestamp() - interval '390 days', 1,
           pg_catalog.sha256(
             pg_catalog.convert_to(kind || '-' || seq::text, 'UTF8'))
         FROM (VALUES ($1::uuid, 1::bigint, $3::uuid, 'purged'),
                      ($1::uuid, 2::bigint, $4::uuid, 'purged'),
                      ($2::uuid, 1::bigint, $5::uuid, 'purged'),
                      ($1::uuid, 11::bigint, $3::uuid, 'backup.deleted'),
                      ($1::uuid, 12::bigint, $4::uuid, 'backup.deleted'),
                      ($2::uuid, 11::bigint, $5::uuid, 'backup.deleted'),
                      ($1::uuid, 3::bigint, $6::uuid, 'purged'))
              AS t(org, seq, lineage, kind)`,
        [
          task9OrganizationA,
          task9OrganizationB,
          task9LineageA,
          task9LineageB,
          task9LineageC,
          task9LineageD,
        ],
      );
      await fixture.query(
        `INSERT INTO dasher.dashboard_cleanup_coordination (
           organization_id, dashboard_id, current_step,
           expected_lifecycle_revision
         )
         SELECT org, dash, 'cleaned', 2
         FROM (VALUES ($1::uuid, $3::uuid), ($1::uuid, $4::uuid),
                      ($2::uuid, $5::uuid), ($1::uuid, $6::uuid))
              AS t(org, dash)`,
        [
          task9OrganizationA,
          task9OrganizationB,
          task9DashboardA,
          task9DashboardB,
          task9DashboardC,
          task9DashboardD,
        ],
      );
      const ownerName = (
        await fixture.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        )
      ).rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("Task 9 could not resolve the database owner");
      }
      await fixture.query(
        `INSERT INTO dasher.retention_service_principal_allowlist (
           retention_service_principal_id, principal_revision, binding_kind,
           binding_subject, authority_scope, scope_organization_id,
           can_initialize, can_materialize_expiry, can_place_hold,
           can_release_hold, can_claim_cleanup, can_record_attempt, can_purge,
           enabled, created_at, predecessor_revision, predecessor_sha256,
           revision_sha256, migration_provenance
         ) VALUES (
           $1::uuid, 1, 'postgres_session_user', $2::name, 'platform_operator',
           NULL, true, true, true, true, true, true, true, true,
           transaction_timestamp(), NULL, NULL,
           pg_catalog.decode(pg_catalog.repeat('39', 32), 'hex'),
           'task9-ageout-probe'
         )`,
        [task9PrincipalId, ownerName],
      );
      await fixture.query("COMMIT");
    } catch (error) {
      await fixture.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }
  }, 180_000);

  afterAll(async () => {
    await resetManagedSchemas();
  }, 120_000);

  // 0008 Part 9, asserted rather than assumed: the installed vocabulary admits
  // exactly the frozen two values plus the one the frozen age-out requires, and
  // it is still a closed vocabulary - every other event kind is refused with
  // 23514, so widening it by one value did not turn the column into free text.
  it("admits backup.deleted in the installed ledger vocabulary and still refuses everything else", async () => {
    const ledger = await ownerPool.query<{
      readonly definition: string;
    }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_catalog.pg_constraint
       WHERE conname = 'backup_deletion_ledger_event_kind_check'`,
    );
    expect(ledger.rows[0]?.definition).toBe(
      "CHECK ((event_kind = ANY (ARRAY['access_revoked'::text, 'purged'::text, 'backup.deleted'::text])))",
    );

    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      // The admitted value writes, through the ordinary INSERT path.
      await client.query(
        `INSERT INTO dasher.backup_deletion_ledger (
           organization_id, ledger_sequence, tombstone_lineage_id,
           lifecycle_revision, event_kind, event_occurred_at, inserted_at,
           retention_policy_revision, proof_sha256
         ) VALUES ($1::uuid, 99, $2::uuid, 2, 'backup.deleted',
           transaction_timestamp(), transaction_timestamp(), 1,
           pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8')))`,
        [task9OrganizationA, task9LineageA],
      );
      await client.query("SAVEPOINT vocabulary_probe");
      for (const rejected of [
        "backup_deleted",
        "backup.restored",
        "cleaned",
        "",
      ]) {
        await expect(
          client.query(
            `INSERT INTO dasher.backup_deletion_ledger (
               organization_id, ledger_sequence, tombstone_lineage_id,
               lifecycle_revision, event_kind, event_occurred_at, inserted_at,
               retention_policy_revision, proof_sha256
             ) VALUES ($1::uuid, 100, $2::uuid, 2, $3::text,
               transaction_timestamp(), transaction_timestamp(), 1,
               pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8')))`,
            [task9OrganizationA, task9LineageA, rejected],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "backup_deletion_ledger_event_kind_check",
        });
        await client.query("ROLLBACK TO SAVEPOINT vocabulary_probe");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const residue = await task9Residue("9a000000-0000-4000-8000-00000000ffff");
    expect(residue.backup_deleted_ledger_rows).toBe("3");
  }, 60_000);

  // The precondition is real, and the ledger row is what satisfies it. The
  // fourth fixture dashboard is identical to the target in every way except
  // that its tombstone lineage carries only the 'purged' ledger event and no
  // 'backup.deleted' one, so the frozen entry point dies exactly where it died
  // for every dashboard before Part 9 made such a row writable: at the ledger
  // lookup's SELECT ... INTO STRICT, with an unnormalized P0002. Nothing is
  // mutated to produce this - the ledger is append-only and the schema is
  // untouched - so it is the absence of the row, and only that, being observed.
  it("dies at the frozen ledger lookup when the lineage has no backup.deleted row", async () => {
    const operationId = "9a000000-0000-4000-8000-0000000000f1";
    const client = await ownerPool.connect();
    try {
      // The ledger lookup precedes every proof comparison in the frozen body,
      // so a well-formed 32-byte argument is all this needs to reach it.
      await client.query("SET ROLE dasher_retention_operator");
      await expect(
        client.query(
          `SELECT dasher_retention_api.age_out_dashboard_agent_run_metadata(
             $1::uuid, $2::bigint, $3::bytea, $4::uuid, $5::text, $6::uuid
           )`,
          [
            task9DashboardD,
            2,
            Buffer.alloc(32, 0x9a),
            operationId,
            task9Deployment,
            task9OrganizationA,
          ],
        ),
      ).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
    const residue = await task9Residue(operationId);
    expect(residue.backup_deleted_ledger_rows).toBe("3");
    expect(residue.age_out_proof_rows).toBe("0");
    expect(residue.audit_rows_for_operation).toBe("0");
  }, 60_000);

  // (d) The happy path still completes end to end: the wrap changes an error
  // path, not the age-out itself.
  it("completes the full age-out on the happy path", async () => {
    const operationId = "9a000000-0000-4000-8000-0000000000d1";
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await task9CallAgeOut(client, operationId);
      const written = await client.query<{
        readonly audit_rows: string;
        readonly proof_rows: string;
      }>(
        `SELECT
           (SELECT pg_catalog.count(*)::text
            FROM dasher.dashboard_agent_run_age_out_proofs
            WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid)
             AS proof_rows,
           (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
            WHERE audit_event_id = $3::uuid) AS audit_rows`,
        [task9OrganizationA, task9DashboardA, operationId],
      );
      expect(written.rows[0]).toEqual({ audit_rows: "1", proof_rows: "1" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const residue = await task9Residue(operationId);
    expect(residue.age_out_proof_rows).toBe("0");
    expect(residue.audit_rows_for_operation).toBe("0");
  }, 60_000);

  // (a) The frozen global probe still fires first when the collision is one the
  // Part 5 policy can see. This path is unchanged by Part 6.
  it("normalizes an in-scope duplicate operation id from the frozen probe", async () => {
    const operationId = "9a000000-0000-4000-8000-0000000000a1";
    await task9SpendOperationId(
      operationId,
      task9OrganizationA,
      task9DashboardA,
    );
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await expect(task9CallAgeOut(client, operationId)).rejects.toMatchObject({
        code: "P1002",
        message: "dasher_conflict",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const residue = await task9Residue(operationId);
    expect(residue.age_out_proof_rows).toBe("0");
    expect(residue.audit_rows_for_operation).toBe("1");
    expect(residue.seeded_audit_row_survives).toBe(true);
  }, 60_000);

  // (b) The collision Part 5's scoping hides: the operation id belongs to
  // another dashboard in the same organization, so the frozen probe cannot see
  // it and the primary key is what refuses. Part 6 is what makes that refusal
  // P1002 instead of a raw 23505.
  it("normalizes a cross-dashboard collision at the audit INSERT and rolls back cleanly", async () => {
    const operationId = "9a000000-0000-4000-8000-0000000000b1";
    await task9SpendOperationId(
      operationId,
      task9OrganizationA,
      task9DashboardB,
    );
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await expect(task9CallAgeOut(client, operationId)).rejects.toMatchObject({
        code: "P1002",
        message: "dasher_conflict",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    // Nothing partial survives: no age-out proof, the installed ledger
    // vocabulary and its three seeded 'backup.deleted' rows are exactly as the
    // fixture left them, and the only audit row carrying the operation id is
    // still the one the probe seeded against the other dashboard.
    const residue = await task9Residue(operationId);
    expect(residue).toEqual({
      age_out_proof_rows: "0",
      audit_rows_for_operation: "1",
      backup_deleted_ledger_rows: "3",
      ledger_constraint:
        "CHECK ((event_kind = ANY (ARRAY['access_revoked'::text, 'purged'::text, 'backup.deleted'::text])))",
      seeded_audit_row_survives: true,
    });
  }, 60_000);

  // (c) The same collision across an organization boundary.
  it("normalizes a cross-organization collision at the audit INSERT and rolls back cleanly", async () => {
    const operationId = "9a000000-0000-4000-8000-0000000000c1";
    await task9SpendOperationId(
      operationId,
      task9OrganizationB,
      task9DashboardC,
    );
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await expect(task9CallAgeOut(client, operationId)).rejects.toMatchObject({
        code: "P1002",
        message: "dasher_conflict",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const residue = await task9Residue(operationId);
    expect(residue).toEqual({
      age_out_proof_rows: "0",
      audit_rows_for_operation: "1",
      backup_deleted_ledger_rows: "3",
      ledger_constraint:
        "CHECK ((event_kind = ANY (ARRAY['access_revoked'::text, 'purged'::text, 'backup.deleted'::text])))",
      seeded_audit_row_survives: true,
    });
  }, 60_000);

  // The counterfactual, so the repair cannot be quietly reverted: with frozen
  // 0007's body restored, the very same cross-dashboard collision surfaces the
  // bare uniqueness failure the plan forbids - constraint name and all.
  it("surfaces a raw 23505 from the frozen 0007 body the correction replaces", async () => {
    const operationId = "9a000000-0000-4000-8000-0000000000e1";
    await task9SpendOperationId(
      operationId,
      task9OrganizationA,
      task9DashboardB,
    );
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const frozen =
      /^CREATE FUNCTION dasher_retention_api[.]age_out_dashboard_agent_run_metadata\([\s\S]*?^\$function\$;/mu.exec(
        migrations[6]?.sql ?? "",
      )?.[0];
    if (frozen === undefined) {
      throw new Error("Task 9 could not extract the frozen 0007 age-out");
    }
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        frozen.replace("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "),
      );
      await expect(task9CallAgeOut(client, operationId)).rejects.toMatchObject({
        code: "23505",
        constraint: "audit_events_pkey",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const residue = await task9Residue(operationId);
    expect(residue.age_out_proof_rows).toBe("0");
    expect(residue.audit_rows_for_operation).toBe("1");
  }, 60_000);

  // Part 6 lives inside a routine body, and pg_get_functiondef is part of the
  // fingerprinted routine inventory, so reverting it is catalog drift rather
  // than a silent behavioural regression. Restoring frozen 0007's body moves
  // the phase-8 fingerprint off its frozen constant - observed as
  // cbc1f2228f4af4e6fc8a2957ab7cad9eac21c20024d9cbd6d5278cca8394b796 against
  // the 5e42f3bd... baseline, at an unchanged entry count of 7718, because
  // replacing a routine renames no identity - and the gate refuses it.
  it("reads a reverted Part 6 body as phase-8 catalog drift", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const frozen =
      /^CREATE FUNCTION dasher_retention_api[.]age_out_dashboard_agent_run_metadata\([\s\S]*?^\$function\$;/mu.exec(
        migrations[6]?.sql ?? "",
      )?.[0];
    if (frozen === undefined) {
      throw new Error("Task 9 could not extract the frozen 0007 age-out");
    }
    const client = await ownerPool.connect();
    try {
      const ownerName = (
        await client.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        )
      ).rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("Task 9 could not resolve the database owner");
      }
      // The installed catalog is on the frozen constant before the revert.
      expect(await canonical0008CatalogMatchesForTests(client, ownerName)).toBe(
        true,
      );
      await client.query("BEGIN");
      try {
        await client.query(
          frozen.replace("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "),
        );
        expect(
          await canonical0008CatalogMatchesForTests(client, ownerName),
        ).toBe(false);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      // And back on it once the revert is rolled back.
      expect(await canonical0008CatalogMatchesForTests(client, ownerName)).toBe(
        true,
      );
    } finally {
      client.release();
    }
  }, 60_000);
});

// Task 9 audit-event-id collision normalization for the three retention entry
// points 0008 corrects outside the age-out: the cleanup claim (Part 2), the
// agent-run drain (Part 3) and the dashboard purge (Part 8).
//
// dasher.audit_events.audit_event_id is a global primary key, and all three
// write it from a caller-supplied uuid. Unlike the age-out, none of them has
// any probe that could observe that uuid being spent somewhere else: every
// guard they carry is scoped to one organization and one dashboard. So a uuid
// already spent by an audit row in another scope passes every gate, the call
// runs its whole write path, and the audit INSERT at the end is what refuses
// it. Without the wrapper that refusal is a bare 23505 carrying
// audit_events_pkey; with it, it is the P1002 / dasher_conflict every other
// conflict path in these functions already raises.
//
// Each function below is reached through its real precondition chain - claim
// the lease, drain, record the attempt, re-claim with the drain proof, purge -
// driven by the same operator context production uses. Nothing is stubbed and
// no schema is altered.
describe.sequential("Task 9 retention audit collision normalization", () => {
  const t9rOrganization = "9b000000-0000-4000-8000-000000000001";
  const t9rDashboard = "9b000000-0000-4000-8000-000000000010";
  const t9rOtherDashboard = "9b000000-0000-4000-8000-000000000011";
  const t9rLineage = "9b000000-0000-4000-8000-000000000020";
  const t9rOtherLineage = "9b000000-0000-4000-8000-000000000021";
  const t9rUserId = "9b000000-0000-4000-8000-000000000030";
  const t9rPrincipalId = "9b000000-0000-4000-8000-000000000040";
  const t9rDeployment = "task9-retention-probe";
  const t9rBaseRevision = 5;

  // Every retention entry point opens its own operator context, and
  // initialize_operator_context refuses to run when any of its GUCs is already
  // set. They are set transaction-locally, so one call per transaction is the
  // contract; each helper here honours it by using a fresh implicit
  // transaction, exactly as the production caller does.
  async function callRetentionAs(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<void> {
    const client = await ownerPool.connect();
    let failure: unknown;
    try {
      await client.query("SET ROLE dasher_retention_operator");
      await client.query(sql, [...parameters]);
    } catch (error) {
      failure = error;
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  async function t9rClaim(
    revision: number,
    transitionProof: Buffer | null,
    operationId: string,
  ): Promise<void> {
    await callRetentionAs(
      `SELECT dasher_retention_api.claim_dashboard_cleanup(
         $1::uuid, $2::bigint, $3::bytea, interval '5 minutes', $4::uuid,
         $5::text, $6::uuid)`,
      [
        t9rDashboard,
        revision,
        transitionProof,
        operationId,
        t9rDeployment,
        t9rOrganization,
      ],
    );
  }

  async function t9rDrainRequestProof(
    revision: number,
    operationId: string,
  ): Promise<Buffer> {
    const derived = await ownerPool.query<{ readonly request_sha256: Buffer }>(
      `SELECT pg_catalog.sha256(
         pg_catalog.convert_to('dasher.agent-run-drain-request.v1', 'UTF8')
         || pg_catalog.decode('00', 'hex')
         || pg_catalog.uuid_send($2::uuid)
         || pg_catalog.int8send($3::bigint)
         || pg_catalog.uuid_send($4::uuid)
         || pg_catalog.int4send(pg_catalog.octet_length($5::text))
         || pg_catalog.convert_to($5::text, 'UTF8')
         || pg_catalog.uuid_send($1::uuid)
         || pg_catalog.int4send(
           pg_catalog.octet_length(coordination.current_step))
         || pg_catalog.convert_to(coordination.current_step, 'UTF8')
         || pg_catalog.int4send(
           pg_catalog.octet_length(coordination.lease_owner::text))
         || pg_catalog.convert_to(coordination.lease_owner::text, 'UTF8')
         || pg_catalog.int8send((extract(epoch FROM
           coordination.lease_expires_at) * 1000000)::bigint)
         || pg_catalog.uuid_send($6::uuid)
         || pg_catalog.int8send($7::bigint)
       ) AS request_sha256
       FROM dasher.dashboard_cleanup_coordination AS coordination
       WHERE coordination.organization_id = $1::uuid
         AND coordination.dashboard_id = $2::uuid`,
      [
        t9rOrganization,
        t9rDashboard,
        revision,
        operationId,
        t9rDeployment,
        t9rPrincipalId,
        1,
      ],
    );
    const digest = derived.rows[0]?.request_sha256;
    if (digest === undefined) {
      throw new Error("Task 9 could not derive the drain request proof");
    }
    return digest;
  }

  async function t9rDrain(
    revision: number,
    requestProof: Buffer,
    operationId: string,
  ): Promise<void> {
    await callRetentionAs(
      `SELECT dasher_retention_api.drain_dashboard_agent_runs(
         $1::uuid, $2::bigint, $3::bytea, $4::uuid, $5::text, $6::uuid)`,
      [
        t9rDashboard,
        revision,
        requestProof,
        operationId,
        t9rDeployment,
        t9rOrganization,
      ],
    );
  }

  async function t9rCleanupCompletionProof(
    cleanupAttemptId: string,
    step: string,
    result: string,
  ): Promise<Buffer> {
    const derived = await ownerPool.query<{
      readonly completion_sha256: Buffer;
    }>(
      `SELECT pg_catalog.sha256(
         pg_catalog.convert_to(
           'dasher.dashboard-cleanup-completion.v1', 'UTF8')
         || pg_catalog.decode('00', 'hex')
         || pg_catalog.uuid_send($2::uuid)
         || pg_catalog.int8send(dashboard.lifecycle_revision)
         || pg_catalog.uuid_send($3::uuid)
         || pg_catalog.int4send(pg_catalog.octet_length($4::text))
         || pg_catalog.convert_to($4::text, 'UTF8')
         || pg_catalog.int4send(pg_catalog.octet_length($5::text))
         || pg_catalog.convert_to($5::text, 'UTF8')
         || pg_catalog.int8send(0::bigint)
         || pg_catalog.int8send(0::bigint)
         || pg_catalog.int8send(0::bigint)
         || CASE WHEN drain.drain_proof_sha256 IS NULL
           THEN pg_catalog.decode('00', 'hex')
           ELSE pg_catalog.decode('01', 'hex')
             || pg_catalog.int4send(
               pg_catalog.octet_length(drain.drain_proof_sha256))
             || drain.drain_proof_sha256 END
         || pg_catalog.uuid_send($1::uuid)
         || pg_catalog.int4send(
           pg_catalog.octet_length(coordination.lease_owner::text))
         || pg_catalog.convert_to(coordination.lease_owner::text, 'UTF8')
         || pg_catalog.uuid_send($6::uuid)
         || pg_catalog.int8send($7::bigint)
       ) AS completion_sha256
       FROM dasher.dashboards AS dashboard
       JOIN dasher.dashboard_cleanup_coordination AS coordination
         ON coordination.organization_id = dashboard.organization_id
         AND coordination.dashboard_id = dashboard.dashboard_id
       LEFT JOIN LATERAL (
         SELECT proof.drain_proof_sha256
         FROM dasher.dashboard_agent_drain_proofs AS proof
         WHERE proof.organization_id = dashboard.organization_id
           AND proof.dashboard_id = dashboard.dashboard_id
           AND NOT EXISTS (
             SELECT 1
             FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
             WHERE consumed.organization_id = proof.organization_id
               AND consumed.dashboard_id = proof.dashboard_id
               AND consumed.proof_id = proof.proof_id
           )
         ORDER BY proof.generated_at DESC,
           pg_catalog.uuid_send(proof.proof_id) DESC
         LIMIT 1
       ) AS drain ON true
       WHERE dashboard.organization_id = $1::uuid
         AND dashboard.dashboard_id = $2::uuid`,
      [
        t9rOrganization,
        t9rDashboard,
        cleanupAttemptId,
        step,
        result,
        t9rPrincipalId,
        1,
      ],
    );
    const digest = derived.rows[0]?.completion_sha256;
    if (digest === undefined) {
      throw new Error("Task 9 could not derive the cleanup completion proof");
    }
    return digest;
  }

  async function t9rUnconsumedDrainProof(): Promise<Buffer> {
    const derived = await ownerPool.query<{
      readonly drain_proof_sha256: Buffer;
    }>(
      `SELECT proof.drain_proof_sha256
       FROM dasher.dashboard_agent_drain_proofs AS proof
       WHERE proof.organization_id = $1::uuid
         AND proof.dashboard_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1
           FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
           WHERE consumed.organization_id = proof.organization_id
             AND consumed.dashboard_id = proof.dashboard_id
             AND consumed.proof_id = proof.proof_id
         )
       ORDER BY proof.generated_at DESC,
         pg_catalog.uuid_send(proof.proof_id) DESC
       LIMIT 1`,
      [t9rOrganization, t9rDashboard],
    );
    const digest = derived.rows[0]?.drain_proof_sha256;
    if (digest === undefined) {
      throw new Error("Task 9 could not find an unconsumed drain proof");
    }
    return digest;
  }

  // The frozen claim only takes the coordination lease when the current one has
  // expired, so the harness expires it the way a real operator would wait it
  // out. Nothing else about the row is touched.
  async function t9rReleaseLease(): Promise<void> {
    await ownerPool.query(
      `UPDATE dasher.dashboard_cleanup_coordination
       SET lease_expires_at = statement_timestamp() - interval '1 second'
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid
         AND lease_expires_at IS NOT NULL`,
      [t9rOrganization, t9rDashboard],
    );
  }

  // Commit one audit row that spends `operationId` against a different
  // dashboard in the same organization. None of the three functions has a
  // probe that can see it, so it is invisible to every gate and the primary
  // key is what stops the call.
  async function t9rSpend(operationId: string): Promise<void> {
    await ownerPool.query(
      `INSERT INTO dasher.audit_events (
         audit_event_id, organization_id, occurred_at, actor_kind,
         actor_service, authority_revision, request_id, action, target_type,
         target_id, outcome, content_sha256, deployment_revision
       ) VALUES (
         $1::uuid, $2::uuid, transaction_timestamp(), 'service',
         'task9-retention-probe', 1, pg_catalog.gen_random_uuid(),
         'dashboard.cleanup_started', 'dashboard', $3::uuid, 'succeeded',
         pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8')),
         'task9-retention-probe'
       )`,
      [operationId, t9rOrganization, t9rOtherDashboard],
    );
  }

  async function t9rResidue(operationId: string): Promise<{
    readonly audit_rows_for_operation: string;
    readonly drain_proofs: string;
    readonly lifecycle_events_for_operation: string;
    readonly lifecycle_state: string;
    readonly seeded_audit_row_survives: boolean;
  }> {
    const residue = await ownerPool.query<{
      readonly audit_rows_for_operation: string;
      readonly drain_proofs: string;
      readonly lifecycle_events_for_operation: string;
      readonly lifecycle_state: string;
      readonly seeded_audit_row_survives: boolean;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
          WHERE audit_event_id = $1::uuid) AS audit_rows_for_operation,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_lifecycle_events
          WHERE lifecycle_event_id = $1::uuid)
           AS lifecycle_events_for_operation,
         (SELECT pg_catalog.count(*)::text
          FROM dasher.dashboard_agent_drain_proofs
          WHERE organization_id = $2::uuid AND dashboard_id = $3::uuid)
           AS drain_proofs,
         (SELECT dashboard.lifecycle_state FROM dasher.dashboards AS dashboard
          WHERE dashboard.organization_id = $2::uuid
            AND dashboard.dashboard_id = $3::uuid) AS lifecycle_state,
         EXISTS (SELECT 1 FROM dasher.audit_events
           WHERE audit_event_id = $1::uuid
             AND actor_service = 'task9-retention-probe')
           AS seeded_audit_row_survives`,
      [operationId, t9rOrganization, t9rDashboard],
    );
    const row = residue.rows[0];
    if (row === undefined) {
      throw new Error("Task 9 retention residue projection returned no row");
    }
    return row;
  }

  // Install a frozen 0007 body, run the probe against it, and put the 0008
  // body back. The replacement is committed rather than held in an open
  // transaction because the caller has to reach it through its own operator
  // context in a separate transaction; the finally clause restores the
  // corrected body and the phase-8 gate is re-asserted afterwards.
  async function t9rWithFrozenBody(
    routine: string,
    probe: () => Promise<void>,
  ): Promise<void> {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const frozenSource = migrations[6]?.sql ?? "";
    const correctedSource = migrations[7]?.sql ?? "";
    const pattern = new RegExp(
      `^CREATE (?:OR REPLACE )?FUNCTION ${routine.replaceAll(".", "[.]")}\\([\\s\\S]*?^\\$function\\$;`,
      "mu",
    );
    const frozen = pattern.exec(frozenSource)?.[0];
    const corrected = pattern.exec(correctedSource)?.[0];
    if (frozen === undefined || corrected === undefined) {
      throw new Error(`Task 9 could not extract both bodies for ${routine}`);
    }
    try {
      await ownerPool.query(
        frozen.replace("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "),
      );
      await probe();
    } finally {
      await ownerPool.query(corrected);
    }
    const client = await ownerPool.connect();
    try {
      const ownerName = (
        await client.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        )
      ).rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("Task 9 could not resolve the database owner");
      }
      // The corrected body really is back: the phase-8 gate hashes it.
      expect(await canonical0008CatalogMatchesForTests(client, ownerName)).toBe(
        true,
      );
    } finally {
      client.release();
    }
  }

  async function t9rRecordAttempt(
    attemptId: string,
    step: string,
    result: string,
  ): Promise<void> {
    const completionProof = await t9rCleanupCompletionProof(
      attemptId,
      step,
      result,
    );
    await callRetentionAs(
      `SELECT dasher_retention_api.record_dashboard_cleanup_attempt(
         $1::uuid, $2::uuid, $3::text, $4::text, 0, 0, 0, $5::bytea, $6::uuid)`,
      [t9rDashboard, attemptId, step, result, completionProof, t9rOrganization],
    );
  }

  // One full claim/drain/record cycle at a revision, the way the retention
  // operator runs it. Mirrors the frozen sequence exactly: take the lease,
  // drain under it, then close the attempt that the next claim consumes.
  async function t9rDrainCycle(
    revision: number,
    step: string,
    claimId: string,
    drainId: string,
  ): Promise<void> {
    await t9rReleaseLease();
    await t9rClaim(revision, null, claimId);
    const requestProof = await t9rDrainRequestProof(revision, drainId);
    await t9rDrain(revision, requestProof, drainId);
    await t9rRecordAttempt(drainId, step, "succeeded");
  }

  async function t9rPurge(
    revision: number,
    completionProof: Buffer | null,
    operationId: string,
  ): Promise<void> {
    await callRetentionAs(
      `SELECT dasher_retention_api.purge_dashboard(
         $1::uuid, $2::bigint, $3::bytea, $4::uuid, $5::text, $6::uuid)`,
      [
        t9rDashboard,
        revision,
        completionProof,
        operationId,
        t9rDeployment,
        t9rOrganization,
      ],
    );
  }

  async function t9rPurgeState(): Promise<{
    readonly completion_proof: Buffer | null;
    readonly current_step: string;
    readonly lifecycle_revision: string;
    readonly lifecycle_state: string;
  }> {
    const observed = await ownerPool.query<{
      readonly completion_proof: Buffer | null;
      readonly current_step: string;
      readonly lifecycle_revision: string;
      readonly lifecycle_state: string;
    }>(
      `SELECT dashboard.lifecycle_state,
         dashboard.lifecycle_revision::text AS lifecycle_revision,
         coordination.current_step,
         coordination.completion_proof_sha256 AS completion_proof
       FROM dasher.dashboards AS dashboard
       JOIN dasher.dashboard_cleanup_coordination AS coordination
         ON coordination.organization_id = dashboard.organization_id
         AND coordination.dashboard_id = dashboard.dashboard_id
       WHERE dashboard.organization_id = $1::uuid
         AND dashboard.dashboard_id = $2::uuid`,
      [t9rOrganization, t9rDashboard],
    );
    const row = observed.rows[0];
    if (row === undefined) {
      throw new Error("Task 9 lost the dashboard mid-purge");
    }
    return row;
  }

  // The wrapper-only counterfactual. It takes the body 0008 actually installs
  // and removes exactly the four lines of the collision wrapper, leaving every
  // other correction that body carries in place. That isolates the wrapper as
  // the thing under test: for claim_dashboard_cleanup the frozen 0007 body
  // cannot be used as the counterfactual at all, because its ON CONFLICT
  // inference list - the defect Part 2 repairs - makes every call fail with
  // 42P10 long before the audit INSERT.
  function t9rUnwrapAuditInsert(body: string): string {
    const wrapper =
      /^([ ]*)BEGIN\n((?:[ ]*INSERT INTO dasher\.audit_events[\s\S]*?))\n\1EXCEPTION WHEN unique_violation THEN\n\1 {2}RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';\n\1END;$/mu;
    const match = wrapper.exec(body);
    if (match === null) {
      throw new Error("Task 9 could not locate the audit collision wrapper");
    }
    const inner = match[2] ?? "";
    const unwrapped = inner
      .split("\n")
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
      .join("\n");
    // A function replacer, not a string: these bodies use positional $1..$5
    // parameter references, which String.replace would read as capture groups.
    const stripped = body.replace(wrapper, () => unwrapped);
    if (stripped.includes("EXCEPTION WHEN unique_violation")) {
      throw new Error("Task 9 left a collision wrapper behind");
    }
    return stripped;
  }

  async function t9rWithUnwrappedBody(
    routine: string,
    probe: () => Promise<void>,
  ): Promise<void> {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);
    const pattern = new RegExp(
      `^CREATE (?:OR REPLACE )?FUNCTION ${routine.replaceAll(".", "[.]")}\\([\\s\\S]*?^\\$function\\$;`,
      "mu",
    );
    const corrected = pattern.exec(migrations[7]?.sql ?? "")?.[0];
    if (corrected === undefined) {
      throw new Error(`Task 9 could not extract the 0008 body for ${routine}`);
    }
    try {
      await ownerPool.query(t9rUnwrapAuditInsert(corrected));
      await probe();
    } finally {
      await ownerPool.query(corrected);
    }
    const client = await ownerPool.connect();
    try {
      const ownerName = (
        await client.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        )
      ).rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("Task 9 could not resolve the database owner");
      }
      expect(await canonical0008CatalogMatchesForTests(client, ownerName)).toBe(
        true,
      );
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    await closeAppPoolBeforeLoginTeardown();
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }
    await resetManagedSchemas();
    await runMigrations(ownerPool, canonicalMigrationDirectory, []);

    const fixture = await ownerPool.connect();
    try {
      await fixture.query("BEGIN");
      await fixture.query(
        `INSERT INTO dasher.users (user_id, created_at)
         VALUES ($1::uuid, transaction_timestamp())`,
        [t9rUserId],
      );
      await fixture.query(
        `INSERT INTO dasher.organizations (organization_id, display_name)
         VALUES ($1::uuid, 'Task 9 retention collision organization')`,
        [t9rOrganization],
      );
      await fixture.query(
        `INSERT INTO dasher.dashboard_lifecycle_policies (
           organization_id, policy_revision, default_disposable_ttl_seconds,
           retention_policy_revision, created_at, created_by_user_id,
           provenance
         ) VALUES ($1::uuid, 1, 86400, 1, transaction_timestamp(), $2::uuid,
           'task9-retention-probe')`,
        [t9rOrganization, t9rUserId],
      );
      await fixture.query(
        `INSERT INTO dasher.dashboard_tombstones (
           organization_id, tombstone_lineage_id, retention_policy_revision,
           access_revoked_at, access_revoked_lifecycle_revision,
           access_revoked_proof_sha256
         )
         SELECT $1::uuid, lineage, 1,
           transaction_timestamp() - interval '48 hours', $2::bigint,
           pg_catalog.sha256(pg_catalog.convert_to('revoked', 'UTF8'))
         FROM (VALUES ($3::uuid), ($4::uuid)) AS t(lineage)`,
        [t9rOrganization, t9rBaseRevision, t9rLineage, t9rOtherLineage],
      );
      // Both dashboards are 'access_revoked' and past their purge_after, which
      // is the state the cleanup claim, the drain and the purge all start from.
      await fixture.query(
        `INSERT INTO dasher.dashboards (
           organization_id, dashboard_id, title, created_by_user_id, created_at,
           created_kind, current_kind, lifecycle_state, lifecycle_revision,
           capability_epoch, cache_epoch, access_revoked_at, revocation_reason,
           purge_after, retention_policy_revision, tombstone_lineage_id
         )
         SELECT $1::uuid, dash, 'Task 9 retention collision probe', $2::uuid,
           transaction_timestamp() - interval '30 days',
           'durable', 'durable', 'access_revoked', $3::bigint, 1, 1,
           transaction_timestamp() - interval '48 hours', 'explicit_delete',
           transaction_timestamp() - interval '24 hours', 1, lineage
         FROM (VALUES ($4::uuid, $5::uuid), ($6::uuid, $7::uuid))
              AS t(dash, lineage)`,
        [
          t9rOrganization,
          t9rUserId,
          t9rBaseRevision,
          t9rDashboard,
          t9rLineage,
          t9rOtherDashboard,
          t9rOtherLineage,
        ],
      );
      await fixture.query(
        `INSERT INTO dasher.dashboard_cleanup_coordination (
           organization_id, dashboard_id, current_step,
           expected_lifecycle_revision
         )
         SELECT $1::uuid, dash, 'access_revoked', $2::bigint
         FROM (VALUES ($3::uuid), ($4::uuid)) AS t(dash)`,
        [t9rOrganization, t9rBaseRevision, t9rDashboard, t9rOtherDashboard],
      );
      const ownerName = (
        await fixture.query<{ readonly owner_name: string }>(
          "SELECT session_user::text AS owner_name",
        )
      ).rows[0]?.owner_name;
      if (ownerName === undefined) {
        throw new Error("Task 9 could not resolve the database owner");
      }
      await fixture.query(
        `INSERT INTO dasher.retention_service_principal_allowlist (
           retention_service_principal_id, principal_revision, binding_kind,
           binding_subject, authority_scope, scope_organization_id,
           can_initialize, can_materialize_expiry, can_place_hold,
           can_release_hold, can_claim_cleanup, can_record_attempt, can_purge,
           enabled, created_at, predecessor_revision, predecessor_sha256,
           revision_sha256, migration_provenance
         ) VALUES (
           $1::uuid, 1, 'postgres_session_user', $2::name, 'platform_operator',
           NULL, true, true, true, true, true, true, true, true,
           transaction_timestamp(), NULL, NULL,
           pg_catalog.decode(pg_catalog.repeat('9b', 32), 'hex'),
           'task9-retention-probe'
         )`,
        [t9rPrincipalId, ownerName],
      );
      await fixture.query("COMMIT");
    } catch (error) {
      await fixture.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    // Take the lease the drain requires. This claim transitions nothing - it
    // carries no drain proof - so it writes no audit row and spends no
    // audit_event_id on the path under test.
    await t9rClaim(
      t9rBaseRevision,
      null,
      "9b000000-0000-4000-8000-0000000000a0",
    );
  }, 180_000);

  // dasher_retention_api.drain_dashboard_agent_runs. On the first-drain path
  // there is no audit probe at all, so a uuid spent by another dashboard's
  // audit row passes every gate and only the primary key refuses it.
  it("normalizes a cross-scope drain collision at the audit INSERT and leaves no residue", async () => {
    const operationId = "9b000000-0000-4000-8000-0000000000b1";
    await t9rSpend(operationId);
    const requestProof = await t9rDrainRequestProof(
      t9rBaseRevision,
      operationId,
    );
    await expect(
      t9rDrain(t9rBaseRevision, requestProof, operationId),
    ).rejects.toMatchObject({ code: "P1002", message: "dasher_conflict" });
    const residue = await t9rResidue(operationId);
    expect(residue).toEqual({
      audit_rows_for_operation: "1",
      drain_proofs: "0",
      lifecycle_events_for_operation: "0",
      lifecycle_state: "access_revoked",
      seeded_audit_row_survives: true,
    });
  }, 60_000);

  // The counterfactual: with frozen 0007's body installed, the very same call
  // surfaces the bare uniqueness failure the plan forbids, constraint name and
  // all. The 0008 body is restored afterwards and the phase-8 gate re-checked.
  it("surfaces a raw 23505 from the frozen 0007 drain body", async () => {
    const operationId = "9b000000-0000-4000-8000-0000000000b2";
    await t9rSpend(operationId);
    const requestProof = await t9rDrainRequestProof(
      t9rBaseRevision,
      operationId,
    );
    await t9rWithFrozenBody(
      "dasher_retention_api.drain_dashboard_agent_runs",
      async () => {
        await expect(
          t9rDrain(t9rBaseRevision, requestProof, operationId),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "audit_events_pkey",
        });
      },
    );
    const residue = await t9rResidue(operationId);
    expect(residue.drain_proofs).toBe("0");
    expect(residue.audit_rows_for_operation).toBe("1");
  }, 60_000);

  // The happy path is unchanged: an unspent operation id drains, writes its
  // proof and writes its audit row.
  it("drains normally on an unspent operation id", async () => {
    const operationId = "9b000000-0000-4000-8000-0000000000b3";
    const requestProof = await t9rDrainRequestProof(
      t9rBaseRevision,
      operationId,
    );
    await t9rDrain(t9rBaseRevision, requestProof, operationId);
    const residue = await t9rResidue(operationId);
    expect(residue).toEqual({
      audit_rows_for_operation: "1",
      drain_proofs: "1",
      lifecycle_events_for_operation: "0",
      lifecycle_state: "access_revoked",
      seeded_audit_row_survives: false,
    });
    const written = await ownerPool.query<{ readonly action: string }>(
      "SELECT action FROM dasher.audit_events WHERE audit_event_id = $1::uuid",
      [operationId],
    );
    expect(written.rows[0]?.action).toBe("dashboard.agent_runs_drained");
  }, 60_000);

  // dasher_retention_api.claim_dashboard_cleanup reaches its audit INSERT only
  // when it transitions the dashboard, which needs the drain proof the step
  // above produced and the successful cleanup attempt that closed it. Both are
  // recorded here through the frozen entry points, so the claim below is
  // reached through the real chain.
  it("records the cleanup attempt that closes the drain", async () => {
    const attemptId = "9b000000-0000-4000-8000-0000000000b3";
    const completionProof = await t9rCleanupCompletionProof(
      attemptId,
      "drain_and_cancel",
      "succeeded",
    );
    await callRetentionAs(
      `SELECT dasher_retention_api.record_dashboard_cleanup_attempt(
         $1::uuid, $2::uuid, 'drain_and_cancel', 'succeeded', 0, 0, 0,
         $3::bytea, $4::uuid)`,
      [t9rDashboard, attemptId, completionProof, t9rOrganization],
    );
    const attempts = await ownerPool.query<{ readonly result: string }>(
      `SELECT result FROM dasher.dashboard_cleanup_attempts
       WHERE organization_id = $1::uuid AND dashboard_id = $2::uuid`,
      [t9rOrganization, t9rDashboard],
    );
    expect(attempts.rows.map((row) => row.result)).toEqual(["succeeded"]);
  }, 60_000);

  it("normalizes a cross-scope claim collision at the audit INSERT and leaves no residue", async () => {
    const operationId = "9b000000-0000-4000-8000-0000000000c1";
    await t9rSpend(operationId);
    const drainProof = await t9rUnconsumedDrainProof();
    await t9rReleaseLease();
    await expect(
      t9rClaim(t9rBaseRevision, drainProof, operationId),
    ).rejects.toMatchObject({ code: "P1002", message: "dasher_conflict" });
    const residue = await t9rResidue(operationId);
    expect(residue).toEqual({
      audit_rows_for_operation: "1",
      drain_proofs: "1",
      lifecycle_events_for_operation: "0",
      lifecycle_state: "access_revoked",
      seeded_audit_row_survives: true,
    });
  }, 60_000);

  it("surfaces a raw 23505 from the unwrapped claim body", async () => {
    const operationId = "9b000000-0000-4000-8000-0000000000c2";
    await t9rSpend(operationId);
    const drainProof = await t9rUnconsumedDrainProof();
    await t9rReleaseLease();
    await t9rWithUnwrappedBody(
      "dasher_retention_api.claim_dashboard_cleanup",
      async () => {
        await expect(
          t9rClaim(t9rBaseRevision, drainProof, operationId),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "audit_events_pkey",
        });
      },
    );
    const residue = await t9rResidue(operationId);
    expect(residue.lifecycle_state).toBe("access_revoked");
    expect(residue.audit_rows_for_operation).toBe("1");
  }, 60_000);

  it("claims and transitions normally on an unspent operation id", async () => {
    const operationId = "9b000000-0000-4000-8000-0000000000c3";
    const drainProof = await t9rUnconsumedDrainProof();
    await t9rReleaseLease();
    await t9rClaim(t9rBaseRevision, drainProof, operationId);
    const residue = await t9rResidue(operationId);
    expect(residue).toEqual({
      audit_rows_for_operation: "1",
      drain_proofs: "1",
      lifecycle_events_for_operation: "1",
      lifecycle_state: "quarantined",
      seeded_audit_row_survives: false,
    });
    const written = await ownerPool.query<{ readonly action: string }>(
      "SELECT action FROM dasher.audit_events WHERE audit_event_id = $1::uuid",
      [operationId],
    );
    expect(written.rows[0]?.action).toBe("dashboard.cleanup_started");
  }, 60_000);

  // dasher_retention_api.purge_dashboard. Its audit INSERT is on the last pass
  // of the frozen multi-pass traversal, so the dashboard is walked there
  // through the real chain and the probes are taken at exactly that pass -
  // identified, as the frozen body identifies it, by the coordination row
  // standing at 'final_proof_ready' with its completion proof present.
  it("normalizes a cross-scope purge collision on the final pass and completes on an unspent id", async () => {
    const collisionId = "9b000000-0000-4000-8000-0000000000d1";
    const counterfactualId = "9b000000-0000-4000-8000-0000000000d2";
    await t9rSpend(collisionId);
    await t9rSpend(counterfactualId);

    // quarantined@6 -> purge_eligible@7, then one more drain and consumption at
    // revision 7, which is what purge_dashboard's own gate requires.
    await t9rDrainCycle(
      6,
      "prepare_finalizers",
      "9b000000-0000-4000-8000-0000000000d3",
      "9b000000-0000-4000-8000-0000000000d4",
    );
    const purgeEligibleProof = await t9rUnconsumedDrainProof();
    await t9rReleaseLease();
    await t9rClaim(
      6,
      purgeEligibleProof,
      "9b000000-0000-4000-8000-0000000000d5",
    );
    await t9rDrainCycle(
      7,
      "purge_finalizing",
      "9b000000-0000-4000-8000-0000000000d6",
      "9b000000-0000-4000-8000-0000000000d7",
    );
    const finalDrainProof = await t9rUnconsumedDrainProof();
    await t9rReleaseLease();
    await t9rClaim(7, finalDrainProof, "9b000000-0000-4000-8000-0000000000d8");

    const trace: string[] = [];
    let probedFinalPass = false;
    let pass = 0;
    for (;;) {
      pass += 1;
      if (pass > 40) {
        throw new Error(`Task 9 purge traversal did not converge: ${trace}`);
      }
      const state = await t9rPurgeState();
      trace.push(
        `${state.lifecycle_state}@${state.lifecycle_revision}/${state.current_step}`,
      );
      if (state.lifecycle_state === "cleaned") {
        break;
      }
      const revision = Number(state.lifecycle_revision);
      if (state.completion_proof === null) {
        const attemptId = randomUUID();
        await t9rReleaseLease();
        await t9rClaim(revision, null, attemptId);
        await t9rRecordAttempt(attemptId, "purge_finalizing", "succeeded");
        continue;
      }
      if (state.current_step === "final_proof_ready" && !probedFinalPass) {
        probedFinalPass = true;
        // (a) The collision. Every gate above passes - the spent uuid belongs
        // to another dashboard's audit row and nothing here can see it - so
        // the whole purge runs and the audit INSERT is what refuses.
        await expect(
          t9rPurge(revision, state.completion_proof, collisionId),
        ).rejects.toMatchObject({ code: "P1002", message: "dasher_conflict" });
        // Nothing partial survives: the dashboard is still purge_eligible and
        // the coordination row is exactly where the failed pass found it.
        const afterCollision = await t9rPurgeState();
        expect(afterCollision).toMatchObject({
          current_step: "final_proof_ready",
          lifecycle_revision: state.lifecycle_revision,
          lifecycle_state: "purge_eligible",
        });
        expect((await t9rResidue(collisionId)).audit_rows_for_operation).toBe(
          "1",
        );

        // (b) The counterfactual, on the same pass.
        await t9rWithUnwrappedBody(
          "dasher_retention_api.purge_dashboard",
          async () => {
            await expect(
              t9rPurge(revision, state.completion_proof, counterfactualId),
            ).rejects.toMatchObject({
              code: "23505",
              constraint: "audit_events_pkey",
            });
          },
        );
        expect(await t9rPurgeState()).toMatchObject({
          current_step: "final_proof_ready",
          lifecycle_state: "purge_eligible",
        });
      }
      await t9rPurge(revision, state.completion_proof, randomUUID());
    }

    // (c) The happy path: the traversal reached 'cleaned' with the last pass
    // run on an unspent id, so neither probe changed what the purge does.
    expect(probedFinalPass).toBe(true);
    const purged = await ownerPool.query<{
      readonly lifecycle_state: string;
      readonly purged_at_set: boolean;
      readonly purged_audit_rows: string;
    }>(
      `SELECT dashboard.lifecycle_state,
         dashboard.purged_at IS NOT NULL AS purged_at_set,
         (SELECT pg_catalog.count(*)::text FROM dasher.audit_events
          WHERE organization_id = $1::uuid AND action = 'dashboard.purged'
            AND target_id = $2::uuid) AS purged_audit_rows
       FROM dasher.dashboards AS dashboard
       WHERE dashboard.organization_id = $1::uuid
         AND dashboard.dashboard_id = $2::uuid`,
      [t9rOrganization, t9rDashboard],
    );
    expect(purged.rows[0]).toEqual({
      lifecycle_state: "cleaned",
      purged_at_set: true,
      purged_audit_rows: "1",
    });
  }, 180_000);

  afterAll(async () => {
    await resetManagedSchemas();
  }, 120_000);
});

// The installed shape of every audit-event-id collision wrapper 0008 issues.
//
// Four of the five wrapped routines are proven behaviourally elsewhere in this
// file: the age-out, the cleanup claim, the agent-run drain and the dashboard
// purge each get a live cross-scope collision, a residue check and a
// counterfactual. The fifth, dasher_api.request_agent_run, is not reachable
// from a seeded fixture without also building the field-catalog snapshot,
// metric-contract and evidence layers its frozen validators demand, so it is
// pinned here structurally instead: the definition PostgreSQL actually
// installed has to carry the wrapper, in the right place, around the right
// statement, and nowhere else. The unit suite carries the matching mechanical
// proof that the 0008 body is the frozen 0007 body plus exactly those four
// lines.
describe.sequential("Task 9 audit collision wrapper installed shape", () => {
  const wrappedRoutines = [
    "dasher_api.request_agent_run",
    "dasher_retention_api.claim_dashboard_cleanup",
    "dasher_retention_api.drain_dashboard_agent_runs",
    "dasher_retention_api.purge_dashboard",
    "dasher_retention_api.age_out_dashboard_agent_run_metadata",
  ] as const;

  beforeAll(async () => {
    await closeAppPoolBeforeLoginTeardown();
    if (appLoginCreated) {
      await dropTemporaryAppLogin(
        ownerPool,
        config.appDatabase,
        config.appUsername,
      );
      appLoginCreated = false;
    }
    await resetManagedSchemas();
    await runMigrations(ownerPool, canonicalMigrationDirectory, []);
  }, 180_000);

  afterAll(async () => {
    await resetManagedSchemas();
  }, 120_000);

  it.each(wrappedRoutines)(
    "installs exactly one audit-INSERT collision wrapper in %s",
    async (routine) => {
      const installed = await ownerPool.query<{ readonly definition: string }>(
        `SELECT pg_catalog.pg_get_functiondef(routine.oid) AS definition
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname || '.' || routine.proname = $1::text`,
        [routine],
      );
      expect(installed.rows).toHaveLength(1);
      const definition = installed.rows[0]?.definition ?? "";

      // Exactly one wrapper, and it is the collision wrapper.
      expect(
        definition.match(/EXCEPTION WHEN unique_violation THEN/gu),
      ).toHaveLength(1);
      expect(
        definition.match(
          /EXCEPTION WHEN unique_violation THEN\n[ ]*RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';\n[ ]*END;/gu,
        ),
      ).toHaveLength(1);

      // It wraps the audit INSERT and nothing else: the block opens
      // immediately before that INSERT and closes immediately after its
      // terminator, with no other statement inside it.
      const block =
        /^([ ]*)BEGIN\n(\1[ ]{2}INSERT INTO dasher\.audit_events \((?:.|\n)*?)\n\1EXCEPTION WHEN unique_violation THEN\n\1[ ]{2}RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';\n\1END;$/mu.exec(
          definition,
        );
      expect(block).not.toBeNull();
      const body = block?.[2] ?? "";
      expect(body.trimEnd()).toMatch(/\);$/u);
      // One statement: the only semicolon in the block terminates the INSERT.
      expect(body.match(/;/gu)).toHaveLength(1);
      // And no row mark was pulled inside the subtransaction with it.
      expect(body).not.toMatch(/FOR (?:UPDATE|KEY SHARE|SHARE|NO KEY UPDATE)/u);

      // dasher_api.request_agent_run has no live collision probe in this file,
      // so its own guarantee is spelled out here: the routine is still
      // SECURITY DEFINER over the same audit relation the wrapped INSERT
      // writes, and the wrapper is the last thing before the result is built.
      if (routine === "dasher_api.request_agent_run") {
        expect(definition).toContain("SECURITY DEFINER");
        expect(definition).toMatch(/END;\n\n[ ]*v_result := ROW\(/u);
      }
    },
    60_000,
  );
});

// Part 10's collision wrapper on dasher_api.cancel_agent_run, exercised as a
// live race rather than as installed text.
//
// The frozen body's defence was an advisory lock plus a global probe over
// dasher.audit_events. Neither closes the hole this covers. The advisory key is
// 'dasher:agent-run-cancel-operation:v1|' || <operation id>, so it orders cancel
// against cancel and against nothing else: dasher.audit_events.audit_event_id is
// one global primary key, and the other five frozen entry points spend it from
// their own caller-supplied parameters under no such key. A writer that is not a
// cancel therefore never waits on that lock, and the probe cannot see its row
// until it commits, so the id is spent between the probe and the INSERT.
//
// The competing writer here is a direct INSERT into dasher.audit_events, held
// open in its own transaction. That is deliberate and is the strongest available
// stand-in for dasher_api.request_agent_run, which this file already documents
// as unreachable from a seeded fixture without also building the field-catalog,
// metric-contract and evidence layers its frozen validators demand. What reaches
// the cancel is identical either way - a concurrently committed row holding that
// primary key - and the substitution is conservative in the direction that
// matters: the stand-in takes no lock in the cancel namespace at all, which is
// exactly the cross-entry-point condition being reproduced. The lock-witness
// assertion below proves that, rather than assuming it.
//
// Four cases, and the first two are what stop the last two from being vacuous:
//   (a) an unspent id cancels successfully, so the fixture provably reaches and
//       passes the audit INSERT;
//   (b) an id already committed before the call is refused by the frozen probe,
//       so the lock and the probe still stand as defence in depth;
//   (c) and (d) an id spent by a concurrent uncommitted transaction is refused
//       by the wrapper, at READ COMMITTED and at REPEATABLE READ. The probe
//       cannot see the competing row in either case - it is uncommitted when the
//       probe runs - so the INSERT is what raises, and the distinct error code
//       from (b) is what proves which of the two paths fired.
describe.sequential(
  "Task 9 cancel_agent_run audit collision concurrency",
  () => {
    const cancelReason =
      '{"reason":"user_requested","schema":"run-cancel-reason-v1"}';
    const cancelDeployment = "task9-cancel-race";
    let actor: Task4Actor;
    const counterfactualDashboardId = randomUUID();
    const raceDashboardId = randomUUID();
    const counterfactualRunId = randomUUID();
    const raceRunId = randomUUID();

    // The policy digest is derived from the installed validator rather than from a
    // re-typed copy of its preimage: dasher_private.validate_agent_run_policy_chain_v1
    // recomputes it over every revision and the cancel refuses the whole call if it
    // disagrees, so a hand-copied preimage that drifted would silently turn this
    // fixture into a P1001 test of nothing.
    async function policySha256Expression(): Promise<string> {
      const definition = (
        await ownerPool.query<{ readonly definition: string }>(
          "SELECT pg_catalog.pg_get_functiondef('dasher_private.validate_agent_run_policy_chain_v1()'::regprocedure) AS definition",
        )
      ).rows[0]?.definition;
      if (definition === undefined) {
        throw new Error("the policy chain validator is not installed");
      }
      const opener = "v_expected_sha := pg_catalog.sha256(";
      const start = definition.indexOf(opener);
      const end = definition.indexOf("\n    );", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return definition
        .slice(start + "v_expected_sha := ".length, end + "\n    )".length)
        .replaceAll("v_revision.", "policy.");
    }

    async function seedAgentRun(
      dashboardId: string,
      runId: string,
    ): Promise<void> {
      await ownerPool.query(
        `INSERT INTO dasher.agent_runs (
         organization_id, dashboard_id, run_id, run_request_id,
         requesting_user_id, requesting_membership_id,
         requesting_authority_revision, policy_revision, requested_at, state,
         run_revision, current_event_sequence, current_event_sha256, lease_epoch
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1, 1,
         transaction_timestamp(), 'requested', 1, 1,
         pg_catalog.sha256(pg_catalog.convert_to($3::text, 'UTF8')), 0
       )`,
        [
          actor.organizationId,
          dashboardId,
          runId,
          randomUUID(),
          actor.userId,
          actor.membershipId,
        ],
      );
    }

    async function callCancel(
      client: PoolClient,
      runId: string,
      auditId: string,
    ): Promise<void> {
      await client.query(
        `SELECT dasher_api.cancel_agent_run(
         $1::uuid, 1::bigint, pg_catalog.convert_to($2::text, 'UTF8'),
         $3::uuid, 1::smallint, $4::bytea, $5::text
       )`,
        [runId, cancelReason, auditId, actor.csrfDigest, cancelDeployment],
      );
    }

    // Commit one audit row holding `auditId`, from a transaction the cancel is not
    // serialized against.
    async function spendAuditId(auditId: string): Promise<void> {
      await ownerPool.query(
        `INSERT INTO dasher.audit_events (
         audit_event_id, organization_id, occurred_at, actor_kind,
         actor_service, authority_revision, request_id, action, target_type,
         target_id, outcome, content_sha256, deployment_revision
       ) VALUES (
         $1::uuid, $2::uuid, transaction_timestamp(), 'service',
         'task9-cancel-race', 1, pg_catalog.gen_random_uuid(),
         'dashboard.agent_run_requested', 'agent_run', $3::uuid, 'succeeded',
         pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8')),
         $4::text
       )`,
        [auditId, actor.organizationId, raceRunId, cancelDeployment],
      );
    }

    async function waitForLockWait(pid: number): Promise<string> {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const waiting = await ownerPool.query<{
          readonly wait_event_type: string | null;
          readonly state: string | null;
        }>(
          `SELECT activity.wait_event_type, activity.state
         FROM pg_catalog.pg_stat_activity AS activity
         WHERE activity.pid = $1::int`,
          [pid],
        );
        const row = waiting.rows[0];
        if (row?.state === "active" && row.wait_event_type === "Lock") {
          return row.wait_event_type;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the cancel never blocked on the audit primary key");
    }

    beforeAll(async () => {
      await closeAppPoolBeforeLoginTeardown();
      if (appLoginCreated) {
        await dropTemporaryAppLogin(
          ownerPool,
          config.appDatabase,
          config.appUsername,
        );
        appLoginCreated = false;
      }
      await resetManagedSchemas();
      await createTemporaryAppLogin(
        ownerPool,
        config.appDsn,
        config.appUsername,
      );
      appLoginCreated = true;
      await runMigrations(ownerPool, canonicalMigrationDirectory, [
        config.appUsername,
      ]);
      appPool = new Pool({ connectionString: config.appDsn, max: 4 });

      const client = await appPool.connect();
      try {
        await client.query("SET ROLE dasher_app");
        actor = await createTask4Actor(client, "admin");
        for (const dashboardId of [
          counterfactualDashboardId,
          raceDashboardId,
        ] as const) {
          await runContextOperation(
            client,
            actor.sessionDigest,
            randomUUID(),
            () =>
              client.query(
                `SELECT * FROM dasher_api.create_dashboard(
                 $1::uuid, 'Task 9 cancel race', 'durable', NULL, false,
                 $2::uuid, $3::uuid, 1::smallint, $4::bytea, $5::text
               )`,
                [
                  dashboardId,
                  randomUUID(),
                  randomUUID(),
                  actor.csrfDigest,
                  cancelDeployment,
                ],
              ),
          );
        }
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }

      await ownerPool.query(
        `WITH candidate AS (
         SELECT 1::bigint AS policy_revision,
           NULL::bigint AS previous_policy_revision,
           NULL::bytea AS previous_policy_sha256, true AS enabled,
           'fake-provider-v1'::text AS adapter_id,
           'fake-model-v1'::text AS model_id,
           'fake-price-book-v1'::text AS price_book_revision,
           0::bigint AS input_token_micros, 0::bigint AS output_token_micros,
           ROW(4,2,1,0,1,20000,8000,8000,20000,8000,24000,36000,32000,120000)
             ::dasher_run_api.attempt_resource_vector
             AS generation_limit_vector,
           ROW(1,0,0,1,0,5000,2000,2000,5000,2000,6000,9000,8000,30000)
             ::dasher_run_api.attempt_resource_vector AS review_limit_vector,
           2::smallint AS active_organization_run_limit,
           1::smallint AS active_dashboard_run_limit,
           2::smallint AS approval_required_dashboard_limit,
           1::smallint AS provider_concurrency_limit,
           0::smallint AS tool_attempt_limit, 1::smallint AS retry_limit,
           pg_catalog.sha256(pg_catalog.convert_to('planner', 'UTF8'))
             AS planner_instructions_sha256,
           pg_catalog.sha256(pg_catalog.convert_to('generator', 'UTF8'))
             AS generator_instructions_sha256,
           pg_catalog.sha256(pg_catalog.convert_to('specialist', 'UTF8'))
             AS specialist_instructions_sha256,
           pg_catalog.sha256(pg_catalog.convert_to('repair', 'UTF8'))
             AS repair_instructions_sha256,
           pg_catalog.sha256(pg_catalog.convert_to('reviewer', 'UTF8'))
             AS reviewer_instructions_sha256
       )
       INSERT INTO dasher.agent_run_policy_revisions (
         policy_revision, previous_policy_revision, previous_policy_sha256,
         policy_sha256, enabled, adapter_id, model_id, price_book_revision,
         input_token_micros, output_token_micros, generation_limit_vector,
         review_limit_vector, active_organization_run_limit,
         active_dashboard_run_limit, approval_required_dashboard_limit,
         provider_concurrency_limit, tool_attempt_limit, retry_limit,
         planner_instructions_sha256, generator_instructions_sha256,
         specialist_instructions_sha256, repair_instructions_sha256,
         reviewer_instructions_sha256, created_at
       )
       SELECT policy.policy_revision, policy.previous_policy_revision,
         policy.previous_policy_sha256, ${await policySha256Expression()},
         policy.enabled, policy.adapter_id, policy.model_id,
         policy.price_book_revision, policy.input_token_micros,
         policy.output_token_micros, policy.generation_limit_vector,
         policy.review_limit_vector, policy.active_organization_run_limit,
         policy.active_dashboard_run_limit,
         policy.approval_required_dashboard_limit,
         policy.provider_concurrency_limit, policy.tool_attempt_limit,
         policy.retry_limit, policy.planner_instructions_sha256,
         policy.generator_instructions_sha256,
         policy.specialist_instructions_sha256,
         policy.repair_instructions_sha256,
         policy.reviewer_instructions_sha256, transaction_timestamp()
       FROM candidate AS policy`,
      );
      // The fixture is worthless if the chain it just wrote does not validate:
      // the cancel calls this and refuses with P1001 when it returns false.
      const chain = await ownerPool.query<{ readonly valid: boolean }>(
        "SELECT dasher_private.validate_agent_run_policy_chain_v1() AS valid",
      );
      expect(chain.rows[0]?.valid).toBe(true);

      await seedAgentRun(counterfactualDashboardId, counterfactualRunId);
      await seedAgentRun(raceDashboardId, raceRunId);
    }, 180_000);

    afterAll(async () => {
      await resetManagedSchemas();
    }, 120_000);

    it("cancels on an unspent audit id, so the fixture reaches the audit INSERT", async () => {
      const auditId = randomUUID();
      const client = await appPool!.connect();
      try {
        await client.query("SET ROLE dasher_app");
        await runContextOperation(
          client,
          actor.sessionDigest,
          randomUUID(),
          () => callCancel(client, counterfactualRunId, auditId),
        );
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }

      const written = await ownerPool.query<{
        readonly action: string;
        readonly state: string;
      }>(
        `SELECT audit.action,
         (SELECT run.state FROM dasher.agent_runs AS run
          WHERE run.organization_id = $2::uuid AND run.run_id = $3::uuid)
           AS state
       FROM dasher.audit_events AS audit
       WHERE audit.audit_event_id = $1::uuid`,
        [auditId, actor.organizationId, counterfactualRunId],
      );
      expect(written.rows[0]).toEqual({
        action: "dashboard.agent_run_cancelled",
        state: "cancelled",
      });
    }, 60_000);

    it("refuses an already-committed audit id at the frozen probe, before any write", async () => {
      const auditId = randomUUID();
      await spendAuditId(auditId);

      const client = await appPool!.connect();
      let raised: unknown;
      try {
        await client.query("SET ROLE dasher_app");
        await runContextOperation(
          client,
          actor.sessionDigest,
          randomUUID(),
          () => callCancel(client, raceRunId, auditId),
        ).catch((error: unknown) => {
          raised = error;
        });
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }

      // The frozen probe sees the committed row and refuses. This is the
      // defence-in-depth half: it is a different code from the wrapper's, which
      // is what makes the concurrent cases below provably wrapper-driven.
      expect(raised).toMatchObject({ code: "P1001", message: "dasher_denied" });
      const untouched = await ownerPool.query<{ readonly state: string }>(
        `SELECT run.state FROM dasher.agent_runs AS run
       WHERE run.organization_id = $1::uuid AND run.run_id = $2::uuid`,
        [actor.organizationId, raceRunId],
      );
      expect(untouched.rows[0]?.state).toBe("requested");
    }, 60_000);

    it.each(["READ COMMITTED", "REPEATABLE READ"] as const)(
      "normalizes a concurrently spent audit id to P1002 at %s",
      async (isolationLevel) => {
        const auditId = randomUUID();
        const competitor = await ownerPool.connect();
        const client = await appPool!.connect();
        let raised: unknown;
        let competitorOpen = false;

        try {
          // The competing writer spends the id and holds it uncommitted, so the
          // cancel's probe cannot see it at any isolation level.
          await competitor.query("BEGIN");
          competitorOpen = true;
          const competitorPid = (
            await competitor.query<{ readonly pid: number }>(
              "SELECT pg_catalog.pg_backend_pid() AS pid",
            )
          ).rows[0]?.pid;
          if (competitorPid === undefined) {
            throw new Error("PostgreSQL did not return the competitor pid");
          }
          await competitor.query(
            `INSERT INTO dasher.audit_events (
             audit_event_id, organization_id, occurred_at, actor_kind,
             actor_service, authority_revision, request_id, action,
             target_type, target_id, outcome, content_sha256,
             deployment_revision
           ) VALUES (
             $1::uuid, $2::uuid, transaction_timestamp(), 'service',
             'task9-cancel-race', 1, pg_catalog.gen_random_uuid(),
             'dashboard.agent_run_requested', 'agent_run', $3::uuid,
             'succeeded',
             pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8')), $4::text
           )`,
            [auditId, actor.organizationId, raceRunId, cancelDeployment],
          );

          await client.query("SET ROLE dasher_app");
          await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
          await client.query(
            `SELECT * FROM dasher_api.initialize_context(
             1::smallint, $1::bytea, $2::uuid
           )`,
            [actor.sessionDigest, randomUUID()],
          );
          // The isolation level is asserted rather than assumed: the whole point
          // of the REPEATABLE READ row is that nothing on the dasher_api path
          // pins it, so a silent downgrade would make that row a duplicate of the
          // READ COMMITTED one.
          const level = await client.query<{
            readonly transaction_isolation: string;
          }>("SHOW transaction_isolation");
          expect(level.rows[0]?.transaction_isolation.toUpperCase()).toBe(
            isolationLevel,
          );
          const cancelPid = (
            await client.query<{ readonly pid: number }>(
              "SELECT pg_catalog.pg_backend_pid() AS pid",
            )
          ).rows[0]?.pid;
          if (cancelPid === undefined) {
            throw new Error("PostgreSQL did not return the cancel backend pid");
          }

          const pending = callCancel(client, raceRunId, auditId).catch(
            (error: unknown) => {
              raised = error;
            },
          );

          // The cancel gets all the way to the audit INSERT and blocks there on
          // the global primary key. Two things follow, and both are asserted: the
          // probe did not refuse it, and the competitor is not waiting on the
          // cancel's advisory lock - it holds no lock in that namespace at all,
          // which is the cross-entry-point hole the wrapper closes.
          await waitForLockWait(cancelPid);
          const advisoryWitness = await ownerPool.query<{
            readonly count: string;
          }>(
            `SELECT pg_catalog.count(*)::text AS count
           FROM pg_catalog.pg_locks AS lock_row
           WHERE lock_row.locktype = 'advisory'
             AND lock_row.pid = $1::int`,
            [competitorPid],
          );
          expect(advisoryWitness.rows[0]?.count).toBe("0");

          await competitor.query("COMMIT");
          competitorOpen = false;
          await pending;
        } finally {
          if (competitorOpen) {
            await competitor.query("ROLLBACK").catch(() => undefined);
          }
          competitor.release();
          // Both statements have to run even when an assertion above threw, or
          // the pooled client goes back dirty and the next row of this it.each
          // fails on a transaction it did not open.
          await client.query("ROLLBACK").catch(() => undefined);
          await client.query("RESET ROLE").catch(() => undefined);
          client.release();
        }

        // The wrapper, not the probe: P1002 / dasher_conflict, with no SQLSTATE
        // 23505, no constraint name and no relation name anywhere in the error.
        expect(raised).toMatchObject({
          code: "P1002",
          message: "dasher_conflict",
        });
        const serialized = JSON.stringify(
          raised,
          Object.getOwnPropertyNames(raised as object),
        );
        expect(serialized).not.toContain("23505");
        expect(serialized).not.toContain("audit_events_pkey");
        expect(serialized).not.toContain("duplicate key");
        expect(serialized).not.toContain("unique constraint");

        // The losing side wrote nothing: the competitor's row is the only one
        // holding that id, and the run is still cancellable.
        const residue = await ownerPool.query<{
          readonly actor_service: string | null;
          readonly state: string;
        }>(
          `SELECT audit.actor_service,
           (SELECT run.state FROM dasher.agent_runs AS run
            WHERE run.organization_id = $2::uuid AND run.run_id = $3::uuid)
             AS state
         FROM dasher.audit_events AS audit
         WHERE audit.audit_event_id = $1::uuid`,
          [auditId, actor.organizationId, raceRunId],
        );
        expect(residue.rows[0]).toEqual({
          actor_service: "task9-cancel-race",
          state: "requested",
        });
      },
      120_000,
    );
  },
);
