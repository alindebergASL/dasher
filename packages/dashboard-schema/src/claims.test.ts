import { describe, expect, it } from "vitest";

import { canonicalBytes } from "./canonical";
import { claimPointer, extractSpecClaims } from "./claims";
import { parseDashboardSpec, type DashboardSpec } from "./schema";

/**
 * A spec with four evidence kinds and three assertion-carrying component kinds,
 * because the interesting behaviour of this walk is which pointer it produces
 * and which of several evidence kinds a claim inherits — neither of which a
 * single-evidence fixture can show.
 */
function station(id: string) {
  return {
    id,
    name: `Gauge ${id}`,
    group: "Sacramento",
    latitude: 38.5,
    longitude: -121.5,
    primary: { value: 4.2, unit: "ft" },
    secondary: { value: 900, unit: "cfs" },
    direction: "rising" as const,
    freshness: "fresh" as const,
    evidenceIds: ["observed-1"],
  };
}

const SPEC_INPUT = {
  schemaVersion: "1.2",
  id: "mixed",
  title: "Mixed evidence",
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
    evidenceIds: ["observed-1"],
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
          tone: "normal",
          evidenceIds: ["observed-1"],
          claims: [
            { text: "Conditions are stable.", evidenceIds: ["observed-1"] },
            {
              text: "Spend is tracking to budget.",
              evidenceIds: ["observed-1", "calculated-1"],
            },
          ],
        },
        {
          id: "grid",
          kind: "metric-grid",
          title: "Figures",
          evidenceIds: ["calculated-1"],
          metrics: [
            {
              label: "Total",
              value: "152,850",
              evidenceIds: ["calculated-1", "interpreted-1"],
            },
            {
              label: "Change",
              value: "+4%",
              evidenceIds: ["recommended-1", "observed-1"],
            },
          ],
        },
      ],
    },
    {
      id: "details",
      title: "Details",
      description: "Every remaining component kind, so none goes unwalked",
      components: [
        {
          id: "map",
          kind: "station-map",
          title: "Where",
          evidenceIds: ["observed-1"],
          stations: [station("gauge-a"), station("gauge-b")],
        },
        {
          id: "table",
          kind: "station-table",
          title: "Readings",
          evidenceIds: ["observed-1"],
          columns: { station: "Gauge", primary: "Stage", secondary: "Flow" },
          stations: [station("gauge-c")],
        },
        {
          id: "ranking",
          kind: "ranking",
          title: "Largest movers",
          evidenceIds: ["calculated-1"],
          items: [
            {
              id: "first",
              label: "Field operations",
              value: "+9%",
              evidenceIds: ["calculated-1"],
            },
          ],
        },
        {
          id: "trend",
          kind: "trend-list",
          title: "Over time",
          evidenceIds: ["observed-1"],
          series: [
            {
              id: "stage",
              label: "Stage",
              unit: "ft",
              evidenceIds: ["observed-1"],
              points: [
                { at: "2026-07-29T10:00:00.000Z", value: 1 },
                { at: "2026-07-29T11:00:00.000Z", value: 2 },
              ],
            },
          ],
        },
        {
          id: "alerts",
          kind: "alert-list",
          title: "Attention",
          evidenceIds: ["interpreted-1"],
          alerts: [
            {
              id: "rising",
              severity: "attention",
              title: "Stage rising",
              detail: "The gauge has risen for three consecutive readings.",
              evidenceIds: ["interpreted-1"],
            },
          ],
        },
      ],
    },
    {
      id: "empty",
      title: "Empty",
      description: "A component that asserts nothing",
      components: [
        {
          id: "no-alerts",
          kind: "alert-list",
          title: "Nothing to report",
          alerts: [],
          evidenceIds: [],
        },
      ],
    },
  ],
  evidence: (
    ["observed", "calculated", "interpreted", "recommended"] as const
  ).map((kind) => ({
    id: `${kind}-1`,
    kind,
    label: `${kind} item`,
    sourceName: "Fixture",
    retrievedAt: "2026-07-29T12:01:00.000Z",
    detail: `An ${kind} evidence item.`,
    confidence: "high" as const,
  })),
  architecture: {
    title: "How this dashboard works",
    summary: "Read, calculate, explain.",
    nodes: [
      {
        id: "source",
        label: "Source",
        detail: "Fixture",
        kind: "input",
      },
      { id: "page", label: "Dashboard", detail: "Two pages", kind: "page" },
    ],
    edges: [{ from: "source", to: "page", label: "updates" }],
  },
  executiveBrief: {
    known: {
      statementTypes: ["observed"],
      headline: "One condition is known",
      detail: "The current source reading is available.",
      evidenceIds: ["observed-1"],
    },
    changed: {
      statementTypes: ["calculated"],
      headline: "Conditions remain stable",
      detail: "The calculated change is within the stable range.",
      evidenceIds: ["calculated-1"],
    },
    important: {
      statementTypes: ["interpreted"],
      headline: "Review before publishing",
      detail: "The source should be confirmed before this view is shared.",
      evidenceIds: ["interpreted-1"],
    },
  },
};

const spec: DashboardSpec = parseDashboardSpec(SPEC_INPUT);

function claimAt(pointer: string) {
  const found = extractSpecClaims(spec).find(
    (claim) => claim.pointer === pointer,
  );
  if (found === undefined) throw new Error(`no claim at ${pointer}`);
  return found;
}

describe("extractSpecClaims", () => {
  it("addresses every assertion, and only assertions", () => {
    // The exact set, not a count: a walk that silently stops visiting a
    // component kind still passes a length check written against the old total.
    // All seven kinds appear, because a mutation run reported four of them as
    // never walked — a bug in the `ranking` branch would have shipped.
    expect(extractSpecClaims(spec).map((claim) => claim.pointer)).toEqual([
      "/nextAction",
      "/executiveBrief/known",
      "/executiveBrief/changed",
      "/executiveBrief/important",
      "/pages/0/components/0/claims/0",
      "/pages/0/components/0/claims/1",
      "/pages/0/components/1/metrics/0",
      "/pages/0/components/1/metrics/1",
      "/pages/1/components/0/stations/0",
      "/pages/1/components/0/stations/1",
      "/pages/1/components/1/stations/0",
      "/pages/1/components/2/items/0",
      "/pages/1/components/3/series/0",
      "/pages/1/components/4/alerts/0",
    ]);
  });

  it("names each component kind's own item array in the pointer", () => {
    // `stations`, `items`, `series`, `alerts` — the key has to match the array
    // the item actually lives in, or the pointer addresses nothing in the
    // stored bytes and the claim is unresolvable for as long as the row exists.
    const pointers = extractSpecClaims(spec).map((claim) => claim.pointer);
    for (const key of [
      "claims",
      "metrics",
      "stations",
      "items",
      "series",
      "alerts",
    ]) {
      expect(
        pointers.some((one) => one.includes(`/${key}/`)),
        `no pointer names ${key}`,
      ).toBe(true);
    }
  });

  it("records no claim for a component with no items", () => {
    // The alert list on page 3 has an empty `alerts` array and an empty
    // `evidenceIds`. A component is a container, so it contributes nothing on
    // its own — asserting the absence because emitting a container-level claim
    // would double-count every row inside a populated one.
    expect(
      extractSpecClaims(spec).some((claim) =>
        claim.pointer.startsWith("/pages/2"),
      ),
    ).toBe(false);
  });

  it("inherits the most speculative evidence kind behind the assertion", () => {
    expect(claimAt("/nextAction").label).toBe("observed");
    expect(claimAt("/executiveBrief/changed").label).toBe("calculated");
    expect(claimAt("/executiveBrief/important").label).toBe("hypothesis");
    // observed + calculated is a calculation, not an observation.
    expect(claimAt("/pages/0/components/0/claims/1").label).toBe("calculated");
    // calculated + interpreted is an interpretation.
    expect(claimAt("/pages/0/components/1/metrics/0").label).toBe("hypothesis");
    // recommended outranks observed however the ids are ordered.
    expect(claimAt("/pages/0/components/1/metrics/1").label).toBe(
      "recommendation",
    );
  });

  it("marks the brief and the next action as the salient assertions", () => {
    const claims = extractSpecClaims(spec);
    expect(
      claims
        .filter((claim) => claim.salience === "high")
        .map((claim) => claim.pointer),
    ).toEqual([
      "/nextAction",
      "/executiveBrief/known",
      "/executiveBrief/changed",
      "/executiveBrief/important",
    ]);

    // And every other claim is `normal` — asserted rather than left implied,
    // because `claims_salience_check` accepts exactly these two words and a
    // third would abort the transaction the whole dashboard is saved in.
    for (const claim of claims.filter(
      (one) =>
        !one.pointer.startsWith("/executiveBrief") &&
        one.pointer !== "/nextAction",
    )) {
      expect(claim.salience, claim.pointer).toBe("normal");
    }
  });

  it("hashes the sub-document the pointer actually addresses", () => {
    // Not a re-derivation of the assertion's text: the bytes are the fragment
    // at the pointer, canonicalised the same way the stored spec is, so a
    // digest taken here and one taken from the stored bytes agree.
    expect(claimAt("/pages/0/components/0/claims/0").assertionBytes).toEqual(
      canonicalBytes(
        spec.pages[0]!.components[0]!.kind === "summary"
          ? spec.pages[0]!.components[0]!.claims[0]
          : undefined,
      ),
    );
    expect(claimAt("/nextAction").assertionBytes).toEqual(
      canonicalBytes(spec.nextAction),
    );
  });

  it("changes the assertion digest when the assertion changes", () => {
    const edited = structuredClone(SPEC_INPUT) as typeof SPEC_INPUT;
    edited.nextAction.detail = "Publish without confirming the source.";

    expect(claimAt("/nextAction").assertionBytes).not.toEqual(
      extractSpecClaims(parseDashboardSpec(edited)).find(
        (claim) => claim.pointer === "/nextAction",
      )?.assertionBytes,
    );
  });

  it("carries the evidence ids in the order the assertion lists them", () => {
    // The order is the edge order in `claim_evidence`, and a set would lose it.
    expect(claimAt("/pages/0/components/1/metrics/1").evidenceIds).toEqual([
      "recommended-1",
      "observed-1",
    ]);
  });

  it("labels an assertion unknown when its evidence cannot be resolved", () => {
    // Unreachable through `parseDashboardSpec`, which rejects an unresolved
    // reference at every site this walk visits — so it is reached here by
    // removing the evidence from an already-parsed spec. The guard is pinned
    // rather than trusted because the failure it prevents is silent: without
    // it, `LABEL_PRECEDENCE.find` returns nothing for a claim whose support
    // vanished and the claim would be recorded as `observed`, which is the
    // strongest label in the vocabulary and a lie about a missing source.
    const stripped: DashboardSpec = {
      ...spec,
      evidence: spec.evidence.filter((one) => one.id !== "observed-1"),
    };

    const claim = extractSpecClaims(stripped).find(
      (one) => one.pointer === "/nextAction",
    );
    expect(claim?.label).toBe("unknown");
  });

  it("labels an assertion unknown when it rests on no evidence at all", () => {
    // Also unreachable today: every site this walk visits requires at least one
    // evidence id. Pinned because the fallback is what decides the label if
    // that ever relaxes, and `observed` is what an unpinned `.find()` result
    // would most plausibly be replaced with.
    const unsupported: DashboardSpec = {
      ...spec,
      nextAction: { ...spec.nextAction, evidenceIds: [] },
    };

    expect(
      extractSpecClaims(unsupported).find(
        (one) => one.pointer === "/nextAction",
      )?.label,
    ).toBe("unknown");
  });

  it("produces pointers the database's own constraint accepts", () => {
    // `claims_json_pointer_check` rejects a malformed pointer with a constraint
    // violation that aborts the whole transaction, so the shape is asserted
    // here rather than discovered in an integration test.
    const pattern = /^(?:\/(?:[^~/\p{Cc}]|~0|~1)*)+$/u;
    for (const claim of extractSpecClaims(spec)) {
      expect(claim.pointer, claim.pointer).toMatch(pattern);
      expect(claim.pointer.length).toBeLessThanOrEqual(512);
    }
  });
});

describe("claimPointer", () => {
  it("joins path tokens into an RFC 6901 pointer", () => {
    expect(claimPointer("pages", 0, "components", 2, "items", 0)).toBe(
      "/pages/0/components/2/items/0",
    );
  });

  it("escapes the two characters a pointer token cannot carry literally", () => {
    // No token the walk produces contains either today, which is exactly why
    // this is asserted directly: an unescaped `/` does not fail, it silently
    // addresses a different place, and the stored claim would point at
    // something that is not the assertion it was recorded for.
    expect(claimPointer("a/b")).toBe("/a~1b");
    expect(claimPointer("a~b")).toBe("/a~0b");
    // `~` first, then `/`, or the escape of one eats the escape of the other:
    // escaping `/` to `~1` before `~` to `~0` would turn `a/b` into `/a~01b`.
    expect(claimPointer("a~/b")).toBe("/a~0~1b");
  });

  it("leaves an array index alone", () => {
    expect(claimPointer(0)).toBe("/0");
    expect(claimPointer(12)).toBe("/12");
  });
});
