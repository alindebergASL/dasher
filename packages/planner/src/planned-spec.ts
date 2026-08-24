import type { DashboardComponent, Evidence } from "@dasher/dashboard-schema";

/**
 * The parts of compiling a plan that do not know what a source is.
 *
 * Extracted when a second source arrived, and extracted no further than that.
 * `compile.ts` builds dashboards from stations and `compile-ledger.ts` builds
 * them from a ledger; these are the two things they were about to hold
 * identical copies of. Everything genuinely station-shaped — selection,
 * metrics, freshness, the components themselves — stayed where it was.
 *
 * There is no `SourceCompiler` interface here and no registry of sources. Two
 * compilers that share two functions do not need one, and an abstraction with
 * one real implementation is the thing this repository keeps deciding not to
 * build ahead of evidence.
 */

export const PLANNER_EVIDENCE_ID = "planner-composition";

export interface PlannerIdentity {
  readonly id: string;
  readonly usesModel: boolean;
}

/**
 * Names what chose the composition, in the reader's terms.
 *
 * A deterministic planner and a model are different claims about the system,
 * and the difference is exactly what a reader of the architecture panel wants
 * to know. Saying "model" when none ran overstates Dasher's role; saying
 * nothing leaves the layout unattributed.
 *
 * `subject` is what the plan selected — "gauge", "budget line". It is a word
 * rather than a domain object because this sentence is the only thing here that
 * needs one, and taking the whole vocabulary would make this file know about
 * stations again.
 */
export function composerSentence(
  planner: PlannerIdentity,
  subject: string,
): string {
  return planner.usesModel
    ? `A planning model chose this dashboard's title, audience, framing, ${subject} selection, and page layout.`
    : `A deterministic planner chose this dashboard's title, audience, framing, ${subject} selection, and page layout; no model was called.`;
}

/**
 * The planner's record of its own part in the work — which is the only thing a
 * planner contributes to a dashboard's evidence. It produced no reading, no
 * calculation, and no claim.
 */
export function plannerEvidence(
  planner: PlannerIdentity,
  subject: string,
  asOf: string,
): Evidence {
  return {
    id: PLANNER_EVIDENCE_ID,
    kind: "interpreted",
    label: "Dashboard composition",
    sourceName: `Dasher planner (${planner.id})`,
    retrievedAt: asOf,
    detail: `${composerSentence(planner, subject)} It did not produce any reading, calculation, or claim: every value shown here is computed by Dasher from the source observations and validated against the dashboard contract before display.`,
    confidence: "medium",
  };
}

interface PlannedPage<TSection> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sections: readonly TSection[];
}

/**
 * Turn a plan's pages into a dashboard's pages, dropping what a source could
 * not build.
 *
 * A section that produces nothing is not an error: a plan may ask for lines
 * over budget when none are, and the honest result is a page without that
 * section rather than an empty panel. A page left with no components at all
 * goes too, for the same reason.
 */
export function assemblePages<TSection>(
  pages: readonly PlannedPage<TSection>[],
  build: (section: TSection) => DashboardComponent | undefined,
): Array<{
  id: string;
  title: string;
  description: string;
  components: DashboardComponent[];
}> {
  return pages
    .map((page) => ({
      id: page.id,
      title: page.title,
      description: page.description,
      components: page.sections
        .map(build)
        .filter(
          (component): component is DashboardComponent =>
            component !== undefined,
        ),
    }))
    .filter((page) => page.components.length > 0);
}

/** Evidence ids, deduplicated, order preserved. */
export function uniqueIds(
  ...groups: ReadonlyArray<readonly string[]>
): string[] {
  return [...new Set(groups.flat())];
}
