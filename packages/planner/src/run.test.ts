import { describe, expect, it } from "vitest";

import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  DashboardPlanSchema,
  FakePlanningProvider,
  PlanRejected,
  runPlanner,
  type DashboardPlan,
  type PlanningProvider,
} from "./index";

const AS_OF = "2026-07-29T12:02:00.000Z";
const gauges = parseUsgsInstantaneousValues(fixture);

function run(
  requestText: string,
  provider: PlanningProvider = new FakePlanningProvider(),
) {
  return runPlanner({ requestText, gauges, provider, asOf: AS_OF });
}

/** A provider that returns whatever it is handed, for adversarial cases. */
class ScriptedProvider implements PlanningProvider {
  readonly id = "scripted-test-provider";
  readonly usesModel = false;
  private index = 0;

  constructor(private readonly outputs: readonly unknown[]) {}

  async plan(): Promise<unknown> {
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)];
    this.index += 1;
    return output;
  }
}

const validPlan: DashboardPlan = {
  planVersion: "plan-v1",
  title: "Test Dashboard",
  audience: "Testers",
  framing: "A framing sentence.",
  siteIds: gauges.map((gauge) => gauge.siteId),
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Everything at once.",
      sections: ["conditions-summary", "gauge-table"],
    },
  ],
};

describe("runPlanner", () => {
  it("turns a plain-language request into a validated dashboard", async () => {
    const result = await run(
      "Create a live dashboard monitoring river gauges near Sacramento.",
    );

    expect(result.dashboard.schemaVersion).toBe("1.1");
    expect(result.dashboard.pages.length).toBeGreaterThan(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.accepted).toBe(true);
  });

  it("composes a different dashboard for a different request", async () => {
    const general = await run("Show me river conditions near Sacramento.");
    const emergency = await run(
      "I need a flood watch view for emergency response.",
    );

    expect(emergency.plan.title).not.toBe(general.plan.title);
    expect(emergency.plan.audience).toBe("Emergency management leads");

    // The emergency framing leads with what needs attention; the general one
    // leads with the summary. Layout is a planner decision, and it moved.
    expect(emergency.dashboard.pages[0]?.components[0]?.kind).toBe(
      "alert-list",
    );
    expect(general.dashboard.pages[0]?.components[0]?.kind).toBe("summary");
  });

  it("selects only the gauges the request names", async () => {
    const result = await run("How is the American river doing?");

    const table = result.dashboard.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "gauge-table");

    expect(table?.kind).toBe("gauge-table");
    if (table?.kind !== "gauge-table") throw new Error("expected gauge-table");
    expect(table.gauges).toHaveLength(1);
    expect(table.gauges[0]?.river.toLowerCase()).toContain("american");
  });

  it("rejects a plan naming an unavailable gauge, then accepts the revision", async () => {
    // The fake planner proposes a Feather River site, which the fixture does
    // not contain. Validation must catch it and the revision must drop it.
    const result = await run(
      "Compare the Sacramento and Feather river gauges.",
    );

    expect(result.attempts.length).toBeGreaterThan(1);
    expect(result.attempts[0]?.accepted).toBe(false);
    expect(result.attempts[0]?.findings.map((f) => f.code)).toContain(
      "unknown_site",
    );
    expect(result.attempts.at(-1)?.accepted).toBe(true);

    // The unavailable site reached neither the accepted plan nor the output.
    expect(result.plan.siteIds).not.toContain("11407000");
    expect(JSON.stringify(result.dashboard)).not.toContain("11407000");
  });

  it("gives up after the attempt budget instead of rendering a bad plan", async () => {
    const alwaysUnknown = new ScriptedProvider([
      { ...validPlan, siteIds: ["99999999"] },
    ]);

    await expect(
      runPlanner({
        requestText: "anything",
        gauges,
        provider: alwaysUnknown,
        asOf: AS_OF,
        maxAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(PlanRejected);
  });

  it("rejects malformed provider output", async () => {
    const garbage = new ScriptedProvider([
      { planVersion: "plan-v1", title: "Missing everything" },
    ]);

    await expect(
      runPlanner({
        requestText: "anything",
        gauges,
        provider: garbage,
        asOf: AS_OF,
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(PlanRejected);
  });

  it("recovers when a malformed first attempt is followed by a valid one", async () => {
    const provider = new ScriptedProvider([{ not: "a plan" }, validPlan]);

    const result = await runPlanner({
      requestText: "anything",
      gauges,
      provider,
      asOf: AS_OF,
      maxAttempts: 2,
    });

    expect(result.attempts[0]?.findings[0]?.code).toBe("plan_malformed");
    expect(result.attempts[1]?.accepted).toBe(true);
  });
});

describe("the plan contract cannot carry a fact", () => {
  it("refuses unknown fields, so a plan cannot smuggle a value", () => {
    const withReading = {
      ...validPlan,
      gaugeReadings: { "11447650": 42.0 },
    };

    expect(DashboardPlanSchema.safeParse(withReading).success).toBe(false);
  });

  it("refuses a section kind Dasher does not implement", () => {
    const withInventedSection = {
      ...validPlan,
      pages: [
        { ...validPlan.pages[0]!, sections: ["flood-probability-model"] },
      ],
    };

    expect(DashboardPlanSchema.safeParse(withInventedSection).success).toBe(
      false,
    );
  });

  it("computes displayed values itself, ignoring anything the plan says", async () => {
    // Two plans differing only in framing must produce identical numbers.
    const first = await runPlanner({
      requestText: "a",
      gauges,
      provider: new ScriptedProvider([validPlan]),
      asOf: AS_OF,
    });
    const second = await runPlanner({
      requestText: "b",
      gauges,
      provider: new ScriptedProvider([
        { ...validPlan, title: "Everything Is Fine", framing: "All calm." },
      ]),
      asOf: AS_OF,
    });

    const readings = (spec: (typeof first)["dashboard"]) =>
      spec.pages
        .flatMap((page) => page.components)
        .filter((component) => component.kind === "gauge-table")
        .flatMap((component) =>
          component.kind === "gauge-table" ? component.gauges : [],
        )
        .map((gauge) => [gauge.id, gauge.stage, gauge.direction]);

    expect(readings(second.dashboard)).toStrictEqual(readings(first.dashboard));
    expect(second.dashboard.title).toBe("Everything Is Fine");
  });

  it("records the planner's role in the evidence, marked interpreted", async () => {
    const result = await run("Show me river conditions.");
    const plannerEvidence = result.dashboard.evidence.find(
      (item) => item.id === "planner-composition",
    );

    expect(plannerEvidence?.kind).toBe("interpreted");
    expect(plannerEvidence?.sourceName).toContain("fake-keyword-planner-v1");
  });

  it("every evidence reference in the output resolves", async () => {
    const result = await run("flood watch for emergency response");
    const ids = new Set(result.dashboard.evidence.map((item) => item.id));

    // parseDashboardSpec enforces this, so a failure here means the compiler
    // produced something the contract would have rejected.
    for (const page of result.dashboard.pages) {
      for (const component of page.components) {
        for (const evidenceId of component.evidenceIds) {
          expect(ids.has(evidenceId)).toBe(true);
        }
      }
    }
    expect(ids.size).toBeGreaterThan(1);
  });
});
