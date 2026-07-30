# Executive Brief Gate 1 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make known, changed, important, and next-safe-action information explicit, with evidence reachable in no more than two interactions, while preserving the reviewed deterministic fixture. The original human-validation completion method is historical and is superseded by the governance amendment below.

**Architecture:** Add a backward-compatible DashboardSpec 1.1 executive-brief contract while continuing to parse 1.0 dashboards. The deterministic river domain constructs three evidence-linked decision claims (`known`, `changed`, `important`); the existing top-level `nextAction` is rendered as the fourth brief item. The web app renders the brief before detailed components and keeps all evidence in the existing bounded modal. The original plan separated human task-comprehension evidence from agent/browser checks; that completion rule is superseded by the explicit owner-accepted synthetic amendment below without reclassifying agents as humans.

**Tech Stack:** TypeScript, Zod, React/Next.js, Vitest/Testing Library, Playwright, Markdown validation record.

## Post-implementation governance amendment

Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION

After implementation and exact-head review, six isolated, distinct-model agents
rehearsed the decision surface from a cold-load screenshot. The owner then
inspected the dashboard and explicitly replaced the plan's previously required
six-real-person Gate 1 with an owner-accepted synthetic product gate. The six
model IDs are distinct, but provider diversity is not six-way: four are
Claude-family models and two are OpenAI models run through Codex.

This amendment supersedes the human-only Gate 1 completion language in the
historical tasks below. No human sessions were performed, no synthetic agent is
recorded as a human equivalent, and no 30-second human-comprehension claim is
made. The accepted synthetic record preserves 6-of-6 content recovery, 6-of-6
predicted evidence reachability, 6-of-6 mechanically valid one-activation paths,
4-of-6 strict statement-type mapping, and bounded usefulness/need feedback from
all six. Later roadmap gates retain their independent security, real-data,
manager-user, and release requirements.

The governing record is
[`docs/validation/2026-07-30-executive-brief-gate.md`](../validation/2026-07-30-executive-brief-gate.md).
Sections below remain the historical implementation plan and protocol design;
where they require real-person Gate 1 completion, this amendment controls.

---

## Hard boundaries

- Preserve the Sacramento USGS fixture bytes and all existing calculations, pages, evidence, Architecture UI, and generated-code `Status: CLOSED` gate.
- Do not add authentication, persistence, cookies, telemetry backends, uploads, live USGS, model/provider calls, OAuth, MCP, public publication, or deployment.
- Historical Gate 1 completion requirement, superseded by the amendment above: require five of six real target-role participants for comprehension and, independently, five of six for evidence; models and agents could not count as participants.
- Do not retain participant names, sensitive notes, screen recordings, or raw interaction telemetry. The validation record may contain only anonymous session IDs, rounded timings, bounded outcome fields, and non-sensitive aggregate observations.
- Keep all brief strings and evidence-reference arrays within existing DashboardSpec budgets, include brief references in global complexity accounting, and fail closed on missing evidence.
- Maintain a single bounded accessor-free parser snapshot; never reread the caller's original object.

### Task 1: Add the backward-compatible DashboardSpec 1.1 brief contract

**Objective:** Preserve valid 1.0 inputs while requiring an evidence-linked executive brief for 1.1 inputs.

**Files:**

- Modify: `packages/dashboard-schema/src/schema.ts`
- Modify: `packages/dashboard-schema/src/schema.test.ts`

**Steps:**

1. Add a strict brief-claim schema with `headline`, `detail`, and one-to-32 `evidenceIds`.
2. Add a strict `executiveBrief` object containing exactly `known`, `changed`, and `important` claims.
3. Permit schema versions `1.0` and `1.1`; forbid `executiveBrief` on 1.0 and require it on 1.1 in schema validation.
4. Include brief evidence references in `DASHBOARD_MAX_TOTAL_EVIDENCE_REFERENCES` accounting.
5. Validate every brief evidence ID against the accepted evidence set using fixed, sanitized errors.
6. Add tests proving:
   - a valid historical 1.0 dashboard still parses without a brief;
   - 1.0 plus a brief fails;
   - 1.1 without a brief fails;
   - a valid 1.1 brief parses;
   - unknown brief keys fail;
   - missing brief evidence fails;
   - brief references count toward the global budget;
   - hostile getter/Proxy/toJSON one-snapshot regressions still pass.
7. Run focused tests and full dashboard-schema tests before continuing.

### Task 2: Construct the deterministic river executive brief

**Objective:** Generate concise, truthful, evidence-linked known/changed/important claims from the same deterministic metrics and alert state already used by the dashboard.

**Files:**

- Modify: `packages/river-domain/src/dashboard.ts`
- Modify: `packages/river-domain/src/dashboard.test.ts`

**Steps:**

1. Change the generated dashboard to `schemaVersion: "1.1"`.
2. Build `known` from total monitored gauges plus rising/falling counts.
3. Build `changed` from the fastest fresh complete material one-hour rise; when none exists, say no material rise was available rather than inventing change.
4. Build `important` from non-info alert count and the highest-priority alert detail; when none exists, state that configured checks are clear.
5. Reuse only existing observed/calculated evidence IDs; deduplicate while preserving deterministic order.
6. Keep `nextAction` unchanged so the fourth decision item remains the reviewed safe action.
7. Add exact fixture tests for all three brief claims and evidence IDs plus no-material-rise/no-attention fallback tests.
8. Run river-domain focused tests and full package tests.

### Task 3: Render the four-part executive brief with direct evidence

**Objective:** Put known, changed, important, and next safe action ahead of detailed components with clear visual hierarchy and keyboard-accessible evidence controls.

**Files:**

- Modify: `apps/web/components/dashboard-shell.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/components/dashboard-shell.test.tsx`

**Steps:**

1. Add a semantic section labeled `Executive brief` on the Overview page only.
2. Render four ordered items: `Known`, `Changed`, `Important`, and `Next safe action`.
3. Render the schema claim headline/detail for the first three and existing `nextAction` title/detail for the fourth.
4. Each item gets a directly accessible evidence button whose first activation opens the existing evidence modal; evidence content/source is therefore reachable in one interaction, inside the two-interaction limit.
5. Do not duplicate the separate mobile next-action card; retain the persistent desktop sidebar action for non-overview pages.
6. Style a calm four-column desktop strip, two-column tablet/mobile strip, clear attention emphasis without alarmism, visible focus states, and no document-level horizontal overflow.
7. Add Testing Library assertions for order, exact fixture copy, all evidence controls, modal focus/close behavior, Overview-only visibility, and no duplicate mobile action.
8. Run focused web tests and full tests.

### Task 4: Add browser contracts for first-view and evidence reachability

**Objective:** Prove layout, responsiveness, evidence interaction count, and existing behavior in a production browser without pretending automation proves human comprehension.

**Files:**

- Modify: `apps/web/e2e/river-dashboard.spec.ts`

**Steps:**

1. Assert the executive brief appears before `.dashboard-grid` in document order and uses an accessible ordered list.
2. Assert all four decision labels, honest observed/calculated/interpreted/recommended statement-type labels, and exact fixture headlines are visible on desktop and 390×844 mobile.
3. Assert one activation of Changed evidence opens the evidence dialog with the direct USGS source and calculated explanation.
4. Assert one activation of Next-safe-action evidence opens the evidence dialog and records next-action review only in in-memory session telemetry.
5. Assert bounded usefulness, wrong/unclear/missing-context, and missing-information/workflow-need controls remain non-durable and reset on reload.
6. Assert the brief and page have no document-level horizontal overflow at desktop and mobile sizes, that exactly one visible next-action surface remains on mobile, and that readable text and evidence targets still fit the first view.
7. Open Architecture on mobile and prove its dialog content, viewport bounds, and contained scrolling are reachable.
8. Keep page navigation, map selection, modal focus, and contained table-scrolling tests passing.
9. Run Playwright against a production build and inspect desktop/mobile screenshots and console output.

### Task 5: Create the honest target-role validation record

**Historical objective, superseded by the amendment above:** Define and later record the six-person comprehension test without storing real customer data or substituting agent results.

**Files:**

- Create: `docs/validation/2026-07-30-executive-brief-gate.md`
- Modify: `README.md`

**Steps:**

1. Historical status before the amendment: `Status: PENDING TARGET-ROLE VALIDATION`.
2. Define the participant profile: manager/community leader who did not build the dashboard.
3. Define the cold-load script: 30 seconds without coaching; ask the participant to identify known, changed, important, and next safe action; then ask them to open evidence for the named change or action.
4. Ask each participant to distinguish observed source facts, deterministic calculations, interpretations, and recommendations; at least four of six must succeed.
5. Use only non-durable tab-memory instrumentation for cumulative evidence opens and next-action review. For the timed evidence task, the facilitator selects the bounded requested target (`changed` or `next-action`), arms the counter, and closes the feedback dialog; count every click, tap, Enter/Space activation, and Escape from that point until the requested evidence—not unrelated evidence—opens. Then collect a bounded 1–5 usefulness rating, wrong/unclear/missing-context flags, and one concrete missing-information/workflow-need category.
6. Define two independent outcomes per session: comprehension passes when all four decision outcomes are correct without coaching within 30 seconds; evidence passes when the requested evidence opens within two counted interactions.
7. Define aggregate pass: at least five of six comprehension outcomes pass, independently at least five of six evidence outcomes pass, at least four distinguish statement types, and every participant supplies usefulness and need fields. A narrow miss on any threshold remains fail/pending; no model decides the roadmap consequence.
8. Store only anonymous session IDs, rounded seconds, four outcome booleans, the bounded requested-evidence target, evidence interaction count, next-action-reviewed boolean, statement-type outcome, usefulness rating, bounded feedback flags, bounded need category, separate comprehension/evidence pass booleans, and sanitized non-sensitive aggregate observations. Do not store names, organizations, recordings, source data, raw event logs, or free-form personal notes.
9. State explicitly that automated/browser/model reviews are engineering evidence only and do not count toward the six.
10. Add a README link and preserve the current not-pilot-ready warning.

### Task 6: Exact-head verification and PR checkpoint

**Historical objective, superseded by the amendment above:** Produce a reviewed immutable candidate without deploying or claiming the human gate passed.

**Steps:**

1. Run `pnpm install --frozen-lockfile`, formatting, lint, typecheck, all tests, production build, Playwright, full/production audits, exact generated-code CLOSED check, local-link check, `git diff --check`, and clean-tree checks.
2. Confirm the fixture blob hash is unchanged from `main`.
3. Obtain independent exact-head spec and adversarial reviews; remediate all blocker/important findings in a new commit and repeat exact-head review.
4. Push only the approved immutable head, open a scoped PR, and inspect clean-checkout CI on that exact head.
5. Merge only after all protected gates pass and authorization remains valid; verify post-merge `main` CI.
6. Do not deploy. The historical completion rule required a real six-session record; the owner-accepted synthetic amendment above now controls Gate 1 completion.
