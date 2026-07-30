# Foundation PR Readiness

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Take the reviewed foundation commit `41ff309` on `feat/river-dashboard-foundation` from "reviewed" to "PR-ready": add CI, close the reconciled review findings (input bounds, React keys, audit posture, durable status records), guard the generated-code gate, and finish with exact verification plus two independent reviews before the controller opens the PR to `main`.

**Baseline:** `main` = `1e62e8e` (bootstrap). `feat/river-dashboard-foundation` = `41ff309` (44 files, all 7 foundation tasks squashed into one commit; working tree clean; local and `origin` in sync). All work in this plan lands as additional bite-sized commits on `feat/river-dashboard-foundation`.

**Tech Stack:** Node.js 22, pnpm 10.14.0 (`packageManager` in root `package.json`), TypeScript, Next.js 16, React 19, Zod 4, Vitest 4, Testing Library, ESLint 10 (`typescript-eslint`), Prettier 3 (defaults, no config file), Playwright 1.62 (Chromium only), GitHub Actions.

**Current verification surface (must never regress):** root scripts `format:check`, `lint` (`eslint . --max-warnings 0`), `typecheck` (recursive `tsc --noEmit` ×3), `test` (recursive `vitest run` ×3 — **31 unit/component tests at baseline**: 9 in `packages/dashboard-schema/src/schema.test.ts`, 5 in `packages/river-domain/src/usgs.test.ts`, 4 in `packages/river-domain/src/metrics.test.ts`, 6 in `packages/river-domain/src/dashboard.test.ts`, 7 in `apps/web/components/dashboard-shell.test.tsx`), `build` (`next build` for `@dasher/web`), `test:e2e` (2 Playwright Chromium tests in `apps/web/e2e/river-dashboard.spec.ts`; the webServer runs `pnpm start`, so `pnpm build` must precede `pnpm test:e2e`).

---

## Scope and hard boundaries

**In scope**

- A GitHub Actions workflow on Node 22 / pnpm 10 with `pnpm install --frozen-lockfile`, running Prettier check, ESLint, typecheck, the full unit suite (31+ tests), `next build`, Playwright Chromium e2e, full and production dependency audits, a generated-code-gate guard, a clean-working-tree check, and failure-artifact upload with bounded retention.
- Reasonable upper bounds on future untrusted input arrays in `packages/river-domain/src/usgs.ts` and `packages/dashboard-schema/src/schema.ts`, chosen so `fixtures/usgs/sacramento-instantaneous-values.json` and the current deterministic planner output continue to validate unchanged.
- Stable React list keys in `apps/web/components/component-renderer.tsx` (the two content-derived keys) plus schema-level uniqueness guards.
- A durable automated guardrail that `docs/security/GENERATED_CODE_GATE.md` remains `Status: CLOSED` and that no dynamic-code-execution primitive enters first-party source.
- Durable readiness and security status documents, including a reconciled disposition table for the Qwen 3.8 review findings.
- Exact final verification, two independent reviews, then controller-driven commit/push/PR.

**Out of scope**

- Production deployment, server mutation, live USGS calls, model/API calls, generated-code execution (gate stays CLOSED), auth/billing/multi-tenant persistence.
- Changing the fixture, the deterministic planner's visible output, or any e2e-asserted copy (e.g. `"1 gauge needs attention"`, `"Station 11447650"`, `"38.4566, -121.5019"`).
- Merging the PR — the controller (Hermes) owns merge/review/deploy decisions.
- New runtime dependencies. CI uses only `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `actions/upload-artifact`.

**Reconciliation note on Qwen 3.8 findings:** the three-row table in `docs/security/2026-07-30-security-status.md` is the durable reconciled record. The raw transcript was controller input, not a repository dependency. Qwen reported no blocker or important finding and three minor findings: (a) a claim that `z.number()` may accept non-finite values, which the controller disproved against installed Zod 4.4.3 (`Infinity`, `-Infinity`, and `NaN` all rejected); (b) content-derived React keys `key={claim.text}` and `key={metric.label}`; and (c) unbounded DashboardSpec/USGS collection cardinality, including future `Math.min(...values)`/`Math.max(...values)` spread risk. Missing CI, dependency-audit policy, undocumented supply-chain pins, and absent durable readiness evidence are independently identified foundation-hardening gaps, not Qwen findings. None may be mislabeled as model output.

**Final-review remediation note:** after committed HEAD `52b7fce`, both object
parsers were changed to serialize once, enforce their UTF-8 ceiling on that
serialized JSON representation, parse the same text, and let Zod and downstream
semantics consume only the accessor-free snapshot. Hostile accessor errors are
sanitized, USGS observations cannot postdate query creation, and architecture
edge keys use the same collision-safe JSON tuple as schema uniqueness. These
snapshot ceilings do not bound raw HTTP, upload, model, or connector bytes
before `JSON.stringify`; every future live ingress must enforce raw bytes before
object construction or JSON parsing. The remediation is incorporated by the
post-Task-7 security commit and passed the controller's complete ordered gate
sequence.

---

## Task 1: Bound untrusted USGS input arrays (TDD)

**Objective:** Add explicit upper bounds to every array in the USGS parser schema so an oversized future (live-adapter) response is rejected, without changing the fixture's parse result.

**Files:**

- Modify: `packages/river-domain/src/usgs.ts`
- Test: `packages/river-domain/src/usgs.test.ts`

**Steps:**

1. Write failing tests in `packages/river-domain/src/usgs.test.ts` (follow the existing pattern of cloning the fixture via `structuredClone` and mutating it):
   - "rejects responses with an excessive number of time series": a valid response whose `value.timeSeries` is one valid entry repeated 61 times → expect `parseUsgsInstantaneousValues` to throw.
   - "rejects a time series with an excessive number of observations": one series whose `values[0].value` contains 10,001 synthetic observations → expect throw.
   - "still parses the checked-in Sacramento fixture unchanged": import `../../../fixtures/usgs/sacramento-instantaneous-values.json` (same relative path as `usgs.test.ts:3`), assert 3 gauges and the exact per-gauge observation counts that hold today (Freeport 4 stage + 4 flow; Verona 4 + 4; American River 3 stage + 0 flow after sentinel filtering).
2. Run `pnpm --filter @dasher/river-domain test` — expect the two new rejection tests to fail.
3. Implement in `packages/river-domain/src/usgs.ts` by adding `.max()` to the existing schemas (keep every `.min()` as-is):
   - `ResponseSchema` → `timeSeries: z.array(TimeSeriesSchema).min(1).max(60)` (3 rivers × 2 params today = 6; 60 allows ~30 stations, matching ADR-002's station-count-limit control).
   - `TimeSeriesSchema` → `values: z.array(...).min(1).max(4)`; inner observation array `value: z.array(ValueSchema).max(10_000)` (≈ 3.5 months of 15-minute readings; fixture max is 4).
   - `sourceInfo.siteCode` → `.min(1).max(4)`; `variable.variableCode` → `.min(1).max(4)`.
   - Attach a short error message to each `.max()` (e.g. `"Too many time series in USGS response"`) so rejection reasons are legible in logs.
4. Run `pnpm --filter @dasher/river-domain test` — expect all tests (5 existing + 3 new) to pass. Run `pnpm typecheck`.
5. Commit: `feat: bound untrusted usgs input arrays`

---

## Task 2: Bound DashboardSpec arrays and guard key-relevant uniqueness (TDD)

**Objective:** Add upper bounds to `DashboardSpec` arrays and semantic uniqueness checks for summary claim texts, metric labels, and architecture edges, so no valid spec can produce duplicate React keys — while the current planner output still validates.

**Files:**

- Modify: `packages/dashboard-schema/src/schema.ts`
- Test: `packages/dashboard-schema/src/schema.test.ts`

**Steps:**

1. Write failing tests in `packages/dashboard-schema/src/schema.test.ts` using the existing shared valid-spec fixture builders (lines 1–82):
   - "rejects duplicate claim texts within a summary component" (two claims with identical `text`).
   - "rejects duplicate metric labels within a metric grid" (two metrics with identical `label`).
   - "rejects duplicate architecture edges" (two edges with identical `from`/`to`/`label`).
   - "rejects a dashboard with an excessive number of pages" (17 pages).
   - "rejects a trend series with an excessive number of points" (5,001 points).
2. Run `pnpm --filter @dasher/dashboard-schema test` — expect the 5 new tests to fail.
3. Implement in `packages/dashboard-schema/src/schema.ts`:
   - Uniqueness: extend the existing semantic-validation section of `parseDashboardSpec` to assert uniqueness of `claims[].text` per summary component, `metrics[].label` per metric-grid component, and the collision-safe `JSON.stringify([from, to, label])` tuple across `architecture.edges`.
   - Bounds (add `.max()`, keep existing `.min()`; current planner output remains far inside): `pages` ≤ 16; `components` per page ≤ 24; `claims` and `metrics` ≤ 24; map/table `gauges` ≤ 200; `ranking.items` and `trend-list.series` ≤ 100; `alert-list.alerts` ≤ 200; trend `points` ≤ 5,000; `evidence` ≤ 500; `architecture.nodes` ≤ 64; `architecture.edges` ≤ 256. Final-review remediation additionally caps every `evidenceIds` list and every string category, imposes a 1 MiB serialized JSON object-snapshot ceiling, and enforces global item, trend-point, and evidence-reference budgets. It is not an early raw-ingress byte limit.
4. Run `pnpm --filter @dasher/dashboard-schema test` (9 existing + 5 new pass), then `pnpm --filter @dasher/river-domain test` — the 6 planner tests in `packages/river-domain/src/dashboard.test.ts` prove the deterministic planner output still validates. Run `pnpm typecheck`.
5. Commit: `feat: bound dashboard spec arrays and enforce key uniqueness`

---

## Task 3: Stabilize the two content-derived React keys (TDD)

**Objective:** Replace the two content-derived list keys in the renderer with keys that are unique by construction and scoped to their component, so rendering can never produce duplicate keys even if schema guards are relaxed later.

**Files:**

- Modify: `apps/web/components/component-renderer.tsx`
- Test: `apps/web/components/dashboard-shell.test.tsx`

**Steps:**

1. Write a failing test in `apps/web/components/dashboard-shell.test.tsx` (reuse the existing fixture-driven setup at the top of the file): render `DashboardShell` with the fixture-derived dashboard, spy on `console.error`, and assert no React "Encountered two children with the same key" (or any) error is emitted, and that all three summary claims and all four metric cards render as distinct elements. (This pins current behavior; it will pass before the change too — its role is regression protection. The behavioral driver is step 2's code review of the key expressions.)
2. In `apps/web/components/component-renderer.tsx`:
   - Line 189: change `<p key={claim.text}>` to a component-scoped positional key, ``key={`${component.id}:claim:${index}`}`` (add `index` to the `.map` callback at line 188). Positional keys are correct here: the spec is an immutable value replaced wholesale per ADR-001's immutable-dashboard-version contract, and claims carry no identity field.
   - Line 210: change `key={metric.label}` to ``key={`${component.id}:metric:${index}`}`` likewise (map at line 209).
   - Leave the id-keyed lists untouched. Task 2's edge-uniqueness check backs the architecture key; final-review remediation later replaces its hyphen-joined composite with the same collision-safe `JSON.stringify([from, to, label])` tuple used by schema uniqueness.
3. Run `pnpm --filter @dasher/web test` (7 existing + 1 new pass), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
4. Commit: `fix: use stable component-scoped keys for claims and metrics`

---

## Task 4: Generated-code gate CLOSED guardrail (TDD)

**Objective:** Turn the gate's CLOSED status and the "no dynamic code execution" invariant from prose into an automated check that fails the suite (and CI) if either regresses.

**Files:**

- Create: `packages/dashboard-schema/src/generated-code-gate.test.ts`
- Test: `packages/dashboard-schema/src/generated-code-gate.test.ts`

**Steps:**

1. Write the test file (it runs under the package's existing bare `vitest run`, Node environment; use `node:fs` + `node:path`, resolving the repo root as `../../..` from the test file):
   - "the generated-code gate remains CLOSED": read `docs/security/GENERATED_CODE_GATE.md` and assert it contains the exact line `Status: CLOSED`.
   - Add a clearly labeled static regression tripwire that recursively scans first-party `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, and `.mts` files while excluding generated/dependency directories and the probe test itself. Regex probes cover whitespace and common indirect spellings of eval/Function, dynamic import, child processes, VM/worker runtimes, WebAssembly compilation/instantiation, Deno/Bun process APIs, `document.write`, and unsafe HTML sinks. Representative adversarial spellings must be unit-tested. This tripwire is defense in depth only; it is not sandbox or generated-code isolation proof.
2. Run `pnpm --filter @dasher/dashboard-schema test` — the gate-status, adversarial-probe, and clean-source tripwire tests pass; temporarily edit the gate doc's status line locally to confirm the first test fails, then revert (no committed change to the doc).
3. Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`.
4. Commit: `test: guard generated-code gate closed status`

---

## Task 5: Durable readiness and security status documents (Qwen 3.8 reconciliation)

**Objective:** Record, in-repo and durably, what was verified, the foundation's safety posture, and a per-finding disposition for the Qwen 3.8 review, so the PR carries its own evidence.

**Files:**

- Create: `docs/status/2026-07-30-foundation-readiness.md`
- Create: `docs/security/2026-07-30-security-status.md`
- Modify: `README.md`

**Steps:**

1. Create `docs/status/2026-07-30-foundation-readiness.md` with sections:
   - **Scope**: branch `feat/river-dashboard-foundation`, baseline commit `41ff309`, plus the commits from Tasks 1–7 of this plan (list them by subject once made).
   - **Verification results**: a table of every gate (`pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck`, `test`, `build`, `test:e2e`, `pnpm audit`, `pnpm audit --prod`) with pass/fail, the exact command, and the unit-test count (31 at baseline; expected pre-remediation total 42 after Tasks 1–4: dashboard-schema package 16 = 14 schema + 2 gate, river-domain package 18 = 8 USGS + 4 metrics + 6 dashboard, web 8 — CI requirement is **31+** and must be restated here with the actual number from the final run). Results must come from actually running the commands (Task 7), never from pasted summaries. Review-remediation tests added afterward change the final count; the exact Task 7 rerun is authoritative.
   - **Known deltas**: the 7-task plan landed as one squashed commit; `docs/architecture/ADR-001-foundation.md` and `ADR-002` remain `Status: Proposed` (ADR-001 flips to Accepted only after merge — a controller action); ADR-001's repository layout is aspirational (`apps/worker`, `packages/ui|provenance|model-gateway|sandbox-contract`, `infra/*` do not exist yet); package-level `lint` scripts actually run `tsc --noEmit` (root `pnpm lint` is the only ESLint entry point).
2. Create `docs/security/2026-07-30-security-status.md` with sections:
   - **Posture summary** (mirrors and extends README "Safety status"): fixture mode only; no live USGS, model, or generated-code paths; generated-code gate `Status: CLOSED` and now test-guarded (Task 4); `SafeSourceUrlSchema` rejects non-HTTP(S) and credential-bearing URLs; USGS parser and DashboardSpec arrays now bounded (Tasks 1–2).
   - **Supply chain**: `pnpm-lock.yaml` (lockfileVersion 9.0) is frozen in CI; document the previously-undocumented `pnpm-workspace.yaml` decisions — `overrides: postcss 8.5.25, sharp 0.35.3` (version pinning) and `onlyBuiltDependencies: [sharp]` (lifecycle scripts denied to every other package — a real hardening choice aligned with gate invariant 5); record the `pnpm audit` and `pnpm audit --prod` results from Task 7, and state the policy: severity ≥ high fails CI, any ignore requires a CVE-specific entry under `pnpm-workspace.yaml` `auditConfig` plus a rationale row in this document.
   - **Qwen 3.8 review findings — reconciled dispositions**: exactly three rows matching the raw report, with columns: ID (`Q38-01`…), finding (verbatim or faithful summary), severity, disposition (`fixed-in-this-branch` | `accepted-with-rationale` | `not-applicable` | `deferred-with-owner`), and evidence. Reconcile: (a) alleged non-finite-number acceptance → `not-applicable`, with the installed-Zod probe showing `Infinity`, `-Infinity`, and `NaN` rejected; (b) content-derived React keys → fixed by Tasks 2–3; (c) unbounded collection cardinality / spread risk → fixed by Tasks 1–2 and the established bounds. Record missing CI, audit policy/pin rationale, and durable status as separate controller-identified hardening gaps, never as Qwen findings. During initial reconciliation, an unavailable raw report would have required `PENDING TRANSCRIPT`; after reconciliation, the committed three-row table is the durable record and the controller input is not a repository dependency.
3. In `README.md`, under the existing **Verification** block, add the two audit commands and one sentence pointing to `.github/workflows/ci.yml` (Task 6) and to the two status documents; do not alter the existing command list or Safety status bullets.
4. Run `pnpm format:check` (Prettier formats Markdown; fix with `pnpm format` if needed).
5. Commit: `docs: add readiness and security status with reconciled review findings`

---

## Task 6: GitHub Actions CI on Node 22 / pnpm 10

**Objective:** One workflow that reproduces the full local verification order on every push and PR, with frozen installs, both audits, the gate guard, artifact hygiene, and failure diagnostics.

**Files:**

- Create: `.github/workflows/ci.yml`

**Steps:**

1. Create `.github/workflows/ci.yml`:
   - `name: ci`; `on: { push: { branches: [main] }, pull_request: {} }`; `permissions: { contents: read }`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
   - Single job `verify` on `ubuntu-latest`, `timeout-minutes: 30`, `env: { NEXT_TELEMETRY_DISABLED: "1" }`, steps in exactly this order (mirroring README's Verification block plus this plan's additions):
     1. `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (`v4`).
     2. `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1` (`v4`) with no explicit version — it reads `packageManager: pnpm@10.14.0` from the root `package.json`, keeping pnpm 10 pinned in one place.
     3. `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (`v4`) with `node-version: 22` and `cache: pnpm`.
     4. `pnpm install --frozen-lockfile` (fails on any lockfile drift — the frozen-install requirement).
     5. `pnpm format:check` (Prettier).
     6. `pnpm lint` (ESLint, `--max-warnings 0`).
     7. `pnpm typecheck`.
     8. `pnpm test` (runs all unit/component suites — 42 expected before review-remediation tests, ≥ 31 required).
     9. `pnpm build` (Next production build; must precede e2e because `apps/web/playwright.config.ts` `webServer` runs `pnpm start`).
     10. `pnpm --filter @dasher/web exec playwright install --with-deps chromium` (Chromium only, matching the single `chromium` project in `apps/web/playwright.config.ts`).
     11. `pnpm test:e2e`.
     12. Full audit: `pnpm audit --audit-level high`.
     13. Prod audit: `pnpm audit --prod --audit-level high`.
     14. Gate guard (redundant with Task 4's test, cheap defense-in-depth): `grep -qx 'Status: CLOSED' docs/security/GENERATED_CODE_GATE.md`.
     15. Artifact hygiene — clean tree: `git status --porcelain` must be empty (`test -z "$(git status --porcelain)"`), proving builds/tests generate nothing outside the gitignored `apps/web/.next/`, `apps/web/test-results/`, `playwright-report/`, `*.tsbuildinfo` set.
     16. `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (`v4`) with `if: failure()`, `name: playwright-artifacts`, paths `apps/web/playwright-report/` and `apps/web/test-results/`, `retention-days: 7`, `if-no-files-found: ignore` (bounded retention; artifacts only on failure — nothing uploaded on green runs).
   - Note honored: ADR-002's "CI never calls USGS" holds — every data path in CI is the checked-in fixture.
2. Validate the workflow YAML locally by parsing it (e.g. `node -e "..."` with a YAML parse via `pnpm exec`, or careful review — no `act` dependency required); confirm step order matches README.
3. Run `pnpm format:check` (Prettier also checks YAML).
4. Commit: `ci: add github actions verification pipeline`

---

## Task 7: Exact final verification (full local gate run)

**Objective:** Run the complete gate sequence exactly as CI will, record real results into the Task 5 documents, and leave a clean tree.

**Files:**

- Modify: `docs/status/2026-07-30-foundation-readiness.md` (fill in results)
- Modify: `docs/security/2026-07-30-security-status.md` (fill in audit results)

**Steps:**

1. Run, in order, from `/home/ubuntu/dasher`:

   ```bash
   pnpm install --frozen-lockfile
   pnpm format:check
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm --filter @dasher/web exec playwright install chromium
   pnpm test:e2e
   pnpm audit --audit-level high
   pnpm audit --prod --audit-level high
   grep -qx 'Status: CLOSED' docs/security/GENERATED_CODE_GATE.md
   git status --short
   git status --ignored --short
   git diff --check
   ```

   Expectations: every gate passes; unit-test total ≥ 31 (expected pre-remediation total 42: dashboard-schema package 16 = 14 schema + 2 gate, river-domain package 18 = 8 USGS + 4 metrics + 6 dashboard, and web 8); both Playwright tests pass; only intended source files tracked; generated directories (`node_modules/`, `apps/web/.next/`, `apps/web/test-results/`, `*.tsbuildinfo`) remain ignored. Additional review-remediation tests change the final count, so the exact Task 7 rerun is authoritative. If an audit gate fails, stop and surface it — do not add ignores without a documented CVE-specific rationale (Task 5 policy).

2. Transcribe the actual counts and audit outcomes into the two status documents. Verifier reruns are authoritative over any pasted summary.
3. Commit: `docs: record final verification results`

---

## Review and release gate

1. **Independent review #1 — specification compliance:** a reviewer who did not implement this plan verifies every task's Files/Steps against the diff (`git diff 1e62e8e..HEAD`), confirms the fixture and all e2e-asserted copy are byte-identical to `41ff309`, confirms the unit-test count, spot-checks that behavioral driver tests fail when their production control is removed, and confirms that guard/regression tests exercise their tripwire even when they intentionally pass against the baseline. The reviewer also confirms the plan-to-commit mapping (one conventional commit per task, Tasks 1–7).
2. **Independent review #2 — security:** a second independent reviewer verifies: gate doc still `Status: CLOSED` and the Task 4 guard actually fails when it is not; array bounds reject oversized input; no new dependencies were added; CI has `permissions: contents: read` and no secrets; audit gates are blocking; the Qwen 3.8 disposition table has no empty and no invented rows.
3. Both reviews must run the verification commands themselves; rerun results override any reported summary.
4. Generated-code execution remains disabled; nothing in this plan may weaken `docs/security/GENERATED_CODE_GATE.md`.
5. **Controller actions (Hermes), only after both reviews pass and with explicit user approval:** commit any review-driven fixes, push `feat/river-dashboard-foundation`, and open the PR to `main` titled `feat: river dashboard foundation` with a body linking `docs/status/2026-07-30-foundation-readiness.md` and `docs/security/2026-07-30-security-status.md`. Merge, deploy, and ADR-001 status transition (`Proposed → Accepted` on merge) remain controller decisions outside this plan.
