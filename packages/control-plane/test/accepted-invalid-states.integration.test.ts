import { createHash, randomUUID } from "node:crypto";

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
  dropTemporaryAppLogin,
} from "./postgres-harness.js";

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
  ownerPool = new Pool({ connectionString: config.ownerDsn, max: 4 });
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

  await createTemporaryAppLogin(ownerPool, config.appDsn, appUsername);
  const appUrl = new URL(config.appDsn);
  appUrl.username = appUsername;
  appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });

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
           VALUES ($1, $2, $3, 1, 1, $4, 1, $5, now(), now(),
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
  if (ownerPool !== undefined) {
    await dropTemporaryAppLogin(ownerPool, config.appDatabase, appUsername);
    await ownerPool.end();
  }
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

  // Still open, and deliberately so: creating an organization and its first
  // owner is self-serve provisioning, which no seam function covers yet. Every
  // other identity workflow now has an entry point; this one is the last.
  it.fails(
    "the application role can create the first organization and its owner",
    async () => {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        const newUser = randomUUID();
        const newOrg = randomUUID();
        await client.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
          newUser,
        ]);
        await client.query(
          "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, 'first org')",
          [newOrg],
        );
        await client.query(
          `INSERT INTO dasher.memberships
           (membership_id, organization_id, user_id, role, state, authority_revision)
         VALUES ($1, $2, $3, 'admin', 'active', 1)`,
          [randomUUID(), newOrg, newUser],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  it("the application role can resolve an external identity to a user", async () => {
    // Pre-authentication, so there is no context to have. The function runs
    // as the owner, takes an issuer and subject, and returns nothing but the
    // user id it maps to.
    await ownerPool.query(
      `INSERT INTO dasher.external_identities (issuer, subject, user_id)
       VALUES ('https://issuer.example', $1, $2)`,
      [`subject-${alice}`, alice],
    );

    const client = await appPool.connect();
    try {
      const found = await client.query<{ readonly resolved: string | null }>(
        "SELECT dasher_api.resolve_external_identity($1, $2) AS resolved",
        ["https://issuer.example", `subject-${alice}`],
      );
      expect(found.rows[0]?.resolved).toBe(alice);

      const missing = await client.query<{ readonly resolved: string | null }>(
        "SELECT dasher_api.resolve_external_identity($1, $2) AS resolved",
        ["https://issuer.example", "nobody"],
      );
      expect(missing.rows[0]?.resolved).toBeNull();
    } finally {
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
       VALUES ($1, $2, 'invitee@example.com', 'editor', 'admin', 1, $3, $4,
               now() + interval '7 days')`,
      [randomUUID(), org, invitationToken, alice],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const accepted = await client.query<{ readonly membership: string }>(
        `SELECT dasher_api.accept_invitation($1::smallint, $2, $3, $4, $5)
           AS membership`,
        [1, invitationToken, invitee, randomUUID(), "test"],
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
           $1, 'gauge_reading', '/value', 'identity', $2, now()) AS id`,
        [snapshot.rows[0]!.id, sha256("42")],
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
