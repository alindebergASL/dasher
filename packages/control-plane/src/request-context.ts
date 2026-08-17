import type { PoolClient } from "pg";

/**
 * The request context: the only way a caller reaches tenant data.
 *
 * WHY THIS SHAPE. `dasher_api.begin_request` validates a session token and then
 * publishes five settings — user, organization, session, authority revision, and
 * a digest binding them together — with `set_config(..., true)`. The `true` is
 * the whole design: **all five are transaction-local.** They exist from that
 * statement until the transaction ends, and nowhere else.
 *
 * Three consequences, none optional:
 *
 *   1. Every read and write for a request runs inside ONE transaction. A caller
 *      that authenticates, commits, and then queries has no context and sees
 *      nothing — which is the correct failure, but a confusing one to debug.
 *   2. It must be the SAME connection. A pool hands out a different backend per
 *      checkout, and the settings do not travel.
 *   3. Nothing leaks to the next checkout. When the transaction ends the
 *      settings are gone, so a pooled connection cannot carry one tenant's
 *      context into another tenant's request. That is a property worth testing
 *      rather than assuming, and `request-context.integration.test.ts` does.
 *
 * WHAT ENFORCES ACCESS. Not this module. Row-level security policies on the
 * tenant tables call `dasher_private.context_allows(organization_id, role)`,
 * which reads those settings. With no context the predicate is false for every
 * row, so an unauthenticated query returns zero rows rather than the table. This
 * module's job is to make the context exist for exactly as long as the work
 * needs it, and to make it impossible to run tenant work without one.
 */

/** The opaque session token a caller presents. Never the stored digest. */
export interface RequestCredential {
  readonly tokenKeyVersion: number;
  readonly token: Buffer;
}

/** Who the token turned out to belong to, as the database resolved it. */
export interface RequestPrincipal {
  readonly userId: string;
  readonly organizationId: string;
}

export type RequestContextErrorCode =
  /** The token was absent, malformed, expired, revoked, or not a session. */
  | "denied"
  /** The seam returned no principal, which should be unreachable. */
  | "no_principal";

export class RequestContextError extends Error {
  readonly code: RequestContextErrorCode;

  constructor(code: RequestContextErrorCode, message: string) {
    super(message);
    this.name = "RequestContextError";
    this.code = code;
  }
}

/** A pool thin enough to fake, and to avoid importing `pg` types outward. */
export interface RequestPool {
  connect(): Promise<PoolClient>;
}

/**
 * Run `work` inside a transaction that carries a verified request context.
 *
 * The client is handed to `work` deliberately: everything the request touches
 * has to run on it, because the context does not exist anywhere else. Returning
 * a context object and letting the caller find its own connection would be an
 * interface that looks safe and silently reads nothing.
 *
 * `work` must not commit or roll back. This owns the transaction so that a
 * caller cannot end it early and continue querying without context.
 */
export async function withRequestContext<T>(
  pool: RequestPool,
  credential: RequestCredential,
  work: (client: PoolClient, principal: RequestPrincipal) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let principal: RequestPrincipal;
    try {
      const result = await client.query<{
        user_id: string;
        organization_id: string;
      }>(
        "SELECT user_id, organization_id FROM dasher_api.begin_request($1, $2)",
        [credential.tokenKeyVersion, credential.token],
      );

      const row = result.rows[0];
      if (row === undefined) {
        // The seam raises `dasher_denied` for a bad token, so an empty result
        // means it returned successfully without a principal. That is not a
        // shape the caller can do anything with, and continuing would run the
        // work with no context and report zero rows as though they were data.
        throw new RequestContextError(
          "no_principal",
          "begin_request returned no principal",
        );
      }
      principal = { userId: row.user_id, organizationId: row.organization_id };
    } catch (error) {
      if (error instanceof RequestContextError) throw error;
      // `28000` is what the seam raises for every rejection — absent, short,
      // expired, revoked, or belonging to no live membership. It is deliberately
      // one code: distinguishing them for the caller would report whether a
      // token was real to whoever presented it.
      if (isDenied(error)) {
        throw new RequestContextError("denied", "request context denied");
      }
      throw error;
    }

    const value = await work(client, principal);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    // Best-effort: the transaction may already be aborted, and the original
    // error is what the caller needs to see.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is going back to the pool either way */
    }
    throw error;
  } finally {
    client.release();
  }
}

function isDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "28000"
  );
}
