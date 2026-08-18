import { readFileSync } from "node:fs";

import { findPlaywrightReportProblems } from "./playwright-report";

/**
 * The command line around `findPlaywrightReportProblems`.
 *
 * Thin on purpose: reading a file, parsing arguments, and writing GitHub
 * annotations are the parts that cannot be unit tested usefully, so they are
 * the only parts that live here. Everything that decides whether a report is
 * acceptable is in the module beside this one, where tests can reach it.
 *
 *   vite-node src/assert-playwright-report.ts -- \
 *     --report=/tmp/results.json --spec-file=x.spec.ts --min-tests=6
 */

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function fail(message: string): never {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}

const reportPath = argument("report");
const specFile = argument("spec-file");
const minimumTests = Number(argument("min-tests"));

if (reportPath === undefined || specFile === undefined) {
  fail("usage: --report=<path> --spec-file=<name> --min-tests=<n>");
}
if (!Number.isInteger(minimumTests) || minimumTests < 1) {
  fail("--min-tests must be a positive integer");
}

let report: unknown;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  // A missing or unparseable report is itself the finding. The suite was told
  // to write one; not having it means the run did not get far enough to say
  // anything, which must not read as silence.
  fail(`could not read ${reportPath}: ${String(error)}`);
}

const problems = findPlaywrightReportProblems(report, {
  specFile,
  minimumTests,
});

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`::error::${problem}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `${specFile}: at least ${String(minimumTests)} tests ran, none skipped, all passed.\n`,
);
