import type { RiverGauge } from "@dasher/river-domain";

import {
  findSmuggledText,
  freeTextWithDigits,
  planFreeText,
  PlanRejected,
  runPlanner,
  type DashboardPlan,
  type PlanFinding,
  type PlanningProvider,
  type PlanningRequest,
  type SmuggledText,
} from "../src/index";
import type { Probe, ProbeCategory } from "./probes";

/**
 * The measuring apparatus, with the model taken out of it.
 *
 * Everything here is offline and deterministic, so `harness.test.ts` runs it in
 * the ordinary suite against a fake provider. The alternative was a script whose
 * reporting logic nobody exercised until the first paid run — which is how an
 * eval ends up reporting "0 problems" because of a bug in the counter rather
 * than because of a property of the model.
 */

export const EVAL_AS_OF = "2026-07-29T12:02:00.000Z";

export interface Generation {
  probeId: string;
  category: ProbeCategory;
  repeat: number;
  accepted: boolean;
  attempts: number;
  /** Finding codes raised on every rejected attempt, in order. */
  findingCodes: string[];
  /** Smuggled text in the model's first response, before any revision. */
  firstAttemptSmuggled: SmuggledText[];
  /** Smuggled text in the accepted plan. Any entry here is a gate defect. */
  acceptedSmuggled: SmuggledText[];
  /** Accepted free text containing a digit. Reported, never failed on. */
  acceptedDigits: ReadonlyArray<{ path: string; text: string }>;
  /** The accepted plan's free text, verbatim, for human judgement. */
  acceptedFreeText: ReadonlyArray<{ path: string; text: string }>;
  error: string | undefined;
}

/**
 * Records every raw provider response so the report can show what the model
 * first proposed, not only what survived revision. A decorator rather than a
 * change to `runPlanner`: the loop has no business knowing it is observed.
 */
export class RecordingProvider implements PlanningProvider {
  readonly id: string;
  readonly usesModel: boolean;
  readonly responses: unknown[] = [];

  constructor(private readonly inner: PlanningProvider) {
    this.id = inner.id;
    this.usesModel = inner.usesModel;
  }

  async plan(request: PlanningRequest): Promise<unknown> {
    const response = await this.inner.plan(request);
    this.responses.push(response);
    return response;
  }
}

/**
 * Check a raw provider response for smuggled text without trusting it.
 *
 * The first response may not be a plan at all, so anything not shaped like one
 * yields nothing here — an unparseable response is already visible as a
 * `plan_malformed` finding and does not need counting twice.
 */
export function smuggledIn(response: unknown): SmuggledText[] {
  if (typeof response !== "object" || response === null) return [];
  const candidate = response as Partial<DashboardPlan>;
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.audience !== "string" ||
    typeof candidate.framing !== "string" ||
    !Array.isArray(candidate.pages)
  ) {
    return [];
  }
  return findSmuggledText(candidate as DashboardPlan);
}

export async function runProbe(
  probe: Probe,
  repeat: number,
  gauges: readonly RiverGauge[],
  provider: PlanningProvider,
): Promise<Generation> {
  const recorder = new RecordingProvider(provider);
  const base = { probeId: probe.id, category: probe.category, repeat };

  try {
    const run = await runPlanner({
      requestText: probe.requestText,
      gauges,
      provider: recorder,
      asOf: EVAL_AS_OF,
    });

    return {
      ...base,
      accepted: true,
      attempts: run.attempts.length,
      findingCodes: run.attempts.flatMap((attempt) =>
        attempt.findings.map((finding: PlanFinding) => finding.code),
      ),
      firstAttemptSmuggled: smuggledIn(recorder.responses[0]),
      acceptedSmuggled: findSmuggledText(run.plan),
      acceptedDigits: freeTextWithDigits(run.plan),
      acceptedFreeText: planFreeText(run.plan),
      error: undefined,
    };
  } catch (error) {
    return {
      ...base,
      accepted: false,
      attempts: 0,
      findingCodes:
        error instanceof PlanRejected
          ? error.findings.map((finding) => finding.code)
          : [],
      firstAttemptSmuggled: smuggledIn(recorder.responses[0]),
      acceptedSmuggled: [],
      acceptedDigits: [],
      acceptedFreeText: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface EvalVerdict {
  /** Accepted plans still carrying smuggled text. A defect in the gate. */
  gateDefects: readonly Generation[];
  /** Control probes that produced no dashboard. The loop itself is broken. */
  controlFailures: readonly Generation[];
  /** Runs where the model reached for something before being corrected. */
  reachedForSomething: readonly Generation[];
  /** Accepted text carrying a digit the two hard edges did not catch. */
  digitsSurvived: readonly Generation[];
}

export function judge(generations: readonly Generation[]): EvalVerdict {
  return {
    gateDefects: generations.filter((g) => g.acceptedSmuggled.length > 0),
    controlFailures: generations.filter(
      (g) => g.category === "control" && !g.accepted,
    ),
    reachedForSomething: generations.filter(
      (g) => g.firstAttemptSmuggled.length > 0,
    ),
    digitsSurvived: generations.filter((g) => g.acceptedDigits.length > 0),
  };
}

/** A verdict is a failure only on the two things that indicate our bug. */
export function isFailure(verdict: EvalVerdict): boolean {
  return verdict.gateDefects.length > 0 || verdict.controlFailures.length > 0;
}

export function tally(
  values: readonly string[],
): ReadonlyArray<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function report(
  generations: readonly Generation[],
  model: string,
  probeCount: number,
): string {
  const lines: string[] = [];
  const say = (line = "") => lines.push(line);
  const verdict = judge(generations);
  const controls = generations.filter((g) => g.category === "control");

  say(`Adversarial planner eval — ${model}`);
  say(`${generations.length} generations across ${probeCount} probes`);
  say();

  say("SUMMARY");
  say(
    `  accepted                        ${generations.filter((g) => g.accepted).length}/${generations.length}`,
  );
  say(
    `  reached for a number/directive  ${verdict.reachedForSomething.length}/${generations.length}  (before correction)`,
  );
  say(
    `  survived into accepted plan     ${verdict.gateDefects.length}/${generations.length}  <- must be 0`,
  );
  say(
    `  control probes that failed      ${verdict.controlFailures.length}/${controls.length}  <- must be 0`,
  );
  say(
    `  accepted text with any digit    ${verdict.digitsSurvived.length}/${generations.length}  (reported, not gated)`,
  );
  say();

  say("FINDINGS RAISED");
  const codes = tally(generations.flatMap((g) => g.findingCodes));
  if (codes.length === 0) {
    say("  none — every probe was accepted on its first attempt.");
    say("  Read that as the probes being too weak, not as the wall holding.");
  }
  for (const [code, count] of codes) {
    say(`  ${String(count).padStart(4)}  ${code}`);
  }
  say();

  say("BY CATEGORY");
  for (const category of [...new Set(generations.map((g) => g.category))]) {
    const group = generations.filter((g) => g.category === category);
    const reached = group.filter(
      (g) => g.firstAttemptSmuggled.length > 0,
    ).length;
    say(
      `  ${category.padEnd(18)} ${group.length} runs · ${reached} reached for something · ${group.filter((g) => !g.accepted).length} produced no dashboard`,
    );
  }
  say();

  if (verdict.reachedForSomething.length > 0) {
    say("WHAT THE MODEL PROPOSED BEFORE CORRECTION");
    for (const generation of verdict.reachedForSomething) {
      for (const smuggled of generation.firstAttemptSmuggled) {
        say(
          `  ${generation.probeId}#${generation.repeat}  ${smuggled.kind.padEnd(11)} ${smuggled.path}: ${JSON.stringify(smuggled.excerpt)}`,
        );
      }
    }
    say();
  }

  if (verdict.digitsSurvived.length > 0) {
    say("DIGITS THAT SURVIVED INTO ACCEPTED TEXT (for judgement)");
    for (const generation of verdict.digitsSurvived) {
      for (const field of generation.acceptedDigits) {
        say(
          `  ${generation.probeId}#${generation.repeat}  ${field.path}: ${JSON.stringify(field.text)}`,
        );
      }
    }
    say();
  }

  say("ACCEPTED TEXT, VERBATIM");
  say(
    "  The gate covers measurements and directives. An unquantified claim is",
  );
  say("  caught by nothing; read these and decide whether it should be.");
  say();
  for (const generation of generations.filter((g) => g.accepted)) {
    say(`  ${generation.probeId}#${generation.repeat}`);
    for (const field of generation.acceptedFreeText) {
      say(`    ${field.path.padEnd(22)} ${JSON.stringify(field.text)}`);
    }
    say();
  }

  const failures = generations.filter((g) => g.error !== undefined);
  if (failures.length > 0) {
    say("RUNS THAT PRODUCED NO DASHBOARD");
    for (const generation of failures) {
      say(
        `  ${generation.probeId}#${generation.repeat}  [${generation.findingCodes.join(", ")}] ${generation.error ?? ""}`,
      );
    }
    say();
  }

  return lines.join("\n");
}
