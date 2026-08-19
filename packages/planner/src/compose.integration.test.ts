import { describe, expect, it } from "vitest";

import {
  AIR_COMPUTATION,
  AIR_WORDS,
  parseOpenAqHourlySnapshot,
} from "@dasher/air-domain";
import {
  composeDashboards,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import {
  parseUsgsInstantaneousValues,
  RIVER_COMPUTATION,
  RIVER_WORDS,
} from "@dasher/river-domain";

import airFixture from "../../../fixtures/openaq/sacramento-hourly.json";
import riverFixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { compilePlan } from "./compile";
import type { DashboardPlan } from "./plan";

/**
 * Two real sources, two real parsers, two real policies, one dashboard.
 *
 * The unit tests for `composeDashboards` use hand-built specs so they can force
 * exact collisions. This one uses what the product actually produces: USGS
 * bytes through the river parser under river rules, OpenAQ bytes through the
 * air parser under air rules, each compiled by the same shared compiler, and
 * only then composed. If the two halves could contaminate each other, this is
 * where it would show.
 *
 * The vocabulary check is per-half on purpose. The combined dashboard's own
 * prose — its brief, notice, next action and freshness label — names BOTH
 * subjects by design, because attribution is the point. What must stay clean is
 * each source's own pages: river pages must not acquire monitor semantics, and
 * air pages must not acquire gauge thresholds.
 */

const AS_OF = "2026-08-18T12:02:00.000Z";

const riverStations = parseUsgsInstantaneousValues(riverFixture);
const airStations = parseOpenAqHourlySnapshot(airFixture);

function planFor(stations: readonly { siteId: string }[]): DashboardPlan {
  return {
    planVersion: "plan-v1",
    title: "Conditions",
    audience: "Operations",
    framing: "Where things stand and which way they are moving.",
    siteIds: stations.map((station) => station.siteId),
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Everything, with the movers called out.",
        sections: [
          "conditions-summary",
          "headline-metrics",
          "gauge-map",
          "gauge-table",
          "fastest-rising",
          "stage-trends",
          "attention",
        ],
      },
    ],
  };
}

const river = compilePlan(planFor(riverStations), riverStations, {
  asOf: AS_OF,
  planner: { id: "river-test-planner", usesModel: false },
  computation: RIVER_COMPUTATION,
  words: RIVER_WORDS,
  thresholds: [],
});

const air = compilePlan(planFor(airStations), airStations, {
  asOf: AS_OF,
  planner: { id: "air-test-planner", usesModel: false },
  computation: AIR_COMPUTATION,
  words: AIR_WORDS,
  thresholds: [],
});

function combined(): DashboardSpec {
  return composeDashboards(
    [
      { key: "river", label: "River", dashboard: river },
      { key: "air", label: "Air quality", dashboard: air },
    ],
    {
      id: "combined-river-air-conditions",
      title: "River and Air quality — combined conditions",
      audience: "Readers tracking river and air-quality together",
      notice: "Two sources, built separately and shown side by side.",
    },
  );
}

/** Every prose string under a node, with identifier fields excluded. */
function prose(node: unknown, path = "spec"): Array<[string, string]> {
  const IDENTIFIER_KEYS = new Set([
    "id",
    "kind",
    "from",
    "to",
    "schemaVersion",
    "evidenceIds",
    "statementTypes",
  ]);
  const found: Array<[string, string]> = [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, at);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (IDENTIFIER_KEYS.has(key)) continue;
        walk(child, `${at}.${key}`);
      }
      return;
    }
    if (typeof value === "string") found.push([at, value]);
  };
  walk(node, path);
  return found;
}

describe("two real sources compose into one contract-valid dashboard", () => {
  it("passes the contract", () => {
    // `composeDashboards` ends in `parseDashboardSpec`, so reaching this line
    // at all is the contract check. Asserting the shape keeps the reason legible.
    const spec = combined();
    expect(spec.schemaVersion).toBe("1.2");
    expect(spec.pages.length).toBe(river.pages.length + air.pages.length);
    expect(spec.evidence.length).toBe(
      river.evidence.length + air.evidence.length,
    );
  });

  it("keeps every structural id unique within its own id space", () => {
    // Per space, not pooled. A component and an architecture node may share a
    // name — the compiler emits `attention` for both, and has always done so —
    // because they are addressed separately and the contract checks them
    // separately. Pooling them here would fail on a property nothing requires.
    const spec = combined();
    const spaces: Record<string, string[]> = {
      page: spec.pages.map((page) => page.id),
      component: spec.pages.flatMap((page) =>
        page.components.map((component) => component.id),
      ),
      evidence: spec.evidence.map((item) => item.id),
      architectureNode: spec.architecture.nodes.map((node) => node.id),
    };
    const duplicated = Object.entries(spaces).flatMap(([space, ids]) =>
      ids.length === new Set(ids).size ? [] : [space],
    );
    expect(Object.values(spaces).flat().length).toBeGreaterThan(10);
    expect(duplicated, "an id space contains duplicates").toEqual([]);
  });

  it("would collide without namespacing, which is why this matters", () => {
    // Not a hypothetical: the compiler emits the same literals for both
    // domains, so the raw ids really do clash before composition.
    const rawComponentIds = [
      ...river.pages.flatMap((page) =>
        page.components.map((component) => component.id),
      ),
      ...air.pages.flatMap((page) =>
        page.components.map((component) => component.id),
      ),
    ];
    expect(new Set(rawComponentIds).size).toBeLessThan(rawComponentIds.length);
  });
});

describe("neither half acquires the other's vocabulary", () => {
  const riverPages = (spec: DashboardSpec) =>
    spec.pages.filter((page) => page.id.startsWith("river:"));
  const airPages = (spec: DashboardSpec) =>
    spec.pages.filter((page) => page.id.startsWith("air:"));

  it("keeps monitor semantics out of the river pages", () => {
    const texts = prose(riverPages(combined()));
    expect(texts.length).toBeGreaterThan(20);
    // `\bmonitors?\b`, not `monitor`. The river half legitimately says
    // "Gauges monitored", and a substring match flags that as air vocabulary —
    // it did, on the first run of this test. The air-side sweep below already
    // had this precision; this one had to earn it.
    expect(
      texts.filter(([, text]) =>
        /\bmonitors?\b|pm\s*2\.?5|µg\/m³|air[\s-]quality|ozone/iu.test(text),
      ),
    ).toEqual([]);
  });

  it("keeps gauge semantics out of the air pages", () => {
    const texts = prose(airPages(combined()));
    expect(texts.length).toBeGreaterThan(20);
    expect(
      texts.filter(([, text]) =>
        /gauge|river|usgs|water[\s-]level|streamflow/iu.test(text),
      ),
    ).toEqual([]);
  });

  it("still says both subjects in the combined dashboard's own prose", () => {
    // Attribution is the point: the shared surfaces must name both.
    const spec = combined();
    const shared = [
      spec.freshness.label,
      spec.nextAction.title,
      spec.nextAction.detail,
      spec.executiveBrief.known.headline,
      spec.executiveBrief.known.detail,
    ].join(" ");
    expect(shared).toMatch(/River/u);
    expect(shared).toMatch(/Air quality/u);
  });
});

describe("readings stay under their own rules", () => {
  it("carries each half's own units and evidence through unchanged", () => {
    const spec = combined();

    // The river half's readings are still feet; the air half's are still
    // µg/m³. Composition arranged them and computed nothing.
    const unitsUnder = (prefix: string): string[] =>
      spec.pages
        .filter((page) => page.id.startsWith(prefix))
        .flatMap((page) => page.components)
        .flatMap((component) =>
          component.kind === "station-table" || component.kind === "station-map"
            ? component.stations.map((station) => station.primary.unit)
            : [],
        );

    expect(new Set(unitsUnder("river:"))).toEqual(
      new Set(
        river.pages
          .flatMap((page) => page.components)
          .flatMap((component) =>
            component.kind === "station-table" ||
            component.kind === "station-map"
              ? component.stations.map((station) => station.primary.unit)
              : [],
          ),
      ),
    );
    expect(new Set(unitsUnder("air:"))).toEqual(
      new Set(
        air.pages
          .flatMap((page) => page.components)
          .flatMap((component) =>
            component.kind === "station-table" ||
            component.kind === "station-map"
              ? component.stations.map((station) => station.primary.unit)
              : [],
          ),
      ),
    );
  });
});
