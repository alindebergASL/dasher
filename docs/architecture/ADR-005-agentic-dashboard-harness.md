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
every use, an append-only run and checkpoint ledger, an end-to-end evidence
chain, explicit autonomy tiers, and human approval at authority, source,
publish, and recurring-cost boundaries. Model inference goes through the
provider-neutral gateway. Initial development uses fake providers,
deterministic replay, and evaluation corpora before any capped live-provider
gate.

Generated-code execution remains `CLOSED`. The only presentation output is a
validated, versioned declarative `DashboardSpec`. No model, plan, calculation,
tool call, or validation repair may introduce arbitrary code, SQL, credentials,
ambient authority, hidden side effects, or unsupported claims.

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

## Workspace and dashboard lifecycle

The workspace treats durable and disposable dashboards as first-class kinds.
Exact default, minimum, and maximum disposable time-to-live values remain an
open product decision.

### Durable dashboards

A durable dashboard is intended to remain useful over time. It has insert-only
version history, manual refresh and an explicitly authorized schedule,
prior-good-version preservation, and visible changed-since value with the
provenance that supports that comparison.

A conceptual lifecycle is:

```text
draft -> validating -> candidate -> active -> archived
              |           |
              v           v
            rejected    superseded

active -> refresh requested -> validating candidate -> promoted active version
                                  |
                                  v
                         failed; prior good stays active
```

Changed-since is a typed comparison between identified dashboard versions and
their source snapshots. It records the baseline, current version, calculation
or transformation, relevant evidence, and freshness. A narrative alone cannot
establish change.

### Disposable dashboards

A disposable dashboard is optimized for quick, bounded use. Creation requires
an explicit expiry, schedules no recurring work by default, and enters secure
cleanup when it expires. Cleanup revokes access and capabilities first, cancels
derived work, then applies the approved deletion and retention policy to
artifacts while preserving only the audit material that policy requires.
Cleanup completion and failures are auditable.

A conceptual lifecycle is:

```text
draft -> active -> expiry pending -> access revoked -> cleanup -> cleaned
            |
            v
       promotion requested -> durable candidate -> durable active
```

An authorized user may explicitly promote an unexpired disposable dashboard to
durable. Promotion is a reviewed lifecycle transition, not a lossy copy: it
preserves source snapshots, evidence, candidate and accepted versions,
calculation lineage, and the disposable-to-durable relationship. Promotion
does not silently add a refresh schedule or broaden source authority.

Expiry, retention, legal hold, promotion races, in-flight runs, failed cleanup,
and restore behavior must be resolved in the implementation plan before an
immutable dashboard schema is authored.

## Governed run lifecycle

Each run has one durable identifier and one append-only history. Mutable leases
may coordinate work, but they are not the record of what happened.

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

The append-only ledger records, as applicable:

- run purpose, dashboard kind, organization, actor or service, authority and
  policy revisions, approved inputs, budgets, and idempotency key;
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

The ledger excludes credentials and unnecessary sensitive source or prompt
content. Retention, redaction, tenant isolation, and sealed audit copies follow
ADR-003.

## Typed calculations and evidence chain

A model may propose a calculation as a typed directed acyclic graph whose nodes
reference approved snapshot fields or prior typed nodes. Safe expressions use
only reviewed primitives, such as bounded arithmetic, aggregation, comparison,
time-window, grouping, filtering, missing-value, and unit-conversion operations.
The exact primitive registry is versioned.

Validation rejects cycles; unknown operations; ambiguous or incompatible
types, units, currencies, grains, and time windows; non-finite results;
unbounded cardinality or work; invented inputs; unavailable or cross-tenant
evidence; disallowed sensitivity combinations; and policy or resource
violations. Trusted services execute the accepted graph deterministically and
record engine, registry, input, output, and evidence hashes.

The evidence chain is:

```text
authorized source -> immutable snapshot -> typed field or record
  -> validated transformation/calculation graph -> claim or value
  -> DashboardSpec component -> dashboard version
```

Interpretations and recommendations additionally record the model and prompt or
instruction revision, supporting facts, uncertainty, and validation outcome.
They must not present unsupported inference as an observed or calculated fact.

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
   a validated candidate. Whether policy may automatically advance that
   candidate to the active head is Open Product Decision 3 and must remain
   disabled until that decision is explicitly resolved; new authority still
   pauses for approval.

Regardless of tier, a human must approve any new or broadened authority, source
or connection, publication or audience change, and new or increased recurring
schedule/cost. Promotion from disposable to durable is explicit and audited.
Organization policy may require additional approval or prohibit a tier.

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

A replay never grants current source, credential, publication, or scheduling
authority and cannot silently commit against a live dashboard.

## Acceptance gates

### Documentation and schema gate

- This proposed ADR and a reviewed implementation plan precede any new
  immutable dashboard-schema migration or harness implementation.
- Immutable migrations `0001_identity_audit.sql` and
  `0002_security_boundary.sql` are not edited. Required identity and dashboard
  evolution uses separately reviewed, forward-only migrations.
- The plan resolves dashboard/run state transitions, concurrency and promotion
  races, exact ledger/checkpoint records, retention and cleanup failure modes,
  expression primitives, budgets, and owner-reserved TTL values.
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
  unsupported expressions, non-finite values, cardinality and resource bounds,
  sensitivity policy, and deterministic replay.
- Ledger tests prove append-only ordering, idempotency, complete checkpoints,
  crash/resume behavior, revocation races, lineage, redaction, tenant isolation,
  and reconstruction of every accepted claim and dashboard version.
- Approval tests prove that authority, source, publish/audience, recurring-cost,
  and disposable-promotion boundaries cannot be crossed by model output,
  configuration drift, retry, replay, or stale approval.

### Dashboard lifecycle gate

- Durable dashboards preserve insert-only versions and the prior good version
  on failed refresh; changed-since values resolve to explicit version,
  snapshot, calculation, and evidence lineage.
- Disposable dashboards require an explicit policy-valid expiry, have no
  recurring work by default, revoke access and cancel work at expiry, and
  demonstrate bounded, observable cleanup and failure recovery.
- Promotion to durable is explicit, authorized, audited, race-safe, and
  preserves snapshots, evidence, versions, calculations, and origin lineage
  without silently creating a schedule.
- Backup, restore, deletion, retention, legal-hold, and cleanup behavior pass in
  the authoritative storage and database environments before real data.

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
  gates; replay or model review does not satisfy them.

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
  implementation, but avoids encoding unresolved TTL, identity-linking,
  cleanup, and promotion decisions into migrations that cannot be edited.

## Open product decisions

1. The default, minimum, maximum, and organization-configurable TTLs for each
   disposable-dashboard use case.
2. Which disposable artifacts are deleted, cryptographically erased, retained
   as audit hashes, or held under customer retention and legal-hold policies.
3. Whether durable refresh candidates auto-promote inside a human-approved
   policy or always require review for specified sensitivity or impact classes.
4. Candidate-count, specialist/reviewer, token, latency, and cost defaults by
   autonomy tier and organization policy.
5. The initial safe-expression primitive set and unit/currency/time-grain
   semantics.
6. The ranking and human-review policy when several valid candidates make
   materially different but evidence-supported judgments.
