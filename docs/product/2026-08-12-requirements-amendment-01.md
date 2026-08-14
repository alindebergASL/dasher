# Requirements Amendment 01

Status: Proposed amendment — requires owner acceptance before it governs
Date: 2026-08-12
Amends: [Product requirements](PRODUCT_REQUIREMENTS.md) (Approved baseline),
[ADR-004](../architecture/ADR-004-provider-oauth-mcp-boundaries.md) (Accepted),
[ADR-005](../architecture/ADR-005-agentic-dashboard-harness.md) (Proposed),
[Private pilot execution roadmap](../roadmap/2026-07-30-private-pilot-roadmap.md) (Accepted)
Source: [Product direction decisions](2026-08-12-product-direction-decisions.md)

## Standing

The decisions recorded on 2026-08-12 contradict specific clauses in an approved
baseline, two accepted documents, and one proposed ADR. This amendment states the
replacement text for each clause in one reviewable place rather than editing
those documents quietly.

Until this amendment is accepted, the original clauses govern. On acceptance,
each amended document gets a dated pointer to this file at its head, and the
superseded clause is marked in place rather than deleted — the convention
`docs/plans/2026-07-30-product-spine.md:3-14` already established.

Nothing here relaxes a safety invariant. The generated-code gate stays `CLOSED`.
Record immutability, forced row-level security, composite tenant foreign keys,
audit atomicity, and the no-cross-credential-fallback rule are all unchanged.

---

## A1 — Provider credentials

**Amends** `PRODUCT_REQUIREMENTS.md:203`.

**Current.** "Organization-level BYOK is the pilot default."

**Replacement.**

> A Dasher-operated provider credential is the pilot default, so that an invited
> organization can reach a working dashboard without procuring an inference key.
> Organization-level BYOK is supported and an organization may switch to its own
> credential at any time.
>
> Credential selection is an explicit, stored, per-organization choice. Dasher
> never falls back from a tenant credential to the platform credential, or from
> any credential to another, for any reason including absence, expiry, revocation,
> quota, or transport failure. A missing or failing tenant credential produces a
> clear error and no inference call.

**Why the second paragraph is load-bearing.** ADR-004 forbids fallback "from user
OAuth to an administrator key." A platform default implemented as a fallback
would silently void that invariant and make its negative tests meaningless.
Implemented as a stored selection, the invariant survives intact.

**Consequential change to ADR-004.** The credential disposition table gains a
row:

| Credential class                    | Disposition | Dasher posture                                                                                                                                                                |
| ----------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dasher-operated platform credential | **PASS**    | Pilot default. Same gateway contract, endpoint/region/model validation, budget ceilings, and metering as BYOK. Selected explicitly per organization; never a fallback target. |

## A2 — Provider ordering and model selection

**Amends** `2026-07-30-private-pilot-roadmap.md` Gate 5 and ADR-004's provider
ordering.

**Current.** Gate 5 enables "standard QwenCloud/Model Studio pay-as-you-go
organization BYOK as the first capped live planning proof. Standard OpenAI
Platform BYOK may follow through the same contract."

**Replacement.**

> Dasher is provider-neutral in fact, not only in architecture. The gateway must
> support Qwen, Anthropic, and OpenAI models through one contract, and adding a
> provider must not require changes outside its adapter.
>
> The first live provider is chosen by measured dashboard quality, cost, and
> deployment fit for the intended user, not fixed in advance. Selection evidence
> comes from an evaluation harness that compares providers on identical inputs.
> Residency and procurement constraints are part of that evaluation.

**New requirement — provider evaluation harness.** Add to
`PRODUCT_REQUIREMENTS.md` under AI credentials and model portability:

> Dasher maintains an evaluation harness that runs a fixed corpus of requests
> against each candidate provider and compares the resulting dashboards.
> Because a planner emits a composition plan while trusted services compute every
> displayed value, provider comparison is a deterministic diff over plans rather
> than a subjective reading of rendered output. Comparison covers composition
> quality, request adherence, structural-revision behaviour, refusal behaviour on
> unsupportable requests, latency, and cost.

## A3 — Disposable dashboards removed

**Amends** `PRODUCT_REQUIREMENTS.md:98-126` and ADR-005's normative product
grammar.

**Current.** The workspace holds Boards and Scratches. A Scratch is a disposable
dashboard with a fixed expiry, TTL presets, no renewal, secure cleanup, and an
explicit promotion path to durable.

**Replacement.**

> The pilot workspace holds dashboards of one kind. A dashboard has the lifecycle
> `draft → active → archived`. Archiving is reversible, retains authorized
> access, and removes the dashboard from default views. Explicit delete
> transitions any state to access-revoked cleanup.
>
> Workspace scale is managed by archiving and search, not by expiry. No dashboard
> expires automatically, and no dashboard is destroyed on a timer.

**Removed from the product grammar.** Scratch, disposable kind, TTL defaults,
presets and administrator TTL policy, expiry semantics, promotion and its race
handling, quarantine, restore-as-new, and the operator-only legal-hold capability
as a pilot feature.

**Retained.** Record immutability, version history, explicit delete with
access-revoked cleanup, and the four-milestone retention vocabulary as
documentation of what deletion claims mean.

**New requirement — search.** Archiving alone does not manage scale.
`PRODUCT_REQUIREMENTS.md` gains a requirement for dashboard search across title,
audience, source, and freshness. Search does not exist today and is unplanned.

**Honest limit.** `0003_immutable_content.sql` is immutable and already contains
this machinery. This amendment stops forward work on it; it does not remove it.
Removal is possible only under [ADR-006](../architecture/ADR-006-schema-freeze-point.md)
before a Freeze Point is declared.

## A4 — Auto-composition replaces the builder

**Amends** the deferred interface list at
`docs/plans/2026-08-01-dashboard-lifecycle-and-agent-harness.md:1814`.

**Current.** Deferred interface work includes a three-pane Compose experience, a
native declarative canvas, a component-merge interface, and a registry with
duplicate and retirement management.

**Replacement.**

> Dasher composes; the user directs. A user who wants a dashboard changed says so
> in words, and Dasher produces a new validated version. There is no canvas, no
> component palette, no drag-and-drop arrangement, and no manual component merge.
>
> A refinement request follows the same governed path as an initial request: it
> may change composition, framing, selection, and layout, and it may not change a
> computed value. A refinement Dasher cannot support is refused with a reason,
> never partially applied.

**Removed.** Three-pane Compose, declarative canvas, component-merge interface,
and the component registry with duplicate/retirement management.

**Retained.** Conversational reconfiguration, already required at
`PRODUCT_REQUIREMENTS.md:140`, which this makes the sole editing path rather than
one of two.

## A5 — Alerting scope and the safety boundary

**Amends** the tension between `PRODUCT_REQUIREMENTS.md:62` and `:247`.

**Current.** Threshold alerts are a required feature of the first slice;
emergency dispatch and safety-critical flood warnings are non-goals. Both stand
without a rule reconciling them.

**Replacement.** This amendment does not settle the product question. It records
the constraint that any resolution must satisfy:

> Dasher must not present itself, by title, audience, framing, or alert language,
> as an authority for a use it disclaims. Where the product disclaims
> safety-critical warning, the generated surface must not adopt emergency-response
> framing. This is enforced in the composition contract rather than by a
> disclaimer, because a disclaimer does not constrain generated output.

**Evidence that this is live rather than theoretical.** The planner spike, asked
for a flood watch, produces a dashboard titled "Sacramento Flood Watch" addressed
to "Emergency management leads." Nothing prevents it today.

**Options, none selected.** Narrow the first vertical away from emergency
framing; constrain the audiences and titles a planner may emit; or accept the
positioning deliberately after legal review.

## A6 — Statistical capability

**Amends** ADR-005's pilot registry v1.

**Current.** Registry v1 provides `count_rows`, `count_present`, `sum`, `min`,
`max`, and `mean`. `count_distinct` and `median` are declarable in a metric
contract but "not executable in `calculation-registry-v1`", producing
`unsupported_capability` abstention.

**Replacement.**

> The registry must be able to execute every aggregation the metric-contract
> vocabulary can express. A declarable aggregation that always abstains is a
> defect in the contract, not a safe default.
>
> Before the first customer-owned-data vertical, registry v1 adds `count_distinct`
> and `median` as executable operations, and adds percentile with an explicit
> interpolation rule. Any aggregation deliberately excluded is removed from the
> metric-contract vocabulary as well, so the two agree.

**Why.** "How many distinct accounts," "median deal size," and "p90 cycle time"
are ordinary executive questions. The cash-flow vertical in particular is
difficult to serve without `count_distinct`.

## A7 — Synthetic validation retired as a technique

**Amends** the roadmap's Gate 1 precedent.

**Current.** Gate 1 was accepted on a six-agent synthetic rehearsal, honestly
labelled as synthetic, with later gates retaining independent requirements.

**Replacement.**

> Model agreement is not evidence of human comprehension and is not accepted as
> gate evidence for any comprehension, usability, or decision-quality criterion.
> Synthetic review may be used for coverage, regression, and adversarial testing,
> where the property under test is mechanical.

The Gate 1 record is not revised. The technique is not used again.

---

## Amendments summary

| #   | Document                  | Clause            | Change                                             |
| --- | ------------------------- | ----------------- | -------------------------------------------------- |
| A1  | `PRODUCT_REQUIREMENTS.md` | `:203`            | platform credential default; explicit selection    |
| A1  | `ADR-004`                 | disposition table | new platform credential class row                  |
| A2  | roadmap                   | Gate 5            | provider chosen by evaluation, not fixed           |
| A2  | `PRODUCT_REQUIREMENTS.md` | model portability | new evaluation-harness requirement                 |
| A3  | `PRODUCT_REQUIREMENTS.md` | `:98-126`         | disposable dashboards removed; search added        |
| A3  | `ADR-005`                 | product grammar   | Scratch, TTL, promotion, quarantine removed        |
| A4  | lifecycle plan            | `:1814`           | canvas and registry removed; prompting is the path |
| A5  | `PRODUCT_REQUIREMENTS.md` | `:62`, `:247`     | constraint recorded; product question left open    |
| A6  | `ADR-005`                 | registry v1       | executable distinct, median, percentile            |
| A7  | roadmap                   | Gate 1 precedent  | synthetic validation retired as gate evidence      |

## What acceptance requires

A1, A2, A4, A6, and A7 are straightforward once accepted: they change text and
future work, and contradict nothing already built.

A3 is only partly achievable by amendment. The schema it removes from the product
is permanent unless [ADR-006](../architecture/ADR-006-schema-freeze-point.md) is
also accepted and a squash is performed before a Freeze Point is declared.

A5 records a constraint and leaves a product decision open. It is the one item
here that is not finished.
