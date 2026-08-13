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

/** Runs a body as the application role under a named request context. */
async function asTenant<T>(
  organizationId: string,
  userId: string,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [
      "dasher.context_organization_id",
      organizationId,
    ]);
    await client.query("SELECT set_config($1, $2, true)", [
      "dasher.context_user_id",
      userId,
    ]);
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
  it.fails(
    "a connection cannot act as a user it never authenticated as",
    async () => {
      // The application role chooses both GUCs itself, and `context_allows`
      // verifies only that the named user holds a membership — not that this
      // session legitimately acts as them. Anything able to issue SQL on the
      // application connection can therefore name any member of any organization
      // and read their rows. Nothing here proves a session.
      const rows = await asTenant(otherOrg, carol, async (client) => {
        const result = await client.query(
          "SELECT organization_id FROM dasher.dashboards",
        );
        return result.rowCount ?? 0;
      });
      expect(rows).toBe(0);
    },
  );
});

describe("attribution", () => {
  it.fails(
    "an editor cannot attribute a dashboard to another member",
    async () => {
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
    },
  );

  it.fails(
    "an editor cannot attribute an agent run to another member",
    async () => {
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
    },
  );
});

describe("dashboard lifecycle", () => {
  it.fails("an active dashboard cannot roll back to draft", async () => {
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

  it.fails("lifecycle_revision cannot move backwards", async () => {
    // Raised to 5 first on purpose. Decrementing from 1 would be refused by the
    // `lifecycle_revision >= 1` floor, which would make this test pass without
    // monotonicity being enforced anywhere.
    await ownerPool.query(
      `UPDATE dasher.dashboards SET lifecycle_revision = 5
       WHERE organization_id = $1 AND dashboard_id = $2`,
      [org, dashboardTwo],
    );

    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `UPDATE dasher.dashboards SET lifecycle_revision = 2
           WHERE organization_id = $1 AND dashboard_id = $2`,
          [org, dashboardTwo],
        ),
      ),
    );
  });

  it.fails("an invalid version cannot become the head", async () => {
    const dashboardId = randomUUID();
    const badVersion = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.dashboards
         (organization_id, dashboard_id, title, lifecycle_state,
          lifecycle_revision, created_by_user_id)
       VALUES ($1, $2, 'invalid head', 'draft', 1, $3)`,
      [org, dashboardId, alice],
    );
    await asTenant(org, alice, (client) =>
      client.query(
        `INSERT INTO dasher.dashboard_versions
           (organization_id, dashboard_id, version_id, canonical_spec_bytes,
            canonical_spec_sha256, validation_state, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'invalid', $6)`,
        [org, dashboardId, badVersion, Buffer.from("{}"), sha256("{}"), alice],
      ),
    );

    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `UPDATE dasher.dashboards
             SET lifecycle_state = 'active', head_version_id = $3,
                 lifecycle_revision = lifecycle_revision + 1
           WHERE organization_id = $1 AND dashboard_id = $2`,
          [org, dashboardId, badVersion],
        ),
      ),
    );
  });
});

describe("run and version provenance", () => {
  it.fails(
    "a run cannot claim a version belonging to another dashboard",
    async () => {
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
    },
  );

  it.fails("a version cannot cite a run that does not exist", async () => {
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

  it.fails("a terminal run cannot be reopened", async () => {
    const runId = randomUUID();
    const versionId = await publishDashboard(dashboardOne);
    await asTenant(org, alice, (client) =>
      client.query(
        `INSERT INTO dasher.agent_runs
           (organization_id, run_id, dashboard_id, requested_by_user_id,
            request_text, state, produced_version_id, finished_at)
         VALUES ($1, $2, $3, $4, 'original request', 'succeeded', $5, now())`,
        [org, runId, dashboardOne, alice, versionId],
      ),
    );

    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `UPDATE dasher.agent_runs
             SET state = 'running', produced_version_id = NULL, finished_at = NULL
           WHERE organization_id = $1 AND run_id = $2`,
          [org, runId],
        ),
      ),
    );
  });

  it.fails("a completed run's request text cannot be rewritten", async () => {
    const runId = randomUUID();
    await asTenant(org, alice, (client) =>
      client.query(
        `INSERT INTO dasher.agent_runs
           (organization_id, run_id, dashboard_id, requested_by_user_id,
            request_text, state, failure_reason, finished_at)
         VALUES ($1, $2, $3, $4, 'what was actually asked', 'failed',
                 'planner_rejected', now())`,
        [org, runId, dashboardOne, alice],
      ),
    );

    await expectRejected(
      asTenant(org, alice, (client) =>
        client.query(
          `UPDATE dasher.agent_runs SET request_text = 'something else'
           WHERE organization_id = $1 AND run_id = $2`,
          [org, runId],
        ),
      ),
    );
  });
});

describe("published bundles", () => {
  it.fails(
    "a claim cannot be attached after its version is published",
    async () => {
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
    },
  );

  it.fails(
    "a version's stored digest must match its stored bytes",
    async () => {
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
    },
  );
});

describe("audit and evidence write paths", () => {
  it.fails(
    "the application role can record an audit event for its own mutation",
    async () => {
      await asTenant(org, alice, async (client) => {
        await client.query(
          `UPDATE dasher.dashboards SET title = 'renamed'
         WHERE organization_id = $1 AND dashboard_id = $2`,
          [org, dashboardTwo],
        );
        await client.query(
          `INSERT INTO dasher.audit_events
           (audit_event_id, organization_id, actor_kind, actor_user_id,
            authority_revision, request_id, action, target_type, target_id,
            outcome, deployment_revision)
         VALUES ($1, $2, 'user', $3, 1, $4, 'dashboard.created', 'dashboard',
                 $5, 'succeeded', 'test')`,
          [randomUUID(), org, alice, randomUUID(), dashboardTwo],
        );
      });
    },
  );

  it.fails(
    "the application role can record a source snapshot and its evidence",
    async () => {
      const snapshotId = randomUUID();
      await asTenant(org, alice, async (client) => {
        await client.query(
          `INSERT INTO dasher.source_snapshots
           (organization_id, snapshot_id, source_kind, source_ref,
            canonical_bytes, content_sha256, observed_at, retrieved_at)
         VALUES ($1, $2, 'usgs', 'gauge/11447650', $3, $4, now(), now())`,
          [org, snapshotId, Buffer.from("bytes"), sha256("bytes")],
        );
        await client.query(
          `INSERT INTO dasher.evidence_records
           (organization_id, evidence_id, snapshot_id, evidence_kind,
            coordinates, transformation, content_sha256, observed_at)
         VALUES ($1, $2, $3, 'gauge_reading', '/value/0', 'identity', $4, now())`,
          [org, randomUUID(), snapshotId, sha256("bytes")],
        );
      });
    },
  );

  it.fails("a recorded source snapshot cannot be rewritten", async () => {
    const snapshotId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.source_snapshots
         (organization_id, snapshot_id, source_kind, source_ref,
          canonical_bytes, content_sha256, observed_at, retrieved_at)
       VALUES ($1, $2, 'usgs', 'gauge/11447650', $3, $4, now(), now())`,
      [org, snapshotId, Buffer.from("original"), sha256("original")],
    );

    // Asserted against the owner, because the invariant under test is whether
    // the table itself refuses rewriting — not whether a grant happens to be
    // withheld from one role today.
    await expectRejected(
      ownerPool.query(
        `UPDATE dasher.source_snapshots SET canonical_bytes = $3
         WHERE organization_id = $1 AND snapshot_id = $2`,
        [org, snapshotId, Buffer.from("rewritten")],
      ),
    );
  });
});

/**
 * A second review found a class the first one missed: the baseline is not only
 * under-enforced, it is functionally incomplete. The application role cannot
 * perform the workflows the identity tables exist to serve, and two of those
 * are circular rather than merely ungranted.
 */
describe("sign-in and onboarding", () => {
  it.fails(
    "the application role can find a session by its token digest",
    async () => {
      // The circularity: `sessions_read` requires context_user_id() to equal the
      // row's user_id, but resolving an opaque token to a user is precisely what
      // the lookup is for. There is no context to set until the lookup succeeds,
      // and the lookup cannot succeed without one.
      const sessionId = randomUUID();
      const digest = sha256(`token:${sessionId}`);
      await ownerPool.query(
        `INSERT INTO dasher.sessions
         (session_id, organization_id, user_id, authority_revision,
          token_key_version, token_digest, csrf_key_version, csrf_digest,
          issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 1, 1, $4, 1, $5, now(), now(),
               now() + interval '30 minutes', now() + interval '12 hours')`,
        [sessionId, org, alice, digest, sha256(`csrf:${sessionId}`)],
      );

      const client = await appPool.connect();
      try {
        const found = await client.query(
          "SELECT user_id, organization_id FROM dasher.sessions WHERE token_digest = $1",
          [digest],
        );
        expect(found.rowCount).toBe(1);
      } finally {
        client.release();
      }
    },
  );

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

  it.fails(
    "the application role can resolve an external identity to a user",
    async () => {
      await ownerPool.query(
        `INSERT INTO dasher.external_identities (issuer, subject, user_id)
       VALUES ('https://issuer.example', $1, $2)`,
        [`subject-${alice}`, alice],
      );
      const client = await appPool.connect();
      try {
        const found = await client.query(
          "SELECT user_id FROM dasher.external_identities WHERE issuer = $1 AND subject = $2",
          ["https://issuer.example", `subject-${alice}`],
        );
        expect(found.rowCount).toBe(1);
      } finally {
        client.release();
      }
    },
  );
});

describe("timestamp coherence", () => {
  it.fails("a session cannot have been seen after it idled out", async () => {
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

  it.fails(
    "an invitation cannot be accepted before it was created",
    async () => {
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
    },
  );

  it.fails("an invitation cannot be accepted after it expired", async () => {
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

  it.fails("a dashboard cannot be archived before it was created", async () => {
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
  it.fails(
    "a succeeded run must name the dashboard it produced a version for",
    async () => {
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
    },
  );

  it.fails(
    "two runs cannot claim to have produced the same version",
    async () => {
      const versionId = await publishDashboard(dashboardOne);
      await asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.agent_runs
           (organization_id, run_id, dashboard_id, requested_by_user_id,
            request_text, state, produced_version_id, finished_at)
         VALUES ($1, $2, $3, $4, 'first', 'succeeded', $5, now())`,
          [org, randomUUID(), dashboardOne, alice, versionId],
        ),
      );

      await expectRejected(
        asTenant(org, alice, (client) =>
          client.query(
            `INSERT INTO dasher.agent_runs
             (organization_id, run_id, dashboard_id, requested_by_user_id,
              request_text, state, produced_version_id, finished_at)
           VALUES ($1, $2, $3, $4, 'second', 'succeeded', $5, now())`,
            [org, randomUUID(), dashboardOne, alice, versionId],
          ),
        ),
      );
    },
  );
});

describe("provenance completeness", () => {
  it.fails(
    "a claim marked complete must cite at least one supporting evidence edge",
    async () => {
      const dashboardId = randomUUID();
      await ownerPool.query(
        `INSERT INTO dasher.dashboards
         (organization_id, dashboard_id, title, lifecycle_state,
          lifecycle_revision, created_by_user_id)
       VALUES ($1, $2, 'uncited', 'draft', 1, $3)`,
        [org, dashboardId, alice],
      );
      const versionId = randomUUID();
      await asTenant(org, alice, (client) =>
        client.query(
          `INSERT INTO dasher.dashboard_versions
           (organization_id, dashboard_id, version_id, canonical_spec_bytes,
            canonical_spec_sha256, validation_state, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'valid', $6)`,
          [org, dashboardId, versionId, Buffer.from("{}"), sha256("{}"), alice],
        ),
      );

      await expectRejected(
        asTenant(org, alice, (client) =>
          client.query(
            `INSERT INTO dasher.claims
             (organization_id, dashboard_id, version_id, claim_id, json_pointer,
              label, salience, evidence_state, assertion_sha256)
           VALUES ($1, $2, $3, $4, '/pages/0/sections/0/value', 'observed',
                   'high', 'complete', $5)`,
            [org, dashboardId, versionId, randomUUID(), sha256("uncited")],
          ),
        ),
      );
    },
  );

  it.fails("a recorded evidence record cannot be rewritten", async () => {
    const snapshotId = randomUUID();
    const evidenceId = randomUUID();
    await ownerPool.query(
      `INSERT INTO dasher.source_snapshots
         (organization_id, snapshot_id, source_kind, source_ref,
          canonical_bytes, content_sha256, observed_at, retrieved_at)
       VALUES ($1, $2, 'usgs', 'gauge/11447650', $3, $4, now(), now())`,
      [org, snapshotId, Buffer.from("evidence base"), sha256("evidence base")],
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
});
