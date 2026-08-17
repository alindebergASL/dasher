// @vitest-environment node
import { describe, expect, it } from "vitest";

import { planDashboard, refineDashboard } from "./actions";
import {
  DEFAULT_REQUEST,
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
} from "./planning";

/**
 * The server-action boundary.
 *
 * A server action is a public endpoint: anything that can reach the page can
 * call it with anything. The refinement path is the first one here that accepts
 * a structured argument rather than a string — the previous plan, handed back
 * by the browser — so it is the first one where "the client sent it" could be
 * mistaken for "it is valid".
 */

async function firstPlan() {
  const result = await planDashboard(DEFAULT_REQUEST);
  if (!result.ok || !result.plan) throw new Error("expected a plan");
  return result.plan;
}

describe("planDashboard", () => {
  it("returns the plan alongside the dashboard, so a change can be applied", async () => {
    const result = await planDashboard(DEFAULT_REQUEST);

    expect(result.ok).toBe(true);
    expect(result.plan?.planVersion).toBe("plan-v1");
    expect(result.dashboard?.schemaVersion).toBe("1.1");
  });

  it.each([
    ["empty", "   "],
    ["over the length limit", "x".repeat(REQUEST_MAX_LENGTH + 1)],
  ])("refuses a request that is %s", async (_label, text) => {
    const result = await planDashboard(text);

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
  });
});

describe("refineDashboard", () => {
  it("applies a change to the plan it was given", async () => {
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, "Drop the map", plan);

    expect(result.ok).toBe(true);
    expect(result.plan?.pages.flatMap((page) => page.sections)).not.toContain(
      "gauge-map",
    );
    expect(
      result.dashboard?.pages.flatMap((page) => page.components),
    ).not.toContainEqual(expect.objectContaining({ kind: "gauge-map" }));
  });

  it("says so when it could not interpret the change", async () => {
    const plan = await firstPlan();

    const result = await refineDashboard(
      DEFAULT_REQUEST,
      "Make it feel more optimistic",
      plan,
    );

    expect(result.ok).toBe(true);
    expect(result.refinement).toBe("not-understood");
  });

  it("reports nothing when something actually changed", async () => {
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, "Drop the map", plan);

    expect(result.refinement).toBeUndefined();
  });

  it("does not call an understood-but-already-true change a failure", async () => {
    // The shipped suggestion chip, on the dashboard it ships with. The plan
    // comes back identical because the chart is already there — telling the
    // reader Dasher did not understand would be false, and it is the first
    // thing a new visitor sees.
    const plan = await firstPlan();
    const sections = (
      plan as { pages: { sections: string[] }[] }
    ).pages.flatMap((page) => page.sections);
    expect(sections).toContain("stage-trends");

    const result = await refineDashboard(
      DEFAULT_REQUEST,
      "Add the history chart",
      plan,
    );

    expect(result.ok).toBe(true);
    expect(result.refinement).toBe("already-satisfied");
  });

  it.each([
    ["empty", "   "],
    ["over the length limit", "x".repeat(REFINEMENT_MAX_LENGTH + 1)],
  ])("refuses an instruction that is %s", async (_label, instruction) => {
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, instruction, plan);

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
  });
});

describe("the previous plan is parsed, not trusted", () => {
  it.each([
    ["null", null],
    ["a string", "not a plan"],
    ["an object of the wrong shape", { pages: [] }],
    [
      "a plan with an unknown section",
      {
        planVersion: "plan-v1",
        title: "t",
        audience: "a",
        framing: "f",
        siteIds: ["11446500"],
        pages: [
          {
            id: "p",
            title: "P",
            description: "D",
            sections: ["flood-probability-model"],
          },
        ],
      },
    ],
  ])(
    "refuses %s rather than planning from it",
    async (_label, previousPlan) => {
      const result = await refineDashboard(
        DEFAULT_REQUEST,
        "Drop the map",
        previousPlan,
      );

      expect(result.ok).toBe(false);
      expect(result.dashboard).toBeUndefined();
    },
  );

  it("rejects a smuggled measurement even from a plan it accepted before", async () => {
    // The realistic attack on this endpoint: take a plan the server issued,
    // edit one string, hand it back. The schema accepts the shape — every field
    // is a legal string — and the free-text gate is what refuses it.
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, "Drop the map", {
      ...plan,
      title: "Sacramento at 12.4 ft",
    });

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
    expect(result.plan).toBeUndefined();
    // The error quotes the offending text back, which is the right thing: it
    // tells the reader what was refused. What must not exist is a dashboard
    // carrying it, and there is none — nothing rendered.
    expect(result.error).toContain("may not carry a measurement");
  });

  it("computes its own numbers regardless of the plan handed back", async () => {
    const plan = await firstPlan();
    const untouched = await refineDashboard(
      DEFAULT_REQUEST,
      "Drop the map",
      plan,
    );
    const relabelled = await refineDashboard(DEFAULT_REQUEST, "Drop the map", {
      ...plan,
      title: "Everything Is Fine",
      framing: "All calm.",
    });

    const readings = (result: typeof untouched) =>
      result.dashboard?.pages
        .flatMap((page) => page.components)
        .filter((component) => component.kind === "gauge-table")
        .flatMap((component) =>
          component.kind === "gauge-table" ? component.gauges : [],
        )
        .map((gauge) => [gauge.id, gauge.stage, gauge.direction]);

    expect(readings(relabelled)).toStrictEqual(readings(untouched));
    expect(relabelled.dashboard?.title).toBe("Everything Is Fine");
  });
});
