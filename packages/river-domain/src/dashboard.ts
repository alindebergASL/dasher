import {
  parseDashboardSpec,
  type DashboardSpec,
} from "@dasher/dashboard-schema";

import {
  CALCULATION_EVIDENCE_ID,
  deriveRiverFacts,
  gaugeEvidenceId,
  gaugeView,
  signed,
  uniqueEvidenceIds,
  type ThresholdRule,
} from "./facts";
import { buildGaugeMetrics } from "./metrics";
import type { RiverGauge } from "./usgs";

export type { ThresholdRule } from "./facts";

export interface RiverDashboardOptions {
  asOf: string;
  audience?: string;
  thresholds?: ThresholdRule[];
}

type RiverDashboardSpec = Extract<DashboardSpec, { schemaVersion: "1.1" }>;

export function createRiverDashboard(
  gauges: RiverGauge[],
  options: RiverDashboardOptions,
): RiverDashboardSpec {
  const metrics = gauges.map((gauge) => buildGaugeMetrics(gauge, options.asOf));
  const {
    rising,
    falling,
    staleOrMissing,
    ranked,
    evidence,
    gaugeEvidenceIds,
    allEvidenceIds,
    alerts,
    latestObservationAt,
  } = deriveRiverFacts(metrics, {
    asOf: options.asOf,
    thresholds: options.thresholds,
  });

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
        statementTypes: ["observed", "calculated"],
        headline: `${metrics.length} gauge${metrics.length === 1 ? "" : "s"} monitored`,
        detail: `${rising.length} gauge${rising.length === 1 ? " is" : "s are"} rising and ${falling.length} gauge${falling.length === 1 ? " is" : "s are"} falling based on fresh water-level readings.`,
        evidenceIds: uniqueEvidenceIds(gaugeEvidenceIds, [
          CALCULATION_EVIDENCE_ID,
        ]),
      },
      changed: fastest
        ? {
            statementTypes: ["calculated"],
            headline: `${fastest.gauge.river} rose fastest`,
            detail: `The fastest fresh, complete material one-hour rise is ${signed(fastest.stageChange1h, "ft")} at ${fastest.gauge.name}.`,
            evidenceIds: [
              gaugeEvidenceId(fastest.gauge.siteId),
              CALCULATION_EVIDENCE_ID,
            ],
          }
        : {
            statementTypes: ["calculated"],
            headline: "No material one-hour rise available",
            detail:
              "No fresh, complete gauge rose more than 0.05 ft over the last hour.",
            evidenceIds: uniqueEvidenceIds(gaugeEvidenceIds, [
              CALCULATION_EVIDENCE_ID,
            ]),
          },
      important: highestPriorityAlert
        ? {
            statementTypes: ["interpreted"],
            headline: `${attentionAlerts.length} item${attentionAlerts.length === 1 ? "" : "s"} need attention`,
            detail: `Highest priority: ${highestPriorityAlert.title} — ${highestPriorityAlert.detail}`,
            evidenceIds: uniqueEvidenceIds(
              ...attentionAlerts.map((alert) => alert.evidenceIds),
            ),
          }
        : {
            statementTypes: ["interpreted"],
            headline: "Configured checks are clear",
            detail:
              "No data-quality or user-defined threshold checks need attention.",
            evidenceIds: uniqueEvidenceIds(
              ...alerts.map((alert) => alert.evidenceIds),
              [CALCULATION_EVIDENCE_ID],
            ),
          },
    },
    nextAction: firstAttention
      ? {
          title: `Review ${firstAttention.gauge.river} gauge`,
          detail: `${firstAttention.gauge.name}: ${firstAttention.dataIssues[0]}`,
          evidenceIds: [gaugeEvidenceId(firstAttention.gauge.siteId)],
        }
      : {
          title: "Review the dashboard before publishing",
          detail:
            "Confirm the calculated conditions match the source readings and intended audience.",
          evidenceIds: [CALCULATION_EVIDENCE_ID],
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
                evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
              },
              {
                text: summaryClaims[1]!,
                evidenceIds: fastest
                  ? [
                      gaugeEvidenceId(fastest.gauge.siteId),
                      CALCULATION_EVIDENCE_ID,
                    ]
                  : [CALCULATION_EVIDENCE_ID],
              },
              {
                text: summaryClaims[2]!,
                evidenceIds:
                  staleOrMissing.length > 0
                    ? staleOrMissing.map((item) =>
                        gaugeEvidenceId(item.gauge.siteId),
                      )
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
                evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
              },
              {
                label: "Falling",
                value: String(falling.length),
                direction: "down",
                evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
              },
              {
                label: "Freshness checks",
                value: String(staleOrMissing.length),
                direction: staleOrMissing.length ? "unknown" : "steady",
                evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
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
              evidenceIds: [
                gaugeEvidenceId(item.gauge.siteId),
                CALCULATION_EVIDENCE_ID,
              ],
            })),
            evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
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
                evidenceIds: [gaugeEvidenceId(item.gauge.siteId)],
                points: item.stagePoints,
              })),
            evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
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
              evidenceIds: [
                gaugeEvidenceId(item.gauge.siteId),
                CALCULATION_EVIDENCE_ID,
              ],
            })),
            evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
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
