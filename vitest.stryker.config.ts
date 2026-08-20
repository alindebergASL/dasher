import { defineConfig } from "vitest/config";

/**
 * Test selection for the mutation run only.
 *
 * The composition rules live in `@dasher/station-domain` and are exercised
 * from there, from `@dasher/river-domain`'s fixture-driven suite, and from
 * `@dasher/planner`, so mutating them has to run all three suites or the
 * score measures the wrong thing. Nothing else discovers this file: each
 * package's own `vitest run` uses its own directory.
 *
 * THE INCLUDE LIST AND THE MUTATE LIST MOVE TOGETHER. Adding a file to
 * `stryker.config.json` without adding the tests that exercise it does not
 * report "untested" — it reports every mutant as NO COVERAGE, which looks
 * identical to weak assertions and is not the same claim at all. The two
 * lists are one decision split across two files, and this comment is the
 * only thing joining them.
 *
 * `compose.ts` is exercised from exactly two places: its own unit suite,
 * named here, and `compose.integration.test.ts`, already covered by the
 * planner glob above. The rest of `@dasher/dashboard-schema`'s suite is
 * deliberately NOT included — those tests do not touch composition, and
 * `generated-code-gate.test.ts` walks the whole repository on every run.
 */
export default defineConfig({
  test: {
    include: [
      "packages/planner/src/**/*.test.ts",
      "packages/river-domain/src/**/*.test.ts",
      "packages/station-domain/src/**/*.test.ts",
      "packages/dashboard-schema/src/compose.test.ts",
    ],
  },
});
