import { describe, expect, it } from "vitest";

import { findPlanProblems, PlanRejected } from "./plan";
import {
  FakePlanningProvider,
  type PlanningProvider,
  type PlanningRequest,
} from "./provider";
import { describePlan, runTablePlanner } from "./run";
import { TablePlanSchema, type TablePlan } from "./table-plan";
import {
  AS_OF,
  flatTable,
  quarterlyTable,
  sourceFor,
  transactionsTable,
  travelTable,
  wideTable,
} from "./test-tables";

const fake = new FakePlanningProvider();

/** Answers from a script first, then defers to the fake for revisions. */
function scripted(
  answers: readonly unknown[],
  repair = true,
): PlanningProvider & { requests: PlanningRequest[] } {
  const requests: PlanningRequest[] = [];
  return {
    id: "scripted",
    usesModel: true,
    requests,
    async plan(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next !== undefined) return next;
      return repair ? fake.plan(request) : answers.at(-1);
    },
  };
}

async function goodPlan(): Promise<TablePlan> {
  const table = transactionsTable();
  return TablePlanSchema.parse(
    await fake.plan({
      requestText: "Spend by category",
      table: { columns: table.columns, rowCount: table.rowCount },
      sourceName: "transactions.csv",
    }),
  );
}

describe("runTablePlanner", () => {
  it("accepts a good plan on the first attempt", async () => {
    const table = transactionsTable();
    const run = await runTablePlanner({
      requestText: "Spend by category",
      table,
      provider: fake,
      source: sourceFor(table, "transactions.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts).toEqual([
      { attempt: 1, findings: [], accepted: true },
    ]);
    expect(run.dashboard.pages.length).toBeGreaterThan(0);
    expect(findPlanProblems(run.plan, table)).toEqual([]);
  });

  it("sends findings back and accepts the repaired plan", async () => {
    const table = transactionsTable();
    const broken = {
      ...(await goodPlan()),
      roles: { amount: "Amt", category: "Category", period: "Date" },
    };
    const provider = scripted([broken]);
    const run = await runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "transactions.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts.map((attempt) => attempt.accepted)).toEqual([
      false,
      true,
    ]);
    expect(run.attempts[0]!.findings[0]).toMatchObject({
      code: "unknown_column",
      path: "roles.amount",
    });
    expect(provider.requests[1]!.revision).toMatchObject({
      attempt: 1,
      previousPlan: broken,
    });
    expect(provider.requests[1]!.revision!.findings).toEqual(
      run.attempts[0]!.findings,
    );
    expect(run.plan.roles.amount).toBe("Amount");
    expect(
      run.dashboard.evidence.some((item) => item.id === "composition"),
    ).toBe(true);
  });

  it("spends an attempt on malformed output and starts the next one clean", async () => {
    const table = transactionsTable();
    const provider = scripted(["not json at all"]);
    const run = await runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts[0]!.findings[0]!.code).toBe("plan_malformed");
    expect(provider.requests[1]!.revision).toBeUndefined();
    expect(run.attempts).toHaveLength(2);
  });

  it("rejects after three bad attempts with the last findings", async () => {
    const table = transactionsTable();
    const broken = { ...(await goodPlan()), title: "Total is $12,000" };
    const provider = scripted([broken], false);
    const attempt = runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
    });
    await expect(attempt).rejects.toBeInstanceOf(PlanRejected);
    await attempt.catch((error: PlanRejected) => {
      expect(error.findings[0]!.code).toBe("free_text_measurement");
    });
    expect(provider.requests).toHaveLength(3);
  });

  it("refuses a plan whose filters empty the table instead of dropping them", async () => {
    const table = flatTable();
    const empty: TablePlan = {
      ...(await goodPlan()),
      roles: { amount: "Cost", category: "Team" },
      filters: [{ column: "Team", op: "include", values: ["Nobody"] }],
      pages: [
        {
          id: "p",
          title: "P",
          description: "d",
          sections: ["summary", "by-category"],
        },
      ],
    };
    const provider = scripted([empty]);
    const run = runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
    });
    await expect(run).rejects.toBeInstanceOf(PlanRejected);
    await run.catch((error: PlanRejected) => {
      expect(error.findings[0]!.code).toBe("empty_after_filters");
      expect(error.findings[0]!.message).toContain("Nobody");
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("spends one attempt on a provider that throws and carries on", async () => {
    const table = transactionsTable();
    let calls = 0;
    const provider: PlanningProvider = {
      id: "flaky",
      usesModel: true,
      async plan(request) {
        calls += 1;
        if (calls === 1) throw new Error("429 rate limited");
        return fake.plan(request);
      },
    };
    const run = await runTablePlanner({
      requestText: "Spend by category",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts.map((attempt) => attempt.accepted)).toEqual([
      false,
      true,
    ]);
    expect(run.attempts[0]!.findings[0]).toMatchObject({
      code: "plan_malformed",
    });
    expect(run.attempts[0]!.findings[0]!.message).toContain("429");
  });

  it("rejects with findings, not the provider's error, once attempts run out", async () => {
    const table = transactionsTable();
    const failure = new Error("500 from the model");
    const provider: PlanningProvider = {
      id: "broken",
      usesModel: true,
      plan() {
        return Promise.reject(failure);
      },
    };
    const attempt = runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
    });
    await expect(attempt).rejects.toBeInstanceOf(PlanRejected);
    await attempt.catch((error: PlanRejected) => {
      expect(error.findings).toHaveLength(1);
      expect(error.cause).toBe(failure);
    });
  });

  it("hands a refinement to the provider on every attempt", async () => {
    const table = transactionsTable();
    const previous = await goodPlan();
    const provider = scripted(["garbage"]);
    const run = await runTablePlanner({
      requestText: "Spend by category",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
      refine: { previousPlan: previous, instruction: "drop the trend" },
    });
    expect(
      provider.requests.every(
        (request) => request.refinement?.instruction === "drop the trend",
      ),
    ).toBe(true);
    expect(run.plan.pages.flatMap((page) => page.sections)).not.toContain(
      "trend",
    );
  });

  it("excludes only the category the request names", async () => {
    const table = travelTable();
    const run = await runTablePlanner({
      requestText: "show spend excluding travel",
      table,
      provider: fake,
      source: sourceFor(table, "travel.csv"),
      asOf: AS_OF,
    });
    expect(run.plan.filters).toEqual([
      { column: "Category", op: "exclude", values: ["Travel"] },
    ]);
    const grid = run.dashboard.pages[0]!.components.find(
      (component) => component.kind === "metric-grid",
    )!;
    expect(grid.kind === "metric-grid" && grid.metrics[0]!.value).toBe("500");
  });

  it("filters a category the column profile's samples never showed", async () => {
    const table = travelTable();
    const run = await runTablePlanner({
      requestText: "only E",
      table,
      provider: fake,
      source: sourceFor(table, "travel.csv"),
      asOf: AS_OF,
    });
    expect(run.plan.filters).toEqual([
      { column: "Category", op: "include", values: ["E"] },
    ]);
    expect(
      table.columns.find((column) => column.name === "Category")!.samples,
    ).not.toContain("E");
  });

  it("refuses a non-positive attempt budget", async () => {
    const table = transactionsTable();
    await expect(
      runTablePlanner({
        requestText: "x",
        table,
        provider: fake,
        source: sourceFor(table, "x.csv"),
        asOf: AS_OF,
        maxAttempts: 0,
      }),
    ).rejects.toThrow(/maxAttempts/u);
  });
});

describe("describePlan", () => {
  it("names the roles the plan reads", async () => {
    const table = transactionsTable();
    const plan = await goodPlan();
    const sentence = describePlan(plan, table);
    expect(sentence).toContain("Amount");
    expect(sentence).toContain("Category");
    expect(sentence).toContain("Date");
    expect(sentence).toContain("month");
  });

  it("names the period column's own grain when it is coarser than the plan's", async () => {
    const table = quarterlyTable();
    const plan: TablePlan = {
      ...(await goodPlan()),
      roles: { amount: "Amount", period: "Quarter", category: "Category" },
      grain: "month",
    };
    expect(describePlan(plan, table)).toContain("by quarter");
  });

  it("says when the periods came from unpivoted columns", async () => {
    const table = wideTable();
    const plan = TablePlanSchema.parse(
      await fake.plan({
        requestText: "Budget",
        table: {
          columns: table.columns,
          rowCount: table.rowCount,
          unpivoted: true,
        },
        sourceName: "wide.csv",
      }),
    );
    expect(describePlan(plan, table)).toMatch(/period columns/u);
  });
});
