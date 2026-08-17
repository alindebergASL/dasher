import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  parsePostgresIntegrationEnv,
  runMigrations,
} from "../src/index.js";
import {
  RequestContextError,
  withRequestContext,
} from "../src/request-context.js";
import {
  baselineMigrationDirectory,
  borrowedClientPool,
  createTemporaryAppLogin,
  createUnprivilegedSchemaOwner,
  dropUnprivilegedSchemaOwner,
  ignoreTeardownShutdown,
} from "./postgres-harness.js";

/**
 * The request context, exercised from TypeScript for the first time.
 *
 * The schema's row-level security has been tested against SQL that set the
 * context by hand. This is the first time the application's own data-access path
 * establishes one, and the property worth proving is not that a correct request
 * works — it is what happens when the context is absent or belongs to somebody
 * else. Row-level security fails open in exactly one direction that matters: if
 * the policies were wrong, or the settings leaked between pooled checkouts, an
 * unauthenticated read would return the table rather than nothing, and every
 * test that only checks the happy path would still be green.
 */

const config = parsePostgresIntegrationEnv(process.env);
// The harness preflights these identifiers against exact patterns before
// interpolating them into DDL, so they are not free-form.
const databaseName = `dasher_test_db_${randomUUID().replaceAll("-", "")}`;
const ownerRole = `dasher_test_owner_${randomUUID().replaceAll("-", "")}`;
const appUsername = `dasher_test_${randomUUID().replaceAll("-", "")}`;

const org = randomUUID();
const otherOrg = randomUUID();
const alice = randomUUID();
const carol = randomUUID();

let operatorPool: Pool;
let ownerPool: Pool;
let appPool: Pool;

const tokens = new Map<string, Buffer>();
const dashboards = new Map<string, string>();

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

beforeAll(async () => {
  operatorPool = new Pool({ connectionString: config.ownerDsn, max: 2 });
  ignoreTeardownShutdown(operatorPool);
  const ownerDsn = await createUnprivilegedSchemaOwner(
    operatorPool,
    config.ownerDsn,
    ownerRole,
    databaseName,
  );
  ownerPool = new Pool({ connectionString: ownerDsn, max: 4 });
  ignoreTeardownShutdown(ownerPool);

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

  const appDsnUrl = new URL(config.appDsn);
  appDsnUrl.pathname = `/${databaseName}`;
  await createTemporaryAppLogin(ownerPool, appDsnUrl.toString(), appUsername);
  const appUrl = new URL(appDsnUrl.toString());
  appUrl.username = appUsername;
  // max: 1 on purpose. One backend, reused for every checkout, is the harshest
  // arrangement for the leak test below: if the context outlived its
  // transaction, the next request would inherit it on the same connection.
  appPool = new Pool({ connectionString: appUrl.toString(), max: 1 });
  ignoreTeardownShutdown(appPool);

  const seed = await ownerPool.connect();
  try {
    await seed.query("BEGIN");
    for (const [organizationId, userId] of [
      [org, alice],
      [otherOrg, carol],
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
         VALUES ($1, $2, $3, 'editor', 'active', 1)`,
        [randomUUID(), organizationId, userId],
      );

      const token = sha256(`session-token:${userId}`);
      tokens.set(userId, token);
      await seed.query(
        `INSERT INTO dasher.sessions
           (session_id, organization_id, user_id, authority_revision,
            token_key_version, token_digest, csrf_key_version, csrf_digest,
            issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
                 now() + interval '30 minutes', now() + interval '12 hours')`,
        [randomUUID(), organizationId, userId, token, sha256(`csrf:${userId}`)],
      );

      const dashboardId = randomUUID();
      dashboards.set(organizationId, dashboardId);
      await seed.query(
        `INSERT INTO dasher.dashboards
           (organization_id, dashboard_id, title, lifecycle_state,
            lifecycle_revision, created_by_user_id)
         VALUES ($1, $2, $3, 'draft', 1, $4)`,
        [
          organizationId,
          dashboardId,
          `dashboard for ${organizationId}`,
          userId,
        ],
      );
    }
    await seed.query("COMMIT");
  } catch (error) {
    await seed.query("ROLLBACK");
    throw error;
  } finally {
    seed.release();
  }
}, 60_000);

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

it("reads the caller's own dashboards once a context is established", async () => {
  const rows = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (client, principal) => {
      expect(principal.organizationId).toBe(org);
      expect(principal.userId).toBe(alice);
      const result = await client.query<{ dashboard_id: string }>(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      return result.rows;
    },
  );

  expect(rows.map((row) => row.dashboard_id)).toStrictEqual([
    dashboards.get(org),
  ]);
});

it("returns no rows at all without a context, rather than every row", async () => {
  // The rows have to exist for this to mean anything. Without this assertion
  // the test passes just as happily against an empty table, so a seeding
  // failure would read as proof that row-level security works.
  const present = await ownerPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM dasher.dashboards",
  );
  expect(Number(present.rows[0]?.count)).toBe(2);

  // The failure this exists to catch: policies absent, mis-scoped, or not
  // enabled, in which case this returns both organizations' dashboards and
  // every happy-path test above still passes.
  const client = await appPool.connect();
  try {
    const result = await client.query(
      "SELECT dashboard_id FROM dasher.dashboards",
    );
    expect(result.rows).toStrictEqual([]);
  } finally {
    client.release();
  }
});

it("does not let one organization read another's, even with a valid context", async () => {
  const rows = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(carol)! },
    async (client) => {
      const result = await client.query<{ dashboard_id: string }>(
        "SELECT dashboard_id FROM dasher.dashboards WHERE dashboard_id = $1",
        [dashboards.get(org)],
      );
      return result.rows;
    },
  );

  // Carol's context is valid; the row is simply not hers. A dashboard id is
  // guessable in a way an org id is not, so this is the shape a real leak takes.
  expect(rows).toStrictEqual([]);
});

it("leaves no context behind on a pooled connection", async () => {
  // `appPool` has max: 1, so this is the same backend Alice just used.
  await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (client) => client.query("SELECT 1"),
  );

  const client = await appPool.connect();
  try {
    const settings = await client.query<{ value: string }>(
      "SELECT current_setting('dasher.context_organization_id', true) AS value",
    );
    // `set_config(..., true)` is transaction-local, so the setting is gone once
    // the transaction ends. If it were session-local instead, the next request
    // on this connection would silently inherit Alice's organization.
    expect(settings.rows[0]?.value ?? null).toBeFalsy();

    const rows = await client.query(
      "SELECT dashboard_id FROM dasher.dashboards",
    );
    expect(rows.rows).toStrictEqual([]);
  } finally {
    client.release();
  }
});

it("refuses a revoked session", async () => {
  const revokedToken = sha256(`revoked:${alice}`);
  await ownerPool.query(
    `INSERT INTO dasher.sessions
       (session_id, organization_id, user_id, authority_revision,
        token_key_version, token_digest, csrf_key_version, csrf_digest,
        issued_at, last_seen_at, idle_expires_at, absolute_expires_at,
        revoked_at, revocation_reason)
     VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
             now() + interval '30 minutes', now() + interval '12 hours',
             now(), 'signed_out')`,
    [randomUUID(), org, alice, revokedToken, sha256(`revoked-csrf:${alice}`)],
  );

  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: revokedToken },
      async (client) => client.query("SELECT 1"),
    ),
  ).rejects.toBeInstanceOf(RequestContextError);
});

it("refuses a token that was never issued", async () => {
  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: sha256("not-a-real-token") },
      async (client) => client.query("SELECT 1"),
    ),
  ).rejects.toMatchObject({ code: "denied" });
});

it("gives the application no direct write path to tenant tables", async () => {
  // Reads go through row-level security; writes go through the SECURITY
  // DEFINER seam, which is where legality, actor identity, and the audit row
  // are enforced together. A direct INSERT grant would let a caller write a
  // history the seam would have refused, so its absence is the design.
  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (client) =>
        client.query(
          `INSERT INTO dasher.dashboards
             (organization_id, dashboard_id, title, lifecycle_state,
              lifecycle_revision, created_by_user_id)
           VALUES ($1, $2, 'direct write', 'draft', 1, $3)`,
          [org, randomUUID(), alice],
        ),
    ),
  ).rejects.toThrow(/permission denied/iu);
});

it("rolls back a seam write when the work throws afterwards", async () => {
  let created: string | undefined;

  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (client) => {
        const result = await client.query<{ dashboard_id: string }>(
          "SELECT dasher_api.create_dashboard($1, $2, $3) AS dashboard_id",
          ["written then abandoned", randomUUID(), "test"],
        );
        created = result.rows[0]?.dashboard_id;
        // A request that fails after its first write must leave nothing. This
        // is the case that makes owning the transaction here rather than
        // handing it to the caller worth the constraint.
        throw new Error("work failed after writing");
      },
    ),
  ).rejects.toThrow("work failed after writing");

  expect(created).toBeDefined();

  const survived = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (client) =>
      client.query(
        "SELECT dashboard_id FROM dasher.dashboards WHERE dashboard_id = $1",
        [created],
      ),
  );
  expect(survived.rows).toStrictEqual([]);
});
