# Superseded migration series

These twelve files were the migration series through 2026-08-12. They are
retained for provenance and are **not referenced by any code**: the migrator
reads `migrations/` only, and nothing here is applied, checksummed, or tested.

They were replaced by a single `migrations/0001_baseline.sql` on 2026-08-13.

## Why they were replaced

Seven of the twelve existed only to correct a predecessor, accounting for 38.7%
of the series' 56,913 lines. `0012` is 11,839 lines containing twenty-two
`CREATE OR REPLACE FUNCTION` statements and one `ALTER FUNCTION` — it re-emits
every function body in order to change function attributes, because a
forward-only immutable series cannot edit the original.

Immutable forward-only migrations protect a deployed database. Dasher has never
deployed one. The rule was adopted in ADR-003 on 2026-07-30, one day before the
first migration was written, and its cost was paid every week thereafter with no
corresponding benefit.

The baseline carries forward the schema those files produced, minus the
disposable-dashboard lifecycle, the retention and deletion apparatus, and the
agent-run ledger's lease, budget, checkpoint, and replay machinery.

See [the restructure proposal](../../../docs/review/2026-08-13-restructure-proposal.md).

## When immutability returns

At the first production deployment. From that point the series is forward-only
and append-only again, and `0001_baseline.sql` becomes immutable.

| File                                                                   | Lines  |
| ---------------------------------------------------------------------- | ------ |
| `0001_identity_audit.sql`                                              | 491    |
| `0002_security_boundary.sql`                                           | 3,798  |
| `0003_immutable_content.sql`                                           | 5,868  |
| `0004_lifecycle_api_correction.sql`                                    | 2,422  |
| `0005_security_definer_cleanup_coordination.sql`                       | 20     |
| `0006_lifecycle_access_retention_guard_correction.sql`                 | 489    |
| `0007_agent_run_ledger_and_calculations.sql`                           | 24,704 |
| `0008_retention_lock_authority_correction.sql`                         | 5,910  |
| `0009_agent_run_takeover_settlement_transition_correction.sql`         | 632    |
| `0010_agent_run_cancel_attempt_context_correction.sql`                 | 652    |
| `0011_agent_run_bundle_lock_authorized_phase_correction.sql`           | 88     |
| `0012_agent_run_operator_reachability_and_replay_fence_correction.sql` | 11,839 |
