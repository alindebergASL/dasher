import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  parsePostgresIntegrationEnv,
  runMigrations,
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
 * States the baseline schema accepts and should not.
 *
 * Every test here states an invariant positively and is marked `it.fails`,
 * meaning the invariant is currently unmet. That is deliberate: when a fix
 * lands, `it.fails` starts failing because the body now passes, which forces
 * the marker off rather than letting a closed gap sit unnoticed. The set of
 * `.fails` markers in this file is therefore the remaining work, executable.
 *
 * The distinction that produced this file: cutting the multi-role apparatus
 * from the superseded series was right, but that series also carried the only
 * write path — `dasher_app` held no direct table grants and every mutation went
 * through a function that checked actor identity, legal transitions, and audit
 * atomicity. Replacing that with direct INSERT/UPDATE grants dropped the
 * enforcement along with the ceremony. Smaller and less governed are separate
 * choices, and only the first was intended.
 *
 * The states fall into two classes, and the second is worse than the first:
 *
 *   * under-enforcement — the schema accepts histories it should refuse:
 *     forged actors, illegal transitions, incoherent provenance, unsealed
 *     bundles, digests unrelated to the bytes they claim to summarise;
 *
 *   * incompleteness — the application role cannot perform the workflows the
 *     tables exist to serve. Two of those are circular rather than merely
 *     ungranted: resolving a session token needs the request context that the
 *     resolution would establish, and accepting an invitation needs the
 *     membership that acceptance would create. No grant fixes a cycle.
 *
 * Closing these needs a trusted mutation seam — a small set of narrow,
 * server-derived entry points — not the sixteen-table ledger back.
 */

const config = parsePostgresIntegrationEnv(process.env);
const appUsername = `dasher_test_${randomUUID().replaceAll("-", "")}`;
const ownerSuffix = randomUUID().replaceAll("-", "");
const ownerRole = `dasher_test_owner_${ownerSuffix}`;
const databaseName = `dasher_test_db_${ownerSuffix}`;

let operatorPool: Pool;
let ownerPool: Pool;
let appPool: Pool;

const org = randomUUID();
const otherOrg = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const carol = randomUUID();
const dashboardOne = randomUUID();
const dashboardTwo = randomUUID();
const otherOrgDashboard = randomUUID();

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Session tokens, one per seeded member. */
const tokens = new Map<string, Buffer>();

/**
 * Runs a body as the application role, authenticated as a real session.
 *
 * The context can no longer be asserted by setting GUCs: they are only
 * honoured alongside a keyed digest that `begin_request` stamps after
 * validating a token. The organization argument is kept for readability and
 * checked against what the session actually proves.
 */
async function asTenant<T>(
  organizationId: string,
  userId: string,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const token = tokens.get(userId);
  if (token === undefined) {
    throw new Error(`no seeded session for ${userId}`);
  }
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    const established = await client.query<{
      readonly organization_id: string;
    }>(
      "SELECT organization_id FROM dasher_api.begin_request($1::smallint, $2)",
      [1, token],
    );
    if (established.rows[0]?.organization_id !== organizationId) {
      throw new Error("session proved a different organization");
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

/** Asserts the database refused the operation, whatever the SQLSTATE. */
async function expectRejected(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toSatisfy(
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string",
  );
}

/** Seeds a published dashboard and returns its head version id. */
async function publishDashboard(dashboardId: string): Promise<string> {
  const versionId = randomUUID();
  const seed = await ownerPool.connect();
  try {
    await seed.query("BEGIN");
    await seed.query(
      `INSERT INTO dasher.dashboard_versions
         (organization_id, dashboard_id, version_id, canonical_spec_bytes,
          canonical_spec_sha256, validation_state, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'valid', $6)`,
      [org, dashboardId, versionId, Buffer.from("{}"), sha256("{}"), alice],
    );
    await seed.query(
      `UPDATE dasher.dashboards
         SET lifecycle_state = 'active', head_version_id = $3,
             lifecycle_revision = lifecycle_revision + 1
       WHERE organization_id = $1 AND dashboard_id = $2`,
      [org, dashboardId, versionId],
    );
    await seed.query("COMMIT");
  } catch (error) {
    await seed.query("ROLLBACK");
    throw error;
  } finally {
    seed.release();
  }
  return versionId;
}

/** Creates a dashboard and publishes a version through the seam. */
async function publishThroughSeam(
  organizationId: string,
  userId: string,
): Promise<{
  readonly dashboardId: string;
  readonly versionId: string;
  readonly runId: string;
}> {
  return asTenant(organizationId, userId, async (client) => {
    const dashboard = await client.query<{ readonly id: string }>(
      "SELECT dasher_api.create_dashboard($1, $2, 'test') AS id",
      ["seam dashboard", randomUUID()],
    );
    const dashboardId = dashboard.rows[0]!.id;
    const run = await client.query<{ readonly id: string }>(
      "SELECT dasher_api.start_run($1, $2, 'fake', 'fake-v1', $3, 'test') AS id",
      [dashboardId, "publish me", randomUUID()],
    );
    const runId = run.rows[0]!.id;
    const version = await client.query<{ readonly id: string }>(
      `SELECT dasher_api.finalize_run($1, $2, '[]'::jsonb, 1, $3, 'test') AS id`,
      [runId, Buffer.from('{"pages":[]}'), randomUUID()],
    );
    return { dashboardId, versionId: version.rows[0]!.id, runId };
  });
}

beforeAll(async () => {
  // Everything below runs against a schema owner that is NOSUPERUSER and
  // NOBYPASSRLS, which is the deployment this schema targets. Connecting as
  // the superuser the test database was created with would hide any failure
  // that only an ordinary owner suffers, and one already got through that way:
  // forcing row-level security disabled the whole write seam against an
  // ordinary owner while all 40 of these passed. The DSN from the environment
  // is now used only to provision.
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

  // The application credential keeps its own password from the environment;
  // only the database it points at moves to the one this run provisioned.
  const appDsnUrl = new URL(config.appDsn);
  appDsnUrl.pathname = `/${databaseName}`;
  const appDsn = appDsnUrl.toString();
  await createTemporaryAppLogin(ownerPool, appDsn, appUsername);
  const appUrl = new URL(appDsn);
  appUrl.username = appUsername;
  appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });
  ignoreTeardownShutdown(appPool);

  const seed = await ownerPool.connect();
  try {
    await seed.query("BEGIN");
    for (const [organizationId, members] of [
      [org, [alice, bob]],
      [otherOrg, [carol]],
    ] as const) {
      await seed.query(
        "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, $2)",
        [organizationId, `org ${organizationId.slice(0, 8)}`],
      );
      for (const userId of members) {
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
          [
            randomUUID(),
            organizationId,
            userId,
            token,
            sha256(`csrf:${userId}`),
          ],
        );
      }
    }
    for (const [organizationId, dashboardId, userId] of [
      [org, dashboardOne, alice],
      [org, dashboardTwo, alice],
      [otherOrg, otherOrgDashboard, carol],
    ] as const) {
      await seed.query(
        `INSERT INTO dasher.dashboards
           (organization_id, dashboard_id, title, lifecycle_state,
            lifecycle_revision, created_by_user_id)
         VALUES ($1, $2, $3, 'draft', 1, $4)`,
        [
          organizationId,
          dashboardId,
          `dashboard ${dashboardId.slice(0, 8)}`,
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

describe("the deployment these cases run against", () => {
  it("owns the schema as an ordinary role", async () => {
    // Guards the premise of every case below. If this suite is ever pointed
    // back at a superuser connection, row security stops applying to the owner
    // and a whole class of failure goes quiet again -- which is how forcing it
    // survived 40 passing tests.
    const result = await ownerPool.query<{
      readonly rolsuper: boolean;
      readonly rolbypassrls: boolean;
    }>(
      "SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER",
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("request identity", () => {
  it("a connection cannot act as a user it never authenticated as", async () => {
    // Names a real, active member of another organization and sets both
    // context settings directly, exactly as an attacker holding the
    // application connection would. Without the keyed digest that only
    // `begin_request` can stamp, the principal does not resolve and every
    // policy denies.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config($1, $2, true)", [
        "dasher.context_organization_id",
        otherOrg,
      ]);
      await client.query("SELECT set_config($1, $2, true)", [
        "dasher.context_user_id",
        carol,
      ]);
      const principal = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      expect(principal.rows[0]?.who).toBeNull();

      const visible = await client.query(
        "SELECT organization_id FROM dasher.dashboards",
      );
      expect(visible.rowCount).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

describe("attribution", () => {
  it("an editor cannot attribute a dashboard to another member", async () => {
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.dashboards
             (organization_id, dashboard_id, title, lifecycle_state,
              lifecycle_revision, created_by_user_id)
           VALUES ($1, $2, 'forged', 'draft', 1, $3)`,
          [org, randomUUID(), bob],
        ),
      ),
    );
  });

  it("an editor cannot attribute an agent run to another member", async () => {
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.agent_runs
             (organization_id, run_id, dashboard_id, requested_by_user_id,
              request_text, state)
           VALUES ($1, $2, $3, $4, 'forged request', 'running')`,
          [org, randomUUID(), dashboardOne, bob],
        ),
      ),
    );
  });
});

describe("dashboard lifecycle", () => {
  it("an active dashboard cannot roll back to draft", async () => {
    const dashboardId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.dashboards
         (organization_id, dashboard_id, title, lifecycle_state,
          lifecycle_revision, created_by_user_id)
       VALUES ($1, $2, 'rollback', 'draft', 1, $3)`,
      [org, dashboardId, alice],
    );
    await publishDashboard(dashboardId);

    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `UPDATE dasher.dashboards
             SET lifecycle_state = 'draft', head_version_id = NULL
           WHERE organization_id = $1 AND dashboard_id = $2`,
          [org, dashboardId],
        ),
      ),
    );
  });

  it("lifecycle_revision cannot move backwards", async () => {
    const published = await publishThroughSeam(org, alice);

    // Attempted as the owner, because the invariant belongs to the table
    // rather than to a grant: the guard holds whoever the writer is.
    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.dashboards SET lifecycle_revision = lifecycle_revision - 1
         WHERE organization_id = $1 AND dashboard_id = $2`,
        [org, published.dashboardId],
      ),
    );
  });

  it("an invalid version cannot become the head", async () => {
    const published = await publishThroughSeam(org, alice);
    const invalidVersion = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.dashboard_versions
         (organization_id, dashboard_id, version_id, canonical_spec_bytes,
          canonical_spec_sha256, validation_state, created_by_user_id)
       VALUES ($1, $2, $3, $4, sha256($4), 'invalid', $5)`,
      [org, published.dashboardId, invalidVersion, Buffer.from("{}"), alice],
    );

    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.dashboards
           SET head_version_id = $3,
               lifecycle_revision = lifecycle_revision + 1
         WHERE organization_id = $1 AND dashboard_id = $2`,
        [org, published.dashboardId, invalidVersion],
      ),
    );
  });
});

describe("run and version provenance", () => {
  it("a run cannot claim a version belonging to another dashboard", async () => {
    const foreignVersion = await publishDashboard(dashboardTwo);
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.agent_runs
             (organization_id, run_id, dashboard_id, requested_by_user_id,
              request_text, state, produced_version_id, finished_at)
           VALUES ($1, $2, $3, $4, 'cross-dashboard', 'succeeded', $5, now())`,
          [org, randomUUID(), dashboardOne, alice, foreignVersion],
        ),
      ),
    );
  });

  it("a version cannot cite a run that does not exist", async () => {
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.dashboard_versions
             (organization_id, dashboard_id, version_id, canonical_spec_bytes,
              canonical_spec_sha256, validation_state, created_by_user_id, run_id)
           VALUES ($1, $2, $3, $4, $5, 'valid', $6, $7)`,
          [
            org,
            dashboardOne,
            randomUUID(),
            Buffer.from("{}"),
            sha256("{}"),
            alice,
            randomUUID(),
          ],
        ),
      ),
    );
  });

  it("a terminal run cannot be reopened", async () => {
    const published = await publishThroughSeam(org, alice);

    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.agent_runs
           SET state = 'running', produced_version_id = NULL, finished_at = NULL
         WHERE organization_id = $1 AND run_id = $2`,
        [org, published.runId],
      ),
    );
  });

  it("a completed run's request text cannot be rewritten", async () => {
    const published = await publishThroughSeam(org, alice);

    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.agent_runs SET request_text = 'something else'
         WHERE organization_id = $1 AND run_id = $2`,
        [org, published.runId],
      ),
    );
  });
});

describe("published bundles", () => {
  it("a claim cannot be attached after its version is published", async () => {
    const dashboardId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.dashboards
         (organization_id, dashboard_id, title, lifecycle_state,
          lifecycle_revision, created_by_user_id)
       VALUES ($1, $2, 'sealed', 'draft', 1, $3)`,
      [org, dashboardId, alice],
    );
    const versionId = await publishDashboard(dashboardId);

    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.claims
             (organization_id, dashboard_id, version_id, claim_id, json_pointer,
              label, salience, evidence_state, assertion_sha256)
           VALUES ($1, $2, $3, $4, '/pages/0/title', 'observed', 'normal',
                   'complete', $5)`,
          [org, dashboardId, versionId, randomUUID(), sha256("late")],
        ),
      ),
    );
  });

  it("a version's stored digest must match its stored bytes", async () => {
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.dashboard_versions
             (organization_id, dashboard_id, version_id, canonical_spec_bytes,
              canonical_spec_sha256, validation_state, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, 'valid', $6)`,
          [
            org,
            dashboardOne,
            randomUUID(),
            Buffer.from('{"real":"bytes"}'),
            sha256("a completely different string"),
            alice,
          ],
        ),
      ),
    );
  });
});

describe("audit and evidence write paths", () => {
  it("a mutation and its audit event commit together or not at all", async () => {
    // Audit atomicity is now a property of the schema rather than a
    // convention: the application role cannot write either the dashboard or
    // the audit row directly, and the one function that writes the dashboard
    // writes the audit row in the same statement.
    const created = await asTenant(org, alice, async (client) => {
      const result = await client.query<{ readonly id: string }>(
        "SELECT dasher_api.create_dashboard($1, $2, 'test') AS id",
        ["audited dashboard", randomUUID()],
      );
      return result.rows[0]!.id;
    });

    const audited = await ownerPool.query(
      `SELECT 1 FROM dasher.audit_events
       WHERE organization_id = $1 AND action = 'dashboard.created'
         AND target_id = $2 AND actor_user_id = $3`,
      [org, created, alice],
    );
    expect(audited.rowCount).toBe(1);
  });
});

/**
 * A second review found a class the first one missed: the baseline is not only
 * under-enforced, it is functionally incomplete. The application role cannot
 * perform the workflows the identity tables exist to serve, and two of those
 * are circular rather than merely ungranted.
 */
describe("sign-in and onboarding", () => {
  it("the application role can find a session by its token digest", async () => {
    // The cycle is broken by not needing a context to start with:
    // `begin_request` runs as the owner, so it can see past the sessions
    // policy, validate the token, and only then establish the principal that
    // every later statement is filtered by.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const established = await client.query<{
        readonly user_id: string;
        readonly organization_id: string;
      }>("SELECT * FROM dasher_api.begin_request($1::smallint, $2)", [
        1,
        tokens.get(alice),
      ]);
      expect(established.rows[0]?.user_id).toBe(alice);
      expect(established.rows[0]?.organization_id).toBe(org);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("a revoked or expired session establishes nothing", async () => {
    const revoked = sha256(`revoked:${alice}`);
    await ownerPool.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at,
          revoked_at, revocation_reason)
       VALUES ($1, $2, $3, 1, 1, $4, 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours',
               now(), 'signed_out')`,
      [randomUUID(), org, alice, revoked, sha256(`revoked-csrf:${alice}`)],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await expectRejected(
        client.query(
          "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
          [1, revoked],
        ),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("the application role cannot create an organization", async () => {
    // Not a gap. `PRODUCT_REQUIREMENTS.md:248` makes managing organizations an
    // administrator action and names public signup a non-goal, which the
    // roadmap repeats as an explicit deferral. Provisioning is therefore an
    // operator path using owner credentials, not an application feature, and
    // the denial below is the intended behaviour rather than missing work.
    //
    // This also settles how a development or pilot organization is seeded:
    // doing it with owner credentials is not a workaround, it is what an
    // administrator does in production.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await expectRejected(
        client.query(
          "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, 'self serve')",
          [randomUUID()],
        ),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("an invited user can accept without already holding a membership", async () => {
    // The second cycle. The invitee has no membership, so no context can exist
    // for them; the invitation token is the only thing they can present.
    const invitee = randomUUID();
    const invitationToken = sha256(`invite:${invitee}`);
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      invitee,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.invitations
         (invitation_id, organization_id, normalized_email, granted_role,
          role_ceiling, token_key_version, token_digest, created_by_user_id,
          expires_at)
       VALUES ($1, $2, 'invitee@example.com', 'editor', 'admin', 1, sha256($3), $4,
               now() + interval '7 days')`,
      [randomUUID(), org, invitationToken, alice],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const accepted = await client.query<{ readonly membership: string }>(
        `SELECT dasher_api.accept_invitation($1::smallint, $2, $3, $4, $5, $6, 'test')
           AS membership`,
        [
          1,
          invitationToken,
          "https://issuer.example",
          `subject-invitee-${invitee}`,
          "invitee@example.com",
          randomUUID(),
        ],
      );
      expect(accepted.rows[0]?.membership).toEqual(expect.any(String));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Acceptance and its audit event are one statement, so neither can happen
    // without the other.
    const audit = await ownerPool.query(
      `SELECT 1 FROM dasher.audit_events
       WHERE organization_id = $1 AND action = 'invitation.accepted'`,
      [org],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe("timestamp coherence", () => {
  it("a session cannot have been seen after it idled out", async () => {
    await expectRejected(
      ownerPool.query(
        `INSERT INTO dasher.sessions
           (session_id, organization_id, user_id, authority_revision,
            token_key_version, token_digest, csrf_key_version, csrf_digest,
            issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, 1, 1, $4, 1, $5,
                 now(),
                 now() + interval '40 minutes',
                 now() + interval '30 minutes',
                 now() + interval '12 hours')`,
        [randomUUID(), org, alice, sha256(randomUUID()), sha256(randomUUID())],
      ),
    );
  });

  it("an invitation cannot be accepted before it was created", async () => {
    await expectRejected(
      ownerPool.query(
        `INSERT INTO dasher.invitations
           (invitation_id, organization_id, normalized_email, granted_role,
            role_ceiling, token_key_version, token_digest, created_by_user_id,
            created_at, expires_at, accepted_at, accepted_user_id)
         VALUES ($1, $2, 'invitee@example.com', 'viewer', 'admin', 1, $3, $4,
                 now(), now() + interval '7 days', now() - interval '1 day', $5)`,
        [randomUUID(), org, sha256(randomUUID()), alice, bob],
      ),
    );
  });

  it("an invitation cannot be accepted after it expired", async () => {
    await expectRejected(
      ownerPool.query(
        `INSERT INTO dasher.invitations
           (invitation_id, organization_id, normalized_email, granted_role,
            role_ceiling, token_key_version, token_digest, created_by_user_id,
            created_at, expires_at, accepted_at, accepted_user_id)
         VALUES ($1, $2, 'late@example.com', 'viewer', 'admin', 1, $3, $4,
                 now() - interval '30 days', now() - interval '20 days',
                 now(), $5)`,
        [randomUUID(), org, sha256(randomUUID()), alice, bob],
      ),
    );
  });

  it("a dashboard cannot be archived before it was created", async () => {
    // Published first, then archived by UPDATE. Inserting an archived row
    // outright is refused by the deferred head foreign key, which would make
    // this pass without any timestamp rule existing.
    const dashboardId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.dashboards
         (organization_id, dashboard_id, title, lifecycle_state,
          lifecycle_revision, created_by_user_id)
       VALUES ($1, $2, 'time traveller', 'draft', 1, $3)`,
      [org, dashboardId, alice],
    );
    await publishDashboard(dashboardId);

    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.dashboards
           SET lifecycle_state = 'archived',
               archived_at = created_at - interval '1 day'
         WHERE organization_id = $1 AND dashboard_id = $2`,
        [org, dashboardId],
      ),
    );
  });
});

describe("run and version cardinality", () => {
  it("a succeeded run must name the dashboard it produced a version for", async () => {
    await expectRejected(
      asTenant(org, alice, async (client) => {
        const versionId = await publishDashboard(dashboardOne);
        return client.query(
          `INSERT INTO dasher.agent_runs
             (organization_id, run_id, dashboard_id, requested_by_user_id,
              request_text, state, produced_version_id, finished_at)
           VALUES ($1, $2, NULL, $3, 'orphan success', 'succeeded', $4, now())`,
          [org, randomUUID(), alice, versionId],
        );
      }),
    );
  });

  it("two runs cannot claim to have produced the same version", async () => {
    const published = await publishThroughSeam(org, alice);

    await expectRejected(
      ownerPool.query(
        `INSERT INTO dasher.agent_runs
           (organization_id, run_id, dashboard_id, requested_by_user_id,
            request_text, state, produced_version_id, finished_at)
         VALUES ($1, $2, $3, $4, 'second claimant', 'succeeded', $5, now())`,
        [org, randomUUID(), published.dashboardId, alice, published.versionId],
      ),
    );
  });
});

describe("evidence immutability and completeness", () => {
  it("the application role can record a source snapshot and its evidence", async () => {
    const recorded = await asTenant(org, alice, async (client) => {
      const snapshot = await client.query<{ readonly id: string }>(
        `SELECT dasher_api.record_source_snapshot(
           'usgs', 'gauge/11447650', $1, now(), $2, 'test') AS id`,
        [Buffer.from('{"value":42}'), randomUUID()],
      );
      const evidence = await client.query<{ readonly id: string }>(
        `SELECT dasher_api.record_evidence(
           $1, 'gauge_reading', '/value', 'identity', $2, now(), $3, 'test') AS id`,
        [snapshot.rows[0]!.id, sha256("42"), randomUUID()],
      );
      return {
        snapshot: snapshot.rows[0]!.id,
        evidence: evidence.rows[0]!.id,
      };
    });

    // The digest is derived inside the function rather than accepted from the
    // caller, so it cannot disagree with the bytes stored beside it.
    const stored = await ownerPool.query<{ readonly matches: boolean }>(
      `SELECT content_sha256 = sha256(canonical_bytes) AS matches
       FROM dasher.source_snapshots WHERE snapshot_id = $1`,
      [recorded.snapshot],
    );
    expect(stored.rows[0]?.matches).toBe(true);
    expect(recorded.evidence).toEqual(expect.any(String));
  });

  it("recording evidence writes its audit event in the same transaction", async () => {
    // I18 in the seam review brief claims every action named in
    // `audit_events_action_check` that the seam performs writes its audit event
    // alongside the state change, such that neither can occur without the
    // other. `evidence_record.created` is in that allowlist and
    // `record_evidence` wrote nothing, so the invariant was stated and untrue —
    // an evidence record could exist with no trace of who put it there.
    const requestId = randomUUID();
    const evidenceId = await asTenant(org, alice, async (client) => {
      const snapshot = await client.query<{ readonly id: string }>(
        `SELECT dasher_api.record_source_snapshot(
           'usgs', 'gauge/11447650', $1, now(), $2, 'test') AS id`,
        [Buffer.from('{"value":7}'), randomUUID()],
      );
      const evidence = await client.query<{ readonly id: string }>(
        `SELECT dasher_api.record_evidence(
           $1, 'gauge_reading', '/value', 'identity', $2, now(), $3, 'test') AS id`,
        [snapshot.rows[0]!.id, sha256("7"), requestId],
      );
      return evidence.rows[0]!.id;
    });

    const audited = await ownerPool.query<{
      readonly action: string;
      readonly target_id: string;
      readonly actor_user_id: string;
      readonly request_id: string;
    }>(
      `SELECT action, target_id::text, actor_user_id::text, request_id::text
       FROM dasher.audit_events WHERE target_id = $1`,
      [evidenceId],
    );

    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]).toMatchObject({
      action: "evidence_record.created",
      target_id: evidenceId,
      actor_user_id: alice,
      request_id: requestId,
    });
  });

  it("leaves no evidence record behind when its audit event cannot be written", async () => {
    // The other half of "neither can occur without the other". A rejected audit
    // event must take the evidence with it, or the atomicity is only a claim
    // about the happy path.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT organization_id FROM dasher_api.begin_request($1::smallint, $2)",
        [1, tokens.get(alice)!],
      );
      const snapshot = await client.query<{ readonly id: string }>(
        `SELECT dasher_api.record_source_snapshot(
           'usgs', 'gauge/11447650', $1, now(), $2, 'test') AS id`,
        [Buffer.from('{"value":8}'), randomUUID()],
      );
      // A deployment revision longer than the column admits: the audit insert
      // fails after the evidence insert has already happened.
      await expectRejected(
        client.query(
          `SELECT dasher_api.record_evidence(
             $1, 'gauge_reading', '/value', 'identity', $2, now(), $3, $4) AS id`,
          [snapshot.rows[0]!.id, sha256("8"), randomUUID(), "x".repeat(400)],
        ),
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const orphans = await ownerPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM dasher.evidence_records AS record
       WHERE record.content_sha256 = sha256('8')
         AND NOT EXISTS (
           SELECT 1 FROM dasher.audit_events AS event
           WHERE event.target_id = record.evidence_id
         )`,
    );
    expect(orphans.rows[0]?.count).toBe("0");
  });

  it("a recorded source snapshot cannot be rewritten", async () => {
    const snapshotId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.source_snapshots
         (organization_id, snapshot_id, source_kind, source_ref,
          canonical_bytes, content_sha256, observed_at, retrieved_at)
       VALUES ($1, $2, 'usgs', 'gauge/11447650', $3, sha256($3), now(), now())`,
      [org, snapshotId, Buffer.from("original")],
    );

    // Asserted against the owner: the invariant must belong to the table, not
    // to a grant that happens to be withheld today.
    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.source_snapshots SET canonical_bytes = $3
         WHERE organization_id = $1 AND snapshot_id = $2`,
        [org, snapshotId, Buffer.from("rewritten")],
      ),
    );
  });

  it("a recorded evidence record cannot be rewritten", async () => {
    const snapshotId = randomUUID();
    const evidenceId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.source_snapshots
         (organization_id, snapshot_id, source_kind, source_ref,
          canonical_bytes, content_sha256, observed_at, retrieved_at)
       VALUES ($1, $2, 'usgs', 'gauge/11447650', $3, sha256($3), now(), now())`,
      [org, snapshotId, Buffer.from("evidence base")],
    );
    await ownerPool.query(
      `INSERT INTO dasher.evidence_records
         (organization_id, evidence_id, snapshot_id, evidence_kind,
          coordinates, transformation, content_sha256, observed_at)
       VALUES ($1, $2, $3, 'gauge_reading', '/value/0', 'identity', $4, now())`,
      [org, evidenceId, snapshotId, sha256("evidence base")],
    );

    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.evidence_records SET transformation = 'rewritten'
         WHERE organization_id = $1 AND evidence_id = $2`,
        [org, evidenceId],
      ),
    );
  });

  it("a claim marked complete must cite at least one supporting evidence edge", async () => {
    const published = await publishThroughSeam(org, alice);
    const draftVersion = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.dashboard_versions
         (organization_id, dashboard_id, version_id, canonical_spec_bytes,
          canonical_spec_sha256, validation_state, created_by_user_id)
       VALUES ($1, $2, $3, $4, sha256($4), 'valid', $5)`,
      [org, published.dashboardId, draftVersion, Buffer.from("{}"), alice],
    );

    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dasher.claims
           (organization_id, dashboard_id, version_id, claim_id, json_pointer,
            label, salience, evidence_state, assertion_sha256)
         VALUES ($1, $2, $3, $4, '/pages/0/uncited', 'observed', 'high',
                 'complete', $5)`,
        [org, published.dashboardId, draftVersion, randomUUID(), sha256("x")],
      );
      // Deferred to commit, because the claim necessarily exists before the
      // edge that would support it.
      await expectRejected(client.query("COMMIT"));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});

describe("request context replay", () => {
  it("a captured context cannot be replayed in another transaction", async () => {
    // The test that should have existed. The earlier construction signed only
    // the principal, which made the settings a bearer credential: authenticate
    // once, read all of them with `current_setting`, and replay them later on
    // any connection. Independent review found it; it reproduced; this pins it
    // shut.
    const captured = await asTenant(org, alice, async (client) => {
      const result = await client.query<{
        readonly user_id: string;
        readonly organization_id: string;
        readonly session_id: string;
        readonly authority: string;
        readonly digest: string;
      }>(
        `SELECT current_setting('dasher.context_user_id') AS user_id,
                current_setting('dasher.context_organization_id') AS organization_id,
                current_setting('dasher.context_session_id') AS session_id,
                current_setting('dasher.context_authority') AS authority,
                current_setting('dasher.context_digest') AS digest`,
      );
      return result.rows[0]!;
    });

    // Everything the caller could possibly have taken, replayed verbatim.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      // Force an identifier onto this transaction first. Without a write,
      // `pg_current_xact_id_if_assigned` returns NULL and `verified_context`
      // denies on that guard alone — which would make this test pass even if
      // the transaction were removed from the digest entirely. Verified by
      // mutation: it did.
      await client.query("SELECT pg_current_xact_id()");
      for (const [name, value] of [
        ["dasher.context_user_id", captured.user_id],
        ["dasher.context_organization_id", captured.organization_id],
        ["dasher.context_session_id", captured.session_id],
        ["dasher.context_authority", captured.authority],
        ["dasher.context_digest", captured.digest],
      ] as const) {
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }

      const principal = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      expect(principal.rows[0]?.who).toBeNull();

      const visible = await client.query(
        "SELECT dashboard_id FROM dasher.dashboards",
      );
      expect(visible.rowCount).toBe(0);

      await expectRejected(
        client.query("SELECT dasher_api.create_dashboard($1, $2, 'test')", [
          "replayed",
          randomUUID(),
        ]),
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("a captured context cannot be replayed after its session is revoked", async () => {
    const victim = randomUUID();
    const victimToken = sha256(`replay-victim:${victim}`);
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      victim,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, 'editor', 'active', 1)`,
      [randomUUID(), org, victim],
    );
    await ownerPool.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours')`,
      [randomUUID(), org, victim, victimToken, sha256(`rv-csrf:${victim}`)],
    );
    tokens.set(victim, victimToken);

    const captured = await asTenant(org, victim, async (client) => {
      const result = await client.query<{ readonly settings: string }>(
        `SELECT current_setting('dasher.context_user_id') || '|' ||
                current_setting('dasher.context_organization_id') || '|' ||
                current_setting('dasher.context_session_id') || '|' ||
                current_setting('dasher.context_authority') || '|' ||
                current_setting('dasher.context_digest') AS settings`,
      );
      return result.rows[0]!.settings.split("|");
    });

    await ownerPool.query(
      `UPDATE dasher.sessions SET revoked_at = now(), revocation_reason = 'test'
       WHERE user_id = $1`,
      [victim],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_current_xact_id()");
      const names = [
        "dasher.context_user_id",
        "dasher.context_organization_id",
        "dasher.context_session_id",
        "dasher.context_authority",
        "dasher.context_digest",
      ];
      for (const [index, name] of names.entries()) {
        await client.query("SELECT set_config($1, $2, true)", [
          name,
          captured[index],
        ]);
      }
      const principal = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      expect(principal.rows[0]?.who).toBeNull();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("a context established legitimately authorizes across its own transaction", async () => {
    // The fix must not make the context single-use: every statement after
    // begin_request, in that transaction, still resolves the principal.
    const observed = await asTenant(org, alice, async (client) => {
      const first = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      await client.query("SELECT count(*) FROM dasher.dashboards");
      const second = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      return [first.rows[0]?.who, second.rows[0]?.who];
    });
    expect(observed).toEqual([alice, alice]);
  });

  it("a missing context key denies rather than admits", async () => {
    // `NULL <> anything` is NULL, not TRUE, so comparing against a NULL
    // expected digest fell through and admitted the caller. Exercising that
    // branch requires the key to actually be gone: supplying a bad digest
    // while the key exists only tests ordinary mismatch.
    const saved = await ownerPool.query<{ readonly secret: Buffer }>(
      "SELECT secret FROM dasher_private.context_keys",
    );
    expect(saved.rowCount).toBe(1);
    await ownerPool.query("DELETE FROM dasher_private.context_keys");

    try {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_current_xact_id()");
        for (const [name, value] of [
          ["dasher.context_user_id", alice],
          ["dasher.context_organization_id", org],
          ["dasher.context_session_id", randomUUID()],
          ["dasher.context_authority", "1"],
          ["dasher.context_digest", "00"],
        ] as const) {
          await client.query("SELECT set_config($1, $2, true)", [name, value]);
        }
        const principal = await client.query<{ readonly who: string | null }>(
          "SELECT dasher_private.context_user_id()::text AS who",
        );
        expect(principal.rows[0]?.who).toBeNull();
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await ownerPool.query(
        "INSERT INTO dasher_private.context_keys (secret) VALUES ($1)",
        [saved.rows[0]!.secret],
      );
    }
  });
});

/**
 * Written before the fix, from the attacker's position rather than from the
 * code's structure: what does a caller hold, and what can it reach with it?
 *
 * Each case is required to fail against the schema as it stands, then pass
 * after the fix, then fail again when the fix is deliberately reverted. A test
 * that cannot detect the defect it names does not count as evidence — four in
 * this file previously passed for reasons unrelated to what they claimed.
 */
describe("session credentials", () => {
  it("the application role cannot read stored session verifiers", async () => {
    // If the caller can read the column that authenticates a session, the
    // stored verifier is a credential rather than a verifier.
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query("SELECT token_digest FROM dasher.sessions"),
      ),
    );
    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query("SELECT csrf_digest FROM dasher.sessions"),
      ),
    );
  });

  it("a stored verifier cannot be used to authenticate", async () => {
    // The whole attack: hold one session, read another's stored verifier, and
    // present it. Reads the digest as the owner so the case still stands even
    // if the column grant above were the only thing stopping it — the point is
    // that the digest must not be accepted as input, not merely that it is
    // hard to obtain.
    const second = randomUUID();
    const secondRaw = sha256(`raw-second-device:${alice}`);
    await ownerPool.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours')`,
      [second, org, alice, secondRaw, sha256(`csrf-second:${alice}`)],
    );

    const stored = await ownerPool.query<{ readonly token_digest: Buffer }>(
      "SELECT token_digest FROM dasher.sessions WHERE session_id = $1",
      [second],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await expectRejected(
        client.query(
          "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
          [1, stored.rows[0]!.token_digest],
        ),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("the raw token still authenticates its own session", async () => {
    // The fix must not break the legitimate path, which is the failure mode a
    // careless correction here would introduce.
    const third = randomUUID();
    const thirdRaw = sha256(`raw-third-device:${alice}`);
    await ownerPool.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours')`,
      [third, org, alice, thirdRaw, sha256(`csrf-third:${alice}`)],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const established = await client.query<{ readonly user_id: string }>(
        "SELECT user_id FROM dasher_api.begin_request($1::smallint, $2)",
        [1, thirdRaw],
      );
      expect(established.rows[0]?.user_id).toBe(alice);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

/**
 * Three coupled defects, written from the attack before any fix exists.
 *
 * They are one unit because fixing any alone leaves the others open: binding a
 * context to an authority revision means nothing if a role change need not
 * advance that revision, and neither helps if establishment is not atomic
 * against a concurrent revocation.
 */
describe("authority and establishment", () => {
  it("a role change must advance the authority revision", async () => {
    // Every other authority check trusts this. Nothing enforced it, so an
    // operator could grant admin while leaving the revision — and every
    // session issued under the old authority — apparently valid.
    const subject = randomUUID();
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      subject,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, 'viewer', 'active', 1)`,
      [randomUUID(), org, subject],
    );

    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.memberships SET role = 'admin', updated_at = now()
         WHERE organization_id = $1 AND user_id = $2`,
        [org, subject],
      ),
    );

    // Advancing it together is the legal form.
    await ownerPool.query(
      `UPDATE dasher.memberships
         SET role = 'admin',
             authority_revision = authority_revision + 1,
             updated_at = now()
       WHERE organization_id = $1 AND user_id = $2`,
      [org, subject],
    );
  });

  it("a context stops authorizing once its authority is superseded", async () => {
    // Signed at revision N; the live membership moves to N+1. The context must
    // not carry over, in either direction — this reproduced as a viewer
    // context reading admin-only rows after a mid-transaction promotion.
    const subject = randomUUID();
    const raw = sha256(`authority-subject:${subject}`);
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      subject,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, 'viewer', 'active', 1)`,
      [randomUUID(), org, subject],
    );
    await ownerPool.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours')`,
      [randomUUID(), org, subject, raw, sha256(`auth-csrf:${subject}`)],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
        [1, raw],
      );
      const before = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      expect(before.rows[0]?.who).toBe(subject);

      await ownerPool.query(
        `UPDATE dasher.memberships
           SET role = 'admin',
               authority_revision = authority_revision + 1,
               updated_at = now()
         WHERE organization_id = $1 AND user_id = $2`,
        [org, subject],
      );

      const after = await client.query<{ readonly who: string | null }>(
        "SELECT dasher_private.context_user_id()::text AS who",
      );
      expect(after.rows[0]?.who).toBeNull();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("a session revoked while establishment blocks does not establish", async () => {
    // The race: begin_request read the session, then refreshed it with an
    // UPDATE whose only predicate was the session id. Blocking behind a
    // concurrent revocation and resuming after it commits, the UPDATE still
    // matched, so a context was stamped for a session that was already gone.
    const subject = randomUUID();
    const raw = sha256(`race-subject:${subject}`);
    const sessionId = randomUUID();
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      subject,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, 'editor', 'active', 1)`,
      [randomUUID(), org, subject],
    );
    await ownerPool.query(
      `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, sha256($4), 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours')`,
      [sessionId, org, subject, raw, sha256(`race-csrf:${subject}`)],
    );

    const revoker = await ownerPool.connect();
    const attacker = await appPool.connect();
    try {
      // Hold the row lock without committing.
      await revoker.query("BEGIN");
      await revoker.query(
        `UPDATE dasher.sessions SET revoked_at = now(), revocation_reason = 'race'
         WHERE session_id = $1`,
        [sessionId],
      );

      // begin_request now blocks behind that lock.
      await attacker.query("BEGIN");
      const establishing = attacker.query(
        "SELECT * FROM dasher_api.begin_request($1::smallint, $2)",
        [1, raw],
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      await revoker.query("COMMIT");

      await expectRejected(establishing);
    } finally {
      await attacker.query("ROLLBACK").catch(() => undefined);
      await revoker.query("ROLLBACK").catch(() => undefined);
      attacker.release();
      revoker.release();
    }
  });
});

/**
 * Invitation acceptance, written from the attack before the fix exists.
 *
 * The invitee holds no membership, so no request context can exist for them —
 * that is the cycle acceptance has to break. Breaking it by taking the user as
 * an argument made the token an "add anyone" token instead of "this person may
 * join", which is a different and worse thing.
 */
describe("invitation acceptance", () => {
  /** Issues an invitation and returns the raw token to present. */
  async function issueInvitation(
    email: string,
    grantedRole: string,
  ): Promise<Buffer> {
    const raw = sha256(`invite:${email}:${randomUUID()}`);
    await ownerPool.query(
      `INSERT INTO dasher.invitations
         (invitation_id, organization_id, normalized_email, granted_role,
          role_ceiling, token_key_version, token_digest, created_by_user_id,
          expires_at)
       VALUES ($1, $2, $3, $4, 'admin', 1, sha256($5), $6,
               now() + interval '7 days')`,
      [randomUUID(), org, email, grantedRole, raw, alice],
    );
    return raw;
  }

  it("acceptance is refused when the verified email is not the invitee", async () => {
    // The attack: hold a token addressed to someone else and claim it.
    const raw = await issueInvitation("intended@example.com", "editor");
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await expectRejected(
        client.query(
          `SELECT dasher_api.accept_invitation($1::smallint, $2, $3, $4, $5, $6, 'test')`,
          [
            1,
            raw,
            "https://issuer.example",
            `subject-${randomUUID()}`,
            "someone.else@example.com",
            randomUUID(),
          ],
        ),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("a viewer invitation cannot restore a revoked admin as admin", async () => {
    const returning = randomUUID();
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      returning,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.external_identities (issuer, subject, user_id)
       VALUES ('https://issuer.example', $1, $2)`,
      [`subject-returning-${returning}`, returning],
    );
    await ownerPool.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state,
          authority_revision, revoked_at)
       VALUES ($1, $2, $3, 'admin', 'revoked', 5, now())`,
      [randomUUID(), org, returning],
    );

    const raw = await issueInvitation("returning@example.com", "viewer");
    await asTenant(org, alice, () => Promise.resolve());
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT dasher_api.accept_invitation($1::smallint, $2, $3, $4, $5, $6, 'test')`,
        [
          1,
          raw,
          "https://issuer.example",
          `subject-returning-${returning}`,
          "returning@example.com",
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const restored = await ownerPool.query<{
      readonly role: string;
      readonly state: string;
    }>(
      "SELECT role, state FROM dasher.memberships WHERE organization_id = $1 AND user_id = $2",
      [org, returning],
    );
    expect(restored.rows[0]).toEqual({ role: "viewer", state: "active" });
  });

  it("acceptance creates the membership at exactly the granted role", async () => {
    // The legitimate path must still work, and must record the resolved user
    // rather than anything the caller named.
    const joiner = randomUUID();
    const subject = `subject-joiner-${joiner}`;
    await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
      joiner,
    ]);
    await ownerPool.query(
      `INSERT INTO dasher.external_identities (issuer, subject, user_id)
       VALUES ('https://issuer.example', $1, $2)`,
      [subject, joiner],
    );
    const raw = await issueInvitation("joiner@example.com", "editor");

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT dasher_api.accept_invitation($1::smallint, $2, $3, $4, $5, $6, 'test')`,
        [
          1,
          raw,
          "https://issuer.example",
          subject,
          "joiner@example.com",
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const created = await ownerPool.query<{ readonly role: string }>(
      "SELECT role FROM dasher.memberships WHERE organization_id = $1 AND user_id = $2",
      [org, joiner],
    );
    expect(created.rows[0]?.role).toBe("editor");

    const audited = await ownerPool.query(
      `SELECT 1 FROM dasher.audit_events
       WHERE organization_id = $1 AND actor_user_id = $2
         AND action = 'invitation.accepted'`,
      [org, joiner],
    );
    expect(audited.rowCount).toBe(1);
  });
});
