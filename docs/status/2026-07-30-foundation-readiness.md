# Foundation Readiness Status

Date: 2026-07-30

## Scope

This status covers `feat/river-dashboard-foundation`, starting from foundation baseline `41ff309` (`feat: add river dashboard foundation`). The branch now contains the implementations and records for Tasks 1–7 from `docs/plans/2026-07-30-foundation-pr-readiness.md`, including final-review remediations.

The task-to-commit mapping is:

1. `d6b804188270` — `feat: bound untrusted usgs input arrays`
2. `cbcb67f520d2` — `feat: bound dashboard spec inputs and enforce uniqueness`
3. `085041528a62` — `fix: use stable component-scoped keys for claims and metrics`
4. `b6a6804e9ad8` — `test: guard generated-code gate closed status`
5. `dbfe88ea80bd` — `docs: add readiness security and review evidence`
6. `9fce515ce484` — `ci: add github actions verification pipeline`
7. This evidence commit — `docs: record final verification results`

Task 7's complete ordered command sequence was rerun after final-review remediation. Every executable gate passed.

## Final verification gates

The controller reran the complete ordered sequence on the remediated working tree. Every gate passed; GitHub Actions will provide the clean-checkout confirmation after push.

| Gate                        | Exact command                                                    | Status | Result                                                    |
| --------------------------- | ---------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| Frozen install              | `pnpm install --frozen-lockfile`                                 | PASS   | Lockfile current; pnpm 10.14.0                            |
| Formatting                  | `pnpm format:check`                                              | PASS   | All files matched Prettier                                |
| Lint                        | `pnpm lint`                                                      | PASS   | ESLint exited 0 with zero warnings                        |
| Typecheck                   | `pnpm typecheck`                                                 | PASS   | All three TypeScript workspaces passed                    |
| Unit/component tests        | `pnpm test`                                                      | PASS   | 53/53 tests passed across six files                       |
| Production build            | `pnpm build`                                                     | PASS   | Next.js 16.2.12 production build and static render passed |
| Playwright Chromium install | `pnpm --filter @dasher/web exec playwright install chromium`     | PASS   | Chromium available                                        |
| Browser end-to-end tests    | `pnpm test:e2e`                                                  | PASS   | 2/2 Chromium tests passed                                 |
| Full dependency audit       | `pnpm audit --audit-level high`                                  | PASS   | No known vulnerabilities                                  |
| Production dependency audit | `pnpm audit --prod --audit-level high`                           | PASS   | No known vulnerabilities                                  |
| Generated-code gate         | `grep -qx 'Status: CLOSED' docs/security/GENERATED_CODE_GATE.md` | PASS   | Exact `Status: CLOSED` line present                       |
| Tracked tree review         | `git status --short`                                             | PASS   | Only intended readiness/remediation changes present       |
| Ignored tree review         | `git status --ignored --short`                                   | PASS   | Generated artifacts remained ignored                      |
| Whitespace/error check      | `git diff --check`                                               | PASS   | No errors                                                 |

There are six unit/component test files across three package suites:
`schema.test.ts` and `generated-code-gate.test.ts`; `usgs.test.ts`,
`metrics.test.ts`, and `dashboard.test.ts`; and `dashboard-shell.test.tsx`.
The final total is 53: dashboard-schema package 24 (21 schema + 3 gate),
river-domain package 21 (11 USGS + 4 metrics + 6 dashboard), and web 8.

### Targeted remediation checks

Targeted results are recorded only after execution on the remediated tree. They
do not substitute for the final ordered Task 7 run.

- `pnpm format` completed with no further changes, and
  `pnpm format:check` passed.
- `pnpm --filter @dasher/dashboard-schema test` passed 24/24 tests across two
  files: 21 schema tests and 3 generated-code tripwire tests.
- `pnpm --filter @dasher/river-domain test` passed 21/21 tests across three
  files: 11 USGS tests, 4 metrics tests, and 6 dashboard tests.
- `pnpm --filter @dasher/web test` passed 8/8 tests in one file.
- The targeted total is 53/53 tests across six files.
- `pnpm lint` passed with zero warnings, and `pnpm typecheck` passed for all
  three TypeScript workspaces.

## Known deltas and limitations

- The original seven-task river-dashboard foundation plan landed as the single squashed foundation commit `41ff309`; this readiness plan landed as the seven conventional commits listed above.
- `docs/architecture/ADR-001-foundation.md` and
  `docs/architecture/ADR-002-usgs-live-adapter.md` remain `Status: Proposed`.
  ADR-001 changes to Accepted only after merge, which is a controller action.
- ADR-001's repository layout is aspirational. `apps/worker`, `packages/ui`,
  `packages/provenance`, `packages/model-gateway`,
  `packages/sandbox-contract`, and `infra/*` do not exist yet.
- Package-level `lint` scripts run `tsc --noEmit`. Root `pnpm lint` is the only
  ESLint entry point.
