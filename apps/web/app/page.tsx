import { RequestWorkspace } from "@/components/request-workspace";

import { planDashboard } from "./actions";
import { DEFAULT_REQUEST } from "./planning";

export default async function Home() {
  const result = await planDashboard(DEFAULT_REQUEST);

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
