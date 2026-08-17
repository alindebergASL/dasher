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
 */
export default async function SavedDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!isPersistenceConfigured()) notFound();

  const credential = await readSessionCredential();
  if (credential === undefined) notFound();

  const loaded = await withDashboardRepository(
    getPool(),
    credential,
    async (repository) => repository.loadById(id),
  );
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

  return <DashboardShell dashboard={spec} />;
}
