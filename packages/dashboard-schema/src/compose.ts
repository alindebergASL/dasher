/**
 * Compose several finished dashboards into one, without any domain's rules
 * touching another's numbers.
 *
 * This is the smallest seam a multi-source dashboard needs. Each source is
 * built by its own parser, computation policy, vocabulary, thresholds and
 * builder, exactly as it is today, and arrives here as a finished
 * `DashboardSpec`. Nothing here recomputes a reading, re-derives a trend, or
 * applies one domain's tolerance to another's values — it arranges, attributes,
 * and re-checks. That is deliberate: the moment composition starts computing,
 * "air values under river rules" becomes reachable.
 *
 * A SOURCE THAT DID NOT LOAD IS COMPOSED TOO, as an absence. It contributes no
 * page, no evidence and no architecture node — nothing was fetched, so there is
 * nothing to show — but it keeps its place in every attributed line, and it
 * costs the dashboard its `fresh` status and its observation timestamp. See
 * `AbsentSource`.
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

/**
 * A source that was asked for and could not be loaded.
 *
 * WHY AN ABSENCE IS A COMPOSITION MEMBER AND NOT A CALLER'S FOOTNOTE. There
 * are three things this module could do when one of several sources fails, and
 * only one of them is honest:
 *
 * - refuse the whole request. Truthful, and it was the shipped behaviour, but
 *   at 95% per-source availability it throws away 10% of two-source requests
 *   and 23% of five-source ones over a fault in a part the reader may not even
 *   have been looking at.
 * - show what loaded and say nothing. This is the failure the rest of the
 *   product exists to prevent: a page that answers a narrower question than
 *   the one asked, while looking like it answered the one asked.
 * - show what loaded and SAY WHAT IS MISSING. That is this.
 *
 * Making the absence a member rather than a caller-supplied sentence is what
 * makes the third option hold. Attribution, freshness and the observation
 * timestamp all run over present and absent members together, so a source
 * cannot be dropped from one of those surfaces by forgetting it there: the
 * reader sees the same named voices in the brief, the next action and the
 * freshness line whether or not that voice had data.
 *
 * It carries no reason. Which upstream failed and why is a server-side fact;
 * to the reader it is one fact — this part could not be built — and the
 * difference between a 401 and a timeout must not become a description of
 * Dasher's credentials.
 */
export interface AbsentSource {
  /** Namespace it would have used. Checked against the present sources' keys. */
  readonly key: string;
  /** How the absence is attributed, e.g. "Air quality". */
  readonly label: string;
}

export interface ComposeOptions {
  readonly id: string;
  readonly title: string;
  readonly audience: string;
  readonly notice: string;
  /**
   * Sources that were asked for and did not load. Empty or omitted is the
   * ordinary case; when it is not empty the result is a partial dashboard and
   * the caller's `title` and `notice` are the two places that must say so —
   * this module cannot know what the reader typed.
   */
  readonly absent?: readonly AbsentSource[];
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
 * The floor is two VOICES, not two loaded sources: one present source beside
 * one absence is still a composition, and composing it is what lets a partial
 * dashboard keep the same shape as the whole one it was asked to be.
 */
export type ComposedSources = readonly ComposedSource[];

/**
 * How many sources one dashboard may combine today.
 *
 * Deliberately low, and deliberately a constant rather than a type. What used
 * to make raising it expensive was the fail-closed policy — refuse unless every
 * source loads — because at 95% per-source availability that succeeds 90% of
 * the time at two sources, 77% at five and 60% at ten. Degrading per source
 * removes that arithmetic as an obstacle: a large N now loses parts rather than
 * whole dashboards.
 *
 * What still binds is the reader. Every additional voice lengthens the same
 * attributed sentences and the same freshness line, and those are bounded by
 * the contract's short-text limit. Raising this number is a decision about how
 * much a person can hold at once, which is the right thing for it to be about.
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
function attribute(
  labels: readonly string[],
  texts: readonly string[],
): string {
  // Every text but the last is sentence-terminated before the next label
  // follows it; the last is left as its source wrote it.
  return labels
    .map((label, index) => {
      const text = (texts[index] ?? "").trimEnd();
      const isLast = index === labels.length - 1;
      const terminated = isLast || SENTENCE_END.test(text) ? text : `${text}.`;
      return `${label}: ${terminated}`;
    })
    .join(" ");
}

function joinHeadlines(
  labels: readonly string[],
  texts: readonly string[],
): string {
  return labels
    .map((label, index) => `${label}: ${texts[index] ?? ""}`)
    .join(" · ");
}

/**
 * What an absence says where a source's own words would have been.
 *
 * "When this dashboard was built" and not "right now": a saved dashboard is
 * reopened later, and by then the source may well be answering again. The
 * sentence has to stay true in the archive, because that is where it will
 * mostly be read.
 *
 * It is already terminated, so it survives being last in an attributed line
 * without picking up a second full stop.
 */
const ABSENT_DETAIL = "unavailable when this dashboard was built.";
/** The same fact where headlines are joined, which are labels and not sentences. */
const ABSENT_HEADLINE = "unavailable";

/** Present labels then absent ones, in the order the caller gave them. */
function voiceLabels(
  sources: ComposedSources,
  absent: readonly AbsentSource[],
): string[] {
  return [
    ...sources.map((source) => source.label),
    ...absent.map((a) => a.label),
  ];
}

/** One source's own words for each present voice, the fixed text for each absence. */
function voiceTexts(
  sources: ComposedSources,
  absent: readonly AbsentSource[],
  say: (source: ComposedSource) => string,
  whenAbsent: string,
): string[] {
  return [...sources.map(say), ...absent.map(() => whenAbsent)];
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
 * All fresh is fresh, all stale is stale, anything else is partial.
 *
 * `partial` is the only honest answer to a mixture: a combined dashboard whose
 * river half is current and whose air half is not is neither fresh nor stale,
 * and calling it either would misdescribe half the page.
 *
 * AN ABSENCE IS A MIXTURE OF ONE. A source that did not load has no freshness
 * at all, so it satisfies neither quantifier, and a dashboard missing a part it
 * was asked for cannot be `fresh` however current the parts it has. This is the
 * machine-readable half of the honest partial: a reader who never reaches the
 * notice still sees the page decline to call itself current.
 */
function composeFreshness(
  sources: ComposedSources,
  absent: readonly AbsentSource[],
): DashboardSpec["freshness"] {
  const parts = sources.map((source) => source.dashboard.freshness);

  // EVERY part fresh is fresh; every part stale is stale; any mixture is
  // partial. The pair version read "a && b"; the N version is the same rule
  // with the quantifier made explicit, which is what it always meant. Absences
  // are counted in the denominator and satisfy neither.
  const total = parts.length + absent.length;
  const status =
    parts.filter((part) => part.status === "fresh").length === total
      ? "fresh"
      : parts.filter((part) => part.status === "stale").length === total
        ? "stale"
        : "partial";

  // The EARLIEST of them, and only when EVERY voice has one. A missing
  // timestamp is the least current state there is — unknown — so it cannot be
  // filtered past on the way to a minimum, or the parts that did report would
  // stand for the whole page under a single heading. An absence is exactly such
  // a missing timestamp, which is why it suppresses this field rather than
  // letting the loaded sources date the page.
  const observations = parts.map((part) => part.latestObservationAt);
  const known = observations.filter(
    (value): value is string => value !== undefined,
  );
  const earliest =
    known.length === total
      ? known.slice().sort((x, y) => Date.parse(x) - Date.parse(y))[0]
      : undefined;

  return {
    status,
    label: joinHeadlines(
      voiceLabels(sources, absent),
      voiceTexts(
        sources,
        absent,
        (source) => source.dashboard.freshness.label,
        ABSENT_HEADLINE,
      ),
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
  const absent = options.absent ?? [];
  const voices = sources.length + absent.length;

  // Arity is checked here, not in the type. Two rules, and they are different
  // rules: at least one source must have LOADED, because a page of nothing but
  // absences is a refusal wearing a dashboard's clothes and the caller owns
  // that message; and at least two must have been ASKED FOR, because one source
  // on its own is not a composition and the caller should build it directly.
  if (sources.length < 1) {
    throw new DashboardCompositionError(
      "Composition needs at least one source that loaded; received none.",
    );
  }
  if (voices < 2) {
    throw new DashboardCompositionError(
      `Composition needs at least two sources; received ${String(voices)}.`,
    );
  }
  if (voices > MAX_COMPOSED_SOURCES) {
    throw new DashboardCompositionError(
      `Composition is limited to ${String(MAX_COMPOSED_SOURCES)} sources; received ${String(voices)}.`,
    );
  }

  // Absences are namespaced along with the rest. Their key claims no ids today,
  // but it is the same key the source would have used, and letting it collide
  // here would mean a request whose duplicate only becomes an error on the days
  // both sources happen to be up.
  const keys = [
    ...sources.map((source) => source.key),
    ...absent.map((a) => a.key),
  ];
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) {
    throw new DashboardCompositionError(
      `More than one source uses the namespace ${JSON.stringify(duplicate)}; structural ids would collide.`,
    );
  }

  const labels = voiceLabels(sources, absent);

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
      headline: joinHeadlines(labels, [
        ...claims.map((entry) => entry.headline),
        ...absent.map(() => ABSENT_HEADLINE),
      ]),
      detail: attribute(labels, [
        ...claims.map((entry) => entry.detail),
        ...absent.map(() => ABSENT_DETAIL),
      ]),
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
    freshness: composeFreshness(sources, absent),
    nextAction: {
      title: joinHeadlines(
        labels,
        voiceTexts(
          sources,
          absent,
          (source) => source.dashboard.nextAction.title,
          ABSENT_HEADLINE,
        ),
      ),
      detail: attribute(
        labels,
        voiceTexts(
          sources,
          absent,
          (source) => source.dashboard.nextAction.detail,
          ABSENT_DETAIL,
        ),
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
        labels,
        voiceTexts(
          sources,
          absent,
          (source) => source.dashboard.architecture.summary,
          ABSENT_DETAIL,
        ),
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
