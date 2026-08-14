import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  parsePostgresIntegrationEnv,
  runMigrations,
} from "../src/index.js";
import {
  baselineMigrationDirectory,
  borrowedClientPool,
  createTemporaryAppLogin,
  createUnprivilegedSchemaOwner,
  dropUnprivilegedSchemaOwner,
  executeServerFormattedSql,
} from "./postgres-harness.js";

/**
 * Properties the deployed schema must hold, exercised against a real
 * PostgreSQL server.
 *
 * These are properties, not catalog shape. The previous suite asserted the
 * exact contents of `pg_catalog` against a hand-authored manifest; that
 * apparatus is gone. What matters — and what a manifest could never prove — is
 * that a tenant cannot read another tenant's rows, that a record cannot be
 * rewritten, and that a child row cannot reference a parent in another
 * organization. Those are checked here by trying to do each of them.
 */

const config = parsePostgresIntegrationEnv(process.env);
const appUsername = `dasher_test_${randomUUID().replaceAll("-", "")}`;
const ownerSuffix = randomUUID().replaceAll("-", "");
const ownerRole = `dasher_test_owner_${ownerSuffix}`;
const databaseName = `dasher_test_db_${ownerSuffix}`;

let operatorPool: Pool;
let ownerPool: Pool;
let appPool: Pool;

const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const dashboardA = randomUUID();
const dashboardB = randomUUID();
const versionA = randomUUID();
const snapshotA = randomUUID();
const evidenceA = randomUUID();

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Runs one statement as the application role, authenticated as a real session.
 *
 * Setting the context settings directly no longer establishes anything: they
 * are honoured only alongside a keyed digest that `dasher_api.begin_request`
 * stamps after validating a session token. Passing a null organization or user
 * exercises the no-context path deliberately.
 */
const sessionTokens = new Map<string, Buffer>();

async function asTenant<T>(
  organizationId: string | null,
  userId: string | null,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    if (organizationId !== null && userId !== null) {
      const token = sessionTokens.get(`${organizationId}:${userId}`);
      if (token === undefined) {
        throw new Error(`no seeded session for ${userId}`);
      }
      await client.query(
        "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
        [1, token],
      );
    }
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Re-issues a seeded session at the membership's current authority.
 *
 * A role or state change now advances `authority_revision`, which invalidates
 * every session issued under the old authority — that is the point of it. In
 * production the user signs in again; here the seeded session is moved forward
 * so a test that changes authority does not silently strand every test after
 * it.
 */
async function resyncSessionAuthority(
  organizationId: string,
  userId: string,
): Promise<void> {
  await ownerPool.query(
    `UPDATE dasher.sessions AS s
       SET authority_revision = m.authority_revision
     FROM dasher.memberships AS m
     WHERE m.organization_id = s.organization_id
       AND m.user_id = s.user_id
       AND s.organization_id = $1
       AND s.user_id = $2`,
    [organizationId, userId],
  );
}

async function expectSqlState(
  operation: Promise<unknown>,
  sqlState: string,
): Promise<void> {
  await expect(operation).rejects.toSatisfy(
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === sqlState,
  );
}

beforeAll(async () => {
  // The schema owner is an ordinary role, not the superuser the test database
  // was created with. A superuser bypasses row-level security whatever the
  // catalog says, so these isolation properties would hold vacuously for the
  // owner and hide anything that only an unprivileged deployment suffers.
  operatorPool = new Pool({ connectionString: config.ownerDsn, max: 2 });
  const ownerDsn = await createUnprivilegedSchemaOwner(
    operatorPool,
    config.ownerDsn,
    ownerRole,
    databaseName,
  );
  ownerPool = new Pool({ connectionString: ownerDsn, max: 4 });
  const client = await ownerPool.connect();
  try {
    await bootstrapManagedRoles(client, []);
    await runMigrations(
      borrowedClientPool(client),
      baselineMigrationDirectory,
      [],
    );
  } finally {
    client.release();
  }

  // The application credential keeps its own password from the environment;
  // only the database it points at moves to the one this run provisioned.
  const appDsnUrl = new URL(config.appDsn);
  appDsnUrl.pathname = `/${databaseName}`;
  const appDsn = appDsnUrl.toString();
  await createTemporaryAppLogin(ownerPool, appDsn, appUsername);
  const appUrl = new URL(appDsn);
  appUrl.username = appUsername;
  appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });

  // Seed two organizations as the owner, bypassing tenant policies. Every
  // assertion below then reads through the restricted application role.
  const seed = await ownerPool.connect();
  try {
    await seed.query("BEGIN");
    for (const [organizationId, userId, dashboardId] of [
      [orgA, userA, dashboardA],
      [orgB, userB, dashboardB],
    ] as const) {
      await seed.query(
        "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, $2)",
        [organizationId, `org ${organizationId.slice(0, 8)}`],
      );
      await seed.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
        userId,
      ]);
      await seed.query(
        `INSERT INTO dasher.memberships
           (membership_id, organization_id, user_id, role, state, authority_revision)
         VALUES ($1, $2, $3, 'admin', 'active', 1)`,
        [randomUUID(), organizationId, userId],
      );
      const sessionToken = sha256(`session:${organizationId}:${userId}`);
      sessionTokens.set(`${organizationId}:${userId}`, sessionToken);
      await seed.query(
        `INSERT INTO dasher.sessions
           (session_id, organization_id, user_id, authority_revision,
            token_key_version, token_digest, csrf_key_version, csrf_digest,
            issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
                 now() + interval '30 minutes', now() + interval '12 hours')`,
        [
          randomUUID(),
          organizationId,
          userId,
          sessionToken,
          sha256(`csrf:${organizationId}:${userId}`),
        ],
      );
      await seed.query(
        `INSERT INTO dasher.dashboards
           (organization_id, dashboard_id, title, lifecycle_state,
            lifecycle_revision, created_by_user_id)
         VALUES ($1, $2, $3, 'draft', 1, $4)`,
        [
          organizationId,
          dashboardId,
          `dashboard ${organizationId.slice(0, 8)}`,
          userId,
        ],
      );
    }
    await seed.query(
      `INSERT INTO dasher.dashboard_versions
         (organization_id, dashboard_id, version_id, canonical_spec_bytes,
          canonical_spec_sha256, validation_state, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'valid', $6)`,
      [orgA, dashboardA, versionA, Buffer.from("{}"), sha256("{}"), userA],
    );
    await seed.query(
      `INSERT INTO dasher.source_snapshots
         (organization_id, snapshot_id, source_kind, source_ref, canonical_bytes,
          content_sha256, observed_at, retrieved_at)
       VALUES ($1, $2, 'usgs', 'gauge/11447650', $3, $4, now(), now())`,
      [orgA, snapshotA, Buffer.from("bytes"), sha256("bytes")],
    );
    await seed.query(
      `INSERT INTO dasher.evidence_records
         (organization_id, evidence_id, snapshot_id, evidence_kind, coordinates,
          transformation, content_sha256, observed_at)
       VALUES ($1, $2, $3, 'reading', '/0/gageHeight', 'identity', $4, now())`,
      [orgA, evidenceA, snapshotA, sha256("reading")],
    );
    await seed.query("COMMIT");
  } catch (error) {
    await seed.query("ROLLBACK");
    throw error;
  } finally {
    seed.release();
  }
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  if (operatorPool !== undefined) {
    await dropUnprivilegedSchemaOwner(operatorPool, ownerRole, databaseName, [
      appUsername,
    ]);
    await operatorPool.end();
  }
});

describe("migration application", () => {
  it("is idempotent — a second run applies nothing", async () => {
    const client = await ownerPool.connect();
    try {
      const result = await runMigrations(
        borrowedClientPool(client),
        baselineMigrationDirectory,
        [],
      );
      expect(result.appliedCount).toBe(0);
      expect(result.previouslyAppliedCount).toBe(result.discoveredCount);
    } finally {
      client.release();
    }
  });

  it("records the baseline in the journal with its file checksum", async () => {
    const result = await ownerPool.query<{
      readonly filename: string;
      readonly checksum_sha256: Uint8Array;
    }>("SELECT filename, checksum_sha256 FROM dasher_meta.schema_migrations");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.filename).toBe("0001_baseline.sql");
    expect(result.rows[0]?.checksum_sha256).toHaveLength(32);
  });
});

describe("tenant isolation", () => {
  it("the application role cannot bypass row-level security", async () => {
    const result = await ownerPool.query<{ readonly rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1",
      [appUsername],
    );
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it("no tenant table forces row-level security", async () => {
    // FORCE makes the *table owner* subject to the policies. Every dasher_api
    // function is SECURITY DEFINER and therefore runs as that owner, so FORCE
    // subjects the seam to the very policies it exists to establish:
    // `begin_request` cannot update the session row it is authenticating,
    // because the policy demands a request context that does not exist until
    // `begin_request` finishes. The seam only survives FORCE when its owner is
    // superuser or BYPASSRLS, which a production deployment has no reason to
    // be — and which this suite is no longer, so reintroducing FORCE now
    // breaks these tests outright rather than passing quietly.
    //
    // Reproduced against a NOSUPERUSER NOBYPASSRLS owner: with FORCE the whole
    // seam is dead and `begin_request` raises `dasher_denied` for a valid
    // token, indistinguishable from a wrong password; without it, the seam
    // works and the application role is still confined to its organization.
    const result = await ownerPool.query<{
      readonly relname: string;
    }>(`
      SELECT relation.relname::text AS relname
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'dasher'
        AND relation.relkind = 'r'
        AND relation.relforcerowsecurity
      ORDER BY relation.relname
    `);
    expect(result.rows.map((row) => row.relname)).toEqual([]);
  });

  it("every tenant table still enables row-level security", async () => {
    // Dropping FORCE must not drop RLS. The application role is not the table
    // owner, so policies still apply to it in full; that is what confines a
    // tenant, and it does not depend on FORCE.
    const result = await ownerPool.query<{
      readonly relname: string;
    }>(`
      SELECT relation.relname::text AS relname
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'dasher'
        AND relation.relkind = 'r'
        AND NOT relation.relrowsecurity
      ORDER BY relation.relname
    `);
    expect(result.rows.map((row) => row.relname)).toEqual([]);
  });

  it("leaves nothing behind when it refuses a migration that forces row security", async () => {
    // Refusing is only half the contract. A migrator that reports rejection
    // while committing the rejected schema has not protected anything: the
    // table stays forced, the journal records the migration as applied, and
    // because it is journaled a re-run will not retry it — so the database is
    // stuck refusing forever with no path forward but manual repair.
    const directory = await mkdtemp(join(tmpdir(), "dasher-forced-rls-"));
    await copyFile(
      join(baselineMigrationDirectory, "0001_baseline.sql"),
      join(directory, "0001_baseline.sql"),
    );
    await writeFile(
      join(directory, "0002_adversarial_force.sql"),
      "ALTER TABLE dasher.dashboards FORCE ROW LEVEL SECURITY;\n",
      "utf8",
    );

    const scratch = `dasher_test_db_${randomUUID().replaceAll("-", "")}`;
    const provisioner = await operatorPool.connect();
    try {
      await executeServerFormattedSql(
        provisioner,
        "CREATE DATABASE %I OWNER %I",
        [scratch, ownerRole],
      );
    } finally {
      provisioner.release();
    }

    const url = new URL(config.ownerDsn);
    url.username = ownerRole;
    url.pathname = `/${scratch}`;
    const scratchPool = new Pool({ connectionString: url.toString(), max: 2 });
    const client = await scratchPool.connect();
    try {
      await bootstrapManagedRoles(client, []);
      await expect(
        runMigrations(borrowedClientPool(client), directory, []),
      ).rejects.toSatisfy(
        (error: unknown) =>
          (error as { code?: unknown }).code === "forced_row_security",
      );

      const forced = await client.query<{ readonly relname: string }>(`
        SELECT relation.relname::text AS relname
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'dasher' AND relation.relforcerowsecurity
      `);
      const journal = await client.query<{ readonly filename: string }>(
        "SELECT filename FROM dasher_meta.schema_migrations ORDER BY sequence",
      );

      expect(forced.rows.map((row) => row.relname)).toEqual([]);
      expect(journal.rows.map((row) => row.filename)).toEqual([
        "0001_baseline.sql",
      ]);
    } finally {
      client.release();
      await scratchPool.end();
      const cleanup = await operatorPool.connect();
      try {
        await executeServerFormattedSql(
          cleanup,
          "DROP DATABASE IF EXISTS %I WITH (FORCE)",
          [scratch],
        );
      } finally {
        cleanup.release();
      }
    }
  });

  it("refuses to migrate a database where a tenant table forces row security", async () => {
    // The suite observes the failure directly now that it migrates as an
    // ordinary role. This asserts the second line of defence: the contract is
    // also refused at migration time, where it holds for whatever schema a
    // deployment brings rather than only for the one committed here.
    const client = await ownerPool.connect();
    try {
      await client.query(
        "ALTER TABLE dasher.dashboards FORCE ROW LEVEL SECURITY",
      );
      await expect(
        runMigrations(borrowedClientPool(client), baselineMigrationDirectory),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === "forced_row_security",
      );
    } finally {
      await client.query(
        "ALTER TABLE dasher.dashboards NO FORCE ROW LEVEL SECURITY",
      );
      client.release();
    }
  });

  it("memberships still enables row-level security for the application role", async () => {
    const result = await ownerPool.query<{ readonly relrowsecurity: boolean }>(`
      SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'dasher' AND relation.relname = 'memberships'
    `);
    expect(result.rows[0]?.relrowsecurity).toBe(true);

    const rows = await asTenant(orgA, userA, async (client) =>
      client.query<{ readonly organization_id: string }>(
        "SELECT organization_id FROM dasher.memberships",
      ),
    );
    expect(rows.rows.every((row) => row.organization_id === orgA)).toBe(true);
    expect(rows.rowCount).toBeGreaterThan(0);
  });

  it("reads nothing without a request context", async () => {
    const rows = await asTenant(null, null, async (client) =>
      client.query("SELECT dashboard_id FROM dasher.dashboards"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("cannot establish a context for an organization the user is not in", async () => {
    // Stronger than the property this replaced. A mismatched context used to
    // be establishable and then denied by policy; now it cannot be established
    // at all, because the only route in is a session token and no session
    // pairs this user with that organization. Asserting the pair directly
    // proves the digest binds both halves, not just the user.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
        [1, sessionTokens.get(`${orgA}:${userA}`)],
      );
      await client.query("SELECT set_config($1, $2, true)", [
        "dasher.context_organization_id",
        orgB,
      ]);
      const principal = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_organization_id()::text AS who",
      );
      expect(principal.rows[0]?.who).toBeNull();

      const rows = await client.query(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      expect(rows.rowCount).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("reads only its own organization's dashboards", async () => {
    const rows = await asTenant(orgA, userA, async (client) =>
      client.query<{ readonly dashboard_id: string }>(
        "SELECT dashboard_id FROM dasher.dashboards",
      ),
    );
    expect(rows.rows.map((row) => row.dashboard_id)).toEqual([dashboardA]);
  });

  it("cannot reach another organization's row by naming its primary key", async () => {
    const rows = await asTenant(orgA, userA, async (client) =>
      client.query(
        "SELECT dashboard_id FROM dasher.dashboards WHERE dashboard_id = $1",
        [dashboardB],
      ),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("a membership revoked mid-transaction stops reading immediately", async () => {
    // Revoking before the request would now be caught by `begin_request`,
    // which is earlier and cheaper. The property worth holding is the harder
    // one: a context already established must stop authorizing the moment the
    // membership behind it is revoked, without waiting for the session to
    // expire or the transaction to end.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
        [1, sessionTokens.get(`${orgA}:${userA}`)],
      );
      const before = await client.query(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      expect(before.rowCount).toBe(1);

      await ownerPool.query(
        `UPDATE dasher.memberships
            SET state = 'revoked', revoked_at = now(), updated_at = now(),
                authority_revision = authority_revision + 1
          WHERE organization_id = $1 AND user_id = $2`,
        [orgA, userA],
      );

      const after = await client.query(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      expect(after.rowCount).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
      await ownerPool.query(
        `UPDATE dasher.memberships
            SET state = 'active', revoked_at = NULL, updated_at = now(),
                authority_revision = authority_revision + 1
          WHERE organization_id = $1 AND user_id = $2`,
        [orgA, userA],
      );
      await resyncSessionAuthority(orgA, userA);
    }
  });

  it("a viewer cannot read the audit log, which requires admin", async () => {
    await ownerPool.query(
      `UPDATE dasher.memberships
         SET role = 'viewer', updated_at = now(),
             authority_revision = authority_revision + 1
       WHERE organization_id = $1 AND user_id = $2`,
      [orgA, userA],
    );
    await resyncSessionAuthority(orgA, userA);
    try {
      const rows = await asTenant(orgA, userA, async (client) =>
        client.query("SELECT audit_event_id FROM dasher.audit_events"),
      );
      expect(rows.rowCount).toBe(0);
    } finally {
      await ownerPool.query(
        `UPDATE dasher.memberships
           SET role = 'admin', updated_at = now(),
               authority_revision = authority_revision + 1
         WHERE organization_id = $1 AND user_id = $2`,
        [orgA, userA],
      );
      await resyncSessionAuthority(orgA, userA);
    }
  });

  it("cannot read dasher_private tables through the application role", async () => {
    await expectSqlState(
      asTenant(orgA, userA, async (client) =>
        client.query("SELECT 1 FROM dasher_meta.schema_migrations"),
      ),
      "42501",
    );
  });
});

describe("composite tenant foreign keys", () => {
  it("rejects a version whose dashboard belongs to another organization", async () => {
    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.dashboard_versions
           (organization_id, dashboard_id, version_id, canonical_spec_bytes,
            canonical_spec_sha256, validation_state, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'valid', $6)`,
        [
          orgB,
          dashboardA,
          randomUUID(),
          Buffer.from("{}"),
          sha256("{}"),
          userB,
        ],
      ),
      "23503",
    );
  });

  it("rejects a claim citing evidence from another organization", async () => {
    // `unsupported` on purpose: a `complete` claim must cite something, which
    // is a different property checked below. This isolates the composite
    // foreign key.
    const claimId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.claims
         (organization_id, dashboard_id, version_id, claim_id, json_pointer,
          label, salience, evidence_state, assertion_sha256)
       VALUES ($1, $2, $3, $4, '/pages/0/title', 'observed', 'normal',
               'unsupported', $5)`,
      [orgA, dashboardA, versionA, claimId, sha256("assertion")],
    );

    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.claim_evidence
           (organization_id, dashboard_id, version_id, claim_id, evidence_id, relation)
         VALUES ($1, $2, $3, $4, $5, 'supports')`,
        [orgB, dashboardA, versionA, claimId, evidenceA],
      ),
      "23503",
    );
  });

  it("accepts a claim citing evidence from its own organization", async () => {
    // One transaction, because a `complete` claim and the edge supporting it
    // are checked together at commit: the claim necessarily exists before the
    // edge that supports it.
    const claimId = randomUUID();
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dasher.claims
           (organization_id, dashboard_id, version_id, claim_id, json_pointer,
            label, salience, evidence_state, assertion_sha256)
         VALUES ($1, $2, $3, $4, '/pages/0/sections/0', 'calculated', 'high',
                 'complete', $5)`,
        [orgA, dashboardA, versionA, claimId, sha256("calculated")],
      );
      await client.query(
        `INSERT INTO dasher.claim_evidence
           (organization_id, dashboard_id, version_id, claim_id, evidence_id, relation)
         VALUES ($1, $2, $3, $4, $5, 'supports')`,
        [orgA, dashboardA, versionA, claimId, evidenceA],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const rows = await ownerPool.query(
      "SELECT 1 FROM dasher.claim_evidence WHERE claim_id = $1",
      [claimId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("rejects a complete claim that cites nothing", async () => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dasher.claims
           (organization_id, dashboard_id, version_id, claim_id, json_pointer,
            label, salience, evidence_state, assertion_sha256)
         VALUES ($1, $2, $3, $4, '/pages/0/uncited', 'observed', 'normal',
                 'complete', $5)`,
        [orgA, dashboardA, versionA, randomUUID(), sha256("uncited")],
      );
      await expectSqlState(client.query("COMMIT"), "23514");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});

describe("record immutability", () => {
  it("rejects updating a published dashboard version", async () => {
    await expectSqlState(
      ownerPool.query(
        "UPDATE dasher.dashboard_versions SET validation_state = 'invalid' WHERE version_id = $1",
        [versionA],
      ),
      "55000",
    );
  });

  it("rejects deleting a published dashboard version", async () => {
    await expectSqlState(
      ownerPool.query(
        "DELETE FROM dasher.dashboard_versions WHERE version_id = $1",
        [versionA],
      ),
      "55000",
    );
  });

  it("rejects rewriting an audit event", async () => {
    const auditId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.audit_events
         (audit_event_id, organization_id, actor_kind, actor_user_id,
          authority_revision, request_id, action, target_type, target_id,
          outcome, deployment_revision)
       VALUES ($1, $2, 'user', $3, 1, $4, 'dashboard.created', 'dashboard', $5,
               'succeeded', 'test')`,
      [auditId, orgA, userA, randomUUID(), dashboardA],
    );

    await expectSqlState(
      ownerPool.query(
        "UPDATE dasher.audit_events SET outcome = 'succeeded' WHERE audit_event_id = $1",
        [auditId],
      ),
      "55000",
    );
  });

  it("rejects rewriting a claim", async () => {
    await expectSqlState(
      ownerPool.query(
        "UPDATE dasher.claims SET salience = 'high' WHERE version_id = $1",
        [versionA],
      ),
      "55000",
    );
  });
});

describe("lifecycle invariants", () => {
  it("rejects a draft dashboard that already names a head version", async () => {
    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.dashboards
           (organization_id, dashboard_id, title, lifecycle_state,
            lifecycle_revision, head_version_id, created_by_user_id)
         VALUES ($1, $2, 'bad draft', 'draft', 1, $3, $4)`,
        [orgA, randomUUID(), versionA, userA],
      ),
      "23514",
    );
  });

  it("rejects an archived dashboard with no archived_at", async () => {
    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.dashboards
           (organization_id, dashboard_id, title, lifecycle_state,
            lifecycle_revision, head_version_id, created_by_user_id)
         VALUES ($1, $2, 'bad archive', 'archived', 1, $3, $4)`,
        [orgA, randomUUID(), versionA, userA],
      ),
      "23514",
    );
  });

  it("rejects a lifecycle state outside draft, active, archived", async () => {
    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.dashboards
           (organization_id, dashboard_id, title, lifecycle_state,
            lifecycle_revision, created_by_user_id)
         VALUES ($1, $2, 'expiring', 'expired', 1, $3)`,
        [orgA, randomUUID(), userA],
      ),
      "23514",
    );
  });

  it("rejects a succeeded run that produced no version", async () => {
    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.agent_runs
           (organization_id, run_id, dashboard_id, requested_by_user_id,
            request_text, state, finished_at)
         VALUES ($1, $2, $3, $4, 'river conditions', 'succeeded', now())`,
        [orgA, randomUUID(), dashboardA, userA],
      ),
      "23514",
    );
  });

  it("rejects a running run that already finished", async () => {
    await expectSqlState(
      ownerPool.query(
        `INSERT INTO dasher.agent_runs
           (organization_id, run_id, dashboard_id, requested_by_user_id,
            request_text, state, finished_at)
         VALUES ($1, $2, $3, $4, 'river conditions', 'running', now())`,
        [orgA, randomUUID(), dashboardA, userA],
      ),
      "23514",
    );
  });

  it("accepts a failed run carrying a reason", async () => {
    const runId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.agent_runs
         (organization_id, run_id, dashboard_id, requested_by_user_id,
          request_text, state, failure_reason, attempt_count, finished_at)
       VALUES ($1, $2, $3, $4, 'river conditions', 'failed', 'plan_rejected', 3, now())`,
      [orgA, runId, dashboardA, userA],
    );

    const rows = await ownerPool.query(
      "SELECT state FROM dasher.agent_runs WHERE run_id = $1",
      [runId],
    );
    expect(rows.rowCount).toBe(1);
  });
});
