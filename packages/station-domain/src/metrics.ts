import type { Observation, Series, Station } from "./station";

export type TrendDirection = "rising" | "falling" | "steady" | "unknown";

export interface StationMetrics {
  station: Station;
  latestPrimary: number | null;
  latestSecondary: number | null;
  latestAt: string | null;
  primaryChange1h: number | null;
  primaryChange6h: number | null;
  primaryChange24h: number | null;
  direction: TrendDirection;
  freshness: "fresh" | "stale" | "missing";
  primaryFreshness: "fresh" | "stale" | "missing";
  secondaryFreshness: "fresh" | "stale" | "missing";
  dataIssues: string[];
  primaryPoints: Observation[];
}

export interface BuildStationMetricsOptions {
  /**
   * The change below which a primary reading counts as steady, in the
   * primary series' own unit. 0.05 is the river default (feet); a domain
   * whose readings live on a different scale supplies its own.
   */
  directionTolerance?: number;
}

const DEFAULT_DIRECTION_TOLERANCE = 0.05;

function latest(series?: Series): Observation | null {
  return series?.observations.at(-1) ?? null;
}

function changeOverHours(
  series: Series | undefined,
  hours: number,
): number | null {
  const current = latest(series);
  if (!current || !series) return null;
  const targetMs = Date.parse(current.at) - hours * 60 * 60 * 1000;
  const candidates = series.observations.filter(
    (item) => Date.parse(item.at) <= targetMs,
  );
  const prior = candidates.at(-1);
  if (!prior) return null;
  const distanceMs = targetMs - Date.parse(prior.at);
  if (distanceMs > 90 * 60 * 1000) return null;
  return Number((current.value - prior.value).toFixed(2));
}

function classify(
  change1h: number | null,
  change6h: number | null,
  tolerance: number,
): TrendDirection {
  const change = change1h ?? change6h;
  if (change === null) return "unknown";
  if (change > tolerance) return "rising";
  if (change < -tolerance) return "falling";
  return "steady";
}

export function buildStationMetrics(
  station: Station,
  asOf: string,
  options: BuildStationMetricsOptions = {},
): StationMetrics {
  const tolerance = options.directionTolerance ?? DEFAULT_DIRECTION_TOLERANCE;
  const primary = latest(station.primary);
  const secondary = latest(station.secondary);
  const latestAt =
    [primary?.at, secondary?.at]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1) ?? null;
  const dataIssues: string[] = [];
  const staleAfterMs = 2 * 60 * 60 * 1000;
  const isStale = (observation: Observation | null) =>
    observation !== null &&
    Date.parse(asOf) - Date.parse(observation.at) > staleAfterMs;
  const sensorFreshness = (
    observation: Observation | null,
  ): "fresh" | "stale" | "missing" =>
    observation === null ? "missing" : isStale(observation) ? "stale" : "fresh";
  const primaryFreshness = sensorFreshness(primary);
  const secondaryFreshness = sensorFreshness(secondary);

  // The issue prose takes its noun from the station so a river gauge still
  // says "Water-level readings are missing" and an air monitor never does —
  // including when the series itself is absent, which is exactly the case
  // the message is for.
  if (!primary) {
    dataIssues.push(`${station.primaryLabel} readings are missing`);
  } else if (isStale(primary)) {
    dataIssues.push(
      `${station.primaryLabel} reading is more than two hours old`,
    );
  }
  if (!secondary) {
    dataIssues.push(`${station.secondaryLabel} readings are missing`);
  } else if (isStale(secondary)) {
    dataIssues.push(
      `${station.secondaryLabel} reading is more than two hours old`,
    );
  }

  let freshness: StationMetrics["freshness"] = "fresh";
  if (primaryFreshness === "missing" || secondaryFreshness === "missing") {
    freshness = "missing";
  } else if (primaryFreshness === "stale" || secondaryFreshness === "stale") {
    freshness = "stale";
  }

  const primaryChange1h = changeOverHours(station.primary, 1);
  const primaryChange6h = changeOverHours(station.primary, 6);
  const primaryChange24h = changeOverHours(station.primary, 24);

  return {
    station,
    latestPrimary: primary?.value ?? null,
    latestSecondary: secondary?.value ?? null,
    latestAt,
    primaryChange1h,
    primaryChange6h,
    primaryChange24h,
    direction:
      primaryFreshness === "fresh"
        ? classify(primaryChange1h, primaryChange6h, tolerance)
        : "unknown",
    freshness,
    primaryFreshness,
    secondaryFreshness,
    dataIssues,
    primaryPoints: station.primary?.observations ?? [],
  };
}
