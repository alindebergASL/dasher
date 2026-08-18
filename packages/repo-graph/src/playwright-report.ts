/**
 * Reading a Playwright JSON report as evidence that a named suite actually ran.
 *
 * WHY THIS EXISTS. A job that runs a test suite and reports green proves less
 * than it looks like it does. The suite can be skipped in place by a guard, a
 * missing environment variable can turn every test into a no-op, and both look
 * identical to success from outside. The persistence job in `ci.yml` exists to
 * prove that a saved dashboard survives a reload, and a version of it that
 * passes while proving nothing is worse than no job at all, because it also
 * stops anyone looking.
 *
 * WHY IT IS HERE RATHER THAN IN THE WORKFLOW. It was 108 lines of Node inlined
 * into a YAML `run:` block. Nothing could lint it, typecheck it, or test it,
 * and the only way to find out whether it worked was to push. A checker nobody
 * can check is the same category of problem as the one it was written to catch.
 *
 * WHY A FLOOR AND NOT AN EXACT COUNT. The inlined version pinned the test count
 * at three separate sites, so adding a seventh persistence test failed CI three
 * times over, in a file that could not be run locally. That is not the property
 * the job is defending. "At least this many tests ran, none of them skipped,
 * all of them passed" is; a growing suite should not be a build break, and a
 * shrinking one should. Counts that must be exact — skipped, unexpected, flaky
 * — stay exact, because zero is the actual claim there rather than a tally that
 * happened to be true on the day it was written.
 */

/** What the caller claims the run should have demonstrated. */
export interface ReportExpectation {
  /**
   * The spec file every discovered test must belong to. The job names one file
   * on the command line; this is what catches a report describing a different
   * one, which is what a rename plus a stale path would produce.
   */
  readonly specFile: string;
  /**
   * The fewest tests that count as the suite having run. A floor, so the suite
   * can grow without touching CI, and a real assertion, so it cannot shrink to
   * nothing quietly.
   */
  readonly minimumTests: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every spec in the report, including those nested in `describe` blocks.
 *
 * Returns `undefined` rather than throwing or returning `[]` when the shape is
 * wrong: an empty list would be indistinguishable from a run that discovered
 * nothing, and that is precisely the case this has to be able to report.
 */
function collectSpecs(suites: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(suites)) return undefined;

  const specs: unknown[] = [];
  for (const suite of suites) {
    if (!isRecord(suite) || !Array.isArray(suite.specs)) return undefined;
    specs.push(...suite.specs);

    const children = Object.hasOwn(suite, "suites") ? suite.suites : [];
    const nested = collectSpecs(children);
    if (nested === undefined) return undefined;
    specs.push(...nested);
  }
  return specs;
}

/** A test result the report says passed, under the report's own shape. */
function resultsAllPassed(results: unknown): boolean {
  return (
    Array.isArray(results) &&
    results.length > 0 &&
    results.every((result) => isRecord(result) && result["status"] === "passed")
  );
}

/**
 * Everything wrong with this report, as messages.
 *
 * All of them, not the first: a caller fixing one thing at a time from a
 * single-problem checker pays a CI round trip per problem, and the problems
 * here are usually symptoms of one cause anyway. An empty array means the
 * report is evidence the suite ran and passed.
 */
export function findPlaywrightReportProblems(
  report: unknown,
  expectation: ReportExpectation,
): readonly string[] {
  const problems: string[] = [];

  if (!isRecord(report)) return ["the report root is not an object"];

  const stats = report["stats"];
  if (!isRecord(stats)) {
    problems.push("the report has no stats object");
  } else {
    // Zero is the claim, not a count of the day. A skip is the failure mode
    // this whole check exists for; unexpected and flaky mean the run did not
    // actually demonstrate what it reported.
    for (const name of ["skipped", "unexpected", "flaky"] as const) {
      if (stats[name] !== 0) {
        problems.push(`stats.${name} is ${String(stats[name])}, expected 0`);
      }
    }

    const expected = stats["expected"];
    if (typeof expected !== "number") {
      problems.push(`stats.expected is ${String(expected)}, expected a number`);
    } else if (expected < expectation.minimumTests) {
      problems.push(
        `stats.expected is ${String(expected)}, expected at least ${String(expectation.minimumTests)}`,
      );
    }
  }

  if (!Array.isArray(report["errors"]) || report["errors"].length !== 0) {
    problems.push("the report contains runner errors");
  }

  const specs = collectSpecs(report["suites"]);
  if (specs === undefined) {
    problems.push("the report suites are malformed");
    return problems;
  }

  if (specs.length < expectation.minimumTests) {
    problems.push(
      `the report discovered ${String(specs.length)} specs, expected at least ${String(expectation.minimumTests)}`,
    );
  }

  let tests = 0;
  for (const spec of specs) {
    if (!isRecord(spec)) {
      problems.push("the report contains a malformed spec");
      continue;
    }
    if (spec["file"] !== expectation.specFile) {
      problems.push(
        `a spec belongs to ${String(spec["file"])}, expected ${expectation.specFile}`,
      );
    }
    if (spec["ok"] !== true) {
      problems.push(`spec ${String(spec["title"])} is not ok`);
    }

    const specTests = spec["tests"];
    if (!Array.isArray(specTests) || specTests.length === 0) {
      problems.push(`spec ${String(spec["title"])} ran no tests`);
      continue;
    }
    tests += specTests.length;

    for (const test of specTests) {
      if (!isRecord(test)) {
        problems.push(`spec ${String(spec["title"])} has a malformed test`);
        continue;
      }
      // A test Playwright expected to fail or skip passes its own check while
      // proving nothing about the product. `expectedStatus` is what separates
      // "passed" from "passed at being skipped".
      if (test["expectedStatus"] !== "passed") {
        problems.push(
          `a test in ${String(spec["title"])} has expectedStatus ${String(test["expectedStatus"])}`,
        );
      }
      if (!resultsAllPassed(test["results"])) {
        problems.push(`a test in ${String(spec["title"])} did not pass`);
      }
    }
  }

  if (tests < expectation.minimumTests) {
    problems.push(
      `the report executed ${String(tests)} tests, expected at least ${String(expectation.minimumTests)}`,
    );
  }

  return problems;
}
