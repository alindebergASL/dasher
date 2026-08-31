# ADR-006: Schema Freeze Point and Immutability Tiers

Status: Accepted by owner direction, 2026-08-31 — and largely executed on
2026-08-13; see Execution record below
Date: 2026-08-12
Depends on: ADR-003
Amends: ADR-003 migration-immutability language, ADR-005 first-migration-completeness rule

## Context

Three different mechanisms in this project are all called "immutable," and
conflating them has cost more than any of them individually is worth.

**Record immutability.** Audit events, evidence records, dashboard versions, and
source snapshots are insert-only, enforced by trigger and ACL. A committed fact
cannot be rewritten.

**Schema immutability.** Migration files are byte-frozen and forward-only.
`0001`–`0008` can never be edited, and a mistake can only be corrected by adding
another migration.

**Verification-manifest immutability.** The expected catalog is hand-authored in
`migrator.ts` and its fixtures, pinned by SHA-256, and a test forbids deriving it
programmatically.

Only the first is a product property. The other two are development-process
rules, and both were adopted before there was anything to protect.

### The rule preceded the schema

ADR-003 was accepted on **2026-07-30** and states that migrations "are not
edited." The first migration, `0001_identity_audit.sql`, landed on
**2026-07-31**. The immutability rule was therefore written one day before the
first schema existed, for a database that has still never been deployed:
`README.md:50` records "Production deployment: not performed," and the
2026-08-04 status baseline records that "the merged lifecycle source is not
deployed."

Migration immutability exists to protect environments that have already run a
migration, because rewriting history would leave deployed databases in a state no
file describes. With zero deployments, it protects nothing and costs everything.

### What it has cost

- ADR-005 requires that lifecycle rules "must exist in the first dashboard
  migration; they cannot be deferred behind a minimal dashboard row." Because the
  first migration had to be complete, `0003_immutable_content.sql` is 5,868 lines.
- Three of eight migrations exist only to correct earlier ones. `0008` corrects
  `0006`, which was itself a correction.
- The hand-authored manifest costs roughly 900 lines of TypeScript for a 20-line
  SQL change, measured at 47× on migration `0005`.
- On **2026-08-12** the owner decided to remove disposable dashboards entirely.
  That feature's schema — `current_kind`, expiry, promotion, quarantine, purge,
  finalizers, retention claims, holds, tombstone lineage — is permanent, because
  it was frozen before the product question was tested.

The last item is the decisive one. The rule did not prevent a mistake; it
preserved one.

## Decision

Replace one undifferentiated notion of immutability with three tiers, each
beginning when the property it protects becomes real.

### Tier 1 — Record immutability. Always, unconditionally.

Unchanged from ADR-003. Audit events, evidence records, dashboard versions, and
source snapshots remain insert-only, enforced in the database. Security-sensitive
mutations still commit atomically with their audit event. Compare-and-swap still
governs head promotion.

This is the tier that carries enterprise weight, and nothing here relaxes it.

### Tier 2 — Schema immutability. Begins at the Freeze Point.

The **Freeze Point** is the first deployment of the schema into an environment
that may hold real or customer-supplied data.

Before the Freeze Point, migrations are a design artifact. They may be squashed,
rewritten, renumbered, or deleted, provided the resulting baseline passes the
full adversarial PostgreSQL gate.

From the Freeze Point onward, ADR-003's current rules apply in full and without
exception: forward-only, byte-frozen, checksum-pinned, no edits, corrections only
by successor migration.

The Freeze Point is declared once by the owner and recorded in `docs/status/`.
It is not reached by elapsed time, by a passing gate, or by merging to `main`.

### Tier 3 — Verification manifests. Never hand-authored.

The expected catalog and checksum manifest are generated from `migrations/*.sql`,
committed, and verified by regenerating and comparing. Drift between the
committed manifest and the live database is rejected exactly as today.

This retires the `forbiddenInference` guard at
`canonical-migrations.test.ts:3386`, which currently forbids exactly this. The
trade is stated plainly in the re-sequencing proposal's P1: independent human
authorship is exchanged for a single reviewable source. This ADR takes the trade
because the guard's cost is now measured and its benefit has never caught a
defect that the catalog comparison would have missed.

## Enterprise readiness is unaffected

The owner's direction is that Dasher must be enterprise ready. That direction is
not in tension with this ADR, because enterprise readiness is a claim about
production behaviour and evidence, not about development history.

What enterprise buyers and auditors actually require:

| Requirement                  | Provided by                                                   | Affected by this ADR |
| ---------------------------- | ------------------------------------------------------------- | -------------------- |
| Tenant isolation             | RLS (enabled, seam-governed), composite FKs, restricted roles | no                   |
| Immutable audit trail        | Tier 1, enforced in the database                              | no                   |
| Change control               | forward-only migrations after the Freeze Point                | no                   |
| Data deletion and retention  | behaviour at deletion time, in production                     | no                   |
| Backup and restore           | operational drills against a deployment                       | no                   |
| Access review and revocation | membership, session, and credential revocation                | no                   |

A SOC 2 or ISO audit examines controls operating over an audit period that begins
at or after production launch. No auditor examines migration files authored
before the product existed, and none requires that a pre-launch schema was never
squashed. Change control begins at the Freeze Point by construction, which is
precisely what Tier 2 formalises.

Squashing a pre-production schema is ordinary practice; Rails, Django, and Prisma
all provide it for this reason. What would genuinely weaken enterprise posture is
relaxing Tier 1, and this ADR does not.

## Consequences

**A squash becomes available, once.** Before the Freeze Point, `0001`–`0008` may
be collapsed into a single reviewed baseline reflecting current decisions. That
baseline would omit disposable dashboards and everything that exists only to
serve them. This is the only mechanism by which the 2026-08-12 decision can
actually remove that machinery rather than carrying it permanently.

**The window narrows.** Every migration added before the Freeze Point is one more
thing the baseline must carry or drop. Task 9's `0007` and `0008` are already
30,614 lines. Deciding this before Task 9F is materially cheaper than after,
which is the same decision point as the dual-evaluator question in P2.

**Superseded migration files are archived, not deleted.** They move to
`packages/control-plane/migrations/archive/`, unreferenced by the migrator,
preserving provenance and review history.

**The baseline needs one careful review.** It is a new artifact and the
adversarial PostgreSQL gate must pass against it in full. That review is real
work, and it is smaller than the review cost already being paid per correction.

**Nothing about Tier 1 changes**, so no test asserting record immutability,
audit atomicity, RLS denial, or compare-and-swap behaviour is weakened.

## Alternatives considered

### Keep the current rule unchanged

Rejected. It sounds safest and is not. It has already preserved a feature the
owner has decided to remove, and it will preserve every future mistake made
before launch with equal fidelity. The cost is unbounded and the benefit — before
any deployment — is zero.

### Squash later, after the Freeze Point

Rejected because it is impossible. After a deployment holds real data, rewriting
migration history breaks the correspondence between the deployed database and the
files describing it. The opportunity exists now and does not return.

### Allow edits to existing migrations at any time

Rejected. Once a deployment exists, editing an applied migration is exactly the
failure mode ADR-003 was right to prevent. The Freeze Point keeps that protection
and only moves when it starts.

### Keep hand-authored manifests, squash only the schema

Rejected as a partial measure. A squash makes the manifest problem worse, not
better: one baseline would require one enormous hand-authored catalog. Tier 3 is
what makes Tier 2 affordable.

### Relax record immutability to simplify retention

Rejected. Tier 1 is the property customers and auditors actually rely on, and it
is the cheapest of the three to maintain because the database enforces it.

## Adoption

Accepted by owner direction on 2026-08-31. The Freeze Point is declared
separately, as this ADR requires — see
[the 2026-08-31 declaration](../status/2026-08-31-freeze-point-and-pilot-gate-review.md):
it takes effect at the first `luckbutton.com` deployment that holds real data.

## Execution record (2026-08-31)

Reality moved ahead of this document's status line, and the record should say
so plainly rather than leave an accepted ADR describing work as future that was
finished weeks earlier.

- **The squash was performed on 2026-08-13** —
  [baseline squash](../status/2026-08-13-baseline-squash.md). Twelve migrations
  became `0001_baseline.sql`; the baseline deliberately omits the
  disposable-dashboard machinery, which is what lets Amendment 01 A3 actually
  hold. The adversarial PostgreSQL gate passes against the baseline series on
  every CI run since.
- **One consequence was executed differently than written.** This ADR said
  superseded files move to `migrations/archive/`; they were briefly kept there
  and then deleted on 2026-08-14, with retrieval documented via git history in
  the squash record. That deviation is endorsed: an unreferenced 56,913-line
  copy beside the live migration is the exact artifact this ADR exists to
  eliminate, and git history preserves provenance at zero carrying cost.
- **Tier 3 holds in spirit through a different artifact.** The hand-authored
  manifest was removed with the squash; schema equality is now proven by
  `schema.snapshot.txt`, generated by `renderSchemaSnapshot` against a freshly
  migrated database and diffed on every integration run. Nothing is
  hand-authored twice.
- **The migration series at acceptance is `0001`–`0004`** (`0002_sign_in`,
  `0003_session_revocation`, `0004_sign_in_rate_limit_lock` landed after the
  squash). These are the files the Freeze Point freezes.
