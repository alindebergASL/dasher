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
```

## Safety status

- Fixture mode: enabled.
- Live USGS requests: not implemented in this foundation slice.
- Model calls: disabled.
- Generated-code execution: disabled until the sandbox gate in `docs/security/GENERATED_CODE_GATE.md` is satisfied.
- Production deployment: not performed.

See `docs/product/PRODUCT_REQUIREMENTS.md`, `docs/architecture/ADR-001-foundation.md`, and `docs/plans/2026-07-29-river-dashboard-foundation.md`.
