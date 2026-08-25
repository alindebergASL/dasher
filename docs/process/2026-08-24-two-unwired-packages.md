# Two packages nothing used, what they were for, and what happened next

Date: 2026-08-24
Occasioned by: PR #51, and the arithmetic in it

## Correction, before the finding

The first version of this note opened by announcing that two packages are
reachable from nothing, as though that were news. **The repository already knew,
and had instrumented it.** `reachability.json` declares both, each with a reason
and a date, and `@dasher/repo-graph` fails the build in both directions — on an
orphan nobody declared, and on a declaration that has gone stale because the
package got wired up.

That gate's own docstring names the exact failure it exists to stop: control-plane
reaching 71,748 lines and calculation-engine 17,372 "with nothing importing
either, while every gate stayed green."

I found the absence by grepping `package.json` manifests and stopped there. The
working practice I wrote two days ago says an absence claim carries the command
that produced it _and_ that the command's matches get read — and a manifest grep
was the wrong command, because the declaration does not live in a manifest. So
this note is not the discovery it first claimed to be. What follows is what it
actually adds: what the packages contain, what the arithmetic already costs, and
which declaration has gone quietly out of date.

## What the declarations say

```json
{ "name": "@dasher/calculation-engine",
  "reason": "Its only importer was the integration test cross-checking the
             PL/pgSQL evaluator that the baseline squash deleted. Wiring it into
             @dasher/planner is step 4 of the restructure proposal and is the
             next visible change.",
  "since": "2026-08-14" }
```

"The next visible change" was ten days ago, and four slices have shipped since.
The declaration is not false — nothing imports it — but its _reason_ has become
a plan nobody is executing, which is the softer version of the rot the gate was
built to catch.

```json
{ "name": "@dasher/extraction-spike",
  "reason": "...must not be importable by product code while ADR-008 is Proposed
             and the extracted tier is undecided...",
  "since": "2026-08-19" }
```

That one is doing its job exactly as written, and it **overrules** the
recommendation this note originally made for it. See below.

Between them the two packages carry **372 tests** through every CI run.

## `@dasher/calculation-engine` — the calculation envelope, already built

It is a pure deterministic graph runtime for `calculation-registry-v1`: no
database, filesystem, network, clock, randomness, dynamic import, or provider
dependency. What it contains, read rather than assumed:

- **Exact decimal arithmetic.** `decimal.ts` says it plainly: every semantic
  signed-64 value is the tagged string `i64:<decimal>` parsed straight to
  `bigint`, and **no value is routed through a JavaScript number**. Decimals are
  `{coefficient, scale}` pairs, arithmetic runs on exact reduced rationals, and
  there is exactly one final quantization with half-even rounding.
- **A canonical input table.** `canonical-input-table-v1` — fields and rows, with
  a snapshot id, a row count, and a sha256 over its exact bytes. That is the
  shape a normalized workbook has.
- **Metric contracts, an FX rate evidence type, timezone handling, unit
  conversion, and a step budget.**
- **A public entry point.** `runCalculation(request): CalculationRun`.
- **A river dashboard fixture test** — "bounded river dashboard fixture" —
  which converts streamflow from `[ft_i]3/s` to `m3/s` exactly, stage from
  `[ft_i]` to `m`, and temperature through both affine offsets.

So it was built for dashboards, it has a river fixture, and the river dashboard
does not use it.

### What that cost, measured

PR #51 adds a ledger compiler that computes totals, period-over-period change,
share of total, and budget variance — money — in JavaScript floats. The
committed fixture's shares do not sum to one hundred:

```
shares sum to: 99.99999999999999
exactly 100?   false
error:         -1.4210854715202004e-14
```

The test written for that property asserts `toBeCloseTo(100, 6)`. The tolerance
is not wrong for a display that rounds to one decimal place, and it is exactly
the shape of a claim written to fit what the code does rather than what the
product needs. A finance dashboard whose figures are computed in binary floating
point is a defensible demo and an indefensible product, and the repository
already contains the thing that fixes it.

### Recommendation

Wire it, starting with the ledger. Not as a rewrite of everything: the ledger's
facts are small, the engine's input table is the shape a normalized ledger
already has, and the ledger is the only place in the product where the numbers
are money. Whether the station domains follow is a separate question that
should be answered by whether unit conversion is wanted, not by symmetry.

If it is NOT wired, it should be deleted. A calculation engine nobody calls is
not an asset held for later; it is 303 tests defending an interface no consumer
has ever pushed against, and every month it stays unwired the odds rise that it
does not fit the consumer when one arrives.

## `@dasher/extraction-spike` — the provenance model for values read out of documents

It verifies that a value a model claims to have extracted actually appears at
the coordinates it claims, in a document whose bytes are sealed by sha256. It is
lexical, deterministic, and fail-closed: ten distinct refusal reasons, and its
own docstring is explicit that it CANNOT tell whether the right number was bound
to the right claim.

That last part is the valuable part. Its corpus classifies wrongness into
`subject`, `field`, `reporting-period`, `unit`, `denominator`, `section`, and
`fragment` — a taxonomy of the ways an extracted number can be right-looking and
wrong. It seals two real captures: UCR's campus-facts HTML and a live OpenAQ
capture.

### Why it matters now

The next slice is CSV/XLSX. "Dasher explains its source understanding" means
saying which cell a figure came from and standing behind it, which is this
package's entire subject — one representation away. Its locators are text
coordinates in a document; a workbook's are sheet, row, and column.

### Recommendation, corrected

The first version of this note said to "treat it as the provenance model the
workbook path extends". **That is not available.** Its declaration says it must
not be importable by product code while ADR-008 is Proposed and the extracted
tier is undecided, and importing it into a workbook path is precisely what that
forbids. The boundary is deliberate and the note was wrong to route around it.

What is available, and what this note recommends instead: when the workbook path
needs coordinate-level provenance, the decision to make is **ADR-008's** — accept
or reject the extracted tier — and the spike is the evidence for that decision
rather than a library to import. Its wrongness taxonomy (`subject`, `field`,
`reporting-period`, `unit`, `denominator`, `section`, `fragment`) is worth
reading before designing workbook evidence, because `reporting-period` and
`denominator` are exactly how a spending figure goes wrong. Reading it is not
importing it.

So: leave it alone, and do not treat its isolation as debt. Unlike the
calculation engine, its declaration is current and its reason still holds.

## What this is an instance of

Three times now in this repository, a capability existed and the work in front
of it did not use it.

| Built                                                          | Used by         |
| -------------------------------------------------------------- | --------------- |
| `@dasher/planner/anthropic` — complete model-backed planner    | one eval script |
| `@dasher/calculation-engine` — exact decimal calculation graph | nothing         |
| `@dasher/extraction-spike` — coordinate-verified extraction    | nothing         |

Each was found by reading before building, and each was found late. The cheap
countermeasure is to make it the first question of any slice rather than a
discovery inside one: **before adding a capability, grep the workspace for it.**
It cost two hours on the model planner and would have changed the arithmetic in
PR #51 had it been asked there.

## What was decided, and what has been done

Recorded 2026-08-25, so that this file describes the repository rather than a
moment in it. **The audit above is what was true on 2026-08-24; it is no longer
true of the first package, and this section is the reason.**

**`@dasher/calculation-engine`: wired, starting with the ledger**, exactly as
recommended. Every amount, change, share and budget variance the ledger displays
is now computed by the engine on exact decimals, the snapshot is carried through
`canonical-input-table-v1` and hashed at the boundary, and the package's entry in
`reachability.json` is gone — the repo-graph gate passing without it is what
proves the wiring is real rather than declared. That work is on
`claude/ledger-free-text-gate` and is not merged at the time of writing, so a
reader checking `main` may still find the exemption in place; check
`reachability.json` rather than this paragraph.

Three things the engine refused along the way, each of which changed the design
and none of which the float version had to answer: arithmetic across two
evaluation domains, division by zero, and the assumption that output rows come
back in the order they were submitted. The last one silently attached one budget
line's figures to another until a guard caught it.

It also corrected the measurement in this file. The float shares summed to
99.99999999999999, and the exact ones sum to 100 for the period the dashboard
shows — but not for all six periods in the fixture, two of which land one unit in
the last requested place away. Rounding residue is inherent; what changed is that
it is now bounded by a precision someone asked for.

**`@dasher/extraction-spike`: still unreachable, still declared, still
undecided.** Its recommendation stands unactioned, and the tension named there is
unresolved: extending it to workbook coordinates is the cheapest path for the
parsing slice, and its `reachability.json` entry forbids product code importing
it while ADR-008 is Proposed. That is an ADR decision, not an implementation
choice, and nothing here takes it.

## What this file does not decide

Anything about `@dasher/extraction-spike`. The recommendation above is a
recommendation; the decision affects scope, CI time, and what the workbook slice
is allowed to assume, and it belongs to whoever owns those.
