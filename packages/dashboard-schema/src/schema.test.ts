import { ZodError } from "zod";
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_MAX_EVIDENCE_IDS,
  DASHBOARD_MAX_TOTAL_EVIDENCE_REFERENCES,
  DASHBOARD_SPEC_MAX_BYTES,
  DASHBOARD_STRING_LIMITS,
  parseDashboardSpec,
} from "./schema";

const validSpec = {
  schemaVersion: "1.2",
  id: "river-demo",
  title: "River conditions",
  audience: "Leaders",
  generatedAt: "2026-07-29T12:01:00.000Z",
  dataMode: "demo",
  freshness: {
    status: "fresh",
    label: "Updated just now",
    latestObservationAt: "2026-07-29T12:00:00.000Z",
  },
  nextAction: {
    title: "Review the readings",
    detail: "Confirm the source before publishing.",
    evidenceIds: ["e1"],
  },
  notice: "Not an official warning system.",
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Current conditions",
      components: [
        {
          id: "summary",
          kind: "summary",
          title: "What matters",
          claims: [{ text: "Conditions are stable.", evidenceIds: ["e1"] }],
          tone: "normal",
          evidenceIds: ["e1"],
        },
      ],
    },
    {
      id: "details",
      title: "Details",
      description: "Gauge detail",
      components: [
        {
          id: "alerts",
          kind: "alert-list",
          title: "Attention",
          alerts: [],
          evidenceIds: [],
        },
      ],
    },
  ],
  evidence: [
    {
      id: "e1",
      kind: "observed",
      label: "USGS reading",
      sourceName: "USGS",
      sourceUrl: "https://waterservices.usgs.gov/",
      observedAt: "2026-07-29T12:00:00.000Z",
      retrievedAt: "2026-07-29T12:01:00.000Z",
      detail: "Gauge observation",
      confidence: "high",
    },
  ],
  architecture: {
    title: "How this dashboard works",
    summary: "Read, calculate, explain.",
    nodes: [
      {
        id: "source",
        label: "River gauges",
        detail: "USGS readings",
        kind: "input",
      },
      { id: "page", label: "Dashboard", detail: "Two pages", kind: "page" },
    ],
    edges: [{ from: "source", to: "page", label: "updates" }],
  },
  executiveBrief: {
    known: {
      statementTypes: ["observed", "calculated"],
      headline: "One condition is known",
      detail: "The current source reading is available.",
      evidenceIds: ["e1"],
    },
    changed: {
      statementTypes: ["calculated"],
      headline: "Conditions remain stable",
      detail: "The calculated change is within the stable range.",
      evidenceIds: ["e1"],
    },
    important: {
      statementTypes: ["interpreted"],
      headline: "Review before publishing",
      detail: "The source should be confirmed before this view is shared.",
      evidenceIds: ["e1"],
    },
  },
} as const;

interface MutableBriefClaim {
  statementTypes: string[];
  headline: string;
  detail: string;
  evidenceIds: string[];
}

/** A mutable deep copy, since the fixture itself is `as const`. */
function specCopy(input: typeof validSpec = validSpec) {
  return structuredClone(input) as unknown as Omit<
    typeof validSpec,
    "executiveBrief"
  > & {
    executiveBrief: {
      known: MutableBriefClaim;
      changed: MutableBriefClaim;
      important: MutableBriefClaim;
    };
  };
}

describe("parseDashboardSpec", () => {
  it("accepts a 1.2 multi-page dashboard", () => {
    expect(parseDashboardSpec(validSpec).pages).toHaveLength(2);
  });

  it("rejects the retired 1.0 and 1.1 versions", () => {
    // ADR-007 dropped them while zero dashboards were persisted outside
    // tests. Sealed bytes in an old version must refuse to parse, so /d/[id]
    // answers 404 rather than rendering under a contract that no longer
    // exists.
    for (const schemaVersion of ["1.0", "1.1"]) {
      const input = { ...structuredClone(validSpec), schemaVersion };
      expect(() => parseDashboardSpec(input)).toThrow(ZodError);
    }
  });

  it("requires an executive brief", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    delete input["executiveBrief"];

    expect(() => parseDashboardSpec(input)).toThrow(ZodError);
  });

  it("accepts a strict evidence-linked executive brief", () => {
    const parsed = parseDashboardSpec(validSpec);
    expect(parsed.executiveBrief).toEqual(validSpec.executiveBrief);
  });

  it("requires bounded unique statement-type labels on every brief claim", () => {
    for (const statementTypes of [
      [],
      ["observed", "observed"],
      ["observed", "calculated", "interpreted"],
      ["recommended"],
    ]) {
      const input = specCopy();
      input.executiveBrief.known.statementTypes = statementTypes;
      expect(() => parseDashboardSpec(input)).toThrow(ZodError);
    }
  });

  it("rejects unknown executive brief keys", () => {
    const input = specCopy() as ReturnType<typeof specCopy> & {
      executiveBrief: ReturnType<typeof specCopy>["executiveBrief"] & {
        urgent: unknown;
      };
    };
    input.executiveBrief.urgent = {
      headline: "Unreviewed claim",
      detail: "Unknown claims must not enter the brief.",
      evidenceIds: ["e1"],
    };

    expect(() => parseDashboardSpec(input)).toThrow(ZodError);
  });

  it("fails closed with a fixed error when brief evidence is missing", () => {
    const input = specCopy();
    input.executiveBrief.changed.evidenceIds = ["attacker-secret-evidence"];

    expect(() => parseDashboardSpec(input)).toThrow(
      new Error("Executive brief Changed references missing evidence"),
    );
    try {
      parseDashboardSpec(input);
      expect.unreachable("Missing brief evidence should be rejected");
    } catch (error) {
      expect((error as Error).message).not.toContain(
        "attacker-secret-evidence",
      );
    }
  });

  it("counts executive brief references toward the global budget", () => {
    const input = specCopy() as Record<string, unknown>;
    const pages = input.pages as Array<{ components: unknown[] }>;
    pages[0]!.components.push(
      ...Array.from({ length: 13 }, (_, componentIndex) => ({
        id: `metrics-${componentIndex}`,
        kind: "metric-grid",
        title: `Metrics ${componentIndex}`,
        evidenceIds: ["e1"],
        metrics: Array.from({ length: 24 }, (_, metricIndex) => ({
          label: `Metric ${metricIndex}`,
          value: "1",
          evidenceIds: Array.from(
            { length: DASHBOARD_MAX_EVIDENCE_IDS },
            () => "e1",
          ),
        })),
      })),
    );

    expect(DASHBOARD_MAX_TOTAL_EVIDENCE_REFERENCES).toBe(10_000);
    expect(() => parseDashboardSpec(input)).toThrow(
      /total evidence reference count/,
    );
  });

  it("reads an accessor exactly once and validates its JSON snapshot", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const title = input.title;
    let reads = 0;
    Object.defineProperty(input, "title", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("title was read more than once");
        }
        return title;
      },
    });

    expect(parseDashboardSpec(input).title).toBe(title);
    expect(reads).toBe(1);
  });

  it("sanitizes hostile access errors without retaining their cause", () => {
    const secret = "attacker-secret-dashboard-value";
    const input = new Proxy(structuredClone(validSpec), {
      get() {
        throw new Error(secret);
      },
    });

    try {
      parseDashboardSpec(input);
      expect.unreachable("Hostile input should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "DashboardSpec input must be JSON-serializable",
      );
      expect((error as Error).message).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("validates the same representation returned by toJSON", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    input.title = "x".repeat(DASHBOARD_SPEC_MAX_BYTES);
    let calls = 0;
    input.toJSON = () => {
      calls += 1;
      return structuredClone(validSpec);
    };

    const parsed = parseDashboardSpec(input);

    expect(parsed.title).toBe(validSpec.title);
    expect(parsed).not.toHaveProperty("toJSON");
    expect(calls).toBe(1);
  });

  it("rejects an unknown component kind", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      components: Array<Record<string, unknown>>;
    }>;
    pages[0]!.components[0]!.kind = "arbitrary-html";
    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("rejects dangling evidence references", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      components: Array<{ evidenceIds: string[] }>;
    }>;
    pages[0]!.components[0]!.evidenceIds = ["missing"];
    expect(() => parseDashboardSpec(input)).toThrow(/missing evidence/);
  });

  it("rejects dangling claim-level evidence references", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      components: Array<{ claims?: Array<{ evidenceIds: string[] }> }>;
    }>;
    pages[0]!.components[0]!.claims![0]!.evidenceIds = ["missing"];
    expect(() => parseDashboardSpec(input)).toThrow(/Summary claim/);
  });

  it("rejects dangling item-level evidence references", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      components: Array<{
        alerts?: Array<{
          id: string;
          severity: "info";
          title: string;
          detail: string;
          evidenceIds: string[];
        }>;
      }>;
    }>;
    pages[1]!.components[0]!.alerts!.push({
      id: "bad-alert",
      severity: "info",
      title: "Bad reference",
      detail: "This must fail closed.",
      evidenceIds: ["missing"],
    });
    expect(() => parseDashboardSpec(input)).toThrow(/Item 1/);
  });

  it("rejects dangling architecture edges", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const architecture = input.architecture as { edges: Array<{ to: string }> };
    architecture.edges[0]!.to = "missing";
    expect(() => parseDashboardSpec(input)).toThrow(/missing node/);
  });

  it("rejects unsafe or credential-bearing source URLs", () => {
    for (const sourceUrl of [
      "javascript:alert(1)",
      "https://user:secret@example.com/source",
    ]) {
      const input = structuredClone(validSpec) as Record<string, unknown>;
      const evidence = input.evidence as Array<{ sourceUrl: string }>;
      evidence[0]!.sourceUrl = sourceUrl;
      expect(() => parseDashboardSpec(input)).toThrow(
        /credential-free HTTP\(S\)/,
      );
    }
  });

  it("reports a normal Zod failure for a malformed source URL", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const evidence = input.evidence as Array<{ sourceUrl: string }>;
    evidence[0]!.sourceUrl = "not a URL";

    try {
      parseDashboardSpec(input);
      expect.unreachable("Malformed source URL should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it("rejects unknown properties and duplicate identifiers", () => {
    const withUnknown = structuredClone(validSpec) as Record<string, unknown>;
    withUnknown.executableCode = "alert(1)";
    expect(() => parseDashboardSpec(withUnknown)).toThrow();

    const withDuplicate = structuredClone(validSpec) as Record<string, unknown>;
    const evidence = withDuplicate.evidence as Array<Record<string, unknown>>;
    evidence.push(structuredClone(evidence[0]!));
    expect(() => parseDashboardSpec(withDuplicate)).toThrow(
      /Evidence IDs must be unique/,
    );
  });

  it("requires architecture metadata", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    delete input.architecture;
    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("rejects duplicate claim texts within a summary component", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      components: Array<{
        claims?: Array<{ text: string; evidenceIds: string[] }>;
      }>;
    }>;
    pages[0]!.components[0]!.claims!.push({
      text: "Conditions are stable.",
      evidenceIds: ["e1"],
    });

    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("rejects duplicate metric labels within a metric grid", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{ components: unknown[] }>;
    pages[0]!.components.push({
      id: "metrics",
      kind: "metric-grid",
      title: "Metrics",
      metrics: [
        {
          label: "Stage",
          value: "14.8 ft",
          evidenceIds: ["e1"],
        },
        {
          label: "Stage",
          value: "14.9 ft",
          evidenceIds: ["e1"],
        },
      ],
      evidenceIds: ["e1"],
    });

    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("rejects duplicate architecture edges", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const architecture = input.architecture as { edges: unknown[] };
    architecture.edges.push(structuredClone(architecture.edges[0]!));

    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("keeps distinct architecture edge tuples containing arrow characters", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const architecture = input.architecture as {
      nodes: Array<{
        id: string;
        label: string;
        detail: string;
        kind: "input";
      }>;
      edges: Array<{ from: string; to: string; label: string }>;
    };
    architecture.nodes = ["a→b", "c", "a", "b→c"].map((id) => ({
      id,
      label: id,
      detail: `Node ${id}`,
      kind: "input",
    }));
    architecture.edges = [
      { from: "a→b", to: "c", label: "d" },
      { from: "a", to: "b→c", label: "d" },
    ];

    expect(parseDashboardSpec(input).architecture.edges).toHaveLength(2);
  });

  it("rejects a dashboard with an excessive number of pages", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      id: string;
      components: Array<{ id: string }>;
    }>;
    input.pages = Array.from({ length: 17 }, (_, index) => {
      const page = structuredClone(pages[0]!);
      page.id = `page-${index}`;
      page.components[0]!.id = `summary-${index}`;
      return page;
    });

    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("rejects a trend series with an excessive number of points", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{ components: unknown[] }>;
    pages[0]!.components.push({
      id: "trends",
      kind: "trend-list",
      title: "Trends",
      series: [
        {
          id: "stage-trend",
          label: "Stage",
          unit: "ft",
          evidenceIds: ["e1"],
          points: Array.from({ length: 5_001 }, (_, index) => ({
            at: "2026-07-29T12:00:00.000Z",
            value: index,
          })),
        },
      ],
      evidenceIds: ["e1"],
    });

    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("caps evidenceIds arrays at every nesting level", () => {
    const input = structuredClone(validSpec) as Record<string, unknown>;
    const pages = input.pages as Array<{
      components: Array<{
        claims?: Array<{ evidenceIds: string[] }>;
      }>;
    }>;
    pages[0]!.components[0]!.claims![0]!.evidenceIds = Array.from(
      { length: DASHBOARD_MAX_EVIDENCE_IDS + 1 },
      () => "e1",
    );

    expect(() => parseDashboardSpec(input)).toThrow();
  });

  it("rejects oversized strings across reusable string categories", () => {
    const oversizedId = structuredClone(validSpec) as Record<string, unknown>;
    oversizedId.id = "i".repeat(DASHBOARD_STRING_LIMITS.id + 1);

    const oversizedTitle = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    oversizedTitle.title = "t".repeat(DASHBOARD_STRING_LIMITS.shortText + 1);

    const oversizedNotice = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    oversizedNotice.notice = "n".repeat(DASHBOARD_STRING_LIMITS.longText + 1);

    const oversizedUrl = structuredClone(validSpec) as Record<string, unknown>;
    const evidence = oversizedUrl.evidence as Array<{ sourceUrl: string }>;
    evidence[0]!.sourceUrl = `https://example.com/${"u".repeat(
      DASHBOARD_STRING_LIMITS.url,
    )}`;

    const oversizedTimestamp = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    oversizedTimestamp.generatedAt = "2".repeat(
      DASHBOARD_STRING_LIMITS.isoTimestamp + 1,
    );

    for (const input of [
      oversizedId,
      oversizedTitle,
      oversizedNotice,
      oversizedUrl,
      oversizedTimestamp,
    ]) {
      expect(() => parseDashboardSpec(input)).toThrow(ZodError);
    }
  });

  it("rejects undefined, non-serializable, and circular input with a fixed error", () => {
    const circular = structuredClone(validSpec) as Record<string, unknown>;
    circular.circular = circular;

    for (const input of [undefined, 1n, circular]) {
      try {
        parseDashboardSpec(input);
        expect.unreachable("Non-serializable input should be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "DashboardSpec input must be JSON-serializable",
        );
        expect(error).not.toHaveProperty("cause");
      }
    }
  });

  it("rejects an oversized DashboardSpec JSON snapshot before Zod", () => {
    const oversized = structuredClone(validSpec) as Record<string, unknown>;
    oversized.padding = "x".repeat(DASHBOARD_SPEC_MAX_BYTES);
    expect(() => parseDashboardSpec(oversized)).toThrow(
      /exceeds the 1048576-byte serialized limit/,
    );
  });

  it("enforces cumulative item, trend-point, and evidence-reference budgets", () => {
    const tooManyItems = structuredClone(validSpec) as Record<string, unknown>;
    const itemPages = tooManyItems.pages as Array<{ components: unknown[] }>;
    itemPages[0]!.components.push(
      ...Array.from({ length: 10 }, (_, componentIndex) => ({
        id: `station-map-${componentIndex}`,
        kind: "station-map",
        title: `Station map ${componentIndex}`,
        evidenceIds: ["e1"],
        stations: Array.from({ length: 200 }, (_, stationIndex) => ({
          id: `station-${componentIndex}-${stationIndex}`,
          name: `Station ${stationIndex}`,
          group: "River",
          latitude: 0,
          longitude: 0,
          primary: { value: 1, unit: "ft" },
          secondary: { value: 1, unit: "ft3/s" },
          direction: "steady",
          freshness: "fresh",
          evidenceIds: ["e1"],
        })),
      })),
    );
    expect(() => parseDashboardSpec(tooManyItems)).toThrow(/total item count/);

    const tooManyPoints = structuredClone(validSpec) as Record<string, unknown>;
    const pointPages = tooManyPoints.pages as Array<{ components: unknown[] }>;
    pointPages[0]!.components.push({
      id: "many-trends",
      kind: "trend-list",
      title: "Many trends",
      evidenceIds: ["e1"],
      series: Array.from({ length: 3 }, (_, seriesIndex) => ({
        id: `series-${seriesIndex}`,
        label: `Series ${seriesIndex}`,
        unit: "ft",
        evidenceIds: ["e1"],
        points: Array.from({ length: 4_000 }, (_, pointIndex) => ({
          at: "2026-07-29T12:00:00.000Z",
          value: pointIndex,
        })),
      })),
    });
    expect(() => parseDashboardSpec(tooManyPoints)).toThrow(
      /total trend point count/,
    );

    const tooManyReferences = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    const referencePages = tooManyReferences.pages as Array<{
      components: unknown[];
    }>;
    referencePages[0]!.components.push(
      ...Array.from({ length: 14 }, (_, componentIndex) => ({
        id: `metrics-${componentIndex}`,
        kind: "metric-grid",
        title: `Metrics ${componentIndex}`,
        evidenceIds: ["e1"],
        metrics: Array.from({ length: 24 }, (_, metricIndex) => ({
          label: `Metric ${metricIndex}`,
          value: "1",
          evidenceIds: Array.from(
            { length: DASHBOARD_MAX_EVIDENCE_IDS },
            () => "e1",
          ),
        })),
      })),
    );
    expect(() => parseDashboardSpec(tooManyReferences)).toThrow(
      /total evidence reference count/,
    );
  });

  it("enforces evidence and freshness timestamp ordering", () => {
    const observedAfterRetrieved = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    const observedEvidence = observedAfterRetrieved.evidence as Array<{
      observedAt: string;
    }>;
    observedEvidence[0]!.observedAt = "2026-07-29T12:01:01.000Z";
    expect(() => parseDashboardSpec(observedAfterRetrieved)).toThrow(
      /observedAt must not be after retrievedAt/,
    );

    const retrievedAfterGenerated = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    const retrievedEvidence = retrievedAfterGenerated.evidence as Array<{
      retrievedAt: string;
    }>;
    retrievedEvidence[0]!.retrievedAt = "2026-07-29T12:01:01.000Z";
    expect(() => parseDashboardSpec(retrievedAfterGenerated)).toThrow(
      /retrievedAt must not be after generatedAt/,
    );

    const observationAfterGenerated = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    const freshness = observationAfterGenerated.freshness as {
      status: string;
      latestObservationAt?: string;
    };
    freshness.latestObservationAt = "2026-07-29T12:01:01.000Z";
    expect(() => parseDashboardSpec(observationAfterGenerated)).toThrow(
      /latestObservationAt must not be after generatedAt/,
    );

    const freshWithoutObservation = structuredClone(validSpec) as Record<
      string,
      unknown
    >;
    const missingFreshness = freshWithoutObservation.freshness as {
      latestObservationAt?: string;
    };
    delete missingFreshness.latestObservationAt;
    expect(() => parseDashboardSpec(freshWithoutObservation)).toThrow(
      /Fresh status requires latestObservationAt/,
    );
  });
});
