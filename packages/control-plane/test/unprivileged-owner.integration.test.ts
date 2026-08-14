import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

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
} from "./postgres-harness.js";

/**
 * The deployment contract: everything after provisioning works when the schema
 * owner is an ordinary role.
 *
 * The rest of this suite connects as the superuser its database was created
 * with, so it cannot see any failure that only an unprivileged owner suffers.
 * That blind spot has already cost once — forcing row-level security disabled
 * the entire write seam against an ordinary owner, denying every valid token,
 * and all 71 tests passed throughout. A preflight now refuses that particular
 * schema, but a preflight only catches what someone thought to check.
 *
 * This runs the real thing instead: provision as an operator, then hand over.
 * Role creation, migration, seeding, authentication, and a write all happen as
 * a role that is NOSUPERUSER and NOBYPASSRLS.
 */

const config = parsePostgresIntegrationEnv(process.env);
const suffix = randomUUID().replaceAll("-", "");
const ownerRole = `dasher_test_owner_${suffix}`;
const databaseName = `dasher_test_db_${suffix}`;
const appUsername = `dasher_test_${randomUUID().replaceAll("-", "")}`;

const organization = randomUUID();
const user = randomUUID();
const token = createHash("sha256").update(`token:${suffix}`).digest();

let operatorPool: Pool;
let ownerPool: Pool;
let appPool: Pool;
let ownerDsn: string;

beforeAll(async () => {
  operatorPool = new Pool({ connectionString: config.ownerDsn, max: 2 });
  ownerDsn = await createUnprivilegedSchemaOwner(
    operatorPool,
    config.ownerDsn,
    ownerRole,
    databaseName,
  );
  ownerPool = new Pool({ connectionString: ownerDsn, max: 4 });
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await dropUnprivilegedSchemaOwner(operatorPool, ownerRole, databaseName, [
    appUsername,
  ]);
  await operatorPool?.end();
});

it("bootstraps roles, migrates, and serves a request as an ordinary owner", async () => {
  const owner = await ownerPool.connect();
  try {
    const attributes = await owner.query<{
      readonly rolsuper: boolean;
      readonly rolbypassrls: boolean;
    }>(
      "SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER",
    );
    // If this ever reports true, everything below proves nothing.
    expect(attributes.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
    });

    await bootstrapManagedRoles(owner, []);
    await runMigrations(
      borrowedClientPool(owner),
      baselineMigrationDirectory,
      [],
    );

    // Seeding is itself part of the contract: an owner that cannot insert an
    // organization cannot provision a tenant, and forcing row security took
    // exactly that away.
    await owner.query(
      "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, 'acme')",
      [organization],
    );
    await owner.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [user]);
    await owner.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, 'admin', 'active', 1)`,
      [randomUUID(), organization, user],
    );
    await owner.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, $4, 1, $5, now(), now(),
               now() + interval '1 hour', now() + interval '8 hours')`,
      [
        randomUUID(),
        organization,
        user,
        createHash("sha256").update(token).digest(),
        createHash("sha256").update("csrf").digest(),
      ],
    );
  } finally {
    owner.release();
  }

  const appDsnUrl = new URL(config.appDsn);
  appDsnUrl.pathname = `/${databaseName}`;
  const appDsn = appDsnUrl.toString();
  await createTemporaryAppLogin(ownerPool, appDsn, appUsername);
  const appUrl = new URL(appDsn);
  appUrl.username = appUsername;
  appPool = new Pool({ connectionString: appUrl.toString(), max: 2 });

  const app = await appPool.connect();
  try {
    await app.query("BEGIN");
    const established = await app.query<{
      readonly organization_id: string;
    }>(
      "SELECT organization_id FROM dasher_api.begin_request($1::smallint, $2)",
      [1, token],
    );
    expect(established.rows[0]?.organization_id).toBe(organization);

    const created = await app.query<{ readonly id: string }>(
      "SELECT dasher_api.create_dashboard($1, $2, 'test') AS id",
      ["written by an unprivileged owner", randomUUID()],
    );
    expect(created.rows[0]?.id).toEqual(expect.any(String));
    await app.query("COMMIT");
  } catch (error) {
    await app.query("ROLLBACK");
    throw error;
  } finally {
    app.release();
  }

  // And the confinement still holds: a connection with no request context
  // reads nothing, whoever owns the tables.
  const unscoped = await appPool.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM dasher.dashboards",
  );
  expect(unscoped.rows[0]?.count).toBe("0");
});
