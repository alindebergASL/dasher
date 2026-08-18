import {
  deriveStationFacts,
  type DeriveStationFactsOptions,
  type StationFacts,
  type StationMetrics,
} from "@dasher/station-domain";

/**
 * The river half of the split that ADR-007 finished: the generic mechanics
 * moved to `@dasher/station-domain`, and what remains here is exactly what a
 * second domain should NOT inherit — the river's words and the river's
 * numbers. If something in this file looks structural, it is in the wrong
 * file.
 */

/** How the river domain describes Dasher's own arithmetic, as evidence. */
const RIVER_CALCULATIONS = {
  label: "Dasher river calculations",
  detail:
    "One-, six-, and 24-hour changes are calculated from the nearest qualifying USGS observations. Rising/falling uses a 0.05-foot tolerance.",
} as const;

/** A material rise for a river gauge: 0.05 ft over an hour. */
const RIVER_MATERIAL_RISE_TOLERANCE = 0.05;

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
    calculations: RIVER_CALCULATIONS,
    materialRiseTolerance: RIVER_MATERIAL_RISE_TOLERANCE,
  });
}

/** The river evidence namespace, kept callable by site id alone. */
export function gaugeEvidenceId(siteId: string): string {
  return `usgs-${siteId}`;
}
