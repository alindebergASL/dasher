# Agent Run Ledger and Deterministic Calculations Implementation Plan

> **For Hermes:** Use the `subagent-driven-development` skill to implement this
> plan task-by-task, with one active writer and independent specification then
> code-quality review at every exact-byte gate.

**Status:** Proposed — docs-only planning; implementation HOLD

**Goal:** Add a tenant-isolated, append-only agent-run ledger, fenced run and
budget coordination, strict deterministic calculation graphs, immutable claim
evidence manifests, and zero-network fake-provider/content-addressed replay as
additive migration `0007` and bounded TypeScript packages.

**Architecture:** PostgreSQL remains authoritative for run identity, event order,
lease epochs, immutable budgets, current authorization, claims, and evidence
bindings. A restricted run operator may mutate only through fixed functions that
lock and reauthorize exact rows; app callers use the existing pinned tenant
transaction wrapper. Pure TypeScript packages validate and execute a closed
calculation AST and orchestrate fake/replayed provider results without network,
credentials, tools, publication, or dashboard-head mutation.

**Tech Stack:** PostgreSQL 16.14, TypeScript 5.9, Node 22, pnpm 10.14, Zod 4,
node-postgres, Vitest, existing Next.js/Playwright aggregate gates.

---

## 1. Decision lock and authorization boundary

This plan is based on exact merged `main`
`1aab2a0012a1f577046e30c333a50ca02fe37725`, tree
`34e71e18294f64502f709b440fb11dd6f2103f3f`. Its factual companion is
`docs/status/2026-08-04-lifecycle-foundation-and-task-9-planning-baseline.md`.

This document plans implementation; it does not implement or authorize it.
Implementation begins only after this exact planning tree passes both independent
review lenses, the planning PR is separately approved and merged, and the owner
explicitly authorizes an implementation branch from then-current `main`.

Migrations `0001`–`0006` are immutable. The only migration number available to
this slice is `0007`. Historical ADR/plan references to `0004+`, a synthetic
trust/run gate at `0004`, or a fake-agent/decision gate at `0005` express
sequencing, not reusable filenames. This slice must never renumber or rewrite
history.

Generated-code execution remains exactly `Status: CLOSED`.

### In scope

- additive `0007` catalog, role, fixed-function, ACL, RLS, trigger, and journal
  contracts;
- one append-only ordered event history per run;
- rebuildable run projections and revisioned checkpoints;
- monotonic `lease_epoch` fencing and one active run per dashboard;
- immutable per-run limits, partitioned generation/review allocations, and
  separate reserved/used/released counters;
- strict calculation AST parsing, static validation, deterministic execution,
  runtime meters, and immutable accepted graph/results;
- stable Claims, ClaimEvidence support/contradiction/context edges, and one
  immutable evidence manifest per candidate;
- a provider-neutral adapter contract implemented only by a zero-network fake;
- content-addressed replay that consumes recorded results without redispatch;
- Suggest-tier candidate generation, bounded specialist/reviewer roles, structured
  repair, cancellation/resume, and every Task 9-reachable outcome; and
- local/unit/PostgreSQL/adversarial/exact-head verification.

### Explicitly out of scope

- live providers, provider credentials, SDKs, HTTP clients, egress, OAuth, MCP,
  model web search, provider-hosted tools, or a production model gateway;
- customer data, uploads, object storage, live connectors, raw source-byte
  admission, schedules, recurring work, queues, external outbox dispatch, or a
  long-running worker process;
- application routes, Server Actions, UI, publication, audience changes,
  dashboard promotion, dashboard-head compare-and-swap, or automatic acceptance;
- write/external-effect tools, shell, SQL generation, arbitrary expressions,
  editable code cells, package installation at runtime, or generated workloads;
- Decision Snapshot, Recipe, alerts/actions, passwordless identity, protected
  deployment, historical-data remediation, or Gate 2 completion; and
- changes to `DashboardSpec` 1.0 or 1.1. Candidate metadata and claim manifests
  remain outside serialized specs; any future spec expansion requires a new
  separately planned schema version.

No passing fake/replay test may be described as live-provider, real-user,
production, deployment, or protected-release evidence.

## 2. Carry forward and leave behind

### Carry forward

- ADR-003 server-derived organization/user/service context, forced RLS,
  restricted runtime roles, immutable facts, reauthorization, audit atomicity,
  and prior-good-state preservation;
- ADR-004 provider-neutral inference contract, inference-only provider boundary,
  per-attempt authority/budget checks, and no cross-credential fallback;
- ADR-005 run lifecycle, append-only ledger, honest hash-chain limitation,
  lease-epoch fencing, epistemic labels, calculation semantics, aggregate budgets,
  fake-provider/replay-first sequence, and human authority boundaries;
- `DashboardLifecycleRepository`'s preflight-before-connect discipline, pinned
  `BEGIN` / `SET LOCAL search_path = pg_catalog` / `initialize_context` / one
  fixed call / commit sequence, normalized denials, rollback, release, and
  pooled-client destruction on ambiguous cleanup; and
- the migrator's exact-prefix, checksum, role-comment, catalog, dependency,
  replay, rollback, and no-adoption model.

### Leave behind

- obsolete migration numbers in historical prose;
- the idea that provider/model nondeterminism can be replayed by calling again;
- caller-selected tenant, policy, budget, price, field, evidence, capability,
  or lease context;
- a mutable log treated as authority, a TTL lease without an epoch, generic JSON
  operation envelopes, generic SQL callbacks, or table-wide runtime mutation;
- confidence scores as correctness, event proximity as causality, implicit
  floating-point money, dynamic field paths, arbitrary CEL/JSON Logic, and
  unbounded reductions; and
- any implementation that needs live transport, credentials, tools, routes, UI,
  storage, or deployment merely to prove this slice.

## 3. Product and run contract

### 3.1 Bounded run lifecycle

The closed run states are:

```text
requested -> authorized -> planning -> generating -> validating
                                  ^          |             |
                                  +-- revising <------------+
                                                     |
                                             approval_required
                                                     |
                                rejected | cancelled | expired | failed

                 accepted is reserved: no Task 9 transition enters it
```

Task 9 can place a fully validated private candidate and immutable evidence
manifest in durable `approval_required` state. That state clears the worker lease
and waits without consuming budget; it does not publish, change an audience,
advance `dashboards.head_version_id`, promote a Scratch, create a schedule, insert
`dashboard_versions`, or create snapshot/evidence `access_bearing` reference
claims. `accepted` remains a reserved future terminal value, but no Task 9
function, trigger, repository method, fake fixture, or replay may enter it.

A later, separately accepted human-approval plan must add a tenant-facing function
that reauthorizes current actor membership, lifecycle, policy, candidate bytes,
manifest, evidence, and reference-claim eligibility. It must use the existing
`dasher_api.create_dashboard_version` semantics with fresh IDs and claims before
any accepted/head action and may not copy old run authority. The current candidate
is therefore an immutable private run artifact, not a dashboard version.

Task 9 terminal states are `rejected`, `cancelled`, `expired`, and `failed`; no
terminal run reopens. `approval_required` may move only to cancellation/expiry in
this slice. Future entry to `accepted` requires a separately reviewed additive
migration and application surface.

The implementation supports only ADR-005's Suggest tier. It may use already
bound immutable inputs to produce private candidates. It has zero external tool
attempts and no source retrieval. `governed_draft` and `governed_refresh` remain
reserved/denied until a separate capability-broker/source-job plan.

Every specialist or reviewer is a role allocation inside one run. Specialists
and reviewers have zero tools and cannot recurse, spawn, borrow another budget
partition, accept a candidate, or change authority.

### 3.2 Immutable event authority

Each event binds:

- `organization_id`, `run_id`, ordered `event_sequence`, event kind, database
  event time, current `lease_epoch` when worker-authored, actor/service identity,
  authority/policy revisions, request ID, and idempotency identity;
- canonical payload bytes/hash, prior-event hash, current event hash, pinned code,
  policy, field-catalog, expression-registry, tool-manifest, provider/model,
  input, and timezone-database digests as applicable; and
- no credential, authorization header, raw provider error, unnecessary prompt,
  source byte body, or chain-of-thought.

The previous-event chain detects mutation but is not externally sealed or
attacker-proof. The plan and implementation must say so wherever the chain is
reported.

`agent_runs` is a rebuildable current projection plus immutable request bindings.
`agent_run_checkpoints` are insert-only revisions; a pointer to the latest valid
checkpoint may be mutable but never authoritative over events. A deterministic
reducer must rebuild the same projection and checkpoint digest from event 1 while
the dashboard remains lifecycle-accessible and semantic payloads are retained.
After governed purge, retained headers and payload hashes rebuild only the cleaned
tombstone projection and prove chain/count/deletion consistency; they cannot and
must not reconstruct deleted tenant content.

### 3.3 Lease and commit fence

A claim transaction locks the exact run, reauthorizes all live inputs, increments
`lease_epoch`, generates an unguessable attempt token, sets database-owned claim
and expiry times, and appends `lease_acquired` atomically. The tuple
`(organization_id, run_id, lease_epoch, attempt_token)` is required on every
worker event, checkpoint, attempt reservation/reconciliation/release, graph,
result, candidate, manifest, cache/artifact seam, and terminal commit.

A stale epoch/token, expired claim, cancelled/terminal run, inaccessible or
expired dashboard, changed authority/policy, or mismatched input digest denies
without mutation. External cancellation is unnecessary for the fake provider;
late fake/replay results are still discarded to prove the same acceptance fence.

The claim function may discover only minimal eligible IDs. It then establishes
exact organization/run context, locks authority rows in a fixed order, and
returns an opaque claim handle. It never returns cross-tenant metadata from an
ineligible row.

For `dasher_run_api.claim_agent_run(uuid, integer)`, the UUID is an operator-
generated claim request/idempotency ID and the integer is bounded lease seconds;
neither is an organization, dashboard, run, tenant, policy, or capability ID.
Eligible-run selection occurs only inside the function after exact run-principal
bootstrap. It uses the fixed eligible index and deterministic
`requested_at, run_id` order with locked/skip-locked selection, then promotes the
chosen opaque run to full fenced context. The caller has no run-listing or target-
selection API.

### 3.4 Budget contract

Run limits are immutable and copied from an exact enabled policy revision at
request time. The initial implementation freezes ADR-005 Suggest defaults and
absolute ceilings:

- at most 2 candidates, 1 specialist, 1 reviewer, 0 tool attempts, 5 fake model
  calls, 1 repair, 30,000 tokens, 45 seconds, and 150,000 base-currency micros;
- at most 2 active runs per organization, 1 active run per dashboard, and 1
  provider attempt at a time per run; and
- no mid-run expansion or policy replacement.

The ledger stores separate generation and review partitions and separate
`reserved`, `used`, and `released` counters for calls, candidate/specialist/
reviewer/repair attempts, input/output/reasoning/cache token categories, wall and
working time, integer base-currency cost, and every calculation meter.

Every attempt reserves the conservative maximum and appends `attempt_reserved`
in one committed transaction before adapter dispatch. Fake pricing is exact and
contains no credential or billing identity. Result reconciliation occurs in a
new fenced transaction. A simulated post-dispatch timeout is billing-indeterminate
and remains reserved until an explicit deterministic fixture outcome resolves or
quarantines it. Retry requires a fresh reservation; only one transient retry is
allowed. Unknown estimate, missing price-book revision, overflow, exhausted
partition, or any limit breach denies before adapter invocation.

At 80% of any budget, orchestration stops exploration and may only finish from
already recorded evidence; it cannot expand limits. An incompletely reviewed
candidate remains ineligible.

## 4. PostgreSQL `0007` design contract

Task 9A freezes exact columns, constraints, policy expressions, return composites,
function signatures, comments, hashes, and fixture IDs in a static matrix before
canonical SQL is authored. The names below are fixed; exact argument/return types
must be copied into that matrix and cannot drift during later tasks.

### 4.1 Managed roles

The migrator conditionally prepares exactly two additional managed roles before
running canonical `0007`:

- `dasher_run_definer`: `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`; owns only the
  run-operator functions and no schema, table, sequence, or data;
- `dasher_run_operator`: `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`; owns nothing and
  receives only exact `EXECUTE` on the fixed operator API.

Both have null passwords, no role settings, no memberships, exact managed
comments, `CONNECTION LIMIT -1`, `VALID UNTIL 'infinity'`, no default privileges,
and no database/schema/table/sequence/function access before the canonical
transaction. Existing
`dasher_retention_definer` and `dasher_retention_operator` neither inherit nor
receive run authority. Existing `dasher_security_definer` receives no run-operator
role, capability, lease, or `dasher_run_api` authority; it receives only the exact
new relation/column privileges needed to own the tenant-facing
request/cancel/read functions. The app role receives only exact `EXECUTE` on those
tenant-facing functions.

Canonical `0007` creates `dasher_run_api` as a dedicated schema owned by the
database migration owner, never by either managed run role. It revokes all schema
privileges from `PUBLIC`, grants no `CREATE`, grants exact `USAGE` only to
`dasher_run_definer` and `dasher_run_operator`, and grants the operator only the
listed function `EXECUTE` privileges. The definer receives only the exact
underlying table/column privileges required by those functions. App, security-
definer, retention, unrelated-login, and unrelated-managed roles receive no
`dasher_run_api` schema privilege. Schema owner, ACL, absence of default
privileges, and absence of extra objects are cumulative phase-7 catalog checks.

The migrator also extends its expected-login contract from app/retention to
three separate, sorted, duplicate-free, pairwise-disjoint allowlists:
`expectedAppLoginRoleNames`, `expectedRetentionLoginRoleNames`, and
`expectedRunLoginRoleNames`. All default empty. Every listed login is
database-bound, has the exact restricted login attributes, and has only the
single expected membership (`dasher_app`, `dasher_retention_operator`, or
`dasher_run_operator`, respectively). Every managed role is forbidden from all
three lists. A run login is a test or separately enrolled service identity—not
the managed NOLOGIN role itself—and no production run login is provisioned by
this slice. Expected-login comments use exact marker `run-login`, extending the
closed existing `app-login | retention-login` marker union; any other marker,
duplicate, wrong list, or cross-list role fails closed.

Bootstrap order extends the existing fail-closed prepared-prefix protocol:
acquire the session gate -> validate exact journal/catalog phase 6 -> create or
validate the exact role pair in one bounded transaction -> revalidate the pair ->
run canonical SQL and journal insertion atomically -> validate exact cumulative
phase 7. SQL itself creates no role. Failure may leave only the exact prepared
pair; wrong flags/comments/dependencies fail closed.

Task 9 adds owner-only
`resetPreparedRunRoles(pool, directory, expectedAppLoginRoleNames, expectedRetentionLoginRoleNames, expectedRunLoginRoleNames)`.
It is never called automatically and is exported only from the migrator module.
It reuses the same canonical-directory discovery/prefix validation and the same
validated, pairwise-disjoint three-allowlist membership inventory as the runner.
It succeeds only while the advisory session gate is held, the journal is exactly
the six canonical rows, both named run roles exist, `0007` is absent, and catalog
dependency inventory proves the pair has no object/default-privilege/database-
setting or unexpected membership dependencies beyond the validated login lists.
It drops `dasher_run_operator` then `dasher_run_definer` in one transaction and
re-proves both absent. Wrong owner, directory/prefix/allowlist drift, partial or
unexpected role set, dependency, journal drift, concurrent runner, or any post-
`0007` state denies without drop.

### 4.2 Tables and relations

Migration `0007_agent_run_ledger_and_calculations.sql` creates exactly these
relation families, all organization-keyed with composite tenant-safe foreign
keys and forced RLS:

1. `agent_run_policy_revisions` — immutable enabled policy revisions and closed
   Suggest limits. The first request for an organization lazily seeds exact
   revision 1 under the existing organization advisory/row locks with fixed
   migration provenance; concurrent first requests converge on one identical
   row. No app policy-admin mutation is exposed in this slice.
2. `run_service_principal_allowlist` — append-only principal revisions binding
   one exact `postgres_session_user` login to the platform run-operator scope and
   closed capabilities (`claim`, `checkpoint`, `reserve`, `reconcile`, `release`,
   `commit_graph`, `commit_candidate`, `commit_manifest`, `finish`). `checkpoint`
   authorizes only checkpoint write.
   It carries
   predecessor revision/hash, enabled state, exact database marker, and no tenant
   wildcard chosen by a caller. Canonical production data contains no principal;
   PostgreSQL tests insert one synthetic binding through the owner harness and
   remove it during cleanup.
3. `agent_runs` — immutable request/input/purpose/dashboard/policy/limit bindings
   plus rebuildable current state, sequence/hash pointer, lease epoch/token hash/
   owner/expiry, latest checkpoint revision, and terminal metadata.
4. `agent_run_events` — insert-only ordered non-sensitive event headers and
   hashes. Sensitive/tenant-derived canonical event bytes live separately in
   retention-deletable `agent_run_event_payloads`.
5. `agent_run_checkpoints` — insert-only checkpoint headers, reducer version,
   source event sequence/hash, state hash, and pinned digests; bounded canonical
   checkpoint bytes live in retention-deletable `agent_run_checkpoint_payloads`.
6. `agent_run_budget_counters` — one row per run, partition, and closed category;
   immutable limit plus nonnegative reserved/used/released totals.
7. `agent_run_attempts` — immutable attempt identity and reservation, with a
   one-way outcome/reconciliation transition and sanitized usage/result hashes.
8. `field_catalog_snapshots` and `field_catalog_entries` — immutable stable field
   IDs, types, nullability, units/currency/grain/event time/freshness, and exact
   source snapshot/evidence bindings.
9. `calculation_graphs` and `calculation_results` — immutable accepted AST,
   versions/digests/limits, deterministic output/status/meters, and evidence hash.
10. `metric_contract_versions` — immutable expected type/unit/grain/freshness and
    calculation graph binding.
11. `agent_candidates` — private candidate identity, strict `DashboardSpec` 1.0
    or 1.1 hash, validation/rank/review state, and no version, head, reference-
    claim, or publication authority. Canonical candidate bytes live in a separate
    retention-deletable payload relation.
12. `claims`, `claim_evidence`, and `candidate_evidence_manifests` — stable typed
    statements, evidence state, support/contradiction/context edges, manifest
    completeness/hash, and exact candidate/snapshot/evidence bindings. They do
    not bind or create dashboard versions in this slice.
13. `agent_recorded_results` — bounded, sanitized, content-addressed fake/replay
    model results and structured validation findings. No credential, network
    response body, provider error, tool side effect, or prompt secret is stored.

Use UUIDs supplied only after strict application validation or generated by fixed
trusted functions as specified in the Task 9A matrix. All timestamps used for
ordering, lease, budget, and terminal decisions are database-controlled. JSONB is
permitted only for closed canonical payload/AST/spec/checkpoint/result
values validated against a named schema/version and bounded by bytes; there is no
generic operation envelope or caller-selected SQL identifier.

All tenant-derived bytes and semantic text are separated from the retained run
header/hash ledger. This includes event/checkpoint/result payloads, field labels,
calculation AST/results, candidate specs, claim statements/edges/manifests, and
recorded fake results. Retained headers contain only opaque IDs, closed states,
times, revisions, counters, and cryptographic hashes that are insufficient to
reconstruct deleted content.

Every immutable relation rejects UPDATE/DELETE for runtime roles. Mutable fields
on `agent_runs`, budget counters, and attempts use exact transition triggers and
column-level grants; no runtime role receives table-wide UPDATE or DELETE.

### 4.3 Fixed function identities

Tenant-facing functions execute only after existing `dasher_api.initialize_context`
and use current full tenant context:

- `dasher_api.request_agent_run(uuid, uuid, uuid, text, bigint, bytea, bytea)`;
- `dasher_api.cancel_agent_run(uuid, bigint, bytea)`;
- `dasher_api.get_agent_run(uuid)`;
- `dasher_api.list_agent_run_events(uuid, bigint, integer)`;
- `dasher_api.get_agent_run_checkpoint(uuid)`; and
- `dasher_api.get_agent_candidate(uuid, uuid)`.

All six tenant-facing functions live in the existing `dasher_api` schema, are
owned by existing `dasher_security_definer`, are `SECURITY DEFINER`, and set
`search_path = pg_catalog`. They are `VOLATILE` because each performs or depends
on current reauthorization and database time, even when the final operation is a
read. Canonical `0007` revokes all execute authority from `PUBLIC`, run, retention,
and unrelated roles, then grants only each exact signature to `dasher_app`.

`dasher_security_definer` receives only the Task 9A-matrix column-level
`SELECT`/`INSERT`/`UPDATE` privileges required by these six bodies and the exact
existing audit/context dependencies; it receives no table-wide mutation,
`DELETE`, role membership, run lease/capability, or `dasher_run_api` privilege.
Forced-RLS policies require `current_user = 'dasher_security_definer'`, exact full
`initialize_context` organization/user/membership/authority revision, and current
dashboard/run lifecycle. Function owner, security mode, volatility, fixed search
path, body hash, dependencies, execute ACL, underlying column ACLs, and absence of
overloads are cumulative phase-7 catalog assertions.

Existing `dasher_security_definer` is `BYPASSRLS`; therefore tenant-facing
authorization is enforced by each fixed function's full current-context and
resource reauthorization plus exact column grants, not by RLS alone. The forced-
RLS policies and triggers remain required defense in depth and protect any future
non-bypass owner posture, but Task 9 evidence must not describe them as the
effective boundary for this existing definer.

The Task 9A matrix freezes exact named return composites and explains each UUID,
revision, digest, bounded enum, and pagination input. Request derives organization,
actor, dashboard lifecycle, policy, and immutable limits under locks; callers do
not submit tenant, role, budget, provider, price, or lease values. Reads use fixed
bounded pagination and non-leaking denial.

Operator functions are owned by `dasher_run_definer`, executable only by
`dasher_run_operator`, and receive/return fixed typed scalars/composites—not a
JSON operation envelope:

- `dasher_run_api.claim_agent_run(uuid, integer)`;
- `dasher_run_api.write_agent_run_checkpoint(uuid, bigint, bytea, bigint, bytea, bytea)`;
- `dasher_run_api.reserve_agent_run_attempt(uuid, bigint, bytea, uuid, text, text, bigint, bigint)`;
- `dasher_run_api.reconcile_agent_run_attempt(uuid, bigint, bytea, uuid, text, bigint, bigint, bytea)`;
- `dasher_run_api.release_agent_run_attempt(uuid, bigint, bytea, uuid, text, bytea)`;
- `dasher_run_api.commit_calculation_graph(uuid, bigint, bytea, uuid, bytea, bytea)`;
- `dasher_run_api.commit_agent_candidate(uuid, bigint, bytea, uuid, bytea, bytea)`;
- `dasher_run_api.commit_candidate_manifest(uuid, bigint, bytea, uuid, bytea, bytea)`; and
- `dasher_run_api.finish_agent_run(uuid, bigint, bytea, text, bytea)`.

For `claim_agent_run`, the UUID is the claim request/idempotency ID and the integer
is bounded lease seconds, as fixed in section 3.3. It performs eligible-run
discovery internally and returns the only opaque run handle; no caller supplies a
run target. Each remaining signature's first UUID is the run ID from that handle.

No runtime role receives a generic event-append function or caller-selected event
kind. Each fixed transition function chooses its closed event kind and validates
its versioned payload. A private append helper has `EXECUTE` revoked from `PUBLIC`,
app, run operator, retention, and unrelated roles; it is reachable only from the
fixed SECURITY DEFINER bodies. After locking the run, that helper reads the current
projection hash, derives exactly `current_sequence + 1`, and atomically writes the
event plus projection pointer.

In Task 9, `finish_agent_run` accepts only `rejected`, `cancelled`, `expired`, or
`failed`. Candidate/manifest completion enters `approval_required` through the
closed manifest commit path; neither function accepts `accepted`. The phase-7
transition trigger independently rejects that reserved transition even if a
caller bypasses repository validation.

Before SQL is authored, Task 9A may refine argument types only by updating this
plan through a separately reviewed docs correction. Implementation may not
silently invent overloads or broader signatures.

`claim_agent_run` alone performs this acquisition protocol inside one transaction:

1. validate syntactic inputs before connection where applicable;
2. bootstrap the exact enabled session-user principal and `claim` capability;
3. discover and lock one eligible run internally in the fixed order without
   caller-selected tenant/run identity;
4. lock dashboard, service authority, lifecycle policy, run policy, and immutable
   inputs in the documented global order;
5. derive and set transaction-local organization/run/service context and
   reauthorize current lifecycle, authority, policy, inputs, claimability, and
   aggregate run limits;
6. increment the lease epoch, mint/store only the token hash, set database-owned
   owner/claim/expiry, and append `lease_acquired` atomically; and
7. return the bounded opaque claim handle with no existence, SQL, constraint,
   credential, prompt, or provider-error leakage.

Every remaining operator function performs this post-claim protocol inside one
transaction:

1. validate syntactic inputs before connection where applicable;
2. lock the supplied exact run and verify lease epoch/token hash/expiry/state;
3. lock dashboard, service authority, lifecycle policy, run policy, and any
   referenced snapshot/evidence/version rows in the documented global order;
4. derive and set transaction-local organization/run/service context;
5. reauthorize current lifecycle, expiry, authority, policy, inputs, and budget;
6. perform one closed mutation with exact expected sequence/prior hash or exact
   attempt/graph/candidate identity;
7. append the matching event atomically; and
8. return a bounded typed result with no existence, SQL, constraint, credential,
   prompt, or provider-error leakage.

There is no database transaction across adapter invocation. Reservation commits,
then the fake adapter runs outside PostgreSQL, then a fresh fenced transaction
reauthorizes and reconciles/commits or discards the result.

### 4.4 Lifecycle and retention coupling

Migration `0007` must not create a new source/evidence residue or purge blocker.
It replaces only the exact lifecycle/retention functions and policies needed for
these additive relations while preserving every predecessor invariant:

- `dasher_retention_api.drain_dashboard_agent_runs(uuid, bigint, bytea, uuid,
text, uuid)` is an exact fixed function owned by
  `dasher_retention_definer`, executable only by
  `dasher_retention_operator`, and authorized by the existing
  `claim_cleanup` capability. During the existing `drain_and_cancel` step it
  is normally invoked before step completion, but authorization does not depend on
  the mutable `current_step` label: it locks and proves the exact
  `dashboard_cleanup_coordination` target and held lease owner, expected lifecycle
  revision, retention principal revision, `purged_at IS NULL`, and current
  lifecycle in `access_revoked | quarantined | purge_eligible` before touching a
  run. It then
  locks all nonterminal runs for the one dashboard in stable run-ID order,
  increments/fences their lease epochs, clears claims, terminalizes them as
  `cancelled`, and appends sanitized cancellation events atomically. Existing
  run functions independently deny immediately after dashboard access revocation,
  so this drain supplies final state rather than a revocation safety boundary.
- `dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid)` is
  replaced without overload by an exact phase-7 body that, under the existing
  `purge` authority, deletes all run payload,
  field-catalog entry, graph/result, candidate, claim-edge/manifest, and recorded-
  result rows for the target dashboard before it attempts source/evidence purge.
  It retains only non-sensitive run/event/checkpoint/attempt headers, exact
  counters, terminal disposition, hashes, and the aggregate purge proof.
- Purge fails closed unless every run is terminal/unclaimed, every tenant-derived
  payload count is zero, every claim/evidence edge is absent, and the retained
  headers are internally hash/count consistent. Those checks are part of the
  same transaction and aggregate final proof; an RLS-filtered zero-row result is
  not accepted as physical absence.
- Exact column DELETE/UPDATE grants, RLS policies, trigger branches, dependency
  inventory, and fixed function body hashes for this retention extension are
  frozen in Task 9A. No table-wide retention grant, cascade, generic cleanup
  callback, or runtime RLS broadening is allowed.
- Legal hold and pre-purge access semantics carry forward. Agent run artifacts
  neither create retention authority nor escape an existing hold. Cleanup/retry
  is idempotent, and a failed transaction leaves all source/evidence and run
  payload bytes in the prior valid state.

The existing cleanup-step vocabulary already includes `drain_and_cancel` and
`purge_finalizing`; `0007` does not rewrite historical step meanings or add a
parallel cleanup coordinator. It adds no capability to
`dasher_retention_api.initialize_operator_context` and no column or authority to
`dasher.retention_service_principal_allowlist`; the existing `claim_cleanup`
capability remains the exact drain authorization. The drain is idempotently
callable under any held pre-purge cleanup lease, including after a proof-bearing
claim has advanced directly to `quarantined`, so the terminal-run purge precondition
cannot become unreachable because a historical step label was skipped.

### 4.5 RLS and ACL rules

- Every new tenant relation has `ENABLE ROW LEVEL SECURITY` and
  `FORCE ROW LEVEL SECURITY`.
- Tenant-definer policies require existing full current-user tenant context and
  accessible dashboard/run linkage. Terminal/expired/revoked lifecycle hides
  candidate body and evidence while retaining only the bounded admin status
  already authorized. Existing `dasher_security_definer` BYPASSRLS honesty remains
  governed by section 4.3.
- Run-operator policies require `current_user = 'dasher_run_definer'`, promoted
  run phase, run ID,
  organization ID, lease epoch, attempt-token hash, operator principal/revision,
  capability, and current policy equality.
- Run-operator bootstrap first resolves exactly one current enabled
  `run_service_principal_allowlist` revision for `session_user`, proves its
  predecessor-hash chain and database marker, rejects any later revision or
  duplicate binding, and places only opaque principal/revision/capability values
  in transaction-local settings. Role membership alone never authorizes a run.
- Bootstrap discovery exposes only an eligible opaque run ID and required gate
  fields, then promotes context after authority/lifecycle locks. It does not grant
  broad tenant scanning.
- Claims and manifests cannot link unavailable, cross-tenant, or lifecycle-
  inaccessible evidence. Composite FKs and fixed triggers independently enforce
  the same organization/dashboard/version/candidate scope.
- In this slice claims/manifests bind candidates, not `dashboard_versions`.
  They create no snapshot/evidence reference claim and therefore cannot extend
  retention. Their composite evidence links are deleted through the governed
  dashboard purge path before source/evidence deletion; no cascade silently
  stands in for the cleanup proof.
- Public, app, general-definer, retention, migration-unrelated, and operator roles
  receive no unintended access. No default privileges or role memberships widen
  access.
- Function `search_path`, owner, volatility, security-definer status, settings,
  execute ACL, body hash, and dependencies are exact catalog inventory.

## 5. Deterministic calculation contract

Create `packages/calculation-engine` as a pure, side-effect-free package. It has
no database, filesystem, network, clock, random, process, dynamic import, eval,
Function constructor, SQL, regex evaluator, or provider dependency.

### 5.1 Closed AST and canonicalization

The strict discriminated AST includes only ADR-005 registry-v1 operations:
stable field references and typed literals; bounded select/filter/group/sort/
rank/top-k; row/present counts, sum/min/max/mean; exact arithmetic; absolute/
clamp; comparisons/booleans/conditional/coalesce; lag/delta/percentage change/
bounded windows; explicit unit conversion; explicit missing/null/unavailable/
stale classification; and explicit rounding/scale.

Every object rejects unknown keys. Every accepted graph pins schema, registry,
field-catalog snapshot, input snapshot, evaluation time, timezone database,
limits, and canonical AST hash. Field references use stable IDs only. Reject
cycles, implicit joins, dynamic paths/functions, recursion, arbitrary distinct/
reduce, unbounded lists/frames/cardinality, or unknown versions.

Canonicalization snapshots untrusted input once, enforces a pre-parse UTF-8 byte
ceiling, parses strict JSON-compatible values, normalizes object-key ordering and
integer/decimal forms, and hashes the exact canonical bytes. No getter/proxy field
is reread after the snapshot boundary.

### 5.2 Numeric, temporal, and missing semantics

- Exact numbers use bounded integer coefficient plus explicit scale; money uses
  integer minor units or the same canonical decimal representation and a pinned
  currency. Binary float, NaN/infinity, overflow, implicit scale changes, and
  hidden rounding fail.
- Divide by zero fails. Branches have identical type/unit/currency/grain.
- Missing, explicit null, unavailable/error, stale, and empty input are distinct.
  `count_rows` and `count_present` return zero on empty input; typed sum returns
  exact zero; min/max/mean return `empty_input`.
- Sort/top-k requires a unique stable tie key and bounded literal `k`.
- Windows require partition keys, unique total order, event-time field, and
  bounded frame. Fixed duration and calendar periods are distinct and pin the
  timezone database.
- Unit conversion uses a versioned dimension registry including affine units.
  Currency conversion is a separate graph node bound to immutable evidence-linked
  FX input; Task 9 fixtures may use only synthetic fixed rates.

### 5.3 Static and runtime limits

Static validation computes worst-case type, unit, cost, and cardinality before
execution. Runtime meters enforce the same source/AST/input/output byte, node,
depth, literal/list, row, group/group-size, intermediate/output cardinality,
step, wall-time, and memory ceilings. Exceeding either layer fails closed with a
sanitized typed finding and no partial fact/candidate commit.

## 6. Fake provider, replay, claims, and candidates

Create `packages/agent-harness` with a provider-neutral typed adapter contract and
only `FakeProviderAdapter`. Production code in this slice must contain no network
client or credential interface capable of transport.

The fake adapter accepts immutable typed request snapshots and returns bounded
fixtures for success, invalid envelope, refusal, timeout-before-dispatch,
post-dispatch indeterminate timeout, budget denial, transient retry, malformed
candidate, structured repair, specialist/reviewer result, cancellation, and late
result. Tests inject the adapter; import and default paths make zero calls.

Replay fixtures are content-addressed by canonical request/result/event hashes.
Replay creates a distinct replay run referencing the original run, requires
current authorization, reads recorded results in event order, and never calls an
adapter or tool. It cannot silently commit to a dashboard, reuse old authority,
change policy/code/catalog digests, or treat an old approval as current. Digest
mismatch fails closed.

A material Claim has exactly one semantic label: `observed`, `calculated`,
`event`, `hypothesis`, `recommendation`, `unknown`, or `blocked`. Evidence state
is separately exactly `complete`, `partial`, `contradicted`, `stale`, or
`unsupported`. ClaimEvidence edges are only `supports`, `contradicts`, or
`context`. Event proximity never creates causal support, and confidence never
replaces evidence state.

Hard validation precedes deterministic ranking. Only candidates with strict
DashboardSpec bytes, successful calculation/evidence validation, complete
high-salience claim manifest, and completed independent review are eligible for
`approval_required`. Ties use canonical candidate hash, never adapter order.
No candidate mutates a dashboard head or publication.

## 7. Implementation tasks

### Task 9A: freeze phase-7 migrator and authority contract before SQL

**Objective:** Make the new role/catalog/function/ACL/RLS contract mechanically
selectable and red before canonical `0007` exists.

**Files:**

- Modify: `packages/control-plane/src/migrator.ts`
- Modify: `packages/control-plane/src/migrator.test.ts`
- Modify: `packages/control-plane/src/canonical-migrations.test.ts`
- Modify: `packages/control-plane/src/preflight.ts` only if a separately named
  run-operator test login allowlist is required
- Modify: `packages/control-plane/test/postgres-harness.ts` only for prepared-role
  and exact-login fixture support

**Steps:**

1. Add failing static tests for exact phase-7 filename/checksum placeholder,
   tables/types/functions/signatures/owners/settings/ACLs/policies/triggers,
   managed role flags/comments/dependencies, and immutable phase-6 prefix.
2. Add failing prepared-role clean/partial/wrong/adoption/residue/retry/reset and
   app/run/retention login overlap, wrong-database marker, membership,
   managed-role, and unlisted-login denial tests before connection.
3. Implement only the modeled phase-7 allowlist, bootstrap state machine, exact
   role pair preparation, `run-login` marker, dependency validation, and owner-only
   five-argument `resetPreparedRunRoles`; do not create schema objects. Reset tests bind
   exact six-row journal, exact dependency-free pair, operator-then-definer drop,
   canonical directory/prefix plus all three validated login allowlists,
   transactional absence proof, wrong-owner/directory/allowlist/partial/post-`0007`
   denial, and no automatic call.
4. Run focused migrator/canonical tests and confirm phase-7 SQL-dependent cases
   remain expected red while every phase 1–6/predecessor case stays green.
5. Commit: `test(control-plane): lock 0007 run-ledger inventory`.

### Task 9B: add one-shot additive `0007`

**Objective:** Create the exact phase-7 schema/functions/RLS/ACLs without source,
provider, route, worker, or deployment scope.

**Files:**

- Create: `packages/control-plane/migrations/0007_agent_run_ledger_and_calculations.sql`
- Modify: `packages/control-plane/src/canonical-migrations.test.ts`
- Modify: `packages/control-plane/src/migrator.ts`
- Modify: `packages/control-plane/src/migrator.test.ts`
- Modify: `packages/control-plane/test/postgres.integration.test.ts` only for
  migration/catalog/replay/rollback cases completed in Task 9F

**Steps:**

1. Author the migration once from the frozen Task 9A matrix; SQL creates no role.
2. Add exact canonical SHA-256 and reject edits to all six predecessor bytes.
3. Implement exact phase-7 catalog validation and dependency inventory.
4. Add clean chain, exact phase-6 upgrade, replay/no-op, checksum drift, partial
   journal, post-DDL failure, journal-insert failure, role-residue, wrong-object,
   and cumulative catalog rollback/retry tests.
5. Verify predecessor service suites on the evolved schema and that no historical
   migration replay widens successor ACLs.
6. Commit: `feat(control-plane): add agent run ledger schema`.

### Task 9C: implement the pure calculation engine

**Objective:** Validate and execute registry-v1 calculation graphs deterministically
with exact semantics and hard meters.

**Files:**

- Create: `packages/calculation-engine/package.json`
- Create: `packages/calculation-engine/tsconfig.json`
- Create: `packages/calculation-engine/src/index.ts`
- Create: `packages/calculation-engine/src/schema.ts`
- Create: `packages/calculation-engine/src/canonical.ts`
- Create: `packages/calculation-engine/src/decimal.ts`
- Create: `packages/calculation-engine/src/registry.ts`
- Create: `packages/calculation-engine/src/validate.ts`
- Create: `packages/calculation-engine/src/evaluate.ts`
- Create tests beside each module or in `packages/calculation-engine/src/*.test.ts`
- Modify: `pnpm-lock.yaml` only for the new workspace importer; add no new external
  runtime dependency without a plan correction

**Steps:**

1. Write red strict-schema, unknown-key/version/field, byte/depth/node/cycle, and
   hostile getter/proxy snapshot tests.
2. Implement canonical snapshot/parser/hash and registry-v1 schemas minimally.
3. Write red decimal/money/null/missing/empty/unit/time/window/FX semantics tests,
   then implement exact primitives.
4. Write red static cost/cardinality and runtime meter tests, then implement both
   layers with identical limits.
5. Add deterministic fixture vectors and canonical-hash stability tests across
   key order and equivalent decimal encodings.
6. Run package tests/typecheck plus dashboard-schema/river-domain regressions.
7. Commit: `feat(calculation-engine): add closed deterministic graph runtime`.

### Task 9D: add run repository, reducer, and fixed transaction wrappers

**Objective:** Expose strict app and run-operator repositories that use only fixed
functions and reconstruct run state from events.

**Files:**

- Create: `packages/control-plane/src/agent-run-types.ts`
- Create: `packages/control-plane/src/agent-run-reducer.ts`
- Create: `packages/control-plane/src/agent-run-repository.ts`
- Create: `packages/control-plane/src/agent-run-repository.test.ts`
- Create: `packages/control-plane/src/agent-run-reducer.test.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/control-plane/src/public-exports.test.ts`
- Modify: `packages/control-plane/package.json` only if an existing script cannot
  include the new ordinary tests

**Steps:**

1. Add strict public input/output/error contracts and pre-connection hostile-input
   tests; expose no SQL callback, budget override, provider credential, tool,
   tenant selector, head update, publication, or schedule method.
2. Add red fixed-query/source-characterization tests for every tenant function and
   every operator function.
3. Implement app calls using the existing pinned transaction wrapper semantics;
   extract a shared internal wrapper only if byte-for-byte behavior and all
   invitation/session/lifecycle cleanup/release regressions remain intact.
4. Implement a separate run-operator wrapper. Before connection it validates the
   closed request shape and configured restricted run-login identity. Each call
   acquires one pooled run-login client, executes `BEGIN`,
   `SET LOCAL ROLE dasher_run_operator`, `SET LOCAL search_path = pg_catalog`, and
   exactly one fixed claim or post-claim function, then commits. Claim receives
   only request ID/lease seconds; post-claim calls verify the exact returned run/
   epoch/token handle. Rollback failure or ambiguous cleanup destroys the client.
   No transaction spans adapter invocation, and the wrapper cannot invoke a
   private context or event helper directly.
5. Implement the pure reducer and prove complete event reconstruction,
   checkpoint equivalence while payloads are retained, hash-only cleaned-tombstone
   reconstruction after purge, duplicate/idempotent event handling, invalid
   transition denial, and no terminal reopen.
6. Test stale epoch/token, lease expiry, cancellation/revocation, wrong policy/
   input digest, budget conflict, normalized denial, pool reuse, rollback/release
   failure, and `AggregateError` behavior.
7. Commit: `feat(control-plane): add fenced agent run repository`.

### Task 9E: add fake-provider orchestration and content-addressed replay

**Objective:** Exercise the run protocol end to end with zero network and zero
credential access.

**Files:**

- Create: `packages/agent-harness/package.json`
- Create: `packages/agent-harness/tsconfig.json`
- Create: `packages/agent-harness/src/index.ts`
- Create: `packages/agent-harness/src/contracts.ts`
- Create: `packages/agent-harness/src/fake-provider.ts`
- Create: `packages/agent-harness/src/orchestrator.ts`
- Create: `packages/agent-harness/src/replay.ts`
- Create: `packages/agent-harness/src/claims.ts`
- Create: `packages/agent-harness/src/ranker.ts`
- Create: `packages/agent-harness/fixtures/*.json`
- Create tests beside modules or in `packages/agent-harness/src/*.test.ts`
- Modify: `pnpm-lock.yaml` only for the workspace importer

**Steps:**

1. Add an import/default-mode zero-call test and a source guard rejecting network,
   credential, provider SDK, dynamic execution, shell, SQL, and tool dispatch.
2. Define the provider-neutral request/result contract and fake outcomes; snapshot
   and strictly validate all adapter responses as hostile input.
3. Implement bounded Suggest orchestration with reserved budget before each fake
   call, one transient retry, partitioned reviewer budget, 80% finish behavior,
   structured repair, cancellation, late-result discard, and prior-good-state
   preservation.
4. Implement claims/manifests, hard validity, deterministic ranker/ties, reviewer
   completion, and transition to `approval_required` without dashboard-head
   mutation. Task 9 inserts no `dashboard_versions` or access-bearing reference
   claims and exposes no acceptance method.
5. Implement replay as a new authorized run over exact recorded hashes; prove zero
   adapter/tool calls, digest drift denial, stale approval denial, and no live
   commit.
6. Cover every run terminal state, invalid/malformed/throwing provider envelopes,
   secret/error sanitization, incomplete evidence, unsupported claims, hidden
   tool requests, source substitution, authority drift, budget exhaustion, and
   validation-feedback manipulation.
7. Commit: `feat(agent-harness): add fake provider and replay`.

### Task 9F: authoritative PostgreSQL run/race/rollback gate

**Objective:** Prove the complete `0007` role, RLS, lifecycle, event, lease,
budget, graph, claim, replay, and cleanup contract on PostgreSQL 16.14.

**Files:**

- Modify: `packages/control-plane/test/postgres.integration.test.ts`
- Modify: `packages/control-plane/test/postgres-harness.ts` only for bounded
  reusable run-role, lock, fault, and cleanup helpers
- Modify: `packages/control-plane/package.json` only if the existing serial
  `test:postgres` selector cannot include the expanded same gate

**Required matrix:**

- exact seven-row journal, migration hashes, two new managed roles, function/ACL/
  RLS/trigger/dependency catalog, clean/upgrade/replay/rollback/retry paths;
- app versus run operator versus retention/general-definer/migration-owner
  authority, default-empty run-login enrollment, service-principal revision/hash
  binding, role-membership-insufficient denial, direct-table denial, no table-wide
  grants, and current-user/session-user proof;
- access revocation versus run claim/commit; direct PostgreSQL invocation of
  `drain_dashboard_agent_runs` under valid held cleanup leases at `access_revoked`,
  `quarantined`, and `purge_eligible` regardless of `current_step`; terminal
  fencing, idempotent retry, and explicit proof that this slice adds no TypeScript
  or production cleanup-worker caller; legal hold, purge-before-source ordering,
  zero physical run payload/claim-edge residue, retained-header consistency, and
  retry after injected deletion/final-proof failures;
- cross-tenant/missing/forged context, inaccessible dashboard, inclusive expiry,
  revocation, policy drift, pool reuse, and non-leaking denial;
- two claimers, lease takeover, stale epoch/token/expiry on every mutation path,
  cancellation and terminal races, one active run per dashboard, and deterministic
  lock order;
- event sequence/prior-hash conflicts, reducer/checkpoint rebuild, immutable-row
  UPDATE/DELETE denial, and trigger/audit rollback atomicity;
- concurrent reservation, partition isolation, overflow, 80% boundary, unknown
  estimate, indeterminate timeout, retry/fallback fresh reservation, and exact
  reserved/used/released arithmetic;
- graph/candidate/claim/manifest cross-tenant and cross-dashboard references,
  incomplete/contradicted/stale evidence, canonical hash mismatch, and no head or
  publication mutation;
- lifecycle access revocation fences late work; `drain_and_cancel` terminalizes
  all runs; purge removes every run payload/semantic/evidence edge before source
  and evidence rows while retaining only verified non-sensitive headers/hashes;
- fake/replay result commit after revocation or lease takeover is discarded;
  replay causes no adapter/tool/network activity; and
- finally remove synthetic rows/logins in approved dependency order, close pools,
  terminate/drop temporary logins, and prove no backend, prepared role residue,
  temporary schema/file/credential, or test process survives. Managed NOLOGIN
  roles and exact production schema remain.

**Commands:**

```sh
pnpm --filter @dasher/control-plane test:postgres
pnpm --filter @dasher/control-plane test
pnpm --filter @dasher/control-plane typecheck
pnpm --filter @dasher/calculation-engine test
pnpm --filter @dasher/agent-harness test
pnpm exec prettier --check packages/control-plane packages/calculation-engine \
  packages/agent-harness
pnpm lint
git diff --check
```

Any skipped matrix case, unhandled rejection, timeout, truncated evidence,
cleanup residue, wrong PostgreSQL image/server identity, or credential marker is
HOLD—not “mostly green.”

Commit: `test(control-plane): enforce agent run and budget races`.

### Task 9G: exact-head review and PR gate

**Objective:** Bind all evidence and both independent review lenses to one clean
implementation head before publication.

**Files:** No product/schema changes after the candidate freeze. A redacted
self-binding result/status artifact may be added once, followed by a completely
fresh final-byte gate. Any source or docs edit invalidates old evidence.

**Steps:**

1. Freeze exact base/parent/head/tree, seven migration filenames/checksums,
   PostgreSQL image/server identity, new role/catalog/function/ACL/RLS inventory
   hashes, package/fixture hashes, test counts, and cleanup proof.
2. Run the complete repository CI sequence on exact final bytes:
   `pnpm install --frozen-lockfile`, format, lint, typecheck, ordinary tests,
   build, Playwright, both audits, generated-code exact status, PostgreSQL gate,
   credential/diff/clean-worktree checks.
3. Obtain two exact-byte reviews at one binding:
   - focused verifier: path/scope, identities, formatting, requirements, commands,
     and cleanup; and
   - direct implementation-grounded reviewer: migrations, roles, RLS/ACLs,
     transaction/claim/budget protocol, calculation semantics, fake/replay
     no-call boundary, and denial/race completeness.
4. Fix blockers through one writer, rerun all final-byte evidence and both reviews,
   then commit/push without force.
5. Open the implementation PR only from the reviewed clean head, require exact-
   head `verify` and `postgres`, update/read back source-bound PR metadata, post a
   validated checkpoint, and leave the PR open/unmerged without deployment.

Expected PASS: exact identities bind every green gate and both reviewers report
no blocking finding. Any source edit/rebase invalidates reviews and CI.

Expected commit: none after the frozen result artifact; this is a review/PR gate.

## 8. Required local and CI verification

The implementation branch must run the repository's existing aggregate commands;
do not add a parallel weaker gate merely to restate them:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @dasher/web exec playwright install --with-deps chromium
pnpm test:e2e
pnpm audit --audit-level high
pnpm audit --prod --audit-level high
grep -qx 'Status: CLOSED' docs/security/GENERATED_CODE_GATE.md
pnpm test:postgres
git diff --check
test -z "$(git status --porcelain)"
```

GitHub `verify` and `postgres` must both succeed on the exact final head. Local
PostgreSQL evidence uses the same pinned `postgres:16.14-bookworm` identity as CI
and must prove explicit owner/app/run-operator login separation and zero skips.

## 9. Measurable acceptance gates

### Schema and authority

- Journal is exactly seven immutable rows with all predecessor hashes unchanged.
- New roles are exact managed NOLOGIN/NOBYPASSRLS identities with no memberships,
  secrets, ownership, default privileges, or unrelated authority.
- Every table/function/policy/grant/trigger/dependency matches phase-7 inventory;
  app/run/retention/PUBLIC authority differs only where explicitly planned.
- Every run mutation is exact-run, exact-epoch, exact-token, current-authority,
  lifecycle, policy, and budget fenced; stale or cross-tenant work has zero effect.

### Ledger, lease, and budget

- Every Task 9 terminal or `approval_required` run reconstructs exactly from
  ordered events while semantic payloads are retained, and no terminal run
  reopens. After governed purge, only the cleaned tombstone projection and
  hash/count/deletion proof reconstruct; deleted content does not.
- While payloads are retained, checkpoints/projections are rebuildable and
  hash-equivalent to the event reducer.
- Every worker-authored path rejects stale epochs/tokens after takeover.
- Budget counters remain exact under concurrency; generation cannot borrow review;
  retry/fallback reserves anew; indeterminate outcomes never release silently.

### Calculation and evidence

- Closed AST, stable field IDs, exact decimal/money/null/empty/unit/window/FX
  semantics, static analysis, and runtime hard caps pass shared adversarial vectors.
- Every committed material Claim for an `approval_required` candidate resolves
  through a complete immutable manifest to authorized evidence and, when
  calculated, an accepted graph/result while the dashboard remains accessible.
  Task 9 candidate completion creates no version or retention claim; later purge
  removes semantic payload and links physically.
- Unsupported, partial, contradicted, stale, Unknown, or Blocked statements never
  masquerade as complete observed/calculated facts.

### Fake provider and replay

- Import, default, fake, and replay modes use zero network, zero credentials, zero
  provider-hosted tools, zero external side effects, and zero generated code.
- Fake outcomes cover `approval_required`, every Task 9-reachable terminal state,
  every failure class, and explicit denial of `accepted`, with sanitized logs.
- Replay consumes exact recorded results without redispatch, requires current
  authority, detects digest drift, and cannot commit to a live dashboard head.

### Scope and release

- DashboardSpec 1.0/1.1 behavior and generated-code `CLOSED` guard remain green.
- No app route, UI, worker, queue, storage, live source/provider, schedule,
  publication, customer data, deployment, or remediation is added or implied.
- Task 9 passing remains only a synthetic run/calculation gate. Gate 2 and every
  live/deployment gate remain separately `PARTIAL`/HOLD.

## 10. Alternatives and trade-offs

### Put run state only in application memory

Rejected. Cancellation, resume, race investigation, budgets, and exact evidence
cannot survive process loss or prove stale-worker denial.

### Use a mutable event log without a reducer contract

Rejected. Mutable history cannot be authoritative, and a checkpoint that cannot
be rebuilt silently changes semantics.

### Use only a TTL lease

Rejected. A late worker can commit after expiry/takeover unless every mutation is
fenced by a monotonic epoch and exact attempt token.

### Add a generic JSON command/function

Rejected. It hides authority expansion, defeats exact function/ACL inventory, and
lets implementation invent transitions after review.

### Let JavaScript own budgets

Rejected. Concurrent workers and retries require atomic database reservation and
reconciliation. The orchestration layer may preflight but PostgreSQL is final.

### Start with a live provider

Rejected. It combines transport, credentials, billing ambiguity, revocation, and
nondeterministic responses before ledger/replay/calculation invariants are proven.

### Reuse existing security or retention operator roles

Rejected. Run coordination is a distinct authority. Reuse would widen unrelated
roles and make credential/process separation impossible to prove later.

### Put typed graphs inside DashboardSpec 1.1

Rejected. It would silently change a stable rendering contract. Graphs and claim
manifests attach by IDs/hashes outside the spec until a separately versioned
DashboardSpec migration is justified.

### Defer claims/evidence manifests until publication

Rejected. Candidate validity and ranking would otherwise operate without exact
material-claim coverage, making later human-approval/publication review unable to
reconstruct what was proposed.

## 11. Planning-PR gate

This docs-only PR changes exactly:

- `docs/status/2026-08-04-lifecycle-foundation-and-task-9-planning-baseline.md`;
- `docs/plans/2026-08-04-agent-run-ledger-and-deterministic-calculations.md`.

Before publication:

1. mechanically enforce the two-path allowlist and unchanged repository source;
2. verify all six migration hashes directly from base and candidate;
3. run Prettier, `git diff --check`, and the repository aggregate CI commands;
4. obtain an exact-byte focused verifier and a separate direct
   implementation-grounded reviewer over this complete plan;
5. correct any HOLD through one writer and repeat all reviews on new bytes;
6. commit, push, open the PR, require exact-head hosted CI, verify the raw PR body,
   and leave the PR open/unmerged; and
7. perform no implementation, merge, deployment, live-provider call, or
   historical-data remediation.

Acceptance of this plan is an explicit future owner decision. A review PASS or an
open green planning PR grants no implementation authority by itself.
