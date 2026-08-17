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
const expiredTokens = new Map<string, Buffer>();

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

      // Expiry seeds. `sessions_idle_expiry_check` requires
      // `issued_at < idle_expires_at <= absolute_expires_at`, which makes
      // "absolute expired but idle still fresh" a state the table cannot hold:
      // if absolute is past, idle is necessarily past too. So the absolute
      // ceiling is not tested by a rejected row — it is tested below by what
      // `begin_request` refreshes idle expiry TO.
      for (const [label, issued, idle, absolute] of [
        [
          "idle",
          "now() - interval '2 hours'",
          "now() - interval '1 minute'",
          "now() + interval '12 hours'",
        ],
        [
          "expired",
          "now() - interval '3 hours'",
          "now() - interval '2 minutes'",
          "now() - interval '1 minute'",
        ],
      ] as const) {
        const expiredToken = sha256(`${label}-expired:${userId}`);
        expiredTokens.set(`${label}:${organizationId}`, expiredToken);
        await seed.query(
          `INSERT INTO dasher.sessions
             (session_id, organization_id, user_id, authority_revision,
              token_key_version, token_digest, csrf_key_version, csrf_digest,
              issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
           VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, ${issued}, ${issued},
                   ${idle}, ${absolute})`,
          [
            randomUUID(),
            organizationId,
            userId,
            expiredToken,
            sha256(`${label}-csrf:${userId}`),
          ],
        );
      }

      // A live session whose absolute ceiling is nearer than the 30-minute idle
      // refresh window, so the cap is observable.
      const nearCeilingToken = sha256(`near-ceiling:${userId}`);
      expiredTokens.set(`ceiling:${organizationId}`, nearCeilingToken);
      await seed.query(
        `INSERT INTO dasher.sessions
           (session_id, organization_id, user_id, authority_revision,
            token_key_version, token_digest, csrf_key_version, csrf_digest,
            issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
                 now() + interval '2 minutes', now() + interval '5 minutes')`,
        [
          randomUUID(),
          organizationId,
          userId,
          nearCeilingToken,
          sha256(`ceiling-csrf:${userId}`),
        ],
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

/**
 * The handle, and what a callback cannot do with it.
 *
 * These exist because of a reproduction, not a theory. Against a real pool at
 * `max: 1`, a callback that retained its `PoolClient`, and used it after its own
 * transaction had committed and released, executed inside the NEXT request's
 * transaction and read that request's tenant setting. A raw client handed to
 * application code is a cross-tenant execution primitive with a delay on it.
 */

it("rejects a handle used after its own transaction finished", async () => {
  let escaped: Parameters<Parameters<typeof withRequestContext>[2]>[0];

  await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => {
      escaped = handle;
      return handle.query("SELECT 1");
    },
  );

  await expect(escaped!.query("SELECT 1")).rejects.toMatchObject({
    code: "stale_handle",
  });
});

it("rejects an escaped handle even while another tenant holds the connection", async () => {
  // The reproduction, exactly. `appPool` is max: 1, so Carol's transaction runs
  // on the same backend Alice's did. Before the handle was invalidated, Alice's
  // retained reference executed here and read Carol's context.
  let alicesHandle: Parameters<Parameters<typeof withRequestContext>[2]>[0];

  await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => {
      alicesHandle = handle;
      return handle.query("SELECT 1");
    },
  );

  const outcome = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(carol)! },
    async (carolsHandle, principal) => {
      expect(principal.organizationId).toBe(otherOrg);
      const attempt = await alicesHandle!
        .query(
          "SELECT current_setting('dasher.context_organization_id', true) AS org",
        )
        .then(
          (result): { executed: boolean; error?: unknown } => {
            void result;
            return { executed: true };
          },
          (error: unknown): { executed: boolean; error?: unknown } => ({
            executed: false,
            error,
          }),
        );
      // Carol's own handle still works; only the escaped one is dead.
      await carolsHandle.query("SELECT 1");
      return attempt;
    },
  );

  expect(outcome).toMatchObject({ executed: false });
  expect(outcome.error).toMatchObject({ code: "stale_handle" });
});

it("gives the callback no way to release or reach the client", async () => {
  await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => {
      // Structural, not advisory: there is nothing on the handle but `query`.
      expect(Object.keys(handle)).toStrictEqual([
        "query",
        "invalidate",
        "outstanding",
      ]);
      expect((handle as { release?: unknown }).release).toBeUndefined();
      expect((handle as { connection?: unknown }).connection).toBeUndefined();
      return undefined;
    },
  );
});

it.each([
  ["COMMIT", "COMMIT"],
  ["ROLLBACK", "ROLLBACK"],
  ["a nested BEGIN", "BEGIN"],
  ["END", "end"],
  ["a savepoint", "SAVEPOINT sp1"],
])("refuses %s from inside the callback", async (_label, sql) => {
  // A helper that wraps its own work in BEGIN/COMMIT would end the request's
  // transaction early, leaving every later statement with no context and
  // reading zero rows as data.
  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (handle) => handle.query(sql),
    ),
  ).rejects.toMatchObject({ code: "transaction_control" });
});

it("commits a seam write when the work returns, and it is still there afterwards", async () => {
  // The proof the first version of this file never made: it showed that a
  // failing request persists nothing, and never that a succeeding one does.
  // "Nothing was written" passes both ways.
  const created = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => {
      const result = await handle.query<{ dashboard_id: string }>(
        "SELECT dasher_api.create_dashboard($1, $2, $3) AS dashboard_id",
        ["persisted by commit", randomUUID(), "test"],
      );
      return result.rows[0]?.dashboard_id;
    },
  );

  expect(created).toBeDefined();

  const found = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) =>
      handle.query<{ title: string }>(
        "SELECT title FROM dasher.dashboards WHERE dashboard_id = $1",
        [created],
      ),
  );
  expect(found.rows.map((row) => row.title)).toStrictEqual([
    "persisted by commit",
  ]);
});

it("refuses to commit when the callback returns with a query still in flight", async () => {
  let leaked: Promise<unknown> | undefined;
  const dashboardId = randomUUID();

  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (handle) => {
        // Started, deliberately not awaited — the realistic async accident.
        leaked = handle.query(
          "SELECT dasher_api.create_dashboard($1, $2, $3) AS dashboard_id",
          ["written by a leaked promise", dashboardId, "test"],
        );
        return "returned too early";
      },
    ),
  ).rejects.toMatchObject({ code: "operations_outstanding" });

  await leaked?.catch(() => undefined);

  const survived = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) =>
      handle.query(
        "SELECT dashboard_id FROM dasher.dashboards WHERE title = $1",
        ["written by a leaked promise"],
      ),
  );
  expect(survived.rows).toStrictEqual([]);
});

it.each([
  ["an idle-expired session", "idle"],
  ["a fully expired session", "expired"],
])("refuses %s", async (_label, kind) => {
  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: expiredTokens.get(`${kind}:${org}`)! },
      async (handle) => handle.query("SELECT 1"),
    ),
  ).rejects.toMatchObject({ code: "denied" });
});

it("caps the idle refresh at the absolute ceiling rather than extending past it", async () => {
  // `sessions_idle_expiry_check` requires idle <= absolute, so a session that
  // is absolute-expired but idle-fresh cannot exist as a row. The ceiling is
  // therefore enforced at refresh: `begin_request` sets idle to
  // LEAST(now + 30 minutes, absolute_expires_at). Without the LEAST, a session
  // could be renewed indefinitely past its absolute limit — and the row would
  // then violate its own check constraint, so this is also what keeps the
  // refresh legal.
  const before = await ownerPool.query<{ absolute: string; idle: string }>(
    `SELECT absolute_expires_at::text AS absolute, idle_expires_at::text AS idle
       FROM dasher.sessions WHERE token_digest = sha256($1)`,
    [expiredTokens.get(`ceiling:${org}`)!],
  );
  expect(before.rows).toHaveLength(1);

  await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: expiredTokens.get(`ceiling:${org}`)! },
    async (handle) => handle.query("SELECT 1"),
  );

  const after = await ownerPool.query<{ capped: boolean; grew: boolean }>(
    `SELECT idle_expires_at = absolute_expires_at AS capped,
            idle_expires_at > $2::timestamptz AS grew
       FROM dasher.sessions WHERE token_digest = sha256($1)`,
    [expiredTokens.get(`ceiling:${org}`)!, before.rows[0]!.idle],
  );
  // It refreshed (so the session is live) but stopped exactly at the ceiling.
  expect(after.rows[0]?.grew).toBe(true);
  expect(after.rows[0]?.capped).toBe(true);
});

it.each([
  ["a token below the minimum length", Buffer.alloc(8, 1)],
  ["an empty token", Buffer.alloc(0)],
])("refuses %s without reaching the database", async (_label, token) => {
  // Checked locally so a malformed credential never becomes a round trip, and
  // so it is indistinguishable from a well-formed one that is simply wrong.
  await expect(
    withRequestContext(appPool, { tokenKeyVersion: 1, token }, async (handle) =>
      handle.query("SELECT 1"),
    ),
  ).rejects.toMatchObject({ code: "denied" });
});

it("evicts the backend when ROLLBACK fails, and still raises the original error", async () => {
  // A backend whose ROLLBACK failed may still be in a transaction, or be dead.
  // Returning it to the pool carries that state into the next request, so it
  // has to be destroyed — while the caller still sees their own error, not the
  // rollback's.
  const released: unknown[] = [];
  const realClient = await appPool.connect();
  const failingPool = {
    connect: async () =>
      ({
        query: async (sql: string, params?: unknown[]) => {
          if (/^\s*rollback/iu.test(sql)) throw new Error("rollback failed");
          return realClient.query(sql, params);
        },
        release: (reason?: unknown) => released.push(reason),
      }) as never,
  };

  await expect(
    withRequestContext(
      failingPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async () => {
        throw new Error("the request's own failure");
      },
    ),
  ).rejects.toThrow("the request's own failure");

  expect(released).toHaveLength(1);
  expect(released[0]).toBeInstanceOf(Error);
  expect((released[0] as Error).message).toBe("rollback failed");

  await realClient.query("ROLLBACK").catch(() => undefined);
  realClient.release();
});

it("releases exactly once on the ordinary path", async () => {
  const released: unknown[] = [];
  const realClient = await appPool.connect();
  const countingPool = {
    connect: async () =>
      ({
        query: async (sql: string, params?: unknown[]) =>
          realClient.query(sql, params),
        release: (reason?: unknown) => released.push(reason),
      }) as never,
  };

  await withRequestContext(
    countingPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => handle.query("SELECT 1"),
  );

  // The `finally` also calls release; the guard is what keeps it to one.
  expect(released).toStrictEqual([undefined]);
  realClient.release();
});

/**
 * The two escapes from the leading-keyword check, found by probe at 5068a4e.
 *
 * Both are asserted on outcome, not just on the block. "It threw" is the weaker
 * claim; what matters is that the transaction still belonged to its owner
 * afterwards — the write neither vanished under a reported success nor became
 * durable ahead of one.
 */

it("refuses ABORT, the documented synonym for ROLLBACK", async () => {
  // Before `abort` was listed: the callback issued ABORT, returned normally,
  // the wrapper reported success, and the write was gone. A caller had no way
  // to know their request had been discarded.
  const title = `abort-probe-${randomUUID()}`;

  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (handle) => {
        await handle.query(
          "SELECT dasher_api.create_dashboard($1, $2, $3) AS dashboard_id",
          [title, randomUUID(), "test"],
        );
        return handle.query("ABORT");
      },
    ),
  ).rejects.toMatchObject({ code: "transaction_control" });

  // The request failed, so nothing persisted — and, crucially, the caller was
  // told it failed rather than being handed a success over a discarded write.
  const after = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) =>
      handle.query(
        "SELECT dashboard_id FROM dasher.dashboards WHERE title = $1",
        [title],
      ),
  );
  expect(after.rows).toStrictEqual([]);
});

it("refuses a second statement smuggled after a first", async () => {
  // `pg` sends a parameterless query over the simple protocol, which runs every
  // statement in the string. Before this rule, `SELECT 1; COMMIT` committed the
  // request's transaction early and the write survived outside the wrapper's
  // control — durable ahead of a success the wrapper had not yet decided on.
  const title = `multi-statement-probe-${randomUUID()}`;

  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (handle) => {
        await handle.query(
          "SELECT dasher_api.create_dashboard($1, $2, $3) AS dashboard_id",
          [title, randomUUID(), "test"],
        );
        return handle.query("SELECT 1; COMMIT");
      },
    ),
  ).rejects.toMatchObject({ code: "transaction_control" });

  const after = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) =>
      handle.query(
        "SELECT dashboard_id FROM dasher.dashboards WHERE title = $1",
        [title],
      ),
  );
  expect(after.rows).toStrictEqual([]);
});

it.each([
  ["ABORT with a trailing semicolon", "ABORT;"],
  ["a leading-whitespace ABORT", "   abort"],
  ["ROLLBACK TO SAVEPOINT", "ROLLBACK TO SAVEPOINT sp1"],
  ["a statement pair with no transaction keyword", "SELECT 1; SELECT 2"],
  ["a trailing statement after a semicolon and newline", "SELECT 1;\nCOMMIT"],
])("also refuses %s", async (_label, sql) => {
  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (handle) => handle.query(sql),
    ),
  ).rejects.toMatchObject({ code: "transaction_control" });
});

it("still allows an ordinary statement with a conventional trailing semicolon", async () => {
  // The multi-statement rule must not make normal SQL unusable; a single
  // trailing semicolon is how a great many callers write a query.
  const result = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => handle.query<{ one: number }>("SELECT 1 AS one;"),
  );
  expect(result.rows[0]?.one).toBe(1);
});

/**
 * Forging the request context directly.
 *
 * The guard above stops a callback taking the transaction. This asks the next
 * question: the row-level-security predicate reads five settings, and
 * `set_config` is an ordinary statement the handle allows — so can a callback
 * simply write Carol's organization into them and read her rows?
 *
 * It cannot, and the reason is the fifth setting. `begin_request` stores a
 * digest over user, organization, session, authority revision, and the
 * transaction id, computed by a `SECURITY DEFINER` function whose key the
 * application role cannot reach. `context_allows` recomputes and compares it, so
 * a forged field invalidates the whole context rather than replacing one part of
 * it. These are the negative tests for that claim; without them it is an
 * argument from reading the schema.
 */

it("cannot compute a context digest as the application role", async () => {
  // The keyed function is the root of the whole construction. If the app role
  // could call it, every other assertion here would be worthless.
  await expect(
    withRequestContext(
      appPool,
      { tokenKeyVersion: 1, token: tokens.get(alice)! },
      async (handle) =>
        handle.query(
          "SELECT dasher_private.context_digest($1, $2, $3, 1, '0') AS digest",
          [carol, otherOrg, randomUUID()],
        ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});

it("cannot read another tenant by overwriting every context setting", async () => {
  // The full forgery: inside Alice's legitimate transaction, replace all five
  // settings with Carol's values plus an invented digest, then go looking for
  // Carol's dashboard by its id.
  const rows = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => {
      await handle.query(
        "SELECT set_config('dasher.context_user_id', $1, true)",
        [carol],
      );
      await handle.query(
        "SELECT set_config('dasher.context_organization_id', $1, true)",
        [otherOrg],
      );
      await handle.query(
        "SELECT set_config('dasher.context_session_id', $1, true)",
        [randomUUID()],
      );
      await handle.query(
        "SELECT set_config('dasher.context_authority', '1', true)",
      );
      await handle.query(
        "SELECT set_config('dasher.context_digest', $1, true)",
        [Buffer.alloc(32, 7).toString("hex")],
      );

      const result = await handle.query<{ dashboard_id: string }>(
        "SELECT dashboard_id FROM dasher.dashboards WHERE dashboard_id = $1",
        [dashboards.get(otherOrg)],
      );
      return result.rows;
    },
  );

  expect(rows).toStrictEqual([]);
});

it("loses its own access when only the digest is altered", async () => {
  // The sharper version. Alice keeps her real identity in four settings and
  // changes only the digest. If the digest were decorative, her own rows would
  // still be visible and the binding would be proving nothing.
  const rows = await withRequestContext(
    appPool,
    { tokenKeyVersion: 1, token: tokens.get(alice)! },
    async (handle) => {
      // Not an exact count: earlier tests in this file commit dashboards of
      // their own, and the property under test is "she could see her rows, then
      // could not" rather than how many there were.
      const before = await handle.query(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      expect(before.rows.length).toBeGreaterThan(0);

      await handle.query(
        "SELECT set_config('dasher.context_digest', $1, true)",
        [Buffer.alloc(32, 9).toString("hex")],
      );

      const after = await handle.query(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      return after.rows;
    },
  );

  // The context is bound as a whole, not field by field.
  expect(rows).toStrictEqual([]);
});
