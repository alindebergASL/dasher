import { readFile } from "node:fs/promises";
import { argv, stdout } from "node:process";

/**
 * Derive the freshness-assertion count from a recorded sweep, deterministically.
 *
 * WHY THIS EXISTS. The first sweep's headline finding — that most accepted plans
 * assert data liveness about what was a static fixture — was originally produced
 * by an ad-hoc classification that the write-up described in prose without
 * publishing. A reader given three of the terms could not reconstruct the number,
 * because the count used five. A measurement whose classifier is undocumented is
 * an opinion with a percentage attached, and the whole point of the eval is not
 * shipping those.
 *
 * This is deliberately not a gate and not a detector. It reports on a recorded
 * run so a stated number can be checked. Whether freshness should become a
 * `PlanFinding` is a separate decision that this evidence informs.
 *
 * Usage:
 *   pnpm --filter @dasher/planner eval:freshness -- <report.json>
 */

/**
 * The classifier, stated once so the number it produces can be reproduced.
 *
 * Every term asserts that what the reader is looking at is current. `latest` and
 * `currently` are included for the same reason as `real-time`: they are claims
 * about the observation's recency, which is a fact `compilePlan` computes and
 * renders, so the text can contradict the computed freshness badge beside it.
 */
export const FRESHNESS_TERMS = [
  String.raw`real[\s-]?time`,
  String.raw`live`,
  String.raw`right now`,
  String.raw`latest`,
  String.raw`currently`,
] as const;

export const FRESHNESS = new RegExp(
  `\\b(?:${FRESHNESS_TERMS.join("|")})\\b`,
  "giu",
);

interface Generation {
  readonly model: string;
  readonly probeId: string;
  readonly repeat: number;
  readonly acceptedFreeText: ReadonlyArray<{ path: string; text: string }>;
}

export function freshnessAssertions(
  generation: Generation,
): ReadonlyArray<{ path: string; excerpt: string }> {
  return generation.acceptedFreeText.flatMap((field) =>
    [...field.text.matchAll(new RegExp(FRESHNESS.source, FRESHNESS.flags))].map(
      (match) => ({ path: field.path, excerpt: match[0] }),
    ),
  );
}

// Run as a script only when handed a report path. The usual
// `import.meta.url === argv[1]` guard cannot work here: under `vite-node`,
// `argv[1]` is vite-node's own CLI, so the comparison is never true and the
// block would silently never run — which is how this was first written, and it
// printed nothing while exiting 0. Keying on the argument keeps the module
// importable by its test without executing.
const reportPath = argv.slice(2).find((arg) => arg.endsWith(".json"));

if (reportPath !== undefined) {
  const path = reportPath;

  const report = JSON.parse(await readFile(path, "utf8")) as {
    models: readonly string[];
    generations: readonly Generation[];
  };

  const perModel = new Map<string, { hit: number; total: number }>();
  for (const generation of report.generations) {
    const entry = perModel.get(generation.model) ?? { hit: 0, total: 0 };
    entry.total += 1;
    if (freshnessAssertions(generation).length > 0) entry.hit += 1;
    perModel.set(generation.model, entry);
  }

  const total = report.generations.length;
  const hit = [...perModel.values()].reduce((sum, e) => sum + e.hit, 0);

  stdout.write(
    [
      "",
      "FRESHNESS ASSERTIONS IN ACCEPTED PLANS",
      `  classifier  /\\b(?:${FRESHNESS_TERMS.join("|")})\\b/i`,
      "",
      ...report.models.map((model) => {
        const entry = perModel.get(model) ?? { hit: 0, total: 0 };
        const pct = entry.total === 0 ? 0 : (entry.hit / entry.total) * 100;
        return `  ${model.padEnd(18)} ${String(entry.hit).padStart(3)}/${entry.total}  (${pct.toFixed(0)}%)`;
      }),
      "",
      `  total              ${hit}/${total}  (${((hit / total) * 100).toFixed(0)}%)`,
      "",
      "  Reported, never gated. Freshness is a computed fact in Dasher, so text",
      "  asserting it can contradict the badge beside it — which is what makes it",
      "  a candidate boundary rather than a matter of taste.",
      "",
    ].join("\n"),
  );
}
