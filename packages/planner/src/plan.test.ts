import { describe, expect, it } from "vitest";

import { matchValues } from "./fake-heuristics";
import { findMeasurement, findPlanProblems, PlanRejected } from "./plan";
import type { TablePlan } from "./table-plan";
import { flatTable, transactionsTable, wideTable } from "./test-tables";

const base: TablePlan = {
  planVersion: "table-plan-v1",
  title: "Spend",
  audience: "Finance",
  framing: "Totals, then categories.",
  roles: {
    amount: "Amount",
    period: "Date",
    category: "Category",
    label: "Description",
  },
  grain: "month",
  filters: [],
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "The whole file.",
      sections: ["summary", "trend"],
    },
    {
      id: "detail",
      title: "Detail",
      description: "Rows.",
      sections: ["movers", "table"],
    },
  ],
};

function codes(plan: TablePlan, table = transactionsTable()): string[] {
  return findPlanProblems(plan, table).map(
    (finding) => `${finding.code}@${finding.path}`,
  );
}

describe("findPlanProblems", () => {
  it("accepts a plan whose roles and sections fit the table", () => {
    expect(codes(base)).toEqual([]);
  });

  it("reports a role or filter naming a column the table lacks", () => {
    expect(
      codes({
        ...base,
        roles: { ...base.roles, category: "Dept" },
        filters: [{ column: "Vendor", op: "exclude", values: ["x"] }],
      }),
    ).toEqual([
      "unknown_column@roles.category",
      "unknown_column@filters[0].column",
    ]);
  });

  it("requires number columns for amount and budget and a date or period column for period", () => {
    expect(
      codes({
        ...base,
        roles: { ...base.roles, amount: "Description", budget: "Category" },
      }),
    ).toEqual(
      expect.arrayContaining([
        "role_type@roles.amount",
        "role_type@roles.budget",
      ]),
    );
    expect(
      codes({ ...base, roles: { ...base.roles, period: "Account" } }),
    ).toContain("role_type@roles.period");
  });

  it("accepts the unpivoted period column as a period", () => {
    const wide = wideTable();
    const plan: TablePlan = {
      ...base,
      roles: {
        amount: "amount",
        period: "period",
        category: "label",
        budget: "budget",
      },
      pages: [
        {
          id: "p",
          title: "P",
          description: "d",
          sections: ["summary", "trend", "budget-variance"],
        },
      ],
    };
    expect(codes(plan, wide)).toEqual([]);
  });

  it("reports sections whose roles are missing", () => {
    const plan: TablePlan = { ...base, roles: { amount: "Amount" } };
    expect(codes(plan)).toEqual([
      "section_needs_role@pages[0].sections[1]",
      "section_needs_role@pages[1].sections[0]",
      "section_needs_role@pages[1].sections[0]",
    ]);
    expect(
      codes({
        ...base,
        pages: [{ ...base.pages[0]!, sections: ["budget-variance"] }],
      }),
    ).toEqual(["section_needs_role@pages[0].sections[0]"]);
  });

  it("checks the type of every role, not only the numeric ones", () => {
    expect(
      codes({
        ...base,
        roles: { ...base.roles, category: "Amount", label: "Date" },
      }),
    ).toEqual(
      expect.arrayContaining([
        "role_type@roles.category",
        "role_type@roles.label",
      ]),
    );
  });

  it("reports duplicate sections and page ids", () => {
    const plan: TablePlan = {
      ...base,
      pages: [
        {
          id: "same",
          title: "A",
          description: "a",
          sections: ["summary", "table"],
        },
        { id: "same", title: "B", description: "b", sections: ["table"] },
      ],
    };
    expect(codes(plan)).toEqual([
      "duplicate_page_id@pages[1].id",
      "duplicate_section@pages[1].sections[0]",
    ]);
  });

  it("reports figures in free text but allows years and time windows", () => {
    expect(codes({ ...base, title: "Spend was $49,875 in August" })).toEqual([
      "free_text_measurement@title",
    ]);
    expect(codes({ ...base, framing: "Cloud took 12% of spend" })).toEqual([
      "free_text_measurement@framing",
    ]);
    expect(
      codes({
        ...base,
        pages: [{ ...base.pages[0]!, description: "Up 1.5 on last month" }],
      }),
    ).toEqual(["free_text_measurement@pages[0].description"]);
    expect(
      codes({
        ...base,
        title: "Spend, last 12 months",
        framing: "Operating spend for 2026 by month",
      }),
    ).toEqual([]);
  });

  it("reports plain integers, magnitudes and spelled-out figures", () => {
    expect(
      codes({
        ...base,
        title: "Q3: we spent 89000, up twenty percent",
        framing: "Half the budget is gone",
      }),
    ).toEqual(["free_text_measurement@title", "free_text_measurement@framing"]);
  });

  it("works on a table without a period column", () => {
    const plan: TablePlan = {
      ...base,
      roles: { amount: "Cost", category: "Team", label: "Item" },
      pages: [
        {
          id: "p",
          title: "P",
          description: "d",
          sections: ["summary", "by-category", "table"],
        },
      ],
    };
    expect(codes(plan, flatTable())).toEqual([]);
  });
});

describe("findMeasurement", () => {
  it.each([
    ["$1,200", "$1,200"],
    ["up 3.5 points", "3.5"],
    ["about 40 percent", "40 percent"],
    ["12,000 USD", "12,000 USD"],
  ])("finds %s", (text, excerpt) => {
    expect(findMeasurement(text)).toBe(excerpt);
  });

  it.each([
    "we spent 89000",
    "50k of runway left",
    "1.2m in the bank",
    "3bn under management",
    "up twenty percent",
    "three million in claims",
    "Half the budget is gone",
    "double the spend of last year",
    "500 dollars a seat",
  ])("finds a figure in %s", (text) => {
    expect(findMeasurement(text)).toBeDefined();
  });

  it.each([
    "last 12 months",
    "the last 3 months",
    "last 24 hours",
    "FY2026 overview",
    "Q3 2026 by team",
    "2026 operating spend",
    "top 5 vendors",
    "the first 10 rows",
    "version two",
    "Totals for the latest period and the one before",
  ])("allows %s", (text) => {
    expect(findMeasurement(text)).toBeUndefined();
  });
});

it("PlanRejected carries its findings and a readable message", () => {
  const error = new PlanRejected([
    {
      code: "unknown_column",
      path: "roles.amount",
      message: "No such column.",
    },
  ]);
  expect(error.findings).toHaveLength(1);
  expect(error.message).toContain("roles.amount");
  expect(error.name).toBe("PlanRejected");
});

describe("a filter phrase containing a joining word", () => {
  // "Salaries and benefits", "Travel and events", "Research and development":
  // stopping the phrase at "and" reads the first word only, matches no
  // category, and silently does nothing while reporting success.
  it("matches a category value whose own name contains 'and'", () => {
    expect(
      matchValues("salaries and benefits", [
        "Salaries and benefits",
        "Marketing",
      ]),
    ).toEqual(["Salaries and benefits"]);
  });

  it("still matches a single category named before a joining word", () => {
    expect(
      matchValues("travel for the quarter", ["Travel", "Marketing"]),
    ).toEqual(["Travel"]);
  });

  it("matches each category an instruction names", () => {
    expect(
      matchValues("travel and marketing", ["Travel", "Marketing", "Rent"]),
    ).toEqual(["Travel", "Marketing"]);
  });

  it("does not match a category the instruction merely contains letters of", () => {
    expect(matchValues("travel", ["A", "E", "Travel"])).toEqual(["Travel"]);
  });
});
