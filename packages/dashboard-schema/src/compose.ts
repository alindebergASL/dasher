/**
 * Compose two finished dashboards into one, without either domain's rules
 * touching the other's numbers.
 *
 * This is the smallest seam that a two-source dashboard needs. Each source is
 * built by its own parser, computation policy, vocabulary, thresholds and
 * builder, exactly as it is today, and arrives here as a finished
 * `DashboardSpec`. Nothing here recomputes a reading, re-derives a trend, or
 * applies one domain's tolerance to another's values — it arranges, attributes,
 * and re-checks. That is deliberate: the moment composition starts computing,
 * "air values under river rules" becomes reachable.
 *
 * THE CONTRACT IS THE CHECK. Composition ends by running the result through
 * `parseDashboardSpec`, which already enforces everything a merge can break:
 * unique page, component, evidence and architecture-node ids; every evidence
 * reference resolving; every architecture edge landing on a real node; and the
 * complexity budgets. So an incomplete namespacing is a thrown error rather
 * than a dashboard with dangling references, and this module does not
 * reimplement a single one of those rules.
 */

import {
  DASHBOARD_MAX_EVIDENCE_IDS,
  parseDashboardSpec,
  type DashboardSpec,
} from "./schema";

export interface ComposedSource {
  /**
   * Namespace for this source's structural ids. Must differ between sources;
   * the contract check catches it if it does not.
   */
  readonly key: string;
  /** How a reader sees this source attributed, e.g. "River conditions". */
  readonly label: string;
  readonly dashboard: DashboardSpec;
}

export interface ComposeOptions {
  readonly id: string;
  readonly title: string;
  readonly audience: string;
  readonly notice: string;
}

/** Exactly two. Widening this is a product decision, not a refactor. */
export type ComposedSources = readonly [ComposedSource, ComposedSource];

export class DashboardCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardCompositionError";
  }
}

/**
 * Structural ids get namespaced. Ids a READER sees do not.
 *
 * Page, component, evidence and architecture-node ids are plumbing: two
 * independently built dashboards both call a component `conditions-summary`
 * and both call an architecture node `request`, so without a prefix they
 * collide the moment they share a spec.
 *
 * Station, ranking, series and alert ids are the opposite. They are data
 * identity and they are rendered — the station table prints the site id, and
 * the map's accessible name reads it out. Prefixing those would put
 * `river:11447650` in front of a reader. They also cannot collide across
 * sources, because the contract checks them per component and the two domains
 * never share one.
 */
function namespaced(key: string, id: string): string {
  return `${key}:${id}`;
}

/**
 * Round-robin, then cap.
 *
 * Evidence-reference lists are bounded by the contract, and a union of two
 * full lists can exceed that bound. Taking the first N would silently drop one
 * source entirely; interleaving guarantees both sources are represented in
 * whatever survives. The cap is lossy either way — these are supporting links
 * rather than the claim itself — so the honest choice is the one that cannot
 * make a two-source claim look single-source.
 */
function mergeEvidenceIds(
  first: readonly string[],
  second: readonly string[],
): string[] {
  const interleaved: string[] = [];
  for (
    let index = 0;
    index < Math.max(first.length, second.length);
    index += 1
  ) {
    const a = first[index];
    const b = second[index];
    if (a !== undefined) interleaved.push(a);
    if (b !== undefined) interleaved.push(b);
  }
  return [...new Set(interleaved)].slice(0, DASHBOARD_MAX_EVIDENCE_IDS);
}

const STATEMENT_ORDER = ["observed", "calculated", "interpreted"] as const;
type StatementType = (typeof STATEMENT_ORDER)[number];

/**
 * The contract allows at most two statement types per brief claim, and a union
 * of two claims can name three. Something has to be dropped, and the direction
 * matters: dropping `interpreted` would present interpretation as observation,
 * which overstates the claim. Dropping `observed` understates it. Understating
 * is the safe error, so the weaker kinds are kept.
 */
function mergeStatementTypes(
  first: readonly string[],
  second: readonly string[],
): StatementType[] {
  const present = new Set([...first, ...second]);
  const keptWeakestFirst = (["interpreted", "calculated", "observed"] as const)
    .filter((type) => present.has(type))
    .slice(0, 2);
  return STATEMENT_ORDER.filter((type) => keptWeakestFirst.includes(type));
}

/**
 * Terminal punctuation, allowing one closing bracket or quote after it, so
 * `(provisional.)` is recognised as already ended rather than given a second
 * full stop.
 */
const SENTENCE_END = /[.!?\u2026][)\]"'\u201d\u2019]?$/u;

/**
 * Attributed, never blended: a reader can always see which source said what.
 *
 * The first source's text is sentence-terminated before the second label
 * follows it. Detail strings are prose and do not all end in punctuation — the
 * river half's highest-priority line ends "…more than two hours old" — so
 * joining on a bare space produced
 *
 *   "…Water-level reading is more than two hours old Air quality: Highest
 *    priority: Elevated PM2.5 watch…"
 *
 * two sentences fused into one unreadable run, on the executive brief and the
 * next action of every combined dashboard.
 *
 * IT SHIPPED THAT WAY, and the reason is worth keeping: the tests on either
 * side of this function asserted that both labels APPEAR, which is exactly as
 * true of fused prose as of separated prose. An assertion that cannot fail on
 * the defect is not a test of it. The tests now pin the boundary itself.
 *
 * Headlines keep `·` instead: they are labels rather than sentences, and a
 * full stop after one would be wrong in the other direction.
 */
function attribute(
  sources: ComposedSources,
  texts: readonly [string, string],
): string {
  const lead = texts[0].trimEnd();
  const terminated = SENTENCE_END.test(lead) ? lead : `${lead}.`;
  return `${sources[0].label}: ${terminated} ${sources[1].label}: ${texts[1]}`;
}

function joinHeadlines(
  sources: ComposedSources,
  texts: readonly [string, string],
): string {
  return `${sources[0].label}: ${texts[0]} · ${sources[1].label}: ${texts[1]}`;
}

function remapSpec(source: ComposedSource): {
  pages: DashboardSpec["pages"];
  evidence: DashboardSpec["evidence"];
  nodes: DashboardSpec["architecture"]["nodes"];
  edges: DashboardSpec["architecture"]["edges"];
} {
  const { key, label, dashboard } = source;
  const id = (value: string): string => namespaced(key, value);

  return {
    pages: dashboard.pages.map((page) => ({
      ...page,
      id: id(page.id),
      // Page TITLES are attributed as well as page ids, and for a different
      // reason. Ids are namespaced so the contract stays satisfiable; titles
      // are attributed so the reader can tell the halves apart. Both domains
      // legitimately call their first page "Overview", and a navigation list
      // reading "01 Overview / 02 Overview" tells a reader nothing about
      // which subject they are about to open. Nothing further down is
      // prefixed: inside an already-attributed page, "Current readings" is
      // unambiguous, and prefixing every component would be noise.
      title: `${label} — ${page.title}`,
      components: page.components.map((component) => {
        const base = {
          ...component,
          id: id(component.id),
          evidenceIds: component.evidenceIds.map(id),
        };
        // Every per-item evidence reference has to move with the evidence it
        // points at. Missing one here is not a silent defect: the contract
        // refuses a dangling reference when this result is re-parsed.
        switch (base.kind) {
          case "summary":
            return {
              ...base,
              claims: base.claims.map((claim) => ({
                ...claim,
                evidenceIds: claim.evidenceIds.map(id),
              })),
            };
          case "metric-grid":
            return {
              ...base,
              metrics: base.metrics.map((metric) => ({
                ...metric,
                evidenceIds: metric.evidenceIds.map(id),
              })),
            };
          case "station-map":
          case "station-table":
            return {
              ...base,
              stations: base.stations.map((station) => ({
                ...station,
                evidenceIds: station.evidenceIds.map(id),
              })),
            };
          case "ranking":
            return {
              ...base,
              items: base.items.map((item) => ({
                ...item,
                evidenceIds: item.evidenceIds.map(id),
              })),
            };
          case "trend-list":
            return {
              ...base,
              series: base.series.map((series) => ({
                ...series,
                evidenceIds: series.evidenceIds.map(id),
              })),
            };
          case "alert-list":
            return {
              ...base,
              alerts: base.alerts.map((alert) => ({
                ...alert,
                evidenceIds: alert.evidenceIds.map(id),
              })),
            };
        }
      }),
    })),
    evidence: dashboard.evidence.map((item) => ({ ...item, id: id(item.id) })),
    nodes: dashboard.architecture.nodes.map((node) => ({
      ...node,
      id: id(node.id),
    })),
    edges: dashboard.architecture.edges.map((edge) => ({
      ...edge,
      from: id(edge.from),
      to: id(edge.to),
    })),
  };
}

/**
 * Both fresh is fresh, both stale is stale, anything else is partial.
 *
 * `partial` is the only honest answer to a mixed pair: a combined dashboard
 * whose river half is current and whose air half is not is neither fresh nor
 * stale, and calling it either would misdescribe half the page.
 */
function composeFreshness(
  sources: ComposedSources,
): DashboardSpec["freshness"] {
  const [first, second] = sources;
  const a = first.dashboard.freshness;
  const b = second.dashboard.freshness;

  const status =
    a.status === "fresh" && b.status === "fresh"
      ? "fresh"
      : a.status === "stale" && b.status === "stale"
        ? "stale"
        : "partial";

  // The EARLIEST of the two, not the latest. A combined dashboard is only as
  // current as its least current half, and reporting the newer timestamp would
  // let a just-updated river reading vouch for hours-old air data.
  const observations = [a.latestObservationAt, b.latestObservationAt].filter(
    (value): value is string => value !== undefined,
  );
  const earliest = observations
    .slice()
    .sort((x, y) => Date.parse(x) - Date.parse(y))[0];

  return {
    status,
    label: `${first.label}: ${a.label} · ${second.label}: ${b.label}`,
    ...(earliest === undefined ? {} : { latestObservationAt: earliest }),
  };
}

export function composeDashboards(
  sources: ComposedSources,
  options: ComposeOptions,
): DashboardSpec {
  const [first, second] = sources;

  if (first.key === second.key) {
    throw new DashboardCompositionError(
      `Both sources use the namespace ${JSON.stringify(first.key)}; structural ids would collide.`,
    );
  }
  // Two sources cannot be honestly labelled with one mode. Demo readings beside
  // live ones under a single "live" banner is exactly the confident wrongness
  // the rest of this product refuses.
  if (first.dashboard.dataMode !== second.dashboard.dataMode) {
    throw new DashboardCompositionError(
      `Sources disagree about data mode: ${first.dashboard.dataMode} and ${second.dashboard.dataMode}.`,
    );
  }

  const remapped = sources.map(remapSpec) as [
    ReturnType<typeof remapSpec>,
    ReturnType<typeof remapSpec>,
  ];

  // The later of the two: the contract requires every evidence `retrievedAt`
  // and the freshness timestamp to fall at or before `generatedAt`, and taking
  // the earlier one could put the other source's evidence in the future.
  const generatedAt = [
    first.dashboard.generatedAt,
    second.dashboard.generatedAt,
  ].sort((x, y) => Date.parse(y) - Date.parse(x))[0] as string;

  const brief = (
    claim: "known" | "changed" | "important",
  ): DashboardSpec["executiveBrief"]["known"] => {
    const a = first.dashboard.executiveBrief[claim];
    const b = second.dashboard.executiveBrief[claim];
    return {
      statementTypes: mergeStatementTypes(a.statementTypes, b.statementTypes),
      headline: joinHeadlines(sources, [a.headline, b.headline]),
      detail: attribute(sources, [a.detail, b.detail]),
      evidenceIds: mergeEvidenceIds(
        a.evidenceIds.map((id) => namespaced(first.key, id)),
        b.evidenceIds.map((id) => namespaced(second.key, id)),
      ),
    };
  };

  // Re-parsed, not assembled and trusted. Everything a merge can break —
  // colliding ids, dangling evidence, orphaned edges, budget overruns — is
  // already the contract's job, and this is where that job runs.
  return parseDashboardSpec({
    schemaVersion: "1.2",
    id: options.id,
    title: options.title,
    audience: options.audience,
    generatedAt,
    dataMode: first.dashboard.dataMode,
    freshness: composeFreshness(sources),
    nextAction: {
      title: joinHeadlines(sources, [
        first.dashboard.nextAction.title,
        second.dashboard.nextAction.title,
      ]),
      detail: attribute(sources, [
        first.dashboard.nextAction.detail,
        second.dashboard.nextAction.detail,
      ]),
      evidenceIds: mergeEvidenceIds(
        first.dashboard.nextAction.evidenceIds.map((id) =>
          namespaced(first.key, id),
        ),
        second.dashboard.nextAction.evidenceIds.map((id) =>
          namespaced(second.key, id),
        ),
      ),
    },
    notice: options.notice,
    pages: [...remapped[0].pages, ...remapped[1].pages],
    evidence: [...remapped[0].evidence, ...remapped[1].evidence],
    architecture: {
      title: options.title,
      summary: attribute(sources, [
        first.dashboard.architecture.summary,
        second.dashboard.architecture.summary,
      ]),
      nodes: [...remapped[0].nodes, ...remapped[1].nodes],
      edges: [...remapped[0].edges, ...remapped[1].edges],
    },
    executiveBrief: {
      known: brief("known"),
      changed: brief("changed"),
      important: brief("important"),
    },
  });
}
