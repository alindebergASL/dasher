# River Dashboard Foundation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Deliver a locally runnable, deterministic multi-page river-conditions dashboard generated from USGS-format fixtures, including evidence/freshness states and a plain-language Architecture diagram.

**Architecture:** A pnpm TypeScript monorepo separates the Next.js renderer from shared dashboard and river-domain contracts. The first slice contains no model call and no generated-code execution: a deterministic planner converts normalized river observations into a validated `DashboardSpec`. This establishes the safe contract that later AI and sandbox services must use.

**Tech Stack:** Node.js 22, pnpm workspaces, TypeScript, Next.js, React, Zod, Vitest, Testing Library, ESLint, Playwright.

---

## Scope and hard boundaries

In scope:

- Monorepo/tooling foundation.
- Versioned multi-page `DashboardSpec`.
- USGS-format fixture normalization and calculated trends.
- Deterministic Sacramento river dashboard planner.
- Dashboard shell, page navigation, summary/cards/ranking/trend/map-ready gauge list.
- Evidence/freshness UI.
- Architecture button and plain-language diagram derived from the spec.
- Unit/component/end-to-end tests and local production build.

Out of scope:

- Production deployment or server mutation.
- Authentication, invitations, billing, or durable multi-tenant database writes.
- Real model/API calls.
- Arbitrary generated-code execution.
- Live scheduled refresh.
- All non-USGS connectors.
- Claims that this is an official warning system.

## Task 1: Create the workspace and quality gates

**Objective:** Establish an installable monorepo with deterministic commands.

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `README.md`

**Steps:**

1. Add root scripts for `format:check`, `lint`, `typecheck`, `test`, and `build`.
2. Add workspaces for `apps/*` and `packages/*`.
3. Install dependencies and commit `pnpm-lock.yaml`.
4. Run `pnpm install --frozen-lockfile`; expect success.
5. Commit: `chore: initialize dasher workspace`.

## Task 2: Define the trusted dashboard schema

**Objective:** Create a versioned fail-closed contract for multi-page dashboards and their architecture metadata.

**Files:**

- Create: `packages/dashboard-schema/package.json`
- Create: `packages/dashboard-schema/tsconfig.json`
- Create: `packages/dashboard-schema/src/index.ts`
- Create: `packages/dashboard-schema/src/schema.ts`
- Test: `packages/dashboard-schema/src/schema.test.ts`

**Steps:**

1. Write failing tests that accept a two-page dashboard and reject unknown component kinds, dangling data/evidence references, and an absent architecture model.
2. Run `pnpm --filter @dasher/dashboard-schema test`; expect failure.
3. Implement Zod schemas for dashboard metadata, pages, component registry, evidence references, freshness, and architecture nodes/edges.
4. Add a semantic validator for cross-references.
5. Rerun the package test; expect pass.
6. Commit: `feat: define dashboard specification`.

## Task 3: Build the river-domain normalization and metrics

**Objective:** Convert USGS-format observations into a stable domain snapshot and calculated changes.

**Files:**

- Create: `packages/river-domain/package.json`
- Create: `packages/river-domain/tsconfig.json`
- Create: `packages/river-domain/src/index.ts`
- Create: `packages/river-domain/src/usgs.ts`
- Create: `packages/river-domain/src/metrics.ts`
- Test: `packages/river-domain/src/usgs.test.ts`
- Test: `packages/river-domain/src/metrics.test.ts`
- Create: `fixtures/usgs/sacramento-instantaneous-values.json`

**Steps:**

1. Add a small deterministic fixture covering multiple gauges, water level, streamflow, missing values, and observations spanning at least 24 hours.
2. Write failing parsing tests for station identity, units, timestamps, coordinates, and source identity.
3. Write failing metric tests for one/six/24-hour deltas, rising/falling/steady classification, fastest-rising order, and stale/missing states.
4. Implement strict parsing with explicit unsupported/malformed errors.
5. Implement pure metric functions with documented tolerances and units.
6. Run package tests; expect pass.
7. Commit: `feat: normalize river observations and metrics`.

## Task 4: Plan the deterministic river dashboard

**Objective:** Produce a valid multi-page `DashboardSpec` without model access.

**Files:**

- Create: `packages/river-domain/src/dashboard.ts`
- Test: `packages/river-domain/src/dashboard.test.ts`

**Steps:**

1. Write a failing test asserting Overview and Gauge Details pages, summary, map-ready gauge data, current metrics, fastest-rising ranking, trends, stale warnings, and source evidence.
2. Assert the architecture model names USGS input, normalization/calculation, dashboard pages, and manual/daily refresh in plain language.
3. Implement the deterministic planner.
4. Validate the result with `@dasher/dashboard-schema` before returning it.
5. Run tests; expect pass.
6. Commit: `feat: generate river dashboard specification`.

## Task 5: Create the web renderer

**Objective:** Render the trusted specification as calm executive software.

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/components/dashboard-shell.tsx`
- Create: `apps/web/components/component-renderer.tsx`
- Create: `apps/web/components/architecture-dialog.tsx`
- Test: `apps/web/components/dashboard-shell.test.tsx`

**Steps:**

1. Write component tests for page switching, freshness visibility, evidence opening, and Architecture dialog opening.
2. Implement the shell and a reviewed renderer switch that fails closed for unknown components.
3. Implement accessible executive-style cards, ranking, trends, warnings, and map-ready gauge list. A geographic plotting library is optional in this slice; the UI must still expose gauge coordinates and geography coherently.
4. Derive the Architecture diagram directly from `DashboardSpec.architecture`.
5. Verify keyboard navigation and accessible dialog semantics.
6. Run component tests; expect pass.
7. Commit: `feat: render river dashboard experience`.

## Task 6: Add end-to-end proof

**Objective:** Prove the production build and primary user path.

**Files:**

- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/river-dashboard.spec.ts`

**Steps:**

1. Add an end-to-end test that loads the dashboard, switches pages, opens evidence, opens the Architecture diagram, and confirms no horizontal overflow at desktop and 390px widths.
2. Run `pnpm lint`; expect pass.
3. Run `pnpm typecheck`; expect pass.
4. Run `pnpm test`; expect pass.
5. Run `pnpm build`; expect pass.
6. Run `pnpm --filter @dasher/web test:e2e`; expect pass.
7. Commit: `test: prove river dashboard vertical slice`.

## Task 7: Document the live-adapter seam and deployment gate

**Objective:** Make the next slice explicit without silently widening scope.

**Files:**

- Modify: `README.md`
- Create: `docs/architecture/ADR-002-usgs-live-adapter.md`
- Create: `docs/security/GENERATED_CODE_GATE.md`

**Steps:**

1. Document local commands and what is deterministic versus live.
2. Define USGS request allowlists, timeouts, response limits, provenance, caching, and fixture refresh procedure.
3. Define the non-negotiable sandbox controls required before generated code can execute.
4. Record deployment prerequisites: authentication, PostgreSQL/RLS, secret storage, rate limits, backups, nginx/HTTPS, and production-safe smoke tests.
5. Run documentation/link checks if configured.
6. Commit: `docs: define live data and generated code gates`.

## Final verification

Run from repository root:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @dasher/web test:e2e

git status --short
git status --ignored --short
```

Expected: all gates pass; only intended source files are tracked; generated directories remain ignored.

## Review and release gate

Before any deployment:

1. Independent specification-compliance review.
2. Independent security/code-quality review.
3. Verify exact commit and CI results.
4. Keep generated-code execution disabled.
5. Obtain explicit user approval before pushing a PR, merging, or modifying the EC2 server.
