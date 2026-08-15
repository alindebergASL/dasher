# Mutation testing the reachable product logic

Status: Applied — Stryker runs in CI against the reachable product logic
Date: 2026-08-14

## Why here

`compile.ts` is the largest source file on the path from a browser request to a
rendered dashboard, and until 2026-08-14 it had no test of its own. Three
mutations to it survived the planner's whole suite _and_ the end-to-end suite,
including the case named for evidence and freshness:

- the threshold comparison `>` weakened to `>=`
- the stale-gauge filter inverted, so fresh gauges are the ones flagged
- the summary tone pinned to `normal`, so nothing ever asks for attention

Passing tests said nothing about whether those rules held. That is the specific
failure mutation testing names, and it is worth automating precisely because
noticing it by hand depended on somebody thinking to look.

The planner is also the only reachable product logic. `control-plane` gets its
assurance from 75 integration tests against a real PostgreSQL server, where the
equivalent discipline is applied per fix by hand.

## Running it

```bash
pnpm test:mutation
```

Roughly three minutes for 1,043 mutants. It has its own CI job so it runs in
parallel rather than in front of the static gates.

## What is mutated, and why it runs from the root

`@dasher/planner`'s compiler, plan contract, free-text gate, run loop, and
provider, plus `@dasher/river-domain`'s `facts.ts` — the composition rules the
two share.

`freetext.ts` joined the run on 2026-08-14 with the gate it implements. It is
pattern-matching over strings, which is the shape of code where a passing suite
proves least: a regex can be weakened in a dozen ways that no example in the
test file happens to exercise. It scored 100% — 36 mutants, none survived — and
that is the number to defend rather than a licence to stop.

`provider.ts` joined with the refinement pass, and adding it turned the gate red
at 67.21: it arrived with 53 mutants that no test covered at all. That was not
noise. The fake provider's own docstring claims it "makes different composition
choices for different requests", and two of its five branches — the homeowner one
and the rate-of-change one — had never been exercised by anything. Its
selection-by-site-id and selection-by-station-name paths were untested too.

`provider.test.ts` closed those, taking the file from 60.30% to 73.73% and the
total to 71.81%. One of the new tests then failed on its first run for a reason
worth keeping: asserting that the five branches produce five distinct plans
returned four, because "I own a house near the river" — close to the most natural
way a homeowner would ask — falls through to the generic overview. The branch
wants the literal words "my house" or "property". That is pinned as a limitation
rather than patched, because widening the keyword list moves the silent failure
one phrase outward instead of removing it.

That is six files, not everything a browser request touches: `river-domain`'s
`metrics.ts` and `usgs.ts` and all of `dashboard-schema` are outside the run.
They are covered by their own suites but not held to this gate, so read the
score as being about the planning path rather than about the whole product.

That last one is the reason this runs from the repository root rather than
inside the planner. When the duplicated rules were extracted into
`river-domain`, the planner's mutant count fell from 687 to 528 and its score
_rose_ from 58.92 to 64.23, because 159 mutants had moved into a file the run
no longer looked at. The gate would have rewarded the refactor for putting code
beyond its reach. Mutating across both packages, and running both suites via
`vitest.stryker.config.ts`, is what keeps the score measuring the same thing
before and after a move.

## Three configuration decisions

**`inPlace: true`.** Stryker normally copies the project into a sandbox and
mutates the copy. That does not work here: the sandbox root is the package
directory, so it excludes both the workspace links the package needs and
`fixtures/usgs/`, which every planner test imports from three levels up. The
first attempt reported `No tests were found`, because every test file failed to
load. Mutating in place keeps the real paths and the real `node_modules`.

The cost is that a crash mid-run could leave a mutant in the working tree.
Stryker restores from a backup directory when it finishes, and the CI job runs
`git status --porcelain` afterwards so an unrestored file is reported rather
than silently carried into the next step.

**A dedicated Vitest config.** The shared rules are exercised from both
packages, so mutating them has to run both suites or the score measures the
wrong thing. `vitest.stryker.config.ts` selects exactly those two; nothing else
discovers it, since each package's own `vitest run` uses its own directory.

**`vitest.related: false`.** Stryker asks Vitest which tests relate to a mutated
file. `run.test.ts` imports through `./index` rather than from the source files
directly, so that lookup finds nothing and no tests run at all.

## The threshold is a floor, not an aspiration

`break` is set to the score measured the day this landed, not to a number worth
reaching. A gate that is red on arrival gets deleted within a week — the same
reasoning that made the reachability gate check against a declaration rather
than against zero.

So it fails on regression today, and is raised deliberately as coverage
improves. Raising it is a one-line change and should accompany the tests that
earn it.

| Measured 2026-08-14 | Score   | Killed | Survived | No coverage |
| ------------------- | ------- | ------ | -------- | ----------- |
| `freetext.ts`       | 100.00% | 36     | 0        | 0           |
| `plan.ts`           | 77.03%  | 57     | 14       | 3           |
| `provider.ts`       | 73.73%  | 247    | 74       | 14          |
| `compile.ts`        | 70.40%  | 264    | 105      | 6           |
| `run.ts`            | 68.33%  | 40     | 9        | 10          |
| `facts.ts`          | 63.80%  | 104    | 52       | 7           |
| **total**           | 71.81%  | 748    | 254      | 40          |

`plan.ts` moved from 80.95% to 77.03% in the same change, and the drop is real
rather than a regression: the free-text gate added a branch and two finding
messages to `findPlanProblems`, and the three new uncovered mutants are the
`StringLiteral` bodies of those messages — provider-facing revision text, where
the code and the path carry the meaning. The total rose because `freetext.ts`
brought 36 killed mutants with it.

The floor has been raised as coverage earned it: 58, then 61 when the shared
composition rules came under the run, then 62, then 67 when `plan.ts` went from
31.75% to 80.95%, then 69 when review found a display string that had silently
changed meaning. It stayed at 69 through the free-text gate, then rose to 71
when `provider.ts` came under the run and the tests that cover it landed
alongside.

## What survived, and which of it is worth attacking

The survivors are not one population. Sorted by mutator:

| Mutator                 | Survived |
| ----------------------- | -------- |
| `ConditionalExpression` | 62       |
| `StringLiteral`         | 51       |
| `EqualityOperator`      | 31       |
| `ArrayDeclaration`      | 11       |
| `MethodExpression`      | 11       |
| everything else         | 27       |

The 51 surviving `StringLiteral` mutants are mostly display copy and error
text. Emptying a headline that no assertion reads is a mutant nobody should
chase; pinning exact prose in tests buys brittleness rather than confidence.
They are deliberately not excluded from the run — excluding a mutator to raise
a number is how the number stops meaning anything — but they are the reason the
raw score reads lower than the state of the logic.

The `ConditionalExpression`, `EqualityOperator`, and `LogicalOperator`
survivors are the real gaps, and they are where the next tests should go. One
concrete example, `run.ts:54`:

```ts
if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
```

Changing `||` to `&&` survives, so the attempt-budget guard is not tested at
its boundary.

`plan.ts` was the weakest file at 31.75%, which mattered because it is the
contract deciding what a planning model may say. It is now the strongest at
80.95%, with no uncovered mutants left, and all twelve survivors are
`StringLiteral` in finding messages — text fed back to a provider for a
revision pass, where the code and the path carry the meaning and the wording
does not.

The lesson generalises. Its limits were exercised through the run loop and
looked covered, but nothing asserted the numbers, so a cap of four pages tested
identically to a cap of forty. A limit has to be asserted at the boundary —
admits the maximum, refuses the first thing past it — or it is not tested at
all.

`facts.ts` at 63.80% is now the weakest. It also supplied the counter-example
to the paragraph above: `signed(null)` returned "Not enough history" and was
changed to "Missing" during a refactor, which is a `StringLiteral` mutation
that altered what a reader is told — too little history is not a missing
reading. Review caught it; the gate did not. So "display copy is not worth
chasing" holds for a headline nobody asserts and fails for a string that names
a state.
