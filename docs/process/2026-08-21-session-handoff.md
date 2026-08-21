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

(The doctrine-level drift is in its own section below; this is the narrower
defect pattern.)

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

## Where this work drifted from the working practice

`docs/process/2026-08-12-working-practice.md` is the doctrine this project
adopted after the drift analysis. Checked against it rather than against
recollection, this stretch of work reverted on five of its points. Each item
below is stated so it can be verified from the repository, not taken on trust.

### 1. It built a layer and called that a virtue (§1)

The doctrine: _"A layer cannot be used. There is no point at which it is
demonstrable, so there is no point at which reality can correct it."_

The pattern registry is a layer. Its headline claim was **no behaviour
change** — offered as evidence of a careful consolidation. Under §1 that is
not a virtue, it is the diagnostic. Its one behavioural consumer is the model
prompt, on a path unreachable in the shipped product.

What followed is what §1 predicts. Reality did not correct it. A reviewer did,
and only on the single part that did touch behaviour — a refinement-ordering
change that the registry's own 248 tests could not see.

### 2. "Done" stopped meaning demonstrated (§2)

The doctrine: _"A task is not finished until someone has looked at the thing it
changed, running."_ And, on the cases where that looks impossible: _"the
constraint is informative rather than obstructive — it means the slice was
drawn along a layer boundary and should be redrawn."_

`git diff --name-only 1da592b~2 origin/claude/pattern-registry -- apps/web/e2e/`
returns **nothing**. Three consecutive pieces of work — the n-ary refactor, the
honest partial, and the registry — touched no end-to-end spec at all.

The honest partial is the sharpest case. Its browser proof was reasoned away on
the grounds that fixture mode never fails a source, so reaching the partial in a
browser would need a test seam in shipped code. That reasoning is sound and the
conclusion still inverted the doctrine: impossibility was treated as permission
to skip the proof, where §2 says it is the signal to redraw the slice.

### 3. The one check that cannot be faked went unused

The doctrine, on the agentic loop: _"The implementer's only current self-check
is a test suite it wrote itself. That is a closed loop in miniature. A browser
is not."_ It records a CSS collision, a dropped feature and a mobile regression
found that way, _"none findable by any test the same agent would have written."_

The mutation gate quietly took the browser's place in this work. It is a good
gate and it caught two real defects here — but it runs over code the same author
wrote, against tests the same author wrote. It is a stronger closed loop, not an
open one. The substitution was never decided; it just happened.

### 4. Review asymmetry was destroyed by the PR bodies (§4)

The doctrine: _"Give the reviewer only the invariants and the diff — never the
implementation plan, the author's reasoning, or the conversation that produced
it."_ The asymmetry that matters is context.

Every PR body in this stretch does the opposite: a full narrative of the
author's reasoning, the alternatives rejected, the mutants run, the conclusions
drawn. A reviewer opening one of them is handed the author's frame before seeing
a line of the diff.

Worth noting precisely: the review that found the three defects found them by
running the code. Nothing in the body pointed at them, and the body's confident
"no behaviour change" pointed away.

### 5. Owner attention went on prose (§7, plan-to-code ratio)

The doctrine: _"Owner attention is the constraint, not agent throughput… cap
what reaches the owner."_ And it names the plan-to-code ratio as _"a cheap early
warning."_

The registry PR adds 1,213 lines. Of the 1,006 that are source, **360 are
comment**; a further 198 are ADR and note prose. `registry.ts` is 274 lines, 131
of them comment. The house style is deliberately comment-heavy and that is not
the problem — the problem is that the ratio moved without anyone deciding it
should, which is exactly the signal §7 says to watch.

### 6. "No indirection ahead of evidence" was applied inconsistently, in one file

Not from the working practice but from the codebase's own rule, stated in
`source-runtime.ts`: _"the day a third source makes this painful is the day the
abstraction has evidence behind it."_

In `registry.ts` that rule was applied to `maxPerDashboard` — left out because
eight identical fields would be indirection ahead of evidence — and violated in
the same file for the deprecation lifecycle, which got a status field, two
filtering functions, a constructor dependency and six tests while **no entry is
deprecated**. Both decisions are argued in ADR-010; neither argument mentions
the other.

That machinery then did the damage the rule exists to prevent. `retainOffered`
absorbed two classes of real defect — a section name replaced with `""`, and a
page's sections replaced with `[]` — that the plan schema had been catching.
Both were caught, but only by the mutation gate, and only after the score fell.

`componentKind` fails the same rule by the note's own standard: its only
consumer today is the test that keeps it true.

### A risk rather than an error: keyword matching got a governance process

`SECTION_WORDS` moved out of the fake provider and into the registry, where it
gained per-entry tests, a collision invariant and a version policy. That is
tidier. It also makes the keyword matcher **harder to remove**, immediately
before the slice whose entire purpose is to remove it. Worth watching when the
provider is replaced: the registry should end up describing what a generator may
compose, not preserving how the fake used to guess.

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
