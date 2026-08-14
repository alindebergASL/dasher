import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { argv, env, exit, stdout } from "node:process";

import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import { AnthropicPlanningProvider } from "../src/anthropic";
import { isFailure, judge, report, runProbe, type Generation } from "./harness";
import { PROBES } from "./probes";

/**
 * The adversarial eval: does a real model smuggle a measurement, an
 * instruction, or a claim into the plan's free text, and does the loop repair it
 * when it tries?
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. `pnpm test` is trustworthy because it is
 * deterministic and offline. A live model inside it would make every gate in
 * this repository slow and flaky, and would make a red build ambiguous between
 * "the code broke" and "the model had an off run". Everything that can be
 * checked without a model — the detectors, the harness, the report — is checked
 * in the suite. What is left here is the part that genuinely cannot be faked.
 *
 * WHAT A CLEAN RUN DOES AND DOES NOT PROVE. The gate runs inside `runPlanner`,
 * so an accepted plan carrying a measurement is a defect in the gate, and that
 * is one of the two things this exits non-zero on. It does NOT prove a model
 * never tries. The interesting numbers are how often the model reached for a
 * reading before being corrected, and which digits the two hard edges let
 * through. A run where nothing was ever caught means the probes are too weak.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... DASHER_EVAL_MODEL=... \
 *     pnpm --filter @dasher/planner eval:adversarial -- --repeats 3 --out report.json
 */

interface Options {
  repeats: number;
  out: string | undefined;
  only: string | undefined;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
}

function fail(message: string): never {
  stdout.write(`\nadversarial eval: ${message}\n\n`);
  exit(2);
}

function parseOptions(args: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  const repeats = Number.parseInt(value("--repeats") ?? "3", 10);
  if (!Number.isInteger(repeats) || repeats < 1) {
    fail("--repeats must be a positive integer");
  }

  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  const effort = value("--effort");
  if (effort !== undefined && !efforts.includes(effort as never)) {
    fail(`--effort must be one of: ${efforts.join(", ")}`);
  }

  return {
    repeats,
    out: value("--out"),
    only: value("--probe"),
    effort: effort as Options["effort"],
  };
}

const options = parseOptions(argv.slice(2));

const apiKey = env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  fail(
    "ANTHROPIC_API_KEY is not set.\n" +
      "  This eval calls a real model on purpose. Passing quietly without one\n" +
      "  would be worse than having no eval at all, because a green run would\n" +
      "  look like evidence. Set the key and DASHER_EVAL_MODEL, then re-run.",
  );
}

const model = env.DASHER_EVAL_MODEL;
if (model === undefined || model.trim() === "") {
  fail(
    "DASHER_EVAL_MODEL is not set.\n" +
      "  The model has to be named explicitly: a result that does not record\n" +
      "  which model produced it can be neither reproduced nor compared.",
  );
}

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../../../fixtures/usgs/sacramento-instantaneous-values.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;
const gauges = parseUsgsInstantaneousValues(fixture);

const provider = new AnthropicPlanningProvider({
  apiKey,
  model,
  ...(options.effort === undefined ? {} : { effort: options.effort }),
});

const probes =
  options.only === undefined
    ? PROBES
    : PROBES.filter((probe) => probe.id === options.only);
if (probes.length === 0) {
  fail(`no probe matches --probe ${options.only ?? ""}`);
}

const generations: Generation[] = [];
for (const probe of probes) {
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    stdout.write(`  running ${probe.id} #${repeat}\n`);
    // Sequential on purpose. This measures what the model writes, not how fast
    // it can be made to write it, and a rate-limit error part-way through a
    // parallel fan-out costs more to interpret than the time it saves.
    generations.push(await runProbe(probe, repeat, gauges, provider));
  }
}

stdout.write(`\n${report(generations, model, probes.length)}\n`);

if (options.out !== undefined) {
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(
    options.out,
    `${JSON.stringify({ model, repeats: options.repeats, generations }, null, 2)}\n`,
    "utf8",
  );
  stdout.write(`written to ${options.out}\n`);
}

exit(isFailure(judge(generations)) ? 1 : 0);
