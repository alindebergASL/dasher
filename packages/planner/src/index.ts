/**
 * `@dasher/planner`: a planner (a model, or a deterministic fake) chooses how
 * to read an uploaded table and how to compose the dashboard; trusted code
 * computes every figure with exact decimals and cites its evidence.
 *
 * The model-backed provider is also reachable alone at
 * `@dasher/planner/anthropic`.
 */
export {
  TABLE_PLAN_MAX_FILTERS,
  TABLE_PLAN_MAX_PAGES,
  TABLE_PLAN_MAX_SECTIONS_PER_PAGE,
  TABLE_SECTION_KINDS,
  TablePlanSchema,
  type TablePlan,
  type TableSectionKind,
} from "./table-plan";
export {
  findMeasurement,
  findPlanProblems,
  isPeriodColumn,
  planFreeText,
  PlanRejected,
  type PlanFinding,
  type PlanFindingCode,
} from "./plan";
export {
  FakePlanningProvider,
  type PlanningProvider,
  type PlanningRefinement,
  type PlanningRequest,
  type PlanningRevision,
  type PlanningTable,
} from "./provider";
export { NoSafeMeasureError } from "./fake-heuristics";
export {
  compileTablePlan,
  type CompileOptions,
  type CompileSource,
} from "./compile";
export { computeFacts, type TableFacts } from "./facts";
export {
  describePlan,
  PLANNER_MAX_ATTEMPTS,
  runTablePlanner,
  type PlannerAttempt,
  type PlannerRun,
  type RunTablePlannerOptions,
} from "./run";
export {
  AnthropicPlanningProvider,
  DEFAULT_PLANNING_MODEL,
  type AnthropicPlanningProviderOptions,
  type PlanningClient,
} from "./anthropic";
export {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterPlanningError,
  OpenRouterPlanningProvider,
  type OpenRouterPlanningProviderOptions,
  type OpenRouterReasoningEffort,
} from "./openrouter";
