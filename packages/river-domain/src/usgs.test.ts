import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  USGS_MAX_TOTAL_OBSERVATIONS,
  USGS_PAYLOAD_MAX_BYTES,
  USGS_STRING_LIMITS,
  parseUsgsInstantaneousValues,
} from "./usgs";

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

  it("rejects responses with an excessive number of time series", () => {
    const input = structuredClone(fixture);
    input.value.timeSeries = Array.from({ length: 61 }, () =>
      structuredClone(fixture.value.timeSeries[0]!),
    );

    expect(() => parseUsgsInstantaneousValues(input)).toThrow();
  });

  it("rejects a time series with an excessive number of observations", () => {
    const input = structuredClone(fixture);
    input.value.timeSeries[0]!.values[0]!.value = Array.from(
      { length: 10_001 },
      (_, index) => ({
        value: String(index),
        qualifiers: [],
        dateTime: "2026-07-29T12:00:00.000Z",
      }),
    );

    expect(() => parseUsgsInstantaneousValues(input)).toThrow();
  });

  it("rejects oversized strings in the USGS payload", () => {
    const input = structuredClone(fixture);
    input.value.timeSeries[0]!.sourceInfo.siteName = "s".repeat(
      USGS_STRING_LIMITS.siteName + 1,
    );

    expect(() => parseUsgsInstantaneousValues(input)).toThrow();
  });

  it("rejects an oversized serialized USGS payload before Zod parsing", () => {
    const input = structuredClone(fixture) as Record<string, unknown>;
    input.padding = "x".repeat(USGS_PAYLOAD_MAX_BYTES);

    expect(() => parseUsgsInstantaneousValues(input)).toThrow(
      /exceeds the 5242880-byte serialized limit/,
    );
  });

  it("rejects payloads over the cumulative observation budget", () => {
    const input = structuredClone(fixture);
    const timeSeries = input.value.timeSeries[0]!;
    const fullGroup = Array.from({ length: 10_000 }, (_, index) => ({
      value: String(index),
      qualifiers: [],
      dateTime: "2026-07-29T12:00:00.000Z",
    }));
    timeSeries.values = [
      { value: fullGroup },
      { value: structuredClone(fullGroup) },
      {
        value: [
          {
            value: String(USGS_MAX_TOTAL_OBSERVATIONS),
            qualifiers: [],
            dateTime: "2026-07-29T12:00:00.000Z",
          },
        ],
      },
    ];

    expect(() => parseUsgsInstantaneousValues(input)).toThrow(
      /observation cumulative limit/,
    );
  });

  it("still parses the checked-in Sacramento fixture unchanged", () => {
    const gauges = parseUsgsInstantaneousValues(fixture);

    expect(gauges).toHaveLength(3);
    expect(
      gauges.map(({ siteId, stage, streamflow }) => ({
        siteId,
        stageObservations: stage?.observations.length ?? 0,
        streamflowObservations: streamflow?.observations.length ?? 0,
      })),
    ).toEqual([
      {
        siteId: "11446500",
        stageObservations: 3,
        streamflowObservations: 0,
      },
      {
        siteId: "11447650",
        stageObservations: 4,
        streamflowObservations: 4,
      },
      {
        siteId: "11370500",
        stageObservations: 4,
        streamflowObservations: 4,
      },
    ]);
  });
});
