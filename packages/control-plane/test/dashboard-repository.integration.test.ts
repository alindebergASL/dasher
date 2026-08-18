import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  parsePostgresIntegrationEnv,
  runMigrations,
  seedDevPrincipal,
  withDashboardRepository,
  type DashboardRepository,
  type DevPrincipalSeed,
} from "../src/index";
import {
  baselineMigrationDirectory,
  borrowedClientPool,
  createTemporaryAppLogin,
  createUnprivilegedSchemaOwner,
  dropUnprivilegedSchemaOwner,
  ignoreTeardownShutdown,
} from "./postgres-harness";

/**
 * The repository, and the boundary it inherits.
 *
 * The happy path here is small — save a dashboard, read it back — and it is not
 * what this file is for. A dashboard surviving a reload is one assertion. The
 * rest is what a reload must NOT do: return somebody else's dashboard, return a
 * dashboard to a request with no context, or let a repository captured in one
 * request execute in another.
 *
 * Those properties belong to `request-context.ts`, which already proves them
 * for its handle. They are re-proven here because the repository is what
 * application code will actually hold, and "the layer underneath is safe" is a
 * claim about a different object.
 */

const config = parsePostgresIntegrationEnv(process.env);
const databaseName = `dasher_test_db_${randomUUID().replaceAll("-", "")}`;
const ownerRole = `dasher_test_owner_${randomUUID().replaceAll("-", "")}`;
const appUsername = `dasher_test_${randomUUID().replaceAll("-", "")}`;

let operatorPool: Pool;
let ownerPool: Pool;
let appPool: Pool;

let alice: DevPrincipalSeed;
let carol: DevPrincipalSeed;

const SPEC: Uint8Array = Buffer.from(
  JSON.stringify({ schemaVersion: "1.1", pages: [] }),
  "utf8",
);

function credential(seed: DevPrincipalSeed) {
  return { tokenKeyVersion: seed.tokenKeyVersion, token: seed.token };
}

function saveInput(title: string) {
  return {
    title,
    requestText: "Show me river conditions near Sacramento.",
    provider: "fake",
    model: "fake-1",
    canonicalSpecBytes: SPEC,
    requestId: randomUUID(),
    deploymentRevision: "test",
  };
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
  // max: 1, so a repository retained past its request meets the same backend
  // the next request is using.
  appPool = new Pool({ connectionString: appUrl.toString(), max: 1 });
  ignoreTeardownShutdown(appPool);

  const seeder = await ownerPool.connect();
  try {
    await seeder.query("BEGIN");
    alice = await seedDevPrincipal(seeder, { organizationName: "alice org" });
    carol = await seedDevPrincipal(seeder, { organizationName: "carol org" });
    await seeder.query("COMMIT");
  } catch (error) {
    await seeder.query("ROLLBACK");
    throw error;
  } finally {
    seeder.release();
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

it("seeds a principal whose token actually authenticates", async () => {
  // The seed is only useful if it produces a session the seam accepts. If this
  // fails, every other test in this file is testing the seed rather than the
  // repository.
  const principal = await withDashboardRepository(
    appPool,
    credential(alice),
    async (_repository, resolved) => resolved,
  );

  expect(principal.organizationId).toBe(alice.organizationId);
  expect(principal.userId).toBe(alice.userId);
});

it("persists a dashboard and returns it in a later request", async () => {
  // The slice, end to end: two separate transactions, which is what a page
  // reload is.
  const saved = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.save(saveInput("Sacramento conditions")),
  );

  expect(saved.dashboardId).toBeDefined();
  expect(saved.versionId).toBeDefined();

  const loaded = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.loadById(saved.dashboardId),
  );

  expect(loaded?.title).toBe("Sacramento conditions");
  expect(loaded?.versionId).toBe(saved.versionId);
  // `loadById` returns what pg gives back, which is a Buffer; the input side
  // is Uint8Array so the schema package needs no Node types. Comparing by
  // content keeps the test honest about both.
  expect(
    Buffer.from(loaded!.canonicalSpecBytes).equals(Buffer.from(SPEC)),
  ).toBe(true);
  // `finalize_run` promotes the head and bumps the revision in the same
  // statement, so an active dashboard at revision 2 is the proof the promotion
  // happened rather than the version merely being inserted.
  expect(loaded?.lifecycleState).toBe("active");
  expect(loaded?.lifecycleRevision).toBe(2);
});

/**
 * WHICH POLICY THESE ISOLATION TESTS ACTUALLY PIN, stated because mutation
 * testing showed it is not what it looks like.
 *
 * `loadById` joins `dashboards` to `dashboard_versions`, so the read is filtered
 * if EITHER table's policy holds. Disabling row security on `dashboards` alone
 * leaves every test in this file green; both have to be off before the two
 * cross-tenant cases below go red. That is defence in depth in the schema and a
 * weakness in the test: on its own, this file does not prove the `dashboards`
 * policy does anything.
 *
 * It is proven, in `request-context.integration.test.ts`, which reads
 * `dasher.dashboards` unjoined — removing `ENABLE ROW LEVEL SECURITY` from that
 * table turns four of its cases red. The coverage exists; it just does not live
 * here, and claiming otherwise by leaving this unsaid would make these tests
 * read as stronger than they are.
 *
 * The facade cannot close the gap itself: it exposes no operation that reads
 * `dashboards` without the join, which is a consequence of keeping it narrow
 * rather than an oversight to fix by widening it.
 */

it("does not return another organization's dashboard by id", async () => {
  const saved = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.save(saveInput("alice private")),
  );

  const seenByCarol = await withDashboardRepository(
    appPool,
    credential(carol),
    async (repository) => repository.loadById(saved.dashboardId),
  );

  // Undefined, not an error: "no such dashboard" and "not yours" have to be
  // the same answer, or the difference tells Carol that Alice has one.
  expect(seenByCarol).toBeUndefined();
});

it("returns undefined for an id that does not exist", async () => {
  // The same answer as the case above, which is the point of checking both.
  const missing = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.loadById(randomUUID()),
  );

  expect(missing).toBeUndefined();
});

it("refuses a repository retained past its own request", async () => {
  // A repository is an object and objects get captured. Because every method
  // re-enters the handle, and the handle checks liveness per call, a stale
  // repository fails instead of running under whoever holds the connection.
  let escaped: DashboardRepository | undefined;

  const saved = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => {
      escaped = repository;
      return repository.save(saveInput("captured repository"));
    },
  );

  await expect(escaped!.loadById(saved.dashboardId)).rejects.toMatchObject({
    code: "stale_handle",
  });
});

it("refuses a retained repository even while another tenant is mid-request", async () => {
  // The dangerous shape: not that the stale call fails, but that it could
  // succeed under someone else's context. `appPool` is max: 1, so Carol's
  // request is on the backend Alice's just used.
  let alicesRepository: DashboardRepository | undefined;

  const saved = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => {
      alicesRepository = repository;
      return repository.save(saveInput("alice during carol"));
    },
  );

  const outcome = await withDashboardRepository(
    appPool,
    credential(carol),
    async (carolsRepository, principal) => {
      expect(principal.organizationId).toBe(carol.organizationId);
      const attempt = await alicesRepository!.loadById(saved.dashboardId).then(
        (value): { executed: boolean; value?: unknown; error?: unknown } => ({
          executed: true,
          value,
        }),
        (error: unknown): { executed: boolean; error?: unknown } => ({
          executed: false,
          error,
        }),
      );
      // Carol's own repository is unaffected; only the escaped one is dead.
      await carolsRepository.loadById(randomUUID());
      return attempt;
    },
  );

  expect(outcome.executed).toBe(false);
  expect(outcome.error).toMatchObject({ code: "stale_handle" });
});

it("writes nothing when the request fails after a save", async () => {
  let dashboardId: string | undefined;

  await expect(
    withDashboardRepository(appPool, credential(alice), async (repository) => {
      const saved = await repository.save(saveInput("abandoned"));
      dashboardId = saved.dashboardId;
      throw new Error("failed after saving");
    }),
  ).rejects.toThrow("failed after saving");

  expect(dashboardId).toBeDefined();

  const found = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.loadById(dashboardId!),
  );
  expect(found).toBeUndefined();
});

it("refuses to save without a valid session", async () => {
  await expect(
    withDashboardRepository(
      appPool,
      { tokenKeyVersion: 1, token: Buffer.alloc(32, 3) },
      async (repository) => repository.save(saveInput("unauthenticated")),
    ),
  ).rejects.toMatchObject({ code: "denied" });
});

it("keeps each organization's dashboards to itself when both have saved", async () => {
  // Both tenants writing matters: a policy that returned nothing to everybody
  // would satisfy the isolation tests above while being useless, and a policy
  // that ignored the organization would surface here and nowhere else.
  const alicesSave = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.save(saveInput("alice list entry")),
  );
  const carolsSave = await withDashboardRepository(
    appPool,
    credential(carol),
    async (repository) => repository.save(saveInput("carol list entry")),
  );

  const alicesView = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => ({
      own: await repository.loadById(alicesSave.dashboardId),
      other: await repository.loadById(carolsSave.dashboardId),
    }),
  );

  expect(alicesView.own?.title).toBe("alice list entry");
  expect(alicesView.other).toBeUndefined();
});

it("lists an organization's dashboards newest first, its own and nothing else", async () => {
  // A fresh tenant, so the listing is deterministic regardless of what the
  // tests above have accumulated for alice and carol.
  const seeder = await ownerPool.connect();
  let dave: DevPrincipalSeed;
  try {
    await seeder.query("BEGIN");
    dave = await seedDevPrincipal(seeder, { organizationName: "dave org" });
    await seeder.query("COMMIT");
  } catch (error) {
    await seeder.query("ROLLBACK");
    throw error;
  } finally {
    seeder.release();
  }

  const saved: string[] = [];
  for (const title of ["first saved", "second saved", "third saved"]) {
    const result = await withDashboardRepository(
      appPool,
      credential(dave),
      async (repository) => repository.save(saveInput(title)),
    );
    saved.push(result.dashboardId);
  }

  const listed = await withDashboardRepository(
    appPool,
    credential(dave),
    async (repository) => repository.listRecent(10),
  );

  expect(listed.map((entry) => entry.title)).toEqual([
    "third saved",
    "second saved",
    "first saved",
  ]);
  expect(listed.map((entry) => entry.dashboardId)).toEqual(
    [...saved].reverse(),
  );
  for (const entry of listed) {
    expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
  }

  // The other half: carol's listing must not gain dave's rows. Row-level
  // security is the entire mechanism — this read is unjoined, so it runs
  // directly against the dashboards policy rather than through the join
  // that `loadById` gets its depth from.
  const carolsView = await withDashboardRepository(
    appPool,
    credential(carol),
    async (repository) => repository.listRecent(100),
  );
  for (const entry of carolsView) {
    expect(saved).not.toContain(entry.dashboardId);
  }

  const bounded = await withDashboardRepository(
    appPool,
    credential(dave),
    async (repository) => repository.listRecent(2),
  );
  expect(bounded.map((entry) => entry.title)).toEqual([
    "third saved",
    "second saved",
  ]);
});

it("returns an empty listing for an organization that has saved nothing", async () => {
  const seeder = await ownerPool.connect();
  let erin: DevPrincipalSeed;
  try {
    await seeder.query("BEGIN");
    erin = await seedDevPrincipal(seeder, { organizationName: "erin org" });
    await seeder.query("COMMIT");
  } catch (error) {
    await seeder.query("ROLLBACK");
    throw error;
  } finally {
    seeder.release();
  }

  const listed = await withDashboardRepository(
    appPool,
    credential(erin),
    async (repository) => repository.listRecent(10),
  );

  expect(listed).toEqual([]);
});

it("refuses an unbounded or malformed listing limit", async () => {
  // Bounded in the repository, not by caller manners: a listing that can be
  // asked for everything is a full-table read wearing a UI.
  for (const limit of [0, -1, 101, 2.5, Number.NaN]) {
    await expect(
      withDashboardRepository(appPool, credential(alice), async (repository) =>
        repository.listRecent(limit),
      ),
    ).rejects.toMatchObject({ code: "unexpected_shape" });
  }
});
