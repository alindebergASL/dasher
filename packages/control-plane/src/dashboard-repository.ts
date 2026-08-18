import {
  withRequestContext,
  type RequestCredential,
  type RequestPool,
  type RequestPrincipal,
  type TransactionHandle,
} from "./request-context";

/**
 * The dashboard repository: the package's first public data-access surface.
 *
 * WHY A FACADE RATHER THAN A CONNECTION. `request-context.ts` is not exported,
 * because the handle it hands its callback still takes SQL, and a generic
 * capability in the public API is one import away from becoming an
 * application's data layer. This is what gets exported instead: named
 * operations, each of which knows the one statement it needs.
 *
 * WHY EACH METHOD RE-ENTERS THE HANDLE. Every call goes through
 * `handle.query`, which checks liveness per call. That is not incidental — a
 * repository is an object, an object can be retained, and a pool reuses its
 * clients. A repository captured during one request and called during a later
 * one would otherwise execute under whoever holds the connection now. Because
 * the handle is checked on every call rather than once at construction, a stale
 * repository throws instead, and `request-context.integration.test.ts` proves
 * that against a real second tenant.
 *
 * So this file holds no connection, no client, and no state of its own. It is a
 * closure over a handle whose validity is somebody else's job to enforce, which
 * is why it can be exported when the handle cannot.
 *
 * WHAT IT DOES NOT DO. It does not compute, validate, or interpret a dashboard
 * spec. Bytes go in and come back out; `@dasher/planner` decides what they mean
 * and `dashboard-schema` decides whether they are legal. A repository that
 * understood the payload would be a second place where the contract lives.
 */

/** Everything a persisted dashboard version needs to be created. */
export interface SaveDashboardInput {
  readonly title: string;
  /** The reader's original request, recorded on the run for provenance. */
  readonly requestText: string;
  readonly provider: string;
  readonly model: string;
  /** The compiled spec, canonicalised by the caller. Opaque here. */
  readonly canonicalSpecBytes: Uint8Array;
  readonly requestId: string;
  readonly deploymentRevision: string;
}

export interface SavedDashboard {
  readonly dashboardId: string;
  readonly versionId: string;
  readonly runId: string;
}

export interface LoadedDashboard {
  readonly dashboardId: string;
  readonly title: string;
  readonly versionId: string;
  /**
   * What `pg` hands back for a `bytea`, which is a `Buffer`. The input side
   * takes `Uint8Array` instead, so `@dasher/dashboard-schema` can produce the
   * bytes without acquiring Node types; the asymmetry is real rather than an
   * oversight, and narrowing this to `Uint8Array` would only make callers
   * re-wrap what they already have.
   */
  readonly canonicalSpecBytes: Buffer;
  readonly lifecycleState: string;
  readonly lifecycleRevision: number;
}

export type DashboardRepositoryErrorCode =
  /** A seam refused the write because state moved under it. */
  | "conflict"
  /** A seam returned success without the identifier it promises. */
  | "unexpected_shape";

export class DashboardRepositoryError extends Error {
  readonly code: DashboardRepositoryErrorCode;

  constructor(code: DashboardRepositoryErrorCode, message: string) {
    super(message);
    this.name = "DashboardRepositoryError";
    this.code = code;
  }
}

export interface DashboardRepository {
  /**
   * Create a dashboard and its first version, through the seam.
   *
   * Three statements rather than one, because the schema models them as three
   * facts: a dashboard exists, a run produced something, that run's output
   * became the head version. They are atomic regardless — the request owns one
   * transaction, so a failure at any point leaves none of them.
   */
  save(input: SaveDashboardInput): Promise<SavedDashboard>;

  /**
   * Read a dashboard and its head version by id.
   *
   * Returns `undefined` for both "no such dashboard" and "not yours", because
   * row-level security makes them the same query result and telling them apart
   * would leak the existence of another tenant's row.
   */
  loadById(dashboardId: string): Promise<LoadedDashboard | undefined>;
}

const FIRST_REVISION = 1;

export function createDashboardRepository(
  handle: TransactionHandle,
  principal: RequestPrincipal,
): DashboardRepository {
  return {
    async save(input: SaveDashboardInput): Promise<SavedDashboard> {
      const created = await handle.query<{ dashboard_id: string }>(
        "SELECT dasher_api.create_dashboard($1, $2, $3) AS dashboard_id",
        [input.title, input.requestId, input.deploymentRevision],
      );
      const dashboardId = created.rows[0]?.dashboard_id;
      if (dashboardId === undefined) {
        throw new DashboardRepositoryError(
          "unexpected_shape",
          "create_dashboard returned no identifier",
        );
      }

      const started = await handle.query<{ run_id: string }>(
        "SELECT dasher_api.start_run($1, $2, $3, $4, $5, $6) AS run_id",
        [
          dashboardId,
          input.requestText,
          input.provider,
          input.model,
          input.requestId,
          input.deploymentRevision,
        ],
      );
      const runId = started.rows[0]?.run_id;
      if (runId === undefined) {
        throw new DashboardRepositoryError(
          "unexpected_shape",
          "start_run returned no identifier",
        );
      }

      // `create_dashboard` writes lifecycle_revision 1, and `finalize_run`
      // promotes the head only if the revision it was told to expect still
      // holds. Passing the known-fresh value is honest here because this
      // dashboard was created in this transaction and nothing else can have
      // touched it; a later update path has to read the revision it saw.
      const finalized = await handle
        .query<{ version_id: string }>(
          "SELECT dasher_api.finalize_run($1, $2, $3::jsonb, $4, $5, $6) AS version_id",
          [
            runId,
            input.canonicalSpecBytes,
            "[]",
            FIRST_REVISION,
            input.requestId,
            input.deploymentRevision,
          ],
        )
        .catch((error: unknown) => {
          // `40001` is the seam's single conflict code: the run moved, or the
          // head revision was not what the caller expected. It is a retry
          // signal, not a bug, so it is named rather than passed through as a
          // serialization failure the caller has to decode.
          if (isConflict(error)) {
            throw new DashboardRepositoryError(
              "conflict",
              "the dashboard changed while this version was being written",
            );
          }
          throw error;
        });

      const versionId = finalized.rows[0]?.version_id;
      if (versionId === undefined) {
        throw new DashboardRepositoryError(
          "unexpected_shape",
          "finalize_run returned no identifier",
        );
      }

      return { dashboardId, versionId, runId };
    },

    async loadById(dashboardId: string): Promise<LoadedDashboard | undefined> {
      // The organization is not in the predicate. It does not need to be: the
      // policy adds it, and writing it here as well would suggest this query is
      // what enforces tenancy. `principal` is taken so a reader can see whose
      // context this repository belongs to, and so a mismatched pairing is a
      // type error rather than a silent one.
      void principal;

      const result = await handle.query<{
        dashboard_id: string;
        title: string;
        version_id: string;
        canonical_spec_bytes: Buffer;
        lifecycle_state: string;
        lifecycle_revision: string;
      }>(
        `SELECT d.dashboard_id,
                d.title,
                v.version_id,
                v.canonical_spec_bytes,
                d.lifecycle_state,
                d.lifecycle_revision::text AS lifecycle_revision
           FROM dasher.dashboards AS d
           JOIN dasher.dashboard_versions AS v
             ON v.organization_id = d.organization_id
            AND v.dashboard_id = d.dashboard_id
            AND v.version_id = d.head_version_id
          WHERE d.dashboard_id = $1`,
        [dashboardId],
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      return {
        dashboardId: row.dashboard_id,
        title: row.title,
        versionId: row.version_id,
        canonicalSpecBytes: row.canonical_spec_bytes,
        lifecycleState: row.lifecycle_state,
        // bigint arrives as text so it cannot silently lose precision on the
        // way through a double; the revisions this counts stay small, but the
        // cast is where that assumption would otherwise hide.
        lifecycleRevision: Number(row.lifecycle_revision),
      };
    },
  };
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "40001"
  );
}

/**
 * The public way in: a request context with a repository on top of it.
 *
 * This is what application code gets. The callback receives named operations
 * and a principal — never a handle, never a client, never SQL. Everything the
 * seam below enforces about transaction ownership, liveness, and tenant
 * isolation still applies, because this is that seam with a narrower opening.
 *
 * Constructing the repository per transaction, here, is what keeps the two from
 * drifting apart: there is no arrangement in which a caller holds a repository
 * older than the context it runs in, because obtaining one requires entering a
 * context and the repository never outlives the callback it was made for. If it
 * is retained anyway, every method still fails closed — the handle it closes
 * over refuses.
 */
export async function withDashboardRepository<T>(
  pool: RequestPool,
  credential: RequestCredential,
  work: (
    repository: DashboardRepository,
    principal: RequestPrincipal,
  ) => Promise<T>,
): Promise<T> {
  return withRequestContext(pool, credential, async (handle, principal) =>
    work(createDashboardRepository(handle, principal), principal),
  );
}
