import { describe, expect, it } from "vitest";

import { classifyRequest, DOMAIN_CATALOG } from "./domains";
import { loadDomainSnapshot } from "./source-runtime";

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

describe("requests that name the known UCR enrollment source", () => {
  it.each([
    "UC Riverside enrollment",
    "Current student enrollment at UCR",
    "How many students are enrolled at the University of California, Riverside?",
  ])("routes %j to the captured official snapshot", (text) => {
    expect(classifyRequest(text)).toEqual({
      kind: "known-source",
      source: "ucr-enrollment",
    });
  });
});

describe("requests that do not", () => {
  it.each([
    "UC Riverside tuition",
    "Riverside enrollment",
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
    "compare UCR enrollment with Sacramento air quality",
    "UCR enrollment and river levels",
    "UCR enrollment, river levels, and air quality",
  ])("calls %j ambiguous instead of picking for the reader", (text) => {
    // Still refused, and for a reason that did not go away when river+air
    // became supported: enrollment is not a station. Composing it beside a
    // sensor domain would need a shape the product does not have, and
    // guessing which subject the reader meant is the failure this router
    // exists to prevent.
    expect(classifyRequest(text)).toEqual({ kind: "ambiguous" });
  });
});

describe("requests that name both sensor domains", () => {
  it.each([
    "Compare river conditions and air quality near Sacramento",
    "flood risk and smoke forecast for Sacramento",
    "air quality and river levels near Sacramento",
    "smoke and streamflow",
  ])("binds %j to both sources instead of refusing it", (text) => {
    // The change this slice is about: fail-closed moved from refusing the
    // PLURAL to refusing the UNRESOLVABLE. Two of these were `ambiguous`
    // before, and the refusal they got was the product declining to answer a
    // question it could answer.
    expect(classifyRequest(text)).toEqual({
      kind: "domains",
      domains: [DOMAIN_CATALOG.river, DOMAIN_CATALOG.air],
    });
  });

  it("orders the binding set by the catalog, not by the request", () => {
    // "air ... river" and "river ... air" must produce the same dashboard.
    // Ordering by first mention would make the page layout depend on how the
    // reader phrased the question.
    const riverFirst = classifyRequest("river levels and air quality");
    const airFirst = classifyRequest("air quality and river levels");
    expect(riverFirst).toEqual(airFirst);
    expect(
      riverFirst.kind === "domains"
        ? riverFirst.domains.map((domain) => domain.key)
        : [],
    ).toEqual(["river", "air"]);
  });

  it("does not treat one domain named twice as two sources", () => {
    // "river" and "streamflow" are both river signals; naming both is still a
    // single-source request, and composing a dashboard with itself would
    // collide every structural id.
    expect(classifyRequest("river levels and streamflow")).toEqual({
      kind: "domain",
      domain: DOMAIN_CATALOG.river,
    });
  });
});

describe("the catalog entries are complete and their own", () => {
  it("pairs each domain's computation, words, phrasing, and refusal label", () => {
    const { river, air } = DOMAIN_CATALOG;

    expect(river.words.noun).toBe("gauge");
    expect(air.words.noun).toBe("monitor");
    expect(river.computation.toleranceUnit).toBe("ft");
    expect(air.computation.toleranceUnit).toBe("µg/m³");
    expect(river.label).toBe("river");
    expect(air.label).toBe("air-quality");
  });

  it("names thresholds that exist in the domain's own snapshot", async () => {
    // A rule referencing the other domain's site id would silently never
    // fire. The snapshot comes from the source runtime now rather than the
    // catalog, so this checks the pairing across that seam.
    for (const entry of [DOMAIN_CATALOG.river, DOMAIN_CATALOG.air]) {
      const snapshot = await loadDomainSnapshot(entry.key);
      expect(snapshot.stations.length).toBeGreaterThan(0);
      for (const threshold of entry.thresholds) {
        expect(snapshot.stations.map((station) => station.siteId)).toContain(
          threshold.siteId,
        );
      }
      // Every station's retrieval time is at or before the snapshot's asOf,
      // which is what keeps freshness judgements meaningful.
      for (const station of snapshot.stations) {
        expect(Date.parse(station.retrievedAt)).toBeLessThanOrEqual(
          Date.parse(snapshot.asOf),
        );
      }
    }
  });
});
