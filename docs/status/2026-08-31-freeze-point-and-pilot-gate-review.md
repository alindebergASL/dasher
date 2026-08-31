# Freeze Point declaration and owner-pilot gate review

Status: Recorded at owner direction, 2026-08-31
Declares: the [ADR-006](../architecture/ADR-006-schema-freeze-point.md) Freeze
Point
Reviews: the [ADR-003](../architecture/ADR-003-multi-tenant-control-plane.md)
acceptance gates against the first deployment
Revision reviewed: PR #58 head (`64b7ed8` plus the documentation-reconciliation
commits merged with it)

## The Freeze Point

The Freeze Point takes effect at the first `luckbutton.com` deployment that
holds real data — the cutover described in `deploy/cutover.md`, expected within
a day of this record. From that moment:

- Migrations `0001_baseline.sql` through `0004_sign_in_rate_limit_lock.sql` are
  byte-frozen and forward-only. Corrections happen only by successor migration.
- The one-time squash window ADR-006 opened is closed. It was used once, on
  2026-08-13, and does not return.

Until the cutover actually runs, the window is technically still open; nobody
should spend it. If the cutover is abandoned rather than merely delayed, this
declaration lapses with it and must be re-made for whatever replaces it.

## Why deploying does not violate ADR-003

ADR-003 forbids real CUSTOMER data before its gates pass in their authoritative
environments. The 2026-08-31 amendment to that ADR records the distinction this
review applies: the first deployment carries the owner's own organization and
the owner's own data — data the owner answers for, not data someone else
entrusted. Several gates demand evidence that only exists against a real
deployment (backup restore on the instance, revocation against the deployed
database, monitoring against real traffic); the owner-only deployment is how
that evidence gets produced.

**The hard line unchanged by this review:** no second organization, and no
person beyond the owner, until the preconditions at the bottom of this document
are met.

## Gate-by-gate status at this revision

**Foundation checkpoint — passing.** CI green on `main`; generated-code gate
exactly `CLOSED` and enforced by test.

**Identity and tenant policy — largely evidenced, one substitution.** Sign-in,
session, CSRF/same-origin, cross-tenant RLS matrix, composite-FK, forged- and
missing-context, and mid-flight revocation are all covered by the PostgreSQL
integration suites (175 tests at this revision), including the concurrent
rate-limit proof added in migration 0004. The substitution: ADR-003 describes
administrator-created INVITATIONS; what exists is operator provisioning via the
`provision` CLI plus magic-link sign-in. For an owner-only pilot the operator
and the sole member are the same person, so the invitation path is waived until
a second member exists — at which point it is required, not optional.

**Immutable persistence and storage — evidenced in the database, narrower than
the ADR's full shape.** Insert-only enforcement, audit atomicity,
evidence/version lineage, and snapshot immutability are proven by integration
tests. Uploaded files are stored as immutable `source_snapshots` rows in
PostgreSQL; the object-storage quarantine/signed-URL machinery the ADR
describes is not built and not needed until uploads leave the database. Backup
restore has been rehearsed under local Docker only; the on-instance
backup→S3→restore→restore-check proof is a deploy-day step in
`deploy/cutover.md` and `deploy/README.md`, and this gate is not called passed
until it has run there.

**Ingestion — partially evidenced, scope honest.** CSV upload is byte-limited
and parsed defensively with tests; XLSX does not exist. Live connectors run
fixture-mode by default (`DASHER_SOURCE_MODE=fixture`), so the connector
restrictions are latent rather than load-bearing at this deployment.

**Job authority — not applicable.** No jobs, schedules, or workers exist.
Nothing to gate; nothing enabled.

**Model gateway — not applicable, and gated absent.** No model calls exist in
the product; `no-model-calls.test.ts` fails the build if `apps/web` grows a
provider import. The gate runs when ADR-005's planner work begins.

**Private pilot operations — this document is the owner review.** Explicitly
waived for the owner-only phase, and owed before anyone else:

- monitoring, alerting, and an incident drill (there is deliberately no logging
  yet);
- documented retention and deletion behaviour;
- secret rotation procedure;
- the on-instance restore drill (deploy-day step; becomes a standing drill).

## Preconditions for inviting anyone beyond the owner

1. Every waiver above closed, with evidence against the deployed environment.
2. The invitation path built and tested, replacing operator-only provisioning.
3. The legal review that the
   [2026-08-26 A5 decision](../product/2026-08-26-a5-alerting-decision.md)
   deferred — it is recorded there as a blocker for a real pilot user, and it
   still is.
4. An explicit owner go/no-go recorded in `docs/status/`, per ADR-003's final
   gate.
