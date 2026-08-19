import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CORPUS, type WrongnessCategory } from "./corpus";
import { DOCUMENTS, DOCUMENTS_BY_ID } from "./document";
import { formatReport, runSpike } from "./report";
import type { RefusalReason } from "./verify";

const REPOSITORY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("the documents are the real captures", () => {
  it("reproduces the hash UCR's own provenance sidecar recorded", () => {
    // Not a self-check: the sidecar was written when the page was captured, so
    // this ties the corpus to that retrieval rather than to whatever is on disk.
    const sidecar = JSON.parse(
      readFileSync(
        join(REPOSITORY_ROOT, "fixtures/ucr/campus-facts-2025.meta.json"),
        "utf8",
      ),
    ) as { sha256: string; sourceUrl: string };
    const sealed = DOCUMENTS_BY_ID.get("ucr-campus-facts-2025");
    expect(sealed?.contentSha256).toBe(sidecar.sha256);
    expect(sidecar.sourceUrl).toContain("ucr.edu");
  });

  it("seals every document it declares", () => {
    for (const document of DOCUMENTS) {
      expect(document.bytes.length).toBeGreaterThan(0);
      expect(document.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("the corpus is not hollow", () => {
  const report = runSpike();

  it("accepts every positive", () => {
    const missed = report.scored
      .filter(
        (scored) =>
          scored.case.intent === "positive" && !scored.verdict.accepted,
      )
      .map((scored) => scored.case.id);
    expect(missed, "a positive case stopped verifying").toEqual([]);
  });

  it("refuses every refusal probe", () => {
    const leaked = report.scored
      .filter(
        (scored) =>
          scored.case.intent === "refusal-probe" && scored.verdict.accepted,
      )
      .map((scored) => scored.case.id);
    expect(leaked, "a refusal probe was accepted").toEqual([]);
  });

  it("exercises every refusal reason the verifier can produce, or names why not", () => {
    // A reason that no case reaches is a branch nobody has ever seen run.
    const reachedByCorpus = new Set(
      report.scored
        .filter((scored) => !scored.verdict.accepted)
        .map((scored) =>
          scored.verdict.accepted ? "" : scored.verdict.reason,
        ),
    );
    // `unknown-snapshot` and `unit-not-in-extracted-text` are unreachable from a
    // corpus built over real documents — the first needs a snapshot id that does
    // not exist, the second needs text whose unit contradicts a claim about the
    // same text. Both are covered in `verify.test.ts` instead.
    const coveredElsewhere: readonly RefusalReason[] = [
      "unknown-snapshot",
      "unit-not-in-extracted-text",
    ];
    const allReasons: readonly RefusalReason[] = [
      "malformed-candidate",
      "unknown-snapshot",
      "hash-mismatch",
      "locator-out-of-range",
      "coordinate-text-mismatch",
      "unsupported-normalization",
      "unsupported-unit-syntax",
      "value-not-in-extracted-text",
      "unit-not-in-extracted-text",
    ];
    const unexercised = allReasons.filter(
      (reason) =>
        !reachedByCorpus.has(reason) && !coveredElsewhere.includes(reason),
    );
    expect(unexercised, "a refusal reason is never produced").toEqual([]);
  });

  it("probes every semantic-error category ADR-008 names, plus the one this spike found", () => {
    const probed = new Set(
      CORPUS.filter((item) => item.intent === "false-acceptance-probe").map(
        (item) => item.wrongness,
      ),
    );
    const required: readonly WrongnessCategory[] = [
      "subject",
      "field",
      "reporting-period",
      "unit",
      "denominator",
      "section",
      "fragment",
    ];
    expect([...probed].sort()).toEqual([...required].sort());
  });
});

describe("the finding", () => {
  const report = runSpike();

  it("catches none of the semantic-error classes", () => {
    // The whole point, asserted rather than narrated. If a future change makes
    // this pass by catching something, that is a real result and this test
    // should be updated deliberately — not a failure to route around.
    expect(report.semanticClassesCaught).toBe(0);
    expect(report.semanticClassesProbed).toBe(7);
  });

  it("accepts every false-acceptance probe", () => {
    const caught = report.scored
      .filter(
        (scored) =>
          scored.case.intent === "false-acceptance-probe" &&
          !scored.verdict.accepted,
      )
      .map((scored) => scored.case.id);
    expect(caught).toEqual([]);
  });

  it("has exactly one lexical over-strictness cost, not a pile of them", () => {
    // Fail-closed refusals of true claims are the guard working. Only the
    // `lexis` family is a cost, and knowing it is one case — a span that ran
    // into the next word — is what points at span trimming rather than
    // separators as the first normalisation question.
    expect(report.strictnessCost.get("lexis") ?? 0).toBe(1);
  });

  it("does not present its own false-acceptance ratio as a base rate", () => {
    // The ratio is a property of corpus composition. Guarding the wording keeps
    // a convenient number from being quoted as a measurement.
    const text = formatReport(report);
    expect(text).toContain("NOT a base rate");
  });
});
