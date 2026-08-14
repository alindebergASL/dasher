# Dasher

Dasher turns a plain-language monitoring request and ordinary data sources into evidence-backed, multi-page dashboards for managers and leaders.

The first foundation slice is a deterministic Sacramento river-conditions dashboard built from USGS-format fixtures. It establishes the trusted dashboard schema, river metrics, evidence/freshness states, and the plain-language Architecture diagram before model calls or generated-code execution are introduced.

## Local development

Requirements: Node.js 22+ and pnpm 10.14.0. Corepack is optional if pnpm is
already installed directly.

```bash
pnpm install
pnpm --filter @dasher/web exec playwright install chromium
pnpm dev
```

Open `http://localhost:3000`.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm audit --audit-level high
pnpm audit --prod --audit-level high
```

`pnpm test:mutation` runs Stryker against the planner and the river composition
rules: it breaks the code deliberately and requires the tests to notice. Its threshold
is a floor set to the measured score, raised as coverage earns it. See
[mutation testing](docs/process/2026-08-14-mutation-testing.md).

`pnpm test` includes a reachability gate: every workspace package must be an
entry point, reachable from one, or listed in [`reachability.json`](reachability.json)
with a reason and a date. It fails in both directions — on a package nothing
imports, and on a declaration that has stopped being true — so dead weight has
to be declared rather than merely tolerated. Edges come from a text scan rather
than a module graph, so it catches a package nothing points at and does not
prove anything runs; the limits are enumerated in
[`packages/repo-graph`](packages/repo-graph/src/workspace.ts).

The same gates run in [GitHub Actions](.github/workflows/ci.yml). Current
evidence and caveats are recorded in the
[foundation readiness status](docs/status/2026-07-30-foundation-readiness.md)
and [security status](docs/security/2026-07-30-security-status.md).

## Safety status

- Fixture mode: enabled.
- Live USGS requests: not implemented in this foundation slice.
- Identity, multi-tenant persistence, uploads, jobs, provider access, and MCP:
  not implemented.
- Model calls: disabled in the product, and gated rather than merely absent. A
  real provider now exists at `@dasher/planner/anthropic`; nothing in `apps/web`
  imports it, `@anthropic-ai/sdk` is a devDependency rather than a dependency,
  and [a test](apps/web/no-model-calls.test.ts) fails if either stops being
  true. The only caller is
  [the adversarial eval](packages/planner/eval/adversarial.ts), which needs an
  explicit key and model and exits non-zero without them.
- Multi-dashboard lifecycle, passwordless or external-IdP sign-in, and the
  agentic dashboard harness: not implemented.
- Migrations: mutable until the first production deployment. A schema change is
  made by editing `packages/control-plane/migrations/0001_baseline.sql` and
  recreating the development database. See
  [the restructure proposal](docs/review/2026-08-13-restructure-proposal.md).
- Generated-code execution: disabled until the sandbox gate in `docs/security/GENERATED_CODE_GATE.md` is satisfied.
- Pilot publication: private-only by accepted design; no publication system is
  implemented.
- Production deployment: not performed.

## Architecture and roadmap

- [ADR-001: Foundation architecture](docs/architecture/ADR-001-foundation.md)
- [ADR-002: USGS live adapter boundary](docs/architecture/ADR-002-usgs-live-adapter.md)
- [ADR-003: Multi-tenant control plane](docs/architecture/ADR-003-multi-tenant-control-plane.md)
- [ADR-004: Provider, OAuth, and MCP boundaries](docs/architecture/ADR-004-provider-oauth-mcp-boundaries.md)
- [ADR-005: Agentic dashboard harness](docs/architecture/ADR-005-agentic-dashboard-harness.md)
- [ADR-006: Schema freeze point and immutability tiers](docs/architecture/ADR-006-schema-freeze-point.md)
  (proposed; not accepted)
- [Requirements Amendment 01](docs/product/2026-08-12-requirements-amendment-01.md)
  (proposed; not accepted)
- [How Dasher drifted](docs/review/2026-08-12-drift-analysis.md) (advisory
  root-cause analysis)
- [Working practice](docs/process/2026-08-12-working-practice.md) (advisory
  recommendations)
- [Removal register](docs/process/2026-08-12-removal-register.md) (advisory
  deletion candidates; no gate outcome)
- [Restructure proposal](docs/review/2026-08-13-restructure-proposal.md)
  (proposed; steps 1-3 applied)
- [Baseline squash status](docs/status/2026-08-13-baseline-squash.md)
- [Forward plan](docs/roadmap/2026-08-13-forward-plan.md): why Task 9E should
  not be built, and the route to a pilot (proposed; not accepted)
- [Private pilot execution roadmap](docs/roadmap/2026-07-30-private-pilot-roadmap.md)
- [Project and process efficiency review](docs/review/2026-08-12-project-efficiency-review.md)
  (advisory; no gate outcome) and its
  [proposed re-sequencing](docs/roadmap/2026-08-12-proposed-resequencing.md)
  (proposed; not accepted)
- [Executive Brief owner-accepted synthetic validation](docs/validation/2026-07-30-executive-brief-gate.md)
- [Six-agent Executive Brief rehearsal](docs/validation/2026-07-30-six-agent-executive-brief-rehearsal.md)

ADR-001 records the implemented, reviewed fixture foundation. Accepted ADR-002,
ADR-003, and ADR-004 and the roadmap define gated future work. An accepted
decision does not mean those systems are implemented or that Dasher is
production- or pilot-ready. Gate 1 was accepted by explicit owner decision from
a six-agent synthetic rehearsal. The six model IDs are distinct, but provider
diversity is not six-way: four are Claude-family models and two are OpenAI models
run through Codex. No human sessions occurred, the agents are not represented as
human equivalents, and no 30-second human-usability claim is made. Later
security, real-data, manager-user, and protected-release gates remain independent.

Proposed ADR-005 records the owner-approved direction and gates for a
multi-dashboard workspace and governed, non-template-bound agentic harness. Its
proposed status does not claim implementation or authorize a later gate.

See also the [product requirements](docs/product/PRODUCT_REQUIREMENTS.md) and
[foundation implementation plan](docs/plans/2026-07-29-river-dashboard-foundation.md).
