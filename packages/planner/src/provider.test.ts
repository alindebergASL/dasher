import { describe, expect, it } from "vitest";

import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  FakePlanningProvider,
  PLAN_MAX_SECTIONS_PER_PAGE,
  runPlanner,
  type DashboardPlan,
} from "./index";

/**
 * The fake provider's composition choices.
 *
 * Its own docstring says "it does make different composition choices for
 * different requests, which is what makes the loop worth testing: the plan is
 * not a fixed template". Two of its five branches — the homeowner one and the
 * rate-of-change one — had never been exercised by any test, so that sentence
 * was half-checked. Mutation testing is what surfaced it: adding this file to
 * the run produced 53 mutants with no coverage at all.
 *
 * These are not tests of prose. Each asserts the shape of the choice — who the
 * dashboard is for, how many pages, what leads — because that is the decision
 * the branch exists to make.
 */

const AS_OF = "2026-07-29T12:02:00.000Z";
const gauges = parseUsgsInstantaneousValues(fixture);

async function planFor(requestText: string) {
  const run = await runPlanner({
    requestText,
    gauges,
    provider: new FakePlanningProvider(),
    asOf: AS_OF,
  });
  return run;
}

function sectionsOf(plan: DashboardPlan): string[] {
  return plan.pages.flatMap((page) => page.sections);
}

describe("composition choices differ by request", () => {
  it("gives a homeowner one page and leads with plain conditions", async () => {
    const run = await planFor(
      "I own a house near the river and want to know about my property.",
    );

    expect(run.plan.audience).toBe("Homeowners and residents");
    // The whole point of this branch: one page, not the two-page overview.
    expect(run.plan.pages).toHaveLength(1);
    expect(sectionsOf(run.plan)[0]).toBe("conditions-summary");
    expect(sectionsOf(run.plan)).not.toContain("change-windows");
    expect(run.dashboard.pages).toHaveLength(1);
  });

  it("leads with the ranking when the request is about rate of change", async () => {
    const run = await planFor("Which gauges are rising fastest right now?");

    expect(run.plan.audience).toBe("Operations managers");
    expect(sectionsOf(run.plan)[0]).toBe("fastest-rising");
    expect(run.dashboard.pages[0]?.components[0]?.kind).toBe("ranking");
  });

  it("leads with the map when the request asks where", async () => {
    const run = await planFor("Where are the gauges?");

    expect(sectionsOf(run.plan)[0]).toBe("gauge-map");
    expect(run.dashboard.pages[0]?.components[0]?.kind).toBe("station-map");
  });

  it("gives emergency response the attention list first", async () => {
    const run = await planFor("Flood watch for emergency response.");

    expect(run.plan.audience).toBe("Emergency management leads");
    expect(sectionsOf(run.plan)[0]).toBe("attention");
  });

  it("falls back to the two-page overview for anything else", async () => {
    const run = await planFor("Tell me about the water.");

    expect(run.plan.audience).toBe("Managers and community leaders");
    expect(run.plan.pages).toHaveLength(2);
  });

  it("produces five distinct compositions, not one template", async () => {
    // The claim in the provider's docstring, asserted directly. If two branches
    // ever collapse into the same plan, the loop is being tested against a
    // constant while looking like it is being tested against a planner.
    const requests = [
      "Conditions near my property.",
      "Which gauges are rising fastest?",
      "Where are the gauges?",
      "Flood watch for emergency response.",
      "Tell me about the water.",
    ];
    const plans = await Promise.all(
      requests.map(async (request) =>
        JSON.stringify((await planFor(request)).plan),
      ),
    );

    expect(new Set(plans).size).toBe(requests.length);
  });

  it("misses natural phrasing, because it matches keywords rather than reading", async () => {
    // Found by the distinctness test above, which returned four instead of
    // five. "I own a house near the river" is close to the most natural way a
    // homeowner would ask, and it lands on the generic two-page overview
    // because the branch wants the literal words "my house" or "property".
    //
    // Pinned rather than fixed. Widening the keyword list would move the
    // boundary a few phrases outward and leave the next one failing just as
    // silently; the fake is a deterministic stand-in, and this is the shape of
    // its ceiling. It is also the clearest single argument for the real
    // provider: a model reads the sentence.
    const natural = await planFor("I own a house near the river.");
    const keyworded = await planFor("Conditions near my property.");

    expect(natural.plan.audience).toBe("Managers and community leaders");
    expect(keyworded.plan.audience).toBe("Homeowners and residents");
  });
});

describe("gauge selection", () => {
  it("selects every gauge when the request names none", async () => {
    const run = await planFor("Tell me about the water.");

    expect(run.plan.siteIds).toHaveLength(gauges.length);
  });

  it("selects by site id as well as by river name", async () => {
    const run = await planFor(`Show me gauge ${gauges[0]!.siteId}.`);

    expect(run.plan.siteIds).toStrictEqual([gauges[0]!.siteId]);
  });

  it("selects by station name", async () => {
    const run = await planFor(gauges[1]!.name.toLowerCase());

    expect(run.plan.siteIds).toStrictEqual([gauges[1]!.siteId]);
  });
});

describe("refinement edge cases", () => {
  const base: DashboardPlan = {
    planVersion: "plan-v1",
    title: "River Conditions",
    audience: "Managers",
    framing: "What is happening now.",
    siteIds: gauges.map((gauge) => gauge.siteId),
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Everything.",
        sections: [
          "conditions-summary",
          "headline-metrics",
          "gauge-map",
          "gauge-table",
          "attention",
          "fastest-rising",
        ],
      },
    ],
  };

  async function refine(previousPlan: DashboardPlan, instruction: string) {
    return runPlanner({
      requestText: "anything",
      gauges,
      provider: new FakePlanningProvider(),
      asOf: AS_OF,
      refine: { previousPlan, instruction },
    });
  }

  it("puts an added section on a page with room, not on a full one", async () => {
    // The first page is at the per-page limit. Appending there would push the
    // plan past the contract and read as the request being ignored.
    expect(base.pages[0]!.sections).toHaveLength(PLAN_MAX_SECTIONS_PER_PAGE);
    const twoPages: DashboardPlan = {
      ...base,
      pages: [
        base.pages[0]!,
        {
          id: "detail",
          title: "Detail",
          description: "More.",
          sections: ["change-windows"],
        },
      ],
    };

    const run = await refine(twoPages, "Add the history chart.");

    expect(run.plan.pages[0]?.sections).toHaveLength(
      PLAN_MAX_SECTIONS_PER_PAGE,
    );
    expect(run.plan.pages[1]?.sections).toContain("stage-trends");
  });

  it("leaves the plan alone when every page is full", async () => {
    const run = await refine(base, "Add the history chart.");

    expect(sectionsOf(run.plan)).not.toContain("stage-trends");
    expect(run.plan.pages[0]?.sections).toStrictEqual(base.pages[0]!.sections);
  });

  it("ignores a section name it was not asked to add or remove", async () => {
    // Naming a section is not an instruction on its own. Acting on a bare
    // mention would make "the map is useful" delete the map.
    const run = await refine(base, "The map is the useful part.");

    expect(run.plan).toStrictEqual(base);
  });

  it("keeps the gauge selection when the named river is not available", async () => {
    const run = await refine(base, "Just the Feather river.");

    expect(run.plan.siteIds).toStrictEqual(base.siteIds);
  });

  it("caps a shortened plan at the per-page section limit", async () => {
    const many: DashboardPlan = {
      ...base,
      pages: [
        base.pages[0]!,
        {
          id: "detail",
          title: "Detail",
          description: "More.",
          sections: ["change-windows", "stage-trends"],
        },
      ],
    };

    const run = await refine(many, "Make it shorter.");

    expect(run.plan.pages).toHaveLength(1);
    expect(run.plan.pages[0]?.sections.length).toBeLessThanOrEqual(
      PLAN_MAX_SECTIONS_PER_PAGE,
    );
  });
});
