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

/**
 * Two or more sources, checked at runtime rather than pinned in the type.
 *
 * This was a 2-tuple, which made the count a fact about the type system: three
 * sources did not compile, so raising the limit meant rewriting the module
 * rather than changing a number. That is the wrong place for a product
 * decision to live. The count is now a POLICY value —
 * `MAX_COMPOSED_SOURCES` — and every rule below is written for N.
 *
 * The floor of two is real: one source is not a composition, and the caller
 * should build it directly.
 */
export type ComposedSources = readonly ComposedSource[];

/**
 * How many sources one dashboard may combine today.
 *
 * Deliberately low, and deliberately a constant rather than a type. Raising it
 * is a product decision that must be taken together with the fail-closed
 * policy: composition currently refuses unless every source loads, and at 95%
 * per-source availability that succeeds 90% of the time at two sources, 77% at
 * five, 60% at ten. The arithmetic — not the rendering — is what makes a large
 * N a different product.
 */
export const MAX_COMPOSED_SOURCES = 3;

export class DashboardCompositionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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
function mergeEvidenceIds(lists: readonly (readonly string[])[]): string[] {
  const interleaved: string[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const id = list[index];
      if (id !== undefined) interleaved.push(id);
    }
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
  lists: readonly (readonly string[])[],
): StatementType[] {
  const present = new Set(lists.flat());
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
function attribute(sources: ComposedSources, texts: readonly string[]): string {
  // Every text but the last is sentence-terminated before the next label
  // follows it; the last is left as its source wrote it.
  return sources
    .map((source, index) => {
      const text = (texts[index] ?? "").trimEnd();
      const isLast = index === sources.length - 1;
      const terminated = isLast || SENTENCE_END.test(text) ? text : `${text}.`;
      return `${source.label}: ${terminated}`;
    })
    .join(" ");
}

function joinHeadlines(
  sources: ComposedSources,
  texts: readonly string[],
): string {
  return sources
    .map((source, index) => `${source.label}: ${texts[index] ?? ""}`)
    .join(" · ");
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
  const parts = sources.map((source) => source.dashboard.freshness);

  // EVERY half fresh is fresh; every half stale is stale; any mixture is
  // partial. The pair version read "a && b"; the N version is the same rule
  // with the quantifier made explicit, which is what it always meant.
  const status = parts.every((part) => part.status === "fresh")
    ? "fresh"
    : parts.every((part) => part.status === "stale")
      ? "stale"
      : "partial";

  // The EARLIEST of them, and only when EVERY half has one. A missing
  // timestamp is the least current state there is — unknown — so it cannot be
  // filtered past on the way to a minimum, or the halves that did report would
  // stand for the whole page under a single heading.
  const observations = parts.map((part) => part.latestObservationAt);
  const known = observations.filter(
    (value): value is string => value !== undefined,
  );
  const earliest =
    known.length === observations.length
      ? known.slice().sort((x, y) => Date.parse(x) - Date.parse(y))[0]
      : undefined;

  return {
    status,
    label: joinHeadlines(
      sources,
      parts.map((part) => part.label),
    ),
    ...(earliest === undefined ? {} : { latestObservationAt: earliest }),
  };
}

/**
 * The contract check, with its failure named for what it is.
 *
 * Only the composed result goes through here. Each source was already parsed
 * by whoever built it, so a failure at this point is a property of the SET —
 * sources that cannot share one spec — rather than of any one of them.
 */
function parseComposed(candidate: unknown): DashboardSpec {
  try {
    return parseDashboardSpec(candidate);
  } catch (error) {
    throw new DashboardCompositionError(
      "The combined dashboard does not satisfy the dashboard contract; these sources cannot be shown together.",
      { cause: error },
    );
  }
}

export function composeDashboards(
  sources: ComposedSources,
  options: ComposeOptions,
): DashboardSpec {
  // Arity is checked here, not in the type. One source is not a composition;
  // the ceiling is a product policy that moves with the fail-closed decision.
  if (sources.length < 2) {
    throw new DashboardCompositionError(
      `Composition needs at least two sources; received ${String(sources.length)}.`,
    );
  }
  if (sources.length > MAX_COMPOSED_SOURCES) {
    throw new DashboardCompositionError(
      `Composition is limited to ${String(MAX_COMPOSED_SOURCES)} sources; received ${String(sources.length)}.`,
    );
  }

  const keys = sources.map((source) => source.key);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) {
    throw new DashboardCompositionError(
      `More than one source uses the namespace ${JSON.stringify(duplicate)}; structural ids would collide.`,
    );
  }

  // Sources cannot be honestly labelled with one mode unless they agree. Demo
  // readings beside live ones under a single "live" banner is exactly the
  // confident wrongness the rest of this product refuses.
  const modes = [
    ...new Set(sources.map((source) => source.dashboard.dataMode)),
  ];
  if (modes.length > 1) {
    throw new DashboardCompositionError(
      `Sources disagree about data mode: ${modes.join(" and ")}.`,
    );
  }
  const dataMode = modes[0]!;

  const remapped = sources.map(remapSpec);

  // The LATEST of them: the contract requires every evidence `retrievedAt` and
  // the freshness timestamp to fall at or before `generatedAt`, and taking an
  // earlier one could put another source's evidence in the future.
  const generatedAt = sources
    .map((source) => source.dashboard.generatedAt)
    .sort((x, y) => Date.parse(y) - Date.parse(x))[0]!;

  const brief = (
    claim: "known" | "changed" | "important",
  ): DashboardSpec["executiveBrief"]["known"] => {
    const claims = sources.map(
      (source) => source.dashboard.executiveBrief[claim],
    );
    return {
      statementTypes: mergeStatementTypes(
        claims.map((entry) => entry.statementTypes),
      ),
      headline: joinHeadlines(
        sources,
        claims.map((entry) => entry.headline),
      ),
      detail: attribute(
        sources,
        claims.map((entry) => entry.detail),
      ),
      evidenceIds: mergeEvidenceIds(
        claims.map((entry, index) =>
          entry.evidenceIds.map((id) => namespaced(sources[index]!.key, id)),
        ),
      ),
    };
  };

  // Re-parsed, not assembled and trusted. Everything a merge can break —
  // colliding ids, dangling evidence, orphaned edges, budget overruns — is
  // already the contract's job, and this is where that job runs.
  //
  // ITS REJECTION IS TRANSLATED, NOT RE-RAISED. A `ZodError` escaping here is
  // indistinguishable to a caller from a genuine fault, so it was being caught
  // as "something went wrong" and reported to the reader as an invitation to
  // reword — advice that cannot work, because no wording makes several
  // dashboards fit inside one budget. Composition failing the contract is a
  // REFUSAL: this set cannot be combined honestly. The reason is preserved as
  // `cause` for logs; the caller decides what a reader is told.
  return parseComposed({
    schemaVersion: "1.2",
    id: options.id,
    title: options.title,
    audience: options.audience,
    generatedAt,
    dataMode,
    freshness: composeFreshness(sources),
    nextAction: {
      title: joinHeadlines(
        sources,
        sources.map((source) => source.dashboard.nextAction.title),
      ),
      detail: attribute(
        sources,
        sources.map((source) => source.dashboard.nextAction.detail),
      ),
      evidenceIds: mergeEvidenceIds(
        sources.map((source) =>
          source.dashboard.nextAction.evidenceIds.map((id) =>
            namespaced(source.key, id),
          ),
        ),
      ),
    },
    notice: options.notice,
    pages: remapped.flatMap((entry) => entry.pages),
    evidence: remapped.flatMap((entry) => entry.evidence),
    architecture: {
      title: options.title,
      summary: attribute(
        sources,
        sources.map((source) => source.dashboard.architecture.summary),
      ),
      nodes: remapped.flatMap((entry) => entry.nodes),
      edges: remapped.flatMap((entry) => entry.edges),
    },
    executiveBrief: {
      known: brief("known"),
      changed: brief("changed"),
      important: brief("important"),
    },
  });
}
