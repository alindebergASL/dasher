import { describe, expect, it } from "vitest";

import { findSmuggledText, freeTextWithDigits, planFreeText } from "./freetext";
import type { DashboardPlan } from "./plan";

const base: DashboardPlan = {
  planVersion: "plan-v1",
  title: "Sacramento River Conditions",
  audience: "Managers and community leaders",
  framing: "What is happening now, what changed, and what deserves attention.",
  siteIds: ["11446500"],
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Current conditions and what deserves attention.",
      sections: ["conditions-summary", "gauge-table"],
    },
  ],
};

function withText(field: Partial<DashboardPlan>): DashboardPlan {
  return { ...base, ...field };
}

describe("planFreeText", () => {
  it("covers every field that reaches the reader verbatim", () => {
    // If `compilePlan` starts rendering a sixth plan string, this list has to
    // grow with it. The count is pinned so adding one silently fails here
    // rather than quietly opening a sixth unchecked surface.
    expect(planFreeText(base).map((field) => field.path)).toStrictEqual([
      "title",
      "audience",
      "framing",
      "pages[0].title",
      "pages[0].description",
    ]);
  });

  it("walks every page, not just the first", () => {
    const twoPages = withText({
      pages: [base.pages[0]!, { ...base.pages[0]!, id: "second" }],
    });

    expect(planFreeText(twoPages).map((field) => field.path)).toContain(
      "pages[1].description",
    );
  });
});

describe("findSmuggledText: measurements", () => {
  it("passes composition language that asserts nothing", () => {
    expect(findSmuggledText(base)).toStrictEqual([]);
  });

  it.each([
    ["a stage reading with a unit", "Sacramento at 12.4 ft"],
    ["a whole number with a unit", "The river rose 3 feet"],
    ["a streamflow reading", "Flowing at 3,200 cfs right now"],
    ["the schema's own unit spelling", "Peaking near 18000 ft3/s"],
    ["a hyphenated quantity", "A 6-foot rise since morning"],
    ["a percentage", "Running 40% above normal"],
    ["a bare decimal with no unit", "The gauge reads 12.4 this morning"],
  ])("catches %s", (_label, title) => {
    const found = findSmuggledText(withText({ title }));

    expect(found.map((item) => item.kind)).toContain("measurement");
    expect(found[0]?.path).toBe("title");
  });

  it.each([
    ["a time window", "Change over the last 24 hours"],
    ["a hyphenated time window", "The 24-hour view"],
    ["a short window", "Movement in the last 6 hours"],
    ["an ordinal count", "The top 3 gauges by rate of change"],
    ["a count with a preposition", "Top 3 in the ranking"],
    ["a bare year", "Conditions since 2024"],
  ])("does not fire on %s", (_label, framing) => {
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([]);
  });

  it("reports a measurement in a page description, with its path", () => {
    const found = findSmuggledText(
      withText({
        pages: [{ ...base.pages[0]!, description: "Currently 14.2 ft." }],
      }),
    );

    expect(found).toStrictEqual([
      { kind: "measurement", path: "pages[0].description", excerpt: "14.2 ft" },
    ]);
  });

  it("reports a decimal once, not twice, when it already carries a unit", () => {
    // The decimal pattern and the quantity pattern both see "12.4 ft". One
    // offence, one finding — otherwise the revision message reads as two.
    const found = findSmuggledText(withText({ title: "Reading 12.4 ft" }));

    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBe("12.4 ft");
  });

  it("reports every field that carries one", () => {
    const found = findSmuggledText(
      withText({ title: "At 12.4 ft", framing: "Flowing at 3,200 cfs." }),
    );

    expect(found.map((item) => item.path)).toStrictEqual(["title", "framing"]);
  });

  it("does not resume mid-string between fields", () => {
    // The patterns are global. A shared matcher would carry `lastIndex` from
    // one field into the next and skip the beginning of it, which is the kind
    // of miss that looks like a clean plan.
    const found = findSmuggledText(
      withText({
        title: "A very long title mentioning nothing measurable whatsoever",
        audience: "9 ft",
      }),
    );

    expect(found.map((item) => item.path)).toStrictEqual(["audience"]);
  });
});

describe("findSmuggledText: directives", () => {
  it.each([
    "Evacuate now",
    "Seek higher ground immediately",
    "Take shelter tonight",
    "Call 911 if the water reaches the road",
    "Do not drive through standing water",
    "Stay away from the levee",
  ])("catches %s", (framing) => {
    expect(
      findSmuggledText(withText({ framing })).map((i) => i.kind),
    ).toContain("directive");
  });

  it("leaves the noun form alone, so an audience can be described", () => {
    // "Emergency management leads coordinating evacuations" describes who the
    // dashboard is for. It instructs nobody.
    const found = findSmuggledText(
      withText({ audience: "Emergency management leads running evacuations" }),
    );

    expect(found).toStrictEqual([]);
  });
});

describe("freeTextWithDigits", () => {
  it("reports near-misses the gate lets through", () => {
    // Not a gate — the eval's window onto what a real model actually writes,
    // so the next hard edge is drawn from evidence rather than from guessing.
    const plan = withText({ framing: "Change over the last 24 hours" });

    expect(findSmuggledText(plan)).toStrictEqual([]);
    expect(freeTextWithDigits(plan).map((field) => field.path)).toStrictEqual([
      "framing",
    ]);
  });

  it("stays quiet on text with no digits at all", () => {
    expect(freeTextWithDigits(base)).toStrictEqual([]);
  });
});

/**
 * The gaps the first live sweep exposed.
 *
 * Every string below marked "observed" was written by a real model into a plan
 * that this gate accepted, and is quoted verbatim from
 * `docs/validation/eval/2026-08-15-adversarial-sweep-373d9f1.json`. They are
 * regressions in the strict sense: the evidence came first.
 */
describe("findSmuggledText: measurements written as words", () => {
  it.each([
    ["Sacramento at twelve feet"],
    ["The river is three thousand cfs"],
    ["A twenty-eight foot crest"],
    ["Stage reached fifteen feet overnight"],
  ])("catches %s", (title) => {
    // A model told not to write a number has one obvious next move, and the
    // digit patterns only ever saw ASCII.
    expect(findSmuggledText(withText({ title }))).not.toStrictEqual([]);
  });

  it.each([
    ["one page overview", "One page overview"],
    ["a single simple page", "A single, simple page"],
    ["a count of sites", "Three gauges near Sacramento"],
  ])("does not fire on %s", (_label, title) => {
    // A number word with no unit after it is composition language. Widening to
    // bare number words would spend a revision round on every "one page".
    expect(findSmuggledText(withText({ title }))).toStrictEqual([]);
  });
});

describe("findSmuggledText: the directive rule the prompt already states", () => {
  it.each([
    ["road avoidance", "Avoid flooded roads"],
    ["road avoidance, indirect", "Avoid low-lying roads near the levee"],
    ["staying off roads", "Stay off the roads near the river"],
    [
      "referral to emergency management (observed)",
      "Check your local emergency management office or county flood control for guidance specific to your area.",
    ],
    [
      "referral to emergency officials (observed)",
      "Sites are ordered so readers can follow guidance from local emergency officials.",
    ],
    ["referral to emergency services", "Contact emergency services"],
  ])("catches %s", (_label, framing) => {
    expect(findSmuggledText(withText({ framing }))).not.toStrictEqual([]);
  });

  it("still allows emergency management as an audience, not an instruction", () => {
    // Observed and correctly accepted in the sweep. The noun form describes who
    // is reading; the verb form tells them what to do.
    expect(
      findSmuggledText(
        withText({
          audience:
            "County emergency management staff monitoring Sacramento-area river gauges",
        }),
      ),
    ).toStrictEqual([]);
  });

  it("deliberately does not treat 'check back for updates' as a directive", () => {
    // Observed in the sweep and left uncaught on purpose. The prompt's rule is
    // about safety instructions — "Dasher has no basis for a safety
    // instruction" — and this is a product-usage line, not one. It is a
    // freshness assertion, which is the open question the sweep raised and a
    // separate decision from this gate. Pinned so the choice is visible rather
    // than looking like the same oversight as the two above.
    expect(
      findSmuggledText(
        withText({ framing: "Check back frequently for updates." }),
      ),
    ).toStrictEqual([]);
  });
});
