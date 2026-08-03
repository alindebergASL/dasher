-- Dasher lifecycle API correction successor.

CREATE FUNCTION dasher_private.context_csrf_allows(
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea
)
RETURNS boolean
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
  v_trusted_organization_id uuid;
  v_organization_advisory_key bigint;
  v_rotated_from_session_id uuid;
  v_replaced_by_session_id uuid;
  v_now timestamptz;
BEGIN
  IF p_current_csrf_key_version IS NULL
    OR p_current_csrf_key_version NOT BETWEEN 1 AND 32767
    OR p_current_csrf_digest IS NULL
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
  THEN
    RETURN false;
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
  EXCEPTION
    WHEN OTHERS THEN
      RETURN false;
  END;

  IF v_context_session_id IS NULL
    OR v_context_user_id IS NULL
    OR v_context_organization_id IS NULL
    OR v_context_membership_id IS NULL
    OR v_context_authority_revision IS NULL
    OR v_context_session_key_version IS NULL
    OR v_context_session_digest IS NULL
    OR pg_catalog.octet_length(v_context_session_digest) <> 32
  THEN
    RETURN false;
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

  IF NOT FOUND
    OR v_trusted_organization_id IS NULL
    OR v_trusted_organization_id IS DISTINCT FROM v_context_organization_id
  THEN
    RETURN false;
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

  RETURN EXISTS (
    SELECT 1
    FROM dasher.sessions AS session_row
    JOIN dasher.memberships AS membership
      ON membership.organization_id = session_row.organization_id
     AND membership.user_id = session_row.user_id
    WHERE session_row.session_id = v_context_session_id
      AND session_row.organization_id = v_trusted_organization_id
      AND session_row.user_id = v_context_user_id
      AND session_row.authority_revision = v_context_authority_revision
      AND session_row.token_key_version = v_context_session_key_version
      AND session_row.token_digest = v_context_session_digest
      AND session_row.csrf_key_version = p_current_csrf_key_version
      AND session_row.csrf_digest = p_current_csrf_digest
      AND session_row.replaced_by_session_id IS NULL
      AND session_row.revoked_at IS NULL
      AND v_now < session_row.idle_expires_at
      AND v_now < session_row.absolute_expires_at
      AND membership.membership_id = v_context_membership_id
      AND membership.organization_id = v_trusted_organization_id
      AND membership.user_id = v_context_user_id
      AND membership.state = 'active'
      AND membership.authority_revision = v_context_authority_revision
      AND membership.role IN ('viewer', 'editor', 'admin')
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END
$function$;

ALTER FUNCTION dasher_private.context_csrf_allows(smallint, bytea)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_private.context_csrf_allows(smallint, bytea)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;

CREATE TYPE dasher.dashboard_creation_result AS (
  dashboard_id uuid,
  created_at timestamptz,
  effective_expires_at timestamptz,
  effective_ttl_seconds integer,
  used_organization_default boolean,
  lifecycle_policy_seeded boolean,
  lifecycle_policy_revision bigint,
  default_disposable_ttl_seconds integer,
  retention_policy_revision bigint
);

REVOKE ALL ON TYPE dasher.dashboard_creation_result
  FROM PUBLIC, dasher_app, dasher_security_definer,
    dasher_retention_definer, dasher_retention_operator;

ALTER TYPE dasher.dashboard_lineage_projection
  ADD ATTRIBUTE artifact_ownership_class text;

CREATE OR REPLACE FUNCTION dasher_api.list_dashboards(integer)
RETURNS SETOF dasher.dashboard_summary
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_now timestamptz := statement_timestamp();
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'viewer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF $1 IS NULL OR $1 NOT BETWEEN 1 AND 100 OR v_organization_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT dashboard_id, title, current_kind, lifecycle_state,
      lifecycle_revision, effective_expires_at, head_version_id
    FROM dasher.dashboards
    WHERE organization_id = v_organization_id
      AND access_revoked_at IS NULL AND purged_at IS NULL
      AND (
        (current_kind = 'disposable' AND lifecycle_state IN ('draft', 'active')
          AND effective_expires_at IS NOT NULL AND v_now < effective_expires_at)
        OR
        (current_kind = 'durable' AND lifecycle_state IN ('draft', 'active', 'archived')
          AND effective_expires_at IS NULL)
      )
    ORDER BY created_at DESC, dashboard_id
    LIMIT $1;
END
$function$;

ALTER FUNCTION dasher_api.list_dashboards(integer)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.list_dashboards(integer)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.list_dashboards(integer) TO dasher_app;

CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_summary(uuid)
RETURNS dasher.dashboard_summary
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result dasher.dashboard_summary;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'viewer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT dashboard_id, title, current_kind, lifecycle_state,
      lifecycle_revision, effective_expires_at, head_version_id
    INTO v_result
  FROM dasher.dashboards
  WHERE organization_id = dasher_private.context_organization_id()
    AND dashboard_id = $1 AND access_revoked_at IS NULL AND purged_at IS NULL
    AND (
      (current_kind = 'disposable' AND lifecycle_state IN ('draft', 'active')
        AND effective_expires_at IS NOT NULL AND v_now < effective_expires_at)
      OR
      (current_kind = 'durable' AND lifecycle_state IN ('draft', 'active', 'archived')
        AND effective_expires_at IS NULL)
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION dasher_api.get_dashboard_summary(uuid)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_summary(uuid)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_summary(uuid) TO dasher_app;

CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_head(uuid)
RETURNS dasher.dashboard_version_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result dasher.dashboard_version_projection;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'viewer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT version.dashboard_id, version.version_id, version.parent_version_id,
      version.canonical_spec_bytes, version.canonical_spec_sha256,
      version.validation_state, version.validation_sha256,
      version.planner_provenance_sha256, version.policy_revision,
      version.registry_revision, version.calculation_graph_sha256,
      version.created_at
    INTO v_result
  FROM dasher.dashboards AS dashboard
  JOIN dasher.dashboard_versions AS version
    ON version.organization_id = dashboard.organization_id
   AND version.dashboard_id = dashboard.dashboard_id
   AND version.version_id = dashboard.head_version_id
  WHERE dashboard.organization_id = dasher_private.context_organization_id()
    AND dashboard.dashboard_id = $1
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND (
      (dashboard.current_kind = 'disposable'
        AND dashboard.lifecycle_state IN ('draft', 'active')
        AND dashboard.effective_expires_at IS NOT NULL
        AND v_now < dashboard.effective_expires_at)
      OR
      (dashboard.current_kind = 'durable'
        AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
        AND dashboard.effective_expires_at IS NULL)
    )
    AND version.validation_state = 'validated'
    AND EXISTS (
      SELECT 1 FROM dasher.snapshot_reference_claims AS claim
      WHERE claim.organization_id = version.organization_id
        AND claim.dashboard_id = version.dashboard_id
        AND claim.version_id = version.version_id
        AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION dasher_api.get_dashboard_head(uuid)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_head(uuid)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_head(uuid) TO dasher_app;

CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_version(uuid, uuid)
RETURNS dasher.dashboard_version_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result dasher.dashboard_version_projection;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'viewer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT version.dashboard_id, version.version_id, version.parent_version_id,
      version.canonical_spec_bytes, version.canonical_spec_sha256,
      version.validation_state,
      version.validation_sha256, version.planner_provenance_sha256,
      version.policy_revision, version.registry_revision,
      version.calculation_graph_sha256, version.created_at
    INTO v_result
  FROM dasher.dashboard_versions AS version
  JOIN dasher.dashboards AS dashboard
    ON dashboard.organization_id = version.organization_id
   AND dashboard.dashboard_id = version.dashboard_id
  WHERE version.organization_id = dasher_private.context_organization_id()
    AND version.dashboard_id = $1 AND version.version_id = $2
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND (
      (dashboard.current_kind = 'disposable'
        AND dashboard.lifecycle_state IN ('draft', 'active')
        AND dashboard.effective_expires_at IS NOT NULL
        AND v_now < dashboard.effective_expires_at)
      OR
      (dashboard.current_kind = 'durable'
        AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
        AND dashboard.effective_expires_at IS NULL)
    )
    AND version.validation_state = 'validated'
    AND EXISTS (
      SELECT 1 FROM dasher.snapshot_reference_claims AS claim
      WHERE claim.organization_id = version.organization_id
        AND claim.dashboard_id = version.dashboard_id
        AND claim.version_id = version.version_id
        AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION dasher_api.get_dashboard_version(uuid, uuid)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_version(uuid, uuid)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_version(uuid, uuid) TO dasher_app;

CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_admin_status(uuid)
RETURNS dasher.dashboard_admin_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result dasher.dashboard_admin_projection;
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT dashboard.dashboard_id, dashboard.lifecycle_state,
      dashboard.lifecycle_revision, dashboard.capability_epoch,
      dashboard.cache_epoch, dashboard.access_revoked_at, dashboard.purge_after,
      dashboard.purge_started_at, dashboard.purged_at,
      (SELECT count(*) FROM dasher.dashboard_legal_holds AS hold
       WHERE hold.organization_id = dashboard.organization_id
         AND hold.dashboard_id = dashboard.dashboard_id
         AND hold.released_at IS NULL),
      coordination.current_step
    INTO v_result
  FROM dasher.dashboards AS dashboard
  LEFT JOIN dasher.dashboard_cleanup_coordination AS coordination
    ON coordination.organization_id = dashboard.organization_id
   AND coordination.dashboard_id = dashboard.dashboard_id
  WHERE dashboard.organization_id = dasher_private.context_organization_id()
    AND dashboard.dashboard_id = $1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION dasher_api.get_dashboard_admin_status(uuid)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_admin_status(uuid)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_admin_status(uuid)
  TO dasher_app;

GRANT SELECT ON TABLE dasher.dashboard_cleanup_coordination
  TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_legal_holds
  TO dasher_security_definer;

CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid)
RETURNS SETOF dasher.dashboard_evidence_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'viewer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM dasher.dashboards AS dashboard
    JOIN dasher.dashboard_versions AS version
      ON version.organization_id = dashboard.organization_id
     AND version.dashboard_id = dashboard.dashboard_id
    WHERE dashboard.organization_id = dasher_private.context_organization_id()
      AND dashboard.dashboard_id = $1
      AND version.version_id = $2
      AND version.validation_state = 'validated'
      AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
      AND (
        (dashboard.current_kind = 'disposable'
          AND dashboard.lifecycle_state IN ('draft', 'active')
          AND dashboard.effective_expires_at IS NOT NULL
          AND v_now < dashboard.effective_expires_at)
        OR
        (dashboard.current_kind = 'durable'
          AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
          AND dashboard.effective_expires_at IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS version_claim
        WHERE version_claim.organization_id = version.organization_id
          AND version_claim.dashboard_id = version.dashboard_id
          AND version_claim.version_id = version.version_id
          AND version_claim.claim_kind = 'access_bearing'
          AND version_claim.hold_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS missing_evidence
        WHERE missing_evidence.organization_id = version.organization_id
          AND missing_evidence.dashboard_id = version.dashboard_id
          AND missing_evidence.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.evidence_reference_claims AS claim
            WHERE claim.organization_id = missing_evidence.organization_id
              AND claim.evidence_id = missing_evidence.evidence_id
              AND claim.dashboard_id = missing_evidence.dashboard_id
              AND claim.version_id = missing_evidence.version_id
              AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
          )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT link.dashboard_id, link.version_id, evidence.evidence_id,
      evidence.evidence_kind, evidence.content_sha256, evidence.observed_at,
      evidence.retrieved_at
    FROM dasher.dashboard_version_evidence AS link
    JOIN dasher.evidence_records AS evidence
      ON evidence.organization_id = link.organization_id
     AND evidence.evidence_id = link.evidence_id
    JOIN dasher.dashboard_versions AS version
      ON version.organization_id = link.organization_id
     AND version.dashboard_id = link.dashboard_id
     AND version.version_id = link.version_id
    JOIN dasher.dashboards AS dashboard
      ON dashboard.organization_id = version.organization_id
     AND dashboard.dashboard_id = version.dashboard_id
    WHERE dashboard.organization_id = dasher_private.context_organization_id()
      AND dashboard.dashboard_id = $1
      AND version.dashboard_id = $1 AND version.version_id = $2
      AND link.dashboard_id = $1 AND link.version_id = $2
      AND version.validation_state = 'validated'
      AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
      AND (
        (dashboard.current_kind = 'disposable'
          AND dashboard.lifecycle_state IN ('draft', 'active')
          AND dashboard.effective_expires_at IS NOT NULL
          AND v_now < dashboard.effective_expires_at)
        OR
        (dashboard.current_kind = 'durable'
          AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
          AND dashboard.effective_expires_at IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS version_claim
        WHERE version_claim.organization_id = version.organization_id
          AND version_claim.dashboard_id = version.dashboard_id
          AND version_claim.version_id = version.version_id
          AND version_claim.claim_kind = 'access_bearing'
          AND version_claim.hold_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS missing_snapshot
        WHERE missing_snapshot.organization_id = version.organization_id
          AND missing_snapshot.dashboard_id = version.dashboard_id
          AND missing_snapshot.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.snapshot_reference_claims AS snapshot_claim
            WHERE snapshot_claim.organization_id = missing_snapshot.organization_id
              AND snapshot_claim.snapshot_id = missing_snapshot.snapshot_id
              AND snapshot_claim.dashboard_id = missing_snapshot.dashboard_id
              AND snapshot_claim.version_id = missing_snapshot.version_id
              AND snapshot_claim.claim_kind = 'access_bearing'
              AND snapshot_claim.hold_id IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS missing_evidence
        WHERE missing_evidence.organization_id = version.organization_id
          AND missing_evidence.dashboard_id = version.dashboard_id
          AND missing_evidence.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.evidence_reference_claims AS missing_claim
            WHERE missing_claim.organization_id = missing_evidence.organization_id
              AND missing_claim.evidence_id = missing_evidence.evidence_id
              AND missing_claim.dashboard_id = missing_evidence.dashboard_id
              AND missing_claim.version_id = missing_evidence.version_id
              AND missing_claim.claim_kind = 'access_bearing'
              AND missing_claim.hold_id IS NULL
          )
      )
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS source_link
        JOIN dasher.snapshot_reference_claims AS source_claim
          ON source_claim.organization_id = source_link.organization_id
         AND source_claim.snapshot_id = source_link.snapshot_id
         AND source_claim.dashboard_id = source_link.dashboard_id
         AND source_claim.version_id = source_link.version_id
         AND source_claim.claim_kind = 'access_bearing'
         AND source_claim.hold_id IS NULL
        WHERE source_link.organization_id = link.organization_id
          AND source_link.dashboard_id = link.dashboard_id
          AND source_link.version_id = link.version_id
          AND source_link.snapshot_id = evidence.snapshot_id
      )
      AND EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS evidence_claim
        WHERE evidence_claim.organization_id = link.organization_id
          AND evidence_claim.evidence_id = link.evidence_id
          AND evidence_claim.dashboard_id = link.dashboard_id
          AND evidence_claim.version_id = link.version_id
          AND evidence_claim.claim_kind = 'access_bearing'
          AND evidence_claim.hold_id IS NULL
      )
    ORDER BY evidence.evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
END
$function$;

ALTER FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid)
  TO dasher_app;

CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid)
RETURNS SETOF dasher.dashboard_lineage_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
BEGIN
  IF NOT dasher_private.context_allows(
    dasher_private.context_organization_id(), 'viewer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM dasher.dashboard_versions AS version
    JOIN dasher.dashboards AS dashboard
      ON dashboard.organization_id = version.organization_id
     AND dashboard.dashboard_id = version.dashboard_id
    WHERE version.organization_id = dasher_private.context_organization_id()
      AND version.dashboard_id = $1 AND version.version_id = $2
      AND version.validation_state = 'validated'
      AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
      AND (
        (dashboard.current_kind = 'disposable'
          AND dashboard.lifecycle_state IN ('draft', 'active')
          AND dashboard.effective_expires_at IS NOT NULL
          AND v_now < dashboard.effective_expires_at)
        OR
        (dashboard.current_kind = 'durable'
          AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
          AND dashboard.effective_expires_at IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS version_claim
        WHERE version_claim.organization_id = version.organization_id
          AND version_claim.dashboard_id = version.dashboard_id
          AND version_claim.version_id = version.version_id
          AND version_claim.claim_kind = 'access_bearing'
          AND version_claim.hold_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS missing_snapshot
        WHERE missing_snapshot.organization_id = version.organization_id
          AND missing_snapshot.dashboard_id = version.dashboard_id
          AND missing_snapshot.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.snapshot_reference_claims AS claim
            WHERE claim.organization_id = missing_snapshot.organization_id
              AND claim.snapshot_id = missing_snapshot.snapshot_id
              AND claim.dashboard_id = missing_snapshot.dashboard_id
              AND claim.version_id = missing_snapshot.version_id
              AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS missing_evidence
        WHERE missing_evidence.organization_id = version.organization_id
          AND missing_evidence.dashboard_id = version.dashboard_id
          AND missing_evidence.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.evidence_reference_claims AS claim
            WHERE claim.organization_id = missing_evidence.organization_id
              AND claim.evidence_id = missing_evidence.evidence_id
              AND claim.dashboard_id = missing_evidence.dashboard_id
              AND claim.version_id = missing_evidence.version_id
              AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_artifacts AS missing_artifact
        WHERE missing_artifact.organization_id = version.organization_id
          AND (
            (missing_artifact.ownership_class = 'dashboard_owned'
              AND missing_artifact.dashboard_id = version.dashboard_id
              AND missing_artifact.version_id = version.version_id)
            OR
            (missing_artifact.ownership_class = 'shared' AND EXISTS (
              SELECT 1 FROM dasher.artifact_reference_claims AS relevance_claim
              WHERE relevance_claim.organization_id = missing_artifact.organization_id
                AND relevance_claim.artifact_id = missing_artifact.artifact_id
                AND relevance_claim.dashboard_id = version.dashboard_id
                AND relevance_claim.version_id = version.version_id
                AND relevance_claim.claim_kind = 'access_bearing'
                AND relevance_claim.hold_id IS NULL
            ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM dasher.artifact_reference_claims AS claim
            WHERE claim.organization_id = missing_artifact.organization_id
              AND claim.artifact_id = missing_artifact.artifact_id
              AND claim.dashboard_id = version.dashboard_id
              AND claim.version_id = version.version_id
              AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
          )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT version.dashboard_id, version.version_id, version.parent_version_id,
      snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id,
      artifact.ownership_class
    FROM dasher.dashboard_versions AS version
    LEFT JOIN dasher.dashboard_version_snapshots AS snapshot
      ON snapshot.organization_id = version.organization_id
     AND snapshot.dashboard_id = version.dashboard_id
     AND snapshot.version_id = version.version_id
    LEFT JOIN dasher.dashboard_version_evidence AS evidence
      ON evidence.organization_id = version.organization_id
     AND evidence.dashboard_id = version.dashboard_id
     AND evidence.version_id = version.version_id
    LEFT JOIN dasher.dashboard_artifacts AS artifact
      ON artifact.organization_id = version.organization_id
     AND (
       (artifact.ownership_class = 'dashboard_owned'
         AND artifact.dashboard_id = version.dashboard_id
         AND artifact.version_id = version.version_id)
       OR
       (artifact.ownership_class = 'shared' AND EXISTS (
         SELECT 1 FROM dasher.artifact_reference_claims AS relevance_claim
         WHERE relevance_claim.organization_id = artifact.organization_id
           AND relevance_claim.artifact_id = artifact.artifact_id
           AND relevance_claim.dashboard_id = version.dashboard_id
           AND relevance_claim.version_id = version.version_id
           AND relevance_claim.claim_kind = 'access_bearing'
           AND relevance_claim.hold_id IS NULL
       ))
     )
    JOIN dasher.dashboards AS dashboard
      ON dashboard.organization_id = version.organization_id
     AND dashboard.dashboard_id = version.dashboard_id
    WHERE dashboard.organization_id = dasher_private.context_organization_id()
      AND dashboard.dashboard_id = $1
      AND version.dashboard_id = $1 AND version.version_id = $2
      AND version.validation_state = 'validated'
      AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
      AND (
        (dashboard.current_kind = 'disposable'
          AND dashboard.lifecycle_state IN ('draft', 'active')
          AND dashboard.effective_expires_at IS NOT NULL
          AND v_now < dashboard.effective_expires_at)
        OR
        (dashboard.current_kind = 'durable'
          AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
          AND dashboard.effective_expires_at IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS version_claim
        WHERE version_claim.organization_id = version.organization_id
          AND version_claim.dashboard_id = version.dashboard_id
          AND version_claim.version_id = version.version_id
          AND version_claim.claim_kind = 'access_bearing'
          AND version_claim.hold_id IS NULL
      )
      AND (
        version.parent_version_id IS NULL OR EXISTS (
          SELECT 1 FROM dasher.dashboard_versions AS parent
          WHERE parent.organization_id = version.organization_id
            AND parent.dashboard_id = version.dashboard_id
            AND parent.version_id = version.parent_version_id
            AND parent.validation_state = 'validated'
            AND EXISTS (
              SELECT 1 FROM dasher.snapshot_reference_claims AS parent_claim
              WHERE parent_claim.organization_id = parent.organization_id
                AND parent_claim.dashboard_id = parent.dashboard_id
                AND parent_claim.version_id = parent.version_id
                AND parent_claim.claim_kind = 'access_bearing'
                AND parent_claim.hold_id IS NULL
            )
        )
      )
      AND (
        dashboard.head_version_id IS NULL OR EXISTS (
          SELECT 1 FROM dasher.dashboard_versions AS head
          WHERE head.organization_id = dashboard.organization_id
            AND head.dashboard_id = dashboard.dashboard_id
            AND head.version_id = dashboard.head_version_id
            AND head.validation_state = 'validated'
            AND EXISTS (
              SELECT 1 FROM dasher.snapshot_reference_claims AS head_claim
              WHERE head_claim.organization_id = head.organization_id
                AND head_claim.dashboard_id = head.dashboard_id
                AND head_claim.version_id = head.version_id
                AND head_claim.claim_kind = 'access_bearing'
                AND head_claim.hold_id IS NULL
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS missing_snapshot
        WHERE missing_snapshot.organization_id = version.organization_id
          AND missing_snapshot.dashboard_id = version.dashboard_id
          AND missing_snapshot.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.snapshot_reference_claims AS missing_claim
            WHERE missing_claim.organization_id = missing_snapshot.organization_id
              AND missing_claim.snapshot_id = missing_snapshot.snapshot_id
              AND missing_claim.dashboard_id = missing_snapshot.dashboard_id
              AND missing_claim.version_id = missing_snapshot.version_id
              AND missing_claim.claim_kind = 'access_bearing'
              AND missing_claim.hold_id IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS missing_evidence
        WHERE missing_evidence.organization_id = version.organization_id
          AND missing_evidence.dashboard_id = version.dashboard_id
          AND missing_evidence.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.evidence_reference_claims AS missing_claim
            WHERE missing_claim.organization_id = missing_evidence.organization_id
              AND missing_claim.evidence_id = missing_evidence.evidence_id
              AND missing_claim.dashboard_id = missing_evidence.dashboard_id
              AND missing_claim.version_id = missing_evidence.version_id
              AND missing_claim.claim_kind = 'access_bearing'
              AND missing_claim.hold_id IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_artifacts AS missing_artifact
        WHERE missing_artifact.organization_id = version.organization_id
          AND (
            (missing_artifact.ownership_class = 'dashboard_owned'
              AND missing_artifact.dashboard_id = version.dashboard_id
              AND missing_artifact.version_id = version.version_id)
            OR
            (missing_artifact.ownership_class = 'shared' AND EXISTS (
              SELECT 1 FROM dasher.artifact_reference_claims AS relevance_claim
              WHERE relevance_claim.organization_id = missing_artifact.organization_id
                AND relevance_claim.artifact_id = missing_artifact.artifact_id
                AND relevance_claim.dashboard_id = version.dashboard_id
                AND relevance_claim.version_id = version.version_id
                AND relevance_claim.claim_kind = 'access_bearing'
                AND relevance_claim.hold_id IS NULL
            ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM dasher.artifact_reference_claims AS missing_claim
            WHERE missing_claim.organization_id = missing_artifact.organization_id
              AND missing_claim.artifact_id = missing_artifact.artifact_id
              AND missing_claim.dashboard_id = version.dashboard_id
              AND missing_claim.version_id = version.version_id
              AND missing_claim.claim_kind = 'access_bearing'
              AND missing_claim.hold_id IS NULL
          )
      )
      AND (snapshot.snapshot_id IS NULL OR EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS snapshot_claim
        WHERE snapshot_claim.organization_id = version.organization_id
          AND snapshot_claim.snapshot_id = snapshot.snapshot_id
          AND snapshot_claim.dashboard_id = version.dashboard_id
          AND snapshot_claim.version_id = version.version_id
          AND snapshot_claim.claim_kind = 'access_bearing'
          AND snapshot_claim.hold_id IS NULL
      ))
      AND (evidence.evidence_id IS NULL OR EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS evidence_claim
        WHERE evidence_claim.organization_id = version.organization_id
          AND evidence_claim.evidence_id = evidence.evidence_id
          AND evidence_claim.dashboard_id = version.dashboard_id
          AND evidence_claim.version_id = version.version_id
          AND evidence_claim.claim_kind = 'access_bearing'
          AND evidence_claim.hold_id IS NULL
      ))
      AND (artifact.artifact_id IS NULL OR EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS artifact_claim
        WHERE artifact_claim.organization_id = version.organization_id
          AND artifact_claim.artifact_id = artifact.artifact_id
          AND artifact_claim.dashboard_id = version.dashboard_id
          AND artifact_claim.version_id = version.version_id
          AND artifact_claim.claim_kind = 'access_bearing'
          AND artifact_claim.hold_id IS NULL
      ))
    ORDER BY snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
END
$function$;

ALTER FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid)
  OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid)
  FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid)
  TO dasher_app;

DROP FUNCTION dasher_api.create_dashboard(
  uuid, text, text, integer, boolean, uuid, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.create_evidence_record(
  uuid, uuid, uuid, uuid, uuid, text, text, bytea,
  timestamptz, timestamptz, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.create_dashboard_version(
  uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea,
  uuid[], uuid[], uuid[], uuid[], uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.compare_and_swap_dashboard_head(
  uuid, uuid, uuid, bigint, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.request_dashboard_promotion(
  uuid, uuid, bigint, bytea, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.decide_dashboard_promotion(
  uuid, bigint, text, uuid, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.set_dashboard_archive(
  uuid, boolean, bigint, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.delete_dashboard(
  uuid, bigint, uuid, text
) RESTRICT;
DROP FUNCTION dasher_api.restore_dashboard_as_new(
  uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text
) RESTRICT;

CREATE FUNCTION dasher_api.create_dashboard(
  uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text
)
RETURNS dasher.dashboard_creation_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_now timestamptz;
  v_effective_expires_at timestamptz;
  v_default_ttl_seconds integer;
  v_ttl_seconds integer;
  v_policy_row_revision bigint;
  v_policy_revision bigint;
  v_policy_insert_count bigint;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($8, $9) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR btrim($2) <> $2 OR char_length($2) NOT BETWEEN 1 AND 200
    OR $3 NOT IN ('disposable', 'durable') OR $5 IS NULL
    OR ($3 = 'disposable' AND (($5 AND $4 IS NOT NULL)
      OR (NOT $5 AND $4 NOT IN (3600, 86400, 604800, 2592000))))
    OR ($3 = 'durable' AND ($4 IS NOT NULL OR $5)) OR $6 IS NULL OR $7 IS NULL
    OR $10 IS NULL OR char_length($10) NOT BETWEEN 1 AND 64
    OR $7 = dasher_private.context_request_id()
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_lifecycle_policies (
    organization_id, policy_revision, default_disposable_ttl_seconds,
    retention_policy_revision, created_at, created_by_user_id, provenance
  )
  SELECT v_organization_id, 1, 86400, 1, statement_timestamp(),
      v_actor_user_id, 'dasher:lifecycle-policy:v1:lazy-seed'
  WHERE NOT EXISTS (
    SELECT 1 FROM dasher.dashboard_lifecycle_policies
    WHERE organization_id = v_organization_id
  );
  GET DIAGNOSTICS v_policy_insert_count = ROW_COUNT;
  IF v_policy_insert_count IS NULL
    OR v_policy_insert_count NOT IN (0, 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT policy_revision, default_disposable_ttl_seconds,
      retention_policy_revision
    INTO v_policy_row_revision, v_default_ttl_seconds, v_policy_revision
  FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM dasher.dashboard_lifecycle_policies
    WHERE organization_id = v_organization_id
      AND policy_revision > v_policy_row_revision
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_ttl_seconds := CASE WHEN $5 THEN v_default_ttl_seconds ELSE $4 END;
  IF $3 = 'disposable' AND v_ttl_seconds NOT BETWEEN 3600 AND 2592000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  v_effective_expires_at := CASE WHEN $3 = 'disposable'
    THEN v_now + make_interval(secs => v_ttl_seconds) END;
  INSERT INTO dasher.dashboards (
    organization_id, dashboard_id, title, created_by_user_id, created_at,
    created_kind, current_kind, original_expires_at, effective_expires_at,
    lifecycle_state, lifecycle_revision, capability_epoch, cache_epoch,
    retention_policy_revision, tombstone_lineage_id
  ) VALUES (
    v_organization_id, $1, $2, v_actor_user_id, v_now, $3, $3,
    v_effective_expires_at, v_effective_expires_at,
    'draft', 0, 0, 0,
    v_policy_revision, $6
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $7, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    v_authority_revision, dasher_private.context_request_id(), NULL,
    'dashboard.created', 'dashboard', $1, 'succeeded', NULL, NULL, NULL,
    NULL, NULL, NULL, $10
  );
  RETURN ROW(
    $1,
    v_now,
    v_effective_expires_at,
    CASE WHEN $3 = 'disposable' THEN v_ttl_seconds END,
    CASE WHEN $3 = 'disposable' THEN $5 ELSE false END,
    v_policy_insert_count = 1,
    v_policy_row_revision,
    v_default_ttl_seconds,
    v_policy_revision
  )::dasher.dashboard_creation_result;
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

ALTER FUNCTION dasher_api.create_dashboard(
  uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.create_dashboard(
  uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.create_dashboard(
  uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.create_evidence_record(
  uuid, uuid, uuid, uuid, uuid, text, text, bytea,
  timestamptz, timestamptz, uuid, smallint, bytea, text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($12, $13) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $6 NOT IN (
      'source_record', 'typed_value', 'calculation_result', 'event_record'
    ) OR $7 IS NULL OR btrim($7) <> $7 OR char_length($7) NOT BETWEEN 1 AND 200
    OR $8 IS NULL OR octet_length($8) <> 32 OR $9 IS NULL OR $10 IS NULL
    OR $9 > $10 OR $11 IS NULL OR $11 = dasher_private.context_request_id()
    OR $14 IS NULL OR char_length($14) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_organization_id AND snapshot.snapshot_id = $4
    AND snapshot.source_kind IN ('synthetic_fixture', 'public_usgs_fixture')
    AND octet_length(snapshot.canonical_bytes) BETWEEN 1 AND 1048576
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.snapshot_id = $4
  ) OR EXISTS (
    SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.evidence_id = $3
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id AND dashboard.dashboard_id = $1
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND ((dashboard.current_kind = 'disposable'
      AND dashboard.lifecycle_state IN ('draft', 'active')
      AND dashboard.effective_expires_at IS NOT NULL)
      OR (dashboard.current_kind = 'durable'
        AND dashboard.lifecycle_state IN ('draft', 'active')
        AND dashboard.effective_expires_at IS NULL))
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_versions AS version
  WHERE version.organization_id = v_organization_id
    AND version.dashboard_id = $1 AND version.version_id = $2
    AND version.validation_state = 'validated'
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_version_snapshots AS source_link
      WHERE source_link.organization_id = version.organization_id
        AND source_link.dashboard_id = version.dashboard_id
        AND source_link.version_id = version.version_id
        AND source_link.snapshot_id = $4
    )
    AND EXISTS (
      SELECT 1 FROM dasher.snapshot_reference_claims AS claim
      WHERE claim.organization_id = v_organization_id
        AND claim.snapshot_id = $4 AND claim.dashboard_id = $1
        AND claim.version_id = $2 AND claim.claim_kind = 'access_bearing'
        AND claim.hold_id IS NULL
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  PERFORM 1 FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = $1
    AND ((dashboard.current_kind = 'disposable'
      AND dashboard.lifecycle_state IN ('draft', 'active')
      AND dashboard.effective_expires_at IS NOT NULL
      AND v_now < dashboard.effective_expires_at)
      OR (dashboard.current_kind = 'durable'
        AND dashboard.lifecycle_state IN ('draft', 'active')
        AND dashboard.effective_expires_at IS NULL))
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.evidence_records (
    organization_id, evidence_id, snapshot_id, evidence_kind, coordinates,
    transformation, content_sha256, observed_at, retrieved_at, created_at
  ) VALUES (v_organization_id, $3, $4, $6, $7, 'identity', $8, $9, $10,
    v_now);
  INSERT INTO dasher.dashboard_version_evidence (
    organization_id, dashboard_id, version_id, evidence_id
  ) VALUES (v_organization_id, $1, $2, $3);
  INSERT INTO dasher.evidence_reference_claims (
    organization_id, evidence_id, reference_claim_id, dashboard_id,
    version_id, claim_kind, hold_id, created_at
  ) VALUES (v_organization_id, $3, $5, $1, $2, 'access_bearing', NULL, v_now);
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $11, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    v_authority_revision, dasher_private.context_request_id(), NULL,
    'evidence_record.created', 'evidence_record', $3, 'succeeded', $8,
    NULL, NULL, NULL, NULL, NULL, $14
  );
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

ALTER FUNCTION dasher_api.create_evidence_record(
  uuid, uuid, uuid, uuid, uuid, text, text, bytea,
  timestamptz, timestamptz, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.create_evidence_record(
  uuid, uuid, uuid, uuid, uuid, text, text, bytea,
  timestamptz, timestamptz, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.create_evidence_record(
  uuid, uuid, uuid, uuid, uuid, text, text, bytea,
  timestamptz, timestamptz, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.create_dashboard_version(
  uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea,
  uuid[], uuid[], uuid[], uuid[], uuid, smallint, bytea, text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_now timestamptz;
  v_snapshot_id uuid;
  v_snapshot_claim_id uuid;
  v_evidence_id uuid;
  v_evidence_claim_id uuid;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($16, $17) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $4 IS NULL OR octet_length($4) NOT BETWEEN 2 AND 1048576
    OR $5 IS NULL OR octet_length($5) <> 32
    OR $5 <> pg_catalog.sha256($4) OR $6 IS NULL
    OR octet_length($6) <> 32 OR $7 IS NULL OR octet_length($7) <> 32
    OR $8 < 1 OR $9 < 1 OR ($10 IS NOT NULL AND octet_length($10) <> 32)
    OR $11 IS NULL OR cardinality($11) = 0
    OR $12 IS NULL OR cardinality($12) <> cardinality($11)
    OR $13 IS NULL
    OR $14 IS NULL OR cardinality($14) <> cardinality($13)
    OR $15 IS NULL OR $15 = dasher_private.context_request_id()
    OR $18 IS NULL OR char_length($18) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT value) FROM unnest($11) AS value)
    OR (SELECT count(*) <> count(DISTINCT value) FROM unnest($12) AS value)
    OR (SELECT count(*) <> count(DISTINCT value) FROM unnest($13) AS value)
    OR (SELECT count(*) <> count(DISTINCT value) FROM unnest($14) AS value)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies AS policy
  WHERE policy.organization_id = v_organization_id AND policy.policy_revision = $8
    AND NOT EXISTS (
      SELECT 1 FROM dasher.dashboard_lifecycle_policies AS later
      WHERE later.organization_id = policy.organization_id
        AND later.policy_revision > policy.policy_revision
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_organization_id
    AND snapshot.snapshot_id = ANY($11)
    AND snapshot.source_kind IN ('synthetic_fixture', 'public_usgs_fixture')
    AND octet_length(snapshot.canonical_bytes) BETWEEN 1 AND 1048576
  ORDER BY snapshot.snapshot_id FOR SHARE;
  IF (SELECT count(*) FROM dasher.source_snapshots AS snapshot
      WHERE snapshot.organization_id = v_organization_id
        AND snapshot.snapshot_id = ANY($11)
        AND snapshot.source_kind IN ('synthetic_fixture', 'public_usgs_fixture')
        AND octet_length(snapshot.canonical_bytes) BETWEEN 1 AND 1048576
      ) <> cardinality($11)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.snapshot_id = ANY($11)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.evidence_records AS evidence
  WHERE evidence.organization_id = v_organization_id
    AND evidence.evidence_id = ANY($13) AND evidence.snapshot_id = ANY($11)
    AND EXISTS (
      SELECT 1 FROM dasher.evidence_reference_claims AS authority_claim
      WHERE authority_claim.organization_id = evidence.organization_id
        AND authority_claim.evidence_id = evidence.evidence_id
        AND authority_claim.dashboard_id = $1
        AND authority_claim.claim_kind = 'access_bearing'
        AND authority_claim.hold_id IS NULL
    )
  ORDER BY evidence.evidence_id FOR SHARE;
  IF (SELECT count(*) FROM dasher.evidence_records AS evidence
      WHERE evidence.organization_id = v_organization_id
        AND evidence.evidence_id = ANY($13) AND evidence.snapshot_id = ANY($11)
        AND EXISTS (
          SELECT 1 FROM dasher.evidence_reference_claims AS authority_claim
          WHERE authority_claim.organization_id = evidence.organization_id
            AND authority_claim.evidence_id = evidence.evidence_id
            AND authority_claim.dashboard_id = $1
            AND authority_claim.claim_kind = 'access_bearing'
            AND authority_claim.hold_id IS NULL
        )) <> cardinality($13)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.evidence_id = ANY($13)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id AND dashboard.dashboard_id = $1
    AND dashboard.lifecycle_state IN ('draft', 'active')
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND ((dashboard.current_kind = 'disposable'
      AND dashboard.effective_expires_at IS NOT NULL)
      OR (dashboard.current_kind = 'durable' AND dashboard.effective_expires_at IS NULL))
    AND ($3 IS NULL OR EXISTS (
      SELECT 1 FROM dasher.dashboard_versions AS parent
      WHERE parent.organization_id = v_organization_id
        AND parent.dashboard_id = $1 AND parent.version_id = $3
        AND parent.validation_state = 'validated'
    ))
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  PERFORM 1 FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = $1
    AND dashboard.lifecycle_state IN ('draft', 'active')
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND ((dashboard.current_kind = 'disposable'
      AND dashboard.effective_expires_at IS NOT NULL
      AND v_now < dashboard.effective_expires_at)
      OR (dashboard.current_kind = 'durable'
        AND dashboard.effective_expires_at IS NULL));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_versions (
    organization_id, dashboard_id, version_id, parent_version_id,
    canonical_spec_bytes, canonical_spec_sha256, validation_state,
    validation_sha256, planner_provenance_sha256, policy_revision,
    registry_revision, calculation_graph_sha256, created_by_user_id, created_at
  ) VALUES (v_organization_id, $1, $2, $3, $4, $5, 'validated', $6, $7,
    $8, $9, $10, v_actor_user_id, v_now);
  FOREACH v_snapshot_id IN ARRAY $11 LOOP
    INSERT INTO dasher.dashboard_version_snapshots
      (organization_id, dashboard_id, version_id, snapshot_id)
    VALUES (v_organization_id, $1, $2, v_snapshot_id);
  END LOOP;
  FOREACH v_evidence_id IN ARRAY $13 LOOP
    INSERT INTO dasher.dashboard_version_evidence
      (organization_id, dashboard_id, version_id, evidence_id)
    VALUES (v_organization_id, $1, $2, v_evidence_id);
  END LOOP;
  FOR v_snapshot_id, v_snapshot_claim_id IN
    SELECT * FROM unnest($11, $12)
  LOOP
    INSERT INTO dasher.snapshot_reference_claims (
      organization_id, snapshot_id, reference_claim_id, dashboard_id,
      version_id, claim_kind, hold_id, created_at
    ) VALUES (v_organization_id, v_snapshot_id, v_snapshot_claim_id, $1, $2,
      'access_bearing', NULL, v_now);
  END LOOP;
  FOR v_evidence_id, v_evidence_claim_id IN
    SELECT * FROM unnest($13, $14)
  LOOP
    INSERT INTO dasher.evidence_reference_claims (
      organization_id, evidence_id, reference_claim_id, dashboard_id,
      version_id, claim_kind, hold_id, created_at
    ) VALUES (v_organization_id, v_evidence_id, v_evidence_claim_id, $1, $2,
      'access_bearing', NULL, v_now);
  END LOOP;
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $15, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    v_authority_revision, dasher_private.context_request_id(), NULL,
    'dashboard_version.created', 'dashboard_version', $2, 'succeeded', $5,
    NULL, NULL, NULL, NULL, NULL, $18
  );
  RETURN $2;
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

ALTER FUNCTION dasher_api.create_dashboard_version(
  uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea,
  uuid[], uuid[], uuid[], uuid[], uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.create_dashboard_version(
  uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea,
  uuid[], uuid[], uuid[], uuid[], uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.create_dashboard_version(
  uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea,
  uuid[], uuid[], uuid[], uuid[], uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.compare_and_swap_dashboard_head(
  uuid, uuid, uuid, bigint, uuid, smallint, bytea, text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_event_kind text;
  v_reason_sha256 bytea;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($6, $7) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR $1 IS NULL OR $3 IS NULL OR $4 IS NULL
    OR $4 < 0 OR $5 IS NULL OR $8 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id AND dashboard.dashboard_id = $1
    AND dashboard.head_version_id IS NOT DISTINCT FROM $2
    AND dashboard.lifecycle_revision = $4
    AND dashboard.lifecycle_state IN ('draft', 'active')
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  SELECT version.canonical_spec_sha256 INTO v_reason_sha256
  FROM dasher.dashboard_versions AS version
  WHERE version.organization_id = v_organization_id AND version.dashboard_id = $1
    AND version.version_id = $3 AND version.validation_state = 'validated'
    AND EXISTS (
      SELECT 1 FROM dasher.snapshot_reference_claims AS claim
      WHERE claim.organization_id = version.organization_id
        AND claim.dashboard_id = version.dashboard_id
        AND claim.version_id = version.version_id
        AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  IF v_dashboard.current_kind = 'disposable'
    AND (v_dashboard.effective_expires_at IS NULL
      OR v_now >= v_dashboard.effective_expires_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_event_kind := CASE WHEN v_dashboard.lifecycle_state = 'draft'
    THEN 'head_activated' ELSE 'head_advanced' END;
  PERFORM set_config('dasher.lifecycle_expected_revision', $4::text, true);
  UPDATE dasher.dashboards
  SET head_version_id = $3,
      lifecycle_state = CASE WHEN lifecycle_state = 'draft' THEN 'active'
        ELSE lifecycle_state END,
      lifecycle_revision = lifecycle_revision + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND head_version_id IS NOT DISTINCT FROM $2 AND lifecycle_revision = $4;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  INSERT INTO dasher.dashboard_lifecycle_events (
    lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
    event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
    actor_user_id, actor_service, authority_revision, retention_policy_revision,
    request_id, job_id, reason_sha256
  ) VALUES (
    $5, v_organization_id, $1, $4 + 1, v_event_kind,
    v_dashboard.current_kind, v_dashboard.current_kind,
    v_dashboard.lifecycle_state, 'active', v_now, v_actor_user_id, NULL,
    v_authority_revision, v_dashboard.retention_policy_revision,
    dasher_private.context_request_id(), NULL, v_reason_sha256
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $5, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    v_authority_revision, dasher_private.context_request_id(), NULL,
    'dashboard_head.promoted', 'dashboard', $1, 'succeeded', v_reason_sha256,
    NULL, NULL, NULL, NULL, NULL, $8
  );
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

ALTER FUNCTION dasher_api.compare_and_swap_dashboard_head(
  uuid, uuid, uuid, bigint, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.compare_and_swap_dashboard_head(
  uuid, uuid, uuid, bigint, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.compare_and_swap_dashboard_head(
  uuid, uuid, uuid, bigint, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.request_dashboard_promotion(
  uuid, uuid, bigint, bytea, uuid, smallint, bytea, text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($6, $7) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'editor')
    OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $3 < 0 OR $4 IS NULL OR octet_length($4) <> 32
    OR $5 IS NULL OR $5 = dasher_private.context_request_id() OR $8 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id AND dashboard.dashboard_id = $1
    AND dashboard.current_kind = 'disposable'
    AND dashboard.lifecycle_state = 'active' AND dashboard.lifecycle_revision = $3
    AND dashboard.head_version_id IS NOT NULL
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_versions AS head
      WHERE head.organization_id = dashboard.organization_id
        AND head.dashboard_id = dashboard.dashboard_id
        AND head.version_id = dashboard.head_version_id
        AND head.validation_state = 'validated'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_versions AS head
  WHERE head.organization_id = v_organization_id
    AND head.dashboard_id = $1
    AND head.version_id = v_dashboard.head_version_id
    AND head.validation_state = 'validated'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  IF v_now >= v_dashboard.effective_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboard_promotion_requests (
    organization_id, promotion_request_id, dashboard_id,
    requested_lifecycle_revision, requested_at, requested_by_user_id,
    rationale_sha256
  ) VALUES (v_organization_id, $2, $1, $3, v_now, v_actor_user_id, $4);
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $5, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    v_authority_revision, dasher_private.context_request_id(), NULL,
    'dashboard.promotion_requested', 'dashboard', $1, 'succeeded', $4,
    NULL, NULL, NULL, NULL, NULL, $8
  );
  RETURN $2;
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

ALTER FUNCTION dasher_api.request_dashboard_promotion(
  uuid, uuid, bigint, bytea, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.request_dashboard_promotion(
  uuid, uuid, bigint, bytea, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.request_dashboard_promotion(
  uuid, uuid, bigint, bytea, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.decide_dashboard_promotion(
  uuid, bigint, text, uuid, uuid, smallint, bytea, text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_requested_by_user_id uuid;
  v_dashboard_id uuid;
  v_rationale_sha256 bytea;
  v_policy_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($6, $7) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'admin')
    OR v_actor_user_id IS NULL OR $1 IS NULL OR $2 < 0
    OR $3 NOT IN ('approved', 'denied')
    OR ($3 = 'approved' AND $4 IS NULL) OR ($3 = 'denied' AND $4 IS NOT NULL)
    OR $5 IS NULL OR $5 = dasher_private.context_request_id() OR $8 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT dashboard_id, requested_by_user_id, rationale_sha256
    INTO v_dashboard_id, v_requested_by_user_id, v_rationale_sha256
  FROM dasher.dashboard_promotion_requests
  WHERE organization_id = v_organization_id AND promotion_request_id = $1
    AND requested_lifecycle_revision = $2
  FOR SHARE;
  IF NOT FOUND OR v_requested_by_user_id = v_actor_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = v_dashboard_id
    AND dashboard.lifecycle_revision = $2 AND dashboard.current_kind = 'disposable'
    AND dashboard.lifecycle_state = 'active' AND dashboard.head_version_id IS NOT NULL
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_versions AS head
      WHERE head.organization_id = dashboard.organization_id
        AND head.dashboard_id = dashboard.dashboard_id
        AND head.version_id = dashboard.head_version_id
        AND head.validation_state = 'validated'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_versions AS head
  WHERE head.organization_id = v_organization_id
    AND head.dashboard_id = v_dashboard_id
    AND head.version_id = v_dashboard.head_version_id
    AND head.validation_state = 'validated'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_policy_revision := v_dashboard.retention_policy_revision;
  v_now := clock_timestamp();
  IF v_now >= v_dashboard.effective_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF $3 = 'approved' THEN
    PERFORM set_config('dasher.lifecycle_expected_revision', $2::text, true);
    UPDATE dasher.dashboards SET current_kind = 'durable',
      effective_expires_at = NULL, promoted_at = v_now,
      lifecycle_revision = lifecycle_revision + 1,
      capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
    WHERE organization_id = v_organization_id AND dashboard_id = v_dashboard_id
      AND lifecycle_revision = $2;
  END IF;
  INSERT INTO dasher.dashboard_promotion_decisions (
    organization_id, promotion_request_id, decision,
    dashboard_lifecycle_revision, decided_at, requested_by_user_id,
    decided_by_user_id, retention_policy_revision
  ) VALUES (v_organization_id, $1, $3, $2, v_now,
    v_requested_by_user_id, v_actor_user_id, v_policy_revision);
  IF $3 = 'approved' THEN
    INSERT INTO dasher.dashboard_lifecycle_events (
      lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
      event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
      actor_user_id, actor_service, authority_revision, retention_policy_revision,
      request_id, job_id, reason_sha256
    ) VALUES (
      $4, v_organization_id, v_dashboard_id, $2 + 1, 'promotion_approved',
      'disposable', 'durable', 'active', 'active', v_now, v_actor_user_id, NULL,
      dasher_private.context_authority_revision(), v_policy_revision,
      dasher_private.context_request_id(), NULL,
      v_rationale_sha256
    );
  END IF;
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $5, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    dasher_private.context_authority_revision(), dasher_private.context_request_id(),
    NULL, CASE WHEN $3 = 'approved' THEN 'dashboard.promotion_approved'
      ELSE 'dashboard.promotion_denied' END, 'dashboard', v_dashboard_id,
    'succeeded', v_rationale_sha256, NULL, NULL, NULL, NULL, NULL, $8
  );
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

ALTER FUNCTION dasher_api.decide_dashboard_promotion(
  uuid, bigint, text, uuid, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.decide_dashboard_promotion(
  uuid, bigint, text, uuid, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.decide_dashboard_promotion(
  uuid, bigint, text, uuid, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.set_dashboard_archive(
  uuid, boolean, bigint, uuid, smallint, bytea, text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_event_kind text;
  v_archive_provenance_sha256 bytea;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($5, $6) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 < 0
    OR $4 IS NULL OR $7 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id AND dashboard.dashboard_id = $1
    AND dashboard.lifecycle_revision = $3 AND dashboard.current_kind = 'durable'
    AND dashboard.head_version_id IS NOT NULL
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND (($2 AND dashboard.lifecycle_state = 'active' AND dashboard.archived_at IS NULL)
      OR (NOT $2 AND dashboard.lifecycle_state = 'archived'
        AND dashboard.archived_at IS NOT NULL))
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_versions AS head
      WHERE head.organization_id = dashboard.organization_id
        AND head.dashboard_id = dashboard.dashboard_id
        AND head.version_id = dashboard.head_version_id
        AND head.validation_state = 'validated'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_versions AS head
  WHERE head.organization_id = v_organization_id
    AND head.dashboard_id = $1
    AND head.version_id = v_dashboard.head_version_id
    AND head.validation_state = 'validated'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  v_event_kind := CASE WHEN $2 THEN 'archived' ELSE 'unarchived' END;
  v_archive_provenance_sha256 := sha256(timestamptz_send(
    CASE WHEN $2 THEN v_now ELSE v_dashboard.archived_at END
  ));
  PERFORM set_config('dasher.lifecycle_expected_revision', $3::text, true);
  UPDATE dasher.dashboards
  SET lifecycle_state = CASE WHEN $2 THEN 'archived' ELSE 'active' END,
      archived_at = CASE WHEN $2 THEN v_now ELSE NULL END,
      lifecycle_revision = lifecycle_revision + 1,
      capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $3;
  INSERT INTO dasher.dashboard_lifecycle_events (
    lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
    event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
    actor_user_id, actor_service, authority_revision, retention_policy_revision,
    request_id, job_id, reason_sha256
  ) VALUES (
    $4, v_organization_id, $1, $3 + 1, v_event_kind, 'durable', 'durable',
    v_dashboard.lifecycle_state, CASE WHEN $2 THEN 'archived' ELSE 'active' END,
    v_now, v_actor_user_id, NULL, dasher_private.context_authority_revision(),
    v_dashboard.retention_policy_revision, dasher_private.context_request_id(),
    NULL, v_archive_provenance_sha256
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $4, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    dasher_private.context_authority_revision(), dasher_private.context_request_id(),
    NULL, CASE WHEN $2 THEN 'dashboard.archived' ELSE 'dashboard.unarchived' END,
    'dashboard', $1, 'succeeded', v_archive_provenance_sha256,
    NULL, NULL, NULL, NULL, NULL, $7
  );
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

ALTER FUNCTION dasher_api.set_dashboard_archive(
  uuid, boolean, bigint, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.set_dashboard_archive(
  uuid, boolean, bigint, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.set_dashboard_archive(
  uuid, boolean, bigint, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.delete_dashboard(
  uuid, bigint, uuid, smallint, bytea, text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_proof_sha256 bytea;
  v_ledger_sequence bigint;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($4, $5) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 < 0 OR $3 IS NULL
    OR $6 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id AND dashboard.dashboard_id = $1
    AND dashboard.lifecycle_revision = $2
    AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
    AND dashboard.access_revoked_at IS NULL AND dashboard.purged_at IS NULL
    AND ((dashboard.current_kind = 'disposable'
      AND dashboard.effective_expires_at IS NOT NULL)
      OR (dashboard.current_kind = 'durable' AND dashboard.effective_expires_at IS NULL))
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_now := clock_timestamp();
  IF v_dashboard.current_kind = 'disposable'
    AND (v_dashboard.effective_expires_at IS NULL
      OR v_now >= v_dashboard.effective_expires_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_proof_sha256 := sha256(
    uuid_send(v_organization_id) || uuid_send($1) || int8send(($2 + 1)::bigint)
      || timestamptz_send(v_now) || convert_to('deleted', 'UTF8')
  );
  PERFORM set_config('dasher.lifecycle_expected_revision', $2::text, true);
  UPDATE dasher.dashboards SET lifecycle_state = 'access_revoked',
    access_revoked_at = v_now, revocation_reason = 'explicit_delete',
    purge_after = v_now + interval '24 hours',
    lifecycle_revision = lifecycle_revision + 1,
    capability_epoch = capability_epoch + 1, cache_epoch = cache_epoch + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $2;
  INSERT INTO dasher.dashboard_tombstones (
    organization_id, tombstone_lineage_id, retention_policy_revision,
    access_revoked_at, access_revoked_lifecycle_revision,
    access_revoked_proof_sha256
  ) VALUES (v_organization_id, v_dashboard.tombstone_lineage_id,
    v_dashboard.retention_policy_revision, v_now, $2 + 1, v_proof_sha256);
  INSERT INTO dasher.dashboard_cleanup_coordination (
    organization_id, dashboard_id, current_step, expected_lifecycle_revision,
    next_attempt_at
  ) VALUES (v_organization_id, $1, 'access_revoked', $2 + 1, v_now);
  SELECT COALESCE(max(ledger_sequence), 0) + 1 INTO v_ledger_sequence
  FROM dasher.backup_deletion_ledger WHERE organization_id = v_organization_id;
  INSERT INTO dasher.backup_deletion_ledger (
    organization_id, ledger_sequence, tombstone_lineage_id, lifecycle_revision,
    event_kind, event_occurred_at, inserted_at, retention_policy_revision,
    proof_sha256
  ) VALUES (v_organization_id, v_ledger_sequence,
    v_dashboard.tombstone_lineage_id, $2 + 1, 'access_revoked', v_now, v_now,
    v_dashboard.retention_policy_revision, v_proof_sha256);
  INSERT INTO dasher.dashboard_lifecycle_events (
    lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
    event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
    actor_user_id, actor_service, authority_revision, retention_policy_revision,
    request_id, job_id, reason_sha256
  ) VALUES (
    $3, v_organization_id, $1, $2 + 1, 'deleted',
    v_dashboard.current_kind, v_dashboard.current_kind,
    v_dashboard.lifecycle_state, 'access_revoked', v_now, v_actor_user_id, NULL,
    dasher_private.context_authority_revision(),
    v_dashboard.retention_policy_revision, dasher_private.context_request_id(),
    NULL, v_proof_sha256
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $3, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    dasher_private.context_authority_revision(), dasher_private.context_request_id(),
    NULL, 'dashboard.deleted', 'dashboard', $1, 'succeeded', v_proof_sha256,
    NULL, NULL, NULL, NULL, NULL, $6
  );
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

ALTER FUNCTION dasher_api.delete_dashboard(
  uuid, bigint, uuid, smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.delete_dashboard(
  uuid, bigint, uuid, smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.delete_dashboard(
  uuid, bigint, uuid, smallint, bytea, text
) TO dasher_app;

CREATE FUNCTION dasher_api.restore_dashboard_as_new(
  uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid,
  smallint, bytea, text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_actor_user_id uuid := dasher_private.context_user_id();
  v_source dasher.dashboards%ROWTYPE;
  v_policy_revision bigint;
  v_now timestamptz;
  v_constraint_name text;
BEGIN
  IF NOT dasher_private.context_csrf_allows($10, $11) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT dasher_private.context_allows(v_organization_id, 'admin')
    OR v_actor_user_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 < 0
    OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR $7 IS NULL
    OR btrim($7) <> $7 OR char_length($7) NOT BETWEEN 1 AND 200
    OR $8 IS NULL OR octet_length($8) <> 32 OR $9 IS NULL
    OR $9 = dasher_private.context_request_id()
    OR $12 IS NULL OR char_length($12) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT retention_policy_revision INTO v_policy_revision
  FROM dasher.dashboard_lifecycle_policies
  WHERE organization_id = v_organization_id
  ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_source FROM dasher.dashboards AS source_dashboard
  WHERE source_dashboard.organization_id = v_organization_id
    AND source_dashboard.dashboard_id = $1
    AND source_dashboard.lifecycle_revision = $3
    AND source_dashboard.lifecycle_state IN ('access_revoked', 'quarantined')
    AND source_dashboard.access_revoked_at IS NOT NULL
    AND source_dashboard.purge_after IS NOT NULL
    AND source_dashboard.purge_started_at IS NULL
    AND source_dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_tombstones AS tombstone
  WHERE tombstone.organization_id = v_organization_id
    AND tombstone.tombstone_lineage_id = v_source.tombstone_lineage_id
    AND tombstone.purged_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_versions AS source_version
  WHERE source_version.organization_id = v_organization_id
    AND source_version.dashboard_id = $1 AND source_version.version_id = $2
    AND source_version.validation_state = 'validated'
    AND NOT EXISTS (
      SELECT 1 FROM dasher.dashboard_version_snapshots AS link
      WHERE link.organization_id = v_organization_id
        AND link.dashboard_id = $1 AND link.version_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM dasher.snapshot_reference_claims AS claim
          WHERE claim.organization_id = link.organization_id
            AND claim.snapshot_id = link.snapshot_id
            AND claim.dashboard_id = link.dashboard_id
            AND claim.version_id = link.version_id
            AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.dashboard_version_evidence AS link
      JOIN dasher.evidence_records AS evidence
        ON evidence.organization_id = link.organization_id
       AND evidence.evidence_id = link.evidence_id
      WHERE link.organization_id = v_organization_id
        AND link.dashboard_id = $1 AND link.version_id = $2
        AND (NOT EXISTS (
          SELECT 1 FROM dasher.evidence_reference_claims AS claim
          WHERE claim.organization_id = link.organization_id
            AND claim.evidence_id = link.evidence_id
            AND claim.dashboard_id = link.dashboard_id
            AND claim.version_id = link.version_id
            AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM dasher.dashboard_version_snapshots AS snapshot_link
          WHERE snapshot_link.organization_id = link.organization_id
            AND snapshot_link.dashboard_id = link.dashboard_id
            AND snapshot_link.version_id = link.version_id
            AND snapshot_link.snapshot_id = evidence.snapshot_id
        ))
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_organization_id
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_version_snapshots AS link
      WHERE link.organization_id = snapshot.organization_id
        AND link.dashboard_id = $1 AND link.version_id = $2
        AND link.snapshot_id = snapshot.snapshot_id
    )
  ORDER BY snapshot.snapshot_id FOR SHARE;
  IF (
    SELECT count(*) FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS link
        WHERE link.organization_id = snapshot.organization_id
          AND link.dashboard_id = $1 AND link.version_id = $2
          AND link.snapshot_id = snapshot.snapshot_id
      )
  ) <> (
    SELECT count(*) FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2
  ) OR EXISTS (
    SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
    JOIN dasher.dashboard_version_snapshots AS link
      ON link.organization_id = finalizer.organization_id
     AND link.snapshot_id = finalizer.snapshot_id
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.evidence_records AS evidence
  WHERE evidence.organization_id = v_organization_id
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_version_evidence AS link
      WHERE link.organization_id = evidence.organization_id
        AND link.dashboard_id = $1 AND link.version_id = $2
        AND link.evidence_id = evidence.evidence_id
    )
  ORDER BY evidence.evidence_id FOR SHARE;
  IF (
    SELECT count(*) FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS link
        WHERE link.organization_id = evidence.organization_id
          AND link.dashboard_id = $1 AND link.version_id = $2
          AND link.evidence_id = evidence.evidence_id
      )
  ) <> (
    SELECT count(*) FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2
  ) OR EXISTS (
    SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
    JOIN dasher.dashboard_version_evidence AS link
      ON link.organization_id = finalizer.organization_id
     AND link.evidence_id = finalizer.evidence_id
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  IF v_now >= v_source.purge_after OR v_source.purge_started_at IS NOT NULL
    OR v_source.purged_at IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.dashboards (
    organization_id, dashboard_id, title, created_by_user_id, created_at,
    created_kind, current_kind, lifecycle_state, lifecycle_revision,
    capability_epoch, cache_epoch, retention_policy_revision,
    tombstone_lineage_id, restored_from_tombstone_lineage_id
  ) VALUES (v_organization_id, $4, $7, v_actor_user_id, v_now,
    'durable', 'durable', 'draft', 0, 0, 0, v_policy_revision, $6,
    v_source.tombstone_lineage_id);
  INSERT INTO dasher.dashboard_versions (
    organization_id, dashboard_id, version_id, parent_version_id,
    canonical_spec_bytes, canonical_spec_sha256, validation_state,
    validation_sha256, planner_provenance_sha256, policy_revision,
    registry_revision, calculation_graph_sha256, created_by_user_id, created_at
  ) SELECT v_organization_id, $4, $5, NULL, source_version.canonical_spec_bytes,
      source_version.canonical_spec_sha256, source_version.validation_state,
      source_version.validation_sha256, source_version.planner_provenance_sha256,
      source_version.policy_revision, source_version.registry_revision,
      source_version.calculation_graph_sha256, v_actor_user_id, v_now
    FROM dasher.dashboard_versions AS source_version
    WHERE source_version.organization_id = v_organization_id
      AND source_version.dashboard_id = $1 AND source_version.version_id = $2;
  INSERT INTO dasher.dashboard_version_snapshots (
    organization_id, dashboard_id, version_id, snapshot_id
  ) SELECT v_organization_id, $4, $5, link.snapshot_id
    FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2;
  INSERT INTO dasher.dashboard_version_evidence (
    organization_id, dashboard_id, version_id, evidence_id
  ) SELECT v_organization_id, $4, $5, link.evidence_id
    FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2;
  INSERT INTO dasher.snapshot_reference_claims (
    organization_id, snapshot_id, reference_claim_id, dashboard_id,
    version_id, claim_kind, hold_id, created_at
  ) SELECT v_organization_id, link.snapshot_id, $5, $4, $5,
      'access_bearing', NULL, v_now
    FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2;
  INSERT INTO dasher.evidence_reference_claims (
    organization_id, evidence_id, reference_claim_id, dashboard_id,
    version_id, claim_kind, hold_id, created_at
  ) SELECT v_organization_id, link.evidence_id, $5, $4, $5,
      'access_bearing', NULL, v_now
    FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = v_organization_id
      AND link.dashboard_id = $1 AND link.version_id = $2;
  INSERT INTO dasher.dashboard_restore_lineage (
    organization_id, dashboard_id, version_id, source_tombstone_lineage_id,
    source_version_id, retention_policy_revision, actor_user_id,
    authority_revision, occurred_at, provenance_sha256
  ) VALUES (v_organization_id, $4, $5, v_source.tombstone_lineage_id, $2,
    v_policy_revision,
    v_actor_user_id, dasher_private.context_authority_revision(),
    v_now, $8);
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $9, v_organization_id, v_now, 'user', v_actor_user_id, NULL,
    dasher_private.context_authority_revision(), dasher_private.context_request_id(),
    NULL, 'dashboard.restored_as_new', 'dashboard', $4, 'succeeded', $8,
    NULL, NULL, NULL, NULL, NULL, $12
  );
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

ALTER FUNCTION dasher_api.restore_dashboard_as_new(
  uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid,
  smallint, bytea, text
) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.restore_dashboard_as_new(
  uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid,
  smallint, bytea, text
) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.restore_dashboard_as_new(
  uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid,
  smallint, bytea, text
) TO dasher_app;
