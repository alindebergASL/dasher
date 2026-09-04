// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PlanRejected } from "@dasher/planner";

import {
  buildFailureMessage,
  DailyLimitedProvider,
  PlannerBudgetExceeded,
  plannerFromEnv,
} from "./planner-config";

const request = {
  requestText: "anything",
  table: { columns: [], rowCount: 0 },
  sourceName: "x.csv",
};

describe("plannerFromEnv", () => {
  it("defaults to the fake planner", () => {
    expect(plannerFromEnv({}).usesModel).toBe(false);
  });

  it("refuses anthropic without a key rather than falling back", () => {
    expect(() => plannerFromEnv({ DASHER_PLANNER: "anthropic" })).toThrow(
      /ANTHROPIC_API_KEY/u,
    );
  });

  it("refuses an unknown planner name", () => {
    expect(() => plannerFromEnv({ DASHER_PLANNER: "openai" })).toThrow(
      /fake.*anthropic/u,
    );
  });

  it("builds a model planner when configured", () => {
    const provider = plannerFromEnv({
      DASHER_PLANNER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
      DASHER_PLANNER_MODEL: "claude-opus-5",
    });
    expect(provider.usesModel).toBe(true);
    expect(provider.id).toContain("claude-opus-5");
  });
});

describe("DailyLimitedProvider", () => {
  it("stops at the limit and resets the next day", async () => {
    let calls = 0;
    const inner = {
      id: "inner",
      usesModel: true,
      plan: async () => {
        calls += 1;
        return {};
      },
    };
    let now = new Date("2026-09-04T10:00:00Z");
    const limited = new DailyLimitedProvider(inner, 2, () => now);
    await limited.plan(request);
    await limited.plan(request);
    await expect(limited.plan(request)).rejects.toBeInstanceOf(
      PlannerBudgetExceeded,
    );
    expect(calls).toBe(2);
    now = new Date("2026-09-05T00:00:01Z");
    await limited.plan(request);
    expect(calls).toBe(3);
  });
});

describe("a budget error through the planner loop", () => {
  // The planner records a provider throw as a failed attempt and reports the
  // original on `cause` once the attempts run out, so the budget is only
  // recognisable through the wrapper.
  it("still reads as the budget message once wrapped", async () => {
    const inner = {
      id: "x",
      usesModel: true,
      plan: async () => ({}),
    };
    const limited = new DailyLimitedProvider(inner, 1);
    await limited.plan(request);
    const error = await limited.plan(request).catch((one: unknown) => one);
    const wrapped = new PlanRejected([], { cause: error });
    expect(buildFailureMessage(wrapped)).toMatch(/planning budget/u);
  });
});
