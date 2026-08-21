import {
  PLAN_MAX_SECTIONS_PER_PAGE,
  type DashboardPlan,
  type PlanFinding,
  type PlanSectionKind,
} from "./plan";
import { offeredEntries, PATTERN_ENTRIES, type PatternEntry } from "./registry";

/**
 * Context a provider may see about the available data. These are identifiers
 * and labels only — no readings, no timestamps, no evidence. A provider selects
 * from this list; it never learns a measurement, so it cannot echo one back as
 * a fact.
 */
export interface AvailableSite {
  siteId: string;
  name: string;
  river: string;
}

export interface PlanningRevision {
  /** 1 for the first revision, 2 for the second, and so on. */
  attempt: number;
  previousPlan: DashboardPlan;
  findings: readonly PlanFinding[];
}

/**
 * A change the reader asked for to a dashboard they are looking at.
 *
 * Deliberately a separate channel from `PlanningRevision`, because the two are
 * different events wearing similar shapes. A revision is Dasher correcting the
 * planner: it is machine-generated, structured, and the planner is obliged to
 * comply. A refinement is a person correcting the dashboard: it is free text of
 * exactly the same trust level as the original request, and the planner is free
 * to interpret it.
 *
 * Collapsing them would have made the loop's audit trail lie. "Attempt 2 after
 * findings" and "attempt 1 of a change the user asked for" are the same shape
 * and opposite claims about who was wrong.
 *
 * They can also co-occur: a refinement whose first plan is rejected arrives
 * carrying both.
 */
export interface PlanningRefinement {
  /** The plan behind the dashboard the reader is looking at. */
  previousPlan: DashboardPlan;
  /** What the reader asked to change, verbatim. Untrusted, like any request. */
  instruction: string;
}

export interface PlanningRequest {
  requestText: string;
  availableSites: readonly AvailableSite[];
  /** Present only when a prior plan was rejected by validation. */
  revision?: PlanningRevision;
  /** Present when the reader asked to change a dashboard they can see. */
  refinement?: PlanningRefinement;
}

/**
 * The provider-neutral planning boundary. Note the return type: a provider
 * returns `unknown`, never a `DashboardPlan`. Provider output is untrusted
 * until `runPlanner` parses it, and the type system enforces that rather than
 * relying on convention.
 *
 * There is deliberately no credential, endpoint, or tool parameter anywhere in
 * this interface. A provider implementation that needs one cannot obtain it
 * through this contract.
 */
export interface PlanningProvider {
  readonly id: string;
  /**
   * Whether a model actually chooses the composition.
   *
   * The dashboard tells its reader who made the layout decisions, and that
   * sentence has to come from the provider rather than be assumed by the
   * compiler. It was assumed once: the architecture panel said "a planning
   * model chose the layout" while the only provider in the repository was
   * keyword matching, which is a claim about AI that was not true of the
   * running system, in the one panel whose job is to explain how the dashboard
   * was made.
   */
  readonly usesModel: boolean;
  plan(request: PlanningRequest): Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * Fake provider
 * ------------------------------------------------------------------ */

/** The free text one of the fake's draft compositions carries. */
export interface FakeDraftText {
  title: string;
  audience: string;
  framing: string;
  /** One entry per page the branch composes, in order. */
  pages: ReadonlyArray<{ title: string; description: string }>;
}

/**
 * Everything the fake planner SAYS, separated from what it DOES.
 *
 * The five branches — which sections, on which pages, for which request
 * keywords — are composition logic and stay in code. The words are a domain's,
 * so they arrive as configuration: the river default below reproduces the
 * shipped dashboards byte for byte, and an air catalog entry supplies air
 * phrasing to the same branches. This is what keeps a second domain from
 * becoming a second pile of hardcoded behaviour.
 */
export interface FakePlannerPhrasing {
  emergency: FakeDraftText;
  movement: FakeDraftText;
  resident: FakeDraftText;
  map: FakeDraftText;
  overview: FakeDraftText;
}

export const RIVER_FAKE_PHRASING: FakePlannerPhrasing = {
  emergency: {
    title: "Sacramento Flood Watch",
    audience: "Emergency management leads",
    framing:
      "Conditions ordered for incident response: what needs attention first, then where it is, then how fast it is moving.",
    pages: [
      { title: "Watch", description: "Active concerns and where they are." },
      {
        title: "Movement",
        description: "How fast levels are changing and over which windows.",
      },
    ],
  },
  movement: {
    title: "Sacramento River Movement",
    audience: "Operations managers",
    framing:
      "Ordered by rate of change: the fastest movers first, then the windows behind those numbers.",
    pages: [
      {
        title: "What is moving",
        description: "Gauges ranked by recent water-level change.",
      },
      {
        title: "Context",
        description: "Where the moving gauges are and what needs a look.",
      },
    ],
  },
  resident: {
    title: "River Levels Near You",
    audience: "Homeowners and residents",
    framing:
      "A short read: whether anything needs attention right now, and the current level at each nearby gauge.",
    pages: [
      {
        title: "Right now",
        description: "Current conditions in plain language.",
      },
    ],
  },
  map: {
    title: "Sacramento Gauge Map",
    audience: "Managers and community leaders",
    framing: "Location first, with current readings beside each gauge.",
    pages: [
      { title: "Map", description: "Gauge locations and their current state." },
    ],
  },
  overview: {
    title: "Sacramento River Conditions",
    audience: "Managers and community leaders",
    framing:
      "What is happening now, what changed, and what deserves attention.",
    pages: [
      {
        title: "Overview",
        description: "What is happening now and what deserves attention.",
      },
      {
        title: "Gauge details",
        description:
          "Current readings, changes, and recent water-level history.",
      },
    ],
  },
};

/**
 * A deterministic, zero-network stand-in for a planning model.
 *
 * This is NOT a claim about how a real model behaves. Its job is to exercise
 * the plan contract, the trusted compiler, and the revision loop with no
 * network, no credentials, and no nondeterminism, so the surrounding machinery
 * can be tested and reviewed before a live provider is ever enabled.
 *
 * It does make different composition choices for different requests, which is
 * what makes the loop worth testing: the plan is not a fixed template.
 */
export class FakePlanningProvider implements PlanningProvider {
  readonly id = "fake-keyword-planner-v1";
  /** Keyword matching over the request text. No model, no network. */
  readonly usesModel = false;
  readonly phrasing: FakePlannerPhrasing;
  /**
   * The envelope this provider composes within.
   *
   * A constructor dependency for the same reason `phrasing` is one: what a
   * planner may propose is configuration, not a fact about this class. It is
   * also the only way to check that the deprecation rule reaches the path this
   * product actually ships — the registry has nothing deprecated in it, so a
   * test that cannot hand this provider a retired entry cannot tell a filtered
   * composition from an unfiltered one.
   */
  readonly entries: readonly PatternEntry[];

  constructor(
    phrasing: FakePlannerPhrasing = RIVER_FAKE_PHRASING,
    entries: readonly PatternEntry[] = PATTERN_ENTRIES,
  ) {
    this.phrasing = phrasing;
    this.entries = entries;
  }

  async plan(request: PlanningRequest): Promise<unknown> {
    // Order matters. A rejected plan has to be repaired against the findings
    // before anything else happens, whether or not a refinement is in flight —
    // otherwise a refinement would keep re-proposing the plan that was just
    // refused and burn the whole attempt budget on it.
    if (request.revision !== undefined) {
      return repair(request.revision, request.availableSites);
    }
    if (request.refinement !== undefined) {
      return refine(request.refinement, request.availableSites, this.entries);
    }
    return this.draft(request);
  }

  private draft(request: PlanningRequest): DashboardPlan {
    const text = request.requestText.toLowerCase();
    const sites = request.availableSites;
    const has = (...needles: string[]) =>
      needles.some((needle) => text.includes(needle));

    const siteIds = selectSites(text, sites);
    const compose = (
      words: FakeDraftText,
      pages: ReadonlyArray<{ id: string; sections: PlanSectionKind[] }>,
    ): DashboardPlan => ({
      planVersion: "plan-v1",
      title: words.title,
      audience: words.audience,
      framing: words.framing,
      siteIds,
      // Filtered AFTER the titles are attached, so dropping a page cannot shift
      // the phrasing index and give the next page someone else's heading.
      pages: retainOffered(
        pages.map((page, index) => ({
          id: page.id,
          title: words.pages[index]?.title ?? page.id,
          description: words.pages[index]?.description ?? page.id,
          sections: page.sections,
        })),
        this.entries,
      ),
    });

    if (has("emergency", "flood", "evacuat", "warning", "public safety")) {
      return compose(this.phrasing.emergency, [
        {
          id: "watch",
          sections: ["attention", "conditions-summary", "gauge-map"],
        },
        {
          id: "movement",
          sections: ["fastest-rising", "change-windows", "stage-trends"],
        },
      ]);
    }

    if (has("rising", "fastest", "changing", "change", "trend")) {
      return compose(this.phrasing.movement, [
        {
          id: "movement",
          sections: [
            "fastest-rising",
            "headline-metrics",
            "change-windows",
            "stage-trends",
          ],
        },
        { id: "context", sections: ["gauge-map", "attention"] },
      ]);
    }

    if (has("homeowner", "my house", "my home", "property", "neighborhood")) {
      return compose(this.phrasing.resident, [
        {
          id: "now",
          sections: [
            "conditions-summary",
            "attention",
            "gauge-map",
            "gauge-table",
          ],
        },
      ]);
    }

    if (has("map", "where", "location", "which gauges")) {
      return compose(this.phrasing.map, [
        {
          id: "map",
          sections: ["gauge-map", "gauge-table", "conditions-summary"],
        },
      ]);
    }

    return compose(this.phrasing.overview, [
      {
        id: "overview",
        sections: [
          "conditions-summary",
          "headline-metrics",
          "gauge-map",
          "fastest-rising",
          "attention",
        ],
      },
      {
        id: "gauge-details",
        sections: ["gauge-table", "stage-trends", "change-windows"],
      },
    ]);
  }
}

/**
 * The one section to keep when a refinement would otherwise empty the plan, or
 * nothing when the registry offers nothing that could stand there.
 *
 * `conditions-summary` in practice — it needs no station and every one of its
 * claims has a zero case — but chosen through the registry rather than written
 * as a literal, so a deprecated summary cannot become the thing Dasher falls
 * back to.
 *
 * IT USED TO SAY THAT AND NOT DO IT. The implementation ended
 * `?? "conditions-summary"`, so with every station-free kind deprecated the
 * literal came back and Dasher synthesised a retired section at the one moment
 * it is choosing entirely for itself. The mutation gate had flagged that exact
 * `?.` as a survivor and it was dismissed as an equivalent mutant; it was not
 * equivalent, it was the tell.
 *
 * Returning nothing is the honest answer to "there is nothing left I am willing
 * to show". The caller then hands back a plan the schema refuses, and the run
 * loop treats that as a malformed plan: it keeps no previous plan to revise
 * from, starts the next attempt clean, and throws `PlanRejected` with
 * `plan_malformed` once the attempts are spent (`run.ts`). A visible refusal
 * rather than a silently resurrected kind — and a retry, not a repair request,
 * because there is no well-formed plan to ask anyone to repair.
 */
function fallbackSection(
  entries: readonly PatternEntry[],
): PlanSectionKind | undefined {
  return offeredEntries(entries).find((entry) => !entry.requiresSites)?.kind;
}

/**
 * Rivers this planner will name a site for even when the observations do not
 * contain one. This models the realistic failure where a planner proposes a
 * plausible-looking source that is not actually authorized or available; the
 * trusted validator rejects it and the revision pass removes it.
 */
const UNAVAILABLE_RIVER_SITES: ReadonlyArray<[string, string]> = [
  ["feather", "11407000"],
  ["yuba", "11421000"],
  ["truckee", "10338000"],
  ["mokelumne", "11323500"],
];

function selectSites(text: string, sites: readonly AvailableSite[]): string[] {
  const named = sites.filter(
    (site) =>
      text.includes(site.river.toLowerCase()) ||
      text.includes(site.siteId) ||
      text.includes(site.name.toLowerCase()),
  );

  const speculative = UNAVAILABLE_RIVER_SITES.filter(([river]) =>
    text.includes(river),
  ).map(([, siteId]) => siteId);

  const base = named.length > 0 ? named : sites;
  return [...base.map((site) => site.siteId), ...speculative];
}

const REMOVE_WORDS = [
  "remove",
  "drop",
  "hide",
  "without",
  "take off",
  "no ",
] as const;
const ADD_WORDS = ["add", "include", "show", "put back", "bring back"] as const;
const COLLAPSE_WORDS = [
  "shorter",
  "simpler",
  "one page",
  "single page",
  "condense",
] as const;
const NARROW_WORDS = ["just", "only", "focus"] as const;

/**
 * What an instruction asks for, read once so the loop and the caller cannot
 * disagree about whether it was understood.
 */
export interface RefinementIntent {
  readonly remove: readonly PlanSectionKind[];
  readonly add: readonly PlanSectionKind[];
  readonly collapse: boolean;
  readonly narrowToSiteIds: readonly string[];
}

function firstIndexOfAny(text: string, words: readonly string[]): number {
  let earliest = -1;
  for (const word of words) {
    const at = text.indexOf(word);
    if (at !== -1 && (earliest === -1 || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * The verb governing a named section is the nearest one in front of it.
 *
 * "Remove the map and add the history chart" names two sections under opposite
 * verbs. Deciding remove-or-add once for the whole sentence deleted the section
 * the reader asked to add and still reported success, so each named section is
 * attributed to the verb it actually sits behind.
 */
function verbBefore(text: string, at: number): "remove" | "add" | undefined {
  let best: { at: number; kind: "remove" | "add" } | undefined;
  const scan = (words: readonly string[], kind: "remove" | "add"): void => {
    for (const word of words) {
      for (let from = 0; ;) {
        const found = text.indexOf(word, from);
        if (found === -1 || found >= at) break;
        if (best === undefined || found > best.at) best = { at: found, kind };
        from = found + 1;
      }
    }
  };
  scan(REMOVE_WORDS, "remove");
  scan(ADD_WORDS, "add");
  return best?.kind;
}

/**
 * Which sections an instruction names, and where.
 *
 * The words a reader uses for each section are the registry's, not this
 * module's. They were a private table here, which meant the fake's refinement
 * vocabulary and the vocabulary a model provider is told about could drift
 * apart while both looked authoritative.
 *
 * IT APPLIES NO LIFECYCLE FILTERING, and that is a correction. It used to skip
 * deprecated entries, which sounded like the rule — a section Dasher no longer
 * proposes should not be reachable by naming it — and was too blunt by half,
 * because it ran BEFORE the verb was read. So a deprecated section could not be
 * REMOVED either: a reader looking at a dashboard that still contained a
 * retired map, typing "Drop the map.", got their instruction reported as
 * uninterpretable and the map left where it was.
 *
 * Deprecation removes a section from what Dasher PROPOSES, never from what it
 * HONOURS, and removing something is not proposing it. Which mentions may
 * become additions is `readRefinementIntent`'s decision, after it knows the
 * verb. This function only answers what was named, and where.
 *
 * CASE-FOLDED HERE rather than relied upon from the caller. This is exported,
 * and `PatternEntry.triggerWords` documents matching as case-folded, so
 * `matchedSections("ADD THE MAP", …)` returning nothing was a public API
 * contradicting its own contract. Folding is length-preserving for these
 * ASCII trigger words, so the returned position still indexes the caller's
 * string.
 *
 * ORDERED BY WHERE THE READER NAMED THEM, not by the order of the list being
 * searched. This is load-bearing rather than tidy. `refine` fills the pages
 * that have room, in the order it receives additions, so when an instruction
 * asks for more sections than there are slots the order decides which request
 * is honoured — and iterating a list meant the answer belonged to whoever last
 * sorted that list. Moving the trigger words into the registry silently changed
 * it: "Add the table and summary." against a nearly-full plan kept the table
 * before and kept the summary after, because the registry lists
 * `conditions-summary` before `gauge-table` and the old private table listed
 * them the other way round. Caught in review, not by the 200 tests that passed.
 *
 * Sorting by position in the instruction makes the answer a property of what
 * the reader wrote. Named first, served first, which is also the only rule that
 * can be explained to them.
 *
 * This is still keyword matching rather than language understanding, and it is
 * still only a stand-in; a real provider reads the instruction. What it has to
 * be is deterministic, so the refinement loop can be tested without a model.
 */
export function matchedSections(
  text: string,
  entries: readonly PatternEntry[],
): ReadonlyArray<readonly [PlanSectionKind, number]> {
  const folded = text.toLowerCase();
  const matched: Array<readonly [PlanSectionKind, number]> = [];
  for (const entry of entries) {
    const at = firstIndexOfAny(folded, entry.triggerWords);
    if (at !== -1) matched.push([entry.kind, at]);
  }
  return matched.sort(([, left], [, right]) => left - right);
}

/**
 * Pages with anything Dasher no longer offers taken out of them.
 *
 * The other half of the deprecation rule, and the half that governs the path
 * the product actually ships. `readRefinementIntent` stops a retired section
 * being ADDED by name — not `matchedSections`, which deliberately matches it so
 * that removal stays possible. Without THIS, the deterministic provider would
 * keep PROPOSING one on every fresh request, because its compositions are
 * written as literals. A lifecycle rule that governs the model prompt and the
 * refinement path but not the provider in front of readers governs nothing.
 *
 * IT REMOVES WHAT IS RETIRED, not everything it fails to recognise, and the
 * difference is the whole safety of putting a filter on this path. Written as
 * "keep what is offered", it also quietly swallowed section names that are not
 * in the registry at all — which are not retired, they are invalid, and the
 * plan schema is what has to refuse them. Mutation testing said so plainly:
 * replacing a section name inside a hardcoded composition with `""` used to be
 * killed by the schema and started surviving, because the filter ate the empty
 * string on the way past.
 *
 * A page THIS FUNCTION emptied is dropped rather than left blank. A page that
 * arrived empty is kept exactly as it came, for the same reason: an empty page
 * is a plan the schema refuses, so a composition authored with no sections is a
 * bug that must keep surfacing rather than disappearing here.
 *
 * If every page empties — every section Dasher can build deprecated at once —
 * this returns nothing, the plan fails its own schema, and the run reports a
 * malformed plan. That is the honest outcome for a registry in that state, and
 * it is a state only a deliberate edit can produce.
 */
export function retainOffered<T extends { sections: PlanSectionKind[] }>(
  pages: readonly T[],
  entries: readonly PatternEntry[],
): T[] {
  const offeredKinds = new Set(offeredEntries(entries).map((e) => e.kind));
  const retired = new Set(
    entries
      .map((entry) => entry.kind)
      .filter((kind) => !offeredKinds.has(kind)),
  );
  return pages
    .map((page) => ({
      ...page,
      sections: page.sections.filter((section) => !retired.has(section)),
    }))
    .filter(
      (page, index) =>
        page.sections.length > 0 || pages[index]?.sections.length === 0,
    );
}

export function readRefinementIntent(
  instruction: string,
  sites: readonly AvailableSite[],
  entries: readonly PatternEntry[] = PATTERN_ENTRIES,
): RefinementIntent {
  const text = instruction.toLowerCase();
  const has = (words: readonly string[]): boolean =>
    words.some((word) => text.includes(word));

  const remove: PlanSectionKind[] = [];
  const add: PlanSectionKind[] = [];
  const anyRemove = has(REMOVE_WORDS);
  const anyAdd = has(ADD_WORDS);

  // The lifecycle rule applies to ADDITIONS ONLY, and it is applied here rather
  // than in the matcher because it depends on the verb. A retired section may
  // always be named for removal — a reader looking at one has to be able to get
  // rid of it — and may never be named for addition, because that is Dasher
  // proposing it again. A mixed instruction gets both: "Drop the map and add
  // the table" removes a deprecated map and adds an offered table.
  const offered = new Set(offeredEntries(entries).map((entry) => entry.kind));
  const addIfOffered = (section: PlanSectionKind): void => {
    if (offered.has(section)) add.push(section);
  };

  for (const [section, at] of matchedSections(text, entries)) {
    const verb = verbBefore(text, at);
    if (verb === "remove") remove.push(section);
    else if (verb === "add") addIfOffered(section);
    // Named with no verb in front of it: fall back to the instruction's own
    // single verb, so "the map — drop it" still reads as a removal.
    else if (anyRemove && !anyAdd) remove.push(section);
    else if (anyAdd && !anyRemove) addIfOffered(section);
  }

  return {
    remove,
    add,
    collapse: has(COLLAPSE_WORDS),
    narrowToSiteIds: has(NARROW_WORDS)
      ? sites
          .filter((site) => text.includes(site.river.toLowerCase()))
          .map((site) => site.siteId)
      : [],
  };
}

/**
 * True when nothing in the instruction was recognised.
 *
 * This is what separates "Dasher did not understand that" from "the dashboard
 * already looks like that". Both leave the plan identical, and reporting the
 * second as the first tells a reader their working request failed.
 */
export function isUninterpretable(intent: RefinementIntent): boolean {
  return (
    intent.remove.length === 0 &&
    intent.add.length === 0 &&
    !intent.collapse &&
    intent.narrowToSiteIds.length === 0
  );
}

/**
 * The refinement pass: a change the reader asked for, applied to the plan they
 * are looking at.
 *
 * It edits the previous plan rather than composing a new one, which is the
 * point of refinement — "drop the map" should not silently reorganise
 * everything else. Anything it cannot interpret leaves the plan unchanged, and
 * the caller reports that honestly rather than pretending something happened.
 */
function refine(
  refinement: PlanningRefinement,
  sites: readonly AvailableSite[],
  entries: readonly PatternEntry[],
): DashboardPlan {
  const plan = refinement.previousPlan;
  const intent = readRefinementIntent(refinement.instruction, sites, entries);

  let pages = plan.pages.map((page) => ({ ...page }));

  // Removals first, then additions. Both run: a compound instruction asks for
  // two things and letting the first verb claim the whole sentence dropped the
  // other one silently.
  if (intent.remove.length > 0) {
    const doomed = new Set(intent.remove);
    pages = pages
      .map((page) => ({
        ...page,
        sections: page.sections.filter((section) => !doomed.has(section)),
      }))
      .filter((page) => page.sections.length > 0);
  }

  if (intent.add.length > 0) {
    const present = new Set(pages.flatMap((page) => page.sections));
    const missing = intent.add.filter((section) => !present.has(section));

    // A removal that emptied every page must not swallow the addition beside
    // it. "Drop the map and add the trends" against a one-section plan left
    // nothing for the addition to land on, so the section was silently dropped
    // and the empty-plan fallback below substituted a summary the reader had
    // not asked for. Seeding a page keeps the reader's second instruction.
    if (pages.length === 0 && missing.length > 0) {
      pages = [{ ...plan.pages[0]!, sections: [] }];
    }

    // Onto the first page with room. A section appended to a full page would be
    // dropped by the contract's own limit, which looks like the request was
    // ignored rather than refused.
    for (const section of missing) {
      const target = pages.find(
        (page) => page.sections.length < PLAN_MAX_SECTIONS_PER_PAGE,
      );
      if (target !== undefined) {
        target.sections = [...target.sections, section];
      }
    }

    // No empty-page sweep here, and it is worth saying why rather than leaving
    // a defensive line nothing can kill. Removals already dropped every page
    // they emptied, so the pages reaching this block all have sections; a page
    // is only seeded when there is an addition to place, and a freshly seeded
    // page always has room for the first one. Mutation testing is what made the
    // point: the sweep survived every mutant, because no input reaches it.
  }

  // "Make it shorter" collapses to a single page, keeping order.
  if (intent.collapse) {
    const flattened = [...new Set(pages.flatMap((page) => page.sections))];
    pages = [
      {
        ...(pages[0] ?? plan.pages[0]!),
        sections: flattened.slice(0, PLAN_MAX_SECTIONS_PER_PAGE),
      },
    ];
  }

  if (pages.length === 0) {
    // Refusing to render nothing. Emptying every page is a plan the contract
    // would reject, and a finding the reader cannot act on is worse than a
    // dashboard that kept its summary — as long as what is kept is something
    // Dasher would still offer. When it is not, the empty plan goes forward and
    // the contract refuses it, which is the honest outcome.
    const kept = fallbackSection(entries);
    if (kept !== undefined) {
      pages = [{ ...plan.pages[0]!, sections: [kept] }];
    }
  }

  return {
    ...plan,
    siteIds:
      intent.narrowToSiteIds.length > 0
        ? [...intent.narrowToSiteIds]
        : plan.siteIds,
    pages,
  };
}

/**
 * The revision pass. It acts only on the structured findings it was given —
 * it does not re-read the request — which is what makes the repair auditable.
 */
function repair(
  revision: PlanningRevision,
  sites: readonly AvailableSite[],
): DashboardPlan {
  const plan = revision.previousPlan;
  const known = new Set(sites.map((site) => site.siteId));

  // Every site the validator called out, resolved back to the value it
  // rejected so the repair is driven by the findings rather than by guesswork.
  const rejectedSites = new Set(
    revision.findings
      .filter(
        (finding) =>
          finding.code === "unknown_site" || finding.code === "duplicate_site",
      )
      .map((finding) => indexFrom(finding.path, "siteIds"))
      .filter((index): index is number => index !== undefined)
      .map((index) => plan.siteIds[index])
      .filter((siteId): siteId is string => siteId !== undefined),
  );

  let siteIds = [
    ...new Set(
      plan.siteIds.filter((id) => !rejectedSites.has(id) && known.has(id)),
    ),
  ];
  if (siteIds.length === 0) {
    siteIds = sites.map((site) => site.siteId);
  }

  // Drop repeated sections, keeping the first occurrence, and drop any page
  // left with nothing to show.
  const seenSections = new Set<PlanSectionKind>();
  const pages = plan.pages
    .map((page) => ({
      ...page,
      sections: page.sections.filter((section) => {
        if (seenSections.has(section)) return false;
        seenSections.add(section);
        return true;
      }),
    }))
    .filter((page) => page.sections.length > 0);

  // NO SYNTHESISED FALLBACK HERE. There was one — a literal
  // `["conditions-summary", "gauge-table"]` page for the case where `pages`
  // came out empty — and it was both a second lifecycle bypass and dead code.
  // Dedup keeps the FIRST occurrence of each section, and nothing has been seen
  // before the first page's first section, so a schema-valid previous plan
  // (min one page, min one section) always yields at least one page. Proved by
  // test rather than asserted here.
  return { ...plan, siteIds, pages };
}

function indexFrom(path: string, field: string): number | undefined {
  const match = new RegExp(`^${field}\\[(\\d+)\\]$`).exec(path);
  if (match?.[1] === undefined) return undefined;
  return Number.parseInt(match[1], 10);
}
