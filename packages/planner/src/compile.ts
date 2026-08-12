import {
  parseDashboardSpec,
  type DashboardComponent,
  type DashboardSpec,
  type Evidence,
} from "@dasher/dashboard-schema";
import { buildGaugeMetrics, type GaugeMetrics } from "@dasher/river-domain";
import type { RiverGauge, ThresholdRule } from "@dasher/river-domain";

import type { DashboardPlan, PlanSectionKind } from "./plan";

/**
 * The trusted compiler. It accepts a plan's composition and framing decisions
 * and rejects everything else: every value, change, direction, freshness state,
 * evidence item, and claim below is computed here from the observations.
 *
 * The plan cannot influence a number. It chooses which sections appear, in
 * what order, on which pages, for which gauges, under what title.
 */

export interface CompileOptions {
  asOf: string;
  /** Identifies the provider that produced the plan, for the evidence record. */
  plannerId: string;
  /**
   * User-configured threshold alerts. These are deliberately not part of the
   * plan contract: a threshold is the user's standing instruction, not a
   * composition choice, so a planner can neither add, remove, nor retune one.
   */
  thresholds?: readonly ThresholdRule[];
}

type CompiledSpec = Extract<DashboardSpec, { schemaVersion: "1.1" }>;

const CALCULATION_EVIDENCE_ID = "calculated-trends";
const PLANNER_EVIDENCE_ID = "planner-composition";

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

function gaugeEvidenceId(siteId: string): string {
  return `usgs-${siteId}`;
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
    evidenceIds: [gaugeEvidenceId(item.gauge.siteId), CALCULATION_EVIDENCE_ID],
  };
}

function unique(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

interface Facts {
  metrics: GaugeMetrics[];
  rising: GaugeMetrics[];
  falling: GaugeMetrics[];
  staleOrMissing: GaugeMetrics[];
  ranked: GaugeMetrics[];
  evidence: Evidence[];
  gaugeEvidenceIds: string[];
  allEvidenceIds: string[];
  alerts: Array<{
    id: string;
    severity: "info" | "attention" | "warning";
    title: string;
    detail: string;
    evidenceIds: string[];
  }>;
  latestObservationAt: string | undefined;
}

function deriveFacts(
  metrics: GaugeMetrics[],
  options: CompileOptions,
  plannerId: string,
): Facts {
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

  evidence.push({
    id: PLANNER_EVIDENCE_ID,
    kind: "interpreted",
    label: "Dashboard composition",
    sourceName: `Dasher planner (${plannerId})`,
    retrievedAt: options.asOf,
    detail:
      "A planning model chose this dashboard's title, audience, framing, gauge selection, and page layout. It did not produce any reading, calculation, or claim: every value shown here is computed by Dasher from the source observations and validated against the dashboard contract before display.",
    confidence: "medium",
  });

  const alerts: Facts["alerts"] = metrics.flatMap((item) =>
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

  const gaugeEvidenceIds = metrics.map((item) =>
    gaugeEvidenceId(item.gauge.siteId),
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
        "All current data-quality checks are clear for the selected gauges.",
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

function buildSection(
  section: PlanSectionKind,
  plan: DashboardPlan,
  facts: Facts,
): DashboardComponent | undefined {
  const {
    metrics,
    rising,
    falling,
    staleOrMissing,
    ranked,
    gaugeEvidenceIds,
    allEvidenceIds,
    alerts,
  } = facts;
  const fastest = ranked[0];

  switch (section) {
    case "conditions-summary":
      return {
        id: "conditions-summary",
        kind: "summary",
        title: "Conditions summary",
        subtitle: plan.framing,
        tone: staleOrMissing.length > 0 ? "attention" : "normal",
        claims: [
          {
            text: `${rising.length} gauge${rising.length === 1 ? " is" : "s are"} rising and ${falling.length} ${falling.length === 1 ? "is" : "are"} falling.`,
            evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
          },
          {
            text: fastest
              ? `${fastest.gauge.river} is the fastest-rising complete gauge over the last hour at ${signed(fastest.stageChange1h, "ft")}.`
              : "No fresh, complete gauge is rising fast enough to rank over the last hour.",
            evidenceIds: fastest
              ? [gaugeEvidenceId(fastest.gauge.siteId), CALCULATION_EVIDENCE_ID]
              : [CALCULATION_EVIDENCE_ID],
          },
          {
            text:
              staleOrMissing.length > 0
                ? `${staleOrMissing.length} gauge${staleOrMissing.length === 1 ? " needs" : "s need"} a freshness or completeness check.`
                : "All selected gauges are fresh and complete.",
            evidenceIds:
              staleOrMissing.length > 0
                ? staleOrMissing.map((item) =>
                    gaugeEvidenceId(item.gauge.siteId),
                  )
                : gaugeEvidenceIds,
          },
        ],
        evidenceIds: allEvidenceIds,
      };

    case "headline-metrics":
      return {
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
      };

    case "gauge-map":
      return {
        id: "gauge-map",
        kind: "gauge-map",
        title: "Gauge map",
        subtitle: "Select a point for current conditions",
        gauges: metrics.map(gaugeView),
        evidenceIds: gaugeEvidenceIds,
      };

    case "gauge-table":
      return {
        id: "gauge-table",
        kind: "gauge-table",
        title: "Current readings",
        gauges: metrics.map(gaugeView),
        evidenceIds: gaugeEvidenceIds,
      };

    case "fastest-rising":
      return {
        id: "fastest-rising",
        kind: "ranking",
        title: "Fastest-rising gauges",
        subtitle: "Fresh, complete gauges ranked by one-hour water-level rise",
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
      };

    case "change-windows":
      return {
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
      };

    case "stage-trends": {
      const series = metrics
        .filter((item) => item.stagePoints.length >= 2)
        .map((item) => ({
          id: item.gauge.siteId,
          label: item.gauge.river,
          unit: item.gauge.stage?.unit ?? "ft",
          evidenceIds: [gaugeEvidenceId(item.gauge.siteId)],
          points: item.stagePoints,
        }));
      // A trend list with no qualifying series would render as an empty panel;
      // omitting it is honest, and the plan's other sections still stand.
      if (series.length === 0) return undefined;
      return {
        id: "stage-trends",
        kind: "trend-list",
        title: "Recent water-level trends",
        series,
        evidenceIds: [...gaugeEvidenceIds, CALCULATION_EVIDENCE_ID],
      };
    }

    case "attention":
      return {
        id: "attention",
        kind: "alert-list",
        title: "Needs attention",
        alerts,
        evidenceIds: allEvidenceIds,
      };
  }
}

/**
 * Compile a validated plan into a validated `DashboardSpec`.
 *
 * Throws whatever `parseDashboardSpec` throws if the compiled result violates
 * the dashboard contract. The caller treats that as a `spec_rejected` finding
 * and may request a revision.
 */
export function compilePlan(
  plan: DashboardPlan,
  gauges: readonly RiverGauge[],
  options: CompileOptions,
): CompiledSpec {
  const selected = plan.siteIds
    .map((siteId) => gauges.find((gauge) => gauge.siteId === siteId))
    .filter((gauge): gauge is RiverGauge => gauge !== undefined);

  const metrics = selected.map((gauge) =>
    buildGaugeMetrics(gauge, options.asOf),
  );
  const facts = deriveFacts(metrics, options, options.plannerId);

  const pages = plan.pages
    .map((page) => ({
      id: page.id,
      title: page.title,
      description: page.description,
      components: page.sections
        .map((section) => buildSection(section, plan, facts))
        .filter(
          (component): component is DashboardComponent =>
            component !== undefined,
        ),
    }))
    .filter((page) => page.components.length > 0);

  const firstAttention = facts.metrics.find(
    (item) => item.dataIssues.length > 0,
  );
  const attentionAlerts = facts.alerts.filter(
    (alert) => alert.severity !== "info",
  );
  const severityRank = { warning: 2, attention: 1, info: 0 } as const;
  const highestPriorityAlert = [...attentionAlerts].sort(
    (a, b) => severityRank[b.severity] - severityRank[a.severity],
  )[0];
  const fastest = facts.ranked[0];

  const spec = parseDashboardSpec({
    schemaVersion: "1.1",
    id: "planned-river-conditions",
    title: plan.title,
    audience: plan.audience,
    generatedAt: options.asOf,
    dataMode: "demo",
    freshness: {
      status: facts.staleOrMissing.length > 0 ? "partial" : "fresh",
      label:
        facts.staleOrMissing.length > 0
          ? `${facts.staleOrMissing.length} gauge${facts.staleOrMissing.length === 1 ? "" : "s"} need${facts.staleOrMissing.length === 1 ? "s" : ""} attention`
          : "All gauges fresh",
      latestObservationAt: facts.latestObservationAt,
    },
    executiveBrief: {
      known: {
        statementTypes: ["observed", "calculated"],
        headline: `${facts.metrics.length} gauge${facts.metrics.length === 1 ? "" : "s"} monitored`,
        detail: `${facts.rising.length} gauge${facts.rising.length === 1 ? " is" : "s are"} rising and ${facts.falling.length} gauge${facts.falling.length === 1 ? " is" : "s are"} falling based on fresh water-level readings.`,
        evidenceIds: unique(facts.gaugeEvidenceIds, [CALCULATION_EVIDENCE_ID]),
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
            evidenceIds: unique(facts.gaugeEvidenceIds, [
              CALCULATION_EVIDENCE_ID,
            ]),
          },
      important: highestPriorityAlert
        ? {
            statementTypes: ["interpreted"],
            headline: `${attentionAlerts.length} item${attentionAlerts.length === 1 ? "" : "s"} need attention`,
            detail: `Highest priority: ${highestPriorityAlert.title} — ${highestPriorityAlert.detail}`,
            evidenceIds: unique(
              ...attentionAlerts.map((alert) => alert.evidenceIds),
            ),
          }
        : {
            statementTypes: ["interpreted"],
            headline: "Configured checks are clear",
            detail: "No data-quality check needs attention.",
            evidenceIds: unique(
              ...facts.alerts.map((alert) => alert.evidenceIds),
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
          title: "Review the dashboard before sharing",
          detail:
            "Confirm the calculated conditions match the source readings and the intended audience.",
          evidenceIds: [CALCULATION_EVIDENCE_ID],
        },
    notice:
      "USGS readings may be provisional and subject to revision. Planning view only; use USGS and local emergency-management sources for official conditions and warnings.",
    pages,
    evidence: facts.evidence,
    architecture: {
      title: "How this dashboard works",
      summary:
        "A planning model chose the layout and framing. Dasher computed every number from USGS-format readings and validated the result against the dashboard contract before rendering.",
      nodes: [
        {
          id: "request",
          label: "Your request",
          detail:
            "The plain-language request you typed. It is the only input that reaches the planner.",
          kind: "input",
        },
        {
          id: "usgs",
          label: "River gauge readings",
          detail:
            "Water level, streamflow, location, and timestamps from USGS-format observations.",
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
            "The planner chose this dashboard's title, audience, framing, gauge selection, and page layout. It never sees a reading and cannot state a fact, run code, or reach a credential; anything it proposes that Dasher cannot support is rejected and sent back for revision.",
          kind: "ai",
        },
        {
          id: "validate",
          label: "Check the plan",
          detail:
            "Dasher rejects any plan naming an unavailable gauge or an unsupported section, and asks the planner to correct it.",
          kind: "process",
        },
        {
          id: "pages",
          label: "Dashboard pages",
          detail:
            "Dasher fills the chosen layout with its own calculated values and source links.",
          kind: "page",
        },
        {
          id: "attention",
          label: "Attention and refresh",
          detail:
            "Source and freshness issues stay visible; a refresh creates a new validated version.",
          kind: "output",
        },
      ],
      edges: [
        { from: "request", to: "ai", label: "what you asked for" },
        { from: "usgs", to: "normalize", label: "read" },
        { from: "normalize", to: "calculate", label: "clean data" },
        { from: "normalize", to: "ai", label: "gauge names only" },
        { from: "ai", to: "validate", label: "proposed layout" },
        { from: "validate", to: "ai", label: "corrections" },
        { from: "validate", to: "pages", label: "approved layout" },
        { from: "calculate", to: "pages", label: "validated metrics" },
        { from: "pages", to: "attention", label: "monitor and refresh" },
      ],
    },
  });

  if (spec.schemaVersion !== "1.1") {
    throw new Error("Planned dashboard must use DashboardSpec 1.1");
  }
  return spec;
}
