"use server";

import {
  FakePlanningProvider,
  PlanRejected,
  runPlanner,
} from "@dasher/planner";
import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";

import {
  DEMO_THRESHOLDS,
  PLANNED_DASHBOARD_AS_OF,
  REQUEST_MAX_LENGTH,
  type PlanResult,
} from "./planning";

export async function planDashboard(requestText: string): Promise<PlanResult> {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "Type what you want to monitor to get started.",
    };
  }
  if (trimmed.length > REQUEST_MAX_LENGTH) {
    return {
      ok: false,
      error: `Requests are limited to ${REQUEST_MAX_LENGTH} characters. Yours is ${trimmed.length}.`,
    };
  }

  const gauges = parseUsgsInstantaneousValues(fixture);

  try {
    const run = await runPlanner({
      requestText: trimmed,
      gauges,
      provider: new FakePlanningProvider(),
      asOf: PLANNED_DASHBOARD_AS_OF,
      thresholds: DEMO_THRESHOLDS,
    });
    return {
      ok: true,
      dashboard: run.dashboard,
      attempts: run.attempts.length,
    };
  } catch (error) {
    if (error instanceof PlanRejected) {
      return {
        ok: false,
        error:
          `Dasher could not build a dashboard it could stand behind for that request. ${error.findings[0]?.message ?? ""}`.trim(),
      };
    }
    return {
      ok: false,
      error: "Something went wrong building that dashboard. Try rewording it.",
    };
  }
}
