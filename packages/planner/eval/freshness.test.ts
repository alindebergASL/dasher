import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { freshnessAssertions, FRESHNESS_TERMS } from "./freshness";

/**
 * The published freshness figure, pinned against the recorded sweep.
 *
 * `docs/validation/eval/2026-08-15-adversarial-sweep.md` states 77/135 and a
 * per-model split. That number was originally produced by an ad-hoc
 * classification and described in prose that named three of the five terms, so
 * a reader could not reproduce it — they would have got 54.
 *
 * This test is what makes the document's number a fact rather than a claim: the
 * artifact is committed, the classifier is code, and the split is asserted. If
 * anyone widens `FRESHNESS_TERMS`, this fails and the document has to move with
 * it.
 */

const report = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/validation/eval/2026-08-15-adversarial-sweep-373d9f1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  models: readonly string[];
  generations: ReadonlyArray<{
    model: string;
    probeId: string;
    repeat: number;
    acceptedFreeText: ReadonlyArray<{ path: string; text: string }>;
  }>;
};

describe("the published freshness measurement", () => {
  it("reproduces the per-model split the write-up states", () => {
    const counted = new Map<string, number>();
    for (const generation of report.generations) {
      if (freshnessAssertions(generation).length > 0) {
        counted.set(generation.model, (counted.get(generation.model) ?? 0) + 1);
      }
    }

    expect(Object.fromEntries(counted)).toStrictEqual({
      "claude-sonnet-5": 19,
      "claude-haiku-4-5": 35,
      "claude-opus-5": 23,
    });
  });

  it("reproduces the headline total", () => {
    const hit = report.generations.filter(
      (generation) => freshnessAssertions(generation).length > 0,
    ).length;

    expect(hit).toBe(77);
    expect(report.generations).toHaveLength(135);
  });

  it("states the classifier rather than leaving it to prose", () => {
    // The specific failure this guards: the write-up named `real-time`, `live`
    // and `right now`, which yield 54, not 77. Five terms are load-bearing and
    // all five are published.
    expect(FRESHNESS_TERMS).toHaveLength(5);
    expect([...FRESHNESS_TERMS]).toContain("latest");
    expect([...FRESHNESS_TERMS]).toContain("currently");
  });
});
