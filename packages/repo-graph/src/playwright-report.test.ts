import { describe, expect, it } from "vitest";

import { findPlaywrightReportProblems } from "./playwright-report";

/**
 * The checker that guards the persistence job, checked.
 *
 * The point of moving this out of `ci.yml` was that a validator nobody can run
 * locally is a validator nobody can trust. So the cases below are not the happy
 * path with decoration — they are the specific reports that the inlined version
 * had to reject, and one it wrongly rejected.
 */

const EXPECTATION = {
  specFile: "persisted-dashboard.spec.ts",
  minimumTests: 6,
} as const;

function test(overrides: Record<string, unknown> = {}) {
  return {
    expectedStatus: "passed",
    results: [{ status: "passed" }],
    ...overrides,
  };
}

function spec(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    file: "persisted-dashboard.spec.ts",
    ok: true,
    tests: [test()],
    ...overrides,
  };
}

function report(count: number, overrides: Record<string, unknown> = {}) {
  return {
    stats: { expected: count, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
    suites: [
      {
        specs: Array.from({ length: count }, (_, index) =>
          spec(`case ${String(index)}`),
        ),
      },
    ],
    ...overrides,
  };
}

describe("a report that proves the suite ran", () => {
  it("accepts exactly the minimum", () => {
    expect(findPlaywrightReportProblems(report(6), EXPECTATION)).toEqual([]);
  });

  it("accepts more than the minimum", () => {
    // The regression this whole change exists for. The inlined checker pinned
    // the count at three sites, so a seventh persistence test failed CI three
    // times in a file that could not be run locally. Growing a suite is not a
    // build break.
    expect(findPlaywrightReportProblems(report(7), EXPECTATION)).toEqual([]);
  });

  it("finds specs nested inside describe blocks", () => {
    const nested = {
      stats: { expected: 6, skipped: 0, unexpected: 0, flaky: 0 },
      errors: [],
      suites: [
        {
          specs: [spec("top")],
          suites: [
            {
              specs: Array.from({ length: 5 }, (_, index) =>
                spec(`nested ${String(index)}`),
              ),
            },
          ],
        },
      ],
    };

    expect(findPlaywrightReportProblems(nested, EXPECTATION)).toEqual([]);
  });
});

describe("a report that proves nothing", () => {
  it("rejects a suite that shrank below the floor", () => {
    // The floor is a real assertion, not a formality: deleting tests until the
    // job proves nothing has to be a failure, or the floor is decoration.
    expect(findPlaywrightReportProblems(report(5), EXPECTATION)).not.toEqual(
      [],
    );
  });

  it("rejects a skipped test", () => {
    // The failure this job exists for. A guard that turns the suite off in
    // place leaves every other signal green.
    const skipped = report(6, {
      stats: { expected: 5, skipped: 1, unexpected: 0, flaky: 0 },
    });

    // Both halves, because they fail independently: a skip that Playwright
    // counts as skipped, and the drop in `expected` that the same skip causes.
    // Asserting only the first left the floor on `expected` killed by nothing
    // more direct than a problem-count test.
    expect(findPlaywrightReportProblems(skipped, EXPECTATION)).toEqual([
      "stats.skipped is 1, expected 0",
      "stats.expected is 5, expected at least 6",
    ]);
  });

  it("rejects a report whose specs come from another file", () => {
    // What a rename plus a stale path in the workflow produces: a green run
    // describing a suite nobody asked for.
    const elsewhere = report(6, {
      stats: { expected: 6, skipped: 0, unexpected: 0, flaky: 0 },
      suites: [
        {
          specs: Array.from({ length: 6 }, (_, index) =>
            spec(`case ${String(index)}`, { file: "smoke.spec.ts" }),
          ),
        },
      ],
    });

    expect(
      findPlaywrightReportProblems(elsewhere, EXPECTATION).length,
    ).toBeGreaterThan(0);
  });

  it("rejects a test that was expected to fail", () => {
    const expectedFailure = report(6, {
      suites: [
        {
          specs: [
            spec("marked fail", {
              tests: [test({ expectedStatus: "failed" })],
            }),
            ...Array.from({ length: 5 }, (_, index) =>
              spec(`case ${String(index)}`),
            ),
          ],
        },
      ],
    });

    expect(
      findPlaywrightReportProblems(expectedFailure, EXPECTATION),
    ).toContain("a test in marked fail has expectedStatus failed");
  });

  it("rejects a test with no results at all", () => {
    const empty = report(6, {
      suites: [
        {
          specs: [
            spec("never ran", { tests: [test({ results: [] })] }),
            ...Array.from({ length: 5 }, (_, index) =>
              spec(`case ${String(index)}`),
            ),
          ],
        },
      ],
    });

    expect(findPlaywrightReportProblems(empty, EXPECTATION)).toContain(
      "a test in never ran did not pass",
    );
  });

  it("rejects runner errors even when every test passed", () => {
    const errored = report(6, { errors: [{ message: "worker crashed" }] });

    expect(findPlaywrightReportProblems(errored, EXPECTATION)).toContain(
      "the report contains runner errors",
    );
  });

  it("rejects a report with no suites key rather than reading it as empty", () => {
    // `[]` and "malformed" must not collapse into the same answer: a report
    // that discovered nothing is exactly the case this has to be able to name.
    const malformed = report(6, { suites: undefined });

    expect(findPlaywrightReportProblems(malformed, EXPECTATION)).toContain(
      "the report suites are malformed",
    );
  });

  it("rejects a root that is not an object", () => {
    expect(findPlaywrightReportProblems([], EXPECTATION)).toEqual([
      "the report root is not an object",
    ]);
    expect(findPlaywrightReportProblems(null, EXPECTATION)).toEqual([
      "the report root is not an object",
    ]);
  });

  it("reports every problem, not just the first", () => {
    // A checker that stops at the first problem costs a CI round trip per
    // problem, and these usually share one cause.
    const broken = report(6, {
      stats: { expected: 2, skipped: 3, unexpected: 1, flaky: 1 },
    });

    expect(
      findPlaywrightReportProblems(broken, EXPECTATION).length,
    ).toBeGreaterThan(3);
  });
});
