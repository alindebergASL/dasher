import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { buildGaugeMetrics } from "./metrics";
import { parseUsgsInstantaneousValues } from "./usgs";

const asOf = "2026-07-29T12:02:00.000Z";

describe("buildGaugeMetrics", () => {
  const gauges = parseUsgsInstantaneousValues(fixture);

  it("calculates one-, six-, and 24-hour stage changes", () => {
    const freeport = gauges.find((gauge) => gauge.siteId === "11447650")!;
    expect(buildGaugeMetrics(freeport, asOf)).toMatchObject({
      latestStage: 14.8,
      latestStreamflow: 26300,
      stageChange1h: 0.3,
      stageChange6h: 0.6,
      stageChange24h: 0.8,
      direction: "rising",
      freshness: "fresh",
    });
  });

  it("classifies falling gauges", () => {
    const verona = gauges.find((gauge) => gauge.siteId === "11370500")!;
    expect(buildGaugeMetrics(verona, asOf).direction).toBe("falling");
  });

  it("surfaces stale and missing sensor data", () => {
    const american = gauges.find((gauge) => gauge.siteId === "11446500")!;
    const result = buildGaugeMetrics(american, asOf);
    expect(result.freshness).toBe("missing");
    expect(result.direction).toBe("unknown");
    expect(result.stageFreshness).toBe("stale");
    expect(result.streamflowFreshness).toBe("missing");
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
    freeport.streamflow!.observations = [
      { at: "2026-07-29T08:00:00.000Z", value: 26000 },
    ];
    const result = buildGaugeMetrics(freeport, asOf);
    expect(result.latestAt).toBe("2026-07-29T12:00:00.000Z");
    expect(result.freshness).toBe("stale");
    expect(result.dataIssues).toContain(
      "Streamflow reading is more than two hours old",
    );
  });
});
