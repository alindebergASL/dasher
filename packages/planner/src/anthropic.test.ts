import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  AnthropicPlanningProvider,
  DEFAULT_PLANNING_MODEL,
  type PlanningClient,
} from "./anthropic";
import type { PlanningRequest } from "./provider";
import { transactionsTable } from "./test-tables";
import { runTablePlanner } from "./run";
import { FakePlanningProvider } from "./provider";
import { TablePlanSchema } from "./table-plan";
import { AS_OF, sourceFor } from "./test-tables";

interface Stub extends PlanningClient {
  params: Anthropic.MessageCreateParamsNonStreaming[];
}

function stubClient(
  responses: readonly { parsed_output: unknown; text?: string }[],
): Stub {
  const params: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    params,
    messages: {
      async parse(request) {
        params.push(request);
        const response =
          responses[Math.min(params.length - 1, responses.length - 1)]!;
        return {
          parsed_output: response.parsed_output,
          content:
            response.text === undefined
              ? []
              : [{ type: "text", text: response.text, citations: null }],
        };
      },
    },
  };
}

function request(extra: Partial<PlanningRequest> = {}): PlanningRequest {
  const table = transactionsTable();
  return {
    requestText: "Spend by category, last 3 months",
    table: { columns: table.columns, rowCount: table.rowCount },
    sourceName: "transactions.csv",
    ...extra,
  };
}

describe("AnthropicPlanningProvider", () => {
  it("requires a key or a client and names the model in its id", () => {
    expect(() => new AnthropicPlanningProvider({})).toThrow(/API key/u);
    expect(new AnthropicPlanningProvider({ apiKey: "k" }).id).toBe(
      `anthropic:${DEFAULT_PLANNING_MODEL}`,
    );
    expect(
      new AnthropicPlanningProvider({ apiKey: "k", model: "claude-sonnet-5" })
        .id,
    ).toBe("anthropic:claude-sonnet-5");
    expect(
      new AnthropicPlanningProvider({ client: stubClient([]) }).usesModel,
    ).toBe(true);
  });

  it("sends the request, the column profiles, and a structured output format", async () => {
    const client = stubClient([
      { parsed_output: { planVersion: "table-plan-v1" } },
    ]);
    const provider = new AnthropicPlanningProvider({ client, maxTokens: 1234 });
    const result = await provider.plan(request());
    expect(result).toEqual({ planVersion: "table-plan-v1" });

    const sent = client.params[0]!;
    expect(sent.model).toBe(DEFAULT_PLANNING_MODEL);
    expect(sent.max_tokens).toBe(1234);
    expect(typeof sent.system).toBe("string");
    expect(sent.system).toMatch(/budget-variance/u);
    expect(sent.output_config?.format?.type).toBe("json_schema");
    expect(sent.messages).toHaveLength(1);
    const content = sent.messages[0]!.content as string;
    expect(content).toContain("Spend by category, last 3 months");
    for (const name of ["Date", "Description", "Category", "Amount", "Account"])
      expect(content).toContain(`"name": "${name}"`);
    expect(content).toContain("142 rows");
    expect(content).not.toMatch(/previous plan/iu);
  });

  it("includes refinement and revision blocks when given", async () => {
    const client = stubClient([{ parsed_output: null, text: "{}" }]);
    const provider = new AnthropicPlanningProvider({ client });
    const table = transactionsTable();
    const previousPlan = TablePlanSchema.parse(
      await new FakePlanningProvider().plan({
        requestText: "Spend",
        table: { columns: table.columns, rowCount: table.rowCount },
        sourceName: "t.csv",
      }),
    );
    await provider.plan(
      request({
        refinement: { previousPlan, instruction: "drop the trend" },
        revision: {
          attempt: 1,
          previousPlan,
          findings: [
            {
              code: "unknown_column",
              path: "roles.amount",
              message: "No such column.",
            },
          ],
        },
      }),
    );
    const content = client.params[0]!.messages[0]!.content as string;
    expect(content).toContain("drop the trend");
    expect(content).toContain("roles.amount");
    expect(content.indexOf("drop the trend")).toBeLessThan(
      content.indexOf("rejected"),
    );
  });

  it("falls back to the text when nothing was parsed and returns unparseable text as-is", async () => {
    const provider = new AnthropicPlanningProvider({
      client: stubClient([
        { parsed_output: null, text: '{"a":1}' },
        { parsed_output: null, text: "nope" },
      ]),
    });
    expect(await provider.plan(request())).toEqual({ a: 1 });
    expect(await provider.plan(request())).toBe("nope");
  });

  it("flows through the run loop into a dashboard that records the model", async () => {
    const table = transactionsTable();
    const plan = await new FakePlanningProvider().plan({
      requestText: "Spend",
      table: { columns: table.columns, rowCount: table.rowCount },
      sourceName: "t.csv",
    });
    const provider = new AnthropicPlanningProvider({
      client: stubClient([{ parsed_output: plan }]),
      model: "claude-opus-5",
    });
    const run = await runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "t.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts).toHaveLength(1);
    expect(
      run.dashboard.evidence.find((item) => item.id === "composition")
        ?.sourceName,
    ).toBe("anthropic:claude-opus-5");
  });
});
