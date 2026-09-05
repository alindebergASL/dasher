import { describe, expect, it } from "vitest";

import { readFilters } from "./fake-heuristics";
import { findPlanProblems } from "./plan";
import { FakePlanningProvider, type PlanningRequest } from "./provider";
import { TablePlanSchema, type TablePlan } from "./table-plan";
import {
  columnNamed,
  flatTable,
  transactionsTable,
  travelTable,
  wideTable,
} from "./test-tables";
import type { Table } from "./workbook";

const provider = new FakePlanningProvider();

function request(
  table: Table,
  requestText: string,
  extra: Partial<PlanningRequest> = {},
): PlanningRequest {
  return {
    requestText,
    table: {
      columns: table.columns,
      rowCount: table.rowCount,
      ...(table.unpivoted === undefined ? {} : { unpivoted: true }),
    },
    sourceName: "sample.csv",
    ...extra,
  };
}

async function planFor(
  table: Table,
  text: string,
  extra: Partial<PlanningRequest> = {},
): Promise<TablePlan> {
  const plan = TablePlanSchema.parse(
    await provider.plan(request(table, text, extra)),
  );
  expect(findPlanProblems(plan, table)).toEqual([]);
  return plan;
}

function sections(plan: TablePlan): string[] {
  return plan.pages.flatMap((page) => page.sections);
}

describe("FakePlanningProvider roles", () => {
  it("identifies itself as deterministic", () => {
    expect(provider.id).toBe("fake-table-planner");
    expect(provider.usesModel).toBe(false);
  });

  it("picks amount, date, category and label from a transactions table", async () => {
    const plan = await planFor(
      transactionsTable(),
      "Show me spend by category",
    );
    expect(plan.roles).toEqual({
      amount: "Amount",
      period: "Date",
      category: "Category",
      label: "Description",
    });
    expect(plan.grain).toBe("month");
    expect(plan.filters).toEqual([]);
    expect(plan.lastPeriods).toBeUndefined();
  });

  it("picks the unpivoted period and budget columns and a readable category from a wide table", async () => {
    const plan = await planFor(wideTable(), "How are we doing against budget?");
    expect(plan.roles.amount).toBe("amount");
    expect(plan.roles.period).toBe("period");
    expect(plan.roles.budget).toBe("budget");
    expect(plan.roles.category).toBe("label");
    expect(sections(plan)[0]).toBe("budget-variance");
  });

  it("falls back to the number column with most values and a modest-cardinality text column", async () => {
    const plan = await planFor(flatTable(), "What did each team spend?");
    expect(plan.roles.amount).toBe("Cost");
    expect(plan.roles.category).toBe("Team");
    expect(plan.roles.label).toBe("Item");
    expect(plan.roles.period).toBeUndefined();
    expect(sections(plan)).not.toContain("trend");
    expect(sections(plan)).not.toContain("movers");
  });
});

describe("FakePlanningProvider request phrases", () => {
  it("uses explicit cash-flow wording without changing generic category copy", async () => {
    const cashFlow = await planFor(
      transactionsTable(),
      "Analyze operating cash flow by category",
    );
    expect(cashFlow.title).toBe("Cash flow by Category");
    expect(cashFlow.pages[0]?.description).toBe(
      "Gross inflow, gross outflow, net movement, and the directional breakdown by Category.",
    );
    expect(cashFlow.framing).toBe(
      "Cash flow first, then the breakdown by Category and the rows behind it.",
    );
    expect(cashFlow.flow).toEqual({ operation: "gross-net" });
    expect(sections(cashFlow)).not.toContain("summary");

    for (const phrase of [
      "Analyze cash flows by category",
      "Show inflows and outflows",
      "Review outflows versus inflows",
      "Analyze cash movement",
      "Review signed flows",
    ]) {
      expect((await planFor(transactionsTable(), phrase)).flow).toEqual({
        operation: "gross-net",
      });
    }

    const generic = await planFor(
      transactionsTable(),
      "Analyze amount by category",
    );
    expect(generic.title).toBe("Amount by Category");
    expect(generic.pages[0]?.description).toBe(
      "Latest Amount, its change from the prior period, and the breakdown by Category.",
    );
    expect(generic.framing).toBe(
      "Amount first, then the breakdown by Category and the rows behind it.",
    );
    expect(generic.flow).toBeUndefined();
  });

  it("reads filters from exclude and only phrases matching category samples", async () => {
    const excluded = await planFor(
      transactionsTable(),
      "Spend by category, excluding Marketing",
    );
    expect(excluded.filters).toEqual([
      { column: "Category", op: "exclude", values: ["Marketing"] },
    ]);
    const only = await planFor(
      transactionsTable(),
      "Only cloud infrastructure, over time",
    );
    expect(only.filters).toEqual([
      { column: "Category", op: "include", values: ["Cloud infrastructure"] },
    ]);
    expect(sections(only)[0]).toBe("trend");
  });

  it("reads grain and a period window", async () => {
    const quarterly = await planFor(transactionsTable(), "Quarterly totals");
    expect(quarterly.grain).toBe("quarter");
    const last = await planFor(
      transactionsTable(),
      "Spend over the last 3 months",
    );
    expect(last.lastPeriods).toBe(3);
    expect(last.grain).toBe("month");
    const years = await planFor(transactionsTable(), "the last two years");
    expect(years).toMatchObject({ lastPeriods: 2, grain: "year" });
  });

  it("leads with the largest rows when asked for the biggest items", async () => {
    const plan = await planFor(
      transactionsTable(),
      "What are the biggest transactions?",
    );
    expect(sections(plan)[0]).toBe("largest-rows");
    expect(
      sections(plan).filter((section) => section === "largest-rows"),
    ).toHaveLength(1);
  });
});

describe("FakePlanningProvider refinement", () => {
  it("drops a named section and leaves the rest", async () => {
    const previous = await planFor(transactionsTable(), "Spend by category");
    const refined = await planFor(transactionsTable(), "Spend by category", {
      refinement: { previousPlan: previous, instruction: "drop the trend" },
    });
    expect(sections(refined)).toEqual(
      sections(previous).filter((section) => section !== "trend"),
    );
    expect(refined.roles).toEqual(previous.roles);
    expect(refined.pages.map((page) => page.id)).toEqual(
      previous.pages.map((page) => page.id),
    );
  });

  it("adds a section, changes grain, filters, and window", async () => {
    const previous = await planFor(flatTable(), "Team spend");
    const added = await planFor(flatTable(), "Team spend", {
      refinement: {
        previousPlan: previous,
        instruction: "add the largest rows",
      },
    });
    expect(sections(added)).toContain("largest-rows");

    const base = await planFor(transactionsTable(), "Spend");
    const quarterly = await planFor(transactionsTable(), "Spend", {
      refinement: { previousPlan: base, instruction: "make it quarterly" },
    });
    expect(quarterly.grain).toBe("quarter");
    const filtered = await planFor(transactionsTable(), "Spend", {
      refinement: { previousPlan: base, instruction: "without Marketing" },
    });
    expect(filtered.filters).toEqual([
      { column: "Category", op: "exclude", values: ["Marketing"] },
    ]);
    const windowed = await planFor(transactionsTable(), "Spend", {
      refinement: { previousPlan: base, instruction: "just the last 6 months" },
    });
    expect(windowed.lastPeriods).toBe(6);
  });

  it("filters a category the reader names instead of dropping the section", async () => {
    const table = travelTable();
    const previous = await planFor(table, "Spend by category");
    const refined = await planFor(table, "Spend by category", {
      refinement: {
        previousPlan: previous,
        instruction: "drop the travel category",
      },
    });
    expect(sections(refined)).toContain("by-category");
    expect(refined.filters).toEqual([
      { column: "Category", op: "exclude", values: ["Travel"] },
    ]);
  });

  it("shortens to one page and returns an unknown instruction unchanged", async () => {
    const previous = await planFor(transactionsTable(), "Spend");
    expect(previous.pages).toHaveLength(2);
    const short = await planFor(transactionsTable(), "Spend", {
      refinement: {
        previousPlan: previous,
        instruction: "just the overview please",
      },
    });
    expect(short.pages).toHaveLength(1);
    const same = await provider.plan(
      request(transactionsTable(), "Spend", {
        refinement: { previousPlan: previous, instruction: "make it purple" },
      }),
    );
    expect(same).toBe(previous);
  });
});

describe("FakePlanningProvider revision", () => {
  it("repairs an unknown column by re-picking the role", async () => {
    const table = transactionsTable();
    const broken: TablePlan = {
      ...(await planFor(table, "Spend")),
      roles: { amount: "Amt", category: "Dept", period: "Date" },
      filters: [{ column: "Nope", op: "exclude", values: ["x"] }],
    };
    const findings = findPlanProblems(broken, table);
    expect(findings.map((finding) => finding.code)).toEqual([
      "unknown_column",
      "unknown_column",
      "unknown_column",
    ]);
    const repaired = await planFor(table, "Spend", {
      revision: { attempt: 1, previousPlan: broken, findings },
    });
    expect(repaired.roles.amount).toBe("Amount");
    expect(repaired.roles.category).toBe("Category");
    expect(repaired.filters).toEqual([]);
  });

  it("drops a section its roles cannot support and neutralises smuggled text", async () => {
    const table = flatTable();
    const broken: TablePlan = {
      ...(await planFor(table, "Spend")),
      title: "Ops spent $420.75",
      pages: [
        {
          id: "p",
          title: "P",
          description: "d",
          sections: ["summary", "trend"],
        },
      ],
    };
    const findings = findPlanProblems(broken, table);
    const repaired = await planFor(table, "Spend", {
      revision: { attempt: 1, previousPlan: broken, findings },
    });
    expect(repaired.pages[0]!.sections).toEqual(["summary"]);
    expect(repaired.title).not.toContain("$");
  });
});

describe("readFilters", () => {
  const category = () => columnNamed(travelTable(), "Category");

  it("matches a value as a whole word, never as a substring of one", () => {
    expect(readFilters("spend excluding travel", category())).toEqual([
      { column: "Category", op: "exclude", values: ["Travel"] },
    ]);
    expect(readFilters("only marketing", category())).toEqual([
      { column: "Category", op: "include", values: ["Marketing"] },
    ]);
  });

  it("emits no filter for a value the profile does not list", () => {
    expect(readFilters("only E", category())).toEqual([]);
    expect(readFilters("excluding stationery", category())).toEqual([]);
  });

  it("filters a value beyond the samples once the values are listed", () => {
    const table = travelTable();
    const values = table.rows.map((row) => row[1] as string);
    expect(
      readFilters("only E", columnNamed(table, "Category"), values),
    ).toEqual([{ column: "Category", op: "include", values: ["E"] }]);
  });

  it("never turns a time window into a category filter", () => {
    expect(readFilters("just the last 2 quarters", category())).toEqual([]);
    expect(readFilters("only the last 3 months", category())).toEqual([]);
  });
});
