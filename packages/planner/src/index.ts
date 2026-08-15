/**
 * `@dasher/planner` — a governed planning loop that turns a plain-language
 * request into a validated `DashboardSpec`.
 *
 * The boundary this package establishes: a planning model may choose a
 * dashboard's title, audience, framing, gauge selection, and page layout. It
 * may not produce a number, an evidence item, a claim, or a component kind
 * Dasher does not already implement. Trusted code computes every displayed
 * value from the observations and validates the result before it can render.
 *
 * Nothing here opens a network connection, reads a credential, executes
 * generated code, or persists anything.
 */

export {
  DashboardPlanSchema,
  findPlanProblems,
  PLAN_MAX_PAGES,
  PLAN_MAX_SECTIONS_PER_PAGE,
  PLAN_MAX_SITES,
  PLAN_SECTION_KINDS,
  PLAN_STRING_LIMITS,
  PlanRejected,
  type DashboardPlan,
  type PlanFinding,
  type PlanFindingCode,
  type PlanPage,
  type PlanSectionKind,
} from "./plan";

export {
  findSmuggledText,
  freeTextWithDigits,
  planFreeText,
  type SmuggledText,
  type SmuggledTextKind,
} from "./freetext";

export {
  FakePlanningProvider,
  type AvailableSite,
  type PlanningProvider,
  type PlanningRefinement,
  type PlanningRequest,
  type PlanningRevision,
} from "./provider";

export { compilePlan, type CompileOptions } from "./compile";

export {
  PLANNER_MAX_ATTEMPTS,
  runPlanner,
  type PlannerAttempt,
  type PlannerRun,
  type PlannerRunOptions,
} from "./run";
