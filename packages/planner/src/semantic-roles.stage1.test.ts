import { profileTable } from "@dasher/workbook";
import { describe, expect, it, vi } from "vitest";

import { findPlanProblems } from "./plan";
import { OpenRouterPlanningProvider } from "./openrouter";
import { FakePlanningProvider, type PlanningRequest } from "./provider";
import type { TablePlan } from "./table-plan";
import type { Table } from "./workbook";

function interpretedTable(): Table {
  return profileTable({
    headers: [
      "Chassis ID",
      "Product Code",
      "Priority Rank",
      "Revenue",
      "Region",
    ],
    rows: [
      ["101", "70001", "1", "1000", "North"],
      ["102", "70002", "2", "900", "South"],
      ["103", "70003", "3", "1100", "West"],
    ],
  });
}

function request(
  table: Table,
  requestText = "Show an overview",
): PlanningRequest {
  return {
    requestText,
    sourceName: "synthetic-dataset",
    table: { columns: table.columns, rowCount: table.rowCount },
  };
}

function planWithAmount(amount: string): TablePlan {
  return {
    planVersion: "table-plan-v1",
    title: "Operations overview",
    audience: "Operations",
    framing: "A summary followed by regional detail.",
    roles: { amount, category: "Region" },
    grain: "month",
    filters: [],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "A summary of the dataset.",
        sections: ["summary"],
      },
    ],
  };
}

function response(content: unknown): Response {
  return new Response(
    JSON.stringify({
      model: "stage-1-model",
      choices: [{ message: { content } }],
    }),
  );
}

describe("stage 1 amount-role safety", () => {
  it.each(["Chassis ID", "Product Code", "Priority Rank"])(
    "rejects %s when a plan assigns it to roles.amount",
    (column) => {
      const findings = findPlanProblems(
        planWithAmount(column),
        interpretedTable(),
      );
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "roles.amount" }),
        ]),
      );
    },
  );

  it("rejects text-valued identifiers, codes, and ordinals from dimension roles", () => {
    const table = profileTable({
      headers: ["Customer ID", "Region Code", "Priority Rank", "Revenue"],
      rows: [
        ["customer-a", "north-code", "first", "1000"],
        ["customer-b", "south-code", "second", "1200"],
      ],
    });

    for (const [role, column] of [
      ["category", "Customer ID"],
      ["label", "Region Code"],
      ["account", "Priority Rank"],
    ] as const) {
      const plan = {
        ...planWithAmount("Revenue"),
        roles: { amount: "Revenue", [role]: column },
      } satisfies TablePlan;
      expect(findPlanProblems(plan, table)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: `roles.${role}` }),
        ]),
      );
    }
  });

  it("rejects non-semantic assignments for budget and period roles", () => {
    const plan = {
      ...planWithAmount("Revenue"),
      roles: {
        amount: "Revenue",
        budget: "Chassis ID",
        period: "Product Code",
        category: "Region",
      },
    } satisfies TablePlan;

    expect(findPlanProblems(plan, interpretedTable())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "roles.budget" }),
        expect.objectContaining({ path: "roles.period" }),
      ]),
    );
  });

  it("chooses a semantic measure instead of a more identifier-like numeric column", async () => {
    const raw = await new FakePlanningProvider().plan(
      request(interpretedTable()),
    );
    expect(raw).toMatchObject({ roles: { amount: "Revenue" } });
  });

  it("applies an explicit safe primary-measure correction", async () => {
    const table = profileTable({
      headers: ["Month", "Spend", "Revenue", "Customer ID"],
      rows: [
        ["2026-01", "100", "150", "7001"],
        ["2026-02", "110", "175", "7002"],
      ],
    });
    const provider = new FakePlanningProvider();
    const initial = (await provider.plan(
      request(table, "Show spend over time"),
    )) as TablePlan;

    const corrected = await provider.plan({
      ...request(table, "Show spend over time"),
      refinement: {
        previousPlan: initial,
        instruction: "Use Revenue as the primary measure",
      },
    });

    expect(corrected).toMatchObject({
      roles: { amount: "Revenue" },
      title: "Revenue over time",
    });
    expect(JSON.stringify(corrected)).not.toMatch(/Spend over time/u);
  });

  it("does not accept an identifier as a primary-measure correction", async () => {
    const table = interpretedTable();
    const provider = new FakePlanningProvider();
    const initial = (await provider.plan(request(table))) as TablePlan;

    const corrected = await provider.plan({
      ...request(table),
      refinement: {
        previousPlan: initial,
        instruction: "Use Chassis ID as the primary measure",
      },
    });

    expect(corrected).toBe(initial);
  });

  it("uses the interpreted measure in generated titles and descriptions", async () => {
    const table = profileTable({
      headers: ["Date", "Region", "Revenue"],
      rows: [
        ["2026-01-01", "North", "1000"],
        ["2026-02-01", "South", "1200"],
      ],
    });

    const raw = await new FakePlanningProvider().plan(
      request(table, "Show revenue by region over time"),
    );

    expect(raw).toMatchObject({ title: "Revenue over time" });
    expect(JSON.stringify(raw)).not.toMatch(/\b(?:money|spend)\b/iu);
  });

  it("fails closed when the canonical table has numeric identifiers but no measure", async () => {
    const identifiersOnly = profileTable({
      headers: ["Chassis ID", "Product Code", "Priority Rank", "Region"],
      rows: [
        ["101", "70001", "1", "North"],
        ["102", "70002", "2", "South"],
      ],
    });

    await expect(
      new FakePlanningProvider().plan(request(identifiersOnly)),
    ).rejects.toThrow(/measure/u);
  });

  it("constrains model amount and budget choices to measures and period to periods", async () => {
    const table = profileTable({
      headers: ["Order Number", "Fiscal Period", "Revenue", "Region"],
      rows: [
        ["1001", "202601", "500", "North"],
        ["1002", "202602", "600", "South"],
      ],
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response(JSON.stringify({ planVersion: "table-plan-v1" })),
      );
    const provider = new OpenRouterPlanningProvider({
      apiKey: "synthetic-provider-placeholder",
      model: "stage-1-model",
      fetcher,
    });

    await provider.plan(request(table));

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      response_format: {
        json_schema: {
          schema: {
            properties: {
              roles: { properties: Record<string, { enum?: string[] }> };
            };
          };
        };
      };
    };
    const roles =
      body.response_format.json_schema.schema.properties.roles.properties;
    expect(roles["amount"]?.enum).toEqual(["Revenue"]);
    expect(roles["budget"]?.enum).toEqual(["Revenue"]);
    expect(roles["period"]?.enum).toEqual(["Fiscal Period"]);
  });
});
