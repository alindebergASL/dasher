# Invite-Only Multi-Tenant Product Spine Implementation Plan

> **For Hermes:** Implement this plan task by task with one active writer. Require
> spec-compliance review before security/code-quality review.

**Goal:** Build Dasher's Gate 2-A durable product spine: invite-only identity,
PostgreSQL-enforced tenant isolation, race-safe sessions and invitations,
immutable synthetic source/evidence/dashboard records, compare-and-swap
promotion, and append-only atomic audit.

**Architecture:** Add a provider-neutral `@dasher/control-plane` TypeScript
package backed by PostgreSQL 16 and immutable raw SQL migrations. The web/API
process connects through a restricted login, explicitly assumes the
`NOBYPASSRLS` `dasher_app` role, and invokes fixed service operations. Every
authenticated mutation runs in one transaction whose context is initialized
from a live session digest and whose membership and session are revalidated
under locks before commit, except the two invitation-family authenticated entry
functions that take and revalidate explicit live session proof so they can
acquire their family advisory lock before any row lock. Direct app DML is
read-only; reviewed, operation-specific functions own all mutations and their
audit writes.

**Tech stack:** Node 22, TypeScript 5.9, pnpm 10.14, ESM, `pg`, Zod, Vitest,
PostgreSQL 16, and a digest-pinned GitHub Actions PostgreSQL service.

---

## Scope and authorization boundary

This plan implements **Gate 2-A**, not all of roadmap Gate 2. It uses only
synthetic organizations, identities, source metadata/bytes, evidence, and
dashboards. Object storage and signed URLs, backup/restore operations,
retention/deletion operations, jobs, live ingestion, external OAuth transport,
provider credentials, connectors, MCP, public/unlisted publication, real
customer data, and production deployment remain blocked.

Passing or merging this slice does not authorize real data, a deployment, a
pilot, or any later gate. Gate 2's remaining object-storage, backup/restore,
retention/deletion, job, kill-switch, and incident-control evidence must pass
separately before Gate 2 is claimed.

Hard invariants:

- There is no public signup or implicit organization bootstrap.
- Canonical migrations contain no login password, HMAC key, deploy credential,
  real email, or real customer data.
- UUIDs are supplied by trusted application/test code; no identifier extension
  is required.
- Every customer-owned row has a non-null `organization_id`; every tenant
  crossing foreign key includes it.
- Every tenant table uses both `ENABLE ROW LEVEL SECURITY` and
  `FORCE ROW LEVEL SECURITY`. Global identity tables are also forced-RLS with
  no app policy or direct app grant.
- Login and runtime roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION NOBYPASSRLS`. The sole exception is the dedicated,
  non-login, least-privilege function owner defined below.
- No app-callable arbitrary user/organization/revision context setter exists.
  Authenticated context is initialized only by presenting a valid session
  digest, and the RLS predicate rebinds every context value to that live
  session and membership.
- Invite, session, and CSRF secrets contain exactly 32 random bytes. Only
  versioned HMAC-SHA-256 digests are stored. Keys remain outside PostgreSQL and
  are explicitly injected into domain code.
- External identity is immutable `(issuer, subject)`, never email. Email is
  used only as a verified invitation-acceptance assertion.
- Stored invitation role is authoritative. Invitations never change an
  existing membership's role.
- Source snapshots, evidence, dashboard versions, version-snapshot links, and
  audit events are insert-only. The sole dashboard mutation is null-safe
  compare-and-swap of its head.
- A security-sensitive mutation and its fixed audit event either both commit
  or both roll back.
- The repo-wide generated-code tripwire remains green and
  `docs/security/GENERATED_CODE_GATE.md` remains exactly `Status: CLOSED`.

## Planned files

- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/src/index.ts`
- Create: `packages/control-plane/src/types.ts`
- Create: `packages/control-plane/src/crypto.ts`
- Create: `packages/control-plane/src/context.ts`
- Create: `packages/control-plane/src/database.ts`
- Create: `packages/control-plane/src/migrator.ts`
- Create: `packages/control-plane/src/invitations.ts`
- Create: `packages/control-plane/src/sessions.ts`
- Create: `packages/control-plane/src/dashboards.ts`
- Create: `packages/control-plane/src/*.test.ts`
- Create: `packages/control-plane/migrations/0001_identity_audit.sql`
- Create: `packages/control-plane/migrations/0002_security_boundary.sql`
- Create: `packages/control-plane/migrations/0003_immutable_content.sql`
- Create: `packages/control-plane/test/fixtures/migrations/*.sql`
- Create: `packages/control-plane/test/postgres-harness.ts`
- Create: `packages/control-plane/test/postgres.integration.test.ts`
- Create: `packages/control-plane/test/preflight.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

No implementation task modifies ADR-003, the roadmap, security-status
documents, or the generated-code gate.

---

## Closed database contract

### Roles, ownership, and the only `BYPASSRLS` exception

The owner DSN's actual `session_user` is the migration owner. It owns the
database, `dasher_meta`, `dasher`, and their tables, but it is never used by
runtime code. Migrations reject `SET ROLE`, an owner that equals either managed
role, an owner without required DDL authority, or execution as the app login or
`dasher_app`.

Before applying migration SQL, the owner connection runs a fail-closed
cluster-role bootstrap and prefix-aware dependency validation under the fixed
migration advisory lock:

1. `dasher_app` must be absent or already carry the exact shared comment
   `dasher:managed-role:v1:app`. If absent, create it as `NOLOGIN NOINHERIT
NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD
NULL` and add that comment. If present without the exact comment, with any
   differing flag, password verifier, outgoing membership, non-allowlisted
   incoming member or membership option, owned object, or unexpected grant,
   abort. Never alter or adopt it.
2. `dasher_security_definer` follows the same rule with comment
   `dasher:managed-role:v1:security-definer` and flags `NOLOGIN NOINHERIT
NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD NULL`.
   It has no incoming or outgoing role-membership edge. It owns no schema,
   table, sequence, type, or database; it owns only the allowlisted
   `SECURITY DEFINER` routines from `0002` and `0003`, and receives only their
   explicit table/column privileges.
3. `dasher_security_definer` is the one explicit exception to the
   `NOBYPASSRLS` runtime rule. Forced RLS makes a privileged pre-auth invite or
   session lookup otherwise impossible. The role cannot log in, cannot create
   anything, owns no data, and gains authority only when an allowlisted,
   fully-qualified function body executes.
4. A known managed role may be reused only when its exact marker, flags,
   memberships, ownership allowlist, and grants match the journal state.
   Cluster-global roles are not treated as installed merely because a
   per-database journal exists.

`dasher_app` is never a member of any role. Its only permitted incoming
membership edges are from the exact role names in
`expectedAppLoginRoleNames`, an explicit preflight-derived, duplicate-free
array supplied to the migrator from app-DSN configuration. It is normally the
singleton array containing the exact app DSN username and may be empty before
an app login is provisioned. The migrator API carries role names only; it never
accepts, carries, or logs a login password or DSN.

Every supplied expected login name must exist and have exactly `LOGIN
NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, a
present SCRAM-SHA-256 password verifier, no role settings, no owned object in
any database, and no direct grant anywhere except `CONNECT` on the current
database. Its exact comment is
`dasher:app-login:v1:database-oid:<current_database_oid_decimal>`, where the
suffix is the decimal OID returned for the migrator's current database. It has
exactly one `pg_catalog.pg_auth_members` edge: it is a member of `dasher_app`
with `inherit_option = false`, `set_option = true`, and `admin_option = false`.
The catalog query projects only a boolean for verifier presence and exact
`SCRAM-SHA-256$` prefix; verifier text never leaves PostgreSQL and is never
returned or logged. Its complete cluster-visible `pg_shdepend` inventory has no
ownership row and exactly the ACL dependency represented by that explicit
current-database `CONNECT`; the migrator resolves and compares the expanded
database ACL rather than trusting the dependency row alone. An absent expected
login, duplicate or unexpected name, wrong database marker, wrong
flag/verifier/setting, ownership, other grant or dependency, additional
incoming or outgoing edge beyond its one membership in `dasher_app`, or wrong
edge option is `managed_role_drift`.

Task 4 modifies `packages/control-plane/src/migrator.ts` and its unit and
PostgreSQL integration tests before introducing immutable `0002`. In every
migrator transaction the first statements are `BEGIN`, `SET LOCAL search_path =
pg_catalog`, and the fully qualified fixed advisory-lock call. No executor,
journal, role, dependency, or other catalog query and no migration SQL runs
before that local search path and lock are in force.

Managed-role validation then:

1. validates the immutable role flags, exact markers, password state, settings,
   managed-login allowlist, and membership rules before interpreting any
   dependency;
2. validates the journal shape and exact contiguous source/checksum prefix;
3. derives from that validated prefix—not merely discovered files or current
   objects—the closed allowlist of every permitted ownership and ACL
   `pg_catalog.pg_shdepend` row for `dasher_app` and
   `dasher_security_definer`, resolving each dependency to the corresponding
   object, subobject, owner, and expanded ACL privilege/grantor in the ordinary
   PostgreSQL catalogs; and
4. compares the complete cluster-visible ownership/ACL dependency inventory to
   that allowlist, together with the exact expanded ACL entries represented by
   those dependencies, before pending SQL and again against the
   successor-prefix allowlist after pending SQL/journal insertion but before
   commit.

The prefix inventories are exact:

- absent journal, empty prefix, and validated `0001` permit no managed-role
  ownership or ACL dependency in any database;
- validated `0002` permits only ownership of the exact sixteen Task 4
  `SECURITY DEFINER` functions and only the exact database, schema, function,
  table, and column grants specified by the Task 4 signature/ACL matrices; and
- when Task 8 introduces `0003`, it first expands the migrator allowlist by the
  exact `0003` function ownership and grants, while preserving the complete
  `0002` inventory.

A missing or extra dependency, a dependency in another database, an unexpected
shared/global object, a wrong object OID/kind/schema/signature/column/privilege,
or ownership/grant inconsistent with the validated prefix is
`managed_role_drift` and aborts before later SQL. Prefix validation never
weakens the zero-dependency checks before `0002`; it replaces only the
impossible blanket-zero rule after a migration intentionally adds an exact
allowlisted dependency.

Every `SECURITY DEFINER` routine:

- is owned by `dasher_security_definer`;
- is SQL or PL/pgSQL with `SET search_path = pg_catalog`;
- references every non-catalog object by schema-qualified name;
- contains no dynamic SQL and accepts no relation, schema, SQL, actor,
  organization, user-authority, arbitrary-role, audit-action, or audit-outcome
  selector. The only role-valued operation data are the closed-enum
  `requested_role` input to `issue_invitation` and `new_role` input to
  `change_membership_role`; proposed user or membership UUIDs allocate absent
  rows and never select authority;
- has `REVOKE ALL ON FUNCTION ... FROM PUBLIC` and an exact
  `GRANT EXECUTE ... TO dasher_app`;
- returns only the columns named in this plan; and
- is catalog-asserted for owner, `prosecdef`, language, volatility,
  `proconfig`, identity argument types, result type, and ACL.

The migration owner retains no `EXECUTE` grant through `PUBLIC`; ownership is
its administrative authority. `dasher_app` cannot assume the definer or owner
role.

Every Task 4 `dasher_api` entry function and
`dasher_private.context_allows(uuid, text)` is `LANGUAGE plpgsql VOLATILE
SECURITY DEFINER`. The six no-argument typed context accessors are `LANGUAGE
plpgsql STABLE SECURITY DEFINER`; each returns null rather than raising for a
missing or malformed GUC. All are owned, search-path-pinned, qualified,
non-dynamic, and ACL-closed as above. `dasher_app` has exact `EXECUTE` but no
`USAGE` on `dasher_private`: policies may invoke their already-bound private
helper OIDs, while a direct app or `PUBLIC` call into `dasher_private` is
denied.

### Immutable migration series and no-adoption journal

Canonical filenames match
`^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$`; the four-digit prefix is the
integer sequence. Sequences start at `0001`, are contiguous, and filenames are
unique. Each canonical file is introduced once with its complete contents and
is never edited, reordered, renamed, or deleted after application. A correction
is the next numbered migration. Task 2 tests the runner only with dedicated
fixture migrations, never with a partially authored canonical file.

Under one transaction, the runner first calls
`SET LOCAL search_path = pg_catalog`, then
`pg_advisory_xact_lock(724372, 20260730)`. It then applies this exact adoption
rule:

- If `dasher_meta.schema_migrations` is absent, any existing `dasher` schema,
  `dasher_meta` schema, or object in either namespace is an adoption conflict
  and aborts. A clean database has none of them.
- On a clean database, create `dasher_meta` owned by the migration
  `session_user`, revoke all schema access from `PUBLIC`, and create:

  ```sql
  CREATE TABLE dasher_meta.schema_migrations (
    sequence integer PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9999),
    filename text NOT NULL UNIQUE
      CHECK (filename ~ '^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$'),
    checksum_sha256 bytea NOT NULL
      CHECK (octet_length(checksum_sha256) = 32),
    applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    applied_by name NOT NULL
  );
  ```

- The journal and schema are owned by the migration owner. Revoke all journal
  and `dasher_meta` privileges from `PUBLIC`, `dasher_app`, and
  `dasher_security_definer`; grant none back.
- SHA-256 is computed over exact source bytes. Migration identity is the tuple
  `(sequence, filename, checksum_sha256)`.
- An existing journal is valid only when its rows, ordered by sequence, are an
  exact contiguous prefix of the discovered files and every identity matches.
  An extra row, gap, duplicate, renamed file, wrong prefix, checksum drift,
  malformed table/owner/ACL, or managed object inconsistent with the prefix
  aborts before any SQL runs.
- Apply every pending file and insert its journal row with
  `applied_by = session_user` in the same transaction. Any migration or
  journal-insert failure rolls back the journal creation, all pending schema
  effects, and all pending journal rows.
- Every managed-role and migration transaction uses one rollback-and-release
  protocol. It records whether `ROLLBACK` succeeded. A successful rollback
  permits normal `client.release()`; a rejected rollback requires the
  node-postgres error/force-destroy release form and the client must never
  return to the pool. This applies to failures from `BEGIN`, `SET LOCAL`, the
  advisory lock, role/catalog validation, migration SQL, journal insertion,
  and `COMMIT` or its recovery path. The original migration/transaction failure
  remains authoritative; any rollback failure is retained only as sanitized
  diagnostic or cause information and must not expose SQL, DSNs, credentials,
  or raw server details.

Migration order is load-bearing:

1. `0001_identity_audit.sql` creates identity, tenant, invitation, session, and
   audit tables, constraints, indexes, audit immutability, and base ACLs.
2. `0002_security_boundary.sql` creates context, invite, membership, and
   session routines; enables/forces RLS; creates policies; and applies routine
   and column grants. It exists before any TypeScript mutation operation.
3. `0003_immutable_content.sql` creates source/evidence/dashboard tables,
   immutability, content routines, policies, grants, and CAS promotion.

### Exact identity, tenant, session, and audit DDL

All timestamps are `timestamptz`; all `_id` values are application-supplied
`uuid`; all digests and SHA-256 content hashes are `bytea` of exactly 32 bytes.
All named text checks reject empty/whitespace-only values and C0/C1 controls.
Text lengths below are character lengths. Constraint and index names are the
literal names shown.

- `dasher.users`: `user_id` primary key and `created_at NOT NULL DEFAULT
transaction_timestamp()`. There is deliberately no user email column and no
  email uniqueness. Add no app policy or direct app privilege.
- `dasher.external_identities`: `issuer varchar(512)`, `subject varchar(512)`,
  `user_id NOT NULL REFERENCES dasher.users`, and `created_at`. Primary key
  `external_identities_pkey (issuer, subject)`; unique
  `external_identities_user_key (user_id)` makes Gate 2-A one immutable
  external identity per user. `(issuer, subject)` is never updated or rebound.
  Add no app policy or direct app privilege.
- `dasher.organizations`: `organization_id` primary key, `display_name
varchar(200) NOT NULL`, and `created_at`. There is no app organization-create
  operation in Gate 2-A; synthetic fixtures are owner-seeded.
- `dasher.memberships`: `membership_id` primary key, `organization_id NOT NULL
REFERENCES organizations`, `user_id NOT NULL REFERENCES users`, `role
varchar(16) CHECK (role IN ('admin','editor','viewer'))`, `state varchar(16)
CHECK (state IN ('active','revoked'))`, `authority_revision bigint NOT NULL
CHECK (authority_revision >= 1)`, `created_at`, `updated_at`, and nullable
  `revoked_at`. Unique `memberships_org_user_key (organization_id, user_id)` and
  `memberships_org_membership_key (organization_id, membership_id)`. State and
  `revoked_at` must be mutually consistent.
- `dasher.invitations`: `invitation_id` primary key; `organization_id`,
  `normalized_email varchar(320)`, `granted_role varchar(16)`,
  `role_ceiling varchar(16)`, `token_key_version smallint CHECK
(token_key_version BETWEEN 1 AND 32767)`, `token_digest`, `created_by_user_id`,
  `created_at`, `expires_at`, nullable `accepted_at`, `accepted_user_id`,
  `revoked_at`, and `revoked_by_user_id`. Unique
  `invitations_org_id_key (organization_id, invitation_id)` and
  `invitations_token_key (token_key_version, token_digest)`. Composite creator
  and revoker FKs reference `(organization_id, user_id)` in memberships;
  accepter references users. `expires_at > created_at`; accepted fields are
  both null or both non-null; accepted and revoked cannot coexist. The email is
  the already-normalized Gate 2-A ASCII subset defined below and is not an
  identity key. Immutable `0001`'s `btrim` and `lower` checks are redundant
  guards for that already whitespace-free lowercase ASCII value, not the
  normalization algorithm.
- `dasher.sessions`: `session_id` primary key; `organization_id`, `user_id`,
  `authority_revision >= 1`, session and CSRF `key_version`/`digest` pairs,
  `issued_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`,
  nullable `rotated_from_session_id`, `replaced_by_session_id`, `revoked_at`,
  and `revocation_reason varchar(32)`. Unique
  `sessions_org_id_key (organization_id, session_id)`,
  `sessions_token_key (token_key_version, token_digest)`, and
  `sessions_csrf_key (csrf_key_version, csrf_digest)`. Composite membership FK
  covers `(organization_id, user_id)`; both lineage FKs use
  `(organization_id, session_id)`. Require `issued_at <= last_seen_at <
absolute_expires_at`, `issued_at < idle_expires_at <= absolute_expires_at`,
  distinct predecessor/successor IDs, and consistent revocation fields.
- `dasher.audit_events`: `audit_event_id` primary key; non-null
  `organization_id`; `occurred_at DEFAULT clock_timestamp()`; `actor_kind
CHECK (actor_kind IN ('user','service'))`; nullable `actor_user_id` and
  `actor_service varchar(64)` with exactly one selected; non-null
  `authority_revision`; non-null `request_id`; nullable `job_id`; `action`,
  `target_type varchar(32)`, `target_id uuid`, `outcome CHECK
(outcome = 'succeeded')`; nullable `content_sha256`, `source_ref
varchar(200)`, `provider varchar(64)`, `credential_version varchar(64)`,
  `usage_units numeric(20,6) CHECK (usage_units IS NULL OR (usage_units <>
'NaN'::numeric AND usage_units >= 0))`, `cost_minor_units bigint CHECK (cost_minor_units >= 0)`;
  PostgreSQL `numeric` admits `NaN`, so the usage constraint must reject it
  explicitly before the migration bytes become immutable; finite precision
  already rejects infinities. The table also has non-null `deployment_revision
varchar(64)`. Unique `audit_events_org_id_key (organization_id,
audit_event_id)`.

The fixed Gate 2-A audit action vocabulary is:

`membership.role_changed`, `membership.revoked`, `invitation.issued`,
`invitation.revoked`, `invitation.accepted`,
`invitation.accepted_existing_membership`, `session.issued`,
`session.rotated`, `session.revoked`, `source_snapshot.created`,
`evidence_record.created`, `dashboard.created`,
`dashboard_version.created`, and `dashboard_head.promoted`.

Each operation-specific routine fixes its action, target type, and successful
outcome in its body. Organization, actor/service, authority revision, and
current session are derived from validated authority; request ID is the
explicitly non-authoritative correlation value classified below. Pre-auth
acceptance derives the actor and organization from the locked invitation and
immutable external identity. The app receives no generic audit-insert routine
and cannot supply actor, organization, revision, action, or outcome.

Audit contains no general `details` JSON and never stores invitation/session/
CSRF plaintext or digest, HMAC key/version, email, issuer/subject, cookie,
credential material, prompt/source bytes, raw header, raw error, DSN, or
password. `content_sha256` is only a non-secret content hash. Tests scan both
database rows and captured logs for marker secrets.

### Exact immutable-content DDL

- `dasher.source_snapshots`: `source_snapshot_id` primary key,
  `organization_id`, `source_kind varchar(32)`, `source_ref varchar(200)`,
  `retrieved_at`, nullable `observed_at`, `canonical_bytes bytea NOT NULL CHECK
(octet_length(canonical_bytes) BETWEEN 1 AND 1048576)`, `content_sha256`,
  `storage_version varchar(64)`, `connector_version varchar(64)`,
  `parser_version varchar(64)`, `classification varchar(32)`, `truncated
boolean`, `validation_state varchar(16) CHECK (validation_state IN
('valid','invalid'))`, `created_by_user_id`, and `created_at`. Unique
  `(organization_id, source_snapshot_id)`. These bounded bytes are synthetic
  Gate 2-A fixtures only and are not an upload/object-storage path.
- `dasher.evidence_records`: `evidence_record_id` primary key,
  `organization_id`, `source_snapshot_id`, `claim_kind CHECK (claim_kind IN
('observed','calculated','interpreted','recommended'))`, `coordinates jsonb`,
  `transformation jsonb`, `content_sha256`, retrieval/observation timestamps,
  `created_by_user_id`, and `created_at`. JSON canonical text is limited to
  32 KiB per field. Unique `(organization_id, evidence_record_id)` and
  composite snapshot FK.
- `dasher.dashboards`: `dashboard_id` primary key, `organization_id`,
  `title varchar(200)`, nullable `head_version_id`, `created_by_user_id`, and
  `created_at`. Unique `(organization_id, dashboard_id)`; the composite head FK
  to dashboard versions is `DEFERRABLE INITIALLY DEFERRED`.
- `dasher.dashboard_versions`: `dashboard_version_id` primary key,
  `organization_id`, `dashboard_id`, nullable `parent_version_id`,
  `canonical_spec_bytes bytea CHECK (octet_length(canonical_spec_bytes) BETWEEN
2 AND 1048576)`, `spec_sha256`, `validation_result jsonb`,
  `planner_provenance jsonb`, `created_by_user_id`, and `created_at`. JSON text
  is limited to 64 KiB per field. Unique `(organization_id,
dashboard_version_id)` and `(organization_id, dashboard_id,
dashboard_version_id)`; composite dashboard, parent-version, and actor FKs.
- `dasher.dashboard_version_snapshots`: `organization_id`,
  `dashboard_version_id`, `source_snapshot_id`, and `created_at`; primary key
  `(organization_id, dashboard_version_id, source_snapshot_id)` with composite
  same-tenant FKs to both parents.

Named B-tree indexes cover every FK referencing-column tuple, invitation
`(organization_id, normalized_email, created_at DESC)`, active membership
`(organization_id, user_id, authority_revision)`, live session lookup
`(organization_id, user_id, revoked_at)`, dashboard versions
`(organization_id, dashboard_id, created_at)`, and audit
`(organization_id, occurred_at, audit_event_id)`. Digest uniqueness indexes are
the only digest indexes.

One migration-owner-owned, non-definer trigger function rejects every
`UPDATE` or `DELETE` on source snapshots, evidence, dashboard versions,
version-snapshot links, and audit. App and `PUBLIC` also have no
`UPDATE`, `DELETE`, or `TRUNCATE` privilege on them. Catalog tests assert both
layers; owner-only `TRUNCATE` remains administrative and is not a runtime path.

### Function signatures and minimal returns

`0002` creates these exact app entry points:

- `dasher_api.accept_invitation(smallint, bytea, text, text, text, boolean,
uuid, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text) RETURNS
TABLE
(user_id uuid, organization_id uuid, membership_id uuid, granted_role text,
authority_revision bigint, session_id uuid, idle_expires_at timestamptz,
absolute_expires_at timestamptz)`. Inputs are invite key version/digest,
  issuer, subject, normalized verified email, email-verified flag,
  application-supplied proposed new user ID, proposed new membership ID, new
  session ID, session key-version/digest, CSRF key-version/digest, audit event
  ID, server request ID, and application-config deployment revision, in that
  exact order. The audit event ID and request ID must not be equal. There is no
  caller organization, membership role, expiry, actor, or audit selector.
- `dasher_api.issue_session(text, text, uuid, uuid, smallint, bytea, smallint,
bytea, uuid, uuid, text) RETURNS TABLE (user_id uuid, organization_id uuid,
membership_id uuid, granted_role text, authority_revision bigint, session_id
uuid, idle_expires_at timestamptz, absolute_expires_at timestamptz)`. Inputs
  are issuer, subject, opaque membership ID, new session ID, session
  key-version/digest, CSRF key-version/digest, application-supplied audit event
  ID, server request ID, and application-config deployment revision, in that
  order. The audit event ID and request ID must not be equal. The identity pair
  is verified by the server; the membership must belong to that immutable
  identity and be active. It cannot select an organization directly.
- `dasher_api.initialize_context(smallint, bytea, uuid) RETURNS TABLE
(session_id uuid, user_id uuid, organization_id uuid, membership_id uuid,
authority_revision bigint, idle_expires_at timestamptz,
absolute_expires_at timestamptz)`. Its only authority input is the session
  key version/digest; request ID is non-authoritative. It sets transaction-local
  session ID, session key version, session digest hex, user, organization,
  membership, revision, and request ID after validation. PostgreSQL cannot
  distinguish a standalone autocommit statement from a call inside an otherwise
  empty explicit transaction. A standalone call may return and perform its
  bounded idle refresh, but every transaction-local context GUC disappears at
  statement completion and cannot authorize a later statement. Every
  context-bound operation therefore uses one connection-pinned wrapper with
  serial `BEGIN` → `initialize_context` → operation → `COMMIT`/`ROLLBACK`;
  transaction control is enforced by the wrapper and tests, not claimed as an
  in-function autocommit detector.
- `dasher_private.context_allows(uuid, text) RETURNS boolean` and typed context
  accessors return only a boolean or one typed value. They are used by policies,
  not called as data lookup APIs. `context_allows` verifies every GUC against
  the exact unexpired, unreplaced, unrevoked session digest and active
  membership/revision except the explicitly non-authoritative request-ID GUC.
  Missing, malformed, manually set, stale, or mismatched authority-bearing
  values return false; request-ID overwrite neither grants nor removes
  authority.
- The exact no-argument typed accessors are
  `dasher_private.context_user_id() RETURNS uuid`,
  `dasher_private.context_organization_id() RETURNS uuid`,
  `dasher_private.context_membership_id() RETURNS uuid`,
  `dasher_private.context_session_id() RETURNS uuid`,
  `dasher_private.context_request_id() RETURNS uuid`, and
  `dasher_private.context_authority_revision() RETURNS bigint`.
- `dasher_api.issue_invitation(uuid, text, text, smallint, bytea, uuid,
smallint, bytea, smallint, bytea, uuid, text) RETURNS TABLE (invitation_id
uuid, expires_at timestamptz)`. Inputs are invitation ID, normalized email,
  requested role, invitation token key version/digest, audit event ID, current
  session key version/digest, current CSRF key version/digest, explicit
  non-authoritative request ID, and deployment revision, in that exact order.
- `dasher_api.revoke_invitation(uuid, uuid, smallint, bytea, smallint, bytea,
uuid, text) RETURNS TABLE (invitation_id uuid, revoked_at timestamptz)`. Inputs
  are invitation ID, audit event ID, current session key version/digest,
  current CSRF key version/digest, explicit non-authoritative request ID, and
  deployment revision, in that exact order.
- `dasher_api.change_membership_role(uuid, text, uuid, smallint, bytea, text)
RETURNS TABLE (membership_id uuid, authority_revision bigint)`. Inputs are
  membership ID, new role, audit event ID, current CSRF key version/digest, and
  deployment revision, in that order.
- `dasher_api.revoke_membership(uuid, uuid, smallint, bytea, text) RETURNS
TABLE (membership_id uuid, authority_revision bigint, revoked_at
timestamptz)`. Inputs are membership ID, audit event ID, current CSRF key
  version/digest, and deployment revision, in that order.
- `dasher_api.rotate_session(uuid, smallint, bytea, smallint, bytea, uuid,
smallint, bytea, text) RETURNS TABLE (session_id uuid, idle_expires_at
timestamptz, absolute_expires_at timestamptz)`. Inputs are successor session
  ID, successor session key version/digest, successor CSRF key version/digest,
  audit event ID, current CSRF key version/digest, and deployment revision, in
  that order. The predecessor is the initialized context session and is not a
  caller selector.
- `dasher_api.revoke_session(uuid, uuid, smallint, bytea, text) RETURNS TABLE
(session_id uuid, revoked_at timestamptz)`. Inputs are target session ID, audit
  event ID, current CSRF key version/digest, and deployment revision, in that
  order. The target must belong to the current context user and organization;
  the routine fixes the revocation reason to `user_revoked`.

Every ordinary context-bound authenticated signature follows one argument
rule: operation IDs and data, then one distinct application-supplied
`audit_event_id uuid`, then the current CSRF `smallint, bytea`, then
`deployment_revision text`. Its request ID is read from the transaction-local
correlation GUC. No operation accepts a caller actor, organization,
user-authority, arbitrary role, audit action, outcome, revocation reason, or
expiry. The two permitted role-valued operation inputs are the closed enums
named above. Every UUID, including every audit event ID, proposed user ID, and
proposed membership ID, is supplied by the application and is never generated
or derived in SQL.

`issue_invitation` and `revoke_invitation` are the only exceptions to that
uniform authenticated argument rule. After operation data and audit event ID,
they take current session `smallint, bytea`, current CSRF `smallint, bytea`,
explicit non-authoritative `request_id uuid`, then `deployment_revision text`.
They do not require or trust initialized context; their explicit session proof
is their only authority input.

The exact operation authorization matrix is:

| Function                 | Required authority after locks and final re-read                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `accept_invitation`      | Pre-authentication; authority comes only from the locked live invitation and verified immutable external identity |
| `issue_invitation`       | Exact explicit live session proof, locked live session, and locked active `admin` membership                      |
| `revoke_invitation`      | Exact explicit live session proof, locked live session, and locked active `admin` membership                      |
| `change_membership_role` | Initialized live session and locked active `admin` membership                                                     |
| `revoke_membership`      | Initialized live session and locked active `admin` membership                                                     |
| `initialize_context`     | Exact live session digest and any locked active membership role                                                   |
| `issue_session`          | Verified immutable identity and any locked active supplied membership role                                        |
| `rotate_session`         | Initialized live session and any locked active membership role                                                    |
| `revoke_session`         | Initialized live session and any locked active membership role; target remains same-user and same-organization    |

Each of the following eight named audit-writing entry functions writes exactly
one audit row. `initialize_context`, `context_allows`, and every typed context
accessor never write audit:

- `accept_invitation`: `invitation.accepted`, `invitation`, and the locked
  invitation ID when it creates a membership; or
  `invitation.accepted_existing_membership`, `invitation`, and that same
  invitation ID when it consumes the invitation for an existing active
  membership.
- `issue_session`: `session.issued`, `session`, and the new session ID.
- `issue_invitation`: `invitation.issued`, `invitation`, and the new invitation
  ID. Its automatic revocation of older pending invitations does not create
  additional audit rows.
- `revoke_invitation`: `invitation.revoked`, `invitation`, and the invitation
  ID.
- `change_membership_role`: `membership.role_changed`, `membership`, and the
  target membership ID.
- `revoke_membership`: `membership.revoked`, `membership`, and the target
  membership ID.
- `rotate_session`: `session.rotated`, `session`, and the successor session ID.
- `revoke_session`: `session.revoked`, `session`, and the target session ID.

Audit field provenance is exact. Action, target type/ID, actor, organization,
authority revision, outcome, and operation time are fixed by or derived inside
the function from the locked operation rows and validated authority; callers
cannot select those audit meanings. Optional audit fields not named by the
operation are fixed null. Audit event ID is application-supplied and globally
unique as specified below. Request ID and deployment revision have only their
explicitly limited provenance classifications and no non-forgeability claim.

`accept_invitation`, `issue_session`, `issue_invitation`, and
`revoke_invitation` take request ID explicitly. The other authenticated
audit-writing functions read the current transaction-local request-ID GUC.
Both forms are caller-controlled, non-authoritative correlation data: a caller
may overwrite the GUC after initialization and request IDs may repeat. Request
ID is not part of session/membership authority. The typed accessor and explicit
inputs still require UUID shape.

Audit event IDs are globally unique across all organizations. Every
audit-writing function requires `audit_event_id <> request_id`, including when
the authenticated request ID was overwritten. A same-tenant or cross-tenant
audit-ID collision is a conflict and rolls back the entire function. An audit
ID whose prior attempted transaction rolled back remains reusable because no
audit row committed.

`deployment_revision` is application-config-asserted provenance, not database
authority and not request data. The database requires the same trimmed,
non-control, 1-to-64-character shape as the audit column; the later repository
wrapper supplies it from fixed process configuration and never from an HTTP
body, query, header, model output, or job payload. A direct database caller can
assert any shape-valid value, so no stronger provenance claim is made.

Every entry function catches and normalizes all expected unique, foreign-key,
check, internal cast/GUC parse, and zero-row conditional paths. A denied path
raises SQLSTATE `P1001` with exact message `dasher_denied`; a conflict path
raises SQLSTATE `P1002` with exact message `dasher_conflict`. Both omit detail,
hint, schema, table, column, constraint, and datatype metadata. Denials include
unknown, malformed, cross-tenant, wrong-user/revision, inactive, revoked,
expired, replayed, invalid-role/email/verification/deployment shape, invalid
CSRF, audit/request equality, and failed authority predicates. Conflicts
include caller-supplied row, token/digest, session-lineage, or audit-ID
collisions; an identity uniqueness loser with no exact immutable winner; and a
conditional rotation loser. Invitation replay remains a denial. A failed
function writes no tenant audit and exposes no raw SQL or constraint detail.
Typed argument conversion that PostgreSQL performs before entering a function
is prevalidated and normalized by the later repository boundary; it is never
fed unvalidated public text.

The future repository maps exact SQLSTATE `P1001` to one typed denial and exact
SQLSTATE `P1002` to one typed conflict by code only, without inspecting a
database message. A future HTTP adapter maps them respectively to status `403`
with exact body `{"error":"operation_denied"}` and status `409` with exact body
`{"error":"operation_conflict"}`. Task 4 adds neither repository wrapper nor
route. Every other SQLSTATE, including an unexpected error whose message
happens to match a fixed message, remains internal and is not silently
relabeled. The future boundary sanitizes it to a generic internal response and
never exposes raw SQL details publicly.

Security logging uses only request ID plus one of these bounded reason codes:
`input_invalid`, `authority_invalid`, `state_invalid`, `expired`, `replay`,
`csrf_invalid`, `identifier_conflict`, `conditional_conflict`, or
`internal_fault`. Logs contain none of the forbidden secret, identity, tenant,
credential, SQL, constraint, or raw-error fields already listed.

`0003` adds operation-specific create-snapshot, create-evidence,
create-dashboard, create-dashboard-version, and promote-head functions. They
accept typed content/IDs plus current CSRF proof and return only created IDs,
hashes, or the promoted head. No routine accepts audit identity/action fields.

`PUBLIC` cannot execute any routine. App calls with manipulated `search_path`
must behave identically. Direct `SELECT/count` on users and external identities
and direct pre-auth table access fail inside and outside tenant context.

### RLS, ACL, and operation ownership matrix

Policy helper expressions below are literal:

- `viewer(org)` =
  `dasher_private.context_allows(organization_id, 'viewer'::text)`
- `admin(org)` =
  `dasher_private.context_allows(organization_id, 'admin'::text)`
- `self(org,user)` = `viewer(org) AND
dasher_private.context_user_id() = user_id`

| Table                          | Direct app `SELECT` policy and safe columns                                                                | `INSERT`                     | `UPDATE`                              | `DELETE` | `TRUNCATE` |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------- | -------- | ---------- |
| `users`, `external_identities` | none; no grant                                                                                             | function only                | none                                  | none     | none       |
| `organizations`                | `organizations_select` to `dasher_app`, `FOR SELECT USING (viewer(org))`; ID, name, timestamps             | no Gate 2-A app operation    | none                                  | none     | none       |
| `memberships`                  | `memberships_select`, viewer; omit no columns                                                              | acceptance function only     | membership functions only             | none     | none       |
| `invitations`                  | `invitations_select`, admin; omit `token_digest` and token key version                                     | issue function only          | accept/revoke functions only          | none     | none       |
| `sessions`                     | `sessions_select`, self; omit both digests and key versions                                                | issue/accept/rotate only     | context/rotate/revoke only            | none     | none       |
| `source_snapshots`             | `source_snapshots_select`, viewer; omit `canonical_bytes` from table grant; bounded function fetches bytes | create function only         | none; trigger rejects                 | none     | none       |
| `evidence_records`             | `evidence_records_select`, viewer                                                                          | create function only         | none; trigger rejects                 | none     | none       |
| `dashboards`                   | `dashboards_select`, viewer                                                                                | create function only         | promote function may change only head | none     | none       |
| `dashboard_versions`           | `dashboard_versions_select`, viewer                                                                        | create function only         | none; trigger rejects                 | none     | none       |
| `dashboard_version_snapshots`  | `dashboard_version_snapshots_select`, viewer                                                               | version-create function only | none; trigger rejects                 | none     | none       |
| `audit_events`                 | `audit_events_select`, admin                                                                               | operation functions only     | none; trigger rejects                 | none     | none       |

Each named policy is `AS PERMISSIVE FOR SELECT TO dasher_app` with exactly the
shown `USING` expression and no `WITH CHECK`. There are no app
`INSERT`, `UPDATE`, `DELETE`, or `ALL` policies. Function-only mutations are
not paired with direct grants.

ACL closure:

- Revoke `CREATE` and `TEMP` on the dedicated database from `PUBLIC`; revoke
  `CREATE` on `public`; app receives only `CONNECT`.
- Revoke all on `dasher_meta`, `dasher`, `dasher_api`, and `dasher_private`
  from `PUBLIC`. App gets `USAGE` on `dasher` and `dasher_api`, not `CREATE`,
  and no `dasher_meta` access.
- Grant app only the safe column-level `SELECT` projections above and exact
  routine `EXECUTE`; grant no table-wide DML, sequence, trigger, role,
  journal, schema-create, truncate, or ownership authority.
- The definer gets schema `USAGE` and only the columns needed by its routines:
  identity `SELECT/INSERT`; membership `SELECT/INSERT/UPDATE
(role,state,authority_revision,updated_at,revoked_at)`; invitation
  `SELECT/INSERT/UPDATE (accepted_at,accepted_user_id,revoked_at,
revoked_by_user_id)`; session `SELECT/INSERT/UPDATE
(last_seen_at,idle_expires_at,replaced_by_session_id,revoked_at,
revocation_reason)`; dashboard `SELECT/INSERT/UPDATE (head_version_id)`;
  immutable content `SELECT/INSERT`; and audit `INSERT` for every listed audit
  column. It has no delete, truncate, schema-create, role, or journal right.
- Set migration-owner default privileges in every managed schema to revoke all
  table, sequence, type, and function privileges from `PUBLIC`. Every later
  migration repeats the default-privilege and explicit-grant discipline.

Catalog assertions compare exact PostgreSQL 16 ACLs and fail on an extra grant,
policy, function, owner, role membership, or default privilege.

### Identity, invitation, and key semantics

Tokens have the wire form `i1.<version>.<secret>` for invites and
`s1.<version>.<secret>` for sessions. CSRF values use
`c1.<version>.<secret>`. `version` is decimal `1..32767`; `secret` is exactly
43 unpadded base64url characters decoding to 32 bytes. Domain-separated HMAC
labels are `dasher:invite:v1`, `dasher:session:v1`, and `dasher:csrf:v1`.

The injected key ring contains at most three verification versions, has one
explicit current issue version, rejects duplicates/unknown/retired versions,
and never scans versions. Parsing the token selects one registered version;
the app computes one digest and the database looks up the exact
`(key_version, digest)` unique key. Rotation tests cover current, previous,
retired, and unknown versions.

Gate 2-A email handling is a closed, locale-independent ASCII subset. Original
application input is rejected if it contains any non-ASCII code point or any
ASCII whitespace/control byte, including space and DEL; it must contain
exactly one `@`, nonempty local and domain components, and no more than 320
characters. There is no trimming. After validation, application normalization
maps only ASCII `A` through `Z` to the corresponding `a` through `z` and leaves
every other permitted printable ASCII byte unchanged.

`issue_invitation` and `accept_invitation` independently validate their
purported normalized email before any persistence or equality decision. Using
the `C` collation or equivalent byte checks, they require only printable ASCII
bytes `0x21..0x7e`, exactly one non-leading/non-trailing `@`, total character
length `3..320`, and no ASCII `A..Z`; uppercase, whitespace/control,
non-ASCII, empty-component, multiple-separator, or overlength inputs are
denied. PostgreSQL never normalizes the value. Immutable `0001`'s
`normalized_email = lower(normalized_email)` constraint is only a redundant
check on this already-lowercase ASCII input and is not relied on for
application/SQL transformation parity.

Invitation issuance requires locked current admin authority. Role order is
`viewer < editor < admin`; the server-owned admin ceiling is `admin`. A
requested role above the derived ceiling is rejected, never silently clamped.
The exact requested role and derived ceiling are stored. Before inserting, the
function follows the special authenticated invitation protocol below, captures
its one database time after its row locks and final revalidation, revokes every
older pending invitation with that time, then inserts one new invitation with
`created_at = now` and `expires_at = now + interval '7 days'` and its one audit
event. The caller cannot supply or shorten the fixed seven-day lifetime.
Requested role must be exactly `viewer`, `editor`, or `admin`; any other value
or any value above the derived `admin` ceiling is denied.

Issue, revoke, and accept use one fixed invitation-family transaction lock:

```sql
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'dasher:invitation-family:v1:'::text
      || organization_id::text
      || ':'::text
      || normalized_email,
    20260730::bigint
  )
);
```

The lock is acquired inside each entry function before any row lock.
`accept_invitation` remains pre-authentication and uses its bounded ordinary
token probe to derive the family key before locking.

`issue_invitation` and `revoke_invitation` are special authenticated entry
functions that do not call or depend on `initialize_context`. Each follows this
exact protocol in one transaction:

1. Ordinarily probe the exact current session key version/digest through its
   unique index, bounded to zero or one row, to discover the current session,
   actor organization, user, and membership row keys. The probe grants no
   authority.
2. For issue, require the complete closed normalized-email SQL predicate above
   before forming its key. For revoke, ordinarily probe only
   `invitation.organization_id = probed_session.organization_id AND
invitation.invitation_id = input_invitation_id`, bounded to zero or one row,
   to discover normalized email. A missing or cross-organization target is
   denied before deriving or acquiring any foreign organization's family lock.
3. Derive the fixed organization/email family key and call
   `pg_catalog.pg_advisory_xact_lock` before any row lock. No caller pre-held
   lock, resolution transaction, or `pg_locks` inspection exists.
4. Lock the derived actor membership, then one deduplicated canonical session
   set containing the probed current session and any other participating
   session row, then the pending invitation family for issue or exact target
   invitation for revoke. The revoke target lock repeats the exact actor-
   organization-plus-invitation-ID predicate; it never locks a foreign row.
5. Re-read everything under those locks and require the exact supplied session
   key version/digest, live unreplaced and unrevoked session, unexpired idle and
   absolute deadlines, active membership, exact authority revision, `admin`
   role, exact current CSRF key version/digest, same organization, valid
   operation data, `audit_event_id <> request_id`, valid deployment revision,
   and every other function input. No probe result is authoritative until this
   revalidation.
6. Capture the one database time, perform the fixed mutation and audit insert,
   and return the minimal result; any failure rolls back the advisory lock,
   mutation, and audit together.

The explicit request ID is non-authoritative correlation, and neither explicit
session proof nor any operation input selects organization, user, membership,
or role; those are derived and revalidated from locked rows. The family lock
serializes the zero-existing-row case as well as existing rows. Hash collisions
are safe and only over-serialize unrelated families. Concurrent issue leaves
exactly one pending winner, every predecessor has a deterministic accepted or
revoked terminal state, and issue-versus-accept or issue-versus-revoke cannot
invert invitation and membership row locks.

Acceptance requires a server-verified external identity input with
`email_verified = true` and an exactly normalized verified email. The
Gate 2-A normalizer applies the closed ASCII-only validation and explicit
whole-address `A..Z` mapping above, including the local part, and acceptance
compares that exact result. The acceptance function locks in this order:

1. perform the bounded probe, acquire the invitation-family advisory lock, and
   claim the re-read invitation by exact key version/digest `FOR UPDATE`;
2. capture one database `clock_timestamp()` and require not accepted, not
   revoked, and `now < expires_at`;
3. require exact normalized-email equality;
4. ordinarily read exact immutable `(issuer, subject)`; if absent, run the
   fixed identity-insert subtransaction below;
5. lock any membership for that derived user and invitation organization;
6. if absent, insert it with the proposed new membership ID and stored
   `granted_role`, using the fixed membership-race behavior below; if already
   active, leave its role/revision unchanged; a revoked membership denies and
   requires a separate admin operation;
7. conditionally mark this invitation accepted, issue the initial session at
   the effective current membership revision, write the fixed audit event, and
   commit.

The proposed new user ID is consumed only when the exact external identity is
absent. If the identity already exists, its immutable user ID wins and the
proposed user ID is ignored without looking it up anywhere. When the identity
is absent, a fixed PL/pgSQL `BEGIN ... EXCEPTION WHEN unique_violation ... END`
subtransaction inserts the proposed user with explicit `user_id` and
`created_at = captured_now`, then inserts the exact external identity with
explicit `issuer`, `subject`, `user_id`, and `created_at = captured_now`; no
timestamp default is used. Any uniqueness failure rolls both proposed inserts
back together; the function then performs one ordinary exact `(issuer,
subject)` read. If an immutable winner is now present, that winner is used and
the proposed user ID is ignored. If no exact winner exists—including a proposed
user-ID collision or an `external_identities_user_key` collision unrelated to
the exact identity—the function raises `dasher_conflict`. It never leaves an
orphan user and never updates or deletes a user or external identity.

The proposed new membership ID is likewise consumed only when membership for
the derived `(organization_id, user_id)` is absent. If a membership already
exists, the proposed ID is ignored without looking it up elsewhere. If absent,
one fixed PL/pgSQL subtransaction attempts the membership insert and rolls back
that attempt on `unique_violation`. A newly inserted membership sets every
field explicitly: proposed `membership_id`, derived `organization_id` and
`user_id`, `role = invitation.granted_role`, `state = 'active'`,
`authority_revision = 1`, `created_at = updated_at = captured_now`, and
`revoked_at = NULL`; no default is used.

After a membership uniqueness loss, the function re-reads the exact
`(organization_id, user_id)` winner `FOR UPDATE`. It holds that winning row lock
through initial-session insertion and audit, and under the lock revalidates
`state = 'active'`, the winner's exact closed-enum role, and its current
authority revision. An active winner is used unchanged at that locked role and
revision, a revoked or invalid winner is denied, and no exact winner means the
proposed membership-ID collision is a conflict. An existing active membership
consumes the invitation but cannot upgrade or downgrade the membership and
selects the alternate acceptance audit action. The new session and audit IDs
are always consumed; any collision is a conflict and rolls back acceptance.

The identity is never rebound. Never search, merge, or link a user by email.
Concurrent acceptance has exactly one conditional invitation transition and
one winner. `dasher_security_definer` receives no identity or user `UPDATE` or
`DELETE` privilege.

Unknown, malformed, expired, revoked, replayed, wrong-email, unverified-email,
and revoked-membership cases have one public denial. An identity insert race
with an exact immutable winner continues with that winner; a uniqueness failure
without that winner is one conflict. Gate 2-A writes no tenant audit for a
denied or conflicted transaction. All pre-auth failures, including
organization-less unknown tokens, emit only a rate-limited structured server
security event containing request ID and one allowed bounded reason code—never
token, digest, email, issuer/subject, organization existence, or raw error.

### Database-clock session, revocation, and CSRF protocol

The database fixes idle lifetime at 30 minutes and the initial absolute
lifetime at 7 days; callers cannot supply either. Every Task 4 entry function
captures one `clock_timestamp()`. `context_allows` separately captures one
database time per predicate invocation. The entry function's exact value is
explicitly written to
`audit_events.occurred_at` and to every timestamp the operation creates or
changes, including user/identity/membership creation and updates, invitation
creation/expiry/acceptance/revocation, session issue/refresh/rotation/revocation,
and dependent-session revocation. No operation relies on a timestamp column
default that would take a second clock value. Expiry is inclusive: deny when
`now >= expires_at`. Sessions created by `accept_invitation` or `issue_session`
set every column explicitly: application-supplied `session_id`; derived
`organization_id`, `user_id`, and current `authority_revision`; supplied
session/CSRF key versions and digests; `issued_at = last_seen_at = now`;
`idle_expires_at = now + interval '30 minutes'`; `absolute_expires_at = now +
interval '7 days'`; and `rotated_from_session_id = replaced_by_session_id =
revoked_at = revocation_reason = NULL`. No session timestamp, lineage, or
revocation default is used.
`initialize_context` performs an unlocked digest probe only to discover row
keys, then locks the membership followed by the canonical session set, re-reads
both, and validates token, lineage, revocation, state, revision, and both
expiries before setting local context. At most once per five minutes it
conditionally advances `last_seen_at = now` and `idle_expires_at = least(now +
interval '30 minutes', absolute_expires_at)`.

All authenticated state changes require the current CSRF version/digest and
compare it to the locked session row. The service computes the domain-separated
digest and uses constant-time comparison before the call; the database routine
also requires exact byte equality. Exemptions are only read-only session
resolution, server-verified external-identity login/session issue, invitation
acceptance, and a future login callback. No HTTP route is added in this slice.

The default authenticated non-invitation row-lock order is:

1. all involved membership rows ordered by `(organization_id, user_id)`;
2. one deduplicated set of all existing current, target, predecessor,
   successor-ID-collision, and directly participating lineage session rows,
   locked by one ordered query in `(organization_id, session_id)` order;
3. the dashboard or other mutable non-invitation target;
4. immutable inserts and audit.

The special authenticated invitation issue/revoke order is the family advisory
lock, derived actor membership, canonical session set, invitation
family/target, then inserts/audit, exactly as specified above. The explicit
pre-authentication acceptance row-lock exception is: family advisory lock,
invitation, identity-race protocol and derived membership, canonical session
set, then the remaining fixed inserts and audit. The acceptance schedule never
locks a session before its derived membership.

Every authenticated mutation revalidates the context's session digest and
membership after acquiring those locks in the same transaction. Membership
role/state changes derive `actor_organization_id` only from the initialized
session row after revalidating that exact session and actor membership in the
current transaction. They cannot target the actor's own membership and never
perform a global target probe. Both `change_membership_role` and
`revoke_membership` resolve and lock the target only with
`membership.organization_id = actor_organization_id AND
membership.membership_id = input_membership_id`; the active-admin lock query is
also constrained to that exact actor organization. A missing or
cross-organization target denies before any target or foreign-organization row
lock.

Within that tenant predicate, the routines lock the actor, target, and every
active-admin membership in one canonical `(organization_id, user_id)` order,
then lock the current and target user's entire session set in canonical
`(organization_id, session_id)` order. They revalidate authority, require the
target to be active, require a new role to be exactly `viewer`, `editor`, or
`admin`, and preserve at least one active admin after the proposed change.
They then capture their one database time, change role/state and increment
`authority_revision` exactly once, and revoke all target sessions in the
already locked session-ID order with reason `authority_changed`. Revision
mismatch independently invalidates any session missed by that update.

Rotation locks membership, then builds one deduplicated session set containing
the context predecessor, any existing proposed-successor-ID row, and every
existing row directly named by the predecessor's lineage columns. It locks
that entire set in canonical organization/session-ID order, regardless of
which UUID sorts first. It revalidates that the predecessor is current, live,
and has no successor, then captures its one database time. To satisfy `0001`'s
immediate lineage foreign keys, writes occur in this exact order:

1. Insert the successor first with every column explicit: supplied successor
   session ID and session/CSRF key versions/digests; predecessor organization,
   user, and current authority revision; `issued_at = last_seen_at = now`;
   `idle_expires_at = least(now + interval '30 minutes',
predecessor.absolute_expires_at)`; `absolute_expires_at =
predecessor.absolute_expires_at`; `rotated_from_session_id =
predecessor.session_id`; and `replaced_by_session_id = revoked_at =
revocation_reason = NULL`.
2. Conditionally update the already locked predecessor's
   `replaced_by_session_id` to the successor ID with the same current/live/no-
   successor predicates and require exactly one updated row.
3. Insert the fixed audit row last.

Any successor insert, zero-row predecessor update, or audit failure rolls back
both lineage directions. Rotation is denied at the inclusive boundary `now >=
predecessor.absolute_expires_at`. Concurrent rotations produce one successor
and one `dasher_conflict` with no tenant audit.

Session revocation locks the membership, then one deduplicated canonical set
containing the current and target sessions; if either is a directly
participating lineage row for the other, it is already present exactly once.
It performs the same final revalidation, captures its one database time, and
conditionally revokes only a session for the current user and organization
with fixed reason `user_revoked`.

`issue_session` locks and validates the derived membership, locks any existing
new-session-ID collision row through its canonical session set, performs its
final re-read, and only then captures its one database time and inserts.
`initialize_context` locks its probed current session through the same
canonical-set mechanism and captures its one database time only after the
membership and session locks and re-read.
Invitation acceptance retains its explicit pre-authentication exception,
captures its one database time immediately after locking the invitation, and,
after the derived membership, canonically locks any existing new-session-ID
collision row before session insert. Invitation issue and revoke acquire the
family advisory lock internally, then lock current membership, canonical
current-session set, and canonically ordered family/target invitation rows.
Membership role/revoke use the canonical actor/target/all-live admin membership
set, then the deduplicated current plus all-target-session set. Every other
authenticated routine captures its one database time only after all
decision-relevant membership, session, and mutable-target locks and the final
authority recheck. No routine acquires an existing session row outside its
canonical set. Audit insertion remains last in every lock protocol.

Tests cover revocation committed before authority locking, revocation waiting
behind a mutation that already holds authority, and revocation winning before
the mutation's final recheck. Reverse-sorted session UUID tests cover
rotation-versus-revocation and lineage/current/target overlap without deadlock.
Acceptance-versus-membership-role-change and
acceptance-versus-membership-revocation barrier tests cover both lock-winner
orders and prove final locked authority determines the result without deadlock.
No transaction spans a network call.

The session cookie is `__Host-dasher_session` with `Secure`, `HttpOnly`,
`Path=/`, no `Domain`, `SameSite=Lax`, and `Max-Age` no longer than the
database absolute expiry.

### Null-safe CAS and atomic audit

Dashboard promotion uses one checked-out app client and one transaction:

1. initialize context from the current session digest;
2. validate CSRF, lock and revalidate session/membership;
3. execute one update whose predicate uses
   `head_version_id IS NOT DISTINCT FROM $expected_head` and whose target is
   selected by an `EXISTS` on a valid version with the same organization and
   dashboard;
4. require exactly one `RETURNING dashboard_id, head_version_id` row;
5. insert the fixed `dashboard_head.promoted` audit event; and
6. commit.

Zero returned rows is one conflict/not-found denial, writes no tenant audit,
and preserves the prior head. A known or unknown conflict may emit only the
same bounded secret-free server event scheme as other denials.

Audit-failure tests use no production hook. In the disposable test database,
one owner transaction revokes `INSERT` on every exact granted audit column from
`dasher_security_definer` and commits. A distinct app-role connection then runs
the mutation and proves the entire mutation rolls back. In `finally`, a
separate owner transaction restores and commits the exact column grants on
`audit_event_id`, `organization_id`, `occurred_at`, `actor_kind`,
`actor_user_id`, `actor_service`, `authority_revision`, `request_id`, `job_id`,
`action`, `target_type`, `target_id`, `outcome`, `content_sha256`, `source_ref`,
`provider`, `credential_version`, `usage_units`, `cost_minor_units`, and
`deployment_revision`. Exact column-ACL catalog assertions and app-pool reuse
checks run only after that committed restoration.

---

## Implementation tasks

### Task 1: Package skeleton and fail-closed preflight

1. Create an ESM package (`"type": "module"`) with an explicit export map.
   Put `pg` and `zod` in runtime dependencies and types/Vitest/TypeScript in
   development dependencies. Include both `src/**/*.ts` and `test/**/*.ts` in
   the package tsconfig.
2. Define exactly three integration variables:
   `DASHER_TEST_OWNER_DSN`, `DASHER_TEST_APP_DSN`, and
   `DASHER_TEST_HMAC_KEY_B64URL`. DSNs are PostgreSQL URLs with explicit
   database, username, and non-empty password; the key is exactly 43 unpadded
   base64url characters decoding to 32 bytes.
3. Ordinary `test` unconditionally excludes `test/postgres.integration.test.ts`
   even if variables are present. `test:postgres` selects only that
   authoritative file and disables file parallelism. Root `test:postgres`
   invokes only the package command.
4. Before constructing any pool, reject a missing/partial variable set,
   byte-identical owner/app DSNs, malformed URLs, same username, missing
   database, weak/invalid key, or an app username outside
   `^dasher_test_[0-9a-f]{32}$`.
5. Test every negative case and prove no marker DSN/password/key is printed.

Expected commit: `test: add fail-closed control-plane preflight`.

### Task 2: Role bootstrap and transactional migration runner

1. Implement the exact managed-role bootstrap and no-adoption journal contract
   above. Use server `format('%I', $1)` and `format('%L', $2)` after strict
   identifier validation for the temporary login; never hand-roll quoting or
   log the resulting credential SQL.
2. Implement exact-byte discovery/checksums, fixed advisory lock, journal
   prefix validation, atomic pending application, and application-role
   rejection.
3. Test the runner with dedicated immutable fixture migrations: clean apply,
   no-op, concurrency, every malformed journal state, adoption conflict,
   checksum/identity drift, wrong executor, role-marker/flag/ownership drift,
   and injected journal-insert rollback.
4. Do not create a canonical migration in this task.

Expected commit: `feat: add fail-closed control-plane migrator`.

### Task 3: Immutable `0001` identity and audit foundation

1. Add `0001_identity_audit.sql` once with the complete identity/tenant/session/
   audit DDL, indexes, base revocations/default privileges, and audit
   immutability specified above.
2. Enable and force RLS on users, identities, organizations, memberships,
   invitations, sessions, and audit immediately. Users/identities have zero
   policy. No mutation TypeScript exists yet.
3. Provision only synthetic organization/admin fixtures through the owner
   harness. A future real operator bootstrap is outside Gate 2-A.
4. Assert exact DDL and prove the app role cannot enumerate users or identities
   inside or outside any manually set context.

Expected commit: `feat: add identity and audit schema`.

### Task 4: Immutable `0002` context and privileged boundary

1. Before creating immutable `0002`, modify
   `packages/control-plane/src/migrator.ts`, its unit tests, and PostgreSQL
   migration tests to implement the exact validated-prefix managed-role
   ownership/ACL dependency inventory, `expectedAppLoginRoleNames` migrator
   input, managed-login validation, and migration-local `pg_catalog` search
   path above. Preserve strict zero-dependency checks through `0001`; test clean
   canonical `0001+0002` apply, validated-`0001` successor application of
   `0002`, and post-`0002` no-op with the expected app login still provisioned.
   Prove the API carries only the preflight-derived login name and never a
   password/DSN. Reject malicious caller `search_path`, a missing/extra grant,
   an extra definer-owned object, extra incoming app member, either managed
   role's outgoing membership, any definer incoming member, wrong membership
   admin/inherit/set option, absent or duplicate expected login, wrong
   database-bound marker, wrong login flag or SCRAM state, login role setting,
   login ownership, extra login grant, and a login marked or granted for the
   wrong database. Replace `rollbackQuietly` with the rollback-and-release
   protocol above and unit-test: migration or journal failure plus successful
   rollback uses normal release; the same failure plus rejected rollback uses
   destructive error/force release and the client is never reused; and a
   transaction-control or commit failure plus failed recovery also destroys the
   client. Preserve the original failure as the public error and retain only a
   sanitized rollback cause. Keep real-PostgreSQL pool-reuse assertions for
   successfully rolled-back connections.
   Add two executable sibling-database cases using a unique database name and
   the already-required superuser owner connection: one creates a
   managed-role-owned object and one grants a managed role an ACL in that
   sibling. `CREATE DATABASE` and `DROP DATABASE` run outside every transaction.
   Each case runs the primary-database migrator and requires
   `managed_role_drift` before migration SQL or journal mutation. Nested
   `finally` cleanup closes sibling clients; connects as owner when needed to
   revoke the ACL or reassign/remove the owned object; closes that client;
   terminates any remaining backends for only the unique sibling database;
   drops it outside a transaction; and proves both its `pg_database` row and
   every `pg_shdepend` row for its former database OID are absent. Cleanup runs
   after both the expected rejection and any intermediate test failure, leaving
   no database, backend, object, grant, or dependency residue.
2. Add `0002_security_boundary.sql` once with the exact function signatures,
   ownership, safe search path, policies, column grants, revocations, default
   privileges, database-clock rules, and lock protocols above.
3. Expose session-bound `initialize_context`; do not expose an arbitrary
   context setter. Include session ID, key version, and digest in the predicate
   binding so manual GUC forgery denies.
4. Implement invitation, session, membership, and fixed audit operations only
   through their allowlisted functions.
5. Catalog-test the exact Task 4 function identities, argument and result
   types, minimal return columns, owner, `prosecdef`, language, volatility,
   `proconfig`, ACL, and exact canonical `prosrc`; prove no dynamic SQL or
   unqualified non-catalog object reference. Prove `PUBLIC` and direct app calls
   to private helpers are denied while app-role policy evaluation succeeds
   without `USAGE` on `dasher_private`, and malicious `search_path` changes
   behavior nowhere.
6. Test no context; manual, malformed, stale, wrong-user, wrong-organization,
   and wrong-revision authority GUCs; revoked membership/session; inclusive
   idle and absolute expiry; transaction-local cleanup; denied and rolled-back
   pool reuse; and allowed request-ID overwrite/repetition without authority
   change. Prove arbitrary organization/user/authority-role selection is denied
   while only valid `requested_role` and `new_role` operation enums are
   accepted. Prove a standalone autocommit `initialize_context` may return and
   refresh but its local context evaporates after that statement and authorizes
   no subsequent statement; prove every successful context-bound operation uses
   a connection-pinned serial `BEGIN` → initialize → operation →
   `COMMIT`/`ROLLBACK` sequence.
7. Table-drive all eight audit-writing functions. For each, assert the exact
   action, target type/ID, actor, organization, authority revision, request ID,
   `occurred_at`, deployment revision, null optional audit fields, one-row
   cardinality, minimal return shape, and complete before/after row state. In a
   committed owner transaction revoke `INSERT` on every exact granted audit
   column, run the mutation on a distinct app connection, and prove full
   rollback with stable before/after row digests, zero residue, and successful
   audit-ID reuse after rollback. In `finally`, restore the exact column grants
   in a separate committed owner transaction before exact ACL restoration and
   pool-reuse assertions. Separately test global same-tenant and cross-tenant
   audit-ID collisions, audit/request equality, and repeated request IDs.
8. Use connection-pinned, serial-query, two-connection barrier tests for:
   new/existing identity and membership acceptance; both external-identity
   unique constraints with different proposed UUIDs and zero orphan users;
   ignored proposed IDs without lookup; proposed user/membership/session UUID
   collisions; replay; concurrent acceptance; zero-row and existing-row
   concurrent invitation issue; issue-versus-accept; issue-versus-revoke; and
   deterministic predecessor terminal states with exactly one pending
   invitation winner. Prove issue/revoke invitation perform bounded explicit
   session and target probes, acquire the family advisory transaction lock
   internally before row locks, reject wrong/revoked/expired/replaced session
   proof and wrong CSRF, and require no pre-resolution transaction or caller
   lock. With two tenants, prove revoking a known foreign invitation UUID denies
   with the same metadata-free response before deriving/acquiring the foreign
   family lock or locking its row, and causes no measurable barrier delay to
   the legitimate tenant's concurrent issue/accept/revoke.
   Make the no-delay assertion deterministic: while the legitimate tenant
   deliberately holds its family advisory or invitation-row lock, the foreign
   caller's revoke must finish with the generic denial before that barrier is
   released; releasing the barrier then lets the legitimate operation finish.
9. Barrier-test concurrent last-admin demotion and revocation in both winner
   orders; self-membership targeting; revocation committed before authority
   lock, waiting behind held authority, and winning before final recheck.
   With two tenants, pause tenant B's legitimate membership operation after it
   deliberately holds its known membership row lock. Tenant A's role-change
   and revoke calls using that UUID must each finish with the same metadata-free
   denial before B releases its barrier; when resumed, B's operation completes
   without having waited for A. Prove no global target probe, foreign row lock,
   or foreign active-admin lock occurs.
   Reverse-sort UUIDs for current/target and predecessor/successor/lineage
   session sets and prove rotation-versus-revocation and concurrent rotation
   finish without deadlock. Test acceptance versus role change and membership
   revocation in both lock-winner orders. Cover just-before-absolute-expiry
   rotation, exact successor timestamps, the inclusive boundary, fixed
   revocation reasons, lock-timeout rollback, full row digests, and subsequent
   pool reuse.
10. Add a three-connection acceptance regression in which one connection
    creates the winning membership, the losing acceptance rolls back its
    membership insert and waits to re-read that winner `FOR UPDATE`, and a third
    connection attempts role change or revocation before the loser continues.
    Cover both lock winners and prove the loser uses only the locked final
    state/role/revision through session and audit. Assert every new
    user/identity/membership/initial-session field is explicit and equals the
    captured-clock/null protocol. Prove rotation inserts the successor before
    its exactly-one-row predecessor update, satisfies immediate lineage FKs,
    audits last, and rolls back both directions on injected insert/update/audit
    failure.
11. Assert exact denial SQLSTATE/message `P1001`/`dasher_denied`, exact conflict
    SQLSTATE/message `P1002`/`dasher_conflict`, and absent
    detail/hint/object metadata for every expected class, including unique, FK,
    CHECK, internal cast/GUC parse, conditional zero-row, cross-tenant, replay,
    duplicate-ID, audit-collision, and race paths. Scan captured database errors,
    security logs, and persisted rows for raw SQL, constraint names, marker
    secrets, and forbidden fields. Task 4 records the future repository/HTTP
    mapping contract but adds no wrapper or route; the later wrapper tasks test
    code-only mapping and the exact status/body.

Expected commit: `feat: enforce session-bound tenant authority`.

### Task 5: Secret, email, and cookie primitives

1. Implement exact token formats, 32-byte generation, domain-separated HMAC,
   bounded key ring/version lookup, and constant-time comparison.
2. Implement the locale-independent Gate 2-A email subset above: reject every
   non-ASCII code point and whitespace/control byte, require exactly one `@`
   with nonempty components and total length at most 320, then map only ASCII
   `A..Z` to `a..z` across the whole address. There is no trim, Unicode case
   mapping, locale/collation transformation, or local-part preservation.
   Acceptance compares the resulting exact string, and email is never
   identity. Test every ASCII byte `0x00..0x7f` exhaustively in local and domain
   positions in application normalization, plus uppercase local/domain mapping,
   empty and repeated separators, lengths immediately below/at/above every
   boundary, and representative non-ASCII code points. For the `0002` SQL
   acceptance predicates, exhaustively test every PostgreSQL
   `text`-representable ASCII byte `0x01..0x7f` in the same positions and apply
   all other cases above. PostgreSQL `text` cannot represent the zero byte, so
   `0x00` is not claimed as an in-function SQL vector; prove at the application
   boundary that it is rejected before any database call. Mapped lowercase
   application output is accepted, while direct uppercase, non-ASCII,
   whitespace/control, malformed-separator, and out-of-bounds purported
   normalized SQL inputs are denied. Assert `0001`'s redundant `btrim`/`lower`
   checks are never used as the normalizer.
3. Implement cookie metadata but no route.
4. Test entropy shape, domain separation, current/previous/retired/unknown key
   behavior, tampering, malformed encoding, no plaintext persistence inputs,
   email rules, and cookie invariants.

Expected commit: `feat: add invite and session secret primitives`.

### Task 6: Race-safe invitation issuance and acceptance

1. Implement the fixed issuance and acceptance functions through repository
   wrappers without adding direct DML.
2. Enforce verified email, immutable identity, no email linking, exact stored
   role, existing/revoked membership behavior, exact database expiry, key
   lookup, lock order, conditional acceptance, initial session issue, and
   same-transaction audit.
3. Normalize all public denials and use only bounded secret-free server events
   for failed attempts.
4. Test concurrent acceptance, external-identity unique races, existing
   membership, revoked membership, replay, expiry boundary, wrong/unverified
   email, role-ceiling rejection, retired key, no duplicate membership, and
   exactly one committed audit chain.
5. Revoke audit insert in the disposable database and prove invitation,
   identity, membership, and session changes leave zero residue.

Expected commit: `feat: add atomic invitation acceptance`.

### Task 7: Session issue, resolve, rotate, CSRF, and revocation

1. Implement server-verified identity session issue, digest-bound context
   initialization, bounded idle refresh, atomic rotation, CSRF validation, and
   explicit session revocation.
2. Implement membership role/revocation operations with exact revision
   increment, dependent-session revocation, universal lock order, and final
   authority recheck.
3. Test inclusive idle/absolute boundaries, refresh throttling, concurrent
   rotation, predecessor replay, wrong CSRF, cross-org use, manually forged
   context, role revision, session/membership revocation, all three revocation
   race schedules, and pool reuse after denied/rolled-back mutations.
4. Inject audit privilege failure and prove every session/membership mutation
   rolls back.

Expected commit: `feat: add revocable rotated sessions`.

### Task 8: Immutable `0003` source, evidence, and dashboard persistence

1. Before creating immutable `0003`, expand the migrator's validated-prefix
   managed-role dependency allowlist and tests by exactly the `0003` function
   ownership and ACL inventory; prove a validated `0002` prefix accepts the
   exact `0003` successor while the preflight-expected app login remains
   provisioned with its exact current-database marker, grant, and membership,
   and rejects missing or extra dependencies.
2. Add `0003_immutable_content.sql` once with the complete DDL, composite FKs,
   indexes, forced RLS policies, ACLs, trigger enforcement, function ownership,
   create routines, and CAS routine above.
3. Parse and validate `DashboardSpec` before persistence; canonicalize bytes
   once and verify the stored SHA-256. Resolve every evidence/snapshot ID in the
   same tenant before creating a version.
4. Implement exactly the null-safe CAS/audit transaction. Conflicts write no
   tenant audit and preserve the prior good head.
5. Test cross-tenant read/count/reference and direct insert/update/delete/
   truncate denial; forged evidence/snapshot IDs; owner-side immutable trigger
   rejection; CAS null/non-null winner-loser races; and audit rollback.

Expected commit: `feat: add immutable dashboard persistence`.

### Task 9: Reproducible PostgreSQL 16 adversarial gate

1. After connecting, prove owner and app target the same server/database OID
   but have distinct `session_user`. Prove the owner is the expected database
   owner; the app login has the exact managed-login flags, marker, SCRAM
   presence, settings, ownership, current-database-only `CONNECT`, and sole
   membership edge specified above; `SET ROLE dasher_app` yields exact
   `current_user`; neither login nor app can migrate/bypass RLS; and neither can
   assume the definer.
2. Create the app login from the app DSN as `LOGIN NOINHERIT NOSUPERUSER
NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, grant only
   `dasher_app` membership with `inherit_option = false`, `set_option = true`,
   and `admin_option = false` and current-database `CONNECT`, and give it the
   exact `dasher:app-login:v1:database-oid:<current_database_oid_decimal>`
   comment. Pass its preflight-derived name—but no password or DSN—as the sole
   `expectedAppLoginRoleNames` entry to every later migrator call. It has no
   owner/definer membership. Never carry or log its password verifier.
3. Assert exact PostgreSQL 16 tables, columns, constraints, relation-OID-scoped
   definitions, indexes, triggers, owners, role flags/comments/memberships,
   function identity/results/config/ACLs, schema/database/default/table/column
   ACLs, policies, `relrowsecurity`, and `relforcerowsecurity`. Same-name
   objects on another relation do not satisfy a check.
4. Run two organizations and at least two synthetic users per role through
   SELECT/count and every direct/mediated mutation, global directory
   enumeration denial, composite-FK attacks, missing/forged/stale context,
   invitation/session/revocation/CAS races, audit failure, transaction cleanup,
   and denied-pool reuse. One integration file runs serially.
5. In `finally`: restore deliberately changed grants; delete test data in FK
   order as owner; verify every managed data table is empty and only the three
   expected migration journal rows remain; close app then owner pools;
   terminate backends for the invocation login; revoke its membership/connect;
   drop it; and prove no invocation-owned role or backend survives. Managed
   non-login roles and migrated schema remain.
6. The TypeScript harness must not shell out to `psql` or Docker and must not
   use dynamic import or any source primitive forbidden by
   `generated-code-gate.test.ts`.

Expected commit: `test: add authoritative PostgreSQL isolation gate`.

### Task 10: CI and operator documentation

1. Add the official service image exactly as
   `postgres:16.14-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55`
   with synthetic credentials, SCRAM, and a health check. A digest change is a
   reviewed dependency change.
2. Run ordinary tests with all three integration variables explicitly unset.
   Then provision the validated app login and run exactly one root
   `pnpm test:postgres` with explicit synthetic DSNs/key.
3. Pipe the PostgreSQL command's stdout/stderr through a local redaction/capture
   step, preserve its exit status, scan that completed artifact for marker
   secrets, and upload it only on failure after redaction. Do not claim to scan
   the still-running GitHub job log.
4. Assert pools/backends/invocation login are gone in-job. Do not assert that
   GitHub's managed service container is already removed; GitHub owns that
   post-job cleanup.
5. Preserve the existing SHA-pinned actions, `permissions: contents: read`,
   format, lint, typecheck, ordinary test, build, Playwright, full and
   production audits, exact generated-code CLOSED grep, and clean-worktree
   check.
6. Update README only by adding PostgreSQL commands, role/synthetic boundaries,
   and explicit no-real-data/no-deploy/no-Gate-2-completion language. Preserve
   its existing Verification command list/order and all clause-locked Gate 1
   links, provider-diversity wording, no-human-equivalence statement, later-gate
   independence statement, and Safety-status claims except the narrow,
   truthful identity-spine update. Run the existing mutation-tested README and
   generated-code guards.

Expected commit: `ci: require PostgreSQL tenant-isolation gate`.

### Task 11: Final verification and release hold

1. Run frozen install; Prettier check; lint; typecheck; ordinary tests with the
   three integration variables unset; build; Playwright; both audits; exact
   generated-code CLOSED grep; README/gate-contract tests; `git diff --check`;
   credential/marker scan; and clean-worktree checks.
2. Run the authoritative PostgreSQL gate on a fresh digest-pinned PostgreSQL
   16 database. Capture exact HEAD/tree, image digest/server version, database
   OID, owner/app identities and flags, migration identities/checksums, test
   counts, cleanup proof, and final clean state in one redacted self-binding
   artifact.
3. Obtain exact-head spec/security and code-quality reviews. Any blocker,
   important finding, timeout, truncation, dirty state, wrong hash, catalog
   mismatch, leaked marker, or cleanup residue is HOLD.
4. Push only a clean committed candidate and require exact-head GitHub CI
   before merge.
5. Merge leaves generated code `CLOSED` and does not authorize real customer
   data, object storage, backups, jobs, OAuth, providers, connectors, MCP,
   deployment, public access, Gate 3, or full Gate 2.

## Gate 2-A acceptance matrix

The slice is complete only when:

- The journal proves immutable contiguous migrations and rejects any role,
  schema, object, checksum, identity, gap, or adoption ambiguity.
- The dedicated definer owns only allowlisted functions; all safe
  `search_path`, signature, return, owner, flag, grant, default-ACL, RLS, and
  policy assertions match exactly.
- The app has no direct identity-directory or mutation access. Every table and
  operation matches the privilege matrix; `PUBLIC`, app update/delete/
  truncate, migration, role administration, and schema creation deny.
- Invitation verified-email, immutable identity, no-email-linking, stored-role,
  expiry, key-version, existing-membership, replay, and race tests pass.
- Session issue/resolve/rotation/CSRF/database-clock expiry/revision/revocation
  and lock-race tests pass; arbitrary GUC context cannot create authority.
- Restricted-role cross-tenant read, count, insert, update, delete, truncate,
  reference, and global-directory tests deny and remain denied after pool
  reuse.
- Immutable facts reject update/delete, CAS has one winner including null-head
  cases, and every failure preserves the prior good head.
- Every committed security mutation has exactly one audit event in the same
  transaction. Action, target type/ID, actor, organization, authority revision,
  outcome, and operation time are fixed or derived as specified; request ID and
  deployment revision carry only their documented limited provenance. Audit
  failure leaves zero mutation residue, and audit/logs contain no secret or
  unnecessary identity/source content.
- CI is reproducible from the three exact variables, serial PostgreSQL command,
  digest-pinned image, validated temporary login, captured/redacted log, and
  deterministic cleanup.
- Existing README contract tests, the repo-wide forbidden-sink tripwire, exact
  generated-code `Status: CLOSED`, Gate 4/Gate 7 real-user requirements, and
  every no-real-data/no-deployment boundary remain intact.
