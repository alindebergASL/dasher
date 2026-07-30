# Foundation Readiness Status

Date: 2026-07-30

## Scope

This status covers `feat/river-dashboard-foundation`, starting from foundation
baseline `41ff309` (`feat: add river dashboard foundation`). Before the
implementation tasks, the readiness plan was added in `4454a5d`
(`docs: plan foundation PR readiness`) and its review-reconciliation scope was
corrected in `3c06725` (`docs: correct qwen review reconciliation scope`).

The committed task-to-commit mapping through exact pre-remediation HEAD
`52b7fceb5997166a60c80d61cc7405249f3a71a6` is:

1. `d6b804188270` — `feat: bound untrusted usgs input arrays`
2. `cbcb67f520d2` — `feat: bound dashboard spec inputs and enforce uniqueness`
3. `085041528a62` — `fix: use stable component-scoped keys for claims and metrics`
4. `b6a6804e9ad8` — `test: guard generated-code gate closed status`
5. `dbfe88ea80bd` — `docs: add readiness security and review evidence`
6. `9fce515ce484` — `ci: add github actions verification pipeline`
7. `52b7fceb5997` — `docs: record final verification results`
8. This remediation commit — `fix: snapshot hostile parser inputs once`

A fresh exact-head security review after Task 7 identified hostile accessor rereads,
serialized-ceiling bypasses, and a delimiter-colliding architecture React key.
The remediation commit closes those findings and adds focused regressions. The
controller then reran the complete ordered gate sequence on the modified tree.

## Final verification gates

The controller ran the complete sequence against the remediated working tree.
Every gate passed; GitHub Actions will provide clean-checkout confirmation after
push.

| Gate                        | Exact command                                                    | Status | Result                                                    |
| --------------------------- | ---------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| Frozen install              | `pnpm install --frozen-lockfile`                                 | PASS   | Lockfile current; pnpm 10.14.0                            |
| Formatting                  | `pnpm format:check`                                              | PASS   | All files matched Prettier                                |
| Lint                        | `pnpm lint`                                                      | PASS   | ESLint exited 0 with zero warnings                        |
| Typecheck                   | `pnpm typecheck`                                                 | PASS   | All three TypeScript workspaces passed                    |
| Unit/component tests        | `pnpm test`                                                      | PASS   | 63/63 tests passed across six files                       |
| Production build            | `pnpm build`                                                     | PASS   | Next.js 16.2.12 production build and static render passed |
| Playwright Chromium install | `pnpm --filter @dasher/web exec playwright install chromium`     | PASS   | Chromium available                                        |
| Browser end-to-end tests    | `pnpm test:e2e`                                                  | PASS   | 2/2 Chromium tests passed                                 |
| Full dependency audit       | `pnpm audit --audit-level high`                                  | PASS   | No known vulnerabilities                                  |
| Production dependency audit | `pnpm audit --prod --audit-level high`                           | PASS   | No known vulnerabilities                                  |
| Generated-code gate         | `grep -qx 'Status: CLOSED' docs/security/GENERATED_CODE_GATE.md` | PASS   | Exact `Status: CLOSED` line present                       |
| Tracked tree review         | `git status --short`                                             | PASS   | Only intended remediation changes present                 |
| Ignored tree review         | `git status --ignored --short`                                   | PASS   | Generated artifacts remained ignored                      |
| Whitespace/error check      | `git diff --check`                                               | PASS   | No errors                                                 |

The 63 tests comprise dashboard-schema 28 (25 schema + 3 gate), river-domain
26 (16 USGS + 4 metrics + 6 dashboard), and web 9, across six files.

## Known deltas and limitations

- The original seven-task river-dashboard foundation plan landed as the single
  squashed foundation commit `41ff309`; this readiness plan landed as the seven
  conventional commits listed above after its pre-task plan commits `4454a5d`
  and `3c06725`.
- The post-`52b7fce` security-review remediation is incorporated in the eighth commit listed above and has passed controller verification.
- `docs/architecture/ADR-001-foundation.md` and
  `docs/architecture/ADR-002-usgs-live-adapter.md` remain `Status: Proposed`.
  ADR-001 changes to Accepted only after merge, which is a controller action.
- ADR-001's repository layout is aspirational. `apps/worker`, `packages/ui`,
  `packages/provenance`, `packages/model-gateway`,
  `packages/sandbox-contract`, and `infra/*` do not exist yet.
- Package-level `lint` scripts run `tsc --noEmit`. Root `pnpm lint` is the only
  ESLint entry point.
