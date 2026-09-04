import { RequestWorkspace } from "@/components/request-workspace";

import { buildDashboard } from "./actions";
import { DEFAULT_REQUEST, type PlanResult } from "./planning";

export const dynamic = "force-dynamic";

const INITIAL_KEY = Symbol.for("dasher.web.initialDashboard");
interface InitialCarrier {
  [INITIAL_KEY]?: Promise<PlanResult>;
}

/**
 * The landing page shows the sample built for the default request. Built once
 * per server process so a page view never spends a model call, and never
 * saved, because nobody asked for it.
 */
function initialDashboard(): Promise<PlanResult> {
  const carrier = globalThis as InitialCarrier;
  const existing = carrier[INITIAL_KEY];
  if (existing !== undefined) return existing;
  const form = new FormData();
  form.set("source", "sample");
  form.set("request", DEFAULT_REQUEST);
  form.set("persist", "no");
  const built = buildDashboard(form).then((result) => {
    if (!result.ok) carrier[INITIAL_KEY] = undefined;
    return result;
  });
  carrier[INITIAL_KEY] = built;
  return built;
}

export default async function Home() {
  const result = await initialDashboard();
  if (
    !result.ok ||
    result.dashboard === undefined ||
    result.plan === undefined
  ) {
    throw new Error(result.error ?? "Could not build the sample dashboard");
  }
  return <RequestWorkspace initial={result} initialRequest={DEFAULT_REQUEST} />;
}
