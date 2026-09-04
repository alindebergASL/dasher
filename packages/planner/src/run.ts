/**
 * The governed loop: ask the provider for a plan, check it, compile it, and
 * on failure send the findings back for a bounded number of revisions.
 */
import type { DashboardSpec } from "@dasher/dashboard-schema";
import type { Table } from "./workbook";
import { compileTablePlan, type CompileSource } from "./compile";
import { planGrain } from "./facts";
import { findPlanProblems, PlanRejected, type PlanFinding } from "./plan";
import type { PlanningProvider, PlanningRefinement } from "./provider";
import { TablePlanSchema, type TablePlan } from "./table-plan";

export const PLANNER_MAX_ATTEMPTS = 3;

export interface RunTablePlannerOptions {
  readonly requestText: string;
  readonly table: Table;
  readonly provider: PlanningProvider;
  readonly source: CompileSource;
  readonly asOf: string;
  /** A change to a dashboard the reader can see; handed to the provider on every attempt. */
  readonly refine?: PlanningRefinement;
  /** Total attempts including the first. Defaults to 3. */
  readonly maxAttempts?: number;
}

export interface PlannerAttempt {
  readonly attempt: number;
  readonly findings: readonly PlanFinding[];
  readonly accepted: boolean;
}

export interface PlannerRun {
  readonly dashboard: DashboardSpec;
  readonly plan: TablePlan;
  readonly attempts: readonly PlannerAttempt[];
}

export async function runTablePlanner(
  options: RunTablePlannerOptions,
): Promise<PlannerRun> {
  const maxAttempts = options.maxAttempts ?? PLANNER_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  const attempts: PlannerAttempt[] = [];
  let previousPlan: TablePlan | undefined;
  let previousFindings: readonly PlanFinding[] = [];
  let providerError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw: unknown;
    try {
      raw = await options.provider.plan({
        requestText: options.requestText,
        table: {
          columns: options.table.columns,
          rowCount: options.table.rowCount,
          ...(options.table.unpivoted === undefined ? {} : { unpivoted: true }),
        },
        sourceName: options.source.name,
        ...(options.refine === undefined ? {} : { refinement: options.refine }),
        ...(previousPlan === undefined
          ? {}
          : {
              revision: {
                attempt: attempt - 1,
                previousPlan,
                findings: previousFindings,
              },
            }),
      });
    } catch (error) {
      // RULE: a provider that fails costs one attempt; it never aborts the run.
      providerError = error;
      previousFindings = [
        {
          code: "plan_malformed",
          path: "",
          message: `The planner did not answer: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
      attempts.push({ attempt, findings: previousFindings, accepted: false });
      previousPlan = undefined;
      continue;
    }

    const parsed = TablePlanSchema.safeParse(raw);
    if (!parsed.success) {
      previousFindings = parsed.error.issues.slice(0, 16).map((issue) => ({
        code: "plan_malformed" as const,
        path: issue.path.join("."),
        message: issue.message,
      }));
      attempts.push({ attempt, findings: previousFindings, accepted: false });
      previousPlan = undefined;
      continue;
    }

    const plan = parsed.data;
    const problems = findPlanProblems(plan, options.table);
    if (problems.length > 0) {
      previousPlan = plan;
      previousFindings = problems;
      attempts.push({ attempt, findings: problems, accepted: false });
      continue;
    }

    try {
      const dashboard = compileTablePlan(plan, options.table, {
        asOf: options.asOf,
        planner: {
          id: options.provider.id,
          usesModel: options.provider.usesModel,
        },
        source: options.source,
      });
      attempts.push({ attempt, findings: [], accepted: true });
      return { dashboard, plan, attempts };
    } catch (error) {
      const findings: readonly PlanFinding[] =
        error instanceof PlanRejected
          ? error.findings
          : [
              {
                code: "spec_rejected",
                path: "pages",
                message:
                  error instanceof Error
                    ? error.message
                    : "The compiled dashboard failed contract validation.",
              },
            ];
      attempts.push({ attempt, findings, accepted: false });
      // RULE: filters that leave no rows are the answer, not a finding to
      // repair. Revising them away would show the reader exactly what they
      // asked to remove, and report it as a success.
      if (findings.some((finding) => finding.code === "empty_after_filters")) {
        throw new PlanRejected(findings);
      }
      previousPlan = plan;
      previousFindings = findings;
    }
  }

  throw new PlanRejected(previousFindings, { cause: providerError });
}

/** One reader-facing sentence on how the plan reads the table. */
export function describePlan(plan: TablePlan, table: Table): string {
  const parts = [`${plan.roles.amount} as the figure`];
  if (plan.roles.category !== undefined)
    parts.push(`${plan.roles.category} as the grouping`);
  if (plan.roles.budget !== undefined)
    parts.push(`${plan.roles.budget} as the budget`);
  if (plan.roles.period !== undefined) {
    const reshaped =
      table.unpivoted !== undefined &&
      plan.roles.period === table.unpivoted.periodColumn;
    parts.push(
      `${reshaped ? "the period columns" : plan.roles.period} by ${planGrain(plan, table)}`,
    );
  }
  return `Read ${parts.join(", ")}.`;
}
