import type { PoolClient, QueryResult, QueryResultRow } from "pg";

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
 *      context into another tenant's request.
 *
 * WHY THE CALLBACK DOES NOT GET A `PoolClient`. A pool reuses the same client
 * object across checkouts. Reproduced against a real pool at `max: 1`: a
 * callback that retained the client, and used it after its own transaction had
 * committed and released, executed inside the NEXT request's transaction and
 * read that request's tenant setting. A raw client handed to application code is
 * therefore a cross-tenant execution primitive with a time delay on it.
 *
 * So the callback receives a `TransactionHandle` instead — allocated per
 * transaction, invalidated before the owner commits or rolls back, and checked
 * on every call. A retained handle throws rather than executing under whoever
 * holds the connection next.
 *
 * WHY NONE OF THIS IS EXPORTED FROM THE PACKAGE. `TransactionHandle.query` still
 * takes SQL, so it is a generic capability, and a generic capability in the
 * public API is one import away from being an application's data-access layer.
 * The intended public surface is a repository facade that closes over a handle
 * and exposes named domain operations — which cannot be designed yet, because
 * nothing persists anything. Until it exists this module stays internal to the
 * package, reachable only by its own tests. Exporting it "for now" is how the
 * facade never gets written.
 *
 * WHAT ENFORCES ACCESS. Not this module. Row-level security policies on the
 * tenant tables call `dasher_private.context_allows(organization_id, role)`,
 * which reads those settings. With no context the predicate is false for every
 * row, so an unauthenticated query returns zero rows rather than the table. This
 * module's job is to make the context exist for exactly as long as the work
 * needs it, and no longer.
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
  | "no_principal"
  /** A handle was used after its transaction finished. */
  | "stale_handle"
  /** The callback tried to end or nest the transaction it was given. */
  | "transaction_control"
  /** The callback returned while queries it started were still running. */
  | "operations_outstanding";

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
 * The capability handed to the work callback.
 *
 * Deliberately has no `release`, no transaction control, and no route back to
 * the underlying client. What it does still have is `query`, which is why this
 * type is not part of the package's public API — see the module docstring.
 */
export interface TransactionHandle {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Statements that would take the transaction away from its owner.
 *
 * This is a leading-keyword check, not a SQL parser: it reads the first word of
 * the statement and nothing else. It cannot be defeated by a string literal
 * containing "commit" because it never looks past the start, and it is not
 * trying to stop a determined caller — a determined caller has `query`. It stops
 * the realistic accident, which is a helper that wraps its own work in
 * BEGIN/COMMIT and silently ends the request's transaction early, leaving every
 * later statement running with no context and reading zero rows as data.
 */
const TRANSACTION_CONTROL =
  /^\s*(?:begin|commit|rollback|end|start\s+transaction|savepoint|release\s+savepoint|prepare\s+transaction)\b/iu;

interface OwnedHandle extends TransactionHandle {
  /** Stop accepting work. Called before the owner commits or rolls back. */
  invalidate(): void;
  /** Queries started through this handle that have not settled. */
  outstanding(): number;
}

function createHandle(client: PoolClient): OwnedHandle {
  let live = true;
  let pending = 0;

  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      // Checked per call, not once at creation. The whole point is the handle
      // that outlives its transaction, and that handle was valid when it was
      // captured.
      if (!live) {
        throw new RequestContextError(
          "stale_handle",
          "this request's transaction has finished; the handle can no longer be used",
        );
      }
      if (TRANSACTION_CONTROL.test(sql)) {
        throw new RequestContextError(
          "transaction_control",
          "the request owns its transaction; the work callback must not end or nest it",
        );
      }

      pending += 1;
      try {
        return await client.query<R>(sql, params as unknown[] | undefined);
      } finally {
        pending -= 1;
      }
    },
    invalidate(): void {
      live = false;
    },
    outstanding(): number {
      return pending;
    },
  };
}

/** Rejects a credential that cannot possibly be valid, without a round trip. */
function assertWellFormed(credential: RequestCredential): void {
  // The seam applies the same minimum and raises 28000. Checking locally keeps a
  // malformed token from reaching the database at all, and keeps the failure
  // identical to a wrong-but-well-formed one — a caller must not be able to tell
  // "malformed" from "not a real session" by timing or by error.
  if (
    !Number.isSafeInteger(credential.tokenKeyVersion) ||
    !Buffer.isBuffer(credential.token) ||
    credential.token.length < 16
  ) {
    throw new RequestContextError("denied", "request context denied");
  }
}

/**
 * Run `work` inside a transaction that carries a verified request context.
 *
 * The transaction is owned here, not handed back. A caller that could commit
 * early would keep querying with no context and read zero rows as though they
 * were data — the failure this schema exists to prevent.
 */
export async function withRequestContext<T>(
  pool: RequestPool,
  credential: RequestCredential,
  work: (handle: TransactionHandle, principal: RequestPrincipal) => Promise<T>,
): Promise<T> {
  assertWellFormed(credential);

  const client = await pool.connect();
  let released = false;
  /** Exactly once, and with the error when the backend's state is unknown. */
  const release = (destroyBecause?: unknown): void => {
    if (released) return;
    released = true;
    if (destroyBecause === undefined) {
      client.release();
      return;
    }
    // `release(err)` makes pg-pool destroy the connection instead of returning
    // it. A backend whose ROLLBACK failed may still be in a transaction, or
    // dead; handing it to the next request would carry that state across.
    client.release(
      destroyBecause instanceof Error
        ? destroyBecause
        : new Error(String(destroyBecause)),
    );
  };

  const handle = createHandle(client);

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
        // The seam raises for a bad token, so an empty result means it returned
        // successfully without a principal. Continuing would run the work with
        // no context and report zero rows as data.
        throw new RequestContextError(
          "no_principal",
          "begin_request returned no principal",
        );
      }
      principal = { userId: row.user_id, organizationId: row.organization_id };
    } catch (error) {
      if (error instanceof RequestContextError) throw error;
      // `28000` is what the seam raises for every rejection — absent, short,
      // expired, revoked, or belonging to no live membership. Deliberately one
      // code: distinguishing them would report whether a token was real to
      // whoever presented it. Kept narrow on purpose, so an unexpected SQLSTATE
      // surfaces as itself rather than being relabelled as a denial.
      if (isDenied(error)) {
        throw new RequestContextError("denied", "request context denied");
      }
      throw error;
    }

    const value = await work(handle, principal);

    // A callback that returns without awaiting a query it started would have
    // that query land after COMMIT, or after the connection has been handed to
    // someone else. Committing here would make a partial write durable and call
    // it success.
    if (handle.outstanding() > 0) {
      throw new RequestContextError(
        "operations_outstanding",
        `work returned with ${String(handle.outstanding())} query(s) still in flight`,
      );
    }

    handle.invalidate();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    handle.invalidate();
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The original error is what the caller needs; the rollback failure is
      // what the pool needs. Both are honoured: evict the backend, raise the
      // request's own error.
      release(rollbackError);
      throw error;
    }
    release();
    throw error;
  } finally {
    handle.invalidate();
    release();
  }
}

function isDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "28000"
  );
}
