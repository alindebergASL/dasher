import { describe, expect, it } from "vitest";

import { AIR_COMPUTATION, parseOpenAqHourlySnapshot } from "@dasher/air-domain";
import { parseDashboardSpec } from "@dasher/dashboard-schema";

import fixture from "../../../fixtures/openaq/sacramento-hourly.json";
import { compilePlan } from "./compile";
import type { DashboardPlan } from "./plan";

/**
 * The generality claim, made checkable: a dashboard for a domain the compiler
 * was not written for, from a REAL parser — not the hand-built objects the
 * spike used — through the shared `compilePlan` entrypoint, under the air
 * domain's own computation policy. One generic code path; no air branch.
 *
 * The policy is asserted on the COMPILED output, not on the domain functions
 * called directly, because the first version of this file did the latter and
 * a reviewer caught what that hid: `compilePlan` was still applying river
 * tolerances and river calculation evidence to air readings, and a monitor
 * easing by 0.8 µg/m³ compiled as "falling" through a tolerance meant for
 * feet of water. A proof that bypasses the thing it is proving is how that
 * survives.
 *
 * What this still deliberately does NOT pin is the compiler's own prose,
 * which says "gauges" — threading the domain's words through those ~40
 * sentences is the recorded next step (ADR-007, "What deliberately does not
 * change"), and asserting the current river wording here would freeze the
 * defect instead of tracking the work.
 */

const AS_OF = "2026-08-18T12:02:00.000Z";

const stations = parseOpenAqHourlySnapshot(fixture);

const PLAN: DashboardPlan = {
  planVersion: "plan-v1",
  title: "Air quality across the Sacramento Valley",
  audience: "Residents deciding whether to be outdoors",
  framing:
    "Where air quality stands at each monitoring station and which way it is moving.",
  siteIds: stations.map((station) => station.siteId),
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Every monitor, with the ones getting worse called out.",
      sections: [
        "conditions-summary",
        "headline-metrics",
        "gauge-map",
        "gauge-table",
        "fastest-rising",
        "stage-trends",
        "attention",
      ],
    },
  ],
};

function compiled() {
  return compilePlan(PLAN, stations, {
    asOf: AS_OF,
    planner: { id: "air-test-planner", usesModel: false },
    computation: AIR_COMPUTATION,
    thresholds: [
      {
        id: "unhealthy-sensitive",
        siteId: "2178",
        label: "Unhealthy for sensitive groups",
        above: 15,
      },
    ],
  });
}

describe("an air-quality dashboard through the shared compiler", () => {
  it("compiles and passes the dashboard contract", () => {
    const spec = compiled();

    expect(() => parseDashboardSpec(spec)).not.toThrow();
    expect(
      spec.pages.flatMap((page) =>
        page.components.map((component) => component.kind),
      ),
    ).toEqual([
      "summary",
      "metric-grid",
      "station-map",
      "station-table",
      "ranking",
      "trend-list",
      "alert-list",
    ]);
  });

  it("shows readings in the air domain's units, nobody's feet", () => {
    const spec = compiled();
    const table = spec.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "station-table");
    if (table?.kind !== "station-table") {
      throw new Error("expected station-table");
    }

    expect(table.stations.map((station) => station.primary.unit)).toEqual([
      "µg/m³",
      "µg/m³",
      "µg/m³",
    ]);
    expect(table.stations.map((station) => station.group)).toEqual([
      "Roseville",
      "Sacramento",
      "Woodland",
    ]);
    // Directions under the AIR tolerance, in the compiled output: +2.5 µg/m³
    // in the last hour clears the 2 µg/m³ bar, so Del Paso is rising; the
    // improving monitor's -0.8 does not, so it is steady — under the river's
    // 0.05 it compiled as "falling", which is the defect the review caught.
    const byId = new Map(
      table.stations.map((station) => [station.id, station.direction]),
    );
    expect(byId.get("2178")).toBe("rising");
    expect(byId.get("2183")).toBe("steady");

    const trend = spec.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "trend-list");
    if (trend?.kind !== "trend-list") throw new Error("expected trend-list");
    expect(trend.series.every((series) => series.unit === "µg/m³")).toBe(true);
    const rendered = JSON.stringify(spec);
    expect(rendered).not.toMatch(/\bft\b/);
  });

  it("cites OpenAQ in the evidence, with the domain's own vocabulary", () => {
    const spec = compiled();
    const observed = spec.evidence.find((item) => item.id === "openaq-2178");

    expect(observed?.sourceName).toBe("OpenAQ");
    expect(observed?.label).toBe("Sacramento monitor 2178");
    expect(observed?.detail).toBe(
      "PM2.5 and Ozone observations for Sacramento — Del Paso Manor.",
    );
    expect(observed?.sourceUrl).toBe(
      "https://explore.openaq.org/locations/2178",
    );
  });

  it("warns about the degraded monitor and fires the user threshold", () => {
    const spec = compiled();
    expect(spec.freshness.status).toBe("partial");

    const alerts = spec.pages
      .flatMap((page) => page.components)
      .flatMap((component) =>
        component.kind === "alert-list" ? component.alerts : [],
      );

    expect(alerts.map((alert) => alert.detail)).toContain(
      "Sacramento is 20.6 µg/m³, above the user threshold of 15 µg/m³.",
    );
    expect(
      alerts.some((alert) =>
        alert.detail.includes("PM2.5 reading is more than two hours old"),
      ),
    ).toBe(true);
    expect(
      alerts.some((alert) =>
        alert.detail.includes("Ozone readings are missing"),
      ),
    ).toBe(true);
  });

  it("applies the air domain's computation policy in the compiled dashboard itself", () => {
    // Asserted on `compilePlan`'s output — not on the domain functions called
    // directly, which is the bypass the first version of this test made. The
    // discriminating cases: Del Paso's +2.5 µg/m³ hour is a direction (above
    // 2) but not a material rise (below 5), so the compiled ranking is empty
    // where the river's 0.05 bar would have ranked it; and the calculated
    // evidence record carries the air domain's words, not the river's.
    const spec = compiled();

    const ranking = spec.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "ranking");
    if (ranking?.kind !== "ranking") throw new Error("expected ranking");
    expect(ranking.items).toEqual([]);

    const calculated = spec.evidence.find(
      (item) => item.id === "calculated-trends",
    );
    expect(calculated?.label).toBe("Dasher air-quality calculations");
    expect(calculated?.detail).toContain("OpenAQ hourly measurements");
    expect(calculated?.detail).not.toContain("USGS");
  });

  it("still compiles the river under river policy when no profile is passed", () => {
    // The other half of the reviewer's criterion: the default must remain
    // the river's, so every existing caller is untouched. Compiling the SAME
    // air stations with no computation profile reproduces the defect — which
    // is exactly what proves the profile is what fixed it.
    const riverRuled = compilePlan(PLAN, stations, {
      asOf: AS_OF,
      planner: { id: "air-test-planner", usesModel: false },
    });

    const table = riverRuled.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "station-table");
    if (table?.kind !== "station-table") {
      throw new Error("expected station-table");
    }
    expect(
      table.stations.find((station) => station.id === "2183")?.direction,
    ).toBe("falling");
    expect(
      riverRuled.evidence.find((item) => item.id === "calculated-trends")
        ?.label,
    ).toBe("Dasher river calculations");
  });
});
