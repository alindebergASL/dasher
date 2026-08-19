/**
 * The acceptance/rejection report, and the one number the spike exists to
 * produce.
 *
 * A report that counted only refusals would measure the easy half. The
 * verifier's rejections are visible, cheap to inspect, and mostly obvious. What
 * decides whether `extracted` can ever be a shippable tier is the opposite
 * cell: candidates the verifier ACCEPTED that are nevertheless factually wrong,
 * because those reach a dashboard looking exactly like correct ones and carry
 * full provenance while doing it.
 *
 * So every case is scored on two independent axes — what the verifier decided,
 * and what the source's own ground truth says — and the four combinations are
 * kept apart:
 *
 *   accepted + correct    the working path
 *   accepted + wrong      FALSE ACCEPTANCE: the finding
 *   refused  + wrong      the check doing its job
 *   refused  + correct    the cost of strictness, and fail-closed refusals
 *
 * That last cell needs care. A refusal of a factually true claim is only
 * "over-strict" when the refusal was about the *lexis*; refusing a true claim
 * whose hash does not match is fail-closed provenance working correctly. The
 * report keeps `intent` alongside so the two never get added together.
 */

import { CORPUS, type CorpusCase, type Intent } from "./corpus";
import { verifyCandidate, type RefusalReason, type Verdict } from "./verify";

/**
 * Why a refusal happened, coarsely. A refused-but-true claim means something
 * completely different depending on this: refusing a true claim whose hash does
 * not match is fail-closed provenance working exactly as designed, while
 * refusing a true claim because the SPAN was untidy is the cost of strictness
 * and a real signal about where normalisation should widen. Adding those two
 * together would report a working guard as an over-strict one.
 */
export type RefusalFamily = "provenance" | "coordinates" | "contract" | "lexis";

const REFUSAL_FAMILY: Readonly<Record<RefusalReason, RefusalFamily>> = {
  "unknown-snapshot": "provenance",
  "snapshot-identity-mismatch": "provenance",
  "hash-mismatch": "provenance",
  "locator-out-of-range": "coordinates",
  "coordinate-text-mismatch": "coordinates",
  "malformed-candidate": "contract",
  "unsupported-normalization": "contract",
  "unsupported-unit-syntax": "lexis",
  "value-not-in-extracted-text": "lexis",
  "unit-not-in-extracted-text": "lexis",
};

export type Outcome =
  | "accepted-and-correct"
  | "accepted-but-wrong"
  | "refused-and-wrong"
  | "refused-though-correct";

export interface ScoredCase {
  readonly case: CorpusCase;
  readonly verdict: Verdict;
  readonly outcome: Outcome;
}

export interface SpikeReport {
  readonly scored: readonly ScoredCase[];
  readonly totals: Readonly<Record<Outcome, number>>;
  readonly byIntent: ReadonlyMap<Intent, Readonly<Record<Outcome, number>>>;
  readonly refusalReasons: ReadonlyMap<RefusalReason, number>;
  readonly accepted: number;
  readonly falselyAccepted: number;
  /**
   * Among everything accepted, the share that is factually wrong.
   *
   * NOT a base rate, and never to be quoted as one. It is a property of how
   * this corpus was composed — it probes seven semantic-error classes on
   * purpose — so it moves whenever a case is added. The number that means
   * something is `semanticClassesProbed` versus `semanticClassesCaught`.
   */
  readonly falseAcceptanceRate: number;
  /** Distinct semantic-error categories the probes cover. */
  readonly semanticClassesProbed: number;
  /** How many of those the verifier refused. Expected to be zero. */
  readonly semanticClassesCaught: number;
  /** Refused-though-true, split by why, so fail-closed is not read as over-strict. */
  readonly strictnessCost: ReadonlyMap<RefusalFamily, number>;
}

function emptyTotals(): Record<Outcome, number> {
  return {
    "accepted-and-correct": 0,
    "accepted-but-wrong": 0,
    "refused-and-wrong": 0,
    "refused-though-correct": 0,
  };
}

function classify(item: CorpusCase, verdict: Verdict): Outcome {
  if (verdict.accepted) {
    return item.factuallyCorrect
      ? "accepted-and-correct"
      : "accepted-but-wrong";
  }
  return item.factuallyCorrect ? "refused-though-correct" : "refused-and-wrong";
}

export function runSpike(corpus: readonly CorpusCase[] = CORPUS): SpikeReport {
  const scored: ScoredCase[] = [];
  const totals = emptyTotals();
  const byIntent = new Map<Intent, Record<Outcome, number>>();
  const refusalReasons = new Map<RefusalReason, number>();

  for (const item of corpus) {
    const verdict = verifyCandidate(item.candidate, {
      ...(item.documentOverrides === undefined
        ? {}
        : { documentOverrides: item.documentOverrides }),
    });
    const outcome = classify(item, verdict);
    scored.push({ case: item, verdict, outcome });

    totals[outcome] += 1;
    const intentTotals = byIntent.get(item.intent) ?? emptyTotals();
    intentTotals[outcome] += 1;
    byIntent.set(item.intent, intentTotals);

    if (!verdict.accepted) {
      refusalReasons.set(
        verdict.reason,
        (refusalReasons.get(verdict.reason) ?? 0) + 1,
      );
    }
  }

  const accepted =
    totals["accepted-and-correct"] + totals["accepted-but-wrong"];
  const falselyAccepted = totals["accepted-but-wrong"];

  const probes = scored.filter(
    (item) => item.case.intent === "false-acceptance-probe",
  );
  const probedClasses = new Set(
    probes.map((item) => item.case.wrongness ?? "unclassified"),
  );
  const caughtClasses = new Set(
    probes
      .filter((item) => !item.verdict.accepted)
      .map((item) => item.case.wrongness ?? "unclassified"),
  );

  const strictnessCost = new Map<RefusalFamily, number>();
  for (const item of scored) {
    if (item.outcome === "refused-though-correct" && !item.verdict.accepted) {
      const family = REFUSAL_FAMILY[item.verdict.reason];
      strictnessCost.set(family, (strictnessCost.get(family) ?? 0) + 1);
    }
  }

  return {
    scored,
    totals,
    byIntent,
    refusalReasons,
    accepted,
    falselyAccepted,
    falseAcceptanceRate: accepted === 0 ? 0 : falselyAccepted / accepted,
    semanticClassesProbed: probedClasses.size,
    semanticClassesCaught: caughtClasses.size,
    strictnessCost,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatReport(report: SpikeReport): string {
  const lines: string[] = [];
  const push = (line = ""): void => void lines.push(line);

  push(
    "ADR-008 coordinate-verification spike — offline, no product integration",
  );
  push("=".repeat(74));
  push();
  push(
    "Every candidate below quotes a real capture already in this repository.",
  );
  push("Coordinates are byte offsets into the sealed bytes.");
  push();
  push("GROUND-TRUTH CUSTODY - three authorities, not one:");
  push("  * fixtures/ucr/campus-facts-2025.meta.json proves the BYTES: source");
  push("    URL, retrieval time, and a sha256 this loader reproduces.");
  push("  * fixtures/ucr/campus-facts-2025.snapshot.json corroborates the");
  push(
    "    enrollment VALUES. It is derived from the same capture, so it is a",
  );
  push("    consistency check rather than an independent source.");
  push("  * subject, section, denominator and fragment semantics are HAND-");
  push("    LABELLED from the retained HTML context. No sidecar asserts them;");
  push("    each carries its justification in the corpus.");
  push(
    "  The OpenAQ capture has NO sidecar: the spike seals whatever bytes are",
  );
  push("  on disk and records the hash it computed.");
  push();

  push("PER CASE");
  push("-".repeat(74));
  for (const scored of report.scored) {
    const verdict = scored.verdict.accepted
      ? "ACCEPTED"
      : `REFUSED(${scored.verdict.reason})`;
    push(`${pad(scored.case.id, 48)} ${verdict}`);
    if (!scored.verdict.accepted) {
      push(`    ${scored.verdict.detail}`);
    }
  }
  push();

  push("OUTCOMES");
  push("-".repeat(74));
  push(
    `  accepted and semantically correct : ${String(report.totals["accepted-and-correct"])}`,
  );
  push(
    `  ACCEPTED BUT SEMANTICALLY WRONG   : ${String(report.totals["accepted-but-wrong"])}`,
  );
  push(
    `  refused, and the claim was wrong  : ${String(report.totals["refused-and-wrong"])}`,
  );
  push(
    `  refused, though the claim was true: ${String(report.totals["refused-though-correct"])}`,
  );
  push();

  push("REFUSAL REASONS");
  push("-".repeat(74));
  for (const [reason, count] of [...report.refusalReasons].sort()) {
    push(`  ${pad(reason, 34)} ${String(count)}`);
  }
  push();

  push("STRICTNESS COST — refused although the claim was true");
  push("-".repeat(74));
  push("  Split by why, because these mean opposite things:");
  for (const family of [
    "provenance",
    "coordinates",
    "contract",
    "lexis",
  ] as const) {
    const count = report.strictnessCost.get(family) ?? 0;
    const gloss =
      family === "lexis"
        ? "<- the only real cost; the rest are fail-closed working"
        : "";
    push(`  ${pad(family, 14)} ${pad(String(count), 4)} ${gloss}`);
  }
  push();

  push("THE DECIDING NUMBER");
  push("-".repeat(74));
  push(
    `  Semantic-error classes probed: ${String(report.semanticClassesProbed)}. Caught by coordinate`,
  );
  push(`  verification: ${String(report.semanticClassesCaught)}.`);
  push();
  push(
    `  For completeness ${String(report.falselyAccepted)} of ${String(report.accepted)} accepted candidates are factually wrong ` +
      `(${(report.falseAcceptanceRate * 100).toFixed(1)}%),`,
  );
  push(
    "  but that percentage is NOT a base rate and must not be quoted as one.",
  );
  push("  It is a property of how this corpus was composed: it probes seven");
  push("  semantic-error classes deliberately, so the ratio moves whenever a");
  push("  case is added. What the spike establishes is WHICH classes are");
  push("  invisible to a lexical check, not how often a model commits them.");
  push("  Measuring frequency needs model-produced candidates over a labelled");
  push("  document set, which this slice does not attempt.");
  push();
  const wrong = report.scored.filter(
    (scored) => scored.outcome === "accepted-but-wrong",
  );
  if (wrong.length > 0) {
    push(
      "  Each one hashes, sits at its stated coordinates, and normalises to",
    );
    push(
      "  its stated value. The verifier has no basis to refuse any of them:",
    );
    push();
    for (const scored of wrong) {
      push(`   - [${scored.case.wrongness ?? "?"}] ${scored.case.what}`);
      push(`     ${scored.case.note}`);
    }
  }
  push();

  push("WHAT THIS CORPUS DOES NOT EXERCISE");
  push("-".repeat(74));
  push("  Space-grouped numbers and dash-as-minus have no natural material in");
  push("  either capture: the UCR document's eight `&nbsp;` entities are all");
  push("  layout, none adjacent to a number, and neither capture contains a");
  push(
    "  dash inside a numeric token. Both are covered by unit tests over the",
  );
  push("  normaliser and by NO corpus candidate.");
  push();
  push("  That gap hid a defect. Version 1 originally stripped every internal");
  push(
    "  space before validating grouping, so `2 7,633` read as 27633, `1 2 3`",
  );
  push(
    "  as 123, and `4. 7%` as 4.7 - adjacent tokens merged into one accepted",
  );
  push(
    "  number. That is a SECOND deterministic lexical false-acceptance class,",
  );
  push(
    "  living in the code rather than the corpus, and review found it because",
  );
  push("  no candidate over these captures could. Space is now a thousands");
  push("  separator under the same grouping rule as a comma.");
  push();
  push("  The `ug_per_m3` unit identity is likewise unit-tested only: the");
  push("  OpenAQ capture never places a number and its unit in one contiguous");
  push("  span, so no real candidate can quote both at once.");

  return lines.join("\n");
}
