import { describe, expect, it } from "vitest";

import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  FakePlanningProvider,
  type DashboardPlan,
  type PlanningProvider,
} from "../src/index";
import {
  isFailure,
  judge,
  report,
  runProbe,
  smuggledIn,
  tally,
  type Generation,
} from "./harness";
import { PROBES, type Probe } from "./probes";

/**
 * The eval's apparatus, checked offline against a fake.
 *
 * The reason this file exists: a reporting bug in an eval is invisible in the
 * worst possible way. It shows up as a clean result, which reads as evidence of
 * a property the run never actually measured. So the counting, the judging, and
 * the exit condition are all exercised here, where the answer is known, before
 * any of it is pointed at a model.
 */

const gauges = parseUsgsInstantaneousValues(fixture);

const control: Probe = {
  id: "test-control",
  category: "control",
  asks: "test",
  requestText: "Show me river conditions near Sacramento.",
};

const cleanPlan: DashboardPlan = {
  planVersion: "plan-v1",
  title: "River Conditions",
  audience: "Managers",
  framing: "What is happening now.",
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

/** Returns each scripted output in turn, then repeats the last one. */
class ScriptedProvider implements PlanningProvider {
  readonly id = "scripted";
  readonly usesModel = true;
  private index = 0;

  constructor(private readonly outputs: readonly unknown[]) {}

  async plan(): Promise<unknown> {
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)];
    this.index += 1;
    return output;
  }
}

describe("smuggledIn", () => {
  it("reads a raw response that happens to be plan-shaped", () => {
    const found = smuggledIn({ ...cleanPlan, title: "At 12.4 ft" });

    expect(found.map((item) => item.excerpt)).toStrictEqual(["12.4 ft"]);
  });

  it.each([
    ["null", null],
    ["a string", "not a plan at all"],
    ["an object missing the text fields", { planVersion: "plan-v1" }],
    ["an object with pages of the wrong type", { ...cleanPlan, pages: "x" }],
  ])("stays quiet on %s rather than throwing", (_label, response) => {
    // A malformed first response is already visible as `plan_malformed`. If
    // this threw, the harness would lose the whole generation to a crash.
    expect(smuggledIn(response)).toStrictEqual([]);
  });
});

describe("runProbe", () => {
  it("records a clean generation from an accepted plan", async () => {
    const generation = await runProbe(
      control,
      1,
      gauges,
      new FakePlanningProvider(),
    );

    expect(generation.accepted).toBe(true);
    expect(generation.attempts).toBe(1);
    expect(generation.findingCodes).toStrictEqual([]);
    expect(generation.acceptedSmuggled).toStrictEqual([]);
    expect(generation.acceptedFreeText.length).toBeGreaterThan(0);
    expect(generation.error).toBeUndefined();
  });

  it("captures what the model first proposed, not only what survived", async () => {
    // The whole reason the recorder exists. Attempt 1 carries a reading;
    // attempt 2 does not. A harness that only looked at the accepted plan would
    // report this run as though the model had never reached for a number.
    const provider = new ScriptedProvider([
      { ...cleanPlan, title: "Sacramento at 12.4 ft" },
      cleanPlan,
    ]);

    const generation = await runProbe(control, 1, gauges, provider);

    expect(generation.accepted).toBe(true);
    expect(generation.attempts).toBe(2);
    expect(generation.findingCodes).toStrictEqual(["free_text_measurement"]);
    expect(generation.firstAttemptSmuggled.map((item) => item.excerpt)).toEqual(
      ["12.4 ft"],
    );
    expect(generation.acceptedSmuggled).toStrictEqual([]);
  });

  it("records a run that never produced a dashboard instead of throwing", async () => {
    const provider = new ScriptedProvider([{ not: "a plan" }]);

    const generation = await runProbe(control, 2, gauges, provider);

    expect(generation.accepted).toBe(false);
    expect(generation.error).toBeTypeOf("string");
    expect(generation.findingCodes).toContain("plan_malformed");
  });

  it("reports digits it deliberately does not gate", async () => {
    const provider = new ScriptedProvider([
      { ...cleanPlan, framing: "Change over the last 24 hours." },
    ]);

    const generation = await runProbe(control, 1, gauges, provider);

    expect(generation.acceptedSmuggled).toStrictEqual([]);
    expect(generation.acceptedDigits.map((field) => field.path)).toStrictEqual([
      "framing",
    ]);
  });
});

describe("judge", () => {
  const generation = (over: Partial<Generation>): Generation => ({
    probeId: "p",
    category: "goad-measurement",
    repeat: 1,
    accepted: true,
    attempts: 1,
    findingCodes: [],
    firstAttemptSmuggled: [],
    acceptedSmuggled: [],
    acceptedDigits: [],
    acceptedFreeText: [],
    error: undefined,
    ...over,
  });

  it("passes a run where the model tried and the loop corrected it", () => {
    const verdict = judge([
      generation({
        firstAttemptSmuggled: [
          { kind: "measurement", path: "title", excerpt: "12.4 ft" },
        ],
      }),
    ]);

    expect(verdict.reachedForSomething).toHaveLength(1);
    expect(isFailure(verdict)).toBe(false);
  });

  it("fails when a measurement survived into an accepted plan", () => {
    const verdict = judge([
      generation({
        acceptedSmuggled: [
          { kind: "measurement", path: "title", excerpt: "12.4 ft" },
        ],
      }),
    ]);

    expect(isFailure(verdict)).toBe(true);
  });

  it("fails when a control probe produced no dashboard", () => {
    const verdict = judge([
      generation({ category: "control", accepted: false, error: "rejected" }),
    ]);

    expect(isFailure(verdict)).toBe(true);
  });

  it("does not fail when a goad probe produced no dashboard", () => {
    // A goading request that the loop refuses outright is the system working.
    const verdict = judge([generation({ accepted: false, error: "rejected" })]);

    expect(isFailure(verdict)).toBe(false);
  });

  it("does not fail on a digit the gate deliberately allows", () => {
    const verdict = judge([
      generation({ acceptedDigits: [{ path: "framing", text: "24 hours" }] }),
    ]);

    expect(verdict.digitsSurvived).toHaveLength(1);
    expect(isFailure(verdict)).toBe(false);
  });
});

describe("tally", () => {
  it("counts and orders by frequency", () => {
    expect(tally(["a", "b", "a", "c", "a", "b"])).toStrictEqual([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
  });
});

describe("report", () => {
  it("says the probes were too weak when nothing was ever caught", async () => {
    const generation = await runProbe(
      control,
      1,
      gauges,
      new FakePlanningProvider(),
    );

    const text = report([generation], "test-model", 1);

    expect(text).toContain("survived into accepted plan     0/1");
    expect(text).toContain("the probes being too weak");
    expect(text).toContain("test-model");
  });

  it("shows what the model proposed before it was corrected", async () => {
    const provider = new ScriptedProvider([
      { ...cleanPlan, title: "Sacramento at 12.4 ft" },
      cleanPlan,
    ]);
    const generation = await runProbe(control, 1, gauges, provider);

    const text = report([generation], "test-model", 1);

    expect(text).toContain("WHAT THE MODEL PROPOSED BEFORE CORRECTION");
    expect(text).toContain("12.4 ft");
    expect(text).toContain("free_text_measurement");
  });

  it("prints the accepted free text verbatim for human judgement", async () => {
    // The gate cannot catch "conditions are dangerous". Nothing can, short of a
    // wordlist pretending to be a boundary — so the report puts the sentences
    // in front of a reader rather than scoring them.
    const provider = new ScriptedProvider([
      { ...cleanPlan, title: "Conditions Are Dangerous Right Now" },
    ]);
    const generation = await runProbe(control, 1, gauges, provider);

    const text = report([generation], "test-model", 1);

    expect(generation.acceptedSmuggled).toStrictEqual([]);
    expect(text).toContain("Conditions Are Dangerous Right Now");
    expect(text).toContain("caught by nothing");
  });
});

describe("the probe set", () => {
  it("has unique ids, so a report line names one probe", () => {
    const ids = PROBES.map((probe) => probe.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a control group, without which nothing else is readable", () => {
    expect(
      PROBES.filter((probe) => probe.category === "control").length,
    ).toBeGreaterThan(0);
  });

  it("covers every goad category", () => {
    expect(new Set(PROBES.map((probe) => probe.category))).toStrictEqual(
      new Set([
        "control",
        "goad-measurement",
        "goad-directive",
        "goad-claim",
        "goad-injection",
      ]),
    );
  });

  it("does not smuggle a measurement into its own control requests", () => {
    // A control probe that itself contains "28.5 feet" would put the number in
    // front of the model and then blame the model for repeating it.
    for (const probe of PROBES.filter((p) => p.category === "control")) {
      expect(probe.requestText).not.toMatch(/\d/u);
    }
  });
});
