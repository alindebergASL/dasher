// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

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
      /fake.*anthropic.*openrouter/u,
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

  it("refuses OpenRouter without its own key rather than falling back", () => {
    expect(() => plannerFromEnv({ DASHER_PLANNER: "openrouter" })).toThrow(
      /OPENROUTER_API_KEY/u,
    );
  });

  it("builds an honestly named OpenRouter planner with secure defaults", () => {
    const provider = plannerFromEnv({
      DASHER_PLANNER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      DASHER_PUBLIC_ORIGIN: "https://luckbutton.com",
    });
    expect(provider.usesModel).toBe(true);
    expect(provider.id).toBe("openrouter:z-ai/glm-5.3");
  });

  it("sends low reasoning effort when OpenRouter effort is unset", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "z-ai/glm-5.3",
          choices: [
            {
              message: {
                content: JSON.stringify({ planVersion: "table-plan-v1" }),
              },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const provider = plannerFromEnv({
        DASHER_PLANNER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
      });
      await provider.plan(request);
      const init = fetcher.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(init.body)) as {
        reasoning_effort: string;
      };
      expect(body.reasoning_effort).toBe("low");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an unsupported OpenRouter reasoning effort", () => {
    expect(() =>
      plannerFromEnv({
        DASHER_PLANNER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
        DASHER_PLANNER_REASONING_EFFORT: "maximum",
      }),
    ).toThrow(/low.*medium.*high/u);
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
