import type { DashboardSpec } from "@dasher/dashboard-schema";
import type { RiverGauge, ThresholdRule } from "@dasher/river-domain";

import { compilePlan, type CompileOptions } from "./compile";
import {
  DashboardPlanSchema,
  findPlanProblems,
  PlanRejected,
  type DashboardPlan,
  type PlanFinding,
} from "./plan";
import type { AvailableSite, PlanningProvider } from "./provider";

export const PLANNER_MAX_ATTEMPTS = 3;

export interface PlannerRunOptions {
  requestText: string;
  gauges: readonly RiverGauge[];
  provider: PlanningProvider;
  asOf: string;
  /** User-configured threshold alerts. Never exposed to the provider. */
  thresholds?: readonly ThresholdRule[];
  /** Total plan attempts, including the first. Defaults to 3. */
  maxAttempts?: number;
}

export interface PlannerAttempt {
  attempt: number;
  /** Findings that rejected this attempt. Empty on the accepted attempt. */
  findings: readonly PlanFinding[];
  accepted: boolean;
}

export interface PlannerRun {
  dashboard: DashboardSpec;
  plan: DashboardPlan;
  attempts: readonly PlannerAttempt[];
}

/**
 * Run one governed planning pass: ask the provider for a plan, validate it
 * against the observations and the dashboard contract, and on rejection hand
 * the structured findings back for a bounded number of revisions.
 *
 * Provider output is untrusted at every step. It is parsed, structurally
 * checked against the data that actually exists, compiled by trusted code, and
 * finally validated against the dashboard contract. A plan that fails any of
 * those produces findings, never a rendered dashboard.
 */
export async function runPlanner(
  options: PlannerRunOptions,
): Promise<PlannerRun> {
  const maxAttempts = options.maxAttempts ?? PLANNER_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  const availableSites: AvailableSite[] = options.gauges.map((gauge) => ({
    siteId: gauge.siteId,
    name: gauge.name,
    river: gauge.river,
  }));
  const knownSiteIds = availableSites.map((site) => site.siteId);
  const compileOptions: CompileOptions = {
    asOf: options.asOf,
    plannerId: options.provider.id,
    thresholds: options.thresholds,
  };

  const attempts: PlannerAttempt[] = [];
  let previousPlan: DashboardPlan | undefined;
  let previousFindings: readonly PlanFinding[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await options.provider.plan({
      requestText: options.requestText,
      availableSites,
      revision:
        previousPlan === undefined
          ? undefined
          : {
              attempt: attempt - 1,
              previousPlan,
              findings: previousFindings,
            },
    });

    const parsed = DashboardPlanSchema.safeParse(raw);
    if (!parsed.success) {
      previousFindings = parsed.error.issues.slice(0, 16).map((issue) => ({
        code: "plan_malformed" as const,
        path: issue.path.join("."),
        message: issue.message,
      }));
      attempts.push({ attempt, findings: previousFindings, accepted: false });
      // Without a well-formed plan there is nothing to revise from, so the
      // next attempt starts clean rather than from unparseable output.
      previousPlan = undefined;
      continue;
    }

    const plan = parsed.data;
    const problems = findPlanProblems(plan, knownSiteIds);
    if (problems.length > 0) {
      previousPlan = plan;
      previousFindings = problems;
      attempts.push({ attempt, findings: problems, accepted: false });
      continue;
    }

    try {
      const dashboard = compilePlan(plan, options.gauges, compileOptions);
      attempts.push({ attempt, findings: [], accepted: true });
      return { dashboard, plan, attempts };
    } catch (error) {
      previousPlan = plan;
      previousFindings = [
        {
          code: "spec_rejected",
          path: "pages",
          message:
            error instanceof Error
              ? error.message
              : "The compiled dashboard failed contract validation.",
        },
      ];
      attempts.push({ attempt, findings: previousFindings, accepted: false });
    }
  }

  throw new PlanRejected(previousFindings);
}
