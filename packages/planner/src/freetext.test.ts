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
