# Agent-Loop Retrospective, 2026-08-21

Status: Advisory — retrospective, no gate outcome
Reviews the work merged as PRs #43, #44 and #45, and the open PR #47.

## Scope

This is a retrospective, not a live handoff. An earlier draft tried to be both
and could not stay true for a day: it recorded which pull requests were open,
and they closed.

Nothing here restates a decision. Those live in ADR-009, ADR-010,
`docs/plans/2026-08-20-precedent-library.md`, and the comments beside the rules
themselves. What is here is what that body of work revealed about how it was
made — checked against `docs/process/2026-08-12-working-practice.md`, the
doctrine this project adopted after the drift analysis.

**Factual claims use immutable repository evidence where it exists** — an
immutable command anyone can re-run. **Observations not independently
recoverable from the repository are identified as session observations where
that distinction matters.**

That is a weaker promise than the first version of this file made, which said
every claim was labelled as one or the other. It was not, and it could not
sensibly be: a retrospective is largely interpretation, and labelling every
sentence would be ceremony rather than rigour. The promise was itself the defect
this document is about — a claim that outran what was behind it — which is worth
recording rather than quietly narrowing.

## State at the time of writing

Immutable references, so this paragraph stays readable after it stops being
current.

|                                  |                                                      |
| -------------------------------- | ---------------------------------------------------- |
| PR #45, pattern registry         | merged at `cf3279224c56cb1bae5bee8ddc400cdf1de8be8f` |
| `main` after that merge          | `e3303d7c11acd9aebb34300bba0a2e6a2ca9fc4a`           |
| PR #47, composition member order | open; a **proposed** correction                      |

**`main` still carries the PR #44 ordering defect** until #47 merges. PRs #43
and #44 merged earlier, both with zero reviews.

---

## 1. A claim verified adjacent to itself

The defect that recurred most, in four distinct forms.

- **"No behaviour change"**, offered on the evidence of 200 passing planner
  tests — none of which asked for more sections than a plan had slots, which was
  the thing that changed. A reader asking to add two sections to a nearly full
  dashboard got a different one of them before and after.
- **"The guarantee is the test file"**, written while a filter's call site could
  have the call removed with every test still green.
- **`toContain` on prose that fused two sentences into one**, which `toContain`
  is exactly as satisfied by as it is by the correct output.
- **Two code comments left behind by the fixes they described.** Both were
  accurate when written. One credited the wrong function with enforcing a rule;
  one described a repair request the run loop does not make.

The repository already names the general form — an assertion equally satisfied by
the defect and by the fix. The addition worth keeping is the tell: **when a claim
and its evidence are not the same proposition, say so or close the gap.**

_Session observation:_ every one of these was found by an outside reviewer or by
the mutation gate. None was found by the author rereading their own work.

## 2. A claim the data structure could not satisfy

Sharper than the above, and PR #44 is the case. ADR-009 said an absence "keeps
its place in every attributed line". The implementation carried absences in a
separate array beside the loaded sources, and **two lists cannot interleave**. A
reader who asked for river conditions and air quality on a day the river gauge
was down got a dashboard whose executive brief, next action, freshness label and
architecture summary each began with the source that _did_ load, and ended
"River: unavailable" — the subject they had asked about, moved to the end of
every line.

**A test would have exposed this immediately** — PR #47 contains exactly such a
test, and a mutant reproducing the two-list arrangement dies against it. What no
test could do was make the property PASS: satisfying it required a structural
correction, a single ordered member type, not a stronger assertion over two
lists. An earlier draft of this file said "no test would have saved this", which
understates the role of a failing test and is contradicted by the correction it
was describing.

The tell is therefore not "tests cannot help here". It is: **when a document
describes a structure, check the structure exists.** The gap was that nobody
wrote the discriminating test, and the reason nobody wrote it is that every
fixture put the absence last — the one arrangement in which the two
implementations agree.

## 3. Green CI is not evidence

PRs #43 and #44 merged on green CI alone, with zero reviews. Both passed every
gate this project has, including mutation. One of them shipped the defect in §2 —
visible in the first sentence a reader would see.

_Repository-verifiable._ Review counts and merge states are recoverable from the
GitHub API for those PR numbers.

## 4. Where this work reverted from the working practice

`docs/process/2026-08-12-working-practice.md`, checked point by point.

### §1 — it built a layer and called that a virtue

The doctrine: _"A layer cannot be used. There is no point at which it is
demonstrable, so there is no point at which reality can correct it."_

The pattern registry's headline claim was **no behaviour change**, offered as
evidence of a careful consolidation. Under §1 that is the diagnostic, not the
virtue.

_Repository-verifiable:_ CI accepted the first head; later review produced a
concrete failing case on the one part that did touch behaviour, and the fix and
its discriminating test are in the merged history.

_Correction to an earlier draft:_ that draft said the registry's "one behavioural
consumer is the model prompt". False of what merged. The merged registry supplies
the schema's section vocabulary, the validator's needs-a-station rule, the model
prompt's guidance, the refinement lifecycle gate, the deterministic provider's
composition filter, and the empty-plan fallback. The layer critique stands on the
first head (`16d3f1bf1b9a8c798236568615d124ce31b175f4`); it does not describe the
merged result.

### §2 — "done" stopped meaning demonstrated

The doctrine: _"A task is not finished until someone has looked at the thing it
changed, running."_ And where that looks impossible: _"the constraint is
informative rather than obstructive — it means the slice was drawn along a layer
boundary and should be redrawn."_

_Repository-verifiable._ No end-to-end spec changed across all three pieces of
work:

```bash
git diff --name-only \
  9f48cf001c34c3e5afe542a96803798fc9730814...cf3279224c56cb1bae5bee8ddc400cdf1de8be8f \
  -- apps/web/e2e/
```

Returns nothing. That range starts at the merge of PR #42 and ends at the merged
head of PR #45, spanning #43, #44 and #45 entire.

The honest partial (#44) is the sharpest case, and the argument for skipping its
browser proof is recoverable from the code rather than only from the session:
fixture mode never fails a source, so reaching a partial dashboard in a browser
requires either live credentials or a test seam in shipped code. Granting that,
the conclusion still inverted the doctrine — impossibility was treated as
permission to skip the proof, where §2 says it is the signal to redraw the
slice.

### §3 — the check that cannot be faked

The doctrine, on the agentic loop: _"The implementer's only current self-check is
a test suite it wrote itself. That is a closed loop in miniature. A browser is
not."_

_Repository-verifiable:_ no browser evidence and no new browser scenario was
committed across that range (same command as §2).

_Session observation:_ the mutation gate stood in for it. That is a stronger
closed loop, not an open one — it runs over code the same author wrote, against
tests the same author wrote. Whether any manual browser check happened is not
something the repository records either way.

### §4 — review asymmetry, given away in the PR bodies

The doctrine: _"Give the reviewer only the invariants and the diff — never the
implementation plan, the author's reasoning, or the conversation that produced
it."_ The asymmetry that matters is context.

_Repository-verifiable._ The PR bodies for #43–#45 are long author narratives:
alternatives rejected, mutants run, conclusions drawn. A reviewer opening one is
handed the author's frame before seeing a line of the diff.

_Session observation:_ the reviews that found the defects found them by running
the code, and one PR body's confident "no behaviour change" pointed away from the
defect it was concealing.

### §7 — owner attention went on prose

The doctrine: _"Owner attention is the constraint, not agent throughput… cap what
reaches the owner."_ And it names the plan-to-code ratio as _"a cheap early
warning."_

_Repository-verifiable_, from the merged PR #45:

```bash
git diff --numstat \
  1da592b5f985f0f25f83b0a493e45f0b0fa96c13...cf3279224c56cb1bae5bee8ddc400cdf1de8be8f \
  | awk '{a+=$1} END {print a}'                      # 1500 additions
```

Of those, **1,251 are TypeScript and 248 are Markdown**. The house style is
deliberately comment-heavy and that is not the complaint.

_Repository-verifiable:_ the diff grew across three correction rounds — the same
figures recomputed at `16d3f1b`, `233a0e9` and `cf32792` differ — and each round
was a response to review. §7 names the ratio as the early warning; what the
repository shows is that it moved.

_An earlier draft published a finer breakdown — comment lines against code lines
— computed from the first head and never recomputed. Removed rather than
refreshed: a ratio quoted to four figures invites more confidence than an ad-hoc
`grep` over a diff can carry._

## 5. "No indirection ahead of evidence", applied inconsistently in one file

Not from the working practice but from the codebase's own rule, in
`source-runtime.ts`: _"the day a third source makes this painful is the day the
abstraction has evidence behind it."_

In `registry.ts` that rule was applied to `maxPerDashboard` — left out because
eight identical fields would be indirection ahead of evidence — and violated in
the same file for the deprecation lifecycle, which shipped a status field, three
enforcement gates and their tests while **no entry is deprecated**. Both
decisions are argued in ADR-010; neither argument mentions the other.

That machinery then did the damage the rule exists to prevent. The composition
filter absorbed two classes of real defect the plan schema had been catching — a
section name replaced with `""`, and a page's sections replaced with `[]`. Both
were caught, but only by the mutation gate, and only after the score fell.

_Correction to an earlier draft:_ that draft said "two filtering functions and
six tests". The merged lifecycle has **three** enforcement gates — `offeredEntries`,
`readRefinementIntent`'s addition gate, and `retainOffered` — and considerably
more call-site coverage. See ADR-010.

## 6. A survivor is evidence, including about a comment

The mutation gate flagged an optional-chaining survivor on the empty-plan
fallback. It was dismissed as an equivalent mutant. It was not equivalent: the
line's own comment promised that a deprecated section could not become the
fallback, and the `??` branch beside it did exactly that.

**A survivor on a line whose comment makes a promise is evidence about the
promise.** A second survivor in the same round really was unreachable, and that
line was deleted rather than left uncoverable — which is the other half of taking
the gate seriously.

## 7. A risk rather than an error

Keyword matching now has a governance process. Moving the trigger words into the
registry gave them per-entry tests, a collision invariant and a version policy.
That is tidier, and it makes the keyword matcher **harder to remove** immediately
before the slice whose purpose is to remove it.

Worth watching when the deterministic provider is replaced: the registry should
end up describing what a generator may compose, not preserving how the keyword
matcher used to guess.

---

## What was deferred, and what brings each one back

From ADR-010, repeated here for the **triggers** — the part that gets lost is
when a thing arrives, not why it is absent.

| Deferred                     | Arrives with                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Layout constraints           | Packing v1, its only consumer                                                                    |
| Exemplars                    | A plan vocabulary with per-section options — until then a fragment for one section _is_ its name |
| Facets                       | The blueprint layer                                                                              |
| A richer trigger fingerprint | A real generator                                                                                 |
| `maxPerDashboard`            | The first kind that legitimately repeats                                                         |

## Where the forward queue lives

Not here. An earlier draft carried a list of next slices, which duplicated the
Staging section of `docs/plans/2026-08-20-precedent-library.md` and went stale
faster than that note did. One copy, in the document that owns the decision.

## Open questions this work raised

- Whether an absence deserves a rendered component rather than prose. It has no
  evidence to cite, and every component kind requires at least one evidence
  reference. Do not build it speculatively — wait for evidence that the prose is
  being missed.
- Whether `dataMode` becomes per-source. ADR-009 raised the pressure: with
  per-source degradation, the sources that load may not be the ones that share a
  mode.
- Where `MAX_COMPOSED_SOURCES` should actually sit. It is 3 because that is one
  more than two, not because 3 was measured.
