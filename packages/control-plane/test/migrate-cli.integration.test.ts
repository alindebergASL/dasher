import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  MigrationContractError,
  parsePostgresIntegrationEnv,
} from "../src/index";
import { migrate } from "../src/migrate";
import {
  createUnprivilegedSchemaOwner,
  dropUnprivilegedSchemaOwner,
  ignoreTeardownShutdown,
} from "./postgres-harness";

/**
 * The migrate entry point, and what it refuses to do on the way in.
 *
 * The ordering here is the whole point. `runMigrations` already refuses a
 * connection that does not own the database, but it refuses too late to help:
 * managed roles are CLUSTER-wide, so creating them first meant a rejected run
 * still changed the cluster it rejected. A failed migration that leaves
 * `dasher_app` behind is a side effect nobody asked for and nobody sees.
 *
 * The first attempt at fixing that ran migrations as a "proof" pass before
 * bootstrapping. It applied the entire schema before the roles existed and only
 * appeared to work because an earlier run in the same cluster had created them
 * already — caught by running it against a genuinely fresh database.
 */

const config = parsePostgresIntegrationEnv(process.env);
const databaseName = `dasher_test_db_${randomUUID().replaceAll("-", "")}`;
const ownerRole = `dasher_test_owner_${randomUUID().replaceAll("-", "")}`;

let operatorPool: Pool;
let ownerDsn: string;

async function managedRoleExists(): Promise<boolean> {
  const result = await operatorPool.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dasher_app') AS present",
  );
  return result.rows[0]?.present === true;
}

async function expectOwnerRefusal(operation: Promise<unknown>): Promise<void> {
  let refusal: unknown;
  try {
    await operation;
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MigrationContractError);
  expect((refusal as MigrationContractError).code).toBe(
    "executor_not_database_owner",
  );
}

beforeAll(async () => {
  operatorPool = new Pool({ connectionString: config.ownerDsn, max: 2 });
  ignoreTeardownShutdown(operatorPool);
  ownerDsn = await createUnprivilegedSchemaOwner(
    operatorPool,
    config.ownerDsn,
    ownerRole,
    databaseName,
  );
}, 60_000);

afterAll(async () => {
  if (operatorPool !== undefined) {
    await dropUnprivilegedSchemaOwner(operatorPool, ownerRole, databaseName);
    await operatorPool.end();
  }
});

it("refuses a non-owner with the migrator's own typed error", async () => {
  // The application login owns nothing. It is exactly who would run this by
  // mistake, having the only connection string most people have to hand.
  const notOwner = new URL(config.appDsn);
  notOwner.pathname = `/${databaseName}`;

  await expectOwnerRefusal(migrate(notOwner.toString(), []));
});

it("changes nothing when it refuses", async () => {
  // `dasher_app` is cluster-wide and other suites legitimately create it, so
  // this cannot demand its absence — dropping it here would break whatever
  // else is running. What it can demand is that a rejected run leaves its
  // existence exactly as it found it.
  const roleBefore = await managedRoleExists();

  const notOwner = new URL(config.appDsn);
  notOwner.pathname = `/${databaseName}`;
  await expectOwnerRefusal(migrate(notOwner.toString(), []));

  expect(await managedRoleExists()).toBe(roleBefore);

  // And the database-scoped half, which no other suite can muddy: the schema
  // this run would have created is absent. Together these say the refusal
  // happened before anything was written, cluster-wide or local — which is the
  // whole reason the ownership check moved ahead of role creation.
  const target = new Pool({ connectionString: ownerDsn, max: 1 });
  ignoreTeardownShutdown(target);
  try {
    const schema = await target.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'dasher'
       ) AS present`,
    );
    expect(schema.rows[0]?.present).toBe(false);
  } finally {
    await target.end();
  }
});

it("applies the schema for the owner, on a database that has never seen it", async () => {
  // A database that has never been migrated is the arrangement that exposed
  // the first, wrong fix: it reported "applied 1" from a pass that was
  // supposed to create nothing.
  await migrate(ownerDsn, []);

  expect(await managedRoleExists()).toBe(true);

  const owner = new Pool({ connectionString: ownerDsn, max: 1 });
  ignoreTeardownShutdown(owner);
  try {
    const tables = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'dasher'",
    );
    expect(Number(tables.rows[0]?.count)).toBeGreaterThan(0);
  } finally {
    await owner.end();
  }
});

it("is idempotent", async () => {
  await migrate(ownerDsn, []);
  await expect(migrate(ownerDsn, [])).resolves.toMatchObject({
    appliedCount: 0,
  });
});
