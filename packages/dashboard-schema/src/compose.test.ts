import { describe, expect, it } from "vitest";

import {
  composeDashboards,
  DashboardCompositionError,
  type ComposedSources,
} from "./compose";
import { parseDashboardSpec, type DashboardSpec } from "./schema";

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
        evidenceIds: ["station-reading"],
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

describe("composition refuses what it cannot state honestly", () => {
  it("refuses two sources sharing a namespace", () => {
    const sources = pair();
    const clashing = [
      sources[0],
      { ...sources[1], key: "river" },
    ] as ComposedSources;
    expect(() => compose(clashing)).toThrow(DashboardCompositionError);
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
