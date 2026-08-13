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
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO dasher_app',
    database_name
  );
END
$migration$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA dasher_api AUTHORIZATION CURRENT_USER;

REVOKE ALL ON SCHEMA dasher
  FROM PUBLIC, dasher_app, dasher_security_definer;
REVOKE ALL ON SCHEMA dasher_meta
  FROM PUBLIC, dasher_app, dasher_security_definer;
REVOKE ALL ON SCHEMA dasher_private
  FROM PUBLIC, dasher_app, dasher_security_definer;
REVOKE ALL ON SCHEMA dasher_api
  FROM PUBLIC, dasher_app, dasher_security_definer;

ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_meta
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_meta
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_meta
  REVOKE ALL ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_meta
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
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
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_api
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_api
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_api
  REVOKE ALL ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dasher_api
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM PUBLIC;

CREATE FUNCTION dasher_private.context_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting(
    'dasher.context_user_id',
    true
  )::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
$function$;

CREATE FUNCTION dasher_api.rotate_session(
  p_successor_session_id uuid,
  p_successor_session_key_version smallint,
  p_successor_session_digest bytea,
  p_successor_csrf_key_version smallint,
  p_successor_csrf_digest bytea,
  p_audit_event_id uuid,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_deployment_revision text
)
RETURNS TABLE (
  session_id uuid,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_context_session_id uuid;
  v_context_user_id uuid;
  v_context_organization_id uuid;
  v_context_membership_id uuid;
  v_context_authority_revision bigint;
  v_context_session_key_version smallint;
  v_context_session_digest bytea;
  v_request_id uuid;
  v_trusted_organization_id uuid;
  v_organization_advisory_key bigint;
  v_rotated_from_session_id uuid;
  v_replaced_by_session_id uuid;
  v_absolute_expires_at timestamptz;
  v_idle_expires_at timestamptz;
  v_now timestamptz;
  v_row_count integer;
  v_constraint_name text;
BEGIN
  IF p_successor_session_id IS NULL
    OR p_successor_session_key_version IS NULL
    OR p_successor_session_key_version NOT BETWEEN 1 AND 32767
    OR p_successor_session_digest IS NULL
    OR pg_catalog.octet_length(p_successor_session_digest) <> 32
    OR p_successor_csrf_key_version IS NULL
    OR p_successor_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_successor_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_successor_csrf_digest) <> 32
    OR p_audit_event_id IS NULL
    OR p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  BEGIN
    v_context_session_id := pg_catalog.current_setting(
      'dasher.context_session_id',
      true
    )::uuid;
    v_context_user_id := pg_catalog.current_setting(
      'dasher.context_user_id',
      true
    )::uuid;
    v_context_organization_id := pg_catalog.current_setting(
      'dasher.context_organization_id',
      true
    )::uuid;
    v_context_membership_id := pg_catalog.current_setting(
      'dasher.context_membership_id',
      true
    )::uuid;
    v_context_authority_revision := pg_catalog.current_setting(
      'dasher.context_authority_revision',
      true
    )::bigint;
    v_context_session_key_version := pg_catalog.current_setting(
      'dasher.context_session_key_version',
      true
    )::smallint;
    v_context_session_digest := pg_catalog.decode(
      pg_catalog.current_setting(
        'dasher.context_session_digest_hex',
        true
      ),
      'hex'
    );
    v_request_id := pg_catalog.current_setting(
      'dasher.context_request_id',
      true
    )::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1001',
        MESSAGE = 'dasher_denied';
  END;

  IF v_request_id IS NULL OR p_audit_event_id = v_request_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.organization_id,
    session_row.rotated_from_session_id,
    session_row.replaced_by_session_id
  INTO
    v_trusted_organization_id,
    v_rotated_from_session_id,
    v_replaced_by_session_id
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_context_organization_id
    AND session_row.user_id = v_context_user_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND membership.membership_id = v_context_membership_id
    AND membership.state = 'active'
    AND membership.authority_revision = v_context_authority_revision
    AND membership.role IN ('viewer', 'editor', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text
      || v_trusted_organization_id::text,
    20260730::bigint
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    v_organization_advisory_key
  );

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = v_context_membership_id
    AND membership.organization_id = v_trusted_organization_id
    AND membership.user_id = v_context_user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_trusted_organization_id
    AND (
      session_row.session_id = v_context_session_id
      OR session_row.session_id = v_rotated_from_session_id
      OR session_row.session_id = v_replaced_by_session_id
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  SELECT session_row.absolute_expires_at
  INTO v_absolute_expires_at
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_trusted_organization_id
    AND session_row.user_id = v_context_user_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.csrf_key_version = p_current_csrf_key_version
    AND session_row.csrf_digest = p_current_csrf_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_context_membership_id
    AND membership.state = 'active'
    AND membership.authority_revision = v_context_authority_revision
    AND membership.role IN ('viewer', 'editor', 'admin');

  IF NOT FOUND THEN
    PERFORM 1
    FROM dasher.sessions AS session_row
    JOIN dasher.memberships AS membership
      ON membership.organization_id = session_row.organization_id
     AND membership.user_id = session_row.user_id
    WHERE session_row.session_id = v_context_session_id
      AND session_row.organization_id = v_trusted_organization_id
      AND session_row.user_id = v_context_user_id
      AND session_row.token_key_version = v_context_session_key_version
      AND session_row.token_digest = v_context_session_digest
      AND session_row.csrf_key_version = p_current_csrf_key_version
      AND session_row.csrf_digest = p_current_csrf_digest
      AND session_row.authority_revision = v_context_authority_revision
      AND session_row.replaced_by_session_id IS NOT NULL
      AND session_row.revoked_at IS NULL
      AND v_now < session_row.idle_expires_at
      AND v_now < session_row.absolute_expires_at
      AND membership.membership_id = v_context_membership_id
      AND membership.state = 'active'
      AND membership.authority_revision = v_context_authority_revision
      AND membership.role IN ('viewer', 'editor', 'admin');

    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  PERFORM 1
  FROM dasher.sessions AS session_collision
  WHERE session_collision.session_id = p_successor_session_id;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1002',
      MESSAGE = 'dasher_conflict';
  END IF;

  v_idle_expires_at := LEAST(
    v_now + pg_catalog.make_interval(mins => 30),
    v_absolute_expires_at
  );

  BEGIN
    INSERT INTO dasher.sessions (
      session_id,
      organization_id,
      user_id,
      authority_revision,
      token_key_version,
      token_digest,
      csrf_key_version,
      csrf_digest,
      issued_at,
      last_seen_at,
      idle_expires_at,
      absolute_expires_at,
      rotated_from_session_id,
      replaced_by_session_id,
      revoked_at,
      revocation_reason
    )
    VALUES (
      p_successor_session_id,
      v_trusted_organization_id,
      v_context_user_id,
      v_context_authority_revision,
      p_successor_session_key_version,
      p_successor_session_digest,
      p_successor_csrf_key_version,
      p_successor_csrf_digest,
      v_now,
      v_now,
      v_idle_expires_at,
      v_absolute_expires_at,
      v_context_session_id,
      NULL,
      NULL,
      NULL
    );
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS
        v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IN (
        'sessions_pkey',
        'sessions_token_key',
        'sessions_csrf_key'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1002',
          MESSAGE = 'dasher_conflict';
      END IF;
      RAISE;
  END;

  UPDATE dasher.sessions AS session_row
  SET replaced_by_session_id = p_successor_session_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_trusted_organization_id
    AND session_row.user_id = v_context_user_id
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1002',
      MESSAGE = 'dasher_conflict';
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_trusted_organization_id,
    v_now,
    'user',
    v_context_user_id,
    NULL,
    v_context_authority_revision,
    v_request_id,
    NULL,
    'session.rotated',
    'session',
    p_successor_session_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY
  SELECT p_successor_session_id, v_idle_expires_at, v_absolute_expires_at;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation
    OR invalid_text_representation
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.revoke_session(
  p_target_session_id uuid,
  p_audit_event_id uuid,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_deployment_revision text
)
RETURNS TABLE (
  session_id uuid,
  revoked_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_context_session_id uuid;
  v_context_user_id uuid;
  v_context_organization_id uuid;
  v_context_membership_id uuid;
  v_context_authority_revision bigint;
  v_context_session_key_version smallint;
  v_context_session_digest bytea;
  v_request_id uuid;
  v_trusted_organization_id uuid;
  v_organization_advisory_key bigint;
  v_current_rotated_from uuid;
  v_current_replaced_by uuid;
  v_target_rotated_from uuid;
  v_target_replaced_by uuid;
  v_now timestamptz;
  v_row_count integer;
  v_constraint_name text;
BEGIN
  IF p_target_session_id IS NULL
    OR p_audit_event_id IS NULL
    OR p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  BEGIN
    v_context_session_id := pg_catalog.current_setting(
      'dasher.context_session_id',
      true
    )::uuid;
    v_context_user_id := pg_catalog.current_setting(
      'dasher.context_user_id',
      true
    )::uuid;
    v_context_organization_id := pg_catalog.current_setting(
      'dasher.context_organization_id',
      true
    )::uuid;
    v_context_membership_id := pg_catalog.current_setting(
      'dasher.context_membership_id',
      true
    )::uuid;
    v_context_authority_revision := pg_catalog.current_setting(
      'dasher.context_authority_revision',
      true
    )::bigint;
    v_context_session_key_version := pg_catalog.current_setting(
      'dasher.context_session_key_version',
      true
    )::smallint;
    v_context_session_digest := pg_catalog.decode(
      pg_catalog.current_setting(
        'dasher.context_session_digest_hex',
        true
      ),
      'hex'
    );
    v_request_id := pg_catalog.current_setting(
      'dasher.context_request_id',
      true
    )::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1001',
        MESSAGE = 'dasher_denied';
  END;

  IF v_request_id IS NULL
    OR p_audit_event_id = v_request_id
    OR v_context_session_digest IS NULL
    OR pg_catalog.octet_length(v_context_session_digest) <> 32
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.organization_id,
    session_row.rotated_from_session_id,
    session_row.replaced_by_session_id
  INTO
    v_trusted_organization_id,
    v_current_rotated_from,
    v_current_replaced_by
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_context_organization_id
    AND session_row.user_id = v_context_user_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND membership.membership_id = v_context_membership_id
    AND membership.state = 'active'
    AND membership.authority_revision = v_context_authority_revision
    AND membership.role IN ('viewer', 'editor', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text
      || v_trusted_organization_id::text,
    20260730::bigint
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    v_organization_advisory_key
  );

  SELECT
    session_row.rotated_from_session_id,
    session_row.replaced_by_session_id
  INTO
    v_target_rotated_from,
    v_target_replaced_by
  FROM dasher.sessions AS session_row
  WHERE session_row.session_id = p_target_session_id
    AND session_row.organization_id = v_trusted_organization_id
    AND session_row.user_id = v_context_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = v_context_membership_id
    AND membership.organization_id = v_trusted_organization_id
    AND membership.user_id = v_context_user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_trusted_organization_id
    AND (
      session_row.session_id = v_context_session_id
      OR session_row.session_id = p_target_session_id
      OR session_row.session_id = v_current_rotated_from
      OR session_row.session_id = v_current_replaced_by
      OR session_row.session_id = v_target_rotated_from
      OR session_row.session_id = v_target_replaced_by
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  PERFORM 1
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_trusted_organization_id
    AND session_row.user_id = v_context_user_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.csrf_key_version = p_current_csrf_key_version
    AND session_row.csrf_digest = p_current_csrf_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_context_membership_id
    AND membership.state = 'active'
    AND membership.authority_revision = v_context_authority_revision
    AND membership.role IN ('viewer', 'editor', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  UPDATE dasher.sessions AS session_row
  SET
    revoked_at = v_now,
    revocation_reason = 'user_revoked'
  WHERE session_row.session_id = p_target_session_id
    AND session_row.organization_id = v_trusted_organization_id
    AND session_row.user_id = v_context_user_id
    AND session_row.revoked_at IS NULL;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_trusted_organization_id,
    v_now,
    'user',
    v_context_user_id,
    NULL,
    v_context_authority_revision,
    v_request_id,
    NULL,
    'session.revoked',
    'session',
    p_target_session_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY SELECT p_target_session_id, v_now;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation
    OR invalid_text_representation
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.change_membership_role(
  p_membership_id uuid,
  p_new_role text,
  p_audit_event_id uuid,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_deployment_revision text
)
RETURNS TABLE (
  membership_id uuid,
  authority_revision bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_context_session_id uuid;
  v_context_user_id uuid;
  v_context_organization_id uuid;
  v_context_membership_id uuid;
  v_context_authority_revision bigint;
  v_context_session_key_version smallint;
  v_context_session_digest bytea;
  v_request_id uuid;
  v_actor_user_id uuid;
  v_actor_organization_id uuid;
  v_actor_membership_id uuid;
  v_actor_authority_revision bigint;
  v_target_user_id uuid;
  v_target_role text;
  v_new_authority_revision bigint;
  v_admin_count bigint;
  v_now timestamptz;
  v_organization_advisory_key bigint;
  v_constraint_name text;
BEGIN
  IF p_membership_id IS NULL
    OR p_new_role IS NULL
    OR p_new_role NOT IN ('viewer', 'editor', 'admin')
    OR p_audit_event_id IS NULL
    OR p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  BEGIN
    v_context_session_id := pg_catalog.current_setting(
      'dasher.context_session_id',
      true
    )::uuid;
    v_context_user_id := pg_catalog.current_setting(
      'dasher.context_user_id',
      true
    )::uuid;
    v_context_organization_id := pg_catalog.current_setting(
      'dasher.context_organization_id',
      true
    )::uuid;
    v_context_membership_id := pg_catalog.current_setting(
      'dasher.context_membership_id',
      true
    )::uuid;
    v_context_authority_revision := pg_catalog.current_setting(
      'dasher.context_authority_revision',
      true
    )::bigint;
    v_context_session_key_version := pg_catalog.current_setting(
      'dasher.context_session_key_version',
      true
    )::smallint;
    v_context_session_digest := pg_catalog.decode(
      pg_catalog.current_setting(
        'dasher.context_session_digest_hex',
        true
      ),
      'hex'
    );
    v_request_id := pg_catalog.current_setting(
      'dasher.context_request_id',
      true
    )::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1001',
        MESSAGE = 'dasher_denied';
  END;

  IF v_request_id IS NULL
    OR p_audit_event_id = v_request_id
    OR v_context_session_digest IS NULL
    OR pg_catalog.octet_length(v_context_session_digest) <> 32
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.user_id,
    session_row.organization_id,
    membership.membership_id
  INTO
    v_actor_user_id,
    v_actor_organization_id,
    v_actor_membership_id
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.user_id = v_context_user_id
    AND session_row.organization_id = v_context_organization_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND membership.membership_id = v_context_membership_id
    AND membership.state = 'active'
    AND membership.role = 'admin'
    AND membership.authority_revision = v_context_authority_revision;

  IF NOT FOUND OR p_membership_id = v_actor_membership_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text
      || v_actor_organization_id::text,
    20260730::bigint
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    v_organization_advisory_key
  );

  SELECT membership.user_id
  INTO v_target_user_id
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.membership_id = p_membership_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND (
      membership.user_id IN (v_actor_user_id, v_target_user_id)
      OR (
        membership.state = 'active'
        AND membership.role = 'admin'
      )
    )
  ORDER BY membership.organization_id, membership.user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_actor_organization_id
    AND (
      session_row.session_id = v_context_session_id
      OR session_row.user_id = v_target_user_id
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  SELECT membership.authority_revision
  INTO v_actor_authority_revision
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_actor_organization_id
    AND session_row.user_id = v_actor_user_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.csrf_key_version = p_current_csrf_key_version
    AND session_row.csrf_digest = p_current_csrf_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_actor_membership_id
    AND membership.state = 'active'
    AND membership.role = 'admin'
    AND membership.authority_revision = v_context_authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT membership.role
  INTO v_target_role
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.membership_id = p_membership_id
    AND membership.user_id = v_target_user_id
    AND membership.state = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_admin_count
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.state = 'active'
    AND membership.role = 'admin';

  IF v_target_role = 'admin'
    AND p_new_role <> 'admin'
    AND v_admin_count <= 1
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  UPDATE dasher.memberships AS membership
  SET
    role = p_new_role,
    authority_revision = membership.authority_revision + 1,
    updated_at = v_now
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.membership_id = p_membership_id
    AND membership.user_id = v_target_user_id
    AND membership.state = 'active'
  RETURNING membership.authority_revision
  INTO v_new_authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  UPDATE dasher.sessions AS session_row
  SET
    revoked_at = v_now,
    revocation_reason = 'authority_changed'
  WHERE session_row.organization_id = v_actor_organization_id
    AND session_row.user_id = v_target_user_id
    AND session_row.revoked_at IS NULL;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_actor_organization_id,
    v_now,
    'user',
    v_actor_user_id,
    NULL,
    v_actor_authority_revision,
    v_request_id,
    NULL,
    'membership.role_changed',
    'membership',
    p_membership_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY SELECT p_membership_id, v_new_authority_revision;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation
    OR invalid_text_representation
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.revoke_membership(
  p_membership_id uuid,
  p_audit_event_id uuid,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_deployment_revision text
)
RETURNS TABLE (
  membership_id uuid,
  authority_revision bigint,
  revoked_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_context_session_id uuid;
  v_context_user_id uuid;
  v_context_organization_id uuid;
  v_context_membership_id uuid;
  v_context_authority_revision bigint;
  v_context_session_key_version smallint;
  v_context_session_digest bytea;
  v_request_id uuid;
  v_actor_user_id uuid;
  v_actor_organization_id uuid;
  v_actor_membership_id uuid;
  v_actor_authority_revision bigint;
  v_target_user_id uuid;
  v_target_role text;
  v_new_authority_revision bigint;
  v_admin_count bigint;
  v_now timestamptz;
  v_organization_advisory_key bigint;
  v_constraint_name text;
BEGIN
  IF p_membership_id IS NULL
    OR p_audit_event_id IS NULL
    OR p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  BEGIN
    v_context_session_id := pg_catalog.current_setting(
      'dasher.context_session_id',
      true
    )::uuid;
    v_context_user_id := pg_catalog.current_setting(
      'dasher.context_user_id',
      true
    )::uuid;
    v_context_organization_id := pg_catalog.current_setting(
      'dasher.context_organization_id',
      true
    )::uuid;
    v_context_membership_id := pg_catalog.current_setting(
      'dasher.context_membership_id',
      true
    )::uuid;
    v_context_authority_revision := pg_catalog.current_setting(
      'dasher.context_authority_revision',
      true
    )::bigint;
    v_context_session_key_version := pg_catalog.current_setting(
      'dasher.context_session_key_version',
      true
    )::smallint;
    v_context_session_digest := pg_catalog.decode(
      pg_catalog.current_setting(
        'dasher.context_session_digest_hex',
        true
      ),
      'hex'
    );
    v_request_id := pg_catalog.current_setting(
      'dasher.context_request_id',
      true
    )::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1001',
        MESSAGE = 'dasher_denied';
  END;

  IF v_request_id IS NULL
    OR p_audit_event_id = v_request_id
    OR v_context_session_digest IS NULL
    OR pg_catalog.octet_length(v_context_session_digest) <> 32
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.user_id,
    session_row.organization_id,
    membership.membership_id
  INTO
    v_actor_user_id,
    v_actor_organization_id,
    v_actor_membership_id
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.user_id = v_context_user_id
    AND session_row.organization_id = v_context_organization_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND membership.membership_id = v_context_membership_id
    AND membership.state = 'active'
    AND membership.role = 'admin'
    AND membership.authority_revision = v_context_authority_revision;

  IF NOT FOUND OR p_membership_id = v_actor_membership_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text
      || v_actor_organization_id::text,
    20260730::bigint
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    v_organization_advisory_key
  );

  SELECT membership.user_id
  INTO v_target_user_id
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.membership_id = p_membership_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND (
      membership.user_id IN (v_actor_user_id, v_target_user_id)
      OR (
        membership.state = 'active'
        AND membership.role = 'admin'
      )
    )
  ORDER BY membership.organization_id, membership.user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_actor_organization_id
    AND (
      session_row.session_id = v_context_session_id
      OR session_row.user_id = v_target_user_id
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  SELECT membership.authority_revision
  INTO v_actor_authority_revision
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_context_session_id
    AND session_row.organization_id = v_actor_organization_id
    AND session_row.user_id = v_actor_user_id
    AND session_row.token_key_version = v_context_session_key_version
    AND session_row.token_digest = v_context_session_digest
    AND session_row.csrf_key_version = p_current_csrf_key_version
    AND session_row.csrf_digest = p_current_csrf_digest
    AND session_row.authority_revision = v_context_authority_revision
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_actor_membership_id
    AND membership.state = 'active'
    AND membership.role = 'admin'
    AND membership.authority_revision = v_context_authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT membership.role
  INTO v_target_role
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.membership_id = p_membership_id
    AND membership.user_id = v_target_user_id
    AND membership.state = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_admin_count
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.state = 'active'
    AND membership.role = 'admin';

  IF v_target_role = 'admin' AND v_admin_count <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  UPDATE dasher.memberships AS membership
  SET
    state = 'revoked',
    authority_revision = membership.authority_revision + 1,
    updated_at = v_now,
    revoked_at = v_now
  WHERE membership.organization_id = v_actor_organization_id
    AND membership.membership_id = p_membership_id
    AND membership.user_id = v_target_user_id
    AND membership.state = 'active'
  RETURNING membership.authority_revision
  INTO v_new_authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  UPDATE dasher.sessions AS session_row
  SET
    revoked_at = v_now,
    revocation_reason = 'authority_changed'
  WHERE session_row.organization_id = v_actor_organization_id
    AND session_row.user_id = v_target_user_id
    AND session_row.revoked_at IS NULL;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_actor_organization_id,
    v_now,
    'user',
    v_actor_user_id,
    NULL,
    v_actor_authority_revision,
    v_request_id,
    NULL,
    'membership.revoked',
    'membership',
    p_membership_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY
  SELECT p_membership_id, v_new_authority_revision, v_now;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation
    OR invalid_text_representation
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.issue_invitation(
  p_invitation_id uuid,
  p_normalized_email text,
  p_requested_role text,
  p_token_key_version smallint,
  p_token_digest bytea,
  p_audit_event_id uuid,
  p_current_session_key_version smallint,
  p_current_session_digest bytea,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS TABLE (
  invitation_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_session_id uuid;
  v_user_id uuid;
  v_organization_id uuid;
  v_membership_id uuid;
  v_authority_revision bigint;
  v_rotated_from_session_id uuid;
  v_replaced_by_session_id uuid;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_organization_advisory_key bigint;
  v_invitation_family_advisory_key bigint;
  v_advisory_key bigint;
  v_constraint_name text;
BEGIN
  IF p_invitation_id IS NULL
    OR p_normalized_email IS NULL
    OR pg_catalog.char_length(p_normalized_email) NOT BETWEEN 3 AND 320
    OR pg_catalog.octet_length(p_normalized_email)
      <> pg_catalog.char_length(p_normalized_email)
    OR p_normalized_email COLLATE pg_catalog."C" !~ '^[!-~]+$'
    OR p_normalized_email COLLATE pg_catalog."C" ~ '[A-Z]'
    OR pg_catalog.char_length(p_normalized_email)
      - pg_catalog.char_length(
        pg_catalog.replace(p_normalized_email, '@', '')
      ) <> 1
    OR pg_catalog.strpos(p_normalized_email, '@') <= 1
    OR pg_catalog.strpos(p_normalized_email, '@')
      >= pg_catalog.char_length(p_normalized_email)
    OR p_requested_role IS NULL
    OR p_requested_role NOT IN ('viewer', 'editor', 'admin')
    OR p_token_key_version IS NULL
    OR p_token_key_version NOT BETWEEN 1 AND 32767
    OR p_token_digest IS NULL
    OR pg_catalog.octet_length(p_token_digest) <> 32
    OR p_audit_event_id IS NULL
    OR p_current_session_key_version IS NULL
    OR p_current_session_key_version NOT BETWEEN 1 AND 32767
    OR p_current_session_digest IS NULL
    OR pg_catalog.octet_length(p_current_session_digest) <> 32
    OR p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_request_id IS NULL
    OR p_audit_event_id = p_request_id
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.session_id,
    session_row.user_id,
    session_row.organization_id,
    membership.membership_id,
    session_row.rotated_from_session_id,
    session_row.replaced_by_session_id
  INTO
    v_session_id,
    v_user_id,
    v_organization_id,
    v_membership_id,
    v_rotated_from_session_id,
    v_replaced_by_session_id
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.token_key_version = p_current_session_key_version
    AND session_row.token_digest = p_current_session_digest;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text || v_organization_id::text,
    20260730::bigint
  );
  v_invitation_family_advisory_key := pg_catalog.hashtextextended(
    'dasher:invitation-family:v1:'::text
      || v_organization_id::text
      || ':'::text
      || p_normalized_email,
    20260730::bigint
  );

  FOR v_advisory_key IN
    SELECT DISTINCT key_set.advisory_key
    FROM pg_catalog.unnest(
      ARRAY[
        v_organization_advisory_key,
        v_invitation_family_advisory_key
      ]::bigint[]
    ) AS key_set(advisory_key)
    ORDER BY key_set.advisory_key
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(v_advisory_key);
  END LOOP;

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = v_membership_id
    AND membership.organization_id = v_organization_id
    AND membership.user_id = v_user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_organization_id
    AND (
      session_row.session_id = v_session_id
      OR session_row.session_id = v_rotated_from_session_id
      OR session_row.session_id = v_replaced_by_session_id
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.invitations AS invitation
  WHERE invitation.organization_id = v_organization_id
    AND invitation.normalized_email = p_normalized_email
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL
  ORDER BY invitation.organization_id, invitation.invitation_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  PERFORM 1
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_session_id
    AND session_row.organization_id = v_organization_id
    AND session_row.user_id = v_user_id
    AND session_row.token_key_version = p_current_session_key_version
    AND session_row.token_digest = p_current_session_digest
    AND session_row.csrf_key_version = p_current_csrf_key_version
    AND session_row.csrf_digest = p_current_csrf_digest
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_membership_id
    AND membership.state = 'active'
    AND membership.role = 'admin'
    AND membership.authority_revision = session_row.authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT membership.authority_revision
  INTO v_authority_revision
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = v_membership_id
    AND membership.organization_id = v_organization_id
    AND membership.user_id = v_user_id;

  UPDATE dasher.invitations AS invitation
  SET
    revoked_at = v_now,
    revoked_by_user_id = v_user_id
  WHERE invitation.organization_id = v_organization_id
    AND invitation.normalized_email = p_normalized_email
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL;

  v_expires_at := v_now + pg_catalog.make_interval(days => 7);

  INSERT INTO dasher.invitations (
    invitation_id,
    organization_id,
    normalized_email,
    granted_role,
    role_ceiling,
    token_key_version,
    token_digest,
    created_by_user_id,
    created_at,
    expires_at,
    accepted_at,
    accepted_user_id,
    revoked_at,
    revoked_by_user_id
  )
  VALUES (
    p_invitation_id,
    v_organization_id,
    p_normalized_email,
    p_requested_role,
    'admin',
    p_token_key_version,
    p_token_digest,
    v_user_id,
    v_now,
    v_expires_at,
    NULL,
    NULL,
    NULL,
    NULL
  );

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_organization_id,
    v_now,
    'user',
    v_user_id,
    NULL,
    v_authority_revision,
    p_request_id,
    NULL,
    'invitation.issued',
    'invitation',
    p_invitation_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY SELECT p_invitation_id, v_expires_at;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'invitations_pkey',
      'invitations_org_id_key',
      'invitations_token_key',
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.accept_invitation(
  p_invite_key_version smallint,
  p_invite_digest bytea,
  p_issuer text,
  p_subject text,
  p_normalized_verified_email text,
  p_email_verified boolean,
  p_new_user_id uuid,
  p_new_membership_id uuid,
  p_new_session_id uuid,
  p_session_key_version smallint,
  p_session_digest bytea,
  p_csrf_key_version smallint,
  p_csrf_digest bytea,
  p_audit_event_id uuid,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS TABLE (
  user_id uuid,
  organization_id uuid,
  membership_id uuid,
  granted_role text,
  authority_revision bigint,
  session_id uuid,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_invitation_id uuid;
  v_organization_id uuid;
  v_invitation_email text;
  v_invitation_role text;
  v_user_id uuid;
  v_membership_id uuid;
  v_membership_role text;
  v_authority_revision bigint;
  v_now timestamptz;
  v_idle_expires_at timestamptz;
  v_absolute_expires_at timestamptz;
  v_created_membership boolean := false;
  v_row_count integer;
  v_organization_advisory_key bigint;
  v_invitation_family_advisory_key bigint;
  v_advisory_key bigint;
  v_constraint_name text;
BEGIN
  IF p_invite_key_version IS NULL
    OR p_invite_key_version NOT BETWEEN 1 AND 32767
    OR p_invite_digest IS NULL
    OR pg_catalog.octet_length(p_invite_digest) <> 32
    OR p_issuer IS NULL
    OR p_issuer <> pg_catalog.btrim(p_issuer)
    OR pg_catalog.char_length(p_issuer) NOT BETWEEN 1 AND 512
    OR p_issuer ~ '[[:cntrl:]]'
    OR p_subject IS NULL
    OR p_subject <> pg_catalog.btrim(p_subject)
    OR pg_catalog.char_length(p_subject) NOT BETWEEN 1 AND 512
    OR p_subject ~ '[[:cntrl:]]'
    OR p_normalized_verified_email IS NULL
    OR pg_catalog.char_length(p_normalized_verified_email)
      NOT BETWEEN 3 AND 320
    OR pg_catalog.octet_length(p_normalized_verified_email)
      <> pg_catalog.char_length(p_normalized_verified_email)
    OR p_normalized_verified_email COLLATE pg_catalog."C" !~ '^[!-~]+$'
    OR p_normalized_verified_email COLLATE pg_catalog."C" ~ '[A-Z]'
    OR pg_catalog.char_length(p_normalized_verified_email)
      - pg_catalog.char_length(
        pg_catalog.replace(p_normalized_verified_email, '@', '')
      ) <> 1
    OR pg_catalog.strpos(p_normalized_verified_email, '@') <= 1
    OR pg_catalog.strpos(p_normalized_verified_email, '@')
      >= pg_catalog.char_length(p_normalized_verified_email)
    OR p_email_verified IS DISTINCT FROM true
    OR p_new_user_id IS NULL
    OR p_new_membership_id IS NULL
    OR p_new_session_id IS NULL
    OR p_session_key_version IS NULL
    OR p_session_key_version NOT BETWEEN 1 AND 32767
    OR p_session_digest IS NULL
    OR pg_catalog.octet_length(p_session_digest) <> 32
    OR p_csrf_key_version IS NULL
    OR p_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_csrf_digest) <> 32
    OR p_audit_event_id IS NULL
    OR p_request_id IS NULL
    OR p_audit_event_id = p_request_id
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    invitation.invitation_id,
    invitation.organization_id,
    invitation.normalized_email
  INTO
    v_invitation_id,
    v_organization_id,
    v_invitation_email
  FROM dasher.invitations AS invitation
  WHERE invitation.token_key_version = p_invite_key_version
    AND invitation.token_digest = p_invite_digest;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text || v_organization_id::text,
    20260730::bigint
  );
  v_invitation_family_advisory_key := pg_catalog.hashtextextended(
    'dasher:invitation-family:v1:'::text
      || v_organization_id::text
      || ':'::text
      || v_invitation_email,
    20260730::bigint
  );

  FOR v_advisory_key IN
    SELECT DISTINCT key_set.advisory_key
    FROM pg_catalog.unnest(
      ARRAY[
        v_organization_advisory_key,
        v_invitation_family_advisory_key
      ]::bigint[]
    ) AS key_set(advisory_key)
    ORDER BY key_set.advisory_key
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(v_advisory_key);
  END LOOP;

  SELECT
    invitation.invitation_id,
    invitation.organization_id,
    invitation.normalized_email,
    invitation.granted_role
  INTO
    v_invitation_id,
    v_organization_id,
    v_invitation_email,
    v_invitation_role
  FROM dasher.invitations AS invitation
  WHERE invitation.token_key_version = p_invite_key_version
    AND invitation.token_digest = p_invite_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_now := pg_catalog.clock_timestamp();

  PERFORM 1
  FROM dasher.invitations AS invitation
  WHERE invitation.invitation_id = v_invitation_id
    AND invitation.organization_id = v_organization_id
    AND invitation.token_key_version = p_invite_key_version
    AND invitation.token_digest = p_invite_digest
    AND invitation.normalized_email = p_normalized_verified_email
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL
    AND v_now < invitation.expires_at
    AND invitation.granted_role IN ('viewer', 'editor', 'admin')
    AND invitation.role_ceiling IN ('viewer', 'editor', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT identity_row.user_id
  INTO v_user_id
  FROM dasher.external_identities AS identity_row
  WHERE identity_row.issuer = p_issuer
    AND identity_row.subject = p_subject;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO dasher.users (user_id, created_at)
      VALUES (p_new_user_id, v_now);

      INSERT INTO dasher.external_identities (
        issuer,
        subject,
        user_id,
        created_at
      )
      VALUES (
        p_issuer,
        p_subject,
        p_new_user_id,
        v_now
      );

      v_user_id := p_new_user_id;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT identity_row.user_id
        INTO v_user_id
        FROM dasher.external_identities AS identity_row
        WHERE identity_row.issuer = p_issuer
          AND identity_row.subject = p_subject;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P1002',
            MESSAGE = 'dasher_conflict';
        END IF;
    END;
  END IF;

  SELECT
    membership.membership_id,
    membership.role,
    membership.authority_revision
  INTO
    v_membership_id,
    v_membership_role,
    v_authority_revision
  FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_organization_id
    AND membership.user_id = v_user_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_membership_role NOT IN ('viewer', 'editor', 'admin') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1001',
        MESSAGE = 'dasher_denied';
    END IF;

    PERFORM 1
    FROM dasher.memberships AS membership
    WHERE membership.membership_id = v_membership_id
      AND membership.organization_id = v_organization_id
      AND membership.user_id = v_user_id
      AND membership.state = 'active'
      AND membership.authority_revision = v_authority_revision;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1001',
        MESSAGE = 'dasher_denied';
    END IF;
  ELSE
    BEGIN
      INSERT INTO dasher.memberships (
        membership_id,
        organization_id,
        user_id,
        role,
        state,
        authority_revision,
        created_at,
        updated_at,
        revoked_at
      )
      VALUES (
        p_new_membership_id,
        v_organization_id,
        v_user_id,
        v_invitation_role,
        'active',
        1,
        v_now,
        v_now,
        NULL
      );

      v_membership_id := p_new_membership_id;
      v_membership_role := v_invitation_role;
      v_authority_revision := 1;
      v_created_membership := true;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT
          membership.membership_id,
          membership.role,
          membership.authority_revision
        INTO
          v_membership_id,
          v_membership_role,
          v_authority_revision
        FROM dasher.memberships AS membership
        WHERE membership.organization_id = v_organization_id
          AND membership.user_id = v_user_id
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P1002',
            MESSAGE = 'dasher_conflict';
        END IF;

        PERFORM 1
        FROM dasher.memberships AS membership
        WHERE membership.membership_id = v_membership_id
          AND membership.organization_id = v_organization_id
          AND membership.user_id = v_user_id
          AND membership.state = 'active'
          AND membership.role IN ('viewer', 'editor', 'admin')
          AND membership.authority_revision = v_authority_revision;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = 'dasher_denied';
        END IF;
    END;
  END IF;

  PERFORM 1
  FROM dasher.invitations AS invitation
  JOIN dasher.memberships AS membership
    ON membership.organization_id = invitation.organization_id
   AND membership.user_id = v_user_id
  WHERE invitation.invitation_id = v_invitation_id
    AND invitation.organization_id = v_organization_id
    AND invitation.token_key_version = p_invite_key_version
    AND invitation.token_digest = p_invite_digest
    AND invitation.normalized_email = p_normalized_verified_email
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL
    AND v_now < invitation.expires_at
    AND membership.membership_id = v_membership_id
    AND membership.state = 'active'
    AND membership.role = v_membership_role
    AND membership.authority_revision = v_authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  PERFORM 1
  FROM dasher.sessions AS session_collision
  WHERE session_collision.session_id = p_new_session_id;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1002',
      MESSAGE = 'dasher_conflict';
  END IF;

  UPDATE dasher.invitations AS invitation
  SET
    accepted_at = v_now,
    accepted_user_id = v_user_id
  WHERE invitation.invitation_id = v_invitation_id
    AND invitation.organization_id = v_organization_id
    AND invitation.token_key_version = p_invite_key_version
    AND invitation.token_digest = p_invite_digest
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL
    AND v_now < invitation.expires_at;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_idle_expires_at := v_now + pg_catalog.make_interval(mins => 30);
  v_absolute_expires_at := v_now + pg_catalog.make_interval(days => 7);

  BEGIN
    INSERT INTO dasher.sessions (
      session_id,
      organization_id,
      user_id,
      authority_revision,
      token_key_version,
      token_digest,
      csrf_key_version,
      csrf_digest,
      issued_at,
      last_seen_at,
      idle_expires_at,
      absolute_expires_at,
      rotated_from_session_id,
      replaced_by_session_id,
      revoked_at,
      revocation_reason
    )
    VALUES (
      p_new_session_id,
      v_organization_id,
      v_user_id,
      v_authority_revision,
      p_session_key_version,
      p_session_digest,
      p_csrf_key_version,
      p_csrf_digest,
      v_now,
      v_now,
      v_idle_expires_at,
      v_absolute_expires_at,
      NULL,
      NULL,
      NULL,
      NULL
    );
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS
        v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IN (
        'sessions_pkey',
        'sessions_token_key',
        'sessions_csrf_key'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1002',
          MESSAGE = 'dasher_conflict';
      END IF;
      RAISE;
  END;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_organization_id,
    v_now,
    'user',
    v_user_id,
    NULL,
    v_authority_revision,
    p_request_id,
    NULL,
    CASE
      WHEN v_created_membership THEN 'invitation.accepted'
      ELSE 'invitation.accepted_existing_membership'
    END,
    'invitation',
    v_invitation_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY
  SELECT
    v_user_id,
    v_organization_id,
    v_membership_id,
    v_membership_role,
    v_authority_revision,
    p_new_session_id,
    v_idle_expires_at,
    v_absolute_expires_at;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.revoke_invitation(
  p_invitation_id uuid,
  p_audit_event_id uuid,
  p_current_session_key_version smallint,
  p_current_session_digest bytea,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS TABLE (
  invitation_id uuid,
  revoked_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_session_id uuid;
  v_user_id uuid;
  v_organization_id uuid;
  v_membership_id uuid;
  v_authority_revision bigint;
  v_normalized_email text;
  v_rotated_from_session_id uuid;
  v_replaced_by_session_id uuid;
  v_now timestamptz;
  v_organization_advisory_key bigint;
  v_invitation_family_advisory_key bigint;
  v_advisory_key bigint;
  v_constraint_name text;
BEGIN
  IF p_invitation_id IS NULL
    OR p_audit_event_id IS NULL
    OR p_current_session_key_version IS NULL
    OR p_current_session_key_version NOT BETWEEN 1 AND 32767
    OR p_current_session_digest IS NULL
    OR pg_catalog.octet_length(p_current_session_digest) <> 32
    OR p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_request_id IS NULL
    OR p_audit_event_id = p_request_id
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.session_id,
    session_row.user_id,
    session_row.organization_id,
    membership.membership_id,
    session_row.rotated_from_session_id,
    session_row.replaced_by_session_id
  INTO
    v_session_id,
    v_user_id,
    v_organization_id,
    v_membership_id,
    v_rotated_from_session_id,
    v_replaced_by_session_id
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.token_key_version = p_current_session_key_version
    AND session_row.token_digest = p_current_session_digest;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT invitation.normalized_email
  INTO v_normalized_email
  FROM dasher.invitations AS invitation
  WHERE invitation.organization_id = v_organization_id
    AND invitation.invitation_id = p_invitation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text || v_organization_id::text,
    20260730::bigint
  );
  v_invitation_family_advisory_key := pg_catalog.hashtextextended(
    'dasher:invitation-family:v1:'::text
      || v_organization_id::text
      || ':'::text
      || v_normalized_email,
    20260730::bigint
  );

  FOR v_advisory_key IN
    SELECT DISTINCT key_set.advisory_key
    FROM pg_catalog.unnest(
      ARRAY[
        v_organization_advisory_key,
        v_invitation_family_advisory_key
      ]::bigint[]
    ) AS key_set(advisory_key)
    ORDER BY key_set.advisory_key
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(v_advisory_key);
  END LOOP;

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = v_membership_id
    AND membership.organization_id = v_organization_id
    AND membership.user_id = v_user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_organization_id
    AND (
      session_row.session_id = v_session_id
      OR session_row.session_id = v_rotated_from_session_id
      OR session_row.session_id = v_replaced_by_session_id
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.invitations AS invitation
  WHERE invitation.organization_id = v_organization_id
    AND invitation.invitation_id = p_invitation_id
  ORDER BY invitation.organization_id, invitation.invitation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_now := pg_catalog.clock_timestamp();

  SELECT membership.authority_revision
  INTO v_authority_revision
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  JOIN dasher.invitations AS invitation
    ON invitation.organization_id = session_row.organization_id
   AND invitation.invitation_id = p_invitation_id
  WHERE session_row.session_id = v_session_id
    AND session_row.organization_id = v_organization_id
    AND session_row.user_id = v_user_id
    AND session_row.token_key_version = p_current_session_key_version
    AND session_row.token_digest = p_current_session_digest
    AND session_row.csrf_key_version = p_current_csrf_key_version
    AND session_row.csrf_digest = p_current_csrf_digest
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_membership_id
    AND membership.state = 'active'
    AND membership.role = 'admin'
    AND membership.authority_revision = session_row.authority_revision
    AND invitation.normalized_email = v_normalized_email
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  UPDATE dasher.invitations AS invitation
  SET
    revoked_at = v_now,
    revoked_by_user_id = v_user_id
  WHERE invitation.organization_id = v_organization_id
    AND invitation.invitation_id = p_invitation_id
    AND invitation.accepted_at IS NULL
    AND invitation.revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_organization_id,
    v_now,
    'user',
    v_user_id,
    NULL,
    v_authority_revision,
    p_request_id,
    NULL,
    'invitation.revoked',
    'invitation',
    p_invitation_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY SELECT p_invitation_id, v_now;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_private.context_organization_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

CREATE FUNCTION dasher_private.context_membership_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting(
    'dasher.context_membership_id',
    true
  )::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
$function$;

CREATE FUNCTION dasher_private.context_session_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting(
    'dasher.context_session_id',
    true
  )::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
$function$;

CREATE FUNCTION dasher_private.context_request_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting(
    'dasher.context_request_id',
    true
  )::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
$function$;

CREATE FUNCTION dasher_private.context_authority_revision()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN pg_catalog.current_setting(
    'dasher.context_authority_revision',
    true
  )::bigint;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END
$function$;

CREATE FUNCTION dasher_private.context_allows(
  p_organization_id uuid,
  p_required_role text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_session_id uuid;
  v_user_id uuid;
  v_organization_id uuid;
  v_membership_id uuid;
  v_authority_revision bigint;
  v_session_key_version smallint;
  v_session_digest bytea;
  v_now timestamptz;
BEGIN
  IF p_required_role IS NULL
    OR p_required_role NOT IN ('viewer', 'editor', 'admin')
  THEN
    RETURN false;
  END IF;

  BEGIN
    v_session_id := pg_catalog.current_setting(
      'dasher.context_session_id',
      true
    )::uuid;
    v_user_id := pg_catalog.current_setting(
      'dasher.context_user_id',
      true
    )::uuid;
    v_organization_id := pg_catalog.current_setting(
      'dasher.context_organization_id',
      true
    )::uuid;
    v_membership_id := pg_catalog.current_setting(
      'dasher.context_membership_id',
      true
    )::uuid;
    v_authority_revision := pg_catalog.current_setting(
      'dasher.context_authority_revision',
      true
    )::bigint;
    v_session_key_version := pg_catalog.current_setting(
      'dasher.context_session_key_version',
      true
    )::smallint;
    v_session_digest := pg_catalog.decode(
      pg_catalog.current_setting(
        'dasher.context_session_digest_hex',
        true
      ),
      'hex'
    );
  EXCEPTION
    WHEN OTHERS THEN
      RETURN false;
  END;

  IF v_session_id IS NULL
    OR v_user_id IS NULL
    OR v_organization_id IS NULL
    OR v_membership_id IS NULL
    OR v_authority_revision IS NULL
    OR v_session_key_version IS NULL
    OR v_session_digest IS NULL
    OR pg_catalog.octet_length(v_session_digest) <> 32
    OR p_organization_id IS DISTINCT FROM v_organization_id
  THEN
    RETURN false;
  END IF;

  v_now := pg_catalog.clock_timestamp();

  RETURN EXISTS (
    SELECT 1
    FROM dasher.sessions AS session_row
    JOIN dasher.memberships AS membership
      ON membership.organization_id = session_row.organization_id
     AND membership.user_id = session_row.user_id
    WHERE session_row.session_id = v_session_id
      AND session_row.organization_id = v_organization_id
      AND session_row.user_id = v_user_id
      AND session_row.authority_revision = v_authority_revision
      AND session_row.token_key_version = v_session_key_version
      AND session_row.token_digest = v_session_digest
      AND session_row.replaced_by_session_id IS NULL
      AND session_row.revoked_at IS NULL
      AND v_now < session_row.idle_expires_at
      AND v_now < session_row.absolute_expires_at
      AND membership.membership_id = v_membership_id
      AND membership.state = 'active'
      AND membership.authority_revision = v_authority_revision
      AND (
        membership.role = 'admin'
        OR (
          membership.role = 'editor'
          AND p_required_role IN ('editor', 'viewer')
        )
        OR (
          membership.role = 'viewer'
          AND p_required_role = 'viewer'
        )
      )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END
$function$;

CREATE FUNCTION dasher_api.initialize_context(
  p_session_key_version smallint,
  p_session_digest bytea,
  p_request_id uuid
)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  organization_id uuid,
  membership_id uuid,
  authority_revision bigint,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_session_id uuid;
  v_user_id uuid;
  v_organization_id uuid;
  v_membership_id uuid;
  v_authority_revision bigint;
  v_rotated_from_session_id uuid;
  v_replaced_by_session_id uuid;
  v_idle_expires_at timestamptz;
  v_absolute_expires_at timestamptz;
  v_last_seen_at timestamptz;
  v_now timestamptz;
  v_organization_advisory_key bigint;
BEGIN
  IF p_session_key_version IS NULL
    OR p_session_key_version NOT BETWEEN 1 AND 32767
    OR p_session_digest IS NULL
    OR pg_catalog.octet_length(p_session_digest) <> 32
    OR p_request_id IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT
    session_row.session_id,
    session_row.user_id,
    session_row.organization_id,
    membership.membership_id,
    session_row.rotated_from_session_id,
    session_row.replaced_by_session_id
  INTO
    v_session_id,
    v_user_id,
    v_organization_id,
    v_membership_id,
    v_rotated_from_session_id,
    v_replaced_by_session_id
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.token_key_version = p_session_key_version
    AND session_row.token_digest = p_session_digest;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text || v_organization_id::text,
    20260730::bigint
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    v_organization_advisory_key
  );

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = v_membership_id
    AND membership.organization_id = v_organization_id
    AND membership.user_id = v_user_id
  FOR UPDATE;

  PERFORM 1
  FROM dasher.sessions AS session_row
  WHERE session_row.organization_id = v_organization_id
    AND (
      session_row.session_id = v_session_id
      OR session_row.session_id = v_rotated_from_session_id
      OR session_row.session_id = v_replaced_by_session_id
    )
  ORDER BY session_row.organization_id, session_row.session_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  SELECT
    membership.membership_id,
    membership.authority_revision,
    session_row.last_seen_at,
    session_row.idle_expires_at,
    session_row.absolute_expires_at
  INTO
    v_membership_id,
    v_authority_revision,
    v_last_seen_at,
    v_idle_expires_at,
    v_absolute_expires_at
  FROM dasher.sessions AS session_row
  JOIN dasher.memberships AS membership
    ON membership.organization_id = session_row.organization_id
   AND membership.user_id = session_row.user_id
  WHERE session_row.session_id = v_session_id
    AND session_row.organization_id = v_organization_id
    AND session_row.user_id = v_user_id
    AND session_row.token_key_version = p_session_key_version
    AND session_row.token_digest = p_session_digest
    AND session_row.replaced_by_session_id IS NULL
    AND session_row.revoked_at IS NULL
    AND v_now < session_row.idle_expires_at
    AND v_now < session_row.absolute_expires_at
    AND membership.membership_id = v_membership_id
    AND membership.state = 'active'
    AND membership.authority_revision = session_row.authority_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  IF v_now - v_last_seen_at >= pg_catalog.make_interval(mins => 5) THEN
    v_idle_expires_at := LEAST(
      v_now + pg_catalog.make_interval(mins => 30),
      v_absolute_expires_at
    );
    UPDATE dasher.sessions AS session_row
    SET
      last_seen_at = v_now,
      idle_expires_at = v_idle_expires_at
    WHERE session_row.session_id = v_session_id
      AND session_row.organization_id = v_organization_id;
  END IF;

  PERFORM pg_catalog.set_config(
    'dasher.context_session_id',
    v_session_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_session_key_version',
    p_session_key_version::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_session_digest_hex',
    pg_catalog.encode(p_session_digest, 'hex'),
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_user_id',
    v_user_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_organization_id',
    v_organization_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_membership_id',
    v_membership_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_authority_revision',
    v_authority_revision::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_request_id',
    p_request_id::text,
    true
  );

  RETURN QUERY
  SELECT
    v_session_id,
    v_user_id,
    v_organization_id,
    v_membership_id,
    v_authority_revision,
    v_idle_expires_at,
    v_absolute_expires_at;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;

CREATE FUNCTION dasher_api.issue_session(
  p_issuer text,
  p_subject text,
  p_membership_id uuid,
  p_session_id uuid,
  p_session_key_version smallint,
  p_session_digest bytea,
  p_csrf_key_version smallint,
  p_csrf_digest bytea,
  p_audit_event_id uuid,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS TABLE (
  user_id uuid,
  organization_id uuid,
  membership_id uuid,
  granted_role text,
  authority_revision bigint,
  session_id uuid,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid;
  v_organization_id uuid;
  v_role text;
  v_authority_revision bigint;
  v_idle_expires_at timestamptz;
  v_absolute_expires_at timestamptz;
  v_now timestamptz;
  v_organization_advisory_key bigint;
  v_constraint_name text;
BEGIN
  IF p_issuer IS NULL
    OR p_issuer <> pg_catalog.btrim(p_issuer)
    OR pg_catalog.char_length(p_issuer) NOT BETWEEN 1 AND 512
    OR p_issuer ~ '[[:cntrl:]]'
    OR p_subject IS NULL
    OR p_subject <> pg_catalog.btrim(p_subject)
    OR pg_catalog.char_length(p_subject) NOT BETWEEN 1 AND 512
    OR p_subject ~ '[[:cntrl:]]'
    OR p_membership_id IS NULL
    OR p_session_id IS NULL
    OR p_session_key_version IS NULL
    OR p_session_key_version NOT BETWEEN 1 AND 32767
    OR p_session_digest IS NULL
    OR pg_catalog.octet_length(p_session_digest) <> 32
    OR p_csrf_key_version IS NULL
    OR p_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_csrf_digest) <> 32
    OR p_audit_event_id IS NULL
    OR p_request_id IS NULL
    OR p_audit_event_id = p_request_id
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  SELECT identity_row.user_id, membership.organization_id
  INTO v_user_id, v_organization_id
  FROM dasher.external_identities AS identity_row
  JOIN dasher.memberships AS membership
    ON membership.user_id = identity_row.user_id
  WHERE identity_row.issuer = p_issuer
    AND identity_row.subject = p_subject
    AND membership.membership_id = p_membership_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_organization_advisory_key := pg_catalog.hashtextextended(
    'dasher:task4-organization:v1:'::text || v_organization_id::text,
    20260730::bigint
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    v_organization_advisory_key
  );

  PERFORM 1
  FROM dasher.memberships AS membership
  WHERE membership.membership_id = p_membership_id
    AND membership.organization_id = v_organization_id
    AND membership.user_id = v_user_id
  FOR UPDATE;

  SELECT membership.role, membership.authority_revision
  INTO v_role, v_authority_revision
  FROM dasher.external_identities AS identity_row
  JOIN dasher.memberships AS membership
    ON membership.user_id = identity_row.user_id
  WHERE identity_row.issuer = p_issuer
    AND identity_row.subject = p_subject
    AND identity_row.user_id = v_user_id
    AND membership.membership_id = p_membership_id
    AND membership.organization_id = v_organization_id
    AND membership.state = 'active'
    AND membership.role IN ('viewer', 'editor', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
  END IF;

  v_now := pg_catalog.clock_timestamp();

  PERFORM 1
  FROM dasher.sessions AS session_collision
  WHERE session_collision.session_id = p_session_id;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1002',
      MESSAGE = 'dasher_conflict';
  END IF;

  v_idle_expires_at := v_now + pg_catalog.make_interval(mins => 30);
  v_absolute_expires_at := v_now + pg_catalog.make_interval(days => 7);

  BEGIN
    INSERT INTO dasher.sessions (
      session_id,
      organization_id,
      user_id,
      authority_revision,
      token_key_version,
      token_digest,
      csrf_key_version,
      csrf_digest,
      issued_at,
      last_seen_at,
      idle_expires_at,
      absolute_expires_at,
      rotated_from_session_id,
      replaced_by_session_id,
      revoked_at,
      revocation_reason
    )
    VALUES (
      p_session_id,
      v_organization_id,
      v_user_id,
      v_authority_revision,
      p_session_key_version,
      p_session_digest,
      p_csrf_key_version,
      p_csrf_digest,
      v_now,
      v_now,
      v_idle_expires_at,
      v_absolute_expires_at,
      NULL,
      NULL,
      NULL,
      NULL
    );
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS
        v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IN (
        'sessions_pkey',
        'sessions_token_key',
        'sessions_csrf_key'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1002',
          MESSAGE = 'dasher_conflict';
      END IF;
      RAISE;
  END;

  INSERT INTO dasher.audit_events (
    audit_event_id,
    organization_id,
    occurred_at,
    actor_kind,
    actor_user_id,
    actor_service,
    authority_revision,
    request_id,
    job_id,
    action,
    target_type,
    target_id,
    outcome,
    content_sha256,
    source_ref,
    provider,
    credential_version,
    usage_units,
    cost_minor_units,
    deployment_revision
  )
  VALUES (
    p_audit_event_id,
    v_organization_id,
    v_now,
    'user',
    v_user_id,
    NULL,
    v_authority_revision,
    p_request_id,
    NULL,
    'session.issued',
    'session',
    p_session_id,
    'succeeded',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_deployment_revision
  );

  RETURN QUERY
  SELECT
    v_user_id,
    v_organization_id,
    p_membership_id,
    v_role,
    v_authority_revision,
    p_session_id,
    v_idle_expires_at,
    v_absolute_expires_at;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS
      v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN (
      'audit_events_pkey',
      'audit_events_org_id_key'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'dasher_conflict';
    END IF;
    RAISE;
  WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1001',
      MESSAGE = 'dasher_denied';
END
$function$;
ALTER FUNCTION dasher_private.context_user_id()
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_private.context_organization_id()
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_private.context_membership_id()
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_private.context_session_id()
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_private.context_request_id()
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_private.context_authority_revision()
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_private.context_allows(uuid, text)
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.initialize_context(smallint, bytea, uuid)
  OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.accept_invitation(
  smallint,
  bytea,
  text,
  text,
  text,
  boolean,
  uuid,
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  uuid,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.issue_session(
  text,
  text,
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  uuid,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.issue_invitation(
  uuid,
  text,
  text,
  smallint,
  bytea,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.revoke_invitation(
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.change_membership_role(
  uuid,
  text,
  uuid,
  smallint,
  bytea,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.revoke_membership(
  uuid,
  uuid,
  smallint,
  bytea,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.rotate_session(
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  smallint,
  bytea,
  text
) OWNER TO dasher_security_definer;
ALTER FUNCTION dasher_api.revoke_session(
  uuid,
  uuid,
  smallint,
  bytea,
  text
) OWNER TO dasher_security_definer;

REVOKE ALL ON FUNCTION dasher_private.context_user_id()
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.context_organization_id()
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.context_membership_id()
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.context_session_id()
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.context_request_id()
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.context_authority_revision()
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.context_allows(uuid, text)
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.initialize_context(smallint, bytea, uuid)
  FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.accept_invitation(
  smallint,
  bytea,
  text,
  text,
  text,
  boolean,
  uuid,
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  uuid,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.issue_session(
  text,
  text,
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  uuid,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.issue_invitation(
  uuid,
  text,
  text,
  smallint,
  bytea,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.revoke_invitation(
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.change_membership_role(
  uuid,
  text,
  uuid,
  smallint,
  bytea,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.revoke_membership(
  uuid,
  uuid,
  smallint,
  bytea,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.rotate_session(
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  smallint,
  bytea,
  text
) FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_api.revoke_session(
  uuid,
  uuid,
  smallint,
  bytea,
  text
) FROM PUBLIC, dasher_app;

GRANT EXECUTE ON FUNCTION dasher_private.context_user_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_organization_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_membership_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_session_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_request_id()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_authority_revision()
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_private.context_allows(uuid, text)
  TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.initialize_context(
  smallint,
  bytea,
  uuid
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.accept_invitation(
  smallint,
  bytea,
  text,
  text,
  text,
  boolean,
  uuid,
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  uuid,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.issue_session(
  text,
  text,
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  uuid,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.issue_invitation(
  uuid,
  text,
  text,
  smallint,
  bytea,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.revoke_invitation(
  uuid,
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.change_membership_role(
  uuid,
  text,
  uuid,
  smallint,
  bytea,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.revoke_membership(
  uuid,
  uuid,
  smallint,
  bytea,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.rotate_session(
  uuid,
  smallint,
  bytea,
  smallint,
  bytea,
  uuid,
  smallint,
  bytea,
  text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.revoke_session(
  uuid,
  uuid,
  smallint,
  bytea,
  text
) TO dasher_app;

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

CREATE POLICY organizations_select
ON dasher.organizations
AS PERMISSIVE
FOR SELECT
TO dasher_app
USING (
  dasher_private.context_allows(organization_id, 'viewer'::text)
);

CREATE POLICY memberships_select
ON dasher.memberships
AS PERMISSIVE
FOR SELECT
TO dasher_app
USING (
  dasher_private.context_allows(organization_id, 'viewer'::text)
);

CREATE POLICY invitations_select
ON dasher.invitations
AS PERMISSIVE
FOR SELECT
TO dasher_app
USING (
  dasher_private.context_allows(organization_id, 'admin'::text)
);

CREATE POLICY sessions_select
ON dasher.sessions
AS PERMISSIVE
FOR SELECT
TO dasher_app
USING (
  dasher_private.context_allows(organization_id, 'viewer'::text)
  AND dasher_private.context_user_id() = user_id
);

CREATE POLICY audit_events_select
ON dasher.audit_events
AS PERMISSIVE
FOR SELECT
TO dasher_app
USING (
  dasher_private.context_allows(organization_id, 'admin'::text)
);

REVOKE ALL ON ALL TABLES IN SCHEMA dasher
  FROM PUBLIC, dasher_app, dasher_security_definer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dasher
  FROM PUBLIC, dasher_app, dasher_security_definer;

GRANT USAGE ON SCHEMA dasher, dasher_api TO dasher_app;
GRANT USAGE ON SCHEMA dasher, dasher_private
  TO dasher_security_definer;

GRANT SELECT (
  organization_id,
  display_name,
  created_at
) ON dasher.organizations TO dasher_app;
GRANT SELECT (
  membership_id,
  organization_id,
  user_id,
  role,
  state,
  authority_revision,
  created_at,
  updated_at,
  revoked_at
) ON dasher.memberships TO dasher_app;
GRANT SELECT (
  invitation_id,
  organization_id,
  normalized_email,
  granted_role,
  role_ceiling,
  created_by_user_id,
  created_at,
  expires_at,
  accepted_at,
  accepted_user_id,
  revoked_at,
  revoked_by_user_id
) ON dasher.invitations TO dasher_app;
GRANT SELECT (
  session_id,
  organization_id,
  user_id,
  authority_revision,
  issued_at,
  last_seen_at,
  idle_expires_at,
  absolute_expires_at,
  rotated_from_session_id,
  replaced_by_session_id,
  revoked_at,
  revocation_reason
) ON dasher.sessions TO dasher_app;
GRANT SELECT (
  audit_event_id,
  organization_id,
  occurred_at,
  actor_kind,
  actor_user_id,
  actor_service,
  authority_revision,
  request_id,
  job_id,
  action,
  target_type,
  target_id,
  outcome,
  content_sha256,
  source_ref,
  provider,
  credential_version,
  usage_units,
  cost_minor_units,
  deployment_revision
) ON dasher.audit_events TO dasher_app;

GRANT SELECT (user_id, created_at)
  ON dasher.users TO dasher_security_definer;
GRANT INSERT (user_id, created_at)
  ON dasher.users TO dasher_security_definer;
GRANT SELECT (issuer, subject, user_id, created_at)
  ON dasher.external_identities TO dasher_security_definer;
GRANT INSERT (issuer, subject, user_id, created_at)
  ON dasher.external_identities TO dasher_security_definer;
GRANT SELECT (
  membership_id,
  organization_id,
  user_id,
  role,
  state,
  authority_revision,
  created_at,
  updated_at,
  revoked_at
) ON dasher.memberships TO dasher_security_definer;
GRANT INSERT (
  membership_id,
  organization_id,
  user_id,
  role,
  state,
  authority_revision,
  created_at,
  updated_at,
  revoked_at
) ON dasher.memberships TO dasher_security_definer;
GRANT UPDATE (
  role,
  state,
  authority_revision,
  updated_at,
  revoked_at
) ON dasher.memberships TO dasher_security_definer;
GRANT SELECT (
  invitation_id,
  organization_id,
  normalized_email,
  granted_role,
  role_ceiling,
  token_key_version,
  token_digest,
  created_by_user_id,
  created_at,
  expires_at,
  accepted_at,
  accepted_user_id,
  revoked_at,
  revoked_by_user_id
) ON dasher.invitations TO dasher_security_definer;
GRANT INSERT (
  invitation_id,
  organization_id,
  normalized_email,
  granted_role,
  role_ceiling,
  token_key_version,
  token_digest,
  created_by_user_id,
  created_at,
  expires_at,
  accepted_at,
  accepted_user_id,
  revoked_at,
  revoked_by_user_id
) ON dasher.invitations TO dasher_security_definer;
GRANT UPDATE (
  accepted_at,
  accepted_user_id,
  revoked_at,
  revoked_by_user_id
) ON dasher.invitations TO dasher_security_definer;
GRANT SELECT (
  session_id,
  organization_id,
  user_id,
  authority_revision,
  token_key_version,
  token_digest,
  csrf_key_version,
  csrf_digest,
  issued_at,
  last_seen_at,
  idle_expires_at,
  absolute_expires_at,
  rotated_from_session_id,
  replaced_by_session_id,
  revoked_at,
  revocation_reason
) ON dasher.sessions TO dasher_security_definer;
GRANT INSERT (
  session_id,
  organization_id,
  user_id,
  authority_revision,
  token_key_version,
  token_digest,
  csrf_key_version,
  csrf_digest,
  issued_at,
  last_seen_at,
  idle_expires_at,
  absolute_expires_at,
  rotated_from_session_id,
  replaced_by_session_id,
  revoked_at,
  revocation_reason
) ON dasher.sessions TO dasher_security_definer;
GRANT UPDATE (
  last_seen_at,
  idle_expires_at,
  replaced_by_session_id,
  revoked_at,
  revocation_reason
) ON dasher.sessions TO dasher_security_definer;
GRANT INSERT (
  audit_event_id,
  organization_id,
  occurred_at,
  actor_kind,
  actor_user_id,
  actor_service,
  authority_revision,
  request_id,
  job_id,
  action,
  target_type,
  target_id,
  outcome,
  content_sha256,
  source_ref,
  provider,
  credential_version,
  usage_units,
  cost_minor_units,
  deployment_revision
) ON dasher.audit_events TO dasher_security_definer;
