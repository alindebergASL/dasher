# Dasher Private Pilot Execution Roadmap

Status: Accepted execution roadmap
Date: 2026-07-30

## Outcome

The private pilot must prove that a manager can move from a plain-language
request and ordinary data to an evidence-backed dashboard, correct it without
losing provenance, and trust a refresh. Within 30 seconds of first view, the
manager should identify what is known/current, what changed, what is important,
and one safe next action. Evidence for a material claim must be reachable
within two interactions.

The governing product loop is:

> request → source understanding → validated draft → versioned correction →
> refresh without provenance loss

Stages advance by evidence, not dates. A later stage cannot compensate for an
unmet earlier security or comprehension gate.

## Standing constraints

- The pilot is invite-only, multi-tenant, and private-only. There is no public
  signup.
- The control-plane gates in ADR-003 pass before real customer data.
- Deterministic services compute metrics. Models may classify, map, plan,
  explain, and propose a strict `DashboardSpec`.
- Generated-code status remains `CLOSED`. There is no trusted-process code
  execution, provider-hosted tool use, model web search/code interpreter,
  arbitrary stdio MCP, or generated workload access to credentials.
- Secure CSV/XLSX is the first customer-owned data priority. Controlled USGS
  may first prove the live connector and job machinery without changing that
  product priority.
- Native read-only Google Sheets precedes broad or generic MCP.
- Simple manager-facing workflows are the default. Administrative controls are
  progressively disclosed.

## Gate 0 — Foundation checkpoint complete

The merged foundation establishes the versioned schema, deterministic USGS
fixture pipeline and metrics, renderer, Architecture dialog, evidence and
freshness states, tests, and CI. Foundation PR #1 merged into `main` at
`4949591dbb032b9c8d5fbfbc48ba2cd3557cca59` after independent exact-head
reviews and GitHub CI.

This checkpoint is implemented and reviewed. It is fixture-only and is not a
production or pilot readiness claim.

### Exit criteria

- Foundation schema, unit, component, end-to-end, build, and CI gates remain
  green.
- The generated-code gate guard continues to require exact `Status: CLOSED`.
- Live USGS, uploads, providers, authentication, durable tenant storage, MCP,
  and publication remain disabled until their later gates.

## Gate 1 — Executive comprehension and instrumentation

Prove the decision surface with deterministic fixture data before adding
infrastructure.

Build an Executive Brief that presents known/current, changed, important, and
one safe next action above secondary detail. Label observed, calculated,
interpreted, and recommended statements; place freshness and evidence near the
claim. Instrument evidence opens, next-action use, usefulness, and
wrong/unclear/missing-context feedback without treating pre-control-plane
telemetry as durable customer data.

### Exit criteria

- At least 5 of 6 manager-shaped participants identify all four brief elements
  within 30 seconds, uncoached.
- At least 5 of 6 reach evidence for a selected material claim within two
  interactions.
- Every visible factual or calculated claim resolves to valid evidence; stale
  or missing data is not presented as fresh.
- At least 4 of 6 distinguish source facts, deterministic calculations, model
  interpretation, and recommendations.
- Every participant supplies a usefulness rating and one concrete missing
  information or workflow need.

## Gate 2 — Private tenant and control-plane spine

Implement ADR-003 before accepting any real customer data: invitations,
sessions, organizations, roles, PostgreSQL `FORCE ROW LEVEL SECURITY`,
composite tenant-safe foreign keys, immutable sources/evidence/dashboard
versions/job events/audit, tenant-scoped object storage, revocation, limits,
backup/restore, kill switches, and incident controls.

Use synthetic data for this gate. Admin workflows cover invites, membership,
roles, model credentials, and source connections with progressive disclosure.

### Exit criteria

- Invite replay/race/expiry/email and session rotation/CSRF tests pass.
- Cross-tenant read, count, update, delete, reference, enqueue, storage, signed
  URL, job, evidence, and cache tests deny access under restricted runtime
  roles with forced RLS.
- Forged or missing tenant context, pooled-connection reuse, composite-FK
  violations, and membership revocation races fail closed.
- Immutable-record enforcement, compare-and-swap promotion, audit atomicity,
  backup restore, credential rotation, and object retention/deletion are
  demonstrated in the exact integration environment.
- The owner authorizes the permitted real-data classes and data-processing
  terms before Gate 4 receives customer data.

## Gate 3 — Source-neutral snapshots, jobs, and controlled USGS

Build one durable source-neutral pipeline:

> authorized source request → immutable snapshot/evidence → deterministic
> metrics → validated candidate → compare-and-swap promotion

Use the ADR-002 USGS adapter as the first controlled live connector and job
proof. It must use exact approved hosts and parameters, early raw-response byte
limits before parsing, SSRF/redirect/time/decompression controls, snapshot
ceilings as defense in depth, bounded retries, reauthorization, and prior-good
version preservation. No live-only renderer or parallel provenance model is
allowed.

### Exit criteria

- ADR-002 allowlist, blocked-network, redirect, timeout, oversize, malformed
  response, unit drift, duplicate series, partial failure, and fixture/live
  normalization tests pass.
- Raw connector bytes are limited before object construction or parsing; the
  existing object snapshot and schema budgets still apply afterward.
- At least 20 controlled refresh attempts complete with no provenance loss;
  every injected failure or revocation race preserves the prior good version.
- Job deduplication, lease expiry, cancellation, retry, and authority rechecks
  at claim, pre-call, continuation, and commit pass.
- The live result uses the same `DashboardSpec`, evidence, freshness, renderer,
  and Architecture contracts as fixtures.

## Gate 4 — Secure CSV/XLSX and deterministic cash-flow proof

Deliver the first customer-owned-data value proof. A user provides a
plain-language request and an approved CSV/XLSX workbook; Dasher confirms its
understanding of sheets, columns, dates, units, missingness, and likely
entities before producing a private cash-flow dashboard.

Uploads enforce raw body and object bytes before parsing, quarantine,
tenant-scoped storage, parser isolation, decompression/workbook complexity
limits, and macro, external-link, embedded-object, formula-execution, and
formula-injection controls. All displayed cash-flow metrics are computed by
deterministic services and retain workbook, sheet, range, transformation, and
time-window evidence.

### Exit criteria

- At least 6 of 8 varied finance workbooks produce a coherent validated result
  without workbook-specific code; unsupported inputs fail with a clear reason.
- At least 5 of 6 manager-shaped users complete request, understanding
  confirmation, upload, and trusted draft without choosing KPIs or chart
  types; median time is under five minutes on the pilot corpus.
- Clean workbooks require at most one blocking clarification.
- Every displayed source value resolves to workbook/sheet/range evidence, and
  every calculation exposes its inputs, time window, and method.
- Parser isolation is verified from inside the runtime; oversized, deceptive,
  compressed, macro/link/object, formula, and cross-tenant cases fail closed.
- The Gate 1 30-second and two-interaction evidence benchmarks pass on the
  file-generated dashboard.

## Gate 5 — Provider-neutral planning gateway

Implement ADR-004 first in a fake-provider mode, then enable standard
QwenCloud/Model Studio pay-as-you-go organization BYOK as the first capped
live planning proof. Standard OpenAI Platform BYOK may follow through the same
contract. The model may map, plan, explain, and propose; deterministic services
calculate.

### Exit criteria

- Fake-provider mode exercises the full request and validation path with zero
  network and zero credential access.
- Credential class, exact endpoint, region/workspace, and model validation
  occur before data leaves; tests prove a prefix alone cannot classify a key.
- Provider tools, arbitrary compatible base URLs, unsupported plan
  credentials, cross-tenant fallback, and requests beyond budget are rejected
  before transport.
- Invalid `DashboardSpec`, invented or cross-tenant evidence, unsupported
  calculations, unsafe URLs, non-finite values, and unknown components cannot
  create a candidate.
- Credential redaction scans, rotation/revocation races, per-tenant metering,
  capped live smoke, and the provider kill switch pass.
- At least 9 of 10 representative conversational corrections produce the
  expected previewable version with Accept/Undo and unchanged underlying
  evidence unless a new source job is explicitly authorized.

## Gate 6 — Native read-only Google Sheets, then optional MCP facade

First implement a native read-only Sheets connector with separate identity and
data-access consent, per-user OAuth by default, approved files/ranges,
immutable snapshots, minimal scopes, encrypted/revocable credentials, and no
domain-wide delegation.

Only after the native connector proves the source contract may the owner allow
an official remote Google Workspace MCP experiment. It must be remote HTTPS,
administrator-approved, exact-manifest-pinned, read-only, per-user authorized,
resource/audience-bound, no token passthrough, no sampling or server-initiated
model calls, and no transitive action/Gmail/Calendar/Drive-sharing authority.
Manifest drift disables the connection. Generic MCP remains deferred.

### Exit criteria

- Native Sheets passes OAuth state/callback/redirect/reduced-scope/revocation,
  membership, approved-file/range, cross-tenant, snapshot, and evidence tests.
- File uploads, USGS, and Sheets use the same snapshot, evidence,
  `DashboardSpec`, renderer, and Architecture contracts.
- If MCP is attempted, malicious metadata/content, prompt injection, token
  passthrough, audience, SSRF, manifest drift, credential exfiltration,
  cross-tenant access, read-to-write escalation, and action-tool denial tests
  pass in the authoritative environment.
- A side-effect tool cannot be enabled by configuration or model output.

## Gate 7 — Private pilot release and learning

### Entry requirements before the first pilot participant

- Gates 0 through 5 pass on the exact deployment. Gate 6 also passes before any
  Google Sheets or MCP capability is offered.
- The owner records the permitted real-data classes and data-processing terms,
  named pilot cohort and accepted use cases, liability boundary, and explicit
  private-pilot go/no-go decision.
- Restore, credential rotation, revocation, provider/schedule kill switches,
  audit sealing, monitoring, rollback, and incident-response drills pass.
- No unresolved tenant-isolation, secret-handling, ingestion, or authority-race
  blocker remains.

Only then may Dasher release to the owner-approved cohort. Dashboards remain
visible only to explicitly authorized organization members.

### Post-launch success and continuation criteria

- At least three approved pilot organizations independently create a dashboard
  from their own authorized or sanitized workbook, with a champion returning
  on at least two separate days.
- The 30-second comprehension and two-interaction evidence goals continue to
  pass on pilot dashboards.
- At least three of five interviewed managers identify a decision Dasher
  changed or accelerated; the top three repeated problems are fixed or
  explicitly declined with a reason.
- Continued access is paused if a prerequisite gate regresses or the owner
  withdraws authorization.

The owner's entry go/no-go authorizes only a bounded private launch. Meeting the
post-launch criteria supports continued learning. Neither is production
readiness.

## Explicit deferrals

The roadmap does not include:

- broad web research, general browsing, or model-hosted web research;
- unlisted or public publication;
- generated code or any execution path covered by the closed generated-code
  gate;
- generic MCP, arbitrary stdio MCP, auto-discovered tools, or dynamic
  packages;
- side-effect tools or autonomous real-world actions;
- public signup, self-serve billing, or a connector marketplace/catalog;
- unsupported consumer Codex/ChatGPT OAuth, token collection, or local
  authentication import;
- Codex Business/Enterprise access tokens without the contract and gates in
  ADR-004; or
- broad Salesforce, HubSpot, Stripe, QuickBooks, analytics, database, travel,
  or other connector work.

These are future decisions, not implied pilot capabilities. Broad web research
comes only after the own-data loop is proven. Public/unlisted publication needs
a separate authorization, isolation, revocation, cache, and cookie gate.

## Decisions reserved for the owner

Only the owner may decide:

1. Which real-data classes may enter Dasher and which data-processing,
   retention, deletion, privacy, and contractual terms apply.
2. The named pilot cohort and accepted use cases.
3. Private-pilot go/no-go after reviewing gate evidence.
4. The liability boundary: Dasher remains decision support, not an official
   warning, accounting, fiduciary, or autonomous action system.
5. Any future change of `docs/security/GENERATED_CODE_GATE.md` from `CLOSED`.

These decisions cannot be inferred from passing tests or delegated to a model.
