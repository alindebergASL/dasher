# Baseline Squash

Status: Applied — verified against PostgreSQL 16
Date: 2026-08-13
Implements: steps 1–3 of the
[restructure proposal](../review/2026-08-13-restructure-proposal.md)
Owner direction: nothing exempt from review; no contract or constraint preserved
for its own sake; pre-production strictness not justified by production
standards.

## What changed

Twelve migrations collapsed to one mutable baseline, and the hand-authored
catalog manifest that existed to prove those migrations were removed.

| Measure                      | Before  | After                |
| ---------------------------- | ------- | -------------------- |
| Repository (TS/TSX/SQL/CSS)  | 227,199 | 40,278               |
| `packages/control-plane`     | 201,071 | 11,915               |
| Migration files              | 12      | 1                    |
| Migration SQL                | 56,913  | 1,046                |
| Tables                       | 62      | 14                   |
| Manifest apparatus           | 58,996  | 0                    |
| Schema-equality artifact     | typed   | generated, 475 lines |
| `migrator.ts`                | 24,416  | 424                  |
| PostgreSQL integration suite | 32,178  | 476                  |

Net: **2,935 insertions, 134,688 deletions** across 38 files. The superseded
migrations are retained unreferenced under `packages/control-plane/migrations-archive/`.

## Migrations are mutable until first production deploy

The rule this replaces was adopted in ADR-003 on 2026-07-30, one day before the
first migration was written, for a database that has never existed. It produced
seven corrections out of twelve files — 38.7% of all migration SQL — including
`0012` at 11,839 lines, which re-emitted twenty-two function bodies in order to
change function attributes.

A schema change is now made by editing `migrations/0001_baseline.sql` and
recreating the development database. The migrator still refuses to run when an
already-applied file has changed; it reports the drift and names the fix rather
than silently diverging. At the first production deployment the series becomes
forward-only and append-only again, and the baseline becomes immutable.

## Schema equality is generated, not typed

The manifest was a second copy of the schema, hand-typed, edited in lockstep with
every migration, whose only job was to be compared against the first copy.

`renderSchemaSnapshot` replaces it: it reads `pg_catalog` and renders columns,
constraints, indexes, row-security flags, policies, triggers, function
attributes, grants, and managed-role attributes as ordered text.
`schema.snapshot.txt` is committed and compared against a freshly migrated
database on every PostgreSQL CI run. Regenerate with `UPDATE_SCHEMA_SNAPSHOT=1`.

It reads the catalog rather than shelling out to `pg_dump` because the
generated-code gate forbids execution sinks in first-party source. That gate
caught the first attempt, which used `child_process`. It was left unchanged and
the code was changed instead.

## Kept

Row-level security is forced on every tenant table but one, composite
`(organization_id, …)` foreign keys prevent a child row from referencing a parent
in another organization, `dasher_app` is `NOBYPASSRLS`, and audit events,
dashboard versions, claims, and claim evidence reject `UPDATE` and `DELETE`.

Identity, sessions, invitations, the secret key ring, and email normalization are
unchanged — 285 tests still pass against them.

## Dropped

Disposable-dashboard lifecycle (expiry, promotion, quarantine, purge, tombstones,
restore lineage, legal holds, retention policy); deletion finalizers and
reference-claim tables; the agent-run ledger's leases, epochs, budgets, meters,
checkpoints, and content-addressed replay; the PL/pgSQL calculation evaluator;
and the multi-role `SECURITY DEFINER` apparatus.

`dashboards` lost fourteen columns serving the cut lifecycle. `agent_runs` went
from thirty-plus columns to thirteen. The agent-run ledger went from sixteen
tables to one.

## The one place SECURITY DEFINER survived, and why

`dasher_private.context_allows` is `SECURITY DEFINER`, and `dasher.memberships`
enables row-level security without `FORCE`. Both facts serve one purpose: every
policy calls that function, and the function reads memberships, so if that read
were itself subject to the memberships policy the evaluation would recurse.

This was not designed in. The property suite found it — `stack depth limit
exceeded` on the first attempt to read a dashboard as a tenant. That is precisely
the class of defect a catalog manifest cannot find, because the manifest and the
migration agree perfectly while the schema does not work.

## Verification

| Gate                | Result                                 |
| ------------------- | -------------------------------------- |
| `pnpm format:check` | pass                                   |
| `pnpm lint`         | pass                                   |
| `pnpm typecheck`    | pass, all six packages                 |
| `pnpm test`         | 697 passed                             |
| `pnpm build`        | pass                                   |
| `pnpm test:e2e`     | 6 passed                               |
| `test:postgres`     | **26 passed against PostgreSQL 16.13** |

The PostgreSQL suite was run against a real server from a freshly created
database, not a mock. It asserts properties rather than catalog shape:

- no rows without a request context, and none for an organization the acting
  user does not belong to
- another organization's row is unreachable even when named by primary key
- a revoked membership stops reading immediately
- a viewer cannot read the audit log
- the application role cannot read `dasher_meta`
- a version cannot reference a dashboard in another organization
- a claim cannot cite evidence from another organization
- published versions, claims, claim evidence, and audit events reject rewrite
- draft/active/archived and agent-run terminal invariants hold

## What this does not do

No product surface changed. `apps/web` still imports only `dashboard-schema`,
`river-domain`, and `planner`, and no database code is yet reachable from a
browser — that is step 5 of the proposal, the persistence slice.

`@dasher/calculation-engine` is now imported by nothing at all: its only importer
was the integration test that cross-checked the deleted PL/pgSQL evaluator.
Wiring it into `planner` is step 4 and is the next visible change.

ADR-003 and ADR-006 still describe the superseded immutability rule. They need
dated amendment pointers; this document is the record until they get them.
