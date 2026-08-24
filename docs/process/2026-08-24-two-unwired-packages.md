# Two packages nothing uses, and what they are for

Date: 2026-08-24
Occasioned by: PR #51, and the arithmetic in it

## The finding

`@dasher/calculation-engine` and `@dasher/extraction-spike` are depended on by no
package in this repository. Verified across every manifest:

```sh
grep -rn "@dasher/calculation-engine\|@dasher/extraction-spike" \
  --include=package.json packages apps | grep -v node_modules
# only their own name fields
```

Between them they carry **372 tests** through every CI run. That is not the
problem. The problem is that both were built for work this repository is about
to do again by hand.

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

### Recommendation

Keep, and treat it as the provenance model the workbook path extends rather than
as a spike to be superseded. Do not rebuild coordinate verification for
spreadsheets. The wrongness taxonomy in particular is the thing that would
otherwise be reinvented badly: `reporting-period` and `denominator` are exactly
how a spending figure goes wrong.

The name should change if it stops being a spike. It is currently accurate.

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

## What this file does not decide

Whether to wire or delete. Both recommendations above are recommendations; the
decision affects scope, CI time, and what the CSV slice is allowed to assume,
and it belongs to whoever owns those.
