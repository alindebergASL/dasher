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

  constructor(phrasing: FakePlannerPhrasing = RIVER_FAKE_PHRASING) {
    this.phrasing = phrasing;
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
      return refine(request.refinement, request.availableSites);
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
      pages: pages.map((page, index) => ({
        id: page.id,
        title: words.pages[index]?.title ?? page.id,
        description: words.pages[index]?.description ?? page.id,
        sections: page.sections,
      })),
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
 * Deprecated entries are skipped, because a section Dasher no longer proposes
 * must not stay reachable by naming it. That rule is why this is a pure
 * function over a list rather than a loop inside `readRefinementIntent`: the
 * shipped registry has nothing deprecated in it, so the only way to check the
 * filtering actually happens HERE — and not merely in `offeredEntries`, which
 * has its own test — is to be able to hand this a deprecated entry.
 *
 * This is still keyword matching rather than language understanding, and it is
 * still only a stand-in; a real provider reads the instruction. What it has to
 * be is deterministic, so the refinement loop can be tested without a model.
 */
export function matchedSections(
  text: string,
  entries: readonly PatternEntry[],
): ReadonlyArray<readonly [PlanSectionKind, number]> {
  const matched: Array<readonly [PlanSectionKind, number]> = [];
  for (const entry of offeredEntries(entries)) {
    const at = firstIndexOfAny(text, entry.triggerWords);
    if (at !== -1) matched.push([entry.kind, at]);
  }
  return matched;
}

export function readRefinementIntent(
  instruction: string,
  sites: readonly AvailableSite[],
): RefinementIntent {
  const text = instruction.toLowerCase();
  const has = (words: readonly string[]): boolean =>
    words.some((word) => text.includes(word));

  const remove: PlanSectionKind[] = [];
  const add: PlanSectionKind[] = [];
  const anyRemove = has(REMOVE_WORDS);
  const anyAdd = has(ADD_WORDS);

  for (const [section, at] of matchedSections(text, PATTERN_ENTRIES)) {
    const verb = verbBefore(text, at);
    if (verb === "remove") remove.push(section);
    else if (verb === "add") add.push(section);
    // Named with no verb in front of it: fall back to the instruction's own
    // single verb, so "the map — drop it" still reads as a removal.
    else if (anyRemove && !anyAdd) remove.push(section);
    else if (anyAdd && !anyRemove) add.push(section);
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
): DashboardPlan {
  const plan = refinement.previousPlan;
  const intent = readRefinementIntent(refinement.instruction, sites);

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
    // dashboard that kept its summary.
    pages = [
      {
        ...plan.pages[0]!,
        sections: ["conditions-summary"],
      },
    ];
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

  return {
    ...plan,
    siteIds,
    pages:
      pages.length > 0
        ? pages
        : [
            {
              id: "overview",
              title: "Overview",
              description: "Current conditions.",
              sections: ["conditions-summary", "gauge-table"],
            },
          ],
  };
}

function indexFrom(path: string, field: string): number | undefined {
  const match = new RegExp(`^${field}\\[(\\d+)\\]$`).exec(path);
  if (match?.[1] === undefined) return undefined;
  return Number.parseInt(match[1], 10);
}
