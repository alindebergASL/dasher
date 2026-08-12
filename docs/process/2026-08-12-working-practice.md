# Working Practice: How to Make This Better

Status: Advisory — recommendations, no gate outcome
Date: 2026-08-12
Relates to: [How Dasher drifted](../review/2026-08-12-drift-analysis.md),
[Proposed re-sequencing](../roadmap/2026-08-12-proposed-resequencing.md)

## Scope

Forward-looking only. This does not restate the efficiency review's findings, the
scope baseline's inventory, the re-sequencing proposal's P1–P8, ADR-006's
immutability tiers, or the amendment's product decisions. Those stand on their
own.

This is about how the work is done from here, and in particular how to run an
agent-driven build so it produces a product rather than a specification.

---

## 1. Build slices, not layers

The project builds layers: identity complete, then lifecycle complete, then
ledger complete, each finished before the next. **A layer cannot be used.** There
is no point at which it is demonstrable, so there is no point at which reality
can correct it. That is the structural reason 95% of the codebase is unreachable
from the running program.

A slice is one narrow path all the way through — request, plan, validate, render,
persist, reload, refresh — narrow enough that most of each layer is missing, whole
enough that a person can use it end to end.

The planner spike is an accidental proof. It is a slice, it is thin, it works, and
running it immediately produced three defects.

Concretely, the next unit of work should be shaped like _"a dashboard survives a
page reload."_ That forces one table, one repository call, one route, and one
round trip, and it is finishable. It is not shaped like _"the agent run ledger,"_
which forces budgets, leases, epochs, checkpoints, replay, claims, and evidence
manifests to all be right simultaneously and delivers nothing observable when
they are.

## 2. "Done" must mean demonstrated

Today done means merged, reviewed, and gates green. Nothing in that definition
references a running system or a person, which is how 209,000 lines can be done
with no product.

Add one clause: **a task is not finished until someone has looked at the thing it
changed, running.**

Where that seems impossible, the constraint is informative rather than
obstructive — it means the slice was drawn along a layer boundary and should be
redrawn. This is the cheapest structural change available here, and it makes
several other mechanisms unnecessary.

## 3. Specify invariants, not implementations

The Task 9 plan specifies exact SQL, exact function bodies, exact assertions, and
exact byte vectors. At that resolution the engineering has already been done by
the specification author, and the agent contributes typing speed. The result is
also unreviewable, because the specification is as long as the code.

Invert it. Specify **invariants and interfaces**; let the implementation be
chosen.

> No query may read another organization's rows under any role, including one
> revoked mid-transaction.

is a specification. Fifty enumerated catalog assertions are a transcript of one.

Verification then comes from adversarial tests rather than from comparing text to
text — which is what the PostgreSQL gate already does well, and what the
hand-authored manifest does badly.

## 4. Make review adversarial through information asymmetry

Retiring model agreement is necessary but not sufficient; something has to
replace it. Two reviewers reading the same specification and agreeing is not
independence.

**Give the reviewer only the invariants and the diff** — never the implementation
plan, the author's reasoning, or the conversation that produced it — and require
a concrete failing case as output. A review that cannot name inputs and
expected-versus-actual is not a review.

The asymmetry that matters is context, not model identity. A fresh reviewer with
no memory of how the code came to be is a genuinely different observer, even
running the same weights.

## 5. Keep a register of what is deliberately not verified

Every gate here lists what must pass. None lists what is knowingly accepted as
unverified. With no way to say "we accept this risk," the only available move is
another gate — which is why roughly nineteen now exist.

A short, dated, owner-signed list — _no load testing before pilot; no
disaster-recovery drill before real data; no formal verification of the
calculation AST_ — lets gates shrink instead of multiply. It also makes the risk
posture legible to an enterprise buyer, which is worth more than another passing
gate.

## 6. Make the fake provider permanent, not a phase

Fake-provider mode is currently a stage to pass through before live inference.
Make it the **permanent test substrate**: every test runs against fakes, and live
is a configuration switch and nothing more.

Two payoffs. The provider evaluation harness required by the amendment becomes
nearly free, because the comparison rig already exists. And the test suite never
requires credentials, which is what makes most integration suites rot.

## 7. Owner attention is the constraint, not agent throughput

Agent capacity is effectively unbounded here: 209,000 lines in 13 days. Owner
review capacity is not, and the current process spends it reading 10,261 lines of
specification.

That is the wrong allocation. Owner attention is uniquely valuable for exactly
two things — looking at running software and judging whether it is any good, and
making the decisions only the owner can make. Hours spent reviewing an exhaustive
plan buy neither.

Practically: cap what reaches the owner. Plans short enough to read in one
sitting. Diffs small enough to actually read. Everything else verified
mechanically — and where it cannot be, that is the signal the slice is too large.

---

## What this means for the agentic coding loop specifically

Most of the above is about the loop rather than about Dasher. Five points are
particular to running an agent as the implementer.

### The context window is a correctness constraint, not just a cost

A 6,471-line plan does not fit usefully in working context alongside the code it
describes. The implementer ends up working from fragments of its own
specification, which is a mechanical reason exhaustive plans produce **worse**
output rather than better. Shorter contracts mean the whole contract is held at
once, which is exactly when gap errors stop happening.

This inverts the intuition behind the current plans. Detail was added to reduce
risk; past a threshold it increases it.

### Agents enumerate willingly and stop unwillingly

Asked to be thorough, an agent will be thorough indefinitely. The 47×
amplification is partly this characteristic meeting a process with no stopping
rule.

The human's job in this loop is therefore **bounding, not specifying** — and
bounding requires seeing output, which requires slices. An owner who only reads
plans has no basis for saying "that is enough," because a plan always looks
incomplete.

### Give the agent a check it cannot fake

The implementer's only current self-check is a test suite it wrote itself. That
is a closed loop in miniature.

A browser is not. During this review, driving the running app in Chromium
surfaced a CSS collision, a dropped feature, and a mobile regression — none
findable by any test the same agent would have written, because each lived in the
gap between components that were individually correct and individually tested.

An agentic loop with a real browser, a real database, and screenshots in it is
qualitatively different from one without. That capability already exists in this
repository via Playwright; it is used only for two frozen end-to-end tests.

### Commit granularity is the loop's memory

A 56,395-line commit destroys bisect, revert, and explanation. Small commits are
not only a courtesy to human reviewers — they are how an agent recovers from its
own mistakes, and how anyone later reconstructs why a decision was made.

The subject line matters for the same reason. The largest schema addition in this
project is recorded as a run-lock policy fix and cannot be found from
`git log --oneline`.

### Plan-to-code ratio is a health signal worth watching

The first plan was 213 lines and produced 8,122 lines of working product. The most
recent is 6,471 lines and has so far produced no product surface at all.

That ratio, tracked over time, is a cheap early warning. When specification grows
faster than demonstrable capability, the loop has closed and no individual
decision will look wrong.

---

## What not to change

The safety invariants were never the problem and should not be relaxed to buy
speed: forced row-level security, composite tenant foreign keys, restricted
runtime roles, audit atomicity, record immutability, the closed generated-code
gate, and the rule that deterministic services compute every displayed value.

Nor should the documentation's honesty change. Every overclaim in this project is
labelled as one by the project itself, which is rare and is the reason any of this
analysis was possible.

The engineering judgment here is good. What needs changing is the loop it runs
in.
