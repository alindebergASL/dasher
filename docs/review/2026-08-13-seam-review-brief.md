# Review brief: the `dasher_api` write and authentication seam

Status: Review request — nothing here is a finding or a decision
Date: 2026-08-13
Scope: PR #20, `packages/control-plane/migrations/0001_baseline.sql` and
`packages/control-plane/test/accepted-invalid-states.integration.test.ts`

## What you are being asked

State the invariants below as claims to be falsified. **Find a concrete case
this schema still accepts and should not**, or state that you could not.

A finding is: named inputs, the operation attempted, what the schema does, and
what it should do instead. A concern without a case is worth raising separately
and labelling as such.

## What this brief deliberately does not contain

No design rationale, no explanation of why any construction is believed sound,
and no account of how the code came to be written. That omission is the point.
The author of this change wrote both the mechanism and the tests asserting it
works; an explanation from that author would invite review of the argument
rather than of the code.

If a construction below looks unmotivated, treat that as a question to answer
from the source, not a gap in this document.

## What changed

`dasher_app` previously held direct `INSERT` and `UPDATE` on `dashboards`,
`dashboard_versions`, `claims`, `claim_evidence`, and `agent_runs`, and no write
access at all to identity, audit, or evidence tables.

It now holds **`SELECT` only, on every table**. All state change goes through
functions in a new `dasher_api` schema. A new `dasher_private.context_keys`
table and three functions establish and verify the request context.

Prior review of the same PR found 26 states the schema wrongly accepted. Those
are enumerated as executable cases in the test file above and are asserted
closed. Verifying that claim is in scope; so is finding what it missed.

## Invariants claimed

Each is claimed to hold against **any** SQL the application role can issue on
its own connection, including SQL it was never intended to issue.

### Request identity

- **I1** No caller can obtain a request context for a principal without
  presenting a session token that resolves to that principal.
- **I2** A caller holding a legitimate context for principal A cannot reach a
  context for principal B by any means available to it.
- **I3** A context does not survive the transaction that established it.
- **I4** A session that is revoked, idle-expired, absolutely expired, or whose
  membership is inactive or has changed authority establishes no context.
- **I5** A context already established stops authorizing as soon as the
  membership behind it is revoked, without waiting for expiry or transaction end.

### Authority

- **I6** No function in `dasher_api` accepts the acting principal as an argument.
- **I7** The application role cannot execute `dasher_private.context_digest`, nor
  read `dasher_private.context_keys`, by any route.
- **I8** Every `dasher_api` function requires at least the role its operation
  implies, and denies otherwise.

### Attribution and provenance

- **I9** No row can record a creator, requester, or actor other than the acting
  principal.
- **I10** A succeeded run names exactly the dashboard whose version it produced;
  a version and its run agree in both directions; at most one run produced a
  given version.
- **I11** A terminal run rejects all further change. A running run's request
  fields are immutable.

### Content and lifecycle

- **I12** A stored digest equals the digest of the bytes stored beside it.
- **I13** Dashboard lifecycle admits only `draft→active`, `active→archived`,
  `archived→active`; revision advances by exactly one; creation provenance is
  immutable; only a `valid` version becomes head.
- **I14** Concurrent promotions of the same dashboard cannot both apply.
- **I15** A published version accepts no further claims or citation edges.
- **I16** A claim asserted `complete` cites at least one supporting edge.
- **I17** Source snapshots and evidence records reject update and delete,
  intrinsically rather than by withheld privilege.

### Audit

- **I18** Every operation named in `audit_events_action_check` that the seam
  performs writes its audit event in the same transaction as the state change,
  such that neither can occur without the other.

### Completeness of the seam

- **I19** No table is reachable for write by the application role other than
  through `dasher_api`.
- **I20** Creating an organization is _not_ possible for the application role.
  This is intended — `PRODUCT_REQUIREMENTS.md:248` makes managing organizations
  an administrator action and names public signup a non-goal. Provisioning is an
  operator path using owner credentials.

## Where to look

|                      |                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------ |
| Context construction | `0001_baseline.sql`, `dasher_private.context_keys` through `context_organization_id` |
| Authorization helper | `dasher_private.context_allows`, and the note on why `memberships` is not `FORCE`d   |
| Enforcement triggers | `dasher_private.guard_*`, and the constraint trigger on claims                       |
| The seam             | `dasher_api.*` — seven functions plus `acting_principal`                             |
| Grants               | the final block of the migration                                                     |
| Executable cases     | `accepted-invalid-states.integration.test.ts`                                        |

`finalize_run` is the largest single function and does the most at once.

## Running it

```bash
pnpm --filter @dasher/control-plane test:postgres
```

Requires `DASHER_TEST_OWNER_DSN`, `DASHER_TEST_APP_DSN`,
`DASHER_TEST_HMAC_KEY_B64URL`. The suite reports 58 passed against a clean
PostgreSQL 16 database. The migration is mutable, so a schema change is made by
editing the file and recreating the database.

## Out of scope

Whether replacing the Task 9D architecture is the right direction — that is
decided. Whether the agent-run ledger should return. Product questions about
lifecycle vocabulary. Formatting.

## In scope and worth attacking

Anything above. Also: whether the invariants themselves are the right set, and
what an attacker holding the application connection can do that none of them
forbid.
