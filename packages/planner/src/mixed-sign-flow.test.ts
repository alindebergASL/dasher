import { profileTable, type Table } from "@dasher/workbook";
import { describe, expect, it } from "vitest";

import { compileTablePlan, type CompileOptions } from "./compile";
import { computeFacts } from "./facts";
import type { TablePlan } from "./table-plan";
import { add, sign, ZERO, type Exact } from "./workbook";

function table(rows: string[][]): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: rows.map(([category, amount]) => [
      "2026-08-01",
      category as string,
      amount as string,
    ]),
  });
}

const plan: TablePlan = {
  planVersion: "table-plan-v1",
  title: "Flow review",
  audience: "Finance",
  framing: "Latest movement, then the categories behind it.",
  roles: { amount: "Amount", period: "Date", category: "Category" },
  flow: { operation: "gross-net" },
  grain: "month",
  filters: [],
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Latest flow and directional categories.",
      sections: ["summary", "headline-totals", "by-category"],
    },
  ],
};

function options(source: Table): CompileOptions {
  return {
    asOf: "2026-09-05T00:00:00.000Z",
    planner: { id: "deterministic-test", usesModel: false },
    source: {
      name: "flow-input",
      retrievedAt: "2026-09-05T00:00:00.000Z",
      rowCount: source.rowCount,
    },
  };
}

function sum(values: readonly Exact[]): Exact {
  return values.reduce((total, value) => add(total, value), ZERO);
}

describe("mixed-sign flow semantics", () => {
  it("does not reinterpret mixed-sign non-flow measures", () => {
    const facts = computeFacts(
      { ...plan, flow: undefined, title: "Profit variance" },
      table([
        ["North", "100"],
        ["South", "-40"],
      ]),
    );

    expect(facts).not.toHaveProperty("mixedSignFlow");
    expect(facts.latestTotal).toBe("60");
    expect(
      facts.shares.map(({ category, share, direction }) => ({
        category,
        share,
        direction,
      })),
    ).toEqual([
      { category: "North", share: "166.7", direction: undefined },
      { category: "South", share: "-66.7", direction: undefined },
    ]);
  });

  it("does not fabricate a mixed-sign decomposition for zero-only data", () => {
    const facts = computeFacts(
      plan,
      table([
        ["A", "0"],
        ["B", "0.00"],
      ]),
    );

    expect(facts).not.toHaveProperty("mixedSignFlow");
    expect(facts.latestTotal).toBe("0");
  });

  it("keeps all-positive data non-mixed with shares summing to 100", () => {
    const facts = computeFacts(
      plan,
      table([
        ["A", "1"],
        ["B", "1"],
        ["C", "1"],
      ]),
    );

    expect(facts).not.toHaveProperty("mixedSignFlow");
    expect(sum(facts.shares.map((share) => share.share))).toBe("100");
  });

  it("keeps all-negative data non-mixed with nonnegative shares summing to 100", () => {
    const facts = computeFacts(
      plan,
      table([
        ["A", "-1"],
        ["B", "-1"],
        ["C", "-1"],
      ]),
    );

    expect(facts).not.toHaveProperty("mixedSignFlow");
    expect(sum(facts.shares.map((share) => share.share))).toBe("100");
    expect(facts.shares.every((share) => sign(share.share) >= 0)).toBe(true);
  });

  it("computes exact gross inflow, gross outflow, and net movement for the latest window", () => {
    const facts = computeFacts(
      plan,
      table([
        ["Collections", "1000.25"],
        ["Refund", "-125.10"],
        ["Payroll", "-400.15"],
        ["Zero", "0"],
      ]),
    );

    expect(facts).toMatchObject({
      mixedSignFlow: {
        grossInflow: "1000.25",
        grossOutflow: "525.25",
        netMovement: "475",
      },
    });
  });

  it("allocates rounded positive and negative category groups independently to 100", () => {
    const facts = computeFacts(
      plan,
      table([
        ["In A", "1"],
        ["In A", "1"],
        ["In B", "1"],
        ["In C", "1"],
        ["Out A", "-1"],
        ["Out A", "-1"],
        ["Out B", "-1"],
        ["Out C", "-1"],
        ["Neither", "0"],
      ]),
    );
    const directional = facts.shares as ((typeof facts.shares)[number] & {
      direction?: "inflow" | "outflow";
    })[];
    const inflow = directional.filter((share) => share.direction === "inflow");
    const outflow = directional.filter(
      (share) => share.direction === "outflow",
    );

    expect(inflow.find((share) => share.category === "In A")?.total).toBe("2");
    expect(outflow.find((share) => share.category === "Out A")?.total).toBe(
      "-2",
    );
    expect(sum(inflow.map((share) => share.share))).toBe("100");
    expect(sum(outflow.map((share) => share.share))).toBe("100");
    expect(directional.every((share) => sign(share.share) >= 0)).toBe(true);
  });

  it("keeps both gross directions when categories and the net cancel to zero", () => {
    const facts = computeFacts(
      plan,
      table([
        ["Transfer", "100"],
        ["Transfer", "-100"],
      ]),
    );
    const transferShares = facts.shares.filter(
      (share) => share.category === "Transfer",
    ) as ((typeof facts.shares)[number] & {
      direction?: "inflow" | "outflow";
    })[];

    expect(facts).toMatchObject({
      latestTotal: "0",
      mixedSignFlow: {
        grossInflow: "100",
        grossOutflow: "100",
        netMovement: "0",
      },
    });
    expect(
      transferShares.map((share) => [share.direction, share.share]),
    ).toEqual([
      ["inflow", "100"],
      ["outflow", "100"],
    ]);
  });

  it("compiles a safe visible decision product with a specific outflow action", () => {
    const source = table([
      ["Collections", "600"],
      ["Sales", "300"],
      ["Other", "100"],
      ["Payroll", "-400"],
      ["Payroll", "-100"],
      ["Vendors", "-200"],
    ]);
    const spec = compileTablePlan(plan, source, options(source));
    const grid = spec.pages[0]?.components.find(
      (component) => component.kind === "metric-grid",
    );
    const ranking = spec.pages[0]?.components.find(
      (component) => component.kind === "ranking",
    );

    expect(
      grid?.kind === "metric-grid" &&
        grid.metrics.map((metric) => metric.label),
    ).toEqual(["Gross inflow", "Gross outflow", "Net movement"]);
    expect(
      ranking?.kind === "ranking" ? ranking.items.map((item) => item.note) : [],
    ).toEqual([
      "60.0% share of inflow",
      "71.4% share of outflow",
      "30.0% share of inflow",
      "28.6% share of outflow",
      "10.0% share of inflow",
    ]);
    expect(spec.executiveBrief.important.headline).toMatch(
      /inflows exceeded outflows by 300/iu,
    );
    expect(spec.nextAction.title).toMatch(/Payroll.*largest outflow/iu);
    expect(spec.nextAction.evidenceIds).toContain("calculations");

    const visible = JSON.stringify(spec);
    expect(visible).not.toMatch(/-\d+(?:\.\d+)?%/u);
    for (const match of visible.matchAll(/(\d+(?:\.\d+)?)% share of/gu)) {
      expect(Number(match[1])).toBeLessThanOrEqual(100);
    }
    expect(visible).not.toMatch(
      /\b(?:cash|burn|runway|opening cash|ending cash)\b/iu,
    );
  });

  it("labels signed non-flow contributions honestly", () => {
    const source = table([
      ["North", "100"],
      ["South", "-40"],
    ]);
    const spec = compileTablePlan(
      { ...plan, flow: undefined, title: "Profit variance" },
      source,
      options(source),
    );

    expect(spec.evidence[1]?.detail).toMatch(
      /does not classify them as directional flows/iu,
    );
    expect(spec.evidence[1]?.detail).toMatch(
      /negative shares or shares above one hundred percent/iu,
    );
  });
});
