import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  buildStationMetrics,
  CALCULATION_EVIDENCE_ID,
  signed,
  type Station,
} from "@dasher/station-domain";

import { deriveRiverFacts } from "./facts";
import { parseUsgsInstantaneousValues } from "./usgs";

/**
 * The judgements themselves, tested apart from any layout.
 *
 * These rules were previously covered only through `createRiverDashboard`, a
 * fixed-page composition that has since been deleted. Testing them through a
 * dashboard meant asserting rendered prose and component ordering to reach a
 * rule about a river, and it tied the rules' coverage to the survival of one
 * particular way of arranging them — when that composition went, so did the
 * assurance, and the mutation gate caught the drop.
 *
 * Stated directly, each test names a claim a reader is entitled to rely on.
 */

const AS_OF = "2026-07-29T12:02:00.000Z";
const gauges = parseUsgsInstantaneousValues(fixture);
const site = "11447650";

function metricsFor(input: readonly Station[], asOf = AS_OF) {
  return input.map((gauge) => buildStationMetrics(gauge, asOf));
}

/**
 * The fixture carries one deliberately degraded gauge, which is what gives the
 * demo something to warn about. Cases about the clear path select against that
 * rather than naming the site, so the set stays right if the fixture changes.
 */
const cleanGauges = gauges.filter((gauge) => {
  const item = buildStationMetrics(gauge, AS_OF);
  return item.freshness === "fresh" && item.dataIssues.length === 0;
});

/** The same gauges, rewritten so every stage series falls steadily. */
function falling(): Station[] {
  return gauges.slice(0, 2).map((gauge) => {
    const copy = structuredClone(gauge);
    copy.primary!.observations = copy.primary!.observations.map(
      (observation, index) => ({ ...observation, value: 20 - index }),
    );
    return copy;
  });
}

describe("which gauges rank as fastest rising", () => {
  it("ranks fresh rising gauges fastest first", () => {
    const { ranked } = deriveRiverFacts(metricsFor(gauges), { asOf: AS_OF });
    const changes = ranked.map((item) => item.primaryChange1h ?? 0);
    expect(changes).toEqual([...changes].sort((a, b) => b - a));
    expect(ranked.every((item) => (item.primaryChange1h ?? 0) > 0.05)).toBe(
      true,
    );
  });

  it("ranks no falling gauge, however gently it falls", () => {
    // The least-negative of several falling gauges is still falling. Ranking it
    // would put a receding river at the top of a list headed "fastest rising",
    // which is the most confidently wrong thing this page could say.
    const { ranked, falling: fell } = deriveRiverFacts(metricsFor(falling()), {
      asOf: AS_OF,
    });
    expect(fell.length).toBeGreaterThan(0);
    expect(ranked).toEqual([]);
  });

  it("ranks no gauge whose readings are stale", () => {
    const stale = deriveRiverFacts(
      metricsFor(gauges, "2026-07-30T12:02:00.000Z"),
      { asOf: AS_OF },
    );
    expect(stale.ranked).toEqual([]);
  });
});

describe("which gauges need a freshness or completeness check", () => {
  it("reports none when every gauge is fresh and complete", () => {
    expect(cleanGauges.length).toBeGreaterThan(0);
    const { staleOrMissing } = deriveRiverFacts(metricsFor(cleanGauges), {
      asOf: AS_OF,
    });
    expect(staleOrMissing.map((item) => item.station.siteId)).toEqual([]);
  });

  it("reports every gauge once its readings are stale", () => {
    // Asserted in both directions on purpose. A test that only checks a stale
    // gauge is flagged passes just as well when every gauge is flagged, which
    // is what inverting this filter does.
    const { staleOrMissing } = deriveRiverFacts(
      metricsFor(gauges, "2026-07-30T12:02:00.000Z"),
      { asOf: AS_OF },
    );
    expect(staleOrMissing).toHaveLength(gauges.length);
  });
});

describe("user-defined thresholds", () => {
  const gauge = gauges.find((candidate) => candidate.siteId === site)!;
  const reading = buildStationMetrics(gauge, AS_OF).latestPrimary!;

  function alertsAt(above: number, asOf = AS_OF) {
    return deriveRiverFacts(metricsFor([gauge], asOf), {
      asOf: AS_OF,
      thresholds: [{ id: "watch", siteId: site, label: "Watch level", above }],
    }).alerts.map((alert) => alert.id);
  }

  it("raises the alert above the threshold", () => {
    expect(alertsAt(reading - 1)).toContain("watch");
  });

  it("does not raise the alert exactly on the threshold", () => {
    expect(alertsAt(reading)).not.toContain("watch");
  });

  it("does not raise the alert below the threshold", () => {
    expect(alertsAt(reading + 1)).not.toContain("watch");
  });

  it("does not raise the alert from a stale reading", () => {
    // A threshold is a claim about conditions now, and a stale reading cannot
    // support one. A flood alert from yesterday's stage is worse than silence.
    expect(alertsAt(reading - 1, "2026-07-30T12:02:00.000Z")).not.toContain(
      "watch",
    );
  });
});

describe("the all-clear", () => {
  it("stands in when nothing else needs saying, citing every gauge it covers", () => {
    const { alerts, stationEvidenceIds } = deriveRiverFacts(
      metricsFor(cleanGauges),
      { asOf: AS_OF },
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe("no-alerts");
    // An all-clear with no evidence behind it is an unsupported claim, and the
    // gauges it covers are exactly what makes it checkable.
    expect(alerts[0]?.evidenceIds).toEqual([
      ...stationEvidenceIds,
      CALCULATION_EVIDENCE_ID,
    ]);
  });

  it("gives way as soon as a real alert exists", () => {
    const { alerts } = deriveRiverFacts(
      metricsFor(gauges, "2026-07-30T12:02:00.000Z"),
      { asOf: AS_OF },
    );
    expect(alerts.map((alert) => alert.id)).not.toContain("no-alerts");
    expect(alerts.length).toBeGreaterThan(0);
  });
});

describe("evidence", () => {
  it("records every gauge, then Dasher's own arithmetic", () => {
    const { evidence, stationEvidenceIds, allEvidenceIds } = deriveRiverFacts(
      metricsFor(gauges),
      { asOf: AS_OF },
    );
    expect(evidence).toHaveLength(gauges.length + 1);
    expect(allEvidenceIds).toEqual([
      ...stationEvidenceIds,
      CALCULATION_EVIDENCE_ID,
    ]);
    expect(evidence.at(-1)?.kind).toBe("calculated");
  });

  it("appends a caller's own record last, and counts it", () => {
    const { evidence, allEvidenceIds } = deriveRiverFacts(metricsFor(gauges), {
      asOf: AS_OF,
      additionalEvidence: [
        {
          id: "composition",
          kind: "interpreted",
          label: "Dashboard composition",
          sourceName: "Test",
          retrievedAt: AS_OF,
          detail: "Who chose the layout.",
          confidence: "medium",
        },
      ],
    });
    expect(evidence.at(-1)?.id).toBe("composition");
    expect(allEvidenceIds.at(-1)).toBe("composition");
  });

  it("names the most recent observation across all gauges", () => {
    const { metrics, latestObservationAt } = deriveRiverFacts(
      metricsFor(gauges),
      { asOf: AS_OF },
    );
    const newest = metrics
      .flatMap((item) => (item.latestAt ? [item.latestAt] : []))
      .sort()
      .at(-1);
    expect(latestObservationAt).toBe(newest);
  });
});

describe("how a change is written for a reader", () => {
  it("says there is not enough history rather than calling it missing", () => {
    // These are different facts and a reader acts on them differently. A
    // missing reading means the sensor told us nothing; too little history
    // means the sensor is fine and the window is short. Extracting this helper
    // collapsed the second into the first, silently, on the rendered path --
    // both copies had agreed on "Not enough history" beforehand.
    expect(signed(null, "ft")).toBe("Not enough history");
  });

  it("marks the direction of a change it can state", () => {
    expect(signed(1.5, "ft")).toBe("+1.5 ft");
    expect(signed(-1.5, "ft")).toBe("-1.5 ft");
    expect(signed(0, "ft")).toBe("0 ft");
  });
});
