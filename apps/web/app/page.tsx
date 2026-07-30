import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  createRiverDashboard,
  parseUsgsInstantaneousValues,
} from "@dasher/river-domain";

import { DashboardShell } from "@/components/dashboard-shell";

export default function Home() {
  const gauges = parseUsgsInstantaneousValues(fixture);
  const dashboard = createRiverDashboard(gauges, {
    asOf: "2026-07-29T12:02:00.000Z",
    thresholds: [
      {
        id: "freeport-demo-threshold",
        siteId: "11447650",
        label: "Freeport watch level",
        stageAbove: 14.5,
      },
    ],
  });

  return <DashboardShell dashboard={dashboard} />;
}
