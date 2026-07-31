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
under locks before commit. Direct app DML is read-only; reviewed,
operation-specific functions own all mutations and their audit writes.

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

Before opening the migration transaction, the owner connection runs a
fail-closed cluster-role bootstrap:

1. `dasher_app` must be absent or already carry the exact shared comment
   `dasher:managed-role:v1:app`. If absent, create it as `NOLOGIN NOINHERIT
NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD
NULL` and add that comment. If present without the exact comment, with any
   differing flag, password verifier, membership, owned object, or unexpected
   grant, abort. Never alter or adopt it.
2. `dasher_security_definer` follows the same rule with comment
   `dasher:managed-role:v1:security-definer` and flags `NOLOGIN NOINHERIT
NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD NULL`.
   It owns no schema, table, sequence, type, or database and has no role
   membership. It owns only the allowlisted `SECURITY DEFINER` routines from
   `0002` and `0003`, and receives only their explicit table/column privileges.
3. `dasher_security_definer` is the one explicit exception to the
   `NOBYPASSRLS` runtime rule. Forced RLS makes a privileged pre-auth invite or
   session lookup otherwise impossible. The role cannot log in, cannot create
   anything, owns no data, and gains authority only when an allowlisted,
   fully-qualified function body executes.
4. A known managed role may be reused only when its exact marker, flags,
   memberships, ownership allowlist, and grants match the journal state.
   Cluster-global roles are not treated as installed merely because a
   per-database journal exists.

Every `SECURITY DEFINER` routine:

- is owned by `dasher_security_definer`;
- is SQL or PL/pgSQL with `SET search_path = pg_catalog`;
- references every non-catalog object by schema-qualified name;
- contains no dynamic SQL and accepts no relation, schema, SQL, actor,
  organization, user, role, audit-action, or audit-outcome selector;
- has `REVOKE ALL ON FUNCTION ... FROM PUBLIC` and an exact
  `GRANT EXECUTE ... TO dasher_app`;
- returns only the columns named in this plan; and
- is catalog-asserted for owner, `prosecdef`, language, volatility,
  `proconfig`, identity argument types, result type, and ACL.

The migration owner retains no `EXECUTE` grant through `PUBLIC`; ownership is
its administrative authority. `dasher_app` cannot assume the definer or owner
role.

### Immutable migration series and no-adoption journal

Canonical filenames match
`^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$`; the four-digit prefix is the
integer sequence. Sequences start at `0001`, are contiguous, and filenames are
unique. Each canonical file is introduced once with its complete contents and
is never edited, reordered, renamed, or deleted after application. A correction
is the next numbered migration. Task 2 tests the runner only with dedicated
fixture migrations, never with a partially authored canonical file.

Under one transaction, the runner first calls
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
  trimmed/lowercase with no controls and is not an identity key.
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
outcome in its body. Organization, actor/service, authority revision, request
ID, and current session are derived from validated context; pre-auth acceptance
derives the actor and organization from the locked invitation and immutable
external identity. The app receives no generic audit-insert routine and cannot
supply actor, organization, revision, action, or outcome.

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
uuid, smallint, bytea, smallint, bytea, uuid, text) RETURNS TABLE
(user_id uuid, organization_id uuid, membership_id uuid, granted_role text,
authority_revision bigint, session_id uuid, idle_expires_at timestamptz,
absolute_expires_at timestamptz)`. Inputs are invite key version/digest,
  issuer, subject, normalized verified email, email-verified flag, new session
  ID and session/CSRF key-version/digests, server request ID, and validated
  deployment revision. There is no caller organization, user, membership role,
  expiry, actor, or audit selector.
- `dasher_api.issue_session(text, text, uuid, uuid, smallint, bytea, smallint,
bytea, uuid, text) RETURNS` the same session/context columns. The first
  identity pair is verified by the server; the supplied opaque membership ID
  must belong to that immutable identity and be active. It cannot select an
  organization directly.
- `dasher_api.initialize_context(smallint, bytea, uuid) RETURNS TABLE
(session_id uuid, user_id uuid, organization_id uuid, membership_id uuid,
authority_revision bigint, idle_expires_at timestamptz,
absolute_expires_at timestamptz)`. Its only authority input is the session
  key version/digest; request ID is non-authoritative. It sets transaction-local
  session ID, session key version, session digest hex, user, organization,
  membership, revision, and request ID after validation. It rejects
  autocommit/non-transaction use.
- `dasher_private.context_allows(uuid, text) RETURNS boolean` and typed context
  accessors return only a boolean or one typed value. They are used by policies,
  not called as data lookup APIs. `context_allows` verifies every GUC against
  the exact unexpired, unreplaced, unrevoked session digest and active
  membership/revision. Missing, malformed, manually set, stale, or mismatched
  values return false.
- Operation-specific invite issue/revoke, membership role/revoke, session
  rotate/revoke functions accept only operation data plus the current CSRF key
  version/digest and deployment revision. Each returns only the affected ID,
  new revision where relevant, and expiry metadata where relevant.

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

Invitation issuance requires locked current admin authority. Role order is
`viewer < editor < admin`; the server-owned admin ceiling is `admin`. A
requested role above the derived ceiling is rejected, never silently clamped.
The exact requested role and derived ceiling are stored. Before inserting, the
function locks the actor membership and all pending invitations for the same
organization/email, revokes those older pending invitations, then inserts one
new invitation and audit event.

Acceptance requires a server-verified external identity input with
`email_verified = true` and an exactly normalized verified email. The
acceptance function locks in this order:

1. claim the invitation by exact key version/digest `FOR UPDATE`;
2. capture one database `clock_timestamp()` and require not accepted, not
   revoked, and `now < expires_at`;
3. require exact normalized-email equality;
4. lock existing `(issuer, subject)` or create a new user and immutable
   identity, retrying the unique-key race by reading the winner;
5. lock any membership for that derived user and invitation organization;
6. create it with the stored `granted_role`, or, if already active, leave its
   role/revision unchanged; a revoked membership denies and requires a separate
   admin operation;
7. conditionally mark this invitation accepted, issue the initial session at
   the effective current membership revision, write the fixed audit event, and
   commit.

The identity is never rebound. If it exists, use its user. If it does not,
create a new user and identity. Never search, merge, or link a user by email.
Concurrent acceptance has exactly one conditional invitation transition and
one winner. An existing active membership consumes the invitation but cannot
upgrade or downgrade the membership.

Unknown, malformed, expired, revoked, replayed, wrong-email, unverified-email,
identity-race-loser, and revoked-membership cases have one public denial.
Gate 2-A writes no tenant audit for a denied transaction. All pre-auth denials,
including organization-less unknown tokens, emit only a rate-limited structured
server security event containing request ID and a bounded reason code—never
token, digest, email, issuer/subject, organization existence, or raw error.

### Database-clock session, revocation, and CSRF protocol

The database fixes idle lifetime at 30 minutes and absolute lifetime at 7 days;
callers cannot supply either. Every routine captures one `clock_timestamp()`.
Expiry is inclusive: deny when `now >= expires_at`. `initialize_context`
performs an unlocked digest probe only to discover row keys, then locks the
membership followed by the session, re-reads both, and validates token,
lineage, revocation, state, revision, and both expiries before setting local
context. At most once per five minutes it conditionally advances
`last_seen_at = now` and `idle_expires_at = least(now + interval '30 minutes',
absolute_expires_at)`.

All authenticated state changes require the current CSRF version/digest and
compare it to the locked session row. The service computes the domain-separated
digest and uses constant-time comparison before the call; the database routine
also requires exact byte equality. Exemptions are only read-only session
resolution, server-verified external-identity login/session issue, invitation
acceptance, and a future login callback. No HTTP route is added in this slice.

The universal mutation lock order is:

1. all involved membership rows ordered by `(organization_id, user_id)`;
2. current and affected sessions ordered by `(organization_id, session_id)`;
3. the invitation, dashboard, or other mutable target;
4. immutable inserts and audit.

Every authenticated mutation revalidates the context's session digest and
membership after acquiring those locks in the same transaction. Membership
role/state changes lock actor and target memberships in the universal order,
change role/state and increment `authority_revision` exactly once, then revoke
all target sessions in session-ID order with reason `authority_changed`.
Revision mismatch independently invalidates any session missed by that update.

Rotation locks membership, predecessor session, then any lineage row. It
conditionally updates the predecessor only when it is current, live, and has
no successor; inserts one successor bound to the same current revision; sets
both lineage directions; audits; and commits. Concurrent rotations produce one
successor and one generic conflict with no tenant audit.

Tests cover revocation committed before authority locking, revocation waiting
behind a mutation that already holds authority, and revocation winning before
the mutation's final recheck. No transaction spans a network call.

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
the owner transactionally revokes the definer's `INSERT` on
`dasher.audit_events`, runs the app mutation and proves the entire mutation
rolls back, then restores the exact grant in `finally` and re-runs catalog
assertions.

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

1. Add `0002_security_boundary.sql` once with the exact function signatures,
   ownership, safe search path, policies, column grants, revocations, default
   privileges, database-clock rules, and lock protocols above.
2. Expose session-bound `initialize_context`; do not expose an arbitrary
   context setter. Include session ID, key version, and digest in the predicate
   binding so manual GUC forgery denies.
3. Implement invitation, session, membership, and fixed audit operations only
   through their allowlisted functions.
4. Test no-context/manual-context/invalid-context, wrong user/org/revision,
   revoked membership/session, transaction cleanup, pool reuse, `PUBLIC`
   execution denial, caller-controlled org/user/role denial, malicious
   `search_path`, and minimal return shapes.

Expected commit: `feat: enforce session-bound tenant authority`.

### Task 5: Secret, email, and cookie primitives

1. Implement exact token formats, 32-byte generation, domain-separated HMAC,
   bounded key ring/version lookup, and constant-time comparison.
2. Normalize email by trimming, rejecting controls and empty/ambiguous values,
   lowercasing the ASCII domain, and applying one documented local-part rule:
   preserve local-part bytes exactly. Acceptance compares the resulting exact
   string; email is never identity.
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

1. Add `0003_immutable_content.sql` once with the complete DDL, composite FKs,
   indexes, forced RLS policies, ACLs, trigger enforcement, function ownership,
   create routines, and CAS routine above.
2. Parse and validate `DashboardSpec` before persistence; canonicalize bytes
   once and verify the stored SHA-256. Resolve every evidence/snapshot ID in the
   same tenant before creating a version.
3. Implement exactly the null-safe CAS/audit transaction. Conflicts write no
   tenant audit and preserve the prior good head.
4. Test cross-tenant read/count/reference and direct insert/update/delete/
   truncate denial; forged evidence/snapshot IDs; owner-side immutable trigger
   rejection; CAS null/non-null winner-loser races; and audit rollback.

Expected commit: `feat: add immutable dashboard persistence`.

### Task 9: Reproducible PostgreSQL 16 adversarial gate

1. After connecting, prove owner and app target the same server/database OID
   but have distinct `session_user`. Prove the owner is the expected database
   owner; the app login has exact safe flags and only membership in
   `dasher_app`; `SET ROLE dasher_app` yields exact `current_user`; neither
   login nor app can migrate/bypass RLS; and neither can assume the definer.
2. Create the app login from the app DSN as `LOGIN NOINHERIT NOSUPERUSER
NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, grant only
   `dasher_app` membership and database `CONNECT`, and mark it with an
   invocation-specific comment. It has no owner/definer membership. Never log
   its password.
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
- Every committed security mutation has exactly one fixed, non-forgeable audit
  event in the same transaction; audit failure leaves zero mutation residue;
  audit and logs contain no secret or unnecessary identity/source content.
- CI is reproducible from the three exact variables, serial PostgreSQL command,
  digest-pinned image, validated temporary login, captured/redacted log, and
  deterministic cleanup.
- Existing README contract tests, the repo-wide forbidden-sink tripwire, exact
  generated-code `Status: CLOSED`, Gate 4/Gate 7 real-user requirements, and
  every no-real-data/no-deployment boundary remain intact.
