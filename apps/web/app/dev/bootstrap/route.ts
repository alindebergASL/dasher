import {
  createSessionCookieMetadata,
  seedDevPrincipal,
} from "@dasher/control-plane";
import { NextResponse } from "next/server";

import { devSeedPool, isPersistenceConfigured } from "../../database";
import { encodeSessionToken } from "../../session";

/**
 * Development sign-in stand-in: seed a principal, issue a real session cookie.
 *
 * WHY A HANDLER RATHER THAN A CONFIGURED TOKEN. The alternatives both put
 * something false into the product. An environment variable is a long-lived
 * secret in configuration, shared by every browser that hits the server, with
 * no rotation and no expiry. A cookie planted by a script is a manual step that
 * drifts from the real path the moment either side changes.
 *
 * This issues the cookie through `createSessionCookieMetadata` — the same seam
 * real sign-in will use — over a session row written by the same inserts the
 * schema requires of anyone. The consequence that matters: no "is this a
 * development token?" branch ever enters product code. `actions.ts` and the
 * `/d/[id]` route read one cookie and call one seam, and they will not change
 * when sign-in lands. This file is deleted, and nothing else does.
 *
 * WHY THE SWITCH IS ITS OWN VARIABLE AND NOT `NODE_ENV`. This mints an
 * authenticated session for anyone who can reach the URL, so it must be off
 * unless somebody deliberately turned it on. `NODE_ENV` is the wrong control
 * for that in both directions: a staging deployment is "production" while still
 * wanting a way in, and any build served by `next start` is "production" even
 * on a laptop — which would have made this route untestable by the end-to-end
 * suite that runs against the real build.
 *
 * `DASHER_DEV_BOOTSTRAP=1` is default-off, explicit, greppable, and belongs to
 * a deployment's configuration rather than to how it was compiled. The check is
 * first, and consults nothing a request can influence.
 *
 * WHY IT CONNECTS AS SOMEBODY ELSE. Seeding writes organizations, users, and
 * memberships directly, which the application role cannot do and must not be
 * able to. Found by running this route: it failed with `permission denied for
 * table organizations`, which is the schema working rather than breaking.
 *
 * The fix is a second, development-only connection as the schema owner, not a
 * grant to the application. A grant would widen the production privilege set
 * permanently to make development convenient; a DSN that only a developer's
 * environment defines does not exist in production at all. The application's
 * own pool is untouched and still cannot write these tables.
 */

const SESSION_MINUTES = 12 * 60;

export async function POST(): Promise<NextResponse> {
  if (process.env["DASHER_DEV_BOOTSTRAP"] !== "1") {
    // Not 403: where this is switched off the route does not exist as far as a
    // caller is concerned, and "forbidden" would confirm that it is here.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!isPersistenceConfigured()) {
    return NextResponse.json(
      {
        error:
          "DASHER_DATABASE_URL is not set, so there is no database to seed a principal in.",
      },
      { status: 503 },
    );
  }

  const pool = devSeedPool();
  if (pool === undefined) {
    return NextResponse.json(
      {
        error:
          "DASHER_DEV_SEED_DSN is not set. Seeding writes tables the application " +
          "role cannot, by design, so the bootstrap needs the schema owner's " +
          "connection string.",
      },
      { status: 503 },
    );
  }
  const client = await pool.connect();
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

  let seeded;
  try {
    // One transaction: a half-seeded principal — an organization with no
    // membership, a session pointing at a user that does not exist — is worse
    // than none, and the schema would reject the pieces in the wrong order
    // anyway.
    await client.query("BEGIN");
    seeded = await seedDevPrincipal(client, {
      organizationName: "Development organization",
      role: "editor",
      absoluteLifetimeMinutes: SESSION_MINUTES,
    });
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Same rule as `request-context.ts`, and it matters more here: this is a
      // SCHEMA OWNER connection. A backend whose rollback failed may still be
      // in a transaction or be dead, and returning it to the pool hands the
      // next bootstrap an unknown-state connection with owner authority.
      // `release(error)` makes pg-pool destroy it; the caller still sees their
      // own failure rather than the rollback's.
      release(rollbackError);
      throw error;
    }
    release();
    throw error;
  } finally {
    release();
  }

  const now = Date.now();
  const cookie = createSessionCookieMetadata(
    now,
    now + SESSION_MINUTES * 60 * 1_000,
  );

  const response = NextResponse.json({
    organizationId: seeded.organizationId,
    userId: seeded.userId,
  });
  response.cookies.set({
    name: cookie.name,
    value: encodeSessionToken(seeded.token),
    httpOnly: cookie.httpOnly,
    // `secure` and the `__Host-` prefix are what the seam specifies, and
    // browsers make an explicit exception for http://localhost, so development
    // does not have to weaken the cookie to use it.
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });
  return response;
}

/**
 * GET is not an alias for a state change — and it checks the switch first.
 *
 * It did not, and answered 405 with an identifying message even where the
 * bootstrap was switched off. That made "this route does not exist when off"
 * true of POST only: a 405 naming a development session is a positive answer to
 * "is this build carrying a bootstrap?"
 */
export function GET(): NextResponse {
  if (process.env["DASHER_DEV_BOOTSTRAP"] !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: "use POST to start a development session" },
    { status: 405 },
  );
}
