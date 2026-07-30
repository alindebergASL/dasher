# ADR-001: Dasher Foundation Architecture

Status: Accepted
Date: 2026-07-29

## Decision

Build Dasher as a TypeScript monorepo with a Next.js web application, a separately deployable job worker, PostgreSQL for durable multi-tenant state, S3-compatible object storage for uploads/artifacts, and a queue abstraction backed by PostgreSQL initially. Use a versioned declarative `DashboardSpec` as the trusted rendering contract. Treat generated code as an optional untrusted extension executed only in an isolated sandbox service.

The first checked-in vertical slice is deterministic: a USGS fixture/live-adapter seam produces a versioned river-domain snapshot, the dashboard planner maps that snapshot to a multi-page `DashboardSpec`, and the renderer displays it. AI generation is introduced behind an adapter after the deterministic contract, provenance, and safety gates are tested.

## Why

Dasher must feel generative while remaining inspectable, testable, and safe. A declarative specification gives the product stable rendering, migrations, accessibility, export, architecture visualization, and provenance. A separate code sandbox preserves the user's requested flexibility without making the application process an arbitrary-code host.

## System boundaries

```text
Browser
  -> Next.js web/API (identity, tenant authorization, dashboard reads)
      -> PostgreSQL (organizations, dashboards, versions, sources, evidence, jobs)
      -> S3-compatible storage (uploads, normalized datasets, generated artifacts)
      -> Job queue
          -> Worker (connectors, normalization, metrics, planner, refresh)
              -> approved external sources (USGS first)
              -> model gateway (tenant-scoped approved provider connection)
              -> sandbox broker (generated-code jobs only)
                  -> isolated disposable runtime (no ambient secrets or network)
```

## Initial deployment shape

For the invite-only pilot, web and worker may run on the same EC2 host as separate processes, while preserving their logical and credential boundaries. PostgreSQL may start on the host only for development; the production pilot should use a managed or separately backed-up PostgreSQL service before storing real customer data. Generated-code execution is disabled until the sandbox service and its tests exist.

Public traffic terminates at nginx on ports 80/443. App processes bind to loopback. `luckbutton.com` resolves to the authorized EC2 host.

## Repository layout

```text
apps/
  web/                 Next.js UI and HTTP API
  worker/              scheduled/manual refresh jobs
packages/
  dashboard-schema/    versioned DashboardSpec and validators
  river-domain/        USGS types, normalization, metrics, freshness
  provenance/          evidence and claim contracts
  model-gateway/       provider-neutral model adapter and policy
  sandbox-contract/    code job input/output/capability contracts
  ui/                  reusable dashboard components
docs/
  architecture/
  plans/
  product/
fixtures/
  usgs/
infra/
  nginx/
  systemd-or-pm2/
```

## Core contracts

### DashboardSpec

A dashboard has metadata, audience, pages, components, filters, data bindings, calculations, actions, provenance references, freshness, and an architecture model. Components are selected from a reviewed registry. Unknown component kinds fail closed.

### Dashboard version

Published dashboards are immutable versions. Refresh creates a candidate version, validates it, and atomically promotes it. A failed refresh leaves the prior good version active.

### Evidence

Every source-derived claim can reference one or more evidence records containing source URL or file identity, retrieved/observed timestamp, excerpt or data coordinates, and confidence. The UI distinguishes observed, calculated, interpreted, and recommended content.

### Architecture model

The architecture dialog is generated from the same source, transformation, calculation, component, refresh, and output metadata used by the dashboard. It is not a hand-written diagram that can drift. The default presentation uses plain-language nodes and arrows; a technical details disclosure exposes connector names, refresh IDs, code hashes, and validation status.

## Multi-tenancy and authorization

Every durable customer-owned row carries `organization_id`. Authorization is checked at the API/service boundary and reinforced with PostgreSQL row-level security before real pilot data is accepted. Object-storage keys are organization-scoped, and signed download URLs are short-lived. Background jobs carry an immutable organization and actor context.

Roles: server administrator, organization administrator, editor, viewer. MCP installation, model credentials, and publication policy are administrator operations.

## Generated-code policy

Generated code cannot be enabled merely by adding `eval`, `Function`, a subprocess call, or a permissive iframe. The extension path requires:

1. A content-addressed input bundle.
2. A declared capability manifest.
3. Static policy checks.
4. A disposable sandbox runtime with a read-only root, non-root user, seccomp/AppArmor or equivalent isolation, no host socket, no cloud metadata, and deny-by-default egress.
5. Resource/time/output limits.
6. A narrow JSON/artifact output contract.
7. Malware/content checks on outputs.
8. Complete audit records.
9. Publish-time approval.

Until that exists, models may propose only a strict `DashboardSpec`;
deterministic reviewed services compute metrics.

## Source and network safety

Connectors fetch through a broker that validates URL scheme/host, resolves and pins public addresses, blocks loopback/private/link-local/metadata networks, limits redirects and response size, enforces timeouts, and records the final URL. Any future MCP server is administrator-approved and exposed to users only as a named, capability-limited connection under ADR-004.

## Model gateway

The model gateway accepts a policy-scoped request, resolves an approved
tenant-scoped provider connection, redacts logs, enforces budget/rate limits,
and records model/provider metadata without storing secrets. It never falls
back across organizations, credential owners, billing principals, regions, or
retention policies. Model output is untrusted and must validate against the
versioned schema. No model can directly publish, execute code, install MCP, or
retrieve credentials.

## Publication

The pilot is private-only. Unlisted and public publication are future
capabilities requiring the separate authorization, isolation, revocation,
cache, cookie, redaction, and human-approval gate defined by ADR-003.

## Refresh

Manual refresh and one daily schedule are supported first. Jobs are deduplicated, observable, retry-bounded, and cancellation-aware. Candidate outputs pass schema, provenance, freshness, and publication-policy checks before promotion.

## Alternatives considered

### Let the model emit arbitrary React and run it in the web app

Rejected. It gives fast demos but combines untrusted code with tenant credentials, browser origin authority, and application availability.

### Use only a fixed component library forever

Rejected. It is safer but does not satisfy the requested creativity. The selected design uses a safe component/spec path plus an isolated extension path.

### Start with microservices for every connector

Rejected for the MVP. Logical package and process boundaries are enough initially; deployment can split when scale or risk requires it.

### Use SQLite for the pilot

Rejected as the durable target because multi-tenant authorization, jobs, and row-level controls are foundational. Deterministic unit tests may use in-memory substitutes, but production contracts target PostgreSQL.

## Consequences

- More up-front schema and provenance work than a prompt-to-React prototype.
- Faster reliable iteration after the contract stabilizes.
- Safe generated code is a separate milestone, not a shortcut.
- Architecture diagrams can remain accurate because they derive from executable metadata.
- The first demo can be useful before model credentials or a sandbox are present.

## Acceptance record

Accepted after foundation PR #1 merged into `main` at
`4949591dbb032b9c8d5fbfbc48ba2cd3557cca59`. The schema, fixture pipeline,
renderer, Architecture dialog, and tests passed independent exact-head reviews
and GitHub CI. This acceptance records the reviewed foundation decision; it
does not claim production or pilot readiness.
