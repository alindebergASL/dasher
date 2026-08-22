# ADR-011: Component widths are packed, and the constraints live beside the contract

Status: Accepted
Date: 2026-08-22
Prior evidence: `docs/plans/2026-08-20-precedent-library.md` ("Layout lives here
too", staging item 2); ADR-010 ("What is deliberately not in an entry yet")

## Context

Every component kind decided its own width, in renderer JSX, one `className` at
a time. Five of the seven asked for the full row, one asked for two thirds, and
the remaining two took whatever column was left. Nobody had ever compared those
seven choices to each other, so what a reader saw was their residue rather than
anyone's decision. Measured in Chromium at 1440px on
`73ff42cfc9e8227cbc1dc1de7119fa7ffa00f269`:

| Dashboard  | Last row                  | Also                                            |
| ---------- | ------------------------- | ----------------------------------------------- |
| River      | one 347px panel of 1073px | map 710px beside a 347px ranking, 240px shorter |
| Enrollment | one 347px panel of 1073px | —                                               |
| Combined   | one 347px panel of 1073px | map 710px beside a 347px ranking, 240px shorter |

Every one of those last rows left 726px of empty grid to the right of a panel.

ADR-010 deferred layout constraints out of the pattern registry on the grounds
that nothing would read them. Packing v1 is the consumer that changes that.

## Decision

**A pure packer decides widths; nothing else does.**
`packComponents` in `@dasher/dashboard-schema` takes a page's components and
returns each one's span and row. It is a function of the sequence of component
kinds and nothing else — no measurement, no content, no randomness — so the same
dashboard packs the same way in a test, in a screenshot, and in a browser.

**Six columns, not three.** Three cannot express halves, so a map beside a
ranking had to be two thirds and one third. Six divides into halves and thirds
alike, which is the entire vocabulary this slice needs.

**Four invariants, each tested against every sequence of up to four kinds
(2801 of them):** order is preserved and every component placed exactly once;
every row's spans sum to exactly six; every span lies inside its kind's
`[minSpan, maxSpan]`; the result is a function of the kind sequence alone.

**The constraints are keyed by component kind, in `@dasher/dashboard-schema` —
not on `PatternEntry` in `@dasher/planner`.** This is a deliberate departure
from the precedent note, which sketched them as a registry field. Two reasons:

- The consumer is a `"use client"` React component. `@dasher/dashboard-schema`
  is already in the browser bundle; `@dasher/planner` is not, and should not be
  pulled in for a table of numbers.
- A plan section is not what gets laid out. `PatternEntry` is keyed by plan
  section kind, but the packer runs on a compiled `Dashboard`, whose unit is the
  component. Putting the field on the entry would mean a lookup through the
  registry to reach a fact about the thing on the other side of the compiler.

A `PatternEntry.layout` accessor delegating to this table was considered and
rejected: nothing would read it, which is the exact condition ADR-010 deferred
the field to avoid.

## Consequences

- A ragged trailing row is now impossible by construction, at any width above
  the 760px breakpoint. Below it the grid is a single column, where the
  invariant holds trivially.
- The grid stretches peers to a shared row height, so a short card no longer
  hangs above a hole. The cost is the mirror image: a panel with one item beside
  a tall map now has empty space _inside_ its border rather than beside it. On
  the river dashboard, "Fastest-rising gauges" holds a single entry and is
  stretched to the map's 430px. That is a content shape — one gauge is fresh and
  complete — that layout cannot fix, and this ADR does not claim it does.
- Adding a component kind means adding a `COMPONENT_LAYOUT` entry; the table is
  exhaustive over the kind union, so TypeScript refuses the omission.
- `minSpan` must divide six and be at least two. This is what keeps a row's
  item count a divisor of six, and so keeps spans whole. A kind admitted at one
  would let five share a row and produce a 1.2-column span. A unit test asserts
  it on every entry rather than leaving it to the next person to notice.
- The 1050px breakpoint no longer overrides the grid. It collapsed three columns
  to two because two-thirds-plus-one-third was cramped there; six columns hold
  down to 760px, where everything becomes one column.

## What this does not do

Nothing here reads content, measures rendered height, or reorders anything.
Order is the plan's. Density, placement tendency, and shape — the rest of the
precedent note's sketch — remain unwritten, because the packer does not read
them yet.
