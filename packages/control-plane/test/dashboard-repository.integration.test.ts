import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  DashboardRepositoryError,
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

/**
 * A well-formed token the database refuses arrives as this package's OWN error,
 * not as the seam's.
 *
 * The credential below is the shape of a real one — right key version, right
 * length — so nothing upstream can reject it on syntax. It is simply not a
 * token anybody was issued, which is the same position a caller is in when
 * theirs has expired, been revoked, or lost its membership. The seam raises
 * `RequestContextError("denied")` for all of those; the facade re-raises it as
 * `not_authenticated`.
 *
 * Asserting the CLASS matters as much as the code. `request-context.ts` is not
 * exported, so a caller outside this package cannot name `RequestContextError`
 * to match on it; if the translation were dropped, the rejection would still
 * carry a `code` and a `toMatchObject` check alone would keep passing while
 * every caller lost the ability to recognise it.
 */
it("refuses to save without a valid session, in its own vocabulary", async () => {
  const rejection = withDashboardRepository(
    appPool,
    { tokenKeyVersion: 1, token: Buffer.alloc(32, 3) },
    async (repository) => repository.save(saveInput("unauthenticated")),
  );

  await expect(rejection).rejects.toBeInstanceOf(DashboardRepositoryError);
  await expect(rejection).rejects.toMatchObject({
    code: "not_authenticated",
  });
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

/**
 * Stored bytes, and the reference that makes them durable evidence.
 *
 * The decision these prove is a product one: a file someone uploads is kept for
 * at least as long as the dashboard built from it, because the dashboard states
 * figures and the file is what those figures came from. A dashboard whose
 * source has been discarded still shows numbers, and there is then no way to
 * check them against anything.
 *
 * The schema is what enforces it rather than a retention job's good intentions:
 * a version cites a snapshot by foreign key, so the bytes cannot be deleted
 * while the version exists.
 */

const UPLOAD: Uint8Array = Buffer.from(
  "line_id,label,budget_per_period,2026-03,2026-04\r\ncloud,Cloud,100,10,20\r\n",
  "utf8",
);

function uploadInput() {
  return {
    sourceKind: "csv-upload",
    sourceRef: "operating-spend.csv",
    bytes: UPLOAD,
    observedAt: new Date("2026-08-24T09:00:00.000Z"),
    requestId: randomUUID(),
    deploymentRevision: "test",
  };
}

it("stores uploaded bytes and hands back the id a version can cite", async () => {
  const { snapshotId, stored } = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository, principal) => {
      const id = await repository.recordSourceSnapshot(uploadInput());
      void principal;
      return { snapshotId: id, stored: id };
    },
  );

  expect(snapshotId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
  expect(stored).toBe(snapshotId);
});

it("keeps the bytes exactly, and derives the digest from them rather than taking one", async () => {
  const snapshotId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.recordSourceSnapshot(uploadInput()),
  );

  // Read through the owner, because the repository exposes no operation that
  // reads a snapshot back — this is checking what the seam wrote, not adding a
  // capability the application gets.
  const row = await ownerPool.query<{
    canonical_bytes: Buffer;
    digest_matches: boolean;
    source_kind: string;
    source_ref: string;
  }>(
    `SELECT canonical_bytes,
            content_sha256 = sha256(canonical_bytes) AS digest_matches,
            source_kind,
            source_ref
       FROM dasher.source_snapshots
      WHERE snapshot_id = $1`,
    [snapshotId],
  );

  // Byte for byte, CRLF endings included. A reader that normalised them would
  // be storing something the author did not upload.
  expect(row.rows[0]?.canonical_bytes.equals(Buffer.from(UPLOAD))).toBe(true);
  expect(row.rows[0]?.digest_matches).toBe(true);
  expect(row.rows[0]?.source_kind).toBe("csv-upload");
  expect(row.rows[0]?.source_ref).toBe("operating-spend.csv");
});

it("records on the version which stored bytes its figures came from", async () => {
  const { snapshotId, dashboardId } = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => {
      const id = await repository.recordSourceSnapshot(uploadInput());
      const saved = await repository.save({
        ...saveInput("uploaded ledger"),
        sourceSnapshotId: id,
      });
      return { snapshotId: id, dashboardId: saved.dashboardId };
    },
  );

  const row = await ownerPool.query<{ source_snapshot_id: string | null }>(
    `SELECT v.source_snapshot_id
       FROM dasher.dashboards AS d
       JOIN dasher.dashboard_versions AS v
         ON v.organization_id = d.organization_id
        AND v.version_id = d.head_version_id
      WHERE d.dashboard_id = $1`,
    [dashboardId],
  );

  expect(row.rows[0]?.source_snapshot_id).toBe(snapshotId);
});

it("leaves it null for a dashboard built from a source that keeps no file", async () => {
  // The ordinary case, and it has to stay distinguishable. A river dashboard
  // reads an API at request time; saying it came from stored bytes would be a
  // claim about evidence that does not exist.
  const saved = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.save(saveInput("live river")),
  );

  const row = await ownerPool.query<{ source_snapshot_id: string | null }>(
    `SELECT v.source_snapshot_id
       FROM dasher.dashboards AS d
       JOIN dasher.dashboard_versions AS v
         ON v.organization_id = d.organization_id
        AND v.version_id = d.head_version_id
      WHERE d.dashboard_id = $1`,
    [saved.dashboardId],
  );

  expect(row.rows[0]?.source_snapshot_id).toBeNull();
});

/**
 * Written expecting a foreign-key violation on delete, which is not what
 * happens and is worth recording. `source_snapshots` carries an immutability
 * trigger, so a DELETE is rejected before the constraint is ever consulted —
 * 55000, not 23503. Retention here is therefore stronger than the decision
 * asked for: the bytes are kept, full stop, and no path in this schema removes
 * them.
 *
 * That leaves the citation doing a different job than "blocks the delete". When
 * a deletion path is eventually built — a privileged retention role, or an
 * archival marker — the reference is what will tell it these bytes are still
 * answering for a dashboard on somebody's screen. Both facts are asserted
 * below, so that the day the trigger is relaxed the second one is already
 * load-bearing and already tested.
 */

it("refuses to delete stored bytes, before any constraint is consulted", async () => {
  const snapshotId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.recordSourceSnapshot(uploadInput()),
  );

  await expect(
    ownerPool.query(
      "DELETE FROM dasher.source_snapshots WHERE snapshot_id = $1",
      [snapshotId],
    ),
    // Uncited bytes, and still refused: this is the immutability trigger, not
    // the reference below.
  ).rejects.toMatchObject({ code: "55000" });
});

it("holds the citation that a deletion path would have to consult", async () => {
  const snapshotId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => {
      const id = await repository.recordSourceSnapshot(uploadInput());
      await repository.save({
        ...saveInput("cites its source"),
        sourceSnapshotId: id,
      });
      return id;
    },
  );

  // "Is anything still answering for these bytes?" — the question a retention
  // pass asks, answerable from the schema rather than from a spec document.
  const citations = await ownerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM dasher.dashboard_versions
      WHERE source_snapshot_id = $1`,
    [snapshotId],
  );

  expect(citations.rows[0]?.count).toBe("1");
});

it("does not let one organization cite another's stored file", async () => {
  // The composite foreign key, doing the job it is composite for. Carol
  // learning Alice's snapshot id must not be enough to attach Alice's evidence
  // to Carol's dashboard, and the failure is a constraint rather than a check
  // somebody remembered to write in the application.
  const alicesSnapshot = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => repository.recordSourceSnapshot(uploadInput()),
  );

  await expect(
    withDashboardRepository(appPool, credential(carol), async (repository) =>
      repository.save({
        ...saveInput("carol borrows evidence"),
        sourceSnapshotId: alicesSnapshot,
      }),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});

/**
 * THE EVIDENCE CHAIN: retained bytes, the parts of them a figure came from, and
 * the assertions that cite those parts.
 *
 * `claims`, `claim_evidence`, and `evidence_records` were fully modelled in the
 * baseline — constraints, immutability triggers, seam functions, grants — and
 * had never held a row, because `finalize_run`'s claims argument was the
 * literal `"[]"` from the day it was written. Everything below is the first
 * exercise any of the three has had against a real database.
 */

const ASSERTION_DIGEST = Buffer.from(
  "d1b2c3a4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "hex",
);

function evidenceInput(snapshotId: string) {
  return {
    snapshotId,
    evidenceKind: "observed",
    coordinates: "ledger-line-salaries",
    transformation: "Recorded as retrieved, without transformation.",
    contentSha256: ASSERTION_DIGEST,
    observedAt: new Date("2026-08-24T09:00:00.000Z"),
    requestId: randomUUID(),
    deploymentRevision: "test",
  };
}

function claimInput(pointer: string, evidenceIds: readonly string[]) {
  return {
    pointer,
    label: "observed" as const,
    salience: "high" as const,
    evidenceState:
      evidenceIds.length === 0
        ? ("unsupported" as const)
        : ("complete" as const),
    assertionSha256: ASSERTION_DIGEST.toString("hex"),
    evidence: evidenceIds.map((evidenceId) => ({
      evidenceId,
      relation: "supports" as const,
    })),
  };
}

it("cites part of a stored file, and keeps the digest it was given", async () => {
  const evidenceId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) =>
      repository.recordEvidence(
        evidenceInput(await repository.recordSourceSnapshot(uploadInput())),
      ),
  );

  const row = await ownerPool.query<{
    evidence_kind: string;
    coordinates: string;
    transformation: string;
    digest_matches: boolean;
    observed_at: Date;
    audited: string;
  }>(
    `SELECT record.evidence_kind,
            record.coordinates,
            record.transformation,
            record.content_sha256 = $2 AS digest_matches,
            record.observed_at,
            (SELECT count(*)::text
               FROM dasher.audit_events AS event
              WHERE event.target_id = record.evidence_id
                AND event.action = 'evidence_record.created') AS audited
       FROM dasher.evidence_records AS record
      WHERE record.evidence_id = $1`,
    [evidenceId, ASSERTION_DIGEST],
  );

  expect(row.rows).toHaveLength(1);
  expect(row.rows[0]?.coordinates).toBe("ledger-line-salaries");
  expect(row.rows[0]?.evidence_kind).toBe("observed");
  expect(row.rows[0]?.digest_matches).toBe(true);
  expect(row.rows[0]?.observed_at.toISOString()).toBe(
    "2026-08-24T09:00:00.000Z",
  );
  // An evidence record with nothing recording who put it there is the one
  // thing an evidence table cannot afford, so the audit row is part of the
  // assertion rather than a separate concern.
  expect(row.rows[0]?.audited).toBe("1");
});

it("refuses to cite bytes that were never stored", async () => {
  await expect(
    withDashboardRepository(appPool, credential(alice), async (repository) =>
      repository.recordEvidence(evidenceInput(randomUUID())),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});

it("does not let one organization cite a part of another's stored file", async () => {
  // The same composite key as the version citation above, one table down. A
  // leaked evidence id must not be enough to hang Carol's claim on Alice's
  // bytes.
  const alicesEvidence = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) =>
      repository.recordEvidence(
        evidenceInput(await repository.recordSourceSnapshot(uploadInput())),
      ),
  );

  await expect(
    withDashboardRepository(appPool, credential(carol), async (repository) =>
      repository.save({
        ...saveInput("carol borrows a citation"),
        claims: [claimInput("/nextAction", [alicesEvidence])],
      }),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});

it("writes an assertion and the edge to the evidence behind it", async () => {
  const { versionId, evidenceId } = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) => {
      const snapshotId = await repository.recordSourceSnapshot(uploadInput());
      const evidence = await repository.recordEvidence(
        evidenceInput(snapshotId),
      );
      const saved = await repository.save({
        ...saveInput("cites its evidence"),
        sourceSnapshotId: snapshotId,
        claims: [
          claimInput("/nextAction", [evidence]),
          claimInput("/executiveBrief/known", [evidence]),
        ],
      });
      return { versionId: saved.versionId, evidenceId: evidence };
    },
  );

  const claims = await ownerPool.query<{
    json_pointer: string;
    label: string;
    salience: string;
    evidence_state: string;
    digest_matches: boolean;
    edges: string;
  }>(
    `SELECT claim.json_pointer,
            claim.label,
            claim.salience,
            claim.evidence_state,
            claim.assertion_sha256 = $2 AS digest_matches,
            (SELECT count(*)::text
               FROM dasher.claim_evidence AS edge
              WHERE edge.claim_id = claim.claim_id
                AND edge.evidence_id = $3
                AND edge.relation = 'supports') AS edges
       FROM dasher.claims AS claim
      WHERE claim.version_id = $1
      ORDER BY claim.json_pointer`,
    [versionId, ASSERTION_DIGEST, evidenceId],
  );

  expect(claims.rows.map((row) => row.json_pointer)).toEqual([
    "/executiveBrief/known",
    "/nextAction",
  ]);
  for (const row of claims.rows) {
    expect(row.label).toBe("observed");
    expect(row.salience).toBe("high");
    expect(row.evidence_state).toBe("complete");
    expect(row.digest_matches).toBe(true);
    expect(row.edges).toBe("1");
  }
});

it("records an unsupported assertion as a claim with no edges", async () => {
  // The live-source shape: the dashboard asserts things, and nothing durable
  // stands behind them. Recorded as a claim rather than omitted, because "no
  // claim" and "a claim nothing supports" are different statements and only
  // the second is true of a gauge read.
  const versionId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) =>
      (
        await repository.save({
          ...saveInput("asserts without evidence"),
          claims: [claimInput("/nextAction", [])],
        })
      ).versionId,
  );

  const row = await ownerPool.query<{
    evidence_state: string;
    edges: string;
  }>(
    `SELECT claim.evidence_state,
            (SELECT count(*)::text
               FROM dasher.claim_evidence AS edge
              WHERE edge.claim_id = claim.claim_id) AS edges
       FROM dasher.claims AS claim
      WHERE claim.version_id = $1`,
    [versionId],
  );

  expect(row.rows).toHaveLength(1);
  expect(row.rows[0]?.evidence_state).toBe("unsupported");
  expect(row.rows[0]?.edges).toBe("0");
});

it("saves a version with no claims at all, as every caller did before", async () => {
  // `claims` is optional, and omitting it has to keep meaning what it meant.
  const versionId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) =>
      (await repository.save(saveInput("no claims"))).versionId,
  );

  const row = await ownerPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM dasher.claims WHERE version_id = $1",
    [versionId],
  );
  expect(row.rows[0]?.count).toBe("0");
});

it("refuses two assertions at the same place in one version", async () => {
  // `claims_pointer_key`. A pointer is the address of an assertion, so two
  // claims sharing one means the walk that produced them is visiting something
  // twice — and a duplicate that inserted quietly would make the count of
  // assertions on a page wrong forever after.
  await expect(
    withDashboardRepository(appPool, credential(alice), async (repository) =>
      repository.save({
        ...saveInput("two claims, one pointer"),
        claims: [claimInput("/nextAction", []), claimInput("/nextAction", [])],
      }),
    ),
  ).rejects.toMatchObject({ code: "23505" });
});

it("refuses a malformed pointer rather than storing an unusable address", async () => {
  await expect(
    withDashboardRepository(appPool, credential(alice), async (repository) =>
      repository.save({
        ...saveInput("bad pointer"),
        claims: [claimInput("nextAction", [])],
      }),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("refuses to edit or delete an assertion once it is recorded", async () => {
  // The same immutability the stored bytes have. A claim that could be edited
  // after the fact would be a record of what somebody currently says the
  // dashboard asserted.
  const versionId = await withDashboardRepository(
    appPool,
    credential(alice),
    async (repository) =>
      (
        await repository.save({
          ...saveInput("immutable claim"),
          claims: [claimInput("/nextAction", [])],
        })
      ).versionId,
  );

  await expect(
    ownerPool.query(
      "UPDATE dasher.claims SET label = 'hypothesis' WHERE version_id = $1",
      [versionId],
    ),
  ).rejects.toMatchObject({ code: "55000" });
  await expect(
    ownerPool.query("DELETE FROM dasher.claims WHERE version_id = $1", [
      versionId,
    ]),
  ).rejects.toMatchObject({ code: "55000" });
});
