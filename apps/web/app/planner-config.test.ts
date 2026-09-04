// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
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
