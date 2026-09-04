import "server-only";

import {
  AnthropicPlanningProvider,
  FakePlanningProvider,
  PlanRejected,
  type PlanningProvider,
  type PlanningRequest,
} from "@dasher/planner";

/**
 * The planner is an explicit choice, never a fallback. `DASHER_PLANNER=fake`
 * (the default) is deterministic and what CI runs. `anthropic` requires a key
 * and fails at first use without one.
 */

export const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_DAILY_LIMIT = 500;

export class PlannerBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`The planner has used its ${limit} model calls for today.`);
    this.name = "PlannerBudgetExceeded";
  }
}

/** Caps model calls per UTC day. In-process; one instance per server. */
export class DailyLimitedProvider implements PlanningProvider {
  readonly id: string;
  readonly usesModel: boolean;
  private day = "";
  private used = 0;

  constructor(
    private readonly inner: PlanningProvider,
    private readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.id = inner.id;
    this.usesModel = inner.usesModel;
  }

  async plan(request: PlanningRequest): Promise<unknown> {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.limit) throw new PlannerBudgetExceeded(this.limit);
    this.used += 1;
    return this.inner.plan(request);
  }
}

export function plannerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlanningProvider {
  const choice = (env["DASHER_PLANNER"] ?? "fake").trim().toLowerCase();
  if (choice === "fake" || choice === "") return new FakePlanningProvider();
  if (choice !== "anthropic") {
    throw new Error(
      `DASHER_PLANNER must be "fake" or "anthropic", not "${choice}".`,
    );
  }
  const apiKey = env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  if (apiKey === "") {
    throw new Error(
      "DASHER_PLANNER=anthropic requires ANTHROPIC_API_KEY. There is no fallback planner.",
    );
  }
  const limitText = env["DASHER_PLANNER_DAILY_LIMIT"]?.trim();
  const limit =
    limitText === undefined || limitText === ""
      ? DEFAULT_DAILY_LIMIT
      : Number.parseInt(limitText, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("DASHER_PLANNER_DAILY_LIMIT must be a positive integer.");
  }
  return new DailyLimitedProvider(
    new AnthropicPlanningProvider({
      apiKey,
      model: env["DASHER_PLANNER_MODEL"]?.trim() || DEFAULT_MODEL,
    }),
    limit,
  );
}

const PLANNER_KEY = Symbol.for("dasher.web.planner");
interface PlannerCarrier {
  [PLANNER_KEY]?: PlanningProvider;
}

/** One provider per server process, so the daily limit is shared. */
export function planner(): PlanningProvider {
  const carrier = globalThis as PlannerCarrier;
  const existing = carrier[PLANNER_KEY];
  if (existing !== undefined) return existing;
  const created = plannerFromEnv();
  carrier[PLANNER_KEY] = created;
  return created;
}

/** The sentence a reader gets when a build fails, and why. */
export function buildFailureMessage(error: unknown): string {
  // The reader gets a sentence; the operator needs the cause. Without this a
  // provider outage is indistinguishable from a bad request in the logs.
  if (!(error instanceof PlanRejected)) {
    console.error("dashboard build failed", error);
  }
  // The planner turns a provider throw into a failed attempt and reports the
  // original on `cause` once the attempts run out, so the budget is only
  // recognisable through the wrapper.
  if (error instanceof PlanRejected && error.cause !== undefined) {
    return buildFailureMessage(error.cause);
  }
  if (error instanceof PlannerBudgetExceeded) {
    return "Dasher has used today's planning budget. Try again tomorrow, or switch to the built-in planner.";
  }
  if (error instanceof PlanRejected) {
    const first = error.findings[0];
    return `Dasher could not build a dashboard it could stand behind for that request.${first === undefined ? "" : ` ${first.message}`}`;
  }
  return "Something went wrong building that dashboard. Try rewording the request.";
}
