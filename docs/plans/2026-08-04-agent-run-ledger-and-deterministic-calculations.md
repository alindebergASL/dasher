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
- monotonic `lease_epoch` fencing, one dispatch-capable active run per dashboard,
  and a bounded quiescent approval backlog;
- immutable per-run limits, partitioned generation/review allocations, and
  separate reserved/used/released counters;
- strict calculation AST parsing, static validation, deterministic execution,
  runtime meters, and immutable validated graph/results;
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
requested -> authorized -> planning -> generating --candidate set--> validating
                                      |                                  |
                                      | invalid result                   v
                                      v                         approval_required
                                   revising --repaired set--> validating

Any claimed nonterminal -> rejected | cancelled | expired | failed
approval_required -> cancelled

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
terminal run reopens. `approval_required` may move only to cancellation in this slice. Future entry to `accepted` requires a separately reviewed additive
migration and application surface.

The implementation supports only ADR-005's Suggest tier. It may use already
bound immutable inputs to produce private candidates. It has zero external tool
attempts and no source retrieval. `governed_draft` and `governed_refresh` remain
reserved/denied until a separate capability-broker/source-job plan.

Every specialist or reviewer is a role allocation inside one run. Specialists
and reviewers have zero tools and cannot recurse, spawn, borrow another budget
partition, accept a candidate, or change authority.

The ordinary Suggest orchestration is one exact provider-result grammar. `F(k)` means
one inserted retryable `failure` result for kind `k`, immediately followed by one
fresh reservation/dispatch whose eventual same-kind result occupies `k`'s ordinary
grammar position; grammar comparison removes only that inserted failure. There may
be at most one `F(k)` in a run, only for `planner` or `generator`, and only when the
failed result is retryable and no later result, semantic artifact, prepared, or
dispatched attempt exists; a higher generator slot may exist only as an untouched
`reserved_pre_dispatch` row. After
removing that one failure, the result sequence is exactly:

```text
planner_output,
[specialist_output],
(
  candidate_output [, candidate_output]
  | candidate_invalid, repair_output
),
reviewer_verdict_set
```

Before that sequence, Suggest freezes its trusted source-derived common bundle while
`authorized`. The planner request binds that bundle and its successful output is the
only Brief bytes the fixed Brief writer accepts. That Brief freezes
`specialist_required` and `candidate_target_count`; the optional specialist exists
iff the former is true, and the normal branch contains exactly the latter's one or
two candidate outputs. The un-erased sequence is contiguous, contains 3..5
results/calls, and the final
reviewer verdict covers exactly the one or two valid result-derived candidates.
The repair branch produces exactly one candidate and forbids a second generator.
The ordinary two-candidate branch uses two successive generator attempts. A
specialist, when present, is before every generator. Refusal, a nonretryable failure,
an exhausted retry, or any sequence mismatch can only lead to a typed abstention or
terminal finish; it cannot be skipped to manufacture the successful grammar.

Run state is a durable macro phase, not the attempt program counter. The planner
reservation moves `authorized -> planning`. The first specialist or generator
reservation moves `planning -> generating`; later specialist/generator reservations
preserve `generating`. A repair reservation alone moves `generating -> revising` and
all repair work preserves `revising`. Candidate commits preserve `generating` or
`revising`; closing the exact candidate set moves either to `validating`. Within a
macro phase the database derives the sole legal next attempt kind from the complete
ordered attempt/result/artifact history above. After the optional specialist is
terminal, it reserves the Brief's exact one/two initial generator slots in ascending
slot order before either can start. A fixed trigger permits only that generator batch,
or a same-slot immediate retry, to coexist as `reserved_pre_dispatch`; all other
reservations require zero nonterminal attempts. Exactly one attempt may be
`dispatch_ready|dispatch_started`, and only the lowest unresolved grammar slot/retry
may enter it, so queued reservations never create a second dispatch or an ambiguous
same-phase transition. If slot 1 returns `candidate_invalid`, every later queued slot
is released in attempt-ID order before repair; a valid slot must be committed as its
candidate before the next slot starts. In `validating`, every candidate first receives
its trusted validation finding set and complete material-claim set, then exactly one
reviewer attempt covers the frozen set, then every manifest is committed, and only
ranking may enter `approval_required`.

### 3.2 Immutable event authority

Each event binds:

- `organization_id`, `run_id`, ordered `event_sequence`, event kind, database
  event time, current `lease_epoch` when worker-authored, actor/service identity,
  authority/policy revisions, request ID, and the persisted request idempotency
  digest carried by `run_requested`;
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
Only `write_agent_run_checkpoint`, while fenced to its current run, active lease,
latest principal revision, and exact `checkpoint` capability, may read retained
event bodies for this replay; ordinary operators and tenant reads never receive
that payload visibility.
After governed purge, retained governed headers and deletion proofs rebuild only the
cleaned tombstone projection and prove stored chain adjacency/count/deletion
consistency. The payload nonce and bare content-address hash are deleted, so the
semantic digest cannot be recomputed and deleted tenant content cannot be
reconstructed.

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
After exact run-principal bootstrap, the function first performs the one exact global
claim-operation lookup by that ID in retained `agent_run_events` headers; only when no
retained ordinary or mixed-terminal operation exists does eligible-run selection
occur. Every committed claim outcome has one immutable header operation kind, ID,
input digest, result digest, and typed result projection under the database-global
partial unique index. An exact retry under the same latest principal and lease
seconds reauthorizes the discovered resource and returns the original typed result
with zero DML. For an ordinary claim this includes the original attempt token even
after the lease has since expired, been released, or been superseded; that historical
response grants no current authority because every post-claim function independently
rejects a stale epoch/token. Any found-ID kind, principal, lease-seconds, input,
result, authority, lifecycle, or purge drift is the same non-leaking `P1001` and
never falls through to another run.

Ordinary selection uses the fixed eligible index and deterministic
`requested_at, run_id` order for opaque discovery, then acquires the organization/
dashboard locks before `FOR UPDATE SKIP LOCKED` on the exact run and promotes the
revalidated tuple to full fenced context. The caller has no run-listing or target-
selection API. Operation lookup is not a run target: its globally unique identity,
branch-specific input/result digests, non-leaking denial, context promotion, retained-
header-only projection, purge behavior, and collision rule are closed in sections
4.2A, 4.3, 4.4, and 4.6.

### 3.4 Budget contract

Run limits are immutable and copied from an exact enabled policy revision at
request time. The initial implementation freezes ADR-005 Suggest defaults and
absolute ceilings:

- at most 2 candidates, 1 specialist, 1 reviewer, 0 tool attempts, 5 fake model
  calls, 1 repair, 30,000 tokens, 45 seconds, and 150,000 base-currency micros;
- at most 2 dispatch-capable active runs per organization, 1 dispatch-capable
  active run per dashboard, 2 quiescent `approval_required` runs per dashboard,
  and 1 provider attempt at a time per run; and
- no mid-run expansion or policy replacement.

For those limits, dispatch-capable active means exactly
`requested|authorized|planning|generating|validating|revising`;
`approval_required` is unleased and cannot reserve or dispatch. Excluding it from
the active-slot predicate is necessary for a same-dashboard replay to coexist with
its still-approved source. Every request locks the dashboard and enforces the active
limits, and every ranking transition locks it and denies a third quiescent approval;
the fixed count check and its concurrency fixture are not caller-selected policy.

The ledger stores separate `generation` and `review` partitions. Provider/fake-
attempt reservation uses one exact `dasher_run_api.attempt_resource_vector` with
these signed-64-bit nonnegative fields in this order:

```text
calls, candidates, specialist_attempts, reviewer_attempts, repair_attempts,
input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
cache_write_tokens, total_tokens, wall_millis, work_millis, cost_micros
```

All stored relation, event, reducer, checkpoint, reservation, used, released, and
outstanding vectors remain this typed composite. The sole wire exception is the
sixth semantic argument of
`reconcile_agent_run_attempt`: it is named exactly `actual_accounting_bytes` and
has SQL type `bytea`, never `attempt_resource_vector`. The frozen transport cap is
inclusive `0 <= octet_length(actual_accounting_bytes) <= 1024`; SQL NULL means no
byte sequence, while a zero-length `bytea` is a present bounded sequence. The
function's content grammar requires `1..1024` bytes, so a present empty sequence is
database-derived `malformed_accounting`.

`actual_accounting_bytes` is raw UTF-8 carrying one RFC 8785 JCS object with schema
`attempt-actual-accounting-v1`. It has exactly the `schema` key and all fourteen
vector-field keys—no more, no fewer—and every vector value is a JSON string. With
`D` defined as canonical signed decimal `0` or an optional `-` followed by a
nonzero ASCII digit and then zero or more ASCII digits, each vector value is exactly
`i64:D`. Thus `+0`, `-0`, leading zeroes, a missing `i64:` tag, whitespace, decimal
points, exponents, and non-ASCII digits are forbidden. Checked conversion must then
place `D` in `-9223372036854775808..9223372036854775807`; the later nonnegative
semantic check rejects the signed minimum and every other negative value. Because
all keys and admitted characters are ASCII, the exact JCS key order and byte grammar
are transcribed by this single template, with each `<i64:D>` replaced by its JSON
string characters (for example, replace `<i64:D>` with `i64:0` while retaining the
displayed surrounding quotes) and with no whitespace or final LF:

```text
{"cache_read_tokens":"<i64:D>","cache_write_tokens":"<i64:D>","calls":"<i64:D>","candidates":"<i64:D>","cost_micros":"<i64:D>","input_tokens":"<i64:D>","output_tokens":"<i64:D>","reasoning_tokens":"<i64:D>","repair_attempts":"<i64:D>","reviewer_attempts":"<i64:D>","schema":"attempt-actual-accounting-v1","specialist_attempts":"<i64:D>","total_tokens":"<i64:D>","wall_millis":"<i64:D>","work_millis":"<i64:D>"}
```

The fixed function parses only inside one bounded PL/pgSQL sub-block. It first
checks the byte length, uses `convert_from(actual_accounting_bytes, 'UTF8')`, and
before JSON conversion rejects any decoded UTF-8 octet outside the finite ASCII
alphabet used by the template: lowercase letters, decimal digits, underscore,
minus, double quote, colon, comma, left brace, and right brace. It then casts that
text to `jsonb` only after also proving the template's fixed punctuation envelope:
exactly one left brace, one right brace, 60 double quotes, 29 colons (15 member
separators plus fourteen `i64:` tags), and 14 commas. It proves object type, the exact
15-key set/count, and string type for every vector key, and checks each tag/decimal
byte with substring/length and ASCII-byte comparisons—no regular-expression
evaluator. The pre-scan excludes nested-container, JSON-escape, and Unicode-
conversion error paths outside the catch registry. It converts each
already syntax-checked decimal once with `::bigint`, reconstructs the template above
from the extracted strings, converts it to UTF-8, and requires byte equality with
`actual_accounting_bytes`. That last comparison rejects noncanonical JSON/JCS,
including whitespace, alternate key order, escape variants, and duplicate keys that
`jsonb` would otherwise collapse. Only SQLSTATE `22021`
(`character_not_in_repertoire`), `22P02` (`invalid_text_representation`), and
`22003` (`numeric_value_out_of_range`) are caught in that sub-block and converted to
the malformed branch. The cap plus pre-scan makes that allowlist exhaustive for the
remaining parser/conversion operations. Structural checks branch explicitly; no
other SQLSTATE is caught, and there is no dynamic SQL, arbitrary exception
swallowing, raw-byte hash, or raw-byte persistence.

After a byte-exact canonical object is parsed, the function holds fourteen checked
`bigint` locals and immediately constructs one local typed
`dasher_run_api.attempt_resource_vector` in the frozen field order. It then uses that
typed local to reject any negative and check every call/kind/candidate category and
token/cache/total/cost equation with `numeric` intermediates and explicit signed-64
bounds. Only after all of those internal checks does it compare that typed vector
componentwise with the locked reservation. The typed local—not the wire bytes—is the
only value eligible for normal determinate storage, event encoding, reducer input,
or checkpoint projection.

SQL and TypeScript share three byte-exact wire fixtures. Substituting signed minimum
for every `D` in the template yields 648 bytes with SHA-256
`45e80d882166095e09c6dcf0e9e340b8689cc0dcfbfc4f8cabeea96135779b2f`;
substituting signed maximum yields 634 bytes with SHA-256
`b6e45d51e9c8b555bcbdf910d7e82ec88f8c8e568e02dccd5be8f9dce527af08`.
Thus every grammar-valid object is at most 648 bytes, safely below the separately
enforced 1,024-byte transport/function defense.
Both exact `i64:-9223372036854775808` and
`i64:9223372036854775807` endpoints are lexically and conversion-valid; the first
then fails nonnegativity and the all-maximum object then fails internal equations,
both before reservation comparison. The normal planner fixture substitutes each of
these values with the `i64:` tag:

```text
cache_read_tokens=100, cache_write_tokens=50, calls=1, candidates=0,
cost_micros=400, input_tokens=100, output_tokens=50, reasoning_tokens=50,
repair_attempts=0, reviewer_attempts=0, specialist_attempts=0, total_tokens=150,
wall_millis=100, work_millis=90
```

It is exactly 396 bytes with SHA-256
`c7f516af474a1da3617dbdcef20ffa9191872ff2f23154670500f819083b95ef` and is
equation-valid within the planner reservation. These digests are fixture checks,
never production persistence of received accounting bytes.

Each field has separate `reserved`, `used`, and `released` totals. Deterministic
calculation high-water/additive meters do not pretend to use this conservation
model: `calculation_meter_vector_v1` separately records exact input/AST/literal/
row/group/intermediate/output byte/cardinality, depth, step, and logical-allocation
values and enforces section 5 limits during graph commit. Tool calls have an
unconditional hard limit of zero and no reservation category.

The immutable default partition limits are exact:

| Vector field          | Generation | Review |
| --------------------- | ---------: | -----: |
| `calls`               |          4 |      1 |
| `candidates`          |          2 |      0 |
| `specialist_attempts` |          1 |      0 |
| `reviewer_attempts`   |          0 |      1 |
| `repair_attempts`     |          1 |      0 |
| `input_tokens`        |     20,000 |  5,000 |
| `output_tokens`       |      8,000 |  2,000 |
| `reasoning_tokens`    |      8,000 |  2,000 |
| `cache_read_tokens`   |     20,000 |  5,000 |
| `cache_write_tokens`  |      8,000 |  2,000 |
| `total_tokens`        |     24,000 |  6,000 |
| `wall_millis`         |     36,000 |  9,000 |
| `work_millis`         |     32,000 |  8,000 |
| `cost_micros`         |    120,000 | 30,000 |

Thus the run totals remain five calls, two candidates, one specialist, one reviewer,
one repair, an aggregate 30,000 total tokens, 45,000 wall milliseconds, 40,000 work
milliseconds, and 150,000 integer base-currency micros. Token categories can overlap:
for `fake-provider-v1`, `total_tokens = input_tokens + output_tokens`, reasoning tokens
are a subset of output tokens, cache-read tokens are a subset of input tokens, and
cache-write tokens are annotations rather than additional billed tokens. Every
adapter/policy revision must pin and test its exact category-to-total formula; no
live adapter is admitted in this slice. Policy revision 1 freezes these exact
literals: `adapter_id = fake-provider-v1`, `model_id = fake-model-v1`,
`price_book_revision = fake-price-book-v1`, token currency `USD`, and integer rates
`input_token_micros = 2`, `output_token_micros = 4`; reasoning/cache fields cost zero
additional micros because they are subsets/annotations. For every reservation and
actual vector, `total_tokens = input_tokens + output_tokens` and
`cost_micros = 2 * input_tokens + 4 * output_tokens`, with both products and the sum
computed in PostgreSQL `numeric`/TypeScript `bigint`, required to fit signed 64-bit,
and rejected on mismatch. There is no fixed fee or rounding.

The closed attempt kinds and conservative reservation vectors are:

| Kind         | Partition    | Nonzero fields in the exact reserved vector                                                                                                                                                                              |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `planner`    | `generation` | `calls=1,input_tokens=4000,output_tokens=2000,reasoning_tokens=2000,cache_read_tokens=4000,cache_write_tokens=2000,total_tokens=6000,wall_millis=9000,work_millis=8000,cost_micros=16000`                                |
| `generator`  | `generation` | `calls=1,candidates=1,input_tokens=6000,output_tokens=3000,reasoning_tokens=3000,cache_read_tokens=6000,cache_write_tokens=3000,total_tokens=9000,wall_millis=9000,work_millis=8000,cost_micros=24000`                   |
| `specialist` | `generation` | `calls=1,specialist_attempts=1,input_tokens=4000,output_tokens=1000,reasoning_tokens=1000,cache_read_tokens=4000,cache_write_tokens=1000,total_tokens=5000,wall_millis=9000,work_millis=8000,cost_micros=12000`          |
| `repair`     | `generation` | `calls=1,candidates=1,repair_attempts=1,input_tokens=6000,output_tokens=2000,reasoning_tokens=2000,cache_read_tokens=6000,cache_write_tokens=2000,total_tokens=8000,wall_millis=9000,work_millis=8000,cost_micros=20000` |
| `reviewer`   | `review`     | `calls=1,reviewer_attempts=1,input_tokens=4000,output_tokens=2000,reasoning_tokens=2000,cache_read_tokens=4000,cache_write_tokens=2000,total_tokens=6000,wall_millis=9000,work_millis=8000,cost_micros=16000`            |

Every omitted reserved-vector field is exactly zero; callers may not reserve a
smaller or larger vector. For a dispatched determinate reconciliation
(`succeeded|refused|failed`), the actual vector is complete, componentwise at most the
reservation, and obeys all of these equality rules before any accounting occurs:

- `calls = 1` for every kind and every determinate outcome;
- `specialist_attempts = 1` exactly for kind `specialist`,
  `reviewer_attempts = 1` exactly for `reviewer`, and `repair_attempts = 1` exactly
  for `repair`; each of those three fields is zero for every other kind, regardless
  of success/refusal/failure;
- `candidates = 1` exactly for a `succeeded` generator `candidate_output` or
  `succeeded` repair `repair_output` whose strict precommit validation is `valid`;
  it is zero for every other determinate kind/result/outcome. This categorical unit
  means one valid reconciled candidate-producing output, not an
  `agent_candidates` row. Reconciliation atomically inserts the immutable recorded
  result and charges the unit; later candidate insertion binds that already charged
  result and never charges or releases the field. Indeterminate has no actual
  vector; its separately defined candidate-field exception releases the reserved
  categorical proof slot because no valid immutable recorded candidate output
  exists, while charging every noncandidate field; and
- all token/time/cache fields are nonnegative, satisfy the pinned overlap and
  token/cost equations, and remain componentwise at most the reservation. They may
  be zero only when those equations permit; mandatory call/kind categorical units
  above can never be released after dispatch.

A determinate reconciliation sets `used_vector = actual_vector`,
`released_vector = reserved_vector - actual_vector`, and `outstanding_vector = 0`
componentwise in one transaction; this determinate equation is unchanged by the
exception below. An **indeterminate settlement** is exactly a caller-selected
`indeterminate` result, a database-derived malformed-accounting or
actual-over-reservation outcome, takeover of a `dispatch_started` attempt, or tenant/
retention cancellation of a `dispatch_started` attempt. Every indeterminate
settlement stores no actual vector and applies this one candidate-field exception
componentwise in the same transaction. For each field `f`, with all operands checked
in PostgreSQL `numeric`/TypeScript `bigint` and then required to fit signed 64-bit:

```text
outstanding_vector.f = 0
if f = candidates:
  used_vector.candidates = 0
  released_vector.candidates = reserved_vector.candidates
else:
  used_vector.f = reserved_vector.f
  released_vector.f = 0
reserved_vector.f = used_vector.f + released_vector.f + outstanding_vector.f
0 <= reserved_vector.f, used_vector.f, released_vector.f, outstanding_vector.f
  <= 9223372036854775807
```

The reserved candidate value is exactly `1` for generator/repair and `0` for every
other kind. Calls and the specialist/reviewer/repair kind units remain fully charged,
as do all other noncandidate fields. Candidate reservation still fences concurrent
capacity while it is outstanding. Settlement releases that categorical proof slot
only because no valid immutable recorded candidate output exists; consequently a
used candidate unit remains proof of such an output rather than a conservative
ambiguity charge.

`attempt_indeterminate.reason_code` is database-derived, is never a function
argument, and is closed to exactly `caller_indeterminate`, `malformed_accounting`,
`actual_over_reservation`, and `takeover_after_dispatch`. The emitting branches and
their precedence are exact:

1. Explicit caller `outcome = indeterminate` is considered first, requires
   `actual_accounting_bytes`, `result_sha256`, and
   `canonical_recorded_result_bytes` all SQL NULL, and emits
   `caller_indeterminate`. It never enters malformed-accounting validation.
2. For a caller-claimed determinate `succeeded|refused|failed` reconciliation, the
   result SHA, result bytes, and `actual_accounting_bytes` must all be nonnull. A
   direct determinate call with SQL NULL accounting, or a present empty/oversized
   byte string, invalid UTF-8, invalid JSON/JCS, wrong schema, unknown/missing/
   duplicate key, nonstring value, invalid tag/decimal/canonical form, out-of-range
   signed-64 value, negative value, or arithmetic/category/token/cache/total/cost
   inconsistency is `malformed_accounting`. The function derives that branch after
   entry under the bounded parser protocol above, before any reservation comparison.
3. Only after the derived typed actual vector is complete, well typed, nonnegative,
   signed-64-safe, and satisfies every category/token/cost equation does the database
   perform the componentwise reservation comparison. Any actual component above its
   reserved component emits `actual_over_reservation`.
4. Otherwise the claimed determinate reconciliation continues unchanged with the
   exact actual/reserved-minus-actual equation and recorded result.
5. A mixed takeover of each `dispatch_started` attempt emits
   `takeover_after_dispatch`.

`malformed_accounting` is limited to the actual-accounting wire object, its derived
typed vector, and its equations; it is distinct from the determinate recorded-result
failure code `malformed_output`.
A determinate `failure(reason_code=malformed_output)` with complete equation-valid,
within-reservation actual accounting follows the unchanged normal determinate branch.

Every branch that emits `attempt_indeterminate` stores SQL NULL `actual_vector`,
inserts no result payload or recorded result, and uses the exact candidate-only
release/noncandidate charge above. Tenant cancellation and retention drain instead
emit `attempt_cancelled_charged`, whose closed body has no `reason_code`; they never
emit `attempt_indeterminate` and do not synthesize any of these four literals.

For the categorical `candidates` field, the reachable counter invariant is exact:
`generation.used_units` equals the checked sum of `actual_vector.candidates` over
determinate terminal attempts, and each `1` corresponds to exactly one immutable
valid `candidate_output|repair_output` recorded result. It need not equal the current
count of `agent_candidates` during the permitted reconciliation-to-materialization
gap. The unique candidate source-result index makes the later durable-row count at
most that sum; before candidate-set close, the fixed grammar requires every still-
relevant charged output to have exactly one row, making the counts equal. No crash,
cancellation, revocation, failure, abstention, or candidate-commit denial releases a
used categorical unit, and a retry cannot charge the same recorded output twice.

The immutable policy permits at most one fresh transient retry per run, only for a
determinate `failed` planner/generator result whose actual vector has
`calls=1`, `candidates=0`, and whose canonical
failure result says `retryable=true`; it must be the immediately preceding result and
no later result/artifact or prepared/dispatched attempt may exist; an untouched
higher reserved generator slot is allowed. Repair/reviewer/refusal/invalid/indeterminate
outcomes and every specialist outcome are not retryable. Retry reserves the same exact kind vector under ordinary
remaining limits, and both the charged failed call and the retried call remain in
used totals and in the recorded-result grammar; a retry never rewrites or discounts
the first attempt.

`attempt_kind` is exactly `planner|generator|specialist|repair|reviewer` with the
partition mapping above. Caller reconcile `outcome` is exactly
`succeeded|refused|failed|indeterminate`; actual-over-reservation is a database-derived
indeterminate outcome, never caller-selected, and the caller supplies no reason code.
`release_agent_run_attempt.reason` is exactly
`adapter_setup_failed|cancelled_before_dispatch|retry_superseded`.
`reserved_pre_dispatch -> dispatch_ready` occurs only through start and
`dispatch_ready -> dispatch_started` only through invocation authorization;
`dispatch_started -> succeeded|refused_charged|failed_charged` maps the first three
reconcile outcomes only after the ordered validation above; caller `indeterminate`
maps to `indeterminate_quarantined` with `caller_indeterminate`, while database-derived
malformed accounting and well-formed over-reservation map there with
`malformed_accounting` and `actual_over_reservation`, respectively. External release
maps only `reserved_pre_dispatch|dispatch_ready -> released_pre_dispatch`; takeover
and cancellation use only the dedicated mappings in the following paragraphs. The immutable policy revision
contains these literals/formulas and no caller supplies or changes a limit, partition,
price, retry rule, or provider/model identity.

For every additive `(run, partition, vector_field)`, define
`outstanding = reserved - used - released`. The invariant is
`reserved = used + released + outstanding`, with every term in
`0..9223372036854775807`. Admission casts all operands to PostgreSQL `numeric`,
requires `used + outstanding + requested <= immutable_limit`, then proves the
result fits `bigint`; TypeScript uses `bigint` and performs the same vector check.
Released capacity may be reserved again, while used capacity may not.

A reservation accepts the complete typed vector, rejects unknown/missing/negative
fields, and includes the vector once. Reconciliation applies the exact outcome/kind
and bounded raw actual-accounting validations above before any componentwise
reservation comparison; malformed accounting maps first, and only a fully parsed,
equation-valid typed local can map to over-reservation. PostgreSQL never attempts
pre-function composite coercion for reconcile. Pre-invocation cancellation releases
the whole vector. No transition can charge or release any component twice; the
attempt row vectors must equal the corresponding per-attempt counter deltas, and the
sum of all attempt deltas must equal every run/partition/field counter. The
indeterminate candidate-field release is a terminal settlement, not a second
release: it occurs exactly once from outstanding under the equation above and is
included in those same per-attempt and aggregate deltas.

The sole bounded queue is not a second dispatch lane. After planner/optional
specialist completion, the reserve function requires generator slot 1 and then, iff
the Brief target is two, slot 2; both are initial, same-kind reservations with null
retry predecessor. Slot 1 admission first proves the checked sum of every still-
missing initial slot reservation fits the current generation vector; it writes only
slot 1, but will not create a batch that cannot admit its remaining slot under the
locked counters. After a determinate all-pre-invocation takeover releases a partial
or complete batch, the new claimant repeats this rule and may insert one null-retry
replacement row for each still-unresolved `released_takeover` slot; it cannot replace
a worker-released, cancelled, dispatched, or result-bearing slot. Before any start,
all still-required initial slots must again be reserved. Start/authorize accept only
the lowest unresolved slot, or its
immediate retry, and require no other attempt in `dispatch_ready|dispatch_started`.
After a valid slot result the candidate commit must bind it before the next slot can
start. After slot-1 invalid, refusal, exhausted failure, or any branch that makes a
later slot unreachable, the fixed worker release settles each later queued slot in
ascending attempt ID with reason `retry_superseded` before abstention/finish/repair.
At most two generator attempts are nonterminal, one per slot; a slot's current row
may be the one retry replacing its terminal failed predecessor. Planner, specialist,
repair, and reviewer are never queued.

Attempt states are exactly `reserved_pre_dispatch`, `dispatch_ready`,
`dispatch_started`,
`succeeded`, `refused_charged`, `failed_charged`, `released_pre_dispatch`,
`released_takeover`, `cancelled_released`, `cancelled_charged`, and
`indeterminate_quarantined`. Transitions are one-way. Every attempt reserves the
conservative vector and appends `attempt_reserved` in one committed transaction
before adapter dispatch. `start_agent_run_attempt` is preparation only: it commits
`reserved_pre_dispatch -> dispatch_ready` and `attempt_dispatch_prepared` after
adapter setup but does not authorize or claim that invocation occurred. A separate
`authorize_agent_run_attempt_invocation` transaction immediately precedes the call;
only its successful commit moves `dispatch_ready -> dispatch_started`, appends
`attempt_dispatch_started`, and returns `authorized_now`. Result reconciliation occurs
in a new fenced transaction.

At the adapter/orchestration boundary, a response that contains a finite accounting
byte sequence of at most 1,024 bytes is captured once and passed unchanged as
`actual_accounting_bytes`. The boundary may distinguish byte-sequence presence and
enforce only that transport cap. It must not decode UTF-8, parse JSON, inspect keys,
coerce a component to JavaScript `number`/`bigint` or the PostgreSQL composite,
canonicalize, reorder, repair, trim, or otherwise normalize the accounting bytes.
In particular, a present zero-byte response and every other received bounded payload
reach the function unchanged under the response's caller-claimed determinate outcome,
so every promised malformed class is database-reachable.

The TypeScript response member is exactly
`actual_accounting_bytes: Uint8Array`; it is not a vector-shaped object. The
orchestrator snapshots its finite view into an equal-length `Buffer` without text
conversion and binds that buffer as parameter 6 of this sole fixed query:

```sql
SELECT *
FROM dasher_run_api.reconcile_agent_run_attempt(
  $1::uuid,
  $2::bigint,
  $3::bytea,
  $4::uuid,
  $5::text,
  $6::bytea,
  $7::bytea,
  $8::bytea
)
```

Parameters 6, 7, and 8 are respectively `actual_accounting_bytes`,
`result_sha256`, and `canonical_recorded_result_bytes`. Node/PostgreSQL bytea
binding must preserve every octet; there is no composite literal, JSON parameter,
text round-trip, or alternate overload.

An absent response, timeout, thrown transport error, truncated/nonfinite stream, or
other failure to obtain a complete byte sequence maps to an explicit caller
`outcome = indeterminate` call with `actual_accounting_bytes`, `result_sha256`, and
`canonical_recorded_result_bytes` all SQL NULL. A response whose accounting sequence
would exceed 1,024 bytes is transport absence under the same rule: the adapter stops
buffering at byte 1,025, passes none of those bytes, and makes the same all-NULL
indeterminate call. It must not claim database `malformed_accounting` for that
unreceived over-cap response. The database nevertheless applies its own inclusive
1,024-byte defense to direct/hostile calls; a nonnull over-cap argument that reaches
the function is database-derived `malformed_accounting`. This separates transport
absence from database content classification without making any bounded received
payload unreachable.

For a retry after a transaction is proven rolled back, orchestration retains and
resubmits the same captured byte array byte-for-byte; it never reparses or rebuilds
the wire object. An ambiguous commit destroys the pooled client and is not permission
to submit a newly normalized accounting object. A committed normal reconciliation
persists and replays only the derived typed vector; a committed indeterminate branch
persists no actual vector. Event/reducer/checkpoint replay never requires or recreates
`actual_accounting_bytes`, and a duplicate/stale reconciliation may perform no extra
accounting or result DML.

A pre-invocation failure may release; any post-dispatch
ambiguity applies the exact indeterminate-settlement equation: every noncandidate
reserved component moves from outstanding to `used`, the candidate component moves
from outstanding to `released`, the attempt enters `indeterminate_quarantined`, and
the run terminalizes as `failed` in the same transaction. Unknown estimate,
missing price-book revision, malformed received accounting, actual usage above reservation,
arithmetic overflow, exhausted partition, or limit breach denies before adapter
invocation or conservatively fails after dispatch.

Lease takeover locks all prior-epoch nonterminal attempts and counters before any new
authority. It settles them in ascending canonical `attempt_id` byte order. If none is
`dispatch_started`, each `reserved_pre_dispatch|dispatch_ready` attempt becomes
`released_takeover`, moves its full outstanding vector to released, and appends one
`attempt_released(release_mode=takeover)`; only after the last release does the
function increment the epoch and append `lease_acquired` for the new claim.

If at least one is `dispatch_started`, the same single transaction still walks the
mixed set in ascending attempt ID: each `reserved_pre_dispatch|dispatch_ready` is
released exactly as above, while each `dispatch_started` becomes
`indeterminate_quarantined`, applies the exact indeterminate-settlement equation,
and appends one `attempt_indeterminate(reason_code=takeover_after_dispatch)`; no
caller reason is accepted. For each released attempt the database derives
`release_proof_sha256` from the
registry preimage with release-reason text exactly `takeover`, the prior epoch, the
stored request hash, and stored reservation; no caller supplies a per-attempt proof.
Only after every per-attempt event does it append one aggregate
`indeterminate_quarantined` event whose released/charged ID arrays preserve those
respective ascending subsequences and whose aggregate used/released vectors are the
checked componentwise sums of the preceding events. It then sets
`new_epoch = prior_epoch + 1`, clears the lease, terminalizes the run as `failed`,
and returns `terminalized_indeterminate` with no token or dispatch-capable claim; it
does not append `lease_acquired`. All attempt/counter/event/run changes roll back
together on any failure. The aggregate write stores operation kind
`indeterminate_takeover`, the claim request ID, the exact terminal claim-input
digest, and the terminal operation digest on `agent_runs`; the globally unique event
header additionally stores the same ID/kind/input, exact typed result projection,
and result digest. The event body binds those hashes plus the lease seconds,
principal, source head captured before the first settlement event, epochs, and
settlement aggregate. An exact pre-purge retry under
the same latest principal and lease seconds discovers that globally unique operation,
revalidates only the retained header contract, returns the stored typed outcome, and
writes nothing. Same operation ID with kind/lease-seconds/principal/input/result
drift receives the one fixed non-leaking denial. A stale worker can never reconcile/release a
settled attempt, a new worker cannot dispatch, and a late result cannot commit or
reopen the run.

Tenant cancellation and retention drain settle all nonterminal attempts in stable
`attempt_id` order in the same transaction. `reserved_pre_dispatch|dispatch_ready` becomes
`cancelled_released`, adds the full reservation to `released`, and appends
`attempt_cancelled_released`. `dispatch_started` without reconciliation becomes
`cancelled_charged`, applies the exact indeterminate-settlement equation, and appends
`attempt_cancelled_charged`; “charged” here means its call, kind, and every other
noncandidate field are charged while its candidate proof slot is released. That event
has no `reason_code` and cancellation/drain never append `attempt_indeterminate`. A
later adapter result is stale and discarded. Already
terminal attempts do not change. Only after every component has zero outstanding
does the body increment/fence the lease epoch and append `run_cancelled` or
`run_cleanup_cancelled`. Same-operation retry emits no duplicate event or charge.
The two fixed function bodies freeze this identical sequence directly; no generic
runtime-settlement helper or EXECUTE grant is exposed.

Tenant cancellation additionally has one durable operation identity on the existing
`agent_runs` row. The audit UUID is the cancel operation UUID. Before first mutation,
the fixed body computes the exact operation digest from that UUID, the locked tenant/
dashboard/run, expected run revision, canonical reason SHA, CSRF key version/digest,
deployment revision, and current actor user/membership/authority revision. After the
terminal event hash is fixed it computes and stores the exact typed-result digest and
the result revision/event sequence/event hash. An exact retry is serialized by that
operation UUID, reauthorizes the current tenant resource, compares every incoming
binding by recomputing the digest, and returns the stored result with zero DML before
ordinary revision/terminal rejection. ID reuse with any target, actor, reason, CSRF,
deployment, operation, or result drift is one non-leaking denial. These opaque run
identity/result commitments survive content purge and disappear with the run at
held-aware 365-day metadata age-out; the immutable predecessor audit header continues
to reserve the UUID afterward. The exact pre/post-age-out behavior is closed in
sections 4.3–4.5.

Retry requires a fresh vector reservation; only one transient retry is allowed.
The 80% threshold applies only to a vector field whose immutable limit is positive;
zero-limit fields permit only requested/used/outstanding zero and are excluded from
the threshold. At or above
`used + outstanding >= ceil(immutable_limit * 4 / 5)` in any positive field of the
relevant partition, no optional call or retry is permitted. Every operand is cast
to exact `numeric` before multiplication/division and the result is range-checked
before storage. Orchestration may only finish from already recorded evidence; it
cannot expand limits, and an incompletely reviewed candidate remains ineligible.

### 3.5 Prior trust-contract disposition

This plan implements the prior lifecycle plan's run ledger, budgets, calculation
registry, MetricContractVersion, Claims/evidence, common evidence bundle, typed
Brief, and typed abstention obligations for a private Suggest-tier candidate. The
following disposition is exhaustive; accepting this planning PR accepts only this
scope split, not implementation authority:

| Prior obligation                                                                              | Task 9 / `0007` disposition                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordered events, projections/checkpoints, leases, budgets, replay, calculation registry/meters | Implement and test in Task 9.                                                                                                                                                                                                                                                                                                                                          |
| Complete `MetricContractVersion` semantics                                                    | Implement immutable candidate/run contract versions with business/data owner, definition, aggregation, denominator, type, unit/currency, good/bad direction, threshold/target, grain, lag, freshness SLO, allowed dimensions, calendar/timezone, lineage, reviewed status, and graph binding. Dashboard-version binding is deferred because Task 9 creates no version. |
| Stable Claims, typed edges, candidate manifests                                               | Implement and purge through the governed candidate lifecycle.                                                                                                                                                                                                                                                                                                          |
| One frozen common evidence bundle for compared candidates                                     | Implement one content-addressed `candidate_comparison_bundle` per run; every candidate and manifest in that run must bind the same bundle hash and evidence membership.                                                                                                                                                                                                |
| Typed Brief and typed abstention                                                              | Implement private run-local Briefs and `run_abstentions` with the closed reasons named in section 4.3; neither creates a dashboard version.                                                                                                                                                                                                                            |
| Manual acceptance and prior-good-head preservation                                            | Explicitly deferred to Task 10 / additive `0008` or later. Task 9 stops at `approval_required` and exposes no acceptance method.                                                                                                                                                                                                                                       |
| Publication and prior-publication preservation                                                | Explicitly deferred to Task 10 / additive `0008` or later; Task 9 creates no publication relation or audience effect.                                                                                                                                                                                                                                                  |
| Manual/agent semantic change receipts                                                         | Explicitly deferred with dashboard-version creation to Task 10 / additive `0008` or later; Task 9 cannot overwrite a version or head.                                                                                                                                                                                                                                  |
| Distinct-alternative UX and administrator projections                                         | Data contracts and bounded status fields are implemented here; routes, UI, and administrator surfaces are separately gated application work.                                                                                                                                                                                                                           |
| Live outbox/provider/tool dispatch                                                            | Explicitly deferred. Fake/replay have zero network/tools; no outbox is created in `0007`.                                                                                                                                                                                                                                                                              |

## 4. PostgreSQL `0007` design contract

Task 9A transcribes the exact columns, constraints, policy expressions, return composites,
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
relation families. Every dashboard/tenant-scoped family is organization-keyed with
composite tenant-safe foreign keys and forced RLS; the platform run-principal
allowlist is not tenant content and uses only the exact SESSION_USER bootstrap
policy below:

1. `agent_run_policy_revisions` — immutable enabled policy revisions and closed
   Suggest limits. The first request globally lazily seeds exact
   revision 1 under a fixed database-wide policy-seed advisory lock acquired before
   the organization advisory lock, with fixed
   migration provenance; concurrent first requests converge on one identical
   row. No app policy-admin mutation is exposed in this slice; the run definer's
   exact policy-key UPDATE authority exists only to acquire the required tuple lock
   and is never a runtime data writer.
2. `run_service_principal_allowlist` — append-only principal revisions binding
   one exact `postgres_session_user` login to the platform run-operator scope and
   closed capabilities in exact unsigned-UTF-8 order (`checkpoint`, `claim`,
   `clone_replay`, `close_candidate_set`, `commit_abstention`, `commit_brief`,
   `commit_bundle`, `commit_candidate`, `commit_claims`, `commit_graph`,
   `commit_manifest`, `commit_validation`, `consume_replay`, `dispatch`,
   `finalize_ranking`, `finish`, `read_input`, `read_replay`, `reconcile`, `release`,
   `reserve`).
   `checkpoint` authorizes only checkpoint write and `dispatch` only the local
   dispatch preparation plus the single fresh invocation-authorization transition;
   it grants no direct provider or network authority. Its exact principal-key UPDATE
   authority likewise exists only for the required tuple lock and cannot mutate an
   allowlist row.
   `capabilities` is a sorted, unique, nonempty constrained `text[]` drawn only from
   that list. `capabilities_sha256` is SHA-256 over domain
   `dasher.run-principal-capabilities.v1\0`, the signed-64-bit element count, and each
   capability in stored order as canonical-binary-v1 text (unsigned-32-bit UTF-8 byte
   length plus NFC bytes). The array has no PostgreSQL-array binary representation in
   any preimage. It carries exact columns `previous_principal_revision`,
   `previous_principal_sha256`, `principal_sha256`, `database_oid`, and
   `database_name` in addition to the binding/capability columns. Revision 1 has both
   predecessor columns NULL; revision `n > 1` requires
   `previous_principal_revision = n - 1` and the exact prior row's `principal_sha256`.
   `principal_sha256` is SHA-256 over domain `dasher.run-principal.v1\0`, principal
   UUID, signed-64-bit revision, nullable prior revision, nullable prior hash,
   PostgreSQL session-login text, enabled byte, the signed-64-bit capability count
   followed by each canonical-binary-v1 capability text, `capabilities_sha256` as a
   byte string, database OID converted losslessly to signed-64-bit `oid::bigint`, and
   database-name text, in exactly that order. The capability count/values in the
   principal preimage must equal the independently hashed array; OIDs outside
   `0..4294967295` deny. There is no tenant wildcard chosen by a caller.
   Canonical production data contains no principal;
   PostgreSQL tests insert one synthetic binding through the owner harness and
   remove it during cleanup.
3. `agent_runs` — opaque request/run IDs, dashboard/policy/limit bindings plus
   rebuildable current state, sequence/hash pointer, lease epoch/token hash/composite
   owner principal ID and revision/expiry, latest checkpoint revision, requesting
   membership/user/authority revision,
   and terminal metadata. A terminal mixed takeover additionally retains its globally
   searchable claim operation ID, a domain-separated terminal claim-input digest,
   and the terminal operation digest needed for body-free exact retry. The global
   cross-kind claim identity and original-result projection live on the matching
   retained event header; no event body is needed for either ordinary or mixed-
   terminal retry. A tenant-cancelled row separately retains one globally unique
   tenant-cancel operation ID, exact operation/result digests, and the result
   revision/event sequence/event hash needed to reconstruct its original mutation result without a purgeable
   payload. Purgeable `agent_run_request_payloads` stores purpose,
   input snapshot/catalog/contract IDs and bare hashes, replay source ID, the exact
   persisted request-idempotency digest, and the nonce needed to verify its retained
   chain envelope. The digest is inside the closed canonical request object and in
   its own exact 32-byte column; it is never copied to a retained run header.
4. `agent_run_events` — insert-only ordered governed event headers and hashes. Every
   successful ordinary claim's `lease_acquired` header and every mixed-terminal
   claim's `indeterminate_quarantined` header also carries the one globally unique
   claim request ID, exact operation kind, branch-specific input/result digests, and
   bounded typed original-result projection. The random ordinary attempt token is
   retained only in that protected header projection until content purge; no tenant
   event-list result exposes it. Sensitive/tenant-derived canonical event bytes live
   separately in retention-deletable `agent_run_event_payloads`.
5. `agent_run_checkpoints` — insert-only governed checkpoint headers, reducer
   version, source event sequence/hash, nonce-independent semantic `state_sha256`,
   nonce-bearing retained-envelope `checkpoint_sha256`, and pinned digests. Bounded
   canonical checkpoint bytes, both hashes, and the nonce live in retention-deletable
   `agent_run_checkpoint_payloads`. Content purge clears the bare semantic state hash
   and payload pointer but retains the envelope digest as governed chain metadata.
   The fixed writer derives the bytes and both hashes by reading and replaying the
   retained event payload rows for exactly its fenced run; there is no general
   payload-reader function.
6. `agent_run_budget_counters` — one row per run, partition, and exact attempt-
   resource-vector field; immutable limit plus exact nonnegative reserved/used/
   released totals. `agent_run_calculation_meters` separately records every exact
   validated `calculation_meter_vector_v1` without additive-reservation fiction.
7. `agent_run_attempts` and `agent_run_attempt_payloads` — governed attempt headers
   and append-only payload rows keyed by `(attempt_id, payload_kind)` where
   `payload_kind` is exactly `request | result`. Before content purge the attempt has
   nonnull immutable `request_payload_id` and initially-null, write-once
   `result_payload_id`; both are retention-nullable and may only transition from
   populated to NULL in the fixed purge body. Reserve inserts the sanitized canonical
   request row; determinate reconcile inserts the sanitized canonical result row and
   sets only `result_payload_id`. A payload row
   stores exactly one canonical byte string/hash/nonce and cannot be updated.
8. `field_catalog_snapshots` and `field_catalog_entries` — immutable stable field
   IDs, types, nullability, units/currency/grain/event time/freshness, and exact
   source snapshot/evidence bindings.
9. `calculation_graphs` and `calculation_results` — immutable validated AST,
   versions/digests/limits, deterministic output/status/meters, and evidence hash.
10. `metric_contract_versions` — immutable business/data owner, definition,
    aggregation, denominator, expected type, unit/currency, direction,
    threshold/target, grain, lag, freshness SLO, allowed dimensions, calendar/
    timezone, lineage, and reviewed status. A calculation graph binds the contract
    through its composite FK; the immutable contract never receives a graph pointer.
    It has no dashboard-version binding in this slice.
11. `candidate_comparison_bundles` and `candidate_comparison_bundle_evidence` —
    exactly one frozen, content-addressed evidence bundle per run and its exact
    authorized evidence membership. The header stores the exact positive membership
    count. Every compared candidate binds this same
    bundle; per-candidate evidence substitution is denied.
12. `agent_candidates` — private candidate identity, strict `DashboardSpec` 1.0
    or 1.1 hash, common-bundle hash, validation/rank/review state, and no version,
    head, reference-claim, or publication authority. Canonical candidate bytes live
    in separate retention-deletable `agent_candidate_payloads`.
13. `claims`, `claim_evidence`, and `candidate_evidence_manifests` — stable typed
    statements, evidence state, support/contradiction/context edges, manifest
    completeness/hash, exact candidate/common-bundle/snapshot/evidence bindings,
    and no dashboard-version binding.
14. `briefs` — immutable private run-local typed objective, audience, constraints,
    evaluation criteria, and common evidence bundle. It creates no route or version.
15. `run_abstentions` — immutable typed outcomes using exactly the section 4.3
    `run-abstention-v1` schema: closed reasons
    `insufficient_evidence`, `ambiguous_request`, `missing_governed_metric`,
    `unsupported_capability`, `calculation_limit`, `budget_exhausted`, and
    `authority_revoked`, with the fixed retryability and next-safe-step mapping
    and no explanation field. No abstention fabricates a fallback fact or
    recommendation.
16. `agent_recorded_results` — bounded, sanitized, content-addressed fake model
    results and replay-consumed copies. Only determinate fake reconciliation or the
    fixed replay-consume function writes them. No credential, network response body,
    provider error, tool side effect, or prompt secret is stored.
17. `agent_validation_findings` — exactly one immutable bounded validation-set row
    per candidate and frozen candidate-spec hash, containing canonical bytes,
    count, derived state, and hash for the section 4.3 schema. Only
    `commit_agent_validation_findings` writes it; it has no provider-attempt,
    dispatch, network, or tool semantics.
18. `dashboard_agent_drain_proofs` — immutable governed cleanup proof headers
    binding dashboard/lifecycle revision, cleanup lease/principal revision,
    pre-drain/cancelled/remaining counts, exact terminal event range/hash, database
    time, and proof hash. They contain no run payload.
19. `dashboard_agent_run_age_out_proofs` — one immutable proof per exact dashboard,
    lifecycle revision, target organization, and age-out operation ID, containing
    eligible/deleted counts, the exact sorted pre-deletion retained run-chain set
    digest and checked event count, deletion time, legal-hold/tombstone/backup-proof
    bindings, distinct `source_purge_proof_sha256` and generated
    `age_out_proof_sha256`. It is audit-governed and not
    deleted by the run-metadata operation it proves.
20. `dashboard_agent_drain_proof_consumptions` — one immutable row per consumed drain
    proof, inserted only by the replaced `claim_dashboard_cleanup` after a successful
    cleanup-attempt row has recorded that generated proof and released the preceding
    lease. It binds exact proof ID/hash, dashboard/lifecycle revision, the preceding
    drain lease and successful attempt, the newly claimed lease, retention principal
    revision, and lifecycle event/audit ID. Absence means unconsumed; no proof row is
    ever updated. It is retained with drain headers and deleted immediately before
    its parent drain proof during final metadata age-out.

### 4.2A Exhaustive phase-7 relation matrix

This matrix is the SQL source of truth for all 31 relations; prose inventory above
cannot add a column or relationship. `N` means nullable; every unmarked column is
`NOT NULL`. No phase-7 column has a `DEFAULT`, identity, or generated expression:
every value, including UUID/time/zero/boolean values, is supplied explicitly by its
fixed writer. A future default would require an explicit `D=<SQL literal>` marker in
the column cell and a plan correction; there are no such markers below. Every digest
and nonce `bytea` has `octet_length = 32`; canonical-byte
columns carry the schema-specific byte ceiling; enum-like `text` and all arrays carry
the closed checks in sections 3–5. Every FK below is `ON UPDATE RESTRICT ON DELETE
RESTRICT`, `MATCH SIMPLE`, and `NOT DEFERRABLE INITIALLY IMMEDIATE` unless the cell
literally says `DEFERRABLE INITIALLY DEFERRED`; every omitted FK/cascade is forbidden.
Unique constraints use PostgreSQL's default `NULLS DISTINCT`. `PK`/`UQ` create their
PostgreSQL btree indexes and the `Ix` cell lists every additional exact btree index or
partial predicate, with `ASC NULLS LAST` for every unannotated key. All 31 relations
are `ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY`.

Names are mechanical and frozen: a relation's PK is `<relation>_pkey`; its UQs, FKs,
CHECKs, and extra indexes are `<relation>_uq_NN`, `<relation>_fk_NN`,
`<relation>_check_NN`, and `<relation>_ix_NN`, where `NN` is the two-digit 1-based
appearance order within its own kind: left-to-right UQ clauses, then left-to-right FK
clauses, then left-to-right CHECK predicates as written in that relation's matrix
cell. A named fixed-trigger requirement is not silently converted into a CHECK.
Partial uniqueness written in an
Extra-index cell is an `ix_NN` unique index, not a UQ constraint. No PostgreSQL
auto-generated/truncated name is accepted. The following tokens are exact expansions
where a row uses shorthand: `dashboard` = local `(organization_id,dashboard_id)` to
`dasher.dashboards(organization_id,dashboard_id)`; `run` = local
`(organization_id,dashboard_id,run_id)` to the same columns of `agent_runs`;
`candidate` = local `(organization_id,dashboard_id,run_id,candidate_id)` to the same
columns of `agent_candidates`; `catalog` = local
`(organization_id,dashboard_id,catalog_snapshot_id)` to the same columns of
`field_catalog_snapshots`; `bundle` = local
`(organization_id,dashboard_id,run_id,bundle_id)` to the same columns of
`candidate_comparison_bundles`; `common_bundle` = local
`(organization_id,dashboard_id,run_id,common_bundle_id)` to
`candidate_comparison_bundles(organization_id,dashboard_id,run_id,bundle_id)`; and
`graph` = local
`(organization_id,dashboard_id,run_id,graph_id)` to the same columns of
`calculation_graphs`. Further tokens are: `policy` = `(policy_revision)` to the same
column of `agent_run_policy_revisions`; `request_payload` = local
`(organization_id,dashboard_id,request_payload_id)` to the same columns of
`agent_run_request_payloads`; `event_with_hash` = local
`(organization_id,dashboard_id,run_id,source_event_sequence,source_event_sha256)` to
`agent_run_events(organization_id,dashboard_id,run_id,event_sequence,event_sha256)`;
`checkpoint_payload` = local
`(organization_id,dashboard_id,checkpoint_payload_id)` to the same columns of
`agent_run_checkpoint_payloads`; `result` = local
`(organization_id,dashboard_id,run_id,result_id)` to the same columns of
`calculation_results`; `brief` = local
`(organization_id,dashboard_id,run_id,brief_id)` to the same columns of `briefs`;
`recorded_result` = local `(organization_id,dashboard_id,run_id,source_result_id)`
or the explicitly named reviewer ID to
`agent_recorded_results(organization_id,dashboard_id,run_id,result_id)`;
`selected_candidate` = local
`(organization_id,dashboard_id,run_id,selected_candidate_id)` to
`agent_candidates(organization_id,dashboard_id,run_id,candidate_id)`;
`attempt_request_payload` and `attempt_result_payload` = respective local
`(organization_id,dashboard_id,run_id,attempt_id,request_payload_id)` and
`(organization_id,dashboard_id,run_id,attempt_id,result_payload_id)` to
`agent_run_attempt_payloads(organization_id,dashboard_id,run_id,attempt_id,payload_id)`;
`source_snapshot` = local `(organization_id,source_snapshot_id)` or explicitly named
input ID to `dasher.source_snapshots(organization_id,snapshot_id)`; `evidence` =
local `(organization_id,evidence_id)` to the same columns of
`dasher.evidence_records`; `membership` = local
`(organization_id,<named_membership_id>)` to
`dasher.memberships(organization_id,membership_id)`; and `contract_member` = local
`(organization_id,dashboard_id,contract_set_id,contract_id,contract_version)` to the
same columns of `metric_contract_versions`. “Exact run bundle/Brief/result/evidence”
always means these full keys, never an ID-only FK. Task 9A expands every token to
ordered local/referenced column arrays and rejects a phrase not in this registry;
constraint/index method, columns, predicate, actions, and deferrability are catalog
fixtures rather than implementer-selected details.

`M` is the exact migration-session owner identity proven at the migrator advisory gate
and journal insert; Task 9A records its role OID/name and requires every new relation,
type, schema, constraint, index, and trigger to have that same owner. It is not a new
managed role. Runtime roles never own a relation. Policy/grant codes expand exactly:
`A` = `dasher_security_definer`, `R` = `dasher_run_definer`, `T` =
`dasher_retention_definer`, `B` = the special all-revision bootstrap SELECT policy for
`R`; suffixes are `S|I|U(columns)|D`. Each policy is named
`<relation>_<a|r|t|bootstrap>_<command>` and uses the exact context/principal/phase/
resource predicates in sections 4.6–4.7 in both `USING`/`WITH CHECK` as applicable.
The role receives only the matching column grant in section 4.7; no cell means no
policy and no grant. Migration-owner test-fixture DML is not a runtime grant.
The sole narrowed SELECT notation is
`R:S(checkpoint_event_payload_columns)`, expanding exactly to
`organization_id,dashboard_id,run_id,event_payload_id,event_id,event_sequence,
content_nonce,canonical_bytes,payload_sha256`; it creates only the checkpoint replay
policy named below and deliberately omits `created_at`. It is not `SELECT ALL` and
does not change the meaning of any other `S` cell.

`agent_run_policy_revisions` is the sole non-tenant policy table exception to the
organization-keyed template. Its `agent_run_policy_revisions_security_definer_select`
policy requires `current_user='dasher_security_definer'`, full initialized tenant
context, and function phase `request_policy`; it may see the complete contiguous
global policy chain only inside that fixed request body; the body validates the full
predecessor/hash chain, selects only its unique maximum revision, and requires that
row enabled. Its identically fenced INSERT policy permits only the exact absent
revision-1 row. The
`agent_run_policy_revisions_run_definer_select` policy requires the proven run
principal, phase, and opaque run and exposes the complete chain only inside that fixed
body; the body validates the chain, fixes its enabled unique maximum as the proven
transaction-local policy key, and later requires the locked run's request-bound
revision/hash to equal it. The exact
`agent_run_policy_revisions_run_lock_update` policy is available only to
`dasher_run_definer` in phase `locking`, requires
`policy_revision = <proven transaction-local policy_revision>` in `USING`, and has
`WITH CHECK (false)`. Its column-level UPDATE grant is exactly `policy_revision`.
There is no DELETE policy, table-wide UPDATE, app-role table grant, free-standing
runtime selector, run-role runtime writer, or fallback to an older revision. The
separately frozen convergent revision-1 INSERT remains the only runtime seed path; the
immutable guard rejects every attempted actual or no-op UPDATE.

After bootstrap has proven the complete principal chain and unique latest revision,
`run_service_principal_allowlist_run_select` exposes in phase `locking` only the exact
latest row whose key equals the proven transaction-local principal ID/revision. Its
exact `run_service_principal_allowlist_run_lock_update` policy is available only to
`dasher_run_definer` in that phase, requires both
`run_service_principal_id = <proven transaction-local principal ID>` and
`principal_revision = <proven transaction-local principal revision>` in `USING`, and
has `WITH CHECK (false)`. The column-level UPDATE grant is exactly
`(run_service_principal_id,principal_revision)`. There is no DELETE policy,
table-wide UPDATE, run-role runtime writer, or actual/no-op mutation path; the
immutable guard rejects every attempted UPDATE. These two narrow policies authorize
only `SELECT ... FOR UPDATE` on the proven principal/policy key rows.

#### 1. `agent_run_policy_revisions`

- Columns: `policy_revision bigint, previous_policy_revision bigint N, previous_policy_sha256 bytea N, policy_sha256 bytea, enabled boolean, adapter_id text, model_id text, price_book_revision text, input_token_micros bigint, output_token_micros bigint, generation_limit_vector dasher_run_api.attempt_resource_vector, review_limit_vector dasher_run_api.attempt_resource_vector, active_organization_run_limit smallint, active_dashboard_run_limit smallint, approval_required_dashboard_limit smallint, provider_concurrency_limit smallint, tool_attempt_limit smallint, retry_limit smallint, planner_instructions_sha256 bytea, generator_instructions_sha256 bytea, specialist_instructions_sha256 bytea, repair_instructions_sha256 bytea, reviewer_instructions_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(policy_revision)`; UQ `(policy_sha256)`; nullable self FK `(previous_policy_revision)` to `(policy_revision)`; revision 1 has both predecessor fields null, `enabled=TRUE`, and the six non-vector limit columns equal `2,1,2,1,0,1` in column order; later rows bind exactly `n-1`/hash by fixed trigger; request/claim use only the unique maximum revision and deny when it is disabled, never falling back
- Extra indexes: none
- RLS/grants: `A:S,I`; `R:S,U(lock-only policy key)`
- Sole writer(s): `request_agent_run` may convergently insert only exact revision 1; later revisions migration-owner provisioning only. The run lock-only UPDATE authority is not a writer; no runtime UPDATE/DELETE exists, and the immutable guard denies actual/no-op mutation.

#### 2. `run_service_principal_allowlist`

- Columns: `run_service_principal_id uuid, principal_revision bigint, session_login name, enabled boolean, capabilities text[], capabilities_sha256 bytea, previous_principal_revision bigint N, previous_principal_sha256 bytea N, principal_sha256 bytea, database_oid oid, database_name name, created_at timestamptz`
- Keys/FKs/checks: PK `(run_service_principal_id,principal_revision)`; UQ `(session_login,database_oid,principal_revision)` and `(principal_sha256)`; nullable self FK `(run_service_principal_id,previous_principal_revision)` to `(run_service_principal_id,principal_revision)` with both predecessor fields null for revision 1 and both nonnull thereafter
- Extra indexes: `(session_login,database_oid,principal_revision DESC)`
- RLS/grants: `B:S`; `R:S,U(lock-only principal key)`
- Sole writer(s): migration-owner/preflight provisioning only; append revisions, never UPDATE/DELETE. The run lock-only UPDATE authority is not a writer, and the immutable guard denies actual/no-op mutation.

#### 3. `agent_runs`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, run_request_id uuid, request_payload_id uuid N, requesting_user_id uuid, requesting_membership_id uuid, requesting_authority_revision bigint, policy_revision bigint, requested_at timestamptz, state text, run_revision bigint, current_event_sequence bigint, current_event_sha256 bytea, lease_epoch bigint, lease_token_sha256 bytea N, lease_owner_principal_id uuid N, lease_owner_principal_revision bigint N, lease_expires_at timestamptz N, latest_checkpoint_revision bigint N, candidate_set_sha256 bytea N, candidate_set_closed_at timestamptz N, terminal_at timestamptz N, terminal_reason_sha256 bytea N, selected_candidate_id uuid N, consumed_replay_sequence bigint N, consumed_replay_sha256 bytea N, terminal_operation_kind text N, terminal_operation_id uuid N, terminal_claim_input_sha256 bytea N, terminal_operation_sha256 bytea N, tenant_cancel_operation_id uuid N, tenant_cancel_operation_sha256 bytea N, tenant_cancel_result_sha256 bytea N, tenant_cancel_result_run_revision bigint N, tenant_cancel_result_event_sequence bigint N, tenant_cancel_result_event_sha256 bytea N`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id)`; UQ `(organization_id,run_id)` and `(organization_id,run_request_id)`; FKs `dashboard` and `policy` use the global immediate rule; `request_payload` and nullable `selected_candidate` are `DEFERRABLE INITIALLY DEFERRED`. `terminal_operation_kind` is NULL or exactly `abstention|ranking|finish|indeterminate_takeover`; `terminal_claim_input_sha256` is NULL for the first three kinds and is nonnull exactly with the pre-purge `indeterminate_takeover` operation digest. The six `tenant_cancel_*` columns are all NULL or all nonnull; the nonnull form is written exactly once only by tenant `cancel_agent_run`, requires state `cancelled`, positive result revision/sequence, exact 32-byte operation/result/event digests, and an immutable `run_cancelled` event at that sequence/hash. Cleanup cancellation and operator `finish_agent_run(...,'cancelled',...)` leave all six NULL. The transition/retention trigger enforces that terminal operation kind/ID are written once together, only the mixed-takeover branch writes `terminal_claim_input_sha256`, both mixed digests are 32 bytes, and content purge may clear those two mixed digests together but may not clear or change kind/ID. Tenant-cancel fields are write-once and never content-purge-clearable.
- Extra indexes: `(state,requested_at,run_id)` with exact predicate `state IN ('requested','authorized','planning','generating','validating','revising')`; unique `(organization_id,dashboard_id)` with exact predicate `state IN ('requested','authorized','planning','generating','validating','revising')`; `(organization_id,requesting_membership_id,state)`; unique `(terminal_operation_id)` with exact predicate `terminal_operation_kind = 'indeterminate_takeover'`; unique `(tenant_cancel_operation_id)` with exact predicate `tenant_cancel_operation_id IS NOT NULL`. The fourth index remains the mixed-takeover run-projection uniqueness check; the fifth is the database-global retained tenant-cancel operation identity. Global cross-kind claim-ID uniqueness and retry discovery use `agent_run_events_ix_02` below. A fixed dashboard-locked request/ranking trigger enforces at most two rows in `approval_required`; there is deliberately no uniqueness index on that quiescent state because source plus replay must both reach it.
- RLS/grants: `A:S,I,U(run/cancel set)`; `R:S,U(run set)`; `T:S,U(retention/run set),D`
- Sole writer(s): request/cancel; operator transition functions, with only `claim_agent_run` writing the mixed-takeover operation/input fields; drain/purge/age-out only as matrixed

#### 4. `agent_run_request_payloads`

- Columns: `organization_id uuid, dashboard_id uuid, request_payload_id uuid, run_request_id uuid, request_idempotency_sha256 bytea, content_nonce bytea, canonical_bytes bytea, request_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,request_payload_id)`; UQ `(organization_id,run_request_id)`; FK `dashboard`; the request digest's matrix-wide exact CHECK is explicitly `octet_length(request_idempotency_sha256) = 32`
- Extra indexes: none
- RLS/grants: `A:S,I`; `R:S`; `T:S,D`
- Sole writer(s): `request_agent_run`

#### 5. `agent_run_events`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, event_sequence bigint, event_id uuid, event_kind text, occurred_at timestamptz, prior_event_sequence bigint N, prior_event_sha256 bytea N, event_payload_id uuid N, event_sha256 bytea, claim_operation_kind text N, claim_request_id uuid N, claim_input_sha256 bytea N, claim_result_sha256 bytea N, claim_result_run_revision bigint N, claim_result_state text N, claim_result_lease_epoch bigint N, claim_result_attempt_token bytea N, claim_result_lease_expires_at timestamptz N, claim_result_policy_revision bigint N, claim_result_input_sha256 bytea N`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,event_sequence)`; UQ `(organization_id,event_id)`, `(organization_id,dashboard_id,run_id,event_sha256)`, and `(organization_id,dashboard_id,run_id,event_sequence,event_sha256)`; FK `run`; nullable FK `(organization_id,dashboard_id,event_payload_id)` to `agent_run_event_payloads(organization_id,dashboard_id,event_payload_id)` is `DEFERRABLE INITIALLY DEFERRED`. The fixed append/retention trigger requires all eleven claim columns NULL for every event except `lease_acquired|indeterminate_quarantined`; before purge those two events require nonnull operation kind/ID/input/result digests and common result revision/state/epoch/policy. `lease_acquired` requires kind `ordinary_claim` and nonnull 32-byte result token, expiry, and input SHA; `indeterminate_quarantined` requires kind `indeterminate_takeover` and those three fields NULL. All digest/token byte strings are exactly 32 bytes. The operation kind/ID and common result revision/state/epoch/policy are immutable forever; content purge alone transitions a claim event to the exact cleared form by nulling `claim_input_sha256`, `claim_result_sha256`, `claim_result_attempt_token`, and `claim_result_input_sha256` together, never restores them, and may not clear the ID/kind.
- Extra indexes: `(organization_id,dashboard_id,run_id,occurred_at,event_sequence)`; unique `(claim_request_id)` with exact predicate `claim_request_id IS NOT NULL`. The second index is database-global across ordinary and mixed-terminal claim kinds and survives content purge until final metadata age-out.
- RLS/grants: `A:S,I`; `R:S,I`; `T:S,I,U(retention/event clear),D`
- Sole writer(s): fixed event helper called only by request/cancel/operator/drain bodies

#### 6. `agent_run_event_payloads`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, event_payload_id uuid, event_id uuid, event_sequence bigint, content_nonce bytea, canonical_bytes bytea, payload_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,event_payload_id)`; UQ `(organization_id,event_id)` and `(organization_id,dashboard_id,run_id,event_sequence)`; FK `run`
- Extra indexes: none
- RLS/grants: `A:I`; `R:S(checkpoint_event_payload_columns),I`; `T:I,D`
- Sole writer(s): same fixed event helper; no direct function

#### 7. `agent_run_checkpoints`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, checkpoint_revision bigint, source_event_sequence bigint, source_event_sha256 bytea, state_sha256 bytea N, checkpoint_sha256 bytea, checkpoint_payload_id uuid N, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,checkpoint_revision)`; UQ `(organization_id,dashboard_id,run_id,source_event_sequence,source_event_sha256)`; FKs `run`, `event_with_hash`, and `checkpoint_payload`. The writer/trigger require nonnull `state_sha256` and payload pointer before purge, require both hashes to equal the referenced payload row, and admit only the fixed retention transition that clears `state_sha256` and `checkpoint_payload_id` together while preserving `checkpoint_sha256`.
- Extra indexes: `(organization_id,dashboard_id,run_id,checkpoint_revision DESC)`
- RLS/grants: `A:S`; `R:S,I`; `T:S,U(retention/checkpoint clear),D`
- Sole writer(s): `write_agent_run_checkpoint`

#### 8. `agent_run_checkpoint_payloads`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, checkpoint_payload_id uuid, checkpoint_revision bigint, content_nonce bytea, canonical_bytes bytea, state_sha256 bytea, checkpoint_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,checkpoint_payload_id)`; UQ `(organization_id,dashboard_id,run_id,checkpoint_revision)`; FK `run`; fixed trigger requires `state_sha256` to be the semantic row hash of `canonical_bytes` and `checkpoint_sha256` to be the nonce-bearing retained checkpoint-envelope digest over that state hash
- Extra indexes: none
- RLS/grants: `A:S`; `R:S,I`; `T:S,D`
- Sole writer(s): `write_agent_run_checkpoint`

#### 9. `agent_run_budget_counters`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, partition text, vector_field text, limit_units bigint, reserved_units bigint, used_units bigint, released_units bigint, updated_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,partition,vector_field)`; UQ `(organization_id,run_id,partition,vector_field)`; FK `run`; exact partition/field enum and conservation/nonnegative checks
- Extra indexes: `(organization_id,dashboard_id,run_id,partition)`
- RLS/grants: `A:S,I,U(reserved_units,used_units,released_units,updated_at)`; `R:S,U(same)`; `T:S,U(same),D`
- Sole writer(s): request seeds; cancel/operator/drain accounting only

#### 10. `agent_run_calculation_meters`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, meter_id uuid, graph_id uuid, result_id uuid, meter_vector dasher_run_api.calculation_meter_vector_v1, meter_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,meter_id)`; UQ `(organization_id,dashboard_id,run_id,graph_id)` and `(organization_id,dashboard_id,run_id,result_id)`; FKs `run`, `graph`, and `result`
- Extra indexes: `(organization_id,dashboard_id,run_id,created_at,meter_id)`
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_calculation_graph`

#### 11. `agent_run_attempts`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, attempt_id uuid, lease_epoch bigint, partition text, attempt_kind text, candidate_slot smallint N, retry_of_attempt_id uuid N, state text, request_payload_id uuid N, result_payload_id uuid N, reserved_vector dasher_run_api.attempt_resource_vector, actual_vector dasher_run_api.attempt_resource_vector N, used_vector dasher_run_api.attempt_resource_vector, released_vector dasher_run_api.attempt_resource_vector, outstanding_vector dasher_run_api.attempt_resource_vector, reserved_at timestamptz, dispatch_ready_at timestamptz N, dispatch_started_at timestamptz N, reconciled_at timestamptz N, terminal_reason_sha256 bytea N`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,attempt_id)`; UQ `(organization_id,run_id,attempt_id)`; FKs `run`, `attempt_request_payload`, `attempt_result_payload`, and nullable self FK `(organization_id,dashboard_id,run_id,retry_of_attempt_id)` to the attempt PK, with the two payload FKs `DEFERRABLE INITIALLY DEFERRED`; fixed trigger additionally requires the request pointer to name `payload_kind='request'` and result pointer to name `payload_kind='result'`. `candidate_slot` is nonnull in `1..2` exactly for generator attempts and equals a tagged request field; it is null for every other kind. `retry_of_attempt_id` is nonnull exactly for the one legal immediate planner/generator retry and names that same-kind/same-slot failed predecessor. State is exactly the section 3.4 union. `reserved_pre_dispatch` has all three later timestamps NULL; `dispatch_ready` has ready nonnull and start/reconciled NULL; `dispatch_started` has ready/start nonnull and reconciled NULL. Those three nonterminal states have null actual, zero used/released, and outstanding equal to reserved. Every terminal state has reconciled nonnull and preserves ready/start exactly when those milestones occurred; `dispatch_started_at` nonnull proves invocation authorization. `actual_vector` is nonnull exactly for `succeeded|refused_charged|failed_charged`; it is the typed vector constructed inside reconcile from valid `actual_accounting_bytes`, never the raw bytes themselves. No relation has an `actual_accounting_bytes` column. The fixed trigger enforces kind/outcome/result categorical equalities, componentwise bound, and exact used/released/outstanding equations from section 3.4 using only stored typed vectors. Release states use `used=0,released=reserved,outstanding=0`. Every indeterminate/charged-cancellation state has null actual and zero outstanding; for `candidates` it requires `used=0,released=reserved`, and for each other field it requires `used=reserved,released=0`, all componentwise within signed 64-bit.
- Extra indexes: `(organization_id,dashboard_id,run_id,state,attempt_id)`; unique `(organization_id,dashboard_id,run_id)` with exact predicate `state IN ('dispatch_ready','dispatch_started')`; unique `(organization_id,dashboard_id,run_id,candidate_slot)` with exact predicate `candidate_slot IS NOT NULL AND state IN ('reserved_pre_dispatch','dispatch_ready','dispatch_started')`
- RLS/grants: `A:S,U(cancel-set)`; `R:S,I,U(attempt-set)`; `T:S,U(cancel/retention-clear set),D`
- Sole writer(s): reserve/start/reconcile/release; cancel/drain/takeover; purge clear/age-out

#### 12. `agent_run_attempt_payloads`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, attempt_id uuid, payload_kind text, payload_id uuid, content_nonce bytea, canonical_bytes bytea, payload_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,attempt_id,payload_kind,payload_id)`; UQ `(organization_id,payload_id)`, `(organization_id,dashboard_id,run_id,attempt_id,payload_id)`, and `(organization_id,dashboard_id,run_id,attempt_id,payload_kind)`; FK `run`; CHECK `payload_kind IN ('request','result')`
- Extra indexes: none
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): reserve inserts request; determinate reconcile inserts result

#### 13. `agent_recorded_results`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, result_sequence bigint, result_id uuid, attempt_id uuid N, result_payload_id uuid N, replay_source_run_id uuid N, replay_source_result_sequence bigint N, replay_source_result_sha256 bytea N, result_kind text, canonical_bytes bytea, result_sha256 bytea, prior_result_head_sha256 bytea N, result_head_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,result_sequence)`; UQ `(organization_id,dashboard_id,run_id,result_id)`; FK `run`; nullable local-attempt FK `(organization_id,dashboard_id,run_id,attempt_id)` to the attempt PK and local-payload FK `(organization_id,dashboard_id,run_id,attempt_id,result_payload_id)` to the payload UQ; CHECK sequence 1..5 and exactly one origin: local attempt+payload with null replay fields, or all three replay fields with null local fields; replay origin is trigger-verified then copied and deliberately has no retention-extending source FK
- Extra indexes: unique `(organization_id,dashboard_id,run_id,attempt_id)` with exact predicate `attempt_id IS NOT NULL`; `(organization_id,dashboard_id,run_id,result_sequence,result_head_sha256)`
- RLS/grants: `A:S`; `R:S,I`; `T:S,D`
- Sole writer(s): determinate reconcile; replay consume creates a new run-local row bound to source

#### 14. `field_catalog_snapshots`

- Columns: `organization_id uuid, dashboard_id uuid, catalog_snapshot_id uuid, input_snapshot_id uuid, input_sha256 bytea, input_row_count bigint, catalog_sha256 bytea, evaluated_at timestamptz, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,catalog_snapshot_id)`; UQ `(organization_id,dashboard_id,catalog_sha256)`; FKs `dashboard` and `(organization_id,input_snapshot_id)` to `dasher.source_snapshots(organization_id,snapshot_id)`
- Extra indexes: `(organization_id,input_snapshot_id,evaluated_at DESC)`
- RLS/grants: `A:S`; `R:S`; `T:S,D`
- Sole writer(s): no production writer; migration-owner synthetic owner harness only

#### 15. `field_catalog_entries`

- Columns: `organization_id uuid, dashboard_id uuid, catalog_snapshot_id uuid, field_id uuid, source_path text, logical_name text, scalar_type text, nullable boolean, semantic_type text, unit text N, currency text N, grain text N, event_time_field_id uuid N, stable_key_ordinal integer N, max_value_bytes bigint, allowed_aggregations text[], allowed_dimensions uuid[], lineage_evidence_ids uuid[], entry_sha256 bytea`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,catalog_snapshot_id,field_id)`; FK `catalog`; nullable self FK `(organization_id,dashboard_id,catalog_snapshot_id,event_time_field_id)` to the PK; every lineage UUID validated by trigger against the same source snapshot/current authority
- Extra indexes: `(organization_id,dashboard_id,field_id)`
- RLS/grants: `A:S`; `R:S`; `T:S,D`
- Sole writer(s): no production writer; migration-owner synthetic owner harness only

#### 16. `metric_contract_versions`

- Columns: `organization_id uuid, dashboard_id uuid, contract_set_id uuid, contract_set_sha256 bytea, contract_id uuid, contract_version bigint, catalog_snapshot_id uuid, business_owner_membership_id uuid, data_owner_membership_id uuid, name text, definition text, measure_field_id uuid, aggregation text, denominator_contract_id uuid N, denominator_contract_version bigint N, value_type text, unit text N, currency text N, direction text, threshold text N, target text N, grain text, lag_millis bigint, freshness_slo_millis bigint, allowed_dimension_field_ids uuid[], calendar text, timezone text, lineage_evidence_ids uuid[], review_state text, contract_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,contract_id,contract_version)`; UQ `(organization_id,dashboard_id,contract_set_id,contract_id,contract_version)` and `(organization_id,dashboard_id,contract_sha256)`; every row in a set has one set hash; FK `catalog`; measure FK `(organization_id,dashboard_id,catalog_snapshot_id,measure_field_id)` to the field-entry PK; nullable denominator FK `(organization_id,dashboard_id,denominator_contract_id,denominator_contract_version)` to the contract PK with both fields null or both nonnull and a trigger requiring the same contract set; business/data owner FKs `(organization_id,business_owner_membership_id)` and `(organization_id,data_owner_membership_id)` to `dasher.memberships(organization_id,membership_id)`; dimension/lineage arrays and every type/unit/currency/direction/threshold/target/grain/lag/SLO/calendar/timezone/owner/review/aggregation cross-field rule use the exact section 5.1 immutable constraint trigger
- Extra indexes: `(organization_id,dashboard_id,contract_set_id,contract_id,contract_version)` and `(organization_id,dashboard_id,review_state,contract_id,contract_version DESC)`
- RLS/grants: `A:S`; `R:S`; `T:S,D`
- Sole writer(s): no production writer; migration-owner synthetic owner harness only

#### 17. `calculation_graphs`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, graph_id uuid, contract_set_id uuid, contract_id uuid, contract_version bigint, catalog_snapshot_id uuid, common_bundle_id uuid, freshness_classifier_node_id uuid N, freshness_input_node_id uuid N, freshness_source_row_id uuid N, graph_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,graph_id)`; UQ `(organization_id,dashboard_id,run_id,graph_sha256)`; FKs `run`, `contract_member`, `catalog`, and `common_bundle`; the three freshness columns are all NULL or all nonnull and are immutable derived projections rather than caller-selected FKs. The fixed INSERT trigger parses the graph/input and requires exact contract output/threshold/target node identities and catalog/dimension/group/aggregation/output/freshness/lineage conformance from section 5.1, including byte-exact rederivation of any nonnull classifier/input/source-row trio
- Extra indexes: `(organization_id,dashboard_id,run_id,contract_id,contract_version)`
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_calculation_graph`

#### 18. `calculation_results`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, result_id uuid, graph_id uuid, result_sha256 bytea, meter_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,result_id)`; UQ `(organization_id,dashboard_id,run_id,graph_id)` and `(organization_id,dashboard_id,run_id,result_sha256)`; FK `graph`; one fixed `DEFERRABLE INITIALLY DEFERRED` result constraint trigger re-parses graph/result and, after the writer's graph -> result -> meter INSERT order, requires the exact unique meter row plus all result/output/hash/meter conformance from section 5.1
- Extra indexes: `(organization_id,dashboard_id,run_id,created_at,result_id)`
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_calculation_graph`

#### 19. `briefs`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, brief_id uuid, common_bundle_id uuid, brief_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,brief_id)`; UQ `(organization_id,dashboard_id,run_id)` and `(organization_id,dashboard_id,run_id,brief_sha256)`; FKs `run`, `common_bundle`
- Extra indexes: none
- RLS/grants: `A:S`; `R:S,I`; `T:S,D`
- Sole writer(s): Suggest `commit_agent_brief`; replay `clone_claimed_replay_prerequisites`

#### 20. `candidate_comparison_bundles`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, bundle_id uuid, source_snapshot_id uuid, evidence_count bigint, bundle_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,bundle_id)`; UQ `(organization_id,dashboard_id,run_id)` and `(organization_id,dashboard_id,run_id,bundle_sha256)`; FKs `run`, `source_snapshot`; `evidence_count` is `1..256`, equals the canonical bundle `entries.length`, and a fixed deferred constraint trigger requires exactly that many child membership rows with the identical entry set before commit. No later child INSERT is admitted once the bundle-commit/clone statement phase ends.
- Extra indexes: none
- RLS/grants: `A:S`; `R:S,I,U(lock-only bundle key)`; `T:S,D`. The run UPDATE grant is exactly `(organization_id,dashboard_id,run_id,bundle_id)` and exists only for the named lock-only policy; the immutable guard rejects actual/no-op UPDATE.
- Sole writer(s): Suggest `commit_common_evidence_bundle`; replay `clone_claimed_replay_prerequisites`

#### 21. `candidate_comparison_bundle_evidence`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, bundle_id uuid, evidence_id uuid, source_snapshot_id uuid, evidence_sha256 bytea, source_sha256 bytea, freshness text, observed_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,bundle_id,evidence_id)`; FK `bundle`; FK `(organization_id,evidence_id)` to `dasher.evidence_records(organization_id,evidence_id)`; FK `(organization_id,source_snapshot_id)` to `dasher.source_snapshots(organization_id,snapshot_id)`; fixed trigger requires the evidence row's snapshot ID and both stored hashes to equal the row-locked source/evidence predecessors. Existing membership rows are immutable nonlocking dependencies under the locked run and bundle header contract in sections 4.4/4.6.
- Extra indexes: `(organization_id,evidence_id,bundle_id)`
- RLS/grants: `A:S`; `R:S,I`; `T:S,D`
- Sole writer(s): Suggest `commit_common_evidence_bundle`; replay `clone_claimed_replay_prerequisites`

#### 22. `agent_candidates`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, brief_id uuid, common_bundle_id uuid, source_result_id uuid, source_result_sha256 bytea, precommit_validation_sha256 bytea, candidate_spec_sha256 bytea, material_claim_count bigint, material_claim_set_sha256 bytea, validation_state text, review_state text, manifest_sha256 bytea N, rank integer N, selected boolean, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,candidate_id)`; UQ `(organization_id,dashboard_id,run_id,candidate_spec_sha256)`; FKs `run`, `brief`, `common_bundle`, `recorded_result`; material count is `1..64`; rank and selected uniqueness are the partial indexes below
- Extra indexes: `(organization_id,dashboard_id,run_id,validation_state,review_state,candidate_id)`; unique `(organization_id,dashboard_id,run_id,rank)` with exact predicate `rank IS NOT NULL`; unique `(organization_id,dashboard_id,run_id)` with exact predicate `selected IS TRUE`; unique `(organization_id,dashboard_id,run_id,source_result_id)`. The last index makes a valid reconciled candidate-producing result materializable as at most one durable candidate and is independent of categorical accounting.
- RLS/grants: `A:S`; `R:S,I,U(validation/review/manifest/rank/selected set)`; `T:S,D`
- Sole writer(s): candidate/validation/manifest/ranking functions only

#### 23. `agent_candidate_payloads`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, canonical_bytes bytea, candidate_spec_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,candidate_id)`; FK `candidate`
- Extra indexes: none
- RLS/grants: `A:S`; `R:S,I`; `T:S,D`
- Sole writer(s): `commit_agent_candidate`

#### 24. `agent_validation_findings`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, finding_count integer, validation_state text, findings_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,candidate_id)`; FK `candidate`; fixed trigger validates every calculation/evidence subject ID+hash against the same run graph/result or common-bundle membership before INSERT
- Extra indexes: `(organization_id,dashboard_id,run_id,validation_state,candidate_id)`
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_agent_validation_findings`

#### 25. `claims`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, claim_id uuid, json_pointer text, assertion_sha256 bytea, label text, statement text, salience text, evidence_state text, calculation_result_id uuid N, calculation_output_identity_kind text N, calculation_output_node_id uuid N, calculation_output_sha256 bytea N, calculation_output_row_id uuid N, calculation_output_field_id uuid N, calculation_output_value_sha256 bytea N, claim_set_sha256 bytea, claim_sha256 bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,candidate_id,claim_id)`; UQ `(organization_id,dashboard_id,run_id,candidate_id,json_pointer)`; FK `candidate` and nullable FK `(organization_id,dashboard_id,run_id,calculation_result_id)` to the calculation-result PK. A non-`calculated` label requires all seven calculation identity columns NULL. A `calculated` label requires a successful exact result plus nonnull identity kind, node, and output digest; `output` requires row/field/value NULL, `scalar_row` requires row/value nonnull and field NULL, and `rowset_cell` requires row/field/value all nonnull. Identity kind is only that three-literal union; both digests are exactly 32 bytes. The sole writer inserts one candidate's complete claim array in one statement; a fixed `AFTER INSERT ... REFERENCING NEW TABLE` statement trigger re-extracts candidate/result bytes and requires claim ID/pointer/assertion hash/allowed label, exact output/value hash and row/cell membership, the server-side subtree mapping below, and complete claim-array equality before the statement returns. A fixed `DEFERRABLE INITIALLY DEFERRED` claim constraint trigger reassembles the final bounded Claims plus zero-or-more `claim_evidence` edges and requires every claim/edge/claim-set hash, including the zero-edge case, before commit
- Extra indexes: `(organization_id,dashboard_id,run_id,candidate_id,salience,evidence_state,claim_id)` and `(organization_id,dashboard_id,run_id,calculation_result_id,calculation_output_node_id,calculation_output_row_id,calculation_output_field_id)` with exact predicate `calculation_result_id IS NOT NULL`
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_candidate_claims`

#### 26. `claim_evidence`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, claim_id uuid, bundle_id uuid, evidence_id uuid, relation text`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,candidate_id,claim_id,bundle_id,evidence_id,relation)`; FK `(organization_id,dashboard_id,run_id,candidate_id,claim_id)` to the claim PK and FK `(organization_id,dashboard_id,run_id,bundle_id,evidence_id)` to the bundle-evidence PK
- Extra indexes: `(organization_id,dashboard_id,run_id,candidate_id,relation,evidence_id)`
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_candidate_claims`

#### 27. `candidate_evidence_manifests`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, candidate_id uuid, reviewer_result_id uuid, reviewer_result_sha256 bytea, manifest_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id,candidate_id)`; UQ `(organization_id,dashboard_id,run_id,manifest_sha256)`; FKs `candidate` and reviewer `recorded_result`; fixed trigger requires the result kind to be `reviewer_verdict_set`, its stored SHA to equal `reviewer_result_sha256`, and its candidate/validation/claim aggregate hashes to equal the current frozen rows
- Extra indexes: none
- RLS/grants: `A:S`; `R:S,I`; `T:S,D`
- Sole writer(s): `commit_candidate_manifest`

#### 28. `run_abstentions`

- Columns: `organization_id uuid, dashboard_id uuid, run_id uuid, abstention_id uuid, abstention_sha256 bytea, canonical_bytes bytea, created_at timestamptz`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,run_id)`; UQ `(organization_id,abstention_id)` and `(organization_id,dashboard_id,run_id,abstention_sha256)`; FK `run`
- Extra indexes: none
- RLS/grants: `R:S,I`; `T:S,D`
- Sole writer(s): `commit_run_abstention`

#### 29. `dashboard_agent_drain_proofs`

- Columns: `organization_id uuid, dashboard_id uuid, proof_id uuid, lifecycle_revision bigint, cleanup_attempt_id uuid, cleanup_lease_owner text, cleanup_lease_expires_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, pre_drain_run_count bigint, cancelled_run_count bigint, released_attempt_count bigint, charged_attempt_count bigint, remaining_nonterminal_run_count bigint, remaining_claimed_run_count bigint, first_event_run_id uuid N, first_event_sequence bigint N, first_event_sha256 bytea N, last_event_run_id uuid N, last_event_sequence bigint N, last_event_sha256 bytea N, event_count bigint, event_range_sha256 bytea, generated_at timestamptz, drain_request_proof_sha256 bytea, drain_proof_sha256 bytea`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,proof_id)`; UQ `(organization_id,dashboard_id,proof_id,drain_proof_sha256)`, `(organization_id,dashboard_id,drain_request_proof_sha256)`, and `(organization_id,dashboard_id,drain_proof_sha256)`; `proof_id = cleanup_attempt_id`; all counts are nonnegative and both remaining counts are zero. `charged_attempt_count` counts dispatched indeterminate settlements whose noncandidate fields are charged and candidate field is released; it is a disposition count, not a candidate-used count. `event_count=0` iff all six first/last event boundary fields are NULL, otherwise all are nonnull and the first `(run_id,sequence)` is not after the last; FK `dashboard` only; cleanup attempt/lease/principal values are immutable proof fields without retention-blocking FKs
- Extra indexes: `(organization_id,dashboard_id,generated_at DESC,proof_id)`
- RLS/grants: `T:S,I,D`
- Sole writer(s): `drain_dashboard_agent_runs`; final age-out deletes

#### 30. `dashboard_agent_drain_proof_consumptions`

- Columns: `organization_id uuid, dashboard_id uuid, proof_id uuid, lifecycle_revision bigint, drain_proof_sha256 bytea, preceding_cleanup_attempt_id uuid, preceding_cleanup_lease_owner text, preceding_cleanup_lease_expires_at timestamptz, new_cleanup_lease_owner text, new_cleanup_lease_expires_at timestamptz, claim_event_and_audit_id uuid, consumed_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, consumption_sha256 bytea`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,proof_id)`; UQ `(organization_id,dashboard_id,claim_event_and_audit_id)` and `(organization_id,dashboard_id,consumption_sha256)`; composite FK `(organization_id,dashboard_id,proof_id,drain_proof_sha256)` to the exact drain-proof UQ, `ON UPDATE RESTRICT ON DELETE RESTRICT NOT DEFERRABLE INITIALLY IMMEDIATE`; the fixed writer requires the preceding attempt/lease fields equal the locked proof and successful attempt and requires `new_cleanup_lease_expires_at > consumed_at`
- Extra indexes: `(organization_id,dashboard_id,consumed_at DESC)`
- RLS/grants: `T:S,I,D`
- Sole writer(s): replaced `claim_dashboard_cleanup`; final age-out deletes

#### 31. `dashboard_agent_run_age_out_proofs`

- Columns: `organization_id uuid, dashboard_id uuid, age_out_operation_id uuid, lifecycle_revision bigint, source_purge_proof_sha256 bytea, backup_deletion_proof_sha256 bytea, eligible_run_count bigint, deleted_run_count bigint, deleted_event_count bigint, deleted_checkpoint_count bigint, deleted_attempt_count bigint, deleted_counter_count bigint, deleted_drain_proof_consumption_count bigint, deleted_drain_proof_count bigint, retained_chain_head_sha256 bytea, retained_event_count bigint, deleted_at timestamptz, retention_principal_id uuid, retention_principal_revision bigint, age_out_proof_sha256 bytea`
- Keys/FKs/checks: PK `(organization_id,dashboard_id,age_out_operation_id)`; UQ `(organization_id,dashboard_id,lifecycle_revision)` and `(organization_id,dashboard_id,age_out_proof_sha256)`; deliberately no content/dashboard FK; every count is nonnegative, `eligible_run_count = deleted_run_count`, `retained_event_count = deleted_event_count`, and `source_purge_proof_sha256`, `backup_deletion_proof_sha256`, `age_out_proof_sha256`, and `retained_chain_head_sha256` are exactly 32 bytes. `retained_chain_head_sha256` is always nonnull and is exactly the section 4.5 chain-set digest, including for zero eligible runs; no null or sentinel is admitted.
- Extra indexes: `(organization_id,dashboard_id,deleted_at DESC)`
- RLS/grants: `T:S,I`; no UPDATE/DELETE
- Sole writer(s): `age_out_dashboard_agent_run_metadata`

For row 26 the exact PK column sequence is `(organization_id,dashboard_id,run_id,
candidate_id,claim_id,bundle_id,evidence_id,relation)`. Arrays in rows 15/16 are
validated by immutable constraint triggers because PostgreSQL cannot express an array
of composite FKs; those triggers lock each referenced row in the global order and are
part of the FK/catalog fixture. No trigger is permission to add an unlisted column or
writer. Rows 14–16 have no production INSERT/UPDATE/DELETE grant or policy; the owner
harness is test-only and canonical production migration data is empty as stated above.

Every phase-7 schema, table, composite/enum type, constraint, index, and trigger
function is owned by the database migration owner. Runtime definers own only their
fixed API functions; no runtime role owns data. UUIDs and locked per-run sequence
fields mean `0007` creates no sequence or identity object, and catalog tests prove
none exists. `dasher_run_api` is migration-owner-owned; predecessor `dasher`,
`dasher_api`, `dasher_private`, existing relations/types, and their owners remain
unchanged. Tenant API functions remain owned by `dasher_security_definer`; operator
functions by `dasher_run_definer`; retention additions/replacements by
`dasher_retention_definer`. Trigger helpers are migration-owner-owned fixed-body
functions with runtime `EXECUTE` revoked. A replacement preserves every predecessor
relation/type/function owner except for the already fixed definer-owned API function.

`field_catalog_snapshots`/entries and `metric_contract_versions` have no app or run-
operator INSERT function. Canonical production `0007` contains no catalog/contract
data. PostgreSQL tests insert exact synthetic reviewed rows through the owner harness
and remove them during cleanup; a run without a current reviewed catalog/contract
can only commit typed `missing_governed_metric`/`unsupported_capability` abstention.
Any real catalog/contract administration is separately planned. `request_agent_run`
may bind only an already-existing exact catalog/contract set under locks; it cannot
invent or edit governance.

Use UUIDs supplied only after strict application validation or generated by fixed
trusted functions as specified in the reviewed function matrix below. All
timestamps used for ordering, lease, budget, and terminal decisions are database-
controlled. JSONB is permitted only for closed canonical payload/AST/spec/
checkpoint/result values validated against a named schema/version and bounded by
bytes; there is no generic operation envelope or caller-selected SQL identifier.

All tenant-derived bytes and semantic text are separated from the retained run
header/hash ledger. This includes event/checkpoint/attempt/result payloads, field
labels, calculation AST/results, candidate specs, comparison-bundle membership,
Brief bodies, claim statements/edges/manifests, abstention explanations, and
recorded fake results. Retained opaque IDs, revisions, counters, timestamps, and
cryptographic hashes are governed, potentially linkable metadata—not anonymous or
non-sensitive data. They remain behind the same tenant/retention authority, legal-
hold, export/audit, and non-leaking read boundaries. A retained header never stores
a bare digest of low-entropy semantic content. Its migration-versioned domain-
separated envelope includes a database-generated 32-byte random nonce stored only
with the deletable payload; purge deletes that nonce and any bare content-address
hash, leaving a governed chain value without a post-purge dictionary-confirmation
oracle. This introduces no provider credential or deployable key. After purge the
stored chain adjacency/count can be checked, but semantic payload hashes cannot be
recomputed—and the product must say so.

The phase-7 purge/FK disposition is fixed:

| Relation class                                                                                                            | Dashboard content purge                                                                                                                                                                                                                                                                                                       | FK rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Final age-out                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_run_policy_revisions`, `run_service_principal_allowlist`                                                           | Not dashboard-scoped; preserve immutable policy/principal history.                                                                                                                                                                                                                                                            | No FK to candidate/source/evidence payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Governed by the separately accepted policy/principal history lifecycle.                                                                                                   |
| `agent_runs`, event/checkpoint/attempt headers, budget counters, `dashboard_agent_drain_proofs`, drain-proof consumptions | Terminalize/clean; clear every payload pointer/FK/bare semantic hash, checkpoint state digest, and claim result secret/digests while retaining only opaque governed metadata plus nonce-enveloped chain adjacency, globally unique claim kind/ID, the tenant-cancel operation/result commitments, counts, and deletion proof. | May retain composite FK only to organization, cleaned dashboard, tombstone, and consumption-to-drain-proof parent. Source/evidence/version/candidate/replay IDs, purpose, candidate-set/replay/reason hashes, non-cancel terminal operation hashes, the terminal/ordinary claim input and result digests, checkpoint state digest, claim token/input SHA, and payload IDs are NULL after content purge. Claim operation kind/ID, terminal operation kind/ID, and the six exact tenant-cancel operation/result fields remain opaque governed metadata until age-out. | Delete through fixed retention API at `purged_at + 365 days`, unless an active hold exists.                                                                               |
| Request/event/checkpoint/attempt/result payloads and candidate payloads                                                   | Physically delete before source/evidence purge.                                                                                                                                                                                                                                                                               | No cascade substitutes for explicit proof-bearing deletion; exact column updates first null the header payload pointers.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Immediate content purge.                                                                                                                                                  |
| Field-catalog snapshots/entries, graphs/results/calculation meters, metric contracts                                      | Physically delete in child-before-parent ID order.                                                                                                                                                                                                                                                                            | No retained-header FK; prove no FK blocker by catalog and owner-visible counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Immediate content purge.                                                                                                                                                  |
| Comparison bundles/membership, Briefs, Claims, claim edges, manifests, abstentions, candidates, recorded results          | Physically delete in child-before-parent ID order.                                                                                                                                                                                                                                                                            | No retained-header FK; candidate/common-bundle/evidence links are all absent before source/evidence deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Immediate content purge.                                                                                                                                                  |
| `agent_validation_findings`                                                                                               | Physically delete before candidate payload/candidate deletion.                                                                                                                                                                                                                                                                | Composite run/candidate FK only; no retained header or source/evidence FK survives content purge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Immediate content purge.                                                                                                                                                  |
| `dashboard_agent_run_age_out_proofs`                                                                                      | Not present until final metadata age-out; preserve as immutable deletion proof.                                                                                                                                                                                                                                               | No FK to run/event/checkpoint/attempt/dashboard content rows and no FK that can block their deletion; opaque organization/dashboard/lifecycle IDs are proof fields, not foreign keys.                                                                                                                                                                                                                                                                                                                                                                               | Retained under a separately accepted proof-record lifecycle; no Task 9 DELETE path. Active legal hold can only lengthen retention and never deletes or weakens the proof. |

Every immutable relation rejects UPDATE/DELETE for runtime roles. Mutable fields on
`agent_runs`, budget counters, and attempts use exact transition triggers and
column-level grants; no runtime role receives table-wide UPDATE or DELETE.

### 4.3 Canonical semantic and proof encoding

Every semantic writer accepts bytes already parsed as a strict JSON object and
re-encodes them before comparison/storage. `canonical-json-v1` means UTF-8 RFC 8785
JCS after requiring every string to be NFC; rejecting duplicate/unknown keys,
unpaired surrogates, control characters outside JSON escapes, and negative zero;
encoding UUIDs as lowercase hyphenated text and SHA-256 as 64 lowercase hex
characters. Every semantic signed-64 value—including revisions, epochs, sequence
numbers, counters, row/cardinality/count values, resource-vector and meter fields,
millisecond/microsecond durations, decimal scales, and proof-mirror timestamps—is a
JSON string in exact tagged form `i64:<decimal>`, where decimal is `0` or
`-?[1-9][0-9]*`, parses to `-9223372036854775808..9223372036854775807`, and uses no
plus sign or leading zero. Nonnegative/positive schema constraints apply after that
lossless parse. TypeScript parses these fields directly to `bigint`; PostgreSQL first
parses to `numeric`, range-checks, and only then casts to `bigint`. No such value is
ever converted through JavaScript `number` or emitted as a JSON number.
Semantic instants remain exact UTC RFC 3339 strings with six fractional digits as
named by each schema, never JSON epoch numbers; parsing must round-trip to PostgreSQL
microsecond precision and canonical-binary proofs encode that same instant as checked
signed-64 epoch microseconds. Durations are tagged `i64` in JSON and `bigint` in SQL.

JSON number tokens are forbidden in every new Task 9 schema except an explicitly
named `jcs-binary64` field inherited inside `dashboard-spec-v1` (latitude, longitude,
stage, streamflow, and trend point value) or a schema field explicitly declared a
bounded safe integer. A `jcs-binary64` value must be finite, have absolute value at
most `9007199254740991`, not be negative zero, and its input token must equal RFC
8785's shortest ECMAScript binary64 rendering; bounded safe integers are additionally
integral and in `-9007199254740991..9007199254740991`. Exponent notation therefore
exists only when that JCS rendering itself requires it for a named binary64 field.
This closed exception preserves the already frozen DashboardSpec 1.0/1.1 number
contract without making counters lossy. Unless a field below is explicitly nullable,
null is forbidden.
Arrays are unique and sorted by the stated tuple using unsigned UTF-8 byte order.
The semantic row hash is SHA-256 of the listed ASCII domain plus NUL, unsigned
big-endian 32-bit canonical-byte length, and canonical bytes. For a request, event,
checkpoint, or attempt payload whose header survives content purge, the header-visible
hash is instead SHA-256 over `dasher.retained-payload-envelope.v1\0`, content-kind
text, the payload's 32-byte database-generated nonce as a byte string, and the
semantic row hash as a byte string. The payload row stores nonce, canonical bytes,
semantic hash, and envelope hash when its exact matrix row lists both. For checkpoints
the names are deliberately non-aliasing: `state_sha256` is the semantic row hash of
the exact `agent-run-checkpoint-v1` reducer-state bytes, while
`checkpoint_sha256` is the retained envelope using exact content-kind text
`agent-run-checkpoint-v1`. The header copies both before purge; purge clears
`state_sha256` with the payload pointer and deletes the payload/nonce, while the
nonce-bearing `checkpoint_sha256` remains. No hash preimage contains the other hash
except that one directed envelope edge from state digest to envelope digest. Any
other deterministic semantic hash needed inside a payload remains inside its deleted
canonical bytes. Thus retained event/checkpoint chain values cannot confirm a guessed
low-entropy payload after nonce deletion. A semantic writer with an explicit
stable content/operation ID must replay the same ID plus canonical bytes/hash as a
no-op returning the original typed row; ID reuse with drift denies. Transition writers
without such an ID are not covered by that rule and use only their function-specific
idempotency contract. The three lease-clearing finalization writers below carry a
stable operation UUID and perform exact replay lookup after current principal/resource
authorization but before stale-lease rejection. Any hash mismatch, noncanonical
encoding, duplicate, order drift, count/byte overflow, unknown key, or schema/version
drift denies before mutation.

Non-JSON proof preimages use `canonical-binary-v1`: UUID network bytes; signed
64-bit integers in big-endian two's-complement; counts as nonnegative signed 64-bit;
timestamps as signed-64-bit microseconds since the Unix epoch UTC; booleans as one
byte `00|01`; byte strings as unsigned-32-bit length plus bytes; and text as
unsigned-32-bit UTF-8 length plus NFC bytes. Required values have no null encoding;
an explicitly nullable value is prefixed `00`, while a present value is prefixed
`01` and its encoding. A registry value named “SHA byte string” uses the length-
prefixed byte-string encoding; a value named “SHA bytes” is an exact fixed-width raw
32-byte digest with no length prefix. Every registry row below deliberately uses one
of those two spellings. Every proof begins with its exact ASCII domain plus NUL.

The semantic payload schemas are closed. In every named schema below whose exact
field list includes `schema`, that field is the exact lowercase literal used as the
schema's displayed name; an omitted, aliased, or differently cased version is
unknown. The inherited DashboardSpec instead keeps its exact `schemaVersion`
discriminator:

`canonical-input-table-v1`, domain `dasher.canonical-input-table.v1`, is the only
Task 9 calculation input representation. Its exact top-level fields are `schema`,
`input_snapshot_id`, `row_count`, `fields`, and `rows`; it is 1..1,048,576 canonical bytes, has 1..512
field entries, and has 0..10,000 rows. `row_count` is tagged `i64` and equals
`rows.length`. A field has exactly `field_id`, `scalar_type`, `nullable`, and
`stable_key_ordinal`; `scalar_type` is
`boolean|integer|decimal|text|date|timestamp`, and the ordinal is null or a tagged
nonnegative `i64`. Fields sort uniquely by UUID. Nonnull stable-key ordinals are
unique and exactly `i64:0..i64:k-1`, with at least one, and thereby define the
ordered stable-key field list.

Each row has exactly `row_id` and `values`. `values` contains exactly one entry for
every field, sorted by field UUID; an entry has exactly `field_id`, `state`, `type`,
and `value`, with type equal to the field scalar type. State is
`present|null|missing|unavailable`; non-present states require JSON null and `null`
is permitted only for a nullable field. Present boolean is a JSON boolean; integer
is a tagged `i64`; decimal is exactly `{coefficient,scale}` with canonical signed
decimal coefficient text (zero exactly `0`, at most 38 digits excluding sign) and a
tagged `i64:0..i64:18` scale. Decimal pairs are reduced by stripping coefficient
trailing zeroes while scale is positive, and zero requires scale `i64:0`; an
equivalent unreduced spelling is noncanonical. Text is NFC and its complete canonical
JCS string token, including quotes and required escapes, is no longer than the
catalog's `max_value_bytes`; date is `YYYY-MM-DD`; timestamp is UTC RFC 3339 with exactly six
fractional digits. Every stable-key value must be present.

For each row, encode the stable-key field count and then each stable-key field UUID
and typed tagged value in ordinal order with `canonical-binary-v1`. The typed value
is exact: one type byte (`boolean=00,integer=01,decimal=02,text=03,date=04,
timestamp=05`), one state byte (`present=00,null=01,missing=02,unavailable=03`), and
no value bytes for a non-present state; a present value is boolean byte `00|01`,
signed-64 integer, signed-128 two's-complement decimal coefficient followed by one
unsigned scale byte, unsigned-32 text byte length plus NFC UTF-8, signed-32 days from
1970-01-01, or signed-64 UTC epoch microseconds, respectively. Decimal coefficients
must fit signed-128 and every timestamp must exactly round-trip the JSON timestamp.
The row's sort
key is that complete byte string. `row_id` is the deterministic UUIDv8 defined below
over domain `dasher.input-row-id.v1`, the input snapshot UUID, and that byte string.
Rows sort by unsigned bytewise sort key then UUID; duplicate sort keys/row IDs deny.
The UUIDv8 rule used everywhere in this plan is: SHA-256 the listed domain/preimage,
take digest bytes 0..15, set the high nibble of byte 6 to `8`, set the high two bits
of byte 8 to `10`, and render those 16 bytes as lowercase RFC 9562 UUID text.

Task 9 does not change how `source_snapshots` are created. A snapshot is merely
eligible for Task 9 when `source_kind = 'synthetic_fixture'`, its existing
`canonical_bytes` are byte-for-byte the schema above, and its existing
`content_sha256` equals the canonical row hash
SHA-256(`dasher.canonical-input-table.v1\0`, unsigned-32 byte length, exact bytes).
At `request_agent_run`, the fixed writer locks that existing row, validates and
re-encodes it, requires `expected_input_sha256 = content_sha256`, and constructs the
nested request `input_table` from that parsed value; the nested object's independent
JCS encoding must equal those exact source bytes and its input snapshot ID must equal
the locked row. The writer also constructs and requires the nested
field catalog's field IDs/types/nullability/stable ordinals, input ID/hash, and row
count to equal it. It copies the exact input object into the immutable request
payload; it adds no source column, route, storage, or ingestion path. Every claimed
input read repeats these equalities and returns the exact source/request bytes as
`canonical_input_bytes`. The calculation parser accepts only those returned bytes;
graph `input_snapshot_id/input_sha256`, static bounds, runtime rows, meters, and
execution all use that one parsed snapshot. Any source/request/catalog/claimed-byte/
row-count/hash mismatch denies before mutation.

1. `common-evidence-bundle-v1`, domain
   `dasher.common-evidence-bundle.v1`: exact fields `schema`, `bundle_id`,
   `source_snapshot_id`, and `entries`. There are 1..256 entries and at most
   262,144 canonical bytes. An entry has exactly `evidence_id`, `evidence_sha256`,
   `source_snapshot_id`, `source_sha256`, `freshness` (`current|stale`), and
   `observed_at` (UTC RFC 3339 with exactly six fractional digits). Entries sort by
   evidence UUID and are unique by evidence and source IDs. Every row must be
   current-authority visible and match its composite organization/snapshot FK. The
   entry evidence-ID set is exactly the sorted union of all lineage evidence IDs in
   the request's frozen field catalog and metric-contract set, with no caller/model
   omission or extra; every entry's source snapshot is the request input snapshot.
   When an entry is the graph's typed-value synthetic FX evidence, its body/row/hash/direction/
   observed-time equality and `freshness = current` are additionally derived by the
   exact `iso4217-task9-v1` contract in section 5.1; the bundle label cannot override
   the evaluation-time cutoff.
   A union over 256 cannot be truncated and requires a typed `unsupported_capability`
   abstention before planner dispatch.
2. `agent-brief-v1`, domain `dasher.agent-brief.v1`: exact fields `schema`,
   `brief_id`, `bundle_id`, `goal`, `metric_contract_ids`, `dimension_field_ids`,
   `requested_views`, `constraints`, `specialist_required`, and
   `candidate_target_count`. `goal` is 1..1,000 UTF-8 bytes;
   metric IDs are 1..16 sorted unique UUIDs; dimensions are 0..32 sorted unique
   governed field UUIDs; views are 1..8 unique values in enum order
   `metric|table|bar|line|scatter`; constraints are 0..16 sorted unique strings of
   1..256 UTF-8 bytes. `specialist_required` is a JSON boolean and
   `candidate_target_count` is exactly tagged `i64:1` or `i64:2`. The total is at most
   32,768 canonical bytes and every ID is
   locked/current under the run's catalog/contract/bundle.
3. `agent-validation-findings-v1`, domain
   `dasher.agent-validation-findings.v1`: one immutable
   `agent_validation_findings` set row per candidate, not one free-form row per
   finding. Exact top-level fields are `schema`, `candidate_id`,
   `candidate_spec_sha256`, and `findings`; the row also stores derived
   `finding_count`, `validation_state`, and set hash. There are 0..64 findings and
   at most 65,536 canonical bytes. Each finding has exactly `kind`, `severity`,
   `subject_kind`, `subject_id`, `json_pointer`, `related_sha256`. `kind` is one of
   `schema_violation|unsupported_component|unknown_field|metric_contract_mismatch|
calculation_error|evidence_incomplete|policy_violation`;
   `severity` is `error|warning`; `subject_kind` is exactly
   `candidate|calculation|evidence`; `json_pointer` is an RFC 6901 pointer of 0..256
   ASCII bytes. Candidate subjects require null `subject_id`/`related_sha256`;
   calculation subjects require the exact current-run `calculation_result_id` and
   result SHA; evidence subjects require an evidence ID and evidence SHA from the
   run's frozen common bundle. Claims/manifests do not yet exist at this lifecycle
   point and are forbidden subjects. The fixed writer locks/reads those calculation
   and bundle predecessors and rejects orphan/cross-run IDs. Findings sort and
   deduplicate by `(severity error-before-warning, kind enum order, subject_kind enum
order, subject_id null-before-UUID, json_pointer, related_sha256)`. Empty or
   warning-only sets derive `passed` or `passed_with_warnings`; any error derives
   `failed`.
4. `candidate-claims-v1`, domain `dasher.candidate-claims.v1`: exact fields
   `schema`, `candidate_id`, `candidate_spec_sha256`,
   `material_claim_set_sha256`, `claims`, `edges`; 1..64 claims, 0..256 edges, at
   most 262,144 canonical bytes. A claim has exactly `claim_id`, `json_pointer`,
   `assertion_sha256`, `label`
   (`observed|calculated|hypothesis|recommendation|unknown|blocked`), `statement`,
   `salience` (`high|normal`), `evidence_state`
   (`complete|partial|contradicted|stale|unsupported`),
   `calculation_result_id`, `calculation_output_identity_kind`,
   `calculation_output_node_id`, `calculation_output_sha256`,
   `calculation_output_row_id`, `calculation_output_field_id`, and
   `calculation_output_value_sha256`.
   `json_pointer` is 1..512 ASCII bytes and `statement` is not model prose: it must
   equal the exact ASCII concatenation `json_pointer`, one space, literal
   `sha256:`, and lowercase `assertion_sha256` hex. Claim ID/pointer/assertion hash
   and the complete claim set must equal the trusted material-assertion extraction
   below; salience is display metadata and cannot add, remove, or relax coverage.
   The seven calculation fields follow relation row 25 exactly. For `calculated`,
   the result must be the same-run successful `calculation-result-v1`; its output
   array must contain the named node exactly once and its exact
   `dasher.calculation-output.v1` row hash must equal the supplied output digest.
   `output` binds that whole output. `scalar_row` binds one named scalar row;
   `rowset_cell` binds one named row and field cell. The latter two recompute
   `calculation_output_value_sha256` by the exact output-value preimage below and
   require the runtime value state to be `present|stale`; a null, missing, or
   unavailable value cannot prove a calculated material assertion. All calculation
   fields are null for every other label. An edge has exactly `claim_id`,
   `evidence_id`, and `relation` (`supports|contradicts|context`); it must reference
   the same candidate's claim and common bundle. Claims sort by claim UUID; edges by
   `(claim_id,evidence_id,relation-enum)`, with duplicates forbidden. `complete`
   requires at least one current `supports` edge; `contradicted` requires at least
   one `contradicts` edge; `hypothesis|recommendation|unknown|blocked` cannot claim
   `complete`. For ranking eligibility every observed/calculated material claim must
   be `complete` with a current support edge, no material claim may be
   `contradicted`, and every other label must truthfully retain its allowed
   non-complete state. `high|normal` never changes those rules.
   `claim_set_sha256` is the canonical semantic row hash of the entire
   `candidate-claims-v1` bytes. Each `claim_sha256` is the row hash with domain
   `dasher.candidate-claim.v1` over all fourteen exact claim object fields in their
   listed order; edges are outside that per-claim hash but inside the set hash.
5. A reviewer attempt's determinate result kind is exactly
   `reviewer-verdict-set-v1`, domain `dasher.reviewer-verdict-set.v1`, with exact
   fields `schema`, `candidate_set_sha256`, `candidate_validation_set_sha256`,
   `candidate_claim_sets_sha256`, and `verdicts`. There are one or two
   verdict entries, sorted/unique by candidate UUID, and their IDs must equal the
   frozen candidate set; both aggregate hashes must equal the immutable finding/claim
   rows defined below and bound in the reviewer request. Each entry has exactly `candidate_id`,
   `candidate_spec_sha256`, `verdict`, and `reason_codes`. Verdict is
   `preferred|acceptable|reject`; there are 0..8 sorted unique reasons from
   `evidence_gap|calculation_error|policy_violation|misleading_encoding|
unsupported_claim|stale_source|inconsistent_bundle|invalid_spec`. Preferred or
   acceptable forbids `policy_violation|misleading_encoding|invalid_spec`; reject
   requires at least one reason. The set is at most 16,384 bytes; one reviewer call
   reviews the complete one/two-candidate set, and only fixed reconciliation can
   create it. Each manifest binds the same set result hash and the matching candidate
   entry; no candidate may be omitted or reviewed by a second result.
6. `candidate-evidence-manifest-v1`, domain
   `dasher.candidate-evidence-manifest.v1`: exact fields `schema`, `candidate_id`,
   `candidate_spec_sha256`, `bundle_sha256`, `claims_sha256`,
   `validation_findings_sha256`, `reviewer_verdict_sha256`,
   `material_claim_set_sha256`, and `entries`; 1..64
   entries, at most 65,536 bytes. Each entry has exactly `claim_id` and sorted unique
   `supporting_evidence_ids`. Entries sort by claim UUID. The entry claim set must
   equal exactly the candidate's complete trusted material-claim set, each list must equal that
   claim's current `supports` edges, and every evidence ID must be in the common
   bundle. No extra/missing claim or edge is accepted. `claims_sha256` must equal
   the stored `claim_set_sha256`, not a caller-selected summary hash.
7. `run-abstention-v1`, domain `dasher.run-abstention.v1`: exact fields
   `schema`, `abstention_id`, `reason`, `retryable`, and `next_safe_step`.
   `abstention_id` equals the terminal operation UUID. Reason is
   `insufficient_evidence|ambiguous_request|missing_governed_metric|
unsupported_capability|calculation_limit|budget_exhausted|authority_revoked`.
   `retryable` is true only for insufficient evidence, ambiguous request, missing
   metric, or budget exhaustion. `next_safe_step` is exactly one of
   `select_source|refresh_snapshot|define_metric|resolve_grain|add_evidence|
reduce_scope|retry_later|none`, with `none` required for unsupported capability and
   authority revoked. It is at most 4,096 bytes and contains no arbitrary explanation
   string; UI copy is selected by reason/step code.
8. `dashboard-spec-v1`, domain `dasher.dashboard-spec.v1`, is not a new schema. Its
   canonical bytes must parse through package `@dasher/dashboard-schema` version
   `0.1.0`'s exported `parseDashboardSpec`, whose authoritative source is
   `packages/dashboard-schema/src/schema.ts` SHA-256
   `dfdbbba8f6202cff2eeddaf82cbc4e2989f30982334351b174926dcd568fd8b2` at the
   authorized base. It admits only the exact 1.0/1.1 strict unions and aggregate
   budgets in that file; Task 9A first asserts this hash and cannot silently fork,
   relax, or upgrade it. The stored row hash uses canonical JCS bytes after validation,
   not the validator's input serialization.

   Candidate commit then runs trusted `material-assertions-v1` extraction in both
   TypeScript and the fixed PostgreSQL writer over those exact stored bytes. It emits
   one assertion for every path in this exhaustive list: `/freshness`, `/nextAction`,
   `/notice`; each present `/executiveBrief/{known|changed|important}`; every
   `/pages/<p>/description`; every present component `subtitle`; every summary
   `claims/<i>` item, metric-grid `metrics/<i>` item, gauge-map/table `gauges/<i>`
   item, ranking `items/<i>` item, trend-list `series/<i>` item including all its
   points, and alert-list `alerts/<i>` item; every `/evidence/<i>` entry; and
   `/architecture/summary`, every architecture node, and every architecture edge.
   Array indices are their canonical stored order and pointers use exact RFC 6901
   escaping. Titles, labels, IDs, audience, generated time, and component-wide
   evidence-ID arrays are metadata unless included inside one of those exact
   subtrees; no other path is material in v1.

   Each extracted entry has exact fields `claim_id`, `json_pointer`,
   `assertion_sha256`, and `allowed_labels`. `assertion_sha256` is the canonical row
   hash over domain `dasher.material-assertion.v1`, exact fields
   `schema,candidate_spec_sha256,json_pointer,value`, where `value` is the exact
   DashboardSpec subtree. `claim_id` is UUIDv8 over domain
   `dasher.material-claim-id.v1`, candidate-spec SHA bytes, pointer text, and
   assertion SHA bytes. Allowed labels are mapped exhaustively: next action is
   `recommendation`; evidence uses `observed`, no fact label, `hypothesis`, or
   `recommendation` for DashboardSpec kinds `observed`, `calculated`, `interpreted`,
   or `recommended` respectively; executive entries use their declared statement
   types with `interpreted -> hypothesis`; freshness/trends are
   `observed|calculated`; gauges are `observed`; metrics are
   `observed|calculated`; all remaining paths are
   `observed|calculated|hypothesis|recommendation`. Every mapped set then additionally
   contains `unknown` and `blocked`, in the global label-enum order, so an assertion
   can remain explicitly unresolved but cannot claim complete evidence. Entries sort by JSON pointer's
   unsigned UTF-8 bytes and are unique. The set hash is SHA-256 over
   `dasher.material-claim-set.v1\0`, candidate-spec SHA, canonical-binary signed-64
   count, then each claim UUID, pointer text, assertion SHA, signed-64 allowed-label count,
   and labels in the enum order above. Candidate commit denies zero or more than 64
   derived assertions, stores the exact count/hash on `agent_candidates`, and emits
   them in `candidate_committed`; the database re-extracts and compares the entire
   set again at claim, manifest, ranking, and replay-fenced validation commits.
   Model-supplied omission, extra claims, pointer/hash substitution, or salience
   never affects the coverage set.

   Calculated provenance is a server-side `calculated-assertion-mapping-v1`; it adds
   no field to DashboardSpec. `calculation_output_sha256` is the canonical row hash
   with domain `dasher.calculation-output.v1` over the complete exact output entry
   from `calculation-result-v1`. A scalar-row or rowset-cell binding additionally
   hashes exact JCS
   `{schema,result_id,node_id,row_id,field_id,value}` with domain
   `dasher.calculation-output-value.v1`; `schema` is
   `calculation-output-value-v1`, `field_id` is null only for a scalar row, and
   `value` is the exact runtime tagged value. Output/row/field lookup uses the result
   array, row IDs, and rowset output field schema—not caller indexes or ordinals.
   Every admitted mapping first follows the result's graph FK to its one bound
   MetricContractVersion. Unless stated otherwise, the output node must equal that
   graph's `contract_output_node_id`, and every DashboardSpec `evidenceIds` array
   below must byte-equal the contract's sorted `lineage_evidence_ids`. The mapping
   also requires the calculated Claim's complete edge set to be exactly one
   `supports` edge for every such lineage ID and no `context|contradicts` edge.
   Thus candidate bytes, normalized edges, manifest, contract, and bundle all name
   the same support set. The mapping
   then admits `calculated` only for these exhaustive complete material subtrees:

   - a summary claim is exactly `{text,evidenceIds}`, with `text` equal to the
     selected scalar/cell's exact display string;
   - a metric item is exactly the pinned schema's object with `label` equal to the
     contract name, `value` equal to that display string, both optional `change` and
     `direction` absent, and the exact lineage evidence IDs;
   - a ranking item has `id` equal to lowercase output-node UUID text, `label` equal
     to the contract name, `value` equal to that display string, optional `note`
     absent, and the exact lineage evidence IDs;
   - an executive entry has `statementTypes` exactly `["calculated"]`, `headline`
     equal to the contract name, `detail` equal to that display string, and the exact
     lineage evidence IDs;
   - a trend series may instead name identity kind `output` and any same-result
     rowset output derived solely from the bound graph's exact source/catalog/bundle.
     The series `id` is lowercase output-node UUID text, `label` is the contract
     name, `evidenceIds` is the exact contract lineage, and the output has
     exactly two fields named `at` and `value`: `at` is nonnull timestamp with null
     unit/currency and `value` is nonnull integer/decimal with null currency and unit
     byte-equal to the series unit. Result rows and points are one-to-one in ordinal
     order, timestamps byte-equal, and each point binary64 exactly equals its rational
     value; and
   - `/freshness` may instead name only the same-result scalar/cell text output whose
     node ID equals the graph row's nonnull `freshness_classifier_node_id`. That graph
     is the Claim result's graph and therefore binds the same one
     MetricContractVersion as `contract_output_node_id`; another result, contract, or
     `classify_state` output cannot substitute. The classifier input must equal
     `freshness_input_node_id`, the exact contract diagnostic maximum described in
     section 5.1, and its source row must equal the independently rederived
     `freshness_source_row_id`. Its `stale_after_millis` is the checked signed-64 sum
     `lag_millis + freshness_slo_millis`, and its evaluation time equals the request,
     graph, and candidate `generatedAt` instant. `current -> status "fresh"` and
     `stale -> status "stale"`; `label` byte-equals that exact output, while
     `latestObservationAt` byte-equals the maximum present/stale event-time value in
     the stored source row. A stale runtime value state may carry the text, but a
     null/missing/unavailable classifier value cannot prove the subtree. Every claim,
     manifest, and ranking revalidation rereads the request input/source/catalog/
     contract plus graph/result and recomputes the maximum value, deterministic tie
     row, checked threshold, classifier output, and all three stored graph columns.

   The exact display string is: boolean `true|false`; integer base-10 without the
   `i64:` tag; decimal fixed-point base-10 with exactly its canonical stored scale
   (scale zero has no point); text/date/timestamp verbatim; and duration as signed
   base-10 microseconds plus ASCII ` us`. Append one ASCII space and the output
   currency when nonnull, otherwise the output unit when nonnull. No locale,
   thousands separator, exponent, plus sign, trailing-zero invention, unit alias, or
   implicit percentage/currency formatting is accepted. Numeric DashboardSpec
   binary64 leaves must round-trip to the exact rational; values that cannot do so
   cannot use that mapping. Evidence entries and gauges have no safe complete-
   subtree mapping in the pinned schema and therefore cannot use `calculated`.
   Every other material path likewise removes `calculated` from its allowed-label
   set while retaining its previously listed non-calculated labels plus
   `unknown|blocked`. Thus prose, architecture, notice, page descriptions, subtitles,
   next action, alerts, evidence entries, and gauges cannot acquire calculated
   provenance by naming an unrelated result. Re-extraction at claim, manifest,
   ranking, and replay repeats this mapping and denies any result/node/output/row/
   field/value/contract/subtree mismatch.

   Task 9 additionally requires every DashboardSpec `evidence[].id` and every
   referenced evidence ID to be lowercase UUID text naming an exact member of the
   run's common bundle; duplicates, non-UUID aliases, and bundle extras represented
   with mismatched identity deny validation. This is an external candidate-validity
   constraint, not a change to DashboardSpec 1.0/1.1 itself. Claim/manifest evidence
   IDs use those same UUIDs, lock the corresponding bundle header, and apply the
   mandatory nonlocking fresh membership revalidation. Task 9 candidates also require
   `dataMode = 'demo'`; accepting schema-valid `live` would falsely imply the
   explicitly absent live-source/provider scope.

9. `precommit-dashboard-validation-v1`, domain
   `dasher.precommit-dashboard-validation.v1`: exact fields `schema`,
   `candidate_spec_sha256`, `validator_id`, `validator_source_sha256`, `state`, and
   `error_codes`. `validator_id` is exactly
   `@dasher/dashboard-schema@0.1.0+task9-candidate-v1`; source hash is SHA-256
   over `dasher.precommit-validator-source.v1\0`, the 32-byte dashboard-schema source
   hash above, then canonical-binary-v1 texts `material-assertions-v1`,
   `bundle-evidence-uuid-v1`, and `demo-data-mode-v1`; state is
   `valid|invalid`. Error codes are 0..64
   sorted unique values from `schema|size|complexity|duplicate_id|missing_evidence|
invalid_evidence_time|invalid_architecture_edge|unsupported_version|
material_claim_limit|unsupported_data_mode`; `valid` requires none, including a trusted derived material
   claim count in 1..64, and `invalid` requires at least one. The canonical bytes are at
   most 16,384.
10. `field-catalog-snapshot-v1`, domain `dasher.field-catalog-snapshot.v1`: exact
    top-level fields `schema`, `catalog_snapshot_id`, `input_snapshot_id`,
    `input_sha256`, `input_row_count`, `evaluated_at`, and `fields`.
    `input_row_count` is a nonnegative tagged `i64` and must equal the frozen
    source-snapshot row count. There are 1..512 fields, sorted and
    unique by field UUID, and at most 262,144 bytes. Each field has exactly `field_id`,
    `source_path`, `logical_name`, `scalar_type`, `nullable`, `semantic_type`, `unit`,
    `currency`, `grain`, `event_time_field_id`, `stable_key_ordinal`,
    `max_value_bytes`, `allowed_aggregations`,
    `allowed_dimensions`, and `lineage_evidence_ids`. Paths/names are NFC strings of
    1..256 bytes. `scalar_type` is `boolean|integer|decimal|text|date|timestamp`;
    `semantic_type` is `identifier|measure|dimension|event_time|attribute`;
    optional unit/currency/grain/event-time IDs are SQL/JSON null when inapplicable.
    Aggregations are sorted unique enum values
    `count|count_distinct|sum|min|max|mean|median|ratio`; dimensions and lineage IDs
    are sorted unique UUID arrays of 0..64 and 1..64 respectively. Every lineage ID
    is current-authority evidence for the frozen source snapshot. `max_value_bytes`
    and every nonnull `stable_key_ordinal` are tagged nonnegative `i64` values. At
    least one field has `stable_key_ordinal`; nonnull ordinals are unique and exactly
    `i64:0..i64:k-1`, and
    canonical input rows sort lexicographically by those tagged values then reject
    duplicate keys.
11. `metric-contract-set-v1`, domain `dasher.metric-contract-set.v1`: exact fields
    `schema`, `contract_set_id`, `catalog_snapshot_id`, and `contracts`; 1..64 entries
    sorted/unique by `(contract_id,version)` and at most 262,144 bytes. Each entry has
    exactly `contract_id`, `version`, `business_owner_membership_id`,
    `data_owner_membership_id`, `name`, `definition`, `measure_field_id`,
    `aggregation`, `denominator_contract_id`, `denominator_contract_version`,
    `value_type`, `unit`, `currency`, `direction`, `threshold`, `target`, `grain`, `lag_millis`,
    `freshness_slo_millis`, `allowed_dimension_field_ids`, `calendar`, `timezone`,
    `lineage_evidence_ids`, and `review_state`.
    Version is positive tagged `i64`; names are 1..256 bytes and definitions 1..4,096.
    `aggregation` uses the field-catalog enum; denominator is nonnull exactly for
    `ratio`; `value_type` is `integer|decimal|currency|percentage|duration`;
    unit/currency are nullable only when inapplicable; direction is
    `higher_is_better|lower_is_better|target_band|neutral`; threshold/target are
    nullable canonical decimal strings matching section 5; grain is 1..128 bytes;
    lag/SLO are nonnegative tagged `i64` milliseconds; dimension and lineage arrays are
    sorted unique with bounds 0..32 and 1..64. Calendar is
    `gregorian|iso_week|fiscal_445`; timezone is an exact IANA name and review state
    is `reviewed`. The immutable contract never receives a later graph pointer;
    `calculation_graphs` holds the composite FK to the contract ID/version and thereby
    binds the actual graph. Every field/evidence/owner ID is locked and current.
12. `agent-run-request-v1`, domain `dasher.agent-run-request.v1`: exact fields
    `schema`, `run_request_id`, `request_idempotency_sha256`, `dashboard_id`,
    `input_snapshot_id`, `input_sha256`, `input_table`,
    `purpose`, `evaluation_time`, `policy_revision`, `field_catalog`,
    `metric_contract_set`, `generation_limit_vector`, `review_limit_vector`,
    `orchestration_limits`,
    `adapter_id`, `model_id`, `price_book_revision`, `replay_source_run_id`,
    `replay_source_result_count`, `replay_source_head_sha256`,
    `replay_source_candidate_set_sha256`, `replay_source_bundle_id`,
    `replay_source_bundle_sha256`, `replay_source_brief_id`,
    `replay_source_brief_sha256`, and `replay_source_selected_candidate_id`; at most
    1,638,400 bytes. `request_idempotency_sha256` is the 64-lowercase-hex JSON
    encoding of the exact 32-byte digest supplied to and independently recomputed by
    `request_agent_run`; it is neither `request_sha256` nor a caller-selected opaque
    label. The row's `request_idempotency_sha256` bytea must equal those decoded 32
    bytes exactly. `input_table` is the exact
    nested `canonical-input-table-v1` object whose canonical bytes and hash equal the
    locked source snapshot. Catalog/contract values are exact nested schemas 10/11
    and bind the same input/catalog IDs. Both vectors contain all fourteen immutable
    limit values as tagged `i64`. `orchestration_limits` has exactly
    `active_organization_runs`, `active_dashboard_runs`,
    `approval_required_dashboard_runs`, `provider_concurrency`, `tool_attempts`, and
    `transient_retries`, with tagged values exactly
    `i64:2,i64:1,i64:2,i64:1,i64:0,i64:1` respectively and
    equality to the six policy columns above. Adapter/model/price are the policy literals.
    Suggest requires all replay source identity/hash fields and result count to be
    null. Replay requires a currently authorized `approval_required` source, the
    exact 3..5 retry-aware result grammar/count, its recomputed final head, and the
    exact source candidate-set/bundle/Brief IDs and hashes plus its selected candidate
    ID. Evaluation time
    is UTC RFC 3339 with six fractional digits and is the sole clock used by the run.
    Construction is deliberately acyclic: first canonical-binary-v1 hashes the
    already fixed idempotency preimage in the registry below; next that digest is
    inserted into this complete request object; then the object is JCS-encoded and
    semantically hashed with `dasher.agent-run-request.v1`; finally
    `request_sha256` is the retained-payload envelope over that complete semantic
    hash and a new database nonce. Neither request hash participates in the
    idempotency preimage.
13. `attempt-request-v1`, domain `dasher.attempt-request.v1`: exact fields `schema`,
    `attempt_id`, `attempt_kind`, `adapter_id`, `model_id`, `policy_revision`,
    `price_book_revision`, `candidate_slot`, `retry_of_attempt_id`, `input_sha256`,
    `common_bundle_sha256`, `brief_sha256`,
    `specialist_result_id`, `specialist_result_sha256`, `candidate_set_sha256`,
    `candidate_validation_set_sha256`, `candidate_claim_sets_sha256`,
    `invalid_result_id`, `invalid_result_sha256`,
    `invalid_validation_sha256`, and `instructions_sha256`; at most 65,536 bytes.
    Adapter/model/price literals and kind are the frozen policy values. The immutable
    policy stores one `instructions_sha256` per kind, computed by the canonical row
    rule with domain `dasher.attempt-instructions.v1` over exact UTF-8 instruction
    fixture bytes; callers must match it and never submit arbitrary prompt text.
    Because Task 9 has only a fake adapter, these bytes are closed routing fixtures,
    not natural-language prompts: planner `dasher-task9-planner-v1` (23 bytes,
    SHA `d57dc1caa47bb25cfe39dd8d44f22167f887414c23fa56a9838947605e87b269`),
    generator `dasher-task9-generator-v1` (25,
    `8d302cfdc12d2688ac685c587ba12dcffb533adabd32ac8dd2371e1eec300021`),
    specialist `dasher-task9-specialist-v1` (26,
    `a7607000dbd2cd782f0fc42e621fe55299c9507e458015d3ca7671e80e1df714`),
    repair `dasher-task9-repair-v1` (22,
    `da21c80354847f46eacb65d09361eeb84abff4b1d41fa31804b16911a9b19026`),
    and reviewer `dasher-task9-reviewer-v1` (24,
    `13c81cc91b6ca0a3d36b13b61c2222303e93e40d239bcbb8014a89b473b22751`).
    Each has no LF/NUL and its displayed SHA is the row-hash domain, NUL,
    unsigned-32 length, then those exact ASCII bytes. A future live adapter requires
    a later additive prompt contract; it cannot reinterpret these fixtures.
    `candidate_slot` is null except for generator, where it is tagged `i64:1` or
    `i64:2` and no greater than the Brief target. `retry_of_attempt_id` is null except
    for the one immediate planner/generator retry and then names the exact failed
    same-kind/same-slot result.
    Every attempt kind requires nonnull `input_sha256`, `common_bundle_sha256`, and
    `instructions_sha256`. They byte-equal, respectively, the frozen run input, the
    already committed common bundle, and that attempt kind's policy-pinned
    instruction digest. Planner requires null candidate slot and null
    Brief/specialist/candidate-set/validation-set/claim-set/invalid fields. Its
    initial request has null retry; its sole permitted immediate retry names the
    exact failed planner attempt and, apart from its new attempt/retry IDs, has
    byte-identical semantic binding fields. Specialist
    requires null slot/retry, the exact successful planner-derived Brief, and all
    later fields null. An initial generator requires its exact slot and null retry,
    the exact bundle/Brief; its
    specialist pair is both null when the Brief omitted specialist and otherwise
    equals the sole successful specialist result. The batch contains exactly slots
    `1..candidate_target_count`. A generator retry has the failed same-slot ID and
    otherwise identical request bindings. Candidate-set/validation-set/claim-set/
    invalid fields are null.
    A post-takeover replacement is encoded like its initial slot (null retry) and is
    legal only when fixed attempt history shows the most recent same-slot row is
    `released_takeover` with no result or later semantic artifact.
    Reviewer requires the exact bundle, Brief, frozen candidate-set hash, the exact aggregate
    validation and claim-set hashes, and null specialist/invalid fields.
    Reviewer and repair have null slot/retry. Repair requires the exact bundle,
    Brief, invalid result ID/SHA/invalid-validation hash,
    inherits the same optional specialist pair as the invalid generator, and has null
    candidate-set/validation-set/claim-set hashes. Every nonnull digest/ID is locked
    to this run. The canonical attempt-request semantic SHA is the row hash over
    these complete bytes. The payload row's `payload_sha256` is the separately
    nonce-bearing retained envelope; `attempt_reserved.body.request_sha256`,
    `recorded-result-v1.request_sha256`, `dispatch_request_sha256`, replay grammar,
    and fake-provider input all use the semantic SHA, never the retained envelope.
    Start and invocation authorization independently re-encode the retained request
    bytes and rederive that semantic SHA before computing the closed dispatch hash;
    result reconciliation repeats both comparisons. This direction is acyclic:
    policy/input/bundle/Brief/predecessor hashes -> attempt bytes -> semantic request
    SHA -> dispatch SHA and recorded-result bytes -> result SHA.
    The fake adapter's exact input is JCS `fake-provider-input-v1` with only fields
    `schema,attempt_request,attempt_request_sha256,dispatch_request_sha256,
instructions`. `attempt_request` is the parsed exact request object whose independent
    JCS encoding byte-equals retained canonical request bytes; both SHA fields are
    64-lowercase-hex renderings of the named 32-byte semantic digests; `instructions`
    is the exact kind-selected ASCII routing fixture above. Unknown keys, envelope
    SHA substitution, digest mismatch, or another fixture deny before the zero-
    network fake call. This object is ephemeral and unhashed; its component hashes
    already supply the acyclic persisted identities, and exact-byte snapshots cover
    all five attempt kinds plus the two legal retry forms.
14. `recorded-result-v1`, domain `dasher.recorded-result.v1`: exact fields `schema`,
    `result_id`, `attempt_id`, `attempt_kind`, `adapter_id`, `model_id`,
    `request_sha256`, `result_kind`, and `result`. Successful kinds are exactly
    `planner_output|specialist_output|candidate_output|candidate_invalid|
repair_output|reviewer_verdict_set`; refused/failed kinds are `refusal|failure`.
    Planner result is exactly an `agent-brief-v1` object; specialist result is exact
    fields `schema`, `bundle_sha256`, `observations` (1..32 sorted unique strings,
    each 1..1,000 bytes); candidate/repair output is exact fields `dashboard_spec`
    and `precommit_validation`, containing one nested canonical `dashboard-spec-v1`
    object and its exact `precommit-dashboard-validation-v1` valid object;
    candidate-invalid has the same two fields with an invalid validation object;
    reviewer output is exactly
    `reviewer-verdict-set-v1`. Refusal/failure is exact fields `schema`, `reason_code`,
    and `retryable`, with reason code
    `policy_refusal|insufficient_context|adapter_error|timeout|malformed_output`; only
    `adapter_error|timeout` may be retryable and only under the policy rule above.
    Attempt/result IDs and kind must match the reserved request. The envelope is at
    most 1,114,112 bytes, permitting one maximum DashboardSpec plus bounded metadata.
    Reconcile outcome maps exactly: `succeeded` requires the one success kind legal
    for the attempt kind and current orchestration position (`planner_output`,
    `specialist_output`, generator `candidate_output|candidate_invalid`, repair
    `repair_output`, or reviewer `reviewer_verdict_set`); `refused` requires
    `refusal`; `failed` requires `failure`; `indeterminate` requires
    `actual_accounting_bytes`, result SHA, and result bytes all SQL NULL, inserts no
    payload/recorded result, and maps first to `caller_indeterminate`. Every caller-
    claimed determinate path requires all three nonnull. Its raw accounting bytes use
    only the 1,024-byte `attempt-actual-accounting-v1` grammar and are classified
    inside reconcile in the exact section 3.4 order, so every byte/shape/type/range/
    equation defect emits `malformed_accounting`, and only the derived complete
    equation-valid typed vector can emit `actual_over_reservation`. A normal
    determinate result alone records the payload; the raw accounting bytes are never
    part of `recorded-result-v1` or any retained envelope/hash.
    The fixed reconcile writer independently parses the candidate subtree, rederives
    its canonical bytes/hash, closed DashboardSpec structural checks, material-
    assertion count/set, and precommit validation bytes/hash before accepting
    `candidates=1`; a caller-supplied `valid` label alone has no authority.
15. `agent-run-checkpoint-v1`, domain `dasher.agent-run-checkpoint.v1`: exact fields
    `schema`, `run_id`, `run_request_id`, `request_idempotency_sha256`,
    `request_sha256`, `policy_revision`, `run_revision`, `state`, `lease_epoch`,
    `source_event_sequence`, `source_event_sha256`, `budget_counters`, `attempts`,
    `latest_brief_sha256`, `latest_bundle_sha256`, `calculation_result_ids`,
    `candidate_ids`, `candidate_set_sha256`, `validation_states`,
    `consumed_replay_sequence`, `consumed_replay_sha256`, `terminal_operation_kind`,
    `terminal_operation_id`, `terminal_claim_input_sha256`,
    `terminal_operation_sha256`, `tenant_cancel_operation_id`,
    `tenant_cancel_operation_sha256`, `tenant_cancel_result_sha256`,
    `tenant_cancel_result_run_revision`, `tenant_cancel_result_event_sequence`,
    `tenant_cancel_result_event_sha256`, and `selected_candidate_id`. The four
    terminal-operation fields and six tenant-cancel fields are JSON null for every
    writable checkpoint because checkpoint admission requires a claimed nonterminal
    run. The pure reducer nevertheless
    populates and verifies
    the first four on `run_abstained`, `run_ranked`, `run_finished`, and
    `indeterminate_quarantined`, and populates the tenant-cancel fields only on
    `run_cancelled`, so final event reconstruction and the run projection cannot
    disagree. Content purge may clear the two mixed-takeover digest projections only
    after checkpoint payload deletion; it never clears a tenant-cancel field. No
    post-terminal or post-purge checkpoint is admitted.
    Budget counters contain one row for every `(generation|review, vector_field)` in
    partition/field enum order with exact reserved/used/released/outstanding signed-64
    values. Attempts are sorted by UUID and contain exact attempt ID/kind/state/epoch,
    candidate slot, retry predecessor, all four vectors, and request/result hashes.
    During reducer/checkpoint replay, an `attempt_indeterminate` source event is
    accepted only when its reason is exactly one of `caller_indeterminate`,
    `malformed_accounting`, `actual_over_reservation`, or
    `takeover_after_dispatch` and matches the branch derivation in section 3.4; the
    reason is validated from the event and adds no new checkpoint key. Cancellation
    attempt events have no reason code. Any other literal, missing reason, branch
    mismatch, cancellation reason key, or nonnull indeterminate actual vector rejects
    the checkpoint bytes.
    IDs/states arrays are parallel,
    sorted by UUID, bounded by policy, and use null only before the corresponding
    semantic exists. The three request identities and policy revision are derived
    from event 1 and never from the current request-payload row alone. The checkpoint
    is a complete reducer projection at the named event, at most 262,144 bytes; the
    fixed writer replays every event header plus retained event body from sequence 1
    through the named source sequence, verifies every payload envelope/body/header
    equality, and rejects any caller byte that differs. After canonicalization it
    computes `state_sha256` by the semantic row-hash rule, then independently mints
    the payload nonce and computes `checkpoint_sha256` by the retained-envelope rule;
    neither digest is a field inside these checkpoint bytes. The payload and header
    store both values, `checkpoint_written` projects both, and the writer/read result
    names never alias them.
16. Every `agent_run_event_payloads` row uses `agent-run-event-payload-v1`, domain
    `dasher.agent-run-event-payload.v1`, with exact fields `schema`, `event_id`,
    `run_id`, `event_sequence`, `run_revision`, `event_kind`, `occurred_at`,
    `actor_kind`, `actor_id`, `actor_revision`, and `body`. Actor kind is
    `tenant|run_operator|retention`; ID/revision is the exact requesting membership or
    principal. The closed event-kind/body registry is:

    | Event kind                                                 | Exact body fields                                                                                                                                                                                                                                                                                                                                                                                                                                |
    | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | `run_requested`                                            | `run_request_id,request_payload_id,request_idempotency_sha256,request_sha256,policy_revision,purpose,replay_source_run_id`                                                                                                                                                                                                                                                                                                                       |
    | `lease_acquired`                                           | `claim_request_id,claim_input_sha256,claim_result_sha256,mode,prior_lease_epoch,new_lease_epoch,lease_token_sha256,lease_expires_at,principal_id,principal_revision,principal_sha256`                                                                                                                                                                                                                                                            |
    | `attempt_reserved`                                         | `attempt_id,partition,attempt_kind,candidate_slot,retry_of_attempt_id,request_payload_id,request_sha256,reserved_vector`                                                                                                                                                                                                                                                                                                                         |
    | `attempt_dispatch_prepared`                                | `attempt_id,dispatch_request_sha256`                                                                                                                                                                                                                                                                                                                                                                                                             |
    | `attempt_dispatch_started`                                 | `attempt_id,dispatch_request_sha256`                                                                                                                                                                                                                                                                                                                                                                                                             |
    | `attempt_reconciled`                                       | `attempt_id,outcome,result_id,result_sha256,actual_vector,used_vector,released_vector`                                                                                                                                                                                                                                                                                                                                                           |
    | `attempt_indeterminate`                                    | `attempt_id,reason_code,used_vector,released_vector,fenced_lease_epoch`                                                                                                                                                                                                                                                                                                                                                                          |
    | `attempt_released`                                         | `attempt_id,release_mode,release_proof_sha256,released_vector`; mode is either `worker` or `takeover`                                                                                                                                                                                                                                                                                                                                            |
    | `attempt_cancelled_released` / `attempt_cancelled_charged` | `attempt_id,cancel_operation_id,used_vector,released_vector`                                                                                                                                                                                                                                                                                                                                                                                     |
    | `indeterminate_quarantined`                                | `claim_request_id,lease_seconds,principal_id,principal_revision,principal_sha256,claim_input_sha256,claim_result_sha256,terminal_claim_input_sha256,source_event_sequence,source_event_sha256,released_attempt_ids,charged_attempt_ids,settled_attempt_count,first_settlement_event_sequence,last_settlement_event_sequence,settlement_events_sha256,used_vector,released_vector,prior_lease_epoch,fenced_lease_epoch,terminal_operation_sha256` |
    | `replay_prerequisites_cloned`                              | `source_run_id,bundle_id,bundle_sha256,brief_id,brief_sha256,candidate_set_sha256,result_count,result_head_sha256`                                                                                                                                                                                                                                                                                                                               |
    | `replay_result_consumed`                                   | `source_run_id,source_result_sequence,source_result_sha256,replay_result_id`                                                                                                                                                                                                                                                                                                                                                                     |
    | `checkpoint_written`                                       | `checkpoint_revision,source_event_sequence,source_event_sha256,state_sha256,checkpoint_sha256`                                                                                                                                                                                                                                                                                                                                                   |
    | `brief_committed`                                          | `brief_id,brief_sha256`                                                                                                                                                                                                                                                                                                                                                                                                                          |
    | `common_bundle_committed`                                  | `bundle_id,bundle_sha256`                                                                                                                                                                                                                                                                                                                                                                                                                        |
    | `calculation_graph_committed`                              | `graph_id,graph_sha256,result_id,result_sha256,meter_sha256`                                                                                                                                                                                                                                                                                                                                                                                     |
    | `candidate_committed`                                      | `candidate_id,candidate_spec_sha256,source_result_id,source_result_sha256,precommit_validation_sha256,bundle_sha256,material_claim_count,material_claim_set_sha256`                                                                                                                                                                                                                                                                              |
    | `candidate_set_closed`                                     | `candidate_ids,candidate_set_sha256`                                                                                                                                                                                                                                                                                                                                                                                                             |
    | `candidate_validation_findings_committed`                  | `candidate_id,findings_sha256,finding_count,validation_state`                                                                                                                                                                                                                                                                                                                                                                                    |
    | `candidate_claims_committed`                               | `candidate_id,claims_sha256,claim_count,edge_count`                                                                                                                                                                                                                                                                                                                                                                                              |
    | `candidate_manifest_committed`                             | `candidate_id,manifest_sha256,reviewer_result_sha256`                                                                                                                                                                                                                                                                                                                                                                                            |
    | `run_abstained`                                            | `terminal_operation_id,abstention_id,abstention_sha256`                                                                                                                                                                                                                                                                                                                                                                                          |
    | `run_ranked`                                               | `terminal_operation_id,selected_candidate_id,ordered_candidate_ids,ordered_ranks,ranking_sha256`                                                                                                                                                                                                                                                                                                                                                 |
    | `run_finished`                                             | `terminal_operation_id,terminal_outcome,reason_sha256`                                                                                                                                                                                                                                                                                                                                                                                           |
    | `run_cancelled`                                            | `cancel_operation_id,cancel_operation_sha256,reason_sha256,released_attempt_ids,charged_attempt_ids,used_vector,released_vector,fenced_lease_epoch`                                                                                                                                                                                                                                                                                              |
    | `run_cleanup_cancelled`                                    | `cancel_operation_id,reason_sha256,released_attempt_ids,charged_attempt_ids,used_vector,released_vector,fenced_lease_epoch`                                                                                                                                                                                                                                                                                                                      |

    No other event kind or body key exists. Body arrays use the sorting/bounds already
    frozen above; vectors contain all fourteen named fields. In particular,
    `attempt_reconciled.actual_vector` is the database-derived typed composite and no
    event body, event/hash preimage, reducer state, checkpoint, recorded result, or
    replay object contains `actual_accounting_bytes` or its raw bytes.
    `attempt_indeterminate.reason_code` is present and closed to exactly
    `caller_indeterminate`, `malformed_accounting`, `actual_over_reservation`, and
    `takeover_after_dispatch`; the append/transition trigger derives and requires the
    exact section 3.4 branch mapping and rejects a caller-supplied or fifth literal.
    `attempt_cancelled_charged` has exactly the displayed fields, never a
    `reason_code`, and cannot substitute for or emit `attempt_indeterminate`. Every
    `attempt_indeterminate` and `attempt_cancelled_charged` body carries the exact
    indeterminate-settlement used/released vectors from section 3.4. Each aggregate
    `indeterminate_quarantined|run_cancelled|run_cleanup_cancelled` body carries their
    checked componentwise sums; a `charged_attempt_ids` entry names a dispatched
    indeterminate settlement and does not redefine the candidate component as used.
    The reducer and append/transition trigger require the candidate component to be
    released and every other component to be charged before accepting those event
    bodies or aggregate vectors. They additionally require SQL NULL stored actual
    vector for every one of the four `attempt_indeterminate` reasons; cancellation/
    drain validate their reasonless charged event separately. The event payload is at
    most 262,144 bytes except `candidate_committed`, whose body still contains only
    hashes/IDs rather than DashboardSpec bytes. For
    `indeterminate_quarantined`, `lease_seconds` is a tagged signed-64 value in
    `i64:1..i64:900`; the explicit principal ID/revision equal the outer
    `actor_id`/`actor_revision`, outer `actor_kind` is exactly `run_operator`, and
    `principal_sha256` equals the locked latest allowlist revision. The source event
    sequence/hash are the locked `agent_runs` current head captured before any
    per-attempt settlement event in that claim transaction, not the final aggregate
    head. `terminal_claim_input_sha256` equals both `claim_input_sha256` and the
    same-named `agent_runs` column; the terminal operation digest equals its run
    column. The claim-result digest binds the typed result projection copied to the
    event header. For either claim event, the append trigger requires header kind/ID/
    input/result digests and typed projection to equal the body and now-fixed result,
    with `ordinary_claim` only on `lease_acquired` and `indeterminate_takeover` only
    on `indeterminate_quarantined`. The fixed
    append/transition trigger verifies all of these body/header/run equalities at
    write time; that proof is later represented by immutable event/header hashes and
    does not authorize an ordinary event-body read on retry.

The hash/preimage registry is closed and uses `canonical-binary-v1` unless the row-hash
rule explicitly says JCS:

| Stored/provided digest                                                                               | Exact domain and ordered values after domain NUL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any canonical semantic row hash above                                                                | its listed `dasher.<schema>.v1` domain, unsigned-32 byte length, exact JCS bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `policy_sha256`                                                                                      | `dasher.agent-run-policy.v1`; revision, nullable predecessor revision/hash, enabled byte, adapter/model/price texts, input/output rates, generation then review vectors in fourteen-field order, six non-vector limits in column order, and five instruction SHA byte strings; `created_at` is audit metadata outside this semantic hash                                                                                                                                                                                                                                                                                                                     |
| catalog entry / metric contract entry hashes                                                         | respectively `dasher.field-catalog-entry.v1` and `dasher.metric-contract-version.v1`; exact canonical field or contract entry object bytes from schemas 10/11; catalog/set hashes remain the canonical semantic row hashes of the complete containing schemas                                                                                                                                                                                                                                                                                                                                                                                                |
| Retained request/event/checkpoint/attempt payload envelope hash                                      | `dasher.retained-payload-envelope.v1`; exact schema content-kind text, 32-byte database nonce, semantic row SHA bytes; this is the header/pointer hash. For checkpoint content-kind `agent-run-checkpoint-v1` it is named only `checkpoint_sha256`; its nonce, bytes, and separately named semantic `state_sha256` are deleted/cleared together while the envelope remains.                                                                                                                                                                                                                                                                                  |
| `candidate_spec_sha256`                                                                              | `dasher.dashboard-spec.v1`, unsigned-32 byte length, exact validated JCS DashboardSpec bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `request_idempotency_sha256`                                                                         | `dasher.agent-run-request-idempotency.v1`; dashboard UUID, input snapshot UUID, run-request UUID, purpose text, expected lifecycle revision, expected input SHA bytes, nullable replay source UUID, deployment revision text. This digest is computed first, is stored as an exact bytea column and inside `agent-run-request-v1`, and neither the semantic request hash nor retained `request_sha256` appears in this preimage.                                                                                                                                                                                                                             |
| `lease_token_sha256`                                                                                 | the exact `dasher.agent-run-lease-token.v1` preimage in section 4.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `dispatch_request_sha256`                                                                            | `dasher.attempt-dispatch-request.v1`; run UUID, lease epoch, attempt UUID, attempt-request row SHA bytes, adapter text, model text, policy revision, price-book text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `release_proof_sha256`                                                                               | `dasher.attempt-release.v1`; run UUID, lease epoch, attempt UUID, release-reason text, attempt-request SHA bytes, then all fourteen reserved-vector signed-64 values in enum order                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ordinary `claim_input_sha256`                                                                        | `dasher.agent-run-ordinary-claim-input.v1`; claim-request UUID, bounded lease seconds as signed-64, latest database-bound principal UUID, signed-64 principal revision, and principal SHA bytes, in that order. No selected run, tenant, event head, clock, or payload participates.                                                                                                                                                                                                                                                                                                                                                                         |
| `terminal_claim_input_sha256`                                                                        | `dasher.agent-run-terminal-claim-input.v1`; claim-request UUID, bounded lease seconds as signed-64, latest database-bound principal UUID, signed-64 principal revision, and principal SHA bytes, in that order. These are all caller semantics plus the principal selected by bootstrap; no run/tenant ID, event head, wall-clock value, or payload hash is an input.                                                                                                                                                                                                                                                                                        |
| event-header `claim_input_sha256` / `claim_result_sha256`                                            | Input is the ordinary digest above for `ordinary_claim` and byte-equals `terminal_claim_input_sha256` for `indeterminate_takeover`. Result is `dasher.agent-run-claim-result.v1`; operation-kind text, claim-request UUID, input-SHA bytes, status text, organization UUID, dashboard UUID, run UUID, signed-64 run revision, state text, signed-64 lease epoch, nullable 32-byte attempt token, nullable lease-expiry timestamp, signed-64 policy revision, and nullable input-SHA bytes. Status is exactly `claimed` for ordinary and `terminalized_indeterminate` for mixed takeover; the three nullable result fields are all present only for ordinary. |
| `settlement_events_sha256`                                                                           | `dasher.takeover-settlement-events.v1`; run UUID, prior epoch, fenced epoch, settlement count, then each per-attempt settlement in event order: attempt UUID, disposition text `released\|charged`, event sequence, event SHA, and all fourteen used then released vector values. `charged` is the dispatched-indeterminate disposition label; its hashed vectors must use the section 3.4 candidate-field exception (`used.candidates=0`, `released.candidates=reserved.candidates`) and charge every other field.                                                                                                                                          |
| `event_sha256`                                                                                       | `dasher.agent-run-event.v1`; run UUID, event sequence, event kind text, occurred-at timestamp, nullable prior sequence, nullable prior event SHA bytes, event-payload SHA bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| checkpoint `state_sha256`                                                                            | semantic row-hash rule for exact `dasher.agent-run-checkpoint.v1` JCS bytes; its source event sequence/hash are inside those bytes, and no nonce or `checkpoint_sha256` is in this preimage                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| checkpoint `checkpoint_sha256`                                                                       | retained-payload envelope rule with exact content-kind text `agent-run-checkpoint-v1`, the payload row's database nonce, and `state_sha256` bytes; no event/header hash participates                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `precommit_validation_sha256`                                                                        | row-hash rule for `dasher.precommit-dashboard-validation.v1` bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| calculation `result_id`                                                                              | UUIDv8 over `dasher.calculation-result-id.v1`; graph UUID, fixed raw 32-byte graph SHA, fixed raw 32-byte input SHA, registry text, limits text. The two digests are the registry's unprefixed “SHA bytes,” while both texts keep their canonical-binary length prefixes                                                                                                                                                                                                                                                                                                                                                                                     |
| calculated-claim output/value digests                                                                | `calculation_output_sha256` is the row-hash rule with domain `dasher.calculation-output.v1` over the exact complete result output entry. `calculation_output_value_sha256` is the row-hash rule with domain `dasher.calculation-output-value.v1` over exact JCS fields `schema,result_id,node_id,row_id,field_id,value`, where schema is `calculation-output-value-v1` and field ID is nullable only for scalar output. Neither digest appears in its own preimage.                                                                                                                                                                                          |
| derived contract group grain                                                                         | lowercase text `group:` followed by SHA-256 over `dasher.metric-group-grain.v1\0`, calendar text, timezone text, signed-64 dimension count, then each allowed-dimension field UUID in its stored sorted order. Text uses canonical-binary-v1 length prefixes. Zero dimensions hashes the exact zero-count prefix.                                                                                                                                                                                                                                                                                                                                            |
| material assertion/claim ID/set                                                                      | exact `dasher.material-assertion.v1`, `dasher.material-claim-id.v1`, and `dasher.material-claim-set.v1` domains and ordered values in schema 8 above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `candidate_set_sha256`                                                                               | `dasher.candidate-set.v1`; bundle SHA bytes, Brief SHA bytes, count, then candidate UUID/spec-SHA pairs sorted by UUID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| reviewer validation/claim aggregate hashes                                                           | respectively `dasher.candidate-validation-set.v1` and `dasher.candidate-claim-sets.v1`; candidate-set SHA bytes, signed-64 candidate count, then candidate UUID and findings SHA or claim-set SHA pairs in candidate UUID order                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ranking_proof_sha256`                                                                               | `dasher.candidate-ranking.v1`; candidate-set SHA bytes, candidate count, then candidate UUID/spec SHA/verdict ordinal/contradicted count/weak count/complete-supported count/rank in rank order, selected candidate UUID                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `replay_source_head_sha256`                                                                          | iterative `dasher.replay-result-head.v1`; source run UUID, result sequence, nullable prior head SHA, result UUID, result-kind text, result SHA; sequence 1 starts with nullable prior head and every later row uses the preceding digest                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `terminal_operation_sha256`                                                                          | `dasher.run-terminal-operation.v1`; operation-kind text, operation UUID, run UUID, then the exact kind-specific suffix below. No kind uses an unlisted generic concatenation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cancel reason_sha256`                                                                               | row-hash rule for `dasher.run-cancel-reason.v1` exact JCS fields `schema,reason`, where reason is `user_requested\|authority_revoked\|dashboard_cleanup`; tenant cancel admits only the first, cleanup synthesizes only the third, and authority fencing synthesizes only the second                                                                                                                                                                                                                                                                                                                                                                         |
| tenant `cancel_operation_sha256`                                                                     | `dasher.run-tenant-cancel-operation.v1`; operation/audit UUID, organization UUID, dashboard UUID, run UUID, signed-64 expected run revision, raw fixed-32 cancel-reason SHA bytes, signed-64 CSRF key version, raw fixed-32 CSRF digest bytes with no length prefix, deployment-revision text, current actor user UUID, current actor membership UUID, and signed-64 actor authority revision. Every value comes from the initialized/locked call; none comes from a purgeable audit payload.                                                                                                                                                                |
| tenant `cancel_result_sha256`                                                                        | `dasher.run-tenant-cancel-result.v1`; raw fixed-32 cancel-operation SHA bytes, organization UUID, dashboard UUID, run UUID, signed-64 stored result run revision, exact state text `cancelled`, signed-64 result event sequence, and raw fixed-32 result event SHA bytes. It is computed only after the terminal event hash is fixed, so the event body points to the operation digest and this result digest points to the event without a cycle.                                                                                                                                                                                                           |
| `capabilities_sha256`, principal revision hash, drain proof, cleanup completion proof, age-out proof | their exact separately enumerated preimages in sections 4.3/4.5; generic concatenation is forbidden                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`actual_accounting_bytes` is deliberately absent from this registry. Successful
determinate event and checkpoint preimages encode only the derived typed
`actual_vector`; malformed/over-reservation/caller-indeterminate preimages encode no
actual vector. No raw accounting byte, digest of it, parser diagnostic, or excerpt is
persisted or returned.

`terminal_operation_kind` is exactly
`abstention|ranking|finish|indeterminate_takeover`. The first three suffixes preserve
their existing order exactly: abstention is signed-64 lease epoch, lease-token SHA
bytes, and abstention row hash; ranking is signed-64 lease epoch, lease-token SHA
bytes, selected candidate UUID, and ranking proof; finish is signed-64 lease epoch,
lease-token SHA bytes, outcome text, and canonical-reason row hash. The
`indeterminate_takeover` suffix is exactly:
terminal claim-input SHA bytes, signed-64 source event sequence, source event SHA
bytes, signed-64 prior epoch, signed-64 fenced epoch, signed-64 settlement count,
settlement-events SHA bytes, signed-64 aggregate event sequence, signed-64 final run
revision, final state text literal `failed`, terminal timestamp, and signed-64 policy
revision. It deliberately includes no lease-token SHA because the takeover clears
that value, and no aggregate event/payload hash because the aggregate body contains
the operation digest.

The mixed-takeover computation is acyclic and ordered exactly. After principal
bootstrap and argument validation, compute the claim-input digest. After the run is
locked and reauthorized, snapshot its current event sequence/hash as the source head
and its lease epoch as `prior_epoch`; compute checked `fenced_epoch = prior_epoch +
1`. Append the per-attempt settlement events in unsigned attempt-UUID order and then
compute `settlement_events_sha256` from their now-fixed event sequences/hashes and
stored vectors. Set `aggregate_event_sequence` to the checked next sequence and fix
the database terminal timestamp, final run revision, state, and policy revision.
Compute the terminal operation digest from the suffix above. Only then canonicalize
the exact typed `terminalized_indeterminate` result and its claim-result digest; its
header `claim_input_sha256` byte-equals the already computed terminal claim-input
digest. Then canonicalize the aggregate body containing the input, result, settlement,
and terminal-operation digests, create its retained envelope, append its header/hash
and immutable claim-result projection, and atomically store the terminal fields plus
final head. Therefore neither the terminal operation nor claim-result digest contains
the aggregate event/payload hash, while that one directed event commitment contains
both digests. The immutable write trigger proves that the original aggregate body,
event claim projection, and run fields contained the exact stored bindings.

Abstention's final semantic value is the abstention row hash; ranking's are selected
candidate UUID and ranking proof; finish's are outcome text and canonical-reason row
hash. The canonical finish reason bytes have exact fields
`schema = run-finish-reason-v1` and `reason`, where reason is
`insufficient_evidence|policy_rejected|budget_exhausted|expired|
operator_cancelled|indeterminate|internal_failure`; outcome/reason pairs are frozen
as `rejected` with the first three, `expired` with expired, `cancelled` with operator
cancelled, and `failed` with indeterminate/internal failure. After current principal,
membership, organization, dashboard, and lifecycle reauthorization, an exact replay
of a stored terminal operation ID/hash returns the stored typed result before checking
the now-cleared old lease; it inserts no row/event/audit and changes no counter. Same
ID with kind/hash/input drift denies. A different operation ID against a caller-
targeted finalized run follows normal state denial.

Both ordinary and mixed-takeover replay are no-run-argument branches and are closed
separately in section 4.4. Content purge clears each claim event's input/result
digests, ordinary result token and input SHA, and clears the mixed run projection's
`terminal_claim_input_sha256`/`terminal_operation_sha256`, while retaining the event
operation kind/ID and mixed run kind/ID. Thereafter any reuse of that committed claim
ID receives fixed denial `P1001`, never falls through to ordinary selection, and
reveals no stored tenant/run identity. Final metadata age-out deletes the claim event
header and run identity together. Only after that separately authorized deletion is
the ID indistinguishable from a never-retained ID and eligible for a new ordinary
claim; no semantic or result replay is promised after either retention boundary.

Tenant cancellation is a separate run-targeted replay branch and never uses the
claim-event index or `terminal_operation_kind`. The call's `audit_event_id` is named
`cancel_operation_id` for this protocol. Before target locks it takes the database-
global cancel-operation advisory gate keyed only by that UUID and probes first
the initialized organization's `agent_runs_ix_05`, then the database-global immutable
`audit_events` primary key. A found run or audit row never falls through to another
cancellation. A found run requires its
matching audit row; the body first requires the found organization/dashboard/run to
equal the currently initialized target, then performs the normal current actor/
membership/dashboard/run reauthorization and locks that row. It recomputes the
operation digest from all incoming bindings, recomputes the result digest from the
six stored cancel fields and immutable event header at the stored sequence, and
requires the stored result revision/sequence/hash to equal the terminal run
projection. It also revalidates the exact immutable audit projection described below.
Exact equality returns the original `dasher_api.agent_run_mutation_result` with zero
attempt/counter/event/audit/run DML before expected-revision or terminal-state
rejection. A found audit row without the run projection—including after age-out—or
any found-ID target/actor/authority/reason/CSRF/deployment/digest/result/event/audit
drift is `P1001`.

If the operation ID is absent, the same advisory gate remains held while the normal
target locks are acquired. The expected revision must equal the locked pre-cancel
revision and the run must be nonterminal. The function computes the operation digest,
settles attempts, fixes the database terminal revision and `run_cancelled` payload,
appends that event with `cancel_operation_id` and `cancel_operation_sha256`, then
computes the result digest from its now-fixed event hash and writes all six
`tenant_cancel_*` fields with the terminal projection. The same transaction inserts
`audit_events.audit_event_id = cancel_operation_id`, action
`dashboard.agent_run_cancelled`, target run ID, and
`content_sha256 = cancel_operation_sha256`. Its complete fixed projection is the
operation organization; the same database `occurred_at` as `run_cancelled`;
`actor_kind='user'`; operation actor user and authority revision; null actor service;
the initialized request ID; null job ID; that exact action;
`target_type='agent_run'`; operation run as target; `outcome='succeeded'`; null
source/provider/credential/usage/cost fields; and the operation deployment revision.
The operation digest binds every reusable semantic field except the per-invocation
request ID and database timestamp. Those two are immutable first-write audit
coordinates: the timestamp must equal the stored event timestamp, while request ID is
validated as the nonnull original audit request and is never compared with a retry's
new request. The audit row is an exact linkage and permanent UUID reservation, not
the typed-result replay store. A
unique-index or locked-row race is `P1002` and rolls back every settlement before
retry. Different operation IDs racing one run serialize on that run: only the winner
cancels and the loser receives normal terminal denial.

Content purge deletes cancel-reason and event payload bytes and clears the ordinary
eighteen fields, but neither mutates the immutable audit header nor clears any
`tenant_cancel_*` field or its globally unique index. Because a purged dashboard is
no longer tenant-accessible, a tenant retry in
that interval returns non-leaking `P1001`; the retained operation UUID remains
reserved and cannot cancel another run. At held-aware `purged_at + 365 days`, final
metadata age-out deletes the run, event header, and stored operation/result projection
atomically, but the predecessor immutable audit header is not an age-out DELETE target
and continues to reserve the operation UUID. A later call
targeting the aged-out original run is `P1001` and no exact replay is promised. Reuse
against any different run also receives `P1001` forever; this UUID never becomes a
fresh cancellation identity after age-out.

`close_agent_candidate_set` requires one or two immutable candidate rows, one common
bundle and Brief, no repair in flight, and no previous set hash. It computes
`candidate_set_sha256` over domain `dasher.candidate-set.v1\0`, bundle hash, Brief
hash, candidate count, then candidate UUID/spec-hash pairs sorted by UUID, stores the
hash/time on `agent_runs`, and emits the same complete set. Ranking reads only that
set. A candidate is eligible iff its validation state is `passed|passed_with_warnings`,
review verdict is `preferred|acceptable`, its trusted material count/set hash rederive
exactly, every material assertion has exactly one claim and manifest entry, every
observed/calculated material claim is complete/current-supported, no material claim is
contradicted, every calculated claim has a successful bound result, and the manifest
is exact. Salience is ignored. Ineligible candidates receive no rank. Eligible ordering is the total tuple
`(review ordinal preferred=0 acceptable=1, contradicted-claim count ascending,
weak-claim count ascending, complete-supported-claim count descending,
candidate_spec_sha256 ascending, candidate_id ascending)`, where weak means
`evidence_state=partial|stale|unsupported` or label `unknown|blocked`, and
complete-supported means state complete with at least one current supports edge.
Ranks are contiguous from 1; selection is rank 1. All counts are recomputed in SQL
from the frozen set and schemas above, never accepted from a caller.

### 4.4 Fixed function identities

Tenant-facing functions execute only after existing `dasher_api.initialize_context`
and use current full tenant context:

- `dasher_api.request_agent_run(uuid, uuid, uuid, text, bigint, bytea, bytea,
uuid, smallint, bytea, text, uuid)`;
- `dasher_api.cancel_agent_run(uuid, bigint, bytea, uuid, smallint, bytea, text)`;
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

Both mutation functions require the wrapper-snapshotted current CSRF key version/
digest and call existing `dasher_private.context_csrf_allows`; they also require an
audit-event UUID distinct from `context_request_id()` and the exact bounded deployment
revision. Request requires a fresh audit UUID on its new path and ignores the retry's
fresh audit UUID as already specified. Cancel requires a fresh operation/audit UUID
for first write and the same UUID plus byte-identical CSRF/deployment bindings for
exact replay. Read functions receive none of these mutation-only values.

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

The reviewed matrix below freezes exact named return composites and explains each
UUID, revision, digest, bounded enum, and pagination input; Task 9A transcribes it
into red fixtures without semantic changes. Request derives organization, actor,
dashboard lifecycle, policy, and immutable limits under locks; callers do not
submit tenant, role, budget, provider, price, or lease values. `purpose` is exactly
`suggest` or `replay`; `replay_source_run_id` must be null for Suggest and a current-
authority source run for replay. Reads use fixed bounded pagination and non-leaking
denial. Replay request succeeds only when the source state is exactly `approval_required`,
is currently authorized and unpurged, and has an exact valid source-result grammar of
3..5 contiguous results under section 3.1's one optional immediate retry rule, plus
exact pinned candidate-set/bundle/Brief artifacts. `rejected` (including abstention), `failed`, `cancelled`, and
`expired` sources deny; a repaired source is eligible only after it reaches
`approval_required` through the repair grammar below. Zero/one/two, over-five,
noncontiguous, wrong-kind, or head-drift sources deny before run creation.

`request_agent_run` has one closed duplicate path. After validating the current
tenant context and CSRF proof, it takes the organization/run-request advisory gate,
follows the global row-lock order, and reauthorizes the current actor, expected
dashboard lifecycle revision, locked input bytes/hash, and—when applicable—the exact
request-time source half of the replay-source fence. If
`(organization_id,run_request_id)` already exists, it locks
the unique `agent_runs` row and its exact request-payload row, requires the current
actor to equal the stored requesting user/membership/authority revision, recomputes
the idempotency digest from the incoming dashboard/input/request/purpose/expected-
lifecycle/expected-input/replay-source/deployment values, and requires both the
argument and the canonical request's persisted digest column to equal it. It also
parses the stored request bytes and requires exact dashboard, input ID/hash and
bytes, purpose, and replay fields; therefore digest, input, deployment, lifecycle,
purpose, or replay drift denies with no mutation. A retry's fresh audit UUID and
current CSRF proof authenticate the call but are not new semantic request fields and
are not inserted on this path.

An exact duplicate returns the original bounded request result reconstructed as the
stored run ID, literal initial `run_revision = 1`, literal initial
`state = 'requested'`, stored policy revision, and stored `request_sha256`, even when
the run's current projection has advanced. It inserts no request payload, run,
counter, event, payload, or audit row. It never returns the current run result as a
substitute for that initial response. Missing/null-cleared request linkage, deleted
request bytes after governed content purge, final metadata age-out, inaccessible
lifecycle, stale requester authority, or an inaccessible/drifted replay source is a
non-leaking denial rather than idempotent success. A new request performs the same
locks and comparisons before its sole insert path; unique-violation recovery is not
an alternate idempotency protocol. Existing-identity digest/input/deployment/
expected-lifecycle/purpose/replay drift normalizes to `P1002`; missing, purged, or
currently unauthorized tenant/source state normalizes to `P1001`.

`cancel_agent_run` has the separate exact durable replay path in section 4.3. Its
`audit_event_id` argument is the operation UUID, not a fresh audit UUID on retry.
After syntactic context/CSRF validation it takes the cancel-operation advisory gate,
performs the unique-index lookup, and either returns the exact stored mutation result
after current reauthorization and digest/event verification with zero DML, or—only
when absent—continues to the ordinary expected-revision cancellation. A caller must
retry with the same CSRF key version/digest and deployment revision that participated
in the first digest; refreshed CSRF material is a different operation binding and is
denied for the retained ID. The wrapper therefore retains the call's validated
arguments for an exact transport retry and never silently substitutes fresh CSRF
values under the same operation UUID. A found operation can never fall through to
cancel a second run.

Operator functions are owned by `dasher_run_definer`, executable only by
`dasher_run_operator`, and receive/return fixed typed scalars/composites—not a
JSON operation envelope. Every one is `VOLATILE SECURITY DEFINER`, has
`SET search_path = pg_catalog`, verifies
`current_user = 'dasher_run_definer'`, and is phase-7 catalog/body-hash inventoried:

- `dasher_run_api.claim_agent_run(uuid, integer)`;
- `dasher_run_api.get_claimed_agent_run_input(uuid, bigint, bytea)`;
- `dasher_run_api.clone_claimed_replay_prerequisites(uuid, bigint, bytea)`;
- `dasher_run_api.list_claimed_replay_results(uuid, bigint, bytea, bigint, integer)`;
- `dasher_run_api.consume_agent_replay_result(uuid, bigint, bytea, bigint, bytea)`;
- `dasher_run_api.write_agent_run_checkpoint(uuid, bigint, bytea, bigint, bytea, bytea)`;
- `dasher_run_api.commit_agent_brief(uuid, bigint, bytea, uuid, bytea)`;
- `dasher_run_api.commit_common_evidence_bundle(uuid, bigint, bytea, uuid, bytea)`;
- `dasher_run_api.reserve_agent_run_attempt(uuid, bigint, bytea, uuid, text, text,
dasher_run_api.attempt_resource_vector, bytea)`;
- `dasher_run_api.start_agent_run_attempt(uuid, bigint, bytea, uuid, bytea)`;
- `dasher_run_api.authorize_agent_run_attempt_invocation(uuid, bigint, bytea, uuid,
bytea)`;
- `dasher_run_api.reconcile_agent_run_attempt(uuid, bigint, bytea, uuid, text,
bytea, bytea, bytea)`;
- `dasher_run_api.release_agent_run_attempt(uuid, bigint, bytea, uuid, text, bytea)`;
- `dasher_run_api.commit_calculation_graph(uuid, bigint, bytea, uuid, bytea, bytea,
dasher_run_api.calculation_meter_vector_v1, bytea)`;
- `dasher_run_api.commit_agent_validation_findings(uuid, bigint, bytea, uuid,
bytea)`;
- `dasher_run_api.commit_agent_candidate(uuid, bigint, bytea, uuid, bytea, bytea,
uuid, bytea, bytea)`;
- `dasher_run_api.close_agent_candidate_set(uuid, bigint, bytea, bytea)`;
- `dasher_run_api.commit_candidate_claims(uuid, bigint, bytea, uuid, bytea)`;
- `dasher_run_api.commit_candidate_manifest(uuid, bigint, bytea, uuid, bytea, bytea)`;
- `dasher_run_api.commit_run_abstention(uuid, bigint, bytea, uuid, bytea)`;
- `dasher_run_api.finalize_agent_run_ranking(uuid, bigint, bytea, uuid, uuid, bytea)`; and
- `dasher_run_api.finish_agent_run(uuid, bigint, bytea, uuid, text, bytea)`.

For that three-trailing-`bytea` reconcile signature, the ordered semantic names are
exactly `actual_accounting_bytes`, `result_sha256`, and
`canonical_recorded_result_bytes`. Task 9A's signature, `pg_proc` identity,
function-registry/body-hash preimage, source fixture, and no-overload assertion use
that `bytea` signature plus the frozen parser schema, 1,024-byte cap, literal key
order, and SQLSTATE allowlist; no fixture may retain the former composite argument.

The reviewed argument/return matrix is part of this plan and precedes SQL. Names in
parentheses are semantic argument names in signature order; implementation may not
reassign an indistinguishable UUID/text/digest. Task 9A transcribes these exact composite
types and attribute types (all nonnull unless explicitly described):

- `dasher_api.agent_run_request_result(run_id uuid, run_revision bigint, state text,
policy_revision bigint, request_sha256 bytea)`;
- `dasher_api.agent_run_mutation_result(run_id uuid, run_revision bigint, state text,
event_sequence bigint, event_sha256 bytea)`;
- `dasher_api.agent_run_summary(run_id uuid, dashboard_id uuid, state text,
run_revision bigint, policy_revision bigint, requested_at timestamptz,
 terminal_at timestamptz, latest_event_sequence bigint,
 latest_checkpoint_revision bigint, selected_candidate_id uuid)`; the last three
  semantic optionals `terminal_at`, `latest_checkpoint_revision`, and
  `selected_candidate_id` use SQL NULL only when their condition does not exist;
- `dasher_api.agent_run_event_summary(run_id uuid, event_sequence bigint,
event_kind text, occurred_at timestamptz, event_sha256 bytea,
payload_available boolean)`;
- `dasher_api.agent_run_checkpoint_result(found boolean, run_id uuid,
checkpoint_revision bigint, source_event_sequence bigint,
source_event_sha256 bytea, state_sha256 bytea, checkpoint_sha256 bytea,
canonical_checkpoint_bytes bytea)`; all fields after `run_id` are NULL exactly
  when `found = false`; authorized app reads are denied after purge rather than
  returning a header without bytes. Before purge, `state_sha256` is the semantic
  reducer-state digest and `checkpoint_sha256` is the nonce-bearing envelope digest;
  neither is an alias for the other;
- `dasher_api.agent_candidate_result(found boolean, run_id uuid, candidate_id uuid,
run_state text, candidate_sha256 bytea, common_bundle_sha256 bytea,
manifest_sha256 bytea, rank integer, selected boolean,
canonical_candidate_bytes bytea, canonical_manifest_bytes bytea)`; candidate
  identity/state/spec/bundle/selected/spec-bytes are nonnull when `found = true`;
  manifest fields are NULL until manifest commit and rank is NULL until ranking;
  every field after `run_id` is NULL when `found = false`, and purge/lifecycle denial
  does not return a partially redacted candidate;
- `dasher_run_api.run_mutation_result(run_id uuid, run_revision bigint, state text,
event_sequence bigint, event_sha256 bytea, lease_epoch bigint)`;
- `dasher_run_api.agent_run_claim_result(status text, organization_id uuid,
dashboard_id uuid, run_id uuid, run_revision bigint, state text,
lease_epoch bigint, attempt_token bytea, lease_expires_at timestamptz,
policy_revision bigint, input_sha256 bytea)`; for `claimed`, every field is
  nonnull; for `terminalized_indeterminate`, organization/dashboard/run/revision/
  state/lease-epoch/policy are nonnull while token/expiry/input are NULL; for
  `no_eligible_run`, only `status` is nonnull;
- `dasher_run_api.claimed_run_input_result(run_id uuid, purpose text,
evaluation_time timestamptz, policy_revision bigint, input_snapshot_id uuid,
input_sha256 bytea, input_row_count bigint, field_catalog_snapshot_id uuid,
metric_contract_set_id uuid, metric_contract_set_sha256 bytea,
generation_limit_vector
dasher_run_api.attempt_resource_vector, review_limit_vector
dasher_run_api.attempt_resource_vector, replay_source_run_id uuid,
replay_source_result_count integer, replay_source_head_sequence bigint,
replay_source_head_sha256 bytea, replay_source_candidate_set_sha256 bytea,
replay_source_bundle_id uuid, replay_source_bundle_sha256 bytea,
replay_source_brief_id uuid, replay_source_brief_sha256 bytea,
replay_source_selected_candidate_id uuid,
canonical_input_bytes bytea, canonical_request_bytes bytea)`; all replay-source
  fields are NULL exactly for `purpose = 'suggest'` and nonnull for
  `purpose = 'replay'`; canonical input bytes are the exact validated existing
  `source_snapshots.canonical_bytes` and exact nested request object bytes. Canonical
  request bytes are self-contained and include that bounded input table, catalog
  entries, metric-contract definitions, non-vector policy limits, evaluation time,
  and replay binding whose typed IDs/hashes are returned separately;
- `dasher_run_api.replay_prerequisite_result(mutation
dasher_run_api.run_mutation_result, source_run_id uuid, bundle_id uuid,
bundle_sha256 bytea, brief_id uuid, brief_sha256 bytea)`;
- `dasher_run_api.replay_source_result(source_run_id uuid,
source_result_sequence bigint, source_result_sha256 bytea, result_kind text,
canonical_result_bytes bytea)`; pagination is ascending source sequence and
  returns only the request-pinned source head;
- `dasher_run_api.checkpoint_commit_result(mutation
dasher_run_api.run_mutation_result, checkpoint_revision bigint,
state_sha256 bytea, checkpoint_sha256 bytea)` and
  `dasher_run_api.content_commit_result(mutation
dasher_run_api.run_mutation_result, object_id uuid, content_sha256 bytea)`;
- `dasher_run_api.attempt_reservation_result(mutation
dasher_run_api.run_mutation_result, attempt_id uuid, reserved_vector
dasher_run_api.attempt_resource_vector)`;
- `dasher_run_api.attempt_start_result(mutation
dasher_run_api.run_mutation_result, attempt_id uuid,
dispatch_ready_at timestamptz)`;
- `dasher_run_api.attempt_invocation_result(mutation
dasher_run_api.run_mutation_result, attempt_id uuid, status text,
invocation_authorized_at timestamptz)`; status is exactly
  `authorized_now|already_authorized` and every field is nonnull on success; denial
  raises normalized `P1001|P1002`, commits no event/state, and returns no row;
- `dasher_run_api.attempt_accounting_result(mutation
dasher_run_api.run_mutation_result, attempt_id uuid, attempt_state text,
reserved_vector dasher_run_api.attempt_resource_vector, used_vector
dasher_run_api.attempt_resource_vector, released_vector
dasher_run_api.attempt_resource_vector, outstanding_vector
dasher_run_api.attempt_resource_vector)`;
- `dasher_run_api.calculation_commit_result(mutation
dasher_run_api.run_mutation_result, graph_id uuid, result_id uuid, graph_sha256
bytea, result_sha256 bytea, meter_vector
dasher_run_api.calculation_meter_vector_v1)`; `result_id` is the deterministic
  UUID of the one `calculation_results` row inserted in the same transaction and is
  the result identity Claims bind as `calculation_result_id`; a calculated Claim
  additionally carries and validates its exact node/output/row/cell/value identity;
- `dasher_run_api.replay_consume_result(mutation
dasher_run_api.run_mutation_result, source_result_sequence bigint,
source_result_sha256 bytea, replay_result_id uuid)`; `replay_result_id` is exactly the
  source row's `result_id`, legal because result uniqueness is run-scoped; the local
  row preserves source canonical bytes and has null local attempt/payload origin;
- `dasher_run_api.validation_findings_result(mutation
dasher_run_api.run_mutation_result, candidate_id uuid, finding_count integer,
findings_sha256 bytea, validation_state text)`;
- `dasher_run_api.candidate_set_result(mutation
dasher_run_api.run_mutation_result, candidate_ids uuid[], candidate_count integer,
candidate_set_sha256 bytea)`;
- `dasher_run_api.claim_set_result(mutation dasher_run_api.run_mutation_result,
candidate_id uuid, claim_count integer, edge_count integer,
claim_set_sha256 bytea)`; and
- `dasher_run_api.ranking_result(mutation dasher_run_api.run_mutation_result,
selected_candidate_id uuid, ordered_candidate_ids uuid[], ordered_ranks integer[],
ranking_sha256 bytea)`.

Every nonnull digest/token is exactly 32 bytes; candidate/rank arrays are bounded to
two, equal-length, unique, and ordered. `0007` grants only the exact schema/type
`USAGE` needed by each caller and revokes all type/function access from every other
runtime role.

The exact functions use those return identities:

| Function                                 | Argument meaning                                                                                                                                                                                                                                                                                                                                                                        | Named return                                                                                                                                                                                                                                                                                                                                 | Locked/mutated authority                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_agent_run`                      | `(dashboard_id, input_snapshot_id, run_request_id, purpose, expected_lifecycle_revision, expected_input_sha256, idempotency_sha256, audit_event_id, current_csrf_key_version, current_csrf_digest, deployment_revision, replay_source_run_id)`                                                                                                                                          | `dasher_api.agent_run_request_result`                                                                                                                                                                                                                                                                                                        | Full actor/CSRF context; serializes the organization/run-request identity, locks active editor/admin membership, policy/dashboard/input and optional replay source. New identity inserts request payload, run with requester identity/revision, vectors, audit, `run_requested`; exact duplicate returns the original five-field result with zero DML.                                                                                                                                                                                               |
| `cancel_agent_run`                       | `(run_id, expected_run_revision, canonical_cancel_reason_bytes, cancel_operation_and_audit_id, current_csrf_key_version, current_csrf_digest, deployment_revision)`                                                                                                                                                                                                                     | `dasher_api.agent_run_mutation_result`                                                                                                                                                                                                                                                                                                       | Current actor/CSRF plus global cancel-operation gate/lookup and dashboard/run. Exact retained-operation retry reauthorizes and returns the stored revision/event result with zero DML; fresh identity settles pre-invocation attempts by full release and dispatched attempts by the exact indeterminate candidate-field exception, increments lease epoch, clears claim, stores all six durable cancel fields, writes the digest-bound audit and `run_cancelled`.                                                                                   |
| `get_agent_run`                          | `(run_id)`                                                                                                                                                                                                                                                                                                                                                                              | `dasher_api.agent_run_summary`                                                                                                                                                                                                                                                                                                               | Current actor/dashboard/run ordinary read; no lock/mutation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `list_agent_run_events`                  | `(run_id, after_sequence, limit)`, `0 <= after_sequence`, `1 <= limit <= 100`                                                                                                                                                                                                                                                                                                           | `SETOF dasher_api.agent_run_event_summary`                                                                                                                                                                                                                                                                                                   | Current actor/dashboard/run ordinary read; no payload after lifecycle denial.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_agent_run_checkpoint`               | `(run_id)`                                                                                                                                                                                                                                                                                                                                                                              | `dasher_api.agent_run_checkpoint_result`                                                                                                                                                                                                                                                                                                     | Current actor/dashboard/run ordinary read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `get_agent_candidate`                    | `(run_id, candidate_id)`                                                                                                                                                                                                                                                                                                                                                                | `dasher_api.agent_candidate_result`                                                                                                                                                                                                                                                                                                          | Current actor/dashboard/run/candidate read; never a version/head.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `claim_agent_run`                        | `(claim_request_id, lease_seconds)`, `1 <= lease_seconds <= 900`                                                                                                                                                                                                                                                                                                                        | discriminated `dasher_run_api.agent_run_claim_result(status, organization_id, dashboard_id, run_id, run_revision, state, lease_epoch, attempt_token, lease_expires_at, policy_revision, input_sha256)`; token/expiry/input nonnull only for ordinary `claimed`; status exactly `claimed`, `terminalized_indeterminate`, or `no_eligible_run` | Latest principal bootstrap, then global event-header operation-ID lookup before eligible discovery. Every committed ordinary/mixed result writes the unique kind/ID/input/result identity; exact replay reauthorizes, verifies immutable headers nonlockingly after the run lock, reconstructs the original typed composite (including the ordinary token), and performs zero DML.                                                                                                                                                                   |
| `get_claimed_agent_run_input`            | `(run_id, lease_epoch, attempt_token)`                                                                                                                                                                                                                                                                                                                                                  | `dasher_run_api.claimed_run_input_result`                                                                                                                                                                                                                                                                                                    | `read_input`; locks/revalidates requester membership, policy/dashboard/run/lease and payload/catalog/contracts; returns bounded durable input only, no mutation/event.                                                                                                                                                                                                                                                                                                                                                                               |
| `clone_claimed_replay_prerequisites`     | `(run_id, lease_epoch, attempt_token)`                                                                                                                                                                                                                                                                                                                                                  | `dasher_run_api.replay_prerequisite_result`                                                                                                                                                                                                                                                                                                  | `clone_replay`; replay `authorized` only; copies no caller bytes: locks/revalidates the request-pinned source fence, clones its exact bundle/membership and Brief bytes/IDs/hashes into the local run, appends `replay_prerequisites_cloned`, and moves to `planning`. Exact retry is a no-op after the same fence.                                                                                                                                                                                                                                  |
| `list_claimed_replay_results`            | `(run_id, lease_epoch, attempt_token, after_source_sequence, limit)`, `0 <= after_source_sequence`, `1 <= limit <= 5`                                                                                                                                                                                                                                                                   | `SETOF dasher_run_api.replay_source_result`                                                                                                                                                                                                                                                                                                  | `read_replay`; replay-purpose planning only after frozen common bundle and Brief; locks/revalidates bound source/head and bundle header, freshly revalidates nonlocking membership, and returns immutable recorded-result bytes in source sequence order, no mutation/event.                                                                                                                                                                                                                                                                         |
| `consume_agent_replay_result`            | `(run_id, lease_epoch, attempt_token, source_result_sequence, source_result_sha256)`                                                                                                                                                                                                                                                                                                    | `dasher_run_api.replay_consume_result`                                                                                                                                                                                                                                                                                                       | `consume_replay`; replay-purpose only; copies the exact pinned source result into the replay run and appends `replay_result_consumed`; no attempt, dispatch, reservation, call, token, time, or cost meter changes.                                                                                                                                                                                                                                                                                                                                  |
| `write_agent_run_checkpoint`             | `(run_id, lease_epoch, attempt_token, source_event_sequence, source_event_sha256, canonical_checkpoint_bytes)`                                                                                                                                                                                                                                                                          | `dasher_run_api.checkpoint_commit_result`                                                                                                                                                                                                                                                                                                    | `checkpoint`; fenced run/event head; under checkpoint-only payload-read phase verifies/replays exact event headers and bodies from 1 through source head, derives semantic `state_sha256` then envelope `checkpoint_sha256`, inserts both on checkpoint/payload plus `checkpoint_written`, and returns both names.                                                                                                                                                                                                                                   |
| `commit_agent_brief`                     | `(run_id, lease_epoch, attempt_token, brief_id, canonical_brief_bytes)`                                                                                                                                                                                                                                                                                                                 | `dasher_run_api.content_commit_result`                                                                                                                                                                                                                                                                                                       | Suggest only; fenced `planning` run/shared bundle, exact successful planner result; inserts one immutable Brief and `brief_committed`. Replay always denies and uses the clone function.                                                                                                                                                                                                                                                                                                                                                             |
| `commit_common_evidence_bundle`          | `(run_id, lease_epoch, attempt_token, bundle_id, canonical_bundle_bytes)`                                                                                                                                                                                                                                                                                                               | `dasher_run_api.content_commit_result`                                                                                                                                                                                                                                                                                                       | Suggest only; fenced current evidence in `authorized`, before planner reservation; inserts one exact source-derived bundle and event. Replay always denies and uses the clone function.                                                                                                                                                                                                                                                                                                                                                              |
| `reserve_agent_run_attempt`              | `(run_id, lease_epoch, attempt_token, attempt_id, partition, attempt_kind, reserved_vector, canonical_request_bytes)`                                                                                                                                                                                                                                                                   | `dasher_run_api.attempt_reservation_result`                                                                                                                                                                                                                                                                                                  | Fenced run/policy/counters and complete next-kind/slot/retry grammar; only the exact one/two-slot generator batch or same-slot retry may coexist reserved. Repair requires zero candidates/set, no queued slot, and bound invalid result/validation/bundle. Reviewer requires the frozen set and every candidate's findings plus complete derived claim set.                                                                                                                                                                                         |
| `start_agent_run_attempt`                | `(run_id, lease_epoch, attempt_token, attempt_id, dispatch_request_sha256)`                                                                                                                                                                                                                                                                                                             | `dasher_run_api.attempt_start_result`                                                                                                                                                                                                                                                                                                        | `dispatch`; exact lowest unresolved reserved attempt/request after adapter setup, with no occupied dispatch lane; digest must match; one-way `dispatch_ready`, event `attempt_dispatch_prepared`; this is not invocation authority.                                                                                                                                                                                                                                                                                                                  |
| `authorize_agent_run_attempt_invocation` | `(run_id, lease_epoch, attempt_token, attempt_id, dispatch_request_sha256)`                                                                                                                                                                                                                                                                                                             | `dasher_run_api.attempt_invocation_result`                                                                                                                                                                                                                                                                                                   | `dispatch`; fresh full authority/policy/lease/budget/request fence immediately before invocation; only `authorized_now` moves `dispatch_ready -> dispatch_started` and emits `attempt_dispatch_started`. Exact replay returns `already_authorized` and must not call; denial performs no mutation and no provider call.                                                                                                                                                                                                                              |
| `reconcile_agent_run_attempt`            | `(run_id, lease_epoch, attempt_token, attempt_id, outcome, actual_accounting_bytes, result_sha256, canonical_recorded_result_bytes)`; all trailing arguments are nonnull for caller-claimed determinate outcomes, while all three are SQL NULL exactly for explicit `indeterminate`; `actual_accounting_bytes` is unchanged bounded raw wire data, and no `reason_code` argument exists | `dasher_run_api.attempt_accounting_result`                                                                                                                                                                                                                                                                                                   | Exact dispatched attempt/counters. Explicit indeterminate maps first to `caller_indeterminate`. The function parses the frozen byte grammar, constructs the typed local, validates internal equations, then compares reservation: malformed maps to `malformed_accounting`, equation-valid excess maps to `actual_over_reservation`, and only normal determinate inserts result and stores/uses the derived typed actual/reserved-minus-actual. Every indeterminate branch stores no actual/result/raw bytes and applies the candidate-only release. |
| `release_agent_run_attempt`              | `(run_id, lease_epoch, attempt_token, attempt_id, reason, release_proof_sha256)`                                                                                                                                                                                                                                                                                                        | `dasher_run_api.attempt_accounting_result`                                                                                                                                                                                                                                                                                                   | Only `reserved_pre_dispatch\|dispatch_ready`; one pre-invocation release and `attempt_released`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `commit_calculation_graph`               | `(run_id, lease_epoch, attempt_token, graph_id, canonical_graph_bytes, canonical_result_bytes, meter_vector, expected_input_sha256)`                                                                                                                                                                                                                                                    | `dasher_run_api.calculation_commit_result`                                                                                                                                                                                                                                                                                                   | Fenced run/catalog/contracts/bundle/input/evidence; inserts graph, deterministic result/payload, meters, `calculation_graph_committed`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `commit_agent_validation_findings`       | `(run_id, lease_epoch, attempt_token, candidate_id, canonical_findings_bytes)`                                                                                                                                                                                                                                                                                                          | `dasher_run_api.validation_findings_result`                                                                                                                                                                                                                                                                                                  | `commit_validation`; validating candidate in frozen set and exact spec hash; rederives material count/set, derives finding count/state, inserts one closed immutable set/event; no provider result write.                                                                                                                                                                                                                                                                                                                                            |
| `commit_agent_candidate`                 | `(run_id, lease_epoch, attempt_token, candidate_id, canonical_dashboard_spec_bytes, common_bundle_sha256, source_result_id, source_result_sha256, precommit_validation_sha256)`                                                                                                                                                                                                         | `dasher_run_api.content_commit_result`                                                                                                                                                                                                                                                                                                       | Fenced run, validated graph/results, Brief/shared bundle and exact successful generator/repair result; exact embedded validation must be `valid`; trusted code/SQL derives and stores 1..64 material claims/count/hash; inserts one of at most two private candidates/event; no state advance.                                                                                                                                                                                                                                                       |
| `close_agent_candidate_set`              | `(run_id, lease_epoch, attempt_token, ordered_candidate_set_sha256)`                                                                                                                                                                                                                                                                                                                    | `dasher_run_api.candidate_set_result`                                                                                                                                                                                                                                                                                                        | Requires one/two immutable candidates with same bundle and independently rederived nonempty bounded material sets; freezes set, moves to validation, writes event.                                                                                                                                                                                                                                                                                                                                                                                   |
| `commit_candidate_claims`                | `(run_id, lease_epoch, attempt_token, candidate_id, canonical_claim_edge_set_bytes)`                                                                                                                                                                                                                                                                                                    | `dasher_run_api.claim_set_result`                                                                                                                                                                                                                                                                                                            | Validating candidate/shared bundle/evidence; re-extracts material set and requires exact one-to-one IDs/pointers/assertion hashes and allowed states before inserting Claims/edges/event.                                                                                                                                                                                                                                                                                                                                                            |
| `commit_candidate_manifest`              | `(run_id, lease_epoch, attempt_token, candidate_id, canonical_manifest_bytes, reviewer_result_sha256)`                                                                                                                                                                                                                                                                                  | `dasher_run_api.content_commit_result`                                                                                                                                                                                                                                                                                                       | Validating candidate/spec-bound findings/Claims/evidence/review; re-extracts material set and requires every claim/edge exactly manifested; inserts one manifest/event; stays validating.                                                                                                                                                                                                                                                                                                                                                            |
| `commit_run_abstention`                  | `(run_id, lease_epoch, attempt_token, terminal_operation_id, canonical_abstention_bytes)`                                                                                                                                                                                                                                                                                               | `dasher_run_api.content_commit_result`                                                                                                                                                                                                                                                                                                       | Any claimed nonterminal with no eligible final candidate and no outstanding attempt; stores terminal operation identity/hash, inserts abstention, enters `rejected`, clears/fences lease.                                                                                                                                                                                                                                                                                                                                                            |
| `finalize_agent_run_ranking`             | `(run_id, lease_epoch, attempt_token, terminal_operation_id, selected_candidate_id, ranking_proof_sha256)`                                                                                                                                                                                                                                                                              | `dasher_run_api.ranking_result`                                                                                                                                                                                                                                                                                                              | Re-extracts every material set and requires exact findings/one-to-one claims/all-claim manifests/review, same bundle, complete factual/calculated support, complete contracts, no outstanding attempt; stores terminal identity/hash/ranks, enters `approval_required`, clears lease.                                                                                                                                                                                                                                                                |
| `finish_agent_run`                       | `(run_id, lease_epoch, attempt_token, terminal_operation_id, terminal_outcome, canonical_reason_bytes)`                                                                                                                                                                                                                                                                                 | `dasher_run_api.run_mutation_result`                                                                                                                                                                                                                                                                                                         | Fenced run/no outstanding attempts; stores terminal operation identity/hash, enters only `rejected`, `cancelled`, `expired`, or `failed`, writes `run_finished`.                                                                                                                                                                                                                                                                                                                                                                                     |

Each operator operation-specific composite has `mutation` as its first attribute,
exactly the nested `dasher_run_api.run_mutation_result` above, followed only by its
listed attributes. `dasher_api.agent_run_mutation_result` is the separate tenant-
cancel result and intentionally has no worker lease attribute. No return is flattened
or gains an unlisted field.
Every composite type receives exact `USAGE` and function-result ACL inventory; no
JSON catch-all or caller-selected field name substitutes for a typed vector.
Malformed inputs deny before connection where possible. Database nonexistence,
cross-tenant identity, capability, and lifecycle denials normalize to `P1001`;
stale revision/lease/event head, duplicate non-idempotent operation, or budget race
normalizes to `P1002`. Neither exposes SQL, constraints, existence, tenant IDs,
payloads, credential names, or provider errors.

The state/event transition matrix is closed:

| Owning fixed function                                                  | Source                                                                                             | Target                                          | Event kind and projection change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_agent_run` new identity                                       | none                                                                                               | `requested`                                     | `run_requested`; initialize immutable bindings/vectors and sequence 1, including the persisted request-idempotency digest. Exact duplicate is a zero-event return path, not a transition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `claim_agent_run` normal                                               | `requested`                                                                                        | `authorized`                                    | `lease_acquired`; set epoch/token hash/composite owner/expiry and return `claimed`. Payload and retained event claim projection fix request ID, ordinary input/result digests, prior/new epoch, owner principal ID/revision/hash, expiry, mode `normal`, and the exact typed result. The token bytes occur only in the protected claim-result header projection, never the semantic event body or tenant event listing.                                                                                                                                                                                                                                        |
| `claim_agent_run` resume                                               | `authorized`, `planning`, `generating`, `validating`, or `revising`                                | same                                            | `lease_acquired`; replace fenced lease only after takeover checks. Same payload/result projection with mode `resume` or `takeover`, exact prior epoch, and current database-bound principal hash. The claim mode vocabulary is closed to exactly `normal`, `resume`, and `takeover`; the globally unique claim ID can later replay only this original result.                                                                                                                                                                                                                                                                                                  |
| `claim_agent_run` determinate pre-invocation takeover                  | expired claimed nonterminal with only prior-epoch `reserved_pre_dispatch\|dispatch_ready` attempts | same                                            | In ascending attempt ID, release/event each; only then increment epoch and append `lease_acquired`. Return `claimed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `claim_agent_run` mixed/indeterminate takeover                         | expired claimed nonterminal with at least one `dispatch_started` attempt                           | `failed`                                        | Capture the locked source head; in one ascending attempt-ID walk release every pre-invocation attempt and settle every dispatched attempt with `attempt_indeterminate(reason_code=takeover_after_dispatch)` and the exact candidate-field exception; compute settlement/terminal-input/operation/claim-result digests in the section 4.3 acyclic order; append the globally unique bound aggregate `indeterminate_quarantined`, increment/fence epoch, clear lease, and store terminal kind/ID/input SHA/operation SHA before returning `terminalized_indeterminate` with no token or `lease_acquired`. Exact retained-operation retry is zero-event/zero-DML. |
| `clone_claimed_replay_prerequisites`                                   | replay `authorized`                                                                                | `planning`                                      | `replay_prerequisites_cloned`; atomically clones the request-pinned exact source bundle/membership and Brief with no caller semantic bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `consume_agent_replay_result` first-through-penultimate result         | replay `planning`                                                                                  | `planning`                                      | `replay_result_consumed`; require next source sequence/hash and change no resource counter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `consume_agent_replay_result` final result                             | replay `planning`                                                                                  | `generating`                                    | `replay_result_consumed`; require frozen bundle and Brief and prove consumed count/head equal the request-pinned source result count/head, enabling ordinary graph/candidate commits with no attempt or dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reserve_agent_run_attempt(..., 'planner')`                            | first: `authorized`; immediate legal retry: `planning`                                             | `planning`                                      | `attempt_reserved`; first planner advances the macro phase, its sole permitted retry preserves it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `reserve_agent_run_attempt(..., 'generator' or 'specialist')`          | first: `planning`; later legal Brief slot/retry step: `generating`                                 | `generating`                                    | `attempt_reserved`; the optional specialist is unqueued and precedes generators; the initial generator batch reserves exact slots in ascending order, and a legal same-slot retry/later slot preserves the macro phase. Only start/authorize, never reservation, occupies the one dispatch lane.                                                                                                                                                                                                                                                                                                                                                               |
| `reserve_agent_run_attempt(..., 'reviewer')`                           | `validating`                                                                                       | `validating`                                    | `attempt_reserved`; review reservation/vector.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reserve_agent_run_attempt(..., 'repair')`                             | `generating`                                                                                       | `revising`                                      | `attempt_reserved`; exactly one precommit repair, requiring zero durable candidates/set, one deterministic invalid slot-1 generator result, and all later queued slots already released.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `start_agent_run_attempt`                                              | matching claimed nonterminal                                                                       | same                                            | `attempt_dispatch_prepared`; attempt becomes `dispatch_ready`, no invocation authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `authorize_agent_run_attempt_invocation`                               | matching claimed nonterminal                                                                       | same                                            | `attempt_dispatch_started`; exact `dispatch_ready` attempt becomes `dispatch_started`; the committing transaction is the invocation authorization point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reconcile_agent_run_attempt` determinate                              | matching claimed nonterminal                                                                       | same                                            | Parse bounded `actual_accounting_bytes`, construct the typed vector, validate equations, then compare reservation; `attempt_reconciled` atomically records the result and derived typed terminal accounting. `candidates=1` means exactly a valid candidate-producing generator/repair result; candidate insertion later has zero accounting DML.                                                                                                                                                                                                                                                                                                              |
| `reconcile_agent_run_attempt` indeterminate/malformed/over-reservation | matching claimed nonterminal                                                                       | `failed`                                        | `attempt_indeterminate` with respectively exact database-derived `caller_indeterminate`, `malformed_accounting`, or `actual_over_reservation`; no stored actual vector, raw bytes, or recorded-result payload, full noncandidate charge, exact candidate-field release, then increment/fence epoch and clear lease.                                                                                                                                                                                                                                                                                                                                            |
| `release_agent_run_attempt`                                            | matching claimed nonterminal                                                                       | same                                            | `attempt_released`; attempt/vector only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `write_agent_run_checkpoint`                                           | any claimed nonterminal                                                                            | same                                            | `checkpoint_written`; semantic state digest, envelope checkpoint digest, payload, and latest pointer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `commit_agent_brief`                                                   | `planning`                                                                                         | `planning`                                      | `brief_committed`; Brief only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `commit_common_evidence_bundle`                                        | Suggest `authorized` before planner                                                                | `authorized`                                    | `common_bundle_committed`; one shared source-derived bundle. Replay denies and uses `clone_claimed_replay_prerequisites`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `commit_calculation_graph`                                             | `generating` or `revising`                                                                         | same                                            | `calculation_graph_committed`; graph/result/meter rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `commit_agent_validation_findings`                                     | `validating`                                                                                       | same                                            | `candidate_validation_findings_committed`; immutable candidate/spec-bound finding set only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `commit_agent_candidate`                                               | `generating` or `revising`                                                                         | same                                            | `candidate_committed`; one-to-one materialization of an already charged valid source result, candidate/payload only, no counter DML.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `close_agent_candidate_set`                                            | `generating` or `revising`                                                                         | `validating`                                    | `candidate_set_closed`; freezes one/two candidate IDs and shared bundle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `commit_candidate_claims`                                              | `validating`                                                                                       | `validating`                                    | `candidate_claims_committed`; Claims/edges only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `commit_candidate_manifest`                                            | `validating`                                                                                       | `validating`                                    | `candidate_manifest_committed`; manifest/review only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `commit_run_abstention`                                                | any claimed nonterminal except `approval_required`                                                 | `rejected`                                      | `run_abstained`; typed abstention and cleared/fenced lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `finalize_agent_run_ranking`                                           | `validating`                                                                                       | `approval_required`                             | `run_ranked`; immutable rank/selection and cleared lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `finish_agent_run`                                                     | any claimed nonterminal except `approval_required`                                                 | `rejected`, `cancelled`, `expired`, or `failed` | `run_finished`; terminal reason and cleared/fenced lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cancel_agent_run` or retention drain                                  | any nonterminal including `approval_required`                                                      | `cancelled`                                     | In ascending attempt ID, `attempt_cancelled_released` for pre-invocation or reasonless `attempt_cancelled_charged` with the exact indeterminate candidate-field exception for dispatched attempts; neither cancellation path emits `attempt_indeterminate` or invents a `reason_code`; then `run_cancelled` or `run_cleanup_cancelled`, zero outstanding, cleared/fenced lease. Fresh tenant cancel additionally stores its six operation/result fields and digest-bound audit; exact operation retry is a zero-event/zero-DML return path, not a transition.                                                                                                  |

No other event changes state, budgets, candidate validity, or authority. The private
append helper validates this exact owner/source/target/event/payload-schema row and
updates event plus projection atomically. It has INSERT authority only on event
payloads and cannot read historical bodies. Full event-1 reducer equivalence is
checked by the checkpoint writer under its narrower read profile and independently
again in PostgreSQL tests; ordinary transition bodies validate only their exact
prior projection/event head and emitted delta.

On takeover, `claim_agent_run` holds run/attempt/counter locks and freezes the
ascending prior-epoch nonterminal attempt list. For the all-pre-invocation case it
releases every `reserved_pre_dispatch|dispatch_ready` attempt and appends one
`attempt_released` per attempt with `release_mode=takeover` and
`release_proof_sha256` computed from the existing `dasher.attempt-release.v1`
preimage using that prior lease epoch and exact reason `takeover`, then mints the new
lease. The token hash is SHA-256
over domain `dasher.agent-run-lease-token.v1\0`, run UUID,
new signed-64-bit epoch, owner principal UUID, signed-64-bit owner principal revision,
and the minted 32 random token bytes encoded as a canonical-binary-v1 byte string, in
that order. The mutable run projection stores only this hash. The exact random token
is additionally stored once in the immutable protected `lease_acquired` claim-result
header projection solely so the same claim request can reconstruct its original
typed response; no tenant event listing, payload reader, general table grant, or
different claim ID can read it. An exact retry while active or after later expiry/
takeover returns that original historical response, appends nothing, and never
repeats release or selects another run. A different fresh claim request after expiry
follows the same takeover rules and creates its own unique claim event.

For a mixed set containing `dispatch_started`, it uses the same single ascending
walk. Pre-invocation attempts take the release branch above; each dispatched attempt
takes the indeterminate-settlement branch, charges every noncandidate field, releases
the candidate proof slot, and emits exactly
`attempt_indeterminate(reason_code=takeover_after_dispatch)` before the aggregate
quarantine event. The aggregate event's two ID arrays, componentwise vector sums,
prior/fenced epochs, settlement count/first/last sequence, and
`settlement_events_sha256` are recomputed from those just-written per-attempt rows/
events using the closed hash registry. Only then is the run failed and lease cleared.
The claim ID plus lease-seconds/principal/source event head are bound in the aggregate
event so exact terminalizing replay can return the prior outcome and any drift denies.
Triggers admit these transitions only inside `claim_agent_run`; reducer and Task 9F
fixtures cover zero/one/two pre-invocation attempts, zero/one dispatched attempt, and
both relative UUID orders for the reachable one-pre-invocation/one-dispatched mixed
set; rollback before/after every per-attempt and aggregate event; exact counts/hashes;
no stranded outstanding units; no double settlement; and
`reserved = used + released + outstanding` after retry.

Exact ordinary retry reads no canonical event body. It retains the claim-operation
advisory gate, tuple-locks the exact proven principal and policy key rows while
completing the existing global-order authority/lifecycle/dashboard locks, locks and
promotes the exact run, and only then performs a nonlocking SELECT of the named
immutable `lease_acquired` header. It verifies the header's nonpurged claim
fields, rederives the ordinary input and result digests, and requires the stored
result run revision/state/epoch/policy/token/expiry/input SHA to be exactly the
original `claimed` composite. The operation gate prevents a competing claim-ID
identity, the locked run fixes the promoted organization/dashboard/run identity and
excludes retention, and the insert-only header cannot be updated, reassigned, or
substituted. Therefore a header row lock adds no authority or integrity. This path
issues no event-row locking clause and receives no event UPDATE grant, lock-only
policy, or event-payload SELECT. It deliberately ignores later mutable run state,
lease owner/token hash/expiry, and event head except to require the same run identity
still exists and is currently authorized. It therefore returns byte-identical typed
claim data after a release, later claim, takeover, or terminal transition without
granting that historical token current authority. It selects no attempt, counter, or
event payload and writes nothing.

Exact mixed-takeover retry likewise reads no canonical event body. From the locked terminal
run it requires: state `failed`; nonnull terminal timestamp; all three lease owner/
token/expiry fields NULL; operation kind `indeterminate_takeover`; operation ID equal
the argument; stored input and operation digests both nonnull and 32 bytes; and
`lease_epoch > 0`. Let `prior_epoch = lease_epoch - 1`. The retry selects only that
run's complete attempt-header set in unsigned attempt UUID order and requires its
sum to equal every counter. The settlement subset is exactly the rows with
`lease_epoch = prior_epoch` and state
`released_takeover|indeterminate_quarantined`; it requires at least one quarantined
row, zero outstanding in each, and exact pre-invocation-release or indeterminate-
settlement vector equations, including the candidate-field exception. The
subset's checked count is `n`; the aggregate
event is the run's current head and the source sequence is checked
`current_event_sequence - n - 1`, which must be positive. The retry reads the source
header and exactly the following `n + 1` event headers, verifies contiguous sequence/
prior-hash adjacency, maps the first `n` kinds in attempt order to
`attempt_released|attempt_indeterminate`, requires the final kind
`indeterminate_quarantined`, requires its timestamp equal `terminal_at`, and requires
its sequence/hash equal the run current head; every selected event payload pointer
must still be nonnull. It recomputes the settlement digest
from those immutable event hashes and attempt vectors, then recomputes and compares
the operation digest from the section 4.3 preimage. The original body-to-attempt,
body-to-input/operation-digest, envelope, and header-hash equalities were enforced by
the fixed append/transition trigger in the original transaction; retry relies on
those immutable header/run commitments and receives no `agent_run_event_payloads`
SELECT policy or grant.

The retry's complete Task 9 read projection is limited to
`agent_runs(organization_id,dashboard_id,run_id,requesting_user_id,
requesting_membership_id,requesting_authority_revision,policy_revision,state,
run_revision,current_event_sequence,current_event_sha256,lease_epoch,
lease_token_sha256,lease_owner_principal_id,lease_owner_principal_revision,
lease_expires_at,terminal_at,terminal_operation_kind,terminal_operation_id,
terminal_claim_input_sha256,terminal_operation_sha256)`, the principal/policy/
membership/lifecycle/dashboard columns already enumerated for claim reauthorization,
`agent_run_attempts(attempt_id,lease_epoch,partition,state,reserved_vector,
used_vector,released_vector,outstanding_vector,reconciled_at)`,
`agent_run_budget_counters(partition,vector_field,limit_units,reserved_units,
used_units,released_units,updated_at)`, and
`agent_run_events(event_sequence,event_kind,occurred_at,prior_event_sequence,
prior_event_sha256,event_payload_id,event_sha256,claim_operation_kind,
claim_request_id,claim_input_sha256,claim_result_sha256,
claim_result_run_revision,claim_result_state,claim_result_lease_epoch,
claim_result_attempt_token,claim_result_lease_expires_at,
claim_result_policy_revision,claim_result_input_sha256)`. It returns literal status
`terminalized_indeterminate`, the stored organization/dashboard/run/run-revision/
state/lease-epoch/policy fields, and SQL NULL token/expiry/input fields. It writes no
row, advances no sequence, changes no counter, and cannot reconstruct or disclose
semantic payload bytes.

Structured repair never mutates or supersedes a durable candidate. It is available
exactly once while generating, after a reconciled generator result fails the strict
precommit `DashboardSpec` validator and before any `agent_candidates` row or
candidate-set hash exists. The repair reservation binds the invalid result ID/SHA,
validator ID/version, canonical invalid validation digest, Brief, and common bundle;
it moves to `revising`. The repaired determinate result may produce the first
immutable candidate only when `commit_agent_candidate` receives that repair result's
ID/SHA and its distinct canonical `valid` precommit digest. The candidate row stores
all three values; the fixed writer locks the repair attempt/result plus the invalid
source attempt/result and rederives the request bindings. A normal candidate likewise
binds its successful generator result ID/SHA and valid digest. Any fabricated,
original-invalid, cross-run, stale-validator, or unbound result denies. The repaired
determinate result may produce the first immutable candidate,
after which normal candidate commit/set close enters validation. Once any candidate
exists or the set is closed, repair reservation denies; validation/reviewer rejection
makes that candidate ineligible and never reopens the set. Candidate limits count
only valid reconciled candidate-producing outputs. The reconciliation transaction
atomically records and charges each such output before any `agent_candidates` insert;
the later candidate writer is an idempotent materialization keyed one-to-one by
`source_result_id` and charges/releases nothing. A crash or lease loss in between
therefore leaves one charged pending output that a later authorized claimant must
materialize from the same immutable result before advancing; revocation or terminal
denial leaves it charged and cannot convert it into a row or release. Replay copies
the same categorical result grammar but, as already required, touches no attempt
counter. One-repair tests prove no double charge, double materialization,
revision/supersession row, second repair, re-close drift, or old finding/manifest
ambiguity can exist.

For `claim_agent_run`, the UUID is the claim request/idempotency ID and the integer
is bounded lease seconds, as fixed in section 3.3. It performs global claim-operation
retry discovery and, only absent such an operation, eligible-run discovery
internally; it returns the only opaque run handle and no caller supplies a run
target. Each remaining signature's first UUID is the run ID from that handle.

No runtime role receives a generic event-append function or caller-selected event
kind. Each fixed transition function chooses its closed event kind and validates
its versioned payload. A private append helper has `EXECUTE` revoked from `PUBLIC`,
app, run operator, retention, and unrelated roles; it is reachable only from the
fixed SECURITY DEFINER bodies. After locking the run, that helper reads the current
projection hash, derives exactly `current_sequence + 1`, and atomically writes the
event plus projection pointer.

In Task 9, `finish_agent_run` accepts only `rejected`, `cancelled`, `expired`, or
`failed`. Only closed ranking finalization enters `approval_required` after every
candidate has Claims, manifest, review, and the shared bundle; no function accepts
`accepted`. The phase-7
transition trigger independently rejects that reserved transition even if a
caller bypasses repository validation.

Before SQL is authored, Task 9A may refine argument types only by updating this
plan through a separately reviewed docs correction. Implementation may not
silently invent overloads or broader signatures.

All app, run, and retention functions share one exhaustive cross-surface lock order:
principal-binding advisory gate -> optional claim-operation advisory gate
used only by `claim_agent_run` and keyed solely by `claim_request_id` -> optional
tenant-cancel-operation advisory gate used only by `cancel_agent_run` and keyed
solely by `cancel_operation_id` -> optional
fixed policy-seed advisory gate used only by first-request convergent insertion ->
organization advisory gate -> optional
organization/run-request advisory gate used only by `request_agent_run`, keyed by
the locked organization UUID and `run_request_id` -> applicable authority rows
(`memberships`, then `run_service_principal_allowlist`, then
`retention_service_principal_allowlist`) -> `dashboard_lifecycle_policies` ->
`agent_run_policy_revisions` -> `dashboards` -> `dashboard_legal_holds` ->
`dashboard_tombstones` -> `backup_deletion_ledger` -> `agent_runs` ->
`dashboard_versions` -> `source_snapshots` -> `evidence_records` ->
`field_catalog_snapshots` -> `field_catalog_entries` -> `metric_contract_versions` ->
`agent_run_request_payloads` -> `agent_run_events` ->
`agent_run_event_payloads` -> `agent_run_checkpoints` ->
`agent_run_checkpoint_payloads` -> `candidate_comparison_bundles` ->
`candidate_comparison_bundle_evidence` -> `briefs` ->
`agent_run_budget_counters` -> `agent_run_attempts` ->
`agent_run_attempt_payloads` -> `agent_recorded_results` ->
`calculation_graphs` -> `calculation_results` ->
`agent_run_calculation_meters` -> `agent_candidates` ->
`agent_candidate_payloads` -> `agent_validation_findings` -> `claims` ->
`claim_evidence` -> `candidate_evidence_manifests` -> `run_abstentions` ->
predecessor `dashboard_cleanup_attempts` ->
`dashboard_agent_drain_proofs` ->
`dashboard_agent_drain_proof_consumptions` ->
`dashboard_agent_run_age_out_proofs`. Within each relation, rows lock by
`organization_id`, then dashboard/run ID, then the relation primary-key columns in
ascending byte order. A function skips relations it does not use but never reorders
the remainder. At their listed positions, every run-definer promoted lock path uses
`SELECT ... FOR UPDATE` on exactly the proven
`run_service_principal_allowlist(run_service_principal_id,principal_revision)` and
`agent_run_policy_revisions(policy_revision)` rows. The principal/policy lock-only
policies and key-column grants add no other tuple lock or mutation authority; in
particular, ordinary retry's `agent_run_events` header reads remain nonlocking, and
its preexisting dashboard/run locks remain unchanged. A prior immutable nonlocking
lookup may discover only opaque gate IDs; every value is revalidated after locks. No
path locks a run before its dashboard. Event/payload rows are immutable nonlocking
reads in ascending event sequence after the run lock has frozen its head; their
position above governs joins and any future row-lock requirement.
`candidate_comparison_bundles` is row-locked at
its listed position through its exact key-only lock policy. Existing
`candidate_comparison_bundle_evidence` rows are deliberately nonlocking reads at the
immediately following position: the already locked run and bundle header freeze the
bundle ID/hash/positive `evidence_count`; insertion is closed after the original
bundle transaction; and the fixed body rereads all exactly counted members, re-encodes
the canonical entries, and rechecks the bundle digest immediately before any
dependent DML. Retention must acquire the same run and bundle-header locks before it
can delete those rows. These facts make substitution impossible without granting
UPDATE on immutable membership content. No fixed body issues a row-locking clause on
`candidate_comparison_bundle_evidence`, and Task 9 grants it no UPDATE column or
lock-only policy. Every purge/age-out body first locks every mutable/header row it
will update or delete in this order. The sole tuple-lock exception is the immutable
membership set: purge holds its run/bundle headers, performs the same immediate
count/digest/member revalidation, and then deletes the members without a row-locking
clause. Its separately frozen pointer-clear and
child-before-parent DML order runs only after that complete lock set is held and
therefore never becomes an alternate acquisition order. Inserts acquire no
preexisting tuple out of order. The organization/run-request advisory gate
serializes both absent and existing unique request identities and is never taken by
cancel/read/operator/retention functions. The existing cleanup coordination lease
row remains the outermost lock
and is outside operator reach; after it, cleanup follows this same order. The
predecessor `dashboard_cleanup_attempts` position is exhaustive: claim,
record-attempt, purge, drain completion-proof verification, and age-out lock all
existing target-dashboard attempt rows by
`organization_id,dashboard_id,started_at,cleanup_attempt_id` at that position,
before any drain proof or consumption. A future-attempt ID that has no row at drain
time acquires no tuple lock; the later record body first locks existing cleanup
attempts at this position, then the named drain proof/consumption, and only then
inserts the new attempt. Child-first deletion remains a post-acquisition DML order
and never reverses these locks.

Bootstrap/discovery has exact non-mutating policy seams:

- `run_service_principal_allowlist_bootstrap_select` permits `dasher_run_definer`
  to read only `(run_service_principal_id, principal_revision, session_login, enabled,
capabilities, capabilities_sha256, previous_principal_revision,
previous_principal_sha256, principal_sha256, database_oid, database_name)` for **all**
  revisions where `session_login = SESSION_USER`, `database_oid = (SELECT oid FROM
pg_database WHERE datname = current_database())`, `database_name =
current_database()`, and the login has the exact `run-login` marker. The RLS policy
  intentionally does not filter `enabled` or any capability: the fixed function must
  see revocation and capability-removal revisions. It requires one principal UUID for
  that login/database, one unique maximum revision, invariant login/database binding
  across the complete contiguous predecessor/hash chain to revision 1, exact
  capability/principal hash recomputation, and no fork/gap. Only after selecting that
  maximum row does it require `enabled` and the fixed function's capability (including
  `claim` for discovery). A disabled or capability-removed latest revision denies;
  it can never fall back to an older enabled row. No preexisting run context is
  required.
- With that latest principal proven, `claim_agent_run` acquires the claim-operation
  advisory gate and sets phase `claim_retry_discovering` with only the claim-request
  UUID and current principal ID/revision/hash. Policy
  `agent_run_events_run_claim_retry_select` requires current user
  `dasher_run_definer`, that exact phase, a complete latest database-bound principal
  proof with `claim`, and `claim_request_id = <context operation UUID>`. It uses
  database-global `agent_run_events_ix_02` and projects exactly
  `organization_id,dashboard_id,run_id,event_sequence,event_kind,occurred_at,
event_payload_id,event_sha256,claim_operation_kind,claim_request_id,
claim_input_sha256,claim_result_sha256,claim_result_run_revision,
claim_result_state,claim_result_lease_epoch,claim_result_attempt_token,
claim_result_lease_expires_at,claim_result_policy_revision,
claim_result_input_sha256`. It deliberately does not compare kind or input digest in
  `USING`: the fixed body must find an existing ordinary or mixed operation under a
  wrong current principal/lease-seconds value and return the same `P1001` without
  tenant/run metadata. It grants no UPDATE or event-payload access.
- If that lookup finds one row, the body selects the branch from the stored exact
  kind, recomputes that branch's input digest, and returns `P1001` immediately for a
  NULL/unequal digest, NULL result digest, cleared required result field, unknown
  kind, or event-kind mismatch. It never enters eligible discovery. Otherwise it
  carries only the opaque organization/dashboard/run/event tuple into phase
  `locking`, acquires the organization gate and authority/lifecycle/policy/dashboard/
  run locks in the global order, and promotes full context only after
  reauthorization. With the operation advisory gate and run lock still held, it then
  reads all immutable event headers nonlockingly in sequence order. For
  `ordinary_claim`, that is the one named `lease_acquired` header projection; the
  fixed body verifies it and recomputes `claim_result_sha256`, but does not require
  the old lease to remain current. The header is immutable, its globally unique
  operation identity cannot race under the gate, its run identity cannot be
  substituted under the locked promoted run, and retention must first acquire that
  same run lock. The path therefore returns the exact historical `claimed` composite
  with zero DML and has no event UPDATE/lock-only authority. For
  `indeterminate_takeover`, it additionally
  performs the existing body-free run/attempt/counter/event-chain/terminal-operation
  verification and returns the original `terminalized_indeterminate` composite.
  Changed latest principal revision/hash, caller lease seconds, operation kind/ID,
  policy, requester authority, lifecycle, event/result projection, terminal state/
  head, attempt/counter aggregate, or digest yields `P1001` with zero DML. A locked-
  row race uses `P1002` and is rolled back before any retry; neither code returns the
  hidden tuple.
- After the latest principal row is proven and the claim-operation lookup finds no
  row, the function sets transaction-local principal ID/revision and phase
  `discovering`.
  `agent_runs_run_discovery_select` then permits
  only `(organization_id, dashboard_id, run_id, requested_at, state,
requesting_membership_id, requesting_user_id, requesting_authority_revision)` for
  currently claimable states under that exact principal/capability. It exposes no
  input, policy, event, payload, candidate, evidence, or token column and grants no
  UPDATE.
- Phase `locking` adds the one opaque tuple and enables only the lock-only SELECT/
  UPDATE policies named in section 4.6. It begins with the proven principal key. At
  the policy relation's global-order position, the run SELECT policy exposes the
  complete chain, the fixed body validates it and sets the enabled unique-maximum
  policy key transaction-locally, and only then can the exact policy-key lock succeed.
  These are the only added key-row locks for the two non-tenant relations. Every
  semantic INSERT/UPDATE/DELETE policy requires
  promoted phase `authorized` plus exact principal revision, organization, run,
  lease epoch, token hash, lifecycle, and capability. `discovering`/`locking`
  contexts can never satisfy a mutation `WITH CHECK`.
- Catalog tests prove no other self-binding/discovery policy, grant, overload, or
  helper EXECUTE path exists and that disabled, wrong-login, stale-revision,
  capability-missing, cross-tenant, and payload-probing cases are indistinguishable
  denials.

`claim_agent_run` alone performs this acquisition protocol inside one transaction:

1. validate syntactic inputs before connection where applicable;
2. bootstrap the exact enabled session-user principal and `claim` capability;
3. take the claim-operation advisory gate and perform the indexed global retained-
   header lookup under `claim_retry_discovering`; a found row selects its frozen
   ordinary/mixed branch, recomputes the branch input/result identities, follows the
   run-lock/promote/reauthorize/nonlocking-header-verify path above, and returns its original typed
   composite with zero DML, while any found-row drift returns fixed `P1001` and never
   falls through;
4. if no committed claim operation exists, compute the ordinary input digest, switch
   to phase `discovering`, and
   discover one eligible opaque organization/dashboard/run tuple by an ordinary
   indexed read without a row lock and without caller-selected identity; if none
   exists, return typed `no_eligible_run` before acquiring target locks;
5. set a transaction-local `locking` phase containing only that opaque tuple plus the
   already proven principal key; it authorizes exact key-row lock policies but no
   data-mutation policy;
6. acquire the gates and locks in the global order. At the policy position, validate
   the complete chain, set the enabled unique-maximum policy revision as the proven
   transaction-local policy key, and tuple-lock exactly that row; then lock dashboard
   before `FOR UPDATE SKIP LOCKED` on the exact run and recheck eligibility. If the row is
   locked, changed, or no longer eligible, raise normalized retry `P1002`; the
   repository rolls back the entire transaction and only then maps the result to
   `no_eligible_run`. A caller may retry the same claim request in a fresh
   transaction, but the function never selects a second target while any prior
   gate/row lock is held;
7. promote to full transaction-local organization/run/service context and
   reauthorize current lifecycle, authority, policy, inputs, claimability, and
   aggregate run limits;
8. execute the determinate-release or mixed-settlement branch when an expired lease
   has prior-epoch attempts; the mixed branch stores the exact run terminal identity
   plus globally unique event claim input/result identity and returns without continuing;
9. otherwise increment the lease epoch, mint/store the run token hash, build the
   exact typed result and its digest, set database-owned owner/claim/expiry, and
   append `lease_acquired` plus its globally unique immutable claim-result header
   atomically; and
10. return the bounded opaque claim handle with no existence, SQL, constraint,
    credential, prompt, or provider-error leakage.

The two claimed read functions perform steps 1–7 of this post-claim protocol and
return only their exact bounded composite/rows; they do not mutate a projection,
append an event, or expose direct table access. Every remaining mutating operator
function performs the full protocol inside one transaction:

1. validate syntactic inputs before connection where applicable;
2. bootstrap the exact enabled session-user principal and the one capability bound
   to the fixed function;
3. perform an ordinary minimal principal-scoped lookup of opaque organization and
   dashboard gate IDs from the supplied run ID;
4. set the same lock-only transaction context from those opaque IDs and the proven
   principal revision;
5. lock all rows classified as lockable in the global order, including dashboard
   before the exact run, read the sole classified kind of immutable membership
   dependency nonlocking, then verify lease epoch/token hash/expiry/state and
   referenced rows;
6. promote to full transaction-local organization/run/service context;
7. reauthorize current lifecycle, expiry, authority, policy, inputs, and budget;
8. perform one closed mutation with exact expected sequence/prior hash or exact
   attempt/graph/candidate identity;
9. append the matching event atomically; and
10. return a bounded typed result with no existence, SQL, constraint, credential,
    prompt, or provider-error leakage.

For `write_agent_run_checkpoint`, step 7 additionally fixes
`source_event_sequence/source_event_sha256` to the locked current head, sets the
separate `checkpoint_replay` phase, and reads only the nine granted columns for
payload rows 1 through that sequence in ascending order. Missing, extra, purged,
cross-run, out-of-order, envelope/body/header, request-idempotency, or reducer-byte
drift denies before checkpoint DML. The body then restores phase `authorized`,
derives/stores semantic `state_sha256` before nonce-bearing `checkpoint_sha256`,
inserts the checkpoint/payload, appends `checkpoint_written` with both, and cannot
use the read profile again in that call. All other fixed functions skip this phase
and have no event-payload SELECT path.

There is no database transaction across adapter invocation. The exact sequence is:
reserve and commit; perform local adapter setup with no call; start and commit the
`dispatch_ready` preparation; call
`authorize_agent_run_attempt_invocation` in a fresh transaction; and invoke the
adapter only if that transaction commits `status=authorized_now`. That function repeats
the complete current principal/requester membership/dashboard/source/policy/run/
lease/token/attempt/request-digest/budget fence, proves this is the sole
dispatch-lane attempt and the lowest unresolved legal grammar slot (any other
nonterminal is a higher queued generator slot), and atomically commits
`dispatch_ready -> dispatch_started` plus `attempt_dispatch_started`. Same attempt/
digest replay after success returns `already_authorized` and the stored timestamp
without a second event; the orchestrator must not invoke for that status. Digest/
attempt drift denies. A denial commits no mutation, the adapter
call count remains zero, and the `dispatch_ready` reservation can be released by a
still-authorized worker or is determinately released by lease takeover/cancellation/
drain. The orchestrator never invokes on an exception or missing/other status.

The commit of that authorization transaction—not an earlier reservation/start and
not a wall-clock adjective—is the invocation authorization point. Revocation can
unavoidably commit after it and before/during the out-of-transaction call; the plan
does not claim otherwise. Such a call may occur, but every reconciliation uses a new
full fence and a revoked/late result cannot mutate durable state. Cancellation,
takeover, or drain conservatively settles a `dispatch_started` attempt as dispatched.

Replay is a distinct no-dispatch protocol. For `purpose = 'replay'`, every reserve,
start, invocation-authorize, reconcile, and release attempt function denies before
mutation, so calls, tokens, wall/work time, and cost remain exactly zero. The source
must be `approval_required` and its recorded-result kinds must match the retry-aware
ordinary grammar in section 3.1: at most one retryable `failure` immediately followed
by the same planner/generator kind, and after erasing that failure exactly
`planner_output`, optional `specialist_output`, one/two `candidate_output` or
`candidate_invalid,repair_output`, and final `reviewer_verdict_set`. The verdict set
must cover exactly the result-derived candidate set; specialist presence and normal
candidate count must equal the source Brief's frozen boolean/target, while the repair
branch deterministically yields one candidate after releasing any queued later slot.
No other kind/order/count is
replayable; rejected/abstained/failed/cancelled/expired sources deny.

The claimed input read returns every request-pinned source artifact binding. Before
any result read, replay calls only `clone_claimed_replay_prerequisites`. The fixed
function—not a fixture or caller—obtains the exact source bundle/membership and Brief
bytes under the source fence, copies them with the same IDs/hashes into the replay
run, emits one atomic event, and moves `authorized -> planning`.
`commit_common_evidence_bundle` and `commit_agent_brief` deny replay, so caller-
supplied semantic bytes cannot satisfy the prerequisite. Bounded replay-result reads
require the next immutable source sequence through that result count/head;
`consume_agent_replay_result` copies one exact source result into the replay run,
advances the consumed sequence/hash, and appends only `replay_result_consumed`. The
third-through-fifth result that is final under the exact grammar atomically moves
`planning -> generating`; normal graph/candidate/set/validation transitions then
apply. Gap, duplicate with drift, changed source head/count, purged source bytes or
artifacts, stale lease/authority, or source-result hash mismatch denies. Exact same-
sequence/hash retry is a no-op. Only consumed results may feed later commits; no
adapter, tool, credential, network, provider attempt, dispatch event, or resource-
counter row is touched.

`replay-source-fence-v1` is the reusable fixed private check used by request, claimed
input, prerequisite clone, every list/consume, and—after final consume—every replay
mutation except tenant cancellation/retention drain. It has no runtime `EXECUTE`
grant. Following the global order it locks both requester membership rows in ascending
membership-ID order, the dashboard, both run rows in ascending run-ID order, the
shared input source/evidence rows, source/local catalog and contract rows, both
request payloads, source/local bundle headers, source/local Briefs, source recorded
results, then source candidates and candidate payloads. At the bundle position it
reads each source/local membership set nonlocking in evidence-UUID order and performs
the mandatory twice-fresh count/digest/member check. It then requires: same
organization/dashboard/input snapshot/input hash/catalog/contract binding; both
requester memberships still active with unchanged user/revision and editor/admin;
dashboard accessible/unexpired/unpurged; source state exactly `approval_required`
with no lease; source request/artifact payloads present; source result sequence
contiguous and retry-grammar-valid with count/final head equal the replay request;
source candidate-set, bundle ID/hash/membership, Brief ID/hash, and selected candidate
equal the corresponding request-pinned fields; every result byte/hash equals the
request-pinned count/head commitment; and local cloned bundle/
Brief bytes/membership exactly equal source. Counts/heads/hashes are recomputed from
locked mutable/header rows plus the mandatory twice-read immutable membership
projection, never trusted from projections.

After final consumption this fence is mandatory in the same transaction before any
write/event for checkpoint, graph/result/meter, candidate, candidate-set close,
validation findings, claims, manifest, abstention, finish, and ranking/
`approval_required` transitions. Source cancellation, purge, approval-state change,
result/artifact removal or drift, requester revocation, or accessibility loss causes
the local call to fail with zero mutation. Cancellation and retention drain remain
available so a fenced replay run can be safely terminated; they cannot complete it.

### 4.5 Lifecycle and retention coupling

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
  `dashboard_cleanup_coordination` target, matching unexpired lease owner,
  expected lifecycle revision, retention principal revision, `purged_at IS NULL`,
  and current lifecycle in `access_revoked | quarantined | purge_eligible` before
  touching a run. It follows the global order after the coordination row, locks all
  nonterminal runs for the one dashboard in stable run-ID order, increments/fences
  their lease epochs, clears claims, terminalizes them as `cancelled`, and appends
  sanitized cancellation events atomically. In that same transaction it inserts
  one `dashboard_agent_drain_proofs` row with the matrix's exact pre-drain,
  cancelled, released-attempt, charged-attempt, remaining-nonterminal,
  remaining-claimed, lexicographic event-boundary/range, lease, principal,
  lifecycle, request-proof, and generated-proof columns; both remaining counts
  must be physical owner-visible zero. The function's
  `operation_and_audit_id` is exactly `proof_id` and `cleanup_attempt_id`; the later
  successful `record_dashboard_cleanup_attempt` call must use that same UUID. This
  is an immutable future-attempt binding, not an FK to the not-yet-inserted attempt.
  Existing run functions independently deny immediately after dashboard access
  revocation, so this drain supplies final state rather than a revocation safety
  boundary.
  It invokes existing `initialize_operator_context($1, 'claim_cleanup', $4, $5,
$6)`: `$4` is the operation/audit identity and `$6` is the required target
  organization; no service-principal UUID is supplied by a caller.
- Canonical `0007` replaces, without changing signatures or adding overloads, the
  exact phase-7 bodies of `claim_dashboard_cleanup` and
  `record_dashboard_cleanup_attempt`. The executable protocol is fixed:
  (1) claim an ordinary cleanup lease without a transition proof;
  (2) call `drain_dashboard_agent_runs` under that live lease, producing an
  unconsumed drain proof whose proof ID and future cleanup-attempt ID both equal
  that drain call's `operation_and_audit_id`;
  (3) call `record_dashboard_cleanup_attempt` with that same cleanup-attempt UUID
  and result `succeeded` or
  `already_complete` and a completion proof that binds the latest generated **but
  unconsumed** drain proof, thereby recording the attempt and releasing the lease as
  immutable `0003` requires; then
  (4) call `claim_dashboard_cleanup` again with argument 3 equal to that generated
  drain-proof hash. The second claim locks the successful attempt/proof, physically
  rechecks zero nonterminal/claimed runs and the cancellation event range/count,
  acquires the new lease, and inserts the immutable consumption row in the same
  transaction before applying any eligible lifecycle transition.
  `access_revoked -> quarantined` requires this sequence. At `quarantined` or
  `purge_eligible`, any repair drain uses the same drain -> record/release ->
  claim/consume sequence even when the claim preserves state; the latest generated
  proof must be consumed before a later transition or purge, and purge requires that
  latest exact consumed zero proof. A well-shaped arbitrary 32-byte proof, stale
  lease/principal/revision, count drift, unsuccessful/mismatched attempt, or missing
  proof denies. Reuse of the same lifecycle event/audit ID and exact already-consumed
  proof returns the prior void result only after exact consumption/new-lease/event
  equality; drift denies and no second row/event is written.
- `dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid)` is
  replaced without overload by an exact phase-7 body that, under the existing
  `purge` authority, deletes every dashboard-scoped semantic/payload class in the
  section 4.2 disposition matrix—attempt/event/checkpoint/result/candidate payloads;
  field catalogs; graphs/results; metric contracts; common bundles/membership;
  Briefs; abstentions; Claims/edges/manifests; validation findings; candidates; and
  recorded results—in
  fixed child-before-parent order before it attempts source/evidence purge. It
  retains only the governed header/counter/drain-proof metadata allowed by that
  matrix. Before payload deletion, exact retention-only column UPDATE clears the
  complete retained-to-deleted set: `agent_runs.request_payload_id`,
  `candidate_set_sha256`, `terminal_reason_sha256`, `selected_candidate_id`,
  `consumed_replay_sequence`, `consumed_replay_sha256`,
  `terminal_claim_input_sha256`, and `terminal_operation_sha256`;
  `agent_run_events.event_payload_id`, `claim_input_sha256`,
  `claim_result_sha256`, `claim_result_attempt_token`, and
  `claim_result_input_sha256`;
  `agent_run_checkpoints.state_sha256` and `checkpoint_payload_id`; and
  `agent_run_attempts.request_payload_id`, `result_payload_id`, and
  `terminal_reason_sha256`. Those columns are retention-nullable but nonnull whenever
  their pre-purge semantic condition exists; only the fixed purge body may change a
  populated value to NULL, and no value may be restored. The four claim-result clear
  fields clear together on every claim event; checkpoint state/pointer clear together.
  Claim operation kind/ID, common nonsecret typed-result metadata, and the envelope
  `checkpoint_sha256` never clear during content purge, so an old claim ID remains
  globally blocking while neither a token/result nor semantic state digest remains
  recoverable. The six tenant-cancel fields likewise never clear: they retain only
  the exact operation/result commitments and original typed result coordinates, keep
  the operation UUID globally reserved, and are deleted with `agent_runs` at final
  metadata age-out. They do not retain reason bytes, CSRF material, or a payload.
  Purpose, input/replay/
  candidate identifiers, and bare input/result/content/reason/operation hashes other
  than the six explicitly enumerated tenant-cancel commitments/coordinates are not
  retained in `agent_runs` or other headers.
  `request_idempotency_sha256` exists only in the request-payload column, the
  request's canonical bytes, and retained event/checkpoint bodies. Group 8 deletes
  the request row and the same purge deletes all event/checkpoint payload bodies, so
  neither the digest nor a field capable of reconstructing its preimage survives;
  there is no additional retained-column clear because no retained header stores it.
- Purge fails closed unless every run is terminal/unclaimed, every semantic/payload
  class count is zero, every candidate/common-bundle/claim/evidence link is absent,
  no retained-to-deleted FK exists, and retained headers are internally hash/count
  consistent. Those checks are part of the same transaction and aggregate final
  proof; an RLS-filtered zero-row result is not accepted as physical absence.
- `dasher_retention_api.age_out_dashboard_agent_run_metadata(uuid, bigint, bytea,
uuid, text, uuid)` is a second exact fixed function owned/executable by the same
  retention roles under existing `purge` capability. It has no TypeScript or
  production caller in this slice. It deletes governed run/event/checkpoint/attempt
  headers, counters, and drain proofs only when the dashboard is already cleaned,
  database time is at least `purged_at + interval '365 days'`, the exact tombstone/
  backup-deletion proof is present, and no active legal hold exists. It writes the
  bounded `dashboard_agent_run_age_out_proofs` row plus audit action
  `dashboard.agent_run_metadata_aged_out` atomically. Operation-ID replay with the
  same target/proof succeeds as a no-op after exact proof equality, without duplicate
  deletion/audit; operation-ID reuse with drift denies, and a different operation ID
  for an already-proved dashboard/lifecycle denies. A first age-out with zero eligible
  runs is admitted and still writes the exact nonnull empty chain-set digest/proof.
  Early, held, partial, or proof-drifted calls deny. It invokes existing
  `initialize_operator_context($1, 'purge', $4, $5, $6)`; `$6` is the target
  organization.
- PostgreSQL DELETE is table-level. `dasher_retention_definer` alone receives exact
  table DELETE for content purge on
  `agent_run_request_payloads`, `agent_run_event_payloads`,
  `agent_run_checkpoint_payloads`, `agent_run_attempt_payloads`,
  `agent_candidate_payloads`, `agent_recorded_results`, `field_catalog_entries`,
  `field_catalog_snapshots`, `agent_run_calculation_meters`,
  `calculation_results`, `calculation_graphs`,
  `metric_contract_versions`, `candidate_evidence_manifests`, `claim_evidence`,
  `claims`, `agent_validation_findings`, `agent_candidates`,
  `candidate_comparison_bundle_evidence`,
  `candidate_comparison_bundles`, `briefs`, and `run_abstentions`; age-out adds only
  `agent_run_attempts`, `agent_run_budget_counters`, `agent_run_checkpoints`,
  `agent_run_events`, `dashboard_agent_drain_proof_consumptions`,
  `dashboard_agent_drain_proofs`, and `agent_runs`. Exact retention-only column UPDATE
  is limited to the eighteen pre-delete clears listed above. Exact
  forced-RLS DELETE policies, lifecycle/hold predicates, immutable-trigger retention
  branches, dependency inventory, and fixed body hashes are frozen in Task 9A.
  App/run/general/retention-operator roles receive no DELETE; there is no cascade,
  generic callback, new capability, or RLS broadening.

The content-purge FK DAG is frozen by the per-relation matrix and an owner-visible
`pg_constraint` fixture; an unlisted FK fails Task 9A. First, under the same
transaction, lock all affected mutable/header rows and every DELETE target except the
explicitly nonlocking bundle-membership rows in the global order; lock their bundle
headers and freshly revalidate those members instead. Then clear exactly the
eighteen retained-to-deleted pointer/hash/secret columns listed above in this order:
the eight `agent_runs` columns; the event payload pointer and four claim fields; the
checkpoint state digest and payload pointer; and the three attempt columns. Each
update is old-nonnull -> NULL only; a conditionally nullable claim column is accepted
without a write, and no retained claim kind/ID or checkpoint envelope digest changes.
Then DELETE in exactly this
child-before-parent order:

1. `candidate_evidence_manifests`;
2. `claim_evidence`, then `claims`, then `agent_validation_findings`;
3. `agent_candidate_payloads`, then `agent_candidates`;
4. `agent_run_calculation_meters`, then `calculation_results`, then
   `calculation_graphs` (meters are children of both result and graph; results are
   children of graphs);
5. `briefs`, then `run_abstentions`;
6. `candidate_comparison_bundle_evidence`, then
   `candidate_comparison_bundles`;
7. `agent_recorded_results`;
8. `agent_run_request_payloads`, then `agent_run_attempt_payloads`,
   `agent_run_checkpoint_payloads`, and `agent_run_event_payloads`;
9. `metric_contract_versions`, then `field_catalog_entries`, then
   `field_catalog_snapshots`.

Request payloads are deleted before their catalog/contract/input/source parents;
candidates, Briefs, and graphs before their common-bundle parent; calculation meters
before both of their RESTRICT parents and results before graphs; recorded results
before result payloads; and every pointer before its referenced payload. Only after
all nine groups have owner-visible zero counts and no FK blocker may the unchanged
predecessor source/evidence purge run. Real PostgreSQL tests materialize every FK,
populate every class, execute this literal order, inject failure at each boundary,
and prove rollback plus catalog equality.

Age-out freezes exactly every `agent_runs` row whose `(organization_id,dashboard_id)`
equals the initialized target; it never selects a subset. Each selected row must be
terminal and unclaimed, have every section 4.5 content-purge clear already NULL, and
have `current_event_sequence >= 1`. With the cleanup coordination/principal/
organization gates already outermost, the function locks the lifecycle policy and
then selects/locks exactly
`dashboards(organization_id,dashboard_id,lifecycle_revision,
tombstone_lineage_id,purged_at)`. Only that locked dashboard column may select the
target active legal-hold rows and then the
`dashboard_tombstones(organization_id,tombstone_lineage_id, purged_at,
purged_lifecycle_revision,purged_proof_sha256)` row and its exact latest
`backup_deletion_ledger` row; ID-only or organization-wide tombstone discovery is
forbidden. It verifies the tombstone/dashboard lifecycle and purge timestamp before
using the lineage UUID in the source-proof preimage. It then locks all selected run
headers by unsigned 16-byte run UUID using exact SQL order
`pg_catalog.uuid_send(run_id) ASC`, reads their immutable event headers by that same
run order and ascending sequence, and locks the remaining header rows in the global
relation order. This is the eligibility snapshot; no count
or tuple is recomputed from an unlocked or RLS-filtered view. For each run, event
headers must be exactly contiguous `1..current_event_sequence`, every prior sequence/
hash link must match, and the last event SHA must equal
`agent_runs.current_event_sha256`. A gap, extra row, head mismatch, or pointer drift
denies before proof DML.

`retained_event_count` is the checked signed-64 sum of every selected run's
`current_event_sequence`, accumulated in PostgreSQL `numeric` and rejected unless it
fits `0..9223372036854775807`; it is not the run count or an implementation-selected
event query count. The physical owner-visible event-row count must equal that sum,
and `deleted_event_count` must later equal it. `eligible_run_count` is the checked
signed-64 selected-run count and must later equal `deleted_run_count`.

`retained_chain_head_sha256` is, despite its historical singular column name, the
exact chain-set digest SHA-256 over domain
`dasher.agent-run-retained-chain-set.v1\0` followed by canonical-binary-v1 values in
this order: target organization UUID, dashboard UUID, signed-64 lifecycle revision,
signed-64 eligible-run count, then for every selected run sorted by unsigned 16-byte
run UUID using `pg_catalog.uuid_send(run_id) ASC`: run UUID, signed-64
`current_event_sequence`, and the 32-byte
`current_event_sha256` as a canonical-binary-v1 byte string. Physical insertion or
scan order never participates. For zero runs, hash exactly the domain and fixed
organization/dashboard/lifecycle/count-zero prefix with no run tuple;
`retained_event_count = 0`. There is no NULL, all-zero, latest-run-only, concatenated-
head, or implementation-selected sentinel case. One run uses one tuple; multiple
runs use all tuples in the exact sorted order. Source/backup proofs, age-out operation
ID, run terminal-operation fields, timestamps, deletion counts, and retention
principal are not chain-set fields; they remain separately ordered in the source or
generated age-out proof.

The function computes the selected set/count/digest before insertion, inserts the
immutable proof and audit, then—while all snapshot locks remain held—independently
rereads the inserted proof through its owner-visible path, rebuilds the ordered
preimage from the still-present run/event headers, and requires byte-for-byte digest
and count equality before any deletion. Every one of those rows, plus any existing
age-out proof row used for no-op detection, is already locked in the exhaustive global
order before proof insertion. The body then uses the FK-safe DML order attempts ->
checkpoints -> budget counters -> events -> drain-proof consumptions -> drain proofs
-> runs; this post-acquisition delete sequence is not a competing lock order. Any
injected failure rolls back proof/audit and every deletion. The immutable age-out row
records the owner-visible affected-row count for each of those seven relation classes
separately. In particular, `deleted_drain_proof_consumption_count` is not inferred
from `deleted_drain_proof_count`: consumed and unconsumed proofs may coexist, and each
stored count must equal its relation's exact deletion count before commit. Immediately
before commit, owner-visible affected counts must equal every stored deleted count,
especially `deleted_event_count = retained_event_count`; no post-deletion empty scan
is substituted for the independently verified pre-deletion proof.

The retention argument matrix preserves predecessor identities exactly:

| Function                                                                                           | Signature-order meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid)`                         | `(dashboard_id, expected_lifecycle_revision, expected_transition_proof_sha256, lease_duration, lifecycle_event_and_audit_id, deployment_revision, target_organization_id)`; argument 3 is NULL for the first lease used to drain and is the latest generated drain-proof hash for the post-record claim/consume step. The latter consumes only a proof bound by the preceding successful cleanup attempt and may then perform the eligible lifecycle transition. Arguments 5/6/7 retain predecessor request identity/deployment/target-organization meaning. |
| `record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid)` | `(dashboard_id, cleanup_attempt_id, step, result, released_claim_count, deleted_resource_count, deferred_claim_count, completion_proof_sha256, target_organization_id)`; the body uses the attempt ID as existing initialization request identity. For a successful drain-bearing step, argument 8 binds the latest generated-but-unconsumed proof under the currently held lease, then the immutable predecessor body releases that lease.                                                                                                                  |
| `drain_dashboard_agent_runs(uuid, bigint, bytea, uuid, text, uuid)`                                | `(dashboard_id, expected_lifecycle_revision, drain_request_proof_sha256, operation_and_audit_id, deployment_revision, target_organization_id)`; argument 3 is the caller request proof defined below, not the generated drain proof; argument 4 is exactly the inserted `proof_id`, the future `cleanup_attempt_id`, and this drain operation's audit identity.                                                                                                                                                                                              |
| `purge_dashboard(uuid, bigint, bytea, uuid, text, uuid)`                                           | `(dashboard_id, expected_lifecycle_revision, cleanup_completion_proof_sha256, operation_and_audit_id, deployment_revision, target_organization_id)`; argument 3 is the exact successful `purge_finalizing` completion proof produced by `record_dashboard_cleanup_attempt`, bound to target/revision/attempt/counts and consumed by the purge body.                                                                                                                                                                                                          |
| `age_out_dashboard_agent_run_metadata(uuid, bigint, bytea, uuid, text, uuid)`                      | `(dashboard_id, expected_lifecycle_revision, tombstone_backup_source_proof_sha256, operation_and_audit_id, deployment_revision, target_organization_id)`; argument 3 is the caller source proof defined below, not the generated age-out proof.                                                                                                                                                                                                                                                                                                              |

All are `VOLATILE SECURITY DEFINER`, set `search_path = pg_catalog`, are owned by
`dasher_retention_definer`, and have exact phase-7 body/dependency/ACL hashes. They
return `void`; idempotent already-complete calls write no duplicate proof/event.
Every proof is exactly 32 bytes and uses section 4.3 `canonical-binary-v1` in the
listed field order:

`event_range_sha256` is SHA-256 over
`dasher.agent-run-drain-event-range.v1\0`, signed-64-bit `event_count`, then each
emitted event's run UUID, signed-64-bit event sequence, and 32-byte event SHA in
ascending canonical UUID-byte/sequence order. Zero events hashes an empty tuple
list and requires all first/last boundary columns NULL; otherwise the first and
last stored run/sequence/SHA triples equal the first and last hashed tuples.

1. Caller drain request proof = SHA-256(`dasher.agent-run-drain-request.v1\0`,
   dashboard UUID, expected lifecycle revision, operation UUID, deployment text,
   target organization UUID, locked coordination step text, cleanup lease-owner
   session-login text, lease-expiry timestamp, retention principal UUID/revision).
   `drain_dashboard_agent_runs` recomputes it after all locks and requires argument 3
   equality. Its generated drain proof = SHA-256(
   `dasher.agent-run-drain-proof.v1\0`, request proof, all preceding identity/lease
   fields, pre-drain run count, cancelled run count, released/charged attempt counts,
   remaining nonterminal count, remaining claimed count, nullable first and last
   emitted run UUID/sequence/SHA triples, event count, event-range SHA, and database
   completion timestamp). The row stores the exact request and generated hashes.
2. `claim_dashboard_cleanup` argument 3 for the post-record claim/consume step is
   exactly the latest unconsumed generated drain-proof hash, never the request proof.
   The function requires a preceding successful cleanup-attempt row whose completion
   proof binds that generated proof and whose recording released the proof's old
   lease. It then verifies all bound fields and physical zero counts, acquires the new
   lease, and inserts consumption atomically before any state transition. This is used
   at `access_revoked`, `quarantined`, and `purge_eligible`; an unconsumed later repair
   proof supersedes an older consumed proof for transition/purge eligibility.
3. The inserted consumption row copies and revalidates the exact generated drain-
   proof hash, preceding cleanup-attempt UUID, preceding lease owner/expiry, newly
   claimed lease owner/expiry, claim event/audit UUID, consumption timestamp, and
   current retention principal UUID/revision. `consumption_sha256` is SHA-256 over
   `dasher.agent-run-drain-consumption.v1\0`, organization UUID, dashboard UUID,
   proof UUID, lifecycle revision, drain-proof SHA, preceding cleanup-attempt UUID,
   preceding lease-owner text, preceding lease-expiry timestamp, new lease-owner
   text, new lease-expiry timestamp, claim event/audit UUID, consumption timestamp,
   retention principal UUID, and signed-64-bit retention principal revision, in that
   order.
4. Successful/`already_complete` `record_dashboard_cleanup_attempt` argument 8 is
   SHA-256(`dasher.dashboard-cleanup-completion.v1\0`, dashboard UUID, locked
   lifecycle revision, cleanup-attempt UUID, step text, result text, released/deleted/
   deferred counts, nullable latest generated-but-unconsumed drain-proof hash, target
   organization UUID, cleanup lease-owner session-login, retention principal UUID/
   revision). The function recomputes it from arguments plus locked rows before
   INSERT, stores it in `dashboard_cleanup_attempts.proof_sha256` and coordination
   completion proof, and denies arbitrary 32-byte input. Retry requires equality to
   that exact stored row. `purge_dashboard` argument 3 must equal and recompute the
   latest successful `purge_finalizing` completion proof before any deletion; if a
   drain proof is embedded, it must also be the latest consumed zero proof.
5. Caller age-out source proof = SHA-256(
   `dasher.agent-run-age-out-source.v1\0`, dashboard UUID, expected lifecycle
   revision, tombstone-lineage UUID, purged-at timestamp, latest backup-ledger
   sequence/event/proof hash, operation UUID, deployment text, target organization
   UUID). The function recomputes it under tombstone/ledger locks. The row's
   `backup_deletion_proof_sha256` is exactly that latest locked backup-ledger proof
   hash, and `source_purge_proof_sha256` is exactly the caller/source digest. Generated age-out
   proof = SHA-256(`dasher.agent-run-age-out-proof.v1\0`, source proof, eligible run
   count, deleted run/event/checkpoint/attempt/counter/drain-proof-consumption/
   drain-proof counts in that exact order, `retained_chain_head_sha256`,
   `retained_event_count`, deletion timestamp, retention principal UUID, and signed-
   64 retention principal revision). Both retained values are the exact locked pre-
   deletion chain-set values above; the immutable row stores them and both proofs
   before deletion. Fresh zero-run input uses eligible/deleted run/event counts zero
   and the defined nonnull zero-tuple digest, not a special branch.

For no-op age-out replay, after current retention principal/target/lifecycle/source-
proof authorization the function locks the unique proof row for that dashboard and
lifecycle. It requires the same operation ID, source and backup proof bindings,
retention principal ID/revision, every stored count/digest/timestamp, and independently
recomputes `age_out_proof_sha256` from that immutable row; exact equality returns
without audit or deletion. It does not attempt to reconstruct already-deleted run
headers. A different operation ID or any argument/stored-field drift denies. On a
fresh operation, any existing proof for the dashboard/lifecycle denies before the
zero-run rule can apply.

Same operation ID, target, producer, all bound fields, and both relevant proofs is
the only no-op replay; null, wrong-purpose, request/generated substitution, cross-
target/revision/principal/lease/attempt/ledger-head drift denies before DML. Task 9A
ships byte-vector fixtures for each preimage plus one-bit/cross-domain negatives;
Task 9F recomputes each proof independently from owner-visible rows. Chain-set
fixtures cover zero, one, and multiple runs; reversed physical insertion must produce
the same unsigned-UUID-sorted digest, while one-bit run UUID/sequence/head, tuple-
order, eligible-count, or event-count drift denies. Gap/head mismatch and checked-add
overflow deny and roll back proof/audit/deletion; the post-proof-insert pre-delete
recomputation is independently exercised. Task 9A's predecessor SELECT-column,
retention-policy, function-DML, body-dependency, and lock-order fixtures all include
`dashboards.tombstone_lineage_id`; removing it or selecting a tombstone not named by
that locked value is catalog/body drift.

Migration `0007` replaces `audit_events_action_check` with one cumulative constraint.
Its exact ordered vocabulary is the 28 predecessor literals
`membership.role_changed`, `membership.revoked`, `invitation.issued`,
`invitation.revoked`, `invitation.accepted`,
`invitation.accepted_existing_membership`, `session.issued`, `session.rotated`,
`session.revoked`, `source_snapshot.created`, `evidence_record.created`,
`dashboard.created`, `dashboard_version.created`, `dashboard_head.promoted`,
`dashboard.promotion_requested`, `dashboard.promotion_approved`,
`dashboard.promotion_denied`, `dashboard.expired`, `dashboard.archived`,
`dashboard.unarchived`, `dashboard.deleted`, `dashboard.restored_as_new`,
`dashboard.cleanup_started`, `dashboard.purge_eligible`,
`dashboard.legal_hold_placed`, `dashboard.legal_hold_released`,
`dashboard.purged`, and `dashboard.artifact_created`, followed by exactly:

| Action                                  | Target type | Target ID / writer                                    |
| --------------------------------------- | ----------- | ----------------------------------------------------- |
| `dashboard.agent_run_requested`         | `agent_run` | new run ID / `request_agent_run`                      |
| `dashboard.agent_run_cancelled`         | `agent_run` | run ID / `cancel_agent_run`                           |
| `dashboard.agent_runs_drained`          | `dashboard` | dashboard ID / `drain_dashboard_agent_runs`           |
| `dashboard.agent_run_metadata_aged_out` | `dashboard` | dashboard ID / `age_out_dashboard_agent_run_metadata` |

No operator mutation invents an audit literal; its append-only run event is the
operation record. The four writers insert exact actor/request/authority/deployment/
content-proof fields in the same transaction as their mutation. Constraint name,
ordered cumulative literal array, target types, and body/catalog hashes are frozen;
request/cancel/drain/age-out audit failure rolls back all associated state.

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

### 4.6 RLS and ACL rules

- Every new tenant relation has `ENABLE ROW LEVEL SECURITY` and
  `FORCE ROW LEVEL SECURITY`.
- Tenant-definer policies require existing full current-user tenant context and
  accessible dashboard/run linkage. Terminal/expired/revoked lifecycle hides
  candidate body and evidence while retaining only the bounded admin status
  already authorized. Existing `dasher_security_definer` BYPASSRLS honesty remains
  governed by section 4.4.
- Run-operator policies require `current_user = 'dasher_run_definer'`, promoted
  run phase, run ID,
  organization ID, lease epoch, attempt-token hash, operator principal/revision,
  capability, and current policy equality.
- The only run-operator payload SELECT policy is
  `agent_run_event_payloads_run_definer_select`. It requires
  `current_user = 'dasher_run_definer'`, phase exactly `checkpoint_replay`,
  required function capability exactly `checkpoint`, the latest enabled database-bound principal
  revision, and transaction-local organization/dashboard/run, lease epoch,
  attempt-token hash, source event sequence/hash, lifecycle, and policy values
  already proven by `write_agent_run_checkpoint`. Its `USING` admits only the same
  organization/dashboard/run and event sequences `1..source_event_sequence`; the
  fixed body joins each row to the exact event header/pointer and verifies event ID,
  sequence, payload envelope, canonical schema, and source head before reducing.
  The writer alone may set this phase, only after the ordinary full checkpoint
  fence, and must restore phase `authorized` before checkpoint/event INSERT. No
  other fixed function, private append helper, role, or direct caller may set or
  satisfy this profile. The grant is only the nine
  `checkpoint_event_payload_columns`; app and operator roles receive no table grant,
  and tenant event listing still exposes only `payload_available`.
- Separate lock-only policies additionally require `current_user =
'dasher_run_definer'`, phase `locking`, the opaque organization/dashboard/run
  tuple, and exact proven principal revision; they permit row locks only and cannot
  satisfy any semantic INSERT/UPDATE/DELETE policy. Promotion to mutation phase
  occurs only after every locked value is reauthorized. The two non-tenant key exceptions are
  exact: `run_service_principal_allowlist_run_lock_update` uses equality to the proven
  transaction-local principal ID/revision, and
  `agent_run_policy_revisions_run_lock_update` uses equality to the proven
  transaction-local policy revision. Both are run-definer-only phase-`locking`
  UPDATE policies with `WITH CHECK (false)` and cannot authorize actual or no-op
  mutation.
- The sole pre-organization claim-retry policy is
  `agent_run_events_run_claim_retry_select` from section 4.4. It is available only
  inside `claim_agent_run` after latest-principal bootstrap, matches one exact
  ordinary-or-mixed claim UUID through the global event partial unique index, and is
  SELECT-only. The fixed function alone projects the enumerated retained claim event
  columns, compares the branch-specific input digest before promoting opaque
  organization/dashboard/run/event context, and emits only `P1001` on any found-row
  kind/principal/input/result/purge drift. After promotion and the run lock, the same
  projection is reread without a row-locking clause. The policy grants no event
  UPDATE/lock-only authority, event-payload, tenant-listing, candidate, request,
  source, or evidence access and is disabled in every other phase/function.
- The `agent_runs_security_definer_select` policy's
  `cancel_operation_probe` arm requires the initialized organization and exact
  transaction-local operation UUID, uses `agent_runs_ix_05`, and exposes only the
  nine-column cancel projection in the DML matrix; it cannot list another operation
  or organization. The tenant-cancel UUID gate then has one analogous immutable,
  nonlocking predecessor policy,
  `audit_events_security_definer_cancel_operation_select`. It requires
  `current_user = 'dasher_security_definer'`, function `cancel_agent_run`, phase
  `cancel_operation_probe`, and equality to the one transaction-local operation UUID.
  The column grant/projection is exactly
  `audit_event_id,organization_id,occurred_at,actor_kind,actor_user_id,actor_service,
authority_revision,request_id,job_id,action,target_type,target_id,outcome,
content_sha256,source_ref,provider,credential_version,usage_units,cost_minor_units,
deployment_revision`; it is re-read under the same profile after target locks. The
  probe intentionally does not require audit organization equality, so an operation
  UUID already committed in another tenant is detected but yields only normalized
  `P1001`, never row content. The immutable predecessor trigger makes a row lock
  unnecessary. This policy grants no
  operation listing or event-payload access, is unsatisfiable outside that fixed
  function/phase/UUID, and is the only added `audit_events` SELECT authority.
- Run-operator bootstrap first resolves every visible revision for the exact
  `session_user`/database binding, proves one complete predecessor-hash chain and one
  unique latest revision, then requires that latest row to be enabled and contain the
  fixed function's capability. A latest disabled or capability-removed row denies
  without stale fallback. Only opaque principal/revision/capability values enter
  transaction-local settings. Role membership alone never authorizes a run.
- Bootstrap discovery exposes either the one exact operation-bound opaque tuple or
  one eligible opaque run ID and required gate fields, then promotes context after
  authority/lifecycle locks. It does not grant broad tenant scanning, and any found
  committed claim operation can never fall through to the eligible-run path.
- A request stores exact `requesting_user_id`, `requesting_membership_id`, and
  `requesting_authority_revision` from the locked current context; it never stores a
  session token/digest. Before dashboard/run mutation, each claim and post-claim
  function locks exactly that membership and requires the same organization/user/
  membership IDs, `state = 'active'`, `revoked_at IS NULL`, unchanged authority
  revision, and role `editor` or `admin`. Policy
  `memberships_run_reauthorization_lock` requires `current_user =
'dasher_run_definer'`, phase `locking`, and equality to every requester value in
  the opaque lock context; its `WITH CHECK (false)` cannot authorize a data change.
  The run row is then locked and must reproduce those values before phase promotion.
  Any drift yields the same denial and no provider call/result commit. Original
  session expiry/revocation alone does not become a worker credential or cancel a
  previously authorized request; membership/lifecycle revocation does fence it.
- On predecessor relations, `dasher_run_definer` receives exact column `SELECT` plus
  separate column-level `UPDATE` needed only to lock the rows named by the
  matrix—nothing table-wide.
  Existing-relation SELECT columns are exactly
  `memberships(organization_id, membership_id, user_id, role, state,
authority_revision, revoked_at)`,
  `dashboard_lifecycle_policies(organization_id, policy_revision)`,
  `dashboards(organization_id, dashboard_id, current_kind, lifecycle_state,
lifecycle_revision, effective_expires_at, access_revoked_at, purged_at,
head_version_id)`,
  `dashboard_versions(organization_id, dashboard_id, version_id)`,
  `source_snapshots(organization_id, snapshot_id, source_kind, canonical_bytes,
content_sha256, observed_at, retrieved_at, created_at)`, and
  `evidence_records(organization_id, evidence_id, snapshot_id, evidence_kind,
coordinates, transformation, content_sha256, observed_at, retrieved_at, created_at)`.
  Existing-relation lock-only
  UPDATE columns are exactly `memberships(organization_id, membership_id)`,
  `dashboard_lifecycle_policies(organization_id, policy_revision)`,
  `dashboards(organization_id, dashboard_id)`,
  `dashboard_versions(organization_id, dashboard_id, version_id)`,
  `source_snapshots(organization_id, snapshot_id)`, and
  `evidence_records(organization_id, evidence_id)`. No role/state/revision/content
  column is update-granted, and there is no `sessions` privilege. Planned lock-only
  keys are exactly `run_service_principal_allowlist(run_service_principal_id,
principal_revision)`, `agent_run_policy_revisions(policy_revision)`,
  `agent_runs(organization_id, run_id)`,
  `candidate_comparison_bundles(organization_id,dashboard_id,run_id,bundle_id)`,
  `agent_run_budget_counters(organization_id, run_id, partition, vector_field)`, and
  `agent_run_attempts(organization_id, run_id, attempt_id)`. Phase-7 predecessor
  SELECT policies are named `<relation>_run_select`, except the specific
  `memberships_run_reauthorization_select`; they require current run definer,
  `locking|authorized` phase, exact proven principal revision, organization/
  dashboard/run, and the exact membership/version/snapshot/evidence IDs already in
  the lock context, and expose only the SELECT columns above. Lock UPDATE policies
  are named `<relation>_run_lock_update`, except
  `memberships_run_reauthorization_lock`; they require the same exact key in `USING`
  and use `WITH CHECK (false)`. No policy admits organization-wide source/evidence
  scans, and replay source rows require both request-pinned run IDs in context;
  immutable/update-guard triggers independently reject any actual or no-op data
  change. For the two non-tenant planned relations, the run definer's column-level
  UPDATE grants are exactly
  `run_service_principal_allowlist(run_service_principal_id,principal_revision)` and
  `agent_run_policy_revisions(policy_revision)` under the two exact policies named
  above; neither grant is table-wide. The run definer is not a runtime writer, and
  there is no DELETE grant or policy on either relation. These
  grants exist only because PostgreSQL `SELECT ... FOR UPDATE` requires UPDATE
  authority. Real-role tests prove each required lock succeeds through a fixed
  function while direct SELECT/UPDATE and no-op UPDATE fail.
- `candidate_comparison_bundle_evidence` is the sole content-addressed dependency
  explicitly excluded from row locking. It has `R:S,I` and no UPDATE grant/policy.
  Every dependent function instead locks the exact run and
  `candidate_comparison_bundles` header, validates header `evidence_count` against
  both canonical `entries.length` and the physical keyed member count, reads every
  immutable member in evidence-UUID order, recomputes the full bundle bytes/hash,
  validates each already row-locked `source_snapshots`/`evidence_records` predecessor,
  and repeats that complete count/digest/member projection immediately before DML.
  Bundle creation/cloning admits the child set only in its original transaction;
  later INSERT and all UPDATE are trigger-denied. A competing purge cannot remove a
  member while another dependent body holds those run/header locks; the purge body's
  own nonlocking member DELETE follows its locked-header revalidation contract. This
  profile is mandatory and is not an implementation choice or a grant omission.
- Claims and manifests cannot link unavailable, cross-tenant, or lifecycle-
  inaccessible evidence. Composite FKs and fixed triggers independently enforce
  the same organization/dashboard/run/candidate/common-bundle scope.
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

### 4.7 Closed underlying DML authority

Task 9A transcribes the following cumulative grant model before executable SQL. For a
new phase-7 relation, `SELECT ALL` or `INSERT ALL` below means an intentional table-
level grant on exactly that named Task 9 relation to one NOLOGIN definer; it is not
a future-column wildcard because phase-7 column shape and catalog hash are frozen in
the same migration. The one exception is the explicit column-level
`agent_run_event_payloads` SELECT granted to `dasher_run_definer` for
`checkpoint_event_payload_columns`; it is never expanded to `SELECT ALL`. Existing-
relation access remains the exact column lists above.
No runtime definer receives `TRUNCATE`, `REFERENCES`, `TRIGGER`, ownership, grant
option, role membership, or sequence authority outside its exact identity columns.

For retention replacements, `phase6-retention-baseline-v1` means the owner-visible
catalog tuple derived from the exact hashed `0001`..`0006` bytes for each predecessor
signature: function owner/language/security/volatility/config/body/dependency OIDs;
every called fixed function; relation and column ACL; RLS policy name/roles/command/
qual/check; trigger name/function/enable/body; and exact SELECT/INSERT/UPDATE/DELETE
column set. Task 9A commits that tuple as a fixture before authoring `0007`; drift from
the canonical base fails. The replacement keeps that complete baseline except for
the additive deltas in its individual row below. Thus “baseline” is an executable
byte-bound set, not permission to infer or broaden predecessor access.

Exact mutable column sets are:

- `agent_runs`: transition-mutable `state`, `run_revision`,
  `current_event_sequence`, `current_event_sha256`, `lease_epoch`,
  `lease_token_sha256`, `lease_owner_principal_id`,
  `lease_owner_principal_revision`, `lease_expires_at`,
  `latest_checkpoint_revision`, `candidate_set_sha256`, `candidate_set_closed_at`,
  `terminal_at`, `terminal_reason_sha256`, `selected_candidate_id`,
  `consumed_replay_sequence`, `consumed_replay_sha256`, `terminal_operation_kind`,
  `terminal_operation_id`, `terminal_claim_input_sha256`,
  `terminal_operation_sha256`, `tenant_cancel_operation_id`,
  `tenant_cancel_operation_sha256`, `tenant_cancel_result_sha256`,
  `tenant_cancel_result_run_revision`, `tenant_cancel_result_event_sequence`, and
  `tenant_cancel_result_event_sha256`; terminal kind/ID are write-once and immutable, both mixed digests
  are write-once during their terminal writer and clear-only during retention, and
  only mixed-takeover claim writes the input digest. The six tenant-cancel columns
  are one write-once group owned only by `cancel_agent_run`, are immutable thereafter,
  and are never content-purge-clearable;
  `request_payload_id` is immutable except for retention clear;
- `agent_run_events`: every claim-result projection field is write-once with the
  event; only retention may clear `event_payload_id`, `claim_input_sha256`,
  `claim_result_sha256`, `claim_result_attempt_token`, and
  `claim_result_input_sha256`. The four claim fields clear together; operation
  kind/ID and common nonsecret result projection fields never update;
- `agent_run_checkpoints`: `state_sha256` and `checkpoint_payload_id` are immutable
  during run work and clear together only during retention;
- `agent_run_budget_counters`: `reserved_units`, `used_units`, `released_units`,
  and `updated_at`;
- `agent_run_attempts`: transition-mutable `state`, `dispatch_ready_at`, `dispatch_started_at`,
  `actual_vector`, `used_vector`, `released_vector`, `outstanding_vector`,
  `reconciled_at`, `terminal_reason_sha256`, and `result_payload_id` (write-once on
  determinate reconciliation); `request_payload_id` is immutable during run work;
- `agent_candidates`: `validation_state`, `review_state`, `manifest_sha256`, `rank`,
  and `selected`;
- retention-clear-only old-nonnull -> NULL columns: the eighteen columns listed in
  section 4.5. Runtime app/run functions cannot clear them, and the retention definer
  cannot set or restore a nonnull value. The two mixed-takeover digests clear together;
  event claim fields and checkpoint state/pointer clear in their named groups;
  operation kind/ID, all tenant-cancel fields, and checkpoint envelope digest never
  clear during content purge.

The fixed function-to-command matrix is exact. The operator-side exact
`replay-source-fence-v1` read set is: both `agent_runs` and request payloads; both
requester `memberships`; the one dashboard and exact input `source_snapshots` plus
bundle-member `evidence_records` rows; all source recorded results through the pinned
count; source candidates and candidate
payloads; source and local bundle, bundle-evidence membership, and Brief rows; and
the source/local catalog and metric-contract rows named by the two request payloads.
It is mechanically unioned into `get_claimed_agent_run_input`,
`clone_claimed_replay_prerequisites`, `list_claimed_replay_results`, and
`consume_agent_replay_result` whenever purpose is replay. After final result
consumption it is also mechanically unioned into each of
`write_agent_run_checkpoint`, `commit_calculation_graph`,
`commit_agent_candidate`, `close_agent_candidate_set`,
`commit_agent_validation_findings`, `commit_candidate_claims`,
`commit_candidate_manifest`, `commit_run_abstention`,
`finalize_agent_run_ranking`, and `finish_agent_run`. The
same rows receive only the already-defined request-pinned SELECT/lock policies. This
conditional union is empty for Suggest and occurs before the row's listed mutation;
it is not an optional prose dependency or permission to scan another run.

For every row below whose SELECT projection names a common bundle or membership,
the mechanical lock union adds only the exact key-column lock authority on
`candidate_comparison_bundles`; its UPDATE cell still describes semantic mutation
and does not add a membership UPDATE. The membership projection is always the
nonlocking, fresh count/digest/member revalidation from section 4.6. Removing the
header lock/revalidation or adding membership lock/UPDATE authority is fixture drift.

Every promoted run-definer profile in the table mechanically includes SELECT plus the
exact key-column lock-only UPDATE authority for the proven latest
`run_service_principal_allowlist` row and proven unique-maximum
`agent_run_policy_revisions` row. This authority is exercised only by
`SELECT ... FOR UPDATE` in global order. An UPDATE cell that says `none` or limits a
retry to no DML means no semantic data UPDATE; it does not omit these two tuple locks.
The union never adds table-wide UPDATE, a run-role runtime writer, DELETE, or an event-row
lock. In particular every ordinary/mixed claim retry retains its principal/policy key
locks and existing dashboard/run locks while its event-header verification remains a
nonlocking SELECT.

The table is:

| Function/profile                            | SELECT relations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | INSERT relations                                                                                                                                                                                                                                    | UPDATE column set                                                                                                                                                                                                                                         | DELETE                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `request_agent_run`                         | existing membership/policy/dashboard/snapshot columns above; local `agent_runs` and `agent_run_request_payloads` for unique-identity replay; all columns of `agent_run_policy_revisions`, `field_catalog_snapshots`, `field_catalog_entries`, `metric_contract_versions`; replay additionally the source half of the exact fence: source run/request, requester membership, recorded results, candidates/payloads, bundle/membership, Brief, catalog/contracts, and input snapshot                                                                                                                                                                                                         | `agent_run_policy_revisions` only for convergent revision-1 seed; new identity only: `agent_run_request_payloads`, `agent_runs`, `agent_run_budget_counters`, `agent_run_events`, `agent_run_event_payloads`, `audit_events`; exact duplicate: none | lock-only existing columns above; no Task 9 data UPDATE                                                                                                                                                                                                   | none                                          |
| `cancel_agent_run`                          | current context/CSRF and existing authority/dashboard columns; global `agent_runs` cancel-operation lookup projection `(organization_id,dashboard_id,run_id,tenant_cancel_operation_id,tenant_cancel_operation_sha256,tenant_cancel_result_sha256,tenant_cancel_result_run_revision,tenant_cancel_result_event_sequence,tenant_cancel_result_event_sha256)` plus the exact immutable `audit_events` cancel-operation projection frozen above; target `agent_runs`, exact stored result `agent_run_events` header, `agent_run_attempts`, and `agent_run_budget_counters`. Found exact replay reads only and performs no settlement; audit-without-run is terminal `P1001`.                  | fresh identity only: `agent_run_events`, `agent_run_event_payloads`, `audit_events`; exact replay: none                                                                                                                                             | fresh identity only: run/counter/attempt sets including the six tenant-cancel fields and exact dispatched candidate-field exception; exact replay: none                                                                                                   | none                                          |
| `get_agent_run`                             | existing authority/dashboard columns; `agent_runs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                      | none                                          |
| `list_agent_run_events`                     | existing authority/dashboard columns; `agent_runs`, `agent_run_events`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                      | none                                          |
| `get_agent_run_checkpoint`                  | existing authority/dashboard columns; `agent_runs`, `agent_run_checkpoints`, `agent_run_checkpoint_payloads`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                      | none                                          |
| `get_agent_candidate`                       | existing authority/dashboard columns; `agent_runs`, `agent_candidates`, `agent_candidate_payloads`, `candidate_evidence_manifests`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                      | none                                          |
| `claim_agent_run`                           | latest-principal bootstrap; initial exact global operation-ID event-header discovery nonlockingly under the operation gate, then the named ordinary/mixed retry projection reread nonlockingly after full-context promotion/run lock; ordinary discovery columns only when no operation exists; existing authority/policy/dashboard columns; `agent_run_policy_revisions`, `agent_runs`, `agent_run_attempts`, `agent_run_budget_counters`, `agent_run_events`; no event-payload SELECT or event row-lock authority                                                                                                                                                                        | fresh claim/takeover only: `agent_run_events`, `agent_run_event_payloads`; exact ordinary/mixed retry: none                                                                                                                                         | every promoted path: exact principal/policy lock-only keys; fresh claim/takeover additionally run/counter/attempt sets above, with exact mixed-takeover candidate-field exception; exact ordinary/mixed retry: no data UPDATE                             | none                                          |
| `get_claimed_agent_run_input`               | bootstrap and existing authority/dashboard columns; current `agent_runs`, request payload, policy, field catalog/entries, metric contracts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | none                                                                                                                                                                                                                                                | lock-only keys only                                                                                                                                                                                                                                       | none                                          |
| `clone_claimed_replay_prerequisites`        | bootstrap/current+source authority/dashboard/request/run rows; exact source recorded-result/candidate-set/candidates/bundle/membership/Brief and local absence/replay-fence rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | local `candidate_comparison_bundles`, `candidate_comparison_bundle_evidence`, `briefs`, `agent_run_events`, `agent_run_event_payloads`                                                                                                              | run set only                                                                                                                                                                                                                                              | none                                          |
| `list_claimed_replay_results`               | bootstrap and existing authority/dashboard columns; current/source `agent_runs`, current request payload, common bundle/membership, Brief, source recorded results                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                | lock-only keys only                                                                                                                                                                                                                                       | none                                          |
| `consume_agent_replay_result`               | bootstrap and existing authority/dashboard columns; current/source `agent_runs`, current request payload, common bundle/membership, Brief, exact source recorded result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `agent_recorded_results`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                            | run set only                                                                                                                                                                                                                                              | none                                          |
| `write_agent_run_checkpoint`                | authority/dashboard/run/event-header reads plus only `checkpoint_event_payload_columns` for the current run's sequence `1..source_event_sequence` under `checkpoint_replay`; replay purpose also unions the exact source fence after final consumption                                                                                                                                                                                                                                                                                                                                                                                                                                     | `agent_run_checkpoints`, `agent_run_checkpoint_payloads`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                            | run set only                                                                                                                                                                                                                                              | none                                          |
| `reserve_agent_run_attempt`                 | authority/dashboard/run/policy/complete attempt queue/counter and exact request payload reads; every kind reads the frozen common bundle and policy instruction digest; planner reads bundle/request, specialist and generator read the successful planner result plus Brief and optional specialist result; repair additionally reads the invalid generator attempt/result payload/recorded result, invalid validation digest, bundle membership, and later-slot releases; reviewer additionally reads every frozen candidate/payload, validation finding, Claim/edge set, and manifest absence plus exact aggregate hashes                                                               | `agent_run_attempts`, `agent_run_attempt_payloads`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                  | run/counter sets only                                                                                                                                                                                                                                     | none                                          |
| `start_agent_run_attempt`                   | authority/dashboard/run/complete attempt queue/request-payload reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                                      | run set and attempt `state`, `dispatch_ready_at` only                                                                                                                                                                                                     | none                                          |
| `authorize_agent_run_attempt_invocation`    | fresh bootstrap/authority/dashboard/source/policy/run/complete attempt queue/request-payload/counter and grammar reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                                      | run set and attempt `state`, `dispatch_started_at` only                                                                                                                                                                                                   | none                                          |
| `reconcile_agent_run_attempt`               | authority/dashboard/run/policy/complete attempt queue/request-payload/counter reads; bounded `actual_accounting_bytes` is a function-local argument, not a relation read; candidate outputs additionally dashboard-spec validator, common bundle/membership and material-extraction predecessors; reviewer output additionally frozen candidate set/spec, validation-finding, and claim-set hashes                                                                                                                                                                                                                                                                                         | normal determinate only: result-kind `agent_run_attempt_payloads`, `agent_recorded_results`; always `agent_run_events`, `agent_run_event_payloads`; never raw accounting bytes                                                                      | run/counter/attempt typed-vector sets only; caller/malformed/over-reservation branches derive respectively `caller_indeterminate`, `malformed_accounting`, or `actual_over_reservation`, store null actual, and apply the exact candidate-field exception | none                                          |
| `release_agent_run_attempt`                 | authority/dashboard/run/complete attempt queue/counter reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                                      | run/counter/attempt sets only                                                                                                                                                                                                                             | none                                          |
| `commit_agent_brief`                        | authority/dashboard/run, exact common bundle, sole successful planner `agent_run_attempts` row, its request/result `agent_run_attempt_payloads`, and matching `agent_recorded_results` planner output; request bytes must carry the same input/bundle/instruction hashes and result bytes must contain the submitted Brief exactly                                                                                                                                                                                                                                                                                                                                                         | `briefs`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                            | run set only                                                                                                                                                                                                                                              | none                                          |
| `commit_common_evidence_bundle`             | Suggest authority/dashboard/run plus exact `agent_run_request_payloads`, `field_catalog_snapshots`, every frozen `field_catalog_entries` row, every frozen `metric_contract_versions` row, source snapshot, and the union's exact evidence rows; reads only those request-named IDs and columns needed to recompute the lineage union and entry equality                                                                                                                                                                                                                                                                                                                                   | `candidate_comparison_bundles`, `candidate_comparison_bundle_evidence`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                              | run set only                                                                                                                                                                                                                                              | none                                          |
| `commit_calculation_graph`                  | authority/dashboard/run/catalog/contract/bundle header and nonlocking freshly revalidated membership/input/evidence predecessors, including exact catalog entry and complete MetricContractVersion columns, graph/result output bytes, FX typed-value body, derived freshness classifier/input/source row, and contract-to-graph/output/meter conformance                                                                                                                                                                                                                                                                                                                                  | `calculation_graphs`, `calculation_results`, `agent_run_calculation_meters`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                         | run set only                                                                                                                                                                                                                                              | none                                          |
| `commit_agent_validation_findings`          | authority/dashboard/run/candidate/spec payload plus exact calculation-result and common-bundle evidence predecessors named by findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `agent_validation_findings`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                         | run set and candidate `validation_state` only                                                                                                                                                                                                             | none                                          |
| `commit_agent_candidate`                    | authority/dashboard/run/graph/result/attempt/recorded-result/Brief/bundle predecessors plus exact precommit-validation binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `agent_candidates`, `agent_candidate_payloads`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                      | run set only                                                                                                                                                                                                                                              | none                                          |
| `close_agent_candidate_set`                 | authority/dashboard/run/candidate payload/material-set/bundle predecessors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                                      | run set only                                                                                                                                                                                                                                              | none                                          |
| `commit_candidate_claims`                   | authority/dashboard/run/request input bytes/candidate payload/material-set/bundle header and freshly revalidated membership/evidence predecessors plus exact source snapshot, field catalog entries, MetricContractVersion, and every named `calculation_results`/`calculation_graphs` row; for calculated claims it parses the exact result output/row/cell/value and recomputes both output digests and the DashboardSpec subtree mapping, including the derived freshness classifier/input/source-row maximum when used                                                                                                                                                                 | `claims`, `claim_evidence`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                          | run set only                                                                                                                                                                                                                                              | none                                          |
| `commit_candidate_manifest`                 | authority/dashboard/run/request input bytes/candidate payload/material-set/validation/Claim/bundle header and freshly revalidated membership/evidence/reviewer-result predecessors plus exact source/catalog/MetricContractVersion and every calculated Claim's graph/result/output mapping, including freshness classifier/input/source-row maximum when used                                                                                                                                                                                                                                                                                                                             | `candidate_evidence_manifests`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                      | run set and candidate `review_state`, `manifest_sha256` only                                                                                                                                                                                              | none                                          |
| `commit_run_abstention`                     | authority/dashboard/run/attempt predecessors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `run_abstentions`, `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                   | run set only                                                                                                                                                                                                                                              | none                                          |
| `finalize_agent_run_ranking`                | authority/dashboard/run/request input bytes/candidate payload/material-set/validation/Claim/manifest/review/bundle header and freshly revalidated membership predecessors plus complete source/MetricContractVersion/catalog and every calculated Claim's exact graph/result/output/row/cell/value mapping, including freshness classifier/input/source-row maximum when used                                                                                                                                                                                                                                                                                                              | `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                                      | run set and candidate `rank`, `selected` only                                                                                                                                                                                                             | none                                          |
| `finish_agent_run`                          | authority/dashboard/run/attempt predecessors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `agent_run_events`, `agent_run_event_payloads`                                                                                                                                                                                                      | run set only                                                                                                                                                                                                                                              | none                                          |
| `drain_dashboard_agent_runs`                | initializer baseline; exact existing coordination/policy/dashboard/hold columns used in section 4.5; predecessor SELECT on target `dashboard_cleanup_attempts` exact columns `organization_id,dashboard_id,cleanup_attempt_id,step,started_at,finished_at,result,proof_sha256`; SELECT ALL on run/attempt/counter/event headers and drain-proof/consumption rows                                                                                                                                                                                                                                                                                                                           | `dashboard_agent_drain_proofs`, `agent_run_events`, `agent_run_event_payloads`, `audit_events`                                                                                                                                                      | run/counter/attempt sets; dispatched cancellation applies the exact candidate-field exception                                                                                                                                                             | none                                          |
| replaced `claim_dashboard_cleanup`          | complete signature-specific phase6 baseline, explicitly including predecessor `dashboard_cleanup_attempts(organization_id,dashboard_id,cleanup_attempt_id,step,started_at,finished_at,result,released_claim_count,deleted_resource_count,deferred_claim_count,failure_code,proof_sha256)`; additive SELECT ALL on drain proofs/consumptions plus exact `agent_runs(organization_id,dashboard_id,run_id,state,lease_owner_principal_id,lease_expires_at,current_event_sequence,current_event_sha256)` and `agent_run_events(organization_id,dashboard_id,run_id,event_sequence,event_kind,event_sha256)` needed for physical zero/event-range verification                                  | baseline inserts plus `dashboard_agent_drain_proof_consumptions`                                                                                                                                                                                    | baseline only                                                                                                                                                                                                                                             | baseline only                                 |
| replaced `record_dashboard_cleanup_attempt` | complete signature-specific phase6 baseline, explicitly including the same predecessor cleanup-attempt columns; additive SELECT ALL on latest generated drain proof/consumption needed to recompute completion proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | baseline only                                                                                                                                                                                                                                       | baseline only                                                                                                                                                                                                                                             | baseline only                                 |
| replaced `purge_dashboard`                  | complete signature-specific phase6 baseline, explicitly including the same predecessor cleanup-attempt columns and exact completion-proof row; additive SELECT ALL on every phase-7 dashboard-scoped relation in section 4.2 and owner-visible FK/count catalog                                                                                                                                                                                                                                                                                                                                                                                                                            | baseline only                                                                                                                                                                                                                                       | baseline plus exactly the eighteen retention-clear columns                                                                                                                                                                                                | exact content-purge table list in section 4.5 |
| `age_out_dashboard_agent_run_metadata`      | initializer baseline; exact `dashboards(organization_id,dashboard_id,lifecycle_revision,tombstone_lineage_id,purged_at)`, legal-hold `(organization_id,dashboard_id,released_at)`, the one tombstone named by the locked dashboard `(organization_id,tombstone_lineage_id,purged_at,purged_lifecycle_revision,purged_proof_sha256)`, its backup ledger `(organization_id,ledger_sequence,tombstone_lineage_id,event_kind,proof_sha256)`, predecessor cleanup-attempt completion-proof columns, SELECT ALL on retained Task 9 headers and age-out proof rows, plus owner-visible affected-count/FK catalog; event reads are exact target runs in unsigned run-UUID/ascending-sequence order | `dashboard_agent_run_age_out_proofs`, `audit_events`                                                                                                                                                                                                | none                                                                                                                                                                                                                                                      | exact age-out table list in section 4.5       |

The four formerly implicit body projections are frozen, not inferred from table
ACLs:

- `commit_agent_brief` selects exactly
  `agent_run_attempts(attempt_id,attempt_kind,state,request_payload_id,
result_payload_id,candidate_slot,retry_of_attempt_id,lease_epoch,reconciled_at)`,
  both named `agent_run_attempt_payloads(attempt_id,payload_kind,payload_id,
canonical_bytes,payload_sha256)`, and
  `agent_recorded_results(result_sequence,result_id,attempt_id,result_payload_id,
result_kind,canonical_bytes,result_sha256,prior_result_head_sha256,
result_head_sha256)`, plus the already matrixed run/policy/bundle columns. It requires
  the sole grammar-position planner attempt to be `succeeded`, its request to carry
  the frozen input/bundle/instruction hashes, its result kind to be
  `planner_output`, and the nested Brief to byte-equal the submitted bytes.
- `commit_common_evidence_bundle` selects exactly the run's
  `agent_run_request_payloads(request_payload_id,run_request_id,
request_idempotency_sha256,canonical_bytes,request_sha256)`, every request-nested
  catalog header matched to
  `field_catalog_snapshots(organization_id,dashboard_id,catalog_snapshot_id,
input_snapshot_id,input_sha256,input_row_count,evaluated_at,catalog_sha256,
canonical_bytes)`,
  field object matched to all relation-row-15 columns except `entry_sha256` first and
  then to its recomputed `entry_sha256`, and every request-nested contract object
  matched to all relation-row-16 columns except `contract_set_sha256,
contract_sha256,created_at` first and then to those recomputed hashes. It selects only
  the request-named
  `source_snapshots(organization_id,snapshot_id,source_kind,canonical_bytes,
content_sha256,observed_at,retrieved_at,created_at)` and exact lineage-union
  `evidence_records(organization_id,evidence_id,snapshot_id,evidence_kind,
coordinates,transformation,content_sha256,observed_at,retrieved_at,created_at)`
  rows. This is sufficient to prove exact source, union membership, typed FX body,
  timestamps, and entry equality and adds no organization-wide scan or unused
  predecessor column.
- `reserve_agent_run_attempt` selects the complete attempt queue and request
  payloads. Planner additionally selects the committed bundle and request payload;
  specialist/generator select the exact Brief and required successful predecessor
  recorded result. Repair selects the invalid generator attempt plus its request and
  result payloads, recorded result, parsed invalid precommit-validation digest,
  common bundle/membership, Brief, optional specialist result, and every higher-slot
  release row. Reviewer selects the frozen candidate rows/payloads, each immutable
  validation finding, complete Claim/edge sets (including calculated output
  identities), and requires zero manifest rows before review; it recomputes both
  aggregate hashes. These are key-bounded reads under the current run context.
- The calculated-freshness projection used identically by
  `commit_candidate_claims`, `commit_candidate_manifest`, and
  `finalize_agent_run_ranking` selects the same-run
  `agent_run_request_payloads(canonical_bytes,request_sha256)`, exact
  `source_snapshots(snapshot_id,canonical_bytes,content_sha256)`, the bound
  `field_catalog_entries(field_id,event_time_field_id,entry_sha256)`, complete named
  `metric_contract_versions`,
  `calculation_graphs(graph_id,contract_set_id,contract_id,contract_version,
catalog_snapshot_id,freshness_classifier_node_id,freshness_input_node_id,
freshness_source_row_id,graph_sha256,canonical_bytes)`, and
  `calculation_results(result_id,graph_id,result_sha256,meter_sha256,
canonical_bytes)`. It also selects the exact bundle header
  `(bundle_id,evidence_count,bundle_sha256,canonical_bytes)` and its mandatory
  nonlocking fresh membership projection. These columns are sufficient to reparse
  the canonical input, locate the contract event-time field, derive the maximum and
  first-ordinal tie row, validate the checked threshold/classifier/result output, and
  compare DashboardSpec bytes. No arbitrary source row, classifier input, threshold,
  or contract is supplied by the Claim.

Task 9A records for every function the ordered SQL relation/column projection, join
keys, lock mode, and body dependency. The grant/policy union is exactly the union of
those listed projections and the already frozen transition writes; it adds no
`EXECUTE` helper, predecessor UPDATE beyond lock-only key columns, event-body read,
cross-run scan, or table ownership. Removing one required projection or adding one
unread column is fixture drift; weakening the comparison is not an alternative.

The age-out profile's additive predecessor column grant includes
`dashboards.tombstone_lineage_id` exactly once. Its retention SELECT/lock policy on
`dashboard_tombstones` and `backup_deletion_ledger` requires the initialized target
organization/dashboard plus equality to that locked dashboard lineage value; the
body may not enumerate another tombstone. Task 9A transcribes those column grants, policy
qualifiers, lock order, and dependencies against `phase6-retention-baseline-v1`.

`dasher_security_definer` receives only the tenant rows from `request_agent_run`
through `get_agent_candidate`; `dasher_run_definer` only the operator rows from
`claim_agent_run` through `finish_agent_run`; `dasher_retention_definer` only the
last five. Each phase-7 tenant relation has only the applicable exact policies:
`<relation>_security_definer_{select|insert|update}` requires `current_user =
'dasher_security_definer'`, full `context_allows`, exact organization/resource in
`USING`, and the same exact keys plus function phase in `WITH CHECK`;
`<relation>_run_definer_{select|insert|update}` requires `current_user =
'dasher_run_definer'`, exact principal revision/capability/phase/organization/run/
lease context in both clauses; and
`<relation>_retention_definer_{select|insert|update|delete}` requires `current_user =
'dasher_retention_definer'`, exact initialized target organization/dashboard,
principal revision/capability/lifecycle/cleanup lease, and hold predicate. A command
not present in the matrix has no policy and no grant. Lock-only policies use their
already fixed names, `USING` exact key equality, and `WITH CHECK (false)`.
For the two non-tenant run locks those exact names are
`run_service_principal_allowlist_run_lock_update` and
`agent_run_policy_revisions_run_lock_update`, and exact key equality means the proven
transaction-local principal ID/revision and policy revision, respectively; their
column grants are key-only and never table-wide.
`agent_run_events_run_claim_retry_select` is the sole explicitly named exception to
the promoted-organization run SELECT template and has exactly the pre-organization
claim-ID/latest-principal predicate and fixed event-header query projection in
sections 4.4/4.6; it adds no mutation policy or event-payload privilege.
Its header reads are nonlocking; no event UPDATE column, lock-only policy, or
row-locking clause is reachable through this exception.

Triggers are likewise closed: `agent_run_immutable_guard` rejects UPDATE/DELETE,
including a no-op UPDATE, on every append-only Task 9 relation and therefore guards
both principal/policy lock-only relations; `agent_run_transition_guard` admits only the
function/event/source/target/column-set rows in the transition matrix;
`agent_run_retention_guard` admits only the eighteen retention clears and enumerated
retention DELETE sets under exact retention context. The transition guard's
`claim_agent_run` ordinary and mixed branches independently rederive their input/
result identities, enforce the global event-header ID collision rule, and require the
typed result projection equalities; the mixed branch additionally rederives the
settlement/terminal-operation digests and requires the aggregate body/header/source-
head/principal/run-field equalities. Every reconcile, takeover, tenant-cancel, and
retention-drain trigger branch with no actual vector independently requires zero
outstanding, `used.candidates=0`, `released.candidates=reserved.candidates`, and
`used=reserved,released=0` for every other field before validating per-attempt and
aggregate event vectors. It rejects claim columns in every other branch.
For `attempt_indeterminate`, the transition trigger accepts exactly
`caller_indeterminate`, `malformed_accounting`, `actual_over_reservation`, or
`takeover_after_dispatch` and rejects any other or caller-selected value. The fixed,
body-hashed reconcile function is the sole authority that derives the first three:
it derives caller indeterminate from the three SQL NULL arguments and derives the
other two from its function-local raw parser/typed comparison. The trigger never
receives, reparses, stores, or hashes raw accounting bytes; it independently checks
the resulting source/target, null stored actual/result, settlement equations, and
event/row vector equality. The fixed takeover body is the sole authority for the
fourth literal under its separately checked source/settlement contract. Tenant-
cancel and drain branches require reasonless
`attempt_cancelled_charged` and reject `attempt_indeterminate` or a `reason_code` key.
The checkpoint branch independently enforces the closed four-literal event registry
and state/vector mapping while deriving semantic state, then derives the envelope
digest; it neither needs nor reconstructs the reconcile wire bytes.
The retention guard requires the two mixed-takeover run digests, four claim-event
fields, and checkpoint state/pointer to clear in their exact groups. The age-out proof insert guard requires the
closed chain-set/count/check equalities before admitting its immutable row. Task 9A expands each profile
into an ordered catalog fixture of relation/command/column list, policy name/role/
expressions, and trigger branch/body hash. Cumulative assertions plus real-role tests
prove required fixed calls, direct/no-op DML denial, no extra grant/policy, and
rollback on policy/trigger/audit failure.

## 5. Deterministic calculation contract

Create `packages/calculation-engine` as a pure, side-effect-free package. It has
no database, filesystem, network, clock, random, process, dynamic import, eval,
Function constructor, SQL, regex evaluator, or provider dependency.

### 5.1 Closed AST and canonicalization

The strict discriminated AST includes only the operation names in the table below.
`select` is the sole projection operation; `project`, `projection`, and `map` are
unknown. `percentage_change` is the sole percentage-change name;
`percent_change` is unknown. `round` and `classify_state` are explicit operations;
there is no generic `aggregate`, `window`, `classify`, or formula name. Static and
runtime meters use the exact operation-to-charge mapping below, never aliases or an
open operation class.

`calculation-graph-v1` is the sole graph schema and uses row-hash domain
`dasher.calculation-graph.v1`. Its exact top-level fields are `schema`, `registry`,
`limits`, `graph_id`, `contract_set_id`, `contract_id`, `contract_version`,
`contract_output_node_id`, `threshold_node_id`, `target_node_id`,
`input_snapshot_id`,
`input_sha256`, `field_catalog_snapshot_id`, `field_catalog_sha256`,
`common_bundle_id`, `common_bundle_sha256`, `evaluation_time`, `timezone`,
`tzdb_version`, `unit_registry_version`, `fx_evidence_id`, `fx_evidence_sha256`,
`nodes`, and `output_node_ids`. Registry/limits are exactly
`calculation-registry-v1`/`calculation-limits-v1`; evaluation time is UTC RFC 3339
with six fractional digits; timezone is IANA; tzdb is `2025b`; unit registry is
`ucum-subset-v1`. FX ID/SHA are both null unless `currency_convert` exists and
otherwise identify one exact `fx-rate-evidence-v1` typed-value synthetic fixed-rate row in the
common bundle. Every currency-convert node must repeat that same ID and the one pair/
rate bound by that evidence; a graph cannot carry two FX pairs or rates.
Untrusted raw graph UTF-8 has a first, pre-parse ceiling of 131,072 bytes. After
strict parse, NFC normalization, revalidation, and JCS re-encoding, canonical graph
bytes have a distinct 65,536-byte ceiling; `ast_bytes` meters only the latter. Both
gates are inclusive, occur in that order, and have separate at/one-over fixtures.
There are 1..128 nodes in deterministic topological order: at each step choose the
lexicographically smallest UUID among ready nodes. Node IDs and 1..32 output IDs are
unique and `output_node_ids` are sorted by UUID; every input references an earlier
node. The exact common node fields are `node_id`, `op`, `output_type`, and
`evaluation_rows_from`. `source|select|filter|group|sort|top_k` are the only rowset
nodes and require null `evaluation_rows_from`; every other operation is scalar and
requires the exact prior rowset whose row IDs form its evaluation domain.
`output_type` has exactly `shape`, `scalar`, `nullable`, `unit`, `currency`, `grain`,
`max_value_bytes`, and `fields`. For scalar shape, scalar is
`boolean|integer|decimal|text|date|timestamp|duration`, `fields` is null, and
`max_value_bytes` is positive tagged `i64`; unit/currency/grain are null only when
inapplicable. For rowset shape, the six scalar attributes after `shape` and before
`fields` are null and `fields` is
1..64 entries `{field_id,name,scalar,nullable,unit,currency,grain,max_value_bytes}`
sorted by field UUID, with each width a positive tagged `i64`; the sole exception is
a zero-key `group`, whose fields array is exactly empty. SQL and TypeScript rederive
every output type/field ID and reject caller mismatch. `contract_output_node_id`
names the one output node that implements the bound MetricContractVersion.
`threshold_node_id` and `target_node_id` follow the exact contract-direction rules
below; each nonnull ID names a boolean output node and is distinct from every other
contract identity. All three IDs participate in graph JCS/hash bytes and are never
selected by an implementation heuristic.

The following table is the complete op-specific key registry; common keys plus the
listed keys are the only accepted keys:

| `op`                                                                        | Exact op-specific fields and constraints                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                                                                    | `field_ids`; 1..64 sorted unique catalog UUIDs, output rowset                                                                                                         |
| `field`                                                                     | `input,field_id`; input is a rowset, evaluation domain equals it, and field is in its output                                                                          |
| `literal`                                                                   | `value`; exact tagged scalar below, broadcast over `evaluation_rows_from`                                                                                             |
| `select`                                                                    | `input,projections`; 1..64 entries `{field_id,name,value_node_id}` sorted by field UUID; each field ID is the derived UUID below                                      |
| `filter`                                                                    | `input,predicate`; predicate scalar boolean                                                                                                                           |
| `group`                                                                     | `input,key_node_ids`; 0..16 sorted unique scalar keys whose evaluation domain is input                                                                                |
| `sort`                                                                      | `input,keys`; 1..16 entries `{value_node_id,direction,nulls,tie}`; direction `asc\|desc`, nulls `first\|last`, exactly one final `tie=true` stable unique key         |
| `top_k`                                                                     | `input,k`; tagged `i64:1..i64:1000`, input must already have total sort                                                                                               |
| `rank`                                                                      | `input,partition_node_ids,keys`; scalar integer over input rows, 0..16 partitions and same total-sort key schema                                                      |
| `count_rows`                                                                | `group_node_id`; scalar integer over that group's stable row IDs                                                                                                      |
| `count_present` / `sum` / `min` / `max`                                     | `input,group_node_id`; input scalar is evaluated over the group node's input rows; output is over group row IDs                                                       |
| `mean`                                                                      | `input,group_node_id,scale,rounding`; same grouping, tagged scale `i64:0..i64:18`, rounding `none\|half_even`                                                         |
| `add` / `subtract` / `multiply` / `divide`                                  | `left,right,scale,rounding`; tagged scale `i64:0..i64:18`; exact closed operand/metadata/result/error contract below; `none` requires an exact result at that scale   |
| `absolute`                                                                  | `input`                                                                                                                                                               |
| `clamp`                                                                     | `input,minimum,maximum`; literal bounds with `minimum <= maximum`                                                                                                     |
| `round`                                                                     | `input,scale,rounding`; tagged scale `i64:0..i64:18`, rounding `none\|half_even`, with the same exactness rule                                                        |
| `equal` / `not_equal` / `less` / `less_equal` / `greater` / `greater_equal` | `left,right`; identical comparable type/unit/currency/grain                                                                                                           |
| `and` / `or`                                                                | `left,right`; boolean scalars                                                                                                                                         |
| `not`                                                                       | `input`; boolean scalar                                                                                                                                               |
| `if_then_else`                                                              | `condition,when_true,when_false`; branches identical typed shape                                                                                                      |
| `coalesce`                                                                  | `inputs`; 1..16 identical typed scalar inputs                                                                                                                         |
| `lag`                                                                       | `input,partition_node_ids,keys,offset`; total-order keys as above, tagged offset `i64:1..i64:10000`                                                                   |
| `delta` / `percentage_change`                                               | lag fields plus `scale,rounding`; tagged scale `i64:0..i64:18`, rounding `none\|half_even`                                                                            |
| `window_sum`                                                                | `input,partition_node_ids,keys,preceding,following`; row-count frame only, total order, tagged bounds `i64:0..i64:10000`, declared inclusive width <=10000            |
| `window_mean`                                                               | row-count window-sum fields plus tagged `scale` and `rounding` exactly `none\|half_even`; no temporal frame discriminator                                             |
| `unit_convert`                                                              | `input,from_unit,to_unit,registry_version,scale,rounding`; exact closed `ucum-subset-v1` registry below, compatible dimensions, tagged scale, and exact rounding enum |
| `currency_convert`                                                          | `input,from_currency,to_currency,fx_evidence_id,rate,scale,rounding`; exact four-currency synthetic FX registry/evidence/formula below                                |
| `classify_state`                                                            | `input,stale_after_millis,evaluation_time`; timestamp input, nonnegative tagged `i64` threshold, exact top-level time, derived text output                            |

Total-sort availability is AST-derived metadata, not a caller field. A `sort` node
creates an order certificate containing its exact `keys.length` in `1..16`.
`filter` and `top_k` preserve that certificate unchanged; every other rowset node,
including `source`, `select`, and `group`, has no certificate. Therefore `top_k.input`
must be a `sort` followed only by zero or more `filter|top_k` nodes. Let `q` be the
current node's tagged top-count literal and let `s` be the inherited certificate's
sort-key count. `q` controls only output cardinality and `max_top_k`; `s` controls the
comparison charge. Neither value is inferred from output rows or conflated with the
other. Static validation derives both from the canonical AST, and runtime verifies
the same certificate chain before metering.

#### Frozen arithmetic registry

`add|subtract|multiply|divide` accept only scalar `integer|decimal` operands. SQL
and TypeScript convert either accepted type directly to an exact reduced rational;
they never route an integer through binary float or silently preserve an integer
output. All four operations derive scalar `decimal`, `fields = null`,
`max_value_bytes = i64:74`, `nullable = left.nullable OR right.nullable`, and the
same `evaluation_rows_from` as both operands. The two operand evaluation domains and
grains must be byte-identical, including both-null grain. The result preserves that
grain. The node's `scale` is the sole requested quantization scale, not an output-type
field; canonical stripping may produce a stored value with a smaller scale.

The accepted metadata combinations are exhaustive:

| Operation        | Operand unit/currency combination                                                                                                                                                    | Derived unit / currency                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `add`,`subtract` | both units and currencies null; or the same exact non-affine `ucum-subset-v1` unit with both currencies null; or both units null and the same exact currency from `iso4217-task9-v1` | preserve the exact pair                            |
| `multiply`       | both units null and both currencies null                                                                                                                                             | null / null                                        |
| `divide`         | both units and currencies null; or the same exact non-affine registry unit with both currencies null; or both units null and the same exact `iso4217-task9-v1` currency              | exact unit `1` / null for all three admitted cases |

No operand may carry both unit and currency. Affine `Cel|[degF]`, unequal units,
unitful multiplication, unlike currency arithmetic, currency multiplication, and
unit/currency cancellation not literally listed above are rejected; there is no
dimensional algebra or invented compound unit. Two bare numeric operands with null
unit/currency are the registry's dimensionless-input spelling; division materializes
that dimension explicitly as exact registry unit `1`. No other operation silently
changes null metadata to `1`. Percentage values are ordinary
unit-bearing values with exact unit `%`: they may add/subtract another `%` value and
may divide by `%` to yield unit `1`, but may not multiply. A ratio may be explicitly
converted from `1` to `%` only by `unit_convert`.

For every present/stale operand pair, form reduced rationals `a` and `b`, perform
exactly one rational operation (`a+b`, `a-b`, `a*b`, or `a/b`), sign-normalize and
GCD-reduce once, then perform the one final node quantization. Quantization multiplies
by `10^scale`; `none` requires an integer coefficient and `half_even` uses symmetric
nearest/ties-to-even. The coefficient must have at most 38 digits excluding sign,
then the ordinary decimal trailing-zero/zero canonicalization runs. There is no
intermediate quantization. Integer operands therefore affect only the input rational
denominator (`1`); mixed integer/decimal and integer/integer cases still return the
same canonical decimal type/bytes under this rule.

Validation and failure precedence is exact: unknown key/op or malformed scale/
rounding is `invalid_graph`; nonnumeric input, evaluation-domain drift, or derived
shape/scalar/nullability/fields/width drift is `type_mismatch`; grain drift is
`grain_mismatch`; a forbidden/mismatched currency combination or derived currency
drift is `currency_mismatch`; a forbidden/mismatched unit combination or derived
unit drift is `unit_mismatch`; then static meter/range ceilings are checked. At
evaluation, strict state propagation occurs before arithmetic. For two
computable values, divide checks an exact zero denominator before quantization or
coefficient range and returns `divide_by_zero`; an inexact `none` quantization is
`inexact_arithmetic`; a greater-than-38-digit final coefficient is `overflow`; a meter ceiling
breach is `limit_exceeded`. This order is identical for positive/negative values and
prevents an overflowing numerator from masking divide-by-zero. Each arithmetic node
charges exactly `n` primitive steps for its evaluation domain, including propagated
non-present rows; rational reduction and quantization add no hidden charge.

The static validator derives this exact metadata and the fixed 74-byte value width
without inspecting caller `output_type`, then compares the caller bytes. It carries
exact rational ranges for literals and operations whose operand bounds are known;
otherwise the representable range is exactly coefficients of at most 38 digits at
scale `0..18`, with runtime overflow as above. PostgreSQL independently parses the
graph/input/result, rederives the same operation category, output metadata, rational
values, canonical result bytes, and meter before commit; it does not trust a
TypeScript type or result serialization. Fixtures cover all table cells, both
nullable values, null and nonnull grain, every integer/decimal pairing, scales 0/18,
exact/inexact half-even signs, currency/unit rejection, zero divisor, 38/39 digits,
and each adjacent error-priority pair.

##### Frozen non-conversion operation registry

This subsection closes every registry operation not already closed by the four-
operation arithmetic, unit-conversion, or FX tables. `W(t)` is the maximum canonical
JCS byte length of one tagged runtime value of scalar `t`, excluding the outer
`{state,type,value}` keys: boolean `5`, integer `26`, decimal `74`, date `12`,
timestamp `29`, duration `26`, and text the source/catalog or literal's exact positive
`max_value_bytes`. For text that width is the complete canonical JCS string token,
including quotes/escapes, not an unescaped code-point count. A derived fixed text
enum uses the longest admitted quoted value;
therefore `classify_state` uses `i64:9`. Unit and currency are mutually exclusive on
every scalar. An operation described as numeric accepts only `integer|decimal`.
“Preserve metadata” means exact scalar/nullability/unit/currency/grain/width and
evaluation domain except for a specifically listed derived field. Every scalar input
to one multi-input operation has the same `evaluation_rows_from`; drift is a type
error before evaluation.

Scalar metadata validity is global and precedes operation validation. Boolean, text,
date, timestamp, and duration require null unit and currency; duration is exact tagged
microseconds, while a measured duration is instead numeric decimal with a listed
duration unit. Integer/decimal permit at most one of a listed unit or listed currency.
Only integer/decimal may carry either. Catalog, source, literal, derived node, result,
and contract-output metadata all obey these same combinations, so no operation can
admit such dimensional nonsense as a timestamp currency or boolean metres.

The complete source/rowset derivation is:

| Operation | Accepted input and exact derived shape/fields/order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | `field_ids` names exact catalog entries for the graph snapshot. Its rowset fields copy field ID, `logical_name`, scalar, nullable, unit, currency, grain, and `max_value_bytes` exactly in field-ID order; rows and cells copy the canonical input states/values and preserve input row order.                                                                                                                                                                                                                                               |
| `field`   | Names one input rowset field and derives that field's exact scalar metadata and row domain; it emits the named cell value for every input row.                                                                                                                                                                                                                                                                                                                                                                                               |
| `literal` | Derives scalar from `value.type`, nullable iff `value.state = null`, null unit/currency/grain, and `W(type)` (text uses the exact literal JCS string length, at least one). It broadcasts the same value over its named domain. The sole contextual exception is a present threshold/target literal consumed only by its corresponding graph-level comparison: it derives the contract output's unit/currency/grain and scalar, and its decimal string must encode exactly in that scalar; any second/different consumer is `invalid_graph`. |
| `select`  | Each projection value is a scalar on the input domain. The derived field ID is the frozen UUIDv8, name is the submitted NFC name, and all remaining field metadata is copied from the value node. Fields sort by derived UUID; rows preserve input IDs/order and cells sort by field UUID. Duplicate names or derived IDs deny.                                                                                                                                                                                                              |
| `filter`  | Predicate is boolean on the input domain. Output field schema is byte-identical to input; it preserves only rows whose predicate is present/stale true, in input order.                                                                                                                                                                                                                                                                                                                                                                      |
| `sort`    | Keys are scalars on the input domain and the final tie rule is unique as already specified. Output field schema/row IDs are preserved and rows use the closed comparison order.                                                                                                                                                                                                                                                                                                                                                              |
| `top_k`   | Requires an already totally sorted input, preserves its complete field schema and the first `min(n,q)` row IDs/order, where `q` is its top-count literal and is distinct from inherited sort-key count `s`.                                                                                                                                                                                                                                                                                                                                  |
| `group`   | Every key is a direct `field` node on the input. Before any tuple/group construction, the first unavailable/missing/null key produces closed `invalid_group_key`; only present/stale keys are admitted. It derives one field per key: UUIDv8 as already frozen, name exact ASCII `key_<zero-based ordinal>`, and remaining metadata copied from that field node. A zero-key group has the sole allowed empty rowset field array. Group rows and IDs follow the frozen admitted-key tuple rule.                                               |

For a group whose direct key field IDs are `d[0..k-1]` in submitted key order,
`group_grain` is exact text `group:` plus the lowercase digest from the hash registry
using the bound contract calendar/timezone, count `k`, and those IDs sorted by UUID.
The group output itself has no rowset-level grain; every grouped aggregate below has
`grain = group_grain`. A bound contract's aggregation group keys must equal its
sorted `allowed_dimension_field_ids` exactly. Additional diagnostic groups may use a
sorted subset, but cannot feed `contract_output_node_id`, threshold, or target.

The complete scalar derivation is:

| Operation                                     | Accepted input                                                                                    | Exact derived scalar metadata and successful value                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rank`                                        | input rowset; direct-field partitions and total keys                                              | nonnullable integer, null unit/currency, grain `group_grain` for the partition IDs, width `i64:26`; exact tagged position `i64:(zero-based position + 1)` in each totally ordered partition, with no dense/tie variant                    |
| `count_rows`                                  | group                                                                                             | nonnullable integer, null unit/currency, group grain, width `i64:26`; exact group membership count                                                                                                                                        |
| `count_present`                               | any scalar plus its group                                                                         | nonnullable integer, null unit/currency, group grain, width `i64:26`; count of present/stale values                                                                                                                                       |
| `sum`                                         | numeric scalar plus its group                                                                     | nonnullable decimal, preserves input unit/currency, group grain, width `i64:74`; exact rational sum, typed decimal zero for no contributor                                                                                                |
| `min`,`max`                                   | identical `integer\|decimal\|date\|timestamp\|duration` scalar plus group                         | nonnullable same scalar/unit/currency and width, group grain; exact order minimum/maximum                                                                                                                                                 |
| `mean`                                        | numeric scalar plus group                                                                         | nonnullable decimal, preserves unit/currency, group grain, width `i64:74`; exact sum/present-count then its one requested quantization                                                                                                    |
| `absolute`                                    | numeric                                                                                           | decimal, input nullable/unit/currency/grain/domain, width `i64:74`; exact absolute rational, with integer converted to scale-zero decimal                                                                                                 |
| `clamp`                                       | numeric; bounds are present canonical numeric literal values                                      | decimal, input nullable/unit/currency/grain/domain, width `i64:74`; exact input clipped to inclusive rational bounds. Bounds are interpreted in the input metadata, may mix integer/decimal, and must satisfy minimum <= maximum          |
| `round`                                       | numeric                                                                                           | decimal, input nullable/unit/currency/grain/domain, width `i64:74`; the one requested quantization                                                                                                                                        |
| `equal`,`not_equal`                           | exact same scalar/unit/currency/grain/domain; any scalar                                          | boolean, nullable OR, null unit/currency, preserved grain/domain, width `i64:5`                                                                                                                                                           |
| `less`,`less_equal`,`greater`,`greater_equal` | exact same scalar/unit/currency/grain/domain; `integer\|decimal\|text\|date\|timestamp\|duration` | boolean with the same derivation as equality; numeric signed rational, text unsigned UTF-8, and temporal native canonical order                                                                                                           |
| `and`,`or`                                    | boolean with exact same grain/domain                                                              | boolean, nullable OR, null unit/currency, preserved grain/domain, width `i64:5`                                                                                                                                                           |
| `not`                                         | boolean                                                                                           | boolean, preserves nullable/grain/domain, null unit/currency, width `i64:5`                                                                                                                                                               |
| `if_then_else`                                | boolean condition and branches with exact same scalar/unit/currency/grain/domain/width            | branch scalar/unit/currency/grain/domain/width; nullable is condition OR true-branch OR false-branch nullable                                                                                                                             |
| `coalesce`                                    | 1..16 exact same scalar/unit/currency/grain/domain/width                                          | preserves scalar/unit/currency/grain/domain/width; nullable is AND of all input nullable flags, because any statically nonnull alternative precludes a final explicit-null state                                                          |
| `lag`                                         | any scalar; direct-field partitions plus total keys                                               | preserves all input metadata/domain; missing when no offset row                                                                                                                                                                           |
| `delta`                                       | numeric                                                                                           | decimal, input nullable/unit/currency/grain/domain, width `i64:74`; exact current minus lag followed by one requested quantization. Currency is preserved, never cancelled                                                                |
| `percentage_change`                           | numeric with at most one of unit/currency nonnull                                                 | decimal, input nullable/grain/domain, exact unit `%`, null currency, width `i64:74`; exact `((current-lag)/lag)*100` followed by one requested quantization. Input currency or unit is explicitly cancelled; zero lag is `divide_by_zero` |
| `window_sum`                                  | numeric plus direct-field partitions/total keys/row frame                                         | nonnullable decimal, preserves input unit/currency/grain/domain, width `i64:74`; exact rational sum and typed decimal zero for no contributor                                                                                             |
| `window_mean`                                 | numeric plus the same row frame                                                                   | nonnullable decimal, preserves input unit/currency/grain/domain, width `i64:74`; exact sum/present-count followed by one requested quantization                                                                                           |
| `classify_state`                              | timestamp with null unit/currency and exact top-level evaluation time                             | text, preserves input nullable/grain/domain, null unit/currency, width `i64:9`; exact `current\|stale` formula already frozen                                                                                                             |

`sum`, `absolute`, `clamp`, and `window_sum` do not have a hidden scale: their
integer/decimal inputs are finite base-10 rationals and the exact result is
canonicalized without quantization. `mean`, `round`, `delta`, `percentage_change`,
and `window_mean` perform exactly one final node quantization with their own
`scale,rounding`; `rounding=none` requires exact termination at that scale and
`half_even` is symmetric. No lag subtraction or percentage multiplication is
separately rounded. A successful numeric output must have at most 38 coefficient
digits; canonical stripping follows quantization. The percentage constant 100 is the
exact rational `100/1`, not a literal node or a second meter step.

Static range propagation is equally closed. Source/field ranges are their complete
representable type range unless a catalog fixture supplies a narrower reviewed
range—Task 9 has no such field, so no implementation may invent one. Literal ranges
are singleton. Filter/select/sort/top-k/lag preserve the referenced range; group has
no scalar range; rank/count are `[0,row_upper]` (runtime rank starts at one when a row
exists); sum/window-sum multiply the most-negative/most-positive numeric endpoint by
the admitted contributor bound using exact rationals; min/max preserve input range;
`mean` and `window_mean` both stay in the input convex hull because every successful
value is the exact arithmetic mean of at least one present/stale contributor before
their one final quantization; half-even then expands each endpoint by at most exact
`1/(2*10^scale)`, while `none` adds no expansion. An empty contributor set remains
the runtime `empty_input` path and does not create a static numeric endpoint.
Absolute maps `[lo,hi]` to
`[0,max(abs(lo),abs(hi))]`; clamp is the monotonic total transform
`[clamp(lo,minimum,maximum),clamp(hi,minimum,maximum)]`, where each clamp is exact
`min(max(x,minimum),maximum)`. Thus a range wholly below or above the bounds maps to
the corresponding singleton bound and never becomes an empty interval. Round expands
each endpoint by at most exact `1/(2*10^scale)` only for half-even; comparisons and
boolean operations are `{false,true}`; branches/coalesce union ranges; delta is
`[lo-hi,hi-lo]`; percentage change uses the full representable decimal envelope when
the lag range includes zero and otherwise exact interval division/multiplication;
classification is `{current,stale}`. Runtime state precedence is applied before
numeric evaluation: unavailable propagation/error, then missing, then null, then
stale marking; aggregate empty input, inexact quantization, overflow, and limit
errors retain their separately frozen order. Static range transformation never turns
one of those states into a numeric value. A range beyond the representable envelope keeps
the fixed output width and becomes a runtime overflow possibility; static byte and
meter bounds still use `W(t)`. Range analysis never silently rejects all ordinary
field arithmetic or clamps a value.

Runtime state and error selection are deterministic. Rowset operations first apply
their already frozen row/state rules. A keyed `group` scans all input rows in input
ordinal order and keys in submitted key-node order before constructing any group.
The first unavailable, missing, or null key returns `invalid_group_key`; state kind
does not create three errors and unavailable remains an ordinary value state outside
this use. This validation occurs before key encoding, group count/row IDs/output
bytes, or downstream evaluation. For a failed group, its runtime primitive charge is
exactly `n * group_key_count`, its emitted groups/rows/bytes are zero, and the meter
uses only already completed node outputs plus an empty final `outputs` array. Thus
the failure's meter/result envelope, when returned by the pure engine, is deterministic
even though the SQL commit writer rejects every failed result with zero DML. Rank always emits present. Count always emits
present. Aggregate unavailable dominates; null/missing are ignored; stale marks a
nonempty computed result stale. Sum/window-sum with no contributor emit present exact
zero, while min/max/mean/window-mean with none return `empty_input`. Absolute, clamp,
round, comparisons, `not`, delta, percentage change, lag, and classification use the
strict propagation rule; `and|or|if_then_else|coalesce` use their separately frozen
short-circuit rules. For a graph with multiple runtime failures, the first node in
canonical topological order wins, then the first row ordinal, then this per-node
order: propagated state (which is not an error); `invalid_group_key`;
`divide_by_zero`; `empty_input`;
`inexact_arithmetic`; `overflow`; `limit_exceeded`. Static validation order is exact:
unknown key/op/tag/version -> `invalid_graph`; unknown/non-pinned timezone or tzdb ->
`invalid_timezone`; missing referenced node/catalog field -> `missing_field`; cycle ->
`cycle`; shape/scalar/domain/nullability/width/field drift
-> `type_mismatch`; grain -> `grain_mismatch`; currency -> `currency_mismatch`; unit
-> `unit_mismatch`; then every static meter/range ceiling -> `limit_exceeded`.

The meter has no open operation behavior. Each rowset/scalar output is encoded in
the exact intermediate schemas below, so operation-specific fields cannot disappear
from byte accounting. Static bytes are computed by constructing those same JCS
objects with each field's `W(t)`-byte maximum value, exact maximum tagged ordinal and
UUID text, maximum admitted rows/cells, then measuring UTF-8; runtime constructs the
actual object and measures it. `output_bytes` always measures the complete exact
result `outputs` array, and `logical_allocation_bytes` always uses the one existing
equation; zero-row, non-present, short-circuit, group, lag, percentage, and window
paths have no discount or surcharge. Primitive steps remain exactly the exhaustive
mapping below: delta/percentage charge `n` despite their closed compound formulas,
and their rational stages add no unlisted allocation. SQL and TypeScript must
independently derive all metadata, ranges, values, exact intermediate/output bytes,
and every meter field; sharing caller-produced metadata or serialized result bytes is
not an independent check.

#### Frozen `ucum-subset-v1`

`ucum-subset-v1` is a closed lookup table, not a UCUM parser. Unit strings are
case-sensitive exact ASCII literals after the global NFC check. Prefix expansion,
pluralization, whitespace trimming, aliases, Unicode symbols, exponent syntax, and
unit multiplication/division are forbidden. The apparent compound strings below
are opaque registry keys; `/` and `3` have no grammar. Every nonnull unit in a Task 9
field catalog, metric contract, graph node, or derived output must be one of these
exact strings. Currency remains separate, never appears in this table, and a
currency-bearing scalar cannot be passed to `unit_convert`.

For each entry, the base value is defined exactly as
`base = source * multiplier + offset`. Each multiplier/offset is the displayed
reduced rational with a positive denominator; implementations store numerator and
denominator integers and may not replace them with binary floats or decimal
approximations. The dimension and base-unit labels in this table are also closed:

| Dimension       | Exact accepted unit | Base unit | Multiplier                | Offset      | Affine |
| --------------- | ------------------- | --------- | ------------------------- | ----------- | ------ |
| dimensionless   | `1`                 | `1`       | `1/1`                     | `0/1`       | no     |
| dimensionless   | `%`                 | `1`       | `1/100`                   | `0/1`       | no     |
| length          | `m`                 | `m`       | `1/1`                     | `0/1`       | no     |
| length          | `cm`                | `m`       | `1/100`                   | `0/1`       | no     |
| length          | `mm`                | `m`       | `1/1000`                  | `0/1`       | no     |
| length          | `km`                | `m`       | `1000/1`                  | `0/1`       | no     |
| length          | `[in_i]`            | `m`       | `127/5000`                | `0/1`       | no     |
| length          | `[ft_i]`            | `m`       | `381/1250`                | `0/1`       | no     |
| duration        | `s`                 | `s`       | `1/1`                     | `0/1`       | no     |
| duration        | `min`               | `s`       | `60/1`                    | `0/1`       | no     |
| duration        | `h`                 | `s`       | `3600/1`                  | `0/1`       | no     |
| duration        | `d`                 | `s`       | `86400/1`                 | `0/1`       | no     |
| volume          | `m3`                | `m3`      | `1/1`                     | `0/1`       | no     |
| volume          | `L`                 | `m3`      | `1/1000`                  | `0/1`       | no     |
| volume          | `[ft_i]3`           | `m3`      | `55306341/1953125000`     | `0/1`       | no     |
| volume          | `[gal_us]`          | `m3`      | `473176473/125000000000`  | `0/1`       | no     |
| volumetric_flow | `m3/s`              | `m3/s`    | `1/1`                     | `0/1`       | no     |
| volumetric_flow | `m3/h`              | `m3/s`    | `1/3600`                  | `0/1`       | no     |
| volumetric_flow | `L/s`               | `m3/s`    | `1/1000`                  | `0/1`       | no     |
| volumetric_flow | `L/min`             | `m3/s`    | `1/60000`                 | `0/1`       | no     |
| volumetric_flow | `[ft_i]3/s`         | `m3/s`    | `55306341/1953125000`     | `0/1`       | no     |
| volumetric_flow | `[gal_us]/min`      | `m3/s`    | `157725491/2500000000000` | `0/1`       | no     |
| temperature     | `K`                 | `K`       | `1/1`                     | `0/1`       | no     |
| temperature     | `Cel`               | `K`       | `1/1`                     | `5463/20`   | yes    |
| temperature     | `[degF]`            | `K`       | `5/9`                     | `45967/180` | yes    |
| temperature     | `[degR]`            | `K`       | `5/9`                     | `0/1`       | no     |

There are exactly 26 accepted strings and no absolute date/time-point unit. `Cel`
and `[degF]` are the only affine entries because they are the only rows with a
nonzero offset; `[degR]` is linear. In particular `ft`, `in`, `liter`, `l`, `sec`,
`hr`, `day`, `degC`, `°C`, `F`, `cfs`, `cms`, `m^3`, `m^3/s`, `[ft_i]^3/s`,
`kg`, any prefixed variant not listed, and any leading/trailing whitespace are
unknown strings. An implementation must reject them rather than parse or normalize
them into a listed literal.

A `unit_convert` input must be a scalar `integer|decimal` node with a nonnull listed
unit, SQL/JSON-null currency, and `from_unit` byte-equal to that derived input unit.
`registry_version` must equal both the graph's `unit_registry_version` and exact
literal `ucum-subset-v1`; `to_unit` must be listed in the same dimension. The derived
output is always scalar `decimal`, preserves the input `nullable`, `grain`, and
`evaluation_rows_from` exactly, sets `unit = to_unit`, requires `currency = null`,
sets `fields = null`, and sets `max_value_bytes = i64:74`, the maximum JCS byte
length of a canonical 38-digit signed decimal object at scale 18. Caller-supplied
integer output, changed nullability/grain/domain, nonnull currency, another width,
or another unit is `type_mismatch`, `grain_mismatch`, `currency_mismatch`, or
`unit_mismatch` as applicable.

For each present or stale input, convert its integer or reduced decimal value to an
exact rational `x`; look up source `(Ms,Os)` and target `(Mt,Ot)`; then perform only
these ordered rational stages:

```text
base = x * Ms + Os
target = (base - Ot) / Mt
```

Numerator/denominator pairs are sign-normalized, reduced by exact integer GCD after
each multiplication/addition/subtraction/division, and never quantized between the
two stages. Then and only then apply the node's single final quantization at tagged
scale `s`: multiply the target rational by `10^s`; `none` requires an integer result,
while `half_even` chooses the nearest integer with exact half ties going to the even
coefficient symmetrically for positive and negative values. Form
`{coefficient,scale=s}`, strip trailing coefficient zeroes while scale is positive,
and canonicalize zero to coefficient `0`, scale `i64:0`. Source-equals-target still
executes this one final quantization; it is not a bypass. A coefficient over 38
digits is `overflow`. No intermediate or second output rounding is permitted.

Non-present `null|missing|unavailable` states propagate without a value; stale
propagates with the converted value. They do not weaken static type/unit checks.
`primitive_steps` charges exactly `2n` for every `unit_convert` evaluation row,
including non-present, affine, and source-equals-target rows: one source-to-base and
one base-to-target stage. Registry lookup, compatibility validation, GCD reduction,
and final quantization add no hidden meter term. Static admission uses the fixed
74-byte output width and the same two-stage range bound; runtime still proves the
actual coefficient, canonical bytes, steps, and logical allocation are within the
admitted limits.

Unit-conversion error selection is deterministic. Strict graph shape, unknown key,
bad tagged scale/rounding, or registry-version mismatch is `invalid_graph` first;
a nonnumeric input is `type_mismatch`; nonnull input currency is
`currency_mismatch`; an unknown exact unit literal is `invalid_unit_conversion`;
missing input unit, `from_unit` drift, or different dimensions is `unit_mismatch`;
an inexact `rounding=none` result is `invalid_unit_conversion`; a greater-than-38-
digit final coefficient is `overflow`; and a meter/range ceiling breach is
`limit_exceeded`. These checks occur in that order. Currency conversion never falls
through to this mapping and continues to use its separate FX evidence errors.

The following fixtures are normative exact values, not examples an implementation
may replace:

| Fixture                    | Input                                                                         | From -> to              | Scale / rounding      | Exact outcome                                                                |
| -------------------------- | ----------------------------------------------------------------------------- | ----------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `unit-at-scale-0`          | integer `1`                                                                   | `m` -> `cm`             | `i64:0` / `none`      | decimal coefficient `100`, scale `i64:0`                                     |
| `unit-at-scale-18`         | integer `1`                                                                   | `%` -> `1`              | `i64:18` / `none`     | decimal coefficient `1`, scale `i64:2` after canonical stripping             |
| `unit-at-width-74`         | decimal coefficient `-99999999999999999999999999999999999999`, scale `i64:18` | `m` -> `m`              | `i64:18` / `none`     | identical 38-digit value; canonical decimal object is exactly 74 UTF-8 bytes |
| `unit-over-coefficient`    | decimal coefficient `99999999999999999999999999999999999999`, scale `i64:0`   | `km` -> `mm`            | `i64:0` / `none`      | `overflow`                                                                   |
| `unit-rational-cfs`        | integer `1`                                                                   | `[ft_i]3/s` -> `m3/s`   | `i64:12` / `none`     | coefficient `28316846592`, scale `i64:12` (`0.028316846592`)                 |
| `unit-rational-gpm`        | integer `1`                                                                   | `[gal_us]/min` -> `L/s` | `i64:10` / `none`     | coefficient `630901964`, scale `i64:10` (`0.0630901964`)                     |
| `unit-affine-celsius`      | integer `0`                                                                   | `Cel` -> `K`            | `i64:2` / `none`      | coefficient `27315`, scale `i64:2`                                           |
| `unit-affine-freezing`     | integer `32`                                                                  | `[degF]` -> `Cel`       | `i64:0` / `none`      | coefficient `0`, scale `i64:0`                                               |
| `unit-affine-boiling`      | integer `212`                                                                 | `[degF]` -> `Cel`       | `i64:0` / `none`      | coefficient `100`, scale `i64:0`                                             |
| `unit-affine-negative`     | integer `-40`                                                                 | `[degF]` -> `Cel`       | `i64:0` / `none`      | coefficient `-40`, scale `i64:0`                                             |
| `unit-affine-rankine`      | decimal coefficient `49167`, scale `i64:2`                                    | `[degR]` -> `K`         | `i64:2` / `none`      | coefficient `27315`, scale `i64:2`                                           |
| `unit-half-even-low`       | integer `5`                                                                   | `cm` -> `m`             | `i64:1` / `half_even` | canonical zero                                                               |
| `unit-half-even-high`      | integer `15`                                                                  | `cm` -> `m`             | `i64:1` / `half_even` | coefficient `2`, scale `i64:1`                                               |
| `unit-half-even-negative`  | integer `-15`                                                                 | `cm` -> `m`             | `i64:1` / `half_even` | coefficient `-2`, scale `i64:1`                                              |
| `unit-none-inexact`        | integer `5`                                                                   | `cm` -> `m`             | `i64:1` / `none`      | `invalid_unit_conversion`                                                    |
| `unit-none-nonterminating` | integer `1`                                                                   | `m` -> `[ft_i]`         | `i64:18` / `none`     | `invalid_unit_conversion`                                                    |
| `unit-incompatible`        | integer `1`                                                                   | `m` -> `s`              | `i64:0` / `none`      | `unit_mismatch`                                                              |
| `unit-from-drift`          | input metadata unit `m`, integer `1`                                          | declared `cm` -> `m`    | `i64:2` / `none`      | `unit_mismatch`                                                              |
| `unit-unknown-opaque`      | integer `1`                                                                   | `cfs` -> `m3/s`         | `i64:12` / `none`     | `invalid_unit_conversion`                                                    |

One registry-enumeration fixture asserts all 26 table literals are accepted once in
the displayed order and that every other string is rejected. Separate type fixtures
freeze nullable true/false propagation, null/missing/unavailable/stale values,
preserved null/non-null grain, forced null currency, decimal scalar, target unit,
`i64:74` width, scale `i64:0`/`i64:18` acceptance, and scale `i64:-1`/`i64:19`
`invalid_graph` rejection.

#### Frozen `iso4217-task9-v1` and synthetic FX contract

`iso4217-task9-v1` is a closed code/exponent lookup, not a general ISO-4217 parser
or claim of live currency support:

| Exact code | Minor-unit exponent |
| ---------- | ------------------: |
| `USD`      |                   2 |
| `EUR`      |                   2 |
| `GBP`      |                   2 |
| `JPY`      |                   0 |

Codes are case-sensitive exact ASCII. Every other code, numeric ISO code, symbol,
alias, whitespace variant, cryptocurrency, and code-pair string is unknown. Every
nonnull Task 9 field-catalog, metric-contract, graph input/output, arithmetic, and
result currency must be exactly one of these four codes; no writer invents a code.
`currency_convert` requires distinct listed `from_currency`/`to_currency`; a scalar
`integer|decimal` input; input `currency` byte-equal to `from_currency`; null input
unit; and the same evaluation domain/grain rules as arithmetic. Its `rate` is exactly
the canonical tagged-decimal object `{coefficient,scale}`: a strictly positive
coefficient of at most 18 digits, tagged scale `i64:0..i64:18`, no trailing
coefficient zero while scale is positive, and no zero/negative rate. The node scale
must equal the target code's minor-unit exponent and `rounding` must be exactly
`half_even`; other otherwise-known scale/rounding values are `invalid_graph` for this
operation. The derived output is scalar `decimal`, preserves input nullable/grain/
evaluation domain, sets unit null, currency exactly `to_currency`, fields null, and
`max_value_bytes = i64:74`.

`fx-rate-evidence-v1`, row-hash domain `dasher.fx-rate-evidence.v1`, is exact JCS
with fields `schema,from_currency,to_currency,rate,observed_at`, in that semantic
order before JCS key sorting, and at most 4,096 bytes. Currencies and rate satisfy the
registry above; `observed_at` is UTC RFC 3339 with six fractional digits. An admitted
FX row is an already-existing synthetic owner-harness `evidence_records` row on the
run's input snapshot with exact predecessor-allowed `evidence_kind = 'typed_value'`, exact NFC
`coordinates = 'task9-fx:' || from_currency || '/' || to_currency`,
`transformation` byte-for-byte equal to the UTF-8 JCS evidence body decoded as text,
`content_sha256` equal to that body's row hash, and row `observed_at` plus
`retrieved_at` both equal to the body instant. The immutable `0003`
`evidence_records_evidence_kind_check` already admits `typed_value` and forbids
`synthetic_fx_rate`; `0007` does not drop, replace, widen, or rename that constraint.
The exact coordinates, canonical transformation body, content hash, snapshot, and
three timestamps make this typed value unambiguously the one synthetic FX rate. No
production writer is added and no other `typed_value` body is accepted as FX.

The graph top-level FX ID/SHA, every node FX ID, and the locked evidence row ID/
content hash must be identical. The run's common-bundle membership must contain that
same evidence ID, SHA, input snapshot/source SHA, and observed instant, with
`freshness = 'current'`; it must also occur in the exact request-bound contract/
catalog lineage union, so the graph cannot smuggle extra evidence into the bundle.
The node rate and currency direction must byte-equal the parsed evidence body. The
fixed PostgreSQL commit writer locks the run, bundle header, evidence row, and source
snapshot in global order. It reads the immutable bundle member without a row lock,
independently re-encodes the evidence body/hash, and performs the mandatory fresh
header-count/full-membership/bundle-digest revalidation immediately before accepting
result bytes.

The rate direction is exactly “one `from_currency` unit buys `rate` units of
`to_currency`,” and the only formula is:

```text
target = input * rate
```

Convert the input and rate directly to reduced rationals, multiply once, GCD-reduce,
then and only then quantize once at the required target exponent with symmetric
half-even and canonical decimal stripping. There is no reciprocal interpretation,
cross-rate, triangulation, bid/ask spread, fee, minor-unit pre-rounding, or second
round. The admitted result range is exactly a final coefficient of at most 38 digits
at the target exponent, with the fixed 74-byte metadata width.

Freshness uses only the graph's pinned `evaluation_time` and a fixed inclusive
`fx_max_age_millis = i64:86400000`: the exact evidence must satisfy
`observed_at <= evaluation_time` and checked
`evaluation_time - observed_at <= 86,400,000` milliseconds. Equality at either
boundary is fresh; a future instant or one microsecond beyond the age cutoff is
stale. Database clock, bundle creation time, evidence retrieval time, and host clock
never participate.

FX validation/error precedence is exact. General graph key/schema/scale/rounding/rate
encoding errors are `invalid_graph`; nonnumeric input is `type_mismatch`; evaluation-
domain or derived shape/scalar/nullability/fields/width drift is `type_mismatch`,
then grain drift is `grain_mismatch`; nonnull/derived output unit drift is
`unit_mismatch`; unknown/same/from-input/to/output currency drift is
`currency_mismatch`. Next, absent/null/mismatched top-level identity, absent bundle
membership or evidence row, wrong kind/snapshot/coordinates/body/hash/direction/rate,
or lineage mismatch is `missing_fx_evidence`. Only after that complete identity/body
contract succeeds can a bad membership freshness label or timestamp cutoff return
`stale_fx`; missing therefore always precedes stale. Strict input-state propagation
then occurs. For a computable value, final coefficient overflow precedes
`limit_exceeded`. No division-by-zero path exists because zero/negative rate is an
invalid graph. Every evaluation row—including null/missing/unavailable/stale input—
charges exactly `2n` total primitive steps: one exact multiply stage and one final
quantization stage; evidence checks add no hidden term.

The byte-exact normative fixture and its mutation vectors are frozen below. The
canonical USD input is coefficient `100`, scale `i64:0`; the earlier equivalent
`10000`/scale-2 spelling is forbidden by canonical trailing-zero stripping. All
fixtures are synthetic and authorize no provider, network, market-data, credential,
or live FX access.

##### Exact R7 synthetic FX fixture

`fx-r7-usd-eur-boundary-v1` uses fixed organization/dashboard/run IDs ending
`0001/0002/0003`. Source snapshot, catalog, contract set, contract, bundle, evidence,
graph, and meter IDs end respectively `0101..0108`; business/data-owner membership
IDs end `0109/0110`; key/amount/event-time field IDs end `0201..0203`; and source,
field, group, sum, FX node IDs end `0301..0305`, all with prefix
`00000000-0000-8000-8000-000000`. Evaluation is exactly
`2026-08-05T12:00:00.000000Z`; source/evidence observed, retrieved, and created
timestamps are all exactly `2026-08-04T12:00:00.000000Z`. The source row ID is
`566c33d0-5293-8da4-bfd1-6bbaf864b153`; the zero-key group row ID is
`4c5b6acc-0c61-8c42-a6b6-35d927aed9fb`; deterministic result ID is
`782f2b22-b86a-8bda-8eae-451cc3f3a26e`. The source row has
`source_kind=synthetic_fixture`. The evidence row has `evidence_kind=typed_value`,
`coordinates=task9-fx:USD/EUR`, and `transformation` exactly equal to the evidence
bytes below. Catalog entry hashes for fields `0201..0203` are respectively
`fcc70d5724088cca1303a01f04e79a146de5ce47fde3d4ecfe8ca3586f866651`,
`fdbc43baeb43ec44ba2c540da6ea01aa7663a33c0cdabe6df5f1c34aa6718790`, and
`dac812f871f145f78fcd3c7229e9959e1fc745a787a20e2ed3201d16e0e4c678`.

These fenced `text` blocks are the complete UTF-8 JCS bytes—one line, no terminal
LF, no ellipsis. Task 9A copies them byte-for-byte; it may not regenerate a different
fixture object.

`input.bytes`:

```text
{"fields":[{"field_id":"00000000-0000-8000-8000-000000000201","nullable":false,"scalar_type":"integer","stable_key_ordinal":"i64:0"},{"field_id":"00000000-0000-8000-8000-000000000202","nullable":false,"scalar_type":"decimal","stable_key_ordinal":null},{"field_id":"00000000-0000-8000-8000-000000000203","nullable":false,"scalar_type":"timestamp","stable_key_ordinal":null}],"input_snapshot_id":"00000000-0000-8000-8000-000000000101","row_count":"i64:1","rows":[{"row_id":"566c33d0-5293-8da4-bfd1-6bbaf864b153","values":[{"field_id":"00000000-0000-8000-8000-000000000201","state":"present","type":"integer","value":"i64:1"},{"field_id":"00000000-0000-8000-8000-000000000202","state":"present","type":"decimal","value":{"coefficient":"100","scale":"i64:0"}},{"field_id":"00000000-0000-8000-8000-000000000203","state":"present","type":"timestamp","value":"2026-08-04T12:00:00.000000Z"}]}],"schema":"canonical-input-table-v1"}
```

`evidence.bytes`:

```text
{"from_currency":"USD","observed_at":"2026-08-04T12:00:00.000000Z","rate":{"coefficient":"925","scale":"i64:3"},"schema":"fx-rate-evidence-v1","to_currency":"EUR"}
```

`catalog.bytes`:

```text
{"catalog_snapshot_id":"00000000-0000-8000-8000-000000000102","evaluated_at":"2026-08-05T12:00:00.000000Z","fields":[{"allowed_aggregations":["count"],"allowed_dimensions":[],"currency":null,"event_time_field_id":null,"field_id":"00000000-0000-8000-8000-000000000201","grain":"row","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"logical_name":"row_key","max_value_bytes":"i64:26","nullable":false,"scalar_type":"integer","semantic_type":"identifier","source_path":"/rows/*/key","stable_key_ordinal":"i64:0","unit":null},{"allowed_aggregations":["sum"],"allowed_dimensions":[],"currency":"USD","event_time_field_id":"00000000-0000-8000-8000-000000000203","field_id":"00000000-0000-8000-8000-000000000202","grain":"row","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"logical_name":"amount_usd","max_value_bytes":"i64:74","nullable":false,"scalar_type":"decimal","semantic_type":"measure","source_path":"/rows/*/amount","stable_key_ordinal":null,"unit":null},{"allowed_aggregations":["max"],"allowed_dimensions":[],"currency":null,"event_time_field_id":null,"field_id":"00000000-0000-8000-8000-000000000203","grain":"row","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"logical_name":"observed_at","max_value_bytes":"i64:29","nullable":false,"scalar_type":"timestamp","semantic_type":"event_time","source_path":"/rows/*/observed_at","stable_key_ordinal":null,"unit":null}],"input_row_count":"i64:1","input_sha256":"99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8","input_snapshot_id":"00000000-0000-8000-8000-000000000101","schema":"field-catalog-snapshot-v1"}
```

`contract-set.bytes`:

```text
{"catalog_snapshot_id":"00000000-0000-8000-8000-000000000102","contract_set_id":"00000000-0000-8000-8000-000000000103","contracts":[{"aggregation":"sum","allowed_dimension_field_ids":[],"business_owner_membership_id":"00000000-0000-8000-8000-000000000109","calendar":"gregorian","contract_id":"00000000-0000-8000-8000-000000000104","currency":"EUR","data_owner_membership_id":"00000000-0000-8000-8000-000000000110","definition":"Sum the frozen USD measure and convert once with the bound synthetic USD/EUR rate.","denominator_contract_id":null,"denominator_contract_version":null,"direction":"neutral","freshness_slo_millis":"i64:86400000","grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","lag_millis":"i64:0","lineage_evidence_ids":["00000000-0000-8000-8000-000000000106"],"measure_field_id":"00000000-0000-8000-8000-000000000202","name":"EUR total","review_state":"reviewed","target":null,"threshold":null,"timezone":"UTC","unit":null,"value_type":"currency","version":"i64:1"}],"schema":"metric-contract-set-v1"}
```

`bundle.bytes`:

```text
{"bundle_id":"00000000-0000-8000-8000-000000000105","entries":[{"evidence_id":"00000000-0000-8000-8000-000000000106","evidence_sha256":"4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522","freshness":"current","observed_at":"2026-08-04T12:00:00.000000Z","source_sha256":"99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8","source_snapshot_id":"00000000-0000-8000-8000-000000000101"}],"schema":"common-evidence-bundle-v1","source_snapshot_id":"00000000-0000-8000-8000-000000000101"}
```

`graph.bytes`:

```text
{"common_bundle_id":"00000000-0000-8000-8000-000000000105","common_bundle_sha256":"e534de468f6daa31aa8f41876f595926a090e4951d576de65be5ea214b8508c7","contract_id":"00000000-0000-8000-8000-000000000104","contract_output_node_id":"00000000-0000-8000-8000-000000000305","contract_set_id":"00000000-0000-8000-8000-000000000103","contract_version":"i64:1","evaluation_time":"2026-08-05T12:00:00.000000Z","field_catalog_sha256":"df77652a8518e5ab39b0a42ab3093688e70ca755262affa9c450e41749dddea9","field_catalog_snapshot_id":"00000000-0000-8000-8000-000000000102","fx_evidence_id":"00000000-0000-8000-8000-000000000106","fx_evidence_sha256":"4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522","graph_id":"00000000-0000-8000-8000-000000000107","input_sha256":"99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8","input_snapshot_id":"00000000-0000-8000-8000-000000000101","limits":"calculation-limits-v1","nodes":[{"evaluation_rows_from":null,"field_ids":["00000000-0000-8000-8000-000000000201","00000000-0000-8000-8000-000000000202","00000000-0000-8000-8000-000000000203"],"node_id":"00000000-0000-8000-8000-000000000301","op":"source","output_type":{"currency":null,"fields":[{"currency":null,"field_id":"00000000-0000-8000-8000-000000000201","grain":"row","max_value_bytes":"i64:26","name":"row_key","nullable":false,"scalar":"integer","unit":null},{"currency":"USD","field_id":"00000000-0000-8000-8000-000000000202","grain":"row","max_value_bytes":"i64:74","name":"amount_usd","nullable":false,"scalar":"decimal","unit":null},{"currency":null,"field_id":"00000000-0000-8000-8000-000000000203","grain":"row","max_value_bytes":"i64:29","name":"observed_at","nullable":false,"scalar":"timestamp","unit":null}],"grain":null,"max_value_bytes":null,"nullable":null,"scalar":null,"shape":"rowset","unit":null}},{"evaluation_rows_from":"00000000-0000-8000-8000-000000000301","field_id":"00000000-0000-8000-8000-000000000202","input":"00000000-0000-8000-8000-000000000301","node_id":"00000000-0000-8000-8000-000000000302","op":"field","output_type":{"currency":"USD","fields":null,"grain":"row","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null}},{"evaluation_rows_from":null,"input":"00000000-0000-8000-8000-000000000301","key_node_ids":[],"node_id":"00000000-0000-8000-8000-000000000303","op":"group","output_type":{"currency":null,"fields":[],"grain":null,"max_value_bytes":null,"nullable":null,"scalar":null,"shape":"rowset","unit":null}},{"evaluation_rows_from":"00000000-0000-8000-8000-000000000303","group_node_id":"00000000-0000-8000-8000-000000000303","input":"00000000-0000-8000-8000-000000000302","node_id":"00000000-0000-8000-8000-000000000304","op":"sum","output_type":{"currency":"USD","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null}},{"evaluation_rows_from":"00000000-0000-8000-8000-000000000303","from_currency":"USD","fx_evidence_id":"00000000-0000-8000-8000-000000000106","input":"00000000-0000-8000-8000-000000000304","node_id":"00000000-0000-8000-8000-000000000305","op":"currency_convert","output_type":{"currency":"EUR","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null},"rate":{"coefficient":"925","scale":"i64:3"},"rounding":"half_even","scale":"i64:2","to_currency":"EUR"}],"output_node_ids":["00000000-0000-8000-8000-000000000305"],"registry":"calculation-registry-v1","schema":"calculation-graph-v1","target_node_id":null,"threshold_node_id":null,"timezone":"UTC","tzdb_version":"2025b","unit_registry_version":"ucum-subset-v1"}
```

`meter.bytes`:

```text
{"ast_bytes":"i64:3788","cumulative_intermediate_bytes":"i64:2562","cumulative_intermediate_rows":"i64:4","final_output_rows":"i64:1","graph_id":"00000000-0000-8000-8000-000000000107","group_count":"i64:1","input_bytes":"i64:922","logical_allocation_bytes":"i64:8133","max_coefficient_digits":"i64:3","max_depth":"i64:4","max_group_rows":"i64:1","max_literal_bytes":"i64:0","max_literal_list_length":"i64:0","max_scale":"i64:3","max_top_k":"i64:0","max_window_frame":"i64:0","node_count":"i64:5","output_bytes":"i64:541","primitive_steps":"i64:6","result_id":"782f2b22-b86a-8bda-8eae-451cc3f3a26e","scanned_rows":"i64:1","schema":"calculation-meter-v1","total_literal_bytes":"i64:0"}
```

`result.bytes`:

```text
{"error_code":null,"graph_id":"00000000-0000-8000-8000-000000000107","graph_sha256":"2ccca8194640e0190f55f25c09be014b007a6e07b6cdcab907f1b6a5f92acc4f","meter_sha256":"3ff548a96c582a09a48260b8af8901dd16231a5b5511269c0186ff9ee725fc35","outputs":[{"cardinality":"i64:1","evaluation_rows_from":"00000000-0000-8000-8000-000000000303","node_id":"00000000-0000-8000-8000-000000000305","output_type":{"currency":"EUR","fields":null,"grain":"group:0b18bd9caa01215aef2b57feb774f8e36a96fd23a9471c2a4d04b5b3c2a30bb1","max_value_bytes":"i64:74","nullable":false,"scalar":"decimal","shape":"scalar","unit":null},"rows":[{"ordinal":"i64:0","row_id":"4c5b6acc-0c61-8c42-a6b6-35d927aed9fb","value":{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}}],"shape":"scalar"}],"result_id":"782f2b22-b86a-8bda-8eae-451cc3f3a26e","schema":"calculation-result-v1","state":"succeeded"}
```

The four exact intermediate JCS objects are derived in node order from the frozen
input/graph under `calculation-node-rowset-v1` or
`calculation-node-scalar-v1`: source rowset, amount field scalar, empty-key group
rowset, and USD sum scalar. Their individual byte lengths are `1238, 471, 315, 538`,
sum `2562`; this ordered length vector is itself a Task 9A fixture. They are exactly
the four node IDs omitted from `output_node_ids`; the FX node is final. Thus the R8
disjoint accounting rule preserves every displayed base/JPY/freshness fixture byte,
meter, hash, and UUID without regeneration. The exact output-
value binding bytes are:

```text
{"field_id":null,"node_id":"00000000-0000-8000-8000-000000000305","result_id":"782f2b22-b86a-8bda-8eae-451cc3f3a26e","row_id":"4c5b6acc-0c61-8c42-a6b6-35d927aed9fb","schema":"calculation-output-value-v1","value":{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}}
```

The exact hashes/lengths are:

| Identity                          | Exact value                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| input SHA / bytes                 | `99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8` / `922`                                                              |
| evidence SHA                      | `4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522`                                                                      |
| catalog SHA                       | `df77652a8518e5ab39b0a42ab3093688e70ca755262affa9c450e41749dddea9`                                                                      |
| contract-set / contract SHA       | `7dffbf5fa5e0a05f3e59d8e252994c89a1d6453de3eced139fa741877617c743` / `dd2df999d3ea9a08b7f8d0d53a84707cade54930fa66f8fd59991401c0a75eee` |
| bundle SHA                        | `e534de468f6daa31aa8f41876f595926a090e4951d576de65be5ea214b8508c7`                                                                      |
| graph SHA / AST bytes             | `2ccca8194640e0190f55f25c09be014b007a6e07b6cdcab907f1b6a5f92acc4f` / `3788`                                                             |
| meter SHA                         | `3ff548a96c582a09a48260b8af8901dd16231a5b5511269c0186ff9ee725fc35`                                                                      |
| result SHA                        | `35e905d4076c026705568b3a1287dacba3874aeaa48d8f7ce05b37551170e185`                                                                      |
| output / output-value SHA         | `f8134964526b30547b65693379806a3a1e86172702ea0d5fb76ff51c9691119d` / `5bb610a65947d0f71ae990c98baa443d12d3f31f2786e94740999ae192ad9cd8` |
| output / logical allocation bytes | `541` / `8133`                                                                                                                          |

All SHA values use the displayed row-hash domains, NUL, unsigned-32 byte length, and
the exact bytes; result ID uses its frozen UUIDv8 preimage. Tests decode every hex,
recompute every hash and UUID independently in SQL and TypeScript, and compare the
literal bytes before fixture insertion. A one-bit change must change the downstream
digest chain and the unchanged expected digest must deny.

Boundary/failure vectors are exact transformations of this fixture, applied before
JCS/hash recomputation in listed order; no other field changes:

| Vector                           | Exact transformation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Exact expected result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fx-jpy-positive-tie`            | replace the input amount coefficient `100` by `1`; replace evidence ID `0106` by `0111` in all three catalog lineages, contract lineage, bundle, and graph; use evidence bytes `{"from_currency":"USD","observed_at":"2026-08-04T12:00:00.000000Z","rate":{"coefficient":"15","scale":"i64:1"},"schema":"fx-rate-evidence-v1","to_currency":"JPY"}`, kind `typed_value`, coordinates `task9-fx:USD/JPY`, and identical transformation; retain catalog input currency USD; change only contract name/definition/output currency to `JPY total`/`Sum the frozen USD measure and convert once with the bound synthetic USD/JPY rate.`/JPY and graph FX to-currency/output currency/rate/scale to JPY/JPY/`15,i64:1`/`i64:0`; replace every stated downstream SHA with the literals at right; no other byte changes | present decimal `2/i64:0`, result ID `406b3f62-6bf1-8b66-8012-55f960d4a667`, `primitive_steps=i64:6`; input `cbf973a5ced4b32f584a8e50e4415a89dfdaf375fa20567ce9c226f916f64b53`/`920`; evidence `e544f32397622b59e433bba55eba7c7526591b97f441b0e21283f4be1c053e0f`; entry hashes `186e2fdd2d2c732f5cc195ce51790751abfb54f4e4af667b4752597cd208007d,5746b7ebb36a79359e76d07f640c65edd0f1be50d754bc0a5ff0da3b559713aa,f7a05e2240c82a67222f4fb022e72458c7fa16f14c78d5b168b5142b5a217097`; catalog `9bd7af6cdb668a3496986952b29f08d6531cfacb4807749f8c8cf3b81c07e2dd`; contract set/member `605753e9681d75cd063869b9fc704ee654f1f214f0d0ba270402b65b9b03c835`/`77db8c613986e7c4dc02d3bab5c5c7c65b8bba108f886cfa7d7ff2564ed2084c`; bundle `a553b776c664592feefff6ba169f788b4983afcd76c03120094f636195fe09c4`; graph `06d6eaeb1d41804c32eb6af430fa04ccbd43557a7e3efd8197b566b30231c832`/`3787`; intermediate lengths `1236,469,315,536`; output/logical bytes `539`/`8122`; meter `64baa053d04ec55cce74294d40cadf2194b9718c371a9c200abaadf7e8b19470`; result `770bb4b97494de8dac4a48adafb3c8c25f5a1e4a8e9564ecb81805253aaaee8b`; output/value `7490c738b15a35510d3c724217e7a10bd5be8cef18a27e57fbc7b86f6ebf07e1`/`ec2c0c4b8310b5d001024d73aa36930f42a6775be5e78d92f95212b2fab9efe9` |
| `fx-jpy-negative-tie`            | apply the positive transformation but replace input amount by `-1`; only input/source-dependent catalog, bundle, graph, result, output, value, and meter identities change as listed at right                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | present decimal `-2/i64:0`, result ID `8f4298c6-0eb4-8591-8d4d-985836129104`, `primitive_steps=i64:6`; input `f046b400986e98f0b11eb825e60442ea2fe9b5654eaeae931e611ea06126d628`/`921`; evidence/entry/contract hashes equal the positive vector; catalog `1fb1b99e5d26a464a6bdbcc3cce98e82e6998d6ce5d1ecc73f0b8e9af1f1e4d0`; bundle `2dd0edf39de73cc8c723b0b35bde307477f159be4071afadccf25e17d0902b35`; graph `1943fe0f549f608689f06cd698794c5dde3f605e015bf8fd446a77433235952c`/`3787`; intermediate lengths `1237,470,315,537`; output/logical bytes `540`/`8127`; meter `f1c03a17e6929ae0387f02ad21a73f5cd4927b5272dbbfbd34b47f459176a0c4`; result `9a9b763058ccc21bbd236e156d3d6f126a895fb39a50a2283becc559796be519`; output/value `567acc019a1092eba15b941acb9ecf1af446aa316dec83c4cb68bd76818e8563`/`080026c9f34c0a0bc71306bf318bf13f77c8c4af073e330ac1f5b50f80ed41e2`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fx-fresh-inclusive`             | unmodified fixture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | succeeds at exactly `86,400,000` ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `fx-stale-one-microsecond`       | set body observed time, evidence-row `observed_at`/`retrieved_at`, and bundle-entry `observed_at` to `2026-08-04T11:59:59.999999Z`; retain row `created_at`; use evidence SHA `25fb9decefb6592fb868513db105082c3f95e5c0d83374f19ed55c724354e583` and recompute all downstream identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `stale_fx`; no committed graph/result/meter/event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fx-future-one-microsecond`      | set body observed time, evidence-row `observed_at`/`retrieved_at`, and bundle-entry `observed_at` to `2026-08-05T12:00:00.000001Z`; retain row `created_at`; use evidence SHA `acbe71d60ef0be625a676c53a508dba14a713bd3dc70df8180351fb4e8b36a04` and recompute downstream identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `stale_fx`; no DML                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fx-kind-predecessor-compatible` | unmodified exact `typed_value` row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted; catalog proves immutable 0003 CHECK unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fx-kind-forbidden-spelling`     | change only evidence kind to `synthetic_fx_rate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | immutable predecessor CHECK rejects owner-fixture INSERT; no 0007 constraint replacement exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fx-missing-before-stale`        | use the stale vector and omit its bundle member                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `missing_fx_evidence`, never `stale_fx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fx-direction-drift`             | swap only the evidence body's from/to codes to EUR/USD, update its coordinates to `task9-fx:EUR/USD`, and recompute that row hash plus every evidence-SHA reference; leave the well-typed node/input/output USD/EUR direction unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `missing_fx_evidence` after currency shape checks because body and node direction differ; no reciprocal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fx-meter-byte-drift`            | increment only supplied `output_bytes` to `i64:542`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | fixed commit denial `P1002`; no DML                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `fx-38/39-digit`                 | retain USD/EUR and target exponent 2; use input decimal coefficient `99999999999999999999999999999999999999`, scale `i64:0`; the success evidence rate is coefficient `1`, scale `i64:0`, while the overflow evidence rate is coefficient `10`, scale `i64:0`; recompute each exact evidence/downstream chain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | rate 1 succeeds with that same 38-digit coefficient and canonical scale `i64:0`; rate 10 produces a 39-digit final coefficient and is `overflow` before meter limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

For the two JPY transformations, Task 9A's fixture builder is executable but has no
semantic parameter: it transcribes those literal replacements and the already frozen
row-ID/group-ID/graph/result/meter algorithms, then snapshots the resulting complete
bytes and hashes. Its test independently recomputes the entire digest chain from the
literal base bytes and transformation; changing a replacement, ID, timestamp,
domain, encoder, or expected output is plan drift, not an implementation choice.

`select` field IDs are UUIDv8 over `dasher.derived-field.v1`, the select node UUID,
the zero-based tagged projection ordinal, projection name, and value-node UUID.
Source output fields retain catalog field IDs; filter/sort/top-k preserve the input
field set. A group output contains one derived field per key, with field ID UUIDv8
over the same domain, group node UUID, text `key`, tagged key ordinal, and key-node
UUID. `rank` is scalar and is added to a rowset only through `select`. No join exists;
`join` and every Cartesian-product spelling are rejected.

The governance aggregation vocabulary is mapped exhaustively rather than treated as
registry aliases. `count -> count_present` on the contract measure;
`sum|min|max` map to the identically named aggregate node over the contract measure
and required group node; `mean` maps to that node with scale `i64:18` and
`half_even`; `ratio` requires a numerator `sum`, a `sum` for the
exact denominator contract over the same group node, then `divide` with tagged scale
`i64:18` and `half_even`; `count_distinct` and `median` are governance values but are
not executable in `calculation-registry-v1` and deterministically require
`unsupported_capability` abstention. `count_rows` is available only for explicit row
cardinality and never silently implements contract `count`. No registry node named
`count_distinct`, `median`, `ratio`, `aggregate`, or `formula` exists.

##### Frozen MetricContractVersion validity and graph conformance

Every contract entry and relation row is validated as one indivisible semantic
object; no field is advisory or ignored. `threshold|target` decimal text uses exact
grammar `0|-?[1-9][0-9]*(\.[0-9]*[1-9])?`, has at most 38 coefficient digits and 18
fractional digits, and forbids negative zero. It is parsed directly to a reduced
rational. Names/definitions are retained governance text and are bound by
`contract_sha256`; the Brief may name only these exact IDs and owner-visible reads
return these exact bytes. Business/data owners must be distinct current active
memberships in the same organization when the owner fixture is admitted, at request,
and at graph commit. `review_state` is exactly `reviewed`; there is no draft fallback.

Cross-field validity is exhaustive:

- `denominator_contract_id/version` are both nonnull exactly for `ratio`, name a
  different reviewed `aggregation=sum` contract in the same set/catalog, and that
  denominator has the same calendar, timezone, allowed dimensions, and derived
  group grain. Its measure has the same `event_time_field_id` as the numerator
  measure, so one exact event-time population governs the ratio's freshness. It
  cannot itself be `ratio`; all other aggregations require both
  denominator fields null. The schema's exact contract aggregation set remains
  `count|count_distinct|sum|min|max|mean|median|ratio`; its graph-capable subset is
  exactly `count|sum|min|max|mean|ratio`. A current Brief containing
  `count_distinct|median`, or a contract with 17..32 otherwise-valid allowed
  dimensions, cannot reach the registry's at-most-16-key group and instead
  deterministically closes as `unsupported_capability` with `next_safe_step=none`
  before any specialist/generator dispatch.
- The measure is a catalog `semantic_type=measure`, lists the chosen aggregation in
  `allowed_aggregations`, has a nonnull timestamp `event_time_field_id` whose catalog
  entry is `semantic_type=event_time`, and carries at most one of unit/currency.
  Every allowed dimension is a catalog `dimension|identifier` entry listed in the
  measure's `allowed_dimensions`; the arrays are exact sorted sets, not subsets
  chosen by the graph.
- `aggregation=count|count_distinct` requires `value_type=integer` and null
  unit/currency. `sum|mean|min|max|median` derive the value type from the selected
  output metadata:
  nonnull currency requires `currency`; a duration-dimension unit requires
  `duration`; any other listed non-`%` unit or null unit requires `decimal`.
  `ratio` requires either `value_type=decimal, unit=1` or
  `value_type=percentage, unit=%`; both ratio forms require null currency. These are
  the only aggregation/value-type pairings. `median` requires a decimal measure;
  its unsupported status does not relax that contract validation. Thus `decimal`
  always has null currency
  and unit null or a listed non-`%` unit; `currency` has null unit and one listed
  currency; `percentage` has `%` and null currency; and `duration` has null currency
  and one non-affine duration-dimension unit. A duration graph scalar remains
  decimal in that unit rather than the tagged-microsecond literal scalar.
- `count` accepts any measure scalar and derives integer. `sum|mean|ratio` require a
  numeric measure. `min|max` for a contract require a decimal measure (the generic
  registry operation remains closed for the additional types above). A currency
  contract's requested currency may differ from the measure only through the one
  bound `currency_convert`; a noncurrency unit may differ only through one final
  compatible `unit_convert`. Ratio numerator and denominator measures must have
  byte-equal scalar/unit/currency metadata before their sums and divide; its
  unconverted output is decimal unit `1`, currency null, including when both measure
  metadata pairs are null/null because the frozen divide registry materializes
  dimensionless unit `1`. This is directly admissible as a decimal ratio contract
  and requires no conversion. A percentage ratio then has
  exactly one final `unit_convert` from `1` to `%`; the decimal ratio stays unit `1`.
- `direction=neutral` requires threshold/target both null. `higher_is_better` and
  `lower_is_better` require both; higher requires target >= threshold, lower requires
  target <= threshold. `target_band` requires both and threshold <= target, where
  threshold is the inclusive lower bound and target the inclusive upper bound. Each
  value must fit and quantize exactly to the contract output scalar: integer count
  values are integral signed-64; decimal/currency/percentage/duration values use at
  most scale 18 and the same unit/currency metadata as the output.
- `lag_millis` and `freshness_slo_millis` are each `0..31536000000`, their checked
  sum fits signed-64, and SLO is positive. Calendar is exactly
  `gregorian|iso_week|fiscal_445`; timezone is an exact IANA name in pinned tzdb
  `2025b` and must equal graph timezone. The
  calendar/timezone/dimensions produce the exact hashed group grain. Contract grain
  must byte-equal that derived text; an arbitrary business-grain label is invalid.
- `lineage_evidence_ids` equals, with no omission or extra, the sorted union of the
  measure entry, its event-time entry, every allowed-dimension entry, and—only for
  ratio—the denominator contract and its corresponding measure/event-time/dimension
  entry lineage. Each ID must be in the request's common bundle with exact snapshot,
  source/evidence hashes, observed time, and current label. Contract-set hash equality
  is recomputed across every entry after these checks.

The graph mapping is also exhaustive. `contract_output_node_id` is in
`output_node_ids` and is the terminal node of exactly this structure: one source
whose field set is exactly every catalog stable-key field plus the measure,
event-time, and exact dimension fields (plus denominator measure/event-time fields
for ratio), with duplicates collapsed; direct field nodes;
one group over exactly the dimension field nodes; then the aggregation mapping
above. No filter, sort, top-k, lag, window, conditional, or other uncontracted
selection may occur on this path. `mean` uses `i64:18/half_even`; ratio's two sums share
the same group and divide at `i64:18/half_even`. At most one final unit conversion and
at most one final currency conversion may follow, only when required by contract
metadata; mutual exclusivity means they never both follow one output. Contract unit
conversion always uses registry `ucum-subset-v1`, scale `i64:18`, and `half_even`;
contract currency conversion uses the target code exponent and `half_even` as
already required by FX. No other operation may sit between the aggregation and contract output.
The output scalar/type/unit/currency/grain/width must equal the value-type mapping;
its evaluation domain is the exact group, and its result entry/hash is present.
Other graph outputs remain legal up to the 32-output bound but cannot substitute for
this named node and must derive only from the same source/catalog/bundle.

The graph row's nullable freshness trio is derived, never selected by a caller or
added to `calculation-graph-v1`. Consequently the literal R7 graph bytes/hash remain
unchanged when no contract freshness diagnostic is present. An exact diagnostic, if
present, is this one structure and no other: a direct `field` node for the bound
measure's `event_time_field_id` on the contract source; a dedicated zero-key `group`
over that same source; one `max` of that field over the dedicated group; and one
`classify_state` whose input is the max node, whose `evaluation_time` byte-equals the
graph top-level time, and whose `stale_after_millis` equals the checked signed-64
`lag_millis + freshness_slo_millis`. The classifier is in `output_node_ids`; the max
need not be. The INSERT trigger stores classifier ID as
`freshness_classifier_node_id`, max ID as `freshness_input_node_id`, and the canonical
input `row_id` of the first source row in input ordinal order whose present/stale
event-time value equals that maximum as `freshness_source_row_id`. Null/missing values
do not compete; any unavailable value is the ordinary aggregate error, at least one
present/stale value is required, and equal maxima resolve only by that first-ordinal
rule. The three columns are all NULL when this exact structure is absent; two matching
structures or a partially matching structure is `invalid_graph`. Unrelated diagnostic
outputs remain legal but can never map `/freshness`. `graph_sha256` already commits
the complete AST, contract identity, and input SHA; the immutable trio is a
server-derived projection of that preimage/input and introduces no second hash or
caller field.

For `neutral`, both graph threshold IDs are null. Otherwise they are nonnull members
of `output_node_ids` and name exactly two distinct comparison nodes whose left input
is `contract_output_node_id` and whose right input is the corresponding contextual
present literal for the exact threshold or target. There are exactly two distinct
literal node IDs, each has only its named comparison as consumer, and they remain
distinct even when threshold and target bytes are equal. Higher uses two `greater_equal` nodes;
lower uses two `less_equal`; target-band uses threshold `greater_equal` and target
`less_equal`. The boolean outputs have the exact derived metadata. No comparison
alias, swapped operand, rounded literal, missing diagnostic output, or unused
threshold is accepted.

Freshness is evaluated without inventing a calendar window. The graph's evaluation
time equals the request evaluation time; catalog `evaluated_at`, source snapshot
observation time, every contract-lineage evidence observation time, and the maximum
present/stale event-time value among the exact rows feeding the aggregation must each
be no later than evaluation time. At least one such event-time value is required.
Catalog/source/lineage-evidence timestamps must independently satisfy exact signed-
microsecond
`evaluation_us - observed_us <= (lag_millis + freshness_slo_millis) * 1000`; one
microsecond over rejects graph freshness conformance. The maximum row event time is
not rejected for being older: the exact classifier returns `current` when that same
inequality holds and `stale` otherwise. Equality is current and one microsecond over
is therefore the first reachable stale diagnostic. This makes both lag and SLO active
without making `stale` unreachable or coupling row-count windows to time. FX evidence
additionally satisfies its stricter fixed 86,400,000-ms rule; a failure of either
applicable evidence rule wins before calculation.

For the calculated `/freshness` diagnostic, the independently checked maximum and
source row are exactly the maximum/source used in the trio above. The sum is computed
in PostgreSQL `numeric` and TypeScript `bigint`, must fit signed 64-bit before the
classifier is validated, and is never supplied by the Claim or DashboardSpec. The
fixed SQL validation order checks contract identity and event-time field, exact source
population/max/tie row, checked sum, classifier structure/output, then subtree bytes.

The fixed SQL writer validates in this exact order and aborts with normalized
`P1002` plus zero graph/result/meter/event DML: canonical contract/set/entry hashes;
owner/review/catalog/FK equality; denominator and value-type cross-fields;
direction/threshold/target; dimension/grain/calendar/timezone; lineage/bundle and
freshness; graph identity/node structure; selected/diagnostic output metadata and
bytes; then static/runtime meter and result hashes. Tests may assert those internal
reason positions but no new public error enum is exposed. TypeScript performs the
same ordered conformance before execution; PostgreSQL independently repeats it from
locked request/catalog/contract/bundle/input and canonical graph/result rows.

A `literal.value` is exactly `{state,type,value}`. State is
`present|null|missing|unavailable`; non-present requires JSON null value. Present
boolean uses JSON boolean; integer uses exact tagged `i64:<decimal>` under the global
canonical base-10/signed-64 rule; decimal uses exactly
`{coefficient,scale}` with canonical integer coefficient text, zero exactly `0`, at
most 38 coefficient digits and tagged scale `i64:0..i64:18`, reduced by the same
trailing-zero/zero-scale rule as canonical input; text is NFC and at most
4,096 UTF-8 bytes; date is `YYYY-MM-DD`; timestamp is UTC RFC 3339 with exactly six
fractional digits; duration is tagged signed-64 microseconds.
A runtime tagged value has state `present|null|missing|unavailable|stale`; present/stale
requires a value and other states require none. `unavailable` is data unavailability,
not an evaluator error.

Decimal canonicalization strips coefficient trailing zeroes while scale is positive;
zero is always `{coefficient:"0",scale:"i64:0"}`. For every operation carrying
`scale,rounding`, compute the exact rational result first, quantize once to at most
that scale, require exact termination when rounding is `none`, use ties-to-even when
it is `half_even`, then apply that canonical stripping rule. `mean` and `window_mean`
are exact sum divided by present/stale count. `lag` returns `missing` when its
partition has no row at the offset; `delta = current - lag`; and
`percentage_change = ((current - lag) / lag) * 100`, with zero lag producing
`divide_by_zero`. A window is only the current row plus the clipped row-count
`preceding`/`following` positions inside its explicit partition and total key order.
Its declared inclusive frame width is `1 + preceding + following`; edge clipping
changes contributing rows but not the charged declared width. `event_time_field_id`
catalog metadata does not select, reorder, or resize a window. Keys such as
`frame_kind`, `event_time`, `duration_millis`, `period`, or `calendar`, and every
fixed-duration/calendar-period interpretation are unknown and fail `invalid_graph`.
Rank is one-based within the explicit partition/
total order. `classify_state` accepts a timestamp and returns present text `current`
when `evaluation_time - input <= stale_after_millis` (including a future input), else
present text `stale`; non-present input states propagate. These are the only formulas
behind those operation names.

Strict scalar operations apply the precedence `unavailable > missing > null`; if none
applies they compute, and any stale operand makes the computed result stale. Division
by numeric zero is an error before rounding. `coalesce` returns the first present/stale
input, stops with unavailable, and if none exists returns null when any skipped input
was null, else missing. `if_then_else` evaluates only the selected branch; an
unavailable/missing/null condition returns that state, while a stale boolean condition
selects normally and marks the selected result stale. Boolean `not` is strict.
`and` returns present false if either present/stale operand is false (stale false yields
stale false unless the other is present false), otherwise unavailable dominates,
then missing, then null, and otherwise true with stale propagated. `or` symmetrically
returns present true if either present/stale operand is true. Filters retain only
present/stale true rows; unavailable/missing/null predicates are excluded and counted.
Aggregates fail unavailable if any included value is unavailable, ignore null/missing,
and mark a nonempty result stale if any contributing value is stale. On zero input
rows, `count_rows`/`count_present` are integer zero and typed sum is exact typed zero;
on rows with no present/stale aggregate values, count-present/sum are zero while
min/max/mean raise `empty_input`.

`calculation-result-v1`, row-hash domain `dasher.calculation-result.v1`, has exact
fields `schema`, `result_id`, `graph_id`, `graph_sha256`, `state`, `outputs`,
`error_code`, and `meter_sha256`, and is at most 1,114,112 canonical bytes.
`result_id` is UUIDv8 over domain
`dasher.calculation-result-id.v1`, graph UUID, graph SHA bytes, input SHA bytes,
registry text, and limits text; it never depends circularly on result bytes. State is
`succeeded|failed`. Success requires null error and exactly one output entry for each
`output_node_ids` element in that same sorted order. An entry has exactly `node_id`,
`shape`, `output_type`, `evaluation_rows_from`, `cardinality`, and `rows`;
`cardinality` is tagged nonnegative `i64`, equals `rows.length`, and the sum across
entries is at most 2,000.

For a scalar output, `shape=scalar`, `output_type` equals the node's derived scalar
type, `evaluation_rows_from` equals its required rowset node, and each row is exactly
`{ordinal,row_id,value}`. For a rowset output, `shape=rowset`, output type equals the
node's derived rowset field schema, `evaluation_rows_from` is null, and each row is
exactly `{ordinal,row_id,cells}`, where cells contain exactly one
`{field_id,value}` per output field sorted by field UUID. Ordinals are the consecutive
tagged values `i64:0..i64:n-1`; array order is ordinal order, not UUID order.

Source row IDs are the validated canonical-input row IDs. Select, filter, sort, and
top-k preserve them; their row order respectively preserves input, preserves the
retained input subsequence, applies the explicit total sort, and takes that sorted
prefix. A group row ID is UUIDv8 over `dasher.group-row-id.v1`, group node UUID, key
count, and each admitted present/stale typed key value in key-node order; group rows
sort by the complete canonical-binary admitted-key tuple then row UUID, and a zero-key group is the one deterministic
empty-tuple row when input is nonempty (also one empty group for empty input, giving
the defined zero aggregates). Scalar field/literal/arithmetic/comparison/boolean/
classification/rank/window outputs use the exact evaluation rowset's IDs and order;
grouped aggregates use the group row IDs/order. There is no join row identity because
join is not a registry operation. These identities and orders are used identically by
intermediate meters, final bytes, fixtures, and replay.

Sort/partition key preimages extend the input typed-value encoding with `duration=06`
and `stale=04`; stale carries the same value bytes as present. Those keys compare
first by state order `unavailable < missing < null < present < stale`, then
type-specific value (signed numeric/date/time order, `false < true`, unsigned UTF-8
text), then stable row UUID. Explicit sort `nulls` relocates
null/missing/unavailable as one absent class to the requested end while preserving
their internal order; direction reverses only the value comparison, and the final
`tie=true` key plus row UUID must be unique. Group keys never use that absent-state
ordering: the named pre-group validation rejects all three absent states, and admitted
group keys compare only `present < stale`, then the same type-specific value, then
stable row UUID. These rules, not locale or JavaScript comparison, define every
group/sort/window order.

Failure requires empty `outputs` and one semantic error code. The closed semantic
codes are
`invalid_graph|type_mismatch|unit_mismatch|currency_mismatch|grain_mismatch|
missing_field|cycle|limit_exceeded|overflow|divide_by_zero|empty_input|
invalid_timezone|invalid_unit_conversion|inexact_arithmetic|missing_fx_evidence|
stale_fx|invalid_group_key`.
`calculation_timeout|calculation_resource_exhausted` are orchestration failures and
cannot be stored as a graph result. No exception text/stack/host timing enters bytes.
The pure engine may return a typed failed envelope to its caller, but
`commit_calculation_graph` accepts and inserts only `state = succeeded`; any failed
envelope or host failure causes no graph/result/meter/event mutation.

`calculation_meter_vector_v1` is a named composite of exactly these nonnegative
signed-64 fields in order: `input_bytes`, `ast_bytes`, `node_count`, `max_depth`,
`max_literal_bytes`, `total_literal_bytes`, `max_literal_list_length`, `scanned_rows`,
`group_count`, `max_group_rows`, `cumulative_intermediate_rows`, `final_output_rows`,
`cumulative_intermediate_bytes`, `output_bytes`, `primitive_steps`,
`logical_allocation_bytes`, `max_top_k`, `max_window_frame`,
`max_coefficient_digits`, and `max_scale`. Its JCS mirror is
`calculation-meter-v1`, row-hash domain `dasher.calculation-meter.v1`, with `schema`,
`graph_id`, `result_id`, and those fields. The supplied composite must equal the pure
engine's recomputed mirror exactly before graph/result/meter insertion. Every mirror
field is tagged `i64`; PostgreSQL composite fields remain `bigint` and conversion uses
the checked canonical-json rule above.

Metering is semantic and algorithm-independent. `ast_bytes` is the byte length of the
post-parse, NFC-normalized RFC 8785 graph bytes—not caller raw bytes; the raw UTF-8
snapshot has the distinct pre-parse 131,072-byte gate above. `input_bytes` is exactly
`octet_length(canonical_input_bytes)` for the validated
`canonical-input-table-v1` returned by the claimed input function. No second binary
table serialization can change this value. The parser's row count/field IDs/order/
values must equal the request/source/catalog binding before static metering or graph
execution. Canonical-binary tagged-value encoding is used only for the explicitly
listed row-ID, sort-key, and proof/hash preimages. All count and byte additions use
checked signed-64 arithmetic.

Each graph node also has exact common field `evaluation_rows_from`: null for rowset
nodes and required for scalar nodes, naming the rowset whose rows are their evaluation
domain. Select/filter/group/sort/rank/window references must use scalar nodes with
that operation's input rowset as `evaluation_rows_from`; grouped aggregate inputs use
the group node's input domain while the aggregate output domain is the group node.
Mismatch denies.
`node_count = nodes.length`. Leaf depth is 1 and another node's depth is 1 plus the
maximum depth of every node ID it references; `max_depth` is the maximum root depth
and shared DAG nodes are counted once in `node_count`. `max_literal_bytes` is the
largest canonical tagged-literal byte length, `total_literal_bytes` is their checked
sum, and `max_literal_list_length` is the largest literal-array count (zero when no
such literal exists).

Runtime row/byte meters use these exact rules:

- `scanned_rows` sums rows emitted by every `source` node, so reading one frozen row
  through two source nodes charges twice. `group_count` is the largest group count
  emitted by any group node; `max_group_rows` is the largest membership of one group.
- Every node belongs to exactly one exhaustive disjoint accounting class. A `final`
  node is one whose ID occurs in `output_node_ids`, regardless of whether it has a
  consumer; every other node is `intermediate`, regardless of whether it is a graph
  root. Consumer/root status has no metering effect. `final_output_rows` is the checked sum of output-entry
  cardinalities for all and only final nodes. `output_bytes` is the UTF-8 length of the exact canonical JCS
  `outputs` array in `calculation-result-v1`, including entry/row/cell keys, tags, and
  separators but excluding the result envelope fields.
  `cumulative_intermediate_rows`/bytes sum each intermediate node output once; final rows
  and bytes are never included in the intermediate totals, even when a final contract
  output is consumed by threshold/target diagnostics. Conversely an intermediate
  consumerless node remains intermediate because it was omitted from
  `output_node_ids`. A rowset byte size
  is the JCS byte length of exact `calculation-node-rowset-v1` fields
  `schema,node_id,output_type,rows`; a scalar vector uses exact
  `calculation-node-scalar-v1` fields `schema,node_id,output_type,
evaluation_rows_from,rows`. Their rows/cells have the same form/order as final
  outputs. Shared-node output is charged once, not once per consumer.
- `primitive_steps` is the checked sum of per-node charges. Let `n` be the actual
  `evaluation_rows_from`/input row count except that an aggregate uses its group
  node's total input membership row count; let `g` be actual groups, `gk` be a
  group's `key_node_ids.length`, `sk` be the current sort/rank node's `keys.length`,
  `pk` be the current rank node's `partition_node_ids.length`, `q` be a top-k node's
  top-count literal, `s` be that node's AST-derived inherited total-sort certificate
  key count, `p` be projection count, `a` be coalesce argument count, and
  `w = 1 + preceding + following` as the declared inclusive
  row-count window width, and
  `L(n) = n * ceil(log2(max(1,n)))`. The exhaustive mapping is:
  `source=n`; `field|literal=n`; `select=n*p`; `filter=n`;
  `group=n*gk+g`; `sort=L(n)+n*sk`; `top_k=L(n)+n*s`;
  `rank=L(n)+n*(pk+sk)+n`; `count_rows|count_present|sum|min|max|mean=n`;
  `add|subtract|multiply|divide|absolute|clamp|round|equal|not_equal|less|
less_equal|greater|greater_equal|and|or|not|classify_state=n`;
  `unit_convert|currency_convert=2n`; `coalesce=n*a`;
  `if_then_else=2n`;
  `lag|delta|percentage_change=n`; and `window_sum|window_mean=n*w`. Every operation
  name appears exactly once; aggregates are independent scalar nodes rather than
  fields inside `group`. Every multiplication/addition is
  checked before comparison with the limit; overflow is `limit_exceeded`.
- `logical_allocation_bytes = input_bytes + ast_bytes +
cumulative_intermediate_bytes + output_bytes + 64*node_count`. This is a
  deterministic logical charge, not host heap/RSS and not a high-water mark.
  `q` is not used in the top-k primitive formula and `s` is not used in top-k
  cardinality or `max_top_k`. `max_top_k`, `max_window_frame`,
  `max_coefficient_digits`, and `max_scale` are the
  maxima of the corresponding validated literals/types, or zero when absent;
  `max_window_frame` uses declared `1 + preceding + following`, never an event-time
  span or an edge-clipped runtime count. Registry v1 admits no literal-array value,
  so `max_literal_list_length` is exactly zero in every admitted graph; a supplied
  nonzero meter denies, and its configured limit is still inclusively checked against
  that zero rather than repurposed for node-ID/key/projection arrays.

Static admission uses the same formulas before execution. `source` upper rows equal
the catalog `input_row_count`; filter/select/sort and window-scalar upper rows equal
input; rank scalar cardinality equals input; group is `1` for zero keys and otherwise
`min(input,1000)`; top-k is `min(input,q)` using its top-count literal; scalar cardinality equals its
named rowset upper bound. Value-byte upper bounds use each catalog field's required
`max_value_bytes`, exact literal bytes, and fixed numeric/time widths above. The
validator substitutes these upper bounds into every runtime formula and denies unless
every graph-wide limit in section 5.3 holds. Runtime recomputation then must be less
than or equal to that admitted bound and equal the supplied meter exactly. Different
execution algorithms cannot change charge.

Every object rejects unknown keys. Every validated graph pins schema, registry,
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
- The four arithmetic nodes use only the closed numeric/metadata matrix and always
  derive decimal output; divide by zero, inexact `none`, and coefficient overflow
  follow the exact precedence above. Branches have identical type/unit/currency/grain.
- Missing, explicit null, unavailable/error, stale, and empty input are distinct.
  `count_rows` and `count_present` return zero on empty input; typed sum returns
  exact zero; min/max/mean return `empty_input`.
- Sort/top-k requires a unique stable tie key and bounded AST field `k`, denoted `q`
  everywhere in cardinality/meter formulas.
- Windows require partition keys, a unique total order, and only the bounded
  row-count preceding/following frame already present in the AST. Task 9 explicitly
  rejects event-time, fixed-duration, and calendar-period windows and every temporal
  discriminator/key rather than promising semantics not encoded by
  `calculation-graph-v1`. Timezone/tzdb remain pinned for timestamp classification
  and governed contract metadata, not for window membership.
- Unit conversion uses only the 26-literal `ucum-subset-v1` table, exact two-stage
  source/base/target rational order, and one final node quantization frozen in
  section 5.1. `Cel` and `[degF]` exercise the only affine offsets; arbitrary UCUM
  parsing/composition is forbidden. Currency conversion uses only
  `iso4217-task9-v1`, one direction/rate, immutable exact typed-value synthetic evidence and the
  evaluation-time freshness rule; no other FX input or live access exists.

### 5.3 Static and runtime limits

`calculation-limits-v1` freezes these inclusive semantic ceilings; zero is allowed
only where the schema/operation permits empty input. A value equal to a ceiling is
accepted, and the first unit above it is rejected before allocation or evaluation:

| Meter                                                  |     Inclusive ceiling |
| ------------------------------------------------------ | --------------------: |
| Canonical input snapshot bytes                         |             1,048,576 |
| Raw graph UTF-8 bytes before parse                     |               131,072 |
| Canonical AST bytes after parse/NFC/JCS                |                65,536 |
| AST nodes / maximum depth                              |              128 / 32 |
| One string literal / all literal bytes                 |        4,096 / 32,768 |
| One literal list / top-k / window frame                |  256 / 1,000 / 10,000 |
| Decimal coefficient digits / scale                     |               38 / 18 |
| Scanned input rows                                     |                10,000 |
| Groups / rows in one group                             |        1,000 / 10,000 |
| Cumulative intermediate rows / final output rows       |        50,000 / 2,000 |
| Cumulative intermediate canonical bytes / output bytes | 8,388,608 / 1,048,576 |
| Evaluator primitive steps                              |             1,000,000 |
| Accounted logical allocation bytes                     |            33,554,432 |

Static and runtime counting is exact and versioned with the limits:

- AST node count is the number of objects in the canonical AST, including literal
  and field-reference leaves. Root depth is 1; each child depth is parent depth + 1;
  maximum depth is the maximum root-to-leaf object count.
- Canonical byte meters use UTF-8 byte length of the already specified sorted-key,
  typed JSON encoding, including type tags, keys, quotes, separators, decimal signs/
  digits/scales, and null markers. They never use JavaScript object size.
- Source row bound is the lesser of the catalog's exact bounded row count and
  10,000. `filter`, `select`, sort, and window preserve that worst-case bound;
  zero-key `group` yields one row and keyed `group` yields
  `min(input_rows, 1,000)`; `top-k` yields
  `min(input_rows, q)`; no join, Cartesian product, recursion, or unbounded distinct
  exists. Cumulative intermediate rows are the sum of every node omitted from
  `output_node_ids`; every listed output node is counted only in final rows, even if
  consumed by another output. Consumerless status is irrelevant. The static byte and
  logical-allocation bounds use that same exhaustive final/intermediate partition.
- Primitive steps are exactly the checked per-node charges, exact `L(n)` definition,
  and distinct top-count `q` versus inherited sort-key count `s` in section 5.1.
  Static top-k cardinality substitutes `min(input,q)` while its step formula
  substitutes the AST-certified `s`; there is no implementation-selected key count.
  There is no additional generic AST-invocation, emitted-row,
  comparison, output-move, sort/window, or group surcharge. Runtime computes each
  node's one formula after its actual `n/g/gk/sk/pk/q/s/a/p/w` inputs are known;
  static admission
  substitutes the corresponding worst-case bounds into those same formulas.
- Logical allocation is exactly the closed section 5.1 equation. Canonical input,
  AST, intermediate, and output byte meters already include their keys, type tags,
  counts, separators, and values; `64*node_count` is the sole additional logical
  object charge. There is no garbage-collection discount and no host-index, sort,
  window, group, or implementation-data-structure surcharge. Static allocation uses
  required field-catalog maximum canonical widths to bound those same byte terms; a
  missing or unbounded width denies before execution.
- Literal-list length is element count; literal bytes include the entire canonical
  list. Group size is the maximum rows assigned to one group. Decimal coefficient
  digits exclude sign/decimal point and scale is fractional digits. Every exact
  definition is shared by static and runtime meters.

Required vectors include every limit at `limit - 1`, `limit`, and `limit + 1` where
representable; root/deep-chain depth 1/32/33; 128/129 nodes; empty/max/overlong UTF-8
and multibyte literals; decimal 38/39 digits and scale 18/19; row/group/top-k/window
boundaries; merge-sort `n=0,1,2,10,000`; cumulative-row/allocation exact and one-over;
and additions/multiplications near signed-64-bit overflow. A vector that would
exceed `numeric`-to-`bigint` storage or lacks a static width fails before evaluation.

Static validation computes worst-case type, unit, exact arithmetic range, steps,
allocation bytes, and cardinality before execution and denies a graph whose bound
exceeds any limit. Runtime meters count the same deterministic dimensions. Every
increment uses `bigint`, proves nonnegative addition and the inclusive limit before
materializing the next row/value/byte, and fails closed on overflow. Static and
runtime boundaries share one versioned limits object and adversarial vectors; no
partial graph/result/fact/candidate is committed.

The pure engine still has no clock, process, or host-memory dependency. The
orchestrator enforces the immutable run wall limit of 45,000 milliseconds with an
injected monotonic runner outside the engine; CI additionally executes engine
vectors with a 45-second command timeout and a 256 MiB process ceiling. These are
non-semantic defense-in-depth outcomes (`calculation_timeout` or
`calculation_resource_exhausted`), are excluded from graph/result hashes, and never
turn partial output into success. Host heap readings are not called deterministic
memory evidence; the semantic memory bound is the exact 33,554,432-byte logical
allocation meter. Replay reevaluates with the same semantic limits and records a
fresh local wall outcome rather than trusting or hashing the original host timing.

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
Replay accepts one exact `approval_required` source run ID with the closed 3..5 result
retry-aware grammar above, pins its result head, candidate-set/bundle/Brief artifacts,
and all current authorization, clones prerequisites only through the fixed source-
bound clone, obtains result bytes only through `list_claimed_replay_results`, and
binds each ordered immutable result through `consume_agent_replay_result`. It never calls
an adapter/tool or enters reserve/start/reconcile/release. It cannot silently commit
to a dashboard, reuse old authority, change policy/code/catalog digests, or treat an
old approval as current. Sequence, source-head, purge, or digest mismatch fails
closed, and all provider resource counters remain exactly zero.

A material Claim has exactly one semantic label: `observed`, `calculated`,
`hypothesis`, `recommendation`, `unknown`, or `blocked` — the exact
`candidate-claims-v1` label set in section 4.3. Evidence state
is separately exactly `complete`, `partial`, `contradicted`, `stale`, or
`unsupported`. ClaimEvidence edges are only `supports`, `contradicts`, or
`context`. Event proximity never creates causal support, and confidence never
replaces evidence state. Trusted extraction from the strict candidate bytes—not model
selection or salience—defines the complete material Claim IDs/paths/hashes.

Before candidate generation, the run freezes one typed Brief and exactly one
content-addressed common evidence bundle. Every candidate, Claim edge, calculation,
review request, and manifest proves that same bundle identity and membership;
compared candidates may differ in judgment/composition but never factual inputs.
If the Brief cannot be satisfied, orchestration commits one typed `run_abstention`
with the closed reason, retryability, and next safe step from section 4.3 — no
explanation field —
then finishes without a candidate. `unknown`, `blocked`, partial, contradicted,
stale, unsupported, and abstention states never become plausible fallback facts.

Hard validation precedes deterministic ranking. Only candidates with strict
DashboardSpec bytes, successful calculation/evidence validation, exact common-
bundle binding, byte-rederived exhaustive material-assertion coverage, an exact
all-material-claim manifest, complete support for every observed/calculated material
claim, no contradicted material claim, and completed independent review are eligible.
Salience is display-only. PostgreSQL rederives the exact lexicographic key only from
stored rows, using the one frozen ranking tuple from section 4.3: reviewer verdict
ordinal `preferred=0 < acceptable=1` ascending (so preferred ranks first), then
contradicted-claim count ascending, weak-claim count ascending,
complete-supported-claim count descending, `candidate_spec_sha256` ascending, and
candidate UUID ascending; weak means `evidence_state = partial | stale |
unsupported` or label `unknown | blocked`, and complete-supported means state
`complete` with at least one current supports edge. `reject` is
ineligible. `ranking_sha256` is the section 4.3 `ranking_proof_sha256`: SHA-256 over domain
`dasher.candidate-ranking.v1\0`, frozen `candidate_set_sha256`, signed-64 candidate
count, then per candidate in rank order its UUID, spec SHA, review ordinal,
contradicted/weak/complete-supported counts, and contiguous rank, followed by selected
candidate UUID, all in canonical-binary-v1. The supplied proof must equal that
recomputed digest over the derived ordered set and selected first candidate; it is
integrity evidence, not selection authority.
Finalization records immutable ranks and enters only `approval_required`. No
candidate mutates a dashboard head or publication.

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

1. Transcribe this plan's reviewed argument/return, transition/event, global-lock,
   function-to-DML/column/policy/trigger, cumulative audit-action, retention proof-
   domain/argument/disposition/FK/retained-column/DELETE-ACL, and limits matrices
   into failing static fixtures;
   freeze exact phase-7 filename/checksum placeholder, tables/types/functions/
   signatures/owners/settings/ACLs/policies/triggers, managed role flags/comments/
   dependencies, no-sequence inventory, all section 4.3 canonical schemas/bounds,
   lossless tagged-i64/canonical-input/multi-output/material-assertion byte vectors,
   retry-aware orchestration, determinate typed-vector equalities, the one no-actual
   indeterminate candidate-field exception and signed-64 conservation equations;
   freeze reconcile's exact ordered `actual_accounting_bytes bytea` signature,
   `attempt-actual-accounting-v1` JCS key/template grammar, inclusive 1,024-byte
   transport/function cap, signed-64 tagged-decimal endpoint and normal planner
   bytes/lengths/hashes, exact `22021|22P02|22003` parser/conversion catch allowlist,
   typed-local construction/equation/comparison order, and absence of composite
   pre-coercion, regex/dynamic SQL, raw-byte persistence/hash/log/error/replay; the
   exact closed `attempt_indeterminate` reason registry
   `caller_indeterminate`, `malformed_accounting`, `actual_over_reservation`, and
   `takeover_after_dispatch`, with caller/malformed/over-reservation/takeover
   derivation and precedence, absent actual vectors, reasonless cancellation/drain
   event split, and trigger/reducer/checkpoint fixtures,
   replay clone/source fence,
   invocation-authorization and mixed-takeover matrices, including the global
   event claim-operation partial unique index across ordinary/mixed claims, ordinary
   input/result preimages and typed replay projection, preserved terminal claim-input/
   operation preimages, pre-organization retry policy/profile, body-free aggregate
   verification, collision/purge/final-age-out behavior, and purge disposition; the
   semantic `state_sha256` versus nonce-envelope `checkpoint_sha256` columns,
   preimages, result names, event/body linkage, clear rules, and acyclic vectors; exact
   positions for checkpoints/payloads, predecessor cleanup attempts, drain
   proofs/consumptions, and age-out proofs
   in the global lock fixture; the separate tenant-cancel operation advisory gate,
   six durable run columns, global unique index, operation/result preimages, first-
   write/retry/race/reuse matrix, exact immutable audit-header projection/policy and
   event/audit linkage, purge reservation, permanent audit UUID reservation, and
   exact age-out denial boundary; the bundle header `evidence_count` plus exact
   key-only lock grant/policy and mandatory nonlocking membership revalidation with
   no membership UPDATE; exact principal/policy relation-matrix cells, key-column
   UPDATE grants, run lock policy names/qualifiers/`WITH CHECK (false)`, immutable
   actual/no-op UPDATE guards, and no table-wide UPDATE/run-role runtime writer/DELETE;
   exact zero/one/multiple-run retained-chain-set preimage/count/
   snapshot/overflow fixtures; the owner-visible purge FK
   DAG/default/nullability/name/column/action/deferrability registry, the per-signature
   `phase6-retention-baseline-v1` tuple, the 26-row exact-rational
   `ucum-subset-v1` registry/fixture/error mapping, the request-idempotency
   column/check/canonical-field/preimage/duplicate-result contract, the checkpoint-
   only nine-column event-payload SELECT policy/profile, the valid-output categorical
   candidate counter/unique materialization invariant, the closed arithmetic metadata/
   rational/error matrix, the complete non-conversion operation metadata/range/state/
   quantization/error/meter matrix, including bare divide -> unit `1`, total clamp
   transform, window-mean range, rejected absent group keys/`invalid_group_key`,
   top-count versus inherited sort-key steps, and disjoint output-ID/intermediate
   accounting; complete MetricContractVersion cross-field and
   contract-output/threshold/target/freshness/lineage conformance, including the
   derived freshness classifier/input/source-row trio, checked lag-plus-SLO threshold,
   deterministic maximum/tie row and exact extra read projections; calculated-Claim
   output/row/cell/value identities and DashboardSpec subtree mapping, four-row FX
   registry and the literal R7 evidence/catalog/contract/bundle/graph/result/meter
   bytes/hashes plus boundary mutations,
   row-count-only window rejection matrix, dashboard tombstone-lineage age-out SELECT/
   policy dependency, and immutable phase-6
   prefix. Freeze the exact per-function relation/column projections for planner Brief,
   common bundle, repair/reviewer reservation, calculated Claims, contract validation,
   and cleanup completion. No semantic field, proof byte, fixture byte, output type,
   owner, payload pointer, unit literal, or retention delta is deferred to SQL or to
   Task 9A judgment; Task 9A only transcribes the literal/algorithmic fixtures here.
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

1. Author the migration once from the frozen Task 9A matrices, including claimed-
   input/replay reads, source-bound replay prerequisite clone/fence, replay consume,
   invocation authorization, material extraction/coverage, validation-finding writer, cumulative audit
   constraint, fixed event helper closure, lock-only/DML policies—including the exact
   principal/policy run SELECT and key-column UPDATE grants, named lock UPDATE
   policies with key-equality `USING`/`WITH CHECK (false)`, and immutable guards with
   no table-wide UPDATE/run-role runtime writer/DELETE—plus drain proof/body
   replacements, immutable drain-proof consumption, and split attempt request/result
   payloads, persisted request-idempotency digest and exact duplicate path,
   checkpoint-only event-payload replay policy/grant and acyclic two-hash checkpoint,
   complete pointer-first purge order, globally idempotent ordinary/mixed claim retry
   discovery and typed reconstruction through a post-run-lock nonlocking immutable-
   header read without event UPDATE/lock-only authority or event-payload SELECT,
   categorical valid-output candidate accounting plus the exact indeterminate
   candidate-field exception in reconcile/takeover/cancel/drain rows and events; the
   four exact database-derived `attempt_indeterminate` reasons, ordered reconcile
   validation/derivation, reconcile-only bounded raw `actual_accounting_bytes`
   parser with the frozen literal grammar/cap/SQLSTATE allowlist and checked typed-
   vector construction before equations/reservation comparison, absent raw-byte
   storage and absent indeterminate actual vectors, and reasonless
   `attempt_cancelled_charged` cancellation/drain split,
   exhaustive lock order, tombstone-lineage lookup, sorted
   retained-chain-set age-out proof/recomputation, age-out-proof disposition, and
   metadata age-out. Include the seven nullable calculated-output Claim columns,
   the six durable tenant-cancel columns/global index, exact event/audit/result
   trigger, and UUID-scoped immutable audit SELECT policy/permanent reservation, the
   bundle-header count/key-only lock plus explicitly nonlocking member
   reads, and the three derived calculation-freshness columns; exact trigger/index/hash/subtree checks, full MetricContractVersion trigger and
   graph conformance, predecessor-compatible FX `typed_value`, the corrected
   all-kind attempt-request bindings, the four exact DML read projections, and
   `dashboard_cleanup_attempts` at its fixed global-lock position; SQL creates no role and
   no generic privileged payload helper.
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
   hostile getter/proxy snapshot tests, including distinct raw/canonical AST gates,
   every rejected registry alias/unit string, the exact 26-entry unit enumeration,
   and lossless tagged-i64 boundaries.
2. Implement canonical snapshot/parser/hash and registry-v1 schemas minimally. This
   package neither accepts nor parses `attempt-actual-accounting-v1`; its tagged-i64
   helpers cannot be used to prevalidate/normalize `actual_accounting_bytes` at the
   adapter boundary or substitute for the fixed SQL parser.
3. Write red decimal/money/null/missing/empty/unit/time/window/FX semantics tests.
   First enumerate every operation row in the frozen non-conversion registry and
   assert accepted input shape/scalar/domain/grain/unit/currency, exact derived
   scalar/nullability/width/fields, rational range, state behavior, error precedence,
   primitive steps, intermediate/output bytes, and logical allocation.
   Freeze every add/subtract/multiply/divide operand cell, derived decimal metadata/
   width, integer/decimal rational behavior, grain/unit/currency rejection, one final
   quantization, dimensionless `divide` unit `1`, ratio reachability, divide-zero/
   inexact/overflow/error priority, and `n` meter. Freeze monotonic clamp and
   window-mean ranges at disjoint/empty/stale/null/overflow boundaries; reject the
   first absent group key as `invalid_group_key` with exact row/key/error/meter order
   while retaining unavailable elsewhere. Freeze
   every normative unit at/invalid/affine/rational/half-even fixture, exact two-stage
   source/base/target order, derived output type, and unit-error priority. Freeze the
   exact four-code ISO registry, canonical directed rate, predecessor-compatible
   `typed_value` evidence row/body/hash/bundle/freshness linkage, output metadata/
   range, missing-before-stale priority, final half-even, and `2n` meter. Transcribe
   and recompute every literal `fx-r7-usd-eur-boundary-v1` body, ID, length, graph/
   result/meter/output hash and exact mutation vector; no fixture field is chosen in
   code. Admit only row-count windows and reject
   every event-time/fixed-duration/calendar-period key or interpretation. Then
   implement those exact primitives without a general UCUM, currency, dimensional,
   or temporal-window parser.
4. Write red inclusive-at-limit, one-over-limit, checked-overflow, static cost/
   cardinality, and runtime meter tests for every `calculation-limits-v1` value,
   including exact AST depth/node, row-bound recurrence, stable-sort step, canonical
   byte/logical-allocation, multibyte, max-width-missing, and static/runtime
   equivalence formulas. Include top-k vectors where top count differs from inherited
   sort-key count, and graphs whose contract output is both final and consumed by two
   diagnostic outputs to prove the output-ID/intermediate partition; then implement
   both layers from one limits object. Exercise the
   external 45-second/256 MiB defense separately and never hash host timing/memory.
5. Add deterministic fixture vectors and canonical-hash stability tests across
   key order and equivalent decimal encodings; cover canonical-input source/request/
   claimed equality and 1..32 scalar/rowset result entries with exact result/field/
   row IDs, domains, order, cardinality, bytes, hashes, and meters. Include contract
   output/threshold/target identity and all cross-field, direction, freshness,
   calendar/timezone, dimension, lineage, owner, and hash conformance fixtures.
   Freshness covers exact/no/duplicate diagnostics, same-contract binding, maximum
   event-time and first-ordinal equal-max row, checked lag-plus-SLO, one-microsecond
   boundary with stale maximum admitted but stale catalog/source/lineage evidence
   denied, unrelated classifier/threshold/source row, and all-null/all-nonnull
   relational projection parity. The bounded river
   dashboard fixture must use exact registry literals `[ft_i]`, `[ft_i]3/s`, and
   `[degF]` and assert the frozen metric conversions to `m`, `m3/s`, and `Cel`; it
   may not introduce `ft`, `cfs`, `degC`, or a parser alias.
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
   every operator function, including bounded claimed-input/replay reads, replay
   prerequisite clone, replay consume, invocation authorization, validation-finding
   commit, reconcile's ordered `actual_accounting_bytes` parameter with no composite
   cast or client-side structural conversion, and the exact planner-Brief/common-
   bundle/repair/reviewer/calculated-Claim/contract projections from section 4.7. A
   required read must be reachable and an extra relation/column or widened grant must
   fail the source/catalog fixture.
3. Implement app calls using the existing pinned transaction wrapper semantics;
   request/cancel must pass exact verified CSRF key-version/digest; request uses a
   fresh audit ID and cancel uses a fresh first-write operation/audit ID retained
   byte-identically for exact retry.
   Replay also binds the exact currently authorized `approval_required` source run,
   closed result grammar, count, contiguous result sequence, and result-chain head.
   Request tests must prove exact duplicate reconstruction of the original
   revision-1/requested/policy/request-hash result with zero duplicate DML after the
   run advances, every digest/input/deployment/lifecycle/purpose/replay drift denial,
   and denial after purge or lifecycle inaccessibility. Cancel tests retain the same
   operation UUID/CSRF/deployment/actor bindings for exact retry, return the stored
   revision/event result before terminal rejection with zero DML, reject operation
   reuse/drift/races, reserve the UUID through content purge, deny original replay
   after purge/age-out, and prove the immutable audit-header probe permanently denies
   reuse on every other run after age-out.
   extract a shared internal wrapper only if byte-for-byte behavior and all
   invitation/session/lifecycle cleanup/release regressions remain intact.
4. Implement a separate run-operator wrapper. Before connection it validates the
   closed request shape and configured restricted run-login identity. Each call
   acquires one pooled run-login client, executes `BEGIN`,
   `SET LOCAL ROLE dasher_run_operator`, `SET LOCAL search_path = pg_catalog`, and
   exactly one fixed claim or post-claim function, then commits. Claim receives
   only request ID/lease seconds and handles the three exact discriminated results;
   an exact ordinary or `terminalized_indeterminate` replay is the original typed
   result with zero DML (including the original ordinary token), while fixed `P1001`
   for a retained-ID kind/lease/principal/input/result or purge drift is never mapped
   to `no_eligible_run` and never selects another run;
   a lost-race `P1002` is rolled back before mapping to no-claim and any retry uses a
   fresh transaction. Post-claim calls verify the exact returned run/
   epoch/token handle. Rollback failure or ambiguous cleanup destroys the client.
   A reconcile retry is allowed only after proven rollback and reuses the identical
   captured accounting byte array; stale/duplicate reconciliation performs no extra
   DML, and no error/log/result may expose those bytes.
   No transaction spans adapter invocation, and the wrapper cannot invoke a
   private context or event helper directly.
   Claimed-input/replay reads still use one fixed call/transaction and return only
   their exact composite/SETOF rows; the source-bound prerequisite clone and replay
   consume are the only no-dispatch source-result/artifact mutations. The adapter
   wrapper treats invocation authorization `authorized_now` as the only callable
   status and documents the unavoidable post-commit concurrency boundary.
5. Implement the pure reducer and prove complete event reconstruction,
   checkpoint equivalence while payloads are retained, hash-only cleaned-tombstone
   reconstruction after purge, duplicate/idempotent event handling, invalid
   transition denial, exact terminal operation/input projections for mixed takeover,
   exact per-attempt and aggregate indeterminate candidate-field releases with every
   noncandidate field charged and no actual vector; reducer/checkpoint rejection of
   every reason outside `caller_indeterminate`, `malformed_accounting`,
   `actual_over_reservation`, and `takeover_after_dispatch`, branch mismatch, or
   reason-bearing cancellation/drain,
   exact tenant-cancel operation/result projections and event/audit reducer binding,
   and no terminal reopen. Checkpoint integration must prove semantic
   `state_sha256` and retained-envelope `checkpoint_sha256` independently in both
   writers/read results, clear only the former on purge, and prove only
   `write_agent_run_checkpoint` can select the nine event-payload columns under its
   current-run/lease/principal/`checkpoint` fence and that the append helper and all
   other fixed functions cannot read bodies.
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
   and treat all adapter responses as hostile input. The accounting member is an
   opaque finite byte sequence: capture it unchanged and enforce only presence and
   the inclusive 1,024-byte transport cap—never decode, structurally validate,
   normalize, or coerce it before reconcile. Every attempt kind's provider input is
   exactly `fake-provider-input-v1`, embedding the parsed retained
   `attempt-request-v1`, exact kind-selected routing fixture, and independently
   rederived semantic request/dispatch hashes; it always binds
   frozen input/common-bundle/kind-policy instruction hashes, and planner alone has a
   null Brief. Recorded results and replay must byte-match that same semantic request
   hash, never the nonce envelope.
3. Implement bounded Suggest orchestration with reservation committed before each
   fake attempt; reserve the Brief's exact one/two generator slots as the sole bounded
   queue before starting its lowest slot. Keep exactly one dispatch lane,
   `start_agent_run_attempt` committing preparation only, and a fresh
   `authorize_agent_run_attempt_invocation` commit immediately before—and required
   for—the call; invoke only for `authorized_now`, never for denial/already-authorized;
   reconcile each caller-claimed determinate response with its canonical recorded-
   result bytes/hash and unchanged nonnull `actual_accounting_bytes`; leave every
   accounting shape/type/value/equation decision to the fixed database parser before
   reservation comparison. A present empty or other bounded malformed sequence must
   remain determinate and reach that parser. Transport absence/failure and byte 1,025
   instead make one explicit `indeterminate` call with accounting/result/hash all SQL
   NULL. Enforce the resulting typed calls/kind/candidate equalities, componentwise
   conservation equations, and the exact no-actual indeterminate rule that fully
   charges calls/kind/noncandidate fields while releasing the reserved candidate
   proof slot; derive `caller_indeterminate` first for explicit transport-
   indeterminate, then database `malformed_accounting` before reservation comparison
   for invalid bounded accounting bytes, then `actual_over_reservation` only for a
   complete equation-valid derived vector, while mixed takeover alone uses
   `takeover_after_dispatch`; never send a
   reason code, and keep cancel/drain on reasonless `attempt_cancelled_charged`;
   enforce zero-limit
   exclusion, prior-epoch takeover quarantine, one transient
   retry, partitioned reviewer budget, inclusive 80% finish behavior, structured
   precommit-only repair (invalid recorded result before any durable candidate),
   cancellation, late-result discard, and prior-good-state preservation.
   Every valid reconciled candidate-producing output charges exactly one categorical
   unit in its result transaction; candidate materialization is one-to-one by result
   and has zero accounting DML across crash/takeover/revocation. Ordinary and mixed-
   takeover retry must reuse the exact claim ID and lease seconds under the same
   latest run principal, accept only the stored zero-DML typed result, and never
   request event-body access; kind/principal/input/result drift is a terminal denial,
   not a fresh dispatch opportunity. Tenant cancel transport retry separately reuses
   its operation/audit UUID and byte-identical expected revision/reason/CSRF/
   deployment/actor binding, accepts only the stored zero-DML result, and never
   re-settles an attempt or substitutes refreshed CSRF material.
4. Freeze the one source-derived common evidence bundle before planner reservation,
   then commit only the successful planner result's typed Brief—including its exact
   specialist boolean and candidate target—bound to it before
   specialist/generator work. Commit one or two candidates without state advance,
   derive/store every material assertion, close the candidate set, commit one exact
   validation-finding set, the complete one-to-one Claims/edges—including exact
   calculated result/output/row/cell/value digests and server-side subtree mapping—and one
   reviewer verdict/manifest for every candidate,
   then use the fixed rank finalizer as the only transition to `approval_required`.
   Implement typed abstentions and hard validity; every candidate shares exact
   bundle membership. Task 9
   inserts no `dashboard_versions` or access-bearing reference claims and exposes
   no acceptance method.
5. Implement replay as a new authorized run whose request binds
   `replay_source_run_id`, source result count/head, and exact recorded-result hashes.
   Require the exact source result grammar and count 3..5, commit the
   source-authorized bundle and Brief only through
   `clone_claimed_replay_prerequisites` before reading results, read only through
   `list_claimed_replay_results`, consume each ordered result only
   through `consume_agent_replay_result`, and use final consumption—not a reservation—
   to enter `generating`; prove zero attempt/dispatch/resource meters, adapter/tool
   calls, retry-grammar/artifact/digest/head/count drift, post-consume source fencing,
   current-authority denial, source cancellation/purge, stale approval denial,
   and no live commit.
6. Cover every run terminal state; the exact valid planner/minimum/maximum signed-i64
   fixtures; present empty bytes and every invalid UTF-8, JSON/JCS, schema, key,
   duplicate, value-type, tag, decimal, canonicality, signed-range, negative,
   category, token/cache/total, and cost/equation class; exactly 1,024 `0x20` bytes
   passed unchanged to database versus 1,025 `0x20` bytes transport-indeterminate;
   no pre-function
   composite coercion; proven-rollback byte-identical retry; stale/duplicate replay;
   no raw-byte persistence/log/error leak; invalid/malformed/throwing provider
   envelopes; secret/error sanitization, incomplete evidence, unsupported claims,
   hidden tool requests, source substitution, authority drift, budget exhaustion,
   and validation-feedback manipulation.
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
  RLS/trigger/dependency/owner/no-sequence catalog, exact phase-6 retention baseline
  plus per-function delta, clean/upgrade/replay/rollback/retry paths;
- app versus run operator versus retention/general-definer/migration-owner
  authority, default-empty run-login enrollment, service-principal revision/hash
  self-binding/discovery column policies, disabled/wrong-login/capability denial,
  global event-header ordinary/mixed claim-ID partial uniqueness and collision
  behavior, exact operation kind/ID/input/result/reconstruction columns, exact
  32-byte terminal claim-input/operation columns and trigger/retention invariants,
  the sole pre-organization claim retry SELECT policy/query projection, fixed non-
  leaking kind/principal/lease/input/result/purge denial, exact historical ordinary
  token reconstruction, zero-DML retry after later lease/release/takeover, post-run-
  lock nonlocking immutable-header reads, and no event UPDATE/lock-only or event-
  payload grant on that path;
  tenant-mutation current-CSRF/audit/deployment proof, role-membership-insufficient
  denial; durable tenant-cancel UUID/operation/result columns, global advisory/index
  first-write/concurrent retry/cross-run reuse, exact actor/revision/reason/CSRF/
  deployment digest, event-to-operation/result-to-event acyclic linkage, exact audit
  projection/content SHA and UUID-scoped nonlocking SELECT policy, zero-DML result
  reconstruction, purge-time reservation/denial, age-out typed-result deletion, and
  permanent audit-header reuse denial; direct-table denial, no table-wide
  grants; exact success of
  `run_service_principal_allowlist_run_lock_update` on only the proven principal key
  and `agent_run_policy_revisions_run_lock_update` on only the proven policy key under
  the real run role, exact column grants/qualifiers/`WITH CHECK (false)`, immutable
  actual/no-op UPDATE denial, no run-role runtime writer/DELETE, and unchanged
  nonlocking ordinary-retry event-header reads; exact bundle-header count/key-only
  lock plus member nonlocking read and twice-fresh digest/count/set revalidation with
  no member UPDATE/lock policy, the sole nine-column
  `agent_run_event_payloads` SELECT grant/profile usable only by the checkpoint
  writer under current run/lease/principal/capability and denied to every other
  function/direct operator/app probe, direct/no-op update denial,
  provisional discovery/lock-context non-mutation, current-user/session-user proof,
  exact function-body relation/column reachability for planner Brief, common bundle,
  repair/reviewer reservation, contract conformance, and calculated Claims, with each
  removed required read failing and every added read/grant/catalog dependency denied;
  lost-race `P1002` rollback before fresh-target retry, and two-order deadlock
  regressions across operator and cleanup paths, including the fixed relative
  positions of checkpoint headers/payloads, predecessor cleanup attempts, drain
  proofs/consumptions, and age-out proofs; claim/record/purge completion-proof races
  lock cleanup attempts before proofs/consumptions and child-first DML starts only
  after the whole ordered lock set;
- exact composite attribute order/types/nullability/type USAGE and `SETOF` behavior;
  requester membership ID/user/revision persistence; active editor/admin claim and
  every post-claim reauthorization; role/revision/revocation races under the real
  run login; explicit absence of worker session-token/session-table authority;
- claimed-input and bounded replay-result reads under exact read capabilities;
  complete purpose/evaluation/input/catalog/contract/limit/source-head/artifact bytes;
  exact `canonical-input-table-v1` source/request/claimed byte+hash equality, tagged-
  i64 losslessness, row-ID/stable-key/order/field/value/count validation, meter/parser/
  graph binding, source canonical/raw request byte ceilings, and denial of every
  source kind except `synthetic_fixture`;
  source-bound prerequisite clone with no caller semantic bytes,
  direct-table/payload-probing denial, stale lease/authority/purge denial, pagination
  gap/order/hash drift, exact same-result idempotency, and no partial redaction;
  request payload column order and exact 32-byte idempotency CHECK, closed request
  schema/hash construction order, run-request advisory serialization, duplicate
  after run advancement returning literal revision 1/requested plus stored
  run/policy/request hash with no duplicate payload/run/counter/event/audit, every
  digest/input/deployment/lifecycle/purpose/replay drift denial, and governed-purge/
  lifecycle-inaccessibility denial;
- access revocation versus run claim/commit; direct PostgreSQL invocation of
  `drain_dashboard_agent_runs` under valid held cleanup leases at `access_revoked`,
  `quarantined`, and `purge_eligible` regardless of `current_step`; terminal
  fencing, idempotent retry, and explicit proof that this slice adds no TypeScript
  or production cleanup-worker caller; arbitrary drain-proof denial; exact same-UUID
  proof/future-attempt binding; request, event-range, generated-proof, and consumption
  byte-vector/one-bit/cross-domain fixtures; zero/nonzero event-boundary pairing and
  canonical `(run_id,event_sequence)` tuple order; preceding attempt/lease and new-
  lease equality on consumption; consumed and unconsumed proofs coexist so age-out
  proves distinct consumption/proof deletion counts; wrong ID/hash/count/boundary/
  lease/principal denial and rollback; exact claim/attempt body replacement, legal hold, complete child-
  before-parent purge/FK ordering, zero physical semantic/payload/evidence-link
  residue, governed-header consistency, 365-day early/held/exact-boundary metadata
  age-out, exact dashboard `tombstone_lineage_id` SELECT/lock-to-tombstone/ledger
  binding, and retry after injected deletion/final-proof failures;
- cross-tenant/missing/forged context, inaccessible dashboard, inclusive expiry,
  revocation, policy drift, pool reuse, and non-leaking denial;
- two claimers plus same-ID concurrent claimers (one commit and one exact historical
  replay, never two runs), lease takeover with all-pre-invocation release versus mixed or sole-
  dispatched indeterminate terminal quarantine, stale epoch/token/expiry on every mutation
  path, no second dispatch, cancellation and terminal races, one dispatch-capable
  active run plus at most two quiescent approvals per dashboard (including a
  reachable source-plus-replay pair), and deterministic global lock order;
  multi-attempt takeover proves
  one ascending interleaved settlement walk, per-attempt release/indeterminate before
  aggregate quarantine, exact released/charged ID subsequences, vector sums with
  candidate released and every noncandidate field charged for each dispatched row,
  count/
  first/last sequence/settlement hash, release-before-new-lease ordering for the
  determinate branch, no new lease for quarantine, composite principal revision token
  binding, ordinary-claim exact replay with exact input/result preimages and original
  token after active/later/released/taken-over states, terminalizing-claim exact
  replay with exact input/result/operation preimages,
  source-head capture, header-only reconstruction, zero DML and drift denial;
  content-purge denial/final-age-out absence behavior, lost-token retry behavior, reducer
  equivalence, rollback at every event, zero stranded outstanding, and no duplicate
  accounting;
- event sequence/prior-hash conflicts, reducer/checkpoint rebuild from every exact
  retained body with request idempotency visible in event 1/checkpoint, distinct
  semantic `state_sha256` and nonce-envelope `checkpoint_sha256` preimages/storage/
  event/return names plus post-purge state clear/envelope retention, checkpoint-
  phase payload policy denial before/after its bounded sequence and after phase
  restoration, immutable-row UPDATE/DELETE denial, and trigger/audit rollback
  atomicity;
- concurrent reservation, partition isolation, checked overflow, inclusive 80%
  boundary only for positive limits, zero-limit denial, complete typed stored vectors,
  Brief-driven generator slot-1/slot-2 batch admission, one nonterminal row per slot,
  one dispatch-lane partial unique index, lower-slot/retry ordering, queued-slot
  supersession release, and a reachable mixed takeover,
  aggregate `total_tokens` enforcement, exact `calls=1` for every dispatched
  determinate outcome, exact specialist/reviewer/repair kind unit, candidate 1 only
  for independently valid generator/repair output and zero otherwise, including the
  reserved-minus-actual candidate release for every other determinate outcome; atomic
  charge at reconciliation, one-to-one zero-DML-accounting candidate materialization after
  crash/takeover, no release on revocation/denial, replay zero counters, fake-provider
  category-overlap/formula drift,
  and canonical request-payload/hash binding; exact SQL/TypeScript equality for the
  396-byte valid planner and 648/634-byte signed-min/max conversion fixtures;
  reconcile catalog/source identity proves `actual_accounting_bytes bytea` with no
  composite argument/coercion/overload; explicit caller indeterminate proves first-
  precedence `caller_indeterminate` with accounting/result/hash all SQL NULL;
  direct determinate SQL NULL, present empty, direct over-1,024, invalid UTF-8,
  invalid JSON, non-JCS whitespace/key order/escape, wrong schema, unknown/missing/
  duplicate key, nonstring value, invalid tag/decimal/canonical form, signed-64
  underflow/overflow, negative, and each category/token/cache/total/cost/equation
  inconsistency proves `malformed_accounting` inside the function before reservation
  comparison. Exact source/body characterization proves only parser/conversion
  SQLSTATEs `22021`, `22P02`, and `22003` are caught in the bounded sub-block, every
  other injected SQLSTATE rolls back, and no regex evaluator, dynamic SQL, arbitrary
  exception swallowing, raw-byte column/hash/event/checkpoint/log/error excerpt, or
  extra relation/DML/authority exists. Exactly 1,024 `0x20` transport bytes reach SQL
  unchanged and classify there, while 1,025 `0x20` bytes and absent/failed transport
  produce explicit all-NULL caller indeterminate without claiming database malformed;
  a fault after parse/conversion/equations and at every settlement/event point rolls
  back all typed vectors/counters/results/events, a proven-rollback retry reuses exact
  raw bytes and settles once, and reducer/checkpoint replay uses only stored typed
  vectors with zero raw-byte reconstruction or extra DML;
  a vector that is both equation-invalid and componentwise excessive proves
  `malformed_accounting`, while repairing only its equation so the same excess is
  complete proves `actual_over_reservation`; mixed
  takeover alone proves `takeover_after_dispatch`. Every one of those exact four
  literals proves absent stored actual, no recorded result, full call/kind/noncandidate
  charge, exact candidate release, zero outstanding, signed-64 conservation, correct
  event bytes/hash/reducer/checkpoint, and rejection of a fifth literal or branch
  mismatch. Tenant cancel/drain prove reasonless `attempt_cancelled_charged`, never
  `attempt_indeterminate` or a reason code, while pre-invocation cancellation proves
  full release,
  every planner/specialist/generator/repair/reviewer request carries the frozen input,
  common bundle, and kind-specific instruction digest; planner alone has null Brief;
  semantic request SHA, nonce envelope, dispatch SHA, provider input, recorded result,
  and replay are independently rederived with the acyclic identities and every null/
  digest drift denied;
  dispatch preparation plus immediately-before-call invocation authorization
  (`authorized_now|already_authorized`), denial/no-call behavior, honest post-commit
  revocation race and reconciliation fence, post-dispatch indeterminate
  timeout, takeover, retry/fallback fresh reservation, and exact conservation/
  reserved/used/released/outstanding arithmetic; tenant cancel and retention drain
  fully release each pre-invocation attempt and apply the same candidate-field
  exception to each dispatched attempt in event order before terminalization;
- graph/result/meter/Brief/bundle/candidate-set/claim/manifest/abstention/ranking/
  recorded-result cross-tenant and cross-dashboard references; one- and two-
  candidate close/rank paths; incomplete/contradicted/stale evidence; canonical
  closed registry names with every alias rejected; separate 131,072 raw and 65,536
  canonical AST gates; governance-aggregation mapping; 1..32 mixed scalar/rowset
  output entries, deterministic result ID, output-node order/type/domain/cardinality,
  derived field IDs and source/select/filter/sort/top-k/group/scalar/window row IDs/
  ordinals/bytes/meters;
  all 26 exact `ucum-subset-v1` strings and every unlisted/case/whitespace/compound
  spelling denial; exact multiplier/offset rationals, dimension compatibility,
  numeric-input/from-unit/currency requirements, affine Celsius/Fahrenheit/Rankine,
  CFS/GPM rational vectors, scale 0/18, 38-digit/74-byte boundaries, one final
  none/half-even quantization, output scalar/unit/nullability/grain/currency/width,
  error priority, and unchanged `2n` primitive-step/static-runtime meter behavior;
  every add/subtract/multiply/divide accepted operand/metadata cell and rejection,
  forced decimal/nullability/grain/unit/currency/74-byte output including exact unit
  `1` for every admitted divide and reachable null-metadata ratio, exact rational and
  integer/decimal behavior, scale 0/18 quantization, divide-zero/inexact/overflow
  precedence, SQL/TypeScript byte agreement, and `n` meter; exact four-code
  `iso4217-task9-v1`, directed tagged-decimal rate, predecessor-compatible
  `typed_value` evidence row/body/hash/
  bundle/lineage/freshness cutoff, output range/metadata, missing-before-stale error
  order, half-even/hash fixtures, and `2n` meter; row-count preceding/following window
  fixtures and explicit event-time/fixed-duration/calendar-period rejection;
  every remaining operation's exact accepted input, derived scalar/nullability/unit/
  currency/grain/width/field schema, range, quantization, state/error priority,
  static/runtime steps, intermediate/output bytes, and logical allocation, including
  delta currency preservation, percentage-change `%`/null-currency cancellation,
  monotonic clamp disjoint-range singletons, window-mean convex-hull/quantization
  bounds, absent group-key `invalid_group_key` precedence/meters and present/stale-only
  group order, top-count versus inherited sort-key count, and consumed-final-output
  exclusion from intermediates;
  complete MetricContractVersion cross-field validity and exact aggregation/measure/
  denominator/dimension/output/threshold/target/grain/lag/SLO/calendar/timezone/
  lineage/graph/result/meter mapping, including the exact optional freshness
  classifier/input/source-row trio, maximum/tie row, checked lag-plus-SLO threshold,
  same-contract calculated subtree and all three writer read projections, with each
  field's one-bit/inertness negative;
  literal R7 FX input/evidence/catalog/contract/bundle/graph/meter/result/output-value
  bytes and every stated hash/UUID/length recomputed in both SQL and TypeScript;
  hash mismatch; every section 4.3 at-limit/one-over/unknown-key/noncanonical/order/
  duplicate/idempotency-drift case; exact reviewer/reason, Claim-edge/label/state,
  exhaustive trusted material path/ID/assertion/set extraction, omission/extra/path/
  subtree/hash/salience negatives, calculated output/row/cell/value/subtree equality
  and unrelated-result denial, all-claim manifest completeness, abstention code,
  eligibility-count and tie-break vectors;
  replay sole/multi/retry results, zero/over-limit denial, fixed clone of source
  bundle/Brief before read, replay-source substitution; a fresh source fence for
  every post-consume graph/candidate/set/validation/claim/manifest/ranking/terminal
  write, source cancel/purge/artifact/head/approval/requester drift with zero local
  mutation; precommit repair success plus post-candidate/second-
  repair denial; and no head/publication mutation;
- lifecycle access revocation fences late work; `drain_and_cancel` terminalizes
  all runs and produces the only accepted quarantine-transition proof; purge
  removes every payload, field catalog, graph/result/calculation meter, metric contract, common
  bundle, Brief, candidate, Claim/edge/manifest, abstention, and recorded result
  before source/evidence rows while retaining only governed metadata for bounded
  held-aware age-out;
- zero-, one-, and multiple-run age-out chain-set fixtures using the exact domain,
  organization/dashboard/lifecycle/count prefix and unsigned run-UUID tuples;
  reversed physical insertion stability, one-bit run/sequence/head/order/count drift,
  signed-64 retained-event checked-sum overflow, per-run gap/head mismatch, nonnull
  zero-run proof, pre-insert computation and independent post-proof-insert/pre-delete
  owner-visible recomputation, deleted-event equality, and rollback on every denial;
- direct probes prove existing claim/record/purge argument meanings, final target-
  organization UUID use, drain/age-out initialization with existing capabilities,
  exact table DELETE only for retention definer, all eighteen retained-to-deleted
  pointer/hash/secret clears, separate immutable attempt request/result rows and
  reconciliation writer,
  no retained purpose/input/replay/request-idempotency/bare hash, and idempotent
  `dashboard_agent_run_age_out_proofs` plus its one-proof-per-lifecycle uniqueness,
  exact pre-deletion chain-set/count/no-content-FK/permanent-proof disposition plus
  `dashboard.agent_run_metadata_aged_out` audit insertion; cumulative preservation of
  every predecessor audit action plus exact request/cancel/drain/age-out action and
  target-type insertion, duplicate-operation no-op, drift denial, and audit-failure
  rollback;
- wrong-purpose/cross-function drain, transition, cleanup-completion, and tombstone/
  backup proof substitution; exact canonical-binary byte vectors, request-versus-
  generated proof columns, drain consumption, recomputed completion proof, producer/
  domain/bound-field/persistence checks and one-bit negatives;
  tenant-cancel and retention-drain failure after one attempt settlement but before
  terminal event/proof, proving rollback of every attempt/vector/run/event/audit/
  proof then exactly-once retry; pointer-clear/content-delete midpoint failure and
  age-out proof/audit midpoint failure with full rollback;
- validation finding schema/kind/count/spec-hash boundaries, exact
  `commit_agent_validation_findings` writer/capability/event, direct insert denial,
  canonical field/order/duplicate/byte/state derivation, manifest dependency, and
  purge-before-candidate ordering;
- owner-visible catalog fixture proves exact constraint/index names, ordered columns,
  no defaults, NOT NULL/nullability, actions/deferrability/predicates and the exact FK
  DAG; it executes pointer clears plus all nine purge groups against fully populated
  rows, with calculation meters deleted before both calculation results and graphs;
  catalog-FK/default/name/order drift and a
  failure at every group boundary deny/roll back before predecessor source/evidence;
- fake/replay result commit after revocation or lease takeover is discarded;
  replay consume requires request-pinned ordered immutable source bytes, rejects
  source-head/purge/hash/sequence drift, and causes exactly zero attempt, dispatch,
  call/token/time/cost, adapter/tool/network, or credential activity; and
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
   hashes, package/fixture hashes, test counts, and cleanup proof. The frozen review
   inventory explicitly includes the two checkpoint hashes, global ordinary/mixed
   claim header, durable tenant-cancel operation/result plus permanent audit
   reservation, exhaustive lock order with locked bundle header/nonlocking member
   revalidation, reconcile's `actual_accounting_bytes bytea` signature and exact
   JCS/cap/parser/SQLSTATE/typed-derivation fixtures with raw-byte nonpersistence,
   categorical candidate invariant, disjoint final/intermediate and
   top-count/sort-key meters, divide-unit/group-key/clamp/window-mean semantics,
   contract-bound calculated freshness, arithmetic/FX/window registries, and
   tombstone-lineage age-out profile.
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
- New managed roles are exact NOLOGIN/NOBYPASSRLS identities with no memberships,
  secrets, default privileges, or unrelated authority. `dasher_run_definer` owns only
  the enumerated operator functions and owns no schema, table, type, sequence, or data;
  `dasher_run_operator` owns nothing. Separately allowlisted run logins have only the
  exact SET membership
  in `dasher_run_operator`.
- Every table/function/policy/grant/trigger/dependency matches phase-7 inventory;
  app/run/retention/PUBLIC authority differs only where explicitly planned.
- For these two non-tenant relations, the run definer can tuple-lock only the exact
  proven
  `run_service_principal_allowlist(run_service_principal_id,principal_revision)` and
  `agent_run_policy_revisions(policy_revision)` rows through their exact R SELECT and
  key-column lock-only UPDATE grants/policies. Both policies use exact transaction-
  local key equality and `WITH CHECK (false)`; immutable guards deny actual/no-op
  UPDATE, and the run role has neither table-wide UPDATE nor DELETE and is never a data
  writer. Ordinary claim retry still reads its immutable event headers nonlockingly;
  this repair adds no event-row lock or event UPDATE authority.
- Every normative function comparison is reachable through its exact relation/column
  projection, including planner Brief, common bundle, repair/reviewer reservation,
  MetricContractVersion, and calculated output lineage; no broader SELECT, mutation,
  helper EXECUTE, ownership, or predecessor authority is present.
- Every bundle-dependent call row-locks only the exact content-addressed bundle
  header, whose positive `evidence_count` equals canonical and physical membership,
  and performs the mandatory fresh ordered member/digest revalidation under the
  locked run immediately before DML. Membership rows remain immutable nonlocking
  reads with no run-definer UPDATE grant/policy; required calls still succeed.
- `agent_run_event_payloads` grants the run definer only its exact nine SELECT
  columns, and forced RLS exposes only the current run's bounded retained prefix to
  `write_agent_run_checkpoint` under the current lease/principal/`checkpoint`
  capability. No other fixed function, direct operator, tenant reader, or generic
  helper can read an event body.
- A request payload persists the exact 32-byte idempotency digest inside the closed
  canonical request and its stable column. Exact duplicate request identity returns
  the original revision-1/requested/policy/request-hash result with zero DML after
  full current reauthorization; any bound-input drift or governed purge denies.
- Every run mutation is exact-run, exact-epoch, exact-token, current-authority,
  lifecycle, policy, and budget fenced; stale or cross-tenant work has zero effect.
- Every committed ordinary or mixed-terminal claim stores one globally unique
  partial-indexed retained event-header operation ID plus exact kind/input/result
  identity and typed result projection. Exact same-principal/same-lease retry is
  discoverable without a run argument, reauthorizes and verifies only enumerated
  retained headers through nonlocking reads after the operation gate/full-context
  promotion/dashboard/run locks, returns the original typed result—including an
  ordinary token after later release/claim/takeover—with zero DML, and never gains
  event UPDATE/lock-only authority or event-body SELECT. Immutable headers plus the
  locked promoted run and operation identity make substitution impossible.
  Any found-ID kind/input/result/principal or purge drift is the one fixed non-leaking
  denial and can never claim another run. Mixed takeover additionally preserves its
  exact run terminal input/operation projection and body-free settlement verification.
- Every tenant cancellation stores its globally unique operation UUID, exact
  actor/authority/expected-revision/reason/CSRF/deployment operation digest, acyclic
  typed-result digest, result revision/event sequence/hash, operation-bound event,
  and audit content SHA on the existing run. Exact retry returns that original
  mutation result with zero DML before terminal rejection; race/reuse/drift denies.
  Content purge keeps the UUID reserved but denies tenant replay; held-aware age-out
  removes the typed-result projection, after which the original target still denies
  and the immutable audit header permanently denies reuse elsewhere.
- Provider invocation occurs only for a fresh `authorized_now` transaction commit;
  denial/already-authorized makes zero call, and later reconciliation independently
  fences the unavoidable post-commit revocation window.

### Ledger, lease, and budget

- Every Task 9 terminal or `approval_required` run reconstructs exactly from
  ordered events while semantic payloads are retained, and no terminal run
  reopens. After governed purge, only the cleaned tombstone projection and stored
  adjacency/count/deletion proof reconstruct; deleted payload digests cannot be
  recomputed because payload nonces and bare content hashes are gone.
- While payloads are retained, checkpoints/projections are rebuildable and
  hash-equivalent to the event reducer from exact event headers and bodies, including
  the event-1 request ID/idempotency/request-hash/policy binding. Semantic
  `state_sha256` is exactly the reducer-state row hash; retained
  `checkpoint_sha256` is exactly the directed nonce envelope. Writers, events,
  headers, payloads, app reads, and operator results use both names without alias;
  purge clears only the semantic digest/pointer and retains the dictionary-resistant
  envelope.
- Every worker-authored path rejects stale epochs/tokens after takeover;
  the bounded generator queue never permits a second dispatch; pre-invocation
  reservations release once; a mixed takeover releases every prepared
  attempt and settles every dispatched attempt by fully charging noncandidate fields
  while releasing the candidate proof slot in one ordered, hashed, rollback-atomic
  settlement before quarantine, while blocking a second dispatch.
  Its source head is the locked pre-settlement head; the aggregate body binds exact
  lease seconds, principal, source head, input digest, settlement digest, and acyclic
  operation digest, and the reducer/run projection agrees without terminal reopen.
- Reconcile alone accepts raw accounting and its argument is exactly bounded
  `actual_accounting_bytes bytea`, not the PostgreSQL composite. The adapter passes
  every present sequence through byte 1,024 unchanged and maps absence/failure/byte
  1,025 to caller indeterminate with all three nullable arguments SQL NULL. The
  database admits no pre-entry shape/type/range coercion, parses the exact
  `attempt-actual-accounting-v1` UTF-8/JCS/tagged-i64 grammar under only the frozen
  three-SQLSTATE catch allowlist, constructs a typed local, and validates equations
  before reservation; it stores that typed vector only for normal determinate
  settlement. No raw byte or digest/excerpt of it reaches a relation, event, result,
  reducer, checkpoint, replay, error, or log.
- Budget conservation and 64-bit bounds remain exact under concurrency;
  `reserved = used + released + outstanding`; admission and inclusive 80% behavior
  use checked arithmetic; generation cannot borrow review; retry/fallback reserves
  anew and retains the first charged result; every dispatched determinate attempt
  charges exactly one call and its kind unit, determinate actual candidate units match
  only valid output, while every other determinate outcome sets
  `actual.candidates=0` and releases the reserved candidate component through the
  unchanged `reserved-actual` equation. Every indeterminate settlement has no actual
  vector, fully charges calls/kind/all other noncandidate fields, sets outstanding to
  zero, and releases only `reserved.candidates` under the signed-64 componentwise
  conservation equation. The reservation fences candidate capacity until settlement;
  the proof slot is released only because no valid immutable recorded candidate output
  exists.
  Every `attempt_indeterminate` event has exactly one database-derived reason:
  explicit caller indeterminate maps first to `caller_indeterminate`; SQL-NULL
  determinate accounting or any present empty/oversized/invalid UTF-8/JSON/JCS/
  schema/key/value/tag/decimal/canonical/range/negative/equation-invalid bounded raw
  accounting maps inside the function before reservation comparison to
  `malformed_accounting`; only a complete equation-valid derived typed vector with
  any component above reservation maps to `actual_over_reservation`; and mixed
  takeover of `dispatch_started` maps to `takeover_after_dispatch`. No fifth literal,
  caller reason argument, stored indeterminate actual, or recorded result is accepted.
  Tenant cancellation and drain use reasonless `attempt_cancelled_charged` and never
  emit `attempt_indeterminate`; event trigger, reducer, checkpoint, and fixtures agree.

- For the categorical `candidates` field, `generation.used_units` equals the checked
  sum of valid reconciled candidate-producing outputs, not an intermediate durable-
  row count. Reconciliation atomically records/charges once; unique
  `source_result_id` materialization charges/releases nothing, is resumable after a
  crash/takeover, and must be complete before set close. Revocation/denial never
  releases used units and replay never touches these counters.

### Calculation and evidence

- Closed AST, stable field IDs, exact decimal/money/null/empty/unit/window/FX
  semantics, and every inclusive/one-over/overflow `calculation-limits-v1` static
  and runtime vector pass. Arithmetic accepts only its frozen numeric/metadata
  combinations, always derives the exact decimal/nullability/grain/unit/currency/
  width, evaluates reduced rationals once, has fixed divide-zero/inexact/overflow
  priority, materializes exact unit `1` for every admitted divide so null-metadata
  ratios are reachable, and produces independently identical SQL/TypeScript bytes
  and `n` meters.
  Unit semantics mean exactly the frozen 26 literals,
  dimensions, rational multipliers/offsets, two-stage affine order, one final
  quantization, derived output type, error mapping, and `2n` charge; no arbitrary
  UCUM grammar exists. FX means exactly four codes, one directed canonical rate and
  typed-value synthetic evidence row/body/hash/common-bundle binding, the fixed inclusive
  evaluation-time freshness cutoff, decimal target metadata/range, final half-even,
  missing-before-stale errors, and `2n`; the literal R7 source/evidence/catalog/
  contract/bundle/graph/meter/result bytes, IDs, lengths, and every domain-separated
  hash recompute exactly, while boundary mutations select their frozen output/error.
  It authorizes no live FX. Windows are only
  row-count preceding/following frames and reject every event-time/duration/calendar
  form. Every other registry operation accepts only its frozen shape/type/domain/
  metadata combinations, derives exact scalar/nullability/unit/currency/grain/width/
  fields and rational range, and has identical SQL/TypeScript state, quantization,
  error, output-byte, step, and logical-allocation results. In particular delta
  preserves currency/unit while percentage change emits unit `%` and null currency.
  Clamp ranges use the total monotonic endpoint transform; window mean has the exact
  convex-hull/final-quantization bound. Missing/null/unavailable group keys fail as
  `invalid_group_key` before grouping while unavailable remains a value elsewhere,
  and group order is defined only for present/stale keys. Top-k steps use inherited
  sort-key count, never top count; final/intermediate meters partition only by
  `output_node_ids`, so a consumed final diagnostic source is never double-counted.
  Deterministic steps/logical allocation are distinct from
  external 45-second/256 MiB defense outcomes and host values are not hashed.
- Existing source canonical bytes, request bytes, claimed bytes, parser rows, graph
  input hash, and input meter are one exact `canonical-input-table-v1` binding with
  lossless tagged signed-64 values; only an existing `synthetic_fixture` snapshot is
  eligible. Registry aliases deny; 1..32 scalar/rowset outputs
  have exact types, domains, stable row/field IDs, ordering, cardinality, hashes, and
  meters.
- Every deterministically extracted material assertion for an `approval_required`
  candidate has exactly one path/ID/hash-bound Claim and all-claim manifest entry and resolves
  through a complete immutable manifest to authorized evidence and, when calculated,
  the exact successful result output plus required row/cell/value digest and
  server-derived DashboardSpec subtree mapping; an unrelated result/output denies.
  Every compared candidate shares the same frozen evidence bundle. Every
  MetricContractVersion field passes its exact cross-field validity; each selected
  graph-capable contract passes its graph selected-output/threshold/target/freshness/
  dimension/grain/calendar/timezone/lineage/meter mapping. Calculated freshness is
  bound to that same contract/result, the one derived classifier/input/source-row
  trio, the maximum event time and deterministic tie row, and checked
  `lag_millis + freshness_slo_millis`; equality maps to `fresh`, the first
  microsecond over maps to reachable `stale`, and unrelated classifiers and
  thresholds deny.
  Selected
  `count_distinct|median` or 17..32 dimensions closes through the exact unsupported
  abstention and creates no graph. No field is inert. Task 9 candidate completion creates no version
  or retention claim; later purge removes all semantic payload and links physically.
- Unsupported, partial, contradicted, stale, Unknown, or Blocked statements never
  masquerade as complete observed/calculated facts; an unsatisfied Brief produces
  only a closed typed abstention without plausible fallback.

### Fake provider and replay

- Import, default, fake, and replay modes use zero network, zero credentials, zero
  provider-hosted tools, zero external side effects, and zero generated code.
- Every reserved attempt kind has one canonical semantic request binding the frozen
  input, already committed common bundle, and exact kind routing-fixture SHA; planner
  alone has null Brief and its legal retry changes only the new attempt/retry IDs.
  Dispatch,
  `fake-provider-input-v1`, recorded result, event, and replay comparisons use that
  semantic SHA and never the retained nonce envelope; all request/dispatch/result
  edges remain acyclic.
- Fake outcomes cover `approval_required`, every Task 9-reachable terminal state,
  every failure class, and explicit denial of `accepted`, with sanitized logs.
- Replay consumes exact recorded results without redispatch, requires current
  authority, obtains source bundle/Brief only through the fixed clone, freshly fences
  source approval/artifacts/count/head on every later commit, detects drift, and
  cannot commit to a live dashboard head.

### Scope and release

- DashboardSpec 1.0/1.1 behavior and generated-code `CLOSED` guard remain green.
- No app route, UI, worker, queue, storage, live source/provider, schedule,
  publication, customer data, deployment, or remediation is added or implied.
- Content purge proves complete semantic/FK absence; retained governed metadata
  contains no request-idempotency digest, claim input/result/token, or checkpoint
  semantic state digest after the exact eighteen clears; retained claim kind/ID and
  checkpoint envelope remain only as governed opaque/dictionary-resistant metadata.
  The six explicitly exempt tenant-cancel fields contain only the operation/result
  commitments and typed result coordinates, keep their UUID reserved through content
  purge, and are deleted with run metadata at the same held-aware age-out boundary;
  the immutable predecessor audit header then keeps that UUID permanently reserved.
  Metadata ages out only through the exact held-aware 365-day retention function,
  whose dashboard SELECT includes and exclusively locks the named
  `tombstone_lineage_id`. Its immutable proof contains the exact sorted
  pre-deletion dashboard run-chain set digest and checked sum of event heads: zero
  runs use the defined nonnull zero-tuple hash, multiple runs sort by unsigned UUID,
  every run proves contiguous events/current head, deletion counts match, and an
  independent post-proof-insert/pre-delete recomputation must agree. All checkpoint,
  predecessor cleanup-attempt, drain-proof, consumption, and age-out-proof locks
  occupy their frozen positions in
  the one global order before child-first deletion begins.
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
