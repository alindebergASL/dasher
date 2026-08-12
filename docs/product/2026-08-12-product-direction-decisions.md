# Product Direction Review and Owner Decisions

Status: Owner decisions recorded 2026-08-12 — decisions authoritative, assessments advisory
Date: 2026-08-12
Reviewed commit: `d01eedce8bff84d54dd79f98d9b3b95e9d40dcdd`
Relates to: [Product requirements](PRODUCT_REQUIREMENTS.md),
[ADR-005](../architecture/ADR-005-agentic-dashboard-harness.md),
[Scope baseline](../status/2026-08-12-scope-baseline.md),
[Proposed re-sequencing](../roadmap/2026-08-12-proposed-resequencing.md)

## What this document is

The efficiency review, scope baseline, and re-sequencing proposal all concern
ordering, cost, and process. This one concerns the product itself: which features
and directions in the accepted scope are worth building.

Two kinds of statement appear here and they carry different authority. An
**assessment** is advisory judgement. A **decision** was taken by the owner on
2026-08-12 and is authoritative. Assessments are opinion and should be argued
with; decisions are settled and the consequences below follow from them.

This document changes no other document. §8 enumerates the amendments the
decisions imply, for separate approval.

## 1. Provider credentials: platform key by default

**Assessment.** `PRODUCT_REQUIREMENTS.md:203` makes organization-level BYOK the
pilot default. The target user is a manager or executive in an invite-only pilot,
and requiring their organization to procure and manage an inference key before
seeing any value is an adoption barrier. BYOK is normally an enterprise
procurement requirement, demanded at contract time rather than at first use.

**Decision.** Pilot users are supplied with a key. An organization must be able
to switch to its own key easily.

**Consequence.** ADR-004's credential contract needs a platform-owned credential
class alongside tenant-owned BYOK. One constraint is load-bearing: ADR-004
forbids falling back "from user OAuth to an administrator key," and that
invariant must survive. The platform key is therefore an **explicit stored
per-organization selection**, never a fallback reached when a tenant credential
is missing or failing. Credential resolution stays a single deliberate choice, so
the no-cross-credential-fallback tests remain meaningful.

## 2. Provider neutrality and model selection by measured quality

**Assessment.** Roadmap Gate 5 makes QwenCloud BYOK the first live planning
proof, with OpenAI Platform following. For a US executive-facing product handling
business data, that ordering raises residency and procurement questions with
precisely the intended buyer.

**Decision.** Not locked to Qwen. It is currently the best cost-per-performance
option and may be adjusted, including to a US-hosted model, depending on the end
user. The system must work with Qwen, Claude, GPT, and others. Which model
produces better dashboards is to be **tested**, not assumed.

**Consequence.** This adds a product requirement that does not currently exist:
a dashboard-quality evaluation harness comparing providers on the same inputs.
The existing spike makes this unusually cheap. `PlanningProvider` already
abstracts the provider, and because the planner emits a composition plan while
trusted code computes every value, two providers can be compared deterministically
— same fixture, same compiler, differing only in the plan. Provider comparison
becomes a diff over plans rather than a subjective read of rendered output.

## 3. Disposable dashboards are cut

**Assessment.** The Scratch specification — 24-hour default TTL, one-hour
minimum, 30-day maximum, fixed at creation, no renewal, presets only, promotion
by request — is the most expensive feature in the scope relative to demonstrated
need. Downstream it drives expiry races, promotion races, access revocation,
quarantine, purge finalizers, retention claims, tombstone lineage, a
backup-deletion ledger, restore-as-new, a cleanup retry schedule, and the
retention-operator role apparatus. The user need beneath it — workspace clutter —
is met by archiving and search. "Fixed at creation, cannot be renewed, ask an
administrator to promote it" is user-hostile and generates support load.

**Decision.** Cut disposable dashboards entirely. Archiving and search replace
them.

**Consequence, stated honestly.** This cannot reclaim what is already built.
`0003_immutable_content.sql` is immutable and already contains `current_kind`,
expiry columns, promotion, quarantine, purge, finalizers, retention claims,
holds, and tombstone lineage; migrations `0004`, `0006`, and `0008` are
corrections to that machinery. The schema cost is sunk.

What the decision stops is forward cost: no TTL user experience, no promotion
flow, no cleanup coordination in the application, no further corrections to that
surface, and a substantial deletion from ADR-005's normative product grammar.

The replacement is partly present already. `0003`'s durable lifecycle is
`draft → active → archived`, so archiving exists at the schema level. Search does
not exist and is unplanned.

This decision is also the concrete case for P6 in the re-sequencing proposal: a
product decision has reversed a feature whose schema can never be removed,
because it was frozen before the product question was tested.

## 4. Tenancy timing

**Assessment.** ADR-003 rejects deferring tenancy until a single-user product
proves demand, and its reasoning — retrofitting ownership over identifiers, jobs,
storage, and audit is painful — is correct for a product that will exist. It
weighs correctness and never weighs timing or option value.

**Decision.** Agreed in principle; recommendation requested.

**Recommendation.** The tenancy substrate is merged, immutable, and its
PostgreSQL gate passes, so deferral is no longer available. Forward-looking:

1. **Keep it.** Do not unwind or rebuild. It is real, working, well-tested work.
2. **Stop letting it gate product work.** It should gate real customer data —
   exactly what ADR-003 says — and nothing else. Not the planner, model
   evaluation, the interface, or user testing on synthetic data.
3. **Do not build the Gate 2 remainder until a user exists.** Object storage and
   quarantine matter when uploads exist; the job system when refresh exists;
   backup and restore drills when there is data worth restoring; kill switches
   when something live can be killed. All of it is unplanned today, and this is
   where deferral saves real effort — not in the tenancy already paid for.
4. **Consider one database per pilot organization.** For a named cohort of a few
   organizations this gives stronger isolation than shared-database row-level
   security, runs the same migrations unchanged, keeps the row-level-security
   work as defense in depth rather than the only line, and avoids
   pooled-connection context bugs and cross-tenant production matrices on day
   one. Every row already carries `organization_id`, so collapsing to a shared
   database later requires no schema change.
5. **The real blocker is identity, not tenancy.** No sign-in path of any kind
   exists and none is planned. That is what stands between today and a pilot
   user, and it is the component most amenable to the build-versus-buy question
   in the re-sequencing proposal.

## 5. Auto-composition, refined by prompting

**Assessment.** The thesis is that a user "should not have to define KPIs, choose
chart types, or organize source material" (`PRODUCT_REQUIREMENTS.md:16-17`). The
deferred interface list nonetheless includes a three-pane Compose experience, a
native declarative canvas, a component-merge interface, and a registry with
duplicate and retirement management. That is a dashboard builder, and building
one hedges against the product's own thesis.

**Decision.** Auto-composition is the direction. When a user dislikes a detail,
they change it by prompting for a fix, not by editing on a canvas.

**Consequence.** Conversational reconfiguration is already required at
`PRODUCT_REQUIREMENTS.md:140`, "without silently changing the underlying
evidence." The decision is that it _replaces_ the canvas rather than coexisting
with it, which removes the Compose canvas, component-merge interface, and
registry from the roadmap.

Architecturally this reuses a mechanism that already exists. `runPlanner` returns
typed findings and asks the provider to revise; a user correction is the same
channel with a different origin. A refinement that Dasher cannot support is
rejected and explained rather than half-applied.

## 6. Alerting versus the safety disclaimer

**Assessment.** `PRODUCT_REQUIREMENTS.md:62` requires user-defined threshold
alerts in the first slice. `:247` lists emergency dispatch and safety-critical
flood warnings as non-goals. The `0005` direction adds edge-triggered alerts and
action proposals with external dispatch. The gap between marketing
flood-adjacent monitoring and disclaiming flood warnings is a liability seam, not
only a scope question. It is demonstrable today: the planner spike, asked for a
flood watch, produces a dashboard titled "Sacramento Flood Watch" addressed to
"Emergency management leads," and nothing prevents it.

**Decision.** Agreed that the disclaimer position is odd and needs resolution.

**Consequence.** This needs a product answer rather than a document disclaimer.
The options are to narrow the first vertical away from emergency framing, to
constrain what audiences and titles a planner may produce, or to accept the
positioning deliberately with legal review. No option is selected here.

## 7. Accepted without separate decision

The owner agreed with the remaining assessments:

- **Legal hold** is enterprise compliance machinery implemented for a product
  with no users, contracts, or litigation exposure. No further work on it.
- **The four-milestone retention model** is excellent thinking encoded as schema
  before any deletion obligation exists. Keep the reasoning; defer the tables.
- **Recipes** reintroduce templating after the thesis rejected templates, as a
  third artifact type before the first has been used. Deferred.
- **Publication and audience grammar** is normative and shapes `0003` while the
  pilot is private-only and exercises none of it. Deferred.
- **The statistical gap is real.** Registry v1 offers `count_rows`,
  `count_present`, `sum`, `min`, `max`, and `mean`. No percentile, quantile,
  standard deviation, correlation, or regression exists. `count_distinct` and
  `median` are declarable in a metric contract but "not executable in
  `calculation-registry-v1`", deterministically producing `unsupported_capability`
  abstention (Task 9 plan `:4788-4792`). The vocabulary invites a request the
  engine is specified to refuse. For the cash-flow vertical, `count_distinct` is
  close to mandatory.
- **Synthetic agent validation is retired as a technique**, not merely discounted
  for Gate 1. Model agreement establishes legibility to models, not to managers.

## 8. Amendments these decisions imply

Not made here. Each touches an approved or accepted document and needs separate
approval.

| Document                              | Clause                                                          | Change implied                                                |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| `PRODUCT_REQUIREMENTS.md`             | `:203` BYOK as pilot default                                    | platform key default, BYOK an explicit switch                 |
| `PRODUCT_REQUIREMENTS.md`             | `:98-126` multi-dashboard workspace, disposable TTLs, promotion | remove disposable dashboards; archiving and search            |
| `PRODUCT_REQUIREMENTS.md`             | `:62` and `:247` threshold alerts against the safety non-goal   | resolve the alerting position                                 |
| `ADR-005`                             | normative product grammar: Scratch, promotion, TTL policy       | large deletion; ADR is `Proposed`, so amendable               |
| `ADR-005`                             | registry v1 aggregations                                        | add distinct and percentile capability, or say why not        |
| `ADR-004`                             | credential disposition and provider ordering                    | platform credential class; provider order by measured quality |
| `2026-07-30-private-pilot-roadmap.md` | Gate 5 Qwen-first ordering                                      | provider chosen by evaluation, not fixed in advance           |
| Lifecycle plan `:1814`                | Compose canvas, component-merge, registry                       | remove; prompt-based refinement replaces them                 |

ADR-005 is `Proposed` and freely amendable. `PRODUCT_REQUIREMENTS.md` is an
`Approved baseline` and the roadmap is an `Accepted execution roadmap`; both
should be superseded explicitly rather than edited quietly, matching the
convention this repository already follows.

## What this document does not do

It does not amend any accepted document, change a gate, authorize implementation,
or estimate effort. It does not assess whether the retained features are
correctly specified — only whether they are worth building now.
