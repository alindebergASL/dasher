import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  beginSignIn,
  bootstrapManagedRoles,
  provisionPrincipal,
  decodeSignInToken,
  encodeSignInToken,
  parsePostgresIntegrationEnv,
  redeemSignIn,
  revokeSession,
  runMigrations,
  withDashboardRepository,
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
 * Passwordless sign-in, against a real database and as the application role.
 *
 * WHY THE APPLICATION POOL RATHER THAN THE OWNER'S. Every property here is a
 * property of what `dasher_app` can do, and `dasher_app` holds no rights on
 * `sign_in_challenges` at all — not even SELECT. Run as the owner these tests
 * would pass while proving nothing about the boundary they exist for.
 *
 * WHAT THE INTERESTING ASSERTIONS ARE. Not "a link works": that is one case.
 * The rest is what must NOT work — a second redemption, an expired link, a link
 * whose membership was revoked after it was sent, and, above all, the fact that
 * an unknown address and a known one are indistinguishable from outside.
 */

const config = parsePostgresIntegrationEnv(process.env);
const databaseName = `dasher_test_db_${randomUUID().replaceAll("-", "")}`;
const ownerRole = `dasher_test_owner_${randomUUID().replaceAll("-", "")}`;
const appUsername = `dasher_test_${randomUUID().replaceAll("-", "")}`;

let operatorPool: Pool;
let ownerPool: Pool;
let appPool: Pool;

function context() {
  return { requestId: randomUUID(), deploymentRevision: "test" };
}

/** Provision a principal the way the operator CLI will: org, user, identity, membership. */
async function provision(email: string, state = "active"): Promise<string> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  await ownerPool.query(
    "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, $2)",
    [organizationId, `org ${organizationId.slice(0, 8)}`],
  );
  await ownerPool.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
    userId,
  ]);
  await ownerPool.query(
    "INSERT INTO dasher.external_identities (issuer, subject, user_id) VALUES ($1, $2, $3)",
    ["urn:dasher:email-link", email, userId],
  );
  await ownerPool.query(
    `INSERT INTO dasher.memberships
       (membership_id, organization_id, user_id, role, state, authority_revision, revoked_at)
     VALUES ($1, $2, $3, 'editor', $4, 1, $5)`,
    [
      randomUUID(),
      organizationId,
      userId,
      state,
      state === "revoked" ? new Date() : null,
    ],
  );
  return organizationId;
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
  appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });
  ignoreTeardownShutdown(appPool);
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

it("cannot read a challenge, or its digest, as the application role", async () => {
  // The boundary the whole design rests on. Anything that could read
  // `token_digest` could redeem a link it never received, so the application
  // gets no rights on this table at all — not a policy that filters rows, no
  // grant whatsoever.
  await expect(
    appPool.query("SELECT count(*) FROM dasher.sign_in_challenges"),
  ).rejects.toMatchObject({ code: "42501" });
});

it("issues a link for an address that may sign in", async () => {
  await provision("member@example.com");

  const issued = await beginSignIn(appPool, {
    email: "member@example.com",
    ...context(),
  });

  expect(issued).toBeDefined();
  expect(issued?.token).toHaveLength(32);
});

it("answers an unknown address exactly as it answers a known one", async () => {
  // The enumeration property, and the reason `begin_sign_in` returns NULL for
  // every refusal rather than a reason. If these two differed in any way the
  // caller could see, the sign-in form would be a way to ask whether an address
  // has an account here.
  const unknown = await beginSignIn(appPool, {
    email: "nobody@example.com",
    ...context(),
  });
  expect(unknown).toBeUndefined();

  // And an address that exists but whose membership is revoked is the same
  // answer again — a former colleague learns nothing about whether they were
  // removed or never existed.
  await provision("revoked@example.com", "revoked");
  const revoked = await beginSignIn(appPool, {
    email: "revoked@example.com",
    ...context(),
  });
  expect(revoked).toBeUndefined();

  // As is an address that is not an address.
  const malformed = await beginSignIn(appPool, {
    email: "not-an-email",
    ...context(),
  });
  expect(malformed).toBeUndefined();
});

it("still sends to an address that arrived with stray whitespace", async () => {
  // `normalizeEmailAddress` rejects surrounding whitespace, which is right for
  // the function that decides two strings are one account and wrong as the
  // product's answer to a pasted address. Untrimmed, this person is told a link
  // is on its way and never gets one — the same sentence as a genuine refusal,
  // which is exactly why it would never be reported as a bug.
  await provision("padded@example.com");

  expect(
    await beginSignIn(appPool, {
      email: "  Padded@Example.com  ",
      ...context(),
    }),
  ).toBeDefined();
});

it("redeems a link once, and issues a session bound to the membership", async () => {
  const organizationId = await provision("redeem@example.com");
  const issued = await beginSignIn(appPool, {
    email: "redeem@example.com",
    ...context(),
  });

  const redeemed = await redeemSignIn(appPool, issued!.token, context());

  expect(redeemed?.organizationId).toBe(organizationId);
  expect(redeemed?.sessionToken).toHaveLength(32);

  // The session is real: it exists, is unrevoked, and carries the membership's
  // authority revision rather than a constant.
  const session = await ownerPool.query<{
    authority_revision: string;
    revoked_at: Date | null;
  }>(
    "SELECT authority_revision::text, revoked_at FROM dasher.sessions WHERE session_id = $1",
    [redeemed?.sessionId],
  );
  expect(session.rows[0]?.authority_revision).toBe("1");
  expect(session.rows[0]?.revoked_at).toBeNull();

  // Second use issues nothing. A link in an inbox, a forwarded thread, or a
  // mail-server log is spent the moment it is used once.
  expect(await redeemSignIn(appPool, issued!.token, context())).toBeUndefined();
});

it("refuses a token that was never issued", async () => {
  expect(
    await redeemSignIn(appPool, randomBytes(32), context()),
  ).toBeUndefined();
});

it("refuses a link whose membership was revoked after it was sent", async () => {
  // Checked at redemption rather than trusted from when the link was posted.
  // Without this, revoking someone's access would leave every link already in
  // their inbox working until it expired.
  const organizationId = await provision("later-revoked@example.com");
  const issued = await beginSignIn(appPool, {
    email: "later-revoked@example.com",
    ...context(),
  });

  await ownerPool.query(
    // `authority_revision` advances by one, because the schema requires an
    // authority change to say so. Revoking without it is refused, which is how
    // a stale session can be told from a current one.
    `UPDATE dasher.memberships
        SET state = 'revoked',
            revoked_at = now(),
            updated_at = now(),
            authority_revision = authority_revision + 1
      WHERE organization_id = $1`,
    [organizationId],
  );

  expect(await redeemSignIn(appPool, issued!.token, context())).toBeUndefined();
});

it("refuses a link that has expired", async () => {
  await provision("expired@example.com");

  // The challenge is created with a lifetime it will outlive during the test,
  // rather than aged afterwards: `sign_in_challenges_consume_once` forbids
  // editing `expires_at`, which is the trigger doing its job. So the seam is
  // called directly with a short expiry — still satisfying
  // `expires_at > created_at` — and then allowed to lapse.
  const token = randomBytes(32);
  const digest = createHash("sha256").update(token).digest();
  const created = await appPool.query<{ challenge_id: string | null }>(
    `SELECT dasher_api.begin_sign_in(
       $1, $2, $3, now() + interval '150 milliseconds', $4, $5
     ) AS challenge_id`,
    ["expired@example.com", 1, digest, randomUUID(), "test"],
  );
  expect(created.rows[0]?.challenge_id).not.toBeNull();

  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(await redeemSignIn(appPool, token, context())).toBeUndefined();
});

it("stops sending after five links in an hour", async () => {
  // An amplifier for mailing somebody else's inbox, bounded. The sixth request
  // is refused the same way an unknown address is, so a sender cannot tell
  // whether they hit the limit or the address was never valid.
  await provision("flooded@example.com");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(
      await beginSignIn(appPool, {
        email: "flooded@example.com",
        ...context(),
      }),
      `attempt ${String(attempt + 1)}`,
    ).toBeDefined();
  }

  expect(
    await beginSignIn(appPool, { email: "flooded@example.com", ...context() }),
  ).toBeUndefined();
});

it("records both halves of a sign-in in the audit trail", async () => {
  const organizationId = await provision("audited@example.com");
  const issued = await beginSignIn(appPool, {
    email: "audited@example.com",
    ...context(),
  });
  await redeemSignIn(appPool, issued!.token, context());

  const events = await ownerPool.query<{ action: string }>(
    `SELECT action FROM dasher.audit_events
      WHERE organization_id = $1 ORDER BY action`,
    [organizationId],
  );

  expect(events.rows.map((row) => row.action)).toEqual([
    "session.issued",
    "sign_in.requested",
  ]);
});

it("cannot reopen a consumed challenge, even as the owner", async () => {
  // Single use is a property of the table, not of the function that reads it.
  const organizationId = await provision("replay@example.com");
  const issued = await beginSignIn(appPool, {
    email: "replay@example.com",
    ...context(),
  });
  await redeemSignIn(appPool, issued!.token, context());

  await expect(
    ownerPool.query(
      `UPDATE dasher.sign_in_challenges
          SET consumed_at = NULL, consumed_session_id = NULL
        WHERE organization_id = $1`,
      [organizationId],
    ),
  ).rejects.toMatchObject({ code: "55000" });

  await expect(
    ownerPool.query(
      "DELETE FROM dasher.sign_in_challenges WHERE organization_id = $1",
      [organizationId],
    ),
  ).rejects.toMatchObject({ code: "55000" });
});

it("accepts only the canonical encoding of a token", async () => {
  // One token must not arrive under several spellings: each would consume a
  // rate-limit slot and write its own audit row for what is one link.
  const token = randomBytes(32);
  const encoded = encodeSignInToken(token);

  expect(decodeSignInToken(encoded)?.equals(token)).toBe(true);
  // Standard base64 rather than base64url, and a padded variant. Both decode to
  // the same bytes in a permissive decoder.
  expect(decodeSignInToken(token.toString("base64"))).toBeUndefined();
  expect(decodeSignInToken(`${encoded}=`)).toBeUndefined();
  expect(decodeSignInToken("")).toBeUndefined();
  expect(decodeSignInToken(encodeSignInToken(randomBytes(16)))).toBeUndefined();
});

it("is enabled for an address the provisioning tool created", async () => {
  // The bootstrapping question invitation-only creates: somebody has to go
  // first, and the product deliberately offers no way to. This is the whole
  // path — the operator tool writes the organization, the identity and the
  // membership, and the address it names can then request a link where a
  // moment earlier it could not.
  expect(
    await beginSignIn(appPool, { email: "first@example.com", ...context() }),
  ).toBeUndefined();

  const provisioned = await provisionPrincipal(ownerPool, {
    organizationName: "First pilot org",
    email: "  First@Example.COM  ",
    role: "admin",
  });

  // Normalised on the way in, so the subject written is the subject the
  // sign-in lookup searches for. Two normalisations would be two accounts.
  expect(provisioned.normalizedEmail).toBe("first@example.com");
  expect(provisioned.reusedExistingUser).toBe(false);

  const issued = await beginSignIn(appPool, {
    email: "first@example.com",
    ...context(),
  });
  expect(issued).toBeDefined();

  const redeemed = await redeemSignIn(appPool, issued!.token, context());
  expect(redeemed?.organizationId).toBe(provisioned.organizationId);
  expect(redeemed?.userId).toBe(provisioned.userId);
});

it("adds an existing address to a second organization without a second user", async () => {
  // `external_identities` is UNIQUE on user_id and keyed on (issuer, subject),
  // so re-provisioning the same address must reuse the person rather than fail
  // or fork them into two accounts sharing an inbox.
  const first = await provisionPrincipal(ownerPool, {
    organizationName: "Org one",
    email: "shared@example.com",
    role: "admin",
  });
  const second = await provisionPrincipal(ownerPool, {
    organizationName: "Org two",
    email: "shared@example.com",
    role: "editor",
  });

  expect(second.reusedExistingUser).toBe(true);
  expect(second.userId).toBe(first.userId);
  expect(second.organizationId).not.toBe(first.organizationId);

  // And the link goes to the OLDEST membership, deterministically, rather than
  // to whichever row the planner happened to return.
  const issued = await beginSignIn(appPool, {
    email: "shared@example.com",
    ...context(),
  });
  const redeemed = await redeemSignIn(appPool, issued!.token, context());
  expect(redeemed?.organizationId).toBe(first.organizationId);
});

it("ends a session so the request seam stops accepting it", async () => {
  // The property worth asserting is not that a column changed. It is that
  // `begin_request` — which every other operation goes through — refuses the
  // credential afterwards. So this signs in, proves the session works by
  // resolving a principal through the real seam, revokes, and proves it does
  // not.
  await provision("signs-out@example.com");
  const issued = await beginSignIn(appPool, {
    email: "signs-out@example.com",
    ...context(),
  });
  const redeemed = await redeemSignIn(appPool, issued!.token, context());
  const credential = {
    tokenKeyVersion: 1,
    token: redeemed!.sessionToken,
  };

  const before = await withDashboardRepository(
    appPool,
    credential,
    async (_repository, principal) => principal,
  );
  expect(before.organizationId).toBe(redeemed?.organizationId);

  expect(
    await revokeSession(appPool, redeemed!.sessionToken, {
      reason: "signed_out",
      ...context(),
    }),
  ).toBe(true);

  await expect(
    withDashboardRepository(
      appPool,
      credential,
      async (_repository, principal) => principal,
    ),
  ).rejects.toThrow();
});

it("reports revoking nothing without saying which nothing", async () => {
  // Already revoked, and never issued. Both false, because signing out twice is
  // not a failure and distinguishing the two would answer "is this a real
  // token?" for somebody holding a stolen one.
  await provision("double-out@example.com");
  const issued = await beginSignIn(appPool, {
    email: "double-out@example.com",
    ...context(),
  });
  const redeemed = await redeemSignIn(appPool, issued!.token, context());

  expect(
    await revokeSession(appPool, redeemed!.sessionToken, {
      reason: "signed_out",
      ...context(),
    }),
  ).toBe(true);
  expect(
    await revokeSession(appPool, redeemed!.sessionToken, {
      reason: "signed_out",
      ...context(),
    }),
  ).toBe(false);
  expect(
    await revokeSession(appPool, randomBytes(32), {
      reason: "signed_out",
      ...context(),
    }),
  ).toBe(false);
});

it("records the revocation, with its reason, in the audit trail", async () => {
  const organizationId = await provision("audited-out@example.com");
  const issued = await beginSignIn(appPool, {
    email: "audited-out@example.com",
    ...context(),
  });
  const redeemed = await redeemSignIn(appPool, issued!.token, context());
  await revokeSession(appPool, redeemed!.sessionToken, {
    reason: "signed_out",
    ...context(),
  });

  const events = await ownerPool.query<{ action: string }>(
    `SELECT action FROM dasher.audit_events
      WHERE organization_id = $1 AND action = 'session.revoked'`,
    [organizationId],
  );
  expect(events.rows).toHaveLength(1);

  const session = await ownerPool.query<{ revocation_reason: string }>(
    "SELECT revocation_reason FROM dasher.sessions WHERE session_id = $1",
    [redeemed?.sessionId],
  );
  expect(session.rows[0]?.revocation_reason).toBe("signed_out");
});

it("no longer lets the application role ask whether an address has an account", async () => {
  // `resolve_external_identity` was granted to `dasher_app` in the baseline and
  // called by nothing. It answers in one call the question `begin_sign_in`
  // returns a uniform NULL to avoid answering, which made the enumeration
  // guarantee a property of one code path rather than of the role.
  await provision("known@example.com");

  await expect(
    appPool.query("SELECT dasher_api.resolve_external_identity($1, $2)", [
      "urn:dasher:email-link",
      "known@example.com",
    ]),
  ).rejects.toMatchObject({ code: "42501" });
});

it("still revokes a session that has already expired", async () => {
  // Pinned because three docstrings said the opposite until a review checked
  // them against the UPDATE, which filters on the digest and `revoked_at IS
  // NULL` and says nothing about expiry. That is the right behaviour — a
  // session that lapsed between page load and click is exactly the one
  // somebody is trying to end — but it means the boolean means "a row was
  // marked", not "the session was live", and a caller must not read it as
  // liveness.
  await provision("expired-session@example.com");
  const issued = await beginSignIn(appPool, {
    email: "expired-session@example.com",
    ...context(),
  });
  const redeemed = await redeemSignIn(appPool, issued!.token, context());

  // Aged past both windows through the owner; there is no product path that
  // ages a session and waiting twelve hours is not a test.
  await ownerPool.query(
    `UPDATE dasher.sessions
        SET issued_at = now() - interval '2 days',
            last_seen_at = now() - interval '2 days',
            idle_expires_at = now() - interval '1 day',
            absolute_expires_at = now() - interval '1 day'
      WHERE session_id = $1`,
    [redeemed?.sessionId],
  );

  // The request seam already refuses it...
  await expect(
    withDashboardRepository(
      appPool,
      { tokenKeyVersion: 1, token: redeemed!.sessionToken },
      async (_repository, principal) => principal,
    ),
  ).rejects.toThrow();

  // ...and revoking it still returns true and still marks the row, so the
  // audit trail records that somebody ended it rather than it merely lapsing.
  expect(
    await revokeSession(appPool, redeemed!.sessionToken, {
      reason: "signed_out",
      ...context(),
    }),
  ).toBe(true);

  const row = await ownerPool.query<{ revocation_reason: string | null }>(
    "SELECT revocation_reason FROM dasher.sessions WHERE session_id = $1",
    [redeemed?.sessionId],
  );
  expect(row.rows[0]?.revocation_reason).toBe("signed_out");
});
