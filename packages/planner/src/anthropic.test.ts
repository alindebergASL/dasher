import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseUsgsInstantaneousValues,
  RIVER_WORDS,
} from "@dasher/river-domain";

import { AIR_WORDS } from "@dasher/air-domain";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { AnthropicPlanningProvider } from "./anthropic";
import { patternFor } from "./registry";
import { PLAN_SECTION_KINDS, type DashboardPlan } from "./plan";
import { runPlanner } from "./run";

/**
 * The provider's wire behaviour, checked against a stub that speaks the
 * Messages API's shape.
 *
 * No credential, no outbound connection, no model. What this proves is the part
 * that would otherwise stay unverified until someone paid for a token and got a
 * 400 back: that the request carries the system prompt and a schema the
 * structured-output subset accepts, that a well-formed response flows through
 * the whole loop into a dashboard, and that a bad response costs an attempt
 * rather than crashing the run.
 *
 * What it does not prove is anything about a model's behaviour. That is what
 * `eval/adversarial.ts` is for, and it needs a real key on purpose.
 */

const gauges = parseUsgsInstantaneousValues(fixture);
const AS_OF = "2026-07-29T12:02:00.000Z";

const plan: DashboardPlan = {
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

interface Stub {
  baseURL: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

/** Serves each body in turn, repeating the last, and records what it was sent. */
async function stubApi(bodies: readonly string[]): Promise<Stub> {
  const requests: Array<Record<string, unknown>> = [];
  let index = 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
      const body = bodies[Math.min(index, bodies.length - 1)] ?? "";
      index += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function messageWith(text: string): string {
  return JSON.stringify({
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

let open: Stub | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function serve(bodies: readonly string[]) {
  open = await stubApi(bodies);
  return open;
}

describe("AnthropicPlanningProvider construction", () => {
  it.each([
    ["an empty key", { words: RIVER_WORDS, apiKey: "  ", model: "m" }],
    ["an empty model", { words: RIVER_WORDS, apiKey: "k", model: " " }],
  ])("refuses %s rather than failing at the first request", (_label, opts) => {
    expect(() => new AnthropicPlanningProvider(opts)).toThrow();
  });

  it("names the model in its id, which reaches the evidence record", () => {
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "some-model-id",
    });

    expect(provider.id).toBe("anthropic:some-model-id");
    expect(provider.usesModel).toBe(true);
  });
});

describe("the request the provider actually sends", () => {
  it("carries the model, the system prompt, and the request text", async () => {
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
      effort: "medium",
    });

    await runPlanner({
      requestText: "Show me the Sacramento gauges.",
      gauges,
      provider,
      asOf: AS_OF,
    });

    const sent = stub.requests[0]!;
    expect(sent.model).toBe("stub-model");
    expect(String(sent.system)).toContain("You are Dasher's dashboard planner");
    expect(JSON.stringify(sent.messages)).toContain(
      "Show me the Sacramento gauges.",
    );
    expect((sent.output_config as { effort?: string }).effort).toBe("medium");
  });

  it("shows the model site labels and never a reading", async () => {
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    await runPlanner({
      requestText: "anything",
      gauges,
      provider,
      asOf: AS_OF,
    });

    const sent = JSON.stringify(stub.requests[0]!.messages);
    expect(sent).toContain(gauges[0]!.siteId);
    expect(sent).toContain(gauges[0]!.group);
    // The observations exist in this process; none of them may be in the body.
    // `AvailableSite` carries identifiers and labels, and the interface is
    // shaped that way because a planner which never sees a reading cannot echo
    // one back as a fact.
    //
    // Asserted as "no decimal number anywhere" rather than reading-by-reading:
    // a site ID is a digit string, so "14" is a substring of 11446500 and a
    // per-reading check would fail on a coincidence instead of on a leak. Every
    // stage and streamflow value in the fixture is decimal, and nothing the
    // provider is entitled to send is.
    expect(sent).not.toMatch(/\d+\.\d+/u);
    for (const key of ["observations", "latitude", "unit", "retrievedAt"]) {
      expect(sent).not.toContain(key);
    }
  });

  it("sends a schema the structured-output subset accepts", async () => {
    // `minLength`, `maxLength`, `pattern`, and `maxItems` are rejected by the
    // API. The SDK demotes them into descriptions; this pins that it did,
    // because the alternative is discovering it as a 400 on a paid call.
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    await provider.plan({ requestText: "x", availableSites: [] });

    const format = (
      stub.requests[0]!.output_config as { format: { schema: unknown } }
    ).format;
    const schema = JSON.stringify(format.schema);

    for (const keyword of ['"minLength"', '"maxLength"', '"pattern"']) {
      expect(schema).not.toContain(keyword);
    }
    expect(schema).toContain('"additionalProperties":false');
    // Derived from `DashboardPlanSchema`, so the two cannot drift apart.
    expect(schema).toContain("planVersion");
    expect(schema).toContain("siteIds");
  });

  it("gives the model each section's purpose, not just its name", async () => {
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    await provider.plan({ requestText: "x", availableSites: [] });

    const system = String(stub.requests[0]!.system);
    for (const kind of PLAN_SECTION_KINDS) {
      // The closed list is restated because the enum is advisory to a model...
      expect(system).toContain(kind);
      // ...and each name carries the registry's guidance, because eight bare
      // names give a planner nothing to choose between. This assertion is the
      // registry's only consumer that a reader would notice: a plan composed
      // from names alone and a plan composed from purposes are different
      // dashboards.
      expect(system).toContain(patternFor(kind).guidance);
    }
  });

  it("hands the findings back verbatim when asking for a revision", async () => {
    const stub = await serve([
      messageWith(JSON.stringify({ ...plan, siteIds: ["99999999"] })),
      messageWith(JSON.stringify(plan)),
    ]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    const run = await runPlanner({
      requestText: "anything",
      gauges,
      provider,
      asOf: AS_OF,
    });

    expect(run.attempts).toHaveLength(2);
    const revision = JSON.stringify(stub.requests[1]!.messages);
    expect(revision).toContain("unknown_site");
    expect(revision).toContain("99999999");
  });
});

describe("what the provider does with a bad response", () => {
  it("turns unparseable output into a spent attempt, not a crash", async () => {
    // A throw here would let a provider abort a run it is not trusted to judge.
    const stub = await serve([
      messageWith("Sure! Here's your dashboard plan:"),
      messageWith(JSON.stringify(plan)),
    ]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    const run = await runPlanner({
      requestText: "anything",
      gauges,
      provider,
      asOf: AS_OF,
    });

    expect(run.attempts[0]?.findings[0]?.code).toBe("plan_malformed");
    expect(run.attempts[1]?.accepted).toBe(true);
  });

  it("catches a measurement the model wrote into the title", async () => {
    const stub = await serve([
      messageWith(JSON.stringify({ ...plan, title: "Sacramento at 12.4 ft" })),
      messageWith(JSON.stringify(plan)),
    ]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    const run = await runPlanner({
      requestText: "anything",
      gauges,
      provider,
      asOf: AS_OF,
    });

    expect(run.attempts[0]?.findings.map((f) => f.code)).toStrictEqual([
      "free_text_measurement",
    ]);
    expect(run.dashboard.title).toBe("River Conditions");
  });
});

describe("what the dashboard says about a model-composed plan", () => {
  it("attributes the layout to a model, because one made it", async () => {
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words: RIVER_WORDS,
      apiKey: "k",
      model: "stub-model",
      baseURL: stub.baseURL,
    });

    const run = await runPlanner({
      requestText: "anything",
      gauges,
      provider,
      asOf: AS_OF,
    });

    expect(run.dashboard.architecture.summary).toContain(
      "A planning model chose",
    );
    expect(
      run.dashboard.architecture.nodes.find((node) => node.id === "planner")
        ?.kind,
    ).toBe("ai");
    expect(
      run.dashboard.evidence.find((item) => item.id === "planner-composition")
        ?.sourceName,
    ).toContain("anthropic:stub-model");
  });
});

describe("the system prompt speaks the domain's words", () => {
  /**
   * The prompt was written when the river was the only domain with a planner,
   * and it said so in literals: "river-conditions dashboard", "USGS
   * observations", "the USGS site IDs". Wiring this provider to the air domain
   * without changing that would have handed a model air monitors and told it
   * they were river gauges.
   *
   * Asserted on what actually goes over the wire, not on the template. A
   * template test would pass while the provider sent a prompt built once at
   * module load from whichever domain constructed first.
   */
  async function systemSentFor(words: typeof RIVER_WORDS): Promise<string> {
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words,
      apiKey: "k",
      model: "m",
      baseURL: stub.baseURL,
    });

    await provider.plan({
      requestText: "Something to plan",
      availableSites: [{ siteId: "1", name: "A place", river: "A grouping" }],
    });

    return String(stub.requests[0]?.["system"] ?? "");
  }

  it("uses the river's nouns and source for the river", async () => {
    const system = await systemSentFor(RIVER_WORDS);

    expect(system).toContain("gauge identifiers");
    expect(system).toContain("available gauges");
    expect(system).toContain("USGS-format observations");
    expect(system).toContain("river gauge readings");
    // Nothing from the domain next door. Note what is NOT asserted: the bare
    // words "gauge" and "monitor" appear in every domain's prompt regardless,
    // because `gauge-map` and `gauge-table` are the plan contract's section
    // names (ADR-007 keeps "gauge" in the plan vocabulary) and `attention`'s
    // registry guidance says "monitoring". Those are shared vocabulary, not
    // leakage. What would be leakage is the other domain's SOURCE.
    expect(system).not.toContain("OpenAQ");
    expect(system).not.toContain("PM2.5");
    expect(system.toLowerCase()).not.toContain("air-quality monitor readings");
  });

  it("uses the air domain's nouns and source for air quality", async () => {
    const system = await systemSentFor(AIR_WORDS);

    expect(system).toContain("monitor identifiers");
    expect(system).toContain("available monitors");
    expect(system).toContain("OpenAQ-format observations");
    expect(system).toContain("air-quality monitor readings");
    // And nothing from the river. "gauge" is exempt for the reason above; a
    // river SOURCE in an air prompt is the thing that would be wrong.
    expect(system).not.toContain("USGS");
    expect(system).not.toContain("water-level");
    expect(system.toLowerCase()).not.toContain("river gauge readings");
  });

  it("names the measurement units of every domain, not just one", async () => {
    // The free-text gate is one list for all domains, so the prompt describing
    // it has to be too. An air unit missing here would be a prompt that quietly
    // permits what the gate then rejects, spending a revision round every time.
    const system = await systemSentFor(RIVER_WORDS);

    for (const unit of ["cfs", "µg/m³", "ppb", "%"]) {
      expect(system).toContain(unit);
    }
    expect(system).toContain("air-quality index");
  });

  it("does not call a station's grouping a river when it is not one", async () => {
    const stub = await serve([messageWith(JSON.stringify(plan))]);
    const provider = new AnthropicPlanningProvider({
      words: AIR_WORDS,
      apiKey: "k",
      model: "m",
      baseURL: stub.baseURL,
    });

    await provider.plan({
      requestText: "Air quality near Sacramento",
      availableSites: [
        { siteId: "678", name: "Sacramento", river: "Sacramento Valley" },
      ],
    });

    const messages = stub.requests[0]?.["messages"] as Array<{
      content: string;
    }>;
    const sent = messages[0]?.content ?? "";

    expect(sent).toContain('"group": "Sacramento Valley"');
    expect(sent).not.toContain('"river"');
  });
});
