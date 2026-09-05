import { profileTable } from "@dasher/workbook";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterPlanningProvider,
} from "./openrouter";
import { compileTablePlan, type CompileOptions } from "./compile";
import { findPlanProblems } from "./plan";
import { requestMessage } from "./prompt";
import { FakePlanningProvider, type PlanningRequest } from "./provider";
import { TablePlanSchema, type TablePlan } from "./table-plan";
import type { Table } from "./workbook";

const provider = new FakePlanningProvider();
const AS_OF = "2026-09-05T12:00:00.000Z";

function relationshipTable(
  rows: readonly (readonly string[])[] = [
    ["2026-01", "100", "12", "8675301"],
    ["2026-02", "120", "15", "8675302"],
    ["2026-03", "126", "18", "8675309"],
  ],
): Table {
  return profileTable({
    headers: ["Month", "Customers", "Headcount", "Customer ID"],
    rows,
  });
}

function request(table: Table, requestText: string): PlanningRequest {
  return {
    requestText,
    table: { columns: table.columns, rowCount: table.rowCount },
    sourceName: "monthly-dataset",
  };
}

function options(table: Table): CompileOptions {
  return {
    asOf: AS_OF,
    planner: { id: provider.id, usesModel: false },
    source: {
      name: "monthly-dataset",
      retrievedAt: AS_OF,
      rowCount: table.rowCount,
    },
  };
}

async function relationshipPlan(table: Table): Promise<TablePlan> {
  return TablePlanSchema.parse(
    await provider.plan(request(table, "Compare customers vs headcount")),
  );
}

function compile(table: Table, plan: TablePlan) {
  return compileTablePlan(plan, table, options(table));
}

function relationshipGrid(
  table: Table,
  plan: TablePlan,
): Extract<
  ReturnType<typeof compileTablePlan>["pages"][number]["components"][number],
  { kind: "metric-grid" }
> {
  const spec = compileTablePlan(plan, table, options(table));
  const component = spec.pages[0]?.components[0];
  expect(component?.kind).toBe("metric-grid");
  if (component?.kind !== "metric-grid") {
    throw new Error("Relationship metric grid was not first");
  }
  return component;
}

describe("bounded metric relationships", () => {
  it("keeps one-metric plans valid and fails closed for missing, repeated, or unsafe comparison roles", async () => {
    const table = relationshipTable();
    const oneMetric = {
      planVersion: "table-plan-v1",
      title: "Customers overview",
      audience: "Operations",
      framing: "Customers first.",
      roles: { amount: "Customers", period: "Month" },
      grain: "month",
      filters: [],
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "Customer totals by month.",
          sections: ["summary"],
        },
      ],
    } satisfies TablePlan;
    expect(TablePlanSchema.parse(oneMetric)).toEqual(oneMetric);

    const valid = await relationshipPlan(table);
    expect(valid.roles).toMatchObject({
      amount: "Customers",
      comparison: "Headcount",
      period: "Month",
    });
    expect(valid.relationship).toEqual({ operation: "ratio" });
    expect(valid.pages[0]?.sections[0]).toBe("relationship");
    expect(findPlanProblems(valid, table)).toEqual([]);

    const withoutComparison = {
      ...valid,
      roles: { amount: "Customers", period: "Month" },
    } as TablePlan;
    expect(findPlanProblems(withoutComparison, table)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "section_needs_role",
          path: "pages[0].sections[0]",
        }),
      ]),
    );

    for (const comparison of ["Customers", "Customer ID"] as const) {
      const unsafe = {
        ...valid,
        roles: { ...valid.roles, comparison },
      } as TablePlan;
      expect(findPlanProblems(unsafe, table)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "roles.comparison" }),
        ]),
      );
    }
  });

  it("selects a comparison only for a clear request naming two safe measures", async () => {
    const table = relationshipTable();
    const comparative = await relationshipPlan(table);
    expect(comparative.title).toBe("Customers vs Headcount");
    expect(comparative.roles.comparison).toBe("Headcount");

    for (const text of [
      "Show customers over time",
      "Compare customer ID vs headcount",
      "Compare customers with operations",
    ]) {
      const ordinary = TablePlanSchema.parse(
        await provider.plan(request(table, text)),
      );
      expect(ordinary.roles.comparison).toBeUndefined();
      expect(ordinary.pages.flatMap((page) => page.sections)).not.toContain(
        "relationship",
      );
    }
  });

  it("does not promote a text Customers column or spend revisions on it", async () => {
    const table = profileTable({
      headers: ["Month", "Customers", "Revenue"],
      rows: [
        ["2026-01", "Acme", "100"],
        ["2026-02", "Bravo", "120"],
      ],
    });
    const plan = TablePlanSchema.parse(
      await provider.plan(request(table, "Compare customers vs revenue")),
    );

    expect(plan.roles.amount).toBe("Revenue");
    expect(plan.roles.comparison).toBeUndefined();
    expect(plan.relationship).toBeUndefined();
    expect(plan.pages.flatMap((page) => page.sections)).not.toContain(
      "relationship",
    );
    expect(findPlanProblems(plan, table)).toEqual([]);
  });

  it("uses explicit compare semantics without inventing a denominator", async () => {
    const table = profileTable({
      headers: ["Month", "Revenue", "Cost"],
      rows: [
        ["2026-01", "100", "80"],
        ["2026-02", "120", "90"],
      ],
    });
    const plan = TablePlanSchema.parse(
      await provider.plan(request(table, "Compare Revenue vs Cost")),
    );
    const spec = compile(table, plan);
    const text = JSON.stringify(spec);

    expect(plan.relationship).toEqual({ operation: "compare" });
    expect(text).not.toContain("Revenue per Cost");
    expect(text).not.toContain("Cost per Revenue");
  });

  it("computes both latest values, prior values, growth rates, and the latest ratio", async () => {
    const table = relationshipTable();
    const grid = relationshipGrid(table, await relationshipPlan(table));

    expect(grid.title).toBe("Customers vs Headcount");
    expect(grid.metrics).toEqual([
      expect.objectContaining({
        label: "Customers, Mar 2026",
        value: "126",
        change: "120 in Feb 2026 · +5.0%",
        direction: "up",
      }),
      expect.objectContaining({
        label: "Headcount, Mar 2026",
        value: "18",
        change: "15 in Feb 2026 · +20.0%",
        direction: "up",
      }),
      expect.objectContaining({
        label: "Customers per Headcount, Mar 2026",
        value: "7",
        change: "8 in Feb 2026 · -12.5%",
      }),
    ]);
    expect(grid.subtitle).toBe(
      "Headcount +20.0% vs Customers +5.0%; Customers per Headcount fell from 8 to 7 (-12.5%).",
    );
  });

  it("puts both measures, their relative change, and a specific evidence-linked action in the brief", async () => {
    const table = relationshipTable();
    const plan = await relationshipPlan(table);
    const spec = compileTablePlan(plan, table, options(table));

    expect(spec.executiveBrief.known).toMatchObject({
      headline: "126 Customers and 18 Headcount for Mar 2026",
      detail:
        "Latest amount and complete-support comparison values computed from the dataset.",
    });
    expect(spec.executiveBrief.changed).toMatchObject({
      headline: "Customers +5.0%; Headcount +20.0% vs Feb 2026",
    });
    expect(spec.executiveBrief.important).toMatchObject({
      headline: "Customers per Headcount fell from 8 to 7 (-12.5%)",
      detail: "Headcount grew +20.0% while Customers grew +5.0%.",
    });
    expect(spec.nextAction).toMatchObject({
      title: "Review the drop in Customers per Headcount",
      detail:
        "Customers per Headcount fell from 8 in Feb 2026 to 7 in Mar 2026 (-12.5%), while Headcount changed +20.0% and Customers changed +5.0%. Check the linked observations and operating context before acting; this comparison does not establish a cause.",
      evidenceIds: expect.arrayContaining(["calculations"]),
    });
  });

  it("omits a zero-denominator ratio and states exactly why it is unavailable", async () => {
    const table = relationshipTable([
      ["2026-01", "100", "12", "8675301"],
      ["2026-02", "120", "15", "8675302"],
      ["2026-03", "126", "0", "8675309"],
    ]);
    const grid = relationshipGrid(table, await relationshipPlan(table));

    expect(grid.metrics.at(-1)).toMatchObject({
      label: "Customers per Headcount, Mar 2026",
      value: "Unavailable",
      change:
        "Relationship unavailable — the Headcount total for Mar 2026 is zero.",
    });
    expect(grid.subtitle).toBe(
      "Headcount -100.0% vs Customers +5.0%; Customers per Headcount is unavailable because the Headcount total for Mar 2026 is zero.",
    );
  });

  it("fails the whole relationship closed when a latest comparison cell is missing", async () => {
    const table = relationshipTable([
      ["2026-01", "100", "12", "8675301"],
      ["2026-02", "120", "15", "8675302"],
      ["2026-03", "60", "9", "8675309"],
      ["2026-03", "66", "", "8675310"],
    ]);
    const plan = await relationshipPlan(table);
    const grid = relationshipGrid(table, plan);
    const rendered = JSON.stringify(compile(table, plan));

    expect(grid.metrics.at(-1)).toMatchObject({
      label: "Customers per Headcount, Mar 2026",
      value: "Unavailable",
    });
    expect(rendered).not.toContain("+5.0%");
    expect(rendered).not.toContain("+20.0%");
    expect(rendered).not.toContain('"value":"14"');
    expect(grid.subtitle).toContain("unavailable");
  });

  it("shows no ratio or either growth comparison when prior support is incomplete", async () => {
    const table = relationshipTable([
      ["2026-01", "100", "12", "8675301"],
      ["2026-02", "60", "", "8675302"],
      ["2026-02", "60", "15", "8675303"],
      ["2026-03", "126", "18", "8675309"],
    ]);
    const plan = await relationshipPlan(table);
    const grid = relationshipGrid(table, plan);
    const rendered = JSON.stringify(compile(table, plan));

    expect(grid.metrics.at(-1)).toMatchObject({
      label: "Customers per Headcount, Mar 2026",
      value: "Unavailable",
    });
    expect(rendered).not.toContain("+5.0%");
    expect(rendered).not.toContain("+20.0%");
    expect(rendered).not.toContain('"value":"7"');
    expect(grid.subtitle).toContain("unavailable");
  });

  it("does not emit relationship framing or action without an active relationship section", async () => {
    const table = relationshipTable();
    const active = await relationshipPlan(table);
    const summaryOnly = {
      ...active,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "Customer summary.",
          sections: ["summary" as const],
        },
      ],
    };

    expect(findPlanProblems(summaryOnly, table)).toEqual([]);
    const spec = compile(table, summaryOnly);
    expect(spec.executiveBrief.known.headline).toBe("126 total for Mar 2026");
    expect(spec.nextAction.title).toBe("Open the evidence");
    expect(JSON.stringify(spec.executiveBrief)).not.toContain("Headcount");
    expect(JSON.stringify(spec.nextAction)).not.toContain("Headcount");
  });

  it("clears relationship metadata when deterministic refinement removes the section", async () => {
    const table = relationshipTable();
    const active = await relationshipPlan(table);
    const refined = TablePlanSchema.parse(
      await provider.plan({
        ...request(table, "Compare customers vs headcount"),
        refinement: {
          previousPlan: active,
          instruction: "drop the relationship",
        },
      }),
    );

    expect(refined.roles.comparison).toBeUndefined();
    expect(refined.relationship).toBeUndefined();
    expect(refined.pages.flatMap((page) => page.sections)).not.toContain(
      "relationship",
    );
    expect(findPlanProblems(refined, table)).toEqual([]);
  });

  it("keeps relationship plans focused on the relationship and row evidence", async () => {
    const plan = await relationshipPlan(relationshipTable());
    const kinds = plan.pages.flatMap((page) => page.sections);

    expect(kinds).toContain("relationship");
    expect(kinds).toContain("table");
    expect(kinds).not.toContain("summary");
    expect(kinds).not.toContain("headline-totals");
    expect(kinds).not.toContain("trend");
  });

  it("rejects unsafe, duplicate, and inconsistent relationship contracts", async () => {
    const table = profileTable({
      headers: [
        "Month",
        "Customers",
        "Headcount",
        "Customer ID",
        "Region Code",
        "Priority Rank",
        "Metric 1",
        "Owner",
      ],
      rows: [
        ["2026-01", "100", "12", "1", "10", "1", "20", "Alice"],
        ["2026-02", "120", "15", "2", "20", "2", "21", "Bob"],
      ],
    });
    const valid = await relationshipPlan(table);

    for (const comparison of [
      "Customers",
      "Customer ID",
      "Region Code",
      "Priority Rank",
      "Metric 1",
      "Owner",
    ]) {
      const findings = findPlanProblems(
        { ...valid, roles: { ...valid.roles, comparison } },
        table,
      );
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "roles.comparison" }),
        ]),
      );
    }

    expect(
      findPlanProblems({ ...valid, relationship: undefined }, table),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "relationship" }),
      ]),
    );
    expect(
      findPlanProblems(
        {
          ...valid,
          roles: { amount: "Customers", period: "Month" },
        },
        table,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "relationship" }),
      ]),
    );
  });

  it("constrains OpenRouter comparison roles to measures and leaks no profile values", async () => {
    const table = relationshipTable();
    const planningRequest = request(table, "Compare customers vs headcount");
    const serialized = requestMessage(planningRequest);
    expect(serialized).not.toContain("8675309");
    expect(serialized).not.toMatch(/"samples"\s*:/u);
    expect(serialized).not.toMatch(/"values"\s*:/u);
    expect(serialized).toContain("Dataset: monthly-dataset");

    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: DEFAULT_OPENROUTER_MODEL,
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
    await new OpenRouterPlanningProvider({
      apiKey: "relationship-test-key",
      fetcher,
    }).plan(planningRequest);

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: { content: string }[];
      response_format: {
        json_schema: {
          schema: {
            properties: {
              roles: { properties: Record<string, { enum?: string[] }> };
              relationship: {
                properties: { operation: { enum?: string[] } };
              };
            };
          };
        };
      };
    };
    const roles =
      body.response_format.json_schema.schema.properties.roles.properties;
    expect(roles["comparison"]?.enum).toEqual(["Customers", "Headcount"]);
    expect(
      body.response_format.json_schema.schema.properties.relationship.properties
        .operation.enum,
    ).toEqual(["compare", "ratio"]);
    expect(body.messages[1]?.content).not.toContain("8675309");
  });
});
