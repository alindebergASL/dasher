import {
  parseDashboardSpec,
  type DashboardSpec,
  type Evidence,
} from "@dasher/dashboard-schema";

import { buildGaugeMetrics, type GaugeMetrics } from "./metrics";
import type { RiverGauge } from "./usgs";

export interface ThresholdRule {
  id: string;
  siteId: string;
  label: string;
  stageAbove: number;
}

export interface RiverDashboardOptions {
  asOf: string;
  audience?: string;
  thresholds?: ThresholdRule[];
}

type RiverDashboardSpec = Extract<DashboardSpec, { schemaVersion: "1.1" }>;

function uniqueEvidenceIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

function formatNumber(value: number | null, maximumFractionDigits = 2): string {
  if (value === null) return "Missing";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

function signed(value: number | null, unit: string): string {
  if (value === null) return "Not enough history";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)} ${unit}`;
}

function gaugeView(item: GaugeMetrics) {
  return {
    id: item.gauge.siteId,
    name: item.gauge.name,
    river: item.gauge.river,
    latitude: item.gauge.latitude,
    longitude: item.gauge.longitude,
    stage: item.latestStage,
    stageUnit: item.gauge.stage?.unit ?? "ft",
    streamflow: item.latestStreamflow,
    streamflowUnit: item.gauge.streamflow?.unit ?? "ft3/s",
    direction: item.direction,
    freshness: item.freshness,
    evidenceIds: [`usgs-${item.gauge.siteId}`, "calculated-trends"],
  } as const;
}

export function createRiverDashboard(
  gauges: RiverGauge[],
  options: RiverDashboardOptions,
): RiverDashboardSpec {
  const metrics = gauges.map((gauge) => buildGaugeMetrics(gauge, options.asOf));
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
  const latestObservationAt = metrics
    .flatMap((item) => (item.latestAt ? [item.latestAt] : []))
    .sort()
    .at(-1);

  const evidence: Evidence[] = metrics.map((item) => ({
    id: `usgs-${item.gauge.siteId}`,
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
    id: "calculated-trends",
    kind: "calculated",
    label: "Dasher river calculations",
    sourceName: "Dasher",
    retrievedAt: options.asOf,
    detail:
      "One-, six-, and 24-hour changes are calculated from the nearest qualifying USGS observations. Rising/falling uses a 0.05-foot tolerance.",
    confidence: "high",
  });

  const alerts: Array<{
    id: string;
    severity: "info" | "attention" | "warning";
    title: string;
    detail: string;
    evidenceIds: string[];
  }> = metrics.flatMap((item) =>
    item.dataIssues.map((detail, index) => ({
      id: `${item.gauge.siteId}-quality-${index}`,
      severity:
        item.freshness === "fresh"
          ? ("attention" as const)
          : ("warning" as const),
      title: item.gauge.river,
      detail,
      evidenceIds: [`usgs-${item.gauge.siteId}`, "calculated-trends"],
    })),
  );

  for (const threshold of options.thresholds ?? []) {
    const item = metrics.find(
      (candidate) => candidate.gauge.siteId === threshold.siteId,
    );
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
        evidenceIds: [`usgs-${item.gauge.siteId}`, "calculated-trends"],
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
      evidenceIds: [
        ...metrics.map((item) => `usgs-${item.gauge.siteId}`),
        "calculated-trends",
      ],
    });
  }

  const fastest = ranked[0];
  const summaryClaims = [
    `${rising.length} gauge${rising.length === 1 ? " is" : "s are"} rising and ${falling.length} ${falling.length === 1 ? "is" : "are"} falling.`,
    fastest
      ? `${fastest.gauge.river} is the fastest-rising complete gauge over the last hour at ${signed(fastest.stageChange1h, "ft")}.`
      : "No fresh, complete gauge is rising fast enough to rank over the last hour.",
    staleOrMissing.length > 0
      ? `${staleOrMissing.length} gauge${staleOrMissing.length === 1 ? " needs" : "s need"} a freshness or completeness check.`
      : "All gauges are fresh and complete.",
  ];

  const allEvidenceIds = evidence.map((item) => item.id);
  const gaugeEvidenceIds = metrics.map((item) => `usgs-${item.gauge.siteId}`);
  const firstAttention = metrics.find((item) => item.dataIssues.length > 0);
  const attentionAlerts = alerts.filter((alert) => alert.severity !== "info");
  const highestPriorityAlert = [...attentionAlerts].sort(
    (a, b) =>
      (({ warning: 2, attention: 1, info: 0 })[b.severity] ?? 0) -
      ({ warning: 2, attention: 1, info: 0 }[a.severity] ?? 0),
  )[0];

  const dashboard = parseDashboardSpec({
    schemaVersion: "1.1",
    id: "sacramento-river-conditions",
    title: "Sacramento River Conditions",
    audience: options.audience ?? "Managers and community leaders",
    generatedAt: options.asOf,
    dataMode: "demo",
    freshness: {
      status: staleOrMissing.length > 0 ? "partial" : "fresh",
      label:
        staleOrMissing.length > 0
          ? `${staleOrMissing.length} gauge${staleOrMissing.length === 1 ? "" : "s"} need${staleOrMissing.length === 1 ? "s" : ""} attention`
          : "All gauges fresh",
      latestObservationAt,
    },
    executiveBrief: {
      known: {
        headline: `${metrics.length} gauge${metrics.length === 1 ? "" : "s"} monitored`,
        detail: `${rising.length} gauge${rising.length === 1 ? " is" : "s are"} rising and ${falling.length} gauge${falling.length === 1 ? " is" : "s are"} falling based on fresh water-level readings.`,
        evidenceIds: uniqueEvidenceIds(gaugeEvidenceIds, ["calculated-trends"]),
      },
      changed: fastest
        ? {
            headline: `${fastest.gauge.river} rose fastest`,
            detail: `The fastest fresh, complete material one-hour rise is ${signed(fastest.stageChange1h, "ft")} at ${fastest.gauge.name}.`,
            evidenceIds: [`usgs-${fastest.gauge.siteId}`, "calculated-trends"],
          }
        : {
            headline: "No material one-hour rise available",
            detail:
              "No fresh, complete gauge rose more than 0.05 ft over the last hour.",
            evidenceIds: uniqueEvidenceIds(gaugeEvidenceIds, [
              "calculated-trends",
            ]),
          },
      important: highestPriorityAlert
        ? {
            headline: `${attentionAlerts.length} item${attentionAlerts.length === 1 ? "" : "s"} need attention`,
            detail: `Highest priority: ${highestPriorityAlert.title} — ${highestPriorityAlert.detail}`,
            evidenceIds: uniqueEvidenceIds(
              ...attentionAlerts.map((alert) => alert.evidenceIds),
            ),
          }
        : {
            headline: "Configured checks are clear",
            detail:
              "No data-quality or user-defined threshold checks need attention.",
            evidenceIds: uniqueEvidenceIds(
              ...alerts.map((alert) => alert.evidenceIds),
            ),
          },
    },
    nextAction: firstAttention
      ? {
          title: `Review ${firstAttention.gauge.river} gauge`,
          detail: `${firstAttention.gauge.name}: ${firstAttention.dataIssues[0]}`,
          evidenceIds: [`usgs-${firstAttention.gauge.siteId}`],
        }
      : {
          title: "Review the dashboard before publishing",
          detail:
            "Confirm the calculated conditions match the source readings and intended audience.",
          evidenceIds: ["calculated-trends"],
        },
    notice:
      "USGS readings may be provisional and subject to revision. Planning view only; use USGS and local emergency-management sources for official conditions and warnings.",
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "What is happening now and what deserves attention.",
        components: [
          {
            id: "conditions-summary",
            kind: "summary",
            title: "Conditions summary",
            subtitle: "Calculated from the latest available gauge readings",
            claims: [
              {
                text: summaryClaims[0]!,
                evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
              },
              {
                text: summaryClaims[1]!,
                evidenceIds: fastest
                  ? [`usgs-${fastest.gauge.siteId}`, "calculated-trends"]
                  : ["calculated-trends"],
              },
              {
                text: summaryClaims[2]!,
                evidenceIds:
                  staleOrMissing.length > 0
                    ? staleOrMissing.map((item) => `usgs-${item.gauge.siteId}`)
                    : gaugeEvidenceIds,
              },
            ],
            tone: staleOrMissing.length > 0 ? "attention" : "normal",
            evidenceIds: allEvidenceIds,
          },
          {
            id: "headline-metrics",
            kind: "metric-grid",
            title: "At a glance",
            metrics: [
              {
                label: "Gauges monitored",
                value: String(metrics.length),
                evidenceIds: gaugeEvidenceIds,
              },
              {
                label: "Rising",
                value: String(rising.length),
                direction: "up",
                evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
              },
              {
                label: "Falling",
                value: String(falling.length),
                direction: "down",
                evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
              },
              {
                label: "Freshness checks",
                value: String(staleOrMissing.length),
                direction: staleOrMissing.length ? "unknown" : "steady",
                evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
              },
            ],
            evidenceIds: allEvidenceIds,
          },
          {
            id: "gauge-map",
            kind: "gauge-map",
            title: "Gauge map",
            subtitle:
              "Sacramento-area gauges; select a point for current conditions",
            gauges: metrics.map(gaugeView),
            evidenceIds: gaugeEvidenceIds,
          },
          {
            id: "fastest-rising",
            kind: "ranking",
            title: "Fastest-rising gauges",
            subtitle:
              "Fresh, complete gauges ranked by one-hour water-level rise",
            items: ranked.map((item) => ({
              id: item.gauge.siteId,
              label: item.gauge.river,
              value: signed(item.stageChange1h, "ft"),
              note: `${item.direction}; 6h ${signed(item.stageChange6h, "ft")}`,
              evidenceIds: [`usgs-${item.gauge.siteId}`, "calculated-trends"],
            })),
            evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
          },
          {
            id: "attention",
            kind: "alert-list",
            title: "Needs attention",
            alerts,
            evidenceIds: allEvidenceIds,
          },
        ],
      },
      {
        id: "gauge-details",
        title: "Gauge details",
        description:
          "Current readings, changes, and recent water-level history.",
        components: [
          {
            id: "gauge-table",
            kind: "gauge-table",
            title: "Current readings",
            gauges: metrics.map(gaugeView),
            evidenceIds: gaugeEvidenceIds,
          },
          {
            id: "stage-trends",
            kind: "trend-list",
            title: "Recent water-level trends",
            subtitle: "Fixture history spans the latest available 24 hours",
            series: metrics
              .filter((item) => item.stagePoints.length >= 2)
              .map((item) => ({
                id: item.gauge.siteId,
                label: item.gauge.river,
                unit: item.gauge.stage?.unit ?? "ft",
                evidenceIds: [`usgs-${item.gauge.siteId}`],
                points: item.stagePoints,
              })),
            evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
          },
          {
            id: "change-windows",
            kind: "ranking",
            title: "Change windows",
            items: metrics.map((item) => ({
              id: item.gauge.siteId,
              label: item.gauge.river,
              value: `1h ${signed(item.stageChange1h, "ft")}`,
              note: `6h ${signed(item.stageChange6h, "ft")} · 24h ${signed(item.stageChange24h, "ft")}`,
              evidenceIds: [`usgs-${item.gauge.siteId}`, "calculated-trends"],
            })),
            evidenceIds: [...gaugeEvidenceIds, "calculated-trends"],
          },
        ],
      },
    ],
    evidence,
    architecture: {
      title: "How this dashboard works",
      summary:
        "USGS-format gauge readings are checked, normalized, and turned into transparent calculations. The fixture demo does not use AI; later AI planning must produce the same validated dashboard contract.",
      nodes: [
        {
          id: "usgs",
          label: "River gauge readings",
          detail:
            "Water level, streamflow, location, and timestamps from USGS.",
          kind: "input",
        },
        {
          id: "normalize",
          label: "Check and organize",
          detail:
            "Dasher validates station IDs, units, coordinates, missing values, and timestamps.",
          kind: "process",
        },
        {
          id: "calculate",
          label: "Calculate change",
          detail:
            "Dasher calculates 1-hour, 6-hour, and 24-hour movement, direction, rankings, and freshness.",
          kind: "process",
        },
        {
          id: "ai",
          label: "AI dashboard planner",
          detail:
            "Not used in this deterministic demo. Later, AI may choose layouts and explanations but cannot change source facts or bypass validation.",
          kind: "ai",
        },
        {
          id: "pages",
          label: "Two dashboard pages",
          detail:
            "Overview shows what matters; Gauge details shows readings and trends.",
          kind: "page",
        },
        {
          id: "attention",
          label: "Attention and refresh",
          detail:
            "Manual or daily refresh can create a new validated version; source and threshold issues stay visible.",
          kind: "output",
        },
      ],
      edges: [
        { from: "usgs", to: "normalize", label: "read" },
        { from: "normalize", to: "calculate", label: "clean data" },
        { from: "calculate", to: "pages", label: "validated metrics" },
        { from: "calculate", to: "ai", label: "optional planning context" },
        { from: "ai", to: "pages", label: "validated spec only" },
        { from: "pages", to: "attention", label: "monitor and refresh" },
      ],
    },
  });

  if (dashboard.schemaVersion !== "1.1") {
    throw new Error("River dashboard must use DashboardSpec 1.1");
  }
  return dashboard;
}
