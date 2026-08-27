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
 * `csv.ts` and `from-csv.ts` are here because they are the first code in the
 * product that reads a file it did not author. A surviving mutant in either is
 * a way for a malformed export to become a plausible dashboard.
 *
 * `apps/web/app/upload.ts` joins them for the same reason, one layer out: it
 * decides how large a file may be, whether its bytes are text at all, what the
 * reader must declare about it, and what each refusal says. A surviving mutant
 * there is a way for a file nobody could read to be accepted, or for a person
 * to be told the wrong thing about why theirs was not.
 *
 * `apps/web/app/mailer.ts` is here because its defaults are security
 * decisions rather than configuration plumbing. A mutant that makes the
 * development transport reachable without being named turns a deployment with
 * missing provider credentials into one that prints live sign-in links to its
 * logs; a mutant that relaxes the https check on the link origin produces
 * sessions a browser silently refuses to store. Neither would fail any other
 * gate, and neither is visible in a code review that reads the intent rather
 * than the condition.
 *
 * The claims pair is here because the evidence chain is a claim ABOUT the
 * product's honesty, and a surviving mutant in either file is a way to make
 * that claim falsely. `packages/dashboard-schema/src/claims.ts` decides which
 * assertions exist and which evidence each inherits its label from; a mutant
 * that widens a label turns an interpretation into an observation on the
 * record. `apps/web/app/claims.ts` decides whether an assertion counts as
 * supported; a mutant that reports `complete` where the evidence was not
 * retained is exactly the overclaim these tables were added to prevent — and
 * nothing downstream would contradict it, because the column is where the
 * answer is supposed to live. Both suites are named below; they and
 * `upload.test.ts` are the only `apps/web` and non-composition
 * `dashboard-schema` suites in the list, because the rest of those packages'
 * tests render React or walk the repository, neither of which this run loads.
 *
 * `exact.ts` is here because it is arithmetic and nothing else — the decimal
 * comparison, rounding and formatting every ledger figure passes through on its
 * way to a reader. A surviving mutant in it is a way for money to be shown
 * wrong while every test still passes.
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
      "packages/dashboard-schema/src/claims.test.ts",
      "packages/dashboard-schema/src/compose.test.ts",
      "packages/ledger-domain/src/exact.test.ts",
      "packages/ledger-domain/src/from-csv.test.ts",
      "packages/workbook/src/csv.test.ts",
      "apps/web/app/claims.test.ts",
      "apps/web/app/mailer.test.ts",
      "apps/web/app/upload.test.ts",
      "packages/ledger-domain/src/ledger.test.ts",
      "packages/dashboard-schema/src/layout.test.ts",
    ],
  },
});
