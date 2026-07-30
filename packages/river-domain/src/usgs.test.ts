import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { parseUsgsInstantaneousValues } from "./usgs";

describe("parseUsgsInstantaneousValues", () => {
  it("normalizes USGS station identity, units, coordinates, and observations", () => {
    const gauges = parseUsgsInstantaneousValues(fixture);
    expect(gauges).toHaveLength(3);

    const freeport = gauges.find((gauge) => gauge.siteId === "11447650");
    expect(freeport).toMatchObject({
      river: "Sacramento River",
      latitude: 38.45657,
      longitude: -121.5019,
      retrievedAt: "2026-07-29T12:02:00.000Z",
    });
    expect(freeport?.stage?.unit).toBe("ft");
    expect(freeport?.streamflow?.unit).toBe("ft3/s");
    expect(freeport?.stage?.observations.at(-1)?.value).toBe(14.8);
  });

  it("removes the USGS no-data sentinel rather than treating it as a reading", () => {
    const gauges = parseUsgsInstantaneousValues(fixture);
    const american = gauges.find((gauge) => gauge.siteId === "11446500");
    expect(american?.streamflow?.observations).toEqual([]);
  });

  it("rejects malformed source data", () => {
    expect(() =>
      parseUsgsInstantaneousValues({ value: { timeSeries: [] } }),
    ).toThrow();
  });

  it("rejects invalid station IDs and parameter/unit mismatches", () => {
    const invalidSite = structuredClone(fixture);
    invalidSite.value.timeSeries[0]!.sourceInfo.siteCode[0]!.value = "../admin";
    expect(() => parseUsgsInstantaneousValues(invalidSite)).toThrow(
      /Invalid USGS site ID/,
    );

    const invalidUnit = structuredClone(fixture);
    invalidUnit.value.timeSeries[0]!.variable.unit.unitCode = "m";
    expect(() => parseUsgsInstantaneousValues(invalidUnit)).toThrow(
      /must use ft/,
    );
  });

  it("does not coerce blank readings to zero", () => {
    const input = structuredClone(fixture);
    input.value.timeSeries[0]!.values[0]!.value[0]!.value = "   ";
    const gauges = parseUsgsInstantaneousValues(input);
    const series = gauges.find((gauge) => gauge.siteId === "11447650")!.stage!;
    expect(series.observations.some((item) => item.value === 0)).toBe(false);
  });
});
