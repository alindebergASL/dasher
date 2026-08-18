import {
  deriveStationFacts,
  type DeriveStationFactsOptions,
  type StationComputation,
  type StationFacts,
  type StationMetrics,
  type StationWords,
} from "@dasher/station-domain";

/**
 * The river half of the split that ADR-007 finished: the generic mechanics
 * moved to `@dasher/station-domain`, and what remains here is exactly what a
 * second domain should NOT inherit — the river's words and the river's
 * numbers. If something in this file looks structural, it is in the wrong
 * file.
 */

/**
 * The river's computation policy: its tolerances and its words for Dasher's
 * arithmetic. This is what `compilePlan` applies when no other domain's
 * policy is passed — the river is the default domain, stated as data.
 */
export const RIVER_COMPUTATION: StationComputation = {
  directionTolerance: 0.05,
  materialRiseTolerance: 0.05,
  toleranceUnit: "ft",
  calculations: {
    label: "Dasher river calculations",
    detail:
      "One-, six-, and 24-hour changes are calculated from the nearest qualifying USGS observations. Rising/falling uses a 0.05-foot tolerance.",
  },
};

export type DeriveRiverFactsOptions = Omit<
  DeriveStationFactsOptions,
  "calculations" | "materialRiseTolerance"
>;

export function deriveRiverFacts(
  metrics: StationMetrics[],
  options: DeriveRiverFactsOptions,
): StationFacts {
  return deriveStationFacts(metrics, {
    ...options,
    calculations: RIVER_COMPUTATION.calculations,
    materialRiseTolerance: RIVER_COMPUTATION.materialRiseTolerance,
  });
}

/** The river evidence namespace, kept callable by site id alone. */
export function gaugeEvidenceId(siteId: string): string {
  return `usgs-${siteId}`;
}

/**
 * The river's words, byte-for-byte the sentences the product has always
 * shown. `compilePlan` applies these when no other domain's words are
 * passed; the e2e suite pins the visible result, which is what keeps this
 * object honest.
 */
export const RIVER_WORDS: StationWords = {
  slug: "river",
  noun: "gauge",
  nounPlural: "gauges",
  reading: "water-level",
  columns: {
    station: "Gauge",
    primary: "Water level",
    secondary: "Streamflow",
  },
  notice:
    "USGS readings may be provisional and subject to revision. Planning view only; use USGS and local emergency-management sources for official conditions and warnings.",
  source: {
    label: "River gauge readings",
    detail:
      "Water level, streamflow, location, and timestamps from USGS-format observations.",
    format: "USGS-format",
  },
};
