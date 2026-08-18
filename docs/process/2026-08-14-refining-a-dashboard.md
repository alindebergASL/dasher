# Refining a dashboard by prompt

Status: Applied — a reader can change a dashboard on screen without rebuilding it
Date: 2026-08-14

## What was missing

`PRODUCT_REQUIREMENTS.md:140` has always said users refine by prompting rather
than by dragging a canvas. Until now they could not. A request produced a
dashboard and that was the end of the conversation: to change one thing you
rewrote the whole brief and took whatever came back, including the parts you had
been happy with.

The revision loop existed, but it was Dasher talking to itself — the planner
proposes, validation refuses, the planner repairs. There was no channel for the
person reading the result.

## Two correction channels, deliberately not one

The new `PlanningRefinement` sits beside the existing `PlanningRevision` in
`PlanningRequest`, and the temptation to merge them is worth naming, because they
have nearly the same shape:

|                        | `PlanningRevision`            | `PlanningRefinement`              |
| ---------------------- | ----------------------------- | --------------------------------- |
| Who is correcting whom | Dasher correcting the planner | a person correcting the dashboard |
| Content                | structured `PlanFinding[]`    | free text, reader-authored        |
| Trust                  | machine-generated, ours       | untrusted, same as any request    |
| Obligation             | the planner must comply       | the planner may interpret         |
| Lifetime               | one attempt                   | standing, across all attempts     |

Merging them would have made the loop's own audit trail lie: "attempt 2 after
findings" and "attempt 1 of a change the reader asked for" are the same shape and
opposite claims about who was wrong.

They also co-occur. A refinement whose first plan is rejected arrives carrying
both, which forces two decisions the tests pin:

**The refinement is standing intent, not a one-shot.** `runPlanner` hands it to
the provider on every attempt. Dropping it after the first would mean a
refinement whose first plan was refused quietly reverted to the dashboard the
reader had just asked to change — and reported success, because a plan was
produced.

**Findings are repaired before the instruction is re-read.** Refinement edits
`previousPlan`, which does not change across attempts. A provider that reads the
instruction first re-proposes the same rejected plan every attempt and exhausts
the budget without ever acting on the findings. This is not hypothetical: the
plan a refinement carries can itself be unacceptable — a stale gauge selection,
or a plan a client handed back doctored — and `refine.test.ts` drives exactly
that case. The first ordering test written for this did _not_ catch the swap;
inverting the order in the provider left it green. It was replaced with one that
does.

## The round trip through the browser

Refinement needs the plan behind the dashboard on screen, and the server holds no
session, so the plan goes to the client and comes back.

The alternative was replaying the whole conversation server-side — original
request plus an ordered list of instructions — which has no untrusted-plan
channel at all. It was rejected because it does not survive contact with a real
provider: replay assumes determinism, and each replay would re-pay for every
earlier turn.

So the plan round-trips, and the boundary is `refineDashboard`'s first act:

```ts
const parsed = DashboardPlanSchema.safeParse(previousPlan);
```

Parse, don't trust. What comes back is a `DashboardPlan` because the schema said
so, not because of where it arrived from. A server action is a public endpoint —
anything that can reach the page can call it with anything — and this is the
first one here that takes a structured argument rather than a string.

The round trip is safe in a second way, which is the more interesting one: a plan
carries composition only. Even a doctored plan can change which sections appear,
and it then goes through the site check, the free-text gate, the trusted
compiler, and the dashboard contract exactly as a provider's own output does.
`actions.test.ts` drives the realistic attack — take a plan the server issued,
edit one string to `"Sacramento at 12.4 ft"`, hand it back — and the free-text
gate refuses it. The schema alone would not have: every field is a legal string.

## The fake provider's refinement pass

Keyword matching over the instruction, applied to the previous plan: remove or
add a named section, collapse to one page, narrow to a named river.

Two properties matter more than the vocabulary:

**It edits rather than re-composes.** "Drop the map" must not silently
reorganise everything else — the reader is looking at the rest and did not ask
for it to move.

**An instruction it cannot interpret changes nothing, and says so.** The
alternative — quietly re-composing — would show the reader a different dashboard
with no explanation of why. `PlanResult.unchanged` carries that back and the UI
says it in words, with a hint that naming a section works better than describing
a mood.

It also refuses to empty the dashboard. "Remove the map and the table and the
summary" leaves a summary standing, because a finding the reader cannot act on is
worse than a dashboard that kept one panel.

This is still a stand-in. It exists so the loop is testable without a model, not
because keyword matching is the product.

## The mobile constraint that caught a regression

`globals.css` documents that on small screens the request control becomes a fixed
bottom strip specifically so it takes no layout height above the dashboard, and
an e2e test asserts the executive brief still fits the viewport.

Adding a second control in the flow broke it, and the test said so. The fix is
not a second fixed strip — two would eat the viewport — but `order: 1` on the
flex column, moving the refinement control below the pages it changes. The rule
the original pinning existed to satisfy is preserved; the mechanism differs.

Worth recording because the constraint was only discoverable from a comment and a
test. Neither the feature nor the CSS made it obvious.

## What this does not change

Every number is still computed by the trusted compiler. `refine.test.ts` pins
that a refined dashboard's readings are identical to the original's, and
`actions.test.ts` pins that a relabelled plan changes the title and nothing
numeric.

The reader's instruction is untrusted text of exactly the same standing as the
original request. A provider that complied with "put the current level in the
title" would be caught by the same gate that catches it on a first draft, and is.

## What still caps how many dashboards Dasher can make

Refinement makes the planner conversational. It does not widen what can be
composed, and it is worth being exact about where that ceiling actually is,
because it is not the planner:

- **Eight section kinds.** Every dashboard is a permutation of eight components
  over at most four pages. `PLAN_SECTION_KINDS` is the real vocabulary limit.
- **One domain.** `compilePlan` is written against `RiverGauge` and
  `GaugeMetrics`. A dashboard about anything other than a river has nowhere to
  compile to.
- **One source.** A committed USGS fixture, in fixture mode.

A better planner — including a real model — makes better choices within that
vocabulary. It does not add a word to it. "Many more dashboards" is a
component-library and domain-binding problem, and naming it here is meant to stop
it being mistaken for a planning problem later.
