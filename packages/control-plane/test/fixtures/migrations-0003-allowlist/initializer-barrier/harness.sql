-- NONCANONICAL Task 8A executable advisory-gate harness.
CREATE SCHEMA task8a_retention_barrier AUTHORIZATION CURRENT_USER;

CREATE TABLE task8a_retention_barrier.authority_revisions (
  binding_subject name NOT NULL,
  retention_service_principal_id uuid NOT NULL,
  principal_revision bigint NOT NULL CHECK (principal_revision >= 1),
  enabled boolean NOT NULL
);

CREATE FUNCTION task8a_retention_barrier.binding_gate(p_subject name)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.hashtextextended(
    'dasher:retention-principal-binding:v1:'::text || p_subject::text,
    0
  )
$function$;

CREATE FUNCTION task8a_retention_barrier.initialize(p_subject name)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_principal_id uuid;
  v_revision bigint;
  v_enabled boolean;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  IF COALESCE(
      pg_catalog.current_setting('task8a.bound_principal_id', true),
      ''
    ) <> ''
    OR COALESCE(
      pg_catalog.current_setting('task8a.bound_revision', true),
      ''
    ) <> ''
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;

  -- Harmless pre-gate query; no authority relation is read here.
  PERFORM 1;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );

  WITH exact_binding AS MATERIALIZED (
    SELECT authority.retention_service_principal_id,
      authority.principal_revision, authority.enabled
    FROM task8a_retention_barrier.authority_revisions AS authority
    WHERE authority.binding_subject = p_subject
  ),
  binding_proof AS (
    SELECT count(DISTINCT retention_service_principal_id)
        AS distinct_principal_count,
      max(principal_revision) AS max_principal_revision
    FROM exact_binding
  ),
  unique_latest AS (
    SELECT authority.*
    FROM exact_binding AS authority
    CROSS JOIN binding_proof AS proof
    WHERE proof.distinct_principal_count = 1
      AND authority.principal_revision = proof.max_principal_revision
      AND (
        SELECT count(*)
        FROM exact_binding AS latest
        WHERE latest.principal_revision = proof.max_principal_revision
      ) = 1
  )
  SELECT retention_service_principal_id, principal_revision, enabled
  INTO v_principal_id, v_revision, v_enabled
  FROM unique_latest;

  IF NOT FOUND OR NOT v_enabled THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM pg_catalog.set_config(
    'task8a.bound_principal_id',
    v_principal_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'task8a.bound_revision',
    v_revision::text,
    true
  );
  RETURN v_revision;
END
$function$;

CREATE FUNCTION task8a_retention_barrier.revalidate(p_subject name)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_bound_principal_id uuid;
  v_bound bigint;
  v_latest_principal_id uuid;
  v_latest bigint;
  v_enabled boolean;
BEGIN
  v_bound_principal_id := pg_catalog.current_setting(
    'task8a.bound_principal_id',
    true
  )::uuid;
  v_bound := pg_catalog.current_setting(
    'task8a.bound_revision',
    true
  )::bigint;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );
  WITH exact_binding AS MATERIALIZED (
    SELECT authority.retention_service_principal_id,
      authority.principal_revision, authority.enabled
    FROM task8a_retention_barrier.authority_revisions AS authority
    WHERE authority.binding_subject = p_subject
  ),
  binding_proof AS (
    SELECT count(DISTINCT retention_service_principal_id)
        AS distinct_principal_count,
      max(principal_revision) AS max_principal_revision
    FROM exact_binding
  ),
  unique_latest AS (
    SELECT authority.*
    FROM exact_binding AS authority
    CROSS JOIN binding_proof AS proof
    WHERE proof.distinct_principal_count = 1
      AND authority.principal_revision = proof.max_principal_revision
      AND (
        SELECT count(*)
        FROM exact_binding AS latest
        WHERE latest.principal_revision = proof.max_principal_revision
      ) = 1
  )
  SELECT retention_service_principal_id, principal_revision, enabled
  INTO v_latest_principal_id, v_latest, v_enabled
  FROM unique_latest;
  IF NOT FOUND OR v_bound_principal_id IS DISTINCT FROM v_latest_principal_id
    OR v_bound IS DISTINCT FROM v_latest OR NOT v_enabled
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  RETURN v_bound;
END
$function$;

CREATE FUNCTION task8a_retention_barrier.append_revision(
  p_subject name,
  p_revision bigint,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );
  IF EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.authority_revisions AS authority
    WHERE authority.binding_subject = p_subject
      AND (
        authority.retention_service_principal_id <>
          '80000000-0000-4000-8000-000000000001'::uuid
        OR authority.principal_revision = p_revision
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  INSERT INTO task8a_retention_barrier.authority_revisions (
    binding_subject,
    retention_service_principal_id,
    principal_revision,
    enabled
  ) VALUES (
    p_subject,
    '80000000-0000-4000-8000-000000000001'::uuid,
    p_revision,
    p_enabled
  );
END
$function$;

CREATE FUNCTION task8a_retention_barrier.insert_adversarial_revision(
  p_subject name,
  p_principal_id uuid,
  p_revision bigint,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );
  INSERT INTO task8a_retention_barrier.authority_revisions (
    binding_subject,
    retention_service_principal_id,
    principal_revision,
    enabled
  ) VALUES (p_subject, p_principal_id, p_revision, p_enabled);
END
$function$;

CREATE FUNCTION task8a_retention_barrier.cleanup_subject(p_subject name)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );
  DELETE FROM task8a_retention_barrier.authority_revisions
  WHERE binding_subject = p_subject;
END
$function$;
