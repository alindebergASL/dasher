# Track A Planner Spike Status

Status: Implemented spike — not a gate, not pilot-ready
Date: 2026-08-12
Relates to: [Proposed re-sequencing](../roadmap/2026-08-12-proposed-resequencing.md)
(Track A1–A3), [Project and process efficiency review](../review/2026-08-12-project-efficiency-review.md)
(Finding 1)

## Why this exists

The review found that the product's central assumption — a governed planner can
turn a plain-language request into a useful dashboard — was scheduled at Gate 5
and had never been attempted, while roughly 95% of the codebase had been built
beneath it. This spike attempts it, at the smallest honest scale, so the
assumption stops being an assumption.

It is a spike. It passes no gate and authorizes nothing.

## What now exists

`packages/planner` (`@dasher/planner`), plus a request field in `apps/web`.

A request goes in; a validated `DashboardSpec` comes out; the existing renderer
draws it. `apps/web/app/page.tsx` no longer builds a hardcoded dashboard — it
calls the planner with a default request, and the user can type their own.

### The boundary

The planner emits a `DashboardPlan` and nothing else. That contract carries:

- title, audience, and one sentence of framing;
- which USGS site IDs are in scope;
- pages, and for each page an ordered list of sections drawn from a closed
  allowlist of eight kinds Dasher already implements.

It carries no numbers, no evidence, no claims, and no component definitions. A
planner cannot state a fact through this contract because the contract has
nowhere to put one — `DashboardPlanSchema` is a `strictObject`, so an attempt to
attach a reading is a parse failure, not a rendered lie. Tests assert both.

`compilePlan` computes every displayed value from the observations, builds every
evidence item, and hands the result to `parseDashboardSpec`. User-configured
threshold alerts are passed to the compiler as trusted input and are deliberately
_not_ part of the plan contract: a threshold is the user's standing instruction,
so a planner can neither add, remove, nor retune one.

### Structured revision

`runPlanner` validates a plan against the gauges that actually exist and against
the dashboard contract. On rejection it returns typed findings — `unknown_site`,
`duplicate_section`, `plan_malformed`, `spec_rejected`, and four others — and
asks the provider to revise, up to a bounded attempt budget. After the budget it
throws rather than rendering something it cannot stand behind.

This path is exercised, not theoretical. Ask for "the Sacramento and Feather
river gauges" and the stand-in planner proposes a plausible Feather River site
ID that the fixture does not contain. Validation rejects it, the revision drops
it, and the UI says so. An e2e test asserts that site ID never reaches the page.

### Safety posture, unchanged

No network, no credentials, no persistence, no generated-code execution, no
database. `PlanningProvider` has no credential, endpoint, or tool parameter, so
an implementation cannot obtain one through the contract. `plan()` returns
`unknown` rather than `DashboardPlan`, so untrusted output cannot masquerade as
validated output without passing the parser. The generated-code gate remains
`Status: CLOSED`.

## What this proves

- The plan/compile split holds: composition can vary widely while every fact
  stays computed by trusted code.
- Different requests produce genuinely different dashboards. "I need a flood
  watch view for emergency response" yields a different title, audience, page
  set, and leading component than the general request; "How is the American
  river doing?" narrows from three gauges to one.
- The revision loop repairs a real over-reach without a human in the loop.
- The existing renderer, evidence drawer, freshness states, and Architecture
  dialog all work against a planned spec with no changes to their contracts.

## What this does not prove

This is the part that matters, and it is the reason this document is not a gate
record.

- **The planner is a keyword-matching stand-in, not a model.** It is
  deterministic and offline by design, so the machinery can be reviewed before a
  live provider exists. Nothing here is evidence about how a real model composes
  dashboards, and `FakePlanningProvider` says so in its own doc comment.
- **No human has used it.** The 30-second comprehension and two-interaction
  evidence criteria remain unmet and untested by real users.
- **Only eight sections exist.** The creative envelope is real but small. Whether
  it is wide enough for "governed does not mean template-bound" is unanswered.
- **One fixture, three gauges, 20 observations.** No live source, no second
  domain, no customer data.
- **Single-tenant and in-process.** Nothing here substitutes for the ADR-003
  control-plane gates, which remain the precondition for real customer data.

## Known issues

- A one-column panel that lands alone on a grid row renders narrow with empty
  space beside it. This predates the spike — the fixed layout had the same gap
  after `attention` — but variable ordering makes it more visible. Not fixed
  here; it is a renderer concern, not a planning one.
- On screens narrower than 640px the request control is a fixed strip at the
  bottom of the viewport rather than inline. This keeps the executive brief
  fully inside the first mobile viewport, which `river-dashboard.spec.ts`
  asserts and which the product requirements depend on.

## Verification

`format:check`, `lint`, `typecheck`, `test` (1,069 tests across 32 files,
including 12 new planner tests), `build`, and `test:e2e` (6 tests, including 4
new ones) all pass. `pnpm audit --audit-level high` reports no known
vulnerabilities and the generated-code gate check passes.

`test:postgres` was not run; it requires a live PostgreSQL instance. No
migration, SQL file, or control-plane source is touched by this change.

The rendered result was also driven manually in Chromium across four requests to
confirm the composition actually changes and the rejected site never appears.

## Suggested next step

Replace `FakePlanningProvider` with a real provider behind the same interface
and compare. The interface, the validation, the revision loop, and the tests are
already in place, so that swap is the experiment — and it is now a small one.
