DO $migration$
DECLARE
  database_name name := pg_catalog.current_database();
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC',
    database_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON DATABASE %I FROM dasher_app, dasher_security_definer',
    database_name
  );
END
$migration$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA dasher AUTHORIZATION CURRENT_USER;
CREATE SCHEMA dasher_private AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA dasher
  FROM PUBLIC, dasher_app, dasher_security_definer;
REVOKE ALL ON SCHEMA dasher_private
  FROM PUBLIC, dasher_app, dasher_security_definer;

ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_private
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_private
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_private
  REVOKE ALL ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_private
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- PostgreSQL's built-in defaults grant PUBLIC function EXECUTE and type USAGE
-- globally. Per-schema REVOKE cannot subtract those global defaults, so the
-- dedicated migration owner must also close them globally. Production uses a
-- dedicated owner; the disposable integration harness restores its baseline.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM PUBLIC;

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
  CONSTRAINT memberships_state_check CHECK (
    state IN ('active', 'revoked')
  ),
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
  CONSTRAINT invitations_token_key UNIQUE (
    token_key_version,
    token_digest
  ),
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
  ON dasher.invitations USING btree (
    organization_id,
    created_by_user_id
  );
CREATE INDEX invitations_accepted_user_idx
  ON dasher.invitations USING btree (accepted_user_id);
CREATE INDEX invitations_revoker_idx
  ON dasher.invitations USING btree (
    organization_id,
    revoked_by_user_id
  );
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
  CONSTRAINT sessions_authority_revision_check CHECK (
    authority_revision >= 1
  ),
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
    AND last_seen_at < absolute_expires_at
  ),
  CONSTRAINT sessions_idle_expiry_check CHECK (
    issued_at < idle_expires_at
    AND idle_expires_at <= absolute_expires_at
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
  ON dasher.sessions USING btree (
    organization_id,
    rotated_from_session_id
  );
CREATE INDEX sessions_replaced_by_idx
  ON dasher.sessions USING btree (
    organization_id,
    replaced_by_session_id
  );
CREATE INDEX sessions_live_user_idx
  ON dasher.sessions USING btree (
    organization_id,
    user_id,
    revoked_at
  );

CREATE TABLE dasher.audit_events (
  audit_event_id uuid CONSTRAINT audit_events_pkey PRIMARY KEY,
  organization_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  actor_kind varchar(16) NOT NULL,
  actor_user_id uuid,
  actor_service varchar(64),
  authority_revision bigint NOT NULL,
  request_id uuid NOT NULL,
  job_id uuid,
  action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id uuid NOT NULL,
  outcome varchar(16) NOT NULL,
  content_sha256 bytea,
  source_ref varchar(200),
  provider varchar(64),
  credential_version varchar(64),
  usage_units numeric(20,6),
  cost_minor_units bigint,
  deployment_revision varchar(64) NOT NULL,
  CONSTRAINT audit_events_org_id_key UNIQUE (
    organization_id,
    audit_event_id
  ),
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
    (
      actor_kind = 'user'
      AND actor_user_id IS NOT NULL
      AND actor_service IS NULL
    )
    OR (
      actor_kind = 'service'
      AND actor_user_id IS NULL
      AND actor_service IS NOT NULL
    )
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
      'dashboard_version.created',
      'dashboard_head.promoted'
    )
  ),
  CONSTRAINT audit_events_target_type_check CHECK (
    target_type = pg_catalog.btrim(target_type)
    AND pg_catalog.char_length(target_type) BETWEEN 1 AND 32
    AND target_type !~ '[[:cntrl:]]'
  ),
  CONSTRAINT audit_events_outcome_check CHECK (outcome = 'succeeded'),
  CONSTRAINT audit_events_content_sha256_check CHECK (
    content_sha256 IS NULL
    OR pg_catalog.octet_length(content_sha256) = 32
  ),
  CONSTRAINT audit_events_source_ref_check CHECK (
    source_ref IS NULL
    OR (
      source_ref = pg_catalog.btrim(source_ref)
      AND pg_catalog.char_length(source_ref) BETWEEN 1 AND 200
      AND source_ref !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT audit_events_provider_check CHECK (
    provider IS NULL
    OR (
      provider = pg_catalog.btrim(provider)
      AND pg_catalog.char_length(provider) BETWEEN 1 AND 64
      AND provider !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT audit_events_credential_version_check CHECK (
    credential_version IS NULL
    OR (
      credential_version = pg_catalog.btrim(credential_version)
      AND pg_catalog.char_length(credential_version) BETWEEN 1 AND 64
      AND credential_version !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT audit_events_usage_units_check CHECK (
    usage_units IS NULL
    OR (
      usage_units <> 'NaN'::pg_catalog.numeric
      AND usage_units >= 0
    )
  ),
  CONSTRAINT audit_events_cost_minor_units_check CHECK (
    cost_minor_units IS NULL OR cost_minor_units >= 0
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

REVOKE ALL ON FUNCTION dasher_private.reject_immutable_mutation()
  FROM PUBLIC, dasher_app, dasher_security_definer;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON dasher.audit_events
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

ALTER TABLE dasher.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.users FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.external_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.audit_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA dasher
  FROM PUBLIC, dasher_app, dasher_security_definer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dasher
  FROM PUBLIC, dasher_app, dasher_security_definer;
