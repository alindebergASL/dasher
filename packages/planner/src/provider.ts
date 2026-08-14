import type { DashboardPlan, PlanFinding, PlanSectionKind } from "./plan";

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

export interface PlanningRequest {
  requestText: string;
  availableSites: readonly AvailableSite[];
  /** Present only when a prior plan was rejected. */
  revision?: PlanningRevision;
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

  async plan(request: PlanningRequest): Promise<unknown> {
    const draft = this.draft(request);

    if (request.revision === undefined) {
      return draft;
    }
    return repair(request.revision, request.availableSites);
  }

  private draft(request: PlanningRequest): DashboardPlan {
    const text = request.requestText.toLowerCase();
    const sites = request.availableSites;
    const has = (...needles: string[]) =>
      needles.some((needle) => text.includes(needle));

    const siteIds = selectSites(text, sites);

    if (has("emergency", "flood", "evacuat", "warning", "public safety")) {
      return {
        planVersion: "plan-v1",
        title: "Sacramento Flood Watch",
        audience: "Emergency management leads",
        framing:
          "Conditions ordered for incident response: what needs attention first, then where it is, then how fast it is moving.",
        siteIds,
        pages: [
          {
            id: "watch",
            title: "Watch",
            description: "Active concerns and where they are.",
            sections: ["attention", "conditions-summary", "gauge-map"],
          },
          {
            id: "movement",
            title: "Movement",
            description: "How fast levels are changing and over which windows.",
            sections: ["fastest-rising", "change-windows", "stage-trends"],
          },
        ],
      };
    }

    if (has("rising", "fastest", "changing", "change", "trend")) {
      return {
        planVersion: "plan-v1",
        title: "Sacramento River Movement",
        audience: "Operations managers",
        framing:
          "Ordered by rate of change: the fastest movers first, then the windows behind those numbers.",
        siteIds,
        pages: [
          {
            id: "movement",
            title: "What is moving",
            description: "Gauges ranked by recent water-level change.",
            sections: [
              "fastest-rising",
              "headline-metrics",
              "change-windows",
              "stage-trends",
            ],
          },
          {
            id: "context",
            title: "Context",
            description: "Where the moving gauges are and what needs a look.",
            sections: ["gauge-map", "attention"],
          },
        ],
      };
    }

    if (has("homeowner", "my house", "my home", "property", "neighborhood")) {
      return {
        planVersion: "plan-v1",
        title: "River Levels Near You",
        audience: "Homeowners and residents",
        framing:
          "A short read: whether anything needs attention right now, and the current level at each nearby gauge.",
        siteIds,
        pages: [
          {
            id: "now",
            title: "Right now",
            description: "Current conditions in plain language.",
            sections: [
              "conditions-summary",
              "attention",
              "gauge-map",
              "gauge-table",
            ],
          },
        ],
      };
    }

    if (has("map", "where", "location", "which gauges")) {
      return {
        planVersion: "plan-v1",
        title: "Sacramento Gauge Map",
        audience: "Managers and community leaders",
        framing: "Location first, with current readings beside each gauge.",
        siteIds,
        pages: [
          {
            id: "map",
            title: "Map",
            description: "Gauge locations and their current state.",
            sections: ["gauge-map", "gauge-table", "conditions-summary"],
          },
        ],
      };
    }

    return {
      planVersion: "plan-v1",
      title: "Sacramento River Conditions",
      audience: "Managers and community leaders",
      framing:
        "What is happening now, what changed, and what deserves attention.",
      siteIds,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "What is happening now and what deserves attention.",
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
          title: "Gauge details",
          description:
            "Current readings, changes, and recent water-level history.",
          sections: ["gauge-table", "stage-trends", "change-windows"],
        },
      ],
    };
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
