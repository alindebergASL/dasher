import type { PlanningProvider } from "@dasher/planner";

/**
 * What to record as having planned a dashboard.
 *
 * The persistence call site wrote `{ provider: "fake", model: "fake-planner" }`
 * as a literal. Two things were wrong with it. It named no provider in this
 * repository — the deterministic planner's id is `fake-keyword-planner-v1` —
 * and, more to the point, it could not change when a different planner ran. A
 * record that is written next to the thing it describes rather than derived
 * from it is a decoration.
 *
 * Both fields come from guarantees the `PlanningProvider` interface already
 * makes. `usesModel` exists precisely to say whether a model chose the
 * composition; `id` names what ran, vendor first when there is a vendor. So
 * this keeps naming the truth on the day a model-backed provider is wired in,
 * without anyone having to remember to come back here.
 *
 * The persisted columns are `varchar(64)`, which both forms fit.
 */

export interface PlannerProvenance {
  readonly provider: string;
  readonly model: string;
}

export function provenanceOf(
  planner: Pick<PlanningProvider, "id" | "usesModel">,
): PlannerProvenance {
  if (!planner.usesModel) {
    return { provider: "deterministic", model: planner.id };
  }
  const separator = planner.id.indexOf(":");
  return separator === -1
    ? { provider: planner.id, model: planner.id }
    : {
        provider: planner.id.slice(0, separator),
        model: planner.id.slice(separator + 1),
      };
}

/**
 * Two sources, two planners. Identical names collapse rather than repeat, so a
 * combined dashboard planned by one kind of planner reads the same as a
 * single-source one planned by it.
 */
export function combinedProvenance(
  planners: readonly Pick<PlanningProvider, "id" | "usesModel">[],
): PlannerProvenance {
  const each = planners.map(provenanceOf);
  const join = (pick: (one: PlannerProvenance) => string): string =>
    [...new Set(each.map(pick))].join("+");
  return {
    provider: join((one) => one.provider),
    model: join((one) => one.model),
  };
}
