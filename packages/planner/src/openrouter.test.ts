import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterPlanningError,
  OpenRouterPlanningProvider,
} from "./openrouter";
import type { PlanningRequest } from "./provider";
import { FakePlanningProvider } from "./provider";
import { runTablePlanner } from "./run";
import { AS_OF, sourceFor, transactionsTable } from "./test-tables";

function request(): PlanningRequest {
  const table = transactionsTable();
  return {
    requestText: "Spend by category",
    table: { columns: table.columns, rowCount: table.rowCount },
    sourceName: "transactions.csv",
  };
}

function response(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
  });
}

describe("OpenRouterPlanningProvider", () => {
  it("requires a key, validates bounds, and names the real provider and model", () => {
    expect(() => new OpenRouterPlanningProvider({ apiKey: " " })).toThrow(
      /API key/u,
    );
    expect(
      () => new OpenRouterPlanningProvider({ apiKey: "x", maxTokens: 0 }),
    ).toThrow(/maxTokens/u);
    expect(
      () => new OpenRouterPlanningProvider({ apiKey: "x", timeoutMs: 0 }),
    ).toThrow(/timeoutMs/u);
    expect(new OpenRouterPlanningProvider({ apiKey: "x" }).id).toBe(
      `openrouter:${DEFAULT_OPENROUTER_MODEL}`,
    );
  });

  it("uses native chat completions with strict ZDR structured output", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response(JSON.stringify({ planVersion: "table-plan-v1" })),
      );
    const provider = new OpenRouterPlanningProvider({
      apiKey: "secret-key",
      model: "z-ai/glm-5.3",
      maxTokens: 1234,
      reasoningEffort: "medium",
      siteUrl: "https://luckbutton.com",
      appName: "Dasher",
      fetcher,
    });

    expect(await provider.plan(request())).toEqual({
      planVersion: "table-plan-v1",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEFAULT_OPENROUTER_BASE_URL);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({
      authorization: "Bearer secret-key",
      "content-type": "application/json",
      "http-referer": "https://luckbutton.com",
      "x-openrouter-title": "Dasher",
    });

    const body = JSON.parse(String(init.body)) as {
      model: string;
      max_tokens: number;
      reasoning_effort: string;
      messages: { role: string; content: string }[];
      response_format: {
        type: string;
        json_schema: { strict: boolean; schema: Record<string, unknown> };
      };
      provider: Record<string, unknown>;
    };
    expect(body.model).toBe("z-ai/glm-5.3");
    expect(body.max_tokens).toBe(1234);
    expect(body.reasoning_effort).toBe("medium");
    expect(body.messages[0]?.content).toContain(
      'planVersion must be exactly "table-plan-v1"',
    );
    expect(body.messages[1]?.content).toContain("Spend by category");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toMatchObject({
      type: "object",
    });
    expect(body.provider).toEqual({
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      allow_fallbacks: false,
    });
  });

  it("returns malformed plan text for the governed loop to reject", async () => {
    const provider = new OpenRouterPlanningProvider({
      apiKey: "x",
      fetcher: vi.fn().mockResolvedValue(response("not-json")),
    });
    expect(await provider.plan(request())).toBe("not-json");
  });

  it("reports only provider status and never its potentially sensitive body", async () => {
    const provider = new OpenRouterPlanningProvider({
      apiKey: "x",
      fetcher: vi
        .fn()
        .mockResolvedValue(new Response("sample cell SECRET", { status: 422 })),
    });
    const error = await provider.plan(request()).catch((one: unknown) => one);
    expect(error).toBeInstanceOf(OpenRouterPlanningError);
    expect(String(error)).toMatch(/answered 422/u);
    expect(String(error)).not.toContain("SECRET");
  });

  it("rejects missing, non-JSON, and oversized response envelopes", async () => {
    for (const returned of [
      new Response("not-json"),
      new Response(JSON.stringify({ choices: [] })),
      new Response("x".repeat(128 * 1024 + 1)),
    ]) {
      const provider = new OpenRouterPlanningProvider({
        apiKey: "x",
        fetcher: vi.fn().mockResolvedValue(returned),
      });
      await expect(provider.plan(request())).rejects.toBeInstanceOf(
        OpenRouterPlanningError,
      );
    }
  });

  it("flows through the governed loop and records OpenRouter provenance", async () => {
    const table = transactionsTable();
    const plan = await new FakePlanningProvider().plan({
      requestText: "Spend",
      table: { columns: table.columns, rowCount: table.rowCount },
      sourceName: "transactions.csv",
    });
    const provider = new OpenRouterPlanningProvider({
      apiKey: "x",
      model: "z-ai/glm-5.3",
      fetcher: vi.fn().mockResolvedValue(response(JSON.stringify(plan))),
    });
    const run = await runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "transactions.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts).toHaveLength(1);
    expect(
      run.dashboard.evidence.find((item) => item.id === "composition")
        ?.sourceName,
    ).toBe("openrouter:z-ai/glm-5.3");
  });
});
