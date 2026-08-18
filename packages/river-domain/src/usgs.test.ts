import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import liveCapture from "../../../fixtures/usgs/live-capture-2026-08-18.json";
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
      group: "Sacramento River",
      latitude: 38.45657,
      longitude: -121.5019,
      retrievedAt: "2026-07-29T12:02:00.000Z",
    });
    expect(freeport?.primary?.unit).toBe("ft");
    expect(freeport?.secondary?.unit).toBe("ft3/s");
    expect(freeport?.primary?.observations.at(-1)?.value).toBe(14.8);
  });

  it("reads an accessor exactly once and normalizes its JSON snapshot", () => {
    const input = structuredClone(fixture) as Record<string, unknown>;
    const value = input.value;
    let reads = 0;
    Object.defineProperty(input, "value", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("value was read more than once");
        }
        return value;
      },
    });

    expect(parseUsgsInstantaneousValues(input)).toHaveLength(3);
    expect(reads).toBe(1);
  });

  it("sanitizes hostile access errors without retaining their cause", () => {
    const secret = "attacker-secret-usgs-value";
    const input = new Proxy(structuredClone(fixture), {
      get() {
        throw new Error(secret);
      },
    });

    try {
      parseUsgsInstantaneousValues(input);
      expect.unreachable("Hostile input should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "USGS payload must be JSON-serializable",
      );
      expect((error as Error).message).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("normalizes the same representation returned by toJSON", () => {
    const input = structuredClone(fixture);
    input.value.timeSeries = Array.from({ length: 61 }, () =>
      structuredClone(fixture.value.timeSeries[0]!),
    );
    let calls = 0;
    const withToJSON = input as typeof input & { toJSON: () => typeof fixture };
    withToJSON.toJSON = () => {
      calls += 1;
      return structuredClone(fixture);
    };

    expect(parseUsgsInstantaneousValues(withToJSON)).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it("removes the USGS no-data sentinel rather than treating it as a reading", () => {
    const gauges = parseUsgsInstantaneousValues(fixture);
    const american = gauges.find((gauge) => gauge.siteId === "11446500");
    expect(american?.secondary?.observations).toEqual([]);
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
    const series = gauges.find(
      (gauge) => gauge.siteId === "11447650",
    )!.primary!;
    expect(series.observations.some((item) => item.value === 0)).toBe(false);
  });

  it("rejects observations after the USGS query creation time", () => {
    const input = structuredClone(fixture);
    input.value.timeSeries[0]!.values[0]!.value[0]!.dateTime =
      "2026-07-29T12:03:00.000Z";

    expect(() => parseUsgsInstantaneousValues(input)).toThrow(
      /observation dateTime must not be after queryInfo\.creationTime/,
    );
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

  it("rejects undefined, non-serializable, and circular input with a fixed error", () => {
    const circular = structuredClone(fixture) as Record<string, unknown>;
    circular.circular = circular;

    for (const input of [undefined, 1n, circular]) {
      try {
        parseUsgsInstantaneousValues(input);
        expect.unreachable("Non-serializable input should be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "USGS payload must be JSON-serializable",
        );
        expect(error).not.toHaveProperty("cause");
      }
    }
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
      gauges.map(({ siteId, primary, secondary }) => ({
        siteId,
        stageObservations: primary?.observations.length ?? 0,
        streamflowObservations: secondary?.observations.length ?? 0,
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

describe("a real response from the live service", () => {
  /**
   * A bounded verbatim capture from waterservices.usgs.gov, trimmed to the
   * last four observations per series and otherwise untouched.
   *
   * It exists because the parser could not read one. The development fixture
   * is hand-authored and carries `queryInfo.creationTime`; the real service
   * carries no such field and reports when it answered in a `requestDT`
   * note. Every live request would have failed at the schema, and nothing
   * caught it because nothing had ever handed this function a real payload.
   */
  it("parses the shape the service actually sends", () => {
    const stations = parseUsgsInstantaneousValues(liveCapture);

    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) {
      // The retrieval time came from the requestDT note, which is the only
      // place the live payload carries it.
      expect(station.retrievedAt).toBe("2026-08-18T22:29:20.423Z");
      expect(station.primary?.unit).toBe("ft");
      expect(station.kindLabel).toBe("gauge");
    }
    expect(stations.map((station) => station.siteId)).toContain("11447650");
  });

  it("refuses a payload carrying no retrieval time at all", () => {
    // Neither shape present. Defaulting it would invent provenance: this
    // timestamp becomes every station's retrievedAt and bounds the
    // future-observation check.
    const undated = structuredClone(liveCapture) as {
      value: { queryInfo: { note?: unknown } };
    };
    undated.value.queryInfo.note = [{ title: "server", value: "vaas01" }];

    expect(() => parseUsgsInstantaneousValues(undated)).toThrow(
      /must carry a retrieval time/,
    );
  });
});
