# Session Handoff: what is in flight and what is not yet reviewed

Status: Advisory — state of play, no gate outcome
Date: 2026-08-21

## Scope

This is a queue and a set of open threads, not a restatement of decisions.
Everything decided in this stretch of work lives in ADRs 009 and 010, in
`docs/plans/2026-08-20-precedent-library.md`, and in the code comments beside
the rules themselves. Read those for the _why_; this file exists so that no
part of the _what next_ depends on a conversation transcript surviving.

Written because a long session's context is lossy in a way the session cannot
self-diagnose. The decisions were deliberately put in the repository as they
were made; this closes the small gap that remained.

---

## In flight

**PR #45 — pattern registry.** Green on all seven checks at `fb761be`, not
merged, awaiting a re-review. Its first head carried three review findings
(a real behaviour change wrongly claimed to be none, a lifecycle rule that did
not reach the shipped provider, and a self-contradicting version policy), all
reproduced before being fixed, plus two more that the mutation gate found
during the fix. ADR-010 records each, including the falsified claim rather
than quietly dropping it. **Do not merge before the re-review lands** — that
review is the control that caught all three.

## Merged without review, and worth a post-hoc read

**PR #43 (n-ary composition)** and **PR #44 (honest partial)** went to `main`
on green CI alone. Both have zero reviews. They are load-bearing — #43 made
the source count a policy value and #44 reversed the fail-closed-all rule —
and they merged during the stretch in which the next reviewed PR came back
with three blocking findings. That is not evidence they are wrong; it is a
reason not to assume they are right.

## The error shape to watch for

Three of the findings on #45, and several earlier in the same body of work,
were the same defect wearing different clothes: **a claim verified adjacent to
itself rather than directly.**

- "No behaviour change", on the evidence of 200 passing tests, not one of
  which exercised the thing that changed.
- "The guarantee is the test file", written while a filter's call site could
  have the call removed with every test still green.
- Earlier: assertions using `toContain` on prose that fused two sentences into
  one, which `toContain` is exactly as satisfied by.

The repository already names the general form — an assertion equally satisfied
by the defect and by the fix. What is worth adding is the tell: **when a claim
and its evidence are not the same proposition, say so or close the gap.** The
mutation gate and an outside reviewer are what have actually caught these; a
re-read by the author has not.

---

## The queue

1. **Packing v1** — deterministic grid, per-kind rules, against river,
   enrollment, and combined river+air. This is where the layout constraints
   deliberately left out of a registry entry get their only consumer. Do not
   add them to `PatternEntry` before this slice; ADR-010 explains why.
2. **Replace the seven-keyword `FakePlanningProvider` with real generation.**
   This is the actual hardcoding in the product — seven keyword matches over
   about five pre-written compositions. It is what makes Dasher feel
   menu-driven, and it is not ADR-005, which already permits the generative
   product. Needs the registry first so a generated plan has an envelope to be
   scored against, with abstention as the switch: generate, and if the result
   fails the envelope, fall back to the nearest entry and say so.
3. **A third source domain** — turns `MAX_COMPOSED_SOURCES = 3` from an
   argument into an observation. Look at a three-voice freshness label against
   the contract's 256-character short-text limit and decide the ceiling from
   that. Also exercises the honest partial at N=3.
4. **Telemetry, the one-instrument slice** — persist refinements, keep/discard
   events, spec tree-edit-distance. Nothing after the registry should ship
   without it, or the registry's value stays an argument.

Independently valuable, and (3) can go first if the ceiling should be settled
before the generation work starts.

## Smaller open threads

- A third `dataMode` value for official snapshots (UCR).
- Whether `dataMode` becomes per-source. ADR-009 raised the pressure: with
  per-source degradation the sources that load may not be the ones that share
  a mode, so the composer's mode-disagreement refusal can fire on a subset the
  reader never chose.
- Whether an absence deserves a component rather than prose. It has no
  evidence to cite, and every component kind requires at least one evidence
  reference, so today it lives in the notice, the brief, the freshness label
  and the title. Do not build it speculatively — wait for evidence that the
  prose is being missed.
- `compile.ts` — "1 item need attention" pluralisation. Rides with the next
  planner-touching PR.
- `docs/plans/2026-08-20-precedent-library.md` still says v3 in its status
  line though its content is effectively v4.

## Deferred registry fields and their triggers

From ADR-010, repeated here only because the trigger is the part that gets
lost: each of these is absent because nothing would read it.

| Field                        | Arrives with                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Layout constraints           | Packing v1                                                                                       |
| Exemplars                    | A plan vocabulary with per-section options — until then a fragment for one section _is_ its name |
| Facets                       | The blueprint layer (stage 3)                                                                    |
| A richer trigger fingerprint | A real generator                                                                                 |
| `maxPerDashboard`            | The first kind that legitimately repeats                                                         |
