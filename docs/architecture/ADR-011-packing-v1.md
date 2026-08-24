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

- A ragged trailing row is now impossible by construction. Above 1260px the
  packer's rows are what the reader sees; at or below it every component takes
  the full row, where the invariant holds trivially.
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
- **At or below 1260px every component takes the full row.** An earlier revision
  of this branch had no rule here and claimed six columns "hold down to 760px".
  That was false, and measuring it disproved it: at 761px the map and the ranking
  came out 214.6px each, the ranking's content was 40px wider than its own panel,
  and the document gained 9px of horizontal scroll. CSS cannot rescue this by
  narrowing spans, because the packer fixed the rows at six columns — mapping a
  half to a third leaves a row summing to nine, which wraps ragged. Panel widths
  for the map, base against this branch:

  | Viewport | Base `73ff42c` | Branch, no rule | Branch, with the rule |
  | -------- | -------------- | --------------- | --------------------- |
  | 761px    | 445.1px        | 214.6px         | 445.1px               |
  | 800px    | 481px          | 232.5px         | 481px                 |
  | 900px    | 573px          | 278.5px         | 573px                 |
  | 1049px   | 710.1px        | 347.0px         | 710.1px               |
  | 1051px   | 469.3px        | 348.0px         | 711.9px               |
  | 1260px   | 597.5px        | 444.1px         | 904.2px               |

  **1260px is measured, not chosen.** It is the widest viewport at which half the
  grid is narrower than 445px — the map width the base stylesheet gave at its own
  narrowest point. Above it a half is 445px or more. A first attempt put the rule
  at the existing 1050px query, which left the map at 348px between 1051px and
  1260px; that is the width this repository elsewhere calls too small for a map,
  and it was the wrong place to stop.

- **The station-detail card no longer covers the markers.** `.map-selection`
  used to be absolutely positioned inside the map, so selecting one station laid
  an opaque card over its neighbours. Letting pointer events pass through that
  card made automated clicks succeed, but it did not give a reader a visible
  target: one marker remained completely hidden at 390px, 1261px, and 1300px.
  Packing v1 introduced the desktop cases by narrowing the map, while the mobile
  case also reproduced on `73ff42c`. The card now renders after the map in normal
  flow. Every marker therefore remains both visible and directly operable after
  a selection, and the evidence control in the card remains ordinarily clickable.

## What this does not do

Nothing here reads content, measures rendered height, or reorders anything.
Order is the plan's. Density, placement tendency, and shape — the rest of the
precedent note's sketch — remain unwritten, because the packer does not read
them yet.
