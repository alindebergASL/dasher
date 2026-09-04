import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DashboardSpec } from "@dasher/dashboard-schema";
import {
  FakePlanningProvider,
  runTablePlanner,
  type TablePlan,
} from "@dasher/planner";
import { readTable } from "@dasher/workbook";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The bundled sample, read the way the app reads it. */
export function sampleCsv(): string {
  return readFileSync(
    path.join(here, "..", "samples", "transactions.csv"),
    "utf8",
  );
}

/** A real dashboard from the sample through the deterministic planner. */
export async function sampleDashboard(
  requestText = "Where is the money going, and what changed last month?",
): Promise<{ dashboard: DashboardSpec; plan: TablePlan }> {
  const table = readTable(sampleCsv());
  const run = await runTablePlanner({
    requestText,
    table,
    provider: new FakePlanningProvider(),
    asOf: "2026-09-04T12:00:00.000Z",
    source: {
      name: "sample-transactions.csv",
      retrievedAt: "2026-09-04T12:00:00.000Z",
      rowCount: table.rowCount,
    },
  });
  return { dashboard: run.dashboard, plan: run.plan };
}
