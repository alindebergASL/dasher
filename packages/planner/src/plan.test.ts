import { describe, expect, it } from "vitest";

import {
  DashboardPlanSchema,
  findPlanProblems,
  PLAN_MAX_PAGES,
  PLAN_MAX_SECTIONS_PER_PAGE,
  PLAN_MAX_SITES,
  PLAN_SECTION_KINDS,
  PLAN_STRING_LIMITS,
  type DashboardPlan,
  type PlanSectionKind,
} from "./plan";

/**
 * The limits of what a planning model is allowed to say.
 *
 * This contract is the boundary, not a detail: it is the only structure a
 * provider may emit, and everything a model could otherwise do to the product
 * has to fit through it. A plan cannot carry a reading because there is nowhere
 * in it to put one — but it can carry a title, an audience, a page count, and a
 * list of gauges, and each of those has a limit that exists for a reason.
 *
 * Limits are asserted at the boundary rather than well inside it. A test that
 * rejects a hundred pages passes just as happily when the cap is four or forty,
 * which is why `plan.ts` sat at 31.75% on the mutation gate while looking
 * covered: `findPlanProblems` was exercised through the run loop, but nothing
 * pinned the numbers. Each case below therefore asserts both that the limit
 * admits what it should and refuses the first thing past it.
 */

const sections = [...PLAN_SECTION_KINDS];

function page(id: string, kinds: readonly PlanSectionKind[] = ["gauge-map"]) {
  return {
    id,
    title: "A page",
    description: "A description.",
    sections: [...kinds],
  };
}

function plan(overrides: Partial<DashboardPlan> = {}): unknown {
  return {
    planVersion: "plan-v1",
    title: "A dashboard",
    audience: "Someone",
    framing: "A framing sentence.",
    siteIds: ["11447650"],
    pages: [page("overview")],
    ...overrides,
  };
}

const accepts = (candidate: unknown) =>
  DashboardPlanSchema.safeParse(candidate).success;

describe("how much a plan may contain", () => {
  it("admits exactly the maximum number of pages and refuses one more", () => {
    const pages = Array.from({ length: PLAN_MAX_PAGES }, (_, index) =>
      page(`page-${index}`),
    );
    expect(accepts(plan({ pages }))).toBe(true);
    expect(accepts(plan({ pages: [...pages, page("one-too-many")] }))).toBe(
      false,
    );
  });

  it("requires at least one page", () => {
    expect(accepts(plan({ pages: [] }))).toBe(false);
  });

  it("admits exactly the maximum sections on a page and refuses one more", () => {
    const within = sections.slice(0, PLAN_MAX_SECTIONS_PER_PAGE);
    expect(accepts(plan({ pages: [page("overview", within)] }))).toBe(true);
    expect(
      accepts(
        plan({
          pages: [
            page("overview", sections.slice(0, PLAN_MAX_SECTIONS_PER_PAGE + 1)),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("requires at least one section on a page", () => {
    expect(accepts(plan({ pages: [page("overview", [])] }))).toBe(false);
  });

  it("admits exactly the maximum number of sites and refuses one more", () => {
    const siteIds = Array.from({ length: PLAN_MAX_SITES }, (_, i) => `s${i}`);
    expect(accepts(plan({ siteIds }))).toBe(true);
    expect(accepts(plan({ siteIds: [...siteIds, "one-too-many"] }))).toBe(
      false,
    );
  });
});

describe("how long a plan's text may be", () => {
  const at = (length: number) => "x".repeat(length);

  it("admits short text at the limit and refuses one character more", () => {
    const limit = PLAN_STRING_LIMITS.shortText;
    expect(accepts(plan({ title: at(limit) }))).toBe(true);
    expect(accepts(plan({ title: at(limit + 1) }))).toBe(false);
    expect(accepts(plan({ audience: at(limit) }))).toBe(true);
    expect(accepts(plan({ audience: at(limit + 1) }))).toBe(false);
  });

  it("admits long text at the limit and refuses one character more", () => {
    const limit = PLAN_STRING_LIMITS.longText;
    expect(accepts(plan({ framing: at(limit) }))).toBe(true);
    expect(accepts(plan({ framing: at(limit + 1) }))).toBe(false);
  });

  it("refuses empty text everywhere it refuses missing text", () => {
    // A blank title is not a shorter title; it is an unlabelled dashboard.
    expect(accepts(plan({ title: "" }))).toBe(false);
    expect(accepts(plan({ audience: "" }))).toBe(false);
    expect(accepts(plan({ framing: "" }))).toBe(false);
  });

  it("admits a page id at the limit and refuses one character more", () => {
    const limit = PLAN_STRING_LIMITS.id;
    expect(accepts(plan({ pages: [page("a".repeat(limit))] }))).toBe(true);
    expect(accepts(plan({ pages: [page("a".repeat(limit + 1))] }))).toBe(false);
  });
});

describe("what a plan identifier may look like", () => {
  it("admits lowercase kebab-case", () => {
    expect(accepts(plan({ pages: [page("gauge-details-2")] }))).toBe(true);
  });

  it("refuses uppercase, underscores, and stray punctuation", () => {
    for (const id of ["Overview", "gauge_details", "gauge details", "-lead"]) {
      expect(accepts(plan({ pages: [page(id)] }))).toBe(false);
    }
  });
});

describe("what version of the contract a plan may claim", () => {
  it("refuses any version but the one this compiler implements", () => {
    // The version is how a future contract change stays safe: an old plan must
    // not be silently accepted by a compiler that means something else by it.
    expect(accepts(plan({ planVersion: "plan-v2" } as never))).toBe(false);
    expect(accepts(plan({ planVersion: "" } as never))).toBe(false);
  });
});

describe("checking a plan against the gauges that exist", () => {
  const known = ["11447650", "11446500"];
  const valid = DashboardPlanSchema.parse(
    plan({ siteIds: known, pages: [page("overview", ["gauge-map"])] }),
  );

  it("finds nothing wrong with a plan that names real, distinct gauges", () => {
    expect(findPlanProblems(valid, known)).toEqual([]);
  });

  it("names the gauge and its position when one does not exist", () => {
    const problems = findPlanProblems(
      { ...valid, siteIds: [known[0]!, "99999999"] },
      known,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: "unknown_site",
      path: "siteIds[1]",
    });
    // The message is fed back to the provider verbatim for a revision pass, so
    // it has to say what is available rather than only what is wrong.
    expect(problems[0]?.message).toContain(known[0]!);
  });

  it("reports a repeated gauge without reporting it as unknown", () => {
    const problems = findPlanProblems(
      { ...valid, siteIds: [known[0]!, known[0]!] },
      known,
    );
    expect(problems.map((problem) => problem.code)).toEqual(["duplicate_site"]);
    expect(problems[0]?.path).toBe("siteIds[1]");
  });

  it("reports that no gauge resolves when none does", () => {
    const problems = findPlanProblems({ ...valid, siteIds: ["nope"] }, known);
    expect(problems.map((problem) => problem.code)).toContain("no_known_sites");
  });

  it("reports a page id used twice", () => {
    const problems = findPlanProblems(
      { ...valid, pages: [page("overview"), page("overview")] },
      known,
    );
    expect(problems.map((problem) => problem.code)).toContain(
      "duplicate_page_id",
    );
    expect(
      problems.find((problem) => problem.code === "duplicate_page_id")?.path,
    ).toBe("pages[1].id");
  });

  it("reports a section repeated on a later page, not only within one", () => {
    // Sections are unique across the whole plan, not per page: the same
    // component twice is a duplicate wherever it lands.
    const problems = findPlanProblems(
      {
        ...valid,
        pages: [page("one", ["gauge-map"]), page("two", ["gauge-map"])],
      },
      known,
    );
    const duplicates = problems.filter(
      (problem) => problem.code === "duplicate_section",
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.path).toBe("pages[1].sections[0]");
  });

  it("reports only the sections that actually need a gauge", () => {
    const problems = findPlanProblems(
      {
        ...valid,
        siteIds: ["nope"],
        pages: [page("one", ["conditions-summary", "gauge-map"])],
      },
      known,
    );
    const needing = problems.filter(
      (problem) => problem.code === "section_needs_sites",
    );
    expect(needing).toHaveLength(1);
    expect(needing[0]?.path).toBe("pages[0].sections[1]");
  });

  it("does not complain about gauge-dependent sections when a gauge resolves", () => {
    const problems = findPlanProblems(
      { ...valid, pages: [page("one", ["gauge-map"])] },
      known,
    );
    expect(
      problems.filter((problem) => problem.code === "section_needs_sites"),
    ).toEqual([]);
  });
});
