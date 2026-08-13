-- Dasher baseline schema.
--
-- This file replaces the twelve-migration series that preceded it. Those files
-- are retained, unreferenced, under `migrations-archive/` for provenance.
--
-- Migrations are MUTABLE until the first production deployment. Before that
-- point, a schema change is made by editing this file and recreating the
-- development database; there is no data to preserve and no deployment to
-- protect. From the first production deployment onward the series becomes
-- forward-only and append-only, and this file becomes immutable.
--
-- What is deliberately kept from the superseded series:
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
-- KNOWN GAP, tracked in test/accepted-invalid-states.integration.test.ts.
-- The superseded series granted `dasher_app` no direct table writes at all:
-- every mutation went through a `dasher_api` SECURITY DEFINER function that
-- checked actor identity, legal transitions, and audit atomicity. Replacing
-- that with direct INSERT/UPDATE grants dropped the enforcement along with the
-- ceremony, which was not intended. Fifteen states this schema wrongly accepts
-- are enumerated as failing tests. Closing them needs a trusted mutation seam,
-- not the sixteen-table ledger back.

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

CREATE FUNCTION dasher_private.context_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting('dasher.context_user_id', true)::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
$function$;

CREATE FUNCTION dasher_private.context_organization_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting(
    'dasher.context_organization_id',
    true
  )::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
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
    issued_at <= last_seen_at AND last_seen_at < absolute_expires_at
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
    pg_catalog.octet_length(content_sha256) = 32
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
  CONSTRAINT dashboard_versions_spec_sha256_check CHECK (
    pg_catalog.octet_length(canonical_spec_sha256) = 32
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
    produced_version_id
  ) REFERENCES dasher.dashboard_versions (organization_id, version_id),
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
-- Every tenant-scoped table enables RLS, and every one but `memberships`
-- forces it. The application connects as dasher_app, which is NOBYPASSRLS, so
-- a missing request context yields zero rows rather than another
-- organization's rows.
--
-- A *wrong* context is a different matter and is not currently prevented:
-- dasher_app sets these GUCs itself and nothing binds them to a verified
-- session, so anything able to issue SQL on this connection can name any
-- member of any organization. See the request-identity case in
-- test/accepted-invalid-states.integration.test.ts.
-- ---------------------------------------------------------------------------

-- True when the request context names this organization and the acting user
-- holds an active membership at or above the required role.
--
-- SECURITY DEFINER, and `dasher.memberships` is the one table below that
-- enables row-level security without FORCE. Both facts serve the same purpose:
-- every policy calls this function, and this function reads memberships, so if
-- that read were itself subject to the memberships policy the evaluation would
-- recurse until PostgreSQL raises `stack depth limit exceeded`. Running as the
-- table owner against a non-forced table breaks the cycle.
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
    AND p_organization_id = dasher_private.context_organization_id()
    AND EXISTS (
      SELECT 1
      FROM dasher.memberships AS m
      WHERE m.organization_id = p_organization_id
        AND m.user_id = dasher_private.context_user_id()
        AND m.state = 'active'
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
    );
$function$;

ALTER TABLE dasher.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.users FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.external_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.organizations FORCE ROW LEVEL SECURITY;
-- Not FORCEd: see dasher_private.context_allows above.
ALTER TABLE dasher.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.source_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_records FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboards FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.claims FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.claim_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.agent_runs FORCE ROW LEVEL SECURITY;

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
  dasher.invitations,
  dasher.sessions,
  dasher.audit_events,
  dasher.source_snapshots,
  dasher.evidence_records
TO dasher_app;

GRANT SELECT, INSERT ON
  dasher.dashboard_versions,
  dasher.claims,
  dasher.claim_evidence
TO dasher_app;

GRANT SELECT, INSERT, UPDATE ON
  dasher.dashboards,
  dasher.agent_runs
TO dasher_app;

GRANT EXECUTE ON FUNCTION dasher_private.context_user_id() TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_organization_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_allows(uuid, text)
  TO dasher_app;
GRANT USAGE ON SCHEMA dasher_private TO dasher_app;
