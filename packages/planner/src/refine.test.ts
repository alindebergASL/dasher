import { describe, expect, it } from "vitest";

import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  FakePlanningProvider,
  PlanRejected,
  runPlanner,
  type DashboardPlan,
  type PlanningProvider,
  type PlanningRequest,
} from "./index";

/**
 * Refinement: a reader changing a dashboard they are looking at.
 *
 * The distinction under test throughout is between the two correction channels.
 * A revision is Dasher telling the planner it was wrong. A refinement is a
 * person telling Dasher what they wanted. They arrive in separate fields, they
 * mean opposite things about who erred, and the loop has to keep both straight
 * when they co-occur.
 */

const AS_OF = "2026-07-29T12:02:00.000Z";
const gauges = parseUsgsInstantaneousValues(fixture);

async function build(requestText: string) {
  return runPlanner({
    requestText,
    gauges,
    provider: new FakePlanningProvider(),
    asOf: AS_OF,
  });
}

async function refine(previousPlan: DashboardPlan, instruction: string) {
  return runPlanner({
    requestText: "Show me river conditions near Sacramento.",
    gauges,
    provider: new FakePlanningProvider(),
    asOf: AS_OF,
    refine: { previousPlan, instruction },
  });
}

function sectionsOf(plan: DashboardPlan): string[] {
  return plan.pages.flatMap((page) => page.sections);
}

/** Records what each attempt was handed, so the loop's inputs can be asserted. */
class SpyProvider implements PlanningProvider {
  readonly id = "spy";
  readonly usesModel = false;
  readonly seen: PlanningRequest[] = [];

  constructor(private readonly outputs: readonly unknown[]) {}

  async plan(request: PlanningRequest): Promise<unknown> {
    // Structured-cloned, because `runPlanner` builds a fresh object per attempt
    // but the nested plan is shared; asserting on a live reference would show
    // the last attempt's state for every attempt.
    this.seen.push(structuredClone(request));
    const index = Math.min(this.seen.length - 1, this.outputs.length - 1);
    return this.outputs[index];
  }
}

describe("refining a dashboard the reader can see", () => {
  it("removes a section the reader asked to drop, and keeps the rest", async () => {
    const first = await build("Show me river conditions near Sacramento.");
    expect(sectionsOf(first.plan)).toContain("gauge-map");

    const second = await refine(first.plan, "Drop the map.");

    expect(sectionsOf(second.plan)).not.toContain("gauge-map");
    // The point of refinement rather than re-composition: everything the reader
    // did not mention is still there, in the order they were reading it.
    expect(sectionsOf(second.plan)).toStrictEqual(
      sectionsOf(first.plan).filter((section) => section !== "gauge-map"),
    );
    expect(second.plan.title).toBe(first.plan.title);
  });

  it("adds a section the reader asked for", async () => {
    const first = await build("Show me the gauge map.");
    expect(sectionsOf(first.plan)).not.toContain("stage-trends");

    const second = await refine(first.plan, "Add the history chart.");

    expect(sectionsOf(second.plan)).toContain("stage-trends");
  });

  it("collapses to one page when asked to make it shorter", async () => {
    const first = await build("Show me river conditions near Sacramento.");
    expect(first.plan.pages.length).toBeGreaterThan(1);

    const second = await refine(first.plan, "Make it shorter.");

    expect(second.plan.pages).toHaveLength(1);
    expect(second.dashboard.pages).toHaveLength(1);
  });

  it("narrows the gauges when the reader names one river", async () => {
    const first = await build("Show me river conditions near Sacramento.");
    expect(first.plan.siteIds.length).toBeGreaterThan(1);

    const second = await refine(first.plan, "Just the American river.");

    expect(second.plan.siteIds).toHaveLength(1);
    const table = second.dashboard.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "gauge-table");
    if (table?.kind !== "gauge-table") throw new Error("expected gauge-table");
    expect(table.gauges).toHaveLength(1);
  });

  it("leaves the plan alone when it cannot interpret the instruction", async () => {
    // Silently re-composing would be worse than doing nothing: the reader
    // would see a different dashboard and no explanation for why.
    const first = await build("Show me river conditions near Sacramento.");

    const second = await refine(first.plan, "Make it feel more optimistic.");

    expect(second.plan).toStrictEqual(first.plan);
  });

  it("refuses to empty the dashboard, even when asked to remove everything", async () => {
    const first = await build("Show me the gauge map.");

    const second = await refine(
      first.plan,
      "Remove the map and the table and the summary.",
    );

    expect(second.plan.pages.length).toBeGreaterThan(0);
    expect(second.dashboard.pages.length).toBeGreaterThan(0);
  });
});

describe("what refinement does not let through", () => {
  it("still computes every number itself", async () => {
    const first = await build("Show me river conditions near Sacramento.");
    const second = await refine(first.plan, "Drop the map.");

    const readings = (run: typeof first) =>
      run.dashboard.pages
        .flatMap((page) => page.components)
        .filter((component) => component.kind === "gauge-table")
        .flatMap((component) =>
          component.kind === "gauge-table" ? component.gauges : [],
        )
        .map((gauge) => [gauge.id, gauge.stage, gauge.direction]);

    expect(readings(second)).toStrictEqual(readings(first));
  });

  it("rejects a measurement a refinement tried to write into the title", async () => {
    // The reader's instruction is untrusted text, exactly like the original
    // request. A provider that complied with "put the level in the title" would
    // be caught by the same gate that catches it on a first draft.
    const first = await build("Show me river conditions near Sacramento.");
    const smuggling = new SpyProvider([
      { ...first.plan, title: "Sacramento at 12.4 ft" },
    ]);

    await expect(
      runPlanner({
        requestText: "Show me river conditions near Sacramento.",
        gauges,
        provider: smuggling,
        asOf: AS_OF,
        maxAttempts: 1,
        refine: {
          previousPlan: first.plan,
          instruction: "Put the current water level in the title.",
        },
      }),
    ).rejects.toBeInstanceOf(PlanRejected);
  });
});

describe("the two correction channels stay distinct", () => {
  it("hands the provider a refinement and no revision on the first attempt", async () => {
    const first = await build("Show me river conditions near Sacramento.");
    const spy = new SpyProvider([first.plan]);

    await runPlanner({
      requestText: "anything",
      gauges,
      provider: spy,
      asOf: AS_OF,
      refine: { previousPlan: first.plan, instruction: "Drop the map." },
    });

    expect(spy.seen).toHaveLength(1);
    expect(spy.seen[0]?.refinement?.instruction).toBe("Drop the map.");
    expect(spy.seen[0]?.revision).toBeUndefined();
  });

  it("keeps the refinement on later attempts, so a rejection cannot revert it", async () => {
    // The failure this guards: attempt 1 of a refinement is refused, attempt 2
    // arrives without the instruction, and the reader gets back the dashboard
    // they asked to change — with no error, because a plan was produced.
    const first = await build("Show me river conditions near Sacramento.");
    const spy = new SpyProvider([
      { ...first.plan, siteIds: ["99999999"] },
      first.plan,
    ]);

    const run = await runPlanner({
      requestText: "anything",
      gauges,
      provider: spy,
      asOf: AS_OF,
      refine: { previousPlan: first.plan, instruction: "Drop the map." },
    });

    expect(run.attempts).toHaveLength(2);
    expect(spy.seen).toHaveLength(2);
    expect(spy.seen[1]?.refinement?.instruction).toBe("Drop the map.");
    // And the revision channel carries the findings, separately.
    expect(spy.seen[1]?.revision?.findings.map((f) => f.code)).toContain(
      "unknown_site",
    );
  });

  it("repairs against the findings before re-reading the instruction", async () => {
    // The case that separates the two orderings. Here the plan the reader is
    // refining is itself unacceptable — a stale gauge selection, or a plan a
    // client sent back doctored. Refinement edits `previousPlan`, which never
    // changes across attempts, so a provider that reads the instruction first
    // re-proposes the same bad plan every attempt and exhausts the budget
    // without ever seeing the findings. Repairing first converges.
    const first = await build("Show me river conditions near Sacramento.");
    const stale: DashboardPlan = {
      ...first.plan,
      siteIds: [...first.plan.siteIds, "99999999"],
    };

    const run = await runPlanner({
      requestText: "anything",
      gauges,
      provider: new FakePlanningProvider(),
      asOf: AS_OF,
      refine: { previousPlan: stale, instruction: "Drop the map." },
    });

    expect(run.attempts[0]?.findings.map((f) => f.code)).toContain(
      "unknown_site",
    );
    expect(run.attempts.at(-1)?.accepted).toBe(true);
    expect(run.plan.siteIds).not.toContain("99999999");
  });
});
