import {
  parseDashboardSpec,
  type DashboardComponent,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import {
  buildStationMetrics,
  CALCULATION_EVIDENCE_ID,
  deriveStationFacts,
  headingCase,
  signed,
  stationEvidenceId,
  stationView,
  uniqueEvidenceIds as unique,
  type Station,
  type StationComputation,
  type StationFacts,
  type StationMetrics,
  type StationWords,
  type ThresholdRule,
} from "@dasher/station-domain";
import { RIVER_COMPUTATION, RIVER_WORDS } from "@dasher/river-domain";

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
  /**
   * What produced the plan. The dashboard states who chose its composition, so
   * that sentence is derived from the provider rather than asserted as a
   * constant — a constant cannot stay true across a change of provider.
   */
  planner: { readonly id: string; readonly usesModel: boolean };
  /**
   * User-configured threshold alerts. These are deliberately not part of the
   * plan contract: a threshold is the user's standing instruction, not a
   * composition choice, so a planner can neither add, remove, nor retune one.
   */
  thresholds?: readonly ThresholdRule[];
  /**
   * The domain's computation policy: direction and material-rise tolerances
   * and the words for the calculated-trends evidence record. Defaults to the
   * river's, because the river is the product's current intake — but the
   * default is the ONLY river-specific thing here. A caller compiling another
   * domain's stations passes that domain's policy, and the first version of
   * the air test that did not was compiling air readings under river rules:
   * a monitor easing by 0.8 µg/m³ showed as "falling" through a tolerance
   * meant for feet of water.
   */
  computation?: StationComputation;
  /**
   * The domain's vocabulary for everything the compiler says in prose.
   * Defaults to the river's, like `computation`, and the two travel
   * together: passing one domain's stations with another domain's words
   * would produce sentences about the wrong instruments.
   */
  words?: StationWords;
}

type CompiledSpec = Extract<DashboardSpec, { schemaVersion: "1.2" }>;

const PLANNER_EVIDENCE_ID = "planner-composition";

type Facts = StationFacts;

/**
 * Names what chose the composition, in the reader's terms.
 *
 * A deterministic planner and a model are different claims about the system,
 * and the difference is exactly what a reader of the architecture panel wants
 * to know. Saying "model" when none ran overstates Dasher's role; saying
 * nothing leaves the layout unattributed.
 */
function composerSentence(
  planner: CompileOptions["planner"],
  words: StationWords,
): string {
  return planner.usesModel
    ? `A planning model chose this dashboard's title, audience, framing, ${words.noun} selection, and page layout.`
    : `A deterministic planner chose this dashboard's title, audience, framing, ${words.noun} selection, and page layout; no model was called.`;
}

function deriveFacts(
  metrics: StationMetrics[],
  options: CompileOptions,
  computation: StationComputation,
  words: StationWords,
): Facts {
  // Every judgement below the layout — rising, falling, stale, ranked,
  // thresholds, evidence — belongs to the domain rather than to the planner,
  // so that composing a dashboard cannot change what is true about a station.
  // What the planner adds is a record of its own part in the work.
  return deriveStationFacts(metrics, {
    asOf: options.asOf,
    calculations: computation.calculations,
    materialRiseTolerance: computation.materialRiseTolerance,
    thresholds: options.thresholds,
    additionalEvidence: [
      {
        id: PLANNER_EVIDENCE_ID,
        kind: "interpreted",
        label: "Dashboard composition",
        sourceName: `Dasher planner (${options.planner.id})`,
        retrievedAt: options.asOf,
        detail: `${composerSentence(options.planner, words)} It did not produce any reading, calculation, or claim: every value shown here is computed by Dasher from the source observations and validated against the dashboard contract before display.`,
        confidence: "medium",
      },
    ],
  });
}

/**
 * The unit a station's primary series actually reports in.
 *
 * Six call sites wrote `"ft"` as a literal while two others read it from the
 * series, so the same reading could be labelled two ways in one dashboard. It
 * was not reachable through the USGS parser, which rejects a stage series that
 * is not in feet — but `compilePlan` takes `Station[]`, not USGS output, so
 * "the parser would have caught it" is a fact about a different function.
 *
 * The fallback stays for a gauge with no stage series at all, where there is no
 * unit to read and the sections using it are about stage by definition.
 */
function primaryUnit(metrics: StationMetrics): string {
  return metrics.station.primary?.unit ?? "ft";
}

function buildSection(
  section: PlanSectionKind,
  plan: DashboardPlan,
  facts: Facts,
  words: StationWords,
): DashboardComponent | undefined {
  const {
    metrics,
    rising,
    falling,
    staleOrMissing,
    ranked,
    stationEvidenceIds,
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
            text: `${rising.length} ${words.noun}${rising.length === 1 ? " is" : "s are"} rising and ${falling.length} ${falling.length === 1 ? "is" : "are"} falling.`,
            evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
          },
          {
            text: fastest
              ? `${fastest.station.group} is the fastest-rising complete ${words.noun} over the last hour at ${signed(fastest.primaryChange1h, primaryUnit(fastest))}.`
              : `No fresh, complete ${words.noun} is rising fast enough to rank over the last hour.`,
            evidenceIds: fastest
              ? [stationEvidenceId(fastest.station), CALCULATION_EVIDENCE_ID]
              : [CALCULATION_EVIDENCE_ID],
          },
          {
            text:
              staleOrMissing.length > 0
                ? `${staleOrMissing.length} ${words.noun}${staleOrMissing.length === 1 ? " needs" : "s need"} a freshness or completeness check.`
                : `All selected ${words.nounPlural} are fresh and complete.`,
            evidenceIds:
              staleOrMissing.length > 0
                ? staleOrMissing.map((item) => stationEvidenceId(item.station))
                : stationEvidenceIds,
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
            label: `${headingCase(words.nounPlural)} monitored`,
            value: String(metrics.length),
            evidenceIds: stationEvidenceIds,
          },
          {
            label: "Rising",
            value: String(rising.length),
            direction: "up",
            evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
          },
          {
            label: "Falling",
            value: String(falling.length),
            direction: "down",
            evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
          },
          {
            label: "Freshness checks",
            value: String(staleOrMissing.length),
            direction: staleOrMissing.length ? "unknown" : "steady",
            evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
          },
        ],
        evidenceIds: allEvidenceIds,
      };

    case "gauge-map":
      // Plan vocabulary keeps the 1.1 name (see ADR-007); the compiler is the
      // mapping between the plan's words and the contract's.
      return {
        id: "gauge-map",
        kind: "station-map",
        title: `${headingCase(words.noun)} map`,
        subtitle: "Select a point for current conditions",
        stations: metrics.map(stationView),
        evidenceIds: stationEvidenceIds,
      };

    case "gauge-table":
      return {
        id: "gauge-table",
        kind: "station-table",
        title: "Current readings",
        stations: metrics.map(stationView),
        // The domain's words for the generic columns; the renderer has none.
        columns: words.columns,
        evidenceIds: stationEvidenceIds,
      };

    case "fastest-rising":
      return {
        id: "fastest-rising",
        kind: "ranking",
        title: `Fastest-rising ${words.nounPlural}`,
        subtitle: `Fresh, complete ${words.nounPlural} ranked by one-hour ${words.reading} rise`,
        items: ranked.map((item) => ({
          id: item.station.siteId,
          label: item.station.group,
          value: signed(item.primaryChange1h, primaryUnit(item)),
          note: `${item.direction}; 6h ${signed(item.primaryChange6h, primaryUnit(item))}`,
          evidenceIds: [
            stationEvidenceId(item.station),
            CALCULATION_EVIDENCE_ID,
          ],
        })),
        evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
      };

    case "change-windows":
      return {
        id: "change-windows",
        kind: "ranking",
        title: "Change windows",
        items: metrics.map((item) => ({
          id: item.station.siteId,
          label: item.station.group,
          value: `1h ${signed(item.primaryChange1h, primaryUnit(item))}`,
          note: `6h ${signed(item.primaryChange6h, primaryUnit(item))} · 24h ${signed(item.primaryChange24h, primaryUnit(item))}`,
          evidenceIds: [
            stationEvidenceId(item.station),
            CALCULATION_EVIDENCE_ID,
          ],
        })),
        evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
      };

    case "stage-trends": {
      const series = metrics
        .filter((item) => item.primaryPoints.length >= 2)
        .map((item) => ({
          id: item.station.siteId,
          label: item.station.group,
          unit: primaryUnit(item),
          evidenceIds: [stationEvidenceId(item.station)],
          points: item.primaryPoints,
        }));
      // A trend list with no qualifying series would render as an empty panel;
      // omitting it is honest, and the plan's other sections still stand.
      if (series.length === 0) return undefined;
      return {
        id: "stage-trends",
        kind: "trend-list",
        title: `Recent ${words.reading} trends`,
        series,
        evidenceIds: [...stationEvidenceIds, CALCULATION_EVIDENCE_ID],
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
  gauges: readonly Station[],
  options: CompileOptions,
): CompiledSpec {
  const selected = plan.siteIds
    .map((siteId) => gauges.find((gauge) => gauge.siteId === siteId))
    .filter((gauge): gauge is Station => gauge !== undefined);

  const computation = options.computation ?? RIVER_COMPUTATION;
  const words = options.words ?? RIVER_WORDS;
  const metrics = selected.map((gauge) =>
    buildStationMetrics(gauge, options.asOf, {
      directionTolerance: computation.directionTolerance,
    }),
  );
  const facts = deriveFacts(metrics, options, computation, words);

  const pages = plan.pages
    .map((page) => ({
      id: page.id,
      title: page.title,
      description: page.description,
      components: page.sections
        .map((section) => buildSection(section, plan, facts, words))
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
    schemaVersion: "1.2",
    id: `planned-${words.slug}-conditions`,
    title: plan.title,
    audience: plan.audience,
    generatedAt: options.asOf,
    dataMode: "demo",
    freshness: {
      status: facts.staleOrMissing.length > 0 ? "partial" : "fresh",
      label:
        facts.staleOrMissing.length > 0
          ? `${facts.staleOrMissing.length} ${words.noun}${facts.staleOrMissing.length === 1 ? "" : "s"} need${facts.staleOrMissing.length === 1 ? "s" : ""} attention`
          : `All ${words.nounPlural} fresh`,
      latestObservationAt: facts.latestObservationAt,
    },
    executiveBrief: {
      known: {
        statementTypes: ["observed", "calculated"],
        headline: `${facts.metrics.length} ${words.noun}${facts.metrics.length === 1 ? "" : "s"} monitored`,
        detail: `${facts.rising.length} ${words.noun}${facts.rising.length === 1 ? " is" : "s are"} rising and ${facts.falling.length} ${words.noun}${facts.falling.length === 1 ? " is" : "s are"} falling based on fresh ${words.reading} readings.`,
        evidenceIds: unique(facts.stationEvidenceIds, [
          CALCULATION_EVIDENCE_ID,
        ]),
      },
      changed: fastest
        ? {
            statementTypes: ["calculated"],
            headline: `${fastest.station.group} rose fastest`,
            detail: `The fastest fresh, complete material one-hour rise is ${signed(fastest.primaryChange1h, primaryUnit(fastest))} at ${fastest.station.name}.`,
            evidenceIds: [
              stationEvidenceId(fastest.station),
              CALCULATION_EVIDENCE_ID,
            ],
          }
        : {
            statementTypes: ["calculated"],
            headline: "No material one-hour rise available",
            // The tolerance is the computation policy's, so this sentence
            // states the bar that was actually applied — under the air
            // profile it reads "5 µg/m³", not a river number.
            detail: `No fresh, complete ${words.noun} rose more than ${computation.materialRiseTolerance} ${computation.toleranceUnit} over the last hour.`,
            evidenceIds: unique(facts.stationEvidenceIds, [
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
          title: `Review ${firstAttention.station.group} ${words.noun}`,
          detail: `${firstAttention.station.name}: ${firstAttention.dataIssues[0]}`,
          evidenceIds: [stationEvidenceId(firstAttention.station)],
        }
      : {
          title: "Review the dashboard before sharing",
          detail:
            "Confirm the calculated conditions match the source readings and the intended audience.",
          evidenceIds: [CALCULATION_EVIDENCE_ID],
        },
    notice: words.notice,
    pages,
    evidence: facts.evidence,
    architecture: {
      title: "How this dashboard works",
      summary: `${composerSentence(options.planner, words)} Dasher computed every number from ${words.source.format} readings and validated the result against the dashboard contract before rendering.`,
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
          label: words.source.label,
          detail: words.source.detail,
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
          id: "planner",
          label: options.planner.usesModel
            ? "AI dashboard planner"
            : "Dashboard planner (no model)",
          detail: `The planner chose this dashboard's title, audience, framing, ${words.noun} selection, and page layout. It never sees a reading and cannot state a fact, run code, or reach a credential; anything it proposes that Dasher cannot support is rejected and sent back for revision.`,
          // The diagram has to agree with the summary beside it. Drawing an AI
          // node for a keyword matcher told the reader a model was involved in
          // the same panel that said none was called.
          kind: options.planner.usesModel ? "ai" : "process",
        },
        {
          id: "validate",
          label: "Check the plan",
          detail: `Dasher rejects any plan naming an unavailable ${words.noun} or an unsupported section, and asks the planner to correct it.`,
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
        { from: "request", to: "planner", label: "what you asked for" },
        { from: "usgs", to: "normalize", label: "read" },
        { from: "normalize", to: "calculate", label: "clean data" },
        { from: "normalize", to: "planner", label: `${words.noun} names only` },
        { from: "planner", to: "validate", label: "proposed layout" },
        { from: "validate", to: "planner", label: "corrections" },
        { from: "validate", to: "pages", label: "approved layout" },
        { from: "calculate", to: "pages", label: "validated metrics" },
        { from: "pages", to: "attention", label: "monitor and refresh" },
      ],
    },
  });

  if (spec.schemaVersion !== "1.2") {
    throw new Error("Planned dashboard must use DashboardSpec 1.2");
  }
  return spec;
}
