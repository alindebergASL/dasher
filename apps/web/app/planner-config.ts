import "server-only";

import {
  AnthropicPlanningProvider,
  FakePlanningProvider,
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
  env: NodeJS.ProcessEnv = process.env,
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
