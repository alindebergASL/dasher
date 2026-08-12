# How Dasher Drifted

Status: Root-cause analysis — advisory, no gate outcome
Date: 2026-08-12
Reviewed commit: `d01eedce8bff84d54dd79f98d9b3b95e9d40dcdd`
Relates to: [Efficiency review](2026-08-12-project-efficiency-review.md),
[Scope baseline](../status/2026-08-12-scope-baseline.md),
[ADR-006](../architecture/ADR-006-schema-freeze-point.md)

## Why this document exists

The efficiency review measured what happened. The scope baseline measured what
remains. Neither explains **how a careful team building carefully arrived
somewhere it did not intend to go**, which is the more useful question, because
symptoms recur if the mechanism survives.

This is an explanation, not an indictment. Every link in the chain below was a
locally reasonable decision. That is precisely what makes it drift rather than
error.

## The origin was healthy

The first implementation plan, `2026-07-29-river-dashboard-foundation.md`, is
**213 lines**. It has a clear goal, an honest in-scope and out-of-scope list, and
seven tasks. From it, commit `41ff309` produced **8,122 lines across 44 files** —
the entire river dashboard, the schema contract, the renderer, the evidence
drawer, the Architecture dialog, and the test suite.

That plan is a good plan. Nothing about it needs defending.

The same is true of the two that followed. `2026-07-30-executive-brief-gate.md`
is 168 lines; `2026-07-30-foundation-pr-readiness.md` is 247. Together with the
first they total **628 lines of plan**, and together they produced **the entire
product surface that exists today**.

## The inflection point

| Plan                                                            | Lines | Produced                           |
| --------------------------------------------------------------- | ----- | ---------------------------------- |
| `2026-07-29-river-dashboard-foundation.md`                      | 213   | the working dashboard              |
| `2026-07-30-executive-brief-gate.md`                            | 168   | the executive brief                |
| `2026-07-30-foundation-pr-readiness.md`                         | 247   | hardening and CI                   |
| **— inflection —**                                              |       |                                    |
| `2026-07-30-product-spine.md`                                   | 1,841 | Gate 2-A identity and tenancy      |
| `2026-08-01-dashboard-lifecycle-and-agent-harness.md`           | 1,949 | migration `0003`                   |
| `2026-08-04-agent-run-ledger-and-deterministic-calculations.md` | 6,471 | `0007`, `0008`, calculation engine |

628 lines of plan produced everything a user can see. The following **10,261
lines produced nothing a user can see.** Specification grew roughly sixteenfold
while product surface grew not at all.

The drift is not at the origin. It begins between `foundation-pr-readiness` and
`product-spine`, on 2026-07-30 — the same day ADR-003 was accepted.

## The causal chain

Six links. No link is wrong on its own.

**1. The executor is an agent.** Chosen on day zero: every plan opens with
"**For Hermes:** Use subagent-driven-development skill to implement this plan
task-by-task." Fifty of the seventy-one commits at the reviewed baseline are
authored by `Hermes Agent`. This was a good choice — it produced 8,122 working lines from a 213-line plan.

**2. Work shifted from product to infrastructure.** ADR-003 established that
tenancy must precede real customer data. That is correct. The team moved from
building the dashboard to building the platform beneath it.

**3. Infrastructure has no user to act as the specification.** This is the hinge,
and nobody decided it. When the work is a dashboard, "does it render the right
thing" is answerable by looking. When the work is a row-level-security policy,
correctness is only answerable by enumeration. The acceptance criteria stopped
being observable and had to be written down instead.

**4. An agent executor plus no observable acceptance forces exhaustive
specification.** If the implementer cannot be relied on to exercise judgment in a
gap, the specification must contain no gaps. Hence
"there is no 'minimal now, secure later' exception" and "any omission is HOLD
before `0003` bytes freeze." Rational for that combination. Fatal to iteration.

**5. Exhaustive specifications make review too expensive to perform, so review
became attestation.** `3a031f0` is +56,395 / −459 and carries `SPEC-APPROVE` and
`SEC-APPROVE`. No one read that diff. And because the reviewers are themselves
agents, model agreement quietly became the verification substrate.

**6. Immutability locked the results in.** Whatever the exhaustive specification
produced became permanent on write, because migrations froze at authorship rather
than at deployment. See [ADR-006](../architecture/ADR-006-schema-freeze-point.md).

## The mechanism, in one sentence

**An agent wrote the specification, an agent implemented it, an agent reviewed
it, and the result was frozen — with no point at which reality could push back.**

That loop has no external corrective signal. The two signals available to this
project were a user and a running deployment. The user is deferred to Gate 4;
deployment has never been performed. So errors could not be detected, only
accumulated.

Every headline number in the efficiency review is a measurement of that
accumulation:

- 49% of commit subjects are corrections;
- three of eight migrations exist only to correct earlier migrations;
- 30% of every line ever written to `migrator.ts` has been deleted;
- Task 8A was declared closed four times.

Those are not sloppiness. They are what a closed loop looks like from the outside.

## One root cause with three faces

Model agreement substituting for human judgment appears in three separate places,
and each was accepted on its own terms:

1. **Gate 1 validation** — six agents, four of them Claude-family, standing in for
   six people. Honestly labelled, and still accepted as a product gate.
2. **Pull request review** — `SPEC-APPROVE` and `SEC-APPROVE` attestations on
   diffs of 47,000 and 56,000 lines.
3. **Documentation gates** — "exact-tree dual review" and "independent
   specification then code-quality review", both performed by agents.

Treating these as three separate observations misses that they are one
substitution made three times. Retiring the technique at Gate 1 while leaving it
in the review path fixes a third of the problem.

## Gate proliferation

The roadmap defines 8 gates. The lifecycle plan adds a documentation gate, a
PostgreSQL gate, a PR gate, and four measurable stage gates. Task 9 adds its own
acceptance gates and a planning-PR gate. Gate 2 later turns out to contain a
Gate 2-A and an unnamed remainder.

Roughly **nineteen gates** now exist. Nobody decided to have nineteen. Each was
added because the previous one did not cover something, which is the signature of
gates being used to compensate for the absent external signal in the mechanism
above.

## The evidence from this engagement

The planner spike built during this review is a small controlled test of the
thesis. It took a few hours, and running it in a browser surfaced three defects
that no amount of specification had caught or would have caught:

- a CSS class collision that silently broke the dashboard's two-column layout;
- a dropped feature — user-defined threshold alerts vanished from the rendered
  output;
- a mobile regression that pushed the executive brief outside the first viewport,
  violating a real product requirement.

All three were found by **looking at the running thing**. None is the kind of
defect enumeration finds, because each lives in the gap between components that
are individually correct.

This is not an argument that specification is worthless. It is evidence that
specification and execution detect **different classes of defect**, and that this
project has been running on one of them for two weeks.

## What was not drift

The drift is confined to method and sequencing. It did not touch:

- **`river-domain`** — clean, honest domain code that refuses to state a trend
  from stale data.
- **`dashboard-schema`** — a genuinely well-designed validation contract that
  caught real errors in the spike.
- **ADR-003 and ADR-004** — decision-dense, rigorous, with alternatives sections
  that give real reasons for real rejections. ADR-004's credential disposition
  table is better than most companies ever produce.
- **The honesty of the documentation** — every overclaim in this project is
  labelled as one by the project itself. That is rare and it is why this analysis
  was possible at all.

The engineering judgment is sound. The loop it was operating in was not.

## What breaks the loop

One thing, not many: **reintroduce an external corrective signal, early and
permanently.**

Concretely, and in order of leverage:

1. **Something runs, and someone looks at it.** The spike now connects a request
   to a rendered dashboard. Keep that path working and exercised on every change.
2. **Deploy something, anywhere.** Nothing has ever been deployed. A deployment
   is a signal generator — it produces defects that no specification anticipates.
   It also creates the Freeze Point that makes immutability meaningful.
3. **Put a human in front of it.** Five manager-shaped people on synthetic data.
   This is the signal the roadmap defers to Gate 4 and that the six-agent
   rehearsal was an attempt to simulate.
4. **Stop using model agreement as verification** in all three places, not one.
5. **Cap diffs at a size a person will actually read**, so that review is a
   signal rather than a ritual.

The specification discipline does not need to be abandoned. It needs something
outside itself to check it against.

## What this document does not claim

It does not claim the infrastructure work was wrong to do, only that it was done
without a corrective signal. It does not evaluate the correctness of any schema,
policy, or contract. It makes no estimate of remaining effort. It passes and
fails nothing.
