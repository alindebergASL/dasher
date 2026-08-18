import { describe, expect, it } from "vitest";

import {
  parseUsgsInstantaneousValues,
  type RiverGauge,
} from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { compilePlan } from "./compile";
import type { DashboardPlan } from "./plan";

/**
 * What a compiled dashboard must be true about, stated against the product's
 * promises rather than against this compiler's structure.
 *
 * `compilePlan` is the trusted half of the planning loop: a model chooses the
 * title, the gauges, and the page layout, and this computes every number,
 * every alert, and every freshness judgement from the observations. It is the
 * largest file in the reachable product and had no test of its own — the
 * closest equivalents tested a second, fixed-page composition that nothing
 * rendered, since deleted. Three mutations to the rules below survived both
 * this package's suite and the full end-to-end suite before these existed:
 * inverting the stale-gauge filter, moving the threshold comparison off its
 * boundary, and pinning the summary tone to `normal`.
 *
 * Two product promises are load-bearing here — `PRODUCT_REQUIREMENTS.md`
 * requires "missing or stale sensor warnings" and "user-defined threshold
 * alerts" — and both are judgements a reader acts on. A gauge wrongly called
 * fresh, or a flood threshold that fires a foot late, is the failure that
 * matters most in a product whose claim is evidence.
 *
 * One mutation deliberately has no test: weakening `dataIssues.length > 0` to
 * `> 1` in the stale-gauge filter changes nothing observable. `buildGaugeMetrics`
 * appends a data issue under exactly the conditions that make its freshness
 * non-fresh, using the same staleness predicate, so the two halves of that `||`
 * are equivalent for every input the compiler can receive — verified across all
 * forty-nine combinations of stage and streamflow age, including the boundary.
 * It is an equivalent mutant rather than a coverage gap, and the clause is worth
 * keeping: a data issue that is not a freshness issue, such as a plausibility
 * check, would make the two diverge.
 */

const AS_OF = "2026-07-29T12:02:00.000Z";
const gauges = parseUsgsInstantaneousValues(fixture);
const site = "11447650";

function planFor(
  siteIds: readonly string[],
  sections: DashboardPlan["pages"][number]["sections"],
): DashboardPlan {
  return {
    planVersion: "plan-v1",
    title: "Compile Test",
    audience: "Testers",
    framing: "A framing sentence.",
    siteIds: [...siteIds],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Everything at once.",
        sections: [...sections],
      },
    ],
  };
}

/** The stage reading a gauge most recently reported, as the fixture has it. */
function latestStage(gauge: RiverGauge): number {
  const observations = gauge.stage?.observations ?? [];
  const last = observations[observations.length - 1];
  if (last?.value === undefined || last.value === null) {
    throw new Error("fixture gauge has no stage reading to anchor a threshold");
  }
  return last.value;
}

function summaryOf(spec: ReturnType<typeof compilePlan>) {
  const component = spec.pages
    .flatMap((page) => page.components)
    .find((candidate) => candidate.kind === "summary");
  if (component?.kind !== "summary") {
    throw new Error("compiled dashboard has no summary component");
  }
  return component;
}

function alertsOf(spec: ReturnType<typeof compilePlan>) {
  const component = spec.pages
    .flatMap((page) => page.components)
    .find((candidate) => candidate.kind === "alert-list");
  if (component?.kind !== "alert-list") {
    throw new Error("compiled dashboard has no alert list");
  }
  return component.alerts;
}

describe("user-defined threshold alerts", () => {
  const gauge = gauges.find((candidate) => candidate.siteId === site)!;
  const reading = latestStage(gauge);

  function compileWithThreshold(stageAbove: number) {
    return compilePlan(planFor([site], ["attention"]), [gauge], {
      asOf: AS_OF,
      planner: { id: "test-planner", usesModel: true },
      thresholds: [
        {
          id: "flood-watch",
          siteId: site,
          label: "Flood watch",
          stageAbove,
        },
      ],
    });
  }

  it("raises the alert when the reading is above the threshold", () => {
    const alerts = alertsOf(compileWithThreshold(reading - 1));
    expect(alerts.map((alert) => alert.id)).toContain("flood-watch");
  });

  it("does not raise the alert when the reading sits exactly on the threshold", () => {
    // `stageAbove` names the level a reading must exceed, so equality is not a
    // breach. This is the boundary a reader is entitled to: a gauge holding
    // steady at the level they set is not the same as one that has passed it,
    // and telling them otherwise makes every threshold cry wolf at its own
    // value.
    const alerts = alertsOf(compileWithThreshold(reading));
    expect(alerts.map((alert) => alert.id)).not.toContain("flood-watch");
  });

  it("does not raise the alert when the reading is below the threshold", () => {
    const alerts = alertsOf(compileWithThreshold(reading + 1));
    expect(alerts.map((alert) => alert.id)).not.toContain("flood-watch");
  });
});

describe("missing or stale sensor warnings", () => {
  const freshGauge = gauges.find((candidate) => candidate.siteId === site)!;

  /** The same gauge, read far enough later that its observations are old. */
  const staleAsOf = "2026-07-30T12:02:00.000Z";

  function compile(asOf: string) {
    return compilePlan(
      planFor([site], ["conditions-summary", "attention"]),
      [freshGauge],
      { asOf, planner: { id: "test-planner", usesModel: true } },
    );
  }

  it("reports a fresh, complete gauge as needing no freshness check", () => {
    const claims = summaryOf(compile(AS_OF)).claims.map((claim) => claim.text);
    expect(claims.join(" ")).not.toMatch(/freshness or completeness check/u);
  });

  it("reports a stale gauge as needing a freshness check", () => {
    // The inverse of the test above, and the pair is the point: asserting only
    // that a stale gauge is flagged passes just as well when *every* gauge is
    // flagged, which is what inverting this filter does.
    const claims = summaryOf(compile(staleAsOf)).claims.map(
      (claim) => claim.text,
    );
    expect(claims.join(" ")).toMatch(/freshness or completeness check/u);
  });

  it("marks the summary for attention when a gauge is stale", () => {
    expect(summaryOf(compile(staleAsOf)).tone).toBe("attention");
  });

  it("leaves the summary tone normal when every gauge is fresh and complete", () => {
    expect(summaryOf(compile(AS_OF)).tone).toBe("normal");
  });

  it("does not raise a threshold alert from a stale reading", () => {
    // A threshold is a claim about conditions now. A reading old enough to be
    // stale cannot support one, and a flood alert derived from yesterday's
    // stage is worse than no alert: it is a confident statement about a river
    // nobody has looked at.
    const spec = compilePlan(planFor([site], ["attention"]), [freshGauge], {
      asOf: staleAsOf,
      planner: { id: "test-planner", usesModel: true },
      thresholds: [
        {
          id: "stale-threshold",
          siteId: site,
          label: "Stale threshold",
          stageAbove: latestStage(freshGauge) - 1,
        },
      ],
    });
    expect(alertsOf(spec).map((alert) => alert.id)).not.toContain(
      "stale-threshold",
    );
  });
});

describe("what the dashboard says about who composed it", () => {
  function architectureFor(usesModel: boolean) {
    return compilePlan(planFor([site], ["conditions-summary"]), gauges, {
      asOf: AS_OF,
      planner: { id: "fake-keyword-planner-v1", usesModel },
    }).architecture.summary;
  }

  it("does not claim a model chose the layout when no model was called", () => {
    // FakePlanningProvider is keyword matching -- `text.includes("flood")` --
    // and README records that model calls are disabled. Telling a reader that
    // "a planning model chose the layout" is then a claim about AI that is not
    // true of the running system, in the one panel whose job is to explain how
    // the dashboard was made.
    expect(architectureFor(false)).not.toMatch(/planning model/iu);
    expect(architectureFor(false)).toMatch(/no model was called/iu);
  });

  it("says a model chose the layout when one did", () => {
    // The other direction matters as much. A dashboard that never credits the
    // model understates where the judgement came from, and a reader deciding
    // how much to trust the framing is entitled to know.
    expect(architectureFor(true)).toMatch(/planning model/iu);
    expect(architectureFor(true)).not.toMatch(/no model was called/iu);
  });

  it("draws no AI node in the diagram when no model ran", () => {
    // The summary and the diagram are one panel to a reader. Saying "no model
    // was called" beside a node labelled "AI dashboard planner" is a
    // contradiction the reader has to resolve, and they will believe the
    // picture.
    const spec = compilePlan(planFor([site], ["conditions-summary"]), gauges, {
      asOf: AS_OF,
      planner: { id: "fake-keyword-planner-v1", usesModel: false },
    });
    expect(spec.architecture.nodes.some((node) => node.kind === "ai")).toBe(
      false,
    );
    expect(spec.architecture.nodes.map((node) => node.label)).not.toContain(
      "AI dashboard planner",
    );
  });

  it("draws the AI node when a model did choose the layout", () => {
    const spec = compilePlan(planFor([site], ["conditions-summary"]), gauges, {
      asOf: AS_OF,
      planner: { id: "real-model", usesModel: true },
    });
    expect(spec.architecture.nodes.some((node) => node.kind === "ai")).toBe(
      true,
    );
  });

  it("attributes the layout either way, never leaving it unexplained", () => {
    for (const usesModel of [true, false]) {
      expect(architectureFor(usesModel)).toMatch(/chose this dashboard/iu);
      expect(architectureFor(usesModel)).toMatch(
        /Dasher computed every number/iu,
      );
    }
  });
});

/**
 * The unit a reading is labelled with comes from the reading, not from a
 * literal.
 *
 * Six sites in the compiler wrote `"ft"` directly while two read it from the
 * series, so one dashboard could label the same gauge's change two different
 * ways. Nothing caught it, and nothing could: `parseUsgsInstantaneousValues`
 * rejects a stage series that is not in feet, so every gauge the fixture path
 * produces makes the literal accidentally correct.
 *
 * `compilePlan` does not take USGS output though — it takes `RiverGauge[]`,
 * and a gauge in metres satisfies that type. "The parser would have caught it"
 * is a statement about a function that is not in this call path. These tests
 * enter through the signature the compiler actually publishes.
 */
describe("the unit of a change", () => {
  const source = gauges.find((candidate) => candidate.siteId === site)!;

  /** The same gauge, reporting in metres. Legal for `RiverGauge`. */
  const metric: RiverGauge = {
    ...source,
    stage: { ...source.stage!, unit: "m" },
  };

  function rankingValues(
    gauge: RiverGauge,
    section: "fastest-rising" | "change-windows",
  ) {
    const spec = compilePlan(planFor([site], [section]), [gauge], {
      asOf: AS_OF,
      planner: { id: "test-planner", usesModel: false },
    });
    const component = spec.pages
      .flatMap((page) => page.components)
      .find((candidate) => candidate.kind === "ranking");
    if (component?.kind !== "ranking") {
      throw new Error("compiled dashboard has no ranking component");
    }
    return component.items.map((item) => `${item.value} ${item.note ?? ""}`);
  }

  it("labels a fastest-rising change in the gauge's own unit", () => {
    const rendered = rankingValues(metric, "fastest-rising").join(" ");

    expect(rendered).toContain(" m");
    expect(rendered).not.toContain("ft");
  });

  it("labels every change window in the gauge's own unit", () => {
    const rendered = rankingValues(metric, "change-windows").join(" ");

    expect(rendered).toContain(" m");
    expect(rendered).not.toContain("ft");
  });

  it("still says ft for a gauge that reports in feet", () => {
    // The other direction, so a change that simply dropped the unit everywhere
    // could not pass. Both sections, because they were separate literals.
    for (const section of ["fastest-rising", "change-windows"] as const) {
      expect(rankingValues(source, section).join(" ")).toContain("ft");
    }
  });

  it("carries the unit into the trend series and the summary alike", () => {
    const spec = compilePlan(
      planFor([site], ["conditions-summary", "stage-trends"]),
      [metric],
      { asOf: AS_OF, planner: { id: "test-planner", usesModel: false } },
    );
    const trend = spec.pages
      .flatMap((page) => page.components)
      .find((candidate) => candidate.kind === "trend-list");
    if (trend?.kind !== "trend-list") {
      throw new Error("compiled dashboard has no trend list");
    }

    expect(trend.series.map((item) => item.unit)).toEqual(["m"]);
    // The summary's fastest-rising claim was its own literal, in a different
    // branch from the ranking section's.
    expect(
      summaryOf(spec)
        .claims.map((claim) => claim.text)
        .join(" "),
    ).not.toContain("ft");
  });
});
