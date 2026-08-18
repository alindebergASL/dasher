import { describe, expect, it } from "vitest";

import {
  AIR_CALCULATIONS,
  AIR_DIRECTION_TOLERANCE,
  AIR_MATERIAL_RISE_TOLERANCE,
  parseOpenAqHourlySnapshot,
} from "@dasher/air-domain";
import { parseDashboardSpec } from "@dasher/dashboard-schema";
import {
  buildStationMetrics,
  deriveStationFacts,
} from "@dasher/station-domain";

import fixture from "../../../fixtures/openaq/sacramento-hourly.json";
import { compilePlan } from "./compile";
import type { DashboardPlan } from "./plan";

/**
 * The generality claim, made checkable: a dashboard for a domain the compiler
 * was not written for, from a REAL parser — not the hand-built objects the
 * spike used — through the same `compilePlan` and the same contract.
 *
 * What this pins is structure: the components exist, the readings carry the
 * air domain's units and labels, the evidence cites OpenAQ, the freshness
 * warning fires for the degraded monitor. What it deliberately does NOT pin
 * is the compiler's own prose, which still says "gauges" — threading the
 * domain's words through those ~40 sentences is the recorded next step
 * (ADR-007, "What deliberately does not change"), and asserting the current
 * river wording here would freeze the defect instead of tracking the work.
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

describe("an air-quality dashboard through the unmodified compiler", () => {
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
    // The worsening monitor reads as rising; the improving one as falling.
    const byId = new Map(
      table.stations.map((station) => [station.id, station.direction]),
    );
    expect(byId.get("2178")).toBe("rising");
    expect(byId.get("2183")).toBe("falling");

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

  it("computes direction and ranking under the air domain's tolerances, not the river's", () => {
    // The generic layer is what the compiler calls today, with river numbers.
    // This pins that the air numbers exist and change the verdict, so wiring
    // them through `compilePlan` is a visible decision rather than a silent
    // default. +2.5 µg/m³ in the last hour: rising under the river's 0.05,
    // steady under the air domain's 2... is false — it is above 2. The
    // fixture's Del Paso rise is +2.5/h and +10.8/6h: material either way.
    // Woodland's last hour is -0.2: steady under both. The discriminating
    // case is ranking: under the river tolerance every rising monitor ranks;
    // under the air tolerance a rise must clear 5 µg/m³ in the hour.
    const metrics = stations.map((station) =>
      buildStationMetrics(station, AS_OF, {
        directionTolerance: AIR_DIRECTION_TOLERANCE,
      }),
    );
    const facts = deriveStationFacts(metrics, {
      asOf: AS_OF,
      calculations: AIR_CALCULATIONS,
      materialRiseTolerance: AIR_MATERIAL_RISE_TOLERANCE,
    });

    expect(facts.rising.map((item) => item.station.siteId)).toEqual(["2178"]);
    // +2.5 in the hour does not clear the 5 µg/m³ material-rise bar.
    expect(facts.ranked).toEqual([]);
    expect(
      facts.evidence.find((item) => item.id === "calculated-trends")?.label,
    ).toBe("Dasher air-quality calculations");
  });
});
