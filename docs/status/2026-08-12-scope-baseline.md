# Scope Baseline From the Implementation Plans

Status: Factual baseline — advisory, no gate outcome
Date: 2026-08-12
Reviewed commit: `d01eedce8bff84d54dd79f98d9b3b95e9d40dcdd`
Relates to: [Project and process efficiency review](../review/2026-08-12-project-efficiency-review.md),
[Proposed re-sequencing](../roadmap/2026-08-12-proposed-resequencing.md)

## Purpose and method

The efficiency review scoped the project from the roadmap and ADRs. This document
scopes it from the three implementation plans, which is where task-level scope
actually lives. It claims no gate outcome and changes no plan.

Read in full or near-full for this baseline: `product-spine.md` scope, task list,
and Gate 2-A acceptance matrix; the lifecycle plan's migration boundaries,
deferrals, stage gates, and acceptance checklist; the Task 9 plan's scope,
task definitions, acceptance gates, alternatives, and planning-PR gate; ADR-003;
ADR-004; ADR-005 through its calculation contract; and the 2026-08-04 status
baseline.

Sampled rather than read line by line: the exact-DDL sections of
`product-spine.md` (lines 121–1289) and the Task 9 plan's enumerative interior —
§4.2A relation matrix, §4.3 canonical encoding, §4.4 function identities, and
§5.1 AST closure. Those roughly 4,000 lines specify migrations already merged and
independently measured; they affect the size of the work, not the shape of the
scope. Anyone relying on this document for schema detail should read them.

## 1. Roadmap Gate 2 is subdivided

`docs/plans/2026-07-30-product-spine.md:44` states:

> This plan implements **Gate 2-A**, not all of roadmap Gate 2.

and lines 52–54 name what Gate 2 still requires beyond it:

> Gate 2's remaining object-storage, backup/restore, retention/deletion, job,
> kill-switch, and incident-control evidence must pass separately before Gate 2
> is claimed.

Roadmap Gate 2 therefore contains at least two parts: Gate 2-A, covering
identity, tenancy, and immutable content, and an unnamed remainder covering
storage, jobs, and operations. Only Gate 2-A has an implementation plan.

## 2. The plan chain and supersession

Three plans form a chain. Each preserves its predecessor's merged work and defers
the next problem forward.

| Plan                                                            | Lines | Tasks | State                                      |
| --------------------------------------------------------------- | ----- | ----- | ------------------------------------------ |
| `2026-07-30-product-spine.md`                                   | 1,841 | 1–7   | merged                                     |
| `2026-07-30-product-spine.md`                                   |       | 8–11  | superseded, HOLD — must not be implemented |
| `2026-08-01-dashboard-lifecycle-and-agent-harness.md`           | 1,949 | 8A–8E | merged, plus corrections `0004`–`0006`     |
| `2026-08-04-agent-run-ledger-and-deterministic-calculations.md` | 6,471 | 9A–9G | partial                                    |

Total: 10,261 lines of implementation plan.

The supersession is explicit. `product-spine.md:3-14` marks its own Tasks 8–11
and its minimal immutable-content DDL as HOLD, and instructs that
`0003_immutable_content.sql` must not be created from that document.

### Task 9 state

Mapped from the plan's own task definitions (§7) against git history:

| Task   | Objective                                                 | State       |
| ------ | --------------------------------------------------------- | ----------- |
| 9A     | Freeze phase-7 migrator and authority contract before SQL | done        |
| 9B     | Add one-shot additive `0007`                              | done        |
| 9C     | Implement the pure calculation engine                     | done        |
| **9D** | Run repository, reducer, and fixed transaction wrappers   | not started |
| **9E** | Fake-provider orchestration and content-addressed replay  | not started |
| **9F** | Authoritative PostgreSQL run/race/rollback gate           | not started |
| **9G** | Exact-head review and PR gate                             | not started |

Measured by the plan's own task-specification length, Task 9 is approximately
**30% complete**: 233 lines of specification for 9A–9C against 541 for 9D–9G.
Task 9F alone, at 298 lines, is longer than the three completed tasks combined.

### Two traceability observations

Neither is an accusation; both are records that could not be reconstructed from
the repository and may have resolutions held outside it.

**Implementation authorization is not recorded.** The Task 9 plan at line 37
requires that implementation begin only after the planning PR merges _and_ "the
owner explicitly authorizes an implementation branch from then-current `main`",
and §11 adds that "a review PASS or an open green planning PR grants no
implementation authority by itself." The planning PR (#16) merged 2026-08-05;
Tasks 9A–9C landed 2026-08-11 in PRs #18 and #19. No record of the authorizing
decision exists in the repository.

**Commit subjects understate their content.** Tasks 9A and 9B — including
`0007_agent_run_ledger_and_calculations.sql` at 24,704 lines and
`0008_retention_lock_authority_correction.sql` at 5,910 — landed in `3a031f0`,
whose subject is `fix(control-plane): admit authorized phase to run-lock policies
(R16)`. The largest schema addition in the project's history is recorded as a
policy fix. Anyone reconstructing the migration history from `git log --oneline`
will not find it.

## 3. Completing Task 9 adds no product surface

The Task 9 plan places the following explicitly out of scope (lines 74–75):

> application routes, Server Actions, UI, publication, audience changes,
> dashboard promotion, dashboard-head compare-and-swap, or automatic acceptance

Its acceptance criteria repeat the boundary at line 6378:

> No app route, UI, worker, queue, storage, live source/provider, schedule,
> publication, customer data, deployment, or remediation is added or implied.

and it closes at line 6398:

> Task 9 passing remains only a synthetic run/calculation gate. Gate 2 and every
> live/deployment gate remain separately `PARTIAL`/HOLD.

This is a deliberate and internally consistent boundary. Its consequence for
scope is that when Tasks 9D through 9G are all complete — the entire remaining
current work stream — the web application is still a deterministic fixture
surface, and roadmap Gate 2 is still not passed.

## 4. Planned versus unplanned

Everything covered by an implementation plan is trust-plane substrate. No
user-facing capability has one.

### Planned and specified

Gate 2-A identity, sessions, invitations, and tenant isolation; the `0003`
dashboard lifecycle schema and repository; the Task 9 agent-run ledger and
deterministic calculation engine.

### Named, with no implementation plan

- **The Gate 2 remainder** — object storage, signed URLs, quarantine,
  backup/restore drills, retention and deletion operations, the job system, kill
  switches, and incident controls (`product-spine.md:52`).
- **Sign-in of any kind.** The lifecycle plan (`:1824`) requires a separate
  identity and security plan for the passwordless path, which "may not modify
  `0001`/`0002` or be folded into dashboard `0003`." No local authentication,
  magic link, or OIDC path exists today.
- **The `0005` decision and operating loop** — Decision Snapshot, Recipe, unified
  change timeline, and edge-triggered alerts (`:1792`).
- **All user interface work.** The lifecycle plan (`:1814`) lists the three-pane
  Compose experience, native declarative canvas, Trust Rail, component-merge UI,
  audience-safe lenses and recipient preview, registry/duplicate/retirement, and
  channels/collaboration/digests as UI or future plans.
- **Roadmap Gates 3 through 7** — live USGS and the job system, CSV/XLSX and the
  first real-user comprehension gate, the provider gateway and live model access,
  Google Sheets and any MCP facade, and private pilot operations. Exit criteria
  exist in the roadmap and in ADR-003 through ADR-005; no implementation plan
  does.
- **A deployment prerequisite created by the lifecycle corrections.** The
  2026-08-04 status baseline (lines 92–98) requires, before any deployment into
  an environment that could hold historically affected lifecycle rows, either a
  target-specific zero-inconsistency inventory or a separately planned bounded
  remediation.

Nothing is deployed in any environment.

## 5. What this means for scope

Two facts, stated separately from any judgement about them.

The project has written 10,261 lines of implementation plan to specify Gate 2-A,
the `0003` lifecycle, and Task 9. That is the planning density this project
operates at, and it is the best available basis for estimating the unplanned
remainder.

The unplanned remainder in §4 is larger in capability terms than everything those
10,261 lines cover. It includes every user-facing surface, the entire identity
path, object storage, the job system, the provider gateway, and four roadmap
gates.

This document does not convert that into a schedule. The defensible statement is
narrower: **the work that has a plan is the substrate, and the work that makes
Dasher a product is unplanned.** The current work stream ends with the
application still showing a fixture.

## 6. Where the planner spike sits

Task 9E plans `packages/agent-harness` as the home for a fake provider,
orchestrator, replay, claims, and ranker. The `packages/planner` spike added on
2026-08-12 is a much smaller relative of that, together with the Server Actions
and UI that Task 9 explicitly excludes.

It is not a substitute for Task 9E. It has no run ledger, no lease epochs, no
budget reservation or reconciliation, no Claims or ClaimEvidence edges, no
immutable evidence manifest, and no content-addressed replay. It is currently the
only path in the repository connecting a plain-language request to a rendered
dashboard, and no accepted plan schedules that connection.

## 7. Open questions for the owner

1. Was Task 9 implementation authorized as the plan requires, and should that
   decision be recorded in the repository?
2. Should the Gate 2 remainder, sign-in, and the user interface get
   implementation plans before Task 9D–9G proceeds, so the sequence to a usable
   product is visible?
3. Does the commit-subject traceability gap in §2 warrant a convention change?

## What this document does not assess

It does not evaluate whether any plan's design is correct, whether the Task 9
schema is well formed, or whether the sampled enumerative sections contain
defects. It makes no estimate of duration or effort, and it passes and fails
nothing.
