import { profileTable } from "@dasher/workbook";
import { describe, expect, it } from "vitest";

import { add, ZERO, type Exact } from "./workbook";
import { compileTablePlan, type CompileOptions } from "./compile";
import { computeFacts } from "./facts";
import { PlanRejected } from "./plan";
import type { TablePlan } from "./table-plan";
import {
  AS_OF,
  blankCategoryTable,
  centsTable,
  flatTable,
  manyCategoriesTable,
  negativeTable,
  partialBudgetTable,
  quarterlyTable,
  sourceFor,
  transactionsTable,
  travelTable,
  wideTable,
  zeroTotalTable,
} from "./test-tables";

const ALL_SECTIONS: TablePlan["pages"] = [
  {
    id: "overview",
    title: "Overview",
    description: "All of it.",
    sections: [
      "summary",
      "headline-totals",
      "by-category",
      "trend",
      "budget-variance",
    ],
  },
  {
    id: "detail",
    title: "Detail",
    description: "Rows.",
    sections: ["movers", "largest-rows", "table"],
  },
];

const transactionsPlan: TablePlan = {
  planVersion: "table-plan-v1",
  title: "Spend",
  audience: "Finance",
  framing: "Totals, then categories.",
  roles: {
    amount: "Amount",
    period: "Date",
    category: "Category",
    label: "Description",
    account: "Account",
  },
  grain: "month",
  filters: [],
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "All of it.",
      sections: ["summary", "headline-totals", "by-category", "trend"],
    },
    {
      id: "detail",
      title: "Detail",
      description: "Rows.",
      sections: ["movers", "largest-rows", "table"],
    },
  ],
};

const widePlan: TablePlan = {
  ...transactionsPlan,
  roles: {
    amount: "amount",
    period: "period",
    category: "label",
    budget: "budget",
  },
  pages: ALL_SECTIONS,
};

function options(
  table: ReturnType<typeof transactionsTable>,
  usesModel = false,
): CompileOptions {
  return {
    asOf: AS_OF,
    planner: {
      id: usesModel ? "anthropic:test" : "fake-table-planner",
      usesModel,
    },
    source: sourceFor(table, "sample.csv"),
  };
}

/** A one-page plan over a small table. */
function planWith(
  roles: TablePlan["roles"],
  sections: TablePlan["pages"][number]["sections"],
  extra: Partial<TablePlan> = {},
): TablePlan {
  return {
    ...transactionsPlan,
    roles,
    pages: [{ id: "one", title: "One", description: "Everything.", sections }],
    ...extra,
  };
}

function componentKinds(spec: ReturnType<typeof compileTablePlan>): string[] {
  return spec.pages.flatMap((page) =>
    page.components.map((component) => component.id),
  );
}

describe("compileTablePlan", () => {
  it("compiles every section kind into a valid spec", () => {
    const table = wideTable();
    const spec = compileTablePlan(widePlan, table, options(table));
    expect(componentKinds(spec)).toEqual([
      "overview-summary",
      "overview-headline-totals",
      "overview-by-category",
      "overview-trend",
      "overview-budget-variance",
      "detail-movers",
      "detail-largest-rows",
      "detail-table",
    ]);
    expect(
      spec.pages.flatMap((page) =>
        page.components.map((component) => component.kind),
      ),
    ).toEqual([
      "summary",
      "metric-grid",
      "ranking",
      "trend-list",
      "alert-list",
      "ranking",
      "ranking",
      "table",
    ]);
    expect(spec.dataMode).toBe("live");
    expect(spec.freshness).toMatchObject({
      status: "partial",
      label: expect.stringMatching(/^Data through /u),
    });
    expect(spec.freshness.latestObservationAt).toBeUndefined();
    expect(spec.evidence.map((item) => item.id)).toEqual([
      "source-file",
      "calculations",
    ]);
    expect(spec.architecture.nodes.map((node) => node.kind)).toEqual([
      "input",
      "process",
      "process",
      "process",
      "page",
      "page",
      "output",
    ]);
  });

  it("records a planning model as interpreted evidence and an ai node", () => {
    const table = transactionsTable();
    const spec = compileTablePlan(
      transactionsPlan,
      table,
      options(table, true),
    );
    expect(spec.evidence.map((item) => [item.id, item.kind])).toEqual([
      ["source-file", "observed"],
      ["calculations", "calculated"],
      ["composition", "interpreted"],
    ]);
    expect(spec.architecture.nodes.some((node) => node.kind === "ai")).toBe(
      true,
    );
    expect(spec.nextAction.evidenceIds).toContain("composition");
  });

  it("computes exact totals, shares that sum to one hundred, and the change between periods", () => {
    const table = transactionsTable();
    const facts = computeFacts(transactionsPlan, table);
    expect(facts.skipped).toBe(0);
    expect(facts.periods).toHaveLength(8);
    expect(facts.latestPeriod).toBe("2026-08");
    expect(facts.previousPeriod).toBe("2026-07");

    const amountAt = table.columns.find(
      (column) => column.name === "Amount",
    )!.index;
    const dateAt = table.columns.find(
      (column) => column.name === "Date",
    )!.index;
    let expected: Exact = ZERO;
    for (const row of table.rows) {
      if (row[dateAt]!.startsWith("2026-08")) {
        expected = add(expected, row[amountAt]!.replace(/[$,]/gu, ""));
      }
    }
    expect(facts.latestTotal).toBe(expected);
    expect(facts.totalsByPeriod.get("2026-08")).toBe(expected);
    expect(add(facts.previousTotal!, facts.change!)).toBe(facts.latestTotal);

    const shareSum = facts.shares.reduce(
      (sum, share) => add(sum, share.share),
      ZERO,
    );
    expect(shareSum).toBe("100");
    expect(
      facts.shares.every((share) => /^\d+(?:\.\d)?$/u.test(share.share)),
    ).toBe(true);
    expect(facts.movers[0]!.change).not.toBe(ZERO);
    expect(Math.abs(Number(facts.movers[0]!.change))).toBeGreaterThanOrEqual(
      Math.abs(Number(facts.movers.at(-1)!.change)),
    );
  });

  it("does not invent a zero when a category is absent from one comparison period", () => {
    const table = profileTable({
      headers: ["Month", "Region", "Revenue"],
      rows: [
        ["2026-01", "North", "100"],
        ["2026-01", "South", "175"],
        ["2026-02", "North", "165"],
      ],
    });
    const facts = computeFacts(
      planWith({ amount: "Revenue", period: "Month", category: "Region" }, [
        "movers",
      ]),
      table,
    );

    expect(facts.movers.map((mover) => mover.category)).toEqual(["North"]);
    expect(facts.movers[0]).toMatchObject({
      previous: "100",
      latest: "165",
      change: "65",
    });
  });

  it("formats money with the detected currency and drops decimals when every amount is whole", () => {
    const transactions = transactionsTable();
    const spec = compileTablePlan(
      transactionsPlan,
      transactions,
      options(transactions),
    );
    const grid = spec.pages[0]!.components[1]!;
    expect(grid.kind === "metric-grid" && grid.metrics[0]!.value).toMatch(
      /^\$\d{1,3}(?:,\d{3})*\.\d{2}$/u,
    );

    const wide = wideTable();
    const wideSpec = compileTablePlan(widePlan, wide, options(wide));
    const wideGrid = wideSpec.pages[0]!.components[1]!;
    expect(
      wideGrid.kind === "metric-grid" && wideGrid.metrics[0]!.value,
    ).toMatch(/^\d{1,3}(?:,\d{3})*$/u);
  });

  it("applies include and exclude filters on raw cell text and a period window", () => {
    const table = transactionsTable();
    const excluded = computeFacts(
      {
        ...transactionsPlan,
        filters: [{ column: "Category", op: "exclude", values: ["marketing"] }],
      },
      table,
    );
    expect(excluded.categories).not.toContain("Marketing");
    expect(excluded.filteredOut).toBeGreaterThan(0);
    const only = computeFacts(
      {
        ...transactionsPlan,
        filters: [{ column: "Category", op: "include", values: ["Marketing"] }],
      },
      table,
    );
    expect(only.categories).toEqual(["Marketing"]);
    const windowed = computeFacts(
      { ...transactionsPlan, lastPeriods: 3 },
      table,
    );
    expect(windowed.periods).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(
      windowed.rows.every(
        (row) =>
          row.period !== undefined && windowed.periods.includes(row.period),
      ),
    ).toBe(true);
  });

  it("buckets by quarter and rolls unpivoted months up", () => {
    const facts = computeFacts({ ...widePlan, grain: "quarter" }, wideTable());
    expect(facts.periods).toEqual(["2026-Q1", "2026-Q2", "2026-Q3"]);
    expect(facts.totalsByPeriod.get("2026-Q3")).toBe(
      add(
        facts.categoryTotalsByPeriod
          .get("2026-Q3")!
          .get("Cloud infrastructure")!,
        facts.shares
          .filter((share) => share.category !== "Cloud infrastructure")
          .reduce((sum, share) => add(sum, share.total), ZERO),
      ),
    );
  });

  it("reports budget variance per line with severity by how far over", () => {
    const table = wideTable();
    const facts = computeFacts(widePlan, table);
    const cloud = facts.budget.find(
      (line) => line.name === "Cloud infrastructure",
    )!;
    expect(cloud).toMatchObject({
      amount: "49875",
      budget: "42000",
      variance: "7875",
      over: true,
    });
    expect(cloud.variancePercent).toBe("18.8");
    const spec = compileTablePlan(widePlan, table, options(table));
    const alerts = spec.pages[0]!.components.find(
      (component) => component.kind === "alert-list",
    )!;
    expect(
      alerts.kind === "alert-list" &&
        alerts.alerts.map((alert) => alert.severity),
    ).toEqual(["warning", "attention"]);
    const summary = spec.pages[0]!.components[0]!;
    expect(summary.kind === "summary" && summary.tone).toBe("attention");
    expect(spec.executiveBrief.important.headline).toContain(
      "Cloud infrastructure",
    );
  });

  it("skips sections that would be empty and skips rows whose amount cannot be read", () => {
    const table = flatTable();
    const plan: TablePlan = {
      ...transactionsPlan,
      roles: { amount: "Cost", category: "Team", label: "Item" },
      pages: [
        {
          id: "one",
          title: "One",
          description: "d",
          sections: ["summary", "by-category", "largest-rows", "table"],
        },
      ],
    };
    const facts = computeFacts(plan, table);
    expect(facts.skipped).toBe(1);
    expect(facts.rows).toHaveLength(5);
    expect(facts.latestTotal).toBe("3500");
    expect(facts.shares.map((share) => [share.category, share.share])).toEqual([
      ["Eng", "85.7"],
      ["Ops", "12"],
      ["Sales", "2.3"],
    ]);
    const spec = compileTablePlan(plan, table, options(table));
    expect(
      spec.pages[0]!.components.map((component) => component.kind),
    ).toEqual(["summary", "ranking", "ranking", "table"]);
    expect(spec.notice).toContain("1 row was skipped");
    expect(spec.executiveBrief.changed.headline).toMatch(/no prior period/iu);
  });

  it("rejects a plan that leaves no rows or no sections", () => {
    const table = transactionsTable();
    expect(() =>
      compileTablePlan(
        {
          ...transactionsPlan,
          filters: [{ column: "Category", op: "include", values: ["Nothing"] }],
        },
        table,
        options(table),
      ),
    ).toThrow(PlanRejected);
    const flat = flatTable();
    let caught: unknown;
    try {
      compileTablePlan(
        {
          ...transactionsPlan,
          roles: { amount: "Cost", category: "Team" },
          pages: [
            { id: "p", title: "P", description: "d", sections: ["movers"] },
          ],
        },
        flat,
        options(flat),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanRejected);
    expect((caught as PlanRejected).findings[0]!.code).toBe("empty_sections");
  });

  it("limits the table component to fifty rows and role columns first", () => {
    const table = transactionsTable();
    const spec = compileTablePlan(transactionsPlan, table, options(table));
    const rows = spec.pages[1]!.components.find(
      (component) => component.kind === "table",
    )!;
    expect(rows.kind === "table" && rows.rows).toHaveLength(50);
    expect(rows.kind === "table" && rows.columns.slice(0, 2)).toEqual([
      "Date",
      "Description",
    ]);
  });

  it("charges every row in the period against the budget its line states", () => {
    const table = partialBudgetTable();
    const plan = planWith(
      {
        amount: "Amount",
        period: "Date",
        category: "Category",
        budget: "Budget",
      },
      ["summary", "budget-variance"],
    );
    const facts = computeFacts(plan, table);
    expect(facts.budget.find((line) => line.name === "Eng")).toMatchObject({
      amount: "2700",
      budget: "1200",
      variance: "1500",
      over: true,
    });
    expect(facts.budget.find((line) => line.name === "Ops")).toMatchObject({
      amount: "100",
      budget: "500",
      variance: "-400",
      over: false,
    });
    const spec = compileTablePlan(plan, table, options(table));
    const summary = spec.pages[0]!.components[0]!;
    expect(
      summary.kind === "summary" &&
        summary.claims.some((claim) =>
          claim.text.includes("1 of 2 budgeted lines is over budget"),
        ),
    ).toBe(true);
    const alerts = spec.pages[0]!.components[1]!;
    expect(alerts.kind === "alert-list" && alerts.alerts[0]!.title).toContain(
      "Eng over budget by 1,500",
    );
  });

  it("ranks categories by size when every amount is negative", () => {
    const table = negativeTable();
    const plan = planWith(
      { amount: "Amount", period: "Date", category: "Category" },
      ["summary", "headline-totals", "by-category"],
    );
    const facts = computeFacts(plan, table);
    expect(facts.shares.map((share) => share.category)).toEqual([
      "Payroll",
      "Rent",
      "Coffee",
    ]);
    expect(facts.shares[0]!.share).toBe("95.2");
    const spec = compileTablePlan(plan, table, options(table));
    const summary = spec.pages[0]!.components[0]!;
    expect(
      summary.kind === "summary" &&
        summary.claims.some((claim) =>
          claim.text.startsWith("Payroll is the largest category"),
        ),
    ).toBe(true);
    const ranking = spec.pages[0]!.components[2]!;
    expect(
      ranking.kind === "ranking" && ranking.items.map((item) => item.label),
    ).toEqual(["Payroll", "Rent", "Coffee"]);
    expect(spec.executiveBrief.important.headline).toContain("Payroll");
  });

  it("adopts the period column's grain when it is coarser than the plan's", () => {
    const table = quarterlyTable();
    const plan = planWith(
      { amount: "Amount", period: "Quarter", category: "Category" },
      ["summary", "trend"],
    );
    expect(plan.grain).toBe("month");
    const facts = computeFacts(plan, table);
    expect(facts.grain).toBe("quarter");
    expect(facts.periods).toEqual(["2026-Q1", "2026-Q2"]);
    const spec = compileTablePlan(plan, table, options(table));
    expect(spec.notice).toContain("by quarter");
    expect(spec.notice).not.toContain("by month");
    expect(spec.evidence[1]!.detail).toContain("grouped by quarter");
    const trend = spec.pages[0]!.components[1]!;
    expect(trend.title).toBe("Trend by quarter");
  });

  it("says how the shares were computed and what the ranking left out", () => {
    const transactions = transactionsTable();
    expect(
      compileTablePlan(transactionsPlan, transactions, options(transactions))
        .evidence[1]!.detail,
    ).toContain("sum to exactly one hundred");

    const negatives = negativeTable();
    const negativeDetail = compileTablePlan(
      planWith({ amount: "Amount", period: "Date", category: "Category" }, [
        "summary",
        "by-category",
      ]),
      negatives,
      options(negatives),
    ).evidence[1]!.detail;
    expect(negativeDetail).not.toContain("sum to exactly one hundred");
    expect(negativeDetail).toContain("need not sum to one hundred");

    const zero = zeroTotalTable();
    expect(
      compileTablePlan(
        planWith({ amount: "Amount", period: "Date", category: "Category" }, [
          "summary",
          "by-category",
        ]),
        zero,
        options(zero),
      ).evidence[1]!.detail,
    ).toContain("the total for Jan 2026 is zero");

    const many = manyCategoriesTable(137);
    const spec = compileTablePlan(
      planWith({ amount: "Amount", period: "Date", category: "Category" }, [
        "by-category",
      ]),
      many,
      options(many),
    );
    expect(spec.evidence[1]!.detail).toContain("37 more");
    const ranking = spec.pages[0]!.components[0]!;
    expect(ranking.kind === "ranking" && ranking.items).toHaveLength(100);
    expect(ranking.title).toContain("137");
  });

  it("rounds trend points to the money scale the rest of the page uses", () => {
    const table = centsTable();
    const plan = planWith(
      { amount: "Amount", period: "Date", category: "Category" },
      ["headline-totals", "trend"],
    );
    const spec = compileTablePlan(plan, table, options(table));
    const grid = spec.pages[0]!.components[0]!;
    expect(grid.kind === "metric-grid" && grid.metrics[0]!.value).toBe(
      "$10.01",
    );
    const trend = spec.pages[0]!.components[1]!;
    expect(
      trend.kind === "trend-list" && trend.series[0]!.points.at(-1)!.value,
    ).toBe(10.01);
    expect(trend.kind === "trend-list" && trend.series[0]!.unit).toBe("USD");
  });

  it("counts rows outside the period window apart from filtered rows", () => {
    const table = transactionsTable();
    const plan: TablePlan = { ...transactionsPlan, lastPeriods: 3 };
    const facts = computeFacts(plan, table);
    expect(facts.filteredOut).toBe(0);
    expect(facts.outsideWindow).toBeGreaterThan(0);
    const detail = compileTablePlan(plan, table, options(table)).evidence[1]!
      .detail;
    expect(detail).toContain("0 rows were left out by the plan's filters");
    expect(detail).toContain(
      `${String(facts.outsideWindow)} rows fell outside the last 3 periods`,
    );
  });

  it("filters a blank category by the name the dashboard shows for it", () => {
    const table = blankCategoryTable();
    const plan = planWith(
      { amount: "Amount", period: "Date", category: "Category" },
      ["summary", "by-category"],
      { filters: [{ column: "Category", op: "exclude", values: ["(blank)"] }] },
    );
    const facts = computeFacts(plan, table);
    expect(facts.categories).toEqual(["Ops"]);
    expect(facts.filteredOut).toBe(2);
    expect(facts.latestTotal).toBe("160");
  });

  it("names what emptied the table when a filter leaves no rows", () => {
    const table = travelTable();
    let caught: unknown;
    try {
      compileTablePlan(
        planWith({ amount: "Amount", period: "Date", category: "Category" }, [
          "summary",
        ]),
        table,
        options(table),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
    try {
      compileTablePlan(
        planWith(
          { amount: "Amount", period: "Date", category: "Category" },
          ["summary"],
          {
            filters: [
              { column: "Category", op: "exclude", values: ["Travel"] },
              { column: "Category", op: "include", values: ["Travel"] },
            ],
          },
        ),
        table,
        options(table),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanRejected);
    const findings = (caught as PlanRejected).findings;
    expect(findings[0]!.code).toBe("empty_after_filters");
    expect(findings[0]!.message).toContain("Travel");
    expect(findings[0]!.message).toContain("Category");
  });
});
