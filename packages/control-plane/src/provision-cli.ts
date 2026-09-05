import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { normalizeEmailAddress } from "./email";

/**
 * Create an organization and its first member, as the schema owner.
 *
 * Usage:
 *   DASHER_MIGRATE_DSN=postgresql://owner:***@host/db \
 *     pnpm --filter @dasher/control-plane provision \
 *       --organization "Pilot org" --email person@example.com [--role admin]
 *
 * `--organization` takes either a display name, which creates a new
 * organization, or the uuid of an existing one, which adds the address to it.
 *
 * WHY THIS EXISTS AT ALL. Sign-in is invitation-only: `begin_sign_in` creates a
 * challenge only for an address that already has an active membership, and
 * there is no path in the product that creates the first one. That is the point
 * — a self-serve path would let anyone who found the hostname provision
 * themselves an organization — but it means somebody has to go first, and this
 * is who.
 *
 * WHY IT CONNECTS AS THE OWNER. Organizations, users, memberships, and external
 * identities are exactly the tables `dasher_app` cannot write. Granting it that
 * ability to make provisioning convenient would widen the application's
 * privileges permanently for an operation that runs a handful of times.
 *
 * The reverse of the same rule: this is an operator tool and must never be
 * reachable from a request. It lives here rather than in the web app because
 * the web app has no owner connection to run it with.
 */

const EMAIL_LINK_ISSUER = "urn:dasher:email-link";
const ROLES = new Set(["admin", "editor", "viewer"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Exactly one of `organizationName` (create) or `organizationId` (join). */
export interface ProvisionOptions {
  readonly organizationName?: string;
  readonly organizationId?: string;
  readonly email: string;
  readonly role: string;
}

export interface ProvisionedPrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly normalizedEmail: string;
  /** True when the address already had an identity and only a membership was added. */
  readonly reusedExistingUser: boolean;
  /** False when the membership joined an organization that already existed. */
  readonly createdOrganization: boolean;
}

export function parseProvisionArgs(argv: readonly string[]): ProvisionOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(`unrecognised argument near "${flag ?? ""}"`);
    }
    values.set(flag.slice(2), value);
  }

  const organization = values.get("organization")?.trim();
  const email = values.get("email");
  const role = values.get("role") ?? "admin";

  if (organization === undefined || organization === "") {
    throw new Error("--organization is required");
  }
  if (email === undefined) throw new Error("--email is required");
  if (!ROLES.has(role)) {
    throw new Error(`--role must be one of ${[...ROLES].sort().join(", ")}`);
  }

  return UUID_PATTERN.test(organization)
    ? { organizationId: organization.toLowerCase(), email, role }
    : { organizationName: organization, email, role };
}

export async function provisionPrincipal(
  pool: Pool,
  options: ProvisionOptions,
): Promise<ProvisionedPrincipal> {
  // Normalised by the same function the sign-in path uses, so the subject this
  // writes is the subject that lookup will search for. Two normalisations would
  // be two accounts for one address.
  const normalizedEmail = normalizeEmailAddress(options.email.trim());
  if (
    (options.organizationId === undefined) ===
    (options.organizationName === undefined)
  ) {
    throw new Error(
      "provide exactly one of organizationName or organizationId",
    );
  }
  const client = await pool.connect();

  // pg-pool THROWS on a second release — `throwOnDoubleRelease` — so the
  // release is guarded rather than repeated. Without this the `finally` below
  // would throw over the top of whatever failure brought it there, and the
  // caller would see "Release called on client which has already been released"
  // instead of the constraint that actually refused the insert. Same guard as
  // the development bootstrap route, for the same reason.
  let released = false;
  const release = (destroyBecause?: unknown): void => {
    if (released) return;
    released = true;
    if (destroyBecause === undefined) {
      client.release();
      return;
    }
    client.release(
      destroyBecause instanceof Error
        ? destroyBecause
        : new Error(String(destroyBecause)),
    );
  };

  try {
    await client.query("BEGIN");

    const existing = await client.query<{ user_id: string }>(
      "SELECT user_id FROM dasher.external_identities WHERE issuer = $1 AND subject = $2",
      [EMAIL_LINK_ISSUER, normalizedEmail],
    );

    const reusedExistingUser = existing.rows.length > 0;
    const userId = existing.rows[0]?.user_id ?? randomUUID();
    if (!reusedExistingUser) {
      await client.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
        userId,
      ]);
      await client.query(
        "INSERT INTO dasher.external_identities (issuer, subject, user_id) VALUES ($1, $2, $3)",
        [EMAIL_LINK_ISSUER, normalizedEmail, userId],
      );
    }

    let organizationId: string;
    const createdOrganization = options.organizationId === undefined;
    if (options.organizationId === undefined) {
      organizationId = randomUUID();
      await client.query(
        "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, $2)",
        [organizationId, options.organizationName],
      );
    } else {
      const found = await client.query<{ organization_id: string }>(
        "SELECT organization_id FROM dasher.organizations WHERE organization_id = $1",
        [options.organizationId],
      );
      const existingId = found.rows[0]?.organization_id;
      if (existingId === undefined) {
        throw new Error(
          `organization ${options.organizationId} does not exist`,
        );
      }
      organizationId = existingId;
    }
    await client.query(
      `INSERT INTO dasher.memberships
         (membership_id, organization_id, user_id, role, state, authority_revision)
       VALUES ($1, $2, $3, $4, 'active', 1)`,
      [randomUUID(), organizationId, userId, options.role],
    );

    await client.query("COMMIT");
    return {
      organizationId,
      userId,
      normalizedEmail,
      reusedExistingUser,
      createdOrganization,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // A backend whose rollback failed may still be in a transaction or be
      // dead, and this is an OWNER connection. `release(error)` makes pg-pool
      // destroy it rather than hand the next caller an unknown-state client
      // with owner authority. The caller still sees their own failure.
      release(rollbackError);
      throw error;
    }
    throw error;
  } finally {
    release();
  }
}
