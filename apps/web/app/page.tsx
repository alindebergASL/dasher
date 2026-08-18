import { RequestWorkspace } from "@/components/request-workspace";

import { planDashboard } from "./actions";
import { DEFAULT_REQUEST } from "./planning";

/**
 * Rendered per request, not prerendered.
 *
 * Generating a dashboard now reads the session cookie to decide whether to
 * persist it, and `cookies()` is not available while a page is being statically
 * generated at build time. This page was static before persistence existed;
 * saying so explicitly is better than relying on Next inferring it from a call
 * several modules deep.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  // Not persisted: nobody asked for this one, and its id is never shown.
  const result = await planDashboard(DEFAULT_REQUEST, { persist: false });

  if (!result.ok || !result.dashboard || !result.plan) {
    throw new Error(result.error ?? "Could not plan the default dashboard");
  }

  return (
    <RequestWorkspace
      initialDashboard={result.dashboard}
      initialPlan={result.plan}
      initialRequest={DEFAULT_REQUEST}
    />
  );
}
