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
 *
 * `layout.ts` is the same shape as `compose.ts`: one pure function with its
 * own unit suite, named here, and nothing else in the package's suite touches
 * it. Its callers are React components, which the mutation run does not load;
 * what the score measures is the packer's arithmetic, not the rendering.
 *
 * The ledger pair follows the same rule. `compile-ledger.ts` is exercised from
 * `packages/planner/src/compile-ledger.test.ts`, already inside the planner glob
 * above; `packages/ledger-domain/src/ledger.ts` needs its own suite named here,
 * because nothing else in the include list loads that package.
 *
 * `registry.ts` needs no new entry here: the planner glob already covers
 * `registry.test.ts`. What it does need saying is what its score MEANS. The
 * registry is mostly a static object literal, and `ignoreStatic` in
 * `stryker.config.json` skips mutants that only module-load code covers — so
 * the eight mutants it reports are the two functions beside the data, not the
 * entries. What covers the entries is `registry.test.ts`'s block-per-entry,
 * each checking a claim by making the compiler or the validator do the thing.
 * A clean score on that file is not a claim that the data is mutation-tested.
 */
export default defineConfig({
  test: {
    include: [
      "packages/planner/src/**/*.test.ts",
      "packages/river-domain/src/**/*.test.ts",
      "packages/station-domain/src/**/*.test.ts",
      "packages/dashboard-schema/src/compose.test.ts",
      "packages/ledger-domain/src/ledger.test.ts",
      "packages/dashboard-schema/src/layout.test.ts",
    ],
  },
});
