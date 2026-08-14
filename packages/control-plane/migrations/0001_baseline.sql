-- Dasher baseline schema.
--
-- This file replaces the twelve-migration series that preceded it. Those files
-- live in history rather than in the tree; read them with
-- `git ls-tree --name-only f521b2c packages/control-plane/migrations/`.
--
-- Migrations are MUTABLE until the first production deployment. Before that
-- point, a schema change is made by editing this file and recreating the
-- development database; there is no data to preserve and no deployment to
-- protect. From the first production deployment onward the series becomes
-- forward-only and append-only, and this file becomes immutable.
--
-- What is kept from the superseded series:
--   * a write seam: `dasher_app` reaches state-changing operations only
--     through `dasher_api` SECURITY DEFINER functions that derive the acting
--     principal themselves (in progress; see the note below)
--   * row-level security on every tenant-scoped table, FORCEd on all but
--     `memberships` — see the note above `context_allows` for why that one
--     cannot be forced without recursing
--   * composite (organization_id, ...) foreign keys, so a child row can never
--     reference a parent in another organization
--   * a single restricted NOBYPASSRLS application role
--   * record immutability on audit events and published dashboard versions
--
-- What is deliberately dropped:
--   * disposable-dashboard lifecycle: expiry, promotion, quarantine, purge,
--     tombstones, restore lineage, legal holds, retention policy
--   * deletion finalizers and reference-claim tables
--   * the agent-run ledger's leases, epochs, budgets, meters, checkpoints, and
--     content-addressed replay
--   * the PL/pgSQL calculation evaluator, superseded by
--     @dasher/calculation-engine
--   * the multi-role apparatus: several restricted roles, retention operators,
--     and service-principal allowlist tables, which enforced a privilege
--     boundary between components that run in one process as one database user
--
-- `dasher_app` holds no INSERT or UPDATE on any table. Every state change goes
-- through a `dasher_api` function that derives the acting principal from the
-- verified context rather than accepting it, so actor attribution cannot be
-- forged; and each writes its own audit event in the same statement, so audit
-- atomicity is a property of the schema rather than a convention.
--
-- KNOWN OPEN. Three independent reviews of this seam found further defects.
-- Each one below was reproduced as a failing test before it was written, and
-- each fix was then confirmed by breaking it again and requiring that test to
-- go red.
--
-- Fixed so far: context replay, by binding the digest to the transaction that
-- established it; the fail-open when the context key was missing; taking the
-- opaque token rather than the stored verifier, which was itself a credential;
-- authority revalidation in `verified_context`, so a revoked or re-roled
-- membership stops authorizing immediately; the membership guard that makes a
-- role change advance the authority revision; atomic session establishment, so
-- a concurrent revocation cannot commit between `begin_request`'s read and its
-- write; and acceptance binding in `accept_invitation`, which no longer takes
-- the accepting user as an argument, and whose reactivation branch now sets
-- `role` to the granted role rather than leaving a revoked administrator's.
--
-- Also fixed: the schema no longer requires a privileged owner. It used to
-- force row-level security on thirteen tables, which subjects the table owner
-- to the policies -- and every seam function runs as that owner. Against a
-- NOSUPERUSER NOBYPASSRLS owner the entire seam was dead, denying every valid
-- token with the error a wrong one produces. FORCE is gone, and the migrator
-- refuses a series that reintroduces it.
--
-- Still open, each with a reproduced case: `record_evidence` writes no audit
-- event though the action is in the allowlist; evidence and claim digests are
-- length-checked but never tied to content; `finalize_run` stamps `valid`
-- without validating anything; audit events hardcode authority revision 1;
-- archive transitions accept the state they are already in; and REPEATABLE
-- READ freezes the membership snapshot and defers revocation.
--
-- All 26 originally enumerated states in
-- test/accepted-invalid-states.integration.test.ts are closed. Creating an
-- organization is deliberately absent from the seam: PRODUCT_REQUIREMENTS.md
-- makes managing organizations an administrator action and names public signup
-- a non-goal, so provisioning is an operator path using owner credentials.

-- ---------------------------------------------------------------------------
-- Schemas and default privileges
-- ---------------------------------------------------------------------------

DO $migration$
DECLARE
  database_name name := pg_catalog.current_database();
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC',
    database_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON DATABASE %I FROM dasher_app',
    database_name
  );
END
$migration$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA dasher AUTHORIZATION CURRENT_USER;
CREATE SCHEMA dasher_private AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA dasher FROM PUBLIC, dasher_app;
REVOKE ALL ON SCHEMA dasher_private FROM PUBLIC, dasher_app;

GRANT USAGE ON SCHEMA dasher TO dasher_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_private
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_private
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- PostgreSQL grants PUBLIC function EXECUTE and type USAGE globally. A
-- per-schema REVOKE cannot subtract a global default, so the migration owner
-- closes them globally as well.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Request context
--
-- The application sets two GUCs per request and every row-level security
-- policy reads them. These two readers are plain STABLE functions:
-- `current_setting` with `missing_ok` needs no elevated rights. The
-- authorization helper further down, `context_allows`, *is* SECURITY DEFINER
-- for a reason recorded there.
--
-- These read whatever the session was told. They do not establish it, and
-- nothing here verifies that the caller is entitled to the identity it names.
-- ---------------------------------------------------------------------------

-- The request context is a signed assertion, bound to one transaction.
--
-- PostgreSQL offers no way to stop a role setting a custom GUC: `REVOKE SET ON
-- PARAMETER` is accepted for a two-part placeholder name and then has no
-- effect, which was verified rather than assumed. So `dasher_app` can always
-- write `dasher.context_user_id`, and it can always *read* every setting with
-- `current_setting`. Anything the seam leaves in a setting is therefore
-- material the caller holds.
--
-- That is why the digest covers the transaction identifier. Signing only the
-- principal would make the digest a bearer credential: a caller could capture
-- the settings after one legitimate request, and replay them later — in
-- another transaction, on another connection, after the session was revoked —
-- because nothing in the signed payload would have changed. Verified: it
-- worked, and it is the defect this construction exists to prevent.
--
-- Binding the transaction identifier makes a captured set useless anywhere but
-- where it was issued. The session and authority revision are bound too, so a
-- context also names which session produced it and under what authority.

CREATE TABLE dasher_private.context_keys (
  singleton boolean NOT NULL DEFAULT true,
  secret bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT context_keys_pkey PRIMARY KEY (singleton),
  CONSTRAINT context_keys_singleton_check CHECK (singleton),
  CONSTRAINT context_keys_secret_check CHECK (
    pg_catalog.octet_length(secret) = 32
  )
);

-- Two v4 UUIDs give 32 bytes from the same CSPRNG `gen_random_uuid` uses, so
-- the key needs no extension. It is per-deployment: a database recreated from
-- this migration gets a different one, which is the desired behaviour.
INSERT INTO dasher_private.context_keys (secret)
VALUES (
  pg_catalog.decode(
    pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
    'hex'
  )
);

-- Keyed on both sides, so the digest cannot be extended into a valid digest
-- for a longer payload.
--
-- Returns NULL when no key row exists. Every caller must treat that as a
-- failure rather than comparing against it, because `NULL <> anything` is NULL
-- and not TRUE — a comparison would fall through and admit the caller. That
-- was the behaviour here before, and it made key loss fail open.
CREATE FUNCTION dasher_private.context_digest(
  p_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_authority_revision bigint,
  p_transaction_id text
)
RETURNS bytea
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.sha256(
    key_row.secret
    || pg_catalog.convert_to(
         p_user_id::text
         || ':' || p_organization_id::text
         || ':' || p_session_id::text
         || ':' || p_authority_revision::text
         || ':' || p_transaction_id,
         'UTF8'
       )
    || key_row.secret
  )
  FROM dasher_private.context_keys AS key_row
  WHERE key_row.singleton;
$function$;

-- Returns the principal only when the stamped digest matches the settings
-- *and* the transaction they were stamped in. Anything else yields no row, and
-- every policy then denies.
--
-- `pg_current_xact_id_if_assigned` rather than `pg_current_xact_id`: the
-- former returns NULL instead of assigning an identifier, so a caller cannot
-- burn transaction identifiers by repeatedly failing this check. A legitimate
-- context always has one assigned, because `begin_request` writes before it
-- stamps.
CREATE FUNCTION dasher_private.verified_context()
RETURNS TABLE (user_id uuid, organization_id uuid, authority_revision bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  claimed_user uuid;
  claimed_organization uuid;
  claimed_session uuid;
  claimed_authority bigint;
  claimed_digest bytea;
  current_transaction text;
  expected_digest bytea;
BEGIN
  BEGIN
    claimed_user :=
      pg_catalog.current_setting('dasher.context_user_id', true)::uuid;
    claimed_organization :=
      pg_catalog.current_setting('dasher.context_organization_id', true)::uuid;
    claimed_session :=
      pg_catalog.current_setting('dasher.context_session_id', true)::uuid;
    claimed_authority :=
      pg_catalog.current_setting('dasher.context_authority', true)::bigint;
    claimed_digest := pg_catalog.decode(
      pg_catalog.current_setting('dasher.context_digest', true),
      'hex'
    );
  EXCEPTION
    WHEN OTHERS THEN
      RETURN;
  END;

  current_transaction := pg_catalog.pg_current_xact_id_if_assigned()::text;

  IF claimed_user IS NULL
    OR claimed_organization IS NULL
    OR claimed_session IS NULL
    OR claimed_authority IS NULL
    OR claimed_digest IS NULL
    OR current_transaction IS NULL
  THEN
    RETURN;
  END IF;

  expected_digest := dasher_private.context_digest(
    claimed_user,
    claimed_organization,
    claimed_session,
    claimed_authority,
    current_transaction
  );

  -- IS DISTINCT FROM, and an explicit NULL guard: a plain `<>` against a NULL
  -- expected digest yields NULL, which is not TRUE, so the RETURN would be
  -- skipped and the caller admitted.
  IF expected_digest IS NULL
    OR claimed_digest IS DISTINCT FROM expected_digest
  THEN
    RETURN;
  END IF;

  -- The digest proves the context was issued. It does not prove the
  -- membership behind it still stands, so that is checked live: an inactive
  -- membership, or one whose authority has moved past the revision this
  -- context names, yields no principal at all. Doing it here rather than in
  -- `context_allows` means one place decides whether a context is live, and
  -- nothing downstream can reach a different answer.
  IF NOT EXISTS (
    SELECT 1
    FROM dasher.memberships AS m
    WHERE m.organization_id = claimed_organization
      AND m.user_id = claimed_user
      AND m.state = 'active'
      AND m.authority_revision = claimed_authority
  ) THEN
    RETURN;
  END IF;

  user_id := claimed_user;
  organization_id := claimed_organization;
  authority_revision := claimed_authority;
  RETURN NEXT;
END
$function$;

CREATE FUNCTION dasher_private.context_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT verified.user_id FROM dasher_private.verified_context() AS verified;
$function$;

CREATE FUNCTION dasher_private.context_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT verified.organization_id
  FROM dasher_private.verified_context() AS verified;
$function$;

CREATE FUNCTION dasher_private.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'immutable relation rejects update and delete';
END
$function$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE dasher.users (
  user_id uuid CONSTRAINT users_pkey PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp()
);

CREATE TABLE dasher.external_identities (
  issuer varchar(512) NOT NULL,
  subject varchar(512) NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT external_identities_pkey PRIMARY KEY (issuer, subject),
  CONSTRAINT external_identities_user_key UNIQUE (user_id),
  CONSTRAINT external_identities_issuer_check CHECK (
    issuer = pg_catalog.btrim(issuer)
    AND pg_catalog.char_length(issuer) BETWEEN 1 AND 512
    AND issuer !~ '[[:cntrl:]]'
  ),
  CONSTRAINT external_identities_subject_check CHECK (
    subject = pg_catalog.btrim(subject)
    AND pg_catalog.char_length(subject) BETWEEN 1 AND 512
    AND subject !~ '[[:cntrl:]]'
  ),
  CONSTRAINT external_identities_user_fkey FOREIGN KEY (user_id)
    REFERENCES dasher.users (user_id)
);

CREATE TABLE dasher.organizations (
  organization_id uuid CONSTRAINT organizations_pkey PRIMARY KEY,
  display_name varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT organizations_display_name_check CHECK (
    display_name = pg_catalog.btrim(display_name)
    AND pg_catalog.char_length(display_name) BETWEEN 1 AND 200
    AND display_name !~ '[[:cntrl:]]'
  )
);

CREATE TABLE dasher.memberships (
  membership_id uuid CONSTRAINT memberships_pkey PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role varchar(16) NOT NULL,
  state varchar(16) NOT NULL,
  authority_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT memberships_org_user_key UNIQUE (organization_id, user_id),
  CONSTRAINT memberships_org_membership_key
    UNIQUE (organization_id, membership_id),
  CONSTRAINT memberships_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT memberships_user_fkey FOREIGN KEY (user_id)
    REFERENCES dasher.users (user_id),
  CONSTRAINT memberships_role_check CHECK (
    role IN ('admin', 'editor', 'viewer')
  ),
  CONSTRAINT memberships_state_check CHECK (state IN ('active', 'revoked')),
  CONSTRAINT memberships_authority_revision_check CHECK (
    authority_revision >= 1
  ),
  CONSTRAINT memberships_state_revoked_at_check CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT memberships_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX memberships_user_idx
  ON dasher.memberships USING btree (user_id);
CREATE INDEX memberships_active_authority_idx
  ON dasher.memberships USING btree (
    organization_id,
    user_id,
    authority_revision
  )
  WHERE state = 'active';

CREATE TABLE dasher.invitations (
  invitation_id uuid CONSTRAINT invitations_pkey PRIMARY KEY,
  organization_id uuid NOT NULL,
  normalized_email varchar(320) NOT NULL,
  granted_role varchar(16) NOT NULL,
  role_ceiling varchar(16) NOT NULL,
  token_key_version smallint NOT NULL,
  token_digest bytea NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  CONSTRAINT invitations_org_id_key UNIQUE (organization_id, invitation_id),
  CONSTRAINT invitations_token_key UNIQUE (token_key_version, token_digest),
  CONSTRAINT invitations_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT invitations_creator_fkey FOREIGN KEY (
    organization_id,
    created_by_user_id
  ) REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT invitations_accepted_user_fkey FOREIGN KEY (accepted_user_id)
    REFERENCES dasher.users (user_id),
  CONSTRAINT invitations_revoker_fkey FOREIGN KEY (
    organization_id,
    revoked_by_user_id
  ) REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT invitations_normalized_email_check CHECK (
    normalized_email = pg_catalog.btrim(normalized_email)
    AND normalized_email = pg_catalog.lower(normalized_email)
    AND pg_catalog.char_length(normalized_email) BETWEEN 1 AND 320
    AND normalized_email !~ '[[:cntrl:]]'
  ),
  CONSTRAINT invitations_granted_role_check CHECK (
    granted_role IN ('admin', 'editor', 'viewer')
  ),
  CONSTRAINT invitations_role_ceiling_check CHECK (
    role_ceiling IN ('admin', 'editor', 'viewer')
  ),
  CONSTRAINT invitations_role_order_check CHECK (
    CASE granted_role
      WHEN 'viewer' THEN 1
      WHEN 'editor' THEN 2
      WHEN 'admin' THEN 3
    END
    <=
    CASE role_ceiling
      WHEN 'viewer' THEN 1
      WHEN 'editor' THEN 2
      WHEN 'admin' THEN 3
    END
  ),
  CONSTRAINT invitations_token_key_version_check CHECK (
    token_key_version BETWEEN 1 AND 32767
  ),
  CONSTRAINT invitations_token_digest_check CHECK (
    pg_catalog.octet_length(token_digest) = 32
  ),
  CONSTRAINT invitations_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT invitations_accepted_fields_check CHECK (
    (accepted_at IS NULL) = (accepted_user_id IS NULL)
  ),
  CONSTRAINT invitations_revoked_fields_check CHECK (
    (revoked_at IS NULL) = (revoked_by_user_id IS NULL)
  ),
  CONSTRAINT invitations_terminal_state_check CHECK (
    accepted_at IS NULL OR revoked_at IS NULL
  ),
  CONSTRAINT invitations_accepted_window_check CHECK (
    accepted_at IS NULL
    OR (accepted_at >= created_at AND accepted_at < expires_at)
  ),
  CONSTRAINT invitations_revoked_order_check CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX invitations_creator_idx
  ON dasher.invitations USING btree (organization_id, created_by_user_id);
CREATE INDEX invitations_accepted_user_idx
  ON dasher.invitations USING btree (accepted_user_id);
CREATE INDEX invitations_revoker_idx
  ON dasher.invitations USING btree (organization_id, revoked_by_user_id);
CREATE INDEX invitations_email_created_idx
  ON dasher.invitations USING btree (
    organization_id,
    normalized_email,
    created_at DESC
  );

CREATE TABLE dasher.sessions (
  session_id uuid CONSTRAINT sessions_pkey PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  authority_revision bigint NOT NULL,
  token_key_version smallint NOT NULL,
  token_digest bytea NOT NULL,
  csrf_key_version smallint NOT NULL,
  csrf_digest bytea NOT NULL,
  issued_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  rotated_from_session_id uuid,
  replaced_by_session_id uuid,
  revoked_at timestamptz,
  revocation_reason varchar(32),
  CONSTRAINT sessions_org_id_key UNIQUE (organization_id, session_id),
  CONSTRAINT sessions_token_key UNIQUE (token_key_version, token_digest),
  CONSTRAINT sessions_csrf_key UNIQUE (csrf_key_version, csrf_digest),
  CONSTRAINT sessions_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT sessions_membership_fkey FOREIGN KEY (organization_id, user_id)
    REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT sessions_rotated_from_fkey FOREIGN KEY (
    organization_id,
    rotated_from_session_id
  ) REFERENCES dasher.sessions (organization_id, session_id),
  CONSTRAINT sessions_replaced_by_fkey FOREIGN KEY (
    organization_id,
    replaced_by_session_id
  ) REFERENCES dasher.sessions (organization_id, session_id),
  CONSTRAINT sessions_authority_revision_check CHECK (authority_revision >= 1),
  CONSTRAINT sessions_token_key_version_check CHECK (
    token_key_version BETWEEN 1 AND 32767
  ),
  CONSTRAINT sessions_token_digest_check CHECK (
    pg_catalog.octet_length(token_digest) = 32
  ),
  CONSTRAINT sessions_csrf_key_version_check CHECK (
    csrf_key_version BETWEEN 1 AND 32767
  ),
  CONSTRAINT sessions_csrf_digest_check CHECK (
    pg_catalog.octet_length(csrf_digest) = 32
  ),
  CONSTRAINT sessions_last_seen_check CHECK (
    issued_at <= last_seen_at
    AND last_seen_at < idle_expires_at
    AND last_seen_at < absolute_expires_at
  ),
  CONSTRAINT sessions_idle_expiry_check CHECK (
    issued_at < idle_expires_at AND idle_expires_at <= absolute_expires_at
  ),
  CONSTRAINT sessions_lineage_check CHECK (
    (rotated_from_session_id IS NULL OR rotated_from_session_id <> session_id)
    AND (replaced_by_session_id IS NULL OR replaced_by_session_id <> session_id)
    AND (
      rotated_from_session_id IS NULL
      OR replaced_by_session_id IS NULL
      OR rotated_from_session_id <> replaced_by_session_id
    )
  ),
  CONSTRAINT sessions_revocation_fields_check CHECK (
    (revoked_at IS NULL) = (revocation_reason IS NULL)
  ),
  CONSTRAINT sessions_revocation_reason_check CHECK (
    revocation_reason IS NULL
    OR (
      revocation_reason = pg_catalog.btrim(revocation_reason)
      AND pg_catalog.char_length(revocation_reason) BETWEEN 1 AND 32
      AND revocation_reason !~ '[[:cntrl:]]'
    )
  )
);

CREATE INDEX sessions_rotated_from_idx
  ON dasher.sessions USING btree (organization_id, rotated_from_session_id);
CREATE INDEX sessions_replaced_by_idx
  ON dasher.sessions USING btree (organization_id, replaced_by_session_id);
CREATE INDEX sessions_live_user_idx
  ON dasher.sessions USING btree (organization_id, user_id, revoked_at);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TABLE dasher.audit_events (
  audit_event_id uuid CONSTRAINT audit_events_pkey PRIMARY KEY,
  organization_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  actor_kind varchar(16) NOT NULL,
  actor_user_id uuid,
  actor_service varchar(64),
  authority_revision bigint NOT NULL,
  request_id uuid NOT NULL,
  action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id uuid NOT NULL,
  outcome varchar(16) NOT NULL,
  content_sha256 bytea,
  deployment_revision varchar(64) NOT NULL,
  CONSTRAINT audit_events_org_id_key UNIQUE (organization_id, audit_event_id),
  CONSTRAINT audit_events_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT audit_events_actor_fkey FOREIGN KEY (
    organization_id,
    actor_user_id
  ) REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT audit_events_actor_kind_check CHECK (
    actor_kind IN ('user', 'service')
  ),
  CONSTRAINT audit_events_actor_check CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL
      AND actor_service IS NULL)
    OR (actor_kind = 'service' AND actor_user_id IS NULL
      AND actor_service IS NOT NULL)
  ),
  CONSTRAINT audit_events_actor_service_check CHECK (
    actor_service IS NULL
    OR (
      actor_service = pg_catalog.btrim(actor_service)
      AND pg_catalog.char_length(actor_service) BETWEEN 1 AND 64
      AND actor_service !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT audit_events_authority_revision_check CHECK (
    authority_revision >= 1
  ),
  CONSTRAINT audit_events_action_check CHECK (
    action IN (
      'membership.role_changed',
      'membership.revoked',
      'invitation.issued',
      'invitation.revoked',
      'invitation.accepted',
      'invitation.accepted_existing_membership',
      'session.issued',
      'session.rotated',
      'session.revoked',
      'source_snapshot.created',
      'evidence_record.created',
      'dashboard.created',
      'dashboard.archived',
      'dashboard.unarchived',
      'dashboard_version.created',
      'dashboard_head.promoted',
      'agent_run.started',
      'agent_run.finished'
    )
  ),
  CONSTRAINT audit_events_target_type_check CHECK (
    target_type = pg_catalog.btrim(target_type)
    AND pg_catalog.char_length(target_type) BETWEEN 1 AND 32
    AND target_type !~ '[[:cntrl:]]'
  ),
  CONSTRAINT audit_events_outcome_check CHECK (outcome = 'succeeded'),
  CONSTRAINT audit_events_content_sha256_check CHECK (
    content_sha256 IS NULL OR pg_catalog.octet_length(content_sha256) = 32
  ),
  CONSTRAINT audit_events_deployment_revision_check CHECK (
    deployment_revision = pg_catalog.btrim(deployment_revision)
    AND pg_catalog.char_length(deployment_revision) BETWEEN 1 AND 64
    AND deployment_revision !~ '[[:cntrl:]]'
  )
);

CREATE INDEX audit_events_actor_idx
  ON dasher.audit_events USING btree (organization_id, actor_user_id);
CREATE INDEX audit_events_occurred_idx
  ON dasher.audit_events USING btree (
    organization_id,
    occurred_at,
    audit_event_id
  );

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON dasher.audit_events
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

-- ---------------------------------------------------------------------------
-- Evidence
--
-- The epistemic chain is: a source snapshot holds retrieved bytes; an evidence
-- record names a coordinate within one snapshot; a claim cites evidence. Every
-- assertion a dashboard displays traces to bytes that were actually retrieved.
-- ---------------------------------------------------------------------------

CREATE TABLE dasher.source_snapshots (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_kind varchar(64) NOT NULL,
  source_ref varchar(512) NOT NULL,
  canonical_bytes bytea NOT NULL,
  content_sha256 bytea NOT NULL,
  observed_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT source_snapshots_pkey PRIMARY KEY (organization_id, snapshot_id),
  CONSTRAINT source_snapshots_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT source_snapshots_content_sha256_check CHECK (
    content_sha256 = pg_catalog.sha256(canonical_bytes)
  ),
  CONSTRAINT source_snapshots_source_kind_check CHECK (
    source_kind = pg_catalog.btrim(source_kind)
    AND pg_catalog.char_length(source_kind) BETWEEN 1 AND 64
    AND source_kind !~ '[[:cntrl:]]'
  ),
  CONSTRAINT source_snapshots_source_ref_check CHECK (
    source_ref = pg_catalog.btrim(source_ref)
    AND pg_catalog.char_length(source_ref) BETWEEN 1 AND 512
    AND source_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT source_snapshots_retrieved_check CHECK (
    retrieved_at >= observed_at
  )
);

CREATE TABLE dasher.evidence_records (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  evidence_kind varchar(64) NOT NULL,
  coordinates text NOT NULL,
  transformation text NOT NULL,
  content_sha256 bytea NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT evidence_records_pkey PRIMARY KEY (organization_id, evidence_id),
  CONSTRAINT evidence_records_snapshot_fkey FOREIGN KEY (
    organization_id,
    snapshot_id
  ) REFERENCES dasher.source_snapshots (organization_id, snapshot_id),
  CONSTRAINT evidence_records_content_sha256_check CHECK (
    pg_catalog.octet_length(content_sha256) = 32
  ),
  CONSTRAINT evidence_records_evidence_kind_check CHECK (
    evidence_kind = pg_catalog.btrim(evidence_kind)
    AND pg_catalog.char_length(evidence_kind) BETWEEN 1 AND 64
    AND evidence_kind !~ '[[:cntrl:]]'
  ),
  CONSTRAINT evidence_records_coordinates_check CHECK (
    pg_catalog.char_length(coordinates) BETWEEN 1 AND 2048
  ),
  CONSTRAINT evidence_records_transformation_check CHECK (
    pg_catalog.char_length(transformation) BETWEEN 1 AND 2048
  )
);

CREATE INDEX evidence_records_snapshot_idx
  ON dasher.evidence_records USING btree (organization_id, snapshot_id);

-- ---------------------------------------------------------------------------
-- Dashboards
--
-- Lifecycle is draft -> active -> archived. Archiving is reversible and
-- retains authorized access. Nothing expires on a timer.
-- ---------------------------------------------------------------------------

CREATE TABLE dasher.dashboards (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  lifecycle_state varchar(16) NOT NULL,
  lifecycle_revision bigint NOT NULL,
  head_version_id uuid,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  archived_at timestamptz,
  CONSTRAINT dashboards_pkey PRIMARY KEY (organization_id, dashboard_id),
  CONSTRAINT dashboards_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT dashboards_creator_fkey FOREIGN KEY (
    organization_id,
    created_by_user_id
  ) REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT dashboards_title_check CHECK (
    title = pg_catalog.btrim(title)
    AND pg_catalog.char_length(title) BETWEEN 1 AND 200
    AND title !~ '[[:cntrl:]]'
  ),
  CONSTRAINT dashboards_lifecycle_state_check CHECK (
    lifecycle_state IN ('draft', 'active', 'archived')
  ),
  CONSTRAINT dashboards_lifecycle_revision_check CHECK (
    lifecycle_revision >= 1
  ),
  CONSTRAINT dashboards_archived_at_check CHECK (
    (lifecycle_state = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT dashboards_archived_order_check CHECK (
    archived_at IS NULL OR archived_at >= created_at
  ),
  -- A draft has no published head; active and archived states do.
  CONSTRAINT dashboards_head_check CHECK (
    (lifecycle_state = 'draft' AND head_version_id IS NULL)
    OR (lifecycle_state <> 'draft' AND head_version_id IS NOT NULL)
  ),
  CONSTRAINT dashboards_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX dashboards_active_idx
  ON dasher.dashboards USING btree (organization_id, updated_at DESC)
  WHERE lifecycle_state <> 'archived';

CREATE TABLE dasher.dashboard_versions (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  parent_version_id uuid,
  canonical_spec_bytes bytea NOT NULL,
  canonical_spec_sha256 bytea NOT NULL,
  validation_state varchar(16) NOT NULL,
  run_id uuid,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT dashboard_versions_pkey PRIMARY KEY (
    organization_id,
    dashboard_id,
    version_id
  ),
  CONSTRAINT dashboard_versions_org_version_key
    UNIQUE (organization_id, version_id),
  CONSTRAINT dashboard_versions_dashboard_fkey FOREIGN KEY (
    organization_id,
    dashboard_id
  ) REFERENCES dasher.dashboards (organization_id, dashboard_id),
  CONSTRAINT dashboard_versions_parent_fkey FOREIGN KEY (
    organization_id,
    dashboard_id,
    parent_version_id
  ) REFERENCES dasher.dashboard_versions (
    organization_id,
    dashboard_id,
    version_id
  ),
  CONSTRAINT dashboard_versions_creator_fkey FOREIGN KEY (
    organization_id,
    created_by_user_id
  ) REFERENCES dasher.memberships (organization_id, user_id),
  -- Not merely 32 bytes: the digest must actually summarise the bytes stored
  -- beside it, so a row cannot claim a hash unrelated to its content.
  CONSTRAINT dashboard_versions_spec_sha256_check CHECK (
    canonical_spec_sha256 = pg_catalog.sha256(canonical_spec_bytes)
  ),
  CONSTRAINT dashboard_versions_validation_state_check CHECK (
    validation_state IN ('valid', 'invalid')
  ),
  CONSTRAINT dashboard_versions_parent_check CHECK (
    parent_version_id IS NULL OR parent_version_id <> version_id
  )
);

CREATE INDEX dashboard_versions_dashboard_created_idx
  ON dasher.dashboard_versions USING btree (
    organization_id,
    dashboard_id,
    created_at DESC
  );

ALTER TABLE dasher.dashboards
  ADD CONSTRAINT dashboards_head_version_fkey FOREIGN KEY (
    organization_id,
    dashboard_id,
    head_version_id
  ) REFERENCES dasher.dashboard_versions (
    organization_id,
    dashboard_id,
    version_id
  ) DEFERRABLE INITIALLY DEFERRED;

-- A published version is a record. It is never edited in place; a change
-- produces a successor version and moves the head.
CREATE TRIGGER dashboard_versions_immutable
BEFORE UPDATE OR DELETE ON dasher.dashboard_versions
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

-- ---------------------------------------------------------------------------
-- Claims
--
-- A claim is one assertion a dashboard version makes, at a JSON pointer within
-- its spec, cited to evidence. `claim_evidence` is the citation edge.
-- ---------------------------------------------------------------------------

CREATE TABLE dasher.claims (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  json_pointer varchar(512) NOT NULL,
  label varchar(16) NOT NULL,
  salience varchar(8) NOT NULL,
  evidence_state varchar(16) NOT NULL,
  assertion_sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT claims_pkey PRIMARY KEY (
    organization_id,
    dashboard_id,
    version_id,
    claim_id
  ),
  CONSTRAINT claims_pointer_key UNIQUE (
    organization_id,
    dashboard_id,
    version_id,
    json_pointer
  ),
  CONSTRAINT claims_version_fkey FOREIGN KEY (
    organization_id,
    dashboard_id,
    version_id
  ) REFERENCES dasher.dashboard_versions (
    organization_id,
    dashboard_id,
    version_id
  ),
  CONSTRAINT claims_assertion_sha256_check CHECK (
    pg_catalog.octet_length(assertion_sha256) = 32
  ),
  CONSTRAINT claims_label_check CHECK (
    label IN (
      'observed',
      'calculated',
      'hypothesis',
      'recommendation',
      'unknown',
      'blocked'
    )
  ),
  CONSTRAINT claims_salience_check CHECK (salience IN ('high', 'normal')),
  CONSTRAINT claims_evidence_state_check CHECK (
    evidence_state IN (
      'complete',
      'partial',
      'contradicted',
      'stale',
      'unsupported'
    )
  ),
  CONSTRAINT claims_json_pointer_check CHECK (
    json_pointer ~ '^(?:/(?:[^~/[:cntrl:]]|~0|~1)*)+$'
  )
);

CREATE TABLE dasher.claim_evidence (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  relation varchar(16) NOT NULL,
  CONSTRAINT claim_evidence_pkey PRIMARY KEY (
    organization_id,
    dashboard_id,
    version_id,
    claim_id,
    evidence_id,
    relation
  ),
  CONSTRAINT claim_evidence_claim_fkey FOREIGN KEY (
    organization_id,
    dashboard_id,
    version_id,
    claim_id
  ) REFERENCES dasher.claims (
    organization_id,
    dashboard_id,
    version_id,
    claim_id
  ),
  CONSTRAINT claim_evidence_evidence_fkey FOREIGN KEY (
    organization_id,
    evidence_id
  ) REFERENCES dasher.evidence_records (organization_id, evidence_id),
  CONSTRAINT claim_evidence_relation_check CHECK (
    relation IN ('supports', 'contradicts', 'context')
  )
);

CREATE INDEX claim_evidence_evidence_idx
  ON dasher.claim_evidence USING btree (organization_id, evidence_id);

CREATE TRIGGER claims_immutable
BEFORE UPDATE OR DELETE ON dasher.claims
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

CREATE TRIGGER claim_evidence_immutable
BEFORE UPDATE OR DELETE ON dasher.claim_evidence
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

-- ---------------------------------------------------------------------------
-- Agent runs
--
-- A record of one planning request and what it produced. Leases, epochs,
-- budget reservation, meters, checkpoints, and content-addressed replay are
-- deliberately absent: they presuppose asynchronous workers and a metered
-- provider, and neither exists. Add them when there is something to fence.
-- ---------------------------------------------------------------------------

CREATE TABLE dasher.agent_runs (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  dashboard_id uuid,
  requested_by_user_id uuid NOT NULL,
  request_text text NOT NULL,
  state varchar(16) NOT NULL,
  provider varchar(64),
  model varchar(128),
  attempt_count integer NOT NULL DEFAULT 0,
  produced_version_id uuid,
  failure_reason varchar(64),
  started_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  finished_at timestamptz,
  CONSTRAINT agent_runs_pkey PRIMARY KEY (organization_id, run_id),
  CONSTRAINT agent_runs_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES dasher.organizations (organization_id),
  CONSTRAINT agent_runs_dashboard_fkey FOREIGN KEY (
    organization_id,
    dashboard_id
  ) REFERENCES dasher.dashboards (organization_id, dashboard_id),
  CONSTRAINT agent_runs_requester_fkey FOREIGN KEY (
    organization_id,
    requested_by_user_id
  ) REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT agent_runs_version_fkey FOREIGN KEY (
    organization_id,
    dashboard_id,
    produced_version_id
  ) REFERENCES dasher.dashboard_versions (
    organization_id,
    dashboard_id,
    version_id
  ),
  CONSTRAINT agent_runs_state_check CHECK (
    state IN ('running', 'succeeded', 'failed')
  ),
  CONSTRAINT agent_runs_request_text_check CHECK (
    pg_catalog.char_length(request_text) BETWEEN 1 AND 4000
  ),
  CONSTRAINT agent_runs_attempt_count_check CHECK (
    attempt_count BETWEEN 0 AND 16
  ),
  CONSTRAINT agent_runs_terminal_check CHECK (
    (state = 'running' AND finished_at IS NULL)
    OR (state <> 'running' AND finished_at IS NOT NULL)
  ),
  CONSTRAINT agent_runs_success_check CHECK (
    (state = 'succeeded' AND produced_version_id IS NOT NULL
      AND dashboard_id IS NOT NULL
      AND failure_reason IS NULL)
    OR (state = 'failed' AND produced_version_id IS NULL
      AND failure_reason IS NOT NULL)
    OR (state = 'running' AND produced_version_id IS NULL
      AND failure_reason IS NULL)
  ),
  CONSTRAINT agent_runs_finished_check CHECK (
    finished_at IS NULL OR finished_at >= started_at
  )
);

CREATE INDEX agent_runs_dashboard_idx
  ON dasher.agent_runs USING btree (
    organization_id,
    dashboard_id,
    started_at DESC
  );

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Every tenant-scoped table enables RLS. None forces it, and that is a
-- decision rather than an omission.
--
-- FORCE subjects the *table owner* to the policies. Every dasher_api function
-- is SECURITY DEFINER and so runs as that owner, which means FORCE subjects
-- the seam to the policies the seam exists to establish. `begin_request`
-- cannot update the session row it is authenticating, because the policy on
-- `sessions` demands a request context that does not exist until
-- `begin_request` has finished creating it. Reproduced against a NOSUPERUSER
-- NOBYPASSRLS owner: every call raises `dasher_denied` for a valid token,
-- which is indistinguishable from a wrong password. It is a total outage that
-- no test here can see, because this suite runs as superuser and superusers
-- bypass row security whatever FORCE says.
--
-- Nothing is lost by dropping it. FORCE constrains only the migration owner
-- and the definer bodies; it never touched dasher_app, which is not the owner
-- and is confined by these policies in full. Every seam function already
-- filters on `actor.organization_id` from the verified context, and every
-- guard trigger on `NEW.organization_id`, so none of them was relying on RLS
-- to scope a query. The migrator refuses to apply a series that reintroduces
-- FORCE; see `forced_row_security` in migrator.ts.
--
-- A wrong context is prevented separately, and not by RLS: the GUCs are only
-- honoured alongside a keyed digest that `begin_request` stamps after
-- validating a token, and `verified_context` revalidates the membership behind
-- it on every call.
-- ---------------------------------------------------------------------------

-- True when the request context names this organization and the acting user
-- holds an active membership at or above the required role.
--
-- SECURITY DEFINER, so this runs as the table owner. Every policy calls this
-- function and this function reads memberships, so if that read were itself
-- subject to the memberships policy the evaluation would recurse until
-- PostgreSQL raises `stack depth limit exceeded`. Running as the owner against
-- a table that does not force row security breaks the cycle -- which is now
-- true of every table here, not just memberships. The property suite found
-- this the hard way, with `stack depth limit exceeded` on the first attempt to
-- read a dashboard as a tenant.
--
-- The function is safe to define this way: it takes an organization and a role
-- name, returns only a boolean, and reads nothing outside the membership row
-- for the user already named in the request context.
CREATE FUNCTION dasher_private.context_allows(
  p_organization_id uuid,
  p_required_role text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    p_organization_id IS NOT NULL
    AND p_organization_id = verified.organization_id
    AND EXISTS (
      SELECT 1
      FROM dasher.memberships AS m
      WHERE m.organization_id = p_organization_id
        AND m.user_id = verified.user_id
        AND m.state = 'active'
        AND m.authority_revision = verified.authority_revision
        AND CASE m.role
              WHEN 'viewer' THEN 1
              WHEN 'editor' THEN 2
              WHEN 'admin' THEN 3
            END
            >=
            CASE p_required_role
              WHEN 'viewer' THEN 1
              WHEN 'editor' THEN 2
              WHEN 'admin' THEN 3
            END
    )
  FROM dasher_private.verified_context() AS verified;
$function$;

ALTER TABLE dasher.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_read ON dasher.organizations
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY memberships_read ON dasher.memberships
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY invitations_read ON dasher.invitations
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'admin'));

CREATE POLICY sessions_read ON dasher.sessions
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (
    dasher_private.context_allows(organization_id, 'viewer')
    AND dasher_private.context_user_id() = user_id
  );

CREATE POLICY audit_events_read ON dasher.audit_events
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'admin'));

CREATE POLICY source_snapshots_read ON dasher.source_snapshots
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY evidence_records_read ON dasher.evidence_records
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY dashboards_read ON dasher.dashboards
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY dashboards_write ON dasher.dashboards
  AS PERMISSIVE FOR ALL TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'editor'))
  WITH CHECK (dasher_private.context_allows(organization_id, 'editor'));

CREATE POLICY dashboard_versions_read ON dasher.dashboard_versions
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY dashboard_versions_insert ON dasher.dashboard_versions
  AS PERMISSIVE FOR INSERT TO dasher_app
  WITH CHECK (dasher_private.context_allows(organization_id, 'editor'));

CREATE POLICY claims_read ON dasher.claims
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY claims_insert ON dasher.claims
  AS PERMISSIVE FOR INSERT TO dasher_app
  WITH CHECK (dasher_private.context_allows(organization_id, 'editor'));

CREATE POLICY claim_evidence_read ON dasher.claim_evidence
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY claim_evidence_insert ON dasher.claim_evidence
  AS PERMISSIVE FOR INSERT TO dasher_app
  WITH CHECK (dasher_private.context_allows(organization_id, 'editor'));

CREATE POLICY agent_runs_read ON dasher.agent_runs
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY agent_runs_write ON dasher.agent_runs
  AS PERMISSIVE FOR ALL TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'editor'))
  WITH CHECK (dasher_private.context_allows(organization_id, 'editor'));

-- ---------------------------------------------------------------------------
-- Grants
--
-- dasher_app reads and writes tenant data through RLS. It cannot read
-- dasher_private, cannot create objects, and holds no rights on tables added
-- later unless a migration grants them explicitly.
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA dasher FROM PUBLIC, dasher_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dasher FROM PUBLIC, dasher_app;

GRANT SELECT ON
  dasher.organizations,
  dasher.memberships,
  dasher.audit_events,
  dasher.source_snapshots,
  dasher.evidence_records
TO dasher_app;

-- Sessions and invitations are granted by column, omitting the verifiers. A
-- readable verifier is a credential: `begin_request` and `accept_invitation`
-- match against sha256 of the presented token, so anything that could read
-- `token_digest` could authenticate without ever holding the token.
GRANT SELECT (
  session_id, organization_id, user_id, authority_revision,
  token_key_version, csrf_key_version, issued_at, last_seen_at,
  idle_expires_at, absolute_expires_at, rotated_from_session_id,
  replaced_by_session_id, revoked_at, revocation_reason
) ON dasher.sessions TO dasher_app;

GRANT SELECT (
  invitation_id, organization_id, normalized_email, granted_role,
  role_ceiling, token_key_version, created_by_user_id, created_at,
  expires_at, accepted_at, accepted_user_id, revoked_at, revoked_by_user_id
) ON dasher.invitations TO dasher_app;

-- Read-only, all of it. Every state change goes through `dasher_api`, which is
-- what makes actor attribution, legal transitions, and audit atomicity
-- properties of the schema rather than conventions the caller may follow.
GRANT SELECT ON
  dasher.dashboards,
  dasher.dashboard_versions,
  dasher.claims,
  dasher.claim_evidence,
  dasher.agent_runs
TO dasher_app;

-- `dasher_private.context_digest` is deliberately absent from this list and
-- must stay absent. It is the key-holding primitive: any role able to execute
-- it can mint a valid digest for any principal, which would defeat the whole
-- construction. `verified_context` is safe to grant because it only ever
-- returns a principal whose digest already checks out.
GRANT EXECUTE ON FUNCTION dasher_private.verified_context() TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_user_id() TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_organization_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_allows(uuid, text)
  TO dasher_app;
GRANT USAGE ON SCHEMA dasher_private TO dasher_app;

-- ---------------------------------------------------------------------------
-- Enforcement triggers
--
-- These hold whoever the writer is, including the owner and the seam functions
-- themselves. A CHECK constraint cannot see the previous row or another table,
-- so transitions, terminal immutability, and sealing live here.
-- ---------------------------------------------------------------------------

-- A run's request is what was asked. It cannot be edited afterwards, and once
-- the run reaches a terminal state nothing about it may change at all.
CREATE FUNCTION dasher_private.guard_agent_run_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.state <> 'running' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'terminal agent run rejects further change';
  END IF;

  IF NEW.run_id <> OLD.run_id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.requested_by_user_id <> OLD.requested_by_user_id
    OR NEW.request_text <> OLD.request_text
    OR NEW.started_at <> OLD.started_at
    OR NEW.dashboard_id IS DISTINCT FROM OLD.dashboard_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'agent run request fields are immutable';
  END IF;

  IF NEW.state NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'agent run may only settle to succeeded or failed';
  END IF;

  RETURN NEW;
END
$function$;

-- Every authority check downstream trusts `authority_revision` to move when
-- the membership's authority moves. Nothing enforced that, so a role could be
-- granted while every session issued under the old authority stayed valid.
CREATE FUNCTION dasher_private.guard_membership_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.membership_id <> OLD.membership_id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'membership identity is immutable';
  END IF;

  IF NEW.role <> OLD.role OR NEW.state <> OLD.state THEN
    IF NEW.authority_revision <> OLD.authority_revision + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'an authority change must advance authority_revision by one';
    END IF;
  ELSIF NEW.authority_revision <> OLD.authority_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'authority_revision advances only with an authority change';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER memberships_guard
BEFORE UPDATE ON dasher.memberships
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_membership_update();

CREATE TRIGGER agent_runs_guard
BEFORE UPDATE ON dasher.agent_runs
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_agent_run_update();

-- draft -> active -> archived, archive reversible, and nothing goes back to
-- draft. Revision advances by exactly one so a promotion cannot be replayed or
-- reordered, and provenance columns are fixed at creation.
CREATE FUNCTION dasher_private.guard_dashboard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  head_state text;
BEGIN
  IF NEW.dashboard_id <> OLD.dashboard_id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'dashboard provenance is immutable';
  END IF;

  IF NEW.lifecycle_state <> OLD.lifecycle_state THEN
    IF NOT (
      (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'active')
      OR (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'archived')
      OR (OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state = 'active')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'illegal dashboard lifecycle transition';
    END IF;
  END IF;

  IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'dashboard lifecycle revision must advance by one';
  END IF;

  -- A head must be a version of this dashboard that validated. The composite
  -- foreign key already proves the first half; only the second needs a lookup.
  IF NEW.head_version_id IS NOT NULL
    AND NEW.head_version_id IS DISTINCT FROM OLD.head_version_id
  THEN
    SELECT version_row.validation_state INTO head_state
    FROM dasher.dashboard_versions AS version_row
    WHERE version_row.organization_id = NEW.organization_id
      AND version_row.dashboard_id = NEW.dashboard_id
      AND version_row.version_id = NEW.head_version_id;

    IF head_state IS DISTINCT FROM 'valid' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'only a valid version may become the head';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER dashboards_guard
BEFORE UPDATE ON dasher.dashboards
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_dashboard_update();

-- Once a version is published its assertions are fixed. Adding a claim later
-- would change what a published dashboard means without changing its bytes,
-- its digest, or its identifier.
CREATE FUNCTION dasher_private.guard_claim_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM dasher.dashboards AS dashboard_row
    WHERE dashboard_row.organization_id = NEW.organization_id
      AND dashboard_row.dashboard_id = NEW.dashboard_id
      AND dashboard_row.head_version_id = NEW.version_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'published version rejects further claims';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER claims_seal
BEFORE INSERT ON dasher.claims
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_claim_insert();

CREATE TRIGGER claim_evidence_seal
BEFORE INSERT ON dasher.claim_evidence
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_claim_insert();

-- Retrieved bytes and what was read out of them are the root of every claim.
-- Immutability here is intrinsic, not a consequence of withholding a grant.
CREATE TRIGGER source_snapshots_immutable
BEFORE UPDATE OR DELETE ON dasher.source_snapshots
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

CREATE TRIGGER evidence_records_immutable
BEFORE UPDATE OR DELETE ON dasher.evidence_records
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

-- A claim asserted as fully supported must cite something. Deferred, because
-- the claim necessarily exists before the edge that supports it.
CREATE FUNCTION dasher_private.guard_claim_support()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.evidence_state = 'complete' AND NOT EXISTS (
    SELECT 1 FROM dasher.claim_evidence AS edge
    WHERE edge.organization_id = NEW.organization_id
      AND edge.dashboard_id = NEW.dashboard_id
      AND edge.version_id = NEW.version_id
      AND edge.claim_id = NEW.claim_id
      AND edge.relation = 'supports'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a complete claim must cite supporting evidence';
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER claims_require_support
AFTER INSERT ON dasher.claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_claim_support();

-- One version is produced by at most one run.
CREATE UNIQUE INDEX agent_runs_produced_version_key
  ON dasher.agent_runs USING btree (organization_id, produced_version_id)
  WHERE produced_version_id IS NOT NULL;

-- Foreign keys the planner would otherwise scan for on every parent update.
CREATE INDEX dashboards_creator_idx
  ON dasher.dashboards USING btree (organization_id, created_by_user_id);
CREATE INDEX dashboard_versions_creator_idx
  ON dasher.dashboard_versions USING btree (
    organization_id,
    created_by_user_id
  );
CREATE INDEX agent_runs_requester_idx
  ON dasher.agent_runs USING btree (organization_id, requested_by_user_id);

-- ---------------------------------------------------------------------------
-- dasher_api — the write and authentication seam
--
-- `dasher_app` holds no direct INSERT or UPDATE on any table. Everything that
-- mutates state, and everything that must run before a request context exists,
-- goes through one of these functions. They are SECURITY DEFINER, so they run
-- as the schema owner and see past row-level security; each therefore derives
-- the acting principal itself rather than accepting it as an argument.
--
-- Two of them exist because a grant cannot fix a cycle. Resolving a session
-- token needs the context that resolution establishes, and accepting an
-- invitation needs the membership that acceptance creates. Both are broken by
-- running as the owner and validating a bearer secret instead.
-- ---------------------------------------------------------------------------

CREATE SCHEMA dasher_api AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA dasher_api FROM PUBLIC;
GRANT USAGE ON SCHEMA dasher_api TO dasher_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_api REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- Pre-authentication: maps an identity-provider subject to a local user. Takes
-- no context because none exists yet, and returns nothing but the user id.
CREATE FUNCTION dasher_api.resolve_external_identity(
  p_issuer text,
  p_subject text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT identity_row.user_id
  FROM dasher.external_identities AS identity_row
  WHERE identity_row.issuer = p_issuer
    AND identity_row.subject = p_subject;
$function$;

-- Establishes the request context from a session token. This is the only way a
-- context comes into existence: it validates the session, then stamps the
-- keyed digest the accessors verify.
--
-- Must be called inside an explicit transaction. The settings are written with
-- `is_local => true` so they are discarded at COMMIT or ROLLBACK, which is what
-- keeps a pooled connection from carrying one request's principal into the
-- next.
CREATE FUNCTION dasher_api.begin_request(
  p_token_key_version smallint,
  p_token bytea
)
RETURNS TABLE (user_id uuid, organization_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  session_row dasher.sessions%ROWTYPE;
  membership_row dasher.memberships%ROWTYPE;
  now_at timestamptz := pg_catalog.clock_timestamp();
  presented_digest bytea;
BEGIN
  -- The caller presents the opaque token; the verifier is derived here. If the
  -- stored digest were the input, then anything able to read that column could
  -- authenticate as the session it belongs to, which makes a verifier into a
  -- credential. Reproduced before this was changed: a caller holding one
  -- session read a second session's stored digest and authenticated as it,
  -- after its own session had been revoked.
  IF p_token IS NULL OR pg_catalog.octet_length(p_token) < 16 THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;
  presented_digest := pg_catalog.sha256(p_token);

  -- Validate and refresh in one statement. Reading first and updating on the
  -- session id alone left a race: blocked behind a concurrent revocation, the
  -- update re-evaluated its predicate against the new row version, still
  -- matched on id, and stamped a context for a session already revoked. Every
  -- validity condition now lives in the predicate that takes the row lock, so
  -- resuming after such a commit finds nothing to update.
  UPDATE dasher.sessions AS live
  SET last_seen_at = now_at,
      idle_expires_at = LEAST(
        now_at + pg_catalog.make_interval(mins => 30),
        live.absolute_expires_at
      )
  WHERE live.token_key_version = p_token_key_version
    AND live.token_digest = presented_digest
    AND live.revoked_at IS NULL
    AND now_at < live.idle_expires_at
    AND now_at < live.absolute_expires_at
  RETURNING * INTO session_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;

  -- Deliberately not locked. Holding a share lock here for the life of the
  -- request would make every role change and revocation queue behind in-flight
  -- requests, which is worse than the window it closes: if the membership moves
  -- after this read, `context_allows` denies on the authority mismatch at the
  -- next statement anyway.
  --
  -- The membership must still be active *and* unchanged since the session was
  -- issued. A role change or revocation bumps authority_revision, which
  -- invalidates every session issued under the old authority.
  SELECT * INTO membership_row
  FROM dasher.memberships AS candidate
  WHERE candidate.organization_id = session_row.organization_id
    AND candidate.user_id = session_row.user_id;

  IF NOT FOUND
    OR membership_row.state <> 'active'
    OR membership_row.authority_revision <> session_row.authority_revision
  THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;

  -- The UPDATE above has assigned this transaction an identifier, which the
  -- digest below binds to. All five settings are transaction-local.
  PERFORM pg_catalog.set_config(
    'dasher.context_user_id', session_row.user_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_organization_id',
    session_row.organization_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_session_id', session_row.session_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_authority',
    membership_row.authority_revision::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_digest',
    pg_catalog.encode(
      dasher_private.context_digest(
        session_row.user_id,
        session_row.organization_id,
        session_row.session_id,
        membership_row.authority_revision,
        pg_catalog.pg_current_xact_id()::text
      ),
      'hex'
    ),
    true
  );

  user_id := session_row.user_id;
  organization_id := session_row.organization_id;
  RETURN NEXT;
END
$function$;

-- The second cycle. The invitee holds no membership yet, so no context can
-- exist for them; the invitation token is the only thing they can present.
-- Creating the membership and recording the audit event happen in one
-- statement, so neither can occur without the other.
CREATE FUNCTION dasher_api.accept_invitation(
  p_token_key_version smallint,
  p_token bytea,
  p_issuer text,
  p_subject text,
  p_verified_email text,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  invitation_row dasher.invitations%ROWTYPE;
  existing_membership dasher.memberships%ROWTYPE;
  accepting_user uuid;
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  now_at timestamptz := pg_catalog.clock_timestamp();
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(p_verified_email));
BEGIN
  SELECT * INTO invitation_row
  FROM dasher.invitations AS candidate
  WHERE candidate.token_key_version = p_token_key_version
    AND candidate.token_digest = pg_catalog.sha256(p_token)
  FOR UPDATE;

  IF NOT FOUND
    OR invitation_row.accepted_at IS NOT NULL
    OR invitation_row.revoked_at IS NOT NULL
    OR now_at >= invitation_row.expires_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;

  -- The invitation names who may join. Taking the accepting user as an
  -- argument instead made this an "add anyone who exists" token: a holder
  -- could grant membership to any user in the table, and the audit event named
  -- that user as the actor. Acceptance is now bound to the address the
  -- invitation was issued to.
  --
  -- What this cannot do is verify the identity assertion itself. The database
  -- has no way to check an identity-provider token, so the caller is trusted to
  -- present an issuer, subject, and email it has already verified. That trust
  -- is narrow and stated rather than hidden: the caller may still only complete
  -- an invitation addressed to the identity it presents.
  IF normalized_email IS NULL
    OR normalized_email <> invitation_row.normalized_email
  THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;

  SELECT identity_row.user_id INTO accepting_user
  FROM dasher.external_identities AS identity_row
  WHERE identity_row.issuer = p_issuer
    AND identity_row.subject = p_subject;

  IF accepting_user IS NULL THEN
    accepting_user := pg_catalog.gen_random_uuid();
    INSERT INTO dasher.users (user_id) VALUES (accepting_user);
    INSERT INTO dasher.external_identities (issuer, subject, user_id)
    VALUES (p_issuer, p_subject, accepting_user);
  END IF;

  SELECT * INTO existing_membership
  FROM dasher.memberships AS candidate
  WHERE candidate.organization_id = invitation_row.organization_id
    AND candidate.user_id = accepting_user;

  IF FOUND THEN
    new_membership_id := existing_membership.membership_id;
    -- Restored at exactly the role the invitation grants. Leaving `role`
    -- untouched let a viewer invitation reactivate a revoked administrator as
    -- an administrator, which made granted_role and role_ceiling meaningless
    -- for anyone who had ever held a higher role.
    UPDATE dasher.memberships AS held
    SET state = 'active',
        role = invitation_row.granted_role,
        revoked_at = NULL,
        authority_revision = held.authority_revision + 1,
        updated_at = now_at
    WHERE held.membership_id = existing_membership.membership_id;
  ELSE
    INSERT INTO dasher.memberships (
      membership_id, organization_id, user_id, role, state, authority_revision
    )
    VALUES (
      new_membership_id,
      invitation_row.organization_id,
      accepting_user,
      invitation_row.granted_role,
      'active',
      1
    );
  END IF;

  UPDATE dasher.invitations AS held
  SET accepted_at = now_at, accepted_user_id = accepting_user
  WHERE held.invitation_id = invitation_row.invitation_id;

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(),
    invitation_row.organization_id,
    'user',
    accepting_user,
    1,
    p_request_id,
    CASE WHEN existing_membership.membership_id IS NULL
      THEN 'invitation.accepted'
      ELSE 'invitation.accepted_existing_membership'
    END,
    'invitation',
    invitation_row.invitation_id,
    'succeeded',
    p_deployment_revision
  );

  RETURN new_membership_id;
END
$function$;


CREATE FUNCTION dasher_api.acting_principal(p_required_role text)
RETURNS TABLE (user_id uuid, organization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  SELECT verified.user_id, verified.organization_id
  INTO user_id, organization_id
  FROM dasher_private.verified_context() AS verified;

  IF user_id IS NULL
    OR NOT dasher_private.context_allows(organization_id, p_required_role)
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'dasher_denied';
  END IF;
  RETURN NEXT;
END
$function$;

CREATE FUNCTION dasher_api.create_dashboard(
  p_title text,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  new_dashboard uuid := pg_catalog.gen_random_uuid();
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  INSERT INTO dasher.dashboards (
    organization_id, dashboard_id, title, lifecycle_state,
    lifecycle_revision, created_by_user_id
  )
  VALUES (
    actor.organization_id, new_dashboard, p_title, 'draft', 1, actor.user_id
  );

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), actor.organization_id, 'user', actor.user_id,
    1, p_request_id, 'dashboard.created', 'dashboard', new_dashboard,
    'succeeded', p_deployment_revision
  );

  RETURN new_dashboard;
END
$function$;

CREATE FUNCTION dasher_api.set_dashboard_archived(
  p_dashboard_id uuid,
  p_expected_revision bigint,
  p_archived boolean,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  next_revision bigint;
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  -- Compare-and-swap on the revision the caller believed it was acting on, so
  -- two concurrent transitions cannot both apply.
  UPDATE dasher.dashboards AS held
  SET lifecycle_state = CASE WHEN p_archived THEN 'archived' ELSE 'active' END,
      archived_at = CASE
        WHEN p_archived THEN pg_catalog.clock_timestamp() ELSE NULL
      END,
      lifecycle_revision = held.lifecycle_revision + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE held.organization_id = actor.organization_id
    AND held.dashboard_id = p_dashboard_id
    AND held.lifecycle_revision = p_expected_revision
  RETURNING held.lifecycle_revision INTO next_revision;

  IF next_revision IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'dasher_conflict';
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), actor.organization_id, 'user', actor.user_id,
    1, p_request_id,
    CASE WHEN p_archived THEN 'dashboard.archived' ELSE 'dashboard.unarchived' END,
    'dashboard', p_dashboard_id, 'succeeded', p_deployment_revision
  );

  RETURN next_revision;
END
$function$;

CREATE FUNCTION dasher_api.record_source_snapshot(
  p_source_kind text,
  p_source_ref text,
  p_canonical_bytes bytea,
  p_observed_at timestamptz,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  new_snapshot uuid := pg_catalog.gen_random_uuid();
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  -- The digest is derived here rather than accepted, so it cannot disagree
  -- with the bytes it summarises.
  INSERT INTO dasher.source_snapshots (
    organization_id, snapshot_id, source_kind, source_ref, canonical_bytes,
    content_sha256, observed_at, retrieved_at
  )
  VALUES (
    actor.organization_id, new_snapshot, p_source_kind, p_source_ref,
    p_canonical_bytes, pg_catalog.sha256(p_canonical_bytes), p_observed_at,
    pg_catalog.clock_timestamp()
  );

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, content_sha256, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), actor.organization_id, 'user', actor.user_id,
    1, p_request_id, 'source_snapshot.created', 'source_snapshot', new_snapshot,
    'succeeded', pg_catalog.sha256(p_canonical_bytes), p_deployment_revision
  );

  RETURN new_snapshot;
END
$function$;

CREATE FUNCTION dasher_api.record_evidence(
  p_snapshot_id uuid,
  p_evidence_kind text,
  p_coordinates text,
  p_transformation text,
  p_content_sha256 bytea,
  p_observed_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  new_evidence uuid := pg_catalog.gen_random_uuid();
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  INSERT INTO dasher.evidence_records (
    organization_id, evidence_id, snapshot_id, evidence_kind, coordinates,
    transformation, content_sha256, observed_at
  )
  VALUES (
    actor.organization_id, new_evidence, p_snapshot_id, p_evidence_kind,
    p_coordinates, p_transformation, p_content_sha256, p_observed_at
  );

  RETURN new_evidence;
END
$function$;

CREATE FUNCTION dasher_api.start_run(
  p_dashboard_id uuid,
  p_request_text text,
  p_provider text,
  p_model text,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  new_run uuid := pg_catalog.gen_random_uuid();
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  INSERT INTO dasher.agent_runs (
    organization_id, run_id, dashboard_id, requested_by_user_id,
    request_text, state, provider, model
  )
  VALUES (
    actor.organization_id, new_run, p_dashboard_id, actor.user_id,
    p_request_text, 'running', p_provider, p_model
  );

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), actor.organization_id, 'user', actor.user_id,
    1, p_request_id, 'agent_run.started', 'agent_run', new_run, 'succeeded',
    p_deployment_revision
  );

  RETURN new_run;
END
$function$;

CREATE FUNCTION dasher_api.fail_run(
  p_run_id uuid,
  p_failure_reason text,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  UPDATE dasher.agent_runs AS held
  SET state = 'failed',
      failure_reason = p_failure_reason,
      finished_at = pg_catalog.clock_timestamp()
  WHERE held.organization_id = actor.organization_id
    AND held.run_id = p_run_id
    AND held.state = 'running';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'dasher_conflict';
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), actor.organization_id, 'user', actor.user_id,
    1, p_request_id, 'agent_run.finished', 'agent_run', p_run_id, 'succeeded',
    p_deployment_revision
  );
END
$function$;

-- The whole publication act, in one statement.
--
-- Version bytes, the complete claim set, its citation edges, the run's terminal
-- state, the head promotion, and the audit events either all commit or none do.
-- That is what makes audit atomicity a property of the schema rather than a
-- convention the caller is trusted to follow, and it is why claims cannot be
-- appended later: they are written before the promotion that seals them.
CREATE FUNCTION dasher_api.finalize_run(
  p_run_id uuid,
  p_canonical_spec_bytes bytea,
  p_claims jsonb,
  p_expected_revision bigint,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  run_row dasher.agent_runs%ROWTYPE;
  new_version uuid := pg_catalog.gen_random_uuid();
  claim_entry jsonb;
  edge_entry jsonb;
  new_claim uuid;
  promoted bigint;
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  SELECT * INTO run_row
  FROM dasher.agent_runs AS candidate
  WHERE candidate.organization_id = actor.organization_id
    AND candidate.run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND
    OR run_row.state <> 'running'
    OR run_row.dashboard_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'dasher_conflict';
  END IF;

  INSERT INTO dasher.dashboard_versions (
    organization_id, dashboard_id, version_id, canonical_spec_bytes,
    canonical_spec_sha256, validation_state, run_id, created_by_user_id
  )
  VALUES (
    actor.organization_id, run_row.dashboard_id, new_version,
    p_canonical_spec_bytes, pg_catalog.sha256(p_canonical_spec_bytes),
    'valid', p_run_id, actor.user_id
  );

  FOR claim_entry IN
    SELECT * FROM pg_catalog.jsonb_array_elements(
      coalesce(p_claims, '[]'::jsonb)
    )
  LOOP
    new_claim := pg_catalog.gen_random_uuid();
    INSERT INTO dasher.claims (
      organization_id, dashboard_id, version_id, claim_id, json_pointer,
      label, salience, evidence_state, assertion_sha256
    )
    VALUES (
      actor.organization_id, run_row.dashboard_id, new_version, new_claim,
      claim_entry ->> 'pointer',
      claim_entry ->> 'label',
      coalesce(claim_entry ->> 'salience', 'normal'),
      claim_entry ->> 'evidence_state',
      pg_catalog.decode(claim_entry ->> 'assertion_sha256', 'hex')
    );

    FOR edge_entry IN
      SELECT * FROM pg_catalog.jsonb_array_elements(
        coalesce(claim_entry -> 'evidence', '[]'::jsonb)
      )
    LOOP
      INSERT INTO dasher.claim_evidence (
        organization_id, dashboard_id, version_id, claim_id, evidence_id,
        relation
      )
      VALUES (
        actor.organization_id, run_row.dashboard_id, new_version, new_claim,
        (edge_entry ->> 'evidence_id')::uuid,
        coalesce(edge_entry ->> 'relation', 'supports')
      );
    END LOOP;
  END LOOP;

  UPDATE dasher.agent_runs AS held
  SET state = 'succeeded',
      produced_version_id = new_version,
      finished_at = pg_catalog.clock_timestamp()
  WHERE held.organization_id = actor.organization_id
    AND held.run_id = p_run_id;

  UPDATE dasher.dashboards AS held
  SET head_version_id = new_version,
      lifecycle_state = 'active',
      lifecycle_revision = held.lifecycle_revision + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE held.organization_id = actor.organization_id
    AND held.dashboard_id = run_row.dashboard_id
    AND held.lifecycle_revision = p_expected_revision
  RETURNING held.lifecycle_revision INTO promoted;

  IF promoted IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'dasher_conflict';
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, content_sha256, deployment_revision
  )
  VALUES
    (
      pg_catalog.gen_random_uuid(), actor.organization_id, 'user',
      actor.user_id, 1, p_request_id, 'dashboard_version.created',
      'dashboard_version', new_version, 'succeeded',
      pg_catalog.sha256(p_canonical_spec_bytes), p_deployment_revision
    ),
    (
      pg_catalog.gen_random_uuid(), actor.organization_id, 'user',
      actor.user_id, 1, p_request_id, 'dashboard_head.promoted',
      'dashboard', run_row.dashboard_id, 'succeeded', NULL,
      p_deployment_revision
    ),
    (
      pg_catalog.gen_random_uuid(), actor.organization_id, 'user',
      actor.user_id, 1, p_request_id, 'agent_run.finished', 'agent_run',
      p_run_id, 'succeeded', NULL, p_deployment_revision
    );

  RETURN new_version;
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA dasher_api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  dasher_api.create_dashboard(text, uuid, text) TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.set_dashboard_archived(uuid, bigint, boolean, uuid, text)
  TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.record_source_snapshot(text, text, bytea, timestamptz, uuid, text)
  TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.record_evidence(uuid, text, text, text, bytea, timestamptz)
  TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.start_run(uuid, text, text, text, uuid, text) TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.fail_run(uuid, text, uuid, text) TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.finalize_run(uuid, bytea, jsonb, bigint, uuid, text) TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.resolve_external_identity(text, text) TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.begin_request(smallint, bytea) TO dasher_app;
GRANT EXECUTE ON FUNCTION
  dasher_api.accept_invitation(smallint, bytea, text, text, text, uuid, text)
  TO dasher_app;
