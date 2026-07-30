import type { GaugeSeries, Observation, RiverGauge } from "./usgs";

export type TrendDirection = "rising" | "falling" | "steady" | "unknown";

export interface GaugeMetrics {
  gauge: RiverGauge;
  latestStage: number | null;
  latestStreamflow: number | null;
  latestAt: string | null;
  stageChange1h: number | null;
  stageChange6h: number | null;
  stageChange24h: number | null;
  direction: TrendDirection;
  freshness: "fresh" | "stale" | "missing";
  stageFreshness: "fresh" | "stale" | "missing";
  streamflowFreshness: "fresh" | "stale" | "missing";
  dataIssues: string[];
  stagePoints: Observation[];
}

function latest(series?: GaugeSeries): Observation | null {
  return series?.observations.at(-1) ?? null;
}

function changeOverHours(
  series: GaugeSeries | undefined,
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
): TrendDirection {
  const change = change1h ?? change6h;
  if (change === null) return "unknown";
  if (change > 0.05) return "rising";
  if (change < -0.05) return "falling";
  return "steady";
}

export function buildGaugeMetrics(
  gauge: RiverGauge,
  asOf: string,
): GaugeMetrics {
  const stage = latest(gauge.stage);
  const streamflow = latest(gauge.streamflow);
  const latestAt =
    [stage?.at, streamflow?.at]
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
  const stageFreshness = sensorFreshness(stage);
  const streamflowFreshness = sensorFreshness(streamflow);

  if (!stage) {
    dataIssues.push("Water-level readings are missing");
  } else if (isStale(stage)) {
    dataIssues.push("Water-level reading is more than two hours old");
  }
  if (!streamflow) {
    dataIssues.push("Streamflow readings are missing");
  } else if (isStale(streamflow)) {
    dataIssues.push("Streamflow reading is more than two hours old");
  }

  let freshness: GaugeMetrics["freshness"] = "fresh";
  if (stageFreshness === "missing" || streamflowFreshness === "missing") {
    freshness = "missing";
  } else if (stageFreshness === "stale" || streamflowFreshness === "stale") {
    freshness = "stale";
  }

  const stageChange1h = changeOverHours(gauge.stage, 1);
  const stageChange6h = changeOverHours(gauge.stage, 6);
  const stageChange24h = changeOverHours(gauge.stage, 24);

  return {
    gauge,
    latestStage: stage?.value ?? null,
    latestStreamflow: streamflow?.value ?? null,
    latestAt,
    stageChange1h,
    stageChange6h,
    stageChange24h,
    direction:
      stageFreshness === "fresh"
        ? classify(stageChange1h, stageChange6h)
        : "unknown",
    freshness,
    stageFreshness,
    streamflowFreshness,
    dataIssues,
    stagePoints: gauge.stage?.observations ?? [],
  };
}
