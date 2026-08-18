import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/openaq/sacramento-hourly.json";
import {
  OPENAQ_MAX_TOTAL_MEASUREMENTS,
  parseOpenAqHourlySnapshot,
} from "./openaq";

/**
 * The same categories `usgs.test.ts` proves for the river parser, because
 * the point of a second domain is that it meets the first one's bar: refuse
 * malformed input loudly, bound what a payload can cost, and emit stations
 * whose provenance a dashboard can cite.
 */

function bundle(): Record<string, unknown> {
  return structuredClone(fixture) as unknown as Record<string, unknown>;
}

describe("parsing the checked-in Sacramento fixture", () => {
  it("normalizes identity, vocabulary, coordinates, and observations", () => {
    const stations = parseOpenAqHourlySnapshot(fixture);

    expect(stations).toHaveLength(3);
    const delPaso = stations.find((station) => station.siteId === "678")!;
    expect(delPaso).toMatchObject({
      name: "Sacramento — Downtown",
      group: "Sacramento",
      kindLabel: "monitor",
      primaryLabel: "PM2.5",
      secondaryLabel: "Ozone",
      evidencePrefix: "openaq",
      sourceName: "OpenAQ",
      latitude: 38.5946,
      longitude: -121.493,
    });
    expect(delPaso.primary?.unit).toBe("µg/m³");
    expect(delPaso.primary?.observations).toHaveLength(6);
    expect(delPaso.secondary?.unit).toBe("ppm");
    expect(delPaso.sourceUrl).toBe("https://explore.openaq.org/locations/678");
  });

  it("sorts observations oldest first whatever order the wire used", () => {
    const input = bundle();
    const hours = (input.hours as Record<string, { results: unknown[] }>)[
      "1556"
    ]!;
    hours.results = [...hours.results].reverse();

    const stations = parseOpenAqHourlySnapshot(input);
    const observations = stations.find((station) => station.siteId === "678")!
      .primary!.observations;

    expect(observations.map((observation) => observation.at)).toEqual(
      [...observations.map((observation) => observation.at)].sort(),
    );
  });

  it("keeps the degraded monitor, with its missing ozone and stale hours intact", () => {
    // Mirrors the river fixture's deliberately degraded gauge: a dashboard
    // with nothing to warn about proves the warning path never runs.
    const woodland = parseOpenAqHourlySnapshot(fixture).find(
      (station) => station.siteId === "627",
    )!;

    expect(woodland.secondary).toBeUndefined();
    expect(woodland.primary?.observations.at(-1)?.at).toBe(
      "2026-08-18T09:00:00.000Z",
    );
  });
});

describe("what the parser refuses", () => {
  it("rejects a pm25 sensor in the wrong units instead of mislabeling readings", () => {
    const input = bundle();
    const locations = input.locations as {
      results: Array<{ sensors: Array<{ parameter: { units: string } }> }>;
    };
    locations.results[0]!.sensors[0]!.parameter.units = "ppb";

    expect(() => parseOpenAqHourlySnapshot(input)).toThrow(/must use µg\/m³/);
  });

  it("rejects a measurement from after the snapshot was taken", () => {
    const input = bundle();
    const hours = input.hours as Record<
      string,
      { results: Array<{ period: { datetimeTo: { utc: string } } }> }
    >;
    hours["1556"]!.results[0]!.period.datetimeTo.utc = "2027-01-01T00:00:00Z";

    expect(() => parseOpenAqHourlySnapshot(input)).toThrow(
      /must not end after the bundle's retrievedAt/,
    );
  });

  it("rejects a payload over the cumulative measurement budget", () => {
    const input = bundle();
    const hours = input.hours as Record<
      string,
      { results: Array<Record<string, unknown>> }
    >;
    // Minimal legal measurements, so the cumulative budget is what trips —
    // the fixture's full-fat entries would hit the byte limit first, which is
    // a different guard.
    const template = {
      value: 1,
      period: { datetimeTo: { utc: "2026-08-18T00:00:00Z" } },
    };
    hours["1556"]!.results = Array.from({ length: 10_000 }, () => template);
    hours["1548"]!.results = Array.from({ length: 10_000 }, () => template);
    hours["2309"]!.results = Array.from({ length: 1 }, () => template);

    expect(() => parseOpenAqHourlySnapshot(input)).toThrow(
      new RegExp(`${OPENAQ_MAX_TOTAL_MEASUREMENTS}-measurement`),
    );
  });

  it("rejects a bundle whose shape is not OpenAQ's", () => {
    expect(() => parseOpenAqHourlySnapshot({ anything: true })).toThrow();
    expect(() => parseOpenAqHourlySnapshot(null)).toThrow();
  });
});

describe("what the parser skips rather than invents", () => {
  it("drops low-cost sensors instead of blending calibration classes", () => {
    const input = bundle();
    const locations = input.locations as {
      results: Array<{ isMonitor: boolean }>;
    };
    locations.results[0]!.isMonitor = false;

    const stations = parseOpenAqHourlySnapshot(input);
    expect(stations.map((station) => station.siteId)).not.toContain("678");
  });

  it("drops negative concentrations, which some instruments report near zero", () => {
    const input = bundle();
    const hours = input.hours as Record<
      string,
      { results: Array<{ value: number }> }
    >;
    hours["1556"]!.results[0]!.value = -0.4;

    const stations = parseOpenAqHourlySnapshot(input);
    expect(
      stations
        .find((station) => station.siteId === "678")!
        .primary!.observations.every((observation) => observation.value >= 0),
    ).toBe(true);
  });

  it("emits a station whose sensor has no hours, so the missing reading is reported not hidden", () => {
    const input = bundle();
    delete (input.hours as Record<string, unknown>)["1548"];

    const delPaso = parseOpenAqHourlySnapshot(input).find(
      (station) => station.siteId === "678",
    )!;

    expect(delPaso.secondary).toBeUndefined();
    expect(delPaso.primary?.observations).toHaveLength(6);
  });
});
