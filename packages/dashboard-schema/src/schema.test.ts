import { describe, expect, it } from "vitest";

import { parseDashboardSpec } from "./schema";

const validSpec = {
  schemaVersion: "1.0",
  id: "river-demo",
  title: "River conditions",
  audience: "Leaders",
  generatedAt: "2026-07-29T12:00:00.000Z",
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
} as const;

describe("parseDashboardSpec", () => {
  it("accepts a multi-page dashboard", () => {
    expect(parseDashboardSpec(validSpec).pages).toHaveLength(2);
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
});
