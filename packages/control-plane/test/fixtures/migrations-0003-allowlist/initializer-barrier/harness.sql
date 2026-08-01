-- NONCANONICAL Task 8A executable advisory-gate harness.
CREATE SCHEMA task8a_retention_barrier AUTHORIZATION CURRENT_USER;

CREATE TABLE task8a_retention_barrier.authority_revisions (
  binding_subject name NOT NULL,
  principal_revision bigint NOT NULL CHECK (principal_revision >= 1),
  enabled boolean NOT NULL,
  PRIMARY KEY (binding_subject, principal_revision)
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
  v_revision bigint;
  v_enabled boolean;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  IF COALESCE(pg_catalog.current_setting('task8a.bound_revision', true), '') <> '' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;

  -- Harmless pre-gate query; no authority relation is read here.
  PERFORM 1;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );

  SELECT authority.principal_revision, authority.enabled
  INTO v_revision, v_enabled
  FROM task8a_retention_barrier.authority_revisions AS authority
  WHERE authority.binding_subject = p_subject
  ORDER BY authority.principal_revision DESC
  LIMIT 1;

  IF v_revision IS NULL OR NOT v_enabled THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
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
  v_bound bigint;
  v_latest bigint;
  v_enabled boolean;
BEGIN
  v_bound := pg_catalog.current_setting(
    'task8a.bound_revision',
    true
  )::bigint;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(p_subject)
  );
  SELECT authority.principal_revision, authority.enabled
  INTO v_latest, v_enabled
  FROM task8a_retention_barrier.authority_revisions AS authority
  WHERE authority.binding_subject = p_subject
  ORDER BY authority.principal_revision DESC
  LIMIT 1;
  IF v_bound IS DISTINCT FROM v_latest OR NOT COALESCE(v_enabled, false) THEN
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
  INSERT INTO task8a_retention_barrier.authority_revisions (
    binding_subject,
    principal_revision,
    enabled
  ) VALUES (p_subject, p_revision, p_enabled);
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
