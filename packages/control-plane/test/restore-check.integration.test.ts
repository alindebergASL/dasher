import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  checkRestore,
  parsePostgresIntegrationEnv,
  runMigrations,
} from "../src/index";
import {
  baselineMigrationDirectory,
  borrowedClientPool,
  createUnprivilegedSchemaOwner,
  dropUnprivilegedSchemaOwner,
  ignoreTeardownShutdown,
} from "./postgres-harness";

/**
 * The restore check, against a database in the states a partial recovery
 * actually produces.
 *
 * WHY THIS DOES NOT SHELL OUT TO `pg_dump`. What is under test is whether the
 * check notices missing rows, not whether Postgres's own dump tool works. So
 * the damage is inflicted directly, with foreign-key triggers disabled —
 * which is precisely what `pg_restore --disable-triggers` does, and the reason
 * dangling references can exist in a database that opened cleanly.
 *
 * WHAT THE SCHEMA ALREADY GUARANTEES, so this does not claim credit for it.
 * `source_snapshots_content_sha256_check` ties the digest to the bytes and is
 * enforced as a dump loads, so corrupt bytes fail the restore rather than
 * reaching this check. The dangling checks are the ones that earn their place.
 */

const config = parsePostgresIntegrationEnv(process.env);
const databaseName = `dasher_test_db_${randomUUID().replaceAll("-", "")}`;
const ownerRole = `dasher_test_owner_${randomUUID().replaceAll("-", "")}`;

let operatorPool: Pool;
let ownerPool: Pool;

/** One organization with the whole chain: snapshot, evidence, version, claim. */
async function seedChain(): Promise<{ organizationId: string }> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const snapshotId = randomUUID();
  const evidenceId = randomUUID();
  const dashboardId = randomUUID();
  const versionId = randomUUID();
  const claimId = randomUUID();
  const bytes = Buffer.from("line_id,label\na,A\n", "utf8");

  // ONE TRANSACTION, because `claims_require_support` is a DEFERRABLE
  // INITIALLY DEFERRED constraint trigger: a claim asserting `complete` must
  // cite supporting evidence, checked at COMMIT, since the claim necessarily
  // exists before the edge that supports it. A statement-per-connection seed
  // commits the claim alone and the trigger fires on the spot.
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, 'org')",
      [organizationId],
    );
    await client.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      userId,
    ]);
    await client.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, 'editor', 'active', 1)`,
      [randomUUID(), organizationId, userId],
    );
    await client.query(
      `INSERT INTO dasher.source_snapshots
         (snapshot_id, organization_id, source_kind, source_ref, canonical_bytes,
          content_sha256, observed_at, retrieved_at)
       VALUES ($1, $2, 'csv-upload', 'x.csv', $3, sha256($3), now(), now())`,
      [snapshotId, organizationId, bytes],
    );
    await client.query(
      `INSERT INTO dasher.evidence_records
         (organization_id, evidence_id, snapshot_id, evidence_kind, coordinates,
          transformation, content_sha256, observed_at)
       VALUES ($1, $2, $3, 'observed', 'ledger-line-a', 'verbatim',
               sha256('x'::bytea), now())`,
      [organizationId, evidenceId, snapshotId],
    );
    // Draft first: `dashboards_head_check` requires a non-draft dashboard to
    // name a head version, and that version does not exist yet.
    await client.query(
      `INSERT INTO dasher.dashboards
         (organization_id, dashboard_id, title, lifecycle_state,
          lifecycle_revision, created_by_user_id)
       VALUES ($1, $2, 'd', 'draft', 1, $3)`,
      [organizationId, dashboardId, userId],
    );
    await client.query(
      `INSERT INTO dasher.dashboard_versions
         (organization_id, dashboard_id, version_id, canonical_spec_bytes,
          canonical_spec_sha256, validation_state, source_snapshot_id,
          created_by_user_id)
       VALUES ($1, $2, $3, $4, sha256($4), 'valid', $5, $6)`,
      [organizationId, dashboardId, versionId, bytes, snapshotId, userId],
    );
    await client.query(
      `INSERT INTO dasher.claims
         (organization_id, dashboard_id, version_id, claim_id, json_pointer,
          label, salience, evidence_state, assertion_sha256)
       VALUES ($1, $2, $3, $4, '/nextAction', 'observed', 'high', 'complete',
               sha256('a'::bytea))`,
      [organizationId, dashboardId, versionId, claimId],
    );
    await client.query(
      `INSERT INTO dasher.claim_evidence
         (organization_id, dashboard_id, version_id, claim_id, evidence_id, relation)
       VALUES ($1, $2, $3, $4, $5, 'supports')`,
      [organizationId, dashboardId, versionId, claimId, evidenceId],
    );
    // Promoted LAST. A published version is sealed — `claims` refuses further
    // rows once the head points at it — which is the order `finalize_run` uses
    // and the order the trigger exists to enforce.
    await client.query(
      `UPDATE dasher.dashboards
          SET lifecycle_state = 'active',
              head_version_id = $3,
              lifecycle_revision = lifecycle_revision + 1,
              updated_at = now()
        WHERE organization_id = $1 AND dashboard_id = $2`,
      [organizationId, dashboardId, versionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { organizationId };
}

/**
 * Delete rows the way a partial restore leaves them missing.
 *
 * `ALTER TABLE ... DISABLE TRIGGER ALL` would be the closest analogue to
 * `pg_restore --disable-triggers`, and it needs SUPERUSER because it covers
 * internal foreign-key triggers — which this suite's unprivileged schema owner
 * deliberately is not. So the named constraint is dropped for the duration
 * instead, which is the same end state and arguably the more faithful one: a
 * selective restore loads data into a schema whose constraints are not yet in
 * place.
 *
 * The immutability triggers are this schema's own and the owner may disable
 * them by name. They are put back either way, so a later test in this file
 * still runs against the real schema.
 */
async function withoutGuards(
  guards: {
    readonly constraints?: readonly (readonly [string, string])[];
    readonly triggers?: readonly (readonly [string, string])[];
  },
  damage: () => Promise<void>,
): Promise<void> {
  const constraints = guards.constraints ?? [];
  const triggers = guards.triggers ?? [];

  const definitions = new Map<string, string>();
  for (const [table, constraint] of constraints) {
    const found = await ownerPool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = $1::regclass AND conname = $2`,
      [table, constraint],
    );
    const def = found.rows[0]?.def;
    if (def === undefined) throw new Error(`no constraint ${constraint}`);
    definitions.set(`${table}.${constraint}`, def);
    await ownerPool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
  }
  for (const [table, trigger] of triggers) {
    await ownerPool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }

  try {
    await damage();
  } finally {
    for (const [table, trigger] of triggers) {
      await ownerPool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    for (const [table, constraint] of constraints) {
      // NOT VALID: the rows just deleted would fail validation, which is the
      // point of the test. The constraint is back for future writes.
      await ownerPool.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${definitions.get(
          `${table}.${constraint}`,
        )!} NOT VALID`,
      );
    }
  }
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
}, 60_000);

afterAll(async () => {
  await ownerPool?.end();
  if (operatorPool !== undefined) {
    await dropUnprivilegedSchemaOwner(
      operatorPool,
      ownerRole,
      databaseName,
      [],
    );
    await operatorPool.end();
  }
});

it("says an empty database is empty rather than verified", async () => {
  // Before anything is seeded. Every invariant holds vacuously, which is the
  // outcome most likely to be mistaken for success.
  const result = await checkRestore(ownerPool);

  expect(result.ok).toBe(true);
  expect(result.counts.snapshots).toBe(0);
  expect(result.counts.dashboardVersions).toBe(0);
});

it("verifies a database whose chain is whole", async () => {
  await seedChain();
  const result = await checkRestore(ownerPool);

  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.counts.snapshots).toBe(1);
  expect(result.counts.claimEdges).toBe(1);
});

it("catches the evidence a claim points at going missing", async () => {
  const { organizationId } = await seedChain();

  // Exactly what `pg_restore --disable-triggers` permits: foreign keys not
  // enforced, and a table restored short. Without disabling them the delete is
  // refused, which is the schema working and not what is under test.
  await withoutGuards(
    {
      constraints: [["dasher.claim_evidence", "claim_evidence_evidence_fkey"]],
      triggers: [["dasher.evidence_records", "evidence_records_immutable"]],
    },
    async () => {
      await ownerPool.query(
        "DELETE FROM dasher.evidence_records WHERE organization_id = $1",
        [organizationId],
      );
    },
  );

  const result = await checkRestore(ownerPool);
  expect(result.ok).toBe(false);
  expect(result.failures.join("\n")).toContain(
    "point at an evidence record that is missing",
  );
  // The scale, not just the kind: one dangling edge and a thousand are
  // different decisions at the moment somebody is choosing whether to keep
  // this restore.
  expect(result.failures.join("\n")).toMatch(/^\d+ claim edge/mu);
});

it("catches a dashboard citing a stored file that is gone", async () => {
  const { organizationId } = await seedChain();

  await withoutGuards(
    {
      constraints: [
        ["dasher.evidence_records", "evidence_records_snapshot_fkey"],
        [
          "dasher.dashboard_versions",
          "dashboard_versions_source_snapshot_fkey",
        ],
      ],
      triggers: [["dasher.source_snapshots", "source_snapshots_immutable"]],
    },
    async () => {
      await ownerPool.query(
        "DELETE FROM dasher.source_snapshots WHERE organization_id = $1",
        [organizationId],
      );
    },
  );

  const result = await checkRestore(ownerPool);
  expect(result.ok).toBe(false);
  const text = result.failures.join("\n");
  // Both links break together, and both are reported: the version's citation
  // and the evidence record's home.
  expect(text).toContain("cite a stored file that is missing");
  expect(text).toContain("belong to a stored file that is missing");
});

it("catches a claim still saying its evidence is complete", async () => {
  // The specific dishonesty a partial restore produces. The dashboard renders,
  // the claim says every figure is backed, and nothing is behind it.
  const { organizationId } = await seedChain();

  await withoutGuards(
    { triggers: [["dasher.claim_evidence", "claim_evidence_immutable"]] },
    async () => {
      await ownerPool.query(
        "DELETE FROM dasher.claim_evidence WHERE organization_id = $1",
        [organizationId],
      );
    },
  );

  const result = await checkRestore(ownerPool);
  expect(result.ok).toBe(false);
  expect(result.failures.join("\n")).toContain(
    "say their evidence is complete with no evidence behind them",
  );
});
