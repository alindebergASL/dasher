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
  sourceFor,
  transactionsTable,
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

  it("treats a plan that compiles to nothing as a rejection the provider can repair", async () => {
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
    const run = await runTablePlanner({
      requestText: "Spend",
      table,
      provider,
      source: sourceFor(table, "x.csv"),
      asOf: AS_OF,
    });
    expect(run.attempts[0]!.findings[0]!.code).toBe("empty_after_filters");
    expect(run.plan.filters).toEqual([]);
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
