import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { buildStationMetrics } from "@dasher/station-domain";

import { parseUsgsInstantaneousValues } from "./usgs";

const asOf = "2026-07-29T12:02:00.000Z";

describe("buildStationMetrics", () => {
  const gauges = parseUsgsInstantaneousValues(fixture);

  it("calculates one-, six-, and 24-hour stage changes", () => {
    const freeport = gauges.find((gauge) => gauge.siteId === "11447650")!;
    expect(buildStationMetrics(freeport, asOf)).toMatchObject({
      latestPrimary: 14.8,
      latestSecondary: 26300,
      primaryChange1h: 0.3,
      primaryChange6h: 0.6,
      primaryChange24h: 0.8,
      direction: "rising",
      freshness: "fresh",
    });
  });

  it("classifies falling gauges", () => {
    const verona = gauges.find((gauge) => gauge.siteId === "11370500")!;
    expect(buildStationMetrics(verona, asOf).direction).toBe("falling");
  });

  it("surfaces stale and missing sensor data", () => {
    const american = gauges.find((gauge) => gauge.siteId === "11446500")!;
    const result = buildStationMetrics(american, asOf);
    expect(result.freshness).toBe("missing");
    expect(result.direction).toBe("unknown");
    expect(result.primaryFreshness).toBe("stale");
    expect(result.secondaryFreshness).toBe("missing");
    expect(result.dataIssues).toEqual(
      expect.arrayContaining([
        "Streamflow readings are missing",
        "Water-level reading is more than two hours old",
      ]),
    );
  });

  it("evaluates each sensor independently and keeps the actual latest timestamp", () => {
    const freeport = structuredClone(
      gauges.find((gauge) => gauge.siteId === "11447650")!,
    );
    freeport.secondary!.observations = [
      { at: "2026-07-29T08:00:00.000Z", value: 26000 },
    ];
    const result = buildStationMetrics(freeport, asOf);
    expect(result.latestAt).toBe("2026-07-29T12:00:00.000Z");
    expect(result.freshness).toBe("stale");
    expect(result.dataIssues).toContain(
      "Streamflow reading is more than two hours old",
    );
  });
});
