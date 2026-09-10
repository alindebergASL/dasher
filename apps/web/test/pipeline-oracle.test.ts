// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";

import type { DashboardSpec } from "@dasher/dashboard-schema";
import { FakePlanningProvider, runTablePlanner } from "@dasher/planner";
import { readTable } from "@dasher/workbook";

import { readUpload } from "../app/upload";
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
const SAMPLES = path.resolve(process.cwd(), "..", "..", "fixtures", "sample");
const SPREADSHEETS = path.resolve(
  process.cwd(),
  "..",
  "..",
  "fixtures",
  "xlsx",
);

async function build(
  file: string,
  request: string,
  directory: string = FIXTURES,
): Promise<DashboardSpec> {
  const csv = readFileSync(path.join(directory, file), "utf8");
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

/** The same, for a file that arrives as a spreadsheet rather than as text. */
async function buildSpreadsheet(
  file: string,
  request: string,
): Promise<DashboardSpec> {
  const bytes = new Uint8Array(readFileSync(path.join(SPREADSHEETS, file)));
  const read = readUpload(file, bytes);
  if (!read.ok) throw new Error(read.message);
  const run = await runTablePlanner({
    requestText: request,
    table: read.upload.table,
    provider: new FakePlanningProvider(),
    asOf: "2026-09-04T12:00:00.000Z",
    source: {
      name: file,
      retrievedAt: "2026-09-04T12:00:00.000Z",
      rowCount: read.upload.table.rowCount,
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

/** The change string on a named metric, which is where percentages are shown. */
function metricChange(
  dashboard: DashboardSpec,
  label: string,
): string | undefined {
  for (const page of dashboard.pages) {
    for (const component of page.components) {
      if (component.kind !== "metric-grid") continue;
      const metric = component.metrics.find((one) => one.label === label);
      if (metric !== undefined) return metric.change;
    }
  }
  return undefined;
}

/** The period-coverage evidence detail, where the disposition is explained. */
function coverageEvidence(dashboard: DashboardSpec): string {
  return (
    dashboard.evidence.find((item) => item.label.startsWith("Period coverage"))
      ?.detail ?? ""
  );
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

describe("the shipped sample", () => {
  // Sums of the Amount column per month, computed from the raw CSV in Python:
  // Jul 2026 is 63,650.80 and Aug 2026 is 55,361.03, so the month-over-month
  // change is -8,289.77, or -13.0%. The file is retrieved after August ended,
  // so August was fully available to the export and the comparison stands.
  //
  // This case exists because a release once withheld this answer entirely and
  // no test noticed. "What changed" is the question the product is for.
  it("answers what changed rather than withholding it", async () => {
    const dashboard = await build(
      "transactions.csv",
      "Spending by category and what changed",
      SAMPLES,
    );
    expect(dashboard.executiveBrief.changed.headline).toBe(
      "-$8,289.77 vs Jul 2026",
    );
    expect(metricChange(dashboard, "Change vs prior period")).toBe(
      "-$8,289.77 (-13.0%) vs Jul 2026",
    );
    // Every month in the file, so a wrong figure cannot hide behind the two
    // the comparison happens to use.
    expect(periodTotals(dashboard, "Total")).toEqual([
      57380.44, 55223.02, 60107.66, 57102.11, 63279.19, 66610.22, 63650.8,
      55361.03,
    ]);
  });
});

describe("events that arrive on no fixed schedule", () => {
  // Hours per team on the dates work actually happened: no daily, monthly,
  // quarterly or yearly grid, which is what most real data looks like and what
  // a dashboard harness must handle. Jun 2026 sums to 45 and Jul 2026 to 35,
  // both months over before the file was retrieved, so the change is -10, or
  // -22.2%. Platform is the largest July team at 23 of the 35 hours.
  it("compares two finished periods without a regular frequency", async () => {
    const dashboard = await build(
      "irregular-events.csv",
      "Resolution hours by team and what changed",
    );
    expect(dashboard.executiveBrief.changed.headline).toBe("-10 vs Jun 2026");
    expect(metricChange(dashboard, "Change vs prior period")).toBe(
      "-10 (-22.2%) vs Jun 2026",
    );
    expect(periodTotals(dashboard, "Total")).toEqual([11, 16, 15, 45, 35]);
    // Platform is 23 of July's 35 hours, and fell from 30 in June.
    expect(categoryRanking(dashboard)[0]).toEqual({
      label: "Platform",
      value: "23",
    });
    expect(dashboard.executiveBrief.important.headline).toBe(
      "Platform moved -7",
    );
  });
});

describe("a latest period the file was retrieved inside", () => {
  // The same shape, but the file was retrieved on 2026-09-04, four days into
  // September. Aug 2026 (28 hours) had ended and was fully available; Sep 2026
  // (7 hours) had not. Comparing them would report a 75% collapse that is only
  // the calendar. The change must be withheld and the reason must say why.
  it("withholds a comparison against a period still running", async () => {
    const dashboard = await build(
      "partial-latest-period.csv",
      "Resolution hours by team and what changed",
    );
    expect(dashboard.executiveBrief.changed.headline).toBe(
      "Change unavailable for partial Sep 2026",
    );
    // The 75% collapse is the calendar, not the teams. It must appear nowhere.
    expect(text(dashboard)).not.toMatch(/75(\.0)?%/u);
    // What is shown is still true, and says which period is only part-counted.
    expect(dashboard.executiveBrief.known.headline).toBe(
      "7 total for Sep 2026 (partial)",
    );
    // Four days into a thirty-day month, which is the whole of the reason.
    expect(coverageEvidence(dashboard)).toContain(
      "the source was retrieved on 2026-09-04, with only 3 of its 30 days elapsed",
    );
    // Nothing is missing from September, so the reader must not be told to
    // supply it. The only thing that fixes a running period is time.
    expect(dashboard.nextAction.title).toBe(
      "Wait for Sep 2026 to finish before comparing it",
    );
    expect(dashboard.nextAction.detail).not.toMatch(/\badd\b/iu);
    // The four complete months are still true and still plotted; only the
    // running one is left out. Withholding them taught the reader nothing.
    expect(periodTotals(dashboard, "Total")).toEqual([12, 13, 16, 28]);
  });
});

describe("a file that arrives as a spreadsheet", () => {
  // Written by Python's openpyxl, so the file under test came from a real
  // spreadsheet writer. Summed from the same source rows: Jun 2026 is 1350.75
  // + 655.20 = 2005.95 and Jul 2026 is 1402.11 + 9250.00 = 10652.11, so the
  // change is +8,646.16, or +431.0%.
  it("reads a spreadsheet to the same figures a CSV would give", async () => {
    const dashboard = await buildSpreadsheet(
      "transactions.xlsx",
      "Spending by category and what changed",
    );
    expect(dashboard.executiveBrief.known.headline).toBe(
      "10,652.11 total for Jul 2026",
    );
    expect(metricChange(dashboard, "Change vs prior period")).toBe(
      "+8,646.16 (+431.0%) vs Jun 2026",
    );
    // Five months, each summed from cells the reader never parsed as floats.
    expect(periodTotals(dashboard, "Total")).toEqual([
      2124.66, 2013.49, 10288.9, 2005.95, 10652.11,
    ]);
    // The dates were serial numbers in the file; nothing downstream can tell.
    expect(text(dashboard)).not.toMatch(/4608\d/u);
  });

  it("passes a cover sheet by and reads the sheet with the table", async () => {
    const dashboard = await buildSpreadsheet(
      "cover-sheet-first.xlsx",
      "Hours by team over time",
    );
    expect(periodTotals(dashboard, "Total")).toEqual([7, 11, 9, 12, 14]);
    expect(text(dashboard)).not.toContain("Exported from the finance system");
  });
});

describe("cells that name their own period", () => {
  // Three monthly cells span nine calendar weeks, but they are not nine weeks
  // of data. Bucketing them by week would put consecutive months into
  // non-consecutive buckets and withhold the comparison entirely. Mar 2026 is
  // 126 + 50 = 176 against Feb 2026 at 120 + 45 = 165, so +11, or +6.7%.
  it("never buckets below the grain the cells state", async () => {
    const dashboard = await build(
      "stated-months.csv",
      "Amount by category over time",
    );
    expect(dashboard.executiveBrief.known.headline).toBe(
      "176 total for Mar 2026",
    );
    expect(metricChange(dashboard, "Change vs prior period")).toBe(
      "+11 (+6.7%) vs Feb 2026",
    );
    expect(periodTotals(dashboard, "Total")).toEqual([140, 165, 176]);
    expect(text(dashboard)).not.toMatch(/Week of/u);
  });
});

describe("readings taken every day", () => {
  // Fourteen days of error counts, two services. A fortnight is one month and
  // two weeks, so neither can show a shape; only a daily bucket can. Summed
  // from the raw CSV: 30 Aug is 1 + 2 = 3, and 29 Aug is 4 + 3 = 7.
  it("buckets a fortnight by day rather than into one month", async () => {
    const dashboard = await build(
      "daily-readings.csv",
      "Errors by service over time",
    );
    expect(dashboard.executiveBrief.known.headline).toBe(
      "3 total for 30 Aug 2026",
    );
    expect(dashboard.executiveBrief.changed.headline).toBe("-4 vs 29 Aug 2026");
    const totals = periodTotals(dashboard, "Total");
    expect(totals).toHaveLength(14);
    expect(totals[0]).toBe(17);
    expect(totals.at(-1)).toBe(3);
    expect(sum(totals)).toBe(182);
  });
});

describe("a measure recorded once a week", () => {
  // Thirteen Mondays of signups. Three monthly buckets cannot show a trend;
  // thirteen weekly ones can. The week of 24 Aug is 70 + 22 = 92 against the
  // week of 17 Aug at 64 + 16 = 80, so +12, or +15.0%.
  it("buckets Mondays by week and names each week by its date", async () => {
    const dashboard = await build(
      "weekly-signups.csv",
      "Signups by channel over time",
    );
    expect(dashboard.executiveBrief.known.headline).toBe(
      "92 total for Week of 24 Aug 2026",
    );
    expect(metricChange(dashboard, "Change vs prior period")).toBe(
      "+12 (+15.0%) vs Week of 17 Aug 2026",
    );
    expect(periodTotals(dashboard, "Total")).toEqual([
      50, 56, 50, 61, 64, 63, 71, 67, 78, 75, 84, 80, 92,
    ]);
    // A reader can place "Week of 24 Aug 2026" on a calendar; "2026-W35" is a
    // number they would have to count out.
    expect(text(dashboard)).not.toMatch(/W\d\d/u);
  });
});
