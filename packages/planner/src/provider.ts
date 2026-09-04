/**
 * What a planner is asked and what it answers with. The answer is `unknown`
 * on purpose: every provider's output is parsed and checked before anything
 * is computed from it.
 */
import type { ColumnProfile } from "./workbook";
import type { PlanFinding } from "./plan";
import type { TablePlan } from "./table-plan";
import { applyRefinement, applyRevision } from "./fake-refine";
import { chooseRoles, defaultPlan, type TableSummary } from "./fake-heuristics";

export interface PlanningTable {
  readonly columns: readonly ColumnProfile[];
  readonly rowCount: number;
  /** True when a wide file was reshaped to one row per line and period. */
  readonly unpivoted?: boolean;
  /**
   * Distinct values, by column name, for the columns small enough to list.
   * A provider may name a filter value only from what it can see here or in a
   * column's samples.
   */
  readonly values?: Readonly<Record<string, readonly string[]>>;
}

export interface PlanningRevision {
  readonly attempt: number;
  readonly previousPlan: TablePlan;
  readonly findings: readonly PlanFinding[];
}

export interface PlanningRefinement {
  readonly previousPlan: TablePlan;
  /** The reader's change request, in their words. */
  readonly instruction: string;
}

export interface PlanningRequest {
  readonly requestText: string;
  readonly table: PlanningTable;
  readonly sourceName: string;
  readonly revision?: PlanningRevision;
  readonly refinement?: PlanningRefinement;
}

export interface PlanningProvider {
  /** Written into the dashboard's evidence, so it names what actually planned. */
  readonly id: string;
  readonly usesModel: boolean;
  plan(request: PlanningRequest): Promise<unknown>;
}

/**
 * A deterministic planner: names and types pick the roles, a few request
 * phrases pick the grain, filters, and section order. It exists so the whole
 * pipeline runs, and is testable, without a model.
 */
export class FakePlanningProvider implements PlanningProvider {
  readonly id = "fake-table-planner";
  readonly usesModel = false;

  plan(request: PlanningRequest): Promise<unknown> {
    const summary: TableSummary = {
      columns: request.table.columns,
      unpivoted: request.table.unpivoted === true,
      ...(request.table.values === undefined
        ? {}
        : { values: request.table.values }),
    };
    if (request.revision !== undefined) {
      return Promise.resolve(
        applyRevision(
          request.revision.previousPlan,
          request.revision.findings,
          summary,
        ),
      );
    }
    if (request.refinement !== undefined) {
      return Promise.resolve(
        applyRefinement(
          request.refinement.previousPlan,
          request.refinement.instruction,
          summary,
        ),
      );
    }
    const roles = chooseRoles(summary);
    return Promise.resolve(
      defaultPlan(request.requestText, request.sourceName, roles, summary),
    );
  }
}
