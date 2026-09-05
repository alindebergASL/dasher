// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";

import type { DashboardSpec } from "@dasher/dashboard-schema";
import { FakePlanningProvider, runTablePlanner } from "@dasher/planner";
import { readTable } from "@dasher/workbook";
import { describe, expect, it } from "vitest";

/**
 * The check the rest of the suite cannot perform on itself.
 *
 * Every expected value here was computed from the raw CSV by hand or in Python,
 * before the code that produces it was written or fixed. The other tests in
 * this repository were written alongside their implementation, so they prove
 * the code agrees with itself; these prove it agrees with the file.
 *
 * Each fixture is a shape a real export takes and an earlier version of this
 * pipeline got wrong, silently and confidently. Adding a case here is how a
 * wrong number stays fixed.
 */

const FIXTURES = path.resolve(
  process.cwd(),
  "..",
  "..",
  "fixtures",
  "adversarial",
);

async function build(file: string, request: string): Promise<DashboardSpec> {
  const csv = readFileSync(path.join(FIXTURES, file), "utf8");
  const table = readTable(csv);
  const run = await runTablePlanner({
    requestText: request,
    table,
    provider: new FakePlanningProvider(),
    asOf: "2026-09-04T12:00:00.000Z",
    source: {
      name: file,
      retrievedAt: "2026-09-04T12:00:00.000Z",
      rowCount: table.rowCount,
    },
  });
  return run.dashboard;
}

/** Everything a reader can see, as one string. */
function text(dashboard: DashboardSpec): string {
  const parts: string[] = [
    dashboard.title,
    dashboard.notice,
    dashboard.executiveBrief.known.headline,
    dashboard.executiveBrief.changed.headline,
    dashboard.executiveBrief.important.headline,
  ];
  for (const page of dashboard.pages) {
    for (const component of page.components) {
      parts.push(component.title, component.subtitle ?? "");
      if (component.kind === "summary") {
        for (const claim of component.claims) parts.push(claim.text);
      }
      if (component.kind === "metric-grid") {
        for (const metric of component.metrics) {
          parts.push(`${metric.label}=${metric.value}`, metric.change ?? "");
        }
      }
      if (component.kind === "ranking") {
        for (const item of component.items) {
          parts.push(`${item.label}=${item.value}`, item.note ?? "");
        }
      }
      if (component.kind === "alert-list") {
        for (const alert of component.alerts) {
          parts.push(alert.title, alert.detail);
        }
      }
    }
  }
  return parts.join("\n");
}

/** The by-category ranking, in order, which is where "largest" is asserted. */
function categoryRanking(
  dashboard: DashboardSpec,
): { label: string; value: string }[] {
  for (const page of dashboard.pages) {
    for (const component of page.components) {
      if (
        component.kind === "ranking" &&
        component.id.endsWith("by-category")
      ) {
        return component.items.map((item) => ({
          label: item.label,
          value: item.value,
        }));
      }
    }
  }
  return [];
}

/** One trend series' values in period order, which spans the whole file. */
function periodTotals(dashboard: DashboardSpec, label: string): number[] {
  for (const page of dashboard.pages) {
    for (const component of page.components) {
      if (component.kind === "trend-list") {
        const series = component.series.find((one) => one.label === label);
        if (series !== undefined) {
          return series.points.map((point) => point.value);
        }
      }
    }
  }
  return [];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe("accounting-format negatives", () => {
  // 1,000 + 2,000 + 3,000 + 4,000 - 5,000 = 5,000. The refund is written
  // "$(5,000.00)", which is what Excel's Accounting format produces.
  it("counts a parenthesised refund rather than dropping it", async () => {
    const shown = text(await build("accounting-negatives.csv", "Total spend"));

    expect(shown).toContain("5,000");
    expect(shown).not.toContain("10,000");
    expect(shown).not.toMatch(/Gross inflow|Gross outflow|Net movement/iu);
  });
});

describe("a European export", () => {
  // Semicolon-delimited, comma decimal mark: 1.250 is one thousand two hundred
  // and fifty. Miete 1250 + 1250 = 2500; Gehalt 12500 + 12500,50 = 25000,50.
  it("reads dotted thousands as thousands", async () => {
    const dashboard = await build("european.csv", "Ausgaben über Zeit");
    // The trend carries every period; the by-category ranking is scoped to the
    // latest one, where Miete has no rows at all. An earlier version of this
    // assertion looked there and failed against correct output.
    expect(periodTotals(dashboard, "Total")).toEqual([
      1250, 1250, 12500, 12500.5,
    ]);
    // 1250 + 1250 and 12500 + 12500.50, computed from the file in Python.
    expect(sum(periodTotals(dashboard, "Miete"))).toBe(2500);
    expect(sum(periodTotals(dashboard, "Gehalt"))).toBe(25000.5);
  });

  // Dated the first of four consecutive months. Read as month-first they all
  // collapse into January, at a 100% parse rate and with nothing skipped.
  it("does not collapse four months into one", async () => {
    const dashboard = await build("european.csv", "Ausgaben über Zeit");
    const series = dashboard.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "trend-list");
    expect(series?.kind).toBe("trend-list");
    if (series?.kind !== "trend-list") return;
    expect(series.series[0]?.points.length).toBe(4);
  });
});

describe("amounts recorded as negatives", () => {
  // Payroll -1,000,000 dwarfs Coffee -10. Card and ledger exports sign spend
  // this way, and "largest" must mean largest by size.
  it("names the biggest line as the largest category", async () => {
    const dashboard = await build(
      "negative-amounts.csv",
      "where is the money going?",
    );
    expect(categoryRanking(dashboard)[0]?.label).toBe("Payroll");
    expect(text(dashboard)).not.toMatch(/Coffee is the largest/u);
  });
});

describe("a budget stated once per category", () => {
  // Eng spends 1000 + 900 + 800 = 2700 against a budget of 1200, so it is over
  // by 1500. Ops spends 100 against 500 and is under.
  it("compares the whole category's spend against its budget", async () => {
    const shown = text(
      await build(
        "budget-once-per-category.csv",
        "how are we doing on budget?",
      ),
    );
    expect(shown).toMatch(/Eng/u);
    expect(shown).not.toMatch(/within budget/iu);
  });
});

describe("a filter naming a category", () => {
  // Six categories, 100 each, two months. Excluding Travel leaves 500 a month.
  // Matching by substring instead removes A and E and keeps Travel.
  it("excludes the category named and no other", async () => {
    const shown = text(
      await build("filter-substring.csv", "spend excluding travel"),
    );
    expect(shown).toContain("500");
    expect(shown).not.toMatch(/\bTravel\b/u);
    expect(shown).not.toContain("400");
  });
});

describe("a quarterly period column", () => {
  // The buckets are quarters; saying "by month" over them is a false statement
  // about figures that are themselves correct.
  it("does not describe quarterly buckets as monthly", async () => {
    const shown = text(await build("quarterly.csv", "spend over time"));
    expect(shown).not.toMatch(/by month|Trend by month|grouped by month/u);
  });
});
