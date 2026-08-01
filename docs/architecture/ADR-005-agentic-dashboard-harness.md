# ADR-005: Agentic Dashboard Harness

Status: Proposed
Date: 2026-07-31
Depends on: ADR-001, ADR-003, ADR-004

## Context

Dasher is a multi-dashboard workspace, not a one-request, one-dashboard
generator. The pilot target includes both long-term durable dashboards and
quick disposable dashboards. Both need creative model planning without giving
a model credentials, execution authority, unsupported factual authority, or a
way around the declarative `DashboardSpec` and the `CLOSED` generated-code
gate.

The deterministic fixture planner proves the current rendering and evidence
contract. It does not define the creative ceiling for the future product. The
target harness must let models explore useful narratives, layouts, components,
metrics, comparisons, and transformations while trusted services enforce
safety, authorization, evidence, and resource limits.

This ADR records an owner-approved product direction as a proposed target
architecture. It does not claim that the harness, identity paths, dashboard
lifecycle, tools, ledger, provider gateway, scheduling, or cleanup exists.

## Decision

The agentic dashboard harness is a core product capability. Dasher will start
with one governed adaptive orchestrator per run. The orchestrator may form and
revise dynamic plans, request bounded specialist or reviewer passes, generate
multiple creative candidate `DashboardSpec` values, and respond structurally
to validation feedback. A specialist or reviewer is a bounded role inside the
same governed run, not an independently authorized agent.

Trusted deterministic services validate and execute approved typed operations;
they do not dictate the dashboard's ideas. Models may propose typed calculation
graphs and safe expressions. Trusted validators and execution services enforce
schema, operation allowlists, types, units, evidence coverage, authorization,
resource ceilings, and policy before any result can become a candidate.

The harness will use capability-scoped typed tools, current authorization on
every use, an append-only run event ledger with rebuildable mutable projections/
checkpoints, an end-to-end evidence chain, explicit autonomy tiers, and human
approval at authority, source, publish, and recurring-cost boundaries. Model
inference goes through the provider-neutral gateway. Initial development uses
fake providers, recorded-result replay, and evaluation corpora before any
capped live-provider gate.

Generated-code execution remains `CLOSED`. The only presentation output is a
validated, versioned declarative `DashboardSpec`. No model, plan, calculation,
tool call, or validation repair may introduce arbitrary code, SQL, credentials,
ambient authority, hidden side effects, or unsupported claims.

## Product thesis and governed decision loop

Dasher is not an AI dashboard generator. It is a governed decision loop that
turns bounded evidence into a safe managerial action and durable decision
memory:

```text
bind intent -> orient -> detect material/new change
  -> explain by epistemic type -> propose safe action
  -> preserve human decision -> promote reviewed work without widening authority
```

The loop is successful when a manager can understand the decision state,
inspect its evidence, choose or reject a safe action, and later reconstruct what
was known and why—not merely when a dashboard renders.

## Hard safety invariants and flexible creative envelope

Governed does not mean template-bound. The boundary is deliberately split:

### Hard safety invariants

- Server-derived organization, actor or service identity, membership,
  authority revision, policy revision, and approved purpose constrain every
  run and every tool call.
- The model receives typed data and opaque capability handles, never
  credentials, raw authorization headers, database access, or tenant context
  selected by prompt content.
- Tools are explicitly registered, typed, capability-scoped, deny by default,
  and reauthorized immediately before each use and result commit.
- Only trusted services retrieve approved sources, evaluate allowed expression
  nodes, execute calculation graphs, validate evidence, render components, and
  advance lifecycle state.
- Every material claim and calculated value must resolve through typed
  transformations to authorized immutable evidence. Interpretation and
  recommendation labels do not substitute for evidence.
- Schema, type, unit, evidence, resource, cost, tenant, freshness, and policy
  checks fail closed. Revoked or stale work cannot commit.
- A model cannot grant itself another call, broaden a capability, add a source,
  publish, schedule recurring work, promote a dashboard, or suppress an
  approval.
- There is no arbitrary code or SQL, provider-hosted tool use, arbitrary MCP,
  secret access, browser-origin execution, or generated workload. The
  generated-code gate remains authoritative.
- Tool results and model output are untrusted inputs. No output has ambient or
  hidden side effects.

### Flexible creative envelope

Within those invariants, the orchestrator may:

- choose and revise the order and shape of a plan rather than follow one fixed
  workflow template;
- ask bounded specialists to explore analysis, narrative, information design,
  or review questions and then synthesize their typed results;
- create and compare multiple candidate dashboard narratives, page structures,
  layouts, supported component combinations, metrics, comparisons, and
  transformations;
- propose new compositions of reviewed components and supported calculation
  primitives without a preselected KPI or chart template; and
- use structured validation findings to repair, replace, or abandon a
  candidate within bounded attempt, time, token, and cost limits.

Validators decide whether an idea is safe and supportable; they do not choose
the idea merely because it matches a preferred template. Candidate ranking may
consider decision usefulness, clarity, evidence coverage, accessibility,
freshness, complexity, and cost, but cannot waive a hard invariant.

## Normative product grammar

- **Workspace:** the container and registry holding multiple Boards and
  Scratches. It is not a dashboard kind or lifecycle state.
- **Scratch:** a dashboard whose `current_kind` is `disposable`. It has
  immutable versions and a current working head, a fixed visible expiry, no
  renewal, and no schedule. Pinning or bookmarking never extends its TTL.
- **Board:** a dashboard whose `current_kind` is `durable`. Its lifecycle is
  `draft`, `active`, or `archived`; its working head may be newer than its most
  recently Published revision.
- **Published:** a reviewed, audience-authorized projection of one immutable
  Board version through an explicit publication/version relation. Published is
  never a third dashboard kind, lifecycle state, synonym for `active`, or
  synonym for the working head.
- **Decision Snapshot:** an immutable record of evidence, filters, contracts,
  values, freshness, rationale, and action present when a human decides.
- **Recipe:** a reviewed parameterized procedure over approved semantic sources
  and closed typed calculations. It is never generated code/SQL or replay of
  unconstrained model behavior.

Scratch-to-Board is the in-place promotion defined below. It preserves dashboard
identity, versions, head, and history but does not publish. The promoted working
head is private until a separate publication review grants an audience. A Board
cannot become a Scratch. Pin, bookmark, link, share, decision, Recipe, or alert
cannot extend Scratch TTL or silently create content retention. Partial or
selective promotion is deferred: a later copy from a selected immutable revision
would be a distinct provenance-bearing copy operation, not promotion and not a
general dashboard clone.

## Workspace and dashboard lifecycle

The workspace treats durable and disposable dashboards as first-class kinds.
Lifecycle state is database-authoritative. Services and UI may project it, but
they cannot make an expired or revoked dashboard accessible while a worker is
late. All boundary comparisons use database time.

### Disposable TTL and user experience

- The disposable default TTL is 24 hours. The minimum is 1 hour and the hard
  maximum is 30 days from creation. An organization administrator may set the
  organization default only from 1 hour through 7 days.
- Pilot creation offers exactly `1h`, `24h`, `7d`, and `30d` presets; it has no
  arbitrary timestamp control. The selected expiry and the organization
  default/policy revision are visible before confirmation and on the dashboard.
- TTL is fixed at creation. Both the original expiry and current effective
  expiry are recorded; a disposable dashboard cannot extend or renew either.
  Inclusive expiry is `database_now >= expires_at`. A user who needs the work
  to persist requests promotion instead of extending it.
- Disposable dashboards cannot schedule recurring work. This is a hard
  lifecycle rule, not a hidden default that an API or model may override.

The 24-hour default makes the quick path useful across a working day while
limiting forgotten data. One hour supports genuinely transient inspection;
30 days is a hard containment boundary. Capping administrator defaults at 7
days prevents an organization-wide default from turning disposable storage
into an undeclared durable tier, while retaining an explicit 30-day user
choice. Fixed, visible presets avoid timezone mistakes, expiry extension races,
and retention promises that a pilot calendar picker cannot explain reliably.

### Durable dashboards

A durable dashboard is intended to remain useful over time. It has insert-only
version history, manual refresh and an explicitly authorized schedule,
prior-good-version preservation, and visible changed-since value with the
provenance that supports that comparison.

A durable dashboard has the product lifecycle `draft -> active -> archived`.
Archive is reversible and retains authorized access; it pauses ordinary active
use without being a deletion surrogate. Explicit delete transitions any
durable state to access-revoked cleanup. There is no durable-to-disposable
transition.

Version validation and refresh remain subordinate workflows:

```text
draft -> validating -> candidate -> active -> archived
              |           |
              v           v
            rejected    superseded

active -> refresh requested -> validating candidate -> accepted working head
                                  |
                                  v
                         failed; prior good stays active
```

Changed-since is a typed comparison between identified dashboard versions and
their source snapshots. It records the baseline, current version, calculation
or transformation, relevant evidence, and freshness. A narrative alone cannot
establish change.

### Disposable expiry, deletion, retention, and restore

A disposable dashboard is optimized for quick, bounded use. Expiry or explicit
delete immediately revokes product access, capabilities, head/version/source/
evidence projections, and cache eligibility regardless of worker or scheduler
lag. The UI replaces content with an inaccessible expired/deleted state and,
for authorized administrators during quarantine, a restore-as-new action.

Revoked content enters a 24-hour inaccessible quarantine, with
`purge_after = access_revoked_at + 24 hours`. Purge may start only at/after
`purge_after`, targets completion by `purge_after + 24 hours`, and never
restores access while waiting. Encrypted, runtime-inaccessible backups target
age-out from Dasher recovery paths within 35 days. Only bounded audit records,
opaque random lineage tombstones, lifecycle revisions, hold/cleanup outcomes,
and minimum policy/event/time provenance remain for 365 days, after which they
are purged unless held.

Retention reporting distinguishes four milestones rather than calling all of
them deletion:

1. **Product access revocation:** immediate and database-authoritative.
2. **Logical retention/recovery expiry:** quarantine, claim-aware purge, and the
   35-day Dasher recoverability objective.
3. **Cryptographic unrecoverability:** a later claim requiring verified
   destruction or inaccessibility of every relevant key copy and backup plus
   retained evidence.
4. **Provider physical-media deletion:** a provider-specific timeline and
   evidence obligation, separate from Dasher's logical or cryptographic state.

The 24-hour quarantine, 35-day backup objective, 365-day metadata retention,
and operator-only hold model are private-pilot product choices, not universal
legal or security standards. The 35-day objective is not proof that a provider
has deleted a particular row from physical media by day 35. Later envelope
per-object or per-dashboard keys, key pedigree, copies, backup behavior,
destruction evidence, and provider deletion evidence require separate design
and review; none is implied by this ADR.

The initial database may store only bounded synthetic or public fixture bytes.
It cannot promise cryptographic erasure for inline `bytea`, and a source-kind
label or byte-length check cannot prove that bytes are non-sensitive. No route
or ingestion boundary may accept raw bytes until a separately reviewed
classification/admission gate exists. Customer, confidential, or uploaded
content remains blocked until that gate plus envelope-encrypted object storage,
key-erasure, and reference/retention-claim gates are reviewed.
Shared snapshots and evidence are independently retained resources, not bytes
owned by one dashboard: purge releases that dashboard's claims and deletes a
resource only after it records deletion intent/finalizer state and proves the
last access, retention, and hold claim is gone in the same transaction. The UI
labels dashboard-owned artifacts separately from independently retained or
shared sources/evidence.

A conceptual lifecycle is:

```text
draft -> active -> access revoked -> quarantine -> purge eligible -> cleaned
            |
            v
       promotion requested -> durable active
```

During quarantine, an organization administrator may restore only as a new
dashboard ID after fresh authority, source, policy, and evidence checks. Restore
copies no schedule and never resurrects the original row, identifier,
capabilities, caches, or lifecycle revision. At or after `purge_after`, restore
is denied. A legal-hold copy is not a restore source.

### Legal hold and purge

Legal hold is a dedicated operator-only capability, not an organization-admin
or application capability. A dashboard/resource may have multiple independent
holds. Each hold and release carries an independent opaque hold ID, opaque
case/matter reference, authority revision, actor, reason hash, and audit event;
release is equally privileged. A hold blocks purge only: it never changes TTL,
access, schedules, capabilities, quarantine, or ordinary lifecycle state. Hold
and purge take the same advisory gate and row/revision locks. A hold that wins
blocks purge; purge that wins returns `already_purged`, and a later hold cannot
recreate content. This ordering makes the irreversible winner explicit and
prevents legal hold from becoming a hidden access back door.

The schema preserves a future tenant legal-administrator and separation-of-
duties seam but grants it no pilot authority. Tombstones never hash
low-entropy emails or names. They use opaque random lineage IDs and the minimum
policy/event/time fields needed for enforcement. Content hashes, pseudonyms,
and tombstones are potentially personal or sensitive governed data, not
anonymous data.

### Promotion and lifecycle races

An editor may request promotion and an organization administrator may approve
it. A request does not pause expiry and shows its pending/approved/denied/
expired status. Promotion uses the same-organization advisory gate, locks the
dashboard row, obtains database time after the lock, and revalidates
`lifecycle_revision`, authority, policy, and state. It commits only when
`database_now < expires_at`; the inclusive boundary belongs to expiry. The
winner updates the lifecycle revision and writes its fixed audit event in the
same transaction. Audit failure rolls back the would-be winner.

Successful promotion is an in-place `current_kind` transition to durable. It
preserves the dashboard ID, disposable origin, original expiry, versions,
current head, snapshots, evidence, calculation lineage, and policy evidence.
It clears effective expiry only as part of that transition and adds no source,
audience, publication, schedule, or other authority. The promoted Board and its
working head remain private until a separate reviewed publication. An expiry
winner denies promotion. A durable dashboard cannot transition back to
disposable.

### In-flight work and cleanup failure behavior

Every run or worker reauthorizes at claim, immediately before and after each
external call, retry, or wait, and immediately before artifact, head, or cache
commit. `lifecycle_revision` and capability/cache epochs fence stale results.
Expiry cancels work and revokes capability/cache epochs immediately. Workers
cooperate for at most a 15-minute lease-drain window; cleanup proceeds after
the bounded wait and no database transaction spans a network call.

Cleanup retries immediately, then after 5 minutes, 30 minutes, 2 hours, 12
hours, and daily. Alert after three failed attempts or one hour, whichever is
first; require operator reconciliation after seven days. Each attempt and
failure is append-only and visible to administrators. A coordinator may resume
idempotently from a recorded step, but it must never mark a dashboard cleaned
until every eligible claim/artifact action is proven complete. Partial cleanup
keeps access revoked.

These lifecycle rules are schema prerequisites. They must exist in the first
dashboard migration; they cannot be deferred behind a minimal dashboard row.

## Governed run lifecycle

Each run has one durable identifier and one append-only ordered event history.
Mutable projections and checkpoints accelerate queries and resume, and mutable
leases coordinate workers, but all are rebuildable/non-authoritative relative
to the event history.

```text
requested -> authorized -> planning -> candidate generation -> validation
                              ^                 |                |
                              |                 v                v
                              +---------- structured revision <-+
                                                                |
                                      approval required <-------+
                                               |
                                               v
                              accepted / rejected / cancelled /
                              expired / failed
```

Every transition is bounded and policy-checked. Checkpoints make interruption,
resume, cancellation, replay, and investigation explicit. Resuming a run
revalidates current authority, capabilities, inputs, policy, provider budget,
dashboard lifecycle, and expiry; it does not rely only on enqueue-time
authority.

Deterministic orchestration means that trusted control flow can be reconstructed
from pinned inputs and recorded outcomes. It does not mean model output is
deterministic. Replay consumes immutable recorded model and tool results; it
never re-calls a model or tool expecting identical output. A new external call
is a new attempt/run with new metering and provenance, not replay.

The append-only ledger records, as applicable:

- run purpose, dashboard kind, organization, actor or service, authority and
  policy revisions, approved inputs, immutable limits, and idempotency key;
- pinned policy, code, expression-registry, field-catalog, tool-manifest,
  provider/model, and input digests plus `evaluation_time`;
- plan and checkpoint revisions, bounded specialist/reviewer requests, model
  and provider metadata, sanitized prompts or prompt hashes, and metering;
- typed tool requests and results, capability and connection identifiers,
  authorization outcomes, and input/output hashes;
- candidate `DashboardSpec` hashes, calculation graphs, validation findings,
  structured revisions, rankings, and terminal disposition;
- source snapshots, evidence and claim links, human approvals or rejections,
  lifecycle transitions, publication state, schedule state, and cleanup
  outcomes; and
- cancellation, revocation, failure, retry, replay, and recovery events.

Every event records its ordered sequence, canonical payload hash, and previous-
event hash. The chain is mutation evidence and an investigation aid; it is not
tamper-proof against an attacker able to rewrite the entire store. External
signed or WORM anchoring is a separate gated capability and is not claimed by
an internal hash chain.

Every worker acquisition atomically increments a monotonic `lease_epoch`. The
current epoch is required on every event, external result, checkpoint,
artifact/head/cache commit, budget reserve/reconcile/release, and outbox
dispatch. A TTL lease without the epoch is not a fence. Provider dispatch and
result capture use idempotency keys where supported, but acceptance and commit
remain epoch/lifecycle/capability fenced when an external execution cannot be
cancelled.

The ledger excludes credentials and unnecessary sensitive source or prompt
content. Retention, redaction, tenant isolation, and sealed audit copies follow
ADR-003.

## Epistemic and evidence contract

Every material statement has exactly one semantic label:

- **Observed:** directly represented in authorized evidence.
- **Calculated:** deterministically derived through a validated typed graph.
- **Event:** an authorized occurrence with explicit event time and provenance.
- **Hypothesis:** a testable interpretation, not established fact.
- **Recommendation:** a proposed safe action with supporting rationale.
- **Unknown:** evidence is insufficient to state or recommend safely.
- **Blocked:** authority, policy, capability, or required validation prevents an
  answer.

Temporal proximity between an Event and a value never establishes causality.
Evidence state is separate from semantic type and is exactly `complete`,
`partial`, `contradicted`, `stale`, or `unsupported`. A generic confidence score
is never presented as correctness and cannot replace coverage, freshness,
contradiction, or validation state.

Evidence records are support artifacts, not semantic Claims. The `0003`
`dashboard_version_evidence` relation is revision-level provenance only; it does
not prove claim-level coverage. The later trust plan adds stable Claim and
ClaimEvidence relations with `supports`, `contradicts`, or `context` edges plus
an immutable evidence manifest per candidate/version.

Metric contracts, publications, Decision Snapshots, Recipes, alerts, Claims,
and runs attach outward through stable organization/dashboard/version/snapshot/
evidence/artifact IDs and canonical hashes. They do not add speculative nullable
columns or provider IDs to `0003`. Manual and agent-authored semantic edits
always create insert-only versions with explicit parent and canonical hash; a
later prompt can never overwrite a manual edit in place.

## Typed calculations and evidence chain

A model may propose a calculation as a typed directed acyclic graph. Its wire
form is a strict discriminated JSON AST inspired by CEL's typed-expression
approach; it is not unrestricted CEL source and is not JSON Logic source. Each
operation has one schema, required fields, and `additionalProperties: false`.
Unknown operation, key, schema/registry version, field, or literal kind fails.

Every accepted expression pins `schema_version`, `registry_version`, a stable
`field_catalog_snapshot_id`, `input_snapshot_id`, `evaluation_time`,
`timezone_database_version`, declared limits, and the canonical accepted-AST
hash. A field reference contains a stable `field_id`, never a free-form or
dynamic path. The pinned catalog declares each field's type, nullability, unit,
currency, grain, event-time semantics, and freshness rule.

Pilot registry v1 contains only:

- typed stable field references and typed literals;
- bounded select, filter, group, sort, rank, and top-k;
- `count_rows`, `count_present`, `sum`, `min`, `max`, and `mean`;
- add, subtract, multiply, and divide, with divide-by-zero as failure;
- absolute value and clamp;
- comparisons, exact boolean operators, conditional, and coalesce;
- lag, delta, percentage change, and bounded time window;
- explicit unit conversion through a versioned dimension registry;
- explicit missing, null, unavailable/error, and stale classification; and
- explicit rounding and decimal scale.

Exact numbers and money use integer minor units or canonical decimal
coefficient/scale strings with explicit scale and rounding. Binary-float money,
NaN, infinity, overflow, implicit scale change, and hidden intermediate rounding
fail. Conditional predicates are exact booleans; branches have identical type,
unit, currency, and grain. Missing means absent, explicit null means present but
null, unavailable/error means evaluation could not obtain a value, and stale
means present but outside the pinned freshness rule; they are never silently
coalesced.

`count_rows` counts rows and `count_present` counts non-missing/non-null values.
On empty input, both counts are zero, typed `sum` is the exact zero of its
declared type/unit, and `min`/`max`/`mean` return the explicit `empty_input`
missing state. There is no general reduce, unrestricted distinct, or unbounded
set operation. Sort/top-k requires an explicit stable tie key and bounded
literal `k`.

Lag/window nodes require explicit partition keys, a unique total order, event-
time field, and bounded frame. Fixed-duration windows and calendar periods are
distinct operations. UTC instants and closed grain rules are explicit;
timezone/calendar operations pin their version and timezone database. Unit
conversion handles both multiplicative and affine units. Currency remains a
separate explicit evidence-linked FX conversion using an approved immutable
rate snapshot.

There is no arbitrary code, SQL, regular expression, dynamic property path,
dynamic function, implicit join, general recursion, or unbounded cardinality.
Each evaluation has hard caps for source/AST bytes, AST nodes/depth,
literals/list lengths, scanned rows, groups/group size, intermediate/output
bytes and cardinality, evaluator steps, wall time, and memory. A static
type/unit/cost/cardinality pass must succeed before execution; runtime meters
the same limits and fails closed. CEL termination properties alone would not
establish that a calculation is cheap enough for Dasher.

Validation rejects cycles; unknown operations/keys/versions/fields/literals;
ambiguous or incompatible types, units, currencies, grains, branches, and time
windows; non-finite/overflowed results; unavailable required values; bounded-
work violations; invented inputs; unavailable or cross-tenant evidence;
disallowed sensitivity combinations; and policy/resource violations. Trusted
services execute the accepted graph deterministically and record engine,
schema/registry/catalog/input/timezone versions, declared limits, accepted AST,
output, and evidence hashes.

The evidence chain is:

```text
authorized source -> immutable snapshot -> typed field or record
  -> validated transformation/calculation graph -> material statement or value
  -> DashboardSpec component -> dashboard version
```

In `0004+`, a stable Claim and its ClaimEvidence edges bind the material
statement to this chain; the `0003` version-evidence link alone does not.

Interpretations and recommendations additionally record the model and prompt or
instruction revision, supporting facts, uncertainty, and validation outcome.
They must not present unsupported inference as an observed or calculated fact.

### Candidate validity, ranking, and review

Hard validity runs before ranking. A versioned deterministic ranker then scores
only valid candidates for evidence coverage, task coverage, accessibility,
clarity, freshness, and policy-compliant cost/latency. A model recommendation
cannot waive hard validity, evidence, authority, or policy. Deterministic ties
use canonical content hash, never provider return order.

Materially different, valid, evidence-supported judgments remain visible. The
manager sees a recommended draft in the Standard flow and a `Compare
alternatives` action only when alternatives are materially distinct and valid;
the human accepts the result. A schema-valid candidate that is incompletely
reviewed or ranked is not promotable. This preserves useful disagreement
without making candidate volume or model confidence an authority mechanism.
An expression/validity failure quarantines that candidate, preserves the prior
good head, and returns a structured, non-executable finding for bounded repair;
the UI never renders a partial number as fact. If no fully valid and reviewed
candidate remains, the run fails with evidence and retry guidance rather than a
fallback promotion.

## Thirty-second managerial projection

Every manager-facing Board or Scratch reserves five fixed above-fold slots:

1. **Known:** current/target or comparison value, data-as-of time, and metric-
   contract version.
2. **Changed:** baseline to current plus no more than three material changes,
   each labeled Observed or Calculated.
3. **Important:** threshold edge, goal gap, impact, or due decision. Nearby
   Events may be context but never imply causality.
4. **Next safe action:** exactly one proposal by default, with owner, intended
   effect, reversibility, required permission, and preview. If evidence does not
   support one, show Unknown and make no plausible recommendation.
5. **Evidence:** material-Claim coverage, oldest referenced data age, metric-
   contract health, and warnings.

A freshness, contract, or comparison failure displaces the affected insight;
it is not demoted to a footnote beneath a confident summary.

The first interaction opens a change drawer with values, contributors, Events,
caveats, evidence, and proposed action. The second opens technical lineage:
Claim -> mark/component -> typed calculation -> metric contract -> evidence ->
snapshot, including hashes, filters, grain, units, revisions, and evaluation
time. Raw run logs are available to authorized technical/admin investigations
but are not required for manager comprehension.

## Typed tools and authorization

A tool contract declares its input and output schema, operation class, source
and resource scope, side-effect class, required role, sensitivity, egress,
budget, timeout, and evidence behavior. A capability binds the narrowest useful
operation to an organization, actor or service, run purpose, resource set,
connection and manifest revision, policy revision, expiry, and call/resource
budget.

Before each tool attempt and before accepting its result, the broker verifies
current membership or service authority, capability state, source and
connection approval, credential version, policy, dashboard state, expiry, and
budget. Provider-hosted tools remain disabled: the orchestrator requests tools
through Dasher's broker, and the provider receives inference-only requests
through ADR-004's gateway.

Read-only is not sufficient by itself. Tool metadata and returned content are
hostile data; prompt content cannot select tools, resources, scopes,
destinations, credentials, or follow-on calls. A tool may return only its typed,
size-limited result plus evidence metadata. A write or external side-effect tool
is outside this ADR and the pilot.

## Autonomy and approval

Policy selects a maximum autonomy tier for each organization and use case. A
run may operate below its maximum tier but cannot raise it.

1. **Suggest:** use already supplied immutable inputs to propose a plan and
   preview candidates; no source retrieval or lifecycle change.
2. **Governed draft:** use already approved read-only source capabilities and
   budgets to retrieve snapshots, calculate, revise, and prepare a private
   candidate; no publish or recurring work.
3. **Governed refresh:** refresh an existing durable dashboard only within a
   previously human-approved source set, schedule, and cost ceiling, producing
   a private validated candidate while the prior good head remains active. New
   authority still pauses for approval.

Regardless of tier, a human must approve any new or broadened authority, source
or connection, publication or audience change, and new or increased recurring
schedule/cost. Promotion from disposable to durable is explicit and audited.
Organization policy may require additional approval or prohibit a tier.

### Aggregate per-run budgets

The defaults are aggregate ceilings for the entire run, including candidates,
specialists, review, retry, and repair; they are not per-agent allowances.

| Tier              | Candidate work            | Specialists | Reviewers | Tool attempts | Model calls | Repairs total | Tokens | Wall time | Cost  |
| ----------------- | ------------------------- | ----------- | --------- | ------------- | ----------- | ------------- | ------ | --------- | ----- |
| Suggest           | 2 candidates              | 1           | 1         | 0             | 5           | 1             | 30k    | 45s       | $0.15 |
| Governed draft    | 3 candidates              | 2           | 1         | 4             | 8           | 2             | 80k    | 120s      | $0.50 |
| Governed refresh  | 1 primary + 1 replacement | 1           | 1         | 4             | 6           | 2             | 50k    | 90s       | $0.25 |
| Administrator max | 4 candidates              | 3           | 2         | 8             | 12          | 3             | 160k   | 240s      | $2.00 |

These defaults and absolute ceilings are Dasher private-pilot product policy,
not industry, legal, or security standards. The administrator maximum is an
absolute policy ceiling, not a suggested configuration. Concurrency is at most
two active runs per organization, one active run per dashboard, and one
provider call at a time per run. A running budget cannot expand. A future human
policy change starts a new run instead of mutating an active run. Specialists
and reviewers receive zero tools and cannot recurse or spawn another role.

The later budget ledger stores immutable limits and separate reserved, used,
and released counters. Candidate-generation and independent-review allocations
are partitioned so generation retry/fallback cannot consume reviewer capacity;
there is no automatic borrowing. Every actual attempt counts, including
failure, timeout, repair, fallback, specialist, and reviewer attempts.

Metering includes:

- per-tool attempts and tool-specific pages, rows, raw bytes, egress,
  subprocesses (pilot ceiling zero), and concurrency;
- input, output, reasoning, cache-write, cache-read, and total token categories;
- cost as integer micros or nanos in one versioned base currency;
- wall time and working time; and
- expression source/AST/input/output bytes, nodes, depth, literals/list lengths,
  rows, groups/group size, cardinality, evaluator steps, wall time, and memory.

Before every paid or external call, the gateway atomically resolves the exact
provider/model and versioned price book, conservatively estimates worst case,
reserves every relevant counter, appends `attempt_reserved`, and commits before
dispatch. It persists response/usage and atomically reconciles reserved to
used/released counters. Unknown pricing or token estimation denies. A timeout
after dispatch is billing-indeterminate and does not release its reservation
until provider reconciliation or an explicit quarantine-expiry/operator policy
decision. Retry and fallback require a fresh reservation; neither inherits the
prior attempt's capacity.

At 80% of any budget, the orchestrator stops exploration and finishes from
evidence already obtained. Only one transient transport failure may be retried,
and retry repeats every authority, lifecycle, capability, pricing, reserve, and
budget check. A valid but incompletely reviewed or ranked candidate is not
promotable. Hard invariant failure fails the candidate or run; only usefulness,
clarity, diversity, and latency may be treated as borderline soft dimensions.

These aggregate limits keep latency and cost comprehensible, prevent hidden
multiplication through role fan-out, and make a run reconstructable from one
ledger. On denial, the UI names the binding limit without exposing provider or
security internals, preserves any prior good head, and offers a smaller new run
rather than a mid-run expansion.

### Promotion policy and progressive disclosure

Auto-promotion is off for the pilot. Governed refresh creates a private,
validated candidate and leaves the prior good head active until a human
accepts. A later opt-in routine auto-update is outside this slice and may cover
only deterministic data-only change with unchanged source authority and set,
structure, calculation graph, interpretation/recommendation text, audience,
and policy. Any model-authored semantic change remains manual.

The manager sees the Standard flow and recommended result. `Compare
alternatives` appears only for materially distinct valid candidates. The five
fixed slots and two-interaction lineage contract above govern the default view.
Administrators see exact budgets, metering, denials, and the upper bound of any
recurring cost. This keeps the ordinary decision surface calm while making
authority and spend inspectable where they are controlled.

## Passwordless forward contract

Passwordless identity is a later forward migration, never part of dashboard
migration `0003`. The built-in issuer uses an opaque stable subject; email is
only a verified delivery and invitation/account binding. A challenge uses a
32-byte random magic-link secret, stores only a domain-separated HMAC digest,
is single use, and expires after 10 minutes. At most one active challenge may
exist per normalized email, organization, and purpose; issuing a new challenge
invalidates the old one.

Generic, non-enumerating limits are 5 requests per email/organization per 15
minutes, 60 per IP per hour, and 200 per organization per hour. The initial GET
does not consume the challenge. It renders a no-store, no-referrer, strict-CSP
page with no third-party content; an explicit same-origin POST performs the
exchange. Exchange revalidates invitation, verified delivery binding,
membership and authority revision, organization policy, challenge expiry,
single-use state, and replay under locks. A matching email never links
identities. An organization that requires an external IdP fails closed on the
built-in path.

Sensitive administrator actions require authentication no older than 15
minutes. The existing 30-minute idle and 7-day absolute session limits remain
unchanged. Denials use one generic response and do not reveal whether an email,
invitation, identity, membership, or policy exists. These rules make link
previewers harmless, keep email out of canonical identity, and preserve current
session containment.

## Development and deployment stages

Stages are gates, not claims that any environment is deployed:

1. **Synthetic fixture lab:** authenticated; no database, live provider,
   customer data, or customer credential.
2. **Synthetic passwordless control plane:** built-in identity path and only
   synthetic data after its separate forward migration and security gate.
3. **Inspectable fake-agent/replay lab:** only after the lifecycle and run plan;
   fake provider, deterministic fixtures, no live provider credential.
4. **Capped live smoke:** only after provider gateway, budget enforcement,
   revocation, and kill switch pass on the exact environment.

Repository documentation must not claim a deployed stage unless tracked
evidence already establishes it. Passing one stage does not authorize the next.

## Provider-neutral execution, replay, and evaluation

The harness depends on ADR-004's provider-neutral inference contract and does
not embed provider-specific authority in plans, tools, ledgers, calculations,
or `DashboardSpec`. Provider adapters return typed model content and metadata;
they cannot call tools or commit state.

Development begins with:

- a fake provider that has no network or credential access and can produce
  success, invalid output, refusal, timeout, budget, and retry scenarios;
- content-addressed replay fixtures for authorized inputs, model responses,
  tool results, validation feedback, approvals, and terminal outcomes;
- deterministic validation and calculation replay, with explicit handling for
  nondeterministic model candidate generation; and
- evaluation corpora that measure hard-invariant compliance, evidence
  coverage, revision success, candidate diversity, decision usefulness,
  accessibility, latency, and cost without treating synthetic agents as human
  research.

A replay reads those immutable recorded responses and results in event order;
it never re-dispatches a model/tool call to test for identical output. A replay
never grants current source, credential, publication, or scheduling authority
and cannot silently commit against a live dashboard. Code/policy/tool/model
digests and safe worker-version routing prevent a resumed history from silently
changing semantics; safe-deployment mechanics are separately tested rather
than inferred from a code version string.

## Acceptance gates

### Documentation and schema gate

- This proposed ADR and a reviewed implementation plan precede any new
  immutable dashboard-schema migration or harness implementation.
- Immutable migrations `0001_identity_audit.sql` and
  `0002_security_boundary.sql` are not edited. Required identity and dashboard
  evolution uses separately reviewed, forward-only migrations.
- Migration `0003` is not authored until the successor plan's lifecycle-safe
  control row, access derivation, evidence links, retention claims, purge seam,
  fixed function/ACL inventory, and adversarial matrix pass dual documentation
  review. The agent-run ledger and passwordless identity are `0004+` concerns;
  `0003` reserves their provider-neutral revision, epoch, policy, hash, and
  relation seams without nullable speculative provider identifiers.
- Workspace, Scratch, Board, Published, Decision Snapshot, and Recipe retain
  their normative meanings. `head_version_id`, `active`, and promotion are never
  publication/audience authority. `0003` version-evidence links are revision-
  level provenance, not Claim/ClaimEvidence coverage, and no decision/Recipe/
  alert/bookmark/share creates Scratch retention.
- Existing `DashboardSpec` 1.0 remains readable without `executiveBrief` and
  rejects `executiveBrief`; 1.1 remains the current Executive Brief contract
  and requires its strict evidence-linked `executiveBrief`. Lifecycle metadata,
  typed calculation graphs, safe-expression fields, or component-contract
  expansion must not be added silently to 1.0 or 1.1. Any serialized-spec
  expansion requires an explicit new schema version, a strict validator,
  deterministic migration or adaptation, and backward-compatibility and
  unknown-field rejection tests.
- The harness remains compatible with those versioned declarative
  `DashboardSpec` contracts, and
  `docs/security/GENERATED_CODE_GATE.md` remains exactly `Status: CLOSED`.

### Harness contract gate

- Fake-provider tests exercise dynamic plans, multiple candidates, bounded
  specialist/reviewer passes, structured validation repair, cancellation, and
  every terminal state with zero network and zero credential access.
- Typed-tool tests deny missing, expired, revoked, over-budget, cross-tenant,
  broadened, wrong-purpose, wrong-source, wrong-manifest, and stale-authority
  capabilities on each use and result commit.
- Calculation tests cover graph cycles, type and unit errors, evidence gaps,
  strict closed JSON-AST schemas, stable field IDs, exact decimal/null/
  aggregate/window/affine-unit/FX semantics, static cost/cardinality analysis,
  runtime hard caps, sensitivity policy, and recorded-result replay.
- Ledger tests prove append-only event ordering, pinned digests and evaluation
  time, payload/previous hashes with honest limitations, rebuildable mutable
  checkpoints/projections, idempotency, crash/resume behavior, monotonic lease-
  epoch fencing on every event/result/commit/budget/outbox path, revocation
  races, lineage, redaction, tenant isolation, and reconstruction of every
  accepted claim and dashboard version without model/tool redispatch.
- Budget tests prove immutable limits; separate reserved/used/released counters;
  partitioned reviewer allocation; all attempt/resource/token/time/expression/
  integer-cost categories; reserve-and-commit before dispatch; fenced
  reconciliation; indeterminate timeout quarantine; unknown-estimate denial;
  and a fresh reservation for every retry/fallback.
- Approval tests prove that authority, source, publish/audience, recurring-cost,
  and disposable-promotion boundaries cannot be crossed by model output,
  configuration drift, retry, replay, or stale approval.
- Epistemic tests require one typed statement label, a separate evidence state,
  explicit Unknown/Blocked abstention, no confidence-as-correctness, no Event-
  proximity causality, insert-only semantic edits, and immutable evidence
  manifests before publication.

### Dashboard lifecycle gate

- Durable dashboards preserve insert-only versions and the prior good version
  on failed refresh; changed-since values resolve to explicit version,
  snapshot, calculation, and evidence lineage.
- Disposable dashboards require an explicit policy-valid expiry, have no
  recurring work, revoke access and cancel work at the inclusive expiry
  boundary, and demonstrate quarantine, bounded cleanup, reference-aware
  deletion, legal hold, restore-as-new, and failure recovery.
- Promotion to durable is explicit, authorized, audited, race-safe, and
  preserves snapshots, evidence, versions, calculations, and origin lineage
  without silently creating a schedule, publication, audience, or retention
  authority beyond the new Board lifecycle.
- Backup, restore, deletion, retention, legal-hold, and cleanup behavior pass in
  the authoritative storage and database environments before real data;
  evidence distinguishes product revocation, logical recovery expiry,
  cryptographic unrecoverability, and provider physical-media deletion.

### Evaluation and live-provider gate

- Replay and adversarial corpora cover prompt injection, unsupported claims,
  hidden-tool requests, authority escalation, source substitution, approval
  bypass, resource exhaustion, and validation-feedback manipulation.
- Evaluations show useful candidate diversity across narratives, layouts,
  supported components, metrics, comparisons, and transformations without
  weakening hard invariants. Governed output is not reduced to a fixed
  template suite.
- A capped live-provider smoke occurs only after the fake-provider, gateway,
  secret-redaction, budget, revocation, and kill-switch gates pass on the exact
  deployment.
- Manager-user comprehension and usefulness remain separate real-user product
  gates; replay or model review does not satisfy them. The live-pilot gate times
  the five-slot 30-second task and evidence access within two interactions.

## Alternatives considered

### Treat the pilot as one dashboard per user

Rejected. Managers need a workspace containing ongoing decision surfaces and
quick one-off investigations. Collapsing both into one lifecycle obscures
history, refresh, expiry, cleanup, and promotion semantics.

### Make disposable dashboards untracked temporary copies

Rejected. A copy without explicit expiry, cleanup, evidence, and promotion
lineage becomes either an undeletable shadow dashboard or an unauditable path
to durable decisions.

### Use a fixed planner or template catalog as the product ceiling

Rejected. Templates can seed or constrain safe output, but they cannot dictate
every useful narrative, comparison, metric, component composition, or layout.
Governance is enforced through typed contracts and validators.

### Let a general autonomous agent choose tools and execute code or SQL

Rejected. It combines creative output with credentials and ambient authority,
bypasses the declarative contract, and conflicts with the closed generated-code
gate.

### Start with an unconstrained multi-agent swarm

Rejected. Independent agents complicate authority, budget, cancellation,
provenance, and replay before the core loop is proven. One orchestrator may use
bounded specialist and reviewer roles while retaining one run policy and
ledger.

### Let deterministic services choose all dashboard ideas

Rejected. Deterministic services should validate and execute trusted
operations. Making them choose every narrative and layout would turn safety
mechanisms into a template product and suppress useful model creativity.

### Accept the first schema-valid candidate

Rejected. Schema validity is necessary but does not establish evidence
coverage, decision usefulness, accessibility, or comparative quality.
Multiple bounded candidates and structured revision allow better output without
relaxing safety.

## Explicitly rejected, deferred, or UI-only

Rejected for this architecture: generated SQL, code, shell, packages, network
access, or editable code cells; chain-of-thought as an audit record; confidence
as correctness; Scratch renewal, pin/bookmark persistence, schedules, or links
that survive expiry; automatic publication or external action; causality inferred
from temporal proximity; and generic dashboard clones.

Partial/selective Scratch promotion is deferred. A later reviewed copy from a
selected immutable revision must use a new identity and explicit provenance and
is not promotion. Quarantine restore-as-new remains the narrowly defined
recovery operation, not a clone feature.

UI-only/future concepts are a three-pane Compose experience, native declarative
canvas, Trust Rail, component-merge UI, audience-safe lenses/recipient preview,
registry/duplicate/retirement workflow, and channels/collaboration/digests.
Their UX value does not justify product UI tables or retention authority in
`0003`.

## Tradeoffs and consequences

- Multiple candidates and review passes improve creative range but increase
  latency and provider cost, so attempt and budget ceilings are product-visible
  policy.
- Typed calculation graphs expand useful model proposals while increasing the
  validator, unit system, primitive-registry, and evaluation surface.
- Append-only ledgers, checkpoints, versions, and retained evidence consume
  storage but make resume, refresh, promotion, replay, audit, and claims
  inspectable.
- Secure disposable cleanup reduces long-lived data but introduces expiry,
  race, retention, restore, and legal-hold complexity.
- One governed orchestrator simplifies authority and replay, but bounded
  specialist diversity must be evaluated so orchestration does not collapse to
  one repetitive design style.
- Provider neutrality and typed tools require adapter and broker work, but keep
  credentials, authority, and lifecycle policy outside model prompts and
  provider-specific features.
- Designing lifecycle and ledger contracts before immutable schema delays
  implementation, but avoids encoding unsafe expiry, identity-linking, cleanup,
  promotion, budget, expression, and review behavior into migrations and
  contracts that cannot be edited in place.

## Decision completeness

The prior open product decisions are locked by this ADR: disposable TTL and
retention; legal hold, restore, and promotion races; durable-refresh manual
acceptance; aggregate run defaults and absolute ceilings; safe-expression v1;
and deterministic ranking with human review. Remaining work is implementation
design review and evidence, not product-policy invention. This ADR remains
`Proposed` until reviewed and merged; proposed status does not authorize the
held `0003` or any harness, passwordless, live-provider, or deployment work.
