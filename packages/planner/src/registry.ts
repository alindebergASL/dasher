import type { DashboardComponent } from "@dasher/dashboard-schema";

/**
 * What Dasher knows about each section a plan may name.
 *
 * This is the PATTERN layer of the precedent-library design
 * (`docs/plans/2026-08-20-precedent-library.md`) and the decision behind it is
 * ADR-010. It is deliberately not a menu of dashboards. It is the envelope a
 * composition has to fit inside: the closed set of sections, what each one is
 * for, what it needs in order to render, and what it compiles to. A generator
 * chooses freely within it; a plan that leaves it is refused with a reason.
 *
 * WHY THIS FILE EXISTS AT ALL. Every fact below was already true and already
 * enforced — scattered across four modules that could disagree with each other
 * and with the compiler:
 *
 * - the closed set lived in `plan.ts` as `PLAN_SECTION_KINDS`;
 * - which sections need a station lived in `plan.ts` as a private `Set` whose
 *   comment named two of its four exclusions and silently omitted the others;
 * - what each section compiles to lived in `compile.ts`'s switch;
 * - which words call for a section lived in `provider.ts` as `SECTION_WORDS`;
 * - what a section is FOR lived nowhere, which is why the model prompt offered
 *   a bare list of eight names and no way to choose between them.
 *
 * Consolidating is the point, but it is not the guarantee. The guarantee is
 * `registry.test.ts`: one block per entry, each checking the entry against what
 * the compiler and the validator actually do, rather than against itself. A
 * registry that merely describes the code is a second thing to keep in sync; a
 * registry the code reads and the tests bind to reality is the source.
 *
 * GOVERNANCE. Draco 2's operating model, which this borrows: a test and
 * co-located documentation per entry, and a version stamp on the whole. The
 * version is monolithic and semantic — one number for the registry, not one per
 * entry — because entries are read together and a plan is valid against the set:
 *
 * - MAJOR: a kind is added to or removed from the offered set, or a trigger
 *   word's meaning changes. Either can change which plan a request produces.
 * - MINOR: a new entry ships `experimental`, or an entry is promoted or
 *   deprecated.
 * - PATCH: `summary` or `guidance` wording.
 */
export const PATTERN_REGISTRY_VERSION = "1.0.0";

/**
 * The closed set of sections the trusted compiler knows how to build. A plan
 * naming anything outside this list is rejected, so an unsupported or invented
 * section can never reach the renderer.
 *
 * It lives here rather than in `plan.ts` so that the schema and the registry
 * cannot disagree about what a section is: the schema's enum is built from this
 * list, and the registry is typed as one entry per member of it, so a kind
 * without an entry is a compile error rather than a runtime surprise.
 */
export const PLAN_SECTION_KINDS = [
  "conditions-summary",
  "headline-metrics",
  "gauge-map",
  "fastest-rising",
  "attention",
  "gauge-table",
  "stage-trends",
  "change-windows",
] as const;

export type PlanSectionKind = (typeof PLAN_SECTION_KINDS)[number];

/**
 * Where an entry is in its life.
 *
 * `deprecated` is the one with teeth, and it is what makes this field more than
 * a label. A deprecated kind stops being OFFERED — it leaves the model prompt
 * and stops being reachable by a refinement instruction — while it keeps
 * COMPILING, because plans naming it are already persisted and a reopened
 * dashboard has to keep rendering. Removal from the schema is a separate,
 * later, breaking change. See `offeredEntries`.
 */
export type PatternStatus = "experimental" | "stable" | "deprecated";

export interface PatternEntry {
  /** The word a plan uses. */
  readonly kind: PlanSectionKind;
  /**
   * The contract component this compiles to.
   *
   * The plan vocabulary and the contract vocabulary are deliberately different
   * (ADR-007): plans still say `gauge-map` while the contract says
   * `station-map`. This field is that mapping, stated once. Its consumer today
   * is the per-entry test that compiles a plan containing only this section and
   * checks what came out — which is what keeps it true — and the layout slice,
   * which needs a section's shape without compiling it.
   */
  readonly componentKind: DashboardComponent["kind"];
  /** One sentence: what this section shows. Co-located documentation. */
  readonly summary: string;
  /**
   * What a planner needs in order to choose this section well, written for a
   * planner and not for a reader. This is what the model prompt carries.
   */
  readonly guidance: string;
  /**
   * Words in a request or a change instruction that call for this section.
   *
   * Matched as substrings, case-folded, so no word here may contain another
   * entry's word — a collision would silently route an instruction to two
   * sections. The registry test checks that across the whole set.
   */
  readonly triggerWords: readonly string[];
  /**
   * Whether this section describes individual stations and therefore cannot
   * render from an empty selection.
   */
  readonly requiresSites: boolean;
  /**
   * Whether the compiler may leave this section out of a dashboard that planned
   * it, when it has nothing to show.
   *
   * True for exactly one section today, and the asymmetry is the point: a
   * section that silently vanishes is a promise the plan made and the dashboard
   * did not keep, so it needs a reason. `stage-trends` has one — a station needs
   * two observations to draw a line, and a trend list with no series renders as
   * an empty panel.
   */
  readonly mayBeOmitted: boolean;
  readonly status: PatternStatus;
}

/**
 * One entry per kind, checked by the type system: an object literal typed as
 * `Record<PlanSectionKind, …>` cannot omit a kind and cannot invent one.
 */
export const PATTERN_REGISTRY: Readonly<Record<PlanSectionKind, PatternEntry>> =
  {
    "conditions-summary": {
      kind: "conditions-summary",
      componentKind: "summary",
      summary:
        "Three computed claims about the selected stations, under the plan's own framing sentence.",
      guidance:
        "The dashboard's opening statement. Choose it when the reader wants to know where things stand before seeing any detail. Every one of its claims has a zero case, so it stays truthful and stays present when nothing qualifies.",
      triggerWords: ["summary", "overview"],
      requiresSites: false,
      mayBeOmitted: false,
      status: "stable",
    },
    "headline-metrics": {
      kind: "headline-metrics",
      componentKind: "metric-grid",
      summary:
        "Four counts: stations monitored, rising, falling, and needing a freshness check.",
      guidance:
        "Counts, never readings. Choose it when the reader wants the scale of the thing at a glance. It says nothing about WHICH station, so it does not stand in for a table or a map.",
      triggerWords: ["metric", "at a glance", "headline", "numbers"],
      requiresSites: false,
      mayBeOmitted: false,
      status: "stable",
    },
    "gauge-map": {
      kind: "gauge-map",
      componentKind: "station-map",
      summary:
        "Every selected station plotted, selectable for its current reading.",
      guidance:
        "The only section that answers 'where'. Choose it when location is part of the question — which part of the network, upstream or downstream, near what. It needs at least one station.",
      triggerWords: ["map", "locations", "where"],
      requiresSites: true,
      mayBeOmitted: false,
      status: "stable",
    },
    "fastest-rising": {
      kind: "fastest-rising",
      componentKind: "ranking",
      summary:
        "Fresh, complete stations ordered by one-hour change in the primary reading.",
      guidance:
        "An ordering. Choose it when the reader asked which one rather than how many. It ranks only the stations fresh and complete enough to be ranked and says so, rather than padding the list to look fuller.",
      triggerWords: ["fastest", "ranking", "rising", "ranked"],
      requiresSites: false,
      mayBeOmitted: false,
      status: "stable",
    },
    attention: {
      kind: "attention",
      componentKind: "alert-list",
      summary:
        "Data-quality and threshold alerts, with an explicit line when nothing qualifies.",
      guidance:
        "Choose it when the reader is monitoring rather than browsing. Its value depends on staying scarce: a dashboard that always has something in this section teaches the reader to skip it.",
      triggerWords: ["alert", "attention", "warning", "concern"],
      requiresSites: false,
      mayBeOmitted: false,
      status: "stable",
    },
    "gauge-table": {
      kind: "gauge-table",
      componentKind: "station-table",
      summary:
        "Every selected station as a row: current reading, recent change, direction, freshness.",
      guidance:
        "The complete, comparable view. Choose it when the reader wants all of it rather than a selection, or wants to hold stations against each other. Its column headings come from the domain, not from the plan.",
      triggerWords: ["table", "readings", "list"],
      requiresSites: true,
      mayBeOmitted: false,
      status: "stable",
    },
    "stage-trends": {
      kind: "stage-trends",
      componentKind: "trend-list",
      summary:
        "One series per station with enough history to draw, over the recent window.",
      guidance:
        "Choose it when the question is about movement over time rather than the current value. It is the one section the compiler may leave out: a station needs at least two observations to draw a line.",
      triggerWords: ["trend", "history", "chart", "graph"],
      requiresSites: true,
      mayBeOmitted: true,
      status: "stable",
    },
    "change-windows": {
      kind: "change-windows",
      componentKind: "ranking",
      summary:
        "Every selected station with its one-hour, six-hour and twenty-four-hour change side by side.",
      guidance:
        "Choose it when short and long movement need to be read against each other — a rise over an hour means something different beside a fall over a day. Unlike fastest-rising it keeps every station rather than ranking a qualifying subset.",
      triggerWords: ["window", "change"],
      requiresSites: true,
      mayBeOmitted: false,
      status: "stable",
    },
  };

/**
 * Every entry, in the order the closed set is presented and iterated.
 *
 * Order is part of the registry rather than incidental: it is the order the
 * model prompt lists sections in and the order a refinement instruction is
 * matched against, so changing it changes behaviour.
 */
export const PATTERN_ENTRIES: readonly PatternEntry[] = PLAN_SECTION_KINDS.map(
  (kind) => PATTERN_REGISTRY[kind],
);

export function patternFor(kind: PlanSectionKind): PatternEntry {
  return PATTERN_REGISTRY[kind];
}

/**
 * The entries a planner may still choose from.
 *
 * Deliberately a pure function over a list rather than a constant derived from
 * the module's own registry: deprecation is a rule, and a rule no entry
 * currently exercises is a rule nothing proves. Passing the list in lets the
 * registry test hand it a deprecated entry and check that the filtering is real,
 * without putting a test seam in the shipped registry.
 *
 * What this does NOT filter is the plan schema. A deprecated kind still parses,
 * still validates and still compiles, because plans naming it are already
 * persisted and a reopened dashboard has to keep rendering. Deprecation removes
 * a section from what Dasher will PROPOSE, not from what it will honour.
 */
export function offeredEntries(
  entries: readonly PatternEntry[],
): readonly PatternEntry[] {
  return entries.filter((entry) => entry.status !== "deprecated");
}
