import { Pool } from "pg";

/**
 * Does a restored database still hold the evidence its dashboards cite?
 *
 * WHY A BACKUP NEEDS THIS AND A SCHEMA MIGRATION DOES NOT. Everything else in
 * this package is checked by the database refusing bad input: constraints,
 * triggers, row security. A restore is the one operation where the database
 * accepts whatever it is given — `pg_restore` will happily produce a
 * structurally valid database that is missing rows, and every constraint will
 * pass, because a foreign key only complains about a child without a parent and
 * a lost parent takes its children with it.
 *
 * So the check is not "did the restore error". It is whether the three claims
 * this product makes about stored evidence still hold:
 *
 *   1. Every stored file still hashes to the digest recorded beside it.
 *   2. Every version that cites a snapshot can still find it. A dashboard whose
 *      `source_snapshot_id` dangles is one asserting figures whose evidence is
 *      gone, which is the state the retention design exists to prevent.
 *   3. Every claim edge still lands on an evidence record, and every evidence
 *      record still belongs to a snapshot.
 *
 * WHICH OF THOSE IS ACTUALLY LOAD-BEARING, measured rather than assumed. The
 * first is not, for an ordinary restore: `source_snapshots_content_sha256_check`
 * is a CHECK constraint tying the digest to the bytes, and Postgres enforces
 * CHECK constraints during the COPY that loads a dump — so mangled bytes fail
 * the restore itself. Verified by trying: the corrupting UPDATE was refused by
 * the constraint, not caught by this file. It is kept as one cheap scan that
 * still means something for a database assembled some other way, and it is
 * described here as what it is rather than as the main defence.
 *
 * The dangling checks are the load-bearing ones, because foreign keys are NOT
 * enforced on the paths a partial recovery actually takes:
 * `pg_restore --disable-triggers` turns off FK triggers, a selective `-t`
 * restore brings some tables and not others, and a restore continued past
 * errors leaves whatever it managed. All three produce a database that opens
 * cleanly, answers queries, and is missing the rows a dashboard's figures point
 * at. Each check below has been driven red against a real restored database in
 * exactly that state.
 *
 * WHY IT COUNTS AS WELL AS CHECKS. All three pass trivially on an empty
 * database. A restore that produced no rows is the worst outcome and the one
 * most likely to look like success, so the totals are reported and a caller
 * that expected data gets to say so.
 */

export interface RestoreCheckCounts {
  readonly snapshots: number;
  readonly evidenceRecords: number;
  readonly claims: number;
  readonly claimEdges: number;
  readonly dashboardVersions: number;
}

export interface RestoreCheckResult {
  readonly ok: boolean;
  readonly counts: RestoreCheckCounts;
  /** Empty when `ok`. One sentence per broken invariant, with its scale. */
  readonly failures: readonly string[];
}

interface Queryable {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

async function count(client: Queryable, sql: string): Promise<number> {
  const result = await client.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n ?? "0");
}

export async function checkRestore(
  client: Queryable,
): Promise<RestoreCheckResult> {
  const counts: RestoreCheckCounts = {
    snapshots: await count(
      client,
      "SELECT count(*)::text AS n FROM dasher.source_snapshots",
    ),
    evidenceRecords: await count(
      client,
      "SELECT count(*)::text AS n FROM dasher.evidence_records",
    ),
    claims: await count(
      client,
      "SELECT count(*)::text AS n FROM dasher.claims",
    ),
    claimEdges: await count(
      client,
      "SELECT count(*)::text AS n FROM dasher.claim_evidence",
    ),
    dashboardVersions: await count(
      client,
      "SELECT count(*)::text AS n FROM dasher.dashboard_versions",
    ),
  };

  const failures: string[] = [];

  // 1. The bytes are the bytes. Belt and braces: the column's own CHECK
  // constraint already ties these together and is enforced as a dump loads, so
  // this can only fire for a database that was assembled without it.
  const corrupted = await count(
    client,
    `SELECT count(*)::text AS n
       FROM dasher.source_snapshots
      WHERE content_sha256 <> sha256(canonical_bytes)`,
  );
  if (corrupted > 0) {
    failures.push(
      `${String(corrupted)} stored file(s) no longer hash to the digest recorded beside them`,
    );
  }

  // 2. Nothing cites evidence that is not there. The composite key means a
  // dangling reference has to be checked on BOTH columns, not just the id.
  const dangling = await count(
    client,
    `SELECT count(*)::text AS n
       FROM dasher.dashboard_versions AS version
      WHERE version.source_snapshot_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM dasher.source_snapshots AS snapshot
           WHERE snapshot.organization_id = version.organization_id
             AND snapshot.snapshot_id = version.source_snapshot_id
        )`,
  );
  if (dangling > 0) {
    failures.push(
      `${String(dangling)} dashboard version(s) cite a stored file that is missing`,
    );
  }

  // 3. The chain from an assertion to the bytes behind it, in both links.
  const orphanEdges = await count(
    client,
    `SELECT count(*)::text AS n
       FROM dasher.claim_evidence AS edge
      WHERE NOT EXISTS (
        SELECT 1 FROM dasher.evidence_records AS record
         WHERE record.organization_id = edge.organization_id
           AND record.evidence_id = edge.evidence_id
      )`,
  );
  if (orphanEdges > 0) {
    failures.push(
      `${String(orphanEdges)} claim edge(s) point at an evidence record that is missing`,
    );
  }

  const orphanEvidence = await count(
    client,
    `SELECT count(*)::text AS n
       FROM dasher.evidence_records AS record
      WHERE NOT EXISTS (
        SELECT 1 FROM dasher.source_snapshots AS snapshot
         WHERE snapshot.organization_id = record.organization_id
           AND snapshot.snapshot_id = record.snapshot_id
      )`,
  );
  if (orphanEvidence > 0) {
    failures.push(
      `${String(orphanEvidence)} evidence record(s) belong to a stored file that is missing`,
    );
  }

  // A claim with `evidence_state = 'complete'` and no edges is the specific
  // dishonesty a partial restore produces: the dashboard still says every
  // figure is backed, and nothing is behind it any more.
  const unbackedComplete = await count(
    client,
    `SELECT count(*)::text AS n
       FROM dasher.claims AS claim
      WHERE claim.evidence_state = 'complete'
        AND NOT EXISTS (
          SELECT 1 FROM dasher.claim_evidence AS edge
           WHERE edge.organization_id = claim.organization_id
             AND edge.claim_id = claim.claim_id
        )`,
  );
  if (unbackedComplete > 0) {
    failures.push(
      `${String(unbackedComplete)} claim(s) still say their evidence is complete with no evidence behind them`,
    );
  }

  return { ok: failures.length === 0, counts, failures };
}

export function formatRestoreCheck(result: RestoreCheckResult): string {
  const { counts } = result;
  const tally =
    `${String(counts.snapshots)} stored file(s), ` +
    `${String(counts.evidenceRecords)} evidence record(s), ` +
    `${String(counts.claims)} claim(s) over ${String(counts.claimEdges)} edge(s), ` +
    `${String(counts.dashboardVersions)} dashboard version(s)`;

  if (!result.ok) {
    return `RESTORE NOT VERIFIED\n  ${tally}\n${result.failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`;
  }

  if (counts.snapshots === 0 && counts.dashboardVersions === 0) {
    // Not a failure — a fresh deployment restores to nothing and that is
    // correct — but "every invariant held" over no rows is a sentence worth
    // refusing to say plainly.
    return `Restore verified, but the database is EMPTY: ${tally}.\nIf you expected data, this restore did not bring it.\n`;
  }

  return `Restore verified: ${tally}, every digest and citation intact.\n`;
}

export async function runRestoreCheck(
  dsn: string,
): Promise<RestoreCheckResult> {
  const pool = new Pool({ connectionString: dsn, max: 1 });
  try {
    return await checkRestore(pool);
  } finally {
    await pool.end();
  }
}
