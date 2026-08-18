import type { Evidence } from "@dasher/dashboard-schema";

import type { Station } from "./station";
import type { StationMetrics } from "./metrics";

/**
 * Facts derived from station metrics, plus the evidence that carries them.
 *
 * Everything here is computed; nothing is plan-supplied. The prose that
 * appears in evidence records, alerts, and thresholds is assembled from words
 * the domain put on the station (`kindLabel`, reading labels, source name) —
 * this file contributes grammar, not vocabulary.
 */

export const CALCULATION_EVIDENCE_ID = "calculated-trends";

/** A user's standing instruction to watch a station, not a composition choice. */
export interface ThresholdRule {
  id: string;
  siteId: string;
  label: string;
  /** The primary reading a fresh observation must exceed to raise the alert. */
  above: number;
}

export interface StationAlert {
  id: string;
  severity: "info" | "attention" | "warning";
  title: string;
  detail: string;
  evidenceIds: string[];
}

export interface StationFacts {
  metrics: StationMetrics[];
  rising: StationMetrics[];
  falling: StationMetrics[];
  staleOrMissing: StationMetrics[];
  /** Fresh, complete stations rising faster than the tolerance, fastest first. */
  ranked: StationMetrics[];
  evidence: Evidence[];
  stationEvidenceIds: string[];
  allEvidenceIds: string[];
  alerts: StationAlert[];
  latestObservationAt: string | undefined;
}

export interface DeriveStationFactsOptions {
  asOf: string;
  /**
   * The calculated-trends evidence record's words, supplied by the domain:
   * what the calculations are called and how they were made. The record's id
   * and mechanics are shared; the sentence is not.
   */
  calculations: { label: string; detail: string };
  /**
   * The primary-reading rise above which a station is ranked as materially
   * rising, in the primary unit. Matches the river default when omitted.
   */
  materialRiseTolerance?: number;
  thresholds?: readonly ThresholdRule[];
  /**
   * Evidence the caller contributes about its own role, appended after the
   * observed and calculated records so identifier order stays stable.
   */
  additionalEvidence?: readonly Evidence[];
}

const DEFAULT_MATERIAL_RISE_TOLERANCE = 0.05;

export function stationEvidenceId(station: Station): string {
  return `${station.evidencePrefix}-${station.siteId}`;
}

function formatNumber(value: number | null, maximumFractionDigits = 2): string {
  if (value === null) return "Missing";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

export function signed(value: number | null, unit: string): string {
  // Distinct from `formatNumber`'s "Missing" on purpose: a null change means
  // too few observations to span the window, not an absent reading.
  if (value === null) return "Not enough history";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)} ${unit}`;
}

export function uniqueEvidenceIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

/**
 * One station as a dashboard shows it: the contract's 1.2 `station` shape
 * (ADR-007), with every value computed and every word taken from the domain.
 */
export function stationView(item: StationMetrics) {
  return {
    id: item.station.siteId,
    name: item.station.name,
    group: item.station.group,
    latitude: item.station.latitude,
    longitude: item.station.longitude,
    primary: {
      value: item.latestPrimary,
      unit: item.station.primary?.unit ?? "",
    },
    secondary: {
      value: item.latestSecondary,
      unit: item.station.secondary?.unit ?? "",
    },
    direction: item.direction,
    freshness: item.freshness,
    evidenceIds: [stationEvidenceId(item.station), CALCULATION_EVIDENCE_ID],
  };
}

export function deriveStationFacts(
  metrics: StationMetrics[],
  options: DeriveStationFactsOptions,
): StationFacts {
  const tolerance =
    options.materialRiseTolerance ?? DEFAULT_MATERIAL_RISE_TOLERANCE;
  const rising = metrics.filter(
    (item) => item.primaryFreshness === "fresh" && item.direction === "rising",
  );
  const falling = metrics.filter(
    (item) => item.primaryFreshness === "fresh" && item.direction === "falling",
  );
  const staleOrMissing = metrics.filter(
    (item) => item.freshness !== "fresh" || item.dataIssues.length > 0,
  );
  const ranked = [...metrics]
    .filter(
      (item) =>
        item.primaryChange1h !== null &&
        item.primaryChange1h > tolerance &&
        item.freshness === "fresh" &&
        item.dataIssues.length === 0,
    )
    .sort((a, b) => (b.primaryChange1h ?? 0) - (a.primaryChange1h ?? 0));

  const evidence: Evidence[] = metrics.map((item) => ({
    id: stationEvidenceId(item.station),
    kind: "observed" as const,
    label: `${item.station.group} ${item.station.kindLabel} ${item.station.siteId}`,
    sourceName: item.station.sourceName,
    sourceUrl: item.station.sourceUrl,
    observedAt: item.latestAt ?? undefined,
    retrievedAt: item.station.retrievedAt,
    detail: `${item.station.primaryLabel} and ${item.station.secondaryLabel} observations for ${item.station.name}.`,
    confidence: "high" as const,
  }));

  evidence.push({
    id: CALCULATION_EVIDENCE_ID,
    kind: "calculated",
    label: options.calculations.label,
    sourceName: "Dasher",
    retrievedAt: options.asOf,
    detail: options.calculations.detail,
    confidence: "high",
  });

  evidence.push(...(options.additionalEvidence ?? []));

  const stationEvidenceIds = metrics.map((item) =>
    stationEvidenceId(item.station),
  );

  const alerts: StationAlert[] = metrics.flatMap((item) =>
    item.dataIssues.map((detail, index) => ({
      id: `${item.station.siteId}-quality-${index}`,
      severity:
        item.freshness === "fresh"
          ? ("attention" as const)
          : ("warning" as const),
      title: item.station.group,
      detail,
      evidenceIds: [stationEvidenceId(item.station), CALCULATION_EVIDENCE_ID],
    })),
  );

  for (const threshold of options.thresholds ?? []) {
    const item = metrics.find(
      (candidate) => candidate.station.siteId === threshold.siteId,
    );
    // `above` names the level a reading must exceed, so a station sitting
    // exactly on it has not breached. A stale reading supports no claim about
    // conditions now, so it raises nothing either.
    if (
      item?.latestPrimary !== null &&
      item?.latestPrimary !== undefined &&
      item.primaryFreshness === "fresh" &&
      item.latestPrimary > threshold.above
    ) {
      const unit = item.station.primary?.unit ?? "";
      alerts.push({
        id: threshold.id,
        severity: "attention",
        title: threshold.label,
        detail: `${item.station.group} is ${formatNumber(item.latestPrimary)} ${unit}, above the user threshold of ${formatNumber(threshold.above)} ${unit}.`,
        evidenceIds: [stationEvidenceId(item.station), CALCULATION_EVIDENCE_ID],
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
      evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
    });
  }

  return {
    metrics,
    rising,
    falling,
    staleOrMissing,
    ranked,
    evidence,
    stationEvidenceIds,
    allEvidenceIds: evidence.map((item) => item.id),
    alerts,
    latestObservationAt: metrics
      .flatMap((item) => (item.latestAt ? [item.latestAt] : []))
      .sort()
      .at(-1),
  };
}
