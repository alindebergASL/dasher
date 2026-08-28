import { describe, expect, it } from "vitest";

import {
  buildStationMetrics,
  deriveStationFacts,
  stationEvidenceId,
  stationView,
  type Station,
} from "./index";

/**
 * The generic layer's own behaviour — the parts a domain wrapper cannot show.
 *
 * The mechanics (staleness windows, change-over-hours, ranking order) are
 * exercised end to end by `@dasher/river-domain`'s tests through
 * `deriveRiverFacts`, against the USGS fixture. What lives here is what makes
 * this layer generic rather than river code that moved: every word in its
 * output comes from the station, and every river-shaped number is a
 * parameter.
 */

const AS_OF = "2026-08-18T12:00:00.000Z";

function hourly(values: readonly number[]) {
  return values.map((value, index) => ({
    at: new Date(
      Date.parse(AS_OF) - (values.length - 1 - index) * 3_600_000,
    ).toISOString(),
    value,
  }));
}

function monitor(overrides: Partial<Station> = {}): Station {
  return {
    siteId: "aq-001",
    name: "Del Paso Manor",
    group: "Sacramento Valley",
    kindLabel: "monitor",
    primaryLabel: "AQI",
    secondaryLabel: "PM2.5",
    latitude: 38.61,
    longitude: -121.37,
    primary: { unit: "AQI", observations: hourly([40, 50, 62]) },
    secondary: { unit: "ug/m3", observations: hourly([9, 11, 14]) },
    sourceName: "Air District",
    sourceUrl: "https://example.invalid/aq-001",
    evidencePrefix: "airnow",
    retrievedAt: AS_OF,
    ...overrides,
  };
}

const CALCULATIONS = {
  label: "Dasher air calculations",
  detail: "Changes are calculated from hourly AQI observations.",
} as const;

describe("the words come from the station", () => {
  it("builds evidence from the station's own vocabulary and source", () => {
    const facts = deriveStationFacts([buildStationMetrics(monitor(), AS_OF)], {
      asOf: AS_OF,
      calculations: CALCULATIONS,
    });

    const observed = facts.evidence.find((item) => item.id === "airnow-aq-001");
    expect(observed?.label).toBe("Sacramento Valley monitor aq-001");
    expect(observed?.sourceName).toBe("Air District");
    expect(observed?.detail).toBe(
      "AQI and PM2.5 observations for Del Paso Manor.",
    );

    const calculated = facts.evidence.find(
      (item) => item.id === "calculated-trends",
    );
    expect(calculated?.label).toBe(CALCULATIONS.label);
    expect(calculated?.detail).toBe(CALCULATIONS.detail);
  });

  it("names a missing series with the station's label even when no series exists to ask", () => {
    // The reason the labels live on the station rather than the series: the
    // message about an absent sensor is exactly the case with no series to
    // read a label from.
    const metrics = buildStationMetrics(
      monitor({ secondary: undefined }),
      AS_OF,
    );

    expect(metrics.dataIssues).toContain("PM2.5 readings are missing");
  });

  it("writes the threshold sentence in the primary series' unit", () => {
    const facts = deriveStationFacts([buildStationMetrics(monitor(), AS_OF)], {
      asOf: AS_OF,
      calculations: CALCULATIONS,
      thresholds: [
        { id: "unhealthy", siteId: "aq-001", label: "Unhealthy", above: 55 },
      ],
    });

    const alert = facts.alerts.find((item) => item.id === "unhealthy");
    expect(alert?.detail).toBe(
      "Sacramento Valley is 62 AQI, above the user threshold of 55 AQI.",
    );
  });

  it("shapes a station view the 1.2 contract accepts, words included", () => {
    const view = stationView(buildStationMetrics(monitor(), AS_OF));

    expect(view).toMatchObject({
      group: "Sacramento Valley",
      primary: { value: 62, unit: "AQI" },
      secondary: { value: 14, unit: "ug/m3" },
      direction: "rising",
      evidenceIds: ["airnow-aq-001", "calculated-trends"],
    });
  });

  it("namespaces evidence by the station's own prefix", () => {
    expect(stationEvidenceId(monitor())).toBe("airnow-aq-001");
  });
});

describe("the river's numbers are parameters", () => {
  it("classifies direction against the caller's tolerance, not 0.05", () => {
    // A +2 AQI change over the last hour: material for a river in feet,
    // noise for AQI on a 0-500 scale if the domain says so.
    const station = monitor({
      primary: { unit: "AQI", observations: hourly([58, 59, 61]) },
    });

    expect(buildStationMetrics(station, AS_OF).direction).toBe("rising");
    expect(
      buildStationMetrics(station, AS_OF, { directionTolerance: 5 }).direction,
    ).toBe("steady");
  });

  it("rounds a change to two decimals, which the tolerances are not", () => {
    /*
     * The one number here that is NOT a parameter, pinned because the next
     * domain will meet it.
     *
     * `changeOverHours` returns `Number((current - prior).toFixed(2))`. Both
     * domains that exist are safe: a river gauge is feet to two places, and
     * PM2.5 is µg/m³ on a 0-500 scale, so two decimals is below anything
     * either reports. A domain whose PRIMARY series is in ppm is not — ozone
     * runs 0.020 to 0.100, and a real one-hour move of 0.004 ppm would arrive
     * here as exactly 0 and be classified steady, whatever tolerance the
     * caller passed.
     *
     * Air already carries ozone in ppm, and gets away with it only because
     * ozone is its SECONDARY series and secondaries are never differenced.
     * `directionTolerance` and `materialRiseTolerance` were both made
     * parameters for this reason; this precision was not, and a third domain
     * (see the backlog) is what would find out.
     */
    const ppm = monitor({
      primary: { unit: "ppm", observations: hourly([0.04, 0.048]) },
    });

    // The exact move is +0.008. What a caller gets is +0.01 — and at +0.004 it
    // would be 0, with no way to tell that from no change at all.
    expect(buildStationMetrics(ppm, AS_OF).primaryChange1h).toBe(0.01);

    const smaller = monitor({
      primary: { unit: "ppm", observations: hourly([0.04, 0.044]) },
    });

    expect(buildStationMetrics(smaller, AS_OF).primaryChange1h).toBe(0);
    expect(
      buildStationMetrics(smaller, AS_OF, { directionTolerance: 0.001 })
        .direction,
    ).toBe("steady");
  });

  it("ranks against the caller's material-rise tolerance", () => {
    const metrics = [buildStationMetrics(monitor(), AS_OF)];
    const strict = deriveStationFacts(metrics, {
      asOf: AS_OF,
      calculations: CALCULATIONS,
      materialRiseTolerance: 50,
    });
    const lax = deriveStationFacts(metrics, {
      asOf: AS_OF,
      calculations: CALCULATIONS,
      materialRiseTolerance: 5,
    });

    expect(strict.ranked).toEqual([]);
    expect(lax.ranked).toHaveLength(1);
  });
});
