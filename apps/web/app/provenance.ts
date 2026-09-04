import type { PlanningProvider } from "@dasher/planner";

export interface PlannerProvenance {
  readonly provider: string;
  readonly model: string;
}

/** What a saved version records about who chose its composition. */
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
