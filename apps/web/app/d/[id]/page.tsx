import { withDashboardRepository } from "@dasher/control-plane";
import { parseDashboardSpec } from "@dasher/dashboard-schema";
import { notFound } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";

import { getPool, isPersistenceConfigured } from "../../database";
import { readSessionCredential } from "../../session";

/**
 * A saved dashboard, reopened.
 *
 * WHY THIS RENDERS STORED BYTES RATHER THAN RECOMPILING. The bytes are what
 * `finalize_run` sealed and hashed, so rendering them is the only way a reload
 * shows what was actually approved. Recompiling on read would be a different
 * product: the output would depend on the planner and the observations at read
 * time, so the same URL could show two different dashboards on two visits, with
 * freshness semantics nobody specified and a model call per page view.
 *
 * WHY THE BYTES ARE STILL PARSED. They came back from a database, and the last
 * thing that vouched for them was a schema check before they were written. That
 * check happened in a different process, possibly under a different version of
 * this code. Parsing here is not distrust of the database; it is the same rule
 * the planner already lives under — the contract is enforced where the value is
 * used, not where it was produced.
 *
 * WHY EVERY FAILURE IS 404. Not found, not yours, and stored-bytes-no-longer-
 * valid are three different problems for us and must be one answer to a caller.
 * Distinguishing them tells someone which dashboard ids exist in another
 * organization.
 *
 * That was the documented contract before it was the actual behaviour. Probing
 * found two ways through it, both returning 500 and both distinguishable from a
 * 404: an id that is not a UUID reached PostgreSQL and came back as `22P02`,
 * and a well-formed but unissued session token let `RequestContextError` escape.
 * A caller could tell "no such dashboard" from "malformed id" and from "bad
 * credential" — which is exactly the discrimination this paragraph promised
 * nobody could make. Both are normalised below, before and around the query.
 */

/** Rejects anything the id column cannot hold, without asking the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export default async function SavedDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!isPersistenceConfigured()) notFound();

  // Before the query, not after: a malformed id is a 22P02 from PostgreSQL,
  // which is a 500 and therefore a different answer from a real miss.
  if (!UUID.test(id)) notFound();

  const credential = await readSessionCredential();
  if (credential === undefined) notFound();

  let loaded;
  try {
    loaded = await withDashboardRepository(
      getPool(),
      credential,
      async (repository) => repository.loadById(id),
    );
  } catch (error) {
    // A cookie that is well formed but names no live session raises `denied`.
    // Letting it escape returns 500, which tells the holder of a forged token
    // that their token is the problem rather than the dashboard. Anything else
    // is a real fault and still surfaces as one.
    if (isDenied(error)) notFound();
    throw error;
  }
  if (loaded === undefined) notFound();

  // Both steps throw rather than returning a result, and both are reachable:
  // bytes that are not JSON, and JSON that is no longer a legal spec because
  // the contract moved since it was written.
  let spec;
  try {
    spec = parseDashboardSpec(
      JSON.parse(loaded.canonicalSpecBytes.toString("utf8")) as unknown,
    );
  } catch {
    notFound();
  }

  // `sealed`: these are stored bytes. The route renders what `finalize_run`
  // hashed, so the badge says snapshot rather than describing how the readings
  // were fetched on the day the dashboard was built.
  return <DashboardShell dashboard={spec} sealed />;
}

function isDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "denied"
  );
}
