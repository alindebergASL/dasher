import { RequestWorkspace } from "@/components/request-workspace";

import { planDashboard } from "./actions";
import { DEFAULT_REQUEST } from "./planning";

export default async function Home() {
  const result = await planDashboard(DEFAULT_REQUEST);

  if (!result.ok || !result.dashboard) {
    throw new Error(result.error ?? "Could not plan the default dashboard");
  }

  return (
    <RequestWorkspace
      initialDashboard={result.dashboard}
      initialRequest={DEFAULT_REQUEST}
    />
  );
}
