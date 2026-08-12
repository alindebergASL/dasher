# Proposed Re-sequencing of the Private Pilot Roadmap

Status: Proposed — not accepted, not authorized
Date: 2026-08-12
Supersedes: nothing
Relates to: [Private pilot execution roadmap](2026-07-30-private-pilot-roadmap.md),
[Project and process efficiency review](../review/2026-08-12-project-efficiency-review.md)

## Standing

This document proposes a change to execution order. It does not edit, weaken, or
replace the accepted roadmap, and it changes no gate's exit criteria. Until the
owner accepts it, `2026-07-30-private-pilot-roadmap.md` remains the governing
sequence.

No safety invariant is relaxed by anything below. The generated-code gate stays
`CLOSED`. Migrations `0001`–`0008` stay immutable. No proposal here permits real
customer data to enter Dasher before the ADR-003 control-plane gates pass.

## Problem this addresses

The accepted roadmap is a serial chain: Gate 2 (control plane) precedes Gate 3
(sources and jobs), which precedes Gate 4 (customer uploads), which precedes
Gate 5 (the model planning gateway and the ADR-005 harness).

That order puts the product's least-validated assumption last. The measured
consequence at commit `d01eedc` is in the companion review: 13 days, ~209,000
lines, and the running program is still a single fixture page with no input. The
loop the product is named for has not been attempted.

The ordering also front-loads the most expensive machinery in the repository.
Gate 2's schema-verification approach costs roughly 900 lines of TypeScript for
a 20-line SQL change (review, Finding 2), and that cost is being paid before
anything downstream has demonstrated that the schema is the right schema.

## Principle

Order work by **what would most change the plan if it turned out badly**, subject
to the fixed safety constraint that real customer data cannot precede the
control-plane gates.

The accepted roadmap already implies the second half of this. It requires
fake-provider mode to exercise the full request and validation path with _"zero
network and zero credential access"_
(`2026-07-30-private-pilot-roadmap.md:255-256`). Work with no network and no
credentials also needs no tenant isolation, because there is nothing to isolate
and no second tenant. The dependency of Gate 5's first phase on Gate 2 is
therefore incidental to the current ordering, not intrinsic.

## Proposal: two tracks instead of one chain

### Track A — value loop, single-tenant, in-process

Runs against the existing committed fixture with no database, no credentials, no
network, and no persistence beyond process memory. Nothing in this track may
accept real customer data, and nothing in it may ship to a pilot participant.

- **A1 — Fake-provider planning against the fixture.** Implement the ADR-004
  gateway boundary in fake-provider mode only, and the ADR-005 orchestrator's
  minimum viable loop: a plain-language request in, a candidate `DashboardSpec`
  out, validated by `@dasher/dashboard-schema`, rendered by the existing shell.
  The gauges, metrics, and layout are chosen by the planner rather than by
  `river-domain/src/dashboard.ts`'s hardcoded page list.
- **A2 — A request input in `apps/web`.** One text field and a result. This is
  the first time the product's stated wow moment
  (`../product/PRODUCT_REQUIREMENTS.md:46`) exists in executable form.
- **A3 — Structured revision.** Feed one validation failure back and prove the
  planner repairs it. This is the cheapest available test of whether the
  governed-not-template-bound thesis holds.
- **A4 — Single-tenant CSV/XLSX.** The Gate 4 value proof, in-process, with the
  parser isolation and byte-ceiling controls Gate 4 already specifies, but
  without multi-tenant storage. Synthetic workbooks only.

Track A answers one question: does a governed model planner produce a dashboard
a manager finds useful? Every downstream contract in the repository — the
calculation graph registry, the run ledger, the evidence manifest — is currently
specified against an assumed answer.

### Track B — trust plane, gated on real data rather than on all development

Unchanged in content and strictness from accepted Gates 2, 3, and 6. The only
change is what it blocks. Track B remains a hard precondition for:

- any real or customer-supplied data entering Dasher,
- any live provider credential or live source request,
- any deployment reachable by a pilot participant,
- any persistence of a dashboard beyond a process lifetime.

It ceases to be a precondition for exploratory, single-tenant, fixture-only work
that cannot touch those things.

### What this does not change

- Gate 4's real-user comprehension criteria, Gate 5's credential and redaction
  criteria, and Gate 7's entry requirements are untouched. Track A does not
  satisfy any of them, and its results are not evidence for any gate.
- The owner decisions reserved at `2026-07-30-private-pilot-roadmap.md:373-387`
  remain reserved.
- Synthetic validation still does not satisfy a manager-user gate.

## Process proposals

Each is stated with the measurement that motivates it. All are owner decisions.

### P1 — Derive the catalog manifests instead of authoring them

**Now:** the expected schema is hand-typed in `migrator.ts` (twice), in
`modeled-0003-inventory.ts` (twice), and in a JSON fixture, alongside 111
hardcoded SHA-256 literals, per-routine MD5s, and exact file byte lengths. One
function body exists in seven places. A one-line SQL edit touches ~14 sites.

**Proposed:** a build step reads `migrations/*.sql`, emits the checksum manifest
and catalog inventory to a committed generated file, and a test asserts the
committed file matches a fresh regeneration. Drift between the committed
manifest and the live catalog is still rejected exactly as it is today.

**What is preserved:** the safety property. The deployed schema is still proven
to equal the reviewed schema, and the manifest is still committed, diffable, and
reviewable.

**What is given up:** the current guarantee that the expected values were typed
by a human independently of the migration. That independence is real, and it is
the reason `canonical-migrations.test.ts:3386` forbids `.map(`, `.filter(`, and
`Object.keys(` inside the manifests. Accepting P1 means deleting that guard and
accepting that a bug in the generator could produce a manifest that agrees with
a wrong migration.

**Mitigation if adopted:** keep the generator small enough to review once in
full, commit its output, and require the generated diff to be reviewed alongside
the SQL. That moves the human check from 14 synchronised sites to one file.

**Not recommended blindly.** This is a genuine trade of independence for
maintainability, and the review does not assert which side wins. It asserts that
the current cost is 47× on the smallest observed migration and that the decision
is worth making deliberately.

### P2 — Resolve the dual evaluator before Task 9F

`dasher_private.evaluate_calculation_graph_v1`
(`../../packages/control-plane/migrations/0007_agent_run_ledger_and_calculations.sql:12766`,
1,748 lines of PL/pgSQL) and `packages/calculation-engine/src/evaluate.ts`
(1,562 lines of TypeScript) implement the same evaluation semantics. Decimal
rounding, currency conversion, grouping, and window ordering must agree
bit-for-bit between them, permanently. Neither is imported by application code.

Either outcome is defensible, but the decision point is narrower than it first
appears. Task 9D adds no migration and touches neither evaluator, so work in
flight there is unaffected. **Task 9F is the lock-in**: at 298 lines it is the
largest task in the plan, and it is where the PL/pgSQL evaluator gains an
adversarial conformance surface. Deciding before 9F is cheap; deciding after
means unwinding the plan's biggest task.

### P3 — Move the freeze point, and cap reviewable diffs

**Freeze point.** Task 8A froze its contract in `e988870` at 17:29 on
2026-08-01, amended it four times within four hours, and had 8,921 of its
`migrator.ts` lines deleted the next day by `c5ff7f7`. Thirty percent of every
line ever written to `migrator.ts` has since been deleted. Proposed: freeze a
contract after an end-to-end slice exercises it, not before implementation
begins.

**Diff cap.** `3a031f0` is +56,395 / −459 and carries `SPEC-APPROVE` and
`SEC-APPROVE`. Proposed: a soft cap near 2,000 lines of non-generated diff per
pull request, and no approval attestation on a diff above the cap unless the
reviewer records what was actually read. Generated files under P1 are excluded
from the cap, which is a further argument for P1.

### P4 — Two tracks with different rules, not only a different order

The two-track proposal above changes what is built in what order. It leaves both
tracks under one set of process rules. Make the rules differ, because the risk
differs:

| Aspect         | Product track               | Trust track         |
| -------------- | --------------------------- | ------------------- |
| Data           | synthetic and fixture only  | unchanged           |
| Migrations     | none, or provisional (P6)   | immutable, as today |
| Pull requests  | capped at a reviewable size | unchanged           |
| Spikes         | expected                    | forbidden, as today |
| Exhaustiveness | explicitly not required     | unchanged           |

The hard boundary is the one ADR-003 already draws. Nothing from the product
track may touch real customer data, a credential, or a deployment until it has
been re-specified under trust-track rules. Code graduates by being rewritten to
that standard, never by being waved across.

### P5 — Make tests the specification, not prose about tests

The Task 9 plan is 6,471 lines in large part because it narrates in prose which
assertions must exist. `canonical-migrations.test.ts` then contains 90 `it()`
blocks implementing that narration.

Proposed: a plan ships the test file rather than a description of it. The same
contract is stated once, in the language that actually enforces it, and the class
of drift where plan prose and test code disagree disappears. This also shortens
the plan-review cycle, which is currently a gate in its own right.

### P6 — A provisional migration tier before the freeze point

"Immutable from birth" is the most expensive constraint in the project. ADR-005
states the forcing function directly: lifecycle rules "must exist in the first
dashboard migration; they cannot be deferred behind a minimal dashboard row."
That is what produced a 5,868-line `0003` and the amplification measured in the
review.

Proposed: a development schema that may be squashed and rewritten freely, which
freezes into an immutable migration at exactly one moment — when real data
becomes possible, a boundary ADR-003 already defines. Iterate the lifecycle
design cheaply; pay the immutability cost once, on a design that learning has
already corrected.

This is the largest change proposed here and it should be rejected if the answer
is that the schema was already right. It was not. Three of eight migrations are
corrections, `0008` corrects `0006`, and on 2026-08-12 the owner decided to
remove disposable dashboards entirely — a feature whose schema is now permanent
because it was frozen before the product decision was tested. That is the cost of
the current rule, stated concretely rather than hypothetically.

### P7 — Pose the build-versus-buy question for the identity spine

Verified absence: a search across every ADR and plan finds no consideration of a
managed identity provider and no build-versus-buy analysis of any kind. The
alternatives sections are architecturally rigorous and commercially silent.

Dasher is hand-building invitations, sessions, rotation, CSRF, membership, roles,
and a provider-neutral `(issuer, subject)` principal, with the passwordless path
still entirely unbuilt and unplanned. That is a commodity with mature vendors.
Building it may still be correct given the row-level-security coupling, but the
question has never been asked, and sign-in is the next thing on the critical path
to a pilot user.

### P8 — A stopping rule for gate rework

The roadmap advances stages by evidence rather than dates, which is sound, but it
has no stopping rule for the cost of that evidence. Task 8A was declared closed
four times across three pull requests, and 30% of everything ever written to
`migrator.ts` has been deleted.

Proposed: when a gate's evidence fails more than a set number of times, treat it
as a signal that the gate is mis-specified rather than that the work is
unfinished, and review the gate itself.

## If this proposal is declined

The accepted roadmap stands and Track B continues as the serial chain. In that
case the review's recommendation reduces to P2 and P3, which are independent of
sequencing, and to a single suggestion: record explicitly that the planning loop
is unvalidated, so that the specifications written against it in Tasks 9D–9G are
understood as provisional.
