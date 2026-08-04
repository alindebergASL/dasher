# Lifecycle Foundation and Task 9 Planning Baseline

Date: 2026-08-04
Status: Merged lifecycle foundation; Task 9 planning only

## Exact merged baseline

This checkpoint binds the next planning slice to exact `main` commit
`1aab2a0012a1f577046e30c333a50ca02fe37725`, tree
`34e71e18294f64502f709b440fb11dd6f2103f3f`.

The merged migration journal is exactly:

| Sequence | Filename                                               | SHA-256                                                            |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `0001`   | `0001_identity_audit.sql`                              | `d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a` |
| `0002`   | `0002_security_boundary.sql`                           | `395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9` |
| `0003`   | `0003_immutable_content.sql`                           | `270ba6f5b8756425835ebb0df0ea8f8c4739b81202d2b4f2b48172a016db9c40` |
| `0004`   | `0004_lifecycle_api_correction.sql`                    | `353021e04bd32183cba82e0069948d43fecf27f4b5ec9995bfb143419279e5d9` |
| `0005`   | `0005_security_definer_cleanup_coordination.sql`       | `f9e33e7a4033d77c1e56f098de68a519f2cfe434119c3bf5ffe13b8a3f9713e7` |
| `0006`   | `0006_lifecycle_access_retention_guard_correction.sql` | `26a6075696c5aba6562a87f63564860e49b22cdbc1c8015335e19006044bd499` |

These six files are immutable history. Future additive migration work starts at
`0007`; historical references to agent-ledger work as `0004+` or a synthetic
trust/run gate as `0004` describe sequencing, not an available migration number.

## Completed lifecycle slice

- PR #14 added the fenced dashboard lifecycle repository and fixed projections;
  it was squash-merged as `ee170e24cf196a2b765d566c7d8a92086f33470e`.
- PR #15 corrected inclusive expiry, retention-trigger dispatch, one-column purge
  authority, and forced-RLS cleanup visibility; it was squash-merged as
  `1aab2a0012a1f577046e30c333a50ca02fe37725`.
- Exact-main CI run
  [30931923358](https://github.com/alindebergASL/dasher/actions/runs/30931923358)
  passed both `verify` and `postgres` on that exact commit.
- The merged lifecycle source is not deployed. No historical-data inventory or
  remediation has been run against a deployable environment.

## Current product and repository truth

Implemented and merged:

- invitation, session, membership, organization, and restricted transaction
  context foundations;
- PostgreSQL forced-RLS lifecycle schema, immutable snapshots/evidence/versions,
  retention claims/finalizers, lifecycle events, promotion, cleanup, legal hold,
  tombstone, and restore lineage;
- a strict lifecycle repository with fixed database functions and bounded
  projections; and
- authoritative PostgreSQL migration/catalog/ACL/RLS/race/rollback coverage.

Not implemented or enabled:

- an agent-run event ledger, run checkpoints/projections, worker leases, or run
  budget accounting;
- a typed calculation engine, primitive registry, MetricContractVersion,
  Claim/ClaimEvidence, or immutable candidate evidence manifest;
- a model gateway, fake-provider package, replay runner, typed-tool broker, or
  provider credential path;
- application routes or UI backed by the lifecycle repository;
- a job worker, model worker, object-storage integration, live source, upload,
  schedule, publication, or customer-data path; and
- any deployment of the merged lifecycle slice.

The web application remains a deterministic fixture surface. Generated-code
execution remains exactly `Status: CLOSED`.

## Task 9 planning boundary

The next bounded plan is
`docs/plans/2026-08-04-agent-run-ledger-and-deterministic-calculations.md`.
It may plan additive migration `0007`, repositories, deterministic calculation
contracts, a zero-network fake provider, and content-addressed replay. The plan
itself implements none of them.

The planning PR must not:

- change source, tests, packages, CI, lockfiles, or migrations;
- edit migrations `0001`–`0006` or imply that a reviewed plan authorizes `0007`;
- enable a live provider, credential, network, customer-data, tool, route, UI,
  worker, schedule, publication, generated-code, merge, or deployment path; or
- claim that fake-provider/replay evidence satisfies a live-provider, real-user,
  protected-release, or Gate 2 completion gate.

## Gate and deployment status

Gate 2 remains `PARTIAL — NOT PASSED`. Merged lifecycle source does not establish
application integration, storage/jobs, backup/restore, kill switches, incident
controls, deployment, or release evidence.

Before any deployment into an environment that could contain historically
affected lifecycle rows, require either:

1. a target-specific zero-inconsistency inventory for `cleaned` dashboards and
   surviving source/evidence/finalizer state; or
2. a separately planned, reviewed, bounded remediation.

Planning or implementing Task 9 does not waive that deployment prerequisite.
