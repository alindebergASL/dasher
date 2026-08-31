import {
  RequestContextError,
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
  /**
   * The stored bytes these figures were computed from, when there are any.
   *
   * `undefined` is the ordinary case and says something specific: this
   * dashboard was built from a source that keeps no file — an API read at
   * request time, or a snapshot committed to the repository. Present, it names
   * a `source_snapshots` row, and the schema's foreign key then keeps those
   * bytes alive for as long as this version exists.
   */
  readonly sourceSnapshotId?: string;
  /**
   * One row per assertion the dashboard makes, with the evidence behind it.
   *
   * Opaque here in the same sense the spec bytes are: the shape is the seam's,
   * `@dasher/dashboard-schema` decides what an assertion is, and this file only
   * carries the rows across. Omitted or empty writes a version with no claims,
   * which is what every caller did before this existed.
   */
  readonly claims?: readonly PersistedClaim[];
  readonly requestId: string;
  readonly deploymentRevision: string;
}

/**
 * An assertion on the page, its evidence, and how well supported it is.
 *
 * `evidenceState` is the caller's to decide rather than the spec's, because it
 * answers a question the spec cannot: whether the evidence behind this
 * assertion was actually retained. A dashboard built from an uploaded file has
 * bytes standing behind its figures; one built from a live API read has the
 * same evidence on the page and nothing durable underneath it. Those are
 * different claims about the same sentence, and only the layer that knows
 * which `evidence_records` rows exist can tell them apart.
 */
export interface PersistedClaim {
  /** RFC 6901 pointer into the canonical spec bytes stored beside it. */
  readonly pointer: string;
  readonly label: string;
  readonly salience: "high" | "normal";
  readonly evidenceState:
    "complete" | "partial" | "contradicted" | "stale" | "unsupported";
  /** Lowercase hex, 64 characters. The seam decodes it. */
  readonly assertionSha256: string;
  /** `evidence_records` ids, which exist only where bytes were retained. */
  readonly evidence: readonly {
    readonly evidenceId: string;
    /** The three `claim_evidence_relation_check` accepts, verbatim. */
    readonly relation: "supports" | "contradicts" | "context";
  }[];
}

/** One retained-bytes citation: where in a snapshot a figure came from. */
export interface RecordEvidenceInput {
  /** The `source_snapshots` row these bytes are part of. */
  readonly snapshotId: string;
  /**
   * What kind of act produced the figure — `observed`, `calculated`,
   * `interpreted`, `recommended`. The spec's own vocabulary, carried through.
   */
  readonly evidenceKind: string;
  /**
   * Where inside the snapshot this came from, in whatever the producing domain
   * uses to locate it. For a ledger upload that is the evidence id the domain
   * minted per line, which is its own name for that row of the file.
   */
  readonly coordinates: string;
  /** What was done to those bytes to get the figure. */
  readonly transformation: string;
  /** Digest of the evidence item as displayed, computed by the caller. */
  readonly contentSha256: Uint8Array;
  /** When the source says this was true, not when it was received. */
  readonly observedAt: Date;
  readonly requestId: string;
  readonly deploymentRevision: string;
}

/** Bytes as they were received, plus the little a file cannot say about itself. */
export interface RecordSourceSnapshotInput {
  /**
   * What kind of thing was retrieved — `csv-upload`, and later `xlsx-upload` or
   * an API's name. Not a MIME type: the point is which reader was applied.
   */
  readonly sourceKind: string;
  /**
   * How this source is referred to. For an upload that is the filename the
   * browser reported, which is a claim by the client and is stored as one
   * rather than trusted for anything.
   */
  readonly sourceRef: string;
  /** Exactly what arrived. The digest is computed by the seam, not accepted. */
  readonly bytes: Uint8Array;
  /**
   * When the source says its contents were true, which is not when they were
   * received. The schema requires `retrieved_at >= observed_at` and stamps the
   * retrieval itself, so a caller cannot backdate the arrival.
   */
  readonly observedAt: Date;
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
  /**
   * The credential presented was not accepted: absent, expired, revoked, or
   * belonging to no live membership. The seam deliberately does not say which
   * of those it was, and neither does this.
   *
   * This exists so a caller can tell "your session is over" apart from "the
   * write failed", WITHOUT the request-context module becoming public. A
   * caller that cannot make the distinction has to describe a dead session as
   * a storage fault and invite a retry that can never work.
   */
  | "not_authenticated"
  /** A seam returned success without the identifier it promises. */
  | "unexpected_shape";

export class DashboardRepositoryError extends Error {
  readonly code: DashboardRepositoryErrorCode;

  constructor(
    code: DashboardRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DashboardRepositoryError";
    this.code = code;
  }
}

/** One row of the recent-dashboards listing: identity, not content. */
export interface DashboardListEntry {
  readonly dashboardId: string;
  readonly title: string;
  readonly createdAt: string;
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
   * Store retrieved bytes, and return the id a version can cite.
   *
   * Separate from `save` and called before it, because the two answer to
   * different failures: bytes that cannot be stored must stop the dashboard
   * being built at all, where a dashboard that cannot be saved is still a
   * dashboard. Both run inside one request transaction, so a failure at either
   * point leaves neither.
   */
  recordSourceSnapshot(input: RecordSourceSnapshotInput): Promise<string>;

  /**
   * Cite one part of a stored snapshot, and return the id a claim can link to.
   *
   * Called once per evidence item the spec carries, between storing the bytes
   * and saving the version, because a claim's edge needs an `evidence_records`
   * id and that row needs a snapshot to belong to. There is deliberately no
   * path to an evidence record without a snapshot: the column is `NOT NULL`,
   * and evidence that cites nothing retained is not evidence.
   */
  recordEvidence(input: RecordEvidenceInput): Promise<string>;

  /**
   * Read a dashboard and its head version by id.
   *
   * Returns `undefined` for both "no such dashboard" and "not yours", because
   * row-level security makes them the same query result and telling them apart
   * would leak the existence of another tenant's row.
   */
  loadById(dashboardId: string): Promise<LoadedDashboard | undefined>;

  /**
   * The organization's dashboards, newest first, bounded.
   *
   * Identity only — id, title, creation time — because a listing is a way to
   * find a dashboard, not a way to render one. Row-level security is the
   * entire isolation story here, exactly as it is for `loadById`; note that
   * this read touches `dashboards` UNJOINED, so it runs directly against the
   * policy the joined read only exercises in depth.
   */
  listRecent(limit: number): Promise<readonly DashboardListEntry[]>;
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
          "SELECT dasher_api.finalize_run($1, $2, $3::jsonb, $4, $5, $6, $7) AS version_id",
          [
            runId,
            input.canonicalSpecBytes,
            // The seam walks this array and writes `claims` and
            // `claim_evidence` itself. It was a literal `"[]"` from the day
            // `finalize_run` was written until this line, which is why three
            // fully modelled tables had never held a row.
            JSON.stringify(
              (input.claims ?? []).map((claim) => ({
                pointer: claim.pointer,
                label: claim.label,
                salience: claim.salience,
                evidence_state: claim.evidenceState,
                assertion_sha256: claim.assertionSha256,
                evidence: claim.evidence.map((edge) => ({
                  evidence_id: edge.evidenceId,
                  relation: edge.relation,
                })),
              })),
            ),
            FIRST_REVISION,
            input.requestId,
            input.deploymentRevision,
            // Named even when there is nothing to name. The seam takes no
            // default for this, so a version built from a live source says so
            // rather than inheriting an answer.
            input.sourceSnapshotId ?? null,
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

    async recordSourceSnapshot(
      input: RecordSourceSnapshotInput,
    ): Promise<string> {
      const stored = await handle.query<{ snapshot_id: string }>(
        "SELECT dasher_api.record_source_snapshot($1, $2, $3, $4, $5, $6) AS snapshot_id",
        [
          input.sourceKind,
          input.sourceRef,
          // `pg` sends a `Buffer` as `bytea`. A `Uint8Array` that is not one
          // goes over as an array literal and arrives as something else
          // entirely, so the conversion is here rather than left to each
          // caller to remember.
          Buffer.from(
            input.bytes.buffer,
            input.bytes.byteOffset,
            input.bytes.byteLength,
          ),
          input.observedAt.toISOString(),
          input.requestId,
          input.deploymentRevision,
        ],
      );

      const snapshotId = stored.rows[0]?.snapshot_id;
      if (snapshotId === undefined) {
        throw new DashboardRepositoryError(
          "unexpected_shape",
          "record_source_snapshot returned no identifier",
        );
      }
      return snapshotId;
    },

    async recordEvidence(input: RecordEvidenceInput): Promise<string> {
      const stored = await handle.query<{ evidence_id: string }>(
        "SELECT dasher_api.record_evidence($1, $2, $3, $4, $5, $6, $7, $8) AS evidence_id",
        [
          input.snapshotId,
          input.evidenceKind,
          input.coordinates,
          input.transformation,
          // Same reason as the snapshot bytes: a `Uint8Array` that is not a
          // `Buffer` goes over as an array literal and arrives as something
          // that is not a 32-byte digest, which the column's own CHECK then
          // rejects mid-transaction.
          Buffer.from(
            input.contentSha256.buffer,
            input.contentSha256.byteOffset,
            input.contentSha256.byteLength,
          ),
          input.observedAt.toISOString(),
          input.requestId,
          input.deploymentRevision,
        ],
      );

      const evidenceId = stored.rows[0]?.evidence_id;
      if (evidenceId === undefined) {
        throw new DashboardRepositoryError(
          "unexpected_shape",
          "record_evidence returned no identifier",
        );
      }
      return evidenceId;
    },

    async listRecent(limit: number): Promise<readonly DashboardListEntry[]> {
      // Bounded here, not by the caller's good manners: a listing that can be
      // asked for everything is a full-table read wearing a UI.
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new DashboardRepositoryError(
          "unexpected_shape",
          "listRecent limit must be an integer between 1 and 100",
        );
      }
      void principal;

      const result = await handle.query<{
        dashboard_id: string;
        title: string;
        created_at: string;
      }>(
        `SELECT dashboard_id,
                title,
                created_at::text AS created_at
           FROM dasher.dashboards
          ORDER BY created_at DESC, dashboard_id DESC
          LIMIT $1`,
        [limit],
      );

      return result.rows.map((row) => ({
        dashboardId: row.dashboard_id,
        title: row.title,
        createdAt: new Date(row.created_at).toISOString(),
      }));
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
  try {
    return await withRequestContext(
      pool,
      credential,
      async (handle, principal) =>
        work(createDashboardRepository(handle, principal), principal),
    );
  } catch (error) {
    /*
     * Translate the one context failure a caller can act on, and let every
     * other one through as itself.
     *
     * `request-context.ts` stays unexported — its handle still accepts SQL —
     * so its error type cannot be what callers match on. Re-raising the denial
     * in the vocabulary this module already publishes is what lets a caller
     * distinguish a finished session from a broken database without being
     * handed the seam to do it.
     *
     * Note the `await` above: without it this returns the promise and the
     * rejection escapes the `try` entirely, which is the shape of bug that
     * makes a translation like this silently do nothing.
     */
    if (error instanceof RequestContextError && error.code === "denied") {
      // `cause` keeps the original rejection reachable for whoever is
      // holding a debugger, without it becoming part of the contract.
      throw new DashboardRepositoryError(
        "not_authenticated",
        "the presented credential was not accepted",
        { cause: error },
      );
    }
    throw error;
  }
}
