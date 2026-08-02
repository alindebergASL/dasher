-- NONCANONICAL Task 8A executable self-binding advisory-gate harness.
-- The disposable PostgreSQL test creates exact security and retention
-- NOLOGIN definer identities before loading this file.  The security identity
-- intentionally has BYPASSRLS, matching the predecessor exception whose
-- fixed functions must enforce authority inside every function body.
CREATE SCHEMA task8a_retention_barrier AUTHORIZATION CURRENT_USER;

-- Row-lock privilege harness.  Each exact unassumable definer receives
-- relation SELECT plus UPDATE on only one immutable tenant/key column.
CREATE TABLE task8a_retention_barrier.security_lock_target (
  organization_id uuid PRIMARY KEY,
  payload text NOT NULL
);

CREATE TABLE task8a_retention_barrier.retention_lock_target (
  organization_id uuid PRIMARY KEY,
  payload text NOT NULL
);

INSERT INTO task8a_retention_barrier.security_lock_target
  (organization_id, payload)
VALUES ('81000000-0000-4000-8000-000000000001'::uuid, 'security');
INSERT INTO task8a_retention_barrier.retention_lock_target
  (organization_id, payload)
VALUES ('82000000-0000-4000-8000-000000000001'::uuid, 'retention');

GRANT USAGE ON SCHEMA task8a_retention_barrier
  TO task8a_security_harness_definer, task8a_retention_harness_definer;
GRANT SELECT ON task8a_retention_barrier.security_lock_target
  TO task8a_security_harness_definer;
GRANT UPDATE (organization_id)
  ON task8a_retention_barrier.security_lock_target
  TO task8a_security_harness_definer;
GRANT SELECT ON task8a_retention_barrier.retention_lock_target
  TO task8a_retention_harness_definer;
GRANT UPDATE (organization_id)
  ON task8a_retention_barrier.retention_lock_target
  TO task8a_retention_harness_definer;

ALTER TABLE task8a_retention_barrier.security_lock_target
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.security_lock_target
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.retention_lock_target
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.retention_lock_target
  FORCE ROW LEVEL SECURITY;

CREATE POLICY security_lock_target_security_select
ON task8a_retention_barrier.security_lock_target
FOR SELECT TO task8a_security_harness_definer
USING (
  CURRENT_USER = 'task8a_security_harness_definer'::name
  AND organization_id = '81000000-0000-4000-8000-000000000001'::uuid
);
CREATE POLICY security_lock_target_security_update
ON task8a_retention_barrier.security_lock_target
FOR UPDATE TO task8a_security_harness_definer
USING (
  CURRENT_USER = 'task8a_security_harness_definer'::name
  AND organization_id = '81000000-0000-4000-8000-000000000001'::uuid
)
WITH CHECK (
  CURRENT_USER = 'task8a_security_harness_definer'::name
  AND organization_id = '81000000-0000-4000-8000-000000000001'::uuid
);
CREATE POLICY retention_lock_target_retention_select
ON task8a_retention_barrier.retention_lock_target
FOR SELECT TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND organization_id = '82000000-0000-4000-8000-000000000001'::uuid
);
CREATE POLICY retention_lock_target_retention_update
ON task8a_retention_barrier.retention_lock_target
FOR UPDATE TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND organization_id = '82000000-0000-4000-8000-000000000001'::uuid
)
WITH CHECK (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND organization_id = '82000000-0000-4000-8000-000000000001'::uuid
);

CREATE FUNCTION task8a_retention_barrier.exercise_security_lock_modes()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.security_lock_target
  WHERE organization_id = '81000000-0000-4000-8000-000000000001'::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.security_lock_target
  WHERE organization_id = '81000000-0000-4000-8000-000000000001'::uuid
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.security_lock_target
  WHERE organization_id = '81000000-0000-4000-8000-000000000001'::uuid
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.security_lock_target
  WHERE organization_id = '81000000-0000-4000-8000-000000000001'::uuid
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.exercise_security_lock_modes()
  OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.exercise_security_lock_modes()
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.exercise_retention_lock_modes()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_retention_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.retention_lock_target
  WHERE organization_id = '82000000-0000-4000-8000-000000000001'::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.retention_lock_target
  WHERE organization_id = '82000000-0000-4000-8000-000000000001'::uuid
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.retention_lock_target
  WHERE organization_id = '82000000-0000-4000-8000-000000000001'::uuid
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.retention_lock_target
  WHERE organization_id = '82000000-0000-4000-8000-000000000001'::uuid
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.exercise_retention_lock_modes()
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.exercise_retention_lock_modes()
  FROM PUBLIC;

CREATE TABLE task8a_retention_barrier.authority_revisions (
  binding_subject name NOT NULL,
  retention_service_principal_id uuid NOT NULL,
  principal_revision bigint NOT NULL CHECK (principal_revision >= 1),
  enabled boolean NOT NULL
);

ALTER TABLE task8a_retention_barrier.authority_revisions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.authority_revisions
  FORCE ROW LEVEL SECURITY;

CREATE FUNCTION task8a_retention_barrier.binding_gate(p_subject name)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.hashtextextended(
    'dasher:retention-principal-binding:v1|postgres_session_user|'::text ||
      p_subject::text,
    0
  )
$function$;

REVOKE ALL ON FUNCTION task8a_retention_barrier.binding_gate(name) FROM PUBLIC;
GRANT USAGE ON SCHEMA task8a_retention_barrier
  TO task8a_retention_harness_definer;
GRANT SELECT ON task8a_retention_barrier.authority_revisions
  TO task8a_retention_harness_definer;
GRANT EXECUTE ON FUNCTION task8a_retention_barrier.binding_gate(name)
  TO task8a_retention_harness_definer;

CREATE POLICY authority_revisions_self_binding_select
ON task8a_retention_barrier.authority_revisions
FOR SELECT
TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND binding_subject = SESSION_USER
);

-- Exact duplicate-dashboard target model. Dashboard UUID is deliberately
-- reused across two organizations, and every target relation forces RLS.
CREATE TABLE task8a_retention_barrier.target_lifecycle_policies (
  organization_id uuid NOT NULL,
  policy_revision bigint NOT NULL,
  PRIMARY KEY (organization_id, policy_revision)
);

CREATE TABLE task8a_retention_barrier.target_dashboards (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  retention_action_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, dashboard_id)
);

CREATE TABLE task8a_retention_barrier.target_events (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, event_id)
);

CREATE TABLE task8a_retention_barrier.target_audits (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  PRIMARY KEY (organization_id, audit_id)
);

INSERT INTO task8a_retention_barrier.target_lifecycle_policies (
  organization_id, policy_revision
) VALUES
  ('83000000-0000-4000-8000-000000000001'::uuid, 1),
  ('83000000-0000-4000-8000-000000000002'::uuid, 1);
INSERT INTO task8a_retention_barrier.target_dashboards (
  organization_id, dashboard_id
) VALUES
  (
    '83000000-0000-4000-8000-000000000001'::uuid,
    '83000000-0000-4000-8000-000000000010'::uuid
  ),
  (
    '83000000-0000-4000-8000-000000000002'::uuid,
    '83000000-0000-4000-8000-000000000010'::uuid
  );

ALTER TABLE task8a_retention_barrier.target_lifecycle_policies
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_lifecycle_policies
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_dashboards
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_dashboards
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_events
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_audits
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.target_audits
  FORCE ROW LEVEL SECURITY;

GRANT SELECT ON task8a_retention_barrier.target_lifecycle_policies
  TO task8a_retention_harness_definer;
GRANT UPDATE (organization_id)
  ON task8a_retention_barrier.target_lifecycle_policies
  TO task8a_retention_harness_definer;
GRANT SELECT ON task8a_retention_barrier.target_dashboards
  TO task8a_retention_harness_definer;
GRANT UPDATE (organization_id, retention_action_count)
  ON task8a_retention_barrier.target_dashboards
  TO task8a_retention_harness_definer;
GRANT INSERT ON task8a_retention_barrier.target_events
  TO task8a_retention_harness_definer;
GRANT INSERT ON task8a_retention_barrier.target_audits
  TO task8a_retention_harness_definer;
GRANT SELECT ON task8a_retention_barrier.target_lifecycle_policies,
  task8a_retention_barrier.target_dashboards
  TO task8a_security_harness_definer;
GRANT UPDATE (organization_id)
  ON task8a_retention_barrier.target_lifecycle_policies
  TO task8a_security_harness_definer;
GRANT UPDATE (organization_id)
  ON task8a_retention_barrier.target_dashboards
  TO task8a_security_harness_definer;

CREATE POLICY target_dashboards_retention_discovery_select
ON task8a_retention_barrier.target_dashboards
FOR SELECT TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) =
    'target_discovery'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
  AND dashboard_id = pg_catalog.current_setting(
    'task8a.target_dashboard_id', true
  )::uuid
  AND EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.authority_revisions AS authority
    WHERE authority.binding_subject = SESSION_USER
      AND authority.retention_service_principal_id =
        pg_catalog.current_setting(
          'task8a.bound_principal_id', true
        )::uuid
      AND authority.principal_revision = pg_catalog.current_setting(
        'task8a.bound_revision', true
      )::bigint
      AND authority.enabled
      AND NOT EXISTS (
        SELECT 1
        FROM task8a_retention_barrier.authority_revisions AS later
        WHERE later.binding_subject = authority.binding_subject
          AND later.principal_revision > authority.principal_revision
      )
  )
);

CREATE POLICY target_lifecycle_policies_retention_select
ON task8a_retention_barrier.target_lifecycle_policies
FOR SELECT TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
);
CREATE POLICY target_lifecycle_policies_retention_update
ON task8a_retention_barrier.target_lifecycle_policies
FOR UPDATE TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
)
WITH CHECK (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
);
CREATE POLICY target_dashboards_retention_authorized_select
ON task8a_retention_barrier.target_dashboards
FOR SELECT TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
  AND dashboard_id = pg_catalog.current_setting(
    'task8a.target_dashboard_id', true
  )::uuid
);
CREATE POLICY target_dashboards_retention_update
ON task8a_retention_barrier.target_dashboards
FOR UPDATE TO task8a_retention_harness_definer
USING (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
  AND dashboard_id = pg_catalog.current_setting(
    'task8a.target_dashboard_id', true
  )::uuid
)
WITH CHECK (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
  AND dashboard_id = pg_catalog.current_setting(
    'task8a.target_dashboard_id', true
  )::uuid
);
CREATE POLICY target_events_retention_insert
ON task8a_retention_barrier.target_events
FOR INSERT TO task8a_retention_harness_definer
WITH CHECK (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
  AND dashboard_id = pg_catalog.current_setting(
    'task8a.target_dashboard_id', true
  )::uuid
);
CREATE POLICY target_audits_retention_insert
ON task8a_retention_barrier.target_audits
FOR INSERT TO task8a_retention_harness_definer
WITH CHECK (
  CURRENT_USER = 'task8a_retention_harness_definer'::name
  AND pg_catalog.current_setting('task8a.binding_phase', true) = 'authorized'
  AND organization_id = pg_catalog.current_setting(
    'task8a.target_organization_id', true
  )::uuid
  AND dashboard_id = pg_catalog.current_setting(
    'task8a.target_dashboard_id', true
  )::uuid
);

CREATE FUNCTION task8a_retention_barrier.initialize(
  p_organization_id uuid,
  p_dashboard_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_subject name := session_user;
  v_principal_id uuid;
  v_revision bigint;
  v_enabled boolean;
  v_target_organization_id uuid;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  IF COALESCE(
      pg_catalog.current_setting('task8a.binding_phase', true),
      ''
    ) <> ''
    OR COALESCE(
      pg_catalog.current_setting('task8a.bound_subject', true),
      ''
    ) <> ''
    OR COALESCE(
      pg_catalog.current_setting('task8a.bound_principal_id', true),
      ''
    ) <> ''
    OR COALESCE(
      pg_catalog.current_setting('task8a.bound_revision', true),
      ''
    ) <> ''
    OR COALESCE(
      pg_catalog.current_setting('task8a.target_organization_id', true),
      ''
    ) <> ''
    OR COALESCE(
      pg_catalog.current_setting('task8a.target_dashboard_id', true),
      ''
    ) <> ''
    OR p_organization_id IS NULL
    OR p_dashboard_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;

  -- Harmless pre-gate query; no authority relation or context is touched.
  PERFORM 1;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(v_subject)
  );

  -- A distinct post-gate SELECT is visible only through the exact definer and
  -- binding_subject = session_user forced-RLS policy above.
  WITH exact_binding AS MATERIALIZED (
    SELECT authority.retention_service_principal_id,
      authority.principal_revision, authority.enabled
    FROM task8a_retention_barrier.authority_revisions AS authority
    WHERE authority.binding_subject = session_user
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
  PERFORM pg_catalog.set_config('task8a.bound_subject', v_subject::text, true);
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
  PERFORM pg_catalog.set_config(
    'task8a.target_organization_id', p_organization_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'task8a.target_dashboard_id', p_dashboard_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'task8a.binding_phase', 'target_discovery', true
  );
  SELECT dashboard.organization_id INTO v_target_organization_id
  FROM task8a_retention_barrier.target_dashboards AS dashboard
  WHERE dashboard.organization_id = p_organization_id
    AND dashboard.dashboard_id = p_dashboard_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'dasher:organization:v1|' || v_target_organization_id::text,
    0
  ));
  PERFORM pg_catalog.set_config(
    'task8a.binding_phase', 'authorized', true
  );
  PERFORM 1
  FROM task8a_retention_barrier.authority_revisions AS authority
  WHERE authority.binding_subject = session_user
    AND authority.retention_service_principal_id = v_principal_id
    AND authority.principal_revision = v_revision
    AND authority.enabled
    AND NOT EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.authority_revisions AS later
      WHERE later.binding_subject = authority.binding_subject
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.initialize(uuid, uuid)
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.initialize(uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.revalidate()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_subject name := session_user;
  v_bound_subject name;
  v_bound_principal_id uuid;
  v_bound bigint;
  v_latest_principal_id uuid;
  v_latest bigint;
  v_enabled boolean;
BEGIN
  IF pg_catalog.current_setting('task8a.binding_phase', true) <> 'authorized'
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  v_bound_subject := pg_catalog.current_setting(
    'task8a.bound_subject',
    true
  )::name;
  v_bound_principal_id := pg_catalog.current_setting(
    'task8a.bound_principal_id',
    true
  )::uuid;
  v_bound := pg_catalog.current_setting(
    'task8a.bound_revision',
    true
  )::bigint;
  IF v_bound_subject IS DISTINCT FROM v_subject THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    task8a_retention_barrier.binding_gate(v_subject)
  );
  WITH exact_binding AS MATERIALIZED (
    SELECT authority.retention_service_principal_id,
      authority.principal_revision, authority.enabled
    FROM task8a_retention_barrier.authority_revisions AS authority
    WHERE authority.binding_subject = session_user
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
END
$function$;

ALTER FUNCTION task8a_retention_barrier.revalidate()
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.revalidate() FROM PUBLIC;

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

REVOKE ALL ON FUNCTION task8a_retention_barrier.append_revision(name, bigint, boolean)
  FROM PUBLIC;

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

REVOKE ALL ON FUNCTION task8a_retention_barrier.insert_adversarial_revision(name, uuid, bigint, boolean)
  FROM PUBLIC;

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

REVOKE ALL ON FUNCTION task8a_retention_barrier.cleanup_subject(name)
  FROM PUBLIC;

-- Noncanonical executable snapshot/finalizer race model.  The model uses one
-- typed resource so the tests can exercise both winner orders without
-- pretending that the modeled 0003 successor is a canonical migration.
CREATE TABLE task8a_retention_barrier.snapshot_resources (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  snapshot_bytes text NOT NULL,
  PRIMARY KEY (organization_id, snapshot_id)
);

CREATE TABLE task8a_retention_barrier.snapshot_finalizers (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('intent', 'eligible', 'deleted')),
  PRIMARY KEY (organization_id, snapshot_id)
);

CREATE TABLE task8a_retention_barrier.snapshot_claims (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  PRIMARY KEY (organization_id, snapshot_id, dashboard_id),
  FOREIGN KEY (organization_id, snapshot_id)
    REFERENCES task8a_retention_barrier.snapshot_resources (
      organization_id, snapshot_id
    )
);

CREATE TABLE task8a_retention_barrier.evidence_attachments (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  PRIMARY KEY (organization_id, evidence_id),
  FOREIGN KEY (organization_id, snapshot_id)
    REFERENCES task8a_retention_barrier.snapshot_resources (
      organization_id, snapshot_id
    )
);

CREATE TABLE task8a_retention_barrier.evidence_finalizers (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('intent', 'eligible', 'deleted')),
  PRIMARY KEY (organization_id, evidence_id)
);

ALTER TABLE task8a_retention_barrier.snapshot_resources
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.snapshot_resources
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.snapshot_finalizers
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.snapshot_finalizers
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.snapshot_claims
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.snapshot_claims
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.evidence_attachments
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.evidence_attachments
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.evidence_finalizers
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.evidence_finalizers
  FORCE ROW LEVEL SECURITY;

CREATE POLICY snapshot_resources_security_select
ON task8a_retention_barrier.snapshot_resources
FOR SELECT TO task8a_security_harness_definer
USING (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY snapshot_resources_security_update
ON task8a_retention_barrier.snapshot_resources
FOR UPDATE TO task8a_security_harness_definer
USING (CURRENT_USER = 'task8a_security_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY snapshot_resources_retention_select
ON task8a_retention_barrier.snapshot_resources
FOR SELECT TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_resources_retention_update
ON task8a_retention_barrier.snapshot_resources
FOR UPDATE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_resources_retention_delete
ON task8a_retention_barrier.snapshot_resources
FOR DELETE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);

CREATE POLICY snapshot_finalizers_security_select
ON task8a_retention_barrier.snapshot_finalizers
FOR SELECT TO task8a_security_harness_definer
USING (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY snapshot_finalizers_retention_select
ON task8a_retention_barrier.snapshot_finalizers
FOR SELECT TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_finalizers_retention_insert
ON task8a_retention_barrier.snapshot_finalizers
FOR INSERT TO task8a_retention_harness_definer
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_finalizers_retention_update
ON task8a_retention_barrier.snapshot_finalizers
FOR UPDATE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);

CREATE POLICY snapshot_claims_security_insert
ON task8a_retention_barrier.snapshot_claims
FOR INSERT TO task8a_security_harness_definer
WITH CHECK (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY snapshot_claims_retention_select
ON task8a_retention_barrier.snapshot_claims
FOR SELECT TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_claims_retention_update
ON task8a_retention_barrier.snapshot_claims
FOR UPDATE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_claims_retention_delete
ON task8a_retention_barrier.snapshot_claims
FOR DELETE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);

CREATE POLICY evidence_attachments_security_insert
ON task8a_retention_barrier.evidence_attachments
FOR INSERT TO task8a_security_harness_definer
WITH CHECK (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY evidence_attachments_retention_select
ON task8a_retention_barrier.evidence_attachments
FOR SELECT TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY evidence_attachments_retention_update
ON task8a_retention_barrier.evidence_attachments
FOR UPDATE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY evidence_attachments_retention_delete
ON task8a_retention_barrier.evidence_attachments
FOR DELETE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);

CREATE POLICY evidence_finalizers_security_select
ON task8a_retention_barrier.evidence_finalizers
FOR SELECT TO task8a_security_harness_definer
USING (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY evidence_finalizers_retention_select
ON task8a_retention_barrier.evidence_finalizers
FOR SELECT TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY evidence_finalizers_retention_insert
ON task8a_retention_barrier.evidence_finalizers
FOR INSERT TO task8a_retention_harness_definer
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY evidence_finalizers_retention_update
ON task8a_retention_barrier.evidence_finalizers
FOR UPDATE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);

GRANT SELECT ON task8a_retention_barrier.snapshot_resources
  TO task8a_security_harness_definer, task8a_retention_harness_definer;
GRANT UPDATE (organization_id)
  ON task8a_retention_barrier.snapshot_resources
  TO task8a_security_harness_definer, task8a_retention_harness_definer;
GRANT DELETE ON task8a_retention_barrier.snapshot_resources
  TO task8a_retention_harness_definer;
GRANT SELECT ON task8a_retention_barrier.snapshot_finalizers
  TO task8a_security_harness_definer, task8a_retention_harness_definer;
GRANT INSERT, UPDATE (state)
  ON task8a_retention_barrier.snapshot_finalizers
  TO task8a_retention_harness_definer;
GRANT INSERT ON task8a_retention_barrier.snapshot_claims
  TO task8a_security_harness_definer;
GRANT SELECT, UPDATE (organization_id), DELETE
  ON task8a_retention_barrier.snapshot_claims
  TO task8a_retention_harness_definer;
GRANT INSERT ON task8a_retention_barrier.evidence_attachments
  TO task8a_security_harness_definer;
GRANT SELECT, UPDATE (organization_id), DELETE
  ON task8a_retention_barrier.evidence_attachments
  TO task8a_retention_harness_definer;
GRANT SELECT ON task8a_retention_barrier.evidence_finalizers
  TO task8a_security_harness_definer, task8a_retention_harness_definer;
GRANT INSERT, UPDATE (state)
  ON task8a_retention_barrier.evidence_finalizers
  TO task8a_retention_harness_definer;

CREATE FUNCTION task8a_retention_barrier.admit_version_reference(
  p_organization_id uuid,
  p_snapshot_id uuid,
  p_dashboard_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1
  FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND snapshot.snapshot_id = p_snapshot_id
  FOR SHARE OF snapshot;
  IF NOT FOUND OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.snapshot_id = p_snapshot_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  INSERT INTO task8a_retention_barrier.snapshot_claims (
    organization_id, snapshot_id, dashboard_id
  ) VALUES (p_organization_id, p_snapshot_id, p_dashboard_id);
END
$function$;

ALTER FUNCTION task8a_retention_barrier.admit_version_reference(uuid, uuid, uuid)
  OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.admit_version_reference(uuid, uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.admit_evidence_reference(
  p_organization_id uuid,
  p_snapshot_id uuid,
  p_evidence_id uuid,
  p_dashboard_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1
  FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND snapshot.snapshot_id = p_snapshot_id
  FOR SHARE OF snapshot;
  IF NOT FOUND OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.snapshot_id = p_snapshot_id
  ) OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.evidence_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.evidence_id = p_evidence_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  INSERT INTO task8a_retention_barrier.evidence_attachments (
    organization_id, evidence_id, snapshot_id, dashboard_id
  ) VALUES (
    p_organization_id, p_evidence_id, p_snapshot_id, p_dashboard_id
  );
  INSERT INTO task8a_retention_barrier.snapshot_claims (
    organization_id, snapshot_id, dashboard_id
  ) VALUES (p_organization_id, p_snapshot_id, p_dashboard_id);
END
$function$;

ALTER FUNCTION task8a_retention_barrier.admit_evidence_reference(
  uuid, uuid, uuid, uuid
) OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.admit_evidence_reference(uuid, uuid, uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.admit_restore_reference(
  p_organization_id uuid,
  p_snapshot_id uuid,
  p_dashboard_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1
  FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND snapshot.snapshot_id = p_snapshot_id
  FOR SHARE OF snapshot;
  IF NOT FOUND OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.snapshot_id = p_snapshot_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  INSERT INTO task8a_retention_barrier.snapshot_claims (
    organization_id, snapshot_id, dashboard_id
  ) VALUES (p_organization_id, p_snapshot_id, p_dashboard_id);
END
$function$;

ALTER FUNCTION task8a_retention_barrier.admit_restore_reference(uuid, uuid, uuid)
  OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.admit_restore_reference(uuid, uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.create_snapshot_intent(
  p_organization_id uuid,
  p_snapshot_id uuid,
  p_source_dashboard_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_retention_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM 1
  FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND snapshot.snapshot_id = p_snapshot_id
  FOR UPDATE OF snapshot;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1
  FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
  WHERE finalizer.organization_id = p_organization_id
    AND finalizer.snapshot_id = p_snapshot_id
  ORDER BY finalizer.snapshot_id
  FOR UPDATE OF finalizer;
  PERFORM 1
  FROM task8a_retention_barrier.snapshot_claims AS claim
  WHERE claim.organization_id = p_organization_id
    AND claim.snapshot_id = p_snapshot_id
  ORDER BY claim.dashboard_id
  FOR UPDATE OF claim;
  PERFORM 1
  FROM task8a_retention_barrier.evidence_attachments AS evidence
  WHERE evidence.organization_id = p_organization_id
    AND evidence.snapshot_id = p_snapshot_id
  ORDER BY evidence.evidence_id
  FOR UPDATE OF evidence;
  PERFORM 1
  FROM task8a_retention_barrier.evidence_finalizers AS finalizer
  JOIN task8a_retention_barrier.evidence_attachments AS evidence
    ON evidence.organization_id = finalizer.organization_id
   AND evidence.evidence_id = finalizer.evidence_id
  WHERE evidence.organization_id = p_organization_id
    AND evidence.snapshot_id = p_snapshot_id
  ORDER BY finalizer.evidence_id
  FOR UPDATE OF finalizer;
  IF EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.snapshot_id = p_snapshot_id
  ) OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.snapshot_claims AS claim
    WHERE claim.organization_id = p_organization_id
      AND claim.snapshot_id = p_snapshot_id
      AND claim.dashboard_id <> p_source_dashboard_id
  ) OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.evidence_attachments AS evidence
    WHERE evidence.organization_id = p_organization_id
      AND evidence.snapshot_id = p_snapshot_id
      AND evidence.dashboard_id <> p_source_dashboard_id
  ) OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.evidence_finalizers AS finalizer
    JOIN task8a_retention_barrier.evidence_attachments AS evidence
      ON evidence.organization_id = finalizer.organization_id
     AND evidence.evidence_id = finalizer.evidence_id
    WHERE evidence.organization_id = p_organization_id
      AND evidence.snapshot_id = p_snapshot_id
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO task8a_retention_barrier.evidence_finalizers (
    organization_id, evidence_id, state
  )
  SELECT evidence.organization_id, evidence.evidence_id, 'intent'
  FROM task8a_retention_barrier.evidence_attachments AS evidence
  WHERE evidence.organization_id = p_organization_id
    AND evidence.snapshot_id = p_snapshot_id
    AND evidence.dashboard_id = p_source_dashboard_id
  ORDER BY evidence.evidence_id;
  INSERT INTO task8a_retention_barrier.snapshot_finalizers (
    organization_id, snapshot_id, state
  ) VALUES (p_organization_id, p_snapshot_id, 'intent');
  RETURN true;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.create_snapshot_intent(uuid, uuid, uuid)
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.create_snapshot_intent(uuid, uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.finalize_evidence(
  p_organization_id uuid,
  p_evidence_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_expected_count integer;
  v_deleted_count integer;
BEGIN
  IF CURRENT_USER <> 'task8a_retention_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  UPDATE task8a_retention_barrier.evidence_finalizers AS finalizer
  SET state = 'deleted'
  WHERE finalizer.organization_id = p_organization_id
    AND finalizer.evidence_id = p_evidence_id
    AND finalizer.state = 'eligible';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO v_expected_count
  FROM task8a_retention_barrier.evidence_attachments AS evidence
  WHERE evidence.organization_id = p_organization_id
    AND evidence.evidence_id = p_evidence_id;
  DELETE FROM task8a_retention_barrier.evidence_attachments AS evidence
  WHERE evidence.organization_id = p_organization_id
    AND evidence.evidence_id = p_evidence_id
    AND EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.evidence_finalizers AS finalizer
      WHERE finalizer.organization_id = evidence.organization_id
        AND finalizer.evidence_id = evidence.evidence_id
        AND finalizer.state = 'deleted'
    );
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  IF v_deleted_count <> v_expected_count OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.evidence_attachments AS evidence
    WHERE evidence.organization_id = p_organization_id
      AND evidence.evidence_id = p_evidence_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_conflict';
  END IF;
  RETURN true;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.finalize_evidence(uuid, uuid)
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.finalize_evidence(uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.finalize_snapshot(
  p_organization_id uuid,
  p_snapshot_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_expected_count integer;
  v_deleted_count integer;
BEGIN
  IF CURRENT_USER <> 'task8a_retention_harness_definer'::name THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  UPDATE task8a_retention_barrier.snapshot_finalizers AS finalizer
  SET state = 'deleted'
  WHERE finalizer.organization_id = p_organization_id
    AND finalizer.snapshot_id = p_snapshot_id
    AND finalizer.state = 'eligible'
    AND NOT EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.evidence_attachments AS evidence
      WHERE evidence.organization_id = finalizer.organization_id
        AND evidence.snapshot_id = finalizer.snapshot_id
    );
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO v_expected_count
  FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND snapshot.snapshot_id = p_snapshot_id;
  DELETE FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND snapshot.snapshot_id = p_snapshot_id
    AND EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
      WHERE finalizer.organization_id = snapshot.organization_id
        AND finalizer.snapshot_id = snapshot.snapshot_id
        AND finalizer.state = 'deleted'
    );
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  IF v_deleted_count <> v_expected_count OR EXISTS (
    SELECT 1
    FROM task8a_retention_barrier.snapshot_resources AS snapshot
    WHERE snapshot.organization_id = p_organization_id
      AND snapshot.snapshot_id = p_snapshot_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_conflict';
  END IF;
  RETURN true;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.finalize_snapshot(uuid, uuid)
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.finalize_snapshot(uuid, uuid)
  FROM PUBLIC;

-- Noncanonical forced-RLS promotion-request authorization model.  The first
-- synthetic identity is the editor and the second is a viewer; authorization
-- is checked before the first tenant relation access and audit remains last.
CREATE TABLE task8a_retention_barrier.promotion_dashboards (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  lifecycle_state text NOT NULL,
  effective_expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, dashboard_id)
);

CREATE TABLE task8a_retention_barrier.promotion_requests (
  organization_id uuid NOT NULL,
  promotion_request_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  requested_by name NOT NULL,
  PRIMARY KEY (organization_id, promotion_request_id)
);

CREATE TABLE task8a_retention_barrier.promotion_audits (
  organization_id uuid NOT NULL,
  audit_event_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  actor name NOT NULL,
  PRIMARY KEY (organization_id, audit_event_id)
);

ALTER TABLE task8a_retention_barrier.promotion_dashboards
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.promotion_dashboards
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.promotion_requests
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.promotion_requests
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.promotion_audits
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.promotion_audits
  FORCE ROW LEVEL SECURITY;

CREATE POLICY promotion_dashboards_security_select
ON task8a_retention_barrier.promotion_dashboards
FOR SELECT TO task8a_security_harness_definer
USING (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY promotion_dashboards_security_update
ON task8a_retention_barrier.promotion_dashboards
FOR UPDATE TO task8a_security_harness_definer
USING (CURRENT_USER = 'task8a_security_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY promotion_requests_security_insert
ON task8a_retention_barrier.promotion_requests
FOR INSERT TO task8a_security_harness_definer
WITH CHECK (CURRENT_USER = 'task8a_security_harness_definer'::name);
CREATE POLICY promotion_audits_security_insert
ON task8a_retention_barrier.promotion_audits
FOR INSERT TO task8a_security_harness_definer
WITH CHECK (CURRENT_USER = 'task8a_security_harness_definer'::name);

GRANT SELECT, UPDATE (organization_id)
  ON task8a_retention_barrier.promotion_dashboards
  TO task8a_security_harness_definer;
GRANT INSERT ON task8a_retention_barrier.promotion_requests
  TO task8a_security_harness_definer;
GRANT INSERT ON task8a_retention_barrier.promotion_audits
  TO task8a_security_harness_definer;

CREATE FUNCTION task8a_retention_barrier.request_promotion(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_promotion_request_id uuid,
  p_audit_event_id uuid,
  p_lock_barrier bigint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name
    OR session_user <> 'task8a_synthetic_operator_a'::name
    OR p_organization_id IS NULL OR p_dashboard_id IS NULL
    OR p_promotion_request_id IS NULL OR p_audit_event_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  IF p_lock_barrier IS NOT NULL THEN
    PERFORM 1
    FROM task8a_retention_barrier.target_lifecycle_policies AS policy
    WHERE policy.organization_id = p_organization_id
    ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE OF policy;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(p_lock_barrier);
    PERFORM 1
    FROM task8a_retention_barrier.target_dashboards AS dashboard
    WHERE dashboard.organization_id = p_organization_id
      AND dashboard.dashboard_id = p_dashboard_id
    FOR UPDATE OF dashboard;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
    END IF;
  END IF;
  PERFORM 1 FROM task8a_retention_barrier.promotion_dashboards AS dashboard
  WHERE dashboard.organization_id = p_organization_id
    AND dashboard.dashboard_id = p_dashboard_id
    AND dashboard.lifecycle_state = 'active'
    AND statement_timestamp() < dashboard.effective_expires_at
  FOR UPDATE OF dashboard;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  INSERT INTO task8a_retention_barrier.promotion_requests (
    organization_id, promotion_request_id, dashboard_id, requested_by
  ) VALUES (
    p_organization_id, p_promotion_request_id, p_dashboard_id, session_user
  );
  INSERT INTO task8a_retention_barrier.promotion_audits (
    organization_id, audit_event_id, dashboard_id, actor
  ) VALUES (p_organization_id, p_audit_event_id, p_dashboard_id, session_user);
END
$function$;

ALTER FUNCTION task8a_retention_barrier.request_promotion(
  uuid, uuid, uuid, uuid, bigint
) OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.request_promotion(
  uuid, uuid, uuid, uuid, bigint
) FROM PUBLIC;

-- Noncanonical complete mutation-role model.  All relations force RLS, while
-- the fixed security definer intentionally bypasses it, so only the explicit
-- pre-relation role gate can prevent viewer/admin-boundary side effects.
CREATE TABLE task8a_retention_barrier.modeled_mutations (
  operation text NOT NULL,
  actor name NOT NULL,
  PRIMARY KEY (operation, actor)
);

CREATE TABLE task8a_retention_barrier.modeled_mutation_audits (
  operation text NOT NULL,
  actor name NOT NULL,
  PRIMARY KEY (operation, actor)
);

ALTER TABLE task8a_retention_barrier.modeled_mutations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.modeled_mutations
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.modeled_mutation_audits
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.modeled_mutation_audits
  FORCE ROW LEVEL SECURITY;

GRANT INSERT ON task8a_retention_barrier.modeled_mutations
  TO task8a_security_harness_definer;
GRANT INSERT ON task8a_retention_barrier.modeled_mutation_audits
  TO task8a_security_harness_definer;

CREATE FUNCTION task8a_retention_barrier.execute_modeled_mutation(
  p_operation text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actual_role text;
  v_minimum_role text;
BEGIN
  v_minimum_role := CASE p_operation
    WHEN 'create_dashboard' THEN 'editor'
    WHEN 'create_evidence_record' THEN 'editor'
    WHEN 'create_dashboard_version' THEN 'editor'
    WHEN 'compare_and_swap_dashboard_head' THEN 'editor'
    WHEN 'request_dashboard_promotion' THEN 'editor'
    WHEN 'decide_dashboard_promotion' THEN 'admin'
    WHEN 'set_dashboard_archive' THEN 'admin'
    WHEN 'delete_dashboard' THEN 'admin'
    WHEN 'restore_dashboard_as_new' THEN 'admin'
    ELSE NULL
  END;
  v_actual_role := CASE session_user
    WHEN 'task8a_synthetic_operator_a'::name THEN 'editor'
    WHEN 'task8a_synthetic_operator_b'::name THEN 'viewer'
    ELSE 'admin'
  END;

  -- This complete gate deliberately precedes the first tenant relation use.
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name
    OR v_minimum_role IS NULL
    OR (v_minimum_role = 'editor' AND v_actual_role NOT IN ('editor', 'admin'))
    OR (v_minimum_role = 'admin' AND v_actual_role <> 'admin')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;

  INSERT INTO task8a_retention_barrier.modeled_mutations (operation, actor)
  VALUES (p_operation, session_user);
  INSERT INTO task8a_retention_barrier.modeled_mutation_audits (
    operation, actor
  ) VALUES (p_operation, session_user);
END
$function$;

ALTER FUNCTION task8a_retention_barrier.execute_modeled_mutation(text)
  OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.execute_modeled_mutation(text)
  FROM PUBLIC;

-- Noncanonical READ COMMITTED projection model.  The advisory barrier is
-- after a deliberately redundant preliminary check.  Each final SELECT is
-- independently authoritative in the statement snapshot acquired only after
-- the test writer commits its revocation or exact-claim deletion.
CREATE TABLE task8a_retention_barrier.projection_dashboards (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  current_kind text NOT NULL CHECK (current_kind IN ('disposable', 'durable')),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
  effective_expires_at timestamptz,
  access_revoked_at timestamptz,
  purged_at timestamptz,
  current_head_version_id uuid NOT NULL,
  PRIMARY KEY (organization_id, dashboard_id)
);

CREATE TABLE task8a_retention_barrier.projection_versions (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  parent_version_id uuid,
  validation_state text NOT NULL,
  PRIMARY KEY (organization_id, dashboard_id, version_id)
);

CREATE TABLE task8a_retention_barrier.projection_snapshot_links (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  PRIMARY KEY (organization_id, dashboard_id, version_id, snapshot_id)
);

CREATE TABLE task8a_retention_barrier.projection_snapshot_claims (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  claim_kind text NOT NULL DEFAULT 'version',
  PRIMARY KEY (organization_id, dashboard_id, snapshot_id)
);

CREATE TABLE task8a_retention_barrier.projection_evidence_records (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  PRIMARY KEY (organization_id, evidence_id)
);

CREATE TABLE task8a_retention_barrier.projection_evidence_links (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  PRIMARY KEY (organization_id, dashboard_id, version_id, evidence_id)
);

CREATE TABLE task8a_retention_barrier.projection_evidence_claims (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  claim_kind text NOT NULL DEFAULT 'evidence',
  PRIMARY KEY (organization_id, dashboard_id, evidence_id)
);

ALTER TABLE task8a_retention_barrier.projection_dashboards
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_dashboards
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_versions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_versions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_snapshot_links
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_snapshot_links
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_snapshot_claims
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_snapshot_claims
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_evidence_records
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_evidence_records
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_evidence_links
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_evidence_links
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_evidence_claims
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.projection_evidence_claims
  FORCE ROW LEVEL SECURITY;

GRANT SELECT ON
  task8a_retention_barrier.projection_dashboards,
  task8a_retention_barrier.projection_versions,
  task8a_retention_barrier.projection_snapshot_links,
  task8a_retention_barrier.projection_snapshot_claims,
  task8a_retention_barrier.projection_evidence_records,
  task8a_retention_barrier.projection_evidence_links,
  task8a_retention_barrier.projection_evidence_claims
  TO task8a_security_harness_definer;

CREATE FUNCTION task8a_retention_barrier.read_evidence_projection(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_barrier bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_preliminary boolean;
  v_projection jsonb;
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name
    OR p_organization_id IS NULL OR p_dashboard_id IS NULL
    OR p_barrier IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM task8a_retention_barrier.projection_dashboards AS dashboard
    WHERE dashboard.organization_id = p_organization_id
      AND dashboard.dashboard_id = p_dashboard_id
  ) INTO v_preliminary;
  IF NOT v_preliminary THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(p_barrier);

  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'version_id', version.version_id,
    'evidence_id', evidence.evidence_id,
    'source_snapshot_id', evidence.source_snapshot_id
  ) ORDER BY version.version_id, evidence.evidence_id)
  INTO v_projection
  FROM task8a_retention_barrier.projection_dashboards AS dashboard
  JOIN task8a_retention_barrier.projection_versions AS version
    ON version.organization_id = dashboard.organization_id
    AND version.dashboard_id = dashboard.dashboard_id
    AND version.validation_state = 'validated'
  JOIN task8a_retention_barrier.projection_evidence_links AS evidence_link
    ON evidence_link.organization_id = dashboard.organization_id
    AND evidence_link.dashboard_id = dashboard.dashboard_id
    AND evidence_link.version_id = version.version_id
  JOIN task8a_retention_barrier.projection_evidence_records AS evidence
    ON evidence.organization_id = evidence_link.organization_id
    AND evidence.evidence_id = evidence_link.evidence_id
  JOIN task8a_retention_barrier.projection_evidence_claims AS evidence_claim
    ON evidence_claim.organization_id = evidence.organization_id
    AND evidence_claim.dashboard_id = dashboard.dashboard_id
    AND evidence_claim.evidence_id = evidence.evidence_id
    AND evidence_claim.claim_kind = 'evidence'
  JOIN task8a_retention_barrier.projection_snapshot_links AS source_link
    ON source_link.organization_id = dashboard.organization_id
    AND source_link.dashboard_id = dashboard.dashboard_id
    AND source_link.version_id = version.version_id
    AND source_link.snapshot_id = evidence.source_snapshot_id
  JOIN task8a_retention_barrier.projection_snapshot_claims AS source_claim
    ON source_claim.organization_id = source_link.organization_id
    AND source_claim.dashboard_id = dashboard.dashboard_id
    AND source_claim.snapshot_id = source_link.snapshot_id
    AND source_claim.claim_kind = 'version'
  WHERE dashboard.organization_id = p_organization_id
    AND dashboard.dashboard_id = p_dashboard_id
    AND dashboard.lifecycle_state IN ('active', 'archived')
    AND dashboard.access_revoked_at IS NULL
    AND dashboard.purged_at IS NULL
    AND (
      (dashboard.current_kind = 'disposable'
        AND dashboard.effective_expires_at IS NOT NULL
        AND statement_timestamp() < dashboard.effective_expires_at)
      OR (dashboard.current_kind = 'durable'
        AND dashboard.effective_expires_at IS NULL)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.projection_snapshot_links AS missing_link
      WHERE missing_link.organization_id = dashboard.organization_id
        AND missing_link.dashboard_id = dashboard.dashboard_id
        AND NOT EXISTS (
          SELECT 1
          FROM task8a_retention_barrier.projection_snapshot_claims AS exact_claim
          WHERE exact_claim.organization_id = missing_link.organization_id
            AND exact_claim.dashboard_id = dashboard.dashboard_id
            AND exact_claim.snapshot_id = missing_link.snapshot_id
            AND exact_claim.claim_kind = 'version'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.projection_evidence_links AS missing_link
      WHERE missing_link.organization_id = dashboard.organization_id
        AND missing_link.dashboard_id = dashboard.dashboard_id
        AND NOT EXISTS (
          SELECT 1
          FROM task8a_retention_barrier.projection_evidence_claims AS exact_claim
          WHERE exact_claim.organization_id = missing_link.organization_id
            AND exact_claim.dashboard_id = dashboard.dashboard_id
            AND exact_claim.evidence_id = missing_link.evidence_id
            AND exact_claim.claim_kind = 'evidence'
        )
    );
  IF v_projection IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  RETURN v_projection;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.read_evidence_projection(
  uuid, uuid, bigint
) OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.read_evidence_projection(
  uuid, uuid, bigint
) FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.read_lineage_projection(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_barrier bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_preliminary boolean;
  v_projection jsonb;
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name
    OR p_organization_id IS NULL OR p_dashboard_id IS NULL
    OR p_barrier IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM task8a_retention_barrier.projection_dashboards AS dashboard
    WHERE dashboard.organization_id = p_organization_id
      AND dashboard.dashboard_id = p_dashboard_id
  ) INTO v_preliminary;
  IF NOT v_preliminary THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(p_barrier);

  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'version_id', version.version_id,
    'parent_version_id', version.parent_version_id,
    'snapshot_id', snapshot_link.snapshot_id
  ) ORDER BY version.version_id, snapshot_link.snapshot_id)
  INTO v_projection
  FROM task8a_retention_barrier.projection_dashboards AS dashboard
  JOIN task8a_retention_barrier.projection_versions AS version
    ON version.organization_id = dashboard.organization_id
    AND version.dashboard_id = dashboard.dashboard_id
    AND version.validation_state = 'validated'
  JOIN task8a_retention_barrier.projection_snapshot_links AS snapshot_link
    ON snapshot_link.organization_id = version.organization_id
    AND snapshot_link.dashboard_id = dashboard.dashboard_id
    AND snapshot_link.version_id = version.version_id
  JOIN task8a_retention_barrier.projection_snapshot_claims AS snapshot_claim
    ON snapshot_claim.organization_id = snapshot_link.organization_id
    AND snapshot_claim.dashboard_id = dashboard.dashboard_id
    AND snapshot_claim.snapshot_id = snapshot_link.snapshot_id
    AND snapshot_claim.claim_kind = 'version'
  JOIN task8a_retention_barrier.projection_versions AS head_version
    ON head_version.organization_id = dashboard.organization_id
    AND head_version.dashboard_id = dashboard.dashboard_id
    AND head_version.version_id = dashboard.current_head_version_id
    AND head_version.validation_state = 'validated'
  WHERE dashboard.organization_id = p_organization_id
    AND dashboard.dashboard_id = p_dashboard_id
    AND dashboard.lifecycle_state IN ('active', 'archived')
    AND dashboard.access_revoked_at IS NULL
    AND dashboard.purged_at IS NULL
    AND (
      (dashboard.current_kind = 'disposable'
        AND dashboard.effective_expires_at IS NOT NULL
        AND statement_timestamp() < dashboard.effective_expires_at)
      OR (dashboard.current_kind = 'durable'
        AND dashboard.effective_expires_at IS NULL)
    )
    AND EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.projection_snapshot_links AS head_link
      JOIN task8a_retention_barrier.projection_snapshot_claims AS head_claim
        ON head_claim.organization_id = head_link.organization_id
        AND head_claim.dashboard_id = dashboard.dashboard_id
        AND head_claim.snapshot_id = head_link.snapshot_id
        AND head_claim.claim_kind = 'version'
      WHERE head_link.organization_id = dashboard.organization_id
        AND head_link.dashboard_id = dashboard.dashboard_id
        AND head_link.version_id = head_version.version_id
    )
    AND (
      version.parent_version_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM task8a_retention_barrier.projection_versions AS parent_version
        JOIN task8a_retention_barrier.projection_snapshot_links AS parent_link
          ON parent_link.organization_id = parent_version.organization_id
          AND parent_link.dashboard_id = dashboard.dashboard_id
          AND parent_link.version_id = parent_version.version_id
        JOIN task8a_retention_barrier.projection_snapshot_claims AS parent_claim
          ON parent_claim.organization_id = parent_link.organization_id
          AND parent_claim.dashboard_id = dashboard.dashboard_id
          AND parent_claim.snapshot_id = parent_link.snapshot_id
          AND parent_claim.claim_kind = 'version'
        WHERE parent_version.organization_id = dashboard.organization_id
          AND parent_version.dashboard_id = dashboard.dashboard_id
          AND parent_version.version_id = version.parent_version_id
          AND parent_version.validation_state = 'validated'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.projection_snapshot_links AS missing_link
      WHERE missing_link.organization_id = dashboard.organization_id
        AND missing_link.dashboard_id = dashboard.dashboard_id
        AND NOT EXISTS (
          SELECT 1
          FROM task8a_retention_barrier.projection_snapshot_claims AS exact_claim
          WHERE exact_claim.organization_id = missing_link.organization_id
            AND exact_claim.dashboard_id = dashboard.dashboard_id
            AND exact_claim.snapshot_id = missing_link.snapshot_id
            AND exact_claim.claim_kind = 'version'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.projection_evidence_links AS missing_link
      WHERE missing_link.organization_id = dashboard.organization_id
        AND missing_link.dashboard_id = dashboard.dashboard_id
        AND NOT EXISTS (
          SELECT 1
          FROM task8a_retention_barrier.projection_evidence_claims AS exact_claim
          WHERE exact_claim.organization_id = missing_link.organization_id
            AND exact_claim.dashboard_id = dashboard.dashboard_id
            AND exact_claim.evidence_id = missing_link.evidence_id
            AND exact_claim.claim_kind = 'evidence'
        )
    );
  IF v_projection IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  RETURN v_projection;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.read_lineage_projection(
  uuid, uuid, bigint
) OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.read_lineage_projection(
  uuid, uuid, bigint
) FROM PUBLIC;

-- Noncanonical shared-artifact governance model.  Original dashboard_id is
-- immutable provenance; a shared artifact is governed by a target only while
-- that target has an exact access-bearing claim, after which the exact
-- target-bound finalizer hash carries authority through byte deletion.
CREATE TABLE task8a_retention_barrier.artifact_resources (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  ownership_class text NOT NULL
    CHECK (ownership_class IN ('dashboard_owned', 'shared')),
  artifact_bytes text NOT NULL,
  PRIMARY KEY (organization_id, artifact_id)
);

CREATE TABLE task8a_retention_barrier.artifact_claims (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  reference_claim_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  claim_kind text NOT NULL CHECK (claim_kind = 'access'),
  PRIMARY KEY (organization_id, artifact_id, reference_claim_id)
);

CREATE TABLE task8a_retention_barrier.artifact_finalizers (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  target_dashboard_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('intent', 'eligible', 'deleted')),
  expected_claim_set_sha256 bytea NOT NULL CHECK (
    octet_length(expected_claim_set_sha256) = 32
  ),
  proof_sha256 bytea,
  bytes_deleted_at timestamptz,
  PRIMARY KEY (organization_id, artifact_id)
);

ALTER TABLE task8a_retention_barrier.artifact_resources
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.artifact_resources
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.artifact_claims
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.artifact_claims
  FORCE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.artifact_finalizers
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.artifact_finalizers
  FORCE ROW LEVEL SECURITY;

GRANT SELECT, DELETE ON task8a_retention_barrier.artifact_resources
  TO task8a_security_harness_definer;
GRANT SELECT, DELETE ON task8a_retention_barrier.artifact_claims
  TO task8a_security_harness_definer;
GRANT SELECT, INSERT, UPDATE
  ON task8a_retention_barrier.artifact_finalizers
  TO task8a_security_harness_definer;

CREATE FUNCTION task8a_retention_barrier.artifact_expected_claim_hash(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_artifact_id uuid
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT sha256(
    uuid_send(p_organization_id) || uuid_send(p_dashboard_id)
    || uuid_send(p_artifact_id)
    || convert_to('task8a_artifact_reference_claims_v1', 'UTF8')
  )
$function$;

REVOKE ALL ON FUNCTION
  task8a_retention_barrier.artifact_expected_claim_hash(uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  task8a_retention_barrier.artifact_expected_claim_hash(uuid, uuid, uuid)
  TO task8a_security_harness_definer;

CREATE FUNCTION task8a_retention_barrier.artifact_is_governable(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_artifact_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT CURRENT_USER = 'task8a_security_harness_definer'::name
    AND EXISTS (
      SELECT 1
      FROM task8a_retention_barrier.artifact_resources AS artifact
      WHERE artifact.organization_id = p_organization_id
        AND artifact.artifact_id = p_artifact_id
        AND (
          (artifact.ownership_class = 'dashboard_owned'
            AND artifact.dashboard_id = p_dashboard_id)
          OR (artifact.ownership_class = 'shared' AND EXISTS (
            SELECT 1
            FROM task8a_retention_barrier.artifact_claims AS exact_claim
            WHERE exact_claim.organization_id = artifact.organization_id
              AND exact_claim.artifact_id = artifact.artifact_id
              AND exact_claim.dashboard_id = p_dashboard_id
              AND exact_claim.claim_kind = 'access'
          ))
        )
    )
$function$;

ALTER FUNCTION task8a_retention_barrier.artifact_is_governable(
  uuid, uuid, uuid
) OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.artifact_is_governable(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION task8a_retention_barrier.guard_artifact_delete()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_dashboard_id uuid;
BEGIN
  v_organization_id := nullif(
    current_setting('task8a.purge_organization_id', true), ''
  )::uuid;
  v_dashboard_id := nullif(
    current_setting('task8a.purge_dashboard_id', true), ''
  )::uuid;
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name
    OR v_organization_id IS DISTINCT FROM OLD.organization_id
    OR v_dashboard_id IS NULL
    OR NOT (
      (OLD.ownership_class = 'dashboard_owned'
        AND OLD.dashboard_id = v_dashboard_id)
      OR OLD.ownership_class = 'shared'
    )
    OR EXISTS (
      SELECT 1 FROM task8a_retention_barrier.artifact_claims AS claim
      WHERE claim.organization_id = OLD.organization_id
        AND claim.artifact_id = OLD.artifact_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.artifact_finalizers AS finalizer
      WHERE finalizer.organization_id = OLD.organization_id
        AND finalizer.artifact_id = OLD.artifact_id
        AND finalizer.target_dashboard_id = v_dashboard_id
        AND finalizer.state = 'deleted'
        AND finalizer.proof_sha256 = finalizer.expected_claim_set_sha256
        AND finalizer.bytes_deleted_at IS NOT NULL
        AND finalizer.expected_claim_set_sha256 =
          task8a_retention_barrier.artifact_expected_claim_hash(
            OLD.organization_id, v_dashboard_id, OLD.artifact_id
          )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  RETURN OLD;
END
$function$;

ALTER FUNCTION task8a_retention_barrier.guard_artifact_delete()
  OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION task8a_retention_barrier.guard_artifact_delete()
  FROM PUBLIC;

CREATE TRIGGER artifact_delete_guard
BEFORE DELETE ON task8a_retention_barrier.artifact_resources
FOR EACH ROW EXECUTE FUNCTION
  task8a_retention_barrier.guard_artifact_delete();

CREATE FUNCTION task8a_retention_barrier.purge_artifact_step(
  p_organization_id uuid,
  p_dashboard_id uuid
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF CURRENT_USER <> 'task8a_security_harness_definer'::name
    OR p_organization_id IS NULL OR p_dashboard_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;
  PERFORM pg_catalog.set_config(
    'task8a.purge_organization_id', p_organization_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'task8a.purge_dashboard_id', p_dashboard_id::text, true
  );

  INSERT INTO task8a_retention_barrier.artifact_finalizers (
    organization_id, artifact_id, target_dashboard_id, state,
    expected_claim_set_sha256
  )
  SELECT artifact.organization_id, artifact.artifact_id, p_dashboard_id,
    'intent', task8a_retention_barrier.artifact_expected_claim_hash(
      artifact.organization_id, p_dashboard_id, artifact.artifact_id
    )
  FROM task8a_retention_barrier.artifact_resources AS artifact
  WHERE artifact.organization_id = p_organization_id
    AND (
      (artifact.ownership_class = 'dashboard_owned'
        AND artifact.dashboard_id = p_dashboard_id)
      OR (artifact.ownership_class = 'shared' AND EXISTS (
        SELECT 1 FROM task8a_retention_barrier.artifact_claims AS target_claim
        WHERE target_claim.organization_id = artifact.organization_id
          AND target_claim.artifact_id = artifact.artifact_id
          AND target_claim.dashboard_id = p_dashboard_id
          AND target_claim.claim_kind = 'access'
      ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.artifact_claims AS other_claim
      WHERE other_claim.organization_id = artifact.organization_id
        AND other_claim.artifact_id = artifact.artifact_id
        AND NOT (
          other_claim.dashboard_id = p_dashboard_id
          AND other_claim.claim_kind = 'access'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.artifact_finalizers AS finalizer
      WHERE finalizer.organization_id = artifact.organization_id
        AND finalizer.artifact_id = artifact.artifact_id
    )
  ORDER BY artifact.artifact_id
  LIMIT 1;
  IF FOUND THEN RETURN 'intent'; END IF;

  DELETE FROM task8a_retention_barrier.artifact_claims AS claim
  WHERE claim.organization_id = p_organization_id
    AND claim.dashboard_id = p_dashboard_id
    AND claim.claim_kind = 'access';
  IF FOUND THEN RETURN 'claims'; END IF;

  UPDATE task8a_retention_barrier.artifact_finalizers AS finalizer
  SET state = 'eligible',
    proof_sha256 = finalizer.expected_claim_set_sha256
  WHERE finalizer.organization_id = p_organization_id
    AND finalizer.target_dashboard_id = p_dashboard_id
    AND finalizer.state = 'intent'
    AND finalizer.expected_claim_set_sha256 =
      task8a_retention_barrier.artifact_expected_claim_hash(
        finalizer.organization_id, p_dashboard_id, finalizer.artifact_id
      )
    AND NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.artifact_claims AS claim
      WHERE claim.organization_id = finalizer.organization_id
        AND claim.artifact_id = finalizer.artifact_id
    );
  IF FOUND THEN RETURN 'eligible'; END IF;

  UPDATE task8a_retention_barrier.artifact_finalizers AS finalizer
  SET state = 'deleted', bytes_deleted_at = statement_timestamp()
  WHERE finalizer.organization_id = p_organization_id
    AND finalizer.target_dashboard_id = p_dashboard_id
    AND finalizer.state = 'eligible'
    AND finalizer.proof_sha256 = finalizer.expected_claim_set_sha256
    AND finalizer.expected_claim_set_sha256 =
      task8a_retention_barrier.artifact_expected_claim_hash(
        finalizer.organization_id, p_dashboard_id, finalizer.artifact_id
      )
    AND NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.artifact_claims AS claim
      WHERE claim.organization_id = finalizer.organization_id
        AND claim.artifact_id = finalizer.artifact_id
    );
  IF FOUND THEN
    DELETE FROM task8a_retention_barrier.artifact_resources AS artifact
    USING task8a_retention_barrier.artifact_finalizers AS finalizer
    WHERE artifact.organization_id = p_organization_id
      AND finalizer.organization_id = artifact.organization_id
      AND finalizer.artifact_id = artifact.artifact_id
      AND finalizer.target_dashboard_id = p_dashboard_id
      AND finalizer.state = 'deleted'
      AND finalizer.proof_sha256 = finalizer.expected_claim_set_sha256
      AND finalizer.bytes_deleted_at IS NOT NULL
      AND finalizer.expected_claim_set_sha256 =
        task8a_retention_barrier.artifact_expected_claim_hash(
          artifact.organization_id, p_dashboard_id, artifact.artifact_id
        );
    RETURN 'bytes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM task8a_retention_barrier.artifact_resources AS artifact
    WHERE artifact.organization_id = p_organization_id
      AND (
        (artifact.ownership_class = 'dashboard_owned'
          AND artifact.dashboard_id = p_dashboard_id)
        OR (artifact.ownership_class = 'shared' AND EXISTS (
          SELECT 1 FROM task8a_retention_barrier.artifact_claims AS exact_claim
          WHERE exact_claim.organization_id = artifact.organization_id
            AND exact_claim.artifact_id = artifact.artifact_id
            AND exact_claim.dashboard_id = p_dashboard_id
            AND exact_claim.claim_kind = 'access'
        ))
        OR EXISTS (
          SELECT 1 FROM task8a_retention_barrier.artifact_finalizers AS finalizer
          WHERE finalizer.organization_id = artifact.organization_id
            AND finalizer.artifact_id = artifact.artifact_id
            AND finalizer.target_dashboard_id = p_dashboard_id
            AND finalizer.expected_claim_set_sha256 =
              task8a_retention_barrier.artifact_expected_claim_hash(
                artifact.organization_id, p_dashboard_id,
                artifact.artifact_id
              )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_conflict';
  END IF;
  RETURN 'cleaned';
END
$function$;

ALTER FUNCTION task8a_retention_barrier.purge_artifact_step(uuid, uuid)
  OWNER TO task8a_security_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.purge_artifact_step(uuid, uuid)
  FROM PUBLIC;

-- Noncanonical bounded snapshot pagination model.  It mirrors the modeled
-- successor's resource -> claims -> fresh-snapshot finalizer ordering and its
-- version-id/snapshot-id link deletion order without claiming canonical 0003.
CREATE TABLE task8a_retention_barrier.snapshot_links (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  PRIMARY KEY (organization_id, dashboard_id, version_id, snapshot_id),
  FOREIGN KEY (organization_id, snapshot_id)
    REFERENCES task8a_retention_barrier.snapshot_resources (
      organization_id, snapshot_id
    )
);

ALTER TABLE task8a_retention_barrier.snapshot_links
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task8a_retention_barrier.snapshot_links
  FORCE ROW LEVEL SECURITY;

CREATE POLICY snapshot_links_retention_select
ON task8a_retention_barrier.snapshot_links
FOR SELECT TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_links_retention_update
ON task8a_retention_barrier.snapshot_links
FOR UPDATE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name)
WITH CHECK (CURRENT_USER = 'task8a_retention_harness_definer'::name);
CREATE POLICY snapshot_links_retention_delete
ON task8a_retention_barrier.snapshot_links
FOR DELETE TO task8a_retention_harness_definer
USING (CURRENT_USER = 'task8a_retention_harness_definer'::name);

GRANT SELECT, UPDATE (organization_id), DELETE
  ON task8a_retention_barrier.snapshot_links
  TO task8a_retention_harness_definer;

CREATE FUNCTION task8a_retention_barrier.purge_snapshot_batch(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_lock_barrier bigint
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_snapshot_ids uuid[];
  v_gap_snapshot_id uuid;
  v_row_count integer;
  v_batch_limit constant integer := 100;
BEGIN
  IF CURRENT_USER <> 'task8a_retention_harness_definer'::name
    OR p_organization_id IS NULL OR p_dashboard_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
  END IF;

  IF p_lock_barrier IS NOT NULL THEN
    PERFORM task8a_retention_barrier.initialize(
      p_organization_id, p_dashboard_id
    );
    PERFORM 1
    FROM task8a_retention_barrier.target_lifecycle_policies AS policy
    WHERE policy.organization_id = p_organization_id
    ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE OF policy;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(p_lock_barrier);
    PERFORM 1
    FROM task8a_retention_barrier.target_dashboards AS dashboard
    WHERE dashboard.organization_id = p_organization_id
      AND dashboard.dashboard_id = p_dashboard_id
    FOR UPDATE OF dashboard;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_denied';
    END IF;
    UPDATE task8a_retention_barrier.target_dashboards AS dashboard
    SET retention_action_count = dashboard.retention_action_count + 1
    WHERE dashboard.organization_id = p_organization_id
      AND dashboard.dashboard_id = p_dashboard_id;
    INSERT INTO task8a_retention_barrier.target_events (
      organization_id, dashboard_id, event_id
    ) VALUES (
      p_organization_id, p_dashboard_id,
      '84000000-0000-4000-8000-000000000001'::uuid
    );
    INSERT INTO task8a_retention_barrier.target_audits (
      organization_id, dashboard_id, audit_id
    ) VALUES (
      p_organization_id, p_dashboard_id,
      '84000000-0000-4000-8000-000000000002'::uuid
    );
    RETURN 'retention_action';
  END IF;

  v_snapshot_ids := ARRAY(
    SELECT snapshot.snapshot_id
    FROM task8a_retention_barrier.snapshot_resources AS snapshot
    WHERE snapshot.organization_id = p_organization_id
      AND EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_links AS link
        WHERE link.organization_id = snapshot.organization_id
          AND link.dashboard_id = p_dashboard_id
          AND link.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
        WHERE finalizer.organization_id = snapshot.organization_id
          AND finalizer.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS other_claim
        WHERE other_claim.organization_id = snapshot.organization_id
          AND other_claim.snapshot_id = snapshot.snapshot_id
          AND other_claim.dashboard_id <> p_dashboard_id
      )
    ORDER BY snapshot.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF snapshot
  );
  PERFORM 1 FROM task8a_retention_barrier.snapshot_claims AS claim
  WHERE claim.organization_id = p_organization_id
    AND claim.snapshot_id = ANY(v_snapshot_ids)
  ORDER BY claim.snapshot_id, claim.dashboard_id
  FOR UPDATE OF claim;
  INSERT INTO task8a_retention_barrier.snapshot_finalizers (
    organization_id, snapshot_id, state
  ) SELECT p_organization_id, candidate.snapshot_id, 'intent'
    FROM unnest(v_snapshot_ids) AS candidate(snapshot_id)
    WHERE NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
        WHERE finalizer.organization_id = p_organization_id
          AND finalizer.snapshot_id = candidate.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS other_claim
        WHERE other_claim.organization_id = p_organization_id
          AND other_claim.snapshot_id = candidate.snapshot_id
          AND other_claim.dashboard_id <> p_dashboard_id
      )
    ORDER BY candidate.snapshot_id
  ON CONFLICT (organization_id, snapshot_id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN 'intent'; END IF;

  SELECT snapshot.snapshot_id INTO v_gap_snapshot_id
  FROM task8a_retention_barrier.snapshot_resources AS snapshot
  WHERE snapshot.organization_id = p_organization_id
    AND EXISTS (
      SELECT 1 FROM task8a_retention_barrier.snapshot_links AS link
      WHERE link.organization_id = snapshot.organization_id
        AND link.dashboard_id = p_dashboard_id
        AND link.snapshot_id = snapshot.snapshot_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
      WHERE finalizer.organization_id = snapshot.organization_id
        AND finalizer.snapshot_id = snapshot.snapshot_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS other_claim
      WHERE other_claim.organization_id = snapshot.organization_id
        AND other_claim.snapshot_id = snapshot.snapshot_id
        AND other_claim.dashboard_id <> p_dashboard_id
    )
  ORDER BY snapshot.snapshot_id
  LIMIT 1
  FOR UPDATE OF snapshot;
  IF v_gap_snapshot_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM task8a_retention_barrier.snapshot_resources AS snapshot
    WHERE snapshot.organization_id = p_organization_id
      AND snapshot.snapshot_id = v_gap_snapshot_id
      AND EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_links AS link
        WHERE link.organization_id = snapshot.organization_id
          AND link.dashboard_id = p_dashboard_id
          AND link.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
        WHERE finalizer.organization_id = snapshot.organization_id
          AND finalizer.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS other_claim
        WHERE other_claim.organization_id = snapshot.organization_id
          AND other_claim.snapshot_id = snapshot.snapshot_id
          AND other_claim.dashboard_id <> p_dashboard_id
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_conflict';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT claim.organization_id, claim.snapshot_id, claim.dashboard_id
    FROM task8a_retention_barrier.snapshot_claims AS claim
    WHERE claim.organization_id = p_organization_id
      AND claim.dashboard_id = p_dashboard_id
    ORDER BY claim.snapshot_id, claim.dashboard_id
    LIMIT v_batch_limit
    FOR UPDATE OF claim
  )
  DELETE FROM task8a_retention_barrier.snapshot_claims AS claim
  USING candidates AS candidate
  WHERE claim.organization_id = candidate.organization_id
    AND claim.snapshot_id = candidate.snapshot_id
    AND claim.dashboard_id = candidate.dashboard_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN 'claims'; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.snapshot_id
    FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.state = 'intent'
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.snapshot_id = finalizer.snapshot_id
      )
    ORDER BY finalizer.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE task8a_retention_barrier.snapshot_finalizers AS finalizer
  SET state = 'eligible'
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.snapshot_id = candidate.snapshot_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN 'eligible'; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT link.organization_id, link.dashboard_id, link.version_id,
      link.snapshot_id
    FROM task8a_retention_barrier.snapshot_links AS link
    WHERE link.organization_id = p_organization_id
      AND link.dashboard_id = p_dashboard_id
    ORDER BY link.version_id, link.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF link
  )
  DELETE FROM task8a_retention_barrier.snapshot_links AS link
  USING candidates AS candidate
  WHERE link.organization_id = candidate.organization_id
    AND link.dashboard_id = candidate.dashboard_id
    AND link.version_id = candidate.version_id
    AND link.snapshot_id = candidate.snapshot_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN 'links'; END IF;

  v_snapshot_ids := ARRAY(
    SELECT finalizer.snapshot_id
    FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    WHERE finalizer.organization_id = p_organization_id
      AND finalizer.state = 'eligible'
      AND NOT EXISTS (
        SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.snapshot_id = finalizer.snapshot_id
      )
    ORDER BY finalizer.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  );
  UPDATE task8a_retention_barrier.snapshot_finalizers AS finalizer
  SET state = 'deleted'
  WHERE finalizer.organization_id = p_organization_id
    AND finalizer.snapshot_id = ANY(v_snapshot_ids);
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN
    DELETE FROM task8a_retention_barrier.snapshot_resources AS snapshot
    WHERE snapshot.organization_id = p_organization_id
      AND snapshot.snapshot_id = ANY(v_snapshot_ids);
    RETURN 'bytes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM task8a_retention_barrier.snapshot_claims AS claim
    WHERE claim.organization_id = p_organization_id
      AND claim.dashboard_id = p_dashboard_id
  ) OR EXISTS (
    SELECT 1 FROM task8a_retention_barrier.snapshot_links AS link
    WHERE link.organization_id = p_organization_id
      AND link.dashboard_id = p_dashboard_id
  ) OR EXISTS (
    SELECT 1 FROM task8a_retention_barrier.snapshot_finalizers AS finalizer
    JOIN task8a_retention_barrier.snapshot_resources AS snapshot
      ON snapshot.organization_id = finalizer.organization_id
     AND snapshot.snapshot_id = finalizer.snapshot_id
    WHERE finalizer.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task8a_conflict';
  END IF;
  RETURN 'cleaned';
END
$function$;

ALTER FUNCTION task8a_retention_barrier.purge_snapshot_batch(
  uuid, uuid, bigint
)
  OWNER TO task8a_retention_harness_definer;
REVOKE ALL ON FUNCTION
  task8a_retention_barrier.purge_snapshot_batch(uuid, uuid, bigint)
  FROM PUBLIC;
