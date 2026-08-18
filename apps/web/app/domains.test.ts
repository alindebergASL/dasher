import { describe, expect, it } from "vitest";

import { classifyRequest, DOMAIN_CATALOG } from "./domains";

/**
 * The router's whole contract: deterministic, and closed on failure. The
 * dangerous outcome is not a wrong answer, it is a confident one — a request
 * about something else quietly producing a Sacramento river dashboard.
 */

describe("requests that name a domain", () => {
  it.each([
    "Create a live dashboard monitoring river gauges near Sacramento",
    "I need a flood watch view for emergency response",
    "Which gauges are rising fastest?",
    "How is the American river doing?",
    "show me streamflow trends",
  ])("routes %j to the river", (text) => {
    const decision = classifyRequest(text);
    expect(decision.kind).toBe("domain");
    if (decision.kind === "domain") {
      expect(decision.domain.key).toBe("river");
    }
  });

  it.each([
    "Build an air-quality dashboard for Sacramento",
    "air quality across Sacramento",
    "How bad is the smoke today?",
    "Show me PM2.5 near downtown",
    "what's the AQI right now",
    "ozone levels this afternoon",
  ])("routes %j to air", (text) => {
    const decision = classifyRequest(text);
    expect(decision.kind).toBe("domain");
    if (decision.kind === "domain") {
      expect(decision.domain.key).toBe("air");
    }
  });
});

describe("requests that do not", () => {
  it.each([
    "UC Riverside enrollment",
    "Show me a dashboard",
    "stock prices for tomorrow",
    "the fairground schedule",
    "",
  ])("refuses %j as unsupported rather than guessing", (text) => {
    // Word boundaries carry the first case: "Riverside" contains r-i-v-e-r
    // and must not read as "river". A substring match here is exactly the
    // silent river fallback this router exists to end.
    expect(classifyRequest(text)).toEqual({ kind: "unsupported" });
  });

  it.each([
    "compare river conditions and air quality",
    "flood risk and smoke forecast for Sacramento",
  ])("calls %j ambiguous instead of picking for the reader", (text) => {
    expect(classifyRequest(text)).toEqual({ kind: "ambiguous" });
  });
});

describe("the catalog entries are complete and their own", () => {
  it("pairs each domain's stations with its computation, words, and planner phrasing", () => {
    const { river, air } = DOMAIN_CATALOG;

    expect(river.stations.length).toBeGreaterThan(0);
    expect(air.stations.length).toBeGreaterThan(0);
    expect(river.words.noun).toBe("gauge");
    expect(air.words.noun).toBe("monitor");
    expect(river.computation.toleranceUnit).toBe("ft");
    expect(air.computation.toleranceUnit).toBe("µg/m³");
    // A threshold names a station that exists in its own domain — a rule
    // referencing the other catalog's site id would silently never fire.
    for (const entry of [river, air]) {
      for (const threshold of entry.thresholds) {
        expect(entry.stations.map((station) => station.siteId)).toContain(
          threshold.siteId,
        );
      }
    }
    // The fixture's asOf matches its stations' retrieval time, which is what
    // keeps freshness judgements meaningful in fixture mode.
    for (const entry of [river, air]) {
      expect(
        entry.stations.every(
          (station) =>
            Date.parse(station.retrievedAt) <= Date.parse(entry.asOf),
        ),
      ).toBe(true);
    }
  });
});
