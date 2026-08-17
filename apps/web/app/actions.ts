"use server";

import {
  DashboardPlanSchema,
  FakePlanningProvider,
  isUninterpretable,
  PlanRejected,
  readRefinementIntent,
  runPlanner,
  type DashboardPlan,
  type PlannerRunOptions,
} from "@dasher/planner";
import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";

import {
  DEMO_THRESHOLDS,
  PLANNED_DASHBOARD_AS_OF,
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
  type PlanResult,
} from "./planning";

/**
 * Nothing here trusts its arguments. A server action is a public endpoint —
 * anything that can reach the page can call it with anything — so request text
 * is bounded and the previous plan a refinement carries is re-parsed against
 * the contract rather than accepted because the browser sent it back.
 *
 * The round trip is safe in a second way, which is why it is worth preferring
 * over replaying the whole conversation server-side: a plan carries composition
 * only. Even a doctored one can only change which sections appear, and it then
 * goes through the site check, the free-text gate, the trusted compiler, and
 * the dashboard contract exactly as a provider's own output does.
 */

function tooLong(text: string, limit: number, label: string): string {
  return `${label} are limited to ${limit} characters. Yours is ${text.length}.`;
}

async function plan(
  requestText: string,
  refine?: PlannerRunOptions["refine"],
): Promise<PlanResult> {
  const gauges = parseUsgsInstantaneousValues(fixture);

  try {
    const run = await runPlanner({
      requestText,
      gauges,
      provider: new FakePlanningProvider(),
      asOf: PLANNED_DASHBOARD_AS_OF,
      thresholds: DEMO_THRESHOLDS,
      ...(refine === undefined ? {} : { refine }),
    });
    const same =
      refine !== undefined &&
      JSON.stringify(run.plan) === JSON.stringify(refine.previousPlan);
    return {
      ok: true,
      dashboard: run.dashboard,
      plan: run.plan,
      attempts: run.attempts.length,
      // An identical plan has two very different causes. Reporting both as
      // "not understood" tells a reader their working request failed — the
      // shipped "Add the history chart" chip does exactly that on the default
      // dashboard, which already has one.
      ...(same
        ? {
            refinement: isUninterpretable(
              readRefinementIntent(
                refine.instruction,
                gauges.map((gauge) => ({
                  siteId: gauge.siteId,
                  name: gauge.name,
                  river: gauge.river,
                })),
              ),
            )
              ? ("not-understood" as const)
              : ("already-satisfied" as const),
          }
        : {}),
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
      error: tooLong(trimmed, REQUEST_MAX_LENGTH, "Requests"),
    };
  }
  return plan(trimmed);
}

export async function refineDashboard(
  requestText: string,
  instruction: string,
  previousPlan: unknown,
): Promise<PlanResult> {
  const trimmedInstruction = instruction.trim();
  if (trimmedInstruction.length === 0) {
    return { ok: false, error: "Type what you want to change." };
  }
  if (trimmedInstruction.length > REFINEMENT_MAX_LENGTH) {
    return {
      ok: false,
      error: tooLong(trimmedInstruction, REFINEMENT_MAX_LENGTH, "Changes"),
    };
  }

  // Parse, don't trust. The client is holding this plan and can return
  // anything; what comes back is a `DashboardPlan` because the schema said so,
  // not because of where it arrived from.
  const parsed = DashboardPlanSchema.safeParse(previousPlan);
  if (!parsed.success) {
    return {
      ok: false,
      error: "That dashboard can no longer be changed. Build a new one.",
    };
  }
  const base: DashboardPlan = parsed.data;

  return plan(requestText.trim().slice(0, REQUEST_MAX_LENGTH), {
    previousPlan: base,
    instruction: trimmedInstruction,
  });
}
