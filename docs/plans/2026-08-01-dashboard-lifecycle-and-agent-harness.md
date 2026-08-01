# Dashboard Lifecycle and Agent Harness Successor Plan

Status: Proposed implementation plan; PLAN/DOCS ONLY
Date: 2026-08-01
Supersedes: unimplemented Tasks 8–11 and the minimal immutable-content DDL in
`docs/plans/2026-07-30-product-spine.md`
Depends on: ADR-001, ADR-003, ADR-004, proposed ADR-005, immutable migrations
`0001_identity_audit.sql` and `0002_security_boundary.sql`

## Decision lock and authorization boundary

This plan prevents the first dashboard migration from freezing an access and
retention model that cannot implement ADR-005 safely. It plans implementation;
it does not implement a migration, repository, harness, identity path, live
provider, customer-data path, CI change, or deployment.

Tasks 1–7 of the 2026-07-30 product-spine plan are completed and merged. Its
minimal immutable-content DDL and Tasks 8–11 are on HOLD and must not be used.
Do not author `0003_immutable_content.sql` until this exact docs tree has passed
dual review and this successor plan is accepted. Once `0003` is introduced its
bytes are immutable; lifecycle, access, evidence, and retention corrections may
not be postponed on the theory that a later edit can repair it.

This plan does not change `0001` or `0002`. Their expected SHA-256 values at the
planning base are:

- `0001_identity_audit.sql`:
  `d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a`
- `0002_security_boundary.sql`:
  `395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9`

Generated code remains `Status: CLOSED`. Synthetic/public bounded fixtures are
the only permitted content in this slice. Nothing here authorizes real customer
data, confidential data, uploads, object storage, schedules, jobs, providers,
passwordless sign-in, public access, or deployment.

## Why the held `0003` is unsafe

The old planned migration is not a safe smaller first step:

1. `dashboards` has no created/current kind, expiry, lifecycle state/revision,
   access revocation, purge, promotion, archive, retention policy, capability
   epoch, cache epoch, or cleanup coordination. Database-enforced expiry is
   therefore impossible.
2. Viewer RLS on snapshots, evidence, versions, and links authorizes child rows
   independently. Revoking a dashboard would leave raw child reads and counts
   accessible.
3. A version links to snapshots but not evidence records. Revision-level support
   provenance cannot be reconstructed or safely retained/purged; semantic
   Claim coverage remains a later relation.
4. The broad immutable trigger rejects every owner update/delete. That protects
   application immutability but also blocks an approved, least-privilege purge
   path.
5. Generic organization access to sources/evidence conflicts with revoke-first
   cleanup and incorrectly treats shared bytes as dashboard-owned.
6. `audit_events_action_check` has creation/head actions but no expiry,
   promotion request/decision, archive, delete, restore, hold, cleanup, or purge
   actions.

Creating that schema would make scheduler lag an authorization condition and
force a later migration to reverse already-granted raw access. It is therefore
HOLD, not an incremental option.

## Product policy consumed by implementation

ADR-005 is authoritative for rationale, failure behavior, and UX. The database
and repository must encode these values without configurable escape hatches:

- Disposable TTL defaults to 24 hours; minimum 1 hour; hard maximum 30 days
  from creation. Organization-admin default is 1 hour through 7 days. Pilot
  presets are exactly 1h/24h/7d/30d, with no arbitrary timestamp.
- TTL is database-authoritative, visible, fixed at creation, and expires at
  `database_now >= effective_expires_at`. There is no extension/renewal and no
  recurring work. Promotion is the persistence path.
- Expiry/delete revokes access immediately, then 24-hour inaccessible
  quarantine with `purge_after = access_revoked_at + 24 hours`. Purge begins no
  earlier than `purge_after`. Its completion target is 24 hours later.
  Runtime-inaccessible encrypted backups target age-out from Dasher recovery
  paths in 35 days, without claiming provider physical-media deletion; bounded
  audit/hash/tombstone metadata ages out in 365 days unless held.
- Multiple operator-only legal holds block purge only. Restore during
  quarantine creates a new ID after fresh checks, copies no schedules, and is
  denied at/after `purge_after`; held copies are not restore sources.
- Editor requests and admin approval do not pause expiry. Promotion is in-place
  only when locked database time is strictly before expiry and grants no new
  source, audience, schedule, or policy authority.
- Durable lifecycle is `draft`, `active`, `archived`; archive is reversible and
  access-retaining. Explicit delete revokes access and starts cleanup. There is
  no durable-to-disposable transition.
- Work reauthorizes at claim, around every external boundary, and before every
  artifact/head/cache commit. Lifecycle revision and capability/cache epochs
  fence stale results.

## Migration boundaries

### Required in `0003` before its bytes freeze

`0003_immutable_content.sql` is one reviewed migration containing all of:

- lifecycle-safe dashboard control and organization TTL policy rows;
- deterministic revision-1 lifecycle-policy lazy seed through first dashboard
  creation, with no policy-admin mutation function;
- append-only lifecycle events unique by dashboard lifecycle revision;
- promotion requests and decisions;
- cleanup coordination and append-only cleanup attempts;
- multiple operator legal holds with audited release;
- a provider-neutral retention-service principal/capability allowlist with no
  credential or production login;
- source snapshots, evidence, dashboard versions, version-snapshot links, and
  explicit version-evidence links;
- explicit reference and retention claims for shared snapshots, evidence, and
  dashboard-owned artifacts plus typed deletion-finalizer coordination;
- tenant-keyed dashboard tombstones, restore lineage, and append-only backup-
  deletion ledger export seam;
- access derived through an accessible dashboard claim, with fixed projections
  instead of raw viewer grants;
- fixed lifecycle/create/CAS/restore functions and exact ACL/RLS inventory;
- lifecycle audit action expansion and atomic event semantics; and
- a reference-aware purge seam usable only by a separate retention authority.

### Deferred to `0004+`

The agent-run ledger, checkpoints, model/tool metering, calculation graphs,
primitive registry, ranker records, and passwordless challenge tables are not
in `0003`. This bounds the migration and prevents provider churn from shaping
the lifecycle schema.

`0003` nevertheless reserves clean, provider-neutral seams:

- `lifecycle_revision`, `capability_epoch`, and `cache_epoch` on the dashboard
  are commit fences;
- organization and dashboard retention-policy revisions are immutable
  provenance;
- versions carry canonical spec, validation, planner-provenance, and optional
  calculation-graph hashes, never a nullable speculative provider ID;
- explicit version/snapshot/evidence relations support later ledger foreign
  keys; and
- later relations attach by organization/dashboard/version IDs and content
  hashes rather than adding provider-specific columns to lifecycle rows.

`0004` is not authorized by completion of `0003`; it receives a separate plan,
review, migration, repository, fake-provider/replay, and PostgreSQL gate.

## Product grammar at the `0003` boundary

ADR-005's nouns are normative for schema review:

- Workspace is a container/registry, not a dashboard kind or lifecycle state.
- Scratch maps exactly to `current_kind = 'disposable'`.
- Board maps exactly to `current_kind = 'durable'` with `draft`, `active`, or
  `archived` lifecycle.
- Published is a later reviewed audience projection of one immutable Board
  version. It is not a dashboard kind/state and does not exist as a relation in
  `0003`.
- Decision Snapshot and Recipe are later outward relations, not columns or
  states in `0003`.

`head_version_id` means the current validated working head. It is not a
publication, audience grant, or claim that the head was human-reviewed for an
audience. `active` means lifecycle-accessible, not Published. Scratch-to-Board
promotion preserves identity/history and produces a private Board working head;
it grants no publication/audience authority. A prior or future published
revision is independent of working-head advancement.

`dashboard_version_evidence` is revision-level provenance only. Evidence rows
are support artifacts, not semantic Claims, and `0003` makes no claim-level
coverage promise. Stable organization/dashboard/version/snapshot/evidence/
artifact IDs plus canonical hashes are sufficient outward seams for later
MetricContractVersion, Claim/ClaimEvidence, evidence-manifest, publication,
Decision Snapshot, Recipe, alert, and run relations. No nullable speculative
column or provider ID is added to `0003` for them.

No decision, Recipe, alert, bookmark, pin, share, recipient link, or future
publication may silently create content retention for an expiring Scratch.
Durable accessible preservation requires in-place promotion before expiry.
After expiry, only independently authorized shared-resource claims and bounded
audit/tombstone retention survive. Partial/selective promotion is deferred; a
later copy from a selected immutable revision would use a new identity and
explicit provenance and is not promotion. Generic dashboard clones remain
rejected. Product UI concepts do not create `0003` tables.

## Exact `0003` relational contract

Names below are normative. The implementation review must reject renaming,
collapsing, JSON substitution for relational authority, or omission.

### Organization policy and dashboard control

`dasher.dashboard_lifecycle_policies` contains `organization_id`, monotonically
increasing `policy_revision`, `default_disposable_ttl_seconds`,
`retention_policy_revision`, `created_at`, and author provenance. The default
TTL check is inclusive `3600..604800`. Rows are append-only. Existing `0002`
organization creation is unchanged, and `0003` adds no policy-admin mutation
function. Under the organization advisory gate already held by
`initialize_context`, the first `create_dashboard` for an organization with no
policy row atomically inserts deterministic revision `1` with
`default_disposable_ttl_seconds = 86400`, `retention_policy_revision = 1`, and
fixed migration/product-policy provenance; it then locks and reselects that row.
Concurrent first creates serialize on the existing organization gate. This lazy
seed applies to existing and future organizations. Later policy change requires
a forward migration/API seam and is not ambient SQL or app-admin behavior in
`0003`.

After seeding if necessary, `create_dashboard` locks the relevant policy rows,
selects the highest revision, and revalidates it. An unlocked
`max(policy_revision)` is never an authority decision. The function accepts
only the four preset seconds (`3600`, `86400`, `604800`, `2592000`) or an
explicit use-organization-default selector. It does not accept a timestamp.

`dasher.dashboards` is the lifecycle control row and contains:

- tenant/key/title/creator: `organization_id`, `dashboard_id`, `title`,
  `created_by_user_id`, `created_at`;
- kind: `created_kind` and `current_kind`, each closed to `disposable` or
  `durable`;
- expiry: immutable `original_expires_at` and mutable-only-by-promotion
  `effective_expires_at`;
- state/fence: `lifecycle_state`, `lifecycle_revision`, `capability_epoch`, and
  `cache_epoch`;
- revocation/retention: `access_revoked_at`, `revocation_reason`, `purge_after`,
  `purge_started_at`, `purged_at`, and `retention_policy_revision`;
- durable lifecycle provenance: `promoted_at`, `archived_at`; and
- nullable `head_version_id` with the same-tenant deferred composite FK,
  meaning only the current validated private working head;
- required opaque random `tombstone_lineage_id`, unique with
  `organization_id`; and
- nullable `restored_from_tombstone_lineage_id`, which is null for ordinary
  creation and references same-tenant restore lineage for restore-as-new.

Creation always sets `lifecycle_state = 'draft'` for both disposable and durable
dashboards; creation itself never creates an `active` dashboard. The only
initial `draft -> active` transition is the first successful validated
working-head compare-and-swap through the fixed head mutation. It updates the
head and lifecycle state atomically with its lifecycle event and audit event;
there is no separate activate function.

Creation uses locked database time once. A disposable row requires
`original_expires_at = effective_expires_at`, at least one hour and at most 30
days after `created_at`; a born-durable row requires both expiry fields null.
Promotion preserves `created_kind = 'disposable'` and
`original_expires_at`, changes `current_kind` to `durable` and state to
`active`, and sets only the effective expiry to null. No other operation changes
an expiry. The head remains a private working head; promotion creates no
publication/audience relation or grant. Database checks and fixed functions
enforce allowed state/kind/timestamp combinations.

The closed lifecycle states are `draft`, `active`, `archived`,
`access_revoked`, `quarantined`, `purge_eligible`, and `cleaned`. Access is
allowed only when `access_revoked_at IS NULL`, `purged_at IS NULL`, the state is
appropriate to the current kind, and either current kind is durable or locked
database time is strictly before `effective_expires_at`. The accessible state
set is exactly disposable `draft|active` or durable `draft|active|archived`;
every cleanup state denies. Projection functions repeat the expiry predicate;
no worker-owned state can override it.

### Normative lifecycle transition table

The table is exhaustive. “Once” means one increment in the same transaction;
unchanged epochs remain exactly unchanged. Operation decision time is captured
from the database after the required locks. Creation and restore-as-new are
revision-zero insertions, not lifecycle mutations.

| Operation                | Source -> target                                                              | Required kind, head, and timestamps                                                                                                                                                                             | Owning fixed function                                                                | Revision/epoch effect                                         | Lifecycle event                           | Fixed audit action                 |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| Create                   | absent -> `draft`                                                             | Requested `disposable` with fixed valid expiry or born-`durable` with null expiry; `head_version_id IS NULL`; revocation/purge/archive/promotion timestamps null                                                | `dasher_api.create_dashboard`                                                        | `lifecycle_revision = capability_epoch = cache_epoch = 0`     | none                                      | existing `dashboard.created`       |
| First validated head CAS | `draft -> active`                                                             | Either kind; target head is non-null, same-tenant, immutable, and validated; lifecycle timestamps unchanged                                                                                                     | `dasher_api.compare_and_swap_dashboard_head`                                         | lifecycle revision +1; capability/cache epochs unchanged      | `head_activated`                          | existing `dashboard_head.promoted` |
| Later validated head CAS | `active -> active`                                                            | Either kind; replacement head is non-null, same-tenant, immutable, and validated; lifecycle timestamps unchanged                                                                                                | `dasher_api.compare_and_swap_dashboard_head`                                         | lifecycle revision +1; capability/cache epochs unchanged      | `head_advanced`                           | existing `dashboard_head.promoted` |
| Promotion approval       | disposable `active ->` durable `active`                                       | Existing non-null validated head; approved request and expected revision; locked time strictly before effective expiry; no cleanup state; original expiry retained, effective expiry cleared, `promoted_at` set | `dasher_api.decide_dashboard_promotion`                                              | lifecycle revision, capability epoch, and cache epoch each +1 | `promotion_approved`                      | `dashboard.promotion_approved`     |
| Archive                  | durable `active -> archived`                                                  | Existing non-null validated head; `archived_at` set to decision time                                                                                                                                            | `dasher_api.set_dashboard_archive`                                                   | lifecycle revision, capability epoch, and cache epoch each +1 | `archived`                                | `dashboard.archived`               |
| Unarchive                | durable `archived -> active`                                                  | Existing non-null validated head; `archived_at` cleared after its prior value is captured in event/audit provenance                                                                                             | `dasher_api.set_dashboard_archive`                                                   | lifecycle revision, capability epoch, and cache epoch each +1 | `unarchived`                              | `dashboard.unarchived`             |
| Expiry materialization   | disposable `draft \| active -> access_revoked`                                | Locked time `>= effective_expires_at`; head may be null or non-null; set revocation time/reason and `purge_after = access_revoked_at + 24 hours`; create tombstone and cleanup coordination                     | `dasher_retention_api.materialize_dashboard_expiry`                                  | lifecycle revision, capability epoch, and cache epoch each +1 | `expired`                                 | `dashboard.expired`                |
| Explicit delete          | accessible disposable/durable `draft \| active \| archived -> access_revoked` | Head may be null or non-null; set locked revocation time/reason and `purge_after = access_revoked_at + 24 hours`; create tombstone and cleanup coordination                                                     | `dasher_api.delete_dashboard`                                                        | lifecycle revision, capability epoch, and cache epoch each +1 | `deleted`                                 | `dashboard.deleted`                |
| Start quarantine         | `access_revoked -> quarantined`                                               | Drain/cancellation proof present; revocation timestamps unchanged                                                                                                                                               | `dasher_retention_api.claim_dashboard_cleanup`                                       | lifecycle revision +1; epochs unchanged                       | `cleanup_started`                         | `dashboard.cleanup_started`        |
| Mark purge eligible      | `quarantined -> purge_eligible`                                               | Locked time `>= purge_after`; exact expected revision; no active hold; revocation timestamps unchanged                                                                                                          | `dasher_retention_api.claim_dashboard_cleanup`                                       | lifecycle revision +1; epochs unchanged                       | `purge_eligible`                          | `dashboard.purge_eligible`         |
| Cleanup lease/retry      | cleanup state unchanged                                                       | State-derived step only; lease/attempt fields may change                                                                                                                                                        | `dasher_retention_api.claim_dashboard_cleanup` or `record_dashboard_cleanup_attempt` | no lifecycle revision or epoch change                         | none; append cleanup-attempt history only | none                               |
| Place hold               | state unchanged                                                               | Any not-cleaned dashboard/resource with `purge_started_at IS NULL`; exact expected revision; no access or expiry change                                                                                         | `dasher_retention_api.place_dashboard_legal_hold`                                    | lifecycle revision +1; epochs unchanged                       | `legal_hold_placed`                       | `dashboard.legal_hold_placed`      |
| Release hold             | state unchanged                                                               | Active hold and exact expected revision; no access or expiry change                                                                                                                                             | `dasher_retention_api.release_dashboard_legal_hold`                                  | lifecycle revision +1; epochs unchanged                       | `legal_hold_released`                     | `dashboard.legal_hold_released`    |
| Purge                    | `purge_eligible -> cleaned`                                                   | No active hold; exact revision; set `purge_started_at` before destructive work and `purged_at` only after final proof                                                                                           | `dasher_retention_api.purge_dashboard`                                               | lifecycle revision +1; epochs unchanged                       | `purged`                                  | `dashboard.purged`                 |
| Restore as new           | absent -> new durable `draft`                                                 | Source remains revoked/quarantined and restorable; selected immutable version only; new dashboard has null expiry/head and new lineage                                                                          | `dasher_api.restore_dashboard_as_new`                                                | new dashboard revision/epochs all `0`; source unchanged       | none                                      | `dashboard.restored_as_new`        |

Head CAS denies `archived` and every cleanup state. Archived Boards remain
accessible but read-only for head mutation and refresh. No function other than
the first successful fixed validated head CAS may perform the initial
`draft -> active` transition; creation and restore never create an active
dashboard, and draft promotion is denied. Promotion requires an already-active
Scratch and stays `active`. Inclusive expiry denies access even before the
scanner materializes `access_revoked`.

### Lifecycle, promotion, cleanup, and holds

`dasher.dashboard_lifecycle_events` is append-only and contains event ID,
organization/dashboard IDs, `lifecycle_revision`, event kind, from/to kind and
state, database occurrence time, actor/service, authority/policy revisions,
request/job correlation, and bounded reason/hash provenance. It has unique
`(organization_id, dashboard_id, lifecycle_revision)`. Revision zero has no
event; every committed lifecycle mutation increments exactly once and appends
exactly one event.

`dasher.dashboard_promotion_requests` records an editor request, dashboard and
requested lifecycle revision, immutable request time, requester, and bounded
rationale hash. `dasher.dashboard_promotion_decisions` is append-only, links one
request, records approving/denying admin, decision, locked dashboard revision,
decision time, and policy revision. At most one successful approval exists per
request. A pending/approved request conveys no access and never changes expiry.

`dasher.dashboard_cleanup_coordination` is the only mutable cleanup lease row.
It records dashboard, current step, lease owner/expiry, expected lifecycle
revision, next attempt time, and completion proof hash. It is never evidence of
product access. `dasher.dashboard_cleanup_attempts` is append-only and records
attempt/step, start/end, result, released/deleted/deferred claim counts, bounded
failure code, and proof hash. Results distinguish success, retryable failure,
held, outstanding reference, and already complete. `cleaned` may be committed
only after fixed predicates prove all eligible work complete.

`dasher.dashboard_legal_holds` uses a unique hold ID so multiple active holds
may coexist. It records opaque random `hold_id`, opaque
`case_matter_reference`, `placed_by_principal_id`,
`placed_authority_revision`, `placed_actor`, `placed_reason_sha256`,
`placed_at`, and `retention_policy_revision`; nullable release fields are
`released_at`, `released_by_principal_id`, `released_authority_revision`,
`released_actor`, and `released_reason_sha256`. Hold rows are mutable only
through the fixed release function; placement and release lifecycle/audit
events are append-only. Release is equally privileged, does not delete history,
and an active hold affects only purge eligibility.

`dasher.dashboard_tombstones` is tenant-keyed by
`(organization_id, tombstone_lineage_id)`. Revocation creates the row exactly
once from the dashboard's own opaque random lineage ID. It contains only the
retention-policy revision, revocation/final-purge event kinds and database
times, lifecycle revisions, and bounded lifecycle proof hashes needed for
retention, denial, and deletion replay. It contains no email, name,
customer/content bytes, prompt, source locator, or low-entropy hashed identity.

`dasher.dashboard_restore_lineage` is append-only and tenant-keyed by the new
dashboard/version identity. It maps that pair to the source
`tombstone_lineage_id` and opaque selected source-version ID, and records the
policy revision, actor/service authority, database occurrence time, and bounded
provenance hash. Same-tenant FKs cover the new dashboard/version and source
tombstone; the source dashboard row is not mutated.

`dasher.backup_deletion_ledger` is an append-only export seam keyed by
`(organization_id, ledger_sequence)`, with a gap-free monotonically allocated
tenant sequence under the organization gate. Each entry contains
`tombstone_lineage_id`, lifecycle revision, event kind closed to
`access_revoked|purged`, event occurrence time, ledger insertion time,
retention-policy revision, and bounded lifecycle/deletion proof hash. Access
revocation and final purge each append their exact entry in the winning
transaction. The relation contains no content bytes or external-system claim.

### Retention-service principal and capability mapping

`dasher.retention_service_principal_allowlist` is the exact non-ambient mapping
required by `initialize_operator_context`. It contains:

- opaque `retention_service_principal_id` and monotonically increasing
  `principal_revision` as its composite primary key;
- `binding_kind`, closed in `0003` to `postgres_session_user`, and exact
  `binding_subject name` matched to `session_user`;
- `authority_scope`, with `platform_operator` active in the pilot and a dormant
  `tenant_legal_admin` seam that no function accepts until a forward
  operations/security review;
- nullable `scope_organization_id`, required only by a future activated tenant
  scope and always null for the pilot platform operator;
- closed boolean capabilities for initialize/materialize-expiry/place-hold/
  release-hold/claim-cleanup/record-attempt/purge, plus `enabled`;
- `created_at`, predecessor revision/hash, and migration provenance.

Rows are immutable and revisioned, contain no password, token, certificate,
digest of a credential, DSN, or provider credential, and are visible only to
the migration owner and exact retention definer projection. The relation has
forced RLS, no app policy/grant, no `PUBLIC`, `dasher_app`, app-login, general-
definer, or organization-admin access, and exact catalog/ACL tests.

Exactly one pre-context forced-RLS policy exists on the allowlist. It permits
`SELECT` only when `current_user = dasher_retention_definer`,
`binding_kind = 'postgres_session_user'`, and
`binding_subject = session_user`. It exposes every exact-binding revision so
the latest revision—including a disabled revocation—cannot be hidden. It
requires no transaction-local context because this self-binding lookup is the
bootstrap authority. Relation and column privileges are `SELECT`-only;
bootstrap `INSERT`, `UPDATE`, and `DELETE` deny. The `SECURITY DEFINER`
initializer returns no allowlist row, column, count, or existence signal and
cannot read another session user's binding. Runtime never uses `SELECT FOR
UPDATE`, `SELECT FOR SHARE`, or another tuple-locking read on the allowlist and
has no allowlist `UPDATE`/`DELETE` privilege or policy.

`dasher_retention_api.initialize_operator_context` is exactly `VOLATILE
SECURITY DEFINER` with the hardened `search_path = pg_catalog`; `STABLE` or
`IMMUTABLE` is forbidden, and catalog identity must report
`provolatile = 'v'`. PostgreSQL READ COMMITTED gives each SQL command a fresh
snapshot, and a VOLATILE function's internal SQL queries may observe a fresh
snapshot instead of being pinned to the caller query's snapshot as a STABLE/
IMMUTABLE function would be. This visibility property is part of the authority
protocol, not a performance annotation.

The initializer body order is exact. Before an allowlist read or provisional
authority context, it requires
`current_setting('transaction_isolation') = 'read committed'` and proves every
reserved bootstrap/full-context key empty. A different reported isolation
value—including a `read uncommitted` alias if it is not reported exactly as
`read committed`, `repeatable read`, or `serializable`—an already-aborted
transaction, or malformed/prepopulated context establishes no authority. It
then derives its canonical operator-principal advisory gate from the exact
immutable login-binding tuple
`(binding_kind = 'postgres_session_user', binding_subject = session_user)`, not
from an unread allowlist row, and acquires that transaction gate. Only after the
lock call returns does it execute the self-binding ordinary allowlist `SELECT`
as a distinct subsequent internal SQL query. No allowlist row, principal
revision, enabled/capability value, or predecessor state may be read, cached, or
materialized before gate acquisition. Under READ COMMITTED, that distinct
post-gate query obtains the command snapshot after the gate-winning writer
committed.

The post-gate query considers all exact-binding revisions and selects the
single highest `principal_revision` regardless of enabled status. The latest
revision must be enabled and possess the exact capability requested for the
immediately following fixed retention operation; a newer disabled revision is
revocation and never falls back to an older enabled revision. The initializer
validates the required predecessor/hash chain. Missing rows,
duplicate-at-revision, malformed chain, stale selection, latest-disabled state,
or absent capability all normalize to denial. An unlocked maximum revision or
ambient role-name check is forbidden. It then writes private provisional
transaction-local context with only bootstrap phase `target_discovery`,
validated principal ID/revision/scope, the exact required capability, bounded
request/case values, and the supplied `target_dashboard_id`. It does not set an
authorized target organization.

Exactly one pre-full-context target-discovery forced-RLS policy exists on
`dasher.dashboards`. It permits the retention definer to `SELECT` only the
single row whose `dashboard_id` equals the provisional context's
`target_dashboard_id`, and only while current user, bootstrap phase, validated
principal/revision/scope/capability, and the gate-stabilized selected allowlist
binding all match. The initializer projects only `organization_id` internally,
takes no tenant row lock during discovery, exposes no row/count/existence
result, and normalizes missing, forged, cross-tenant, and unauthorized locators
to the same denial. No other tenant table, child, content, source byte, claim,
hold, function projection, or policy gets bootstrap visibility.

The initializer validates that the derived organization is permitted by the
locked scope: `platform_operator` may target that derived organization in the
private pilot, while dormant tenant scope remains unusable. It then acquires
the derived target-organization advisory transaction gate before any tenant row
lock and replaces provisional context with full phase `authorized`, binding the
target organization and exact target dashboard in addition to the validated
principal/revision/capability/request/case values. The target-discovery policy
no longer matches after that phase change. With both advisory gates held, the
initializer locks and revalidates the same dashboard through the ordinary
full-context forced-RLS policy. Any mismatch raises, rolls back the transaction,
and clears all transaction-local state.

Allowlist rows remain immutable and append-only to retention runtime. Every
allowlist writer—the migration-owner synthetic test seed/owner-only cleanup and
any future separately reviewed production enrollment, revision, or revocation
mechanism—must derive and acquire the same binding transaction advisory gate
before `INSERT` or owner-only cleanup; no other writer path exists. The shared
gate serializes append-only authority publication/revocation against
initialization. Because it remains held for the initializer transaction, the
selected latest revision is stable for that authority decision without
`UPDATE` privilege or a tuple lock. Every later fixed retention function
revalidates the exact bound principal revision under the same still-held gate
and denies stale or malformed context.

Writer-first means the disabling writer commits its new latest revision before
releasing the gate; the waiting READ COMMITTED initializer acquires next, and
its distinct VOLATILE post-gate query sees latest-disabled and denies without
fallback. Initializer-first means it reads/binds the prior latest revision and
holds the gate through transaction end, so the writer waits and that old
authority is valid only for the already-winning transaction. Explicit
REPEATABLE READ and SERIALIZABLE calls deny before allowlist authority access.

Only the migration owner may seed synthetic bindings used by the PostgreSQL
gate, and owner-only cleanup uses the same gate and requires no active
initializer. The PostgreSQL gate proves both initializer/writer lock-winner
orders and removes test bindings through that gated cleanup. `0003` provisions
no production login or production allowlist row. A future production operator
login, principal enrollment/revision/revocation, credential binding, or
activation of the tenant legal-admin/separation-of-duties seam requires a
forward operations and security review; it is not an app-admin action.

### Content, evidence, and explicit claims

Retain the old plan's bounded, same-tenant, canonical source/evidence/version
requirements, but replace generic access with explicit relations:

- `dasher.source_snapshots` restricts `source_kind` exactly to
  `synthetic_fixture` or `public_usgs_fixture` and checks raw
  `canonical_bytes` length `1..1048576` bytes. Those structural checks do not
  inspect or prove that contents are public, synthetic, or non-sensitive. No
  route/repository/ingestion boundary may accept raw bytes until a separately
  reviewed classification/admission gate exists. Only the migration owner may
  seed fixed synthetic PostgreSQL-gate fixtures, removed during owner cleanup;
  `0003` exposes no runtime/app source-byte create function or grant.
- `dasher.evidence_records` belongs to a same-tenant snapshot and retains typed
  `evidence_kind` closed to `source_record`, `typed_value`,
  `calculation_result`, or `event_record`, plus coordinates, transformation,
  hashes, and observation/retrieval provenance. It has no semantic Claim label
  or confidence/correctness field.
- `dasher.dashboard_versions` belongs to a dashboard and stores canonical spec
  bytes/hash, parent, strict validation state/hash, planner-provenance hash,
  policy/registry revisions, optional calculation-graph hash, creator, and
  database time.
- `dasher.dashboard_version_snapshots` is an explicit same-tenant version to
  snapshot relation.
- `dasher.dashboard_version_evidence` is an explicit same-tenant version to
  evidence relation. Evidence must also resolve through one of that version's
  linked snapshots; a fixed create-version function proves the submitted links
  form a same-tenant referential graph before insert. This does not establish
  semantic Claim coverage or an evidence manifest.
- `dasher.dashboard_artifacts` contains bounded synthetic fixture artifact
  metadata/hash and an ownership class of `dashboard_owned` or `shared`; no
  customer bytes or object-store locator exists in `0003`.
- `dasher.snapshot_reference_claims`, `dasher.evidence_reference_claims`, and
  `dasher.artifact_reference_claims` identify the dashboard/version claiming a
  resource and whether the claim is access-bearing or retention-only. Each has
  nullable same-tenant `hold_id`: access-bearing claims require a null
  `hold_id`; retention-only claims require an active `hold_id` for the same
  organization/dashboard/resource. Claim kinds are closed; generic polymorphic
  target columns are forbidden.
- `dasher.snapshot_deletion_finalizers`,
  `dasher.evidence_deletion_finalizers`, and
  `dasher.artifact_deletion_finalizers` are separate typed coordination rows,
  never a polymorphic target. Each records deletion intent time, expected claim
  set hash, mutable-only-by-retention state (`intent`, `eligible`, `deleted`),
  lease/proof fields, and final byte-deletion time. Append-only cleanup attempts
  carry the outcome history.

Version links and explicit claims are insert-only to application code.
Retention-only claims originate only in fixed legal-hold placement: under the
dashboard/resource locks, placement creates one distinct hold-provenanced claim
per reachable snapshot, evidence record, and artifact. Multiple holds create
distinct claims. Fixed release removes only claims for that hold after exact
proof and audit; it cannot touch access-bearing or another hold's claims. The
active hold row independently blocks `quarantined -> purge_eligible` and purge.

Before `purge_after`, quarantine work is strictly non-destructive. It may
cancel/fence leases, evict cache, and prepare finalizer/proof state, but it may
not release an access-bearing claim, delete a version/link/spec/resource or
artifact byte, set `purge_started_at`, or make restore unreconstructable.
Destructive claim release begins only from `purge_eligible` inside
`purge_dashboard`. That function releases only access-bearing claims owned by
the source dashboard, then removes eligible rows owned solely by that dashboard
(versions, version links, and dashboard-owned artifacts) and shared resource
bytes only when the same locked transaction proves no active hold and no
remaining access-bearing or retention-only claim. A retry resumes finalizers
idempotently. Shared source bytes are never treated as dashboard-owned.

## Immutability, erasure honesty, and retention authority

“Immutable” means no application `UPDATE`, `DELETE`, or `TRUNCATE`. It does not
mean data can never satisfy retention policy. App functions and the existing
general security definer never receive generic delete authority.

Migration SQL `0003` does not create roles. Task 8A extends the migrator with
the conditional prepared-prefix bootstrap defined below; only that separate
pre-SQL transaction may create exactly `dasher_retention_definer` and
`dasher_retention_operator`. Both managed roles are `NOLOGIN`, `NOINHERIT`,
`NOBYPASSRLS`, have null passwords and no role settings, and carry exact managed
comments frozen by Task 8A. The operator owns nothing and receives only exact
`EXECUTE` on the fixed retention API functions. The definer owns only those
functions—not tables, schema, sequences, or data—and receives only the exact
per-relation privileges required by their closed transitions. No runtime, app,
organization-admin, or general-definer role is a member of or can `SET ROLE` to
the definer. `0003` provisions no login, credential, production allowlist row,
worker, or schedule.

Retention-table RLS remains forced and the definer remains `NOBYPASSRLS`.
The only pre-authorized-context exceptions are the two named bootstrap
`SELECT` policies: the self-binding allowlist policy and the single-dashboard
target-discovery policy. All ordinary retention-table policies—including
ordinary dashboard access after discovery—require exact
`current_user = dasher_retention_definer`, full phase `authorized`, the
validated principal/revision and exact capability, the derived target
organization, and the exact target dashboard where applicable. Each fixed
function receives only its closed per-table
`SELECT`/`INSERT`/`UPDATE`/`DELETE` privileges; no policy or grant permits
bootstrap mutation, generic source-byte insertion, caller-selected
organization, pre-gate tenant locking, or cross-organization access. Task 8A
names and encodes each policy but may not add another exception or choose
broader authority semantics.

Retention-definer purge functions accept typed IDs and expected revisions, not
relation/schema/SQL selectors. They delete only after the fixed predicates for
`purge_eligible`, locked decision time, no active hold, expected revision, and
final reference/retention claim are true. Immutability/purge triggers do not
inspect or claim to recognize a call stack. They require exact
`current_user = dasher_retention_definer`, full phase `authorized`, the locked
operator principal/revision/capability, exact target organization/dashboard,
an allowed `OLD` to `NEW` transition, the expected lifecycle revision, and an
exact column-delta allowlist. If `OLD`/`NEW` plus context cannot distinguish an
authorized transition, the trigger denies it. Catalog/ACL closure proves only the closed
`SECURITY DEFINER` functions are owned by the unassumable definer. Migration-
owner administrative access is not a runtime contract; `PUBLIC`, app, and the
general definer have no generic delete or trigger-disable path.

Inline `bytea` does not support a truthful cryptographic-erasure claim. The
closed source-kind allowlist and byte-length checks are defense-in-depth
metadata/shape constraints, not content classification. Customer,
confidential, upload, or any raw-byte ingestion is blocked at the absent
admission boundary until a later forward migration and reviewed route supply
classification, envelope-encrypted object storage, malware/content controls,
signed access, and reference-claim-aware deletion. No `CHECK` constraint is
claimed to make customer data impossible.

Retention evidence reports four separate milestones: immediate product access
revocation; logical retention/recovery expiry; cryptographic unrecoverability;
and provider physical-media deletion. The 24-hour quarantine, 35-day Dasher
backup/recoverability age-out objective, 365-day bounded metadata period, and
operator-only pilot hold authority are private-pilot product policy, not
universal legal/security standards. Day 35 is not evidence of per-row physical-
media deletion.

A future cryptographic-erasure claim requires envelope per-object or per-
dashboard key design, key pedigree, and verified destruction or inaccessibility
of every relevant key copy and backup with retained evidence. That design is
not present or implied here. Backup retention and provider physical deletion
need separate operator/provider evidence.

Tombstones use opaque random `tombstone_lineage_id` plus only
`retention_policy_revision`, `lifecycle_event_kind`, and
`lifecycle_occurred_at` needed to enforce deletion/restore behavior. They do not
hash low-entropy email addresses, names, or similar identifiers. Content hashes,
pseudonyms, opaque references, and tombstones are treated as potentially
personal or sensitive governed data, never presumed anonymous.

## Transaction and lock contract

Every operation uses one connection-pinned transaction, but immutable `0002`
and the new operator path have distinct initializer orders.

### Application transaction order

1. `BEGIN`, then `SET LOCAL search_path = pg_catalog`.
2. Call existing `dasher_api.initialize_context(...)` in that same transaction.
   The immutable `0002` initializer derives the organization, acquires and
   continues to hold its organization advisory transaction gate, locks
   membership and then session in that order, and validates session time
   internally. `0003` does not reacquire or reorder those locks.
3. After the initializer returns with the organization gate still held, the one
   fixed `0003` operation locks lifecycle-policy rows, source/evidence authority
   and resource rows, the dashboard row, then its operation-specific
   request/decision/lineage/claim rows in canonical primary-key/UUID order.
4. Capture a separate operation-decision database time after those additional
   locks. Revalidate membership/session authority revision, policy revision,
   source authority, dashboard kind/state/revision/epochs/expiry, and relevant
   holds/claims.
5. Apply the one fixed mutation and exact dependent rows. Insert its lifecycle
   event when required and fixed audit action last; either failure rolls back
   the complete operation. Commit or use the existing rollback-and-release
   protocol.

### Operator transaction order

1. Execute exactly `BEGIN ISOLATION LEVEL READ COMMITTED`, then
   `SET LOCAL search_path = pg_catalog`, before any other query. Call fixed
   `dasher_retention_api.initialize_operator_context(...)` with typed
   `target_dashboard_id`, bounded request/case values, and the exact capability
   required by the immediately following fixed operation as the first authority
   operation. It accepts no organization or other authority selector and returns
   no existence result.
2. The initializer first verifies the isolation setting is exactly
   `read committed` and reserved context is empty. It then derives/acquires the
   immutable-binding operator gate without reading authority data. Only after
   the gate call returns does its VOLATILE body issue a distinct ordinary,
   non-locking self-binding allowlist query, whose READ COMMITTED command
   snapshot sees any writer-first commit. It considers every exact-binding
   revision, selects the highest `principal_revision` regardless of enabled
   status, validates its predecessor/hash chain, and requires that latest row to
   be enabled with the requested capability. It never falls back or takes an
   allowlist tuple lock.
3. It sets only provisional phase `target_discovery` context, uses the sole
   dashboard bootstrap policy to project `organization_id` for the exact target
   locator without a tenant row lock or observable existence signal, and
   validates that the locked scope permits the derived organization.
4. It acquires the derived target-organization advisory transaction gate before
   any tenant row lock, replaces provisional state with full phase `authorized`
   bound to the exact organization/dashboard, and thereby shuts off the
   discovery policy. With both gates held, it locks and revalidates that same
   dashboard through ordinary forced RLS. Any mismatch rolls back and clears
   transaction-local state.
5. The fixed retention operation then locks lifecycle-policy,
   resource, dashboard, hold, reference-claim, cleanup/finalizer, and target rows
   needed by that operation in canonical order.
6. Capture operation-decision database time after those locks and revalidate the
   exact bound allowlist revision/capability under the still-held operator gate,
   context, target organization, policy, dashboard lifecycle
   revision/state/expiry, holds, claims, and finalizer proof.
7. Apply the one fixed transition. Insert its lifecycle event and fixed audit
   action last, then commit; either failure rolls back the tenant mutation.

The app and operator contexts/roles are mutually unusable. Cross-organization
operations are forbidden. Every `0003` retention operation is dashboard-rooted;
operation-specific hold/claim/finalizer IDs are canonicalized and locked only
after the target-organization gate and full context. One call cannot span
organization gates.

Repository wrappers must emit the exact retention `BEGIN` statement and invoke
the initializer as their first authority operation. Direct callers at any other
reported isolation level deny inside the initializer. A prior harmless query in
a correctly READ COMMITTED transaction does not pin later visibility because
the post-gate internal query is a distinct command with a fresh snapshot. No
operation may invoke the initializer through a `STABLE` or `IMMUTABLE` wrapper
that would pin authority visibility. Immutable `0002` continues to own app
transaction behavior; this exact isolation contract applies only to operator/
retention transactions.

No network call, provider inference, connector read, object-store request, wait,
or unbounded computation occurs inside the transaction. Work is done outside
after a read/claim transaction and must repeat the whole authorization and fence
check in a new transaction before accepting an external result.

Promotion and expiry use the same gate and dashboard lock. If promotion locks
first, it succeeds only when locked database time is `< effective_expires_at`;
if expiry locks first or time is exactly the boundary, expiry increments the
revision and promotion denies as stale/expired. Hold and purge use the same
gate/revision rule. If hold locks first, purge observes an active hold and does
nothing; if purge locks first and commits `purge_started_at`, hold returns
`already_purged` without recreation even while finalizers resume. Audit failure
rolls back whichever lifecycle transition would have won.

## Access, RLS, ACL, and function contract

Every tenant table enables and forces RLS. Composite foreign keys include
`organization_id`; every foreign-key referencing tuple has an index. Policies,
functions, triggers, owners, languages, volatility, `proconfig`, arguments,
returns, and ACLs are asserted by relation/function OID, not name alone.

There is no broad raw viewer access to snapshots, evidence, versions, links,
claims, artifacts, lifecycle events, cleanup, or holds. `dasher_app` has no
direct table DML. Fixed `SECURITY DEFINER` projections derive results through a
currently accessible dashboard and an access-bearing claim at database time.
They return closed, size-bounded columns only:

- dashboard list/summary, including kind/state/visible expiry/cleanup status;
- current working-head identity, parent/version/hash metadata, and validated spec
  bytes, without publication/audience semantics;
- one authorized version's fixed identity/metadata/spec projection;
- freshness and oldest-referenced-data metadata;
- revision-level evidence summary and one-click support projection;
- second-click technical lineage inputs sufficient to reach version/component/
  typed calculation/evidence/snapshot IDs, filters, grain, units, revisions, and
  evaluation time when later contracts exist;
- artifact ownership class (`dashboard_owned` or `shared`); and
- administrator lifecycle, budget-seam, reference-claim, cleanup, and retention
  summary.

These are minimum outward projection seams, not metric, semantic Claim,
publication, decision, Recipe, alert, bookmark/share, or UI-table
implementations. `0003` does not promise the future five-slot hero is complete;
it preserves the version identity, freshness, expiry, ownership, and lineage
inputs that later relations require.

Counts are computed only after the accessible-dashboard predicate and never
answer whether a forged/inaccessible child ID exists. Validated dashboard-spec
bytes use a separate bounded projection and become unavailable after
revocation; source `canonical_bytes` has no app projection in this slice.
Missing, expired, revoked, cross-tenant, forged, stale-revision, or unauthorized
selectors return the same non-leaking denial. Cache keys include organization,
dashboard, lifecycle revision, capability/cache epoch, and projection version;
an epoch change makes prior cache material unusable.

The app-callable mutation surface is a closed set of typed functions:

- create disposable/durable dashboard;
- create evidence/version plus exact reference links against an already
  admitted snapshot; no app/runtime function accepts source bytes;
- compare-and-swap head after validation and fence checks;
- request promotion and approve/deny promotion;
- archive/unarchive durable dashboard;
- explicitly delete a dashboard;
- restore during quarantine as a newly supplied dashboard ID.

The pre-freeze function-name and execution inventory is exact:

| Schema/identity                                         | Owner                      | Execute grantee             |
| ------------------------------------------------------- | -------------------------- | --------------------------- |
| `dasher_api.list_dashboards`                            | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.get_dashboard_summary`                      | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.get_dashboard_head`                         | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.get_dashboard_version`                      | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.get_dashboard_evidence`                     | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.get_dashboard_lineage`                      | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.get_dashboard_admin_status`                 | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.create_dashboard`                           | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.create_evidence_record`                     | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.create_dashboard_version`                   | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.compare_and_swap_dashboard_head`            | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.request_dashboard_promotion`                | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.decide_dashboard_promotion`                 | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.set_dashboard_archive`                      | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.delete_dashboard`                           | `dasher_security_definer`  | `dasher_app`                |
| `dasher_api.restore_dashboard_as_new`                   | `dasher_security_definer`  | `dasher_app`                |
| `dasher_retention_api.initialize_operator_context`      | `dasher_retention_definer` | `dasher_retention_operator` |
| `dasher_retention_api.materialize_dashboard_expiry`     | `dasher_retention_definer` | `dasher_retention_operator` |
| `dasher_retention_api.place_dashboard_legal_hold`       | `dasher_retention_definer` | `dasher_retention_operator` |
| `dasher_retention_api.release_dashboard_legal_hold`     | `dasher_retention_definer` | `dasher_retention_operator` |
| `dasher_retention_api.claim_dashboard_cleanup`          | `dasher_retention_definer` | `dasher_retention_operator` |
| `dasher_retention_api.record_dashboard_cleanup_attempt` | `dasher_retention_definer` | `dasher_retention_operator` |
| `dasher_retention_api.purge_dashboard`                  | `dasher_retention_definer` | `dasher_retention_operator` |

The initializer's catalog identity additionally freezes `provolatile = 'v'`,
`prosecdef = true`, owner `dasher_retention_definer`, and exact hardened
`proconfig` search path `pg_catalog`. Catalog tests reject `STABLE`/`IMMUTABLE`,
missing/extra settings, or any wrapper/body path that performs a pre-gate
authority read.

There are no overloads. Task 8A freezes each identity's exact ordered PostgreSQL
argument types and return columns in the static migrator/catalog test matrix
before canonical SQL is authored. Inputs are closed typed scalars or bounded
typed arrays/composites with named fields; no `jsonb` operation envelope,
variadic argument, default argument, `record` return, or caller-selected action
is permitted. The migration must match that already-reviewed identity matrix;
discovering a signature from the migration is not review.

The operator initializer derives the operator service principal, scope, and
capability revision only from the latest exact-binding allowlist revision
selected by ordinary `SELECT` after the binding-derived advisory gate is held;
no tuple lock, membership, or ambient role-name inference is authority. Its
operation inputs are a typed `target_dashboard_id` locator, bounded request/case
data, and the exact capability required for the immediately following fixed
retention operation. It accepts no organization, actor, role, privilege,
SQL/relation, or arbitrary predicate. The dashboard ID is a locator, not
authority, and the initializer returns no row, organization, count, or
existence result. Every `0003` retention operation is rooted at that exact
dashboard; its operation-specific hold/claim/finalizer IDs are accepted and
locked only after the derived organization gate and full `authorized` context.
Every retention entry revalidates the exact bound principal revision, phase,
organization/dashboard, and capability under the same still-held operator
gate. `0003` provisions no production login or principal: the PostgreSQL gate
uses a temporary exact login plus migration-owner-seeded synthetic allowlist
revision and removes both in `finally` through same-gate owner cleanup.
Production enrollment requires a later operations/security review.

Each accepts only operation data, expected revisions/epochs, application-
supplied IDs, current CSRF proof where required, request/audit IDs, and bounded
provenance. It derives organization/actor/authority from context. No function
accepts an organization selector, role, actor, audit action/outcome, relation,
schema, SQL, provider, credential, arbitrary expiry timestamp, or delete
predicate. Exact `GRANT EXECUTE` goes only to the intended role and all
`PUBLIC` execution is revoked.

Hold, hold release, cleanup-step completion, and purge are separate operator or
retention entry points. They are not granted to `dasher_app`, app login,
organization admin, or the general security definer. Organization admin approval
of promotion and restore remains an application function; legal hold does not.

All mutation functions capture/revalidate current session, CSRF for sensitive
operations, authority revision, policy revision, lifecycle revision, and
database time inside their own locked body. Repository prechecks improve UX but
are never authority.

## Lifecycle and audit semantics

`0003` replaces `audit_events_action_check` only through the forward migration,
preserving every existing action and adding a closed lifecycle set:

- `dashboard.promotion_requested`, `dashboard.promotion_approved`, and
  `dashboard.promotion_denied`;
- `dashboard.expired`, `dashboard.archived`, `dashboard.unarchived`, and
  `dashboard.deleted`;
- `dashboard.restored_as_new`, `dashboard.cleanup_started`, and
  `dashboard.purge_eligible`;
- `dashboard.legal_hold_placed`, `dashboard.legal_hold_released`, and
  `dashboard.purged`; and
- `dashboard.artifact_created`.

The lifecycle-event kind check is independently closed to `head_activated`,
`head_advanced`, `promotion_approved`, `archived`, `unarchived`, `expired`,
`deleted`, `cleanup_started`, `purge_eligible`, `legal_hold_placed`,
`legal_hold_released`, and `purged`. The transition table is the exact mapping
between those kinds and audit actions. Creation writes existing
`dashboard.created` but no revision-zero lifecycle event. Restore-as-new writes
`dashboard.restored_as_new` for the new revision-zero dashboard but no lifecycle
event. Promotion request/denial writes its request/decision record and fixed
audit only; approval owns the one dashboard lifecycle transition.

The immutable legacy action name `dashboard_head.promoted` means only a
validated working-head compare-and-swap. It is not Scratch-to-Board lifecycle
promotion, Published status, or audience authority. New lifecycle promotion
uses the fixed request/approval actions above.

This is the final complete addition to the existing action list;
`dashboard.cleanup_completed` and `dashboard.reference_claims_released` are not
added because purge owns the only destructive completion/release transition. A
wildcard, general details JSON, caller-selected action, or arbitrary outcome is
forbidden. Successful lifecycle mutations increment once and append both the
revision-unique lifecycle event and fixed audit event in the same transaction.
Hold placement/release follows that rule without changing lifecycle state or
epochs, thereby invalidating stale cleanup revisions. Cleanup lease/retry
updates append attempt history only. Audit remains a success ledger under
`0001`; cleanup attempts hold bounded failure outcomes.
No event includes source/spec bytes, email, token, digest, prompt, credential,
raw error, or arbitrary details. Purge retains only the bounded audit/hash/
tombstone fields approved for 365 days and honors an active hold.

## Expiry, work cancellation, cleanup, and restore procedure

Product access is revoked by the database predicate at the exact inclusive
boundary even if no scheduler runs. An expiry scanner only materializes state,
sets locked `access_revoked_at`/reason and
`purge_after = access_revoked_at + 24 hours`, increments lifecycle revision and
both epochs once, cancels/fences work, creates the tombstone, cleanup
coordination, and `access_revoked` backup-ledger entry, and appends exactly the
expired event/audit for what is already inaccessible. Explicit delete performs
the same revocation setup with the deleted event/audit. Duplicate materializer
work is idempotent.

Workers reauthorize:

1. when claiming work;
2. immediately before and after every external call;
3. before and after retry or wait; and
4. immediately before artifact, head, or cache commit.

Each check includes authority/policy revision, lifecycle state/revision,
effective expiry, capability epoch, cache epoch, source authority, and budget.
Expiry or deletion cancels new work immediately. Existing workers get at most a
15-minute cooperative lease-drain interval; cleanup then proceeds without
waiting on a network-spanning transaction. A stale result is discarded and
recorded, never attached to a head/cache/artifact.

Cleanup attempt schedule is immediate, 5 minutes, 30 minutes, 2 hours, 12 hours,
then daily. Alert after three failures or one hour, whichever is first. After
seven days require operator reconciliation.

`claim_dashboard_cleanup` derives its action from locked state; callers do not
select a target state. After drain/cancellation proof it changes
`access_revoked -> quarantined` with exactly one revision increment and the
cleanup-started event/audit. Before `purge_after`, every quarantine attempt is
non-destructive as defined above. At locked time `>= purge_after`, exact expected
revision and no active hold permit `quarantined -> purge_eligible` with exactly
one revision increment and purge-eligible event/audit. Lease ownership,
heartbeats, retries, and proof preparation that do not cross either boundary
change no lifecycle revision/state and append only cleanup-attempt history.

`purge_dashboard` accepts only `purge_eligible`. It sets `purge_started_at`
in a first fixed coordination transaction before destructive work; that
coordination update does not change lifecycle state/revision and appends attempt
history. Later fixed invocations release only the source dashboard's access-
bearing claims and apply reference-aware finalizers/deletes in bounded
transactions. The final transaction requires the exact final-claim/deletion
proof, writes the final tombstone proof plus `purged` backup-ledger entry, sets
`purged_at`/`cleaned`, increments lifecycle revision once, and appends exactly
the purged lifecycle event/audit. A crash or proof/audit failure leaves
`purge_eligible`, may retain truthful `purge_started_at`, never sets `purged_at`
or cleaned, and retains resumable finalizer/attempt state; retry derives
progress idempotently from database truth. Access stays revoked throughout.

Restore scope is exactly one selected immutable source version, not an entire
parent DAG. `restore_dashboard_as_new` accepts the source revoked/quarantined
dashboard, selected source version, collision-checked new dashboard ID and new
version ID, expected source lifecycle revision, current CSRF/request IDs, and
bounded provenance. It is allowed only at locked time `< purge_after`, before
`purge_started_at`, while the source version and its exact snapshot/evidence
links remain reconstructable under valid claims, and after fresh admin, source,
policy, and evidence authority checks. An active hold neither authorizes nor
denies restore; normal checks still apply, and a hold-only preservation copy is
never a restore source.

In one transaction restore creates a born-durable `draft` Board with null
expiry/head, its own new opaque tombstone lineage,
`restored_from_tombstone_lineage_id` set to the source lineage, and lifecycle/
capability/cache values zero. It copies exactly the selected immutable version
into one new version with no parent, copies only that version's exact snapshot/
evidence links, creates the new access-bearing claims before source claims can
later be released, and writes `dashboard_restore_lineage` with the new IDs,
source lineage/opaque source-version ID, policy, actor, and database time. It
copies no parent DAG, schedule, capability, cache, lease, publication, hold, or
claim ownership and does not mutate the source/tombstone. It writes fixed
`dashboard.restored_as_new` and no revision-zero lifecycle event. A later normal
validated head CAS activates the restored draft.

At/after `purge_after`, after `purge_started_at` or purge, with missing links, a
hold-preservation copy, or forged/cross-tenant IDs, restore returns the same
non-leaking denial. The UI labels it “Restore as new” and never implies the
original became accessible.

## Backup resurrection procedure contract

Backups are encrypted and inaccessible to runtime roles. Dasher targets removal
of backup sets from its recoverability paths within 35 days; provider physical-
media deletion is separately evidenced. `0003` supplies only the tenant-ordered
`backup_deletion_ledger` export seam; it does not invent, operate, or claim an
external sealed manifest/system. A stale database backup can contain a stale
copy of that ledger, so `0003` alone cannot prove deletion reapplication.

Production backup resurrection is fail-closed and on HOLD until a separately
reviewed operations mechanism exports and independently seals monotonically
ordered ledger entries newer than every restorable content snapshot. That
mechanism must prove sequence freshness, reapply/re-delete every later revoked
or purged lineage before traffic, re-run current expiry/purge eligibility,
reconcile holds without restoring access, prove fixed projections deny the
deleted material, and record independent operator/provider evidence. Until it
exists and passes rehearsal, a restored environment remains isolated, may not
serve traffic, and cannot count as pilot recovery evidence. The 35-day age-out
remains a Dasher product/recoverability target, not backup-deletion or provider
physical-media evidence.

## Agent harness contract for the later `0004+` plan

The later plan must consume, not reopen, these ADR-005 decisions.
None of the run, budget, expression, checkpoint, outbox, or metering relations
in this section belongs in `0003`.

### Deterministic orchestration, history, and replay

Deterministic orchestration does not promise deterministic model output. Replay
walks append-only ordered events and consumes immutable recorded model/tool
results; it never calls a model or tool again expecting an identical answer. A
new call is a new metered attempt or new run.

The later ledger has an append-only ordered event relation as authority plus
mutable rebuildable run projections and checkpoints. Run creation pins policy,
code, expression-schema/registry, field-catalog snapshot, tool-manifest,
provider/model, and input digests; `evaluation_time` is explicit. Each event
contains run-local sequence, current `lease_epoch`, canonical payload hash, and
previous-event hash. The internal hash chain is mutation evidence only; an
attacker who can rewrite the full store could rewrite the chain. External
signed/WORM anchoring is separately gated and must not be claimed from the
internal hashes.

Every worker acquisition atomically increments a monotonic `lease_epoch`; a TTL
lease alone is not a fence. Every event/result/checkpoint, artifact/head/cache
commit, budget reserve/reconcile/release, and outbox dispatch supplies and
atomically revalidates the current epoch. Stale workers may record only through
a fixed rejected-stale path that cannot consume authority or commit output.
Provider/tool dispatch and result capture use idempotency keys where supported.
External work may be impossible to cancel, but its acceptance and every local
commit remain lease/lifecycle/capability fenced.

### Aggregate defaults and ceilings

| Tier              | Candidate work            | Specialists | Reviewers | Tools | Model calls | Repairs | Tokens | Time | Cost  |
| ----------------- | ------------------------- | ----------- | --------- | ----- | ----------- | ------- | ------ | ---- | ----- |
| Suggest           | 2 candidates              | 1           | 1         | 0     | 5           | 1       | 30k    | 45s  | $0.15 |
| Governed draft    | 3 candidates              | 2           | 1         | 4     | 8           | 2       | 80k    | 120s | $0.50 |
| Governed refresh  | 1 primary + 1 replacement | 1           | 1         | 4     | 6           | 2       | 50k    | 90s  | $0.25 |
| Administrator max | 4 candidates              | 3           | 2         | 8     | 12          | 3       | 160k   | 240s | $2.00 |

These numbers are Dasher private-pilot product policy, not external standards.
Ceilings are aggregate per run. Concurrency is two active runs per organization,
one per dashboard, and one provider call at a time per run. Immutable run limits
have separate reserved, used, and released counters. Candidate generation and
independent review receive partitioned allocations; retry/fallback cannot spend
reviewer capacity and there is no automatic borrowing. No running expansion is
allowed. A human policy change starts a new run. Specialists/reviewers have zero
tools and cannot spawn or recurse.

Every actual attempt counts: successful, failed, timed out, repaired, fallback,
candidate, specialist, and reviewer. The ledger meters:

- per-tool attempts and tool-specific pages, rows, raw bytes, egress,
  subprocesses (pilot ceiling zero), and concurrency;
- input/output/reasoning/cache-write/cache-read/total token categories;
- integer micros or nanos in one pinned versioned base currency, never binary
  floating cost;
- wall time and working time; and
- expression source/AST/input/output bytes, nodes/depth, literal/list lengths,
  scanned rows, groups/group size, intermediate/output cardinality/bytes,
  evaluator steps, wall time, and memory.

Before any paid/external call, one fenced transaction resolves exact provider/
model and versioned price-book digests, conservatively estimates worst case,
reserves every relevant counter, appends `attempt_reserved`, and commits. Only
then may the outbox/provider dispatcher run. Response and usage are persisted,
then a fenced transaction reconciles reserved capacity into used and released
counters. Unknown price or token estimation denies. A timeout after dispatch is
billing-indeterminate and retains its reservation until provider reconciliation
or explicit quarantine-expiry/operator policy. Retry/fallback requires a new
reservation and all checks; it never reuses/release-assumes the prior attempt.

Retry remains limited to one transient transport error. At 80% the run stops
exploration and finishes from existing evidence. Hard invariant failures fail;
usefulness, clarity, diversity, and latency alone may be soft. An incompletely
reviewed/ranked candidate cannot be promoted.

### Closed expression and ranking seam

The implementation is a strict discriminated JSON AST inspired by CEL typing,
not unrestricted CEL or JSON Logic source. Each operation has one JSON Schema
2020-12 schema with required fields and `additionalProperties: false`. Unknown
operation/key/schema-version/registry-version/field/literal fails. The accepted
record pins `schema_version`, `registry_version`, stable
`field_catalog_snapshot_id`, `input_snapshot_id`, `evaluation_time`,
`timezone_database_version`, all declared limits, and canonical accepted-AST
hash.

Field references contain stable `field_id`, never free-form paths. The pinned
catalog records type, nullability, unit, currency, grain, event-time, and
freshness. Registry v1 is exactly typed field/literal; bounded
select/filter/group; `count_rows`/`count_present`/sum/min/max/mean; checked
add/subtract/multiply/divide; abs/clamp;
comparison/exact-boolean/conditional/coalesce; bounded sort/rank/top-k;
lag/delta/percentage-change/time-window; explicit versioned unit conversion;
explicit missing/null/unavailable-error/stale classification; and explicit
rounding/decimal scale.

Exact numbers/money are integer minor units or canonical decimal coefficient/
scale strings. Every rounding and scale change is explicit. Binary-float money,
NaN/infinity, overflow, or hidden intermediate rounding fails. Conditions are
exact booleans and branches match type/unit/currency/grain. Missing, explicit
null, unavailable/error, and stale remain distinct. `count_rows` counts rows;
`count_present` counts non-missing/non-null values. Empty counts are zero, typed
sum is exact zero, and min/max/mean return explicit `empty_input` missing.

There is no general reduce, unrestricted distinct, code, SQL, regex, dynamic
path/function, implicit join, recursion, or unbounded cardinality. Sort/top-k
requires an explicit stable tie key and bounded literal `k`. Lag/window requires
partition keys, unique total order, event time, and bounded frame. Fixed
duration differs from calendar period. Unit conversion handles affine units;
currency remains a separate immutable-rate-snapshot, evidence-linked FX
operation.

Hard declared caps cover source/AST bytes, nodes/depth, literals/list lengths,
scanned rows, groups/group size, intermediate/output bytes/cardinality,
evaluator steps, wall time, and memory. Static type/unit/cost/cardinality
analysis precedes execution and runtime metering enforces the same limits. CEL
termination alone is not evidence of acceptable cost. The later `0004+` plan
must lock numeric cap values before evaluator implementation.

Hard validity precedes deterministic ranking for evidence coverage, task
coverage, accessibility, clarity, freshness, and compliant cost/latency. Ties
use canonical content hash. Model output cannot waive validity or authority.
The Standard manager flow shows the recommended result; materially distinct
valid alternatives remain behind `Compare alternatives`; human acceptance is
required. Auto-promotion remains off. Governed refresh produces a private
candidate and preserves the prior head.

### Trust and product relations reserved for `0004`

The separately accepted `0004` trust/run plan adds outward relations, never
nullable speculative columns on `0003` rows:

- Versioned `MetricContractVersion` in `metric_contract_versions` plus
  `dashboard_version_metric_contracts` bindings. A contract
  records business owner, data owner, definition, aggregation and denominator,
  units/currency, good/bad direction, threshold/target, grain, expected lag,
  freshness SLO, allowed dimensions, calendar/timezone, lineage, and reviewed
  status. Bindings identify the exact contract version used by an immutable
  dashboard version.
- Stable `claims` and `claim_evidence` relations. Each Claim has one ADR-005
  semantic label and stable identity; each evidence edge is exactly `supports`,
  `contradicts`, or `context`. Every candidate/version gets an immutable
  evidence manifest with coverage, contradiction, freshness, and unsupported
  state in `evidence_manifests`. `0003` evidence records remain support
  artifacts.
- A typed `briefs` relation plus one frozen, content-addressed candidate
  evidence bundle shared by
  all bounded candidates in a comparison. Candidates may differ in judgment or
  composition, not silently receive different factual inputs.
- A `publications` relation pointing only to an immutable Board version
  and recording audience, publication policy/revision, reviewer, human decision,
  and publication time. The working head may advance while the prior good
  publication remains audience-visible. Publication never mutates the version
  or Board lifecycle.
- An immutable `semantic_change_receipts` row from old version to new version.
  It lists
  both changed and explicitly unchanged metric, filter, grain, unit, date,
  source, calculation, encoding, layout, and Claim sets, plus recomputation and
  external-effect summaries. Manual and agent edits both create a child version
  and receipt; prompts never overwrite manual work.
- A typed `run_abstentions` row with at least
  `needs_source_selection`, `missing_governed_metric`, `incompatible_grain`,
  `stale_snapshot`, `insufficient_evidence`, `blocked_by_policy`,
  `calculation_failed`, `unsupported_capability`, `budget_exhausted`, and
  `partial_result`. Each carries a safe explanation, retryability, and next
  step. It never fabricates a plausible fallback value or recommendation.
- The governed run/event/checkpoint/lease/outbox/budget contract already defined
  in this section, with foreign keys/hashes attaching through the stable `0003`
  identifiers.

`0004` still adds no Decision Snapshot, Recipe, alert dispatch, external action,
channel/collaboration system, generated code/SQL, or product canvas tables.

### Passwordless is a separate forward migration

The later identity plan uses a built-in issuer with opaque stable subject and
email only as verified delivery binding. It specifies 32-byte magic-link
secrets, HMAC digests, single use, 10-minute expiry, and one active challenge per
email/organization/purpose with replacement invalidation. Generic limits are
5/email+organization/15m, 60/IP/hour, and 200/organization/hour.

GET does not consume. Same-origin POST exchanges under no-store, no-referrer,
strict CSP, and no third party. Exchange revalidates invitation/binding,
membership/revision, organization policy, expiry, and replay. Matching email
never links identities. External-IdP-required organizations fail closed.
Sensitive admin authentication age is at most 15 minutes; existing session
limits stay 30-minute idle and 7-day absolute. None of this belongs in `0003`.

### Staged lab gates

1. Authenticated synthetic fixture lab: no database/live provider/customer data.
2. Synthetic passwordless control plane after its migration/security review.
3. Fake-agent/replay inspectable lab after lifecycle/run-plan acceptance.
4. Capped live smoke only after gateway, budget, revocation, and kill switch.

Do not claim any stage deployed unless current tracked evidence establishes it.

## Authoritative adversarial PostgreSQL matrix

All rows run with forced RLS using owner, app login/`dasher_app`, general
definer, operator/retention authority, two organizations, and at least two users
per applicable role. Race proof uses observed lock ownership/waiters and explicit
barriers, never elapsed time. Every started promise gets handlers before a
barrier is released and settles before client reuse.

| Area                | Required cases and invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Policy/TTL creation | Concurrent first creates under the existing organization gate produce exactly one deterministic revision-1 policy row (`86400`, retention revision `1`, fixed provenance), lock/reselect it, and create `draft` dashboards. Presets 1h/24h/7d/30d pass; arbitrary seconds/timestamps and out-of-range values deny. No policy-admin mutation exists.                                                                                                                                                                                                                                                                                                                                                                            |
| Expiry boundary/lag | Just before expiry reads pass; exact boundary and after deny every dashboard/head/version/source/evidence/artifact projection and count even before scanner runs. Late scanner is idempotent and cannot restore access. Disposable schedule creation always denies.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Initial/head state  | Create for both kinds yields null head, revision/epochs zero, `draft`, create audit, and no lifecycle event. First validated head CAS is the sole `draft -> active`; later CAS is `active -> active`; both increment revision once with exact head event and legacy audit. Archived/cleanup CAS and invalid/null heads deny.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Raw child access    | Direct table select/count and fixed child projection by forged ID deny after expiry/delete, across tenants, with forged/stale context, and after pool reuse. No raw viewer grant bypasses the dashboard claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Promotion/expiry    | Run both lock-winner orders and exact boundary. Only an active disposable with validated non-null head, approved request, exact revision, and locked time before expiry promotes active-to-active; draft/archived/cleanup/stale deny. Promotion increments all three fences once; expiry-first/boundary wins and denies. Event/audit failure fully rolls back.                                                                                                                                                                                                                                                                                                                                                                 |
| Durable lifecycle   | Active durable archive and archived unarchive each increment lifecycle/capability/cache once with exact event/audit. Archived remains accessible but head/refresh read-only. Delete maps draft/active/archived to revoked with exact timestamps/fences/tombstone/ledger. Durable-to-disposable and implicit authority changes deny.                                                                                                                                                                                                                                                                                                                                                                                            |
| Publication meaning | Catalog and projection assertions prove no publication relation/state/grant exists in `0003`; working head, `active`, archive, head CAS, and Scratch-to-Board promotion never return or imply Published/audience authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Retention bypass    | Catalog/function tests prove decision, Recipe, alert, bookmark, pin, share, link, publication, or missing future table cannot create a Scratch access/retention claim, extend expiry, survive revocation, or preserve dashboard-owned bytes. Only approved independent shared-resource claims and bounded audit/tombstone policy remain.                                                                                                                                                                                                                                                                                                                                                                                       |
| Evidence semantics  | `dashboard_version_evidence` resolves only revision-level provenance. No schema/function/projection labels evidence records as semantic Claims or reports claim-level completeness before the later Claim/ClaimEvidence/evidence-manifest relations exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Hold/purge          | Placement/release each increments lifecycle revision once without state/epoch change and creates/removes only that hold's retention claims. Multiple holds coexist. Hold-first invalidates stale cleanup and blocks eligibility/purge; purge-first returns `already_purged`. Unauthorized/stale/event/audit failures roll back without access restoration.                                                                                                                                                                                                                                                                                                                                                                     |
| Restore             | Strictly before `purge_after`/`purge_started_at`, restore exactly one selected immutable version as a new durable draft with null head/expiry, new lineage, one parentless version, exact links, access claims created first, lineage mapping, revision/epochs zero, audit only. Active hold is neutral; hold-copy, boundary/purge, missing/forged/cross-tenant links deny.                                                                                                                                                                                                                                                                                                                                                    |
| Shared references   | Access claims forbid hold IDs; retention claims require an active same-tenant hold ID. Multiple holds create distinct per-resource claims; release removes only its own. Purge releases only source-dashboard access claims and deletes shared bytes only after no access/retention claim or active hold remains. Cross-tenant/fake claims deny.                                                                                                                                                                                                                                                                                                                                                                               |
| Cleanup crashes     | Prove revoked->quarantined and quarantined->purge-eligible state-derived transitions/events. Before boundary, attempts only fence/evict/prepare and cannot release/delete/start purge. Inject crashes through purge finalizers/proofs/event/audit; failure remains purge-eligible without `purged_at`/cleaned lie and retries idempotently on the fixed schedule.                                                                                                                                                                                                                                                                                                                                                              |
| In-flight fences    | Expire/delete/promote/archive during claim, external call, retry, wait, artifact commit, head CAS, and cache commit. Stale lifecycle revision/capability/cache epoch always rejects result. Show no network-spanning DB transaction and 15m cooperative lease limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tenant attacks      | Same UUID in another tenant, forged dashboard/version/snapshot/evidence/artifact/hold IDs, composite-FK attacks, count/oracle attempts, manual GUCs, stale membership/session, and denied-pool reuse disclose nothing and mutate nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Operator bootstrap  | Exact wrapper begins READ COMMITTED and calls the VOLATILE initializer first for authority. With a harmless pre-gate query established, a disabling writer holds the binding gate, appends/commits, and releases; the waiting initializer's distinct post-gate query gets a fresh snapshot, sees latest-disabled, and denies without fallback. Initializer-first binds the old revision only for its gate-held transaction, revalidates it on every fixed call, and blocks the writer until transaction end. Explicit REPEATABLE READ/SERIALIZABLE, wrong/omitted BEGIN, prefilled context, STABLE/IMMUTABLE catalog mutation, pre-gate allowlist read/cache, tuple-lock SQL, and UPDATE grant/policy all deny/fail inventory. |
| Role boundaries     | Discovery/prefix precedes exact prepared-role bootstrap. Both roles are exact NOLOGIN/NOINHERIT/NOBYPASSRLS with null passwords/settings; residue/retry/reset paths close. Exactly two bootstrap SELECT policies exist; all ordinary policies and mutation triggers require exact current user plus full authorized principal/revision/capability/organization/dashboard context. Every append/revocation/test-seed/owner-cleanup writer takes the same binding gate; cleanup requires no active initializer. App/general cannot assume the role; no bootstrap mutation, generic DML, pre-gate tenant lock, cross-org operation, or non-READ-COMMITTED retention transaction passes.                                           |
| Audit/events        | Every transition matches the closed table/event/audit mapping. Creation and restore audit without revision-zero lifecycle events; request/denial do not mutate dashboard lifecycle; lease retries use attempt history. Event/audit collision or revoked privilege rolls back all transition/claim/ledger changes without secret/raw-SQL leakage.                                                                                                                                                                                                                                                                                                                                                                               |
| Backup resurrection | `backup_deletion_ledger` appends ordered revocation/purge entries, but no test invents a sealed external manifest. Any restored environment remains isolated and HOLD without independently sealed entries newer than its content snapshot and a separately reviewed re-delete mechanism; 35-day target is not evidence.                                                                                                                                                                                                                                                                                                                                                                                                       |

The same gate additionally proves:

- retention bootstrap denies absent/stale/forged or other-session bindings,
  duplicate revision, malformed predecessor/hash chain, latest-disabled state,
  missing capability, fallback to an older enabled revision, a third bootstrap
  policy, provisional-context mutation, pre-gate authority read, pre-gate tenant
  lock, and discovery beyond the exact dashboard. Explicit barriers prove a
  pre-gate READ COMMITTED query does not pin the later post-gate snapshot,
  initializer-first and disabling-writer-first orders under the shared binding
  gate, and exact REPEATABLE READ/SERIALIZABLE denial before allowlist authority
  access. Synthetic seed/cleanup take that gate, cleanup proves no active
  initializer, full-context promotion/revalidation follows the organization
  gate, and test state is removed;
- organization policy selection observes both lock-winner orders and cannot use
  an unlocked highest revision; first-create lazy seed serializes and later
  policy mutation is absent;
- only the two source-kind values and byte lengths pass DDL, while repository/
  route tests prove no raw-byte admission path exists and make no content-
  sensitivity claim;
- hold/release captures independent hold/case/authority/actor/reason/audit data,
  direct row mutation denies, and only equally privileged release changes the
  active marker while append-only events remain;
- deletion intent/finalizer survives crashes, quarantine is non-destructive,
  and purge byte deletion occurs only with transactional final-claim proof;
- tombstone/restore-lineage/backup-ledger tenant FKs, indexes, RLS, sequences,
  and catalog inventory are exact; and
- backup recovery remains isolated/HOLD until the external export/seal and
  re-delete mechanism is reviewed; age-out and provider deletion stay separate.

PostgreSQL tests additionally assert TTL scheduler indexes, FK indexes, exact
constraints, relation-bound policies/triggers, non-leaking projection returns,
and all denial SQLSTATE/message normalization. The test suite must prove prior
`0001` invitation/session/membership behavior still passes on the evolved
`0001 -> 0002 -> 0003` schema; replacement-only tests are insufficient.

## Migrator and immutable-prefix contract

Task 8A expands the migrator's validated-prefix model before canonical `0003`
is authored. A validated `0002` prefix continues to allow only the existing
sixteen general-definer functions and grants. The pending `0003` successor
allowlist statically names every new schema object, function identity signature,
owner, role, table/column privilege, function execute grant, policy, and
expanded ACL dependency—including the separate retention owner/capability—and
nothing else. Mechanically selectable PostgreSQL argument/return types, catalog
identities, managed comments, and fixture IDs freeze in Task 8A's static matrix,
not in this prose.

The runner order is fail-closed and differs from the current bootstrap order:

1. Acquire the migrator advisory lock; discover canonical files; validate exact
   filenames/checksums and the contiguous journal/schema prefix before any role
   creation.
2. Conditionally bootstrap exactly `dasher_retention_definer` and
   `dasher_retention_operator` in one separate pre-SQL transaction only when the
   canonical exact-checksum `0003` file is present and pending and journal/schema
   are the exact validated `0002` prefix.
3. Revalidate the exact prepared pair, then run the same canonical `0003` SQL and
   journal insertion transaction. SQL creates no role.

Both prepared roles must have the exact Task 8A-frozen comments and flags:
managed `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`, password null, no role settings,
no memberships, and no premature ownership/ACL/default-ACL or other dependency.
If canonical `0003` SQL fails after bootstrap, the pair may remain as the sole
accepted `0002 + prepared-0003-roles` residue because PostgreSQL role creation
committed separately. Rerun accepts only that exact pair with the same pending
canonical checksum and exact `0002` journal/schema, then retries the same SQL.
One missing role, any extra/drifted role/flag/comment/membership/dependency,
absent or drifted `0003`, or any other premature successor object fails before
SQL. This narrow prepared phase is not adoption.

Reset to pure `0002` is an explicit owner-only operation. It first proves exact
`0002` journal/schema, the exact dependency-free prepared pair, and absence of a
successful/pending-different `0003`; it may then drop only that pair. The
migrator never automatically drops, repairs, adopts, or silently rolls back
prepared roles.

The inventory asserted before pending SQL and after migration/journal insertion
includes:

- role existence, exact managed comments/flags/password-null state, incoming and
  outgoing memberships, role settings, owned objects, and cluster-visible
  `pg_shdepend` ownership/ACL dependencies;
- database/schema/default ACLs and exact expanded grantor/grantee privileges;
- relation/type/sequence/index/constraint/trigger/policy ownership and shape;
- function OID, schema, identity arguments, return, language, volatility,
  `SECURITY DEFINER`, owner, `search_path`, body properties, and ACL;
- app login's existing sole current-database `CONNECT` and `dasher_app`
  membership; and
- exact migration journal sequence, filename, checksum, and applied owner.

The runner otherwise retains contiguous-prefix/no-adoption semantics. Missing
journal plus any managed schema/object is an adoption conflict. A gap, rename,
checksum drift, unknown pending file, old-prefix dependency, premature `0003`
object other than the exact prepared pair, extra role/grant, or exact-object
mismatch fails before SQL. After successful SQL, any missing or extra successor
dependency rolls back migration and journal together; only the already-committed
prepared pair may remain. No “discover and bless current state” path is added.

Golden tests keep immutable byte hashes for `0001` and `0002` and add the final
`0003` hash only when its one-shot bytes are accepted. The authoritative
PostgreSQL gate explicitly migrates a validated `0002` database to `0003`, a
clean database through all three, accepts/retries only the exact prepared-role
residue after injected SQL failure, and rejects drift in every path.

## Research inputs and portability limits

These primary sources supply mechanics and analogies, not broad compliance
claims. Product/service documentation is not a standard, certification, or
evidence that Dasher implements the documented system.

- Temporal's [workflow definition](https://docs.temporal.io/workflow-definition),
  [event history](https://docs.temporal.io/workflow-execution/event),
  [activity](https://docs.temporal.io/activity-definition), and
  [safe deployment](https://docs.temporal.io/develop/safe-deployments) docs
  motivate replay from recorded events rather than re-running nondeterministic
  external work, idempotent activity dispatch, and pinned/routed worker-code
  changes. Dasher adopts those mechanics in its own ledger; it does not claim
  Temporal equivalence or use.
- The [CEL overview](https://cel.dev/overview/cel-overview) informs parse/check/
  evaluate separation and typed host-controlled functions. CEL-Go's
  [program options](https://github.com/google/cel-go/blob/master/cel/options.go)
  demonstrate runtime cost/interrupt/limit controls. Dasher adopts a smaller
  strict JSON AST and both static and runtime limits, not CEL source or a claim
  that CEL termination guarantees cheap evaluation.
- [JSON Schema 2020-12 validation](https://json-schema.org/draft/2020-12/json-schema-validation)
  supplies required-property and closed-object validation mechanics.
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) supplies canonical JSON
  mechanics for stable AST/event payload hashing. [RFC 9557](https://www.rfc-editor.org/rfc/rfc9557)
  informs distinguishing an instant/offset from named-zone rules; Dasher also
  pins its timezone-database version.
- [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final)
  informs the caveat that cryptographic erasure depends on media/key design and
  verified treatment of every relevant key copy. The EDPB's
  [2025 coordinated erasure report](https://www.edpb.europa.eu/our-work-tools/our-documents/other/coordinated-enforcement-action-implementation-right-erasure_en)
  informs restored-system erasure tracking, while the ICO's
  [right-to-erasure guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)
  informs separately governing backup copies and reapplying erasure when data
  returns to a live system. These inputs do not establish legal compliance.
- Google Cloud's [data deletion](https://cloud.google.com/docs/security/deletion)
  documentation is a transparent example of separating logical deletion,
  backup expiry, and physical-media processes; it is not Dasher's provider
  promise. CNCF Distribution's
  [garbage collection](https://distribution.github.io/distribution/about/garbage-collection/)
  and Kubernetes
  [finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
  provide engineering analogies for reachability, deletion intent, and delayed
  removal after references/finalizers clear.
- Provider token-counting documentation, including Anthropic's
  [token counting](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)
  and Google Cloud's
  [CountTokens](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/get-token-count),
  can inform conservative estimates but cannot replace Dasher's stronger atomic
  admission/reservation contract. Kubernetes
  [ResourceQuota](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
  and AWS SDK
  [retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
  are analogies for admission ceilings and retry/request-rate token buckets,
  not agent-budget standards.
- [OWASP AISVS](https://github.com/OWASP/AISVS) and the
  [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
  are informative security/risk inputs only. They are not certifications,
  conformance claims, or substitutes for this plan's exact PostgreSQL,
  lifecycle, expression, replay, and budget evidence.

## Sequenced implementation tasks

Each task is deliberately reviewable and gets one commit on the later
implementation branch. These commit instructions do not authorize commits in
this docs-only slice.

### Documentation gate: exact-tree dual review

Scope exactly:

- `docs/architecture/ADR-005-agentic-dashboard-harness.md`
- `docs/plans/2026-07-30-product-spine.md`
- `docs/plans/2026-08-01-dashboard-lifecycle-and-agent-harness.md`
- `docs/product/PRODUCT_REQUIREMENTS.md` only for the concise locked lifecycle,
  product grammar, and 30-second interaction contract
- `packages/dashboard-schema/src/gate-contracts.test.ts` only for the exact
  durable-document clause guard

Run:

```sh
set -eu

pnpm exec prettier --check \
  docs/architecture/ADR-005-agentic-dashboard-harness.md \
  docs/plans/2026-07-30-product-spine.md \
  docs/plans/2026-08-01-dashboard-lifecycle-and-agent-harness.md \
  docs/product/PRODUCT_REQUIREMENTS.md \
  packages/dashboard-schema/src/gate-contracts.test.ts
pnpm exec vitest run packages/dashboard-schema/src/gate-contracts.test.ts

git diff --cached --check
expected_staged_paths="$(
  printf '%s\n' \
    'docs/architecture/ADR-005-agentic-dashboard-harness.md' \
    'docs/plans/2026-07-30-product-spine.md' \
    'docs/plans/2026-08-01-dashboard-lifecycle-and-agent-harness.md' \
    'docs/product/PRODUCT_REQUIREMENTS.md' \
    'packages/dashboard-schema/src/gate-contracts.test.ts' |
    LC_ALL=C sort
)"
actual_staged_paths="$(git diff --cached --name-only | LC_ALL=C sort)"
test "$actual_staged_paths" = "$expected_staged_paths"
test -z "$(git diff --name-only)"
test -z "$(git ls-files --others --exclude-standard)"

test "$(sed -n '/^Status:/p' docs/security/GENERATED_CODE_GATE.md)" = \
  "Status: CLOSED"
test "$(sha256sum packages/control-plane/migrations/0001_identity_audit.sql | cut -d' ' -f1)" = \
  'd44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a'
test "$(sha256sum packages/control-plane/migrations/0002_security_boundary.sql | cut -d' ' -f1)" = \
  '395fb6fe5eb3802a86c64ff7d55a31f677edc79a45666ddd5d0237af122a47b9'

candidate_tree="$(git write-tree)"
candidate_diff_sha256="$(git diff --cached --binary --full-index | sha256sum | cut -d' ' -f1)"
printf 'candidate_tree=%s\ncandidate_diff_sha256=%s\n' \
  "$candidate_tree" "$candidate_diff_sha256"
```

Expected pass: formatting, focused guard, and staged-diff checks are clean; the
staged paths equal the exact five-path list; unstaged and untracked paths are
empty; generated-code status is `CLOSED`; immutable hashes equal this plan; and
the candidate tree and staged-diff hash are recorded.
Expected failure/hold: any other path, unresolved ADR decision, change to an
immutable hash, implied implementation/deployment claim, or reviewer finding.

The gate covers all five changed paths independently. The focused durable-
document guard reads and mutation-tests exact clauses from each of the four
changed documents, explicitly including the historical product-spine plan. The
guard implementation path is separately bound by the literal staged allowlist,
formatting, focused test execution, and code review. The shell allowlist above
is external to the guard's contract data; the guard never defines or approves
its own allowed scope.

Obtain two reviews on the same recorded staged candidate tree and staged-diff
hash: first product/lifecycle/spec compliance, then PostgreSQL security and
retention design. Any byte edit, restaging change, or candidate-tree/diff-hash
change invalidates both reviews. After commit, the controller re-verifies that
the committed `HEAD^{tree}` equals the accepted candidate tree and that
`git status --porcelain=v1` is empty. Acceptance of that exact tree is the
prerequisite for the implementation branch.

### Task 8A: migrator allowlist and prefix tests before `0003`

Files:

- Modify `packages/control-plane/src/migrator.ts`
- Modify `packages/control-plane/src/migrator.test.ts`
- Modify `packages/control-plane/src/canonical-migrations.test.ts`
- Modify `packages/control-plane/test/postgres.integration.test.ts`
- Create dedicated noncanonical fixtures under
  `packages/control-plane/test/fixtures/migrations-0003-allowlist/`

Work:

1. Add red tests for exact `0002`, the modeled `0003` successor inventory, and
   file/journal/schema discovery and validation before conditional role
   bootstrap. Fixtures exercise catalog logic but are never copied into
   canonical migrations.
2. Refactor runner order to acquire the migrator gate, validate canonical exact-
   checksum files and exact prefix, then bootstrap the exact prepared retention-
   role pair in one pre-SQL transaction only for pending `0003`.
3. Freeze the pair's exact comments/flags/password-null/settings/membership and
   dependency-free prepared inventory. Test first bootstrap, exact residue after
   injected canonical-SQL failure, same-file retry, partial/extra/drifted role,
   absent/drifted file, premature dependency, and owner-only exact-pair reset.
4. Freeze the static `0003` object/function/argument/return/catalog/ACL/policy
   matrix, including the exact typed dashboard-rooted initializer inputs,
   `NOBYPASSRLS` definer authority, and exactly two bootstrap `SELECT` policies:
   self-binding allowlist lookup and single-dashboard target discovery. Freeze
   exact `VOLATILE SECURITY DEFINER` identity, `provolatile = 'v'`, hardened
   `proconfig`, mandatory exact READ COMMITTED check, reserved-context-empty
   check, binding-derived advisory-gate key, and isolation-check -> gate ->
   distinct post-gate ordinary-SELECT body order with no authority read/cache
   before the gate. Freeze all-revision/latest-revision-regardless-enabled
   selection, predecessor/hash validation, latest-disabled/capability denial
   with no fallback, absence of tuple-lock SQL and runtime allowlist
   UPDATE/DELETE grants/policies, and the same-gate requirement for synthetic
   seed/cleanup and every future writer. Reject stable/immutable catalog drift
   and wrapper/body paths that pin or pre-read authority visibility. Barrier
   tests establish a harmless pre-gate query, cover initializer-first and
   appended-disable-first, later-call revalidation while the initializer holds
   the gate, and cleanup only after no initializer is active.
   Freeze their SELECT-only columns/predicates, provisional/full phase keys,
   non-observable denial behavior, and shutdown after promotion to full
   `authorized` context; freeze ordinary policies to that full exact principal/
   revision/capability/organization/dashboard context, exact per-relation
   privileges, and unassumable role closure. Do not infer inventory from live
   objects, add a third bootstrap policy, or broaden semantics.
5. Freeze implementable trigger assertions over exact owner/current-user,
   full authorized phase/context/capability, expected revision, allowed
   `OLD`/`NEW`, and column deltas; forbid bootstrap mutation, call-stack
   inspection claims, and dynamic SQL.
6. Preserve no-adoption, contiguous prefix, owner/app-login checks, lock-first
   ordering, rollback/release, and secret-safe diagnostics. An unexpected
   canonical `0003` still fails until its exact static successor inventory is
   present.

Commands:

```sh
pnpm exec vitest run \
  packages/control-plane/src/migrator.test.ts \
  packages/control-plane/src/canonical-migrations.test.ts
pnpm exec prettier --check packages/control-plane/src/migrator.ts \
  packages/control-plane/src/migrator.test.ts \
  packages/control-plane/src/canonical-migrations.test.ts \
  packages/control-plane/test/postgres.integration.test.ts
git diff --check
```

Expected red before implementation: new successor/prepared-prefix tests reject
the current order and unmodeled `0003` inventory. Expected green after: exact
pure-`0002`, prepared-role residue/retry/reset, and successful successor
inventories pass; every partial/extra/drift/adoption case denies; existing
`0001`/`0002` golden and unit tests remain green. PostgreSQL runtime cases remain
pending for Task 8D, not falsely claimed here.

Expected commit: `test(control-plane): lock 0003 managed-role inventory`

### Task 8B: one-shot lifecycle-safe `0003`

Files:

- Create `packages/control-plane/migrations/0003_immutable_content.sql` once
- Modify `packages/control-plane/src/canonical-migrations.test.ts`
- Modify `packages/control-plane/test/postgres.integration.test.ts` only for
  migration/catalog cases that Task 8D will complete

Work:

1. Write the complete relational contract, constraints, indexes, forced RLS,
   fixed projections/mutations, app/general/retention ownership split, exact
   grants, immutability/purge triggers, and closed audit expansion in one file.
   Include the revisioned retention principal/capability allowlist, two-value
   source-kind check, byte-length-only admission honesty, hold release-only
   mutation, transition table, lazy policy seed, tombstone/restore-lineage/
   backup-ledger relations, hold-provenanced claims, and deletion-intent/
   finalizer state. SQL creates no role. Add no agent-run, metric, semantic
   Claim, evidence-manifest, publication, Decision Snapshot, Recipe, alert,
   bookmark/share, or product-UI table.
2. Add its accepted SHA-256 to the golden test. Never use a partial canonical
   file as a test fixture.
3. Assert exact functions/ACL/catalog inventory and fixed bodies: qualified
   references, no dynamic SQL, pinned `pg_catalog` search path, no arbitrary
   selectors, and audit/lifecycle writes last.
4. Validate clean `0001 -> 0002 -> 0003`, predecessor `0002 -> 0003`, and exact
   `0002 + prepared-0003-roles -> 0003` retry paths. Prove injected SQL/catalog/
   ACL/journal failure leaves exact `0002` journal/schema plus only the accepted
   dependency-free prepared pair; all tenant SQL/journal changes roll back.
5. Keep canonical inline bytes synthetic/public-only and enforce bounds and
   classification checks in DDL.

Commands:

```sh
pnpm exec vitest run \
  packages/control-plane/src/canonical-migrations.test.ts \
  packages/control-plane/src/migrator.test.ts
pnpm exec prettier --check \
  packages/control-plane/src/canonical-migrations.test.ts \
  packages/control-plane/test/postgres.integration.test.ts
git diff --check
sha256sum packages/control-plane/migrations/0001_identity_audit.sql \
  packages/control-plane/migrations/0002_security_boundary.sql \
  packages/control-plane/migrations/0003_immutable_content.sql
```

Expected red before migration: canonical sequence/inventory tests require the
reviewed `0003` and fail. Expected green after: all three exact identities pass,
`0001`/`0002` hashes are unchanged, forbidden source/credential/provider
patterns are absent, and modeled catalog inventory matches the new SQL. Full
runtime/race acceptance waits for Task 8D.

Expected commit: `feat(control-plane): add lifecycle-safe immutable content schema`

### Task 8C: lifecycle repository and fixed projections

Files:

- Create `packages/control-plane/src/dashboard-lifecycle-repository.ts`
- Create `packages/control-plane/src/dashboard-lifecycle-repository.test.ts`
- Create `packages/control-plane/src/dashboard-lifecycle-types.ts`
- Modify `packages/control-plane/src/index.ts`
- Modify `packages/control-plane/src/public-exports.test.ts`
- Modify `packages/control-plane/test/postgres.integration.test.ts`

Work:

1. Add strict public input/output types for presets, kinds/states, revisions,
   projection shapes, policy lazy seed result, promotion, archive/delete,
   selected-version restore-as-new, and fence-aware CAS. Expose no source-byte
   ingestion, arbitrary expiry, policy-admin mutation, or operator hold/purge API
   from the app package.
2. Implement the existing pinned transaction wrapper sequence: begin, immutable
   `initialize_context` (which retains the organization gate), one fixed call,
   commit with established rollback-and-release. Repository code performs no
   direct table DML and no network work inside.
3. Map normalized database denial/conflict to bounded repository errors without
   resource-existence, SQL, constraint, or raw-server leakage.
4. Test revision-zero draft creation/restore, first/later head CAS, promotion
   preconditions, archived read-only behavior, exact output fields, stale fences,
   audit rollback, prior-head preservation, no schedule/authority widening,
   pool reuse, and the absence of operator functions from public exports.
5. Add fixed manager/admin projection tests for above-fold summary, one-click
   revision-level evidence support, second-click lineage seams, visible expiry,
   working-head/version identity, freshness, cleanup status, and shared versus
   dashboard-owned labels. Prove no projection calls head/active/promotion
   Published, reports claim-level evidence, or creates retention through a
   future product noun.

Commands:

```sh
pnpm exec vitest run \
  packages/control-plane/src/dashboard-lifecycle-repository.test.ts \
  packages/control-plane/src/public-exports.test.ts \
  packages/control-plane/src/session-repository.test.ts \
  packages/control-plane/src/invitation-repository.test.ts
pnpm --filter @dasher/control-plane typecheck
pnpm exec prettier --check packages/control-plane/src
git diff --check
```

Expected red before repository: new lifecycle public-contract tests have no
implementation. Expected green after: repository uses only fixed functions,
normalized denials do not leak existence, prior identity/session repository
tests remain green, and typecheck/format pass. No route, worker, schedule, or
provider is added.

Expected commit: `feat(control-plane): add fenced dashboard lifecycle repository`

### Task 8D: authoritative PostgreSQL lifecycle gate

Files:

- Modify `packages/control-plane/test/postgres.integration.test.ts`
- Modify `packages/control-plane/test/postgres-harness.ts` only for bounded,
  reusable lock/fault/role helpers
- Modify `packages/control-plane/package.json` only if the existing
  `test:postgres` command cannot select the expanded same serial gate; do not
  add another integration entry point without review

Work:

1. Implement every row of the adversarial matrix, using deterministic fixture
   IDs, database-controlled boundary setup, lock observers, and injected event/
   ACL failures.
2. Assert exact three-prefix migration/catalog/role/function/ACL inventory and
   both migration paths. Run predecessor invitation/session/membership cases on
   the evolved schema.
3. Exercise app/owner/general-definer/retention boundaries, final-reference
   purge/finalizer, multiple holds and release-only mutation, locked policy
   revision selection, synthetic retention-principal binding/revision/capability
   denial, exact retention READ COMMITTED wrappers and direct isolation denials,
   VOLATILE post-gate visibility in both disabling-writer race orders, cleanup
   crash steps, raw-byte admission absence, and fixed projection non-leakage.
4. Assert the append-only backup-deletion-ledger schema/export ordering and that
   any restored environment remains isolated. Do not rehearse or claim
   production deletion reapplication until the separately reviewed external
   export/seal mechanism exists; its absence is the expected HOLD.
5. In `finally`, restore injected grants/constraints, remove synthetic data in
   approved owner order, close pools, terminate/drop the invocation login, and
   prove only three migration journal rows and the exact managed nonlogin
   roles/schema remain. Prepared-residue tests separately prove exact owner-only
   reset; no backend or test login survives.

Commands:

```sh
pnpm test:postgres
pnpm --filter @dasher/control-plane test
pnpm --filter @dasher/control-plane typecheck
pnpm exec prettier --check packages/control-plane/test \
  packages/control-plane/src
git diff --check
```

`pnpm test:postgres` requires the already-documented synthetic PostgreSQL 16
environment and is the sole authoritative database command. Expected red before
matrix completion: missing catalog/race/fence/reference/role assertions fail.
Expected green after: every matrix row and additive predecessor test passes,
cleanup proves no residue, and ordinary tests/typecheck/format pass. Timeout,
truncation, unhandled rejection, cleanup residue, or skipped matrix case is
HOLD, never “mostly green.”

Expected commit: `test(control-plane): enforce lifecycle and retention races`

### Task 8E: exact-head review and PR gate

Files: no planned product/schema changes; only review evidence permitted by the
accepted contribution process. Any source edit restarts Task 8E.

Work:

1. Freeze and record exact HEAD/tree, all migration filenames/checksums,
   PostgreSQL server/image identity already required by repository CI, role and
   catalog inventory hashes, test counts, and cleanup proof in a redacted
   self-binding artifact.
2. Run the repository's complete required verification on that head, including
   format, lint, typecheck, ordinary tests, build, Playwright, audits,
   PostgreSQL gate, generated-code exact status, diff check, credential scan,
   and clean worktree. This plan adds no CI/package change merely to restate
   existing commands.
3. Obtain exact-head spec/security review first and code-quality review second.
   Review specifically signs off the adversarial matrix, function/ACL inventory,
   inline-byte limitation, and no `0004+` scope leakage.
4. Open the implementation PR only from that reviewed clean head. Require exact-
   head CI. Any rebase/edit invalidates evidence and reviews.

Expected pass: exact identities bind all green evidence and both reviews have no
blocker/important finding. Expected HOLD: dirty tree, wrong hash, skipped test,
wrong PostgreSQL identity, catalog/cleanup residue, leaked marker, timeout,
truncation, review mismatch, or generated-code status other than `CLOSED`.

Expected commit: none; this is a review/PR gate.

## Separately gated follow-on work

### `0004+` agent ledger and calculations

A new accepted plan must name its migration/repository/fake-provider/replay
files, encode the aggregate budgets and primitive registry above, and test:

- authoritative append-only ordered events, rebuildable mutable projections/
  checkpoints, all pinned digests and `evaluation_time`, canonical payload/
  previous-event hashes, and explicit internal-hash-chain limitations;
- monotonic worker `lease_epoch` acquisition and stale-epoch rejection on every
  event/result/checkpoint, artifact/head/cache commit, reserve/reconcile/release,
  and outbox dispatch, including uncancellable external completion;
- immutable limits with separate reserved/used/released counters, partitioned
  generation/review allocations, every actual attempt/resource category,
  versioned base-currency integer cost, and per-run/org/dashboard/provider-call
  concurrency races;
- reserve-and-commit before dispatch, exact provider/model/price-book resolution,
  response/usage reconciliation, indeterminate-timeout quarantine, unknown-
  estimation denial, fresh retry/fallback reservation, 80% finish behavior, no
  expansion, one transient retry, and specialist/reviewer no-tools/no-recursion;
- replay that consumes recorded model/tool results without redispatch,
  idempotency-key use where supported, and safe code/policy version routing;
- strict discriminated JSON-AST schema closure, pinned catalog/input/timezone/
  limits/hash, stable field IDs, exact decimal/money/null/aggregate/window/unit/
  FX semantics, static cost/cardinality analysis, and runtime hard-cap meters;
- MetricContractVersion completeness/bindings; stable typed Claims and
  support/contradiction/context edges; immutable per-candidate/version evidence
  manifests; and one frozen common evidence bundle for candidate comparison;
- typed Briefs, typed abstention without plausible fallback, publication only
  to a valid reviewed Board version, prior-publication preservation when the
  working head advances, and no publication/active/head/promotion conflation;
- insert-only manual/agent semantic edits and old-to-new change receipts that
  enumerate changed and unchanged semantic/presentation/source dimensions plus
  recomputation/external-effect summaries;
- hard validity before rank, canonical-hash ties, distinct-alternative UX, and
  manual acceptance with prior-good-head preservation; and
- exact budget/metering/denial/recurring-upper-bound administrator projections.

No live provider or auto-promotion is authorized by that migration. Routine
data-only auto-update remains a later opt-in plan with the unchanged-source/
structure/calculation/semantic/audience/policy invariants from ADR-005.

### `0005` decision and operating-loop plan

A separately accepted `0005` plan may add:

- an immutable Decision Snapshot capturing the exact evidence manifest,
  filters, MetricContractVersions, values, freshness, rationale, selected action,
  actor, authority/policy revisions, and decision time. Only a human records a
  decision; correction appends an amendment/superseding snapshot and never
  rewrites the original;
- a Recipe binding reviewed source authority, metric-contract versions,
  calculation graph, parameter schema/values, assertions, evidence manifest,
  reviewer, policy/budget revisions, and expiry. It fails closed on source,
  contract, graph, assertion, evidence, policy, or budget drift and neither
  schedules itself nor widens authority;
- a unified typed change/health timeline and edge-triggered alert/action
  proposals. Operational Events are context, not causality; a draft sends
  nothing, and every external dispatch/action requires a separate live
  capability plus human confirmation.

No future Decision Snapshot, Recipe, alert, action proposal, channel, bookmark,
pin, share, or link creates Scratch retention or survives its access revocation.

### UI-only/future product work

The three-pane Compose experience, native declarative canvas, Trust Rail,
component-merge UI, audience-safe lenses/recipient preview, registry/duplicate/
retirement, and channels/collaboration/digests remain UI/future plans. They do
not add `0003` tables or authorize generated SQL/code/shell/packages/network,
editable code cells, chain-of-thought audit, confidence-as-correctness, partial
Scratch promotion, Scratch renewal/persistence/schedules/surviving links,
automatic publication/actions, proximity causality, or dashboard clones.

### Passwordless forward migration

A separate identity/security plan must name and test the built-in issuer,
challenge/HMAC tables, rate-limit coordination, non-consuming GET, same-origin
POST, CSP/header contract, fresh-admin-auth check, external-IdP-required denial,
replay and replacement races, generic response, and no-email-linking. It may not
modify `0001`/`0002` or be folded into dashboard `0003`.

## Measurable stage gates

### Pre-`0003` documentation/schema gate

- Product grammar is normative; Published, working head, and `active` are
  distinct in prose, function/projection contracts, catalog assertions, and
  adversarial cases.
- Stable outward IDs/hashes and minimum version/freshness/expiry/ownership/
  lineage projection seams exist without future product/UI tables.
- No decision/Recipe/alert/bookmark/pin/share/link bypasses Scratch expiry or
  retention, and revision-level evidence is never reported as Claim-level
  provenance.
- The exhaustive lifecycle table, lazy revision-1 policy seed, immutable-`0002`
  app lock order, exact READ COMMITTED/VOLATILE staged operator bootstrap and
  post-gate visibility order, exactly two bootstrap SELECT policies, ordinary
  full-context RLS/trigger authority, prepared-role prefix, quarantine/purge
  boundary, restore lineage, hold-derived claims, and backup export/HOLD
  contract are frozen before Task 8A.

### `0004` synthetic trust/run gate

- Every material Claim in fixtures has a complete typed path through component,
  calculation, MetricContractVersion, ClaimEvidence, evidence record, and
  snapshot; partial/contradicted/stale/unsupported state remains visible.
- Every manual/agent semantic mutation creates an insert-only version and
  semantic change receipt. Typed abstention is safe and contains no plausible
  fallback.
- Bounded candidates share one frozen evidence bundle. Publication accepts only
  a valid reviewed Board version with complete high-salience evidence and
  preserves the prior good publication when the working head advances.
- The gate has no network or model-provider dispatch/inference and no generated
  SQL/code, shell, package, or editable-code-cell path.

### `0005` fake-agent/decision gate

- One fixture reconstructs Brief -> plan -> candidate -> independent review ->
  publication -> human Decision Snapshot -> Recipe using exact IDs, revisions,
  hashes, evidence manifests, events, and receipts.
- Approval and idempotency outcomes are exact; decisions are immutable with
  append-only amendments; Recipes fail closed and cannot widen authority or
  schedule themselves; alerts are edge-triggered.
- Partial, contradicted, stale, unsupported, blocked, or failed work never
  reports complete and is never publishable.

### Live private-pilot gate

- A timed manager exercise answers Known, Changed, Important, Next safe action,
  and Evidence within 30 seconds and reaches evidence/technical lineage in no
  more than two interactions.
- There are zero unauthorized tools/sources, policy bypasses, and unsupported
  published high-salience Claims; revocation, stale-worker, budget, deletion-
  replay, and kill-switch incident drills pass on the exact environment.
- External sends, schedules, exports, write-back, and other side effects remain
  separately disabled and gated.

## Acceptance checklist

The `0003` implementation plan is satisfied only when all are true:

- the historical minimal DDL remains visibly superseded and unimplemented;
- docs exact-tree dual review preceded implementation;
- `0001`/`0002` exact bytes and additive behavior remain unchanged;
- migrator allowlist tests preceded one-shot `0003`; discovery precedes the
  conditional prepared-role transaction, exact residue/retry/reset semantics
  pass, and prefix/no-adoption rejects every drift case;
- Workspace/Scratch/Board/Published/Decision Snapshot/Recipe grammar is
  normative; working head, `active`, promotion, and publication remain distinct;
- lifecycle control and the exhaustive transition/event/audit table, promotion,
  cleanup, multiple holds,
  revision-level version-evidence links, explicit reference/retention claims,
  fixed projections, audit actions, epochs, and reference-aware purge all exist
  in `0003` without semantic Claim/publication/decision/Recipe tables;
- the revisioned `retention_service_principal_allowlist`, exact non-ambient
  operator mapping, `NOBYPASSRLS` prepared roles, the sole self-binding
  allowlist and single-dashboard discovery bootstrap SELECT policies,
  provisional-to-authorized context promotion after the derived organization
  gate, exact READ COMMITTED retention wrappers and isolation denial,
  binding-derived reader/writer advisory serialization, VOLATILE distinct
  post-gate snapshot visibility, ordinary non-locking latest-revision selection
  with latest-disabled denial, ordinary exact current-user/full-context
  policies, implementable OLD/NEW trigger predicates, forced RLS/catalog/ACL
  inventory, synthetic-only same-gate test seed/cleanup, and future production-
  enrollment review boundary exist;
- organization lifecycle policy lazily seeds deterministic revision 1 under the
  existing organization gate, and policy/retention-principal selection occurs
  only after the exact app gate/policy-row locks or operator binding gate/
  ordinary allowlist SELECT, respectively;
- expiry/delete is database-authoritative and child access cannot bypass it;
- promotion produces only a private Board working head, and no publication,
  decision, Recipe, alert, bookmark, pin, share, or link extends Scratch TTL or
  content retention;
- app/general definer cannot delete or hold; separate retention authority has
  only fixed predicates and no login/generic delete;
- hold rows change only through equally privileged fixed release, with
  independent opaque hold/case/authority/actor/reason/audit provenance; only
  active holds create retention-only claims and release touches only its hold;
- source kind/length checks are described only as shape constraints, and no raw-
  byte route exists before the separate content classification/admission gate;
- quarantine is non-destructive; purge-eligible finalizers and transactional
  final-claim proof protect shared bytes; tombstones, one-version restore
  lineage, and backup-deletion ledger use tenant-keyed opaque lineage and all
  hashes/pseudonyms remain governed;
- access revocation, logical recovery expiry, cryptographic unrecoverability,
  and physical-media deletion remain separate evidence milestones; no inline-
  byte, day-35 physical deletion, customer-data, or object-storage claim is made;
- production backup resurrection remains isolated/HOLD until a separately
  reviewed external export/seal and re-delete mechanism proves entries newer
  than every restorable snapshot; `0003` alone and the 35-day target are not
  recovery/deletion evidence;
- the complete PostgreSQL adversarial matrix and predecessor tests pass with
  deterministic cleanup; and
- `0004+` locks event replay/hash limitations, lease epochs, hard reservation/
  reconciliation budgets, and strict expression semantics without adding those
  tables to `0003`; passwordless, live provider, schedules, customer data,
  deployment, and generated code remain separately gated.

Any omission is HOLD before `0003` bytes freeze. There is no “minimal now,
secure later” exception.
