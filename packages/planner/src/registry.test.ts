import { describe, expect, it } from "vitest";

import type { Station } from "@dasher/station-domain";

import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { compilePlan } from "./compile";
import {
  DashboardPlanSchema,
  findPlanProblems,
  type DashboardPlan,
} from "./plan";
import { matchedSections, readRefinementIntent } from "./provider";
import {
  offeredEntries,
  PATTERN_ENTRIES,
  PATTERN_REGISTRY,
  PATTERN_REGISTRY_VERSION,
  patternFor,
  PLAN_SECTION_KINDS,
  type PatternEntry,
} from "./registry";

/**
 * The registry checked against reality, not against itself.
 *
 * A registry is worth having only if it is the source of the facts it states.
 * The failure mode it invites is the opposite: a tidy data file that DESCRIBES
 * the compiler, drifts from it, and is believed anyway — which is what the
 * private `Set` in `plan.ts` had already done, naming two of its four
 * exclusions in a comment and omitting the other two for as long as it existed.
 *
 * So every claim below is checked by making the product do the thing. What a
 * section compiles to is checked by compiling it and reading the component that
 * came out. Whether it needs a station is checked by validating a plan with no
 * available station and looking for the finding. Whether it may be omitted is
 * checked by compiling it against data too thin to draw. An entry that lies now
 * fails here rather than in front of a reader.
 */

const AS_OF = "2026-07-29T12:02:00.000Z";
const gauges = parseUsgsInstantaneousValues(fixture);
const site = "11447650";

function planFor(
  siteIds: readonly string[],
  sections: DashboardPlan["pages"][number]["sections"],
): DashboardPlan {
  return {
    planVersion: "plan-v1",
    title: "Registry Test",
    audience: "Testers",
    framing: "A framing sentence.",
    siteIds: [...siteIds],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Everything at once.",
        sections: [...sections],
      },
    ],
  };
}

function compileOnly(
  section: PatternEntry["kind"],
  stations: readonly Station[] = gauges,
) {
  const spec = compilePlan(planFor([site], [section]), stations, {
    asOf: AS_OF,
    planner: { id: "registry-test-planner", usesModel: false },
  });
  return spec.pages
    .flatMap((page) => page.components)
    .find((component) => component.id === section);
}

/**
 * The same gauge with a single observation on its primary series.
 *
 * One point cannot be a line, which is the only condition under which the
 * compiler is allowed to drop a planned section. Trimming a real gauge rather
 * than inventing one keeps every other field the compiler reads exactly as the
 * fixture has it, so a section that goes missing here went missing for the
 * stated reason.
 */
function withOnePoint(): readonly Station[] {
  const gauge = gauges.find((candidate) => candidate.siteId === site);
  if (gauge?.primary === undefined)
    throw new Error("fixture gauge has no primary series");
  const first = gauge.primary.observations[0];
  if (first === undefined) throw new Error("fixture gauge has no observation");
  return [{ ...gauge, primary: { ...gauge.primary, observations: [first] } }];
}

describe.each(PATTERN_ENTRIES.map((entry) => [entry.kind, entry] as const))(
  "the %s entry describes what the product actually does",
  (kind, entry) => {
    it("compiles to the component kind it claims", () => {
      const component = compileOnly(kind);
      expect(component).toBeDefined();
      expect(component?.kind).toBe(entry.componentKind);
    });

    it("agrees with the validator about needing a station", () => {
      // No available station at all: the plan is refused either way, but only
      // the sections that describe individual stations should be named as the
      // reason, because those findings are what a provider gets back to repair.
      const findings = findPlanProblems(planFor(["nope"], [kind]), []);
      const needsSites = findings.some(
        (finding) => finding.code === "section_needs_sites",
      );
      expect(needsSites).toBe(entry.requiresSites);
    });

    it("is present or omitted, on thin data, exactly as it claims", () => {
      // One observation is enough for every section except a trend line.
      //
      // COMPILED BESIDE A COMPANION, not alone. The compiler drops a page whose
      // components all came to nothing, and a spec with no pages fails the
      // contract — so a plan of nothing but the omittable section does not
      // render an empty dashboard, it is refused. That is the right behaviour
      // and it is checked separately below; here it would just mask the
      // question, because the section would be "missing" from a spec that never
      // existed.
      const companion =
        kind === "conditions-summary"
          ? "headline-metrics"
          : "conditions-summary";
      const spec = compilePlan(
        planFor([site], [companion, kind]),
        withOnePoint(),
        {
          asOf: AS_OF,
          planner: { id: "registry-test-planner", usesModel: false },
        },
      );
      const present = spec.pages
        .flatMap((page) => page.components)
        .some((component) => component.id === kind);

      expect(present).toBe(!entry.mayBeOmitted);
    });

    it("is reachable by every word it lists", () => {
      for (const word of entry.triggerWords) {
        const intent = readRefinementIntent(`add the ${word}`, []);
        expect(intent.add).toContain(kind);
      }
    });

    it("carries its own documentation", () => {
      // Draco 2's rule, and the reason this file has a block per entry at all:
      // an entry with no stated purpose is a name, and a planner choosing
      // between eight names is guessing.
      expect(entry.summary.length).toBeGreaterThan(20);
      expect(entry.guidance.length).toBeGreaterThan(40);
      expect(entry.summary).toMatch(/[.!?]$/u);
      expect(entry.guidance).toMatch(/[.!?]$/u);
      expect(entry.kind).toBe(kind);
    });
  },
);

describe("the registry governs itself", () => {
  it("has exactly one entry per kind the schema accepts", () => {
    expect(PATTERN_ENTRIES.map((entry) => entry.kind)).toEqual([
      ...PLAN_SECTION_KINDS,
    ]);
    expect(Object.keys(PATTERN_REGISTRY).sort()).toEqual(
      [...PLAN_SECTION_KINDS].sort(),
    );
  });

  it("keys every entry by its own kind", () => {
    // A copy-pasted entry that kept the previous one's `kind` would pass every
    // per-entry check above, because those look the entry up BY that field.
    for (const [key, entry] of Object.entries(PATTERN_REGISTRY)) {
      expect(entry.kind).toBe(key);
    }
  });

  it("lets no trigger word of one entry hide inside another's", () => {
    // Trigger words are matched as substrings, so "map" inside "roadmap" would
    // route one instruction to two sections and the refinement would do two
    // things the reader asked once for. This is the invariant that makes
    // substring matching safe, and nothing enforced it while the table lived
    // privately in the provider.
    const owned = PATTERN_ENTRIES.flatMap((entry) =>
      entry.triggerWords.map((word) => [entry.kind, word] as const),
    );
    const collisions = owned.flatMap(([kind, word]) =>
      owned
        .filter(
          ([otherKind, other]) => otherKind !== kind && other.includes(word),
        )
        .map(
          ([otherKind, other]) =>
            `${kind}:${word} inside ${otherKind}:${other}`,
        ),
    );
    expect(collisions).toEqual([]);
  });

  it("stops offering a deprecated entry without unplanning it", () => {
    // The half of the lifecycle rule that has teeth. Deprecation removes a
    // section from what Dasher PROPOSES; it must not remove it from what Dasher
    // HONOURS, because plans naming it are already persisted and a reopened
    // dashboard renders from stored bytes.
    //
    // Checked against a hand-built list rather than the shipped registry, which
    // has nothing deprecated in it: a rule no entry exercises is a rule nothing
    // proves, and waiting for a real deprecation to find out whether the
    // filtering works is the wrong order.
    const retired: PatternEntry = {
      ...patternFor("change-windows"),
      status: "deprecated",
    };
    const offered = offeredEntries([patternFor("gauge-map"), retired]);

    expect(offered.map((entry) => entry.kind)).toEqual(["gauge-map"]);
    // ...and the schema still accepts a plan that names it.
    expect(
      DashboardPlanSchema.safeParse(planFor([site], ["change-windows"]))
        .success,
    ).toBe(true);
  });

  it("keeps a deprecated section out of what an instruction can reach", () => {
    // `offeredEntries` being correct does not make its CALL SITES correct, and
    // the refinement matcher is the one that would silently re-offer a retired
    // section the moment someone iterated the full list instead. Handing the
    // matcher a deprecated entry directly is the only way to check that today,
    // because the shipped registry has nothing deprecated in it.
    const map = patternFor("gauge-map");
    const retired: PatternEntry = { ...map, status: "deprecated" };

    expect(matchedSections("add the map", [map]).map(([kind]) => kind)).toEqual(
      ["gauge-map"],
    );
    expect(matchedSections("add the map", [retired])).toEqual([]);
  });

  it("offers everything it has today, so the filter is not hiding a mistake", () => {
    // The counterweight to the test above: `offeredEntries` returning fewer
    // than everything would also satisfy it. Nothing is deprecated yet, so the
    // two lists are the same length, and the day that stops being true is the
    // day this test is edited deliberately.
    expect(offeredEntries(PATTERN_ENTRIES).length).toBe(PATTERN_ENTRIES.length);
  });

  it("refuses a plan of nothing but an omittable section", () => {
    // Found by writing the test above rather than by reading the code. When the
    // only planned section is one the compiler may drop, the page empties, the
    // empty page is dropped, and the contract refuses a spec with no pages.
    //
    // That is the honest outcome — a dashboard with nothing on it should not
    // render — and it reaches the planner as a `spec_rejected` finding, which
    // is a revision request rather than a crash. Pinned here because it is the
    // one place `mayBeOmitted` has a consequence beyond a missing panel.
    const omittable = PATTERN_ENTRIES.find((entry) => entry.mayBeOmitted);
    expect(omittable).toBeDefined();

    expect(() =>
      compilePlan(planFor([site], [omittable!.kind]), withOnePoint(), {
        asOf: AS_OF,
        planner: { id: "registry-test-planner", usesModel: false },
      }),
    ).toThrow();

    // Guard the guard: the same plan against the full fixture builds fine, so
    // the refusal is the thin data and not the single-section shape.
    expect(() =>
      compilePlan(planFor([site], [omittable!.kind]), gauges, {
        asOf: AS_OF,
        planner: { id: "registry-test-planner", usesModel: false },
      }),
    ).not.toThrow();
  });

  it("stamps a semantic version on the set, not on each entry", () => {
    // Monolithic on purpose: entries are read together and a plan is valid
    // against the set, so a per-entry version would describe something no
    // consumer holds.
    expect(PATTERN_REGISTRY_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});
