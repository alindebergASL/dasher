import { describe, expect, it } from "vitest";

import {
  composeDashboards,
  DashboardCompositionError,
  type AbsentSource,
  type ComposedSources,
  MAX_COMPOSED_SOURCES,
} from "./compose";
import {
  DASHBOARD_MAX_EVIDENCE_IDS,
  parseDashboardSpec,
  type DashboardSpec,
} from "./schema";

/**
 * The fixtures deliberately COLLIDE.
 *
 * Both sources use `conditions-summary`, `calculated-trends`, `request` and
 * `overview` — which is not a contrivance: the compiler emits those exact
 * literals for every domain, so two independently built dashboards really do
 * arrive with identical structural ids. If namespacing were incomplete, these
 * tests would fail on the contract rather than on an assertion, which is the
 * intended design.
 */
/** `count` citation ids, or none. Ids are per-source-namespaced downstream. */
function extraCitationIds(count = 0): string[] {
  return Array.from({ length: count }, (_, index) => `cite-${String(index)}`);
}

function source(options: {
  readonly title: string;
  readonly stationId: string;
  readonly generatedAt: string;
  readonly freshness: DashboardSpec["freshness"];
  readonly dataMode?: "demo" | "live";
  readonly statementTypes?: readonly string[];
  /** Overrides the `important` detail, so a test can supply prose that does
   *  not end in punctuation — which is what the real river half does. */
  readonly importantDetail?: string;
  /**
   * Extra evidence records, all cited by the `known` claim. Real fixtures cite
   * two or three things, which is why the interleave-and-cap in
   * `mergeEvidenceIds` went unverified: the cap never fired and the two lists
   * were never different lengths.
   */
  readonly extraCitations?: number;
}): DashboardSpec {
  return parseDashboardSpec({
    schemaVersion: "1.2",
    id: "planned-conditions",
    title: options.title,
    audience: "Operations",
    generatedAt: options.generatedAt,
    dataMode: options.dataMode ?? "demo",
    freshness: options.freshness,
    nextAction: {
      title: "Check the highest reading",
      detail: "Open the station with the largest recent change.",
      evidenceIds: ["calculated-trends"],
    },
    notice: "Demonstration data.",
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Everything at a glance.",
        components: [
          {
            kind: "summary",
            id: "conditions-summary",
            title: "Conditions",
            tone: "normal",
            evidenceIds: ["calculated-trends"],
            claims: [
              {
                text: `${options.title} summary claim.`,
                evidenceIds: ["station-reading"],
              },
            ],
          },
          {
            kind: "station-table",
            id: "gauge-table",
            title: "Stations",
            evidenceIds: ["station-reading"],
            columns: {
              station: "Station",
              primary: "Level",
              secondary: "Change",
            },
            stations: [
              {
                id: options.stationId,
                name: "Station one",
                group: "Group",
                latitude: 38.6,
                longitude: -121.5,
                primary: { value: 1, unit: "ft" },
                secondary: { value: 0, unit: "ft" },
                direction: "steady",
                freshness: "fresh",
                evidenceIds: ["station-reading"],
              },
            ],
          },
        ],
      },
    ],
    evidence: [
      {
        id: "station-reading",
        kind: "observed",
        label: "Station reading",
        sourceName: "Source",
        retrievedAt: options.generatedAt,
        detail: "A reading.",
        confidence: "high",
      },
      {
        id: "calculated-trends",
        kind: "calculated",
        label: "Calculated trends",
        sourceName: "Dasher",
        retrievedAt: options.generatedAt,
        detail: "Derived from readings.",
        confidence: "high",
      },
      ...extraCitationIds(options.extraCitations).map((id) => ({
        id,
        kind: "observed" as const,
        label: `Citation ${id}`,
        sourceName: "Dasher",
        retrievedAt: options.generatedAt,
        detail: "One more supporting link.",
        confidence: "high" as const,
      })),
    ],
    architecture: {
      title: "How this works",
      summary: `${options.title} pipeline.`,
      nodes: [
        {
          id: "request",
          label: "Request",
          detail: "A request.",
          kind: "input",
        },
        { id: "pages", label: "Pages", detail: "Rendered.", kind: "page" },
      ],
      edges: [{ from: "request", to: "pages", label: "builds" }],
    },
    executiveBrief: {
      known: {
        statementTypes: options.statementTypes ?? ["observed"],
        headline: `${options.title} known`,
        detail: `What is known about ${options.title}.`,
        evidenceIds: [
          "station-reading",
          ...extraCitationIds(options.extraCitations),
        ],
      },
      changed: {
        statementTypes: ["calculated"],
        headline: `${options.title} changed`,
        detail: `What changed for ${options.title}.`,
        evidenceIds: ["calculated-trends"],
      },
      important: {
        statementTypes: ["interpreted"],
        headline: `${options.title} important`,
        detail: options.importantDetail ?? `What matters for ${options.title}.`,
        evidenceIds: ["station-reading"],
      },
    },
  });
}

const FRESH = {
  status: "fresh",
  label: "Fresh",
  latestObservationAt: "2026-08-19T11:00:00.000Z",
} as const;

function pair(
  overrides: {
    first?: Parameters<typeof source>[0];
    second?: Parameters<typeof source>[0];
  } = {},
): ComposedSources {
  return [
    {
      key: "river",
      label: "River",
      dashboard: source({
        title: "River",
        stationId: "11447650",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        ...overrides.first,
      }),
    },
    {
      key: "air",
      label: "Air quality",
      dashboard: source({
        title: "Air",
        stationId: "678",
        generatedAt: "2026-08-19T12:30:00.000Z",
        freshness: FRESH,
        ...overrides.second,
      }),
    },
  ];
}

const OPTIONS = {
  id: "combined-river-air-conditions",
  title: "River and Air quality — combined conditions",
  audience: "Readers tracking both",
  notice: "Two sources, built separately.",
};

function compose(sources: ComposedSources = pair()): DashboardSpec {
  return composeDashboards(sources, OPTIONS);
}

describe("structural ids are namespaced, reader-facing ids are not", () => {
  it("keeps every colliding structural id apart", () => {
    const combined = compose();

    expect(combined.pages.map((page) => page.id)).toEqual([
      "river:overview",
      "air:overview",
    ]);
    expect(
      combined.pages.flatMap((page) =>
        page.components.map((component) => component.id),
      ),
    ).toEqual([
      "river:conditions-summary",
      "river:gauge-table",
      "air:conditions-summary",
      "air:gauge-table",
    ]);
    expect(combined.evidence.map((item) => item.id)).toEqual([
      "river:station-reading",
      "river:calculated-trends",
      "air:station-reading",
      "air:calculated-trends",
    ]);
    expect(combined.architecture.nodes.map((node) => node.id)).toEqual([
      "river:request",
      "river:pages",
      "air:request",
      "air:pages",
    ]);
  });

  it("leaves station ids alone, because a reader sees them", () => {
    // The station table prints the site id and the map reads it aloud.
    // `river:11447650` in front of a person would be this module leaking.
    const stations = compose()
      .pages.flatMap((page) => page.components)
      .flatMap((component) =>
        component.kind === "station-table" ? component.stations : [],
      );
    expect(stations.map((station) => station.id)).toEqual(["11447650", "678"]);
  });

  it("moves every evidence reference with the evidence it points at", () => {
    const combined = compose();
    const known = new Set(combined.evidence.map((item) => item.id));

    const referenced = [
      ...combined.nextAction.evidenceIds,
      ...combined.executiveBrief.known.evidenceIds,
      ...combined.executiveBrief.changed.evidenceIds,
      ...combined.executiveBrief.important.evidenceIds,
      ...combined.pages.flatMap((page) =>
        page.components.flatMap((component) => [
          ...component.evidenceIds,
          ...(component.kind === "summary"
            ? component.claims.flatMap((claim) => claim.evidenceIds)
            : []),
          ...(component.kind === "station-table"
            ? component.stations.flatMap((station) => station.evidenceIds)
            : []),
        ]),
      ),
    ];

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((id) => !known.has(id))).toEqual([]);
  });

  it("attributes page titles so the reader can tell the halves apart", () => {
    // Both fixtures title their page "Overview", exactly as both real domains
    // do. Ids alone are not enough here: page ids are never shown, so without
    // this the navigation reads "01 Overview / 02 Overview" and the reader has
    // to open one to find out which subject it is.
    const sources = pair();
    const combined = compose(sources);
    expect(combined.pages.map((page) => page.title)).toEqual([
      "River — Overview",
      "Air quality — Overview",
    ]);

    // And only page titles. Inside an attributed page a component title is
    // already unambiguous, so prefixing it would be noise a reader has to read
    // past on every panel.
    expect(
      combined.pages.flatMap((page) =>
        page.components.map((component) => component.title),
      ),
    ).toEqual(
      sources.flatMap((source) =>
        source.dashboard.pages.flatMap((page) =>
          page.components.map((component) => component.title),
        ),
      ),
    );
  });

  it("remaps architecture edge endpoints", () => {
    expect(compose().architecture.edges).toEqual([
      { from: "river:request", to: "river:pages", label: "builds" },
      { from: "air:request", to: "air:pages", label: "builds" },
    ]);
  });
});

describe("freshness is the pair's, not either source's", () => {
  const stale = { status: "stale", label: "Stale" } as const;

  it("is fresh only when both are fresh", () => {
    expect(compose().freshness.status).toBe("fresh");
  });

  it("is stale only when both are stale", () => {
    const combined = compose(
      pair({
        first: {
          title: "River",
          stationId: "1",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: stale,
        },
        second: {
          title: "Air",
          stationId: "2",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: stale,
        },
      }),
    );
    expect(combined.freshness.status).toBe("stale");
  });

  it.each([
    ["fresh", "stale"],
    ["stale", "fresh"],
    ["fresh", "partial"],
    ["partial", "stale"],
  ])("is partial when one is %s and the other %s", (a, b) => {
    const of = (status: string) =>
      status === "fresh"
        ? FRESH
        : ({ status, label: status } as DashboardSpec["freshness"]);
    const combined = compose(
      pair({
        first: {
          title: "River",
          stationId: "1",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: of(a),
        },
        second: {
          title: "Air",
          stationId: "2",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: of(b),
        },
      }),
    );
    expect(combined.freshness.status).toBe("partial");
  });

  it("reports the EARLIEST observation, so the fresher half cannot vouch for the older", () => {
    const combined = compose(
      pair({
        first: {
          title: "River",
          stationId: "1",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: {
            status: "fresh",
            label: "Fresh",
            latestObservationAt: "2026-08-19T11:55:00.000Z",
          },
        },
        second: {
          title: "Air",
          stationId: "2",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: {
            status: "fresh",
            label: "Fresh",
            latestObservationAt: "2026-08-19T06:00:00.000Z",
          },
        },
      }),
    );
    expect(combined.freshness.latestObservationAt).toBe(
      "2026-08-19T06:00:00.000Z",
    );
  });

  it("names both sources in the freshness label", () => {
    expect(compose().freshness.label).toContain("River");
    expect(compose().freshness.label).toContain("Air quality");
  });
});

describe("an unknown observation time is unknown, not the other half's", () => {
  const OBSERVED = {
    status: "fresh",
    label: "Fresh",
    latestObservationAt: "2026-08-19T11:30:00.000Z",
  } as const;
  // Stale, not fresh, and that is the contract's doing rather than a choice
  // here: `fresh` REQUIRES `latestObservationAt`, so a half with no timestamp
  // is never fresh. Which means omitting the pair's timestamp can never
  // produce an illegal fresh-without-a-timestamp spec — the composed status
  // is only `fresh` when both halves are, and both therefore had one.
  const UNTIMED = { status: "stale", label: "No recent readings" } as const;

  it("reports nothing when either half has no observation time", () => {
    // A missing timestamp is the LEAST current state there is — unknown — so
    // it cannot be filtered out on the way to "the earliest". Doing that let
    // the half that did report stand for the whole page, under a single
    // "Latest observation" heading a reader takes to cover everything on it.
    for (const [first, second] of [
      [OBSERVED, UNTIMED],
      [UNTIMED, OBSERVED],
      [UNTIMED, UNTIMED],
    ] as const) {
      const combined = compose(
        pair({
          first: {
            title: "River",
            stationId: "1",
            generatedAt: "2026-08-19T12:00:00.000Z",
            freshness: first,
          },
          second: {
            title: "Air",
            stationId: "2",
            generatedAt: "2026-08-19T12:00:00.000Z",
            freshness: second,
          },
        }),
      );
      // The KEY is absent, not present-and-undefined. `toBeUndefined` cannot
      // tell those apart, and only one of them is what the contract's
      // optional field means.
      expect(combined.freshness).not.toHaveProperty("latestObservationAt");
      // The label still names both halves, so the reader is not left with
      // nothing — only with no false precision.
      expect(combined.freshness.label).toContain("River:");
      expect(combined.freshness.label).toContain("Air quality:");
    }
  });

  it("still reports the earliest when both halves have one", () => {
    // The counterweight: "omit when either is missing" must not degrade into
    // "omit always", which would drop a timestamp the pair genuinely has.
    const combined = compose(
      pair({
        first: {
          title: "River",
          stationId: "1",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: OBSERVED,
        },
        second: {
          title: "Air",
          stationId: "2",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: {
            status: "fresh",
            label: "Fresh",
            latestObservationAt: "2026-08-19T11:00:00.000Z",
          },
        },
      }),
    );
    expect(combined.freshness.latestObservationAt).toBe(
      "2026-08-19T11:00:00.000Z",
    );
  });
});

describe("three sources, because the count is policy and not a type", () => {
  // These tests could not be WRITTEN before this change: `ComposedSources` was
  // a 2-tuple, so a third source was a compile error rather than a product
  // decision. Everything below is the same rule the pair version had, with the
  // quantifier made explicit.
  const trio = (): ComposedSources => [
    {
      key: "river",
      label: "River",
      dashboard: source({
        title: "River",
        stationId: "11447650",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
      }),
    },
    {
      key: "air",
      label: "Air quality",
      dashboard: source({
        title: "Air",
        stationId: "678",
        generatedAt: "2026-08-19T12:30:00.000Z",
        freshness: FRESH,
      }),
    },
    {
      key: "tide",
      label: "Tide",
      dashboard: source({
        title: "Tide",
        stationId: "9414290",
        generatedAt: "2026-08-19T11:00:00.000Z",
        freshness: FRESH,
      }),
    },
  ];

  it("namespaces all three id spaces and keeps every page", () => {
    const combined = compose(trio());
    expect(combined.pages.map((page) => page.id)).toEqual([
      "river:overview",
      "air:overview",
      "tide:overview",
    ]);
    expect(combined.evidence.map((item) => item.id)).toEqual([
      "river:station-reading",
      "river:calculated-trends",
      "air:station-reading",
      "air:calculated-trends",
      "tide:station-reading",
      "tide:calculated-trends",
    ]);
  });

  it("attributes all three in prose, in catalog order", () => {
    const combined = compose(trio());
    expect(combined.executiveBrief.known.headline).toBe(
      "River: River known · Air quality: Air known · Tide: Tide known",
    );
    // Sentence-terminated between halves, and NOT after the last one.
    expect(combined.executiveBrief.known.detail).toBe(
      "River: What is known about River. Air quality: What is known about Air. Tide: What is known about Tide.",
    );
    expect(combined.executiveBrief.known.detail).not.toMatch(/[.!?]{2}/u);
  });

  it("takes the latest generatedAt and the earliest observation across all three", () => {
    const observed = (at: string) =>
      ({ status: "fresh", label: "Fresh", latestObservationAt: at }) as const;
    const combined = compose([
      {
        ...trio()[0]!,
        dashboard: source({
          title: "River",
          stationId: "1",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: observed("2026-08-19T11:45:00.000Z"),
        }),
      },
      {
        ...trio()[1]!,
        dashboard: source({
          title: "Air",
          stationId: "2",
          generatedAt: "2026-08-19T12:30:00.000Z",
          freshness: observed("2026-08-19T11:10:00.000Z"),
        }),
      },
      {
        ...trio()[2]!,
        dashboard: source({
          title: "Tide",
          stationId: "3",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: observed("2026-08-19T10:30:00.000Z"),
        }),
      },
    ]);
    // Latest generatedAt is the SECOND source's and earliest observation is the
    // THIRD's, so neither answer can come from comparing just the first pair.
    expect(combined.generatedAt).toBe("2026-08-19T12:30:00.000Z");
    expect(combined.freshness.latestObservationAt).toBe(
      "2026-08-19T10:30:00.000Z",
    );
  });

  it("is fresh only when every source is fresh", () => {
    const stale = { status: "stale", label: "Stale" } as const;
    const sources = trio();
    expect(compose(sources).freshness.status).toBe("fresh");
    expect(
      compose([
        sources[0]!,
        sources[1]!,
        {
          ...sources[2]!,
          dashboard: source({
            title: "Tide",
            stationId: "3",
            generatedAt: "2026-08-19T12:00:00.000Z",
            freshness: stale,
          }),
        },
      ]).freshness.status,
    ).toBe("partial");
  });

  it("gives every source a share of the capped evidence list", () => {
    // Round-robin is N-way now, so the cap divides across all three rather
    // than favouring whoever came first.
    const many = (key: string, label: string, stationId: string) => ({
      key,
      label,
      dashboard: source({
        title: label,
        stationId,
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        extraCitations: 19,
      }),
    });
    const { evidenceIds } = compose([
      many("river", "River", "1"),
      many("air", "Air quality", "2"),
      many("tide", "Tide", "3"),
    ]).executiveBrief.known;

    expect(evidenceIds.length).toBe(DASHBOARD_MAX_EVIDENCE_IDS);
    for (const key of ["river:", "air:", "tide:"]) {
      expect(
        evidenceIds.filter((id) => id.startsWith(key)).length,
      ).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("arity is checked at runtime, where a policy belongs", () => {
  it("refuses a single source, which is not a composition", () => {
    expect(() => compose([pair()[0]!])).toThrow(/at least two sources/u);
  });

  it("refuses more sources than policy allows", () => {
    const one = (key: string) => ({
      key,
      label: key,
      dashboard: source({
        title: key,
        stationId: "1",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
      }),
    });
    const tooMany = Array.from({ length: MAX_COMPOSED_SOURCES + 1 }, (_, i) =>
      one(`s${String(i)}`),
    );
    expect(() => compose(tooMany)).toThrow(
      new RegExp(`limited to ${String(MAX_COMPOSED_SOURCES)} sources`, "u"),
    );
  });

  it("refuses any repeated namespace, not just the first pair", () => {
    const sources = trioWithDuplicate();
    expect(() => compose(sources)).toThrow(/namespace "air"/u);
  });

  function trioWithDuplicate(): ComposedSources {
    const build = (key: string, label: string, stationId: string) => ({
      key,
      label,
      dashboard: source({
        title: label,
        stationId,
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
      }),
    });
    // The duplicate is in positions 2 and 3 — a pair-shaped check comparing
    // only the first two would miss it entirely.
    return [
      build("river", "River", "1"),
      build("air", "Air", "2"),
      build("air", "Air", "3"),
    ];
  }
});

describe("composition refuses what it cannot state honestly", () => {
  it("refuses two sources sharing a namespace, and says which", () => {
    // ASSERTED ON THE MESSAGE, not just the type, and that distinction is the
    // whole point. The contract would catch this collision anyway — once
    // `parseComposed` began wrapping contract failures in the same error
    // class, `toThrow(DashboardCompositionError)` stopped being able to tell
    // the guard from the fallback. Mutation testing proved it: the guard could
    // be deleted outright and every test still passed.
    //
    // So the guard has to earn its place on the only thing it adds — naming
    // the colliding namespace instead of reporting a generic contract
    // failure — and the test has to check that, or the guard is dead weight
    // that looks alive.
    const sources = pair();
    const clashing = [
      sources[0],
      { ...sources[1], key: "river" },
    ] as ComposedSources;

    expect(() => compose(clashing)).toThrow(DashboardCompositionError);
    expect(() => compose(clashing)).toThrow(/namespace "river"/u);
    expect(() => compose(clashing)).not.toThrow(/does not satisfy/u);
  });

  it("refuses a demo source beside a live one", () => {
    const sources = pair({
      second: {
        title: "Air",
        stationId: "678",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        dataMode: "live",
      },
    });
    expect(() => compose(sources)).toThrow(DashboardCompositionError);
  });

  it("refuses a pair that overruns the contract, as a composition failure", () => {
    // A contract rejection here is a property of the PAIR, not of either half:
    // both were parsed by whoever built them. Letting the `ZodError` escape
    // made it indistinguishable from a genuine fault, and the caller reported
    // it to the reader as "try rewording it" — advice that cannot work, since
    // no phrasing makes two dashboards fit inside one budget.
    //
    // Sixteen pages is the contract's ceiling, so nine plus nine overruns it.
    const oversized = (key: string): DashboardSpec => {
      const base = source({
        title: key,
        stationId: "1",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
      });
      return parseDashboardSpec({
        ...base,
        pages: Array.from({ length: 9 }, (_, index) => ({
          ...base.pages[0]!,
          id: `${key}-page-${String(index)}`,
          components: base.pages[0]!.components.map((component) => ({
            ...component,
            id: `${key}-${String(index)}-${component.id}`,
          })),
        })),
      });
    };

    const sources: ComposedSources = [
      { key: "river", label: "River", dashboard: oversized("r") },
      { key: "air", label: "Air quality", dashboard: oversized("a") },
    ];

    // Guard the guard: each half is legal on its own, so the failure really is
    // the pair's and this test is not just asserting a broken fixture.
    const half = sources[0]!;
    expect(half.dashboard.pages.length).toBe(9);
    expect(() => parseDashboardSpec(half.dashboard)).not.toThrow();

    expect(() => compose(sources)).toThrow(DashboardCompositionError);
    // The contract's own reason survives for logs, even though the reader
    // never sees it.
    try {
      compose(sources);
      throw new Error("expected composition to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardCompositionError);
      expect((error as Error).cause).toBeDefined();
    }
  });
});

describe("the brief carries both sources", () => {
  it("takes the later generatedAt so no evidence lands in the future", () => {
    expect(compose().generatedAt).toBe("2026-08-19T12:30:00.000Z");
  });

  it("attributes each half of every claim", () => {
    const { known } = compose().executiveBrief;
    expect(known.headline).toContain("River");
    expect(known.headline).toContain("Air quality");
    expect(known.detail).toContain("River");
    expect(known.detail).toContain("Air quality");
  });

  it("ends the first source's sentence before the second label starts", () => {
    // The assertion above is `toContain`, and `toContain` is exactly as
    // satisfied by fused prose as by separated prose — which is how
    // "...more than two hours old Air quality: Highest priority:..." reached
    // the executive brief of every combined dashboard. This one looks at the
    // BOUNDARY: whatever character precedes the second label must be able to
    // end a sentence.
    const unpunctuated = "Water-level reading is more than two hours old";
    const sources = pair({
      first: {
        title: "River",
        stationId: "1",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        importantDetail: unpunctuated,
      },
    });
    const { detail } = compose(sources).executiveBrief.important;

    // Guard the guard: the fixture really does supply prose with no terminal
    // punctuation, so a regression has something to fail on.
    expect(unpunctuated).not.toMatch(/[.!?]$/u);
    expect(detail).toContain(unpunctuated);
    expect(detail).toMatch(/old\. Air quality:/u);
    expect(detail).not.toMatch(/old Air quality:/u);
  });

  it("carries each source's own next action and summary, not just its label", () => {
    // Mutation testing found this gap: replacing the readers that pull
    // `nextAction.title`, `nextAction.detail` and `architecture.summary` off
    // each source with `() => undefined` left every other test passing. The
    // composed strings became "River: . Air quality: ." — correctly attributed
    // labels around nothing at all — and only the assertions above ran, which
    // check that the LABELS appear. Labels appearing is exactly as true of an
    // empty composition as of a full one.
    const spec = compose();

    expect(spec.nextAction.title).toContain("Check the highest reading");
    expect(spec.nextAction.detail).toContain(
      "Open the station with the largest recent change.",
    );
    expect(spec.architecture.summary).toContain("River pipeline.");
    expect(spec.architecture.summary).toContain("Air pipeline.");
  });

  it("leaves the last source's words as it wrote them", () => {
    // The other half of the termination rule, and the half nothing checked:
    // text is terminated so the NEXT label can follow it, so the last one has
    // nothing to be separated from. Forcing `isLast` to false survived
    // mutation because every fixture's last detail already ended in a full
    // stop. Here the last one does not, and a stray period would be the
    // composer editing a source's prose.
    const unpunctuated = "Ozone is climbing at two monitors";
    const sources = pair({
      second: {
        title: "Air",
        stationId: "2",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        importantDetail: unpunctuated,
      },
    });

    expect(unpunctuated).not.toMatch(/[.!?]$/u);
    expect(compose(sources).executiveBrief.important.detail).toMatch(
      /Ozone is climbing at two monitors$/u,
    );
  });

  it("does not double the punctuation of a detail that already ends", () => {
    // The other direction. The fixture's own details end in a full stop, and
    // "readings.. Air quality:" would be the obvious way to overcorrect.
    const spec = compose();
    for (const claim of ["known", "changed", "important"] as const) {
      expect(spec.executiveBrief[claim].detail).not.toMatch(/[.!?]{2}/u);
    }
    expect(spec.nextAction.detail).not.toMatch(/[.!?]{2}/u);
    expect(spec.architecture.summary).not.toMatch(/[.!?]{2}/u);
  });

  it("leaves headlines joined by the separator, not a full stop", () => {
    // Headlines are labels. Terminating one would be wrong in the other
    // direction, so the fix must not have leaked across.
    const { known } = compose().executiveBrief;
    expect(known.headline).toContain(" · Air quality:");
    expect(known.headline).not.toMatch(/\. Air quality:/u);
  });

  it("cites evidence from both sources", () => {
    const { known } = compose().executiveBrief;
    expect(known.evidenceIds.some((id) => id.startsWith("river:"))).toBe(true);
    expect(known.evidenceIds.some((id) => id.startsWith("air:"))).toBe(true);
  });

  it("keeps every citation when the union fits, however uneven the halves", () => {
    // `Math.max` -> `Math.min` survived mutation testing because every fixture
    // cited the same small number of things from each side. With 25 against 5
    // the two are distinguishable: `min` stops after five rounds and silently
    // drops twenty of the river half's citations.
    //
    // This also pins the `!== undefined` guards. Without them the short half
    // pushes `undefined` for rounds 5..24, and the contract refuses the spec.
    const sources = pair({
      first: {
        title: "River",
        stationId: "1",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        extraCitations: 24,
      },
      second: {
        title: "Air",
        stationId: "2",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        extraCitations: 4,
      },
    });
    const { evidenceIds } = compose(sources).executiveBrief.known;

    // 25 from the first half, 5 from the second, and the cap is 32.
    expect(evidenceIds.length).toBe(30);
    expect(evidenceIds.filter((id) => id.startsWith("river:")).length).toBe(25);
    expect(evidenceIds.filter((id) => id.startsWith("air:")).length).toBe(5);
    expect(new Set(evidenceIds).size).toBe(evidenceIds.length);
  });

  it("keeps both halves represented when the union exceeds the cap", () => {
    // The property the module's own comment claims and nothing checked:
    // "interleaving guarantees both sources are represented in whatever
    // survives". Removing the `.slice` survived mutation testing too, because
    // no fixture ever cited enough to reach the bound.
    //
    // 20 + 20 = 40, capped to 32. Interleaved that is 16 each. A naive
    // concat-then-truncate would keep all 20 of the first and only 12 of the
    // second, so the 15-per-side floor below is what separates the two
    // implementations rather than merely observing that the cap applied.
    const twenty = {
      generatedAt: "2026-08-19T12:00:00.000Z",
      freshness: FRESH,
      extraCitations: 19,
    } as const;
    const sources = pair({
      first: { title: "River", stationId: "1", ...twenty },
      second: { title: "Air", stationId: "2", ...twenty },
    });
    const { evidenceIds } = compose(sources).executiveBrief.known;

    expect(evidenceIds.length).toBe(DASHBOARD_MAX_EVIDENCE_IDS);
    expect(
      evidenceIds.filter((id) => id.startsWith("river:")).length,
    ).toBeGreaterThanOrEqual(15);
    expect(
      evidenceIds.filter((id) => id.startsWith("air:")).length,
    ).toBeGreaterThanOrEqual(15);
  });

  it("keeps the weaker statement types when the cap forces a choice", () => {
    // Union is observed+calculated+interpreted; the contract allows two.
    // Dropping `interpreted` would present interpretation as observation.
    const sources = pair({
      first: {
        title: "River",
        stationId: "1",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        statementTypes: ["observed", "calculated"],
      },
      second: {
        title: "Air",
        stationId: "2",
        generatedAt: "2026-08-19T12:00:00.000Z",
        freshness: FRESH,
        statementTypes: ["interpreted"],
      },
    });
    expect(compose(sources).executiveBrief.known.statementTypes).toEqual([
      "calculated",
      "interpreted",
    ]);
  });
});

describe("a source that did not load is composed as an absence", () => {
  const AIR_ABSENT: readonly AbsentSource[] = [
    { key: "air", label: "Air quality" },
  ];

  /** One loaded source, one absence, and a title that does not overclaim. */
  function partial(
    sources: ComposedSources = [pair()[0]!],
    absent: readonly AbsentSource[] = AIR_ABSENT,
  ): DashboardSpec {
    return composeDashboards(sources, {
      ...OPTIONS,
      title: "River — Air quality unavailable",
      absent,
    });
  }

  it("builds the dashboard instead of refusing the whole request", () => {
    // The behaviour this slice reverses. Refusing here was truthful, but it
    // discarded a river dashboard the reader could have used over a fault in
    // the air source.
    const spec = partial();

    expect(spec.pages.map((page) => page.id)).toEqual(["river:overview"]);
    expect(() => parseDashboardSpec(spec)).not.toThrow();
  });

  it("says which source is missing, everywhere the loaded one speaks", () => {
    // The difference between an honest partial and a silent one. A silent
    // partial passes every structural assertion above and mentions the absent
    // source in none of these four places.
    const spec = partial();

    expect(spec.executiveBrief.known.detail).toMatch(
      /Air quality: unavailable when this dashboard was built\.$/u,
    );
    expect(spec.nextAction.detail).toMatch(
      /Air quality: unavailable when this dashboard was built\.$/u,
    );
    expect(spec.architecture.summary).toMatch(
      /Air quality: unavailable when this dashboard was built\.$/u,
    );
    expect(spec.freshness.label).toBe(
      "River: Fresh · Air quality: unavailable",
    );
  });

  it("ends the loaded source's sentence before the absence starts", () => {
    // Same boundary defect as the two-loaded-source case, and `toContain`
    // would be as satisfied by fused prose here as it was there.
    const spec = partial([
      {
        key: "river",
        label: "River",
        dashboard: source({
          title: "River",
          stationId: "1",
          generatedAt: "2026-08-19T12:00:00.000Z",
          freshness: FRESH,
          importantDetail: "Water-level reading is more than two hours old",
        }),
      },
    ]);
    const { detail } = spec.executiveBrief.important;

    expect(detail).toMatch(/old\. Air quality: unavailable/u);
    expect(detail).not.toMatch(/old Air quality:/u);
  });

  it("keeps the absence a label in headlines, not a sentence", () => {
    expect(partial().executiveBrief.known.headline).toBe(
      "River: River known · Air quality: unavailable",
    );
  });

  it("invents no page, no evidence and no architecture node for it", () => {
    // Nothing was fetched, so there is nothing to cite. Manufacturing an
    // evidence record for an absence would be the one dishonesty worse than
    // saying nothing: a citation for a thing that was never retrieved.
    const spec = partial();

    for (const id of [
      ...spec.pages.map((page) => page.id),
      ...spec.evidence.map((item) => item.id),
      ...spec.architecture.nodes.map((node) => node.id),
    ]) {
      expect(id.startsWith("air:")).toBe(false);
    }
  });

  it("will not call itself fresh while a source is missing", () => {
    // The machine-readable half of the honest partial, for a reader who never
    // reaches the notice. The loaded source is FRESH, so a rule that only
    // quantifies over what loaded reports "fresh" here.
    expect(partial().freshness.status).toBe("partial");

    // Guard the guard: the same source, composed with a second one that DID
    // load and is equally fresh, is fresh. So "partial" above is the absence
    // talking and not a fixture that was never fresh to begin with.
    expect(compose().freshness.status).toBe("fresh");
  });

  it("refuses to date the page from the half that reported", () => {
    // An absence is an unknown observation time, and the existing rule is that
    // one unknown suppresses the field. Reporting the loaded source's
    // timestamp under a single page-level heading would present half the
    // page's currency as the whole page's.
    // OMITTED, not present-and-undefined. `toBeUndefined` alone passes on a
    // spec that carries the key with no value, which is a different claim: the
    // field is optional in the contract and its absence is what says "unknown".
    expect(partial().freshness).not.toHaveProperty("latestObservationAt");
    expect(compose().freshness.latestObservationAt).toBe(
      "2026-08-19T11:00:00.000Z",
    );
  });

  it("survives being saved and reopened, because it lives in the spec", () => {
    // The absence has to be a property of the dashboard, not of the render
    // that happened to produce it. A reopened dashboard is parsed from stored
    // bytes with no memory of the request, so anything the renderer knew and
    // the spec did not is gone by then.
    const reopened = parseDashboardSpec(
      JSON.parse(JSON.stringify(partial())) as unknown,
    );

    expect(reopened.freshness.status).toBe("partial");
    expect(reopened.executiveBrief.known.detail).toContain(
      "Air quality: unavailable when this dashboard was built.",
    );
    // "when this dashboard was built", not "right now": by the time this is
    // reopened the source may well be answering again, and the sentence still
    // has to be true.
    expect(reopened.executiveBrief.known.detail).not.toContain(
      "unavailable right now",
    );
  });

  it("refuses when nothing loaded, because that is a refusal", () => {
    expect(() =>
      composeDashboards([], {
        ...OPTIONS,
        absent: [
          { key: "river", label: "River" },
          { key: "air", label: "Air quality" },
        ],
      }),
    ).toThrow(/at least one source that loaded/u);
  });

  it("counts an absence against the source ceiling", () => {
    // Two loaded and two absent is four sources asked for. A ceiling that
    // counted only what loaded would let a request past the policy on the days
    // its sources were down, which is backwards.
    expect(() =>
      partial(pair(), [
        { key: "tide", label: "Tide" },
        { key: "wind", label: "Wind" },
      ]),
    ).toThrow(
      new RegExp(`limited to ${String(MAX_COMPOSED_SOURCES)} sources`, "u"),
    );
  });

  it("refuses an absence that would collide with a loaded namespace", () => {
    // The key claims no ids today. It is still checked, because otherwise a
    // duplicate would only become an error on the days both sources are up.
    expect(() =>
      partial(pair(), [{ key: "air", label: "Air quality" }]),
    ).toThrow(/namespace "air"/u);
  });
});
