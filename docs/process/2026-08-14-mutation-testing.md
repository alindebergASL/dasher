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

Roughly 100 seconds for 692 mutants. It has its own CI job so it runs in
parallel rather than in front of the static gates.

## What is mutated, and why it runs from the root

`@dasher/planner`'s compiler, plan contract, and run loop, plus
`@dasher/river-domain`'s `facts.ts` — the composition rules the two share.

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

| Measured 2026-08-14 | Score  | Killed | Survived | No coverage |
| ------------------- | ------ | ------ | -------- | ----------- |
| `compile.ts`        | 69.19% | 256    | 107      | 7           |
| `run.ts`            | 67.80% | 39     | 9        | 10          |
| `facts.ts`          | 53.99% | 88     | 68       | 7           |
| `plan.ts`           | 31.75% | 20     | 29       | 14          |
| **total**           | 61.68% | 403    | 213      | 38          |

## What survived, and which of it is worth attacking

The survivors are not one population. Sorted by mutator:

| Mutator                 | Survived |
| ----------------------- | -------- |
| `ConditionalExpression` | 67       |
| `StringLiteral`         | 55       |
| `EqualityOperator`      | 33       |
| `ArrayDeclaration`      | 11       |
| `MethodExpression`      | 10       |
| everything else         | 37       |

The 55 surviving `StringLiteral` mutants are mostly display copy and error
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
its boundary. `plan.ts` at 31.75% is the weakest file: it is the contract that
decides what a planning model is allowed to say, which makes its limits a
boundary worth pinning rather than an implementation detail.
