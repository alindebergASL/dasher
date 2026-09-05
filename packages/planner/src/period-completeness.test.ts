import { profileTable, type Table } from "@dasher/workbook";
import { describe, expect, it } from "vitest";

import { compileTablePlan, type CompileOptions } from "./compile";
import { computeFacts } from "./facts";
import type { PlanningProvider } from "./provider";
import { runTablePlanner } from "./run";
import type { TablePlan, TableSectionKind } from "./table-plan";

const AS_OF = "2026-09-05T12:00:00.000Z";

function options(table: Table, usesModel = false): CompileOptions {
  return {
    asOf: AS_OF,
    planner: {
      id: usesModel ? "model:test" : "deterministic-test-planner",
      usesModel,
    },
    source: {
      name: "canonical table",
      retrievedAt: AS_OF,
      rowCount: table.rowCount,
    },
  };
}

function plan(
  grain: TablePlan["grain"],
  sections: readonly TableSectionKind[] = [
    "summary",
    "headline-totals",
    "by-category",
    "movers",
    "trend",
  ],
): TablePlan {
  return {
    planVersion: "table-plan-v1",
    title: "Period safety",
    audience: "Operators",
    framing: "Current performance with safe comparisons.",
    roles: { amount: "Amount", period: "Date", category: "Category" },
    grain,
    filters: [],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Period-aware results.",
        sections: [...sections],
      },
    ],
  };
}

function table(rows: readonly (readonly string[])[]): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows,
  });
}

function relationshipTable(rows: readonly (readonly string[])[]): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount", "Comparison"],
    rows,
  });
}

function relationshipPlan(grain: TablePlan["grain"]): TablePlan {
  return {
    ...plan(grain, [
      "summary",
      "headline-totals",
      "movers",
      "trend",
      "relationship",
    ]),
    roles: {
      amount: "Amount",
      comparison: "Comparison",
      period: "Date",
      category: "Category",
    },
    relationship: { operation: "ratio" },
  };
}

function monthlyRows(
  includeSeptember: boolean,
): readonly (readonly string[])[] {
  const months = [
    "2026-04-01",
    "2026-05-01",
    "2026-06-01",
    "2026-07-01",
    "2026-08-01",
    ...(includeSeptember ? ["2026-09-01"] : []),
  ];
  return months.flatMap((date, index) => [
    [date, "Alpha", index < 3 ? "300" : "100"],
    [date, "Beta", index < 3 ? "100" : "50"],
  ]);
}

function isoDays(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function componentText(spec: ReturnType<typeof compileTablePlan>): string {
  return JSON.stringify({
    brief: spec.executiveBrief,
    pages: spec.pages,
    freshness: spec.freshness,
  });
}

describe("period completeness safety", () => {
  it("marks July-August Q3 partial against complete Q2 and suppresses unlike-for-like deltas and movers", () => {
    const source = table(monthlyRows(false));
    const facts = computeFacts(plan("quarter"), source);

    expect(facts.periodCoverage).toEqual({
      status: "incomplete",
      latestPeriod: "2026-Q3",
      latestLabel: "Q3 2026",
      observedStart: "2026-07-01",
      observedEnd: "2026-08-01",
      expectedStart: "2026-07-01",
      expectedEnd: "2026-09-30",
      observationGrain: "month",
      observedCount: 2,
      expectedCount: 3,
      priorPeriod: "2026-Q2",
      priorObservedCount: 3,
      comparisonDisposition: "unavailable-partial",
      reason:
        "Q3 2026 has 2 of 3 expected monthly observations; observed dates run from 2026-07-01 through 2026-08-01, inside expected bounds 2026-07-01 through 2026-09-30. Q2 2026 has all 3 expected observations. Current-vs-prior change is unavailable because the latest period is partial.",
    });
    expect(facts.change).toBeUndefined();
    expect(facts.changePercent).toBeUndefined();
    expect(facts.movers).toEqual([]);

    const planned = plan("quarter");
    const stalePlan: TablePlan = {
      ...planned,
      pages: planned.pages.map((page) => ({
        ...page,
        description:
          "Latest Amount, its change from the prior period, and the breakdown by Category.",
      })),
    };
    const spec = compileTablePlan(stalePlan, source, options(source, true));
    const rendered = componentText(spec);
    expect(rendered).toContain("Q3 2026 (partial)");
    expect(rendered).toContain(
      "Current-vs-prior change is unavailable because the latest period is partial.",
    );
    expect
      .soft(spec.pages[0]?.description)
      .toBe(
        "Q3 2026 coverage is partial (2 of 3 expected monthly observations). Comparative findings are withheld.",
      );
    expect.soft(spec.executiveBrief.important).toMatchObject({
      headline: "Q3 2026 is partial; current-vs-prior change is unavailable",
      detail:
        "Q3 2026 has 2 of 3 expected monthly observations; Q2 2026 is complete with 3 monthly observations. The periods are not like-for-like, so current-vs-prior change is unavailable.",
      evidenceIds: ["period-coverage"],
    });
    expect.soft(spec.nextAction).toMatchObject({
      title: "Complete or confirm Q3 2026 coverage before comparison",
      detail:
        "Confirm or complete the 1 missing monthly observation for Q3 2026 shown in the linked period evidence, then rebuild before comparing with Q2 2026.",
      evidenceIds: expect.arrayContaining(["period-coverage"]),
    });
    expect.soft(spec.executiveBrief.important.headline).not.toContain("Alpha");
    expect.soft(spec.nextAction.title).not.toBe("Open the evidence");
    expect(rendered).not.toContain("Change vs prior period");
    expect(
      spec.pages
        .flatMap((page) => page.components)
        .some((one) => one.id.endsWith("-movers")),
    ).toBe(false);
    expect(
      spec.pages
        .flatMap((page) => page.components)
        .some((one) => one.kind === "trend-list"),
    ).toBe(false);
    expect(
      spec.pages
        .flatMap((page) => page.components)
        .some((one) => one.id.endsWith("-summary")),
    ).toBe(false);
    expect(spec.evidence.find((item) => item.id === "period-coverage")).toEqual(
      expect.objectContaining({
        kind: "calculated",
        label: "Period coverage for Q3 2026",
        detail:
          "Period coverage was assessed from canonical dataset values. Latest analysis period: Q3 2026. Observed date range: 2026-07-01 through 2026-08-01. Expected quarter bounds: 2026-07-01 through 2026-09-30. Observed coverage: 2 of 3 monthly observations. Comparison disposition: unavailable — partial latest period. Reason: Q3 2026 has 2 of 3 expected monthly observations; observed dates run from 2026-07-01 through 2026-08-01, inside expected bounds 2026-07-01 through 2026-09-30. Q2 2026 has all 3 expected observations. Current-vs-prior change is unavailable because the latest period is partial.",
      }),
    );
  });

  it("leaves a fully observed latest quarter comparable", () => {
    const source = table(monthlyRows(true));
    const facts = computeFacts(plan("quarter"), source);

    expect(facts.periodCoverage).toMatchObject({
      status: "complete",
      latestPeriod: "2026-Q3",
      observedStart: "2026-07-01",
      observedEnd: "2026-09-01",
      observationGrain: "month",
      observedCount: 3,
      expectedCount: 3,
      priorObservedCount: 3,
      comparisonDisposition: "available",
    });
    expect(facts.change).toBeDefined();
    expect(facts.movers.length).toBeGreaterThan(0);

    const spec = compileTablePlan(plan("quarter"), source, options(source));
    expect(componentText(spec)).not.toContain("(partial)");
    expect(
      spec.pages
        .flatMap((page) => page.components)
        .some((one) => one.id.endsWith("-movers")),
    ).toBe(true);
    expect(
      spec.pages
        .flatMap((page) => page.components)
        .some((one) => one.kind === "trend-list"),
    ).toBe(true);
  });

  it("detects daily coverage at a month boundary", () => {
    const rows = isoDays("2026-02-01", "2026-03-15").map((date) => [
      date,
      "All",
      "1",
    ]);
    const facts = computeFacts(plan("month"), table(rows));

    expect(facts.periodCoverage).toMatchObject({
      status: "incomplete",
      latestPeriod: "2026-03",
      expectedStart: "2026-03-01",
      expectedEnd: "2026-03-31",
      observationGrain: "day",
      observedCount: 15,
      expectedCount: 31,
      priorObservedCount: 28,
      comparisonDisposition: "unavailable-partial",
    });
    expect(facts.change).toBeUndefined();
  });

  it("detects quarterly coverage at a year boundary", () => {
    const rows = [
      "2025-01-01",
      "2025-04-01",
      "2025-07-01",
      "2025-10-01",
      "2026-01-01",
      "2026-04-01",
      "2026-07-01",
    ].map((date) => [date, "All", "10"]);
    const facts = computeFacts(plan("year"), table(rows));

    expect(facts.periodCoverage).toMatchObject({
      status: "incomplete",
      latestPeriod: "2026",
      expectedStart: "2026-01-01",
      expectedEnd: "2026-12-31",
      observationGrain: "quarter",
      observedCount: 3,
      expectedCount: 4,
      priorObservedCount: 4,
      comparisonDisposition: "unavailable-partial",
    });
  });

  it("recognizes complete monthly and yearly period series", () => {
    const monthly = table([
      ["2026-01-01", "All", "10"],
      ["2026-02-01", "All", "20"],
    ]);
    const yearly = table([
      ["2025-01-01", "All", "10"],
      ["2026-01-01", "All", "20"],
    ]);

    expect(computeFacts(plan("month"), monthly).periodCoverage).toMatchObject({
      status: "complete",
      observationGrain: "month",
      observedCount: 1,
      expectedCount: 1,
      comparisonDisposition: "available",
    });
    expect(computeFacts(plan("year"), yearly).periodCoverage).toMatchObject({
      status: "complete",
      observationGrain: "year",
      observedCount: 1,
      expectedCount: 1,
      comparisonDisposition: "available",
    });
  });

  it("uses trusted coverage composition when latest-period coverage is unknown", () => {
    const source = table([
      ["2026-01-05", "Alpha", "10"],
      ["2026-01-20", "Beta", "20"],
      ["2026-02-05", "Alpha", "30"],
    ]);
    const planned = plan("month");
    const stalePlan: TablePlan = {
      ...planned,
      pages: planned.pages.map((page) => ({
        ...page,
        description:
          "Latest Amount, its change from the prior period, and the breakdown by Category.",
      })),
    };

    const spec = compileTablePlan(stalePlan, source, options(source));

    expect
      .soft(spec.pages[0]?.description)
      .toBe(
        "Coverage for Feb 2026 could not be established. Comparative findings are withheld.",
      );
    expect.soft(spec.executiveBrief.important).toMatchObject({
      headline:
        "Coverage for Feb 2026 is unknown; current-vs-prior change is unavailable",
      detail:
        "Comparable coverage for Feb 2026 and Jan 2026 cannot be established, so current-vs-prior change is unavailable. See the linked period evidence for the observed dates and reason.",
      evidenceIds: ["period-coverage"],
    });
    expect.soft(spec.nextAction).toMatchObject({
      title: "Verify Feb 2026 dates and coverage before comparison",
      detail:
        "Verify or correct the source dates and coverage shown in the linked period evidence, then rebuild before comparing Feb 2026 with Jan 2026.",
      evidenceIds: expect.arrayContaining(["period-coverage"]),
    });
    expect.soft(spec.executiveBrief.important.headline).not.toContain("Alpha");
    expect.soft(spec.nextAction.title).not.toBe("Open the evidence");
    expect(spec.pages.flatMap((page) => page.components)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.stringMatching(/-movers$/u) }),
      ]),
    );
    expect(
      spec.pages
        .flatMap((page) => page.components)
        .some((one) => one.kind === "trend-list"),
    ).toBe(false);
  });

  it.each([
    {
      name: "a unique newer date with an unreadable amount",
      rows: [
        ["2026-01-01", "Alpha", "100", "10"],
        ["2026-02-01", "Alpha", "120", "12"],
        ["2026-03-01", "Alpha", "not-an-amount", "15"],
      ],
      latestPeriod: "2026-03",
      previousPeriod: "2026-02",
    },
    {
      name: "a duplicate latest date with an unreadable amount",
      rows: [
        ["2026-01-01", "Alpha", "100", "10"],
        ["2026-02-01", "Alpha", "120", "12"],
        ["2026-02-01", "Beta", "not-an-amount", "3"],
      ],
      latestPeriod: "2026-02",
      previousPeriod: "2026-01",
    },
  ])("fails every current-vs-prior comparison closed for $name", (scenario) => {
    const facts = computeFacts(
      relationshipPlan("month"),
      relationshipTable(scenario.rows),
    );

    expect(facts.latestPeriod).toBe(scenario.latestPeriod);
    expect(facts.previousPeriod).toBe(scenario.previousPeriod);
    expect(facts.periodCoverage).toMatchObject({
      status: "unknown",
      latestPeriod: scenario.latestPeriod,
      priorPeriod: scenario.previousPeriod,
      comparisonDisposition: "unavailable-unknown",
      reason:
        "At least one selected row in the latest or prior analysis period has an unreadable amount value.",
    });
    expect(facts.change).toBeUndefined();
    expect(facts.changePercent).toBeUndefined();
    expect(facts.movers).toEqual([]);
    expect(facts.relationshipSupport).toBe("period-unknown");
    expect(facts.relationshipRatio).toBeUndefined();
    expect(facts.previousRelationshipRatio).toBeUndefined();
    expect(facts.relationshipRatioChangePercent).toBeUndefined();
  });

  it.each([
    {
      name: "sparse or irregular dates",
      source: () =>
        table([
          ["2026-01-05", "All", "10"],
          ["2026-01-20", "All", "20"],
          ["2026-02-05", "All", "30"],
        ]),
      testPlan: () => plan("month"),
      reason:
        "The observed dates do not establish a regular daily, monthly, quarterly, or yearly frequency.",
    },
    {
      name: "a missing date",
      source: () =>
        table([
          ["2026-04-01", "All", "10"],
          ["2026-05-01", "All", "10"],
          ["", "All", "not-an-amount"],
          ["2026-06-01", "All", "10"],
          ["2026-07-01", "All", "10"],
        ]),
      testPlan: () => plan("quarter"),
      reason:
        "At least one selected row has a missing or invalid period value.",
    },
    {
      name: "an invalid date",
      source: () =>
        table([
          ["2026-04-01", "All", "10"],
          ["2026-05-01", "All", "10"],
          ["not-a-date", "All", "10"],
          ["2026-06-01", "All", "10"],
          ["2026-07-01", "All", "10"],
        ]),
      testPlan: () => plan("quarter"),
      reason:
        "At least one selected row has a missing or invalid period value.",
    },
    {
      name: "a single period",
      source: () => table([["2026-01-01", "All", "10"]]),
      testPlan: () => plan("month"),
      reason:
        "There is no prior analysis period in this dataset to establish comparable coverage.",
    },
  ])("fails closed for $name", ({ source, testPlan, reason }) => {
    const canonical = source();
    const facts = computeFacts(testPlan(), canonical);

    expect(facts.periodCoverage).toMatchObject({
      status: "unknown",
      comparisonDisposition:
        facts.previousPeriod === undefined
          ? "unavailable-no-prior"
          : "unavailable-unknown",
      reason,
    });
    expect(facts.change).toBeUndefined();
    expect(facts.changePercent).toBeUndefined();
    expect(facts.movers).toEqual([]);
  });

  it("fails closed for a table with no date role", () => {
    const source = profileTable({
      headers: ["Category", "Amount"],
      rows: [
        ["Alpha", "10"],
        ["Beta", "20"],
      ],
    });
    const noDatePlan: TablePlan = {
      ...plan("month", ["summary", "headline-totals", "by-category"]),
      roles: { amount: "Amount", category: "Category" },
    };
    const facts = computeFacts(noDatePlan, source);

    expect(facts.periodCoverage).toEqual({
      status: "unknown",
      observedCount: 0,
      comparisonDisposition: "unavailable-no-prior",
      reason: "There is no period column in this dataset.",
    });
  });

  it("derives identical coverage evidence with or without a planning model", async () => {
    const source = table(monthlyRows(false));
    const planned = plan("quarter");
    const provider = (usesModel: boolean): PlanningProvider => ({
      id: usesModel ? "model:test" : "deterministic-test-planner",
      usesModel,
      plan: async () => planned,
    });
    const run = async (usesModel: boolean) =>
      runTablePlanner({
        requestText: "Review quarterly performance",
        table: source,
        provider: provider(usesModel),
        asOf: AS_OF,
        source: options(source).source,
      });
    const [deterministic, modelPlanned] = await Promise.all([
      run(false),
      run(true),
    ]);
    const coverage = (spec: (typeof deterministic)["dashboard"]) =>
      spec.evidence.find((item) => item.id === "period-coverage");

    expect(coverage(modelPlanned.dashboard)).toEqual(
      coverage(deterministic.dashboard),
    );
    expect(coverage(deterministic.dashboard)?.detail).toContain("dataset");
    expect(coverage(deterministic.dashboard)?.detail).not.toMatch(
      /model|forecast|annualiz/iu,
    );
  });
});
