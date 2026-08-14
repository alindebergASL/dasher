import type { Evidence } from "@dasher/dashboard-schema";

import type { GaugeMetrics } from "./metrics";

/**
 * The judgements a river dashboard makes, derived once.
 *
 * These rules — which gauges count as rising, which need a freshness check,
 * which thresholds have been breached, and what evidence backs each — used to
 * exist twice, character for character, in `createRiverDashboard` here and in
 * the planner's `compilePlan`. The second copy was made when the planner
 * landed, and the tests did not follow it: the identical mutation died in this
 * package and survived in the planner, so the tested copy was the one nothing
 * rendered and the untested copy was the one readers saw.
 *
 * They had already drifted. The two `no-alerts` messages differed, and nothing
 * asserted either, so nothing could have told anyone which was current.
 *
 * Layout stays with each caller. A fixed-page dashboard and a plan-driven one
 * arrange things differently and should; what they must not do is disagree
 * about whether a gauge is stale.
 */

/** Evidence recorded for Dasher's own arithmetic rather than for a reading. */
export const CALCULATION_EVIDENCE_ID = "calculated-trends";

/** A user's standing instruction to watch a gauge, not a composition choice. */
export interface ThresholdRule {
  id: string;
  siteId: string;
  label: string;
  stageAbove: number;
}

export interface RiverAlert {
  id: string;
  severity: "info" | "attention" | "warning";
  title: string;
  detail: string;
  evidenceIds: string[];
}

export interface RiverFacts {
  metrics: GaugeMetrics[];
  rising: GaugeMetrics[];
  falling: GaugeMetrics[];
  staleOrMissing: GaugeMetrics[];
  /** Fresh, complete gauges rising faster than the tolerance, fastest first. */
  ranked: GaugeMetrics[];
  evidence: Evidence[];
  gaugeEvidenceIds: string[];
  allEvidenceIds: string[];
  alerts: RiverAlert[];
  latestObservationAt: string | undefined;
}

export interface DeriveRiverFactsOptions {
  asOf: string;
  thresholds?: readonly ThresholdRule[];
  /**
   * Evidence the caller contributes about its own role, appended after the
   * observed and calculated records so identifier order stays stable.
   */
  additionalEvidence?: readonly Evidence[];
}

export function gaugeEvidenceId(siteId: string): string {
  return `usgs-${siteId}`;
}

function formatNumber(value: number | null, maximumFractionDigits = 2): string {
  if (value === null) return "Missing";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

export function signed(value: number | null, unit: string): string {
  if (value === null) return "Missing";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)} ${unit}`;
}

export function uniqueEvidenceIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

/** One gauge as a dashboard shows it: computed values, never plan-supplied. */
export function gaugeView(item: GaugeMetrics) {
  return {
    id: item.gauge.siteId,
    name: item.gauge.name,
    river: item.gauge.river,
    latitude: item.gauge.latitude,
    longitude: item.gauge.longitude,
    stage: item.latestStage,
    streamflow: item.latestStreamflow,
    stageUnit: item.gauge.stage?.unit ?? "ft",
    streamflowUnit: item.gauge.streamflow?.unit ?? "ft3/s",
    direction: item.direction,
    freshness: item.freshness,
    evidenceIds: [gaugeEvidenceId(item.gauge.siteId), CALCULATION_EVIDENCE_ID],
  };
}

export function deriveRiverFacts(
  metrics: GaugeMetrics[],
  options: DeriveRiverFactsOptions,
): RiverFacts {
  const rising = metrics.filter(
    (item) => item.stageFreshness === "fresh" && item.direction === "rising",
  );
  const falling = metrics.filter(
    (item) => item.stageFreshness === "fresh" && item.direction === "falling",
  );
  const staleOrMissing = metrics.filter(
    (item) => item.freshness !== "fresh" || item.dataIssues.length > 0,
  );
  const ranked = [...metrics]
    .filter(
      (item) =>
        item.stageChange1h !== null &&
        item.stageChange1h > 0.05 &&
        item.freshness === "fresh" &&
        item.dataIssues.length === 0,
    )
    .sort((a, b) => (b.stageChange1h ?? 0) - (a.stageChange1h ?? 0));

  const evidence: Evidence[] = metrics.map((item) => ({
    id: gaugeEvidenceId(item.gauge.siteId),
    kind: "observed" as const,
    label: `${item.gauge.river} gauge ${item.gauge.siteId}`,
    sourceName: "U.S. Geological Survey",
    sourceUrl: item.gauge.sourceUrl,
    observedAt: item.latestAt ?? undefined,
    retrievedAt: item.gauge.retrievedAt,
    detail: `Water level and streamflow observations for ${item.gauge.name}.`,
    confidence: "high" as const,
  }));

  evidence.push({
    id: CALCULATION_EVIDENCE_ID,
    kind: "calculated",
    label: "Dasher river calculations",
    sourceName: "Dasher",
    retrievedAt: options.asOf,
    detail:
      "One-, six-, and 24-hour changes are calculated from the nearest qualifying USGS observations. Rising/falling uses a 0.05-foot tolerance.",
    confidence: "high",
  });

  evidence.push(...(options.additionalEvidence ?? []));

  const gaugeEvidenceIds = metrics.map((item) =>
    gaugeEvidenceId(item.gauge.siteId),
  );

  const alerts: RiverAlert[] = metrics.flatMap((item) =>
    item.dataIssues.map((detail, index) => ({
      id: `${item.gauge.siteId}-quality-${index}`,
      severity:
        item.freshness === "fresh"
          ? ("attention" as const)
          : ("warning" as const),
      title: item.gauge.river,
      detail,
      evidenceIds: [
        gaugeEvidenceId(item.gauge.siteId),
        CALCULATION_EVIDENCE_ID,
      ],
    })),
  );

  for (const threshold of options.thresholds ?? []) {
    const item = metrics.find(
      (candidate) => candidate.gauge.siteId === threshold.siteId,
    );
    // `stageAbove` names the level a reading must exceed, so a gauge sitting
    // exactly on it has not breached. A stale reading supports no claim about
    // conditions now, so it raises nothing either.
    if (
      item?.latestStage !== null &&
      item?.latestStage !== undefined &&
      item.stageFreshness === "fresh" &&
      item.latestStage > threshold.stageAbove
    ) {
      alerts.push({
        id: threshold.id,
        severity: "attention",
        title: threshold.label,
        detail: `${item.gauge.river} is ${formatNumber(item.latestStage)} ft, above the user threshold of ${formatNumber(threshold.stageAbove)} ft.`,
        evidenceIds: [
          gaugeEvidenceId(item.gauge.siteId),
          CALCULATION_EVIDENCE_ID,
        ],
      });
    }
  }

  if (alerts.length === 0) {
    alerts.push({
      id: "no-alerts",
      severity: "info",
      title: "No configured thresholds are active",
      detail:
        "All current data-quality and user-defined threshold checks are clear.",
      evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
    });
  }

  return {
    metrics,
    rising,
    falling,
    staleOrMissing,
    ranked,
    evidence,
    gaugeEvidenceIds,
    allEvidenceIds: evidence.map((item) => item.id),
    alerts,
    latestObservationAt: metrics
      .flatMap((item) => (item.latestAt ? [item.latestAt] : []))
      .sort()
      .at(-1),
  };
}
