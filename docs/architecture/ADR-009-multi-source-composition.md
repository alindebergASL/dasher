# ADR-009: A dashboard degrades per source, and names what is missing

Status: Accepted
Date: 2026-08-21
Supersedes: the refuse-as-a-unit rule that shipped with multi-source intake,
which was recorded only in `planCombined`'s own comment and never in an ADR.

## Decision

Two decisions, taken together because neither is safe without the other.

**1. The number of sources a dashboard may combine is a policy value, not a
type.** `ComposedSources` is `readonly ComposedSource[]`; the ceiling is
`MAX_COMPOSED_SOURCES`, currently 3, and every rule inside `composeDashboards`
— namespacing, attribution, evidence interleaving, statement-type merging,
freshness — is written for N. Raising the ceiling is an edit to one constant
and the reasoning beside it.

**2. A combined request degrades per source.** When some of the sources a
request named fail to load, Dasher builds the dashboard from the ones that did
and states, in the spec, which ones did not. It refuses only when _no_ source
loads.

An absence is a first-class member of a composition, not a caller's footnote.
It contributes no page, no evidence and no architecture node — nothing was
fetched, so there is nothing to show — and it does three things:

- it keeps its place in every attributed line, so the brief, the next action,
  the architecture summary and the freshness label all name it;
- it costs the dashboard its `fresh` status and its page-level
  `latestObservationAt`, so a machine reading the spec sees an incomplete page
  without reading prose;
- it is stated in the `notice`, which renders on every page, and in the title.

## Why the unit refusal is being reversed

Refusing was truthful. It was compared against exactly one alternative — a
dashboard titled for two subjects that silently contains one — and against
that alternative it is obviously right. The comparison was the error: there is
a third option, and the second one being unacceptable does not make the first
one best.

The cost of the unit refusal is arithmetic. At 95% per-source availability a
two-source request succeeds 90% of the time, a five-source request 77%, a
ten-source request 60%. Each of those failures throws away every part that did
work, over a fault in a part the reader may not have been looking at. That
cost is what made a large N a different product, and it is the reason the
ceiling could not sensibly move.

The three options, stated plainly:

| Behaviour                             | What the reader gets                          | Honest? |
| ------------------------------------- | --------------------------------------------- | ------- |
| Refuse everything                     | Nothing                                       | Yes     |
| Show what loaded, say nothing         | A narrower answer, presented as the whole one | **No**  |
| Show what loaded, say what is missing | A narrower answer, presented as narrower      | Yes     |

Only the middle row is forbidden, and it stays forbidden.

## What makes the third option hold

Three properties, and the design fails if any one of them lapses:

- **The title names what is on the page.** A partial that kept the whole
  request's title would be the silent partial with extra steps: the first line
  a reader reads would still promise a subject the page does not contain. The
  composed title of a partial is `<what loaded> — <what did not> unavailable`.
- **The absence is stated where the source would have spoken.** This is
  `composeDashboards`' job rather than the caller's, deliberately. Because
  attribution runs over present and absent members together, a source cannot
  be dropped from one surface by someone forgetting it there.
- **All of it lives in the spec.** A dashboard is persisted as canonical spec
  bytes and reopened later with no memory of the request that produced it.
  Anything the renderer knew and the spec did not is gone by then. This is
  ADR-005's "later reconstruct what was known and why" applied to what was
  _not_ known: a partial saved today still says which source was missing when
  it was built, months after that source came back.

The absence text says "unavailable when this dashboard was built" and not
"unavailable right now" for the same reason. Most readings of that sentence
happen in the archive, and it has to be true there.

## What deliberately does not change

- **Nothing is ever substituted.** `source-runtime.ts` still refuses to serve
  a committed fixture in place of a live source. Degrading per source changes
  what a caller does with a `SourceUnavailableError`; it does not introduce a
  fallback.
- **The single-source path still refuses.** One source down with nothing else
  requested leaves no dashboard to be partial about.
- **No source loading at all is still a refusal.** A page of nothing but
  absences is a refusal wearing a dashboard's clothes, and the message a reader
  needs there is the refusal's, not a dashboard's.
- **Composition still never computes.** Each source is compiled by its own
  parser, policy, vocabulary and thresholds, and only finished specs meet.
  Absences do not change that; they subtract from it.
- **Sources must still agree about `dataMode`.** Demo readings beside live ones
  under one banner is refused, not degraded — that is a property of the set,
  not an outage.

## What this leaves open

- **Where the ceiling should actually be.** It is 3 because that is one more
  than two, not because 3 was measured. What binds now is the reader rather
  than the availability arithmetic: every additional voice lengthens the same
  attributed sentences and the same freshness line, both bounded by the
  contract's short-text limit. The next move on this number should come from
  looking at a five-voice freshness label, not from an argument.
- **Whether an absence deserves a visible section rather than prose.** It has
  no evidence to cite — manufacturing an evidence record for something never
  retrieved would be worse than saying nothing — so today it lives in the
  notice, the brief, the freshness label and the title. If readers miss it
  there, the fix is a component kind that can exist without citations.
- **Whether `dataMode` should become per-source.** Recorded already as open
  work; a partial makes it slightly more pressing, because the sources that
  load may not be the ones that share a mode.
