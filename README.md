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

The same gates run in [GitHub Actions](.github/workflows/ci.yml). Current
evidence and caveats are recorded in the
[foundation readiness status](docs/status/2026-07-30-foundation-readiness.md)
and [security status](docs/security/2026-07-30-security-status.md).

## Safety status

- Fixture mode: enabled.
- Live USGS requests: not implemented in this foundation slice.
- Identity, multi-tenant persistence, uploads, jobs, provider access, and MCP:
  not implemented.
- Model calls: disabled.
- Generated-code execution: disabled until the sandbox gate in `docs/security/GENERATED_CODE_GATE.md` is satisfied.
- Pilot publication: private-only by accepted design; no publication system is
  implemented.
- Production deployment: not performed.

## Architecture and roadmap

- [ADR-001: Foundation architecture](docs/architecture/ADR-001-foundation.md)
- [ADR-002: USGS live adapter boundary](docs/architecture/ADR-002-usgs-live-adapter.md)
- [ADR-003: Multi-tenant control plane](docs/architecture/ADR-003-multi-tenant-control-plane.md)
- [ADR-004: Provider, OAuth, and MCP boundaries](docs/architecture/ADR-004-provider-oauth-mcp-boundaries.md)
- [Private pilot execution roadmap](docs/roadmap/2026-07-30-private-pilot-roadmap.md)

ADR-001 records the implemented, reviewed fixture foundation. ADR-002 remains
proposed; accepted ADR-003 and ADR-004 and the roadmap define gated future
work. An accepted decision does not mean those systems are implemented or that
Dasher is production- or pilot-ready.

See also the [product requirements](docs/product/PRODUCT_REQUIREMENTS.md) and
[foundation implementation plan](docs/plans/2026-07-29-river-dashboard-foundation.md).
