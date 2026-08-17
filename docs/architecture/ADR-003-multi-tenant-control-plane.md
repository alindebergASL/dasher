# ADR-003: Multi-Tenant Control Plane

Status: Accepted
Date: 2026-07-30
Depends on: ADR-001, ADR-002

## Decision

Dasher will add identity, tenancy, durable storage, ingestion, jobs, model
access, and publication as separately gated control-plane boundaries. The
invite-only pilot is multi-tenant and private-only. No real customer data may
enter Dasher until the identity, organization, authorization, PostgreSQL row
security, tenant-safe storage, immutable-record, revocation, audit, and
operational gates in this ADR pass in their authoritative environments.

This is an accepted target architecture, not a description of the current
fixture-only foundation. The foundation has no identity, tenant database,
uploads, live connector, provider access, durable jobs, or deployment.

The 2026-07-31 product amendment adds a provider-neutral verified-principal
target, optional external IdPs, and first-class durable and disposable
dashboard lifecycles. It does not claim those capabilities exist. ADR-005
defines the proposed agentic harness that uses these control-plane boundaries.

Generated-code execution remains `CLOSED` under
`docs/security/GENERATED_CODE_GATE.md`. Provider-hosted tools, model web
search or code interpreters, parser hooks, arbitrary stdio MCP, and generated
workloads must not create an indirect execution path.

## Trust model

Models, uploaded files, remote responses, connector and MCP metadata, source
text, and generated outputs are untrusted. They may propose data mappings,
classifications, plans, explanations, and a strict `DashboardSpec`; they do
not grant authority.

Authoritative decisions come from server-derived identity and current
membership, PostgreSQL-enforced tenant policy, immutable source and dashboard
records, brokered capabilities, deterministic calculations, and explicit
human approval. Deterministic services compute displayed metrics. A model
cannot publish, alter authorization, retrieve credentials, execute code, or
perform a side effect.

## Required boundaries

### Process and deployment

The target is a modular control plane with separate web/API, ingestion worker,
job worker, model gateway, and, if later enabled, MCP broker and publication
builder identities.

- The web/API process owns invites, sessions, service authorization, and
  tenant-facing APIs. It does not hold provider or connector credentials.
- Isolated parsers receive quarantined input and have no provider secrets,
  tenant-database write authority, or egress.
- The model gateway alone may decrypt model-provider credentials and may
  egress only to exact approved provider endpoints.
- A future MCP broker has a separate credential and egress boundary. The
  model receives capability handles, never credentials.
- A future publication builder has no model, connector, OAuth, or tenant
  database credentials.

Before real customer data, PostgreSQL must be managed or separately backed up
and restore-tested; production processes must not run with migration-owner or
row-security-bypass roles. Before real provider or connector credentials,
services that hold different authorities must use distinct runtime identities,
database roles, secrets, and outbound policies. Public traffic terminates at
the approved edge; application services bind privately.

### Database and tenant authority

Every customer-owned row has a non-null `organization_id`. Cross-row
relationships use composite foreign keys that include the organization, such
as `(organization_id, dashboard_id)`, so an identifier from another tenant
cannot be attached even if it is otherwise valid.

Organizations have organization administrator, editor, and viewer roles.
Server administrators use separate identities and an audited break-glass
path; they are not implicit organization members. Membership and role changes
take effect without waiting for a long-lived token to expire.

Tenant tables use PostgreSQL `ENABLE ROW LEVEL SECURITY`, and deliberately not
`FORCE ROW LEVEL SECURITY`. Runtime roles are `NOBYPASSRLS`; migration
ownership is separate.

> **Corrected 2026-08-17.** This paragraph required `FORCE ROW LEVEL SECURITY`
> and the implementation never had it: all 14 tenant tables are
> `rls=true force=false` in `schema.snapshot.txt`. The code is right and the ADR
> was stale. Forcing row security applies policies to the table's owner as well,
> and every write goes through a `SECURITY DEFINER` seam that runs as that owner
> — so forcing denies the seam the writes it exists to perform, unless the owner
> is superuser or `BYPASSRLS`, which is exactly what this design refuses. The
> migrator rejects a schema that forces it, and `unprivileged-owner` covers the
> ordinary-owner deployment this targets. Enabled-but-not-forced is the
> requirement; the seam, not the policy, is what governs the owner.

Every tenant transaction derives user, organization, role revision, and request
context from the authenticated server session, applies it using server-derived
`SET LOCAL` transaction semantics without string interpolation, and clears it
when the transaction ends. Request bodies, query parameters, model output, and
job payloads cannot select tenant context. Missing or inconsistent context
denies access.

Service-layer authorization remains explicit. Row-level security is the
backstop, not the only policy engine. Workers do not bypass row security to
scan jobs; a narrowly reviewed claim operation returns eligible work, after
which the worker opens a fresh tenant-context transaction.

### Secrets and egress

Credentials are encrypted, tenant-scoped, administrator-managed, versioned,
auditable, revocable, and usable only by the relevant gateway or broker.
Envelope keys remain outside the application database. Decrypted material
exists only in the authorized process memory for the shortest practical
operation and is never placed in job payloads, browser responses, model
context, logs, errors, or generated artifacts.

Every network-capable service has a deny-by-default egress policy. Source,
provider, and future MCP brokers use distinct destination allowlists and
credentials. There is no fallback across organizations, users, credential
owners, residency classes, or billing principals.

## Identity, invitations, and sessions

There is no public signup. An administrator creates an invitation bound to an
organization, normalized email, expiry, and server-owned role ceiling. Invite
tokens have at least 256 bits of randomness; only a keyed hash is stored.
Acceptance is a single conditional transaction, rejects replay and email
mismatch, and takes the role from the stored invitation.

Every successful sign-in must resolve through a provider-neutral boundary to a
stable verified principal and then to current organization authority. The
principal is not an email address. External identity is keyed by issuer and
subject, not email alone.

The target includes a built-in passwordless path, with email magic links as the
proposed default. Email is a verified delivery and invitation/account binding,
not canonical identity; changing an address must not replace the stable
principal. Optional Google Workspace and Microsoft Entra OIDC integrations may
also verify principals. An organization may require an approved IdP, but an
external IdP is not a universal product dependency.

Matching email addresses never automatically merge users, credentials, or
provider identities. Linking requires an explicit, recent-authentication,
policy-allowed operation that proves control of both bindings and atomically
records the actor, principals, providers, outcome, and authority revision in
the audit trail. Unlink and recovery behavior must fail closed and preserve at
least one organization-policy-compliant sign-in path.

This target does not claim local authentication, magic links, OIDC, or identity
linking exists. Immutable migrations `0001_identity_audit.sql` and
`0002_security_boundary.sql` retain their current `(issuer, subject)` identity
contract and are not edited. The current one-external-identity-per-user shape
does not implement the future linking model; any credential-binding or linking
schema is designed first and added only through a separately reviewed,
forward-only migration.

Sessions use opaque, rotated, host-only, `Secure`, `HttpOnly` cookies with an
explicit idle and absolute lifetime. State-changing requests require CSRF
protection. Credential, membership, role, connection, identity-link,
organization-IdP-policy, and any future publication changes require recent or
step-up authentication. Session, membership, invite, identity binding, and IdP
policy revocation must stop subsequent requests and derived work.

## Immutable records

The durable model separates mutable heads and leases from immutable facts:

- A source connection creates immutable source runs and source snapshots.
  Each snapshot records tenant and source identity, retrieval and observation
  times, content hash, storage version, connector/parser version,
  classification, truncation, and validation state.
- Evidence is immutable and identifies the exact snapshot plus source
  coordinates, retrieval/observation time, transformation, and content hash.
  Claims distinguish observed, calculated, interpreted, and recommended
  content.
- A dashboard has insert-only versions containing canonical `DashboardSpec`
  bytes, content hash, parent, source snapshot set, validation results, actor,
  and planner/model provenance. A compare-and-swap head selects the current
  version. Failed work cannot replace the last good version.
- The workspace may contain multiple durable and disposable dashboards.
  Durable dashboards retain version and refresh history plus typed
  changed-since value and provenance. Disposable dashboards have explicit
  expiry, no recurring work by default, access revocation and secure cleanup
  states, and an explicit promotion path that preserves snapshot, evidence,
  version, calculation, and origin lineage. Exact TTLs remain owner-reserved.
- A job has an immutable request, tenant and actor authority revision,
  input hashes, policy revision, and idempotency key. Attempts and lifecycle
  events, including terminal outcomes, are append-only. Only short-lived claim,
  lease, heartbeat, and cancellation coordination is mutable.
- Agentic runs and checkpoints follow the same append-only principle. Their
  durable record covers plans, bounded specialist/reviewer work, tool attempts,
  authorization outcomes, candidates, calculation graphs, validation feedback,
  approvals, model/provider metadata, costs, and terminal outcomes without
  storing credentials. ADR-005 defines the proposed record and state machine.
- Security-sensitive mutations and their append-only audit events commit
  atomically. Application roles cannot update or delete audit entries.

Dashboards render snapshots and versions; they never query mutable external
data at render time. Model proposals must pass strict schema validation,
same-tenant evidence resolution, calculation policy, and current
authorization before becoming a candidate version.

Dashboard expiry, cleanup, promotion, refresh, and run/checkpoint transitions
must be documented and planned before their immutable schema is authored.
Neither an expiring dashboard nor replay may bypass retention, legal hold,
audit, or current authorization policy.

## Object storage and ingress

Object keys and access policy are organization-scoped. Uploads enter a
quarantine namespace through short-lived, operation-specific signed requests.
Downloads use short-lived signed URLs issued only after current
authorization. Promotion to an immutable source namespace occurs only after
the object version, tenant, hash, size, media type, and parser result are
verified. Quarantine cleanup and orphan reconciliation are auditable.

Raw HTTP bodies, direct uploads, provider responses, and connector responses
must be byte-limited while streaming, before object construction,
decompression, workbook expansion, or parsing. Limits include compressed and
expanded bytes, file count, sheet/row/cell count, archive depth, redirects,
and wall-clock time. Existing serialized-object snapshot ceilings and schema
complexity budgets remain defense in depth after early ingress enforcement;
they are not substitutes for it.

CSV/XLSX parsers run in the isolated ingestion boundary. They verify magic
bytes and allowed media types, reject or disable macros, external links,
embedded objects, and formula execution, and neutralize spreadsheet formula
injection in any export. A parse failure leaves no promoted snapshot.

Remote connectors use HTTPS, exact host and method allowlists, public-address
resolution and pinning, redirect revalidation, private/link-local/loopback and
metadata blocking, response limits, timeouts, cancellation, and sanitized
errors. ADR-002 adds the exact restrictions for USGS.

## Jobs, revocation, and races

Jobs use deterministic idempotency keys, bounded leases with heartbeats,
bounded retries, sanitized dead letters, and a transactional outbox. No
database transaction remains open across a network call.

Enqueue-time authority is never sufficient. A worker rechecks the active
user or service, organization membership, role revision, source connection,
credential, schedule, policy, and budget when claiming work; immediately
before each external attempt or retry; after any wait or continuation; and in
the transaction that writes a candidate, cache entry, usage record, or final
state.

The same rule applies to every agentic typed-tool use and result commit. A
capability is narrow, typed, purpose-bound, tenant-bound, revocable, expiring,
and budgeted; it is not a bearer of ambient authority. Human approval is
required before new or broadened authority, a source or connection, a publish
or audience transition, or recurring schedule/cost can be crossed.

Revoking a user, membership, credential, connection, source, or schedule
cancels dependent work. If revocation races with an in-flight external call,
the response is discarded and cannot create a candidate, advance a dashboard
head, populate a reusable cache, or authorize another call. Provider SDK
retries are disabled unless every attempt passes the same checks.

## Publication

The pilot supports private dashboards for explicitly authorized organization
members only. Unlisted and public publication are not pilot features.

Any future enablement requires a separate accepted gate covering
authorization, isolation, revocation, caching, and cookie behavior. Unlisted
access will require revocable, expiring, hashed capabilities and constant
denial behavior. Public output will require a newly built immutable sanitized
bundle, source and sensitivity policy, secret/PII checks, human preview and
approval, and a separate origin with no tenant cookies or control-plane
credentials. Models and workers may never publish.

## Audit and operations

Audit events record organization, actor or service, authority revision,
request/job identifiers, action, target, outcome, content hashes, source,
provider, credential version identifier, usage/cost, and deployment revision.
They exclude secret material and unnecessary prompt or source content. Sealed
copies use independent retention.

Before real customer data, Dasher requires documented retention and deletion
behavior, backup and restore drills, secret rotation, provider and schedule
kill switches, request and spend limits, health and denial alerts, incident
response, deploy/rollback procedures, and evidence that runtime roles cannot
bypass tenant policy.

## Fail-closed invariants

The implementation must deny or preserve the prior good state when:

1. Tenant context, membership, authority revision, policy, or credential
   state is missing, stale, revoked, or ambiguous.
2. A cross-tenant reference, storage key, signed URL, job claim, evidence
   identifier, or cache entry is attempted.
3. Raw ingress or expanded content exceeds a limit, a parser times out, or
   validation cannot complete.
4. A connector destination, redirect, endpoint, provider region/model, or
   MCP manifest is not exactly approved.
5. Model output is invalid, references unavailable evidence, requests a tool,
   or proposes a calculation outside deterministic policy.
6. Audit cannot be written atomically with a security-sensitive mutation.
7. Revocation occurs before commit, including while work is waiting or an
   external call is in flight.
8. The authoritative integration environment or required control is
   unavailable. Mocks cannot substitute for PostgreSQL RLS, object policy,
   OAuth callbacks, or live provider transport at their enablement gates.

## Acceptance gates

| Gate                              | Enables                                                | Required evidence                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation checkpoint             | Continued fixture development                          | Merged foundation schema, fixture pipeline, renderer, Architecture dialog, tests, and CI remain green; generated-code status is exactly `CLOSED`.                                                                                                                                                                                       |
| Identity and tenant policy        | Invitations and durable tenant rows                    | Invite/session/CSRF/role tests; verified-principal and email-binding tests; no-email-linking and explicit-link audit tests when those paths are proposed for enablement; PostgreSQL `FORCE RLS` cross-tenant matrix under restricted roles; composite-FK, forged-context, missing-context, pool-reuse, and mid-flight revocation tests. |
| Immutable persistence and storage | Durable sources, evidence, dashboards, jobs, and audit | Insert-only enforcement; durable refresh and disposable expiry/cleanup/promotion races; complete evidence/version lineage; candidate promotion failure tests; audit atomicity; tenant storage and signed-URL isolation; backup restore; retention and deletion procedure.                                                               |
| Ingestion                         | Controlled USGS and then approved CSV/XLSX data        | Early raw and expanded byte limits; SSRF, redirect, timeout, decompression, malformed-input, macro/link/formula, parser-isolation, quarantine/promotion, and orphan-cleanup tests.                                                                                                                                                      |
| Job authority                     | Manual refresh, then one daily schedule                | Deduplication, leases, retry bounds, failure preservation, payload secret scan, and revocation at claim, wait, pre-call, retry, continuation, and commit.                                                                                                                                                                               |
| Model gateway                     | Standard organization BYOK                             | Fake-provider zero-network/zero-secret proof; endpoint/region/model/credential classification before data leaves; schema and evidence negative tests; transport-level budget block; log secret scan; live capped smoke and kill switch.                                                                                                 |
| Private pilot operations          | Owner pilot go/no-go review                            | All prior gates on the exact deployment, monitoring and incident drill, no unresolved isolation blocker, and explicit owner decisions on real data, terms, cohort, liability, and release.                                                                                                                                              |

Gate evidence must identify the exact revision and environment. Passing a gate
does not imply production readiness or authorize the next owner-reserved
decision.

## Alternatives considered

### Add tenancy after the single-user product proves demand

Rejected. The first durable customer record and credential already create a
tenant boundary; retrofitting it would leave identifiers, jobs, storage, and
audit without enforceable ownership.

### Use service checks without PostgreSQL row-level security

Rejected. Service checks remain necessary, but pooled connections, job paths,
and future code changes require an independent database backstop.

### Put all workers and credentials in one trusted process

Rejected. A hostile upload, connector SDK, or provider response would gain the
combined authority of every tenant and integration.

### Let models calculate and publish directly

Rejected. It makes numerical results nondeterministic and converts untrusted
output into authority. Models propose; deterministic services calculate;
humans control publication.

### Ship unlisted/public access with the private pilot

Rejected. Anonymous access changes the authorization, cache, cookie,
revocation, and data-sanitization boundary and needs a separate decision.

### Require one external IdP for every organization

Rejected. External IdPs are valuable optional policy integrations, but making
one mandatory would prevent a built-in invite-only passwordless path and couple
canonical identity to a provider. Organizations may still require an approved
IdP.

### Link accounts automatically when provider emails match

Rejected. Email reassignment, aliases, provider differences, and unverified
claims make matching unsafe. Linking is an explicit, reauthenticated, audited
operation over verified bindings; email is not canonical identity.

## Consequences

- Meaningful identity, schema, database, storage, and operations work precedes
  real customer-data testing.
- Process and credential separation add deployment complexity but reduce the
  authority held by any compromised component.
- Immutable snapshots, evidence, versions, and job events cost storage but
  make refresh, correction, audit, and rollback inspectable.
- Provider-neutral principals and explicit credential linking add recovery and
  migration work but prevent email or an optional IdP from becoming canonical
  identity.
- First-class disposable dashboards reduce long-lived data only if expiry,
  access revocation, cleanup, retention, and promotion lineage are implemented
  as governed lifecycle transitions.
- The same snapshot-to-`DashboardSpec` path can serve files and live sources
  without source-specific renderer authority.
- Public publication, generated code, broad MCP, and side-effect tools remain
  separate future capabilities rather than pilot shortcuts.
