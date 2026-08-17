import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

/**
 * A development principal: one organization, one user, one membership, one
 * session.
 *
 * WHY THIS EXISTS. Every tenant row has a non-null `organization_id` and a
 * creator, and every request needs a session token to reach
 * `dasher_api.begin_request`. There is no sign-in yet, so without a seed the
 * first product slice cannot write a single row — the foreign keys ask for a
 * principal that nothing can create.
 *
 * WHY IT IS NOT A MIGRATION. A migration runs everywhere, and this must not.
 * It writes an authenticated session whose token the caller is handed in
 * plaintext, which is exactly the thing a deployment must never contain. Making
 * it a function the developer calls keeps it out of the schema, out of CI's
 * migration path, and visible at the call site.
 *
 * WHAT IT REFUSES TO DO. It does not disable a check, relax a policy, or grant
 * a privilege. Everything it writes, it writes as the schema owner through
 * ordinary inserts that satisfy every constraint — so a seeded organization is
 * indistinguishable from a real one, and a bug that only appears under real
 * sign-in is not hidden by a seed that took a shortcut around it.
 */

export interface DevPrincipalSeed {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  /**
   * The opaque session token, in plaintext, for the caller to present.
   *
   * Only the SHA-256 of this is stored. It exists in this return value and
   * nowhere else, which is the point: a seed that persisted the plaintext would
   * make the digest column decorative.
   */
  readonly token: Buffer;
  readonly tokenKeyVersion: number;
}

export interface DevSeedOptions {
  /** Defaults to a generated name; set it when a test asserts on it. */
  readonly organizationName?: string;
  /** `admin`, `editor`, or `viewer`. Defaults to `editor`. */
  readonly role?: "admin" | "editor" | "viewer";
  /** How long the session stays usable. Defaults to twelve hours. */
  readonly absoluteLifetimeMinutes?: number;
}

const TOKEN_BYTES = 32;
const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_ABSOLUTE_MINUTES = 12 * 60;

/**
 * Seed a principal. Must run as the schema owner, on a client the caller owns.
 *
 * The client is a parameter rather than a pool because seeding belongs inside
 * the caller's transaction: a half-seeded principal — an organization with no
 * membership, a session pointing at a user that does not exist — is worse than
 * none, and the caller is the only one who knows what else is in flight.
 */
export async function seedDevPrincipal(
  ownerClient: PoolClient,
  options: DevSeedOptions = {},
): Promise<DevPrincipalSeed> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const sessionId = randomUUID();
  const membershipId = randomUUID();
  const token = randomBytes(TOKEN_BYTES);
  const idleMinutes = DEFAULT_IDLE_MINUTES;
  const absoluteMinutes =
    options.absoluteLifetimeMinutes ?? DEFAULT_ABSOLUTE_MINUTES;

  await ownerClient.query(
    "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, $2)",
    [
      organizationId,
      options.organizationName ?? `dev org ${organizationId.slice(0, 8)}`,
    ],
  );

  await ownerClient.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
    userId,
  ]);

  await ownerClient.query(
    `INSERT INTO dasher.memberships
       (membership_id, organization_id, user_id, role, state, authority_revision)
     VALUES ($1, $2, $3, $4, 'active', 1)`,
    [membershipId, organizationId, userId, options.role ?? "editor"],
  );

  // `sessions_idle_expiry_check` requires
  // `issued_at < idle_expires_at <= absolute_expires_at`, so the idle window is
  // clamped rather than assumed: a caller asking for a five-minute session must
  // not produce a row the table refuses.
  await ownerClient.query(
    `INSERT INTO dasher.sessions
       (session_id, organization_id, user_id, authority_revision,
        token_key_version, token_digest, csrf_key_version, csrf_digest,
        issued_at, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, 1, 1, $4, 1, $5, now(), now(),
             now() + make_interval(mins => LEAST($6::int, $7::int)),
             now() + make_interval(mins => $7::int))`,
    [
      sessionId,
      organizationId,
      userId,
      digest(token),
      digest(randomBytes(TOKEN_BYTES)),
      idleMinutes,
      absoluteMinutes,
    ],
  );

  return {
    organizationId,
    userId,
    sessionId,
    token,
    tokenKeyVersion: 1,
  };
}

function digest(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}
