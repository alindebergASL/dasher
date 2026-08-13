# Forward Plan: everything between here and a pilot

Status: Proposed — requires owner acceptance; nothing here is authorized work
Date: 2026-08-13
Answers: should Task 9E be built, and what replaces it
Relates to: [Restructure proposal](../review/2026-08-13-restructure-proposal.md),
[Removal register](../process/2026-08-12-removal-register.md),
[Requirements Amendment 01](../product/2026-08-12-requirements-amendment-01.md),
[Private pilot roadmap](2026-07-30-private-pilot-roadmap.md) (Accepted)

Written against the squashed baseline. Sizes are magnitude bands, not estimates;
where a number would be false precision it is omitted.

---

## 1. Should Hermes build Task 9E?

**No.** Not as specified, and not as a package.

Task 9E creates `packages/agent-harness` with nine modules and an adversarial
fixture matrix. Its own file list settles the decisive question: the only file it
modifies outside itself is the workspace importer in `pnpm-lock.yaml`. Nothing
imports it. It would join `calculation-engine` as a complete, well-tested,
unreachable package — except that unlike `calculation-engine` it would also
duplicate a loop that already runs in the product.

Component by component:

| 9E component                                           | Disposition | Where it goes                                            |
| ------------------------------------------------------ | ----------- | -------------------------------------------------------- |
| Provider-neutral request/result contracts              | **exists**  | `PlanningProvider` in `packages/planner`                 |
| Deterministic fake provider, responses hostile         | **exists**  | `FakePlanningProvider`                                   |
| Bounded orchestration, structured repair, retry        | **exists**  | `runPlanner`, `PLANNER_MAX_ATTEMPTS`, `findPlanProblems` |
| Zero-network source guard                              | **keep**    | cheap and genuinely useful; add to `planner`             |
| **Evidence bundle, Claims, ClaimEvidence edges**       | **keep**    | **step 3 below — this is the differentiator**            |
| Candidate generation and ranking                       | descope     | one candidate until someone asks for alternatives        |
| Reservation, authorization, reconciliation, accounting | defer       | step 11, when a metered provider exists                  |
| Lease epochs, fencing, takeover                        | defer       | when a worker process exists                             |
| Checkpoints, resume                                    | defer       | when a run outlives a request                            |
| Content-addressed replay                               | **drop**    | avoids re-calling a provider that is never called        |

Roughly one seventh of 9E survives, and it belongs in `packages/planner`, next to
the code that will call it, not in a new package.

**What Hermes should build instead is step 1 below.**

---

## 2. The critical fact that shapes everything after

The accepted roadmap defines pilot success as:

> At least three approved pilot organizations independently create a dashboard
> from **their own authorized or sanitized workbook**.

The product is not the river dashboard. The river dashboard is a fixture demo,
and it is the only thing that has ever been built. Nobody has uploaded a
spreadsheet, no column has ever been mapped to a metric, and no dashboard has
ever been composed from data the project did not author.

That gap — between "the planner composes a river dashboard from a fixture" and "a
manager uploads their spreadsheet and gets something useful" — is the largest
unvalidated assumption in the project, and it sits on the critical path to every
pilot criterion. Everything in phase 1 exists to reach the point where that
assumption can be tested cheaply.

---

## Phase 1 — Make the spine real

The goal is a product loop that works end to end for one person on one machine.
Each step ends with something visible in a browser.

### Step 1 — A dashboard survives a page reload

**Why first.** The baseline schema is 1,046 lines that nothing calls. Until a
request path touches it, it is unvalidated — and the whole argument of the
restructure is that unreachable code is the disease. This step puts a database in
the request path for the first time in the project's history and tests the
schema, the row-level-security request context, and the migrator at once, against
real use rather than against tests written to match the schema's own assumptions.

**Contains.** A development seed for one organization, user, and membership — the
foreign keys require a principal and there is still no sign-in. A repository for
`dashboards` and `dashboard_versions`. Persist the compiled spec on generation,
load it by id, render it. One new route.

**Size.** Small — on the order of 400–600 lines including tests.

**Watch for.** This is where the RLS context GUCs get exercised for the first
time. Setting `dasher.context_organization_id` per request, and proving a missing
context yields zero rows rather than everything, is the real content of this step.

### Step 2 — One evaluator, called by the product

**Why.** There are three implementations of "compute a displayed value": the
PL/pgSQL evaluator (now deleted with the squash), `calculation-engine` (17,372
lines, 303 tests, called only by a test), and `planner/src/compile.ts`, which
computes values inline. The good one is unused.

**Contains.** `compile.ts` delegates value computation to `calculation-engine`.
Delete the duplicated arithmetic. Registry gaps surface here.

**Size.** Small. Mostly deletion.

### Step 3 — Claims and evidence in the compile step

**Why.** This is the surviving seventh of 9E and the reason anyone would trust a
generated dashboard: every assertion on the page traces to bytes that were
actually retrieved. `dashboard-schema` already carries `EvidenceSchema`; the
baseline already has `source_snapshots`, `evidence_records`, `claims`, and
`claim_evidence`.

**Contains.** The compiler emits a claim per displayed assertion, at its JSON
pointer, with a label (`observed`, `calculated`, …) and edges to the evidence it
used. Persist alongside the version. Surface evidence state in the UI.

**Why here rather than in a ledger.** The compiler already knows every input to
every output. A claim is that relationship made durable. Building it anywhere
else means reconstructing knowledge the compiler already has.

**Size.** Medium.

### Step 4 — More than one dashboard

**Contains.** A list view. Create, archive, unarchive. Search across title,
audience, source, and freshness — required by amendment A3, which removed expiry
and made archiving plus search the only scale mechanism. Refinement by prompt: a
user says what to change and gets a new validated version, per A4.

**Size.** Medium. The refinement path reuses `runPlanner`'s revision channel.

**Open decision.** A5 — the alerting-versus-disclaimer tension is unresolved. The
planner today will title a dashboard "Sacramento Flood Watch" and address it to
"Emergency management leads" while the product disclaims safety-critical warning.
This needs a product answer before anything ships to anyone, and it is a
constraint on the composition contract, not a disclaimer.

---

## Phase 2 — Make it usable by someone who is not you

### Step 5 — Sign-in

**This is the actual blocker to a pilot user, and it does not exist.** No sign-in
path of any kind is implemented and none is planned. `sessions`, `memberships`,
`invitations`, and `external_identities` are all modelled and tested; nothing
issues a session.

**Decide build versus buy first.** The pilot needs one identity provider, not an
identity system. This is the piece most amenable to buying, and the tenancy work
already done is what makes buying cheap — the schema does not care where the
subject came from.

**Size.** Medium if bought, large if built.

### Step 6 — Deploy it somewhere

**Nothing is deployed. There is no environment.** No host, no domain, no TLS, no
secret storage, no database backups, no logging. The roadmap treats deployment as
a Gate 7 entry requirement, which means it is currently unscheduled and entirely
unbuilt.

This should happen _early_, not late — a deployed environment with one dashboard
and one user teaches more than another package, and every later step needs
somewhere to run.

**Size.** Medium, and mostly decisions rather than code.

---

## Phase 3 — Make it about the customer's data

This is Gate 4, and it is what the pilot criteria actually require.

### Step 7 — Upload and parse a workbook

CSV and XLSX ingestion, quarantined and typed, producing `source_snapshots` and
`evidence_records` the same way the river fixture does. The evidence chain is
already designed for this; nothing about it is river-specific.

**Size.** Large. Spreadsheets are hostile input in every direction.

### Step 8 — Map columns to metrics

A field catalog and metric contracts, so an uploaded column becomes something the
planner may select and the engine may compute. The baseline dropped
`field_catalog_entries` and `metric_contract_versions`; they come back here, when
there is a real column to catalog.

**Size.** Large, and the least well understood work in the project.

### Step 9 — Close the registry gap

Amendment A6: `count_distinct`, `median`, and percentile with an explicit
interpolation rule must execute, not abstain. "How many distinct accounts,"
"median deal size," and "p90 cycle time" are ordinary executive questions, and
the cash-flow vertical is hard to serve without them.

**Size.** Small — `calculation-engine` is well-structured for this.

---

## Phase 4 — Make it live

### Step 10 — A real model behind `PlanningProvider`

The interface exists and takes no credential, endpoint, or tool parameter, so the
swap is genuinely small. What makes it non-trivial is everything around it:
credential storage and per-organization selection (A1 — never a fallback, always
an explicit stored choice), timeouts, and failure behaviour.

**Size.** Medium.

### Step 11 — The provider evaluation harness, and only then metering

A2 requires choosing the first live provider by measured dashboard quality rather
than fixing it in advance. Because the planner emits a composition plan and
trusted code computes every value, comparison is a deterministic diff over plans
rather than a subjective read of rendered output — so this harness is cheap if
the fake provider stays the permanent test substrate rather than a phase to pass
through.

Budgets, metering, and reservation belong **here**, not in phase 1, because this
is the first moment a call costs money.

**Size.** Medium.

---

## Phase 5 — Operability, when there is something worth protecting

Backup and restore drills, credential rotation, revocation, provider and schedule
kill switches, audit sealing, monitoring, rollback, incident response. All are
Gate 7 entry requirements and all are currently unbuilt.

Every one of them is cheap to defer and expensive to do early, because each
protects an asset that does not exist yet. They become urgent the day real
customer data lands, and not one day before.

---

## Also outstanding, not on the critical path

- **Refresh and scheduling** (Gate 3). Nothing re-runs. A dashboard is composed
  once and never updated.
- **Rewrite the Task 9 plan as invariants.** 7,199 lines, which grew 738 lines
  during its own implementation. A specification that changes while being
  implemented is being discovered, not followed.
- **Cut the gates from roughly nineteen to four** — it builds, it is safe, a
  person used it, real data works — plus a dated register of accepted risk.
- **Delete the prototype-capture ceremony.** 163 declarations routing ~200 call
  sites through `reflectApply(...)` to defend against an attacker who already has
  code execution in the process.
- **Legal and commercial** — permitted data classes, processing terms, liability
  boundary, pilot cohort. Owner-only decisions, and Gate 7 entry requirements.

---

## What this means for sequencing

| Phase | Steps | Ends with                                             |
| ----- | ----- | ----------------------------------------------------- |
| 1     | 1–4   | a working product loop, one machine, fixture data     |
| 2     | 5–6   | someone other than the owner can sign in and use it   |
| 3     | 7–9   | that person can use **their own** data                |
| 4     | 10–11 | a real model composes it, chosen on measured evidence |
| 5     | —     | it can be operated safely with real data in it        |

Phase 3 is the riskiest and least understood, and it is the one the pilot
criteria depend on. Phases 1 and 2 exist to make phase 3 testable cheaply rather
than as a large speculative build.

**The single next unit of work is step 1.** It is small, it is finishable, it
ends with something observable, and it is the first thing in this project that
would make the database reachable from a browser.
